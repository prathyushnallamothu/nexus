/**
 * Nexus CLI — Slash command handlers
 */

import chalk from "chalk";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Message } from "@nexus/core";
import type { SkillStore, DualProcessRouter, ExperienceLearner } from "@nexus/intelligence";
import type { AuditLogger } from "@nexus/governance";
import type { McpManager, McpConfigStore } from "@nexus/protocols";
import type { CronStore } from "@nexus/runtime";
import { listSessions, loadSessionById, type SessionMeta } from "./session.js";
import { DEFAULT_MODEL, BUDGET_USD, NEXUS_HOME } from "./config.js";

export interface SlashCommandContext {
  sessionMessages: Message[];
  lastUserInput: string;
  skillStore: SkillStore;
  router: DualProcessRouter;
  learner: ExperienceLearner;
  auditLogger: AuditLogger;
  mcpManager: McpManager | null;
  mcpConfigStore: McpConfigStore | null;
  cronStore: CronStore | null;
  // Callbacks
  onRetry: (input: string) => void;
  onLoadSession: (messages: Message[]) => void;
}

// ── /help ─────────────────────────────────────────────────

function cmdHelp(): void {
  console.log(chalk.cyan("\n  Commands:"));
  console.log(chalk.dim("  /help           Show this help"));
  console.log(chalk.dim("  /clear          Clear conversation history"));
  console.log(chalk.dim("  /undo           Remove last exchange (user + assistant)"));
  console.log(chalk.dim("  /retry          Re-send the last message"));
  console.log(chalk.dim("  /sessions       List saved sessions  (/sessions load <n>)"));
  console.log(chalk.dim("  /model          Show current model"));
  console.log(chalk.dim("  /skills         List learned skills"));
  console.log(chalk.dim("  /modes          (set in modes/ directory)"));
  console.log(chalk.dim("  /stats          Show routing & learning stats"));
  console.log(chalk.dim("  /budget         Show budget usage"));
  console.log(chalk.dim("  /audit          Show recent audit log"));
  console.log(chalk.dim("  /memory         Show memory store stats"));
  console.log(chalk.dim("  /sandbox        Show sandbox mode & Docker status"));
  console.log(chalk.dim("  /config         Show runtime configuration"));
  console.log(chalk.dim("  /mcp            List MCP servers  (/mcp list|tools|test|enable|disable|remove)"));
  console.log(chalk.dim("  /cron           List scheduled cron jobs"));
  console.log(chalk.dim("  /exit           Exit Nexus"));
  console.log("");
}

// ── /sessions ────────────────────────────────────────────

function cmdSessions(parts: string[], ctx: SlashCommandContext): void {
  const sub = parts[1]?.toLowerCase();

  if (!sub || sub === "list") {
    const sessions = listSessions(NEXUS_HOME);
    if (sessions.length === 0) {
      console.log(chalk.dim("\n  No saved sessions yet.\n"));
      return;
    }
    console.log(chalk.cyan(`\n  ${sessions.length} Saved Session(s):\n`));
    sessions.slice(0, 20).forEach((s, i) => {
      const dt = new Date(s.updatedAt).toLocaleString();
      const msgs = chalk.dim(`${s.messageCount} msgs`);
      console.log(`  ${chalk.white(`[${i + 1}]`)} ${chalk.white(s.name)} ${msgs} — ${chalk.dim(dt)}`);
    });
    console.log(chalk.dim("\n  Use /sessions load <n> to restore a session\n"));
    return;
  }

  if (sub === "load") {
    const idx = parseInt(parts[2] ?? "", 10);
    if (isNaN(idx) || idx < 1) {
      console.log(chalk.red("\n  Usage: /sessions load <number>\n"));
      return;
    }
    const sessions = listSessions(NEXUS_HOME);
    const meta = sessions[idx - 1];
    if (!meta) {
      console.log(chalk.red(`\n  No session at index ${idx}\n`));
      return;
    }
    const session = loadSessionById(NEXUS_HOME, meta.id);
    if (!session) {
      console.log(chalk.red(`\n  Failed to load session "${meta.name}"\n`));
      return;
    }
    ctx.onLoadSession(session.messages);
    console.log(chalk.green(`\n  ✓ Loaded session "${session.name}" (${session.messages.length} messages)\n`));
    return;
  }

  console.log(chalk.dim("\n  Usage: /sessions [list|load <n>]\n"));
}

// ── /undo ────────────────────────────────────────────────

function cmdUndo(ctx: SlashCommandContext): void {
  const msgs = ctx.sessionMessages;
  if (msgs.length === 0) {
    console.log(chalk.dim("\n  Nothing to undo.\n"));
    return;
  }

  // Walk backwards: remove assistant messages (possibly with tool turns), then the user message
  let removed = 0;
  while (msgs.length > 0 && msgs[msgs.length - 1].role !== "user") {
    msgs.pop();
    removed++;
  }
  if (msgs.length > 0 && msgs[msgs.length - 1].role === "user") {
    msgs.pop();
    removed++;
  }

  if (removed > 0) {
    console.log(chalk.green(`\n  ✓ Undid last exchange (${removed} messages removed).\n`));
  } else {
    console.log(chalk.dim("\n  Nothing to undo.\n"));
  }
}

// ── /retry ───────────────────────────────────────────────

function cmdRetry(ctx: SlashCommandContext): void {
  if (!ctx.lastUserInput) {
    console.log(chalk.dim("\n  No previous message to retry.\n"));
    return;
  }
  // Remove last assistant response (if any) before retrying
  const msgs = ctx.sessionMessages;
  while (msgs.length > 0 && msgs[msgs.length - 1].role !== "user") {
    msgs.pop();
  }
  if (msgs.length > 0 && msgs[msgs.length - 1].role === "user") {
    msgs.pop();
  }
  console.log(chalk.dim(`\n  ↩ Retrying: "${ctx.lastUserInput.slice(0, 60)}"\n`));
  ctx.onRetry(ctx.lastUserInput);
}

// ── /skills ──────────────────────────────────────────────

function cmdSkills(ctx: SlashCommandContext): void {
  const skills = ctx.skillStore.getAll();
  if (skills.length === 0) {
    console.log(chalk.dim("\n  No skills learned yet. Use Nexus and it will learn!\n"));
  } else {
    console.log(chalk.cyan(`\n  ${skills.length} Learned Skills:\n`));
    for (const s of skills) {
      const rate = (s.successRate * 100).toFixed(0);
      console.log(
        `  ${chalk.white(s.name)} ${chalk.dim(`v${s.version}`)} — ` +
          `${chalk.green(`${rate}%`)} success, ${chalk.dim(`${s.usageCount} uses, $${s.avgCostUsd.toFixed(4)} avg`)}`,
      );
    }
    console.log("");
  }
}

// ── /stats ───────────────────────────────────────────────

function cmdStats(ctx: SlashCommandContext): void {
  const routerStats = ctx.router.getStats();
  const learnStats = ctx.learner.getStats();
  console.log(chalk.cyan("\n  Intelligence Stats:\n"));
  console.log(chalk.dim(`  Trajectories stored: ${learnStats.trajectoriesStored}`));
  console.log(chalk.dim(`  Skills created:      ${learnStats.skillsCreated}`));
  console.log(chalk.dim(`  Skill mutations:     ${learnStats.skillsMutated}`));
  console.log(chalk.dim(`  Routing decisions:   ${routerStats.total}`));
  console.log(chalk.dim(`    System 1 (fast):   ${routerStats.system1}`));
  console.log(chalk.dim(`    System 2 (full):   ${routerStats.system2}`));
  console.log(chalk.dim(`  Est. cost saved:     $${routerStats.costSaved.toFixed(4)}`));
  console.log("");
}

// ── /budget ──────────────────────────────────────────────

function cmdBudget(): void {
  const spent = parseFloat(process.env["NEXUS_SPENT_USD"] ?? "0");
  const pct = ((spent / BUDGET_USD) * 100).toFixed(1);
  const filled = Math.round((spent / BUDGET_USD) * 20);
  const bar = "█".repeat(Math.min(filled, 20)) + "░".repeat(Math.max(0, 20 - filled));
  console.log(chalk.cyan("\n  Budget:\n"));
  console.log(`  ${chalk.white(`$${spent.toFixed(4)}`)} / ${chalk.white(`$${BUDGET_USD.toFixed(2)}`)}  ${pct}%`);
  console.log(`  ${chalk.green(bar)}\n`);
}

// ── /audit ───────────────────────────────────────────────

function cmdAudit(ctx: SlashCommandContext): void {
  const entries = ctx.auditLogger.getRecent(20);
  if (entries.length === 0) {
    console.log(chalk.dim("\n  No audit entries yet.\n"));
    return;
  }
  const severityColor: Record<string, (s: string) => string> = {
    info: chalk.dim,
    warning: chalk.yellow,
    critical: chalk.red,
    blocked: chalk.bgRed.white,
  };
  console.log(chalk.cyan(`\n  Last ${Math.min(entries.length, 10)} Audit Entries:\n`));
  for (const e of entries.slice(-10)) {
    const colorFn = severityColor[e.severity] ?? chalk.white;
    const ts = e.timestamp.slice(11, 19);
    console.log(`  ${chalk.dim(ts)} ${colorFn(`[${e.severity}]`)} ${chalk.white(e.action)}`);
  }
  console.log("");
}

// ── /memory ──────────────────────────────────────────────

function cmdMemory(): void {
  const memFile = join(NEXUS_HOME, "memory", "semantic.json");
  const episodicFile = join(NEXUS_HOME, "memory", "episodic.json");
  let semanticCount = 0;
  let episodicCount = 0;
  try {
    if (existsSync(memFile)) {
      const data = JSON.parse(readFileSync(memFile, "utf-8"));
      semanticCount = Array.isArray(data) ? data.length : 0;
    }
    if (existsSync(episodicFile)) {
      const data = JSON.parse(readFileSync(episodicFile, "utf-8"));
      episodicCount = Array.isArray(data) ? data.length : 0;
    }
  } catch {}
  console.log(chalk.cyan("\n  Memory:\n"));
  console.log(chalk.dim(`  Semantic facts:   ${semanticCount}`));
  console.log(chalk.dim(`  Episodic records: ${episodicCount}`));
  console.log(chalk.dim(`  Store location:   ${join(NEXUS_HOME, "memory")}\n`));
}

// ── /sandbox ─────────────────────────────────────────────

function cmdSandbox(): void {
  const dockerAvailable = (() => {
    try {
      const { execSync } = require("node:child_process");
      execSync("docker info", { stdio: "ignore", timeout: 2000 });
      return true;
    } catch { return false; }
  })();
  const mode = process.env.NEXUS_SANDBOX === "docker" ? "docker" : "local";
  console.log(chalk.cyan("\n  Sandbox:\n"));
  console.log(chalk.dim(`  Mode:   ${chalk.white(mode)}`));
  console.log(
    chalk.dim(
      `  Docker: ${dockerAvailable ? chalk.green("available") : chalk.yellow("not available (using local fallback)")}`,
    ),
  );
  console.log("");
}

// ── /config ──────────────────────────────────────────────

function cmdConfig(): void {
  console.log(chalk.cyan("\n  Configuration:\n"));
  console.log(chalk.dim(`  Model:          ${chalk.white(DEFAULT_MODEL)}`));
  console.log(chalk.dim(`  Budget:         ${chalk.white(`$${BUDGET_USD.toFixed(2)}`)} per session`));
  console.log(chalk.dim(`  Nexus Home:     ${chalk.white(NEXUS_HOME)}`));
  console.log(chalk.dim(`  Sandbox:        ${chalk.white(process.env.NEXUS_SANDBOX ?? "local")}`));
  console.log(chalk.dim(`  Max iterations: ${chalk.white("25")}`));
  console.log(chalk.dim(`  Max tokens:     ${chalk.white("128000")}\n`));
}

// ── /mcp ─────────────────────────────────────────────────

export async function handleMcpCommand(
  parts: string[],
  mcpManager: McpManager,
  mcpConfigStore: McpConfigStore,
): Promise<void> {
  const sub = parts[1]?.toLowerCase();

  if (!sub || sub === "list") {
    const all = mcpConfigStore.getAll();
    if (all.length === 0) {
      console.log(chalk.dim("\n  No MCP servers. Ask the agent to add one.\n"));
      return;
    }
    const statuses = mcpManager.getStatuses();
    const statusMap = new Map(statuses.map((s) => [s.id, s]));
    console.log(chalk.cyan(`\n  ${all.length} MCP Server(s):\n`));
    for (const { id, config } of all) {
      const st = statusMap.get(id);
      const icon = !config.enabled ? chalk.dim("○") : st?.connected ? chalk.green("●") : chalk.red("●");
      const statusText = !config.enabled
        ? chalk.dim("disabled")
        : st?.connected
          ? chalk.green(`${st.toolCount} tools`)
          : chalk.red(st?.error ?? "disconnected");
      const transport =
        config.transport === "stdio"
          ? chalk.dim(`stdio: ${config.command} ${(config.args ?? []).slice(0, 2).join(" ")}`)
          : chalk.dim(`${config.transport}: ${config.url}`);
      console.log(`  ${icon} ${chalk.white(config.name)} ${chalk.dim(`[${id}]`)} — ${statusText}`);
      console.log(`     ${transport}`);
    }
    console.log("");
    return;
  }

  if (sub === "tools") {
    const id = parts[2] ?? null;
    const tools = id ? mcpManager.getServerTools(id) : mcpManager.getAllTools();
    if (tools.length === 0) {
      console.log(chalk.dim(`\n  No tools${id ? ` from "${id}"` : ""}. Is the server connected?\n`));
      return;
    }
    console.log(chalk.cyan(`\n  ${tools.length} MCP Tool(s)${id ? ` from "${id}"` : ""}:\n`));
    for (const t of tools.slice(0, 30)) {
      console.log(`  ${chalk.white(t.schema.name)}`);
      if (t.schema.description) console.log(`     ${chalk.dim(t.schema.description.slice(0, 80))}`);
    }
    if (tools.length > 30) console.log(chalk.dim(`  … and ${tools.length - 30} more`));
    console.log("");
    return;
  }

  if (sub === "test") {
    const id = parts[2];
    if (!id) { console.log(chalk.red("\n  Usage: /mcp test <server-id>\n")); return; }
    console.log(chalk.dim(`\n  Testing connection to "${id}"...`));
    try {
      const status = await mcpManager.connect(id);
      if (status.connected) {
        console.log(chalk.green(`  ✓ Connected — ${status.toolCount} tools in ${status.connectDurationMs}ms\n`));
      } else {
        console.log(chalk.red(`  ✗ Failed: ${status.error}\n`));
      }
    } catch (err: any) {
      console.log(chalk.red(`  ✗ Error: ${err.message}\n`));
    }
    return;
  }

  if (sub === "enable" || sub === "disable") {
    const id = parts[2];
    if (!id) { console.log(chalk.red(`\n  Usage: /mcp ${sub} <server-id>\n`)); return; }
    const enabled = sub === "enable";
    if (!enabled) await mcpManager.disconnect(id);
    const ok = mcpConfigStore.toggle(id, enabled);
    if (!ok) { console.log(chalk.red(`\n  No server with id "${id}".\n`)); return; }
    if (enabled) {
      try {
        const status = await mcpManager.connect(id);
        console.log(chalk.green(`\n  ✓ Server "${id}" enabled — ${status.toolCount} tools\n`));
      } catch (err: any) {
        console.log(chalk.yellow(`\n  Server "${id}" enabled but connection failed: ${err.message}\n`));
      }
    } else {
      console.log(chalk.green(`\n  Server "${id}" disabled.\n`));
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const id = parts[2];
    if (!id) { console.log(chalk.red("\n  Usage: /mcp remove <server-id>\n")); return; }
    await mcpManager.disconnect(id);
    const ok = mcpConfigStore.remove(id);
    console.log(ok ? chalk.green(`\n  Removed server "${id}".\n`) : chalk.red(`\n  No server with id "${id}".\n`));
    return;
  }

  console.log(chalk.dim("\n  Usage: /mcp [list|tools [id]|test <id>|enable <id>|disable <id>|remove <id>]\n"));
  console.log(chalk.dim("  To add a server: ask the agent — e.g. \"add the GitHub MCP server\"\n"));
}

// ── /cron ────────────────────────────────────────────────

export function handleCronCommand(parts: string[], cronStore: CronStore): void {
  const sub = parts[1]?.toLowerCase();

  if (!sub || sub === "list") {
    const jobs = cronStore.list();
    if (jobs.length === 0) {
      console.log(chalk.dim("\n  No scheduled jobs. Ask the agent to create one!\n"));
      return;
    }
    console.log(chalk.cyan(`\n  ${jobs.length} Scheduled Job(s):\n`));
    for (const j of jobs) {
      const statusIcon = j.enabled ? chalk.green("●") : chalk.dim("○");
      const next = new Date(j.nextRunAt).toLocaleString();
      const last = j.lastRunAt
        ? chalk.dim(`last: ${new Date(j.lastRunAt).toLocaleString()}`)
        : chalk.dim("never run");
      console.log(`  ${statusIcon} ${chalk.white(j.name)} ${chalk.dim(`[${j.id}]`)}`);
      console.log(`     ${chalk.dim(j.schedule)} · next: ${chalk.dim(next)} · ${last}`);
      console.log(`     ${chalk.dim(j.task.slice(0, 80))}`);
    }
    console.log("");
    return;
  }

  if (sub === "delete" || sub === "rm") {
    const id = parts[2];
    if (!id) { console.log(chalk.red("\n  Usage: /cron delete <id>\n")); return; }
    const ok = cronStore.remove(id);
    console.log(ok ? chalk.green(`\n  Deleted job ${id}.\n`) : chalk.red(`\n  No job with id ${id}.\n`));
    return;
  }

  if (sub === "enable" || sub === "disable") {
    const id = parts[2];
    if (!id) { console.log(chalk.red(`\n  Usage: /cron ${sub} <id>\n`)); return; }
    const job = cronStore.toggle(id, sub === "enable");
    if (job) {
      console.log(chalk.green(`\n  Job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.\n`));
    } else {
      console.log(chalk.red(`\n  No job with id ${id}.\n`));
    }
    return;
  }

  console.log(chalk.dim("\n  Usage: /cron [list|delete <id>|enable <id>|disable <id>]\n"));
}

// ── Main dispatcher ───────────────────────────────────────

export async function handleSlashCommand(input: string, ctx: SlashCommandContext): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/help":
      cmdHelp();
      return true;

    case "/clear":
      ctx.sessionMessages.length = 0;
      console.log(chalk.green("  ✓ Conversation cleared.\n"));
      return true;

    case "/undo":
      cmdUndo(ctx);
      return true;

    case "/retry":
      cmdRetry(ctx);
      return false; // Don't re-prompt — onRetry handles it

    case "/sessions":
      cmdSessions(parts, ctx);
      return true;

    case "/model":
      console.log(chalk.dim(`  Model: ${DEFAULT_MODEL}\n`));
      return true;

    case "/skills":
      cmdSkills(ctx);
      return true;

    case "/stats":
      cmdStats(ctx);
      return true;

    case "/budget":
      cmdBudget();
      return true;

    case "/audit":
      cmdAudit(ctx);
      return true;

    case "/memory":
      cmdMemory();
      return true;

    case "/sandbox":
      cmdSandbox();
      return true;

    case "/config":
      cmdConfig();
      return true;

    case "/mcp":
      if (!ctx.mcpManager || !ctx.mcpConfigStore) {
        console.log(chalk.dim("\n  MCP not initialized.\n"));
      } else {
        await handleMcpCommand(parts, ctx.mcpManager, ctx.mcpConfigStore);
      }
      return true;

    case "/cron":
      if (!ctx.cronStore) {
        console.log(chalk.dim("\n  Cron not initialized.\n"));
      } else {
        handleCronCommand(parts, ctx.cronStore);
      }
      return true;

    case "/exit":
      console.log(chalk.dim("\n  Goodbye!\n"));
      process.exit(0);

    default:
      console.log(chalk.red(`  Unknown command: ${cmd}\n`));
      return true;
  }
}
