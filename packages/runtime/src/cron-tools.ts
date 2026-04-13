/**
 * Nexus Cron Tools
 *
 * Agent-callable tools for managing scheduled jobs.
 * These tools wrap CronStore operations so the agent can
 * create, list, toggle, and delete cron jobs via tool calls.
 */

import type { Tool } from "@nexus/core";
import type { CronStore } from "./cron.js";

export function createCronTools(store: CronStore): Tool[] {
  const cronCreateTool: Tool = {
    schema: {
      name: "cron_create",
      description:
        "Create a new scheduled task. The agent will run the task description on the given schedule. " +
        "Accepts 5-part cron expressions OR natural language like 'every day at 9am', 'every hour', 'every monday at 10am'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short display name for the job" },
          schedule: {
            type: "string",
            description:
              "When to run. Cron expression (e.g. '0 9 * * *') or natural language ('every day', 'every hour', 'every monday at 10am')",
          },
          task: {
            type: "string",
            description: "The task to perform when the job fires (natural language instruction)",
          },
        },
        required: ["name", "schedule", "task"],
      },
    },
    async execute(args) {
      const job = store.add({
        name: String(args.name),
        schedule: String(args.schedule),
        task: String(args.task),
      });
      return (
        `Created cron job: ${job.name} (id: ${job.id})\n` +
        `Schedule: ${job.schedule} → ${job.cronExpr}\n` +
        `Next run: ${new Date(job.nextRunAt).toLocaleString()}`
      );
    },
  };

  const cronListTool: Tool = {
    schema: {
      name: "cron_list",
      description: "List all scheduled cron jobs with their status and next run times.",
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      const jobs = store.list();
      if (jobs.length === 0) return "No scheduled jobs. Use cron_create to add one.";

      const lines = jobs.map((j) => {
        const status = j.enabled ? "✓ enabled" : "✗ disabled";
        const next = new Date(j.nextRunAt).toLocaleString();
        const last = j.lastRunAt ? `last ran ${new Date(j.lastRunAt).toLocaleString()}` : "never run";
        return `[${j.id}] ${j.name} (${status})\n  Schedule: ${j.schedule}\n  Next: ${next} | ${last}\n  Runs: ${j.runCount}${j.lastOutput ? `\n  Last output: ${j.lastOutput.slice(0, 120)}` : ""}`;
      });
      return `${jobs.length} scheduled job(s):\n\n${lines.join("\n\n")}`;
    },
  };

  const cronDeleteTool: Tool = {
    schema: {
      name: "cron_delete",
      description: "Delete a scheduled cron job by its ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID (from cron_list)" },
        },
        required: ["id"],
      },
    },
    async execute(args) {
      const removed = store.remove(String(args.id));
      return removed ? `Deleted job ${args.id}.` : `No job found with id ${args.id}.`;
    },
  };

  const cronToggleTool: Tool = {
    schema: {
      name: "cron_toggle",
      description: "Enable or disable a scheduled cron job.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID (from cron_list)" },
          enabled: { type: "boolean", description: "true to enable, false to disable" },
        },
        required: ["id", "enabled"],
      },
    },
    async execute(args) {
      const job = store.toggle(String(args.id), Boolean(args.enabled));
      if (!job) return `No job found with id ${args.id}.`;
      return `Job "${job.name}" is now ${job.enabled ? "enabled" : "disabled"}.`;
    },
  };

  return [cronCreateTool, cronListTool, cronDeleteTool, cronToggleTool];
}
