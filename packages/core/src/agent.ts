/**
 * Nexus Agent — The Core Agent Loop (Hardened)
 *
 * Production-grade agent loop with:
 *   - Retry with exponential backoff on provider errors
 *   - Parallel tool execution for independent tool calls
 *   - Context compression when approaching token limits
 *   - Graceful SIGINT handling
 *   - Budget tracking down to $0.0001
 */

import type {
  AgentConfig,
  AgentContext,
  AgentEvent,
  AgentRunResult,
  BudgetState,
  EventHandler,
  LLMProvider,
  LLMResponse,
  Message,
  Middleware,
  Tool,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "./types.js";
import {
  compressContext,
  estimateTokens,
  COMPRESSION_THRESHOLD,
  MIN_RECENT_MESSAGES,
} from "./compressor.js";

// ── Retry Configuration ───────────────────────────────────

interface RetryConfig {
  /** Max number of retry attempts */
  maxAttempts: number;
  /** Base delay in ms (doubled each retry) */
  baseDelayMs: number;
  /** Max delay cap in ms */
  maxDelayMs: number;
  /** HTTP status codes that trigger retry */
  retryableStatuses: number[];
  /** Error message patterns that trigger retry */
  retryablePatterns: RegExp[];
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableStatuses: [429, 500, 502, 503, 529],
  retryablePatterns: [
    /rate\s*limit/i,
    /too\s*many\s*requests/i,
    /overloaded/i,
    /capacity/i,
    /timeout/i,
    /ECONNRESET/,
    /ETIMEDOUT/,
    /ENOTFOUND/,
    /fetch failed/i,
  ],
};

// COMPRESSION_THRESHOLD and MIN_RECENT_MESSAGES imported from compressor.ts

// ── Agent ─────────────────────────────────────────────────

export interface NexusAgentOptions {
  config: AgentConfig;
  provider: LLMProvider;
  onEvent?: EventHandler;
  retry?: Partial<RetryConfig>;
}

export class NexusAgent {
  private config: AgentConfig;
  private provider: LLMProvider;
  private eventHandlers: EventHandler[] = [];
  private retryConfig: RetryConfig;
  private abortController: AbortController | null = null;
  /** Set by interrupt() — queued redirect message to surface in run() result */
  private _redirectMessage: string | null = null;

  constructor(options: NexusAgentOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.retryConfig = { ...DEFAULT_RETRY, ...options.retry };
    if (options.onEvent) {
      this.eventHandlers.push(options.onEvent);
    }
  }

  /**
   * Interrupt an in-flight run.
   *
   * Aborts the current agent loop via AbortController and optionally queues
   * a redirect message that the caller should use to re-run the agent.
   * Safe to call even when no run is active (no-op).
   */
  interrupt(redirectMessage?: string): void {
    this._redirectMessage = redirectMessage ?? null;
    this.abortController?.abort();
    this.emit({
      type: "agent.interrupted",
      redirectMessage: this._redirectMessage,
      timestamp: Date.now(),
    });
  }

  /** Subscribe to agent events */
  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  /** Emit an event to all handlers */
  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Event handlers should never crash the agent
      }
    }
  }

  /**
   * Run a full conversation turn.
   * Takes a user message, runs the agent loop until the LLM
   * produces a text response (no more tool calls) or budget is exhausted.
   */
  async run(
    userMessage: string,
    sessionMessages: Message[] = [],
  ): Promise<AgentRunResult> {
    const sessionId = `session_${Date.now()}`;

    // Reset interrupt state from any prior interrupt() call
    this._redirectMessage = null;

    // Set up SIGINT handling for graceful abort
    this.abortController = new AbortController();
    const sigintHandler = () => {
      this.abortController?.abort();
    };
    process.on("SIGINT", sigintHandler);

    try {
      // Build initial context
      const ctx: AgentContext = {
        sessionId,
        messages: [
          { role: "system", content: this.config.systemPrompt },
          ...sessionMessages,
          { role: "user", content: userMessage },
        ],
        tools: [...this.config.tools],
        toolSchemas: this.config.tools.map((t) => t.schema),
        systemPrompt: this.config.systemPrompt,
        iteration: 0,
        budget: {
          limitUsd: 1.0,
          spentUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          llmCalls: 0,
          toolCalls: 0,
        },
        meta: {},
        shouldStop: false,
        abort: (reason: string) => {
          ctx.shouldStop = true;
          ctx.meta["abortReason"] = reason;
        },
        redirect: (newMessage: string) => {
          ctx.shouldStop = true;
          ctx.meta["redirect"] = newMessage;
          ctx.meta["abortReason"] = "redirected";
        },
        artifacts: [],
      };

      this.emit({ type: "session.start", sessionId, timestamp: Date.now() });
      this.emit({
        type: "message.user",
        message: { role: "user", content: userMessage },
        timestamp: Date.now(),
      });

      // Build the middleware chain (onion model)
      const middlewareChain = this.buildMiddlewareChain(
        this.config.middleware,
        () => this.agentLoop(ctx),
      );

      // Execute: middleware wraps the agent loop
      await middlewareChain(ctx);

      // Extract final assistant response
      const reversed = [...ctx.messages].reverse();
      const lastPureText = reversed.find(
        (m) => m.role === "assistant" && m.content && !m.toolCalls?.length,
      );
      const lastAnyText = reversed.find(
        (m) => m.role === "assistant" && m.content,
      );
      const lastAssistantMsg = lastPureText ?? lastAnyText;

      const response = lastAssistantMsg?.content ?? "(no response)";

      this.emit({
        type: "session.end",
        reason: (ctx.meta["abortReason"] as string) ?? "completed",
        timestamp: Date.now(),
      });

      // Prefer ctx.redirect() over interrupt() redirect (ctx is more specific)
      const redirectMsg =
        (ctx.meta["redirect"] as string | undefined) ??
        this._redirectMessage ??
        undefined;

      return {
        messages: ctx.messages,
        response,
        budget: ctx.budget,
        redirect: redirectMsg,
        artifacts: ctx.artifacts,
        hitIterationLimit: ctx.meta["hitIterationLimit"] === true,
      };
    } finally {
      // Clean up SIGINT handler
      process.removeListener("SIGINT", sigintHandler);
      this.abortController = null;
    }
  }

  /**
   * The core agent loop — iterate until done or budget exhausted.
   *
   * Production hardening:
   *   - Retry with exponential backoff on transient errors
   *   - Parallel tool execution for independent calls
   *   - Context compression when nearing token limits
   *   - SIGINT-aware abort
   */
  private async agentLoop(ctx: AgentContext): Promise<void> {
    const startIteration = ctx.iteration;
    while (ctx.iteration < this.config.maxIterations && !ctx.shouldStop) {
      ctx.iteration++;

      // Check for SIGINT abort
      if (this.abortController?.signal.aborted) {
        ctx.abort("User interrupted (SIGINT)");
        break;
      }

      // Budget check
      if (ctx.budget.spentUsd >= ctx.budget.limitUsd) {
        this.emit({
          type: "budget.exceeded",
          spentUsd: ctx.budget.spentUsd,
          limitUsd: ctx.budget.limitUsd,
          timestamp: Date.now(),
        });
        ctx.abort("Budget exceeded");
        break;
      }

      // Context compression check — compress if approaching token limit
      await this.compressContextIfNeeded(ctx);

      // Call the LLM with retry
      this.emit({
        type: "llm.call.start",
        model: this.config.model,
        tokenEstimate: this.estimateTokens(ctx.messages),
        timestamp: Date.now(),
      });

      const startTime = Date.now();
      let response: LLMResponse;

      try {
        response = await this.callWithRetry(ctx);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.emit({ type: "error", error: errMsg, timestamp: Date.now() });
        ctx.abort(`LLM error after ${this.retryConfig.maxAttempts} attempts: ${errMsg}`);
        break;
      }

      const durationMs = Date.now() - startTime;

      // Update budget
      ctx.budget.tokensIn += response.usage.inputTokens;
      ctx.budget.tokensOut += response.usage.outputTokens;
      ctx.budget.spentUsd += response.usage.costUsd;
      ctx.budget.llmCalls++;

      this.emit({
        type: "llm.call.end",
        model: this.config.model,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        costUsd: response.usage.costUsd,
        durationMs,
        timestamp: Date.now(),
      });

      // If no tool calls, we're done — LLM produced a final response
      if (!response.toolCalls || response.toolCalls.length === 0) {
        const assistantMsg: Message = {
          role: "assistant",
          content: response.content,
        };
        ctx.messages.push(assistantMsg);
        this.emit({
          type: "message.assistant",
          message: assistantMsg,
          timestamp: Date.now(),
        });
        break;
      }

      // LLM wants to call tools
      const assistantMsg: Message = {
        role: "assistant",
        content: response.content || "",
        toolCalls: response.toolCalls,
      };
      ctx.messages.push(assistantMsg);

      // Dispatch tool calls — in parallel when possible
      const toolResults = await this.dispatchToolsParallel(
        ctx,
        response.toolCalls,
      );

      // Add tool results to messages
      for (const result of toolResults) {
        ctx.messages.push({
          role: "tool",
          content: result.content,
          toolCallId: result.toolCallId,
          name: result.name,
        });
      }

      // Budget warning at 80%
      if (
        ctx.budget.spentUsd >= ctx.budget.limitUsd * 0.8 &&
        !ctx.meta["budgetWarned"]
      ) {
        ctx.meta["budgetWarned"] = true;
        this.emit({
          type: "budget.warning",
          spentUsd: ctx.budget.spentUsd,
          limitUsd: ctx.budget.limitUsd,
          timestamp: Date.now(),
        });
      }
    }

    // If we exited because maxIterations was hit (not due to shouldStop/abort),
    // run recovery: ask the agent to summarize partial work.
    if (!ctx.shouldStop && ctx.iteration >= this.config.maxIterations) {
      await this.iterationLimitRecovery(ctx);
    }
  }

  /**
   * Iteration-limit recovery.
   *
   * Instead of silently stopping, we inject a recovery prompt (tool-free) so
   * the agent can summarize:
   *   1. What was accomplished
   *   2. What remains
   *   3. Key state the caller needs to continue
   *
   * The summary becomes the final response text and is surfaced in the
   * `iteration.limit` event so the UI can display it and offer continuation.
   */
  private async iterationLimitRecovery(ctx: AgentContext): Promise<void> {
    ctx.meta["hitIterationLimit"] = true;
    const fallback =
      `Reached iteration limit (${ctx.iteration}/${this.config.maxIterations}). ` +
      `Recovery summary unavailable. Last tool calls are in the message history.`;

    const recoveryPrompt: Message = {
      role: "user",
      content:
        "You have reached the maximum number of iterations for this run. " +
        "Please provide a concise structured summary:\n" +
        "1. **Accomplished** — what was completed successfully\n" +
        "2. **Remaining** — what still needs to be done\n" +
        "3. **State** — any key information needed to continue (file paths, variable values, next command, etc.)\n\n" +
        "Keep it under 300 words. Do not call any tools.",
    };
    ctx.messages.push(recoveryPrompt);

    try {
      // Tool-free call — pass empty tool schemas so the model can't call tools
      const recovery = await this.provider.complete(
        ctx.messages,
        [], // no tools
        { maxTokens: 512 },
      );

      const summary = recovery.content.trim() || fallback;
      const assistantSummary: Message = { role: "assistant", content: summary };
      ctx.messages.push(assistantSummary);

      // Update budget for the recovery call
      ctx.budget.tokensIn += recovery.usage.inputTokens;
      ctx.budget.tokensOut += recovery.usage.outputTokens;
      ctx.budget.spentUsd += recovery.usage.costUsd;
      ctx.budget.llmCalls++;

      this.emit({
        type: "iteration.limit",
        iteration: ctx.iteration,
        maxIterations: this.config.maxIterations,
        summary,
        timestamp: Date.now(),
      });
    } catch {
      // Recovery call failed — emit the event with a fallback summary
      ctx.messages.push({ role: "assistant", content: fallback });
      this.emit({
        type: "iteration.limit",
        iteration: ctx.iteration,
        maxIterations: this.config.maxIterations,
        summary: fallback,
        timestamp: Date.now(),
      });
    }
  }

  // ── Retry Logic ───────────────────────────────────────────

  /**
   * Call the LLM with exponential backoff retry.
   *
   * Retries on:
   *   - 429 Too Many Requests (with retry-after header if available)
   *   - 500/502/503 Server Errors
   *   - Network errors (ECONNRESET, ETIMEDOUT, fetch failed)
   */
  private async callWithRetry(ctx: AgentContext): Promise<LLMResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        return await this.provider.complete(ctx.messages, ctx.toolSchemas);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this error is retryable
        if (attempt >= this.retryConfig.maxAttempts || !this.isRetryable(lastError)) {
          throw lastError;
        }

        // Calculate delay with exponential backoff + jitter
        const baseDelay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * 0.3 * baseDelay; // ±30% jitter
        const delay = Math.min(baseDelay + jitter, this.retryConfig.maxDelayMs);

        // Check for retry-after header hint in error message
        const retryAfterMatch = lastError.message.match(/retry.after[:\s]+(\d+)/i);
        const retryAfterMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) * 1000
          : delay;
        const finalDelay = Math.min(retryAfterMs, this.retryConfig.maxDelayMs);

        this.emit({
          type: "error",
          error: `Retry ${attempt + 1}/${this.retryConfig.maxAttempts}: ${lastError.message} (waiting ${Math.round(finalDelay)}ms)`,
          timestamp: Date.now(),
        });

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, finalDelay));

        // Check abort during wait
        if (this.abortController?.signal.aborted) {
          throw new Error("Aborted during retry wait");
        }
      }
    }

    throw lastError ?? new Error("Unknown retry failure");
  }

  /** Check if an error is worth retrying */
  private isRetryable(error: Error): boolean {
    const msg = error.message;

    // Check for retryable HTTP status codes in error message
    for (const status of this.retryConfig.retryableStatuses) {
      if (msg.includes(`(${status})`) || msg.includes(`${status}`)) {
        return true;
      }
    }

    // Check for retryable error patterns
    for (const pattern of this.retryConfig.retryablePatterns) {
      if (pattern.test(msg)) {
        return true;
      }
    }

    return false;
  }

  // ── Parallel Tool Dispatch ────────────────────────────────

  /**
   * Dispatch tool calls in parallel.
   *
   * All independent tool calls from a single LLM response run
   * concurrently via Promise.allSettled, then results are
   * collected in the original order.
   */
  private async dispatchToolsParallel(
    ctx: AgentContext,
    toolCalls: ToolCall[],
  ): Promise<ToolResult[]> {
    // Execute all tool calls concurrently
    const promises = toolCalls.map((call) =>
      this.executeSingleTool(ctx, call),
    );

    const settled = await Promise.allSettled(promises);

    return settled.map((result, i) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      // Promise rejected — shouldn't happen since executeSingleTool catches errors,
      // but handle it defensively
      const errMsg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      return {
        toolCallId: toolCalls[i].id,
        name: toolCalls[i].name,
        content: `Error executing tool "${toolCalls[i].name}": ${errMsg}`,
        isError: true,
      };
    });
  }

  /** Execute a single tool call with error handling and event emission */
  private async executeSingleTool(
    ctx: AgentContext,
    call: ToolCall,
  ): Promise<ToolResult> {
    this.emit({
      type: "tool.call.start",
      toolName: call.name,
      args: call.arguments,
      timestamp: Date.now(),
    });

    const startTime = Date.now();
    const tool = ctx.tools.find((t) => t.schema.name === call.name);

    let result: ToolResult;

    if (!tool) {
      result = {
        toolCallId: call.id,
        name: call.name,
        content: `Error: Tool "${call.name}" not found. Available tools: ${ctx.tools.map((t) => t.schema.name).join(", ")}`,
        isError: true,
      };
    } else {
      try {
        const output = await tool.execute(call.arguments);
        result = {
          toolCallId: call.id,
          name: call.name,
          content: output,
          isError: false,
        };
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : String(error);
        result = {
          toolCallId: call.id,
          name: call.name,
          content: `Error executing tool "${call.name}": ${errMsg}`,
          isError: true,
        };
      }
    }

    ctx.budget.toolCalls++;

    const durationMs = Date.now() - startTime;
    this.emit({
      type: "tool.call.end",
      toolName: call.name,
      result: result.content.slice(0, 500),
      isError: result.isError ?? false,
      durationMs,
      timestamp: Date.now(),
    });

    return result;
  }

  // ── Context Compression ───────────────────────────────────

  /**
   * Compress context if we're approaching the token limit.
   *
   * Delegates to the structured compressor in compressor.ts which:
   *   1. Pre-prunes oversized tool results (cheap pass)
   *   2. Protects head (system + first exchange) and tail (recent N messages)
   *   3. Calls the LLM to produce a structured summary with sections:
   *      Resolved / Pending / Key Facts / Files Modified / Commands Run
   *   4. Falls back to deterministic extraction if the LLM call fails
   *   5. Iterates up to 2 passes if still over budget after first compression
   */
  private async compressContextIfNeeded(ctx: AgentContext): Promise<void> {
    const maxTokens = this.config.maxContextTokens ?? 128_000;
    const current = estimateTokens(ctx.messages);
    if (current <= maxTokens * COMPRESSION_THRESHOLD) return;

    const result = await compressContext(
      ctx.messages,
      maxTokens,
      this.provider,
      true, // use LLM for structured summarization
    );

    if (result.messagesRemoved === 0 && result.passes === 0) return;

    ctx.messages = result.messages;

    this.emit({
      type: "context.compressed",
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      messagesRemoved: result.messagesRemoved,
      timestamp: Date.now(),
    } as AgentEvent);
  }

  // ── Middleware Chain ───────────────────────────────────────

  /**
   * Build the middleware chain (onion model).
   * Each middleware calls next() to proceed to the next one.
   * The innermost function is the agent loop itself.
   */
  private buildMiddlewareChain(
    middlewares: Middleware[],
    core: (ctx: AgentContext) => Promise<void>,
  ): (ctx: AgentContext) => Promise<void> {
    let chain = core;

    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i];
      const next = chain;
      chain = (ctx: AgentContext) => mw.execute(ctx, () => next(ctx));
    }

    return chain;
  }

  // ── Token Estimation ──────────────────────────────────────

  /**
   * Estimate tokens for a message array.
   *
   * Uses a more accurate heuristic than chars/4:
   *   - Account for message overhead (~4 tokens per message for role/structure)
   *   - Tool call arguments are JSON-serialized
   *   - Tool schemas add overhead proportional to their count
   */
  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }
}
