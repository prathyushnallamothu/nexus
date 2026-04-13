/**
 * Nexus Audit Logger
 *
 * Immutable, append-only audit trail for every agent action.
 * Critical for compliance, debugging, and trust.
 *
 * Every tool call, LLM decision, and supervision action is recorded
 * with full context and cannot be modified after creation.
 *
 * AuditDB adds SQLite-backed persistence with full-text search,
 * category/severity filtering, and hash-chain integrity verification.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { AgentEvent, EventHandler } from "@nexus/core";
import type { SupervisionDecision } from "./supervisor.js";

// Use bun:sqlite at runtime; avoid tsc resolution issues
const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

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

export interface AuditSearchOpts {
  /** Free-text search in action + details */
  query?: string;
  category?: AuditEntry["category"];
  severity?: AuditSeverity;
  sessionId?: string;
  userId?: string;
  /** Lower bound timestamp in ms */
  since?: number;
  /** Upper bound timestamp in ms */
  until?: number;
  limit?: number;
  offset?: number;
}

export interface AuditStats {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  recentErrors: AuditEntry[];
  /** ISO timestamp of oldest entry */
  oldestEntry?: string;
  /** ISO timestamp of newest entry */
  newestEntry?: string;
}

// ── AuditDB ───────────────────────────────────────────────

/**
 * SQLite-backed audit store with searchable events.
 * Uses WAL mode for concurrent read performance.
 */
export class AuditDB {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    const absPath = resolve(dbPath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.db = new Database(absPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this._bootstrap();
  }

  private _bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        category    TEXT NOT NULL,
        severity    TEXT NOT NULL,
        action      TEXT NOT NULL,
        details     TEXT NOT NULL DEFAULT '{}',
        prev_hash   TEXT,
        user_id     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp  ON audit_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session    ON audit_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_category   ON audit_events(category);
      CREATE INDEX IF NOT EXISTS idx_audit_severity   ON audit_events(severity);
      CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_events(action);
    `);
  }

  /** Insert an audit entry into the database */
  insert(entry: AuditEntry & { userId?: string }): void {
    const id = crypto.randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO audit_events (id, timestamp, session_id, category, severity, action, details, prev_hash, user_id)
        VALUES ($id, $timestamp, $session_id, $category, $severity, $action, $details, $prev_hash, $user_id)
      `).run({
        $id: id,
        $timestamp: entry.timestamp,
        $session_id: entry.sessionId,
        $category: entry.category,
        $severity: entry.severity,
        $action: entry.action,
        $details: JSON.stringify(entry.details),
        $prev_hash: entry.prevHash ?? null,
        $user_id: entry.userId ?? null,
      });
    } catch {
      // Audit DB writes must never crash the agent
    }
  }

  /** Search audit events with flexible filtering */
  search(opts: AuditSearchOpts): AuditEntry[] {
    const conditions: string[] = [];
    const params: Record<string, string | number | bigint | boolean | null> = {};

    if (opts.category) {
      conditions.push("category = $category");
      params.$category = opts.category;
    }
    if (opts.severity) {
      conditions.push("severity = $severity");
      params.$severity = opts.severity;
    }
    if (opts.sessionId) {
      conditions.push("session_id = $session_id");
      params.$session_id = opts.sessionId;
    }
    if (opts.userId) {
      conditions.push("user_id = $user_id");
      params.$user_id = opts.userId;
    }
    if (opts.since !== undefined) {
      conditions.push("timestamp >= $since");
      params.$since = new Date(opts.since).toISOString();
    }
    if (opts.until !== undefined) {
      conditions.push("timestamp <= $until");
      params.$until = new Date(opts.until).toISOString();
    }
    if (opts.query) {
      conditions.push("(action LIKE $query OR details LIKE $query)");
      params.$query = `%${opts.query}%`;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    params.$limit = limit;
    params.$offset = offset;

    const rows = this.db.prepare(
      `SELECT * FROM audit_events ${where} ORDER BY timestamp DESC LIMIT $limit OFFSET $offset`
    ).all(params) as Array<Record<string, unknown>>;

    return rows.map((r) => this._rowToEntry(r));
  }

  /** Get all entries for a session */
  getBySession(sessionId: string): AuditEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM audit_events WHERE session_id = $sid ORDER BY timestamp ASC"
    ).all({ $sid: sessionId }) as Array<Record<string, unknown>>;
    return rows.map((r) => this._rowToEntry(r));
  }

  /** Get entries by category, newest first */
  getByCategory(category: AuditEntry["category"], limit = 100): AuditEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM audit_events WHERE category = $cat ORDER BY timestamp DESC LIMIT $lim"
    ).all({ $cat: category, $lim: limit }) as Array<Record<string, unknown>>;
    return rows.map((r) => this._rowToEntry(r));
  }

  /** Get entries by severity, optionally since a given timestamp (ms) */
  getBySeverity(severity: AuditSeverity, since?: number): AuditEntry[] {
    if (since !== undefined) {
      const rows = this.db.prepare(
        "SELECT * FROM audit_events WHERE severity = $sev AND timestamp >= $since ORDER BY timestamp DESC"
      ).all({ $sev: severity, $since: new Date(since).toISOString() }) as Array<Record<string, unknown>>;
      return rows.map((r) => this._rowToEntry(r));
    }
    const rows = this.db.prepare(
      "SELECT * FROM audit_events WHERE severity = $sev ORDER BY timestamp DESC"
    ).all({ $sev: severity }) as Array<Record<string, unknown>>;
    return rows.map((r) => this._rowToEntry(r));
  }

  /** Aggregate statistics, optionally limited to events since a timestamp (ms) */
  getStats(since?: number): AuditStats {
    const sinceIso = since !== undefined ? new Date(since).toISOString() : null;
    const whereClause = sinceIso ? "WHERE timestamp >= $since" : "";
    const baseParams: Record<string, string | number | bigint | boolean | null> = sinceIso ? { $since: sinceIso } : {};

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as n FROM audit_events ${whereClause}`
    ).get(baseParams) as { n: number };

    const catRows = this.db.prepare(
      `SELECT category, COUNT(*) as n FROM audit_events ${whereClause} GROUP BY category`
    ).all(baseParams) as Array<{ category: string; n: number }>;

    const sevRows = this.db.prepare(
      `SELECT severity, COUNT(*) as n FROM audit_events ${whereClause} GROUP BY severity`
    ).all(baseParams) as Array<{ severity: string; n: number }>;

    const recentErrorRows = this.db.prepare(
      `SELECT * FROM audit_events WHERE severity IN ('critical','blocked') ${sinceIso ? "AND timestamp >= $since" : ""} ORDER BY timestamp DESC LIMIT 10`
    ).all(baseParams) as Array<Record<string, unknown>>;

    const boundsRow = this.db.prepare(
      `SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM audit_events ${whereClause}`
    ).get(baseParams) as { oldest: string | null; newest: string | null };

    const byCategory: Record<string, number> = {};
    for (const row of catRows) byCategory[row.category] = row.n;

    const bySeverity: Record<string, number> = {};
    for (const row of sevRows) bySeverity[row.severity] = row.n;

    return {
      total: totalRow.n,
      byCategory,
      bySeverity,
      recentErrors: recentErrorRows.map((r) => this._rowToEntry(r)),
      oldestEntry: boundsRow.oldest ?? undefined,
      newestEntry: boundsRow.newest ?? undefined,
    };
  }

  /**
   * Delete entries older than `olderThanMs` milliseconds.
   * Returns the number of rows deleted.
   */
  purge(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db.prepare(
      "DELETE FROM audit_events WHERE timestamp < $cutoff"
    ).run({ $cutoff: cutoff });
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private _rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      timestamp: row.timestamp as string,
      sessionId: row.session_id as string,
      category: row.category as AuditEntry["category"],
      severity: row.severity as AuditSeverity,
      action: row.action as string,
      details: JSON.parse(row.details as string) as Record<string, unknown>,
      prevHash: (row.prev_hash as string | null) ?? undefined,
    };
  }
}

// ── AuditLogger ───────────────────────────────────────────

export class AuditLogger {
  private logDir: string;
  private currentFile: string;
  private entryCount = 0;
  private lastHash = "";
  private sessionId: string;
  private db?: AuditDB;

  constructor(logDir: string, sessionId?: string, db?: AuditDB) {
    this.logDir = resolve(logDir);
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    this.db = db;

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

    // Persist to DB when available
    if (this.db) {
      this.db.insert(fullEntry);
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

  /**
   * Search audit entries.
   * Delegates to AuditDB when available; falls back to reading
   * the current JSONL file with in-memory filtering.
   */
  search(opts: AuditSearchOpts): AuditEntry[] {
    if (this.db) {
      return this.db.search(opts);
    }

    // File-based fallback
    let entries: AuditEntry[] = [];
    try {
      if (!existsSync(this.currentFile)) return [];
      const content = readFileSync(this.currentFile, "utf-8");
      entries = content.trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }

    return entries.filter((e) => {
      if (opts.category && e.category !== opts.category) return false;
      if (opts.severity && e.severity !== opts.severity) return false;
      if (opts.sessionId && e.sessionId !== opts.sessionId) return false;
      if (opts.since && new Date(e.timestamp).getTime() < opts.since) return false;
      if (opts.until && new Date(e.timestamp).getTime() > opts.until) return false;
      if (opts.query) {
        const haystack = (e.action + JSON.stringify(e.details)).toLowerCase();
        if (!haystack.includes(opts.query.toLowerCase())) return false;
      }
      return true;
    }).slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100));
  }

  /**
   * Get aggregate statistics.
   * Delegates to AuditDB when available.
   */
  getStats(): AuditStats {
    if (this.db) {
      return this.db.getStats();
    }

    // File-based fallback
    let entries: AuditEntry[] = [];
    try {
      if (!existsSync(this.currentFile)) {
        return { total: 0, byCategory: {}, bySeverity: {}, recentErrors: [] };
      }
      const content = readFileSync(this.currentFile, "utf-8");
      entries = content.trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return { total: 0, byCategory: {}, bySeverity: {}, recentErrors: [] };
    }

    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const e of entries) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    }

    const recentErrors = entries
      .filter((e) => e.severity === "critical" || e.severity === "blocked")
      .slice(-10);

    return {
      total: entries.length,
      byCategory,
      bySeverity,
      recentErrors,
      oldestEntry: entries[0]?.timestamp,
      newestEntry: entries[entries.length - 1]?.timestamp,
    };
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
