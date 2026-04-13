/**
 * Nexus Multi-Scope Budget Enforcer
 *
 * Enforces spending limits across scopes:
 *   USER      — total budget for a user (daily/monthly)
 *   PROJECT   — budget for a specific project/workspace
 *   TEAM      — shared budget across a team
 *   WORKSPACE — org-level workspace budget
 *   SESSION   — budget for a single conversation
 *
 * Budgets are stored persistently (file-based).
 * Atomic enforcement: reservations prevent concurrent over-spending.
 * BudgetHistory provides append-only JSONL spend records.
 * BudgetDashboard provides a read-only summary/CLI view.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Middleware, AgentContext, NextFn } from "@nexus/core";

// ── Types ─────────────────────────────────────────────────

export type BudgetScope = "user" | "project" | "team" | "workspace" | "session";
export type BudgetPeriod = "daily" | "weekly" | "monthly" | "total";

export interface BudgetConfig {
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period: BudgetPeriod;
}

export interface BudgetRecord extends BudgetConfig {
  id: string;
  spentUsd: number;
  resetAt: number; // Timestamp when budget resets
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  budget: BudgetRecord;
  remainingUsd: number;
  reason?: string;
}

export interface BudgetReservation {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  amountUsd: number;
  reservedAt: number;
  /** Auto-rollback after 60 seconds */
  expiresAt: number;
  committed: boolean;
  rolledBack: boolean;
}

export interface BudgetHistoryEntry {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  amountUsd: number;
  /** "llm_call" | "tool_call" | "session_end" | "manual" */
  action: string;
  sessionId: string;
  model?: string;
  timestamp: number;
}

export interface BudgetAggregated {
  scopeId: string;
  totalUsd: number;
  callCount: number;
  avgPerCall: number;
  maxSingleCall: number;
  firstActivity?: number;
  lastActivity?: number;
  byModel: Record<string, { totalUsd: number; callCount: number }>;
}

export interface BudgetSummary {
  scopes: Array<{
    scope: BudgetScope;
    scopeId: string;
    spent: number;
    limit: number;
    remaining: number;
    percentUsed: number;
    period: BudgetPeriod;
    resetsAt: number;
    trend: "stable" | "rising" | "spiking";
  }>;
  totalActiveReservations: number;
  totalReservedUsd: number;
}

// ── Period helpers ────────────────────────────────────────

function getResetTimestamp(period: BudgetPeriod): number {
  const now = new Date();
  switch (period) {
    case "daily": {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      return next.getTime();
    }
    case "weekly": {
      const next = new Date(now);
      const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
      next.setDate(next.getDate() + daysUntilMonday);
      next.setHours(0, 0, 0, 0);
      return next.getTime();
    }
    case "monthly": {
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return next.getTime();
    }
    case "total":
      return Number.MAX_SAFE_INTEGER;
  }
}

// ── In-Memory/File Budget Store ───────────────────────────

export class BudgetStore {
  private budgets: Map<string, BudgetRecord> = new Map();
  private storePath: string;
  /** In-memory reservation store (ephemeral within a session) */
  private reservations: Map<string, BudgetReservation> = new Map();

  constructor(storePath: string) {
    this.storePath = resolve(storePath);
    if (!existsSync(this.storePath)) mkdirSync(this.storePath, { recursive: true });
    this._load();
  }

  /** Create or update a budget limit */
  setBudget(config: BudgetConfig): BudgetRecord {
    const key = this._key(config.scope, config.scopeId);
    const existing = this.budgets.get(key);

    if (existing) {
      existing.limitUsd = config.limitUsd;
      existing.period = config.period;
      existing.updatedAt = Date.now();
      this._persist();
      return existing;
    }

    const record: BudgetRecord = {
      ...config,
      id: crypto.randomUUID(),
      spentUsd: 0,
      resetAt: getResetTimestamp(config.period),
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.budgets.set(key, record);
    this._persist();
    return record;
  }

  /** Check if spending amount is allowed */
  check(scope: BudgetScope, scopeId: string, amountUsd: number): BudgetCheckResult {
    this._resetExpired();
    this._expireReservations();
    const key = this._key(scope, scopeId);
    const budget = this.budgets.get(key);

    if (!budget || !budget.isActive) {
      // No budget set → allowed by default
      return {
        allowed: true,
        budget: budget ?? this._defaultBudget(scope, scopeId),
        remainingUsd: Infinity,
      };
    }

    // Account for active reservations against this scope
    const reserved = this._reservedFor(scope, scopeId);
    const effective = budget.spentUsd + reserved;
    const remaining = budget.limitUsd - effective;
    const allowed = remaining >= amountUsd;

    return {
      allowed,
      budget,
      remainingUsd: Math.max(0, remaining),
      reason: allowed
        ? undefined
        : `Budget exceeded: $${effective.toFixed(4)} effective spend of $${budget.limitUsd} limit (${budget.period})`,
    };
  }

  /** Record spending against a budget */
  record(scope: BudgetScope, scopeId: string, amountUsd: number): void {
    this._resetExpired();
    const key = this._key(scope, scopeId);
    const budget = this.budgets.get(key);
    if (!budget) return;

    budget.spentUsd = Math.max(0, budget.spentUsd + amountUsd);
    budget.updatedAt = Date.now();
    this._persist();
  }

  /** Get a budget record */
  get(scope: BudgetScope, scopeId: string): BudgetRecord | null {
    this._resetExpired();
    return this.budgets.get(this._key(scope, scopeId)) ?? null;
  }

  /** List all budgets */
  list(): BudgetRecord[] {
    this._resetExpired();
    return Array.from(this.budgets.values()).filter((b) => b.isActive);
  }

  /** Reset a budget's spending counter */
  reset(scope: BudgetScope, scopeId: string): void {
    const budget = this.budgets.get(this._key(scope, scopeId));
    if (budget) {
      budget.spentUsd = 0;
      budget.resetAt = getResetTimestamp(budget.period);
      budget.updatedAt = Date.now();
      this._persist();
    }
  }

  // ── Atomic Reservations ───────────────────────────────

  /**
   * Reserve funds atomically before a call.
   * The reserved amount is immediately deducted from the effective remaining
   * budget so concurrent callers cannot over-spend.
   * Returns the reservation ID on success, or null if the budget would be exceeded.
   */
  reserve(scope: BudgetScope, scopeId: string, amountUsd: number): string | null {
    this._expireReservations();
    const checkResult = this.check(scope, scopeId, amountUsd);
    if (!checkResult.allowed) return null;

    const reservation: BudgetReservation = {
      id: crypto.randomUUID(),
      scope,
      scopeId,
      amountUsd,
      reservedAt: Date.now(),
      expiresAt: Date.now() + 60_000, // 60 seconds
      committed: false,
      rolledBack: false,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation.id;
  }

  /**
   * Commit a reservation — actual spend confirmed.
   * Moves the reserved amount into spentUsd on the budget record.
   */
  commit(reservationId: string): boolean {
    this._expireReservations();
    const res = this.reservations.get(reservationId);
    if (!res || res.committed || res.rolledBack) return false;

    res.committed = true;
    this.record(res.scope, res.scopeId, res.amountUsd);
    this.reservations.delete(reservationId);
    return true;
  }

  /**
   * Rollback a reservation — call didn't happen.
   * Releases the reserved amount back to the available budget.
   */
  rollback(reservationId: string): boolean {
    const res = this.reservations.get(reservationId);
    if (!res || res.committed || res.rolledBack) return false;

    res.rolledBack = true;
    this.reservations.delete(reservationId);
    return true;
  }

  /** Get active (non-expired, uncommitted) reservations */
  getReservations(scope?: BudgetScope, scopeId?: string): BudgetReservation[] {
    this._expireReservations();
    const all = Array.from(this.reservations.values()).filter(
      (r) => !r.committed && !r.rolledBack
    );
    if (scope && scopeId) return all.filter((r) => r.scope === scope && r.scopeId === scopeId);
    if (scope) return all.filter((r) => r.scope === scope);
    return all;
  }

  // ── Private helpers ───────────────────────────────────

  private _expireReservations(): void {
    const now = Date.now();
    for (const [id, res] of this.reservations) {
      if (!res.committed && !res.rolledBack && res.expiresAt <= now) {
        // Auto-rollback: just remove it so funds are freed
        this.reservations.delete(id);
      }
    }
  }

  private _reservedFor(scope: BudgetScope, scopeId: string): number {
    let total = 0;
    for (const res of this.reservations.values()) {
      if (!res.committed && !res.rolledBack && res.scope === scope && res.scopeId === scopeId) {
        total += res.amountUsd;
      }
    }
    return total;
  }

  private _resetExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const budget of this.budgets.values()) {
      if (budget.period !== "total" && budget.resetAt <= now) {
        budget.spentUsd = 0;
        budget.resetAt = getResetTimestamp(budget.period);
        budget.updatedAt = now;
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  private _key(scope: BudgetScope, scopeId: string): string {
    return `${scope}:${scopeId}`;
  }

  private _defaultBudget(scope: BudgetScope, scopeId: string): BudgetRecord {
    return {
      id: "default",
      scope,
      scopeId,
      limitUsd: Infinity,
      spentUsd: 0,
      period: "total",
      resetAt: Number.MAX_SAFE_INTEGER,
      isActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private _load(): void {
    const file = join(this.storePath, "budgets.json");
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as BudgetRecord[];
      for (const b of data) this.budgets.set(this._key(b.scope, b.scopeId), b);
    } catch { /* skip */ }
  }

  private _persist(): void {
    const file = join(this.storePath, "budgets.json");
    try {
      writeFileSync(file, JSON.stringify(Array.from(this.budgets.values()), null, 2), "utf-8");
    } catch { /* best effort */ }
  }
}

// ── Budget History ────────────────────────────────────────

/**
 * Append-only JSONL history of all budget spend events.
 * One JSON line per entry in `{storePath}/budget-history.jsonl`.
 */
export class BudgetHistory {
  private historyFile: string;

  constructor(storePath: string) {
    const absPath = resolve(storePath);
    if (!existsSync(absPath)) mkdirSync(absPath, { recursive: true });
    this.historyFile = join(absPath, "budget-history.jsonl");
  }

  /** Append a history entry */
  record(entry: BudgetHistoryEntry): void {
    try {
      appendFileSync(this.historyFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* best effort */ }
  }

  /** Read all entries for a scope, optionally since a timestamp (ms) */
  getHistory(scope: BudgetScope, scopeId: string, since?: number): BudgetHistoryEntry[] {
    const entries = this._readAll();
    return entries.filter((e) => {
      if (e.scope !== scope || e.scopeId !== scopeId) return false;
      if (since !== undefined && e.timestamp < since) return false;
      return true;
    });
  }

  /** Aggregate all history for a scope+id */
  getAggregated(scope: BudgetScope, scopeId: string): BudgetAggregated {
    const entries = this.getHistory(scope, scopeId);

    let totalUsd = 0;
    let maxSingleCall = 0;
    let firstActivity: number | undefined;
    let lastActivity: number | undefined;
    const byModel: Record<string, { totalUsd: number; callCount: number }> = {};

    for (const e of entries) {
      totalUsd += e.amountUsd;
      if (e.amountUsd > maxSingleCall) maxSingleCall = e.amountUsd;
      if (firstActivity === undefined || e.timestamp < firstActivity) firstActivity = e.timestamp;
      if (lastActivity === undefined || e.timestamp > lastActivity) lastActivity = e.timestamp;
      if (e.model) {
        const m = byModel[e.model] ?? { totalUsd: 0, callCount: 0 };
        m.totalUsd += e.amountUsd;
        m.callCount += 1;
        byModel[e.model] = m;
      }
    }

    return {
      scopeId,
      totalUsd,
      callCount: entries.length,
      avgPerCall: entries.length > 0 ? totalUsd / entries.length : 0,
      maxSingleCall,
      firstActivity,
      lastActivity,
      byModel,
    };
  }

  /**
   * Get the top spenders within a scope type, sorted by total USD descending.
   */
  getTopSpenders(
    scope: BudgetScope,
    limit = 10,
  ): Array<{ scopeId: string; totalUsd: number; callCount: number }> {
    const entries = this._readAll().filter((e) => e.scope === scope);
    const totals = new Map<string, { totalUsd: number; callCount: number }>();

    for (const e of entries) {
      const existing = totals.get(e.scopeId) ?? { totalUsd: 0, callCount: 0 };
      existing.totalUsd += e.amountUsd;
      existing.callCount += 1;
      totals.set(e.scopeId, existing);
    }

    return Array.from(totals.entries())
      .map(([scopeId, data]) => ({ scopeId, ...data }))
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, limit);
  }

  /**
   * Delete entries older than `olderThanMs` milliseconds.
   * Rewrites the JSONL file. Returns rows deleted.
   */
  purge(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const entries = this._readAll();
    const kept = entries.filter((e) => e.timestamp >= cutoff);
    const deleted = entries.length - kept.length;
    if (deleted > 0) {
      try {
        writeFileSync(this.historyFile, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf-8");
      } catch { /* best effort */ }
    }
    return deleted;
  }

  private _readAll(): BudgetHistoryEntry[] {
    if (!existsSync(this.historyFile)) return [];
    try {
      const content = readFileSync(this.historyFile, "utf-8");
      return content.trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as BudgetHistoryEntry);
    } catch {
      return [];
    }
  }
}

// ── Budget Dashboard ──────────────────────────────────────

/**
 * Read-only view over BudgetStore + BudgetHistory.
 * Provides summaries and an ASCII table for CLI display.
 */
export class BudgetDashboard {
  constructor(
    private store: BudgetStore,
    private history: BudgetHistory,
  ) {}

  getSummary(userId?: string, projectId?: string, teamId?: string): BudgetSummary {
    const budgets = this.store.list();
    const now = Date.now();
    const reservations = this.store.getReservations();

    // Filter to relevant scopes when IDs are provided
    const relevant = budgets.filter((b) => {
      if (userId && b.scope === "user" && b.scopeId === userId) return true;
      if (projectId && b.scope === "project" && b.scopeId === projectId) return true;
      if (teamId && b.scope === "team" && b.scopeId === teamId) return true;
      if (!userId && !projectId && !teamId) return true;
      return false;
    });

    const scopes = relevant.map((b) => {
      const reserved = reservations
        .filter((r) => r.scope === b.scope && r.scopeId === b.scopeId)
        .reduce((sum, r) => sum + r.amountUsd, 0);
      const effectiveSpent = b.spentUsd + reserved;
      const remaining = Math.max(0, b.limitUsd - effectiveSpent);
      const percentUsed = b.limitUsd > 0 && b.limitUsd !== Infinity
        ? (effectiveSpent / b.limitUsd) * 100
        : 0;

      // Trend: compare last 1h vs previous 1h from history
      const trend = this._computeTrend(b.scope, b.scopeId, now);

      return {
        scope: b.scope,
        scopeId: b.scopeId,
        spent: b.spentUsd,
        limit: b.limitUsd,
        remaining,
        percentUsed,
        period: b.period,
        resetsAt: b.resetAt,
        trend,
      };
    });

    const activeRes = reservations.filter((r) => !r.committed && !r.rolledBack);
    const totalReservedUsd = activeRes.reduce((sum, r) => sum + r.amountUsd, 0);

    return {
      scopes,
      totalActiveReservations: activeRes.length,
      totalReservedUsd,
    };
  }

  /** Render an ASCII table suitable for CLI display */
  formatDashboard(userId?: string, projectId?: string): string {
    const summary = this.getSummary(userId, projectId);

    if (summary.scopes.length === 0) {
      return "No active budgets.";
    }

    const rows: string[][] = [
      ["Scope", "ID", "Spent", "Limit", "Remaining", "% Used", "Period", "Trend"],
    ];

    for (const s of summary.scopes) {
      const limitStr = s.limit === Infinity ? "∞" : `$${s.limit.toFixed(2)}`;
      rows.push([
        s.scope,
        s.scopeId.slice(0, 12),
        `$${s.spent.toFixed(4)}`,
        limitStr,
        s.limit === Infinity ? "∞" : `$${s.remaining.toFixed(4)}`,
        s.limit === Infinity ? "N/A" : `${s.percentUsed.toFixed(1)}%`,
        s.period,
        s.trend,
      ]);
    }

    // Compute column widths
    const colWidths = rows[0]!.map((_, ci) =>
      Math.max(...rows.map((r) => (r[ci] ?? "").length))
    );

    const separator = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
    const formatRow = (row: string[]) =>
      "|" + row.map((cell, i) => ` ${cell.padEnd(colWidths[i]!)} `).join("|") + "|";

    const lines = [
      separator,
      formatRow(rows[0]!),
      separator,
      ...rows.slice(1).map(formatRow),
      separator,
    ];

    if (summary.totalActiveReservations > 0) {
      lines.push(`Active reservations: ${summary.totalActiveReservations} ($${summary.totalReservedUsd.toFixed(4)} reserved)`);
    }

    return lines.join("\n");
  }

  private _computeTrend(scope: BudgetScope, scopeId: string, now: number): "stable" | "rising" | "spiking" {
    const oneHour = 60 * 60 * 1000;
    const recent = this.history.getHistory(scope, scopeId, now - oneHour);
    const prior = this.history.getHistory(scope, scopeId, now - 2 * oneHour)
      .filter((e) => e.timestamp < now - oneHour);

    const recentTotal = recent.reduce((s, e) => s + e.amountUsd, 0);
    const priorTotal = prior.reduce((s, e) => s + e.amountUsd, 0);

    if (priorTotal === 0 && recentTotal === 0) return "stable";
    if (priorTotal === 0) return recent.length > 0 ? "rising" : "stable";

    const ratio = recentTotal / priorTotal;
    if (ratio > 3) return "spiking";
    if (ratio > 1.5) return "rising";
    return "stable";
  }
}

// ── Middleware ────────────────────────────────────────────

export interface MultiScopeBudgetOptions {
  /** Budget store instance */
  store: BudgetStore;
  /** User ID for user-scoped budget checks */
  userId?: string;
  /** Project ID for project-scoped budget checks */
  projectId?: string;
  /** Per-session limit in USD */
  sessionLimitUsd?: number;
}

/**
 * Multi-scope budget enforcer middleware.
 *
 * Checks user → project → session budgets in order.
 * First scope to reject the request wins.
 * Records spending against all scopes after each LLM call.
 */
export function multiScopeBudgetMiddleware(opts: MultiScopeBudgetOptions): Middleware {
  const { store, userId, projectId, sessionLimitUsd = 2.0 } = opts;

  return {
    name: "multi-scope-budget",
    async execute(ctx: AgentContext, next: NextFn) {
      // Set up session budget
      ctx.budget.limitUsd = sessionLimitUsd;

      // Pre-flight check: estimate cost and validate against all scopes
      const estimatedCost = 0.01; // Minimal pre-check (actual tracking happens in agent loop)

      if (userId) {
        const userCheck = store.check("user", userId, estimatedCost);
        if (!userCheck.allowed) {
          ctx.abort(`User budget exceeded: ${userCheck.reason}`);
          return;
        }
        ctx.meta["userBudgetRemaining"] = userCheck.remainingUsd;
      }

      if (projectId) {
        const projCheck = store.check("project", projectId, estimatedCost);
        if (!projCheck.allowed) {
          ctx.abort(`Project budget exceeded: ${projCheck.reason}`);
          return;
        }
        ctx.meta["projectBudgetRemaining"] = projCheck.remainingUsd;
      }

      // Run the agent
      const spentBefore = ctx.budget.spentUsd;
      await next();
      const sessionSpent = ctx.budget.spentUsd - spentBefore;

      // Record actual spending against all scopes
      if (sessionSpent > 0) {
        if (userId) store.record("user", userId, sessionSpent);
        if (projectId) store.record("project", projectId, sessionSpent);
        store.record("session", ctx.sessionId, sessionSpent);
      }

      // Add budget summary to meta
      ctx.meta["budgetSummary"] = {
        sessionSpent: ctx.budget.spentUsd,
        sessionLimit: sessionLimitUsd,
        userRemaining: userId ? store.get("user", userId)?.spentUsd : undefined,
        projectRemaining: projectId ? store.get("project", projectId)?.spentUsd : undefined,
      };
    },
  };
}
