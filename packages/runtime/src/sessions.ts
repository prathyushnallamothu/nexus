/**
 * Nexus Session Store
 *
 * Persists conversation sessions to PostgreSQL.
 * Falls back to an in-memory store when the database is unavailable.
 */

import { getDb } from "./db.js";
import type { Session as DbSession } from "@nexus/db";

// Lazy-load drizzle operators to avoid hard crash when drizzle-orm is absent
function orm() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { eq, desc } = require("drizzle-orm") as typeof import("drizzle-orm");
  return { eq, desc };
}

// ── Session Types ─────────────────────────────────────────

export interface StoredSession {
  id: string;
  userId?: string;
  surface: string;
  sourceThreadId?: string;
  status: "active" | "completed" | "abandoned";
  model?: string;
  messages: StoredMessage[];
  budget: StoredBudget;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: unknown;
  toolCallId?: string;
  toolName?: string;
  tokenCount?: number;
  costUsd?: number;
  createdAt: number;
}

export interface StoredBudget {
  limitUsd: number;
  spentUsd: number;
  tokensIn: number;
  tokensOut: number;
  llmCalls: number;
  toolCalls: number;
}

// ── In-Memory Fallback ────────────────────────────────────

class InMemorySessionStore {
  private sessions = new Map<string, StoredSession>();

  async create(opts: {
    surface: string;
    sourceThreadId?: string;
    userId?: string;
    model?: string;
    limitUsd?: number;
  }): Promise<StoredSession> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: StoredSession = {
      id,
      userId: opts.userId,
      surface: opts.surface,
      sourceThreadId: opts.sourceThreadId,
      status: "active",
      model: opts.model,
      messages: [],
      budget: {
        limitUsd: opts.limitUsd ?? 2.0,
        spentUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        llmCalls: 0,
        toolCalls: 0,
      },
      meta: {},
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  async get(id: string): Promise<StoredSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async getByThread(surface: string, threadId: string): Promise<StoredSession | null> {
    for (const session of this.sessions.values()) {
      if (
        session.surface === surface &&
        session.sourceThreadId === threadId &&
        session.status === "active"
      ) {
        return session;
      }
    }
    return null;
  }

  async addMessage(sessionId: string, msg: Omit<StoredMessage, "id" | "createdAt">): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push({ ...msg, id: crypto.randomUUID(), createdAt: Date.now() });
    session.updatedAt = Date.now();
  }

  async updateBudget(sessionId: string, budget: Partial<StoredBudget>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    Object.assign(session.budget, budget);
    session.updatedAt = Date.now();
  }

  async complete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "completed";
      session.updatedAt = Date.now();
    }
  }

  async list(limit = 20): Promise<StoredSession[]> {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  get storeType(): "memory" { return "memory"; }
}

// ── PostgreSQL-backed Store ───────────────────────────────

class PostgresSessionStore {
  async create(opts: {
    surface: string;
    sourceThreadId?: string;
    userId?: string;
    model?: string;
    limitUsd?: number;
  }): Promise<StoredSession> {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    const { sessions, messages: msgsTable } = await import("@nexus/db");

    const [row] = await db
      .insert(sessions)
      .values({
        surface: opts.surface,
        sourceThreadId: opts.sourceThreadId,
        userId: opts.userId,
        model: opts.model,
        status: "active",
        meta: {},
      })
      .returning();

    return this._toStored(row, []);
  }

  async get(id: string): Promise<StoredSession | null> {
    const db = getDb();
    if (!db) return null;

    const { eq } = orm();
    const { sessions, messages: msgsTable } = await import("@nexus/db");
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!rows.length) return null;

    const msgs = await db
      .select()
      .from(msgsTable)
      .where(eq(msgsTable.sessionId, id))
      .orderBy(msgsTable.createdAt);

    return this._toStored(rows[0], msgs);
  }

  async getByThread(surface: string, threadId: string): Promise<StoredSession | null> {
    const db = getDb();
    if (!db) return null;

    const { eq, desc } = orm();
    const { sessions } = await import("@nexus/db");
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sourceThreadId, threadId))
      .orderBy(desc(sessions.createdAt))
      .limit(1);

    if (!rows.length || rows[0].surface !== surface) return null;
    return this.get(rows[0].id);
  }

  async addMessage(sessionId: string, msg: Omit<StoredMessage, "id" | "createdAt">): Promise<void> {
    const db = getDb();
    if (!db) return;

    const { messages: msgsTable } = await import("@nexus/db");
    await db.insert(msgsTable).values({
      sessionId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls as any,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      tokenCount: msg.tokenCount,
      costUsd: msg.costUsd?.toString(),
    });
  }

  async updateBudget(sessionId: string, budget: Partial<StoredBudget>): Promise<void> {
    const db = getDb();
    if (!db) return;

    const { eq } = orm();
    const { sessions } = await import("@nexus/db");
    await db
      .update(sessions)
      .set({
        totalCostUsd: budget.spentUsd?.toString(),
        totalTokensIn: budget.tokensIn,
        totalTokensOut: budget.tokensOut,
        totalLlmCalls: budget.llmCalls,
        totalToolCalls: budget.toolCalls,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
  }

  async complete(sessionId: string): Promise<void> {
    const db = getDb();
    if (!db) return;

    const { eq } = orm();
    const { sessions } = await import("@nexus/db");
    await db
      .update(sessions)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  async list(limit = 20): Promise<StoredSession[]> {
    const db = getDb();
    if (!db) return [];

    const { desc } = orm();
    const { sessions } = await import("@nexus/db");
    const rows = await db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.createdAt))
      .limit(limit);

    return rows.map((r: DbSession) => this._toStored(r, []));
  }

  private _toStored(row: DbSession, msgs: any[]): StoredSession {
    return {
      id: row.id,
      userId: row.userId ?? undefined,
      surface: row.surface,
      sourceThreadId: row.sourceThreadId ?? undefined,
      status: row.status as "active" | "completed" | "abandoned",
      model: row.model ?? undefined,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? undefined,
        toolCallId: m.toolCallId ?? undefined,
        toolName: m.toolName ?? undefined,
        tokenCount: m.tokenCount ?? undefined,
        costUsd: m.costUsd ? parseFloat(m.costUsd) : undefined,
        createdAt: m.createdAt.getTime(),
      })),
      budget: {
        limitUsd: 2.0,
        spentUsd: parseFloat(row.totalCostUsd?.toString() ?? "0"),
        tokensIn: row.totalTokensIn ?? 0,
        tokensOut: row.totalTokensOut ?? 0,
        llmCalls: row.totalLlmCalls ?? 0,
        toolCalls: row.totalToolCalls ?? 0,
      },
      meta: (row.meta as Record<string, unknown>) ?? {},
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }

  get storeType(): "postgres" { return "postgres"; }
}

// ── Unified Store ─────────────────────────────────────────

export interface ISessionStore {
  create(opts: {
    surface: string;
    sourceThreadId?: string;
    userId?: string;
    model?: string;
    limitUsd?: number;
  }): Promise<StoredSession>;
  get(id: string): Promise<StoredSession | null>;
  getByThread(surface: string, threadId: string): Promise<StoredSession | null>;
  addMessage(sessionId: string, msg: Omit<StoredMessage, "id" | "createdAt">): Promise<void>;
  updateBudget(sessionId: string, budget: Partial<StoredBudget>): Promise<void>;
  complete(sessionId: string): Promise<void>;
  list(limit?: number): Promise<StoredSession[]>;
  readonly storeType: string;
}

let _store: ISessionStore | null = null;

export function getSessionStore(): ISessionStore {
  if (_store) return _store;

  const db = getDb();
  if (db) {
    _store = new PostgresSessionStore();
  } else {
    _store = new InMemorySessionStore();
  }

  return _store;
}

// Allow forcing a specific store (useful for testing)
export function setSessionStore(store: ISessionStore): void {
  _store = store;
}
