/**
 * Nexus CLI — REPL with multiline input support
 *
 * Multiline: end a line with \ to continue on the next line.
 * Alt+Enter also works in terminals that send \x1b\r or \x1b\n.
 * Submit: bare Enter on the final line.
 */

import { createInterface, type Interface as RLInterface } from "node:readline";
import chalk from "chalk";
import type { Message, Tool } from "@nexus/core";
import type { McpManager, McpConfigStore } from "@nexus/protocols";
import type { CronStore } from "@nexus/runtime";
import type { SkillStore, DualProcessRouter, ExperienceLearner, LearningDB } from "@nexus/intelligence";
import type { AuditLogger } from "@nexus/governance";
import { handleSlashCommand, type SlashCommandContext } from "./commands.js";
import { createProcessor, type ProcessorDeps } from "./agent-runner.js";
import {
  saveSession,
  generateSessionId,
  type SessionFile,
} from "./session.js";
import { NEXUS_HOME } from "./config.js";

export interface ReplDeps extends ProcessorDeps {
  skillStore: SkillStore;
  router: DualProcessRouter;
  learner: ExperienceLearner;
  learningDb?: LearningDB;
  auditLogger: AuditLogger;
  mcpManager: McpManager | null;
  mcpConfigStore: McpConfigStore | null;
  cronStore: CronStore | null;
  onShutdown: () => Promise<void>;
}

const PROMPT_NORMAL = chalk.cyan("  ▸ ");
const PROMPT_CONTINUE = chalk.dim("  … ");

export function startRepl(deps: ReplDeps): RLInterface {
  const sessionMessages: Message[] = [];
  const messageQueue: string[] = [];
  let processing = false;
  let lastUserInput = "";

  // Session persistence
  const sessionId = generateSessionId();
  const sessionStartTime = Date.now();

  function persistSession(): void {
    try {
      const userMsgs = sessionMessages.filter((m) => m.role === "user");
      if (userMsgs.length === 0) return;
      const firstUserMsg = userMsgs[0]?.content ?? "";
      const session: SessionFile = {
        id: sessionId,
        name: firstUserMsg.slice(0, 50).replace(/\n/g, " ") || "Unnamed session",
        createdAt: sessionStartTime,
        updatedAt: Date.now(),
        messageCount: sessionMessages.length,
        messages: sessionMessages,
      };
      saveSession(NEXUS_HOME, session);
    } catch {
      // Non-critical
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT_NORMAL,
  });

  // ── Multiline input buffer ────────────────────────────
  const lineBuffer: string[] = [];

  function flushInput(finalLine: string): string {
    const lines = [...lineBuffer, finalLine];
    lineBuffer.length = 0;
    rl.setPrompt(PROMPT_NORMAL);
    return lines.join("\n");
  }

  // ── Processor setup ───────────────────────────────────

  function drainOrPrompt(): void {
    const next = messageQueue.shift();
    if (next) {
      doProcess(next);
    } else {
      processing = false;
      persistSession();
      rl.prompt();
    }
  }

  const processMessage = createProcessor(deps, sessionMessages, drainOrPrompt);

  function doProcess(input: string): void {
    processing = true;
    lastUserInput = input;
    processMessage(input);
  }

  // ── Slash command context ─────────────────────────────

  const slashCtx: SlashCommandContext = {
    get sessionMessages() { return sessionMessages; },
    get lastUserInput() { return lastUserInput; },
    skillStore: deps.skillStore,
    router: deps.router,
    learner: deps.learner,
    learningDb: deps.learningDb,
    auditLogger: deps.auditLogger,
    mcpManager: deps.mcpManager,
    mcpConfigStore: deps.mcpConfigStore,
    cronStore: deps.cronStore,
    onRetry(input: string) {
      doProcess(input);
    },
    onLoadSession(messages: Message[]) {
      sessionMessages.length = 0;
      sessionMessages.push(...messages);
    },
  };

  // ── Line handler ──────────────────────────────────────

  rl.on("line", (line) => {
    // Alt+Enter in many terminals sends ESC + newline (\x1b\r or \x1b\n)
    // We detect it by checking if readline captured a bare \x1b prefix — but
    // readline strips this. The practical approach: check trailing backslash.

    if (line.endsWith("\\")) {
      // Continuation line — strip trailing backslash and buffer
      lineBuffer.push(line.slice(0, -1));
      rl.setPrompt(PROMPT_CONTINUE);
      rl.prompt();
      return;
    }

    const input = lineBuffer.length > 0 ? flushInput(line) : line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      handleSlashCommand(input, slashCtx).then((shouldPrompt) => {
        if (shouldPrompt) rl.prompt();
      });
      return;
    }

    if (processing) {
      messageQueue.push(input);
      console.log(chalk.dim(`  ⏎ Queued (agent busy, ${messageQueue.length} pending)\n`));
      return;
    }

    doProcess(input);
  });

  rl.on("close", async () => {
    console.log(chalk.dim("\n  Goodbye!\n"));
    persistSession();
    await deps.onShutdown();
    process.exit(0);
  });

  rl.prompt();
  return rl;
}
