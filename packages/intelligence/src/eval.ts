/**
 * Nexus Skill Evaluator
 *
 * Evaluates skills before they are promoted from draft → trusted.
 * Three evaluation modes:
 *
 *   auto      — Checks the skill's trajectory history for evidence of success.
 *               Fast, no LLM cost, runs immediately after creation.
 *
 *   shadow    — Runs the skill procedure against recent similar tasks in
 *               a "shadow" mode (no side effects) and scores the output.
 *               Requires LLM call.
 *
 *   benchmark — Runs the skill against a defined benchmark task with known
 *               expected output keywords. Requires execution infrastructure.
 *
 * Scoring (0–1):
 *   ≥ 0.7 → pass → skill promoted to "pending_review" (auto-approve if configured)
 *   < 0.7 → fail → skill stays "draft", reason added to eval record
 */

import type { LLMProvider, Message } from "@nexus/core";
import type { LearningDB, EvalResult, Benchmark, BenchmarkRun, StoredTrajectory } from "./db.js";
import type { Skill } from "./skills.js";

// ── Evaluator ──────────────────────────────────────────────

export interface EvalOptions {
  /** Minimum score to pass (default: 0.7) */
  passThreshold?: number;
  /** Whether to auto-promote on pass (default: false) */
  autoApprove?: boolean;
}

export class SkillEvaluator {
  private db: LearningDB;
  private provider: LLMProvider;

  constructor(db: LearningDB, provider: LLMProvider) {
    this.db = db;
    this.provider = provider;
  }

  /**
   * Run an auto eval — purely data-driven, no LLM cost.
   *
   * Checks:
   *   - Trajectory count (needs ≥ 2 trajectories using this skill)
   *   - Success rate (≥ 60%)
   *   - Cost consistency (P95/P50 ratio < 3× — not wildly variable)
   *   - Recency (last success < 7 days ago)
   */
  async evalAuto(skill: Skill, opts?: EvalOptions): Promise<EvalResult> {
    const threshold = opts?.passThreshold ?? 0.7;
    const trajectories = this.db.getSkillTrajectories(skill.id, 20);
    const metrics = this.db.getSkillMetrics(skill.id);

    const details: Record<string, unknown> = {
      trajectoryCount: trajectories.length,
      successRate: metrics?.successRate ?? 0,
      avgCostUsd: metrics?.avgCostUsd ?? 0,
      avgDurationMs: metrics?.avgDurationMs ?? 0,
    };

    // Score components
    let score = 0;

    // Component 1: Trajectory evidence (0–0.3)
    const trajScore = Math.min(trajectories.length / 3, 1.0) * 0.3;
    score += trajScore;
    details["trajScore"] = trajScore;

    // Component 2: Success rate (0–0.4)
    const successRate = metrics?.successRate ?? 0;
    const successScore = successRate * 0.4;
    score += successScore;
    details["successScore"] = successScore;

    // Component 3: Cost consistency (0–0.15)
    const p50 = metrics?.p50CostUsd ?? 0;
    const p95 = metrics?.p95CostUsd ?? 0;
    const consistencyScore = (p50 === 0 || p95 / p50 < 3) ? 0.15 : 0.05;
    score += consistencyScore;
    details["consistencyScore"] = consistencyScore;

    // Component 4: Recency (0–0.15)
    const daysSinceSuccess = metrics?.lastSuccessAt
      ? (Date.now() - metrics.lastSuccessAt) / (1000 * 60 * 60 * 24)
      : 999;
    const recencyScore = daysSinceSuccess < 7 ? 0.15 : daysSinceSuccess < 30 ? 0.07 : 0;
    score += recencyScore;
    details["recencyScore"] = recencyScore;
    details["daysSinceSuccess"] = daysSinceSuccess;

    const passed = score >= threshold;
    details["threshold"] = threshold;

    const result: EvalResult = {
      id: `eval_auto_${skill.id}_${Date.now()}`,
      skillId: skill.id,
      skillVersion: skill.version,
      evalType: "auto",
      score,
      passed,
      details,
      runAt: Date.now(),
    };

    this.db.saveEvalResult(result);
    return result;
  }

  /**
   * Shadow eval — uses the LLM to assess whether the skill's procedure
   * would have handled a recent similar task correctly.
   *
   * Does not execute tools — purely analytical.
   */
  async evalShadow(skill: Skill, opts?: EvalOptions): Promise<EvalResult> {
    const threshold = opts?.passThreshold ?? 0.7;

    // Find recent trajectories that could have used this skill
    const recent = this.db.getRecentTrajectories(20);
    const similar = recent.filter((t) => {
      const task = t.task.toLowerCase();
      return skill.triggers.some((trigger) => task.includes(trigger.toLowerCase())) ||
        skill.tags.some((tag) => task.includes(tag.toLowerCase()));
    }).slice(0, 3);

    if (similar.length === 0) {
      const result: EvalResult = {
        id: `eval_shadow_${skill.id}_${Date.now()}`,
        skillId: skill.id,
        skillVersion: skill.version,
        evalType: "shadow",
        score: 0.5,
        passed: false,
        details: { reason: "No similar recent trajectories found for shadow evaluation" },
        runAt: Date.now(),
      };
      this.db.saveEvalResult(result);
      return result;
    }

    // Ask LLM to assess the skill's procedure against these tasks
    const taskSamples = similar.map((t, i) => `Task ${i + 1}: ${t.task}`).join("\n");
    const messages: Message[] = [
      {
        role: "system",
        content: `You are evaluating whether a learned skill procedure is correct and generalizable.
Analyze the skill and the sample tasks, then respond with JSON only:
{
  "coverageScore": 0.0-1.0,  // how well the procedure covers the sample tasks
  "clarityScore": 0.0-1.0,   // how clear and actionable the procedure is
  "generalizability": 0.0-1.0, // how well it would apply to similar future tasks
  "issues": ["string"],       // specific problems or gaps
  "strengths": ["string"]     // what's good about this procedure
}`,
      },
      {
        role: "user",
        content: `Skill: ${skill.name}
Description: ${skill.description}
Triggers: ${skill.triggers.join(", ")}

Procedure:
${skill.procedure}

Sample similar tasks this skill should handle:
${taskSamples}

Evaluate the skill's procedure quality:`,
      },
    ];

    try {
      const response = await this.provider.complete(messages, [], { temperature: 0.1 });
      const jsonStr = response.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const assessment = JSON.parse(jsonStr) as {
        coverageScore: number;
        clarityScore: number;
        generalizability: number;
        issues: string[];
        strengths: string[];
      };

      const score = (
        assessment.coverageScore * 0.4 +
        assessment.clarityScore * 0.3 +
        assessment.generalizability * 0.3
      );

      const result: EvalResult = {
        id: `eval_shadow_${skill.id}_${Date.now()}`,
        skillId: skill.id,
        skillVersion: skill.version,
        evalType: "shadow",
        score,
        passed: score >= threshold,
        details: { ...assessment, sampleTaskCount: similar.length },
        runAt: Date.now(),
      };

      this.db.saveEvalResult(result);
      return result;
    } catch (error) {
      const result: EvalResult = {
        id: `eval_shadow_${skill.id}_${Date.now()}`,
        skillId: skill.id,
        skillVersion: skill.version,
        evalType: "shadow",
        score: 0,
        passed: false,
        details: { error: String(error) },
        runAt: Date.now(),
      };
      this.db.saveEvalResult(result);
      return result;
    }
  }

  /**
   * Combined eval for promotion.
   * Runs auto eval first (cheap). If passes, optionally runs shadow eval.
   * Returns overall pass/fail and recommendation.
   */
  async evalForPromotion(
    skill: Skill,
    opts?: EvalOptions & { runShadow?: boolean },
  ): Promise<{
    passed: boolean;
    score: number;
    reason: string;
    autoResult: EvalResult;
    shadowResult?: EvalResult;
  }> {
    const autoResult = await this.evalAuto(skill, opts);

    if (!autoResult.passed) {
      return {
        passed: false,
        score: autoResult.score,
        reason: `Auto eval failed (score ${autoResult.score.toFixed(2)} < ${opts?.passThreshold ?? 0.7}): needs more usage data`,
        autoResult,
      };
    }

    if (!opts?.runShadow) {
      return {
        passed: true,
        score: autoResult.score,
        reason: `Auto eval passed (score ${autoResult.score.toFixed(2)})`,
        autoResult,
      };
    }

    const shadowResult = await this.evalShadow(skill, opts);
    const combined = autoResult.score * 0.5 + shadowResult.score * 0.5;
    const passed = combined >= (opts?.passThreshold ?? 0.7);

    return {
      passed,
      score: combined,
      reason: passed
        ? `Combined eval passed (auto: ${autoResult.score.toFixed(2)}, shadow: ${shadowResult.score.toFixed(2)})`
        : `Combined eval failed (${combined.toFixed(2)} < ${opts?.passThreshold ?? 0.7})`,
      autoResult,
      shadowResult,
    };
  }
}

// ── Benchmark Suite ───────────────────────────────────────

export class BenchmarkSuite {
  private db: LearningDB;

  constructor(db: LearningDB) {
    this.db = db;
  }

  addBenchmark(opts: {
    name: string;
    task: string;
    expectedKeywords: string[];
    skillId?: string;
    category?: string;
    projectId?: string;
  }): Benchmark {
    const bm: Benchmark = {
      id: `bm_${Date.now().toString(36)}`,
      ...opts,
      createdAt: Date.now(),
    };
    this.db.addBenchmark(bm);
    return bm;
  }

  recordRun(opts: {
    benchmarkId: string;
    skillId?: string;
    routingPath: "system1" | "system2";
    outcome: "success" | "partial" | "failure" | "unknown";
    costUsd: number;
    durationMs: number;
    notes?: string;
  }): BenchmarkRun {
    const run: BenchmarkRun = {
      id: `bmrun_${Date.now().toString(36)}`,
      ...opts,
      runAt: Date.now(),
    };
    this.db.saveBenchmarkRun(run);
    return run;
  }

  getReport(): ReturnType<LearningDB["getBenchmarkReport"]> & { costSavingsUsd: number; costSavingsPct: number } {
    const base = this.db.getBenchmarkReport();
    const costSavings = base.avgCostSystem2 > 0
      ? (base.avgCostSystem2 - base.avgCostSystem1) * base.system1Runs
      : 0;
    const pct = base.avgCostSystem2 > 0
      ? ((base.avgCostSystem2 - base.avgCostSystem1) / base.avgCostSystem2) * 100
      : 0;
    return {
      ...base,
      costSavingsUsd: Math.max(0, costSavings),
      costSavingsPct: Math.max(0, pct),
    };
  }

  formatReport(): string {
    const r = this.getReport();
    const lines = [
      "─── Benchmark Report ────────────────────────────────",
      `  Benchmarks: ${r.totalBenchmarks}  │  Total runs: ${r.totalRuns}`,
      "",
      "  System 1 (fast path):",
      `    Runs:        ${r.system1Runs}`,
      `    Avg cost:    $${r.avgCostSystem1.toFixed(4)}`,
      `    Success:     ${(r.successRateSystem1 * 100).toFixed(1)}%`,
      "",
      "  System 2 (full reasoning):",
      `    Runs:        ${r.system2Runs}`,
      `    Avg cost:    $${r.avgCostSystem2.toFixed(4)}`,
      `    Success:     ${(r.successRateSystem2 * 100).toFixed(1)}%`,
      "",
      `  💰 Cost savings from System 1: $${r.costSavingsUsd.toFixed(4)} (${r.costSavingsPct.toFixed(1)}% cheaper)`,
      "────────────────────────────────────────────────────",
    ];
    return lines.join("\n");
  }
}
