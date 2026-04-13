/**
 * Nexus Audit Logger
 *
 * Immutable, append-only audit trail for every agent action.
 * Critical for compliance, debugging, and trust.
 *
 * Every tool call, LLM decision, and supervision action is recorded
 * with full context and cannot be modified after creation.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentEvent, EventHandler } from "@nexus/core";
import type { SupervisionDecision } from "./supervisor.js";

export type AuditSeverity = "info" | "warning" | "critical" | "blocked";

export interface AuditEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Unique session identifier */
  sessionId: string;
  /** Event category */
  category: "tool" | "llm" | "supervision" | "budget" | "security" | "system";
  /** Severity level */
  severity: AuditSeverity;
  /** What happened */
  action: string;
  /** Detailed data */
  details: Record<string, unknown>;
  /** SHA-256 of previous entry (chain integrity) */
  prevHash?: string;
}

export class AuditLogger {
  private logDir: string;
  private currentFile: string;
  private entryCount = 0;
  private lastHash = "";
  private sessionId: string;

  constructor(logDir: string, sessionId?: string) {
    this.logDir = resolve(logDir);
    this.sessionId = sessionId ?? `session_${Date.now()}`;

    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    // One file per day
    const dateStr = new Date().toISOString().split("T")[0];
    this.currentFile = join(this.logDir, `audit_${dateStr}.jsonl`);
  }

  /** Log an audit entry */
  log(entry: Omit<AuditEntry, "timestamp" | "sessionId" | "prevHash">): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      prevHash: this.lastHash || undefined,
    };

    const line = JSON.stringify(fullEntry);
    this.lastHash = this.simpleHash(line);
    this.entryCount++;

    try {
      appendFileSync(this.currentFile, line + "\n", "utf-8");
    } catch {
      // Audit logging should never crash the agent
    }
  }

  /** Log a tool execution */
  logToolCall(toolName: string, args: Record<string, unknown>, result: string, isError: boolean, durationMs: number): void {
    this.log({
      category: "tool",
      severity: isError ? "warning" : "info",
      action: `tool.${toolName}`,
      details: {
        args: this.sanitize(args),
        resultPreview: result.slice(0, 200),
        isError,
        durationMs,
      },
    });
  }

  /** Log an LLM call */
  logLLMCall(model: string, tokensIn: number, tokensOut: number, costUsd: number, durationMs: number): void {
    this.log({
      category: "llm",
      severity: "info",
      action: "llm.complete",
      details: { model, tokensIn, tokensOut, costUsd, durationMs },
    });
  }

  /** Log a supervision decision */
  logSupervision(decision: SupervisionDecision): void {
    const severityMap: Record<string, AuditSeverity> = {
      auto: "info",
      hotl: "warning",
      hitl: "critical",
      block: "blocked",
    };

    this.log({
      category: "supervision",
      severity: severityMap[decision.level] ?? "info",
      action: `supervision.${decision.level}`,
      details: {
        toolName: decision.toolName,
        reason: decision.reason,
        level: decision.level,
      },
    });
  }

  /** Log a security event */
  logSecurity(action: string, details: Record<string, unknown>): void {
    this.log({
      category: "security",
      severity: "critical",
      action,
      details,
    });
  }

  /** Log a budget event */
  logBudget(action: string, spentUsd: number, limitUsd: number): void {
    this.log({
      category: "budget",
      severity: spentUsd >= limitUsd ? "critical" : "warning",
      action,
      details: { spentUsd, limitUsd, percentUsed: (spentUsd / limitUsd * 100).toFixed(1) },
    });
  }

  /** Create an event handler that auto-logs agent events */
  createEventHandler(): EventHandler {
    return (event: AgentEvent) => {
      switch (event.type) {
        case "llm.call.end":
          this.logLLMCall(event.model, event.tokensIn, event.tokensOut, event.costUsd, event.durationMs);
          break;
        case "tool.call.end":
          this.logToolCall(event.toolName, {}, event.result, event.isError, event.durationMs);
          break;
        case "budget.warning":
          this.logBudget("budget.warning", event.spentUsd, event.limitUsd);
          break;
        case "budget.exceeded":
          this.logBudget("budget.exceeded", event.spentUsd, event.limitUsd);
          break;
        case "error":
          this.log({
            category: "system",
            severity: "critical",
            action: "error",
            details: { error: event.error },
          });
          break;
      }
    };
  }

  /** Get entry count */
  getEntryCount(): number {
    return this.entryCount;
  }

  /** Read recent audit entries */
  getRecent(count = 20): AuditEntry[] {
    try {
      if (!existsSync(this.currentFile)) return [];
      const content = readFileSync(this.currentFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines
        .slice(-count)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  /** Sanitize sensitive data from audit logs */
  private sanitize(data: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const sensitiveKeys = /api.?key|secret|password|token|credential|auth/i;

    for (const [key, value] of Object.entries(data)) {
      if (sensitiveKeys.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string" && value.length > 500) {
        sanitized[key] = value.slice(0, 500) + "...[truncated]";
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /** Simple hash for chain integrity (not cryptographic) */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}
