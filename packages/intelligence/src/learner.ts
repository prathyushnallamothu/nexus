/**
 * Nexus Experience Learner
 *
 * The full learning loop — persists to SQLite, classifies outcomes properly,
 * manages the skill approval pipeline, and retires underperforming skills.
 *
 * Pipeline:
 *   1. STORE    — Save trajectory + classified outcome to SQLite
 *   2. REFLECT  — LLM-driven analysis (background, no user latency)
 *   3. EVOLVE   — Create/update skills from reflection
 *   4. APPROVE  — Run auto-eval, promote to pending_review or trusted
 *   5. RETIRE   — Check all skills for retirement criteria
 */

import type { LLMProvider } from "@nexus/core";
import type { LearningDB } from "./db.js";
import type { SkillStore, Skill } from "./skills.js";
import type { SkillEvaluator } from "./eval.js";
import { classifyOutcome, type Trajectory, type Reflection } from "./trajectories.js";

// ── Learner Config ─────────────────────────────────────────

export interface LearnerConfig {
  /**
   * Minimum tool calls for a trajectory to be eligible for skill creation.
   * Pure Q&A (0 tool calls) is rarely worth turning into a skill.
   */
  minToolCallsForReflection: number;
  /**
   * Auto-approve skills that pass eval without waiting for human review.
   * Set false in high-stakes environments to require human sign-off.
   */
  autoApprove: boolean;
  /**
   * Skill retirement threshold: if success rate drops below this
   * over the last N uses, the skill is retired.
   */
  retirementSuccessThreshold: number;
  /** Check retirement after every N uses */
  retirementCheckInterval: number;
  /**
   * Whether to run shadow eval (LLM call) in addition to auto eval.
   * Costs money but gives better signal.
   */
  runShadowEval: boolean;
  /** Project ID for project-scoped skill creation */
  projectId?: string;
}

const DEFAULT_CONFIG: LearnerConfig = {
  minToolCallsForReflection: 1,
  autoApprove: true,
  retirementSuccessThreshold: 0.4,
  retirementCheckInterval: 5,
  runShadowEval: false,
};

// ── Learn Result ───────────────────────────────────────────

export interface LearnResult {
  stored: boolean;
  trajectoryId: string;
  outcome: Trajectory["outcome"];
  outcomeConfidence: number;
  reflection: Reflection | null;
  evolvedSkill: Skill | null;
  skillPromoted: boolean;
  skillRetired: string | null;
}

// ── ExperienceLearner ──────────────────────────────────────

export class ExperienceLearner {
  private provider: LLMProvider;
  private skillStore: SkillStore;
  private db: LearningDB;
  private evaluator: SkillEvaluator;
  private config: LearnerConfig;

  constructor(
    provider: LLMProvider,
    skillStore: SkillStore,
    db: LearningDB,
    evaluator: SkillEvaluator,
    config?: Partial<LearnerConfig>,
  ) {
    this.provider = provider;
    this.skillStore = skillStore;
    this.db = db;
    this.evaluator = evaluator;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Full learning cycle. Non-blocking — call without await for zero latency.
   *
   * Returns a promise that resolves when learning is complete.
   * Errors are caught and reported in the result; they never propagate.
   */
  async learn(trajectory: Trajectory): Promise<LearnResult> {
    const trajId = `traj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // ── Stage 1: STORE ──────────────────────────────────────

    // Classify outcome from evidence (not just the default "success")
    const classification = classifyOutcome(
      trajectory.messages[trajectory.messages.length - 1]?.content ?? "",
      trajectory.messages,
      trajectory.artifacts ?? [],
      trajectory.hitIterationLimit ?? false,
      trajectory.userFeedback,
    );

    // Override trajectory outcome with classified result
    const finalOutcome = trajectory.outcome !== "unknown"
      ? trajectory.outcome  // caller provided explicit outcome (user feedback path)
      : classification.outcome;

    const stored = this.storeTrajectory(trajId, trajectory, finalOutcome, classification);

    if (!stored) {
      return {
        stored: false,
        trajectoryId: trajId,
        outcome: finalOutcome,
        outcomeConfidence: classification.confidence,
        reflection: null,
        evolvedSkill: null,
        skillPromoted: false,
        skillRetired: null,
      };
    }

    // Update skill metrics if this used a skill (System 1)
    if (trajectory.routingPath === "system1" && trajectory.skillUsed) {
      this.skillStore.recordUsage(trajectory.skillUsed, {
        success: finalOutcome === "success",
        costUsd: trajectory.budget.spentUsd,
        durationMs: trajectory.durationMs,
      });
      this.db.updateSkillMetrics(
        trajectory.skillUsed,
        finalOutcome,
        trajectory.budget.spentUsd,
        trajectory.durationMs,
      );

      // Check retirement for this skill
      const retired = await this.checkRetirement(trajectory.skillUsed);
      return {
        stored: true,
        trajectoryId: trajId,
        outcome: finalOutcome,
        outcomeConfidence: classification.confidence,
        reflection: null,
        evolvedSkill: null,
        skillPromoted: false,
        skillRetired: retired,
      };
    }

    // ── Stage 2: REFLECT ────────────────────────────────────

    // Skip reflection if not enough tool usage (probably Q&A)
    if (trajectory.budget.toolCalls < this.config.minToolCallsForReflection) {
      return {
        stored: true,
        trajectoryId: trajId,
        outcome: finalOutcome,
        outcomeConfidence: classification.confidence,
        reflection: null,
        evolvedSkill: null,
        skillPromoted: false,
        skillRetired: null,
      };
    }

    let reflection: Reflection | null = null;
    let evolvedSkill: Skill | null = null;
    let skillPromoted = false;

    try {
      reflection = await this.reflect(trajectory, finalOutcome, trajId);

      // ── Stage 3: EVOLVE ──────────────────────────────────
      evolvedSkill = await this.evolve(trajectory, reflection, trajId, finalOutcome);

      // ── Stage 4: APPROVE ─────────────────────────────────
      if (evolvedSkill) {
        skillPromoted = await this.approveSkill(evolvedSkill, trajId);
      }
    } catch {
      // Learning errors are non-fatal
    }

    return {
      stored: true,
      trajectoryId: trajId,
      outcome: finalOutcome,
      outcomeConfidence: classification.confidence,
      reflection,
      evolvedSkill,
      skillPromoted,
      skillRetired: null,
    };
  }

  /**
   * Apply explicit user feedback to the most recent trajectory.
   * This overrides the auto-classified outcome.
   */
  applyUserFeedback(feedback: "positive" | "negative"): void {
    const recent = this.db.getRecentTrajectories(1);
    if (!recent.length) return;

    const traj = recent[0];
    const newOutcome = feedback === "positive" ? "success" : "failure";

    // Re-save with updated outcome
    this.db.saveTrajectory({ ...traj, outcome: newOutcome, outcomeReason: `User feedback: ${feedback}` });

    // Update skill metrics if applicable
    if (traj.skillId) {
      this.db.updateSkillMetrics(traj.skillId, newOutcome, traj.costUsd, traj.durationMs);
    }
  }

  /**
   * Manually approve a skill (human reviewer).
   */
  async approveSkillManually(skillId: string, notes?: string): Promise<boolean> {
    const skill = this.skillStore.setStatus(skillId, "trusted");
    if (!skill) return false;
    this.db.setSkillStatus(skillId, "trusted", {
      reviewer: "human",
      reviewNotes: notes ?? "Manually approved",
    });
    return true;
  }

  /**
   * Manually retire a skill.
   */
  retireSkill(skillId: string, reason: string): boolean {
    const skill = this.skillStore.setStatus(skillId, "retired");
    if (!skill) return false;
    this.db.setSkillStatus(skillId, "retired", { retireReason: reason });
    return true;
  }

  /**
   * Get learning statistics.
   */
  getStats(): {
    trajectoriesStored: number;
    outcomeBreakdown: Record<string, number>;
    skillsByStatus: Record<string, number>;
    pendingApprovals: number;
  } {
    const byOutcome = this.db.countByOutcome();
    const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);

    const allSkills = this.skillStore.getAll({ scope: undefined });
    const byStatus: Record<string, number> = {};
    for (const s of allSkills) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }

    const pending = this.db.getPendingApprovals().length;

    return {
      trajectoriesStored: total,
      outcomeBreakdown: byOutcome,
      skillsByStatus: byStatus,
      pendingApprovals: pending,
    };
  }

  // ── Stage 2: Reflect ──────────────────────────────────────

  private async reflect(
    trajectory: Trajectory,
    outcome: string,
    trajId: string,
  ): Promise<Reflection> {
    const summary = this.summarizeTrajectory(trajectory);

    const response = await this.provider.complete(
      [
        {
          role: "system",
          content: `You are a performance analyst reviewing an AI agent task execution.
Analyze the trajectory and respond with ONLY valid JSON:
{
  "successFactors": ["string"],
  "failurePoints": ["string"],
  "efficiencyOpportunities": ["string"],
  "skillRecommendation": {
    "action": "create" | "update" | "none",
    "skillName": "string (if create/update)",
    "description": "string (if create/update)",
    "procedure": "step-by-step markdown (if create/update)",
    "triggers": ["keyword patterns to activate this skill"],
    "reason": "why this recommendation"
  },
  "memorableContext": ["generalizable facts worth remembering"]
}`,
        },
        {
          role: "user",
          content: [
            `Task: ${trajectory.task}`,
            `Outcome: ${outcome}`,
            `Routing: ${trajectory.routingPath}`,
            `Cost: $${trajectory.budget.spentUsd.toFixed(4)}`,
            `Duration: ${trajectory.durationMs}ms`,
            `LLM calls: ${trajectory.budget.llmCalls}`,
            `Tool calls: ${trajectory.budget.toolCalls}`,
            `Artifacts: ${(trajectory.artifacts ?? []).map((a) => a.type).join(", ") || "none"}`,
            ``,
            `Execution summary:`,
            summary,
            ``,
            `Respond with JSON reflection:`,
          ].join("\n"),
        },
      ],
      [],
      { temperature: 0.3 },
    );

    try {
      const jsonStr = response.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(jsonStr) as Reflection;
    } catch {
      return {
        successFactors: outcome === "success" ? ["Task completed"] : [],
        failurePoints: outcome !== "success" ? ["Task did not succeed"] : [],
        efficiencyOpportunities: [],
        skillRecommendation: { action: "none", reason: "Could not parse reflection" },
        memorableContext: [],
      };
    }
  }

  // ── Stage 3: Evolve ───────────────────────────────────────

  private async evolve(
    trajectory: Trajectory,
    reflection: Reflection,
    trajId: string,
    outcome: string,
  ): Promise<Skill | null> {
    const rec = reflection.skillRecommendation;
    if (rec.action === "none") return null;

    if (rec.action === "create" && rec.skillName && rec.procedure) {
      const skill = this.skillStore.add({
        name: rec.skillName,
        description: rec.description ?? "",
        procedure: rec.procedure,
        category: this.inferCategory(trajectory.task),
        tags: rec.triggers ?? [],
        triggers: rec.triggers ?? [],
        scope: this.config.projectId ? "project" : "global",
        projectId: this.config.projectId,
        provenance: {
          createdBy: "learner",
          sourceTrajectoryIds: [trajId],
        },
      });

      // Register in DB as draft
      this.db.setSkillStatus(skill.id, "draft", { sourceTrajectoryIds: [trajId] });

      // Record initial usage from this trajectory
      this.skillStore.recordUsage(skill.id, {
        success: outcome === "success",
        costUsd: trajectory.budget.spentUsd,
        durationMs: trajectory.durationMs,
      });
      this.db.updateSkillMetrics(skill.id, outcome as any, trajectory.budget.spentUsd, trajectory.durationMs);

      return skill;
    }

    if (rec.action === "update" && rec.skillName) {
      const existing = this.skillStore.getAll({ scope: undefined }).find(
        (s) => s.name.toLowerCase() === rec.skillName!.toLowerCase(),
      );

      if (existing) {
        return this.skillStore.mutate(
          existing.id,
          {
            procedure: rec.procedure ?? existing.procedure,
            description: rec.description ?? existing.description,
            triggers: rec.triggers ?? existing.triggers,
          },
          rec.reason,
          trajId,
        );
      }
    }

    return null;
  }

  // ── Stage 4: Approve ──────────────────────────────────────

  private async approveSkill(skill: Skill, trajId: string): Promise<boolean> {
    try {
      const evalResult = await this.evaluator.evalForPromotion(skill, {
        passThreshold: 0.65,
        runShadow: this.config.runShadowEval,
      });

      if (!evalResult.passed) {
        // Keep as draft — needs more data
        this.db.setSkillStatus(skill.id, "draft", {
          evalScore: evalResult.score,
          reviewer: "auto",
          reviewNotes: evalResult.reason,
        });
        return false;
      }

      if (this.config.autoApprove) {
        // Auto-promote to trusted
        this.skillStore.setStatus(skill.id, "trusted");
        this.db.setSkillStatus(skill.id, "trusted", {
          evalScore: evalResult.score,
          reviewer: "auto",
          reviewNotes: evalResult.reason,
          sourceTrajectoryIds: [trajId],
        });
        return true;
      } else {
        // Promote to pending_review for human sign-off
        this.skillStore.setStatus(skill.id, "pending_review");
        this.db.setSkillStatus(skill.id, "pending_review", {
          evalScore: evalResult.score,
          sourceTrajectoryIds: [trajId],
        });
        return false;
      }
    } catch {
      return false;
    }
  }

  // ── Stage 5: Retire ───────────────────────────────────────

  private async checkRetirement(skillId: string): Promise<string | null> {
    const metrics = this.db.getSkillMetrics(skillId);
    if (!metrics) return null;

    // Only check every N uses
    if (metrics.usageCount % this.config.retirementCheckInterval !== 0) return null;

    // Need at least 10 uses for a meaningful retirement decision
    if (metrics.usageCount < 10) return null;

    if (metrics.successRate < this.config.retirementSuccessThreshold) {
      const reason = `Success rate ${(metrics.successRate * 100).toFixed(1)}% dropped below ${(this.config.retirementSuccessThreshold * 100).toFixed(0)}% over ${metrics.usageCount} uses`;
      this.skillStore.setStatus(skillId, "retired");
      this.db.setSkillStatus(skillId, "retired", { retireReason: reason });
      return reason;
    }

    return null;
  }

  // ── Helpers ───────────────────────────────────────────────

  private storeTrajectory(
    trajId: string,
    trajectory: Trajectory,
    outcome: Trajectory["outcome"],
    classification: ReturnType<typeof classifyOutcome>,
  ): boolean {
    try {
      const artifacts = trajectory.artifacts ?? [];
      const filesChanged = artifacts
        .filter((a) => a.type === "file_write" || a.type === "file_patch")
        .map((a) => a.path)
        .filter(Boolean) as string[];
      const commandsRun = artifacts
        .filter((a) => a.type === "command_run")
        .map((a) => a.command)
        .filter(Boolean) as string[];

      this.db.saveTrajectory({
        id: trajId,
        sessionId: trajectory.sessionId ?? `sess_${Date.now()}`,
        task: trajectory.task,
        routingPath: trajectory.routingPath,
        skillId: trajectory.skillUsed,
        outcome,
        outcomeReason: classification.reason,
        outcomeConfidence: classification.confidence,
        tokensIn: trajectory.budget.tokensIn,
        tokensOut: trajectory.budget.tokensOut,
        costUsd: trajectory.budget.spentUsd,
        durationMs: trajectory.durationMs,
        llmCalls: trajectory.budget.llmCalls,
        toolCalls: trajectory.budget.toolCalls,
        filesChanged,
        commandsRun,
        exitCodes: [],
        toolsUsed: [...new Set(trajectory.messages
          .filter((m) => m.role === "assistant" && m.toolCalls?.length)
          .flatMap((m) => m.toolCalls!.map((tc) => tc.name)))],
        artifactsJson: JSON.stringify(artifacts),
        messagesJson: JSON.stringify(trajectory.messages),
        projectId: trajectory.projectId ?? this.config.projectId,
        tags: [],
        createdAt: trajectory.timestamp ?? Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private summarizeTrajectory(trajectory: Trajectory): string {
    const lines: string[] = [];
    let toolIdx = 0;

    for (const msg of trajectory.messages) {
      if (msg.role === "system") continue;
      if (msg.role === "user") {
        lines.push(`USER: ${msg.content.slice(0, 200)}`);
      } else if (msg.role === "assistant") {
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            toolIdx++;
            lines.push(`TOOL[${toolIdx}]: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 80)})`);
          }
        }
        if (msg.content) lines.push(`ASSISTANT: ${msg.content.slice(0, 150)}`);
      } else if (msg.role === "tool") {
        lines.push(`RESULT: ${msg.content.slice(0, 100).replace(/\n/g, " ")}`);
      }
    }

    return lines.slice(-30).join("\n"); // Last 30 lines to stay compact
  }

  private inferCategory(task: string): string {
    const lower = task.toLowerCase();
    if (/\b(code|implement|function|class|refactor|bug|fix|test)\b/.test(lower)) return "coding";
    if (/\b(deploy|build|docker|ci|cd|pipeline)\b/.test(lower)) return "devops";
    if (/\b(search|find|research|analyze|read)\b/.test(lower)) return "research";
    if (/\b(write|document|explain|summarize)\b/.test(lower)) return "writing";
    return "general";
  }
}

// Re-export Trajectory type for callers
export type { Trajectory, Reflection } from "./trajectories.js";
