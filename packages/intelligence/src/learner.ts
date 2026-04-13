/**
 * Nexus Experience Learner
 *
 * The 3-stage learning loop that makes Nexus get better over time:
 *   Stage 1: STORE   — Save what happened (trajectory)
 *   Stage 2: REFLECT — Analyze what went well/wrong
 *   Stage 3: EVOLVE  — Create or improve skills from learnings
 *
 * This runs as a background process after each task completes,
 * so there's no user-facing latency.
 */

import type { Message, BudgetState, LLMProvider } from "@nexus/core";
import type { SkillStore, Skill } from "./skills.js";

export interface Trajectory {
  /** Task description (user's original message) */
  task: string;
  /** Full message history */
  messages: Message[];
  /** Final outcome */
  outcome: "success" | "partial" | "failure";
  /** Cost and performance */
  budget: BudgetState;
  /** Duration in ms */
  durationMs: number;
  /** Which routing path was used */
  routingPath: "system1" | "system2";
  /** Skill used (if System 1) */
  skillUsed?: string;
  /** Timestamp */
  timestamp: number;
}

export interface Reflection {
  /** What strategies worked well */
  successFactors: string[];
  /** What went wrong */
  failurePoints: string[];
  /** What could be more efficient */
  efficiencyOpportunities: string[];
  /** Should a skill be created/updated? */
  skillRecommendation: {
    action: "create" | "update" | "none";
    skillName?: string;
    description?: string;
    procedure?: string;
    triggers?: string[];
    reason: string;
  };
  /** Facts to remember about this user/project */
  memorableContext: string[];
}

export class ExperienceLearner {
  private provider: LLMProvider;
  private skillStore: SkillStore;
  private trajectories: Trajectory[] = [];

  constructor(provider: LLMProvider, skillStore: SkillStore) {
    this.provider = provider;
    this.skillStore = skillStore;
  }

  /**
   * Stage 1: STORE — Save the trajectory
   */
  store(trajectory: Trajectory): void {
    this.trajectories.push(trajectory);
    // Keep last 100 trajectories in memory
    if (this.trajectories.length > 100) {
      this.trajectories = this.trajectories.slice(-100);
    }
  }

  /**
   * Stage 2: REFLECT — Analyze what happened
   * Uses the LLM to generate a structured reflection.
   */
  async reflect(trajectory: Trajectory): Promise<Reflection> {
    // Build a compact summary of the trajectory
    const summary = this.summarizeTrajectory(trajectory);

    const response = await this.provider.complete(
      [
        {
          role: "system",
          content: `You are a performance analyst reviewing an AI agent's task execution.
Analyze the trajectory and provide a structured reflection.
Respond ONLY with valid JSON matching this schema:
{
  "successFactors": ["string"],
  "failurePoints": ["string"],
  "efficiencyOpportunities": ["string"],
  "skillRecommendation": {
    "action": "create" | "update" | "none",
    "skillName": "string (if create/update)",
    "description": "string (if create/update)",
    "procedure": "step-by-step markdown (if create/update)",
    "triggers": ["keyword patterns that should activate this skill"],
    "reason": "why this recommendation"
  },
  "memorableContext": ["facts worth remembering"]
}`,
        },
        {
          role: "user",
          content: `Analyze this agent execution:

**Task:** ${trajectory.task}
**Outcome:** ${trajectory.outcome}
**Routing:** ${trajectory.routingPath}
**Cost:** $${trajectory.budget.spentUsd.toFixed(4)}
**Duration:** ${trajectory.durationMs}ms
**LLM Calls:** ${trajectory.budget.llmCalls}
**Tool Calls:** ${trajectory.budget.toolCalls}

**Execution Summary:**
${summary}

Provide your reflection as JSON:`,
        },
      ],
      [], // No tools needed for reflection
      { temperature: 0.3 },
    );

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonStr = response.content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      return JSON.parse(jsonStr) as Reflection;
    } catch {
      // If parsing fails, return a default reflection
      return {
        successFactors: trajectory.outcome === "success" ? ["Task completed successfully"] : [],
        failurePoints: trajectory.outcome === "failure" ? ["Task failed"] : [],
        efficiencyOpportunities: [],
        skillRecommendation: { action: "none", reason: "Could not parse reflection" },
        memorableContext: [],
      };
    }
  }

  /**
   * Stage 3: EVOLVE — Create or update skills based on reflection
   */
  async evolve(trajectory: Trajectory, reflection: Reflection): Promise<Skill | null> {
    const rec = reflection.skillRecommendation;

    if (rec.action === "none") return null;

    if (rec.action === "create" && rec.skillName && rec.procedure) {
      // Create a new skill
      const skill = this.skillStore.add({
        name: rec.skillName,
        description: rec.description ?? "",
        procedure: rec.procedure,
        category: this.inferCategory(trajectory.task),
        tags: rec.triggers ?? [],
        triggers: rec.triggers ?? [],
      });

      // Record the first usage from this trajectory
      this.skillStore.recordUsage(skill.id, {
        success: trajectory.outcome === "success",
        costUsd: trajectory.budget.spentUsd,
        durationMs: trajectory.durationMs,
      });

      return skill;
    }

    if (rec.action === "update" && rec.skillName) {
      // Find existing skill and mutate it
      const skills = this.skillStore.getAll();
      const existing = skills.find(
        (s) => s.name.toLowerCase() === rec.skillName!.toLowerCase(),
      );

      if (existing) {
        const mutated = this.skillStore.mutate(
          existing.id,
          {
            procedure: rec.procedure ?? existing.procedure,
            description: rec.description ?? existing.description,
            triggers: rec.triggers ?? existing.triggers,
          },
          rec.reason,
        );
        return mutated;
      }
    }

    return null;
  }

  /**
   * Full learning cycle — run all three stages
   */
  async learn(trajectory: Trajectory): Promise<{
    stored: boolean;
    reflection: Reflection | null;
    evolvedSkill: Skill | null;
  }> {
    // Stage 1: Store
    this.store(trajectory);

    // Only reflect on System 2 runs (System 1 already used a skill)
    if (trajectory.routingPath === "system1") {
      // Just update skill usage stats
      if (trajectory.skillUsed) {
        this.skillStore.recordUsage(trajectory.skillUsed, {
          success: trajectory.outcome === "success",
          costUsd: trajectory.budget.spentUsd,
          durationMs: trajectory.durationMs,
        });
      }
      return { stored: true, reflection: null, evolvedSkill: null };
    }

    // Stage 2: Reflect only on tasks worth turning into a skill:
    // must have used at least 1 tool (real work was done), not just Q&A
    if (trajectory.budget.toolCalls < 1) {
      return { stored: true, reflection: null, evolvedSkill: null };
    }

    try {
      const reflection = await this.reflect(trajectory);

      // Stage 3: Evolve
      const evolvedSkill = await this.evolve(trajectory, reflection);

      return { stored: true, reflection, evolvedSkill };
    } catch {
      return { stored: true, reflection: null, evolvedSkill: null };
    }
  }

  /** Get learning statistics */
  getStats(): {
    trajectoriesStored: number;
    skillsCreated: number;
    skillsMutated: number;
  } {
    const allSkills = this.skillStore.getAll();
    return {
      trajectoriesStored: this.trajectories.length,
      skillsCreated: allSkills.length,
      skillsMutated: allSkills.reduce((sum, s) => sum + Math.max(0, s.version - 1), 0),
    };
  }

  /** Summarize a trajectory for reflection (keep it compact) */
  private summarizeTrajectory(trajectory: Trajectory): string {
    const lines: string[] = [];
    let toolCallIdx = 0;

    for (const msg of trajectory.messages) {
      if (msg.role === "system") continue;

      if (msg.role === "user") {
        lines.push(`USER: ${msg.content.slice(0, 200)}`);
      } else if (msg.role === "assistant") {
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            toolCallIdx++;
            const argsStr = JSON.stringify(tc.arguments).slice(0, 100);
            lines.push(`TOOL_CALL ${toolCallIdx}: ${tc.name}(${argsStr})`);
          }
        }
        if (msg.content) {
          lines.push(`ASSISTANT: ${msg.content.slice(0, 200)}`);
        }
      } else if (msg.role === "tool") {
        const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
        lines.push(`TOOL_RESULT: ${preview}`);
      }
    }

    return lines.join("\n");
  }

  private inferCategory(task: string): string {
    const lower = task.toLowerCase();
    if (/\b(code|implement|function|class|refactor|bug|fix|test)\b/.test(lower)) return "coding";
    if (/\b(deploy|build|docker|ci|cd|pipeline)\b/.test(lower)) return "devops";
    if (/\b(search|find|research|analyze|read)\b/.test(lower)) return "research";
    if (/\b(write|document|explain|summarize)\b/.test(lower)) return "writing";
    return "general";
  }
}
