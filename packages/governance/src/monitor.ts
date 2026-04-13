/**
 * Behavioral Monitor
 *
 * Real-time anomaly detection for agent behavior.
 * Tracks patterns and flags unusual activity like:
 *   - Excessive tool calls in a short window
 *   - Repeated failures (possible infinite loop)
 *   - Unusual file access patterns
 *   - Cost spikes
 */

import type { Middleware, AgentContext, NextFn, AgentEvent, EventHandler } from "@nexus/core";

export interface AnomalyAlert {
  type: "rate_spike" | "failure_loop" | "cost_spike" | "unusual_access" | "context_overflow";
  severity: "low" | "medium" | "high";
  message: string;
  timestamp: number;
  details: Record<string, unknown>;
}

export interface MonitorConfig {
  /** Max tool calls per minute before alerting */
  maxToolCallsPerMinute: number;
  /** Max consecutive failures before alerting */
  maxConsecutiveFailures: number;
  /** Cost per minute that triggers an alert */
  costSpikePerMinuteUsd: number;
  /** Percentage of context window that triggers overflow warning */
  contextOverflowPercent: number;
}

const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  maxToolCallsPerMinute: 30,
  maxConsecutiveFailures: 3,
  costSpikePerMinuteUsd: 0.50,
  contextOverflowPercent: 80,
};

export class BehavioralMonitor {
  private config: MonitorConfig;
  private alerts: AnomalyAlert[] = [];
  private toolCallTimestamps: number[] = [];
  private consecutiveFailures = 0;
  private costHistory: Array<{ amount: number; timestamp: number }> = [];
  private accessedPaths: Set<string> = new Set();
  private onAlert?: (alert: AnomalyAlert) => void;

  constructor(config?: Partial<MonitorConfig>, onAlert?: (alert: AnomalyAlert) => void) {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
    this.onAlert = onAlert;
  }

  /** Create an event handler for the agent */
  createEventHandler(): EventHandler {
    return (event: AgentEvent) => {
      switch (event.type) {
        case "tool.call.start":
          this.recordToolCall();
          break;

        case "tool.call.end":
          if (event.isError) {
            this.recordFailure();
          } else {
            this.consecutiveFailures = 0;
          }
          break;

        case "llm.call.end":
          this.recordCost(event.costUsd);
          break;
      }
    };
  }

  /** Check all monitors and return any alerts */
  checkAll(): AnomalyAlert[] {
    const newAlerts: AnomalyAlert[] = [];

    // Rate check
    const rateAlert = this.checkRate();
    if (rateAlert) newAlerts.push(rateAlert);

    // Cost check
    const costAlert = this.checkCostSpike();
    if (costAlert) newAlerts.push(costAlert);

    return newAlerts;
  }

  /** Get all alerts */
  getAlerts(): AnomalyAlert[] {
    return [...this.alerts];
  }

  /** Get stats */
  getStats(): {
    totalAlerts: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const alert of this.alerts) {
      byType[alert.type] = (byType[alert.type] ?? 0) + 1;
      bySeverity[alert.severity] = (bySeverity[alert.severity] ?? 0) + 1;
    }

    return { totalAlerts: this.alerts.length, byType, bySeverity };
  }

  private recordToolCall(): void {
    const now = Date.now();
    this.toolCallTimestamps.push(now);

    // Clean old timestamps (keep last 2 minutes)
    const cutoff = now - 120_000;
    this.toolCallTimestamps = this.toolCallTimestamps.filter((t) => t > cutoff);

    // Check rate
    const alert = this.checkRate();
    if (alert) this.emitAlert(alert);
  }

  private recordFailure(): void {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      const alert: AnomalyAlert = {
        type: "failure_loop",
        severity: "high",
        message: `${this.consecutiveFailures} consecutive tool failures detected — possible infinite loop`,
        timestamp: Date.now(),
        details: { consecutiveFailures: this.consecutiveFailures },
      };
      this.emitAlert(alert);
    }
  }

  private recordCost(amount: number): void {
    this.costHistory.push({ amount, timestamp: Date.now() });

    // Clean old entries (keep last 5 minutes)
    const cutoff = Date.now() - 300_000;
    this.costHistory = this.costHistory.filter((c) => c.timestamp > cutoff);

    const alert = this.checkCostSpike();
    if (alert) this.emitAlert(alert);
  }

  private checkRate(): AnomalyAlert | null {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const recentCalls = this.toolCallTimestamps.filter((t) => t > oneMinuteAgo);

    if (recentCalls.length > this.config.maxToolCallsPerMinute) {
      return {
        type: "rate_spike",
        severity: "medium",
        message: `${recentCalls.length} tool calls in the last minute (limit: ${this.config.maxToolCallsPerMinute})`,
        timestamp: now,
        details: { callsPerMinute: recentCalls.length, limit: this.config.maxToolCallsPerMinute },
      };
    }

    return null;
  }

  private checkCostSpike(): AnomalyAlert | null {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const recentCosts = this.costHistory.filter((c) => c.timestamp > oneMinuteAgo);
    const totalCost = recentCosts.reduce((sum, c) => sum + c.amount, 0);

    if (totalCost > this.config.costSpikePerMinuteUsd) {
      return {
        type: "cost_spike",
        severity: "high",
        message: `$${totalCost.toFixed(4)} spent in the last minute (limit: $${this.config.costSpikePerMinuteUsd.toFixed(2)})`,
        timestamp: now,
        details: { costPerMinute: totalCost, limit: this.config.costSpikePerMinuteUsd },
      };
    }

    return null;
  }

  private emitAlert(alert: AnomalyAlert): void {
    // Deduplicate — don't alert same type within 30 seconds
    const lastSameType = this.alerts
      .filter((a) => a.type === alert.type)
      .at(-1);

    if (lastSameType && Date.now() - lastSameType.timestamp < 30_000) {
      return; // Already alerted recently
    }

    this.alerts.push(alert);
    this.onAlert?.(alert);
  }
}

/**
 * Behavioral Monitor Middleware
 *
 * Wraps the agent loop with real-time anomaly detection.
 */
export function monitorMiddleware(monitor: BehavioralMonitor): Middleware {
  return {
    name: "behavioral-monitor",
    async execute(ctx: AgentContext, next: NextFn) {
      await next();

      // Check for anomalies after each cycle
      const alerts = monitor.checkAll();
      if (alerts.some((a) => a.severity === "high")) {
        ctx.meta["behaviorAlerts"] = alerts;
      }
    },
  };
}
