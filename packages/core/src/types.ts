/**
 * Nexus Core Types
 *
 * Foundational types that every layer of the system depends on.
 */

// ── Messages ──────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

// ── Tools ─────────────────────────────────────────────────

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Tool {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ── Agent Configuration ───────────────────────────────────

export interface AgentConfig {
  /** Model identifier, e.g. "anthropic:claude-sonnet-4-20250514" */
  model: string;
  /** System prompt — the base identity */
  systemPrompt: string;
  /** Available tools */
  tools: Tool[];
  /** Middleware pipeline (executed in order) */
  middleware: Middleware[];
  /** Maximum iterations of the agent loop */
  maxIterations: number;
  /** Maximum tokens for context window */
  maxContextTokens: number;
}

// ── Artifact Tracking ─────────────────────────────────────
// First-class record of everything the agent does that has side effects.

export type ArtifactType =
  | "file_read"
  | "file_write"
  | "file_patch"
  | "command_run"
  | "url_fetched"
  | "git_op"
  | "pr_opened"
  | "shell_output";

export interface ArtifactRecord {
  type: ArtifactType;
  /** File path for file operations */
  path?: string;
  /** URL for web/network operations */
  url?: string;
  /** Command text for shell operations */
  command?: string;
  /** Short summary or first line of output */
  summary?: string;
  timestamp: number;
}

// ── Middleware ─────────────────────────────────────────────
// Context flows through a middleware chain;
// each middleware can modify context or abort.

export interface AgentContext {
  /** Current session ID */
  sessionId: string;
  /** Full conversation history */
  messages: Message[];
  /** Available tools for this turn */
  tools: Tool[];
  /** Tool schemas sent to the LLM */
  toolSchemas: ToolSchema[];
  /** Current system prompt */
  systemPrompt: string;
  /** Current iteration in the agent loop */
  iteration: number;
  /** Budget tracking */
  budget: BudgetState;
  /** Metadata bag for middleware to share state */
  meta: Record<string, unknown>;
  /** Whether the loop should stop after this turn */
  shouldStop: boolean;
  /** Abort with a reason */
  abort: (reason: string) => void;
  /**
   * Redirect: stop current run and re-enter with a new user message.
   * Called by interrupt middleware or the agent itself when it realizes it needs
   * different input to continue.
   */
  redirect: (newMessage: string) => void;
  /**
   * All artifacts produced this run — files written/read, commands executed,
   * URLs fetched, git operations performed. Populated by artifactTracker middleware.
   */
  artifacts: ArtifactRecord[];
}

export type NextFn = () => Promise<void>;

export type Middleware = {
  name: string;
  /** Runs before and/or after the LLM call (onion model) */
  execute: (ctx: AgentContext, next: NextFn) => Promise<void>;
};

// ── Budget ────────────────────────────────────────────────

export interface BudgetState {
  /** Total budget for this session in USD */
  limitUsd: number;
  /** Amount spent so far */
  spentUsd: number;
  /** Token counts */
  tokensIn: number;
  tokensOut: number;
  /** Number of LLM calls made */
  llmCalls: number;
  /** Number of tool calls made */
  toolCalls: number;
}

// ── Events ────────────────────────────────────────────────
// Event-driven backbone (inspired by research on EDA for agents)

export type AgentEvent =
  | { type: "session.start"; sessionId: string; timestamp: number }
  | { type: "message.user"; message: Message; timestamp: number }
  | { type: "message.assistant"; message: Message; timestamp: number }
  | { type: "llm.call.start"; model: string; tokenEstimate: number; timestamp: number }
  | { type: "llm.call.end"; model: string; tokensIn: number; tokensOut: number; costUsd: number; durationMs: number; timestamp: number }
  | { type: "tool.call.start"; toolName: string; args: Record<string, unknown>; timestamp: number }
  | { type: "tool.call.end"; toolName: string; result: string; isError: boolean; durationMs: number; timestamp: number }
  | { type: "budget.warning"; spentUsd: number; limitUsd: number; timestamp: number }
  | { type: "budget.exceeded"; spentUsd: number; limitUsd: number; timestamp: number }
  | { type: "context.compressed"; beforeTokens: number; afterTokens: number; messagesRemoved: number; timestamp: number }
  | { type: "session.end"; reason: string; timestamp: number }
  | { type: "error"; error: string; timestamp: number }
  /** Emitted when the agent hits maxIterations — includes a partial-work summary */
  | { type: "iteration.limit"; iteration: number; maxIterations: number; summary: string; timestamp: number }
  /** Emitted when agent.interrupt() is called */
  | { type: "agent.interrupted"; redirectMessage: string | null; timestamp: number }
  /** Streaming token delta (emitted by stream-capable providers) */
  | { type: "stream.delta"; delta: string; accumulated: string; timestamp: number }
  /** Artifact produced — file written, command run, URL fetched, etc. */
  | { type: "artifact"; artifact: ArtifactRecord; timestamp: number };

export type EventHandler = (event: AgentEvent) => void;

// ── Provider Abstraction ──────────────────────────────────

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  /** The raw response from the provider (for debugging) */
  raw?: unknown;
}

export interface LLMProvider {
  /** Human-readable name */
  name: string;
  /** Generate a response */
  complete(
    messages: Message[],
    tools: ToolSchema[],
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<LLMResponse>;
  /** Estimate cost for a given token count */
  estimateCost(inputTokens: number, outputTokens: number): number;
}

// ── Session ───────────────────────────────────────────────

export interface Session {
  id: string;
  messages: Message[];
  budget: BudgetState;
  createdAt: number;
  updatedAt: number;
  meta: Record<string, unknown>;
}

// ── Run Result ────────────────────────────────────────────

export interface AgentRunResult {
  messages: Message[];
  response: string;
  budget: BudgetState;
  /**
   * If the agent was redirected (via ctx.redirect() or agent.interrupt()),
   * this contains the new message to send. The caller should immediately
   * re-run with this message.
   */
  redirect?: string;
  /** Artifacts produced during this run */
  artifacts: ArtifactRecord[];
  /** True if the run stopped due to hitting the iteration limit */
  hitIterationLimit?: boolean;
}
