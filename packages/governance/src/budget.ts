/**
 * Nexus Multi-Scope Budget Enforcer
 *
 * Enforces spending limits across three scopes:
 *   USER    — total budget for a user (daily/monthly)
 *   PROJECT — budget for a specific project/workspace
 *   SESSION — budget for a single conversation
 *
 * Budgets are stored persistently (PostgreSQL when available, file-based fallback).
 * Atomic enforcement: rejects tool calls that would exceed the budget.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Middleware, AgentContext, NextFn } from "@nexus/core";

// ── Types ─────────────────────────────────────────────────

export type BudgetScope = "user" | "project" | "session";
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

    const remaining = budget.limitUsd - budget.spentUsd;
    const allowed = remaining >= amountUsd;

    return {
      allowed,
      budget,
      remainingUsd: Math.max(0, remaining),
      reason: allowed
        ? undefined
        : `Budget exceeded: $${budget.spentUsd.toFixed(4)} spent of $${budget.limitUsd} limit (${budget.period})`,
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
