/**
 * Nexus Skill Store
 *
 * Procedural memory — learned workflows promoted through an approval
 * pipeline before they reach the fast path.
 *
 * Status machine:
 *   draft → pending_review → trusted → retired
 *
 * Skill definitions are JSON files (human-readable, git-trackable).
 * Metrics, approvals, and evals live in SQLite (learning.db).
 *
 * Features:
 *   - Status-gated fast-path (only "trusted" skills reach System 1)
 *   - Full versioning + changelog
 *   - Provenance (which trajectory created/updated this skill)
 *   - Project-specific vs global skills
 *   - Import/export (agentskills.io-compatible format)
 *   - Confidence calibration using Wilson score interval
 *   - Hybrid lexical + TF-IDF retrieval
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { SkillStatus } from "./db.js";

// ── Types ──────────────────────────────────────────────────

export interface Skill {
  /** Unique slug identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this skill does */
  description: string;
  /** Step-by-step procedure (markdown) */
  procedure: string;
  /** Category for hierarchical organization */
  category: string;
  /** Tags for filtering */
  tags: string[];
  /** Trigger patterns — keywords that activate this skill */
  triggers: string[];
  /** Current version (monotonic) */
  version: number;
  /** Approval status */
  status: SkillStatus;
  /** Scope: global (available everywhere) or project-specific */
  scope: "global" | "project";
  /** Project ID this skill belongs to (if scope = "project") */
  projectId?: string;
  /** Where this skill came from */
  provenance: {
    createdBy: "learner" | "import" | "manual";
    sourceTrajectoryIds: string[];
    importedFrom?: string;
  };
  /** Changelog entries (most recent last) */
  changelog: SkillChange[];
  /** Wilson score confidence interval — calibrated, not raw success rate */
  confidence: {
    lower: number;   // Wilson lower bound (0–1)
    upper: number;   // Wilson upper bound (0–1)
    point: number;   // Point estimate (MLE)
    n: number;       // Sample size
  };
  /** Timestamps */
  createdAt: number;
  updatedAt: number;
}

export interface SkillChange {
  version: number;
  field: string;
  summary: string;
  trajectoryId?: string;
  changedAt: number;
}

export interface SkillMatch {
  skill: Skill;
  confidence: number;
  matchedTrigger: string;
  matchMethod: "trigger" | "name" | "description" | "tag" | "tfidf";
}

/** agentskills.io-compatible export format */
export interface SkillExport {
  version: "1.0";
  exportedAt: string;
  skills: Array<{
    name: string;
    description: string;
    procedure: string;
    category: string;
    tags: string[];
    triggers: string[];
  }>;
}

// ── Wilson Score Confidence Interval ──────────────────────

/**
 * Wilson score interval for binomial proportion.
 * More honest than raw success rate — accounts for sample size.
 * With 3 uses and 100% success: lower=0.29 (not trustworthy yet).
 * With 50 uses and 90% success: lower=0.78 (reliable).
 */
function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): { lower: number; upper: number; point: number; n: number } {
  if (n === 0) return { lower: 0, upper: 1, point: 0, n: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    point: p,
    n,
  };
}

// ── TF-IDF ─────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for",
  "of","with","by","from","as","is","was","are","were","be",
  "this","that","it","its","i","you","we","they","have","has",
  "do","does","did","will","can","could","should","would","may",
]);

function extractTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function computeTFIDF(
  query: string[],
  docTerms: string[],
  corpusSize: number,
  docFreq: Map<string, number>,
): number {
  if (!query.length || !docTerms.length) return 0;
  const termFreq = new Map<string, number>();
  for (const t of docTerms) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of query) {
    const tf = (termFreq.get(term) ?? 0) / docTerms.length;
    if (tf === 0) continue;
    const df = docFreq.get(term) ?? 1;
    const idf = Math.log((corpusSize + 1) / (df + 1)) + 1;
    score += tf * idf;
  }
  return score;
}

// ── Skill Store ────────────────────────────────────────────

export class SkillStore {
  private skills: Map<string, Skill> = new Map();
  private skillsDir: string;
  private docFreq: Map<string, number> = new Map();

  constructor(skillsDir: string) {
    this.skillsDir = resolve(skillsDir);
    mkdirSync(this.skillsDir, { recursive: true });
    this.loadFromDisk();
    this.buildDocFreq();
  }

  // ── Retrieval ─────────────────────────────────────────────

  /**
   * Find the best trusted skill matching a task.
   * Uses hybrid lexical + TF-IDF scoring.
   * Only returns "trusted" skills unless anyStatus is set.
   */
  find(
    taskDescription: string,
    threshold = 0.5,
    opts?: { anyStatus?: boolean; projectId?: string },
  ): SkillMatch | null {
    let bestMatch: SkillMatch | null = null;
    const queryTerms = extractTerms(taskDescription);

    for (const skill of this.skills.values()) {
      if (!opts?.anyStatus && skill.status !== "trusted") continue;
      if (skill.scope === "project" && opts?.projectId && skill.projectId !== opts.projectId) continue;

      const [score, method] = this.scoreMatch(skill, taskDescription, queryTerms);
      if (score >= threshold && (!bestMatch || score > bestMatch.confidence)) {
        bestMatch = {
          skill,
          confidence: score,
          matchedTrigger: this.findMatchedTrigger(skill, taskDescription),
          matchMethod: method,
        };
      }
    }

    return bestMatch;
  }

  /** Find all matching skills, ranked. Used for search and recommendations. */
  findAll(
    taskDescription: string,
    threshold = 0.2,
    opts?: { anyStatus?: boolean; limit?: number },
  ): SkillMatch[] {
    const queryTerms = extractTerms(taskDescription);
    const results: SkillMatch[] = [];

    for (const skill of this.skills.values()) {
      if (!opts?.anyStatus && skill.status !== "trusted") continue;
      const [score, method] = this.scoreMatch(skill, taskDescription, queryTerms);
      if (score >= threshold) {
        results.push({
          skill,
          confidence: score,
          matchedTrigger: this.findMatchedTrigger(skill, taskDescription),
          matchMethod: method,
        });
      }
    }

    return results
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, opts?.limit ?? 10);
  }

  // ── CRUD ──────────────────────────────────────────────────

  getAll(opts?: { status?: SkillStatus; projectId?: string; scope?: "global" | "project" }): Skill[] {
    return Array.from(this.skills.values()).filter((s) => {
      if (opts?.status && s.status !== opts.status) return false;
      if (opts?.projectId && s.scope === "project" && s.projectId !== opts.projectId) return false;
      if (opts?.scope && s.scope !== opts.scope) return false;
      return true;
    });
  }

  get(id: string): Skill | null {
    return this.skills.get(id) ?? null;
  }

  /** Create a new skill (always starts as "draft"). */
  add(
    skill: Omit<Skill, "id" | "version" | "status" | "changelog" | "confidence" | "createdAt" | "updatedAt">,
  ): Skill {
    const id = this.generateId(skill.name);
    const now = Date.now();

    const newSkill: Skill = {
      ...skill,
      id,
      version: 1,
      status: "draft",
      changelog: [],
      confidence: wilsonInterval(0, 0),
      createdAt: now,
      updatedAt: now,
    };

    this.skills.set(id, newSkill);
    this.saveToDisk(newSkill);
    this.rebuildDocFreqForSkill(newSkill);
    return newSkill;
  }

  /** Update fields and increment version. Returns updated skill. */
  mutate(
    id: string,
    updates: Partial<Pick<Skill, "procedure" | "description" | "triggers" | "tags" | "name">>,
    reason: string,
    trajectoryId?: string,
  ): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;

    const changes: SkillChange[] = [];
    for (const [key, val] of Object.entries(updates) as [string, unknown][]) {
      if (val !== undefined && JSON.stringify(skill[key as keyof Skill]) !== JSON.stringify(val)) {
        changes.push({
          version: skill.version + 1,
          field: key,
          summary: `${key}: ${String(val).slice(0, 80)}`,
          trajectoryId,
          changedAt: Date.now(),
        });
      }
    }

    const mutated: Skill = {
      ...skill,
      ...updates,
      version: skill.version + 1,
      changelog: [...skill.changelog, ...changes],
      updatedAt: Date.now(),
    };

    this.skills.set(id, mutated);
    this.saveToDisk(mutated);
    this.rebuildDocFreqForSkill(mutated);
    return mutated;
  }

  /** Promote/retire a skill. Called by the approval system. */
  setStatus(id: string, status: SkillStatus): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;
    const updated: Skill = { ...skill, status, updatedAt: Date.now() };
    this.skills.set(id, updated);
    this.saveToDisk(updated);
    return updated;
  }

  /**
   * Record a usage and update the Wilson confidence interval.
   * Confidence calibration: we use Wilson score, not raw success rate,
   * so a skill with 3/3 successes has lower=0.29, not lower=1.0.
   */
  recordUsage(id: string, result: { success: boolean; costUsd: number; durationMs: number }): void {
    const skill = this.skills.get(id);
    if (!skill) return;

    const prevSuccesses = Math.round(skill.confidence.point * skill.confidence.n);
    const n = skill.confidence.n + 1;
    const successes = prevSuccesses + (result.success ? 1 : 0);
    const updated: Skill = {
      ...skill,
      confidence: wilsonInterval(successes, n),
      updatedAt: Date.now(),
    };

    this.skills.set(id, updated);
    this.saveToDisk(updated);
  }

  /** Rollback: adds a changelog entry noting the rollback. Full snapshot not stored yet. */
  rollback(id: string, toVersion: number, reason: string): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;

    const updated: Skill = {
      ...skill,
      version: skill.version + 1,
      changelog: [
        ...skill.changelog,
        {
          version: skill.version + 1,
          field: "rollback",
          summary: `Rolled back to v${toVersion}: ${reason}`,
          changedAt: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    };

    this.skills.set(id, updated);
    this.saveToDisk(updated);
    return updated;
  }

  remove(id: string): boolean {
    if (!this.skills.has(id)) return false;
    this.skills.delete(id);
    const p = join(this.skillsDir, `${id}.json`);
    if (existsSync(p)) unlinkSync(p);
    return true;
  }

  // ── Import / Export ───────────────────────────────────────

  /** Export trusted skills to a portable bundle. */
  export(ids?: string[]): SkillExport {
    const toExport = ids
      ? (ids.map((id) => this.skills.get(id)).filter(Boolean) as Skill[])
      : Array.from(this.skills.values()).filter((s) => s.status === "trusted");

    return {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      skills: toExport.map((s) => ({
        name: s.name,
        description: s.description,
        procedure: s.procedure,
        category: s.category,
        tags: s.tags,
        triggers: s.triggers,
      })),
    };
  }

  /**
   * Import skills from a SkillExport bundle.
   * All imported skills start as "draft" and need approval.
   */
  import(data: SkillExport, opts?: { projectId?: string; importedFrom?: string }): Skill[] {
    const imported: Skill[] = [];
    for (const raw of data.skills) {
      const existing = Array.from(this.skills.values()).find(
        (s) => s.name.toLowerCase() === raw.name.toLowerCase(),
      );
      if (existing) continue;

      const skill = this.add({
        name: raw.name,
        description: raw.description,
        procedure: raw.procedure,
        category: raw.category,
        tags: raw.tags,
        triggers: raw.triggers,
        scope: opts?.projectId ? "project" : "global",
        projectId: opts?.projectId,
        provenance: {
          createdBy: "import",
          sourceTrajectoryIds: [],
          importedFrom: opts?.importedFrom,
        },
      });
      imported.push(skill);
    }
    return imported;
  }

  // ── Scoring ───────────────────────────────────────────────

  private scoreMatch(
    skill: Skill,
    task: string,
    queryTerms: string[],
  ): [number, SkillMatch["matchMethod"]] {
    const taskLower = task.toLowerCase();
    let score = 0;
    let method: SkillMatch["matchMethod"] = "description";

    // 1. Trigger match (highest weight)
    for (const trigger of skill.triggers) {
      if (taskLower.includes(trigger.toLowerCase())) {
        if (0.85 > score) { score = 0.85; method = "trigger"; }
      }
    }

    // 2. Tag match
    for (const tag of skill.tags) {
      if (taskLower.includes(tag.toLowerCase())) {
        if (0.65 > score) { score = 0.65; method = "tag"; } // Don't overwrite better match
      }
    }

    // 3. Name overlap
    const nameTerms = extractTerms(skill.name);
    const nameHits = queryTerms.filter((t) => nameTerms.includes(t)).length;
    if (nameTerms.length > 0) {
      const nameScore = (nameHits / Math.max(nameTerms.length, queryTerms.length)) * 0.75;
      if (nameScore > score) { score = nameScore; method = "name"; }
    }

    // 4. Description overlap
    const descTerms = extractTerms(skill.description);
    const descHits = queryTerms.filter((t) => descTerms.includes(t)).length;
    if (descTerms.length > 0) {
      const descScore = (descHits / Math.max(descTerms.length, queryTerms.length)) * 0.55;
      if (descScore > score) { score = descScore; method = "description"; }
    }

    // 5. TF-IDF over procedure
    const procTerms = extractTerms(skill.procedure);
    const tfidf = computeTFIDF(queryTerms, procTerms, this.skills.size, this.docFreq) * 0.4;
    if (tfidf > score) { score = tfidf; method = "tfidf"; }

    // Wilson confidence boost: well-tested skills score slightly higher
    const confBoost = 0.8 + skill.confidence.lower * 0.4;
    score = Math.min(1.0, score * confBoost);

    return [score, method];
  }

  private findMatchedTrigger(skill: Skill, task: string): string {
    const taskLower = task.toLowerCase();
    for (const trigger of skill.triggers) {
      if (taskLower.includes(trigger.toLowerCase())) return trigger;
    }
    return skill.name;
  }

  private generateId(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
    if (!this.skills.has(base)) return base;
    let i = 2;
    while (this.skills.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  // ── TF-IDF Index ──────────────────────────────────────────

  private buildDocFreq(): void {
    this.docFreq.clear();
    for (const skill of this.skills.values()) {
      const terms = new Set([
        ...extractTerms(skill.name),
        ...extractTerms(skill.description),
        ...extractTerms(skill.procedure),
      ]);
      for (const t of terms) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
    }
  }

  private rebuildDocFreqForSkill(skill: Skill): void {
    const terms = new Set([
      ...extractTerms(skill.name),
      ...extractTerms(skill.description),
      ...extractTerms(skill.procedure),
    ]);
    for (const t of terms) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
  }

  // ── Disk I/O ──────────────────────────────────────────────

  private loadFromDisk(): void {
    const files = readdirSync(this.skillsDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"));

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.skillsDir, file), "utf-8");
        const skill = JSON.parse(raw) as Skill;

        // Migrate legacy format
        if (!skill.status) skill.status = "trusted";
        if (!skill.confidence) {
          const n = (skill as any).usageCount ?? 0;
          const s = Math.round(n * ((skill as any).successRate ?? 0));
          skill.confidence = wilsonInterval(s, n);
        }
        if (!skill.provenance) skill.provenance = { createdBy: "manual", sourceTrajectoryIds: [] };
        if (!skill.changelog) skill.changelog = [];
        if (!skill.scope) skill.scope = "global";

        this.skills.set(skill.id, skill);
      } catch { /* skip corrupted */ }
    }
  }

  private saveToDisk(skill: Skill): void {
    writeFileSync(join(this.skillsDir, `${skill.id}.json`), JSON.stringify(skill, null, 2), "utf-8");
  }
}
