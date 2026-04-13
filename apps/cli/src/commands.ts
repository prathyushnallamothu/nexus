/**
 * Nexus CLI — Slash command handlers
 */

import chalk from "chalk";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Message } from "@nexus/core";
import type { SkillStore, DualProcessRouter, ExperienceLearner, LearningDB, MemoryManager } from "@nexus/intelligence";
import { GitHubSkillInstaller, SkillsDirScanner, SkillsShClient, installFromFile } from "@nexus/intelligence";
import { writeFileSync } from "node:fs";
import type { AuditLogger } from "@nexus/governance";
import type { McpManager, McpConfigStore } from "@nexus/protocols";
import type { CronStore } from "@nexus/runtime";
import { WikiStore } from "@nexus/core";
import { listSessions, loadSessionById, type SessionMeta } from "./session.js";
import { DEFAULT_MODEL, BUDGET_USD, NEXUS_HOME } from "./config.js";
import { printDoctorReport, printSetupReport, validateConfig } from "./diagnostics.js";

// Lazy-import governance types (modules may not be built yet)
type ApprovalQueue = import("@nexus/governance").ApprovalQueue;
type PolicyEngine = import("@nexus/governance").PolicyEngine;
type BudgetStore = import("@nexus/governance").BudgetStore;
type BudgetHistory = import("@nexus/governance").BudgetHistory;
type IdentityManager = import("@nexus/governance").IdentityManager;
type SandboxManager = import("@nexus/runtime").SandboxManager;

export interface SlashCommandContext {
  sessionMessages: Message[];
  lastUserInput: string;
  skillStore: SkillStore;
  router: DualProcessRouter;
  learner: ExperienceLearner;
  learningDb?: LearningDB;
  memoryManager?: MemoryManager;
  auditLogger: AuditLogger;
  mcpManager: McpManager | null;
  mcpConfigStore: McpConfigStore | null;
  cronStore: CronStore | null;
  // Governance extensions
  approvalQueue?: ApprovalQueue;
  policyEngine?: PolicyEngine;
  budgetStore?: BudgetStore;
  budgetHistory?: BudgetHistory;
  identityManager?: IdentityManager;
  sandboxManager?: SandboxManager;
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
  console.log(chalk.dim("  /budget         Budget dashboard  (show|history [scope] [id])"));
  console.log(chalk.dim("  /audit          Audit log  (search <q>|stats|<n>)"));
  console.log(chalk.dim("  /approvals      HITL approval queue  (list|approve|deny|history)"));
  console.log(chalk.dim("  /policy         Governance policy  (show|preset|dryrun|test|history|rollback)"));
  console.log(chalk.dim("  /identity       Identity management  (whoami|list|create|role)"));
  console.log(chalk.dim("  /memory         Show memory store stats"));
  console.log(chalk.dim("  /sandbox        Sandbox management  (status|acquire|exec|health|extract|release|cleanup)"));
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

// ── /approvals ───────────────────────────────────────────

async function cmdApprovals(parts: string[], ctx: SlashCommandContext): Promise<void> {
  const sub = parts[1]?.toLowerCase();
  const queue = ctx.approvalQueue;

  if (!queue) {
    console.log(chalk.dim("\n  Approval queue not initialized.\n"));
    return;
  }

  const RISK_COLOR: Record<string, (s: string) => string> = {
    low: chalk.green,
    medium: chalk.yellow,
    high: chalk.red,
    critical: chalk.bgRed.white,
  };
  const STATUS_COLOR: Record<string, (s: string) => string> = {
    pending: chalk.yellow,
    approved: chalk.green,
    denied: chalk.red,
    expired: chalk.dim,
    cancelled: chalk.dim,
  };

  if (!sub || sub === "list") {
    const pending = queue.getPending();
    if (pending.length === 0) {
      console.log(chalk.dim("\n  No pending approvals.\n"));
    } else {
      console.log(chalk.cyan(`\n  ${pending.length} Pending Approval(s):\n`));
      for (const r of pending) {
        const riskColor = RISK_COLOR[r.riskLevel] ?? chalk.white;
        const age = Math.round((Date.now() - r.requestedAt) / 1000);
        const expires = r.expiresAt ? Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000)) : null;
        console.log(`  ${riskColor(`[${r.riskLevel.toUpperCase()}]`)} ${chalk.white(r.toolName)} ${chalk.dim(`[${r.id.slice(0, 8)}]`)}`);
        console.log(`     Reason: ${chalk.dim(r.reason)}`);
        console.log(`     Age: ${chalk.dim(`${age}s`)}${expires !== null ? `  Expires in: ${chalk.yellow(`${expires}s`)}` : ""}`);
        console.log(chalk.dim(`     /approvals approve ${r.id.slice(0, 8)}   or   /approvals deny ${r.id.slice(0, 8)}`));
        console.log("");
      }
    }

    const stats = queue.getStats();
    console.log(chalk.dim(`  Stats: ${stats.pending} pending · ${stats.approved} approved · ${stats.denied} denied · ${stats.expired} expired\n`));
    return;
  }

  if (sub === "approve" || sub === "deny") {
    const idPrefix = parts[2];
    const notes = parts.slice(3).join(" ") || undefined;
    if (!idPrefix) {
      console.log(chalk.red(`  Usage: /approvals ${sub} <id-prefix> [notes]\n`));
      return;
    }
    // Find by prefix
    const all = queue.getRecent(100);
    const match = all.find((r) => r.id.startsWith(idPrefix) && r.status === "pending");
    if (!match) {
      console.log(chalk.red(`  No pending approval found matching "${idPrefix}"\n`));
      return;
    }
    const ok = sub === "approve"
      ? queue.approve(match.id, "cli-operator", notes)
      : queue.deny(match.id, "cli-operator", notes);
    if (ok) {
      const verb = sub === "approve" ? chalk.green("approved") : chalk.red("denied");
      console.log(chalk.green(`  ✓ Request ${match.id.slice(0, 8)} ${verb}: ${match.toolName}\n`));
    } else {
      console.log(chalk.red(`  Failed — request may have already been decided.\n`));
    }
    return;
  }

  if (sub === "history") {
    const recent = queue.getRecent(20);
    if (recent.length === 0) {
      console.log(chalk.dim("\n  No approval history.\n"));
      return;
    }
    console.log(chalk.cyan(`\n  Last ${recent.length} Approval(s):\n`));
    for (const r of recent) {
      const statusColor = STATUS_COLOR[r.status] ?? chalk.white;
      const ts = new Date(r.requestedAt).toLocaleString();
      console.log(`  ${statusColor(`[${r.status}]`)} ${chalk.white(r.toolName)} ${chalk.dim(ts)}`);
      if (r.reason) console.log(`     ${chalk.dim(r.reason)}`);
    }
    console.log("");
    return;
  }

  console.log(chalk.dim("\n  Usage: /approvals [list|approve <id>|deny <id>|history]\n"));
}

// ── /policy ──────────────────────────────────────────────

async function cmdPolicy(parts: string[], ctx: SlashCommandContext): Promise<void> {
  const sub = parts[1]?.toLowerCase();
  const pe = ctx.policyEngine;

  if (!pe) {
    console.log(chalk.dim("\n  Policy engine not initialized. Create nexus-policy.json to enable.\n"));
    console.log(chalk.dim("  Presets: local-dev · repo-only · ci · production\n"));
    return;
  }

  const ps = (pe as any).getStore?.() ?? pe;

  const PRESET_DESC: Record<string, string> = {
    "local-dev":   "Permissive — ideal for solo dev, warns on destructive commands",
    "repo-only":   "Filesystem restricted to git repo, network limited to GitHub",
    "ci":          "Read-heavy, no HITL, $5 session cap, no deploys",
    "production":  "All deploys HITL, secrets scanned everywhere, tight audit",
  };

  if (!sub || sub === "show") {
    const policy = (ps as any).getCurrent?.();
    if (!policy) {
      console.log(chalk.dim("\n  No policy file found. Use /policy preset <name> to create one.\n"));
      return;
    }
    console.log(chalk.cyan("\n  Current Policy:\n"));
    console.log(`  ${chalk.dim("Version:")}   ${policy.version ?? "1.0"}`);
    console.log(`  ${chalk.dim("Preset:")}    ${policy.preset ?? chalk.dim("none")}`);
    console.log(`  ${chalk.dim("Dry-run:")}   ${policy.dryRun ? chalk.yellow("YES — no actions are blocked") : chalk.green("OFF")}`);
    if (policy.updatedAt) console.log(`  ${chalk.dim("Updated:")}   ${new Date(policy.updatedAt).toLocaleString()}`);

    if (policy.commands) {
      console.log(`\n  ${chalk.dim("Commands:")}`);
      if (policy.commands.deny?.length) console.log(`    deny: ${chalk.red(policy.commands.deny.slice(0, 3).join(" · "))}${policy.commands.deny.length > 3 ? " …" : ""}`);
      if (policy.commands.require_approval?.length) console.log(`    approval: ${chalk.yellow(policy.commands.require_approval.slice(0, 3).join(" · "))}${policy.commands.require_approval.length > 3 ? " …" : ""}`);
    }
    if (policy.paths) {
      console.log(`\n  ${chalk.dim("Paths:")}`);
      if (policy.paths.allow?.length) console.log(`    allow: ${chalk.green(policy.paths.allow.join(" · "))}`);
      if (policy.paths.deny?.length) console.log(`    deny: ${chalk.red(policy.paths.deny.slice(0, 3).join(" · "))}`);
    }
    if (policy.network) {
      console.log(`\n  ${chalk.dim("Network:")}`);
      if (policy.network.allow_domains?.length) console.log(`    allow: ${chalk.green(policy.network.allow_domains.slice(0, 4).join(" · "))}${policy.network.allow_domains.length > 4 ? " …" : ""}`);
      if (policy.network.deny_domains?.length) console.log(`    deny: ${chalk.red(policy.network.deny_domains.slice(0, 4).join(" · "))}`);
      console.log(`    http: ${policy.network.allow_http ? chalk.yellow("allowed") : chalk.green("HTTPS only")}`);
    }
    console.log("");
    return;
  }

  if (sub === "preset") {
    const preset = parts[2] as string;
    if (!preset || !PRESET_DESC[preset]) {
      console.log(chalk.cyan("\n  Available Presets:\n"));
      for (const [name, desc] of Object.entries(PRESET_DESC)) {
        console.log(`  ${chalk.white(name.padEnd(12))} ${chalk.dim(desc)}`);
      }
      console.log(chalk.dim("\n  Use: /policy preset <name>\n"));
      return;
    }
    const current = (ps as any).getCurrent?.() ?? { version: "1.0" };
    (ps as any).save?.({ ...current, version: current.version ?? "1.0", preset: preset as any, updatedAt: new Date().toISOString() });
    console.log(chalk.green(`  ✓ Policy preset set to "${preset}". Changes take effect on next agent run.\n`));
    return;
  }

  if (sub === "dryrun") {
    const toggle = parts[2]?.toLowerCase();
    const current = (ps as any).getCurrent?.() ?? { version: "1.0" };
    const newValue = toggle === "on" ? true : toggle === "off" ? false : !current.dryRun;
    (ps as any).save?.({ ...current, version: current.version ?? "1.0", dryRun: newValue, updatedAt: new Date().toISOString() });
    console.log(newValue
      ? chalk.yellow("  ⚠ Policy dry-run enabled — rules will evaluate but NOT block actions.\n")
      : chalk.green("  ✓ Policy dry-run disabled — rules are enforced.\n"));
    return;
  }

  if (sub === "test") {
    if (parts.length < 4) {
      console.log(chalk.red("  Usage: /policy test <type> <value>\n  Types: command file network model deploy tool\n"));
      return;
    }
    const type = parts[2] as any;
    const testValue = parts.slice(3).join(" ");
    const decision = (pe as any).dryRun?.({ type, value: testValue });
    if (!decision) { console.log(chalk.dim("  Policy engine does not support dry-run evaluation.\n")); return; }
    const icon = decision.allowed ? chalk.green("✓") : chalk.red("✗");
    const level = decision.level === "allow" ? chalk.green(decision.level)
      : decision.level === "deny" ? chalk.red(decision.level)
      : chalk.yellow(decision.level);
    console.log(chalk.cyan("\n  Policy dry-run result:\n"));
    console.log(`  ${icon} ${level} — ${chalk.dim(decision.reason)}`);
    if (decision.matchedRule) console.log(`     matched rule: ${chalk.dim(decision.matchedRule)}`);
    console.log("");
    return;
  }

  if (sub === "history") {
    const history: any[] = (ps as any).getHistory?.() ?? [];
    if (history.length === 0) {
      console.log(chalk.dim("\n  No policy history.\n"));
      return;
    }
    console.log(chalk.cyan(`\n  ${history.length} Policy Version(s):\n`));
    history.slice(-10).reverse().forEach((h: any, i: number) => {
      const ts = new Date(h.savedAt).toLocaleString();
      console.log(`  ${chalk.white(`[${i === 0 ? "current" : `v${history.length - i}`}]`)} ${chalk.dim(ts)} — preset: ${h.policy?.preset ?? "custom"}`);
    });
    console.log(chalk.dim("\n  Use: /policy rollback <n> to restore version n\n"));
    return;
  }

  if (sub === "rollback") {
    const v = parseInt(parts[2] ?? "", 10);
    if (isNaN(v)) { console.log(chalk.red("  Usage: /policy rollback <version-number>\n")); return; }
    try {
      (ps as any).rollback?.(v);
      console.log(chalk.green(`  ✓ Policy rolled back to version ${v}.\n`));
    } catch {
      console.log(chalk.red(`  Version ${v} not found in history.\n`));
    }
    return;
  }

  console.log(chalk.dim("\n  Usage: /policy [show|preset <name>|dryrun [on|off]|test <type> <value>|history|rollback <n>]\n"));
}

// ── /identity ────────────────────────────────────────────

function cmdIdentity(parts: string[], ctx: SlashCommandContext): void {
  const sub = parts[1]?.toLowerCase();
  const im = ctx.identityManager;

  if (!im) {
    console.log(chalk.dim("\n  Identity manager not initialized.\n"));
    return;
  }

  const ROLE_COLOR: Record<string, (s: string) => string> = {
    owner:     chalk.magenta,
    admin:     chalk.red,
    developer: chalk.green,
    viewer:    chalk.dim,
    ci:        chalk.cyan,
  };

  if (!sub || sub === "whoami") {
    const me = im.resolve();
    const roleColor = ROLE_COLOR[me.role] ?? chalk.white;
    console.log(chalk.cyan("\n  Current Identity:\n"));
    console.log(`  ${chalk.white(me.name)} ${chalk.dim(`[${me.id}]`)}`);
    console.log(`  Role: ${roleColor(me.role)}`);
    if (me.email) console.log(`  Email: ${chalk.dim(me.email)}`);
    if (me.budgetLimitUsd) console.log(`  Budget override: ${chalk.dim(`$${me.budgetLimitUsd}`)}`);
    console.log(`  Can execute tools: ${im.canExecuteTools(me) ? chalk.green("yes") : chalk.red("no (viewer)")}`);
    console.log(`  Can approve: ${im.canApprove(me) ? chalk.green("yes") : chalk.dim("no")}`);
    console.log("");
    return;
  }

  if (sub === "list") {
    const identities = im.list();
    if (identities.length === 0) {
      console.log(chalk.dim("\n  No identities. Run /identity create to add one.\n"));
      return;
    }
    console.log(chalk.cyan(`\n  ${identities.length} Identity(ies):\n`));
    for (const id of identities) {
      const roleColor = ROLE_COLOR[id.role] ?? chalk.white;
      const last = id.lastActiveAt ? new Date(id.lastActiveAt).toLocaleDateString() : "never";
      console.log(`  ${roleColor(`[${id.role}]`)} ${chalk.white(id.name)} ${chalk.dim(`— last active: ${last}`)}`);
      if (id.email) console.log(`     ${chalk.dim(id.email)}`);
    }
    console.log("");
    return;
  }

  if (sub === "create") {
    const name = parts[2];
    const role = (parts[3] ?? "developer") as any;
    if (!name) { console.log(chalk.red("  Usage: /identity create <name> [role]\n")); return; }
    const identity = im.create({ name, role });
    console.log(chalk.green(`  ✓ Created identity "${identity.name}" [${identity.role}] — id: ${identity.id}\n`));
    return;
  }

  if (sub === "role") {
    const id = parts[2];
    const role = parts[3] as any;
    if (!id || !role) { console.log(chalk.red("  Usage: /identity role <id> <role>\n")); return; }
    const updated = im.update(id, { role });
    if (updated) {
      console.log(chalk.green(`  ✓ Role updated: ${updated.name} → ${role}\n`));
    } else {
      console.log(chalk.red(`  Identity "${id}" not found.\n`));
    }
    return;
  }

  console.log(chalk.dim("\n  Usage: /identity [whoami|list|create <name> [role]|role <id> <role>]\n"));
  console.log(chalk.dim("  Roles: owner · admin · developer · viewer · ci\n"));
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

function cmdBudget(parts: string[], ctx: SlashCommandContext): void {
  const sub = parts[1]?.toLowerCase();

  // Enhanced dashboard when BudgetStore is available
  if (ctx.budgetStore && (!sub || sub === "show")) {
    const budgets = ctx.budgetStore.list();
    const reservations = ctx.budgetStore.getReservations?.() ?? [];
    console.log(chalk.cyan("\n  Budget Dashboard:\n"));
    if (budgets.length === 0) {
      console.log(chalk.dim("  No budget scopes configured.\n"));
    } else {
      for (const b of budgets) {
        const pct = b.limitUsd < Infinity ? b.spentUsd / b.limitUsd : 0;
        const pctStr = b.limitUsd < Infinity ? `${(pct * 100).toFixed(1)}%` : "—";
        const remaining = b.limitUsd < Infinity ? `$${(b.limitUsd - b.spentUsd).toFixed(4)} left` : "unlimited";
        const filled = b.limitUsd < Infinity ? Math.round(pct * 16) : 0;
        const bar = "█".repeat(Math.min(filled, 16)) + "░".repeat(Math.max(0, 16 - filled));
        const barColor = pct > 0.9 ? chalk.red : pct > 0.7 ? chalk.yellow : chalk.green;
        console.log(`  ${chalk.white(`${b.scope}:${b.scopeId}`.padEnd(24))} ${barColor(bar)} ${pctStr.padStart(6)}`);
        console.log(`     $${b.spentUsd.toFixed(4)} / $${b.limitUsd === Infinity ? "∞" : b.limitUsd.toFixed(2)} — ${remaining} — ${b.period}`);
      }
    }
    if (reservations.length > 0) {
      const totalReserved = reservations.reduce((s, r) => s + r.amountUsd, 0);
      console.log(chalk.dim(`\n  Active reservations: ${reservations.length} ($${totalReserved.toFixed(4)} held)\n`));
    } else {
      console.log("");
    }
    return;
  }

  // History subcommand
  if (sub === "history" && ctx.budgetHistory) {
    const scope = (parts[2] ?? "session") as any;
    const scopeId = parts[3] ?? "current";
    const history = ctx.budgetHistory.getHistory(scope, scopeId, Date.now() - 86400_000);
    if (history.length === 0) {
      console.log(chalk.dim(`\n  No budget history for ${scope}:${scopeId} in the last 24h.\n`));
      return;
    }
    console.log(chalk.cyan(`\n  Budget History — ${scope}:${scopeId} (last 24h):\n`));
    let total = 0;
    for (const e of history.slice(-20)) {
      total += e.amountUsd;
      const ts = new Date(e.timestamp).toLocaleTimeString();
      const model = e.model ? chalk.dim(` [${e.model}]`) : "";
      console.log(`  ${chalk.dim(ts)} ${chalk.white(`$${e.amountUsd.toFixed(4)}`)}${model} ${chalk.dim(e.action)}`);
    }
    console.log(chalk.dim(`\n  Total (shown): $${total.toFixed(4)}\n`));
    return;
  }

  // Fallback: simple session view
  const spent = parseFloat(process.env["NEXUS_SPENT_USD"] ?? "0");
  const pct = ((spent / BUDGET_USD) * 100).toFixed(1);
  const filled = Math.round((spent / BUDGET_USD) * 20);
  const bar = "█".repeat(Math.min(filled, 20)) + "░".repeat(Math.max(0, 20 - filled));
  console.log(chalk.cyan("\n  Session Budget:\n"));
  console.log(`  ${chalk.white(`$${spent.toFixed(4)}`)} / ${chalk.white(`$${BUDGET_USD.toFixed(2)}`)}  ${pct}%`);
  console.log(`  ${chalk.green(bar)}\n`);
  if (ctx.budgetStore || ctx.budgetHistory) {
    console.log(chalk.dim("  Use /budget show for full dashboard, /budget history for spending history.\n"));
  }
}

// ── /audit ───────────────────────────────────────────────

function cmdAudit(parts: string[], ctx: SlashCommandContext): void {
  const sub = parts[1]?.toLowerCase();

  const severityColor: Record<string, (s: string) => string> = {
    info: chalk.dim,
    warning: chalk.yellow,
    critical: chalk.red,
    blocked: chalk.bgRed.white,
  };

  // /audit search <query>
  if (sub === "search") {
    const query = parts.slice(2).join(" ");
    if (!query) { console.log(chalk.red("  Usage: /audit search <query>\n")); return; }
    // Try DB search first
    const results = (ctx.auditLogger as any).search?.({ query, limit: 20 }) as any[] ?? ctx.auditLogger.getRecent(100).filter((e) => JSON.stringify(e).toLowerCase().includes(query.toLowerCase()));
    if (results.length === 0) {
      console.log(chalk.dim(`\n  No audit entries matching "${query}".\n`));
      return;
    }
    console.log(chalk.cyan(`\n  ${results.length} result(s) for "${query}":\n`));
    for (const e of results.slice(0, 20)) {
      const colorFn = severityColor[e.severity] ?? chalk.white;
      const ts = e.timestamp.slice(0, 19).replace("T", " ");
      console.log(`  ${chalk.dim(ts)} ${colorFn(`[${e.severity}]`)} ${chalk.white(e.action)}`);
      if (e.details?.resultPreview) console.log(`     ${chalk.dim(String(e.details.resultPreview).slice(0, 80))}`);
    }
    console.log("");
    return;
  }

  // /audit stats
  if (sub === "stats") {
    const stats = (ctx.auditLogger as any).getStats?.();
    if (!stats) {
      console.log(chalk.dim("\n  Audit stats require SQLite persistence (AuditDB).\n"));
      return;
    }
    console.log(chalk.cyan("\n  Audit Stats:\n"));
    console.log(chalk.dim(`  Total entries: ${stats.total}`));
    if (stats.byCategory) {
      console.log(chalk.dim("  By category:"));
      for (const [cat, n] of Object.entries(stats.byCategory)) {
        console.log(chalk.dim(`    ${cat.padEnd(12)} ${n}`));
      }
    }
    if (stats.bySeverity) {
      console.log(chalk.dim("  By severity:"));
      for (const [sev, n] of Object.entries(stats.bySeverity)) {
        const color = severityColor[sev] ?? chalk.dim;
        console.log(`    ${color(sev.padEnd(10))} ${chalk.dim(String(n))}`);
      }
    }
    if (stats.oldestEntry) console.log(chalk.dim(`  Oldest: ${stats.oldestEntry}`));
    if (stats.newestEntry) console.log(chalk.dim(`  Newest: ${stats.newestEntry}`));
    console.log("");
    return;
  }

  // Default: show recent
  const count = sub && !isNaN(parseInt(sub)) ? parseInt(sub) : 20;
  const entries = ctx.auditLogger.getRecent(count);
  if (entries.length === 0) {
    console.log(chalk.dim("\n  No audit entries yet.\n"));
    return;
  }
  console.log(chalk.cyan(`\n  Last ${Math.min(entries.length, count)} Audit Entries:\n`));
  for (const e of entries.slice(-count)) {
    const colorFn = severityColor[e.severity] ?? chalk.white;
    const ts = e.timestamp.slice(11, 19);
    console.log(`  ${chalk.dim(ts)} ${colorFn(`[${e.severity}]`)} ${chalk.white(e.action)}`);
    if (e.details?.resultPreview) console.log(`     ${chalk.dim(String(e.details.resultPreview).slice(0, 80))}`);
  }
  console.log(chalk.dim("\n  Subcommands: /audit search <query> | /audit stats | /audit <n>\n"));
  console.log("");
}

// ── /memory ──────────────────────────────────────────────

function cmdMemory(ctx: SlashCommandContext): void {
  if (!ctx.memoryManager) {
    console.log(chalk.yellow("\n  Memory manager not available"));
    return;
  }

  const stats = ctx.memoryManager.getStats();
  console.log(chalk.cyan("\n  Memory Store Stats"));
  console.log(chalk.dim(`  Semantic facts: ${stats.semanticFacts}`));
  console.log(chalk.dim(`  Episodic records: ${stats.episodicRecords}`));
  console.log(chalk.dim(`  Outcomes: ${stats.episodicOutcomes.successes} success, ${stats.episodicOutcomes.failures} failure, ${stats.episodicOutcomes.partials} partial`));
  console.log(chalk.dim(`  Store location:   ${join(NEXUS_HOME, "memory")}\n`));
}

// ── /sandbox ─────────────────────────────────────────────

async function cmdSandbox(parts: string[], ctx: SlashCommandContext): Promise<void> {
  const sub = parts[1]?.toLowerCase();

  const STATE_COLOR: Record<string, (s: string) => string> = {
    running:  chalk.green,
    creating: chalk.cyan,
    paused:   chalk.yellow,
    stopped:  chalk.dim,
    error:    chalk.red,
    destroyed: chalk.dim,
  };
  const HEALTH_COLOR: Record<string, (s: string) => string> = {
    healthy:   chalk.green,
    degraded:  chalk.yellow,
    unhealthy: chalk.red,
    unknown:   chalk.dim,
  };

  const manager = ctx.sandboxManager;

  // ── /sandbox status ───────────────────────────────────
  if (!sub || sub === "status" || sub === "list") {
    const dockerAvailable = (() => {
      try {
        const { execSync } = require("node:child_process");
        execSync("docker info", { stdio: "ignore", timeout: 2000 });
        return true;
      } catch { return false; }
    })();

    const e2bAvailable = Boolean(process.env["E2B_API_KEY"]);
    const sshAvailable = Boolean(process.env["NEXUS_SSH_HOST"]);

    console.log(chalk.cyan("\n  Sandbox System:\n"));
    console.log(`  ${chalk.dim("Backends:")} `);
    console.log(`    ${dockerAvailable ? chalk.green("●") : chalk.dim("○")} Docker  ${dockerAvailable ? chalk.green("available") : chalk.dim("not running")}`);
    console.log(`    ${sshAvailable ? chalk.green("●") : chalk.dim("○")} SSH     ${sshAvailable ? chalk.green(process.env["NEXUS_SSH_HOST"]!) : chalk.dim("NEXUS_SSH_HOST not set")}`);
    console.log(`    ${e2bAvailable ? chalk.green("●") : chalk.dim("○")} E2B     ${e2bAvailable ? chalk.green("API key set") : chalk.dim("E2B_API_KEY not set")}`);
    console.log(`    ${chalk.green("●")} Local   ${chalk.green("always available")}`);

    if (manager) {
      const sandboxes = manager.list();
      console.log(`\n  ${chalk.dim("Active sandboxes:")} ${sandboxes.length}`);
      for (const s of sandboxes) {
        const stColor = STATE_COLOR[s.state] ?? chalk.white;
        const age = Math.round((Date.now() - s.createdAt) / 1000);
        const ttl = s.expiresAt ? `TTL: ${Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000))}s` : "no TTL";
        console.log(`    ${stColor(`[${s.state}]`)} ${chalk.white(s.taskId)} ${chalk.dim(`${s.backendType} · age: ${age}s · ${ttl}`)}`);
        console.log(`       workdir: ${chalk.dim(s.workdir)}  id: ${chalk.dim(s.backendId.slice(0, 16))}...`);
      }
    } else {
      console.log(chalk.dim("\n  SandboxManager not initialized (set NEXUS_SANDBOX=docker or configure a backend).\n"));
    }
    console.log(chalk.dim("\n  Subcommands: status · acquire · exec · health · logs · extract · release · cleanup\n"));
    return;
  }

  // ── /sandbox acquire <taskId> [backend] ───────────────
  if (sub === "acquire") {
    const taskId = parts[2];
    const backend = (parts[3] as any) || undefined;
    if (!taskId) { console.log(chalk.red("  Usage: /sandbox acquire <taskId> [backend]\n")); return; }
    if (!manager) { console.log(chalk.dim("  SandboxManager not initialized.\n")); return; }

    console.log(chalk.dim(`\n  Acquiring sandbox for task "${taskId}"...`));
    try {
      const handle = await manager.acquire(taskId, backend ? { backendType: backend } : undefined);
      const stColor = STATE_COLOR[handle.state] ?? chalk.white;
      console.log(chalk.green(`  ✓ Sandbox ready:`));
      console.log(`    ${chalk.dim("ID:")}      ${handle.id}`);
      console.log(`    ${chalk.dim("Backend:")} ${stColor(handle.backendType)}`);
      console.log(`    ${chalk.dim("State:")}   ${stColor(handle.state)}`);
      console.log(`    ${chalk.dim("Workdir:")} ${handle.workdir}`);
      if (handle.localWorkdir) console.log(`    ${chalk.dim("Local:")}   ${handle.localWorkdir}`);
      console.log("");
    } catch (err: any) {
      console.log(chalk.red(`  ✗ Failed to acquire sandbox: ${err.message}\n`));
    }
    return;
  }

  // ── /sandbox exec <taskId> <command> ──────────────────
  if (sub === "exec") {
    const taskId = parts[2];
    const command = parts.slice(3).join(" ");
    if (!taskId || !command) { console.log(chalk.red("  Usage: /sandbox exec <taskId> <command>\n")); return; }
    if (!manager) { console.log(chalk.dim("  SandboxManager not initialized.\n")); return; }

    try {
      const result = await manager.exec(taskId, command);
      if (result.stdout) console.log(chalk.dim("\n  stdout:\n") + result.stdout);
      if (result.stderr) console.log(chalk.yellow("\n  stderr:\n") + result.stderr);
      const exitColor = result.exitCode === 0 ? chalk.green : chalk.red;
      console.log(exitColor(`\n  Exit: ${result.exitCode}`) + chalk.dim(` (${result.durationMs}ms)\n`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}\n`));
    }
    return;
  }

  // ── /sandbox health <taskId> ──────────────────────────
  if (sub === "health") {
    const taskId = parts[2];
    if (!taskId) { console.log(chalk.red("  Usage: /sandbox health <taskId>\n")); return; }
    if (!manager) { console.log(chalk.dim("  SandboxManager not initialized.\n")); return; }

    const result = await manager.healthCheck(taskId);
    const hColor = HEALTH_COLOR[result.health] ?? chalk.white;
    console.log(`\n  Health: ${hColor(result.health)} ${chalk.dim(`(${result.latencyMs}ms)`)}`);
    if (result.message) console.log(`  ${chalk.dim(result.message)}`);
    console.log("");
    return;
  }

  // ── /sandbox extract <taskId> <patterns...> ───────────
  if (sub === "extract") {
    const taskId = parts[2];
    const patterns = parts.slice(3);
    if (!taskId || patterns.length === 0) {
      console.log(chalk.red("  Usage: /sandbox extract <taskId> <pattern> [pattern...]\n"));
      return;
    }
    if (!manager) { console.log(chalk.dim("  SandboxManager not initialized.\n")); return; }

    console.log(chalk.dim(`\n  Extracting artifacts from "${taskId}"...`));
    try {
      const artifacts = await manager.extractArtifacts(taskId, patterns);
      if (artifacts.length === 0) {
        console.log(chalk.dim("  No files matched.\n"));
      } else {
        console.log(chalk.green(`  ✓ ${artifacts.length} artifact(s) extracted:\n`));
        for (const a of artifacts) {
          const sizeKb = (a.sizeBytes / 1024).toFixed(1);
          console.log(`    ${chalk.white(a.sandboxPath)} → ${chalk.dim(a.localPath)} (${sizeKb}KB)`);
        }
        console.log("");
      }
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}\n`));
    }
    return;
  }

  // ── /sandbox release <taskId> ─────────────────────────
  if (sub === "release" || sub === "destroy") {
    const taskId = parts[2];
    if (!taskId) { console.log(chalk.red(`  Usage: /sandbox ${sub} <taskId>\n`)); return; }
    if (!manager) { console.log(chalk.dim("  SandboxManager not initialized.\n")); return; }

    try {
      await manager.release(taskId);
      console.log(chalk.green(`  ✓ Sandbox for "${taskId}" released.\n`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}\n`));
    }
    return;
  }

  // ── /sandbox cleanup ──────────────────────────────────
  if (sub === "cleanup") {
    if (!manager) { console.log(chalk.dim("  SandboxManager not initialized.\n")); return; }
    const count = manager.list().length;
    await manager.destroyAll();
    console.log(chalk.green(`  ✓ Destroyed ${count} sandbox(es).\n`));
    return;
  }

  console.log(chalk.dim("\n  Usage: /sandbox [status|acquire|exec|health|extract|release|cleanup]\n"));
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
      cmdBudget(parts, ctx);
      return true;

    case "/audit":
      cmdAudit(parts, ctx);
      return true;

    case "/approvals":
    case "/approval":
      await cmdApprovals(parts, ctx);
      return true;

    case "/policy":
      await cmdPolicy(parts, ctx);
      return true;

    case "/identity":
    case "/whoami":
      cmdIdentity(parts, ctx);
      return true;

    case "/memory":
      cmdMemory(ctx);
      return true;

    case "/sandbox":
      await cmdSandbox(parts, ctx);
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
      // Check if this is an explicit skill activation (e.g., /skill-name)
      const skillName = cmd.slice(1).toLowerCase();
      const allSkills = ctx.skillStore.getAll({ status: "trusted" });
      const skill = allSkills.find((s) => s.name.toLowerCase() === skillName || s.triggers.includes(skillName));
      if (skill) {
        // Pass through to agent-runner for explicit skill activation
        return false;
      }
      console.log(chalk.red(`  Unknown command: ${cmd}\n`));
      return true;
  }
}
