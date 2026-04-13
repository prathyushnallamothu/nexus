/**
 * Re-export core types used by providers.
 * These are duplicated here to avoid circular deps between packages.
 * The canonical definitions live in @nexus/core.
 */

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

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  raw?: unknown;
}

export interface LLMProvider {
  name: string;
  complete(
    messages: Message[],
    tools: ToolSchema[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<LLMResponse>;
  estimateCost(inputTokens: number, outputTokens: number): number;
}
