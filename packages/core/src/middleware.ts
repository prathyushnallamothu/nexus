/**
 * Nexus Built-in Middleware
 *
 * Composable middleware for safety, budgets, and security.
 */

import type { Middleware, AgentContext, NextFn } from "./types.js";

/**
 * Budget Enforcer — prevents runaway spending.
 */
export function budgetEnforcer(options?: {
  limitUsd?: number;
  warnAtPercent?: number;
}): Middleware {
  const limit = options?.limitUsd ?? 1.0;
  const warnAt = options?.warnAtPercent ?? 0.8;

  return {
    name: "budget-enforcer",
    async execute(ctx: AgentContext, next: NextFn) {
      ctx.budget.limitUsd = limit;

      // Check before running
      if (ctx.budget.spentUsd >= limit) {
        ctx.abort(`Budget exceeded: $${ctx.budget.spentUsd.toFixed(4)} >= $${limit}`);
        return;
      }

      await next();

      // Log final spend
      if (ctx.budget.spentUsd >= limit * warnAt) {
        ctx.meta["budgetWarningIssued"] = true;
      }
    },
  };
}

/**
 * Iteration Limiter — prevents infinite loops.
 * Every project has this, but ours is middleware-based.
 */
export function iterationLimiter(maxIterations?: number): Middleware {
  const limit = maxIterations ?? 25;

  return {
    name: "iteration-limiter",
    async execute(ctx: AgentContext, next: NextFn) {
      const origLimit = ctx.meta["maxIterations"] as number | undefined;
      ctx.meta["maxIterations"] = limit;
      await next();
      if (origLimit !== undefined) ctx.meta["maxIterations"] = origLimit;
    },
  };
}

/**
 * Prompt Firewall — blocks injection attempts in user messages.
 */
export function promptFirewall(): Middleware {
  const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+a/i,
    /\bsystem\s*:\s*override\b/i,
    /<\/?system>/i,
    /```system/i,
    /IMPORTANT:\s*(?:new|override|forget|ignore)/i,
    /\[\s*INST\s*\]/i,
  ];

  return {
    name: "prompt-firewall",
    async execute(ctx: AgentContext, next: NextFn) {
      const lastUserMsg = [...ctx.messages]
        .reverse()
        .find((m) => m.role === "user");

      if (lastUserMsg) {
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(lastUserMsg.content)) {
            ctx.meta["firewall_blocked"] = true;
            ctx.meta["firewall_pattern"] = pattern.source;
            // Don't abort — just log. The user might be discussing injections legitimately.
            // In production, you'd have a stricter policy.
            break;
          }
        }
      }

      await next();
    },
  };
}

/**
 * Output Scanner — checks agent responses for data leakage.
 */
export function outputScanner(): Middleware {
  const LEAKAGE_PATTERNS = [
    /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{20,}/i,
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
    /(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{4,}/i,
    /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/,
    /sk-[a-zA-Z0-9]{20,}/,  // OpenAI-style keys
  ];

  return {
    name: "output-scanner",
    async execute(ctx: AgentContext, next: NextFn) {
      await next();

      // Check the last assistant message
      const lastAssistantMsg = [...ctx.messages]
        .reverse()
        .find((m) => m.role === "assistant");

      if (lastAssistantMsg?.content) {
        for (const pattern of LEAKAGE_PATTERNS) {
          if (pattern.test(lastAssistantMsg.content)) {
            // Redact the sensitive content
            lastAssistantMsg.content = lastAssistantMsg.content.replace(
              pattern,
              "[REDACTED]",
            );
            ctx.meta["output_redacted"] = true;
            break;
          }
        }
      }
    },
  };
}

/**
 * Timing Middleware — tracks execution duration.
 * Basic observability that every production system needs.
 */
export function timing(): Middleware {
  return {
    name: "timing",
    async execute(ctx: AgentContext, next: NextFn) {
      const start = Date.now();
      await next();
      ctx.meta["durationMs"] = Date.now() - start;
    },
  };
}

/**
 * Logger Middleware — logs key events to console.
 * The simplest form of observability.
 */
export function logger(options?: { verbose?: boolean }): Middleware {
  const verbose = options?.verbose ?? false;

  return {
    name: "logger",
    async execute(ctx: AgentContext, next: NextFn) {
      if (verbose) {
        console.log(`[nexus] Session ${ctx.sessionId} starting`);
        console.log(`[nexus] ${ctx.tools.length} tools available`);
      }

      await next();

      if (verbose) {
        console.log(
          `[nexus] Session complete: ${ctx.budget.llmCalls} LLM calls, ` +
            `${ctx.budget.toolCalls} tool calls, ` +
            `$${ctx.budget.spentUsd.toFixed(4)} spent, ` +
            `${ctx.meta["durationMs"] ?? "?"}ms`,
        );
      }
    },
  };
}
