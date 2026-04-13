#!/usr/bin/env bun

/**
 * Nexus CLI — Bootstrap
 */

import { resolve, join } from "node:path";
import chalk from "chalk";

import {
  NexusAgent,
  builtinTools,
  budgetEnforcer,
  promptFirewall,
  outputScanner,
  timing,
  logger,
} from "@nexus/core";
import { createProvider, parseModelString } from "@nexus/providers";
import {
  SkillStore,
  DualProcessRouter,
  System1Executor,
  ExperienceLearner,
  ModeManager,
} from "@nexus/intelligence";
import {
  AuditLogger,
  PermissionGuard,
  DynamicSupervisor,
  BehavioralMonitor,
  permissionMiddleware,
  supervisionMiddleware,
  monitorMiddleware,
} from "@nexus/governance";
import { McpConfigStore, McpManager, createMcpManagementTools } from "@nexus/protocols";
import { CronStore, CronRunner, createCronTools } from "@nexus/runtime";
import type { CronJob, CronRunResult } from "@nexus/runtime";

import { DEFAULT_MODEL, BUDGET_USD, NEXUS_HOME, SYSTEM_PROMPT, loadProjectContext } from "./config.js";
import { createCombinedHandler } from "./events.js";
import { printBanner } from "./banner.js";
import { startRepl } from "./repl.js";

// ── Intelligence Layer ────────────────────────────────────

const skillStore  = new SkillStore(join(NEXUS_HOME, "skills"));
const router      = new DualProcessRouter(skillStore);
const modeManager = new ModeManager(resolve(process.cwd(), "modes"));
const provider    = createProvider(parseModelString(DEFAULT_MODEL));
const learner     = new ExperienceLearner(provider, skillStore);
const system1     = new System1Executor(provider);

// ── Governance Layer ──────────────────────────────────────

const auditLogger     = new AuditLogger(join(NEXUS_HOME, "audit"));
const permissionGuard = new PermissionGuard(process.cwd());

const supervisor = new DynamicSupervisor({
  onApprovalNeeded: async (decision) => {
    console.log(chalk.bgRed.white(`\n  ✋ HITL Required: ${decision.reason}  `));
    console.log(chalk.red(`  └─ Tool: ${decision.toolName} (Auto-denied in REPL mode)`));
    return false;
  },
});

const monitor = new BehavioralMonitor({}, (alert) => {
  process.stderr.write(chalk.yellow(`  🚨 ALERT: ${alert.message}\n`));
});

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectContext = loadProjectContext();

  // ── MCP ───────────────────────────────────────────────
  const mcpConfigStore = new McpConfigStore(join(NEXUS_HOME, "mcp.json"));
  const mcpManager     = new McpManager(mcpConfigStore);

  if (mcpConfigStore.getAll().length === 0) {
    mcpConfigStore.add("memory", {
      name: "Memory",
      transport: "stdio",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      enabled: true,
      timeoutMs: 30_000,
      connectTimeoutMs: 15_000,
    });
  }

  console.log(chalk.dim("  MCP: Connecting to servers..."));
  const mcpStatuses = await mcpManager.connectAll(15_000);
  for (const s of mcpStatuses) {
    if (s.connected) {
      console.log(chalk.dim(`  MCP: ✓ ${s.name} — ${s.toolCount} tools (${s.connectDurationMs}ms)`));
    } else {
      console.log(chalk.yellow(`  MCP: ✗ ${s.name} — ${s.error ?? "failed"}`));
    }
  }

  const mcpTools     = mcpManager.getAllTools();
  const mcpMgmtTools = createMcpManagementTools(mcpConfigStore, mcpManager);
  const cronStore    = new CronStore(join(NEXUS_HOME, "cron"));
  const cronTools    = createCronTools(cronStore);
  const allTools     = [...builtinTools, ...mcpTools, ...mcpMgmtTools, ...cronTools];

  // ── Agent ─────────────────────────────────────────────
  const combinedEventHandler = createCombinedHandler(auditLogger, monitor);

  const agent = new NexusAgent({
    config: {
      model: DEFAULT_MODEL,
      systemPrompt: SYSTEM_PROMPT + projectContext,
      tools: allTools,
      middleware: [
        timing(),
        monitorMiddleware(monitor),
        promptFirewall(),
        budgetEnforcer({ limitUsd: BUDGET_USD }),
        permissionMiddleware(permissionGuard),
        supervisionMiddleware(supervisor),
        outputScanner(),
        logger({ verbose: false }),
      ],
      maxIterations: 25,
      maxContextTokens: 128_000,
    },
    provider,
    onEvent: combinedEventHandler,
  });

  // ── Cron Runner ───────────────────────────────────────
  const cronRunner = new CronRunner(
    cronStore,
    async (task: string) => (await agent.run(task, [])).response,
    (job: CronJob, result: CronRunResult) => {
      const icon = result.success ? chalk.green("✔") : chalk.red("✖");
      process.stderr.write(
        `\n  ${icon} ${chalk.cyan("Cron")} ${chalk.white(job.name)}: ` +
        `${result.output.slice(0, 120).replace(/\n/g, " ")}\n`,
      );
    },
  );
  cronRunner.start();

  printBanner(skillStore, router, modeManager);

  // ── REPL ──────────────────────────────────────────────
  startRepl({
    agent,
    allTools,
    router,
    system1,
    learner,
    modeManager,
    skillStore,
    auditLogger,
    mcpManager,
    mcpConfigStore,
    cronStore,
    onShutdown: async () => {
      cronRunner.stop();
      await mcpManager.disconnectAll().catch(() => {});
    },
  });
}

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err}`));
  process.exit(1);
});
