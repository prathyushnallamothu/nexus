/**
 * Nexus Database Schema
 *
 * Drizzle ORM schema for PostgreSQL.
 * 9 core tables covering sessions, messages, skills, memory, budgets, audit, and traces.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  numeric,
  boolean,
  timestamp,
  bigserial,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// pgvector column — stored as vector type in Postgres; falls back gracefully
// when pgvector extension is absent (column just won't be queryable by ANN).
const vector = (name: string, opts: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${opts.dimensions})`;
    },
    toDriver(val: number[]): string {
      return `[${val.join(",")}]`;
    },
    fromDriver(val: string): number[] {
      return val.replace(/[\[\]]/g, "").split(",").map(Number);
    },
  })(name);

// ── Users ─────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: text("external_id").unique(), // Slack user ID, Discord ID, etc.
  surface: text("surface").notNull().default("cli"), // 'cli', 'slack', 'discord', etc.
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Sessions ──────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  surface: text("surface").notNull(), // 'cli', 'slack', 'discord', 'telegram', 'api', 'web'
  sourceThreadId: text("source_thread_id"), // Platform-specific thread/channel ID
  status: text("status").notNull().default("active"), // 'active', 'completed', 'abandoned'
  model: text("model"),
  totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 6 }).default("0"),
  totalTokensIn: integer("total_tokens_in").default(0),
  totalTokensOut: integer("total_tokens_out").default(0),
  totalLlmCalls: integer("total_llm_calls").default(0),
  totalToolCalls: integer("total_tool_calls").default(0),
  meta: jsonb("meta").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  threadIdx: index("sessions_thread_idx").on(t.sourceThreadId),
  userIdx: index("sessions_user_idx").on(t.userId),
}));

// ── Messages ──────────────────────────────────────────────

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => sessions.id).notNull(),
  role: text("role").notNull(), // 'user', 'assistant', 'system', 'tool'
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"), // Array of ToolCall objects
  toolCallId: text("tool_call_id"), // For tool result messages
  toolName: text("tool_name"),     // For tool result messages
  tokenCount: integer("token_count"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index("messages_session_idx").on(t.sessionId),
}));

// ── Skills (Procedural Memory) ────────────────────────────

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  procedure: text("procedure").notNull(), // Markdown step-by-step
  category: text("category"),
  tags: text("tags").array().default([]),
  triggers: text("triggers").array().default([]), // Activation keywords
  version: integer("version").notNull().default(1),
  successRate: numeric("success_rate", { precision: 5, scale: 4 }).default("0"),
  avgCostUsd: numeric("avg_cost_usd", { precision: 10, scale: 6 }).default("0"),
  avgDurationMs: integer("avg_duration_ms").default(0),
  usageCount: integer("usage_count").notNull().default(0),
  embedding: vector("embedding", { dimensions: 1536 }), // pgvector for semantic search
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Skill Mutations (Memento-Skills pattern) ──────────────

export const skillMutations = pgTable("skill_mutations", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillId: uuid("skill_id").references(() => skills.id).notNull(),
  fromVersion: integer("from_version").notNull(),
  toVersion: integer("to_version").notNull(),
  mutationReason: text("mutation_reason"),
  changesSummary: text("changes_summary"),
  testPassed: boolean("test_passed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  skillIdx: index("skill_mutations_skill_idx").on(t.skillId),
}));

// ── Semantic Memory (Facts & Preferences) ────────────────

export const semanticMemory = pgTable("semantic_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  fact: text("fact").notNull(),
  category: text("category"), // 'preference', 'technical', 'personal', 'project'
  confidence: numeric("confidence", { precision: 3, scale: 2 }).default("1.0"),
  sourceSessionId: uuid("source_session_id").references(() => sessions.id),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastAccessed: timestamp("last_accessed", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("semantic_memory_user_idx").on(t.userId),
}));

// ── Episodic Memory (Past Task Outcomes) ─────────────────

export const episodicMemory = pgTable("episodic_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  sessionId: uuid("session_id").references(() => sessions.id),
  taskSummary: text("task_summary").notNull(),
  outcome: text("outcome").notNull(), // 'success', 'partial', 'failure'
  reflection: jsonb("reflection"), // Structured reflection JSON from Experience Learner
  skillExtracted: uuid("skill_extracted").references(() => skills.id),
  routingPath: text("routing_path"), // 'system1' | 'system2'
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  durationMs: integer("duration_ms"),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("episodic_memory_user_idx").on(t.userId),
}));

// ── Budgets ───────────────────────────────────────────────

export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(), // 'user', 'project', 'session', 'task'
  scopeId: text("scope_id").notNull(), // The ID of the scoped entity
  limitUsd: numeric("limit_usd", { precision: 10, scale: 2 }).notNull(),
  spentUsd: numeric("spent_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  period: text("period"), // 'daily', 'weekly', 'monthly', NULL = total
  resetAt: timestamp("reset_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeIdx: index("budgets_scope_idx").on(t.scope, t.scopeId),
}));

// ── Audit Log (Immutable) ─────────────────────────────────

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: uuid("session_id").references(() => sessions.id),
  userId: uuid("user_id").references(() => users.id),
  category: text("category").notNull(), // 'tool', 'llm', 'supervision', 'budget', 'security', 'system'
  severity: text("severity").notNull(), // 'info', 'warning', 'critical', 'blocked'
  action: text("action").notNull(),
  details: jsonb("details").notNull(),
  riskScore: numeric("risk_score", { precision: 3, scale: 2 }),
  supervisionResult: text("supervision_result"), // 'auto_approved', 'hotl_logged', 'hitl_approved', 'blocked'
  prevHash: text("prev_hash"), // Chain integrity
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index("audit_log_session_idx").on(t.sessionId),
  createdAtIdx: index("audit_log_created_at_idx").on(t.createdAt),
}));

// ── Traces (OpenTelemetry-compatible) ─────────────────────

export const traces = pgTable("traces", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => sessions.id),
  traceId: text("trace_id").notNull(), // OTel trace ID
  spanId: text("span_id").notNull(),   // OTel span ID
  parentSpanId: text("parent_span_id"),
  spanName: text("span_name").notNull(),
  spanType: text("span_type").notNull(), // 'llm_call', 'tool_execution', 'middleware', 'session'
  input: jsonb("input"),
  output: jsonb("output"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  durationMs: integer("duration_ms"),
  status: text("status").notNull().default("ok"), // 'ok', 'error'
  errorMessage: text("error_message"),
  attributes: jsonb("attributes").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index("traces_session_idx").on(t.sessionId),
  traceIdx: index("traces_trace_id_idx").on(t.traceId),
}));

// ── Relations ─────────────────────────────────────────────

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  messages: many(messages),
  auditEntries: many(auditLog),
  traces: many(traces),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
}));

export const skillsRelations = relations(skills, ({ many }) => ({
  mutations: many(skillMutations),
}));

export const skillMutationsRelations = relations(skillMutations, ({ one }) => ({
  skill: one(skills, { fields: [skillMutations.skillId], references: [skills.id] }),
}));

export const episodicMemoryRelations = relations(episodicMemory, ({ one }) => ({
  user: one(users, { fields: [episodicMemory.userId], references: [users.id] }),
  session: one(sessions, { fields: [episodicMemory.sessionId], references: [sessions.id] }),
  skill: one(skills, { fields: [episodicMemory.skillExtracted], references: [skills.id] }),
}));

// ── Type Exports ──────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillMutation = typeof skillMutations.$inferSelect;
export type NewSkillMutation = typeof skillMutations.$inferInsert;
export type SemanticMemoryEntry = typeof semanticMemory.$inferSelect;
export type NewSemanticMemoryEntry = typeof semanticMemory.$inferInsert;
export type EpisodicMemoryEntry = typeof episodicMemory.$inferSelect;
export type NewEpisodicMemoryEntry = typeof episodicMemory.$inferInsert;
export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type Trace = typeof traces.$inferSelect;
export type NewTrace = typeof traces.$inferInsert;
