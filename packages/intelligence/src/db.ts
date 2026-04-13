/**
 * Nexus Learning Database
 *
 * SQLite-backed persistent store for the intelligence layer.
 * Uses bun:sqlite (WAL mode) — zero config, embedded, survives restarts.
 *
 * Tables:
 *   trajectories    — complete execution records with outcomes
 *   skill_metrics   — aggregated per-skill performance stats
 *   skill_approvals — approval workflow state machine
 *   skill_evals     — evaluation results
 *   skill_changelog — full version history with diffs
 *   benchmarks      — benchmark task definitions
 *   benchmark_runs  — benchmark execution results
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Use bun:sqlite at runtime; avoid tsc resolution issues
const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

// ── Types ──────────────────────────────────────────────────

export type OutcomeType = "success" | "partial" | "failure" | "unknown";
export type SkillStatus = "draft" | "pending_review" | "trusted" | "retired";
export type EvalType = "auto" | "benchmark" | "shadow";

export interface StoredTrajectory {
  id: string;
  sessionId: string;
  task: string;
  routingPath: "system1" | "system2";
  skillId?: string;
  outcome: OutcomeType;
  outcomeReason: string;
  outcomeConfidence: number;

  // Cost/performance
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;

  // Evidence arrays (stored as JSON strings in DB)
  filesChanged: string[];
  commandsRun: string[];
  exitCodes: Array<{ command: string; code: number }>;
  toolsUsed: string[];
  artifactsJson: string;

  // Full trace
  messagesJson: string;

  // Metadata
  projectId?: string;
  tags: string[];
  createdAt: number;
}

export interface SkillMetrics {
  skillId: string;
  usageCount: number;
  successCount: number;
  failureCount: number;
  partialCount: number;
  successRate: number;
  avgCostUsd: number;
  avgDurationMs: number;
  p50CostUsd: number | null;
  p95CostUsd: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number;
}

export interface ApprovalRecord {
  skillId: string;
  status: SkillStatus;
  submittedAt: number | null;
  reviewedAt: number | null;
  reviewer: "auto" | "human" | null;
  reviewNotes: string | null;
  evalScore: number | null;
  sourceTrajectoryIds: string[];
  retireReason: string | null;
  updatedAt: number;
}

export interface EvalResult {
  id: string;
  skillId: string;
  skillVersion: number;
  evalType: EvalType;
  score: number;
  passed: boolean;
  details: Record<string, unknown>;
  runAt: number;
}

export interface SkillChangelogEntry {
  id: string;
  skillId: string;
  fromVersion: number;
  toVersion: number;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
  trajectoryId?: string;
  changedAt: number;
}

export interface Benchmark {
  id: string;
  name: string;
  task: string;
  expectedKeywords: string[];
  skillId?: string;
  category?: string;
  projectId?: string;
  createdAt: number;
}

export interface BenchmarkRun {
  id: string;
  benchmarkId: string;
  skillId?: string;
  routingPath: "system1" | "system2";
  outcome: OutcomeType;
  costUsd: number;
  durationMs: number;
  notes?: string;
  runAt: number;
}

// ── Database ───────────────────────────────────────────────

export class LearningDB {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    const absPath = resolve(dbPath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.db = new Database(absPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.bootstrap();
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trajectories (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        task                TEXT NOT NULL,
        routing_path        TEXT NOT NULL,
        skill_id            TEXT,
        outcome             TEXT NOT NULL DEFAULT 'unknown',
        outcome_reason      TEXT NOT NULL DEFAULT '',
        outcome_confidence  REAL NOT NULL DEFAULT 0,
        tokens_in           INTEGER NOT NULL DEFAULT 0,
        tokens_out          INTEGER NOT NULL DEFAULT 0,
        cost_usd            REAL NOT NULL DEFAULT 0,
        duration_ms         INTEGER NOT NULL DEFAULT 0,
        llm_calls           INTEGER NOT NULL DEFAULT 0,
        tool_calls          INTEGER NOT NULL DEFAULT 0,
        files_changed       TEXT NOT NULL DEFAULT '[]',
        commands_run        TEXT NOT NULL DEFAULT '[]',
        exit_codes          TEXT NOT NULL DEFAULT '[]',
        tools_used          TEXT NOT NULL DEFAULT '[]',
        artifacts_json      TEXT NOT NULL DEFAULT '[]',
        messages_json       TEXT NOT NULL DEFAULT '[]',
        project_id          TEXT,
        tags                TEXT NOT NULL DEFAULT '[]',
        created_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_traj_skill    ON trajectories(skill_id);
      CREATE INDEX IF NOT EXISTS idx_traj_outcome  ON trajectories(outcome);
      CREATE INDEX IF NOT EXISTS idx_traj_project  ON trajectories(project_id);
      CREATE INDEX IF NOT EXISTS idx_traj_created  ON trajectories(created_at DESC);

      CREATE TABLE IF NOT EXISTS skill_metrics (
        skill_id        TEXT PRIMARY KEY,
        usage_count     INTEGER NOT NULL DEFAULT 0,
        success_count   INTEGER NOT NULL DEFAULT 0,
        failure_count   INTEGER NOT NULL DEFAULT 0,
        partial_count   INTEGER NOT NULL DEFAULT 0,
        success_rate    REAL NOT NULL DEFAULT 0,
        avg_cost_usd    REAL NOT NULL DEFAULT 0,
        avg_duration_ms REAL NOT NULL DEFAULT 0,
        p50_cost_usd    REAL,
        p95_cost_usd    REAL,
        p50_duration_ms REAL,
        p95_duration_ms REAL,
        last_used_at    INTEGER,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_approvals (
        skill_id                TEXT PRIMARY KEY,
        status                  TEXT NOT NULL DEFAULT 'draft',
        submitted_at            INTEGER,
        reviewed_at             INTEGER,
        reviewer                TEXT,
        review_notes            TEXT,
        eval_score              REAL,
        source_trajectory_ids   TEXT NOT NULL DEFAULT '[]',
        retire_reason           TEXT,
        updated_at              INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_evals (
        id              TEXT PRIMARY KEY,
        skill_id        TEXT NOT NULL,
        skill_version   INTEGER NOT NULL,
        eval_type       TEXT NOT NULL,
        score           REAL NOT NULL,
        passed          INTEGER NOT NULL,
        details         TEXT NOT NULL DEFAULT '{}',
        run_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evals_skill ON skill_evals(skill_id, run_at DESC);

      CREATE TABLE IF NOT EXISTS skill_changelog (
        id              TEXT PRIMARY KEY,
        skill_id        TEXT NOT NULL,
        from_version    INTEGER NOT NULL,
        to_version      INTEGER NOT NULL,
        field           TEXT NOT NULL,
        old_value       TEXT NOT NULL DEFAULT '',
        new_value       TEXT NOT NULL DEFAULT '',
        reason          TEXT NOT NULL DEFAULT '',
        trajectory_id   TEXT,
        changed_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_skill ON skill_changelog(skill_id, changed_at DESC);

      CREATE TABLE IF NOT EXISTS benchmarks (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        task              TEXT NOT NULL,
        expected_keywords TEXT NOT NULL DEFAULT '[]',
        skill_id          TEXT,
        category          TEXT,
        project_id        TEXT,
        created_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benchmark_runs (
        id            TEXT PRIMARY KEY,
        benchmark_id  TEXT NOT NULL,
        skill_id      TEXT,
        routing_path  TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        cost_usd      REAL NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        notes         TEXT,
        run_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bench_runs ON benchmark_runs(benchmark_id, run_at DESC);
    `);
  }

  // ── Trajectories ─────────────────────────────────────────

  saveTrajectory(t: StoredTrajectory): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO trajectories (
        id, session_id, task, routing_path, skill_id,
        outcome, outcome_reason, outcome_confidence,
        tokens_in, tokens_out, cost_usd, duration_ms, llm_calls, tool_calls,
        files_changed, commands_run, exit_codes, tools_used, artifacts_json,
        messages_json, project_id, tags, created_at
      ) VALUES (
        $id, $session_id, $task, $routing_path, $skill_id,
        $outcome, $outcome_reason, $outcome_confidence,
        $tokens_in, $tokens_out, $cost_usd, $duration_ms, $llm_calls, $tool_calls,
        $files_changed, $commands_run, $exit_codes, $tools_used, $artifacts_json,
        $messages_json, $project_id, $tags, $created_at
      )
    `).run({
      $id: t.id,
      $session_id: t.sessionId,
      $task: t.task,
      $routing_path: t.routingPath,
      $skill_id: t.skillId ?? null,
      $outcome: t.outcome,
      $outcome_reason: t.outcomeReason,
      $outcome_confidence: t.outcomeConfidence,
      $tokens_in: t.tokensIn,
      $tokens_out: t.tokensOut,
      $cost_usd: t.costUsd,
      $duration_ms: t.durationMs,
      $llm_calls: t.llmCalls,
      $tool_calls: t.toolCalls,
      $files_changed: JSON.stringify(t.filesChanged),
      $commands_run: JSON.stringify(t.commandsRun),
      $exit_codes: JSON.stringify(t.exitCodes),
      $tools_used: JSON.stringify(t.toolsUsed),
      $artifacts_json: t.artifactsJson,
      $messages_json: t.messagesJson,
      $project_id: t.projectId ?? null,
      $tags: JSON.stringify(t.tags),
      $created_at: t.createdAt,
    });
  }

  getTrajectory(id: string): StoredTrajectory | null {
    const row = this.db.prepare("SELECT * FROM trajectories WHERE id = $id").get({ $id: id }) as any;
    return row ? this.rowToTrajectory(row) : null;
  }

  getRecentTrajectories(limit = 50, projectId?: string): StoredTrajectory[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM trajectories WHERE project_id = $pid ORDER BY created_at DESC LIMIT $lim").all({ $pid: projectId, $lim: limit }) as any[])
      : (this.db.prepare("SELECT * FROM trajectories ORDER BY created_at DESC LIMIT $lim").all({ $lim: limit }) as any[]);
    return rows.map((r) => this.rowToTrajectory(r));
  }

  getSkillTrajectories(skillId: string, limit = 20): StoredTrajectory[] {
    const rows = this.db.prepare(
      "SELECT * FROM trajectories WHERE skill_id = $sid ORDER BY created_at DESC LIMIT $lim"
    ).all({ $sid: skillId, $lim: limit }) as any[];
    return rows.map((r) => this.rowToTrajectory(r));
  }

  countByOutcome(skillId?: string): Record<OutcomeType, number> {
    const where = skillId ? "WHERE skill_id = $sid" : "";
    const params: Record<string, string | number | bigint | boolean | null> = skillId ? { $sid: skillId } : {};
    const rows = this.db.prepare(
      `SELECT outcome, COUNT(*) as cnt FROM trajectories ${where} GROUP BY outcome`
    ).all(params) as any[];
    const result: Record<OutcomeType, number> = { success: 0, partial: 0, failure: 0, unknown: 0 };
    for (const row of rows) result[row.outcome as OutcomeType] = row.cnt;
    return result;
  }

  private rowToTrajectory(row: any): StoredTrajectory {
    return {
      id: row.id,
      sessionId: row.session_id,
      task: row.task,
      routingPath: row.routing_path,
      skillId: row.skill_id ?? undefined,
      outcome: row.outcome,
      outcomeReason: row.outcome_reason,
      outcomeConfidence: row.outcome_confidence,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      llmCalls: row.llm_calls,
      toolCalls: row.tool_calls,
      filesChanged: JSON.parse(row.files_changed),
      commandsRun: JSON.parse(row.commands_run),
      exitCodes: JSON.parse(row.exit_codes),
      toolsUsed: JSON.parse(row.tools_used),
      artifactsJson: row.artifacts_json,
      messagesJson: row.messages_json,
      projectId: row.project_id ?? undefined,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
    };
  }

  // ── Skill Metrics ─────────────────────────────────────────

  /**
   * Update rolling skill metrics after a usage.
   * Computes exact percentiles by reading all costs/durations for the skill.
   */
  updateSkillMetrics(
    skillId: string,
    outcome: OutcomeType,
    costUsd: number,
    durationMs: number,
  ): void {
    const now = Date.now();
    const existing = this.getSkillMetrics(skillId);

    const usage = (existing?.usageCount ?? 0) + 1;
    const successes = (existing?.successCount ?? 0) + (outcome === "success" ? 1 : 0);
    const failures = (existing?.failureCount ?? 0) + (outcome === "failure" ? 1 : 0);
    const partials = (existing?.partialCount ?? 0) + (outcome === "partial" ? 1 : 0);
    const successRate = usage > 0 ? successes / usage : 0;

    // Running averages
    const prevCount = existing?.usageCount ?? 0;
    const avgCost = (((existing?.avgCostUsd ?? 0) * prevCount) + costUsd) / usage;
    const avgDuration = (((existing?.avgDurationMs ?? 0) * prevCount) + durationMs) / usage;

    // Percentiles from stored trajectories
    const costs = (this.db.prepare(
      "SELECT cost_usd FROM trajectories WHERE skill_id = $sid ORDER BY cost_usd"
    ).all({ $sid: skillId }) as any[]).map((r) => r.cost_usd as number);
    const durations = (this.db.prepare(
      "SELECT duration_ms FROM trajectories WHERE skill_id = $sid ORDER BY duration_ms"
    ).all({ $sid: skillId }) as any[]).map((r) => r.duration_ms as number);

    const p50Cost = costs.length ? costs[Math.floor(costs.length * 0.5)] ?? null : null;
    const p95Cost = costs.length ? costs[Math.floor(costs.length * 0.95)] ?? null : null;
    const p50Duration = durations.length ? durations[Math.floor(durations.length * 0.5)] ?? null : null;
    const p95Duration = durations.length ? durations[Math.floor(durations.length * 0.95)] ?? null : null;

    this.db.prepare(`
      INSERT OR REPLACE INTO skill_metrics (
        skill_id, usage_count, success_count, failure_count, partial_count,
        success_rate, avg_cost_usd, avg_duration_ms,
        p50_cost_usd, p95_cost_usd, p50_duration_ms, p95_duration_ms,
        last_used_at, last_success_at, last_failure_at, updated_at
      ) VALUES (
        $skill_id, $usage, $successes, $failures, $partials,
        $success_rate, $avg_cost, $avg_duration,
        $p50_cost, $p95_cost, $p50_duration, $p95_duration,
        $last_used, $last_success, $last_failure, $now
      )
    `).run({
      $skill_id: skillId,
      $usage: usage,
      $successes: successes,
      $failures: failures,
      $partials: partials,
      $success_rate: successRate,
      $avg_cost: avgCost,
      $avg_duration: avgDuration,
      $p50_cost: p50Cost,
      $p95_cost: p95Cost,
      $p50_duration: p50Duration,
      $p95_duration: p95Duration,
      $last_used: now,
      $last_success: outcome === "success" ? now : (existing?.lastSuccessAt ?? null),
      $last_failure: outcome === "failure" ? now : (existing?.lastFailureAt ?? null),
      $now: now,
    });
  }

  getSkillMetrics(skillId: string): SkillMetrics | null {
    const row = this.db.prepare("SELECT * FROM skill_metrics WHERE skill_id = $sid").get({ $sid: skillId }) as any;
    return row ? {
      skillId: row.skill_id,
      usageCount: row.usage_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      partialCount: row.partial_count,
      successRate: row.success_rate,
      avgCostUsd: row.avg_cost_usd,
      avgDurationMs: row.avg_duration_ms,
      p50CostUsd: row.p50_cost_usd,
      p95CostUsd: row.p95_cost_usd,
      p50DurationMs: row.p50_duration_ms,
      p95DurationMs: row.p95_duration_ms,
      lastUsedAt: row.last_used_at,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      updatedAt: row.updated_at,
    } : null;
  }

  getAllSkillMetrics(): SkillMetrics[] {
    const rows = this.db.prepare("SELECT * FROM skill_metrics ORDER BY usage_count DESC").all() as any[];
    return rows.map((row) => ({
      skillId: row.skill_id,
      usageCount: row.usage_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      partialCount: row.partial_count,
      successRate: row.success_rate,
      avgCostUsd: row.avg_cost_usd,
      avgDurationMs: row.avg_duration_ms,
      p50CostUsd: row.p50_cost_usd,
      p95CostUsd: row.p95_cost_usd,
      p50DurationMs: row.p50_duration_ms,
      p95DurationMs: row.p95_duration_ms,
      lastUsedAt: row.last_used_at,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      updatedAt: row.updated_at,
    }));
  }

  // ── Approval Workflow ─────────────────────────────────────

  setSkillStatus(
    skillId: string,
    status: SkillStatus,
    opts?: {
      reviewer?: "auto" | "human";
      reviewNotes?: string;
      evalScore?: number;
      sourceTrajectoryIds?: string[];
      retireReason?: string;
    },
  ): void {
    const now = Date.now();
    const existing = this.getApprovalRecord(skillId);

    this.db.prepare(`
      INSERT OR REPLACE INTO skill_approvals (
        skill_id, status, submitted_at, reviewed_at, reviewer,
        review_notes, eval_score, source_trajectory_ids, retire_reason, updated_at
      ) VALUES (
        $skill_id, $status, $submitted_at, $reviewed_at, $reviewer,
        $review_notes, $eval_score, $source_traj_ids, $retire_reason, $now
      )
    `).run({
      $skill_id: skillId,
      $status: status,
      $submitted_at: status === "pending_review"
        ? now
        : (existing?.submittedAt ?? null),
      $reviewed_at: (status === "trusted" || status === "retired")
        ? now
        : (existing?.reviewedAt ?? null),
      $reviewer: opts?.reviewer ?? existing?.reviewer ?? null,
      $review_notes: opts?.reviewNotes ?? existing?.reviewNotes ?? null,
      $eval_score: opts?.evalScore ?? existing?.evalScore ?? null,
      $source_traj_ids: JSON.stringify(opts?.sourceTrajectoryIds ?? existing?.sourceTrajectoryIds ?? []),
      $retire_reason: opts?.retireReason ?? existing?.retireReason ?? null,
      $now: now,
    });
  }

  getApprovalRecord(skillId: string): ApprovalRecord | null {
    const row = this.db.prepare("SELECT * FROM skill_approvals WHERE skill_id = $sid").get({ $sid: skillId }) as any;
    return row ? {
      skillId: row.skill_id,
      status: row.status,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      reviewer: row.reviewer,
      reviewNotes: row.review_notes,
      evalScore: row.eval_score,
      sourceTrajectoryIds: JSON.parse(row.source_trajectory_ids),
      retireReason: row.retire_reason,
      updatedAt: row.updated_at,
    } : null;
  }

  getPendingApprovals(): ApprovalRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM skill_approvals WHERE status = 'pending_review' ORDER BY submitted_at ASC"
    ).all() as any[];
    return rows.map((row) => ({
      skillId: row.skill_id,
      status: row.status,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      reviewer: row.reviewer,
      reviewNotes: row.review_notes,
      evalScore: row.eval_score,
      sourceTrajectoryIds: JSON.parse(row.source_trajectory_ids),
      retireReason: row.retire_reason,
      updatedAt: row.updated_at,
    }));
  }

  getAllApprovals(): ApprovalRecord[] {
    const rows = this.db.prepare("SELECT * FROM skill_approvals ORDER BY updated_at DESC").all() as any[];
    return rows.map((row) => ({
      skillId: row.skill_id,
      status: row.status as SkillStatus,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      reviewer: row.reviewer,
      reviewNotes: row.review_notes,
      evalScore: row.eval_score,
      sourceTrajectoryIds: JSON.parse(row.source_trajectory_ids),
      retireReason: row.retire_reason,
      updatedAt: row.updated_at,
    }));
  }

  // ── Skill Evals ───────────────────────────────────────────

  saveEvalResult(result: EvalResult): void {
    this.db.prepare(`
      INSERT INTO skill_evals (id, skill_id, skill_version, eval_type, score, passed, details, run_at)
      VALUES ($id, $skill_id, $version, $type, $score, $passed, $details, $run_at)
    `).run({
      $id: result.id,
      $skill_id: result.skillId,
      $version: result.skillVersion,
      $type: result.evalType,
      $score: result.score,
      $passed: result.passed ? 1 : 0,
      $details: JSON.stringify(result.details),
      $run_at: result.runAt,
    });
  }

  getLatestEval(skillId: string): EvalResult | null {
    const row = this.db.prepare(
      "SELECT * FROM skill_evals WHERE skill_id = $sid ORDER BY run_at DESC LIMIT 1"
    ).get({ $sid: skillId }) as any;
    return row ? {
      id: row.id,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      evalType: row.eval_type,
      score: row.score,
      passed: row.passed === 1,
      details: JSON.parse(row.details),
      runAt: row.run_at,
    } : null;
  }

  getSkillEvalHistory(skillId: string, limit = 10): EvalResult[] {
    const rows = this.db.prepare(
      "SELECT * FROM skill_evals WHERE skill_id = $sid ORDER BY run_at DESC LIMIT $lim"
    ).all({ $sid: skillId, $lim: limit }) as any[];
    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      evalType: row.eval_type,
      score: row.score,
      passed: row.passed === 1,
      details: JSON.parse(row.details),
      runAt: row.run_at,
    }));
  }

  // ── Skill Changelog ───────────────────────────────────────

  appendChangelog(entry: SkillChangelogEntry): void {
    this.db.prepare(`
      INSERT INTO skill_changelog (id, skill_id, from_version, to_version, field, old_value, new_value, reason, trajectory_id, changed_at)
      VALUES ($id, $skill_id, $from, $to, $field, $old, $new, $reason, $traj, $changed_at)
    `).run({
      $id: entry.id,
      $skill_id: entry.skillId,
      $from: entry.fromVersion,
      $to: entry.toVersion,
      $field: entry.field,
      $old: entry.oldValue,
      $new: entry.newValue,
      $reason: entry.reason,
      $traj: entry.trajectoryId ?? null,
      $changed_at: entry.changedAt,
    });
  }

  getSkillChangelog(skillId: string, limit = 20): SkillChangelogEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM skill_changelog WHERE skill_id = $sid ORDER BY changed_at DESC LIMIT $lim"
    ).all({ $sid: skillId, $lim: limit }) as any[];
    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value,
      reason: row.reason,
      trajectoryId: row.trajectory_id ?? undefined,
      changedAt: row.changed_at,
    }));
  }

  // ── Benchmarks ────────────────────────────────────────────

  addBenchmark(bm: Benchmark): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO benchmarks (id, name, task, expected_keywords, skill_id, category, project_id, created_at)
      VALUES ($id, $name, $task, $keywords, $skill_id, $category, $project_id, $created_at)
    `).run({
      $id: bm.id,
      $name: bm.name,
      $task: bm.task,
      $keywords: JSON.stringify(bm.expectedKeywords),
      $skill_id: bm.skillId ?? null,
      $category: bm.category ?? null,
      $project_id: bm.projectId ?? null,
      $created_at: bm.createdAt,
    });
  }

  getBenchmarks(projectId?: string): Benchmark[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM benchmarks WHERE project_id = $pid OR project_id IS NULL").all({ $pid: projectId }) as any[])
      : (this.db.prepare("SELECT * FROM benchmarks").all() as any[]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      task: row.task,
      expectedKeywords: JSON.parse(row.expected_keywords),
      skillId: row.skill_id ?? undefined,
      category: row.category ?? undefined,
      projectId: row.project_id ?? undefined,
      createdAt: row.created_at,
    }));
  }

  saveBenchmarkRun(run: BenchmarkRun): void {
    this.db.prepare(`
      INSERT INTO benchmark_runs (id, benchmark_id, skill_id, routing_path, outcome, cost_usd, duration_ms, notes, run_at)
      VALUES ($id, $bm_id, $skill_id, $path, $outcome, $cost, $dur, $notes, $run_at)
    `).run({
      $id: run.id,
      $bm_id: run.benchmarkId,
      $skill_id: run.skillId ?? null,
      $path: run.routingPath,
      $outcome: run.outcome,
      $cost: run.costUsd,
      $dur: run.durationMs,
      $notes: run.notes ?? null,
      $run_at: run.runAt,
    });
  }

  getBenchmarkReport(): {
    totalBenchmarks: number;
    totalRuns: number;
    system1Runs: number;
    system2Runs: number;
    avgCostSystem1: number;
    avgCostSystem2: number;
    successRateSystem1: number;
    successRateSystem2: number;
  } {
    const total = (this.db.prepare("SELECT COUNT(*) as n FROM benchmarks").get() as any).n;
    const runs = this.db.prepare("SELECT * FROM benchmark_runs").all() as any[];

    const s1 = runs.filter((r) => r.routing_path === "system1");
    const s2 = runs.filter((r) => r.routing_path === "system2");

    return {
      totalBenchmarks: total,
      totalRuns: runs.length,
      system1Runs: s1.length,
      system2Runs: s2.length,
      avgCostSystem1: s1.length ? s1.reduce((a, r) => a + r.cost_usd, 0) / s1.length : 0,
      avgCostSystem2: s2.length ? s2.reduce((a, r) => a + r.cost_usd, 0) / s2.length : 0,
      successRateSystem1: s1.length ? s1.filter((r) => r.outcome === "success").length / s1.length : 0,
      successRateSystem2: s2.length ? s2.filter((r) => r.outcome === "success").length / s2.length : 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
