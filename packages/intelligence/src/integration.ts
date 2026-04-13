/**
 * Nexus Learning Integration
 *
 * Wires the ExperienceLearner into the agent execution loop.
 * Provides a simple interface to trigger learning after agent runs.
 *
 * Usage:
 *   const learning = new LearningIntegration({ dbPath, skillsDir, provider, ... });
 *   await learning.afterAgentRun(result, task, sessionId, routingPath, skillUsed);
 */

import type { LLMProvider, Message, BudgetState, ArtifactRecord } from "@nexus/core";
import { ExperienceLearner, type LearnerConfig, type LearnResult, type Trajectory } from "./learner.js";
import { LearningDB } from "./db.js";
import { SkillStore } from "./skills.js";
import { SkillEvaluator } from "./eval.js";
import { DualProcessRouter, type RoutingDecision } from "./router.js";

export interface LearningIntegrationConfig extends LearnerConfig {
  /** Path to learning.db */
  dbPath: string;
  /** Path to skills/ directory */
  skillsDir: string;
  /** LLM provider for reflection */
  provider: LLMProvider;
}

export interface AgentRunContext {
  /** User's original task message */
  task: string;
  /** Session ID */
  sessionId: string;
  /** Full message history */
  messages: Message[];
  /** Final budget state */
  budget: BudgetState;
  /** Wall-clock duration in ms */
  durationMs: number;
  /** Routing path used */
  routingPath: "system1" | "system2";
  /** Skill ID used (if System 1) */
  skillUsed?: string;
  /** Artifacts produced during the run */
  artifacts: ArtifactRecord[];
  /** Whether the agent hit its iteration limit */
  hitIterationLimit: boolean;
  /** Project ID (optional) */
  projectId?: string;
  /** User feedback (optional) */
  userFeedback?: "positive" | "negative";
}

export class LearningIntegration {
  private db: LearningDB;
  private skillStore: SkillStore;
  private learner: ExperienceLearner;
  private router?: DualProcessRouter;

  constructor(config: LearningIntegrationConfig) {
    this.db = new LearningDB(config.dbPath);
    this.skillStore = new SkillStore(config.skillsDir);
    const evaluator = new SkillEvaluator(this.db, config.provider);
    this.learner = new ExperienceLearner(
      this.db,
      this.skillStore,
      evaluator,
      config.provider,
      config,
    );

    // Optional router for System 1 routing
    if (config.enableRouter ?? true) {
      this.router = new DualProcessRouter(
        this.skillStore,
        config.provider,
        {
          system1Threshold: config.system1Threshold ?? 0.7,
          wilsonLowerThreshold: config.wilsonLowerThreshold ?? 0.6,
          maxSystem1Cost: config.maxSystem1Cost ?? 0.05,
          riskThreshold: config.riskThreshold ?? 0.3,
        },
      );
    }
  }

  /**
   * Call this after an agent run completes to trigger learning.
   * Runs in the background (non-blocking) via the learner.
   */
  async afterAgentRun(ctx: AgentRunContext): Promise<LearnResult> {
    const trajectory: Trajectory = {
      task: ctx.task,
      messages: ctx.messages,
      outcome: "unknown", // Will be auto-classified
      outcomeReason: "",
      outcomeConfidence: 0,
      budget: ctx.budget,
      durationMs: ctx.durationMs,
      routingPath: ctx.routingPath,
      skillUsed: ctx.skillUsed,
      artifacts: ctx.artifacts,
      userFeedback: ctx.userFeedback,
      hitIterationLimit: ctx.hitIterationLimit,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      timestamp: Date.now(),
    };

    return this.learner.learn(trajectory);
  }

  /**
   * Get routing decision for a task (System 1 vs System 2).
   * Returns null if routing is disabled or no skill matches.
   */
  async routeTask(task: string, projectId?: string): Promise<RoutingDecision | null> {
    if (!this.router) return null;
    return this.router.route(task, projectId);
  }

  /**
   * Execute a task via System 1 (fast skill execution).
   * Returns the skill procedure to inject into the system prompt.
   */
  async executeSystem1(skillId: string): Promise<string | null> {
    const skill = this.skillStore.get(skillId);
    if (!skill || skill.status !== "trusted") return null;
    return skill.procedure;
  }

  /**
   * Apply explicit user feedback to the most recent trajectory.
   */
  applyUserFeedback(feedback: "positive" | "negative"): void {
    this.learner.applyUserFeedback(feedback);
  }

  /**
   * Manually approve a skill (human reviewer).
   */
  async approveSkillManually(skillId: string, notes?: string): Promise<boolean> {
    return this.learner.approveSkillManually(skillId, notes);
  }

  /**
   * Manually retire a skill.
   */
  retireSkill(skillId: string, reason: string): boolean {
    return this.learner.retireSkill(skillId, reason);
  }

  /**
   * Get learning statistics.
   */
  getStats() {
    return this.learner.getStats();
  }

  /**
   * Get all skills (optionally filtered by status).
   */
  getSkills(opts?: { status?: "draft" | "pending_review" | "trusted" | "retired" }) {
    return this.skillStore.getAll(opts);
  }

  /**
   * Get skill metrics.
   */
  getSkillMetrics(skillId: string) {
    return this.db.getSkillMetrics(skillId);
  }

  /**
   * Get pending approval skills.
   */
  getPendingApprovals() {
    return this.db.getPendingApprovals();
  }

  /**
   * Close database connection.
   */
  close(): void {
    this.db.close();
  }
}
