/**
 * Nexus Approval Queue
 *
 * Persistent HITL (Human-in-the-Loop) approval system.
 * Queues risky actions, notifies operators, and waits for decisions.
 *
 * Storage: SQLite (bun:sqlite) at {nexusHome}/governance/approvals.db
 *
 * Approval channels:
 *   cli      — interactive readline prompt in the terminal
 *   slack    — posts to webhook URL, polls for reaction
 *   github   — creates GitHub issue comment, polls for approval label
 *   auto     — automatic approval (for testing / CI)
 *   deny     — automatic denial (for CI strict mode)
 *
 * States: pending → approved | denied | expired | cancelled
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { DynamicSupervisor, type SupervisionDecision } from "./supervisor.js";

// Use bun:sqlite at runtime; avoid tsc resolution issues
const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

// ── Types ──────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalChannel = "cli" | "slack" | "github" | "auto" | "deny";

export interface ApprovalRequest {
  id: string;                  // UUID
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;              // why approval is needed
  riskLevel: "low" | "medium" | "high" | "critical";
  status: ApprovalStatus;
  channel: ApprovalChannel;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;          // user/system that decided
  notes?: string;
  expiresAt?: number;          // auto-deny after timeout
}

export interface ApprovalResult {
  approved: boolean;
  request: ApprovalRequest;
  decidedBy?: string;
}

interface ApprovalQueueOpts {
  defaultChannel?: ApprovalChannel;
  expiryMs?: number;
  slackWebhookUrl?: string;
  githubRepo?: string;
  githubToken?: string;
}

// ── ApprovalQueue ──────────────────────────────────────────

export class ApprovalQueue {
  private db: InstanceType<typeof Database>;
  private defaultChannel: ApprovalChannel;
  private expiryMs: number;
  private slackWebhookUrl?: string;
  private githubRepo?: string;
  private githubToken?: string;

  constructor(dbPath: string, opts?: ApprovalQueueOpts) {
    const absPath = resolve(dbPath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.db = new Database(absPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.defaultChannel = opts?.defaultChannel ?? "cli";
    this.expiryMs = opts?.expiryMs ?? 5 * 60 * 1000; // 5 minutes default
    this.slackWebhookUrl = opts?.slackWebhookUrl;
    this.githubRepo = opts?.githubRepo;
    this.githubToken = opts?.githubToken;
    this._bootstrap();
  }

  private _bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        args          TEXT NOT NULL DEFAULT '{}',
        reason        TEXT NOT NULL DEFAULT '',
        risk_level    TEXT NOT NULL DEFAULT 'medium',
        status        TEXT NOT NULL DEFAULT 'pending',
        channel       TEXT NOT NULL DEFAULT 'cli',
        requested_at  INTEGER NOT NULL,
        decided_at    INTEGER,
        decided_by    TEXT,
        notes         TEXT,
        expires_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_status      ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_session     ON approvals(session_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_requested   ON approvals(requested_at DESC);
    `);
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Submit a new approval request and block until a decision is reached
   * or the request expires.
   */
  async request(
    req: Omit<ApprovalRequest, "id" | "requestedAt" | "status">,
  ): Promise<ApprovalResult> {
    const now = Date.now();
    const id = randomUUID();
    const channel = req.channel ?? this.defaultChannel;
    const expiresAt = now + this.expiryMs;

    const record: ApprovalRequest = {
      ...req,
      id,
      status: "pending",
      requestedAt: now,
      expiresAt,
      channel,
    };

    this._insert(record);

    // Dispatch to the appropriate channel handler
    let result: ApprovalResult;
    switch (channel) {
      case "auto":
        result = await this._handleAuto(record);
        break;
      case "deny":
        result = await this._handleDeny(record);
        break;
      case "cli":
        result = await this._handleCli(record);
        break;
      case "slack":
        result = await this._handleSlack(record);
        break;
      case "github":
        result = await this._handleGitHub(record);
        break;
      default:
        result = await this._handleCli(record);
    }

    return result;
  }

  /** Approve a pending request. */
  approve(id: string, by?: string, notes?: string): boolean {
    return this._decide(id, "approved", by, notes);
  }

  /** Deny a pending request. */
  deny(id: string, by?: string, notes?: string): boolean {
    return this._decide(id, "denied", by, notes);
  }

  /** Cancel a pending request. */
  cancel(id: string): boolean {
    return this._decide(id, "cancelled");
  }

  /** Get all currently pending requests (checks for expired entries first). */
  getPending(): ApprovalRequest[] {
    this._expireStale();
    const rows = this.db.prepare(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC",
    ).all() as Record<string, unknown>[];
    return rows.map(this._rowToRequest);
  }

  /** Get the most recent N requests of any status. */
  getRecent(limit = 20): ApprovalRequest[] {
    const rows = this.db.prepare(
      "SELECT * FROM approvals ORDER BY requested_at DESC LIMIT $lim",
    ).all({ $lim: limit }) as Record<string, unknown>[];
    return rows.map(this._rowToRequest);
  }

  /** Return aggregate counts by status. */
  getStats(): { pending: number; approved: number; denied: number; expired: number } {
    this._expireStale();
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as cnt FROM approvals GROUP BY status",
    ).all() as Array<{ status: string; cnt: number }>;
    const out = { pending: 0, approved: 0, denied: 0, expired: 0 };
    for (const r of rows) {
      const k = r.status as keyof typeof out;
      if (k in out) out[k] = r.cnt;
    }
    return out;
  }

  // ── Channel handlers ───────────────────────────────────

  private async _handleAuto(req: ApprovalRequest): Promise<ApprovalResult> {
    this._decide(req.id, "approved", "auto");
    const updated = this._getById(req.id)!;
    return { approved: true, request: updated, decidedBy: "auto" };
  }

  private async _handleDeny(req: ApprovalRequest): Promise<ApprovalResult> {
    this._decide(req.id, "denied", "deny");
    const updated = this._getById(req.id)!;
    return { approved: false, request: updated, decidedBy: "deny" };
  }

  private async _handleCli(req: ApprovalRequest): Promise<ApprovalResult> {
    const argsPreview = JSON.stringify(req.args, null, 2).slice(0, 300);
    const riskBadge =
      req.riskLevel === "critical" ? "CRITICAL" :
      req.riskLevel === "high"     ? "HIGH" :
      req.riskLevel === "medium"   ? "MEDIUM" : "LOW";

    process.stdout.write(`\n${"─".repeat(60)}\n`);
    process.stdout.write(`  NEXUS APPROVAL REQUEST [${riskBadge}]\n`);
    process.stdout.write(`  ID:      ${req.id}\n`);
    process.stdout.write(`  Tool:    ${req.toolName}\n`);
    process.stdout.write(`  Reason:  ${req.reason}\n`);
    process.stdout.write(`  Args:\n${argsPreview}\n`);
    process.stdout.write(`${"─".repeat(60)}\n`);

    return new Promise<ApprovalResult>((resolvePromise) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      // Set up expiry timeout
      const timer = setTimeout(() => {
        rl.close();
        this._decide(req.id, "expired", "cli-timeout");
        const updated = this._getById(req.id)!;
        resolvePromise({ approved: false, request: updated, decidedBy: "cli-timeout" });
      }, this.expiryMs);

      rl.question("  Approve? [y/N]: ", (answer) => {
        clearTimeout(timer);
        rl.close();

        const approved = answer.trim().toLowerCase() === "y";
        const status: ApprovalStatus = approved ? "approved" : "denied";
        this._decide(req.id, status, process.env["USER"] ?? "cli");
        const updated = this._getById(req.id)!;
        resolvePromise({ approved, request: updated, decidedBy: process.env["USER"] ?? "cli" });
      });
    });
  }

  private async _handleSlack(req: ApprovalRequest): Promise<ApprovalResult> {
    if (!this.slackWebhookUrl) {
      // Fallback to CLI if no webhook configured
      process.stderr.write("[nexus:approval] Slack channel configured but no webhook URL — falling back to CLI\n");
      return this._handleCli(req);
    }

    const message = {
      text: `*Nexus Approval Request* [${req.riskLevel.toUpperCase()}]`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Tool:* \`${req.toolName}\`\n*Reason:* ${req.reason}\n*Approval ID:* \`${req.id}\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Args:*\n\`\`\`${JSON.stringify(req.args, null, 2).slice(0, 500)}\`\`\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `To approve: \`nexus approval approve ${req.id}\`\nTo deny: \`nexus approval deny ${req.id}\``,
          },
        },
      ],
    };

    try {
      await fetch(this.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
    } catch (err) {
      process.stderr.write(`[nexus:approval] Slack notification failed: ${err}\n`);
    }

    // Poll the DB until a decision is made or the request expires
    return this._pollForDecision(req);
  }

  private async _handleGitHub(req: ApprovalRequest): Promise<ApprovalResult> {
    if (!this.githubRepo || !this.githubToken) {
      process.stderr.write("[nexus:approval] GitHub channel configured but missing repo/token — falling back to CLI\n");
      return this._handleCli(req);
    }

    const [owner, repoName] = this.githubRepo.split("/");
    const issueBody = [
      `**Nexus Approval Request** — Risk Level: **${req.riskLevel.toUpperCase()}**`,
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Approval ID | \`${req.id}\` |`,
      `| Tool | \`${req.toolName}\` |`,
      `| Session | \`${req.sessionId}\` |`,
      `| Reason | ${req.reason} |`,
      "",
      "**Arguments:**",
      "```json",
      JSON.stringify(req.args, null, 2).slice(0, 1000),
      "```",
      "",
      `To approve, add the label \`nexus-approved\` to this issue.`,
      `To deny, add the label \`nexus-denied\` to this issue.`,
    ].join("\n");

    let issueNumber: number | null = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          title: `[Nexus Approval] ${req.toolName} — ${req.riskLevel}`,
          body: issueBody,
          labels: ["nexus-approval-pending"],
        }),
      });
      if (res.ok) {
        const data = await res.json() as { number: number };
        issueNumber = data.number;
      }
    } catch (err) {
      process.stderr.write(`[nexus:approval] GitHub issue creation failed: ${err}\n`);
    }

    if (!issueNumber) {
      return this._handleCli(req);
    }

    // Poll for label change
    return this._pollForDecision(req, async () => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/labels`,
          {
            headers: {
              Authorization: `Bearer ${this.githubToken}`,
              Accept: "application/vnd.github+json",
            },
          },
        );
        if (!res.ok) return;
        const labels = await res.json() as Array<{ name: string }>;
        const names = labels.map((l) => l.name);
        if (names.includes("nexus-approved")) {
          this._decide(req.id, "approved", "github");
        } else if (names.includes("nexus-denied")) {
          this._decide(req.id, "denied", "github");
        }
      } catch {
        // ignore poll errors
      }
    });
  }

  /**
   * Poll the DB every 3 seconds until the request transitions from "pending".
   * An optional `sideEffect` async function is called each poll iteration
   * (used by GitHub to check label changes).
   */
  private async _pollForDecision(
    req: ApprovalRequest,
    sideEffect?: () => Promise<void>,
  ): Promise<ApprovalResult> {
    const pollIntervalMs = 3000;
    const deadline = Date.now() + this.expiryMs;

    return new Promise<ApprovalResult>((resolvePromise) => {
      const poll = async () => {
        if (sideEffect) {
          try {
            await sideEffect();
          } catch {
            // ignore
          }
        }

        const current = this._getById(req.id);
        if (!current) {
          resolvePromise({ approved: false, request: req, decidedBy: undefined });
          return;
        }

        if (current.status !== "pending") {
          resolvePromise({
            approved: current.status === "approved",
            request: current,
            decidedBy: current.decidedBy,
          });
          return;
        }

        if (Date.now() >= deadline) {
          this._decide(req.id, "expired", "timeout");
          const expired = this._getById(req.id)!;
          resolvePromise({ approved: false, request: expired, decidedBy: "timeout" });
          return;
        }

        setTimeout(() => { void poll(); }, pollIntervalMs);
      };

      void poll();
    });
  }

  // ── Internal helpers ───────────────────────────────────

  private _insert(req: ApprovalRequest): void {
    this.db.prepare(`
      INSERT INTO approvals (
        id, session_id, tool_name, args, reason, risk_level, status,
        channel, requested_at, decided_at, decided_by, notes, expires_at
      ) VALUES (
        $id, $session_id, $tool_name, $args, $reason, $risk_level, $status,
        $channel, $requested_at, $decided_at, $decided_by, $notes, $expires_at
      )
    `).run({
      $id: req.id,
      $session_id: req.sessionId,
      $tool_name: req.toolName,
      $args: JSON.stringify(req.args),
      $reason: req.reason,
      $risk_level: req.riskLevel,
      $status: req.status,
      $channel: req.channel,
      $requested_at: req.requestedAt,
      $decided_at: req.decidedAt ?? null,
      $decided_by: req.decidedBy ?? null,
      $notes: req.notes ?? null,
      $expires_at: req.expiresAt ?? null,
    });
  }

  private _decide(id: string, status: ApprovalStatus, by?: string, notes?: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE approvals
      SET status = $status, decided_at = $decided_at, decided_by = $decided_by, notes = $notes
      WHERE id = $id AND status = 'pending'
    `).run({
      $id: id,
      $status: status,
      $decided_at: now,
      $decided_by: by ?? null,
      $notes: notes ?? null,
    });
    return (result.changes ?? 0) > 0;
  }

  private _expireStale(): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE approvals
      SET status = 'expired', decided_at = $now, decided_by = 'system'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < $now
    `).run({ $now: now });
  }

  private _getById(id: string): ApprovalRequest | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = $id").get({ $id: id }) as Record<string, unknown> | undefined;
    return row ? this._rowToRequest(row) : null;
  }

  private _rowToRequest(row: Record<string, unknown>): ApprovalRequest {
    return {
      id: row["id"] as string,
      sessionId: row["session_id"] as string,
      toolName: row["tool_name"] as string,
      args: JSON.parse((row["args"] as string) || "{}"),
      reason: row["reason"] as string,
      riskLevel: row["risk_level"] as ApprovalRequest["riskLevel"],
      status: row["status"] as ApprovalStatus,
      channel: row["channel"] as ApprovalChannel,
      requestedAt: row["requested_at"] as number,
      decidedAt: (row["decided_at"] as number | null) ?? undefined,
      decidedBy: (row["decided_by"] as string | null) ?? undefined,
      notes: (row["notes"] as string | null) ?? undefined,
      expiresAt: (row["expires_at"] as number | null) ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ── createInteractiveSupervisor ────────────────────────────

/**
 * Create a DynamicSupervisor with its HITL approval callback wired to
 * an ApprovalQueue and the given channel.
 */
export function createInteractiveSupervisor(
  approvalQueue: ApprovalQueue,
  channel: ApprovalChannel,
): DynamicSupervisor {
  return new DynamicSupervisor({
    onApprovalNeeded: async (decision: SupervisionDecision): Promise<boolean> => {
      const result = await approvalQueue.request({
        sessionId: `session_${Date.now()}`,
        toolName: decision.toolName,
        args: {},
        reason: decision.reason,
        riskLevel: decision.level === "block" ? "critical" : "high",
        channel,
      });
      return result.approved;
    },
  });
}
