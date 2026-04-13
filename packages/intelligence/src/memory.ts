/**
 * Nexus Memory System
 *
 * Two memory types following the blueprint:
 *
 * 1. SEMANTIC MEMORY — Facts, preferences, and knowledge about the user
 *    and their projects. Stored as embeddings for similarity retrieval.
 *    (e.g. "User prefers TypeScript", "Project uses PostgreSQL")
 *
 * 2. EPISODIC MEMORY — Past task outcomes and experiences.
 *    Enables the "Flight Recorder" pattern from agent_ideas.md —
 *    "have I seen a situation like this before? What happened?"
 *
 * Both types fall back to in-memory storage when the database is
 * unavailable, ensuring the CLI works without PostgreSQL.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LLMProvider } from "@nexus/core";

// ── Types ─────────────────────────────────────────────────

export interface SemanticFact {
  id: string;
  fact: string;
  category: "preference" | "technical" | "personal" | "project";
  confidence: number; // 0.0 - 1.0
  sourceSessionId?: string;
  /** Keyword-based embedding proxy (real pgvector in DB mode) */
  keywords: string[];
  createdAt: number;
  lastAccessed: number;
}

export interface EpisodicRecord {
  id: string;
  sessionId?: string;
  taskSummary: string;
  outcome: "success" | "partial" | "failure";
  /** Structured reflection JSON */
  reflection?: Record<string, unknown>;
  skillExtracted?: string;
  routingPath?: "system1" | "system2";
  costUsd?: number;
  durationMs?: number;
  keywords: string[];
  createdAt: number;
}

export interface MemorySearchResult<T> {
  item: T;
  score: number;
}

// ── Keyword similarity (used as embedding proxy) ──────────

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 30);
}

function keywordSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const word of setB) {
    if (setA.has(word)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
}

// ── In-Memory Semantic Store ──────────────────────────────

class InMemorySemanticStore {
  private facts: Map<string, SemanticFact> = new Map();
  private storePath: string;

  constructor(storePath: string) {
    this.storePath = resolve(storePath);
    if (!existsSync(this.storePath)) mkdirSync(this.storePath, { recursive: true });
    this._load();
  }

  store(
    fact: string,
    category: SemanticFact["category"],
    opts?: { confidence?: number; sourceSessionId?: string },
  ): SemanticFact {
    // Deduplicate similar facts
    const keywords = extractKeywords(fact);
    const existing = this._findSimilar(keywords, 0.8);
    if (existing) {
      // Reinforce existing fact
      existing.item.confidence = Math.min(1.0, existing.item.confidence + 0.1);
      existing.item.lastAccessed = Date.now();
      this._save(existing.item);
      return existing.item;
    }

    const entry: SemanticFact = {
      id: crypto.randomUUID(),
      fact,
      category,
      confidence: opts?.confidence ?? 1.0,
      sourceSessionId: opts?.sourceSessionId,
      keywords,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
    };
    this.facts.set(entry.id, entry);
    this._save(entry);
    return entry;
  }

  search(query: string, limit = 5): MemorySearchResult<SemanticFact>[] {
    const queryKeywords = extractKeywords(query);
    const results: MemorySearchResult<SemanticFact>[] = [];

    for (const fact of this.facts.values()) {
      const score = keywordSimilarity(queryKeywords, fact.keywords) * fact.confidence;
      if (score > 0.1) {
        results.push({ item: fact, score });
        fact.lastAccessed = Date.now();
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getAll(): SemanticFact[] {
    return Array.from(this.facts.values())
      .sort((a, b) => b.lastAccessed - a.lastAccessed);
  }

  remove(id: string): void {
    this.facts.delete(id);
  }

  private _findSimilar(keywords: string[], threshold: number): MemorySearchResult<SemanticFact> | null {
    let best: MemorySearchResult<SemanticFact> | null = null;
    for (const fact of this.facts.values()) {
      const score = keywordSimilarity(keywords, fact.keywords);
      if (score >= threshold && (!best || score > best.score)) {
        best = { item: fact, score };
      }
    }
    return best;
  }

  private _load(): void {
    const file = join(this.storePath, "semantic.json");
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as SemanticFact[];
      for (const f of data) this.facts.set(f.id, f);
    } catch { /* skip corrupted */ }
  }

  private _save(fact: SemanticFact): void {
    const file = join(this.storePath, "semantic.json");
    try {
      writeFileSync(file, JSON.stringify(Array.from(this.facts.values()), null, 2), "utf-8");
    } catch { /* best effort */ }
  }
}

// ── In-Memory Episodic Store ──────────────────────────────

class InMemoryEpisodicStore {
  private records: Map<string, EpisodicRecord> = new Map();
  private storePath: string;

  constructor(storePath: string) {
    this.storePath = resolve(storePath);
    if (!existsSync(this.storePath)) mkdirSync(this.storePath, { recursive: true });
    this._load();
  }

  record(opts: Omit<EpisodicRecord, "id" | "keywords" | "createdAt">): EpisodicRecord {
    const entry: EpisodicRecord = {
      ...opts,
      id: crypto.randomUUID(),
      keywords: extractKeywords(opts.taskSummary),
      createdAt: Date.now(),
    };
    this.records.set(entry.id, entry);

    // Keep last 500 episodes
    if (this.records.size > 500) {
      const oldest = Array.from(this.records.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.records.delete(oldest[0]);
    }

    this._save();
    return entry;
  }

  /**
   * Find similar past episodes — the "Flight Recorder" pattern.
   * "Have I seen a situation like this before? What happened?"
   */
  findSimilar(taskDescription: string, limit = 5): MemorySearchResult<EpisodicRecord>[] {
    const queryKeywords = extractKeywords(taskDescription);
    const results: MemorySearchResult<EpisodicRecord>[] = [];

    for (const record of this.records.values()) {
      const score = keywordSimilarity(queryKeywords, record.keywords);
      if (score > 0.15) results.push({ item: record, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get near-miss memories — tasks that partially or fully failed,
   * to warn the agent before repeating a mistake.
   */
  getNearMisses(taskDescription: string, limit = 3): EpisodicRecord[] {
    return this.findSimilar(taskDescription, limit * 2)
      .filter((r) => r.item.outcome !== "success")
      .slice(0, limit)
      .map((r) => r.item);
  }

  getRecent(limit = 20): EpisodicRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getStats(): { total: number; successes: number; failures: number; partials: number } {
    let successes = 0, failures = 0, partials = 0;
    for (const r of this.records.values()) {
      if (r.outcome === "success") successes++;
      else if (r.outcome === "failure") failures++;
      else partials++;
    }
    return { total: this.records.size, successes, failures, partials };
  }

  private _load(): void {
    const file = join(this.storePath, "episodic.json");
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as EpisodicRecord[];
      for (const r of data) this.records.set(r.id, r);
    } catch { /* skip corrupted */ }
  }

  private _save(): void {
    const file = join(this.storePath, "episodic.json");
    try {
      writeFileSync(file, JSON.stringify(Array.from(this.records.values()), null, 2), "utf-8");
    } catch { /* best effort */ }
  }
}

// ── Unified Memory Manager ────────────────────────────────

export class MemoryManager {
  readonly semantic: InMemorySemanticStore;
  readonly episodic: InMemoryEpisodicStore;
  private provider?: LLMProvider;

  constructor(memoryDir: string, provider?: LLMProvider) {
    this.semantic = new InMemorySemanticStore(join(memoryDir, "semantic"));
    this.episodic = new InMemoryEpisodicStore(join(memoryDir, "episodic"));
    this.provider = provider;
  }

  /**
   * Build a context injection string for the current task.
   * Prepends relevant memories to the system prompt.
   */
  async buildContextInjection(task: string): Promise<string> {
    const lines: string[] = [];

    // 1. Relevant semantic facts
    const facts = this.semantic.search(task, 5);
    if (facts.length) {
      lines.push("## What I know about you:");
      for (const { item } of facts) {
        lines.push(`- ${item.fact} (confidence: ${(item.confidence * 100).toFixed(0)}%)`);
      }
    }

    // 2. Near-miss warnings (Flight Recorder pattern)
    const nearMisses = this.episodic.getNearMisses(task, 3);
    if (nearMisses.length) {
      lines.push("\n## Similar past tasks that went wrong:");
      for (const miss of nearMisses) {
        const reflection = miss.reflection as any;
        const failPoints = reflection?.failurePoints ?? [];
        lines.push(`- "${miss.taskSummary}" → ${miss.outcome}`);
        if (failPoints.length) {
          lines.push(`  Failure reason: ${failPoints[0]}`);
        }
      }
    }

    // 3. Similar successful episodes
    const similar = this.episodic.findSimilar(task, 3)
      .filter((r) => r.item.outcome === "success");
    if (similar.length) {
      lines.push("\n## Similar tasks I've done successfully:");
      for (const { item } of similar) {
        lines.push(`- "${item.taskSummary}" (cost: $${item.costUsd?.toFixed(4) ?? "?"})`);
        if (item.skillExtracted) {
          lines.push(`  Skill learned: ${item.skillExtracted}`);
        }
      }
    }

    return lines.length ? `\n${lines.join("\n")}\n` : "";
  }

  /**
   * Extract and store facts from a completed session using LLM.
   * Runs in the background after a task completes.
   */
  async extractAndStoreFacts(
    userMessages: string[],
    sessionId?: string,
  ): Promise<SemanticFact[]> {
    if (!this.provider || !userMessages.length) return [];

    try {
      const response = await this.provider.complete(
        [
          {
            role: "system",
            content: `Extract factual statements about the user or their project from these messages.
Only extract clear, generalizable facts (not task-specific details).
Respond with JSON array: [{"fact": "...", "category": "preference|technical|personal|project"}]
Return [] if no memorable facts found.`,
          },
          {
            role: "user",
            content: userMessages.slice(-5).join("\n\n"),
          },
        ],
        [],
        { temperature: 0.1 },
      );

      const jsonStr = response.content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      const facts = JSON.parse(jsonStr) as Array<{ fact: string; category: SemanticFact["category"] }>;
      return facts.map((f) =>
        this.semantic.store(f.fact, f.category, { sourceSessionId: sessionId }),
      );
    } catch {
      return [];
    }
  }

  getStats(): {
    semanticFacts: number;
    episodicRecords: number;
    episodicOutcomes: ReturnType<InMemoryEpisodicStore["getStats"]>;
  } {
    return {
      semanticFacts: this.semantic.getAll().length,
      episodicRecords: this.episodic.getStats().total,
      episodicOutcomes: this.episodic.getStats(),
    };
  }
}
