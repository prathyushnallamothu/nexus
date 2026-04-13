/**
 * Task Planner — Nexus built-in planning tool
 *
 * Gives the agent a first-class task list it can update as work progresses.
 * Plans are stored as JSON in `.nexus/tasks/<plan-id>.json` and survive
 * across restarts, making long-running work resumable.
 *
 * Tools exposed:
 *   task_plan        — create a new plan with a goal and ordered steps
 *   task_update      — update a step's status / add notes
 *   task_list        — show current plan with statuses
 *   task_complete    — mark the whole plan done
 *   task_checkpoint  — emit a structured checkpoint (for humans or upstream systems)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tool } from "../types.js";

// ── Types ──────────────────────────────────────────────────

export type StepStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";

export interface PlanStep {
  id: string;
  description: string;
  status: StepStatus;
  notes?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskPlan {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  status: "active" | "completed" | "abandoned";
}

// ── Store ──────────────────────────────────────────────────

export class PlanStore {
  private dir: string;

  constructor(tasksDir: string) {
    this.dir = resolve(tasksDir);
    mkdirSync(this.dir, { recursive: true });
  }

  private planPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(plan: TaskPlan): void {
    plan.updatedAt = Date.now();
    writeFileSync(this.planPath(plan.id), JSON.stringify(plan, null, 2));
  }

  load(id: string): TaskPlan | null {
    const p = this.planPath(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as TaskPlan;
    } catch {
      return null;
    }
  }

  listAll(): TaskPlan[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as TaskPlan;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as TaskPlan[];
    } catch {
      return [];
    }
  }

  activePlan(): TaskPlan | null {
    const all = this.listAll()
      .filter((p) => p.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return all[0] ?? null;
  }
}

// ── Tool Factory ───────────────────────────────────────────

let _store: PlanStore | null = null;

export function initPlannerTools(tasksDir: string): Tool[] {
  _store = new PlanStore(tasksDir);
  return createPlannerTools(_store);
}

export function createPlannerTools(store: PlanStore): Tool[] {
  // ── task_plan ───────────────────────────────────────────

  const task_plan: Tool = {
    schema: {
      name: "task_plan",
      description:
        "Create a structured task plan with an overall goal and ordered steps. " +
        "Use this at the start of any multi-step task to track progress. " +
        "Returns the plan ID you can reference in subsequent tool calls.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The overall goal or objective of this task",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of step descriptions",
          },
          plan_id: {
            type: "string",
            description: "Optional explicit plan ID (auto-generated if omitted)",
          },
        },
        required: ["goal", "steps"],
      },
    },
    async execute(args) {
      const goal = args["goal"] as string;
      const stepDescs = args["steps"] as string[];
      const planId = (args["plan_id"] as string | undefined) ??
        `plan_${Date.now().toString(36)}`;

      if (!goal?.trim()) return "Error: goal is required";
      if (!stepDescs?.length) return "Error: at least one step is required";

      const plan: TaskPlan = {
        id: planId,
        goal: goal.trim(),
        steps: stepDescs.map((desc, i) => ({
          id: `step_${i + 1}`,
          description: desc.trim(),
          status: "pending",
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "active",
      };

      store.save(plan);

      const lines = [
        `✅ Plan created: ${planId}`,
        `Goal: ${plan.goal}`,
        "",
        "Steps:",
        ...plan.steps.map((s) => `  [ ] ${s.id}: ${s.description}`),
        "",
        `Use task_update to mark steps in_progress/done/blocked.`,
      ];

      return lines.join("\n");
    },
  };

  // ── task_update ─────────────────────────────────────────

  const task_update: Tool = {
    schema: {
      name: "task_update",
      description:
        "Update the status of a step in the active (or specified) task plan. " +
        "Status options: pending | in_progress | done | blocked | skipped",
      parameters: {
        type: "object",
        properties: {
          step_id: {
            type: "string",
            description: "Step ID to update (e.g. 'step_1')",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done", "blocked", "skipped"],
            description: "New status for this step",
          },
          notes: {
            type: "string",
            description: "Optional notes or error messages to attach to this step",
          },
          plan_id: {
            type: "string",
            description: "Plan ID (defaults to most recently active plan)",
          },
        },
        required: ["step_id", "status"],
      },
    },
    async execute(args) {
      const stepId = args["step_id"] as string;
      const status = args["status"] as StepStatus;
      const notes = args["notes"] as string | undefined;
      const planId = args["plan_id"] as string | undefined;

      const plan = planId ? store.load(planId) : store.activePlan();
      if (!plan) return "Error: no active plan found. Create one with task_plan first.";

      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) {
        return `Error: step '${stepId}' not found. Available: ${plan.steps.map((s) => s.id).join(", ")}`;
      }

      const prev = step.status;
      step.status = status;
      if (notes) step.notes = notes;
      if (status === "in_progress" && !step.startedAt) step.startedAt = Date.now();
      if (status === "done" || status === "skipped") step.completedAt = Date.now();

      store.save(plan);

      // Render updated plan
      const statusIcon: Record<StepStatus, string> = {
        pending: "○",
        in_progress: "◎",
        done: "✓",
        blocked: "✗",
        skipped: "–",
      };

      const lines = [
        `Updated ${stepId}: ${prev} → ${status}`,
        notes ? `Notes: ${notes}` : "",
        "",
        `Plan: ${plan.goal}`,
        ...plan.steps.map(
          (s) =>
            `  ${statusIcon[s.status]} ${s.id}: ${s.description}` +
            (s.notes ? ` (${s.notes})` : ""),
        ),
      ].filter((l) => l !== "");

      const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
      lines.push(`\nProgress: ${done}/${plan.steps.length} steps complete`);

      return lines.join("\n");
    },
  };

  // ── task_list ───────────────────────────────────────────

  const task_list: Tool = {
    schema: {
      name: "task_list",
      description:
        "Show the current task plan with all steps and their statuses. " +
        "Useful for orienting yourself at the start of a session or after returning from a detour.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "Plan ID to show (defaults to most recently active plan)",
          },
          all: {
            type: "boolean",
            description: "If true, list all plans including completed ones",
          },
        },
        required: [],
      },
    },
    async execute(args) {
      const planId = args["plan_id"] as string | undefined;
      const listAll = args["all"] === true;

      if (listAll) {
        const plans = store.listAll();
        if (plans.length === 0) return "No plans found.";
        return plans
          .map((p) => {
            const done = p.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
            return `[${p.status}] ${p.id}: ${p.goal} (${done}/${p.steps.length} steps)`;
          })
          .join("\n");
      }

      const plan = planId ? store.load(planId) : store.activePlan();
      if (!plan) return "No active plan. Create one with task_plan.";

      const statusIcon: Record<StepStatus, string> = {
        pending: "○",
        in_progress: "◎",
        done: "✓",
        blocked: "✗",
        skipped: "–",
      };

      const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
      const lines = [
        `Plan: ${plan.id} [${plan.status}]`,
        `Goal: ${plan.goal}`,
        `Progress: ${done}/${plan.steps.length} steps`,
        "",
        ...plan.steps.map(
          (s) =>
            `  ${statusIcon[s.status]} ${s.id}: ${s.description}` +
            (s.notes ? `\n     └─ ${s.notes}` : ""),
        ),
      ];

      return lines.join("\n");
    },
  };

  // ── task_complete ───────────────────────────────────────

  const task_complete: Tool = {
    schema: {
      name: "task_complete",
      description:
        "Mark the entire task plan as completed. " +
        "Call this when all steps are done or the goal has been achieved.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "Plan ID to complete (defaults to most recently active plan)",
          },
          summary: {
            type: "string",
            description: "Optional summary of what was accomplished",
          },
        },
        required: [],
      },
    },
    async execute(args) {
      const planId = args["plan_id"] as string | undefined;
      const summary = args["summary"] as string | undefined;

      const plan = planId ? store.load(planId) : store.activePlan();
      if (!plan) return "No active plan found.";

      plan.status = "completed";
      plan.completedAt = Date.now();
      if (summary) plan.steps.push({
        id: "summary",
        description: summary,
        status: "done",
        completedAt: Date.now(),
      });

      store.save(plan);

      const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
      const incomplete = plan.steps.filter((s) => s.status === "pending" || s.status === "in_progress");

      const lines = [
        `✅ Plan completed: ${plan.id}`,
        `Goal: ${plan.goal}`,
        `Completed ${done}/${plan.steps.length} steps`,
      ];

      if (incomplete.length > 0) {
        lines.push(`\nIncomplete steps (${incomplete.length}):`);
        for (const s of incomplete) {
          lines.push(`  – ${s.id}: ${s.description}`);
        }
      }

      if (summary) lines.push(`\nSummary: ${summary}`);

      return lines.join("\n");
    },
  };

  // ── task_checkpoint ─────────────────────────────────────

  const task_checkpoint: Tool = {
    schema: {
      name: "task_checkpoint",
      description:
        "Emit a structured checkpoint of the current plan state. " +
        "Use this periodically during long tasks so humans can monitor progress, " +
        "or before making risky operations so there's a clear record.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "Plan ID (defaults to most recently active plan)",
          },
          message: {
            type: "string",
            description: "Human-readable message about current state",
          },
        },
        required: [],
      },
    },
    async execute(args) {
      const planId = args["plan_id"] as string | undefined;
      const message = args["message"] as string | undefined;

      const plan = planId ? store.load(planId) : store.activePlan();
      if (!plan) return "No active plan.";

      const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped");
      const inProgress = plan.steps.filter((s) => s.status === "in_progress");
      const pending = plan.steps.filter((s) => s.status === "pending");
      const blocked = plan.steps.filter((s) => s.status === "blocked");

      const checkpoint = {
        timestamp: new Date().toISOString(),
        planId: plan.id,
        goal: plan.goal,
        message: message ?? "Checkpoint",
        progress: {
          done: done.length,
          inProgress: inProgress.length,
          pending: pending.length,
          blocked: blocked.length,
          total: plan.steps.length,
          percentComplete: Math.round((done.length / plan.steps.length) * 100),
        },
        currentStep: inProgress[0]?.description ?? "—",
        nextStep: pending[0]?.description ?? "—",
        blockers: blocked.map((s) => s.notes ?? s.description),
      };

      return JSON.stringify(checkpoint, null, 2);
    },
  };

  return [task_plan, task_update, task_list, task_complete, task_checkpoint];
}
