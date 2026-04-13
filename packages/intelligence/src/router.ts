/**
 * Nexus System 1/2 Dual-Process Router
 *
 * Routes tasks through two paths:
 *   System 1 (Fast): Known patterns → skill execution → minimal LLM cost
 *   System 2 (Slow): Novel/risky tasks → full reasoning loop → higher quality
 *
 * The more you use Nexus, the more tasks shift from System 2 to System 1,
 * reducing cost and latency over time.
 */

import type { AgentContext, Middleware, NextFn, LLMProvider, Message } from "@nexus/core";
import type { SkillStore, SkillMatch } from "./skills.js";

export interface RouterConfig {
  /** Confidence threshold for System 1 routing (0.0 - 1.0) */
  confidenceThreshold: number;
  /** Risk threshold above which tasks always go to System 2 (0.0 - 1.0) */
  riskThreshold: number;
  /** Minimum usage count before a skill is trusted for System 1 */
  minUsageForFastPath: number;
}

export interface RoutingDecision {
  path: "system1" | "system2";
  reason: string;
  skillMatch?: SkillMatch;
  estimatedCostUsd?: number;
  riskScore: number;
}

const DEFAULT_CONFIG: RouterConfig = {
  confidenceThreshold: 0.75,
  riskThreshold: 0.6,
  minUsageForFastPath: 3,
};

/** Risk keywords that force System 2 */
const HIGH_RISK_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b.*\b(all|everything|entire)\b/i,
  /\bdrop\b.*\b(table|database|collection)\b/i,
  /\bformat\b/i,
  /\bpush\b.*\b(force|--force)\b/i,
  /\brm\s+-rf\b/i,
  /\bdeploy\b.*\bprod/i,
  /\brollback\b/i,
  /\bmigrat/i,
  /\bsecret|password|credential|token\b/i,
];

/** Low risk patterns that are safe for System 1 */
const LOW_RISK_PATTERNS = [
  /\bread\b/i,
  /\bshow\b/i,
  /\blist\b/i,
  /\bexplain\b/i,
  /\bwhat\s+is\b/i,
  /\bsearch\b/i,
  /\bfind\b/i,
  /\banalyze\b/i,
  /\breview\b/i,
];

export class DualProcessRouter {
  private config: RouterConfig;
  private skillStore: SkillStore;
  private routingHistory: Array<{ task: string; decision: RoutingDecision; timestamp: number }> = [];

  constructor(skillStore: SkillStore, config?: Partial<RouterConfig>) {
    this.skillStore = skillStore;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Decide which processing path to use for a task */
  route(taskDescription: string): RoutingDecision {
    const riskScore = this.assessRisk(taskDescription);

    // High risk → always System 2
    if (riskScore >= this.config.riskThreshold) {
      return this.decide("system2", "High risk task — requires full reasoning", riskScore);
    }

    // Check for skill match
    const match = this.skillStore.find(taskDescription, this.config.confidenceThreshold);

    if (match) {
      // Skill found — but is it trusted enough?
      if (match.skill.usageCount >= this.config.minUsageForFastPath && match.skill.successRate >= 0.7) {
        return this.decide("system1", `Matched skill "${match.skill.name}" (${(match.confidence * 100).toFixed(0)}% confidence)`, riskScore, match);
      }

      // Skill exists but not enough track record — use System 2 but note the match
      return this.decide("system2", `Skill "${match.skill.name}" found but needs more usage data (${match.skill.usageCount}/${this.config.minUsageForFastPath})`, riskScore, match);
    }

    // No skill match → System 2
    return this.decide("system2", "No matching skill — full reasoning required", riskScore);
  }

  /** Get routing statistics */
  getStats(): { total: number; system1: number; system2: number; costSaved: number } {
    const total = this.routingHistory.length;
    const system1 = this.routingHistory.filter((r) => r.decision.path === "system1").length;
    const system2 = total - system1;
    const costSaved = this.routingHistory
      .filter((r) => r.decision.path === "system1" && r.decision.estimatedCostUsd)
      .reduce((sum, r) => sum + (r.decision.estimatedCostUsd ?? 0) * 0.8, 0); // Assume 80% savings

    return { total, system1, system2, costSaved };
  }

  /** Assess the risk level of a task (0.0 - 1.0) */
  private assessRisk(task: string): number {
    let risk = 0.3; // Baseline risk

    // Check for high-risk patterns
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(task)) {
        risk = Math.max(risk, 0.8);
        break;
      }
    }

    // Check for low-risk patterns
    for (const pattern of LOW_RISK_PATTERNS) {
      if (pattern.test(task)) {
        risk = Math.min(risk, 0.2);
        break;
      }
    }

    return risk;
  }

  private decide(path: "system1" | "system2", reason: string, riskScore: number, skillMatch?: SkillMatch): RoutingDecision {
    const decision: RoutingDecision = {
      path,
      reason,
      riskScore,
      skillMatch,
      estimatedCostUsd: skillMatch?.skill.avgCostUsd,
    };

    this.routingHistory.push({
      task: decision.reason,
      decision,
      timestamp: Date.now(),
    });

    return decision;
  }
}

/**
 * System 1 Executor — fast-path skill execution
 *
 * Instead of running the full agent loop, System 1 feeds the skill's
 * procedure directly to the LLM as a structured prompt,
 * skipping the open-ended reasoning stage.
 */
export class System1Executor {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async execute(
    userMessage: string,
    match: SkillMatch,
    tools: { schema: { name: string; description: string; parameters: Record<string, unknown> }; execute: (args: Record<string, unknown>) => Promise<string> }[],
  ): Promise<{ response: string; costUsd: number; durationMs: number }> {
    const startTime = Date.now();

    // Build a focused prompt using the skill's procedure
    const messages: Message[] = [
      {
        role: "system",
        content: `You are a focused task executor. Follow this procedure exactly:

## Skill: ${match.skill.name}
${match.skill.description}

## Procedure
${match.skill.procedure}

Execute this procedure for the user's request. Be direct and efficient.`,
      },
      { role: "user", content: userMessage },
    ];

    const toolSchemas = tools.map((t) => t.schema);

    // Execute with tool use in a tight loop (max 10 iterations for System 1)
    for (let i = 0; i < 10; i++) {
      const response = await this.provider.complete(messages, toolSchemas);

      if (!response.toolCalls.length) {
        // Done — return the text response
        return {
          response: response.content,
          costUsd: response.usage.costUsd,
          durationMs: Date.now() - startTime,
        };
      }

      // Execute tool calls
      messages.push({
        role: "assistant",
        content: response.content || "",
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        const tool = tools.find((t) => t.schema.name === call.name);
        let result: string;
        try {
          result = tool ? await tool.execute(call.arguments) : `Tool "${call.name}" not found`;
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({
          role: "tool",
          content: result,
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    return {
      response: "(System 1 execution reached iteration limit)",
      costUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }
}
