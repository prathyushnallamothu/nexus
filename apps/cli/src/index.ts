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
  memoryContextBuilder,
  artifactTracker,
  toolCompactor,
  afterAgent,
  afterAgentHooks,
  initPlannerTools,
} from "@nexus/core";
import { createProvider, parseModelString } from "@nexus/providers";
import {
  SkillStore,
  DualProcessRouter,
  System1Executor,
  ExperienceLearner,
  ModeManager,
  LearningDB,
  SkillEvaluator,
  MemoryManager,
} from "@nexus/intelligence";
import {
  AuditLogger,
  AuditDB,
  PermissionGuard,
  DynamicSupervisor,
  BehavioralMonitor,
  PolicyEngine,
  PolicyStore,
  ApprovalQueue,
  BudgetStore,
  BudgetHistory,
  IdentityManager,
  NetworkGuard,
  createInteractiveSupervisor,
  permissionMiddleware,
  supervisionMiddleware,
  monitorMiddleware,
  networkMiddleware,
} from "@nexus/governance";
import { McpConfigStore, McpManager, createMcpManagementTools } from "@nexus/protocols";
import { CronStore, CronRunner, createCronTools, createSandboxManager } from "@nexus/runtime";
import type { CronJob, CronRunResult } from "@nexus/runtime";
import { initWikiTools } from "@nexus/core";

import { DEFAULT_MODEL, BUDGET_USD, NEXUS_HOME, SYSTEM_PROMPT, loadProjectContext } from "./config.js";
import {
  hasBlockingConfigIssue,
  installCrashHandlers,
  printDoctorReport,
  printSetupReport,
  validateConfig,
  writeStructuredLog,
} from "./diagnostics.js";
import { runSetupWizard, applyWizardConfig } from "./wizard.js";
import { createCombinedHandler } from "./events.js";
import { printBanner } from "./banner.js";
import { startRepl } from "./repl.js";

// ── Wiki ──────────────────────────────────────────────────
// Must be initialised before builtinTools are used.
initWikiTools(NEXUS_HOME);

// ── Intelligence Layer ────────────────────────────────────

const provider    = createProvider(parseModelString(DEFAULT_MODEL));
const skillStore  = new SkillStore(join(NEXUS_HOME, "skills"));
const learningDb  = new LearningDB(join(NEXUS_HOME, "learning.db"));
const evaluator   = new SkillEvaluator(learningDb, provider);
const router      = new DualProcessRouter(skillStore, undefined, learningDb);
const modeManager = new ModeManager(resolve(process.cwd(), "modes"));
const learner     = new ExperienceLearner(provider, skillStore, learningDb, evaluator, {
  autoApprove: true,          // promote passing skills automatically
  runShadowEval: false,       // shadow eval costs LLM tokens — enable in high-stakes setups
  retirementSuccessThreshold: 0.4,
});
const system1     = new System1Executor(provider);
const memoryManager = new MemoryManager(join(NEXUS_HOME, "memory"), provider);

// ── Governance Layer ──────────────────────────────────────

const govDir         = join(NEXUS_HOME, "governance");
const auditDb        = new AuditDB(join(govDir, "audit.db"));
const auditLogger    = new AuditLogger(join(NEXUS_HOME, "audit"), undefined, auditDb);
const permissionGuard = new PermissionGuard(process.cwd());
const policyEngine   = new PolicyEngine(NEXUS_HOME);
const approvalQueue  = new ApprovalQueue(join(govDir, "approvals.db"), { defaultChannel: "cli" });
const budgetStore    = new BudgetStore(join(govDir, "budgets"));
const budgetHistory  = new BudgetHistory(join(govDir, "budgets"));
const identityMgr    = new IdentityManager(join(govDir, "identities.json"));
const networkGuard   = new NetworkGuard({ denyPrivateRanges: true });

// Resolve current user — auto-detect from git/env/OS
const currentIdentity = identityMgr.resolve();

// Approval-backed supervisor — interactive CLI prompt for HITL
const supervisor = createInteractiveSupervisor(approvalQueue, "cli");

const monitor = new BehavioralMonitor({}, (alert) => {
  process.stderr.write(chalk.yellow(`  🚨 ALERT: ${alert.message}\n`));
});

// ── Sandbox Layer ─────────────────────────────────────────

const sandboxManager = createSandboxManager({
  nexusHome: NEXUS_HOME,
  onEvent: (event) => {
    const taskId = event.type === "created" ? event.handle.taskId : (event as any).taskId ?? "?";
    process.stderr.write(chalk.dim(`  [sandbox] ${event.type} task=${taskId}\n`));
  },
});
sandboxManager.start();

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const configChecks = validateConfig();
  if (hasBlockingConfigIssue(configChecks)) {
    printDoctorReport(configChecks);
    console.log(chalk.yellow("  Continuing in REPL mode. Provider calls may fail until configuration issues are fixed.\n"));
  }

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

  const mcpTools      = mcpManager.getAllTools();
  const mcpMgmtTools  = createMcpManagementTools(mcpConfigStore, mcpManager);
  const cronStore     = new CronStore(join(NEXUS_HOME, "cron"));
  const cronTools     = createCronTools(cronStore);
  const plannerTools  = initPlannerTools(join(NEXUS_HOME, "tasks"));
  // plannerTools replace the default planner tools already in builtinTools
  // (which use env-var paths). Filter them out and use the properly-pathed ones.
  const coreTools     = builtinTools.filter(
    (t) => !["task_plan","task_update","task_list","task_complete","task_checkpoint"].includes(t.schema.name),
  );
  const allTools      = [...coreTools, ...mcpTools, ...mcpMgmtTools, ...cronTools, ...plannerTools];

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
        memoryContextBuilder({ nexusHome: NEXUS_HOME }),
        budgetEnforcer({ limitUsd: BUDGET_USD }),
        permissionMiddleware(permissionGuard),
        networkMiddleware(networkGuard),
        supervisionMiddleware(supervisor),
        artifactTracker(),          // record files/commands/URLs as artifacts
        toolCompactor(),            // truncate huge tool outputs before they blow context
        outputScanner(),
        logger({ verbose: false }),
        afterAgent([               // deterministic hooks that run after the loop
          afterAgentHooks.noteFileChanges,
          afterAgentHooks.archiveSessionToWiki({ nexusHome: NEXUS_HOME }),
          afterAgentHooks.suggestCommitIfChanged,
        ]),
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
  writeStructuredLog("info", "cli.started", {
    model: DEFAULT_MODEL,
    budgetUsd: BUDGET_USD,
    cwd: process.cwd(),
    nexusHome: NEXUS_HOME,
  });

  // ── REPL ──────────────────────────────────────────────
  startRepl({
    agent,
    allTools,
    router,
    system1,
    learner,
    modeManager,
    skillStore,
    learningDb,
    memoryManager,
    auditLogger,
    approvalQueue,
    policyEngine,
    budgetStore,
    budgetHistory,
    identityManager: identityMgr,
    mcpManager,
    mcpConfigStore,
    cronStore,
    sandboxManager,
    onShutdown: async () => {
      cronRunner.stop();
      await sandboxManager.stop();
      learningDb.close();
      auditDb.close();
      await mcpManager.disconnectAll().catch(() => {});
    },
  });
}

installCrashHandlers();

const command = process.argv[2]?.toLowerCase();
if (command === "doctor") {
  const checks = validateConfig();
  printDoctorReport(checks);
  process.exit(hasBlockingConfigIssue(checks) ? 1 : 0);
} else if (command === "setup" || command === "onboard") {
  // Run interactive setup wizard
  runSetupWizard()
    .then((config) => applyWizardConfig(config))
    .catch((err) => {
      console.error(chalk.red(`Setup failed: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    });
} else {
  main().catch((err) => {
    writeStructuredLog("error", "cli.fatal", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    console.error(chalk.red(`Fatal: ${err}`));
    process.exit(1);
  });
}
