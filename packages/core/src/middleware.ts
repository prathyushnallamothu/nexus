/**
 * Nexus Built-in Middleware
 *
 * Composable middleware for safety, budgets, and security.
 */

import type {
  Middleware,
  AgentContext,
  NextFn,
  ArtifactRecord,
  ArtifactType,
  LLMProvider,
} from "./types.js";
import { WikiStore, type MemoryCitation, type MemoryType } from "./wiki.js";
import { WikiSearchIndex, type FTSResult } from "./wiki-index.js";

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

// ── Production Middleware ─────────────────────────────────

export interface MemoryContextBuilderOptions {
  /** Root Nexus data directory. Used to create WikiStore/WikiSearchIndex if store/index are omitted. */
  nexusHome?: string;
  /** Existing wiki store, useful for tests or custom hosts. */
  store?: WikiStore;
  /** Existing FTS5 index, useful for tests or custom hosts. */
  index?: WikiSearchIndex;
  /** Active project slug under wiki/projects/<slug>/. Defaults to cwd basename. */
  project?: string;
  /** Number of recalled pages to include. Default: 5. */
  maxResults?: number;
  /** Max characters from each snippet/body section. Default: 700. */
  maxSnippetChars?: number;
  /** Total character budget for the injected memory block. Default: 6000. */
  maxContextChars?: number;
  /** Include user/profile.md when it contains real facts. Default: true. */
  includeUserProfile?: boolean;
  /** Include projects/<project>/overview.md when present. Default: true. */
  includeProjectOverview?: boolean;
}

export interface RetrievedMemorySource {
  path: string;
  title: string;
  summary: string;
  category: string;
  memoryType?: MemoryType;
  confidence?: number;
  citations?: MemoryCitation[];
  updatedAt?: number;
  rank?: number;
  snippet?: string;
  source: "profile" | "project" | "recall";
}

export interface WikiSessionArchiveOptions {
  /** Root Nexus data directory. Used to create WikiStore/WikiSearchIndex if store/index are omitted. */
  nexusHome?: string;
  /** Existing wiki store, useful for tests or custom hosts. */
  store?: WikiStore;
  /** Existing FTS5 index, useful for tests or custom hosts. */
  index?: WikiSearchIndex;
  /** Active project slug under wiki/projects/<slug>/. Defaults to cwd basename. */
  project?: string;
  /** Max assistant-response chars copied into the summary. Default: 1400. */
  maxResponseChars?: number;
  /** Max artifact rows copied into the summary. Default: 12. */
  maxArtifacts?: number;
}

/**
 * Memory Context Builder — deterministically retrieves wiki memory before the
 * first LLM call and injects a bounded system message with source citations.
 *
 * This closes the gap where memory existed only as tools the model had to
 * remember to call. The agent now always starts with relevant user/project/wiki
 * context when the local wiki contains useful facts.
 */
export function memoryContextBuilder(options: MemoryContextBuilderOptions = {}): Middleware {
  const store =
    options.store ??
    (options.nexusHome ? new WikiStore(options.nexusHome) : null);
  const index =
    options.index ??
    (options.nexusHome ? new WikiSearchIndex(options.nexusHome) : null);

  const maxResults = Math.max(0, options.maxResults ?? 5);
  const maxSnippetChars = Math.max(120, options.maxSnippetChars ?? 700);
  const maxContextChars = Math.max(800, options.maxContextChars ?? 6_000);
  const includeUserProfile = options.includeUserProfile ?? true;
  const includeProjectOverview = options.includeProjectOverview ?? true;
  const project = normaliseProjectSlug(options.project ?? process.cwd().split(/[\\/]/).pop() ?? "");

  return {
    name: "memory-context-builder",
    async execute(ctx: AgentContext, next: NextFn) {
      if (!store || !index) {
        ctx.meta["memoryContext"] = { sourceCount: 0, skipped: "not_configured" };
        await next();
        return;
      }

      const lastUserMessage = [...ctx.messages].reverse().find((m) => m.role === "user");
      const query = lastUserMessage?.content.trim() ?? "";
      const pageMeta = new Map(store.listPages().map((p) => [p.path, p]));
      const sources: RetrievedMemorySource[] = [];
      const seen = new Set<string>();

      try {
        index.syncStale(store);

        if (includeUserProfile) {
          const profile = readUsefulPage(store, "user/profile.md");
          if (profile) {
            const metadata = store.getMetadata("user/profile.md");
            addSource(sources, seen, {
              path: "user/profile.md",
              title: "User Profile",
              summary: profile.summary,
              category: "user",
              memoryType: metadata?.type,
              confidence: metadata?.confidence,
              citations: metadata?.citations,
              updatedAt: pageMeta.get("user/profile.md")?.updatedAt,
              snippet: profile.snippet,
              source: "profile",
            });
          }
        }

        if (includeProjectOverview && project) {
          const projectPath = `projects/${project}/overview.md`;
          const overview = readUsefulPage(store, projectPath);
          if (overview) {
            const metadata = store.getMetadata(projectPath);
            addSource(sources, seen, {
              path: projectPath,
              title: pageMeta.get(projectPath)?.title ?? "Project Overview",
              summary: overview.summary,
              category: "projects",
              memoryType: metadata?.type,
              confidence: metadata?.confidence,
              citations: metadata?.citations,
              updatedAt: pageMeta.get(projectPath)?.updatedAt,
              snippet: overview.snippet,
              source: "project",
            });
          }
        }

        if (query && maxResults > 0) {
          const recalled = index
            .recall(query, maxResults + seen.size + 3)
            .filter((r) => !isInfrastructurePage(r.path))
            .filter((r) => !seen.has(r.path))
            .filter((r) => hasUsefulRecalledPage(store, r))
            .slice(0, maxResults);

          for (const result of recalled) {
            const metadata = store.getMetadata(result.path);
            addSource(sources, seen, {
              path: result.path,
              title: result.title,
              summary: result.summary,
              category: result.category,
              memoryType: metadata?.type,
              confidence: metadata?.confidence,
              citations: metadata?.citations,
              updatedAt: pageMeta.get(result.path)?.updatedAt,
              rank: result.rank,
              snippet: result.snippet,
              source: "recall",
            });
          }
        }

        const memoryBlock = formatMemoryBlock(sources, maxSnippetChars, maxContextChars);
        ctx.meta["memoryContext"] = {
          sourceCount: sources.length,
          sources: sources.map(({ path, title, category, source, rank, updatedAt, memoryType, confidence, citations }) => ({
            path,
            title,
            category,
            source,
            rank,
            updatedAt,
            memoryType,
            confidence,
            citations,
          })),
        };

        if (memoryBlock) {
          insertMemorySystemMessage(ctx, memoryBlock);
        }
      } catch (error) {
        ctx.meta["memoryContext"] = {
          sourceCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      await next();
    },
  };
}

/**
 * Build an after-agent hook that archives each completed run into wiki memory:
 *   - immutable raw transcript: .nexus/raw/sessions/<session-id>.md
 *   - synthesized wiki summary: .nexus/wiki/sessions/<date>-<slug>.md
 *   - append-only wiki log entry
 *
 * This is deterministic by design. It gives the memory retriever something
 * durable to recall even if the model forgets to call wiki_save_session.
 */
export function createWikiSessionArchiveHook(options: WikiSessionArchiveOptions = {}): AfterAgentHook {
  const store =
    options.store ??
    (options.nexusHome ? new WikiStore(options.nexusHome) : null);
  const index =
    options.index ??
    (options.nexusHome ? new WikiSearchIndex(options.nexusHome) : null);
  const project = normaliseProjectSlug(options.project ?? process.cwd().split(/[\\/]/).pop() ?? "");
  const maxResponseChars = Math.max(300, options.maxResponseChars ?? 1_400);
  const maxArtifacts = Math.max(0, options.maxArtifacts ?? 12);

  if (store && index) {
    store.indexer = (pagePath, title, summary, body, mtime) => {
      index.update(pagePath, title, summary, body, mtime);
    };
  }

  return async (ctx: AgentContext): Promise<void> => {
    if (!store) {
      ctx.meta["wikiSessionArchive"] = { archived: false, skipped: "not_configured" };
      return;
    }

    const userMessages = ctx.messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) {
      ctx.meta["wikiSessionArchive"] = { archived: false, skipped: "no_user_messages" };
      return;
    }

    const rawTranscript = formatRawTranscript(ctx);
    const rawPath = store.saveRawSession(ctx.sessionId, rawTranscript);
    const summaryPath = buildSessionSummaryPath(ctx, userMessages[0]?.content ?? "session");
    const summary = buildSessionSummary(ctx, rawPath, project, maxResponseChars, maxArtifacts);

    store.writePage(
      summaryPath,
      summary,
      `Archived session ${ctx.sessionId}`,
      {
        type: "session_summary",
        confidence: 1,
        project: project || undefined,
        tags: ["session", ...(project ? [project] : [])],
        citations: [{
          sourceType: "session",
          sourcePath: rawPath,
          sourceId: ctx.sessionId,
          quote: truncateOneLine(firstUserMessage(ctx), 240),
          timestamp: new Date().toISOString(),
        }],
        attributes: {
          llmCalls: ctx.budget.llmCalls,
          toolCalls: ctx.budget.toolCalls,
          costUsd: ctx.budget.spentUsd,
        },
      },
    );
    store.appendLog(
      "session",
      summaryTitleFromPath(summaryPath),
      `Archived raw transcript to raw/sessions/${ctx.sessionId}.md and summary to ${summaryPath}.`,
    );

    ctx.meta["wikiSessionArchive"] = {
      archived: true,
      rawPath,
      summaryPath,
    };
  };
}

/**
 * Artifact Tracker — wraps every tool's execute() to detect and record
 * side-effectful operations in ctx.artifacts.
 *
 * Detection heuristics (zero false-positive goal):
 *  - file_write / file_patch: tool name contains write/patch/create/save or arg has "path"+"content"
 *  - file_read:  tool name contains read/cat/view or arg is just a path
 *  - command_run: tool name contains run/exec/bash/shell or arg has "command"/"cmd"
 *  - url_fetched: tool name contains fetch/get/request or arg has "url"
 *  - git_op:     tool name contains git
 *  - pr_opened:  tool name contains pr/pull_request
 */
export function artifactTracker(): Middleware {
  function detectType(toolName: string, args: Record<string, unknown>): ArtifactType | null {
    const n = toolName.toLowerCase();
    if (/git/.test(n)) return "git_op";
    if (/pr|pull.?request/.test(n)) return "pr_opened";
    if (/write|patch|create|save|append/.test(n)) return "file_write";
    if (/read|cat|view|open/.test(n)) return "file_read";
    if (/run|exec|bash|shell|terminal|spawn/.test(n)) return "command_run";
    if (/fetch|request|http|curl|browse/.test(n)) return "url_fetched";
    // Fallback: inspect args
    if (args["url"] || args["uri"]) return "url_fetched";
    if (args["command"] || args["cmd"]) return "command_run";
    if (args["path"] && args["content"]) return "file_write";
    if (args["path"] && !args["content"]) return "file_read";
    return null;
  }

  return {
    name: "artifact-tracker",
    async execute(ctx: AgentContext, next: NextFn) {
      // Wrap each tool's execute to intercept calls
      const originalTools = ctx.tools;
      ctx.tools = ctx.tools.map((tool) => ({
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const output = await tool.execute(args);
          const artifactType = detectType(tool.schema.name, args);
          if (artifactType) {
            const record: ArtifactRecord = {
              type: artifactType,
              timestamp: Date.now(),
              summary: output.slice(0, 120).replace(/\n/g, " "),
            };
            if (args["path"] && typeof args["path"] === "string") record.path = args["path"];
            if (args["file"] && typeof args["file"] === "string") record.path = args["file"];
            if (args["url"] && typeof args["url"] === "string") record.url = args["url"];
            if (args["command"] && typeof args["command"] === "string") record.command = args["command"];
            if (args["cmd"] && typeof args["cmd"] === "string") record.command = args["cmd"];
            ctx.artifacts.push(record);
          }
          return output;
        },
      }));

      try {
        await next();
      } finally {
        ctx.tools = originalTools;
      }
    },
  };
}

/**
 * Tool Compactor — truncates oversized tool results before they blow the context.
 *
 * Strategy: head + tail with a `[... N chars omitted ...]` bridge.
 * Keeps the first `headLines` lines (where most errors/output appear)
 * and the last `tailLines` lines (where exit codes / summaries appear).
 */
export function toolCompactor(options?: {
  /** Max characters before truncation kicks in. Default: 8000 */
  maxChars?: number;
  /** Lines to keep from the start. Default: 60 */
  headLines?: number;
  /** Lines to keep from the end. Default: 20 */
  tailLines?: number;
}): Middleware {
  const maxChars = options?.maxChars ?? 8_000;
  const headLines = options?.headLines ?? 60;
  const tailLines = options?.tailLines ?? 20;

  function compact(text: string): string {
    if (text.length <= maxChars) return text;
    const lines = text.split("\n");
    if (lines.length <= headLines + tailLines) {
      // Char budget exceeded but line count is small — just truncate chars
      return text.slice(0, maxChars) + `\n[... ${text.length - maxChars} chars omitted ...]`;
    }
    const head = lines.slice(0, headLines).join("\n");
    const tail = lines.slice(-tailLines).join("\n");
    const omitted = lines.length - headLines - tailLines;
    return `${head}\n[... ${omitted} lines omitted ...]\n${tail}`;
  }

  return {
    name: "tool-compactor",
    async execute(ctx: AgentContext, next: NextFn) {
      const originalTools = ctx.tools;
      ctx.tools = ctx.tools.map((tool) => ({
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const output = await tool.execute(args);
          return compact(output);
        },
      }));

      try {
        await next();
      } finally {
        ctx.tools = originalTools;
      }
    },
  };
}

/**
 * After-Agent — runs deterministic hooks after the agent loop completes.
 *
 * Unlike middleware that wraps the agent (onion model), hooks registered here
 * always run after `next()` returns, in order, with access to the final ctx.
 *
 * Built-in hooks available via `afterAgentHooks.*`:
 *  - noteFileChanges: logs written files to ctx.meta
 *  - archiveSessionToWiki: factory for raw transcript + wiki summary archival
 *  - suggestCommitIfChanged: adds a suggestion to the response if files were written
 */
export type AfterAgentHook = (ctx: AgentContext) => Promise<void> | void;

export function afterAgent(hooks: AfterAgentHook[]): Middleware {
  return {
    name: "after-agent",
    async execute(ctx: AgentContext, next: NextFn) {
      await next();
      for (const hook of hooks) {
        try {
          await hook(ctx);
        } catch {
          // Hooks should never crash the agent
        }
      }
    },
  };
}

/** Built-in after-agent hooks */
export const afterAgentHooks = {
  archiveSessionToWiki: createWikiSessionArchiveHook,

  /**
   * Collect all written file paths into ctx.meta["filesWritten"].
   * Useful for downstream tooling (commit helpers, diff viewers, etc.)
   */
  noteFileChanges: async (ctx: AgentContext): Promise<void> => {
    const written = ctx.artifacts
      .filter((a) => a.type === "file_write" || a.type === "file_patch")
      .map((a) => a.path)
      .filter(Boolean) as string[];
    if (written.length > 0) {
      ctx.meta["filesWritten"] = written;
    }
  },

  /**
   * If the agent wrote files, append a suggestion to consider committing.
   * Only runs if there's a final assistant message to append to.
   */
  suggestCommitIfChanged: async (ctx: AgentContext): Promise<void> => {
    const written = ctx.artifacts.filter(
      (a) => (a.type === "file_write" || a.type === "file_patch") && a.path,
    );
    if (written.length === 0) return;

    const lastMsg = [...ctx.messages].reverse().find((m) => m.role === "assistant" && m.content);
    if (!lastMsg) return;

    const paths = [...new Set(written.map((a) => a.path))].slice(0, 5).join(", ");
    const suffix = `\n\n> 📁 **${written.length} file(s) modified**: ${paths}. Consider running \`git diff\` to review.`;
    if (!lastMsg.content.includes("📁")) {
      lastMsg.content += suffix;
    }
  },
};

// ── Provider Fallback ─────────────────────────────────────

/**
 * createFallbackProvider — wraps a primary LLMProvider with ordered fallbacks.
 *
 * On any error from the primary, tries each fallback in sequence.
 * If all fail, throws the last error.
 *
 * Usage:
 *   const provider = createFallbackProvider(anthropicProvider, [openaiProvider, groqProvider]);
 */
export function createFallbackProvider(
  primary: LLMProvider,
  fallbacks: LLMProvider[],
): LLMProvider {
  const all = [primary, ...fallbacks];

  return {
    name: `fallback(${all.map((p) => p.name).join(" → ")})`,

    async complete(messages, tools, options) {
      let lastError: Error | null = null;
      for (const provider of all) {
        try {
          return await provider.complete(messages, tools, options);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Continue to next provider
        }
      }
      throw lastError ?? new Error("All providers failed");
    },

    estimateCost(inputTokens, outputTokens) {
      // Use primary for cost estimation (it's the cheapest path)
      return primary.estimateCost(inputTokens, outputTokens);
    },
  };
}

function addSource(
  sources: RetrievedMemorySource[],
  seen: Set<string>,
  source: RetrievedMemorySource,
): void {
  if (seen.has(source.path)) return;
  seen.add(source.path);
  sources.push(source);
}

function readUsefulPage(
  store: WikiStore,
  pagePath: string,
): { summary: string; snippet: string } | null {
  const content = store.readPage(pagePath);
  if (content.startsWith("(page not found")) return null;
  if (!hasUsefulMemory(content)) return null;
  return {
    summary: extractPageSummary(content),
    snippet: extractPageBody(content),
  };
}

function hasUsefulRecalledPage(store: WikiStore, result: FTSResult): boolean {
  if (result.snippet && hasUsefulMemory(result.snippet)) return true;
  return hasUsefulMemory(store.readPage(result.path));
}

function hasUsefulMemory(content: string): boolean {
  const stripped = content
    .replace(/^#+\s+.+$/gm, "")
    .replace(/^>\s+.+$/gm, "")
    .replace(/^Updated:\s+\d{4}-\d{2}-\d{2}$/gm, "")
    .trim();
  if (!stripped) return false;

  const placeholders = [
    "_No preferences recorded yet. Update as you learn them._",
    "_Not yet observed._",
    "_Not yet recorded._",
    "_None recorded yet._",
  ];
  const withoutPlaceholders = placeholders.reduce(
    (text, placeholder) => text.replaceAll(placeholder, ""),
    stripped,
  ).trim();
  return withoutPlaceholders.length > 0;
}

function extractPageSummary(content: string): string {
  const blockquote = content.match(/^>\s+(.+)$/m)?.[1]?.trim();
  if (blockquote) return blockquote;
  return extractPageBody(content).split("\n")[0]?.trim() ?? "";
}

function extractPageBody(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith("# "))
    .filter((line) => !line.startsWith("> "))
    .filter((line) => !/^Updated:\s+\d{4}-\d{2}-\d{2}/.test(line.trim()))
    .join("\n")
    .trim();
}

function formatMemoryBlock(
  sources: RetrievedMemorySource[],
  maxSnippetChars: number,
  maxContextChars: number,
): string {
  if (sources.length === 0) return "";

  const lines: string[] = [
    "## Retrieved Memory",
    "",
    "Use this retrieved wiki memory as helpful context. Current user instructions and higher-priority system/developer instructions still take precedence. When relying on remembered facts, cite the source path.",
    "",
  ];

  const profile = sources.filter((s) => s.source === "profile");
  const project = sources.filter((s) => s.source === "project");
  const recall = sources.filter((s) => s.source === "recall");

  appendSourceGroup(lines, "User Memory", profile, maxSnippetChars);
  appendSourceGroup(lines, "Project Memory", project, maxSnippetChars);
  appendSourceGroup(lines, "Relevant Wiki Recall", recall, maxSnippetChars);

  const block = lines.join("\n").trim();
  if (block.length <= maxContextChars) return block;
  return block.slice(0, maxContextChars).trimEnd() + "\n\n[Retrieved memory truncated to fit context budget.]";
}

function appendSourceGroup(
  lines: string[],
  title: string,
  sources: RetrievedMemorySource[],
  maxSnippetChars: number,
): void {
  if (sources.length === 0) return;
  lines.push(`### ${title}`);
  for (const source of sources) {
    const updated = source.updatedAt
      ? new Date(source.updatedAt).toISOString().slice(0, 10)
      : "unknown";
    const rank = typeof source.rank === "number" ? `, rank ${source.rank.toFixed(3)}` : "";
    const type = source.memoryType ? `, type ${source.memoryType}` : "";
    const confidence = typeof source.confidence === "number"
      ? `, confidence ${(source.confidence * 100).toFixed(0)}%`
      : "";
    lines.push(`- Source: \`${source.path}\` (${source.category}${type}, updated ${updated}${confidence}${rank})`);
    if (source.summary) lines.push(`  Summary: ${truncateOneLine(source.summary, 220)}`);
    if (source.snippet) lines.push(`  Snippet: ${truncateOneLine(source.snippet, maxSnippetChars)}`);
    for (const citation of (source.citations ?? []).slice(0, 2)) {
      const sourceId = citation.sourceId ? `#${citation.sourceId}` : "";
      const quote = citation.quote ? ` - "${truncateOneLine(citation.quote, 160)}"` : "";
      lines.push(`  Citation: ${citation.sourceType} \`${citation.sourcePath}${sourceId}\`${quote}`);
    }
  }
  lines.push("");
}

function insertMemorySystemMessage(ctx: AgentContext, memoryBlock: string): void {
  const message = { role: "system" as const, content: memoryBlock };
  const firstNonSystem = ctx.messages.findIndex((m) => m.role !== "system");
  if (firstNonSystem === -1) {
    ctx.messages.push(message);
  } else {
    ctx.messages.splice(firstNonSystem, 0, message);
  }
}

function truncateOneLine(text: string, maxChars: number): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return compacted.slice(0, Math.max(0, maxChars - 16)).trimEnd() + " [truncated]";
}

function isInfrastructurePage(path: string): boolean {
  return path === "SCHEMA.md" || path === "index.md" || path === "log.md";
}

function normaliseProjectSlug(project: string): string {
  return project
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatRawTranscript(ctx: AgentContext): string {
  const lines: string[] = [
    `# Raw Session Transcript`,
    "",
    `Session ID: ${ctx.sessionId}`,
    `Archived: ${new Date().toISOString()}`,
    "",
  ];

  for (const msg of ctx.messages) {
    if (msg.role === "system" && msg.content.includes("## Retrieved Memory")) continue;
    lines.push(`## ${msg.role.toUpperCase()}`);
    if (msg.name) lines.push(`Name: ${msg.name}`);
    if (msg.toolCallId) lines.push(`Tool Call ID: ${msg.toolCallId}`);
    if (msg.toolCalls?.length) {
      lines.push("");
      lines.push("Tool Calls:");
      for (const call of msg.toolCalls) {
        lines.push(`- ${call.name}: ${JSON.stringify(call.arguments)}`);
      }
    }
    lines.push("");
    lines.push(msg.content || "(empty)");
    lines.push("");
  }

  if (ctx.artifacts.length > 0) {
    lines.push("## ARTIFACTS", "");
    for (const artifact of ctx.artifacts) {
      lines.push(`- ${artifact.type}: ${artifact.path ?? artifact.url ?? artifact.command ?? artifact.summary ?? "(no target)"}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function buildSessionSummaryPath(ctx: AgentContext, firstUserMessage: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(firstUserMessage) || ctx.sessionId.replace(/^session_/, "");
  const suffix = ctx.sessionId.replace(/^session_/, "").slice(-6);
  return `sessions/${date}-${slug}-${suffix}.md`;
}

function buildSessionSummary(
  ctx: AgentContext,
  rawPath: string,
  project: string,
  maxResponseChars: number,
  maxArtifacts: number,
): string {
  const firstUser = ctx.messages.find((m) => m.role === "user")?.content ?? "(unknown task)";
  const lastAssistant = [...ctx.messages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "";
  const title = `Session: ${truncateOneLine(firstUser, 70)}`;
  const summary = summarizeResponse(lastAssistant, firstUser);
  const toolNames = [...new Set(ctx.messages
    .filter((m) => m.role === "tool" && m.name)
    .map((m) => m.name as string))];
  const artifacts = ctx.artifacts.slice(0, maxArtifacts);

  const lines: string[] = [
    `# ${title}`,
    "",
    `> ${summary}`,
    "",
    `Updated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Source",
    "",
    `- Raw transcript: \`${rawPath}\``,
    `- Session ID: \`${ctx.sessionId}\``,
    project ? `- Project: \`${project}\`` : "- Project: unknown",
    "",
    "## Request",
    "",
    firstUser.trim(),
    "",
    "## Outcome",
    "",
    ctx.meta["hitIterationLimit"] === true
      ? "- Status: partial, iteration limit reached"
      : "- Status: completed",
    `- LLM calls: ${ctx.budget.llmCalls}`,
    `- Tool calls: ${ctx.budget.toolCalls}`,
    `- Cost: $${ctx.budget.spentUsd.toFixed(4)}`,
    "",
    "## Final Response",
    "",
    truncateBlock(lastAssistant || "(no final assistant response)", maxResponseChars),
    "",
  ];

  if (toolNames.length > 0) {
    lines.push("## Tools Used", "");
    for (const name of toolNames) lines.push(`- ${name}`);
    lines.push("");
  }

  if (artifacts.length > 0) {
    lines.push("## Artifacts", "");
    for (const artifact of artifacts) {
      const target = artifact.path ?? artifact.url ?? artifact.command ?? "";
      const detail = target ? ` - ${target}` : "";
      lines.push(`- ${artifact.type}${detail}`);
    }
    if (ctx.artifacts.length > artifacts.length) {
      lines.push(`- ${ctx.artifacts.length - artifacts.length} more artifact(s) in raw transcript`);
    }
    lines.push("");
  }

  const openItems = extractOpenItems(lastAssistant);
  if (openItems.length > 0) {
    lines.push("## Open Items", "");
    for (const item of openItems) lines.push(`- ${item}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function firstUserMessage(ctx: AgentContext): string {
  return ctx.messages.find((m) => m.role === "user")?.content ?? "";
}

function summarizeResponse(response: string, fallback: string): string {
  const text = response.trim() || fallback.trim();
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "Session archived.";
  return truncateOneLine(firstLine.replace(/^[-*]\s+/, ""), 120);
}

function extractOpenItems(response: string): string[] {
  const lines = response.split("\n");
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/\b(next|todo|remaining|follow[- ]?up|still need|needs to)\b/i.test(trimmed)) {
      items.push(truncateOneLine(trimmed.replace(/^[-*]\s+/, ""), 180));
    }
  }
  return [...new Set(items)].slice(0, 8);
}

function truncateBlock(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - 35)).trimEnd() + "\n\n[truncated in session summary]";
}

function summaryTitleFromPath(path: string): string {
  return path.replace(/^sessions\//, "").replace(/\.md$/, "");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
