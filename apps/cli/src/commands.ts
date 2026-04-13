/**
 * Nexus CLI — Slash command handlers
 */

import chalk from "chalk";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Message } from "@nexus/core";
import type { SkillStore, DualProcessRouter, ExperienceLearner, LearningDB } from "@nexus/intelligence";
import { GitHubSkillInstaller, SkillsDirScanner, SkillsShClient, installFromFile } from "@nexus/intelligence";
import { writeFileSync } from "node:fs";
import type { AuditLogger } from "@nexus/governance";
import type { McpManager, McpConfigStore } from "@nexus/protocols";
import type { CronStore } from "@nexus/runtime";
import { WikiStore } from "@nexus/core";
import { listSessions, loadSessionById, type SessionMeta } from "./session.js";
import { DEFAULT_MODEL, BUDGET_USD, NEXUS_HOME } from "./config.js";
import { printDoctorReport, printSetupReport, validateConfig } from "./diagnostics.js";

export interface SlashCommandContext {
  sessionMessages: Message[];
  lastUserInput: string;
  skillStore: SkillStore;
  router: DualProcessRouter;
  learner: ExperienceLearner;
  learningDb?: LearningDB;
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
  console.log(chalk.dim("  /skills         Manage skills  (list|pending|approve|retire|show|export|import)"));
  console.log(chalk.dim("  /skills install <org/repo>  Install skill from GitHub (SKILL.md)"));
  console.log(chalk.dim("  /skills search <query>      Search skills.sh / GitHub registry"));
  console.log(chalk.dim("  /skills browse [category]   Browse top skills by category"));
  console.log(chalk.dim("  /skills scan                Scan local .claude/skills/ directories"));
  console.log(chalk.dim("  /skills export-md [id]      Export skill(s) to SKILL.md format"));
  console.log(chalk.dim("  /thumbsup       Mark last response as successful (updates learning)"));
  console.log(chalk.dim("  /thumbsdown     Mark last response as failed (updates learning)"));
  console.log(chalk.dim("  /modes          (set in modes/ directory)"));
  console.log(chalk.dim("  /stats          Show routing & learning stats"));
  console.log(chalk.dim("  /budget         Show budget usage"));
  console.log(chalk.dim("  /audit          Show recent audit log"));
  console.log(chalk.dim("  /memory         Show memory store stats"));
  console.log(chalk.dim("  /sandbox        Show sandbox mode & Docker status"));
  console.log(chalk.dim("  /config         Show runtime configuration"));
  console.log(chalk.dim("  /doctor         Run configuration and environment checks"));
  console.log(chalk.dim("  /setup          Create runtime directories and starter .env"));
  console.log(chalk.dim("  /mcp            List MCP servers  (/mcp list|tools|test|enable|disable|remove)"));
  console.log(chalk.dim("  /cron           List scheduled cron jobs"));
  console.log(chalk.dim("  /wiki           Wiki knowledge base  (/wiki index|search <q>|list|lint)"));
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

const STATUS_ICON: Record<string, string> = {
  draft: "○",
  pending_review: "◎",
  trusted: "✓",
  retired: "✗",
};

async function cmdSkills(parts: string[], ctx: SlashCommandContext): Promise<void> {
  const sub = parts[1]?.toLowerCase();

  // /skills list [status]
  if (!sub || sub === "list") {
    const filterStatus = parts[2] as string | undefined;
    const skills = ctx.skillStore.getAll(filterStatus ? { status: filterStatus as any } : undefined);
    if (skills.length === 0) {
      console.log(chalk.dim(`\n  No ${filterStatus ?? ""}skills found. Nexus learns as you use it!\n`));
      return;
    }
    const header = filterStatus ? `${filterStatus} skills` : "All Skills";
    console.log(chalk.cyan(`\n  ${skills.length} ${header}:\n`));
    for (const s of skills) {
      const icon = STATUS_ICON[s.status] ?? "?";
      const conf = s.confidence.n > 0
        ? `${(s.confidence.point * 100).toFixed(0)}% (±${((s.confidence.upper - s.confidence.lower) / 2 * 100).toFixed(0)}%)`
        : "no data";
      const color = s.status === "trusted" ? chalk.green : s.status === "retired" ? chalk.red : chalk.yellow;
      console.log(
        `  ${color(icon)} ${chalk.white(s.name)} ${chalk.dim(`v${s.version} [${s.status}]`)}`,
      );
      console.log(
        `    ${chalk.dim(`confidence: ${conf} · ${s.confidence.n} uses · ${s.scope === "project" ? "project" : "global"}`)}`,
      );
    }
    console.log(chalk.dim(`\n  Subcommands: list [status] | pending | approve <id> | retire <id> | show <id> | export | import <file>`));
    console.log(chalk.dim(`               install <org/repo> | search <query> | browse [category] | scan | export-md [id]`));
    console.log("");
    return;
  }

  // /skills pending — show pending approvals
  if (sub === "pending") {
    const pending = ctx.learningDb?.getPendingApprovals() ?? [];
    if (pending.length === 0) {
      console.log(chalk.dim("\n  No skills pending review.\n"));
      return;
    }
    console.log(chalk.cyan(`\n  ${pending.length} Skills Pending Review:\n`));
    for (const p of pending) {
      const skill = ctx.skillStore.get(p.skillId);
      console.log(
        `  ◎ ${chalk.white(skill?.name ?? p.skillId)} — eval score: ${p.evalScore != null ? (p.evalScore * 100).toFixed(0) + "%" : "n/a"}`,
      );
      console.log(chalk.dim(`    /skills approve ${p.skillId}   or   /skills retire ${p.skillId}`));
    }
    console.log("");
    return;
  }

  // /skills approve <id>
  if (sub === "approve") {
    const skillId = parts[2];
    if (!skillId) { console.log(chalk.red("  Usage: /skills approve <skill-id>\n")); return; }
    const ok = await ctx.learner.approveSkillManually(skillId, "Approved via /skills approve");
    if (ok) {
      console.log(chalk.green(`  ✓ Skill "${skillId}" approved and promoted to trusted.\n`));
    } else {
      console.log(chalk.red(`  ✗ Skill "${skillId}" not found.\n`));
    }
    return;
  }

  // /skills retire <id> [reason]
  if (sub === "retire") {
    const skillId = parts[2];
    if (!skillId) { console.log(chalk.red("  Usage: /skills retire <skill-id> [reason]\n")); return; }
    const reason = parts.slice(3).join(" ") || "Manually retired";
    const ok = ctx.learner.retireSkill(skillId, reason);
    if (ok) {
      console.log(chalk.yellow(`  ✗ Skill "${skillId}" retired: ${reason}\n`));
    } else {
      console.log(chalk.red(`  Skill "${skillId}" not found.\n`));
    }
    return;
  }

  // /skills show <id>
  if (sub === "show") {
    const skillId = parts[2];
    const skill = skillId ? ctx.skillStore.get(skillId) : null;
    if (!skill) { console.log(chalk.red(`  Skill "${skillId}" not found.\n`)); return; }
    const metrics = ctx.learningDb?.getSkillMetrics(skill.id);
    const latestEval = ctx.learningDb?.getLatestEval(skill.id);
    console.log(chalk.cyan(`\n  Skill: ${skill.name} [v${skill.version}] [${skill.status}]\n`));
    console.log(`  ${chalk.dim("Description:")} ${skill.description}`);
    console.log(`  ${chalk.dim("Category:")}    ${skill.category}`);
    console.log(`  ${chalk.dim("Tags:")}        ${skill.tags.join(", ")}`);
    console.log(`  ${chalk.dim("Triggers:")}    ${skill.triggers.join(", ")}`);
    console.log(`  ${chalk.dim("Scope:")}       ${skill.scope}${skill.projectId ? ` (${skill.projectId})` : ""}`);
    console.log(`  ${chalk.dim("Confidence:")}  lower=${(skill.confidence.lower * 100).toFixed(0)}%  point=${(skill.confidence.point * 100).toFixed(0)}%  n=${skill.confidence.n}`);
    if (metrics) {
      console.log(`  ${chalk.dim("Metrics:")}     ${metrics.usageCount} uses · ${(metrics.successRate * 100).toFixed(0)}% success · avg $${metrics.avgCostUsd.toFixed(4)} · avg ${metrics.avgDurationMs.toFixed(0)}ms`);
    }
    if (latestEval) {
      const pass = latestEval.passed ? chalk.green("PASS") : chalk.red("FAIL");
      console.log(`  ${chalk.dim("Last eval:")}   ${pass} score=${(latestEval.score * 100).toFixed(0)}% (${latestEval.evalType})`);
    }
    console.log(`\n  ${chalk.dim("Procedure:")}`);
    console.log(`  ${skill.procedure.replace(/\n/g, "\n  ")}`);
    if (skill.changelog.length > 0) {
      console.log(`\n  ${chalk.dim("Recent changes:")}`);
      for (const c of skill.changelog.slice(-3)) {
        console.log(`  ${chalk.dim(`v${c.version}:`)} ${c.summary}`);
      }
    }
    console.log("");
    return;
  }

  // /skills export [file]
  if (sub === "export") {
    const outFile = parts[2] ?? `nexus-skills-${Date.now()}.json`;
    const exported = ctx.skillStore.export();
    writeFileSync(outFile, JSON.stringify(exported, null, 2));
    console.log(chalk.green(`  ✓ Exported ${exported.skills.length} trusted skills to ${outFile}\n`));
    return;
  }

  // /skills import <file>
  if (sub === "import") {
    const file = parts[2];
    if (!file || !existsSync(file)) { console.log(chalk.red(`  File not found: ${file}\n`)); return; }
    try {
      // Support both .json bundles and .md SKILL.md files
      if (file.endsWith(".md")) {
        const result = installFromFile(file);
        const skill = ctx.skillStore.add(result.skill);
        console.log(chalk.green(`  ✓ Imported skill "${skill.name}" from SKILL.md (status: draft — use /skills approve to promote)\n`));
      } else {
        const data = JSON.parse(readFileSync(file, "utf-8"));
        const imported = ctx.skillStore.import(data, { importedFrom: file });
        console.log(chalk.green(`  ✓ Imported ${imported.length} skills (status: draft — use /skills approve to promote)\n`));
      }
    } catch (e) {
      console.log(chalk.red(`  Import failed: ${e}\n`));
    }
    return;
  }

  // /skills install <org/repo> [@branch]
  // Install skill(s) directly from a GitHub repository
  if (sub === "install") {
    const ref = parts[2];
    if (!ref) {
      console.log(chalk.red("  Usage: /skills install <org/repo>  or  /skills install <org/repo@branch>\n"));
      console.log(chalk.dim("  Examples:\n"));
      console.log(chalk.dim("    /skills install anthropics/nexus-skills\n"));
      console.log(chalk.dim("    /skills install vercel-labs/skill-pack@main\n"));
      console.log(chalk.dim("    /skills install https://github.com/org/repo\n"));
      return;
    }
    console.log(chalk.dim(`\n  Installing from GitHub: ${ref}...\n`));
    try {
      const installer = new GitHubSkillInstaller();
      const results = await installer.fetchFromGitHub(ref);
      let installed = 0;
      for (const result of results) {
        // Check for duplicates
        const existing = ctx.skillStore.getAll().find(
          (s) => s.name.toLowerCase() === result.skill.name.toLowerCase(),
        );
        if (existing) {
          console.log(chalk.dim(`  ○ Skipped "${result.skill.name}" — already exists (${existing.status})`));
          continue;
        }
        const skill = ctx.skillStore.add(result.skill);
        console.log(chalk.green(`  ✓ Installed "${chalk.white(skill.name)}" ${chalk.dim(`[${skill.id}]`)}`));
        console.log(chalk.dim(`     From: ${result.source}`));
        console.log(chalk.dim(`     Status: draft — run /skills approve ${skill.id} to promote\n`));
        installed++;
      }
      if (installed === 0 && results.length > 0) {
        console.log(chalk.yellow("  All skills already installed.\n"));
      } else if (installed > 0) {
        console.log(chalk.green(`\n  ✓ Installed ${installed} skill(s). Use /skills approve to promote to trusted.\n`));
      }
    } catch (err: any) {
      console.log(chalk.red(`  ✗ Install failed: ${err.message}\n`));
      console.log(chalk.dim("  Tip: Set GITHUB_TOKEN env var to avoid rate limits.\n"));
    }
    return;
  }

  // /skills search <query>
  // Search the skills.sh / GitHub registry for matching skills
  if (sub === "search") {
    const query = parts.slice(2).join(" ");
    if (!query) {
      console.log(chalk.red("  Usage: /skills search <query>\n"));
      console.log(chalk.dim("  Example: /skills search git commit automation\n"));
      return;
    }
    console.log(chalk.dim(`\n  Searching registry for "${query}"...\n`));
    try {
      const client = new SkillsShClient();
      const results = await client.search(query, 10);
      if (results.length === 0) {
        console.log(chalk.dim("  No skills found. Try different keywords or /skills browse.\n"));
        return;
      }
      console.log(chalk.cyan(`  ${results.length} result(s) for "${query}":\n`));
      for (const r of results) {
        const stars = r.stars != null ? chalk.dim(` ★ ${r.stars}`) : "";
        console.log(`  ${chalk.white(r.name)}${stars}  ${chalk.dim(r.repo)}`);
        console.log(`     ${chalk.dim(r.description.slice(0, 100))}`);
        if (r.tags?.length) console.log(`     ${chalk.dim(r.tags.slice(0, 5).join(" · "))}`);
        console.log(chalk.dim(`     /skills install ${r.repo}`));
        console.log("");
      }
    } catch (err: any) {
      console.log(chalk.red(`  Search failed: ${err.message}\n`));
      console.log(chalk.dim("  Tip: Set GITHUB_TOKEN for authenticated search (higher rate limits).\n"));
    }
    return;
  }

  // /skills browse [category]
  // Browse top skills from the registry by category
  if (sub === "browse") {
    const category = parts[2]?.toLowerCase();
    const label = category ? `"${category}" skills` : "top agent skills";
    console.log(chalk.dim(`\n  Browsing ${label} from registry...\n`));
    try {
      const client = new SkillsShClient();
      const results = await client.browse(category, 15);
      if (results.length === 0) {
        console.log(chalk.dim("  No skills found in registry. Try /skills search <query>.\n"));
        return;
      }
      const categories = ["coding", "git", "data", "devops", "writing", "research", "security", "files", "web", "testing"];
      console.log(chalk.cyan(`  📦 ${results.length} skill(s) found:\n`));
      for (const r of results) {
        const stars = r.stars != null ? chalk.dim(` ★ ${r.stars}`) : "";
        console.log(`  ${chalk.white(r.name)}${stars}`);
        console.log(`     ${chalk.dim(r.description.slice(0, 100))}`);
        console.log(chalk.dim(`     /skills install ${r.repo}`));
        console.log("");
      }
      console.log(chalk.dim(`  Categories: ${categories.join(" · ")}`));
      console.log(chalk.dim("  Use /skills browse <category> to filter\n"));
    } catch (err: any) {
      console.log(chalk.red(`  Browse failed: ${err.message}\n`));
    }
    return;
  }

  // /skills scan
  // Scan local .claude/skills/ and .agents/skills/ directories
  if (sub === "scan") {
    console.log(chalk.dim("\n  Scanning local skill directories...\n"));
    const scanner = new SkillsDirScanner();
    const results = scanner.scan(process.cwd());
    if (results.length === 0) {
      console.log(chalk.dim("  No SKILL.md files found in:\n"));
      console.log(chalk.dim("    .claude/skills/\n    .agents/skills/\n    ~/.claude/skills/\n    ~/.config/agents/skills/\n"));
      console.log(chalk.dim("  Install skills with /skills install <org/repo> or /skills search <query>\n"));
      return;
    }
    console.log(chalk.cyan(`  Found ${results.length} local SKILL.md file(s):\n`));
    let imported = 0;
    for (const result of results) {
      const existing = ctx.skillStore.getAll().find(
        (s) => s.name.toLowerCase() === result.skill.name.toLowerCase(),
      );
      if (existing) {
        const icon = STATUS_ICON[existing.status] ?? "?";
        const color = existing.status === "trusted" ? chalk.green : chalk.yellow;
        console.log(`  ${color(icon)} ${chalk.white(existing.name)} ${chalk.dim("(already imported)")}`);
      } else {
        const skill = ctx.skillStore.add(result.skill);
        console.log(`  ${chalk.green("+")} ${chalk.white(skill.name)} ${chalk.dim(`← ${result.source}`)}`);
        imported++;
      }
    }
    if (imported > 0) {
      console.log(chalk.green(`\n  ✓ Imported ${imported} new skill(s). Use /skills approve to promote.\n`));
    } else {
      console.log(chalk.dim("\n  All local skills already imported.\n"));
    }
    return;
  }

  // /skills export-md [id] [output-dir]
  // Export a skill to SKILL.md format
  if (sub === "export-md") {
    const skillId = parts[2];
    const outputDir = parts[3] ?? ".agents/skills";
    const scanner = new SkillsDirScanner();

    if (skillId) {
      const skill = ctx.skillStore.get(skillId);
      if (!skill) { console.log(chalk.red(`  Skill "${skillId}" not found.\n`)); return; }
      const filePath = scanner.exportSkill(skill, outputDir);
      console.log(chalk.green(`  ✓ Exported "${skill.name}" to ${filePath}\n`));
    } else {
      // Export all trusted skills
      const skills = ctx.skillStore.getAll({ status: "trusted" });
      if (skills.length === 0) { console.log(chalk.dim("  No trusted skills to export.\n")); return; }
      for (const skill of skills) {
        const filePath = scanner.exportSkill(skill, outputDir);
        console.log(chalk.green(`  ✓ ${skill.name} → ${filePath}`));
      }
      console.log(chalk.green(`\n  Exported ${skills.length} skill(s) to ${outputDir}/\n`));
    }
    return;
  }

  console.log(chalk.dim(`\n  Unknown subcommand: ${sub}\n`));
  console.log(chalk.dim("  Usage: /skills [list|pending|approve|retire|show|export|import|install|search|browse|scan|export-md]\n"));
}

// ── /stats ───────────────────────────────────────────────

function cmdStats(ctx: SlashCommandContext): void {
  const routerStats = ctx.router.getStats();
  const learnStats = ctx.learner.getStats();
  console.log(chalk.cyan("\n  Intelligence Stats:\n"));
  console.log(chalk.dim(`  Trajectories stored: ${learnStats.trajectoriesStored}`));
  if (learnStats.outcomeBreakdown) {
    const ob = learnStats.outcomeBreakdown;
    console.log(chalk.dim(`    success: ${ob.success ?? 0}  partial: ${ob.partial ?? 0}  failure: ${ob.failure ?? 0}  unknown: ${ob.unknown ?? 0}`));
  }
  console.log(chalk.dim(`  Skills by status:`));
  for (const [status, count] of Object.entries(learnStats.skillsByStatus ?? {})) {
    const icon = STATUS_ICON[status] ?? "?";
    console.log(chalk.dim(`    ${icon} ${status}: ${count}`));
  }
  console.log(chalk.dim(`  Pending approvals:   ${learnStats.pendingApprovals ?? 0}`));
  console.log(chalk.dim(`  Routing decisions:   ${routerStats.total}`));
  console.log(chalk.dim(`    System 1 (fast):   ${routerStats.system1} (${(routerStats.system1Pct * 100).toFixed(1)}%)`));
  console.log(chalk.dim(`    System 2 (full):   ${routerStats.system2}`));
  if (ctx.learningDb) {
    const benchReport = ctx.learningDb.getBenchmarkReport();
    if (benchReport.totalRuns > 0) {
      const savings = Math.max(0, benchReport.avgCostSystem2 - benchReport.avgCostSystem1);
      console.log(chalk.dim(`  Benchmark cost savings: $${savings.toFixed(4)}/task via System 1`));
    }
  }
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

// ── /wiki ─────────────────────────────────────────────────

export function handleWikiCommand(parts: string[]): void {
  const store = new WikiStore(NEXUS_HOME);
  const sub = parts[1]?.toLowerCase();

  if (!sub || sub === "index") {
    const index = store.readIndex();
    console.log(chalk.cyan("\n  Wiki Index:\n"));
    const lines = index.split("\n").slice(0, 40);
    for (const l of lines) console.log("  " + chalk.dim(l));
    if (index.split("\n").length > 40) console.log(chalk.dim("  ... (truncated)"));
    console.log("");
    return;
  }

  if (sub === "search") {
    const query = parts.slice(2).join(" ");
    if (!query) { console.log(chalk.red("\n  Usage: /wiki search <query>\n")); return; }
    const results = store.search(query);
    if (results.length === 0) {
      console.log(chalk.dim(`\n  No wiki pages found for "${query}".\n`));
      return;
    }
    console.log(chalk.cyan(`\n  ${results.length} result(s) for "${query}":\n`));
    for (const p of results.slice(0, 15)) {
      console.log(`  ${chalk.white(p.path)}`);
      if (p.summary) console.log(`     ${chalk.dim(p.summary.slice(0, 80))}`);
    }
    console.log("");
    return;
  }

  if (sub === "list") {
    const category = parts[2];
    const pages = store.listPages(category);
    if (pages.length === 0) {
      console.log(chalk.dim(`\n  No wiki pages${category ? ` in "${category}"` : ""}.\n`));
      return;
    }
    console.log(chalk.cyan(`\n  ${pages.length} Wiki Page(s)${category ? ` in "${category}"` : ""}:\n`));
    const sorted = pages.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const p of sorted.slice(0, 30)) {
      const date = new Date(p.updatedAt).toISOString().slice(0, 10);
      const size = `${Math.round(p.size / 1024 * 10) / 10}KB`;
      console.log(`  ${chalk.white(p.path)} ${chalk.dim(`(${size}, ${date})`)}`);
      if (p.summary) console.log(`     ${chalk.dim(p.summary.slice(0, 80))}`);
    }
    if (pages.length > 30) console.log(chalk.dim(`  ... and ${pages.length - 30} more`));
    console.log("");
    return;
  }

  if (sub === "lint") {
    console.log(chalk.dim("\n  Running wiki lint...\n"));
    const issues = store.lint();
    if (issues.length === 0) {
      console.log(chalk.green("  ✓ Wiki lint passed — no issues found.\n"));
      return;
    }
    const byLevel = { error: chalk.red, warn: chalk.yellow, info: chalk.dim };
    console.log(chalk.cyan(`  ${issues.length} issue(s):\n`));
    for (const i of issues) {
      const color = byLevel[i.severity] ?? chalk.white;
      console.log(`  ${color(`[${i.severity}]`)} ${chalk.white(i.page)}: ${chalk.dim(i.message)}`);
    }
    console.log("");
    return;
  }

  if (sub === "read") {
    const page = parts.slice(2).join(" ");
    if (!page) { console.log(chalk.red("\n  Usage: /wiki read <page-path>\n")); return; }
    const content = store.readPage(page);
    console.log(chalk.cyan(`\n  ${page}:\n`));
    const lines = content.split("\n").slice(0, 50);
    for (const l of lines) console.log("  " + chalk.dim(l));
    if (content.split("\n").length > 50) console.log(chalk.dim("  ... (truncated, use wiki_read tool for full content)"));
    console.log("");
    return;
  }

  console.log(chalk.dim("\n  Usage: /wiki [index|search <q>|list [category]|lint|read <page>]\n"));
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
      await cmdSkills(parts, ctx);
      return true;

    case "/thumbsup":
    case "/👍":
      ctx.learner.applyUserFeedback("positive");
      console.log(chalk.green("  ✓ Feedback recorded: positive. Learning updated.\n"));
      return true;

    case "/thumbsdown":
    case "/👎":
      ctx.learner.applyUserFeedback("negative");
      console.log(chalk.yellow("  ✓ Feedback recorded: negative. Learning updated.\n"));
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

    case "/doctor":
      printDoctorReport(validateConfig());
      return true;

    case "/setup":
      printSetupReport();
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

    case "/wiki":
      handleWikiCommand(parts);
      return true;

    case "/exit":
      console.log(chalk.dim("\n  Goodbye!\n"));
      process.exit(0);

    default:
      console.log(chalk.red(`  Unknown command: ${cmd}\n`));
      return true;
  }
}
