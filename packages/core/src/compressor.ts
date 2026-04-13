/**
 * Nexus Context Compressor
 *
 * Structured LLM-based context summarization.
 *
 * Strategy (mirrors Hermes' approach):
 *   1. Pre-pass: prune oversized tool results (cheap, no LLM needed)
 *   2. Protect head: system prompt + first user/assistant exchange
 *   3. Protect tail: last N messages (recent context stays verbatim)
 *   4. Summarize middle with an LLM call using a structured prompt that tracks:
 *      - What was accomplished (resolved)
 *      - What is still pending / in-progress
 *      - Key facts discovered (file paths, values, decisions)
 *      - Files created/modified
 *      - Commands run and their outcomes
 *   5. Re-compress iteratively if still over budget (max 2 passes)
 */

import type { Message, LLMProvider } from "./types.js";

// ── Configuration ─────────────────────────────────────────

/** Token ratio at which compression triggers */
export const COMPRESSION_THRESHOLD = 0.8;

/** Messages to keep verbatim at the tail (recent window) */
export const MIN_RECENT_MESSAGES = 8;

/** Max chars for a single tool result before we truncate it pre-compression */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Max chars for the LLM summary budget */
const SUMMARY_MAX_TOKENS = 1200;

/** Max compression passes before giving up */
const MAX_PASSES = 2;

// ── Token estimation ──────────────────────────────────────

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += 16;
    chars += m.content?.length ?? 0;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += tc.name.length + JSON.stringify(tc.arguments).length + 20;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ── Pre-pass: prune bloated tool results ──────────────────

/**
 * Before calling the LLM, cut any tool result messages that are longer than
 * TOOL_RESULT_MAX_CHARS. These are usually verbose command outputs or file reads
 * that are no longer needed verbatim.
 */
function pruneLargeToolResults(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const content = m.content ?? "";
    if (content.length <= TOOL_RESULT_MAX_CHARS) return m;
    const truncated =
      content.slice(0, TOOL_RESULT_MAX_CHARS) +
      `\n… [${content.length - TOOL_RESULT_MAX_CHARS} chars truncated for context efficiency]`;
    return { ...m, content: truncated };
  });
}

// ── Build the LLM summary prompt ──────────────────────────

function buildSummaryPrompt(messages: Message[]): string {
  const lines: string[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`USER: ${(m.content ?? "").slice(0, 300)}`);
    } else if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          const args = JSON.stringify(tc.arguments).slice(0, 120);
          lines.push(`TOOL_CALL: ${tc.name}(${args})`);
        }
      }
      if (m.content) {
        lines.push(`ASSISTANT: ${m.content.slice(0, 300)}`);
      }
    } else if (m.role === "tool") {
      const preview = (m.content ?? "").slice(0, 200).replace(/\n/g, " ");
      lines.push(`TOOL_RESULT: ${preview}`);
    }
  }

  return lines.join("\n");
}

// ── LLM-based structured summarization ───────────────────

const SYSTEM_SUMMARIZER = `You are a context summarizer for an AI coding agent.
Your job is to compress earlier conversation turns into a dense, lossless summary.
The agent will use this summary as its only record of past work — so be accurate and specific.

Respond with a structured summary in this exact format:

## Resolved
- <what was asked and fully completed — be specific about file names, values, outcomes>

## Pending
- <tasks started but not finished, or questions that need follow-up>

## Key Facts
- <important information discovered: file paths, config values, API endpoints, decisions made, errors encountered>

## Files Modified
- <list each file that was created or changed, with a brief note on what changed>

## Commands Run
- <significant shell commands and their outcomes>

Be concise but complete. Omit trivial exchanges. Focus on what the agent needs to remember to continue the task.`;

async function summarizeWithLLM(
  messages: Message[],
  provider: LLMProvider,
): Promise<string> {
  const transcript = buildSummaryPrompt(messages);

  try {
    const response = await provider.complete(
      [
        { role: "system", content: SYSTEM_SUMMARIZER },
        {
          role: "user",
          content: `Summarize the following agent conversation turns:\n\n${transcript}`,
        },
      ],
      [],
      { temperature: 0.1, maxTokens: SUMMARY_MAX_TOKENS },
    );
    return response.content.trim();
  } catch {
    // LLM call failed — fall back to deterministic extraction
    return buildDeterministicSummary(messages);
  }
}

// ── Deterministic fallback (no LLM) ──────────────────────

function buildDeterministicSummary(messages: Message[]): string {
  const resolvedItems: string[] = [];
  const filesModified = new Set<string>();
  const commandsRun: string[] = [];
  const keyFacts: string[] = [];

  let currentUserTask = "";

  for (const m of messages) {
    if (m.role === "user" && m.content) {
      currentUserTask = m.content.slice(0, 120);
    } else if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          if (tc.name === "write_file" || tc.name === "patch_file" || tc.name === "create_file") {
            const path = tc.arguments?.path as string;
            if (path) filesModified.add(path);
          }
          if (tc.name === "shell") {
            const cmd = tc.arguments?.command as string;
            if (cmd) commandsRun.push(cmd.slice(0, 80));
          }
          if (tc.name === "web_search") {
            const q = tc.arguments?.query as string;
            if (q) keyFacts.push(`Searched for: ${q}`);
          }
        }
      }
      if (m.content && !m.toolCalls?.length && currentUserTask) {
        resolvedItems.push(`${currentUserTask} → ${m.content.slice(0, 100)}`);
        currentUserTask = "";
      }
    }
  }

  const parts: string[] = [];

  if (resolvedItems.length) {
    parts.push("## Resolved\n" + resolvedItems.map((r) => `- ${r}`).join("\n"));
  }
  if (filesModified.size) {
    parts.push("## Files Modified\n" + [...filesModified].map((f) => `- ${f}`).join("\n"));
  }
  if (commandsRun.length) {
    parts.push(
      "## Commands Run\n" +
        commandsRun
          .slice(0, 8)
          .map((c) => `- ${c}`)
          .join("\n"),
    );
  }
  if (keyFacts.length) {
    parts.push("## Key Facts\n" + keyFacts.map((f) => `- ${f}`).join("\n"));
  }

  return parts.join("\n\n") || "*(no significant activity to summarize)*";
}

// ── Main compressor ───────────────────────────────────────

export interface CompressionResult {
  messages: Message[];
  beforeTokens: number;
  afterTokens: number;
  messagesRemoved: number;
  passes: number;
  usedLLM: boolean;
}

/**
 * Compress the message history if it exceeds the token threshold.
 *
 * @param messages    Full message array (including system prompt)
 * @param maxTokens   Context window size
 * @param provider    LLM provider (used for summarization; can be null for fallback)
 * @param useLLM      Whether to use the LLM for summaries (default: true)
 */
export async function compressContext(
  messages: Message[],
  maxTokens: number,
  provider: LLMProvider | null,
  useLLM = true,
): Promise<CompressionResult> {
  const threshold = maxTokens * COMPRESSION_THRESHOLD;
  const beforeTokens = estimateTokens(messages);

  if (beforeTokens <= threshold) {
    return { messages, beforeTokens, afterTokens: beforeTokens, messagesRemoved: 0, passes: 0, usedLLM: false };
  }

  let current = [...messages];
  let totalRemoved = 0;
  let passes = 0;
  let didUseLLM = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const tokens = estimateTokens(current);
    if (tokens <= threshold) break;

    passes++;

    // Locate boundaries
    const systemIdx = current.findIndex((m) => m.role === "system");
    const headEnd = systemIdx + 1;

    // Find first user message after system — head includes first exchange
    let firstExchangeEnd = headEnd;
    let seenUser = false;
    for (let i = headEnd; i < current.length; i++) {
      if (current[i].role === "user") { seenUser = true; }
      else if (seenUser && current[i].role === "assistant" && !current[i].toolCalls?.length) {
        firstExchangeEnd = i + 1;
        break;
      }
    }

    const tailStart = Math.max(firstExchangeEnd + 1, current.length - MIN_RECENT_MESSAGES);
    const middleMessages = current.slice(firstExchangeEnd, tailStart);

    if (middleMessages.length < 2) break; // Nothing to compress

    // Pre-pass: prune large tool results in the middle segment
    const pruned = pruneLargeToolResults(middleMessages);
    const afterPruneTokens = estimateTokens([
      ...current.slice(0, firstExchangeEnd),
      ...pruned,
      ...current.slice(tailStart),
    ]);

    // If pruning alone brought us under threshold, use it
    if (afterPruneTokens <= threshold) {
      current = [...current.slice(0, firstExchangeEnd), ...pruned, ...current.slice(tailStart)];
      // No messages removed, just truncated
      break;
    }

    // Use LLM to generate structured summary
    let summaryText: string;
    if (useLLM && provider) {
      summaryText = await summarizeWithLLM(pruned, provider);
      didUseLLM = true;
    } else {
      summaryText = buildDeterministicSummary(pruned);
    }

    const summaryMessage: Message = {
      role: "user",
      content:
        `[CONTEXT SUMMARY — ${middleMessages.length} earlier messages compressed into this summary]\n\n` +
        summaryText +
        `\n\n[End of summary. Continuing from here...]`,
    };

    const head = current.slice(0, firstExchangeEnd);
    const tail = current.slice(tailStart);
    current = [...head, summaryMessage, ...tail];
    totalRemoved += middleMessages.length - 1; // summary replaces N messages with 1
  }

  const afterTokens = estimateTokens(current);

  return {
    messages: current,
    beforeTokens,
    afterTokens,
    messagesRemoved: totalRemoved,
    passes,
    usedLLM: didUseLLM,
  };
}
