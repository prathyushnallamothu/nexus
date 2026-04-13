/**
 * Nexus CLI — Event handling & spinner
 */

import chalk from "chalk";
import type { AgentEvent } from "@nexus/core";
import type { AuditLogger, BehavioralMonitor } from "@nexus/governance";

// ── Spinner ───────────────────────────────────────────────

export let currentSpinner: { stop: () => void } | null = null;

export function startSpinner(text: string): { stop: () => void } {
  process.stderr.write(chalk.dim(`  ${text}\n`));
  return { stop: () => {} };
}

export function stopSpinner(text: string, ok = true): void {
  const icon = ok ? chalk.green("✔") : chalk.red("✖");
  process.stderr.write(`  ${icon} ${chalk.dim(text)}\n`);
  currentSpinner = null;
}

// ── Core event handler ────────────────────────────────────

export function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "llm.call.start":
      currentSpinner = startSpinner("Thinking...");
      break;

    case "llm.call.end":
      stopSpinner(
        `${event.tokensIn + event.tokensOut} tokens · $${event.costUsd.toFixed(4)} · ${event.durationMs}ms`,
        true,
      );
      break;

    case "tool.call.start":
      currentSpinner = startSpinner(`⚡ ${event.toolName}`);
      break;

    case "tool.call.end":
      stopSpinner(`${event.toolName} (${event.durationMs}ms)`, !event.isError);
      break;

    case "budget.warning":
      console.log(
        chalk.yellow(`\n⚠ Budget warning: $${event.spentUsd.toFixed(4)} / $${event.limitUsd.toFixed(2)}`),
      );
      break;

    case "budget.exceeded":
      console.log(chalk.red("\n✗ Budget exceeded. Stopping."));
      break;

    case "context.compressed":
      console.log(
        chalk.dim(
          `  📦 Context compressed: ${event.messagesRemoved} messages, ` +
          `${event.beforeTokens} → ${event.afterTokens} tokens`,
        ),
      );
      break;

    case "error":
      console.log(chalk.red(`\nError: ${event.error}`));
      break;
  }
}

// ── Combined event handler factory ───────────────────────

export function createCombinedHandler(
  auditLogger: AuditLogger,
  monitor: BehavioralMonitor,
): (event: AgentEvent) => void {
  const auditHandler = auditLogger.createEventHandler();
  const monitorHandler = monitor.createEventHandler();

  return (event: AgentEvent) => {
    auditHandler(event);
    monitorHandler(event);
    handleEvent(event);
  };
}
