/**
 * Nexus Skill Store
 *
 * Manages the agent's procedural memory — learned workflows and
 * patterns that can be reused to handle tasks faster and cheaper.
 *
 * Skills are stored as structured YAML + markdown files on disk,
 * indexed by embedding similarity for retrieval.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

export interface Skill {
  /** Unique identifier */
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
  /** Version counter — incremented on mutation */
  version: number;
  /** Success rate (0.0 - 1.0) */
  successRate: number;
  /** Average cost in USD when used */
  avgCostUsd: number;
  /** Average duration in ms */
  avgDurationMs: number;
  /** Number of times used */
  usageCount: number;
  /** Trigger patterns — when to activate this skill */
  triggers: string[];
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

export interface SkillMatch {
  skill: Skill;
  confidence: number;
  matchedTrigger: string;
}

export interface SkillMutation {
  skillId: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
  timestamp: number;
}

export class SkillStore {
  private skills: Map<string, Skill> = new Map();
  private mutations: SkillMutation[] = [];
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = resolve(skillsDir);
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
    this.loadFromDisk();
  }

  /** Find the best matching skill for a task description */
  find(taskDescription: string, threshold = 0.5): SkillMatch | null {
    let bestMatch: SkillMatch | null = null;

    for (const skill of this.skills.values()) {
      const confidence = this.scoreMatch(skill, taskDescription);
      if (confidence >= threshold && (!bestMatch || confidence > bestMatch.confidence)) {
        bestMatch = {
          skill,
          confidence,
          matchedTrigger: this.findMatchedTrigger(skill, taskDescription),
        };
      }
    }

    return bestMatch;
  }

  /** Get all skills */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** Get a skill by ID */
  get(id: string): Skill | null {
    return this.skills.get(id) ?? null;
  }

  /** Add a new skill */
  add(skill: Omit<Skill, "id" | "version" | "usageCount" | "successRate" | "avgCostUsd" | "avgDurationMs" | "createdAt" | "updatedAt">): Skill {
    const id = this.generateId(skill.name);
    const now = Date.now();

    const newSkill: Skill = {
      ...skill,
      id,
      version: 1,
      usageCount: 0,
      successRate: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.skills.set(id, newSkill);
    this.saveToDisk(newSkill);
    return newSkill;
  }

  /** Update an existing skill (mutation) */
  mutate(id: string, updates: Partial<Pick<Skill, "procedure" | "description" | "triggers" | "tags">>, reason: string): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;

    const mutation: SkillMutation = {
      skillId: id,
      fromVersion: skill.version,
      toVersion: skill.version + 1,
      reason,
      timestamp: Date.now(),
    };

    const mutated: Skill = {
      ...skill,
      ...updates,
      version: skill.version + 1,
      updatedAt: Date.now(),
    };

    this.skills.set(id, mutated);
    this.mutations.push(mutation);
    this.saveToDisk(mutated);
    this.saveMutationLog();
    return mutated;
  }

  /** Record a usage result (updates stats) */
  recordUsage(id: string, result: { success: boolean; costUsd: number; durationMs: number }): void {
    const skill = this.skills.get(id);
    if (!skill) return;

    const newCount = skill.usageCount + 1;
    const newSuccessRate =
      (skill.successRate * skill.usageCount + (result.success ? 1 : 0)) / newCount;
    const newAvgCost =
      (skill.avgCostUsd * skill.usageCount + result.costUsd) / newCount;
    const newAvgDuration =
      (skill.avgDurationMs * skill.usageCount + result.durationMs) / newCount;

    skill.usageCount = newCount;
    skill.successRate = newSuccessRate;
    skill.avgCostUsd = newAvgCost;
    skill.avgDurationMs = newAvgDuration;
    skill.updatedAt = Date.now();

    this.saveToDisk(skill);
  }

  /** Get mutation history for a skill */
  getMutations(skillId: string): SkillMutation[] {
    return this.mutations.filter((m) => m.skillId === skillId);
  }

  /** Score how well a skill matches a task */
  private scoreMatch(skill: Skill, task: string): number {
    const taskLower = task.toLowerCase();
    let score = 0;

    // Check trigger patterns
    for (const trigger of skill.triggers) {
      if (taskLower.includes(trigger.toLowerCase())) {
        score = Math.max(score, 0.8);
      }
    }

    // Check name/description overlap
    const nameWords = skill.name.toLowerCase().split(/\s+/);
    const descWords = skill.description.toLowerCase().split(/\s+/);
    const taskWords = new Set(taskLower.split(/\s+/));

    let nameOverlap = 0;
    for (const w of nameWords) {
      if (w.length > 3 && taskWords.has(w)) nameOverlap++;
    }
    if (nameWords.length > 0) {
      score = Math.max(score, (nameOverlap / nameWords.length) * 0.7);
    }

    let descOverlap = 0;
    for (const w of descWords) {
      if (w.length > 3 && taskWords.has(w)) descOverlap++;
    }
    if (descWords.length > 0) {
      score = Math.max(score, (descOverlap / Math.min(descWords.length, 10)) * 0.5);
    }

    // Check tags
    for (const tag of skill.tags) {
      if (taskLower.includes(tag.toLowerCase())) {
        score = Math.max(score, 0.6);
      }
    }

    // Boost by success rate
    score *= 0.5 + skill.successRate * 0.5;

    return Math.min(score, 1.0);
  }

  private findMatchedTrigger(skill: Skill, task: string): string {
    const taskLower = task.toLowerCase();
    for (const trigger of skill.triggers) {
      if (taskLower.includes(trigger.toLowerCase())) return trigger;
    }
    return skill.name;
  }

  private generateId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
  }

  /** Load skills from disk */
  private loadFromDisk(): void {
    if (!existsSync(this.skillsDir)) return;

    const files = readdirSync(this.skillsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = readFileSync(join(this.skillsDir, file), "utf-8");
        const skill = JSON.parse(data) as Skill;
        this.skills.set(skill.id, skill);
      } catch {
        // Skip corrupted files
      }
    }

    // Load mutation log
    const mutationFile = join(this.skillsDir, "_mutations.json");
    if (existsSync(mutationFile)) {
      try {
        const data = readFileSync(mutationFile, "utf-8");
        this.mutations = JSON.parse(data);
      } catch {
        // Start fresh
      }
    }
  }

  /** Save a skill to disk */
  private saveToDisk(skill: Skill): void {
    const filePath = join(this.skillsDir, `${skill.id}.json`);
    writeFileSync(filePath, JSON.stringify(skill, null, 2), "utf-8");
  }

  /** Save mutation log */
  private saveMutationLog(): void {
    const filePath = join(this.skillsDir, "_mutations.json");
    writeFileSync(filePath, JSON.stringify(this.mutations, null, 2), "utf-8");
  }
}
