/**
 * Nexus Dual-Process Router
 *
 * Routes tasks to System 1 (fast skill execution) or System 2 (full reasoning).
 *
 * Key changes over the original:
 *   - Only "trusted" skills (approved via workflow) reach System 1
 *   - Routing decisions include full human-readable explanations
 *   - Risk factors and confidence factors are surfaced separately
 *   - Wilson score gates: requires calibrated confidence, not raw success rate
 *   - System1Executor returns toolsUsed for artifact tracking
 */

import type { LLMProvider, Message, Tool } from "@nexus/core";
import type { SkillStore, SkillMatch } from "./skills.js";
import type { LearningDB } from "./db.js";

// ── Router Config ──────────────────────────────────────────

export interface RouterConfig {
  /** Confidence threshold for System 1 routing (default: 0.75) */
  confidenceThreshold: number;
  /** Risk threshold above which tasks always go System 2 (default: 0.6) */
  riskThreshold: number;
  /** Min usage count before fast-path (default: 3) */
  minUsageForFastPath: number;
  /** Min Wilson lower-bound confidence (default: 0.4) */
  minWilsonLower: number;
  /** Log routing decisions */
  debug: boolean;
}

const DEFAULT_CONFIG: RouterConfig = {
  confidenceThreshold: 0.75,
  riskThreshold: 0.6,
  minUsageForFastPath: 3,
  minWilsonLower: 0.4,
  debug: false,
};

// ── Routing Decision ───────────────────────────────────────

export interface RoutingDecision {
  path: "system1" | "system2";
  /** One-sentence summary */
  reason: string;
  /** Full explanation suitable for display */
  explanation: string;
  riskScore: number;
  /** What contributed to risk */
  riskFactors: string[];
  /** What affected the confidence/routing decision */
  confidenceFactors: string[];
  skillMatch?: SkillMatch;
  estimatedCostUsd?: number;
  estimatedDurationMs?: number;
}

// ── Risk Assessment ────────────────────────────────────────

const HIGH_RISK = [
  { pattern: /\bdelete\b/i, factor: "destructive operation (delete)" },
  { pattern: /\brm\s+-rf\b/i, factor: "recursive force delete" },
  { pattern: /\bdrop\b.*(table|database|collection)/i, factor: "database drop" },
  { pattern: /\bformat\b/i, factor: "format operation" },
  { pattern: /\bpush.*--force\b/i, factor: "force git push" },
  { pattern: /\bdeploy.*prod/i, factor: "production deployment" },
  { pattern: /\brollback\b/i, factor: "rollback operation" },
  { pattern: /\bmigrat/i, factor: "migration" },
  { pattern: /\b(secret|credential|password|api.?key)\b/i, factor: "credential handling" },
  { pattern: /\bterminate|kill\b/i, factor: "process termination" },
];

const LOW_RISK = [
  { pattern: /\bread\b/i, factor: "read-only" },
  { pattern: /\bshow|display|print\b/i, factor: "display only" },
  { pattern: /\blist\b/i, factor: "list operation" },
  { pattern: /\bexplain|describe|summarize\b/i, factor: "explanation" },
  { pattern: /\bsearch|find|look\b/i, factor: "search" },
  { pattern: /\banalyze|review\b/i, factor: "analysis" },
  { pattern: /\bwhat is|how does|why\b/i, factor: "Q&A" },
];

function assessRisk(task: string): { score: number; factors: string[] } {
  let score = 0.3;
  const factors: string[] = [];

  for (const { pattern, factor } of HIGH_RISK) {
    if (pattern.test(task)) {
      score = Math.max(score, 0.8);
      factors.push(factor);
    }
  }

  for (const { pattern, factor } of LOW_RISK) {
    if (pattern.test(task)) {
      score = Math.min(score, 0.2);
      factors.push(`low-risk: ${factor}`);
      break;
    }
  }

  return { score, factors };
}

// ── DualProcessRouter ──────────────────────────────────────

export class DualProcessRouter {
  private config: RouterConfig;
  private skillStore: SkillStore;
  private db?: LearningDB;
  private routingHistory: Array<{ task: string; decision: RoutingDecision; timestamp: number }> = [];

  constructor(skillStore: SkillStore, config?: Partial<RouterConfig>, db?: LearningDB) {
    this.skillStore = skillStore;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db;
  }

  /**
   * Decide which processing path to use.
   *
   * Decision flow:
   *   1. High risk → System 2 (safety first, always)
   *   2. Trusted skill + usage threshold + Wilson lower bound → System 1
   *   3. Skill found but gated out → System 2 (with match noted)
   *   4. No skill → System 2
   */
  route(taskDescription: string, opts?: { projectId?: string }): RoutingDecision {
    const { score: riskScore, factors: riskFactors } = assessRisk(taskDescription);
    const confidenceFactors: string[] = [];

    // Gate 1: High risk
    if (riskScore >= this.config.riskThreshold) {
      return this.record({
        path: "system2",
        reason: "High-risk operation detected",
        explanation: `Risk score ${riskScore.toFixed(2)} ≥ threshold ${this.config.riskThreshold}. ` +
          `Risk factors: ${riskFactors.join(", ")}. Full reasoning required.`,
        riskScore, riskFactors, confidenceFactors,
      });
    }

    // Gate 2: Find trusted skill
    const match = this.skillStore.find(taskDescription, this.config.confidenceThreshold, {
      projectId: opts?.projectId,
    });

    if (match) {
      const { skill } = match;
      const metrics = this.db?.getSkillMetrics(skill.id);

      confidenceFactors.push(`match: ${match.matchMethod} at ${(match.confidence * 100).toFixed(0)}%`);
      confidenceFactors.push(`wilson lower: ${(skill.confidence.lower * 100).toFixed(0)}%`);
      confidenceFactors.push(`n=${skill.confidence.n} uses`);

      if (skill.confidence.n < this.config.minUsageForFastPath) {
        confidenceFactors.push(`needs ${this.config.minUsageForFastPath - skill.confidence.n} more uses`);
        return this.record({
          path: "system2",
          reason: `Skill "${skill.name}" needs more usage data`,
          explanation: `${skill.confidence.n}/${this.config.minUsageForFastPath} required uses. ` +
            `System 2 will build the track record. Skill status: ${skill.status}.`,
          riskScore, riskFactors, confidenceFactors, skillMatch: match,
        });
      }

      if (skill.confidence.lower < this.config.minWilsonLower) {
        confidenceFactors.push(`calibrated confidence too low`);
        return this.record({
          path: "system2",
          reason: `Skill "${skill.name}" calibrated confidence below threshold`,
          explanation: `Wilson lower bound ${(skill.confidence.lower * 100).toFixed(0)}% < ${(this.config.minWilsonLower * 100).toFixed(0)}% required. ` +
            `Needs more consistent successes before fast-path is trustworthy.`,
          riskScore, riskFactors, confidenceFactors, skillMatch: match,
        });
      }

      // All gates passed → System 1
      const estCost = metrics?.avgCostUsd;
      const estDur = metrics?.avgDurationMs;
      if (estCost != null) confidenceFactors.push(`avg cost: $${estCost.toFixed(4)}`);

      return this.record({
        path: "system1",
        reason: `Using skill "${skill.name}"`,
        explanation: `Matched at ${(match.confidence * 100).toFixed(0)}% via ${match.matchMethod}. ` +
          `Wilson lower bound: ${(skill.confidence.lower * 100).toFixed(0)}% (n=${skill.confidence.n}). ` +
          (estCost != null ? `Expected cost: ~$${estCost.toFixed(4)}.` : ""),
        riskScore, riskFactors, confidenceFactors,
        skillMatch: match,
        estimatedCostUsd: estCost,
        estimatedDurationMs: estDur,
      });
    }

    // No match
    confidenceFactors.push(`no skill at ≥${(this.config.confidenceThreshold * 100).toFixed(0)}% confidence`);
    return this.record({
      path: "system2",
      reason: "No matching skill — full reasoning required",
      explanation: `No trusted skill matched above the ${(this.config.confidenceThreshold * 100).toFixed(0)}% threshold. ` +
        `If this task succeeds, a skill may be learned.`,
      riskScore, riskFactors, confidenceFactors,
    });
  }

  getStats(): { total: number; system1: number; system2: number; system1Pct: number } {
    const total = this.routingHistory.length;
    const s1 = this.routingHistory.filter((r) => r.decision.path === "system1").length;
    return { total, system1: s1, system2: total - s1, system1Pct: total > 0 ? s1 / total : 0 };
  }

  private record(decision: RoutingDecision): RoutingDecision {
    this.routingHistory.push({ task: decision.reason, decision, timestamp: Date.now() });
    return decision;
  }
}

// ── System1Executor ────────────────────────────────────────

export class System1Executor {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async execute(
    userMessage: string,
    match: SkillMatch,
    tools: Tool[],
    opts?: { bypassGates?: boolean },
  ): Promise<{ response: string; costUsd: number; durationMs: number; toolsUsed: string[] }> {
    const startTime = Date.now();
    const toolsUsed: string[] = [];

    const messages: Message[] = [
      {
        role: "system",
        content: [
          `You are executing a known procedure precisely and efficiently.`,
          ``,
          `## Skill: ${match.skill.name}`,
          `${match.skill.description}`,
          ``,
          `## Procedure`,
          match.skill.procedure,
          ``,
          `Follow the procedure. Do not add unnecessary explanation.`,
        ].join("\n"),
      },
      { role: "user", content: userMessage },
    ];

    const toolSchemas = tools.map((t) => t.schema);

    for (let i = 0; i < 10; i++) {
      const response = await this.provider.complete(messages, toolSchemas);

      if (!response.toolCalls.length) {
        return { response: response.content, costUsd: response.usage.costUsd, durationMs: Date.now() - startTime, toolsUsed };
      }

      messages.push({ role: "assistant", content: response.content || "", toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        toolsUsed.push(call.name);
        const tool = tools.find((t) => t.schema.name === call.name);
        let result: string;
        try {
          console.log(`  🔧 ${call.name}...`);
          result = tool ? await tool.execute(call.arguments) : `Tool "${call.name}" not found`;
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({ role: "tool", content: result, toolCallId: call.id, name: call.name });
      }
    }

    return {
      response: "(System 1 hit iteration limit — task may exceed skill scope)",
      costUsd: 0,
      durationMs: Date.now() - startTime,
      toolsUsed,
    };
  }
}
