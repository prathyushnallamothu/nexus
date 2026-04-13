/**
 * Nexus Provider Abstraction
 *
 * Supports every major LLM provider via a unified interface.
 * No external SDK dependency — we call HTTP APIs directly.
 * This keeps us lightweight and future-proof.
 */

import type { LLMProvider, LLMResponse, Message, ToolSchema } from "./types.js";

// ── Provider Registry ─────────────────────────────────────

export interface ProviderConfig {
  /** Provider name, e.g. "anthropic", "openai", "google", "ollama" */
  provider: string;
  /** Model name within the provider */
  model: string;
  /** API key (from env or config) */
  apiKey?: string;
  /** Base URL override (for self-hosted, proxies, OpenRouter, etc.) */
  baseUrl?: string;
  /** Extra headers */
  headers?: Record<string, string>;
}

/** Parse a model string like "anthropic:claude-sonnet-4-20250514" */
export function parseModelString(modelStr: string): ProviderConfig {
  const colonIdx = modelStr.indexOf(":");
  if (colonIdx === -1) {
    // No provider prefix — guess from model name
    return { provider: guessProvider(modelStr), model: modelStr };
  }
  return {
    provider: modelStr.slice(0, colonIdx),
    model: modelStr.slice(colonIdx + 1),
  };
}

function guessProvider(model: string): string {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  if (model.startsWith("gemini")) return "google";
  if (model.startsWith("llama") || model.startsWith("mistral") || model.startsWith("qwen")) return "ollama";
  return "openai"; // Default fallback
}

/** Create a provider from a config */
export function createProvider(config: ProviderConfig): LLMProvider {
  const apiKey =
    config.apiKey ??
    getEnvKey(config.provider) ??
    "";

  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config.model, apiKey, config.baseUrl);
    case "openai":
      return new OpenAIProvider(config.model, apiKey, config.baseUrl);
    case "google":
      return new GoogleProvider(config.model, apiKey, config.baseUrl);
    case "ollama":
      return new OllamaProvider(config.model, config.baseUrl);
    case "openrouter":
      return new OpenRouterProvider(config.model, apiKey, config.baseUrl);
    default:
      // Any unknown provider → try OpenAI-compatible API
      return new OpenAIProvider(config.model, apiKey, config.baseUrl);
  }
}

function getEnvKey(provider: string): string | undefined {
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  const envVar = envMap[provider];
  return envVar ? process.env[envVar] : undefined;
}

// ── Anthropic Provider ────────────────────────────────────

class AnthropicProvider implements LLMProvider {
  name: string;
  private model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: string, apiKey: string, baseUrl?: string) {
    this.name = `anthropic:${model}`;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? "https://api.anthropic.com";
  }

  async complete(
    messages: Message[],
    tools: ToolSchema[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<LLMResponse> {
    // Separate system message from conversation
    const systemMsg = messages.find((m) => m.role === "system");
    const convMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => this.toAnthropicMessage(m));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 8192,
      messages: convMessages,
    };

    // Add cache_control to system prompt (static content)
    if (systemMsg) {
      body.system = {
        type: "text",
        text: systemMsg.content,
        cache_control: { type: "ephemeral" },
      };
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    // Add cache_control to tools (static schemas)
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        cache_control: { type: "ephemeral" },
      }));
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      const retryAfter = res.headers.get("retry-after");
      const retryHint = retryAfter ? ` retry-after: ${retryAfter}` : "";
      throw new Error(`Anthropic API error (${res.status}):${retryHint} ${errorText}`);
    }

    const data = await res.json() as AnthropicResponse;
    return this.parseAnthropicResponse(data);
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // Model-specific pricing (USD per token)
    const pricing: Record<string, [number, number]> = {
      "claude-opus-4-20250514":         [15.0  / 1e6, 75.0  / 1e6],
      "claude-sonnet-4-20250514":       [3.0   / 1e6, 15.0  / 1e6],
      "claude-3-5-haiku-20241022":  [1.0   / 1e6, 5.0   / 1e6],
      "claude-3-5-sonnet-20241022": [3.0   / 1e6, 15.0  / 1e6],
    };
    const [inputRate, outputRate] = pricing[this.model] ?? [3.0 / 1e6, 15.0 / 1e6];
    return inputTokens * inputRate + outputTokens * outputRate;
  }

  private toAnthropicMessage(msg: Message): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const content: unknown[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      return { role: "assistant", content };
    }

    if (msg.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: msg.content,
          },
        ],
      };
    }

    return { role: msg.role, content: msg.content };
  }

  private parseAnthropicResponse(data: AnthropicResponse): LLMResponse {
    let content = "";
    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

    for (const block of data.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        costUsd: this.estimateCost(data.usage.input_tokens, data.usage.output_tokens),
      },
      raw: data,
    };
  }
}

// ── OpenAI Provider ───────────────────────────────────────

class OpenAIProvider implements LLMProvider {
  name: string;
  private model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: string, apiKey: string, baseUrl?: string) {
    this.name = `openai:${model}`;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? "https://api.openai.com";
  }

  async complete(
    messages: Message[],
    tools: ToolSchema[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => this.toOpenAIMessage(m)),
    };

    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      const retryAfter = res.headers.get("retry-after");
      const retryHint = retryAfter ? ` retry-after: ${retryAfter}` : "";
      throw new Error(`OpenAI API error (${res.status}):${retryHint} ${errorText}`);
    }

    const data = await res.json() as OpenAIResponse;
    return this.parseOpenAIResponse(data);
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    const pricing: Record<string, [number, number]> = {
      "gpt-4o":          [2.5  / 1e6, 10.0  / 1e6],
      "gpt-4o-mini":     [0.15 / 1e6, 0.6   / 1e6],
      "gpt-4-turbo":     [10.0 / 1e6, 30.0  / 1e6],
      "o1":              [15.0 / 1e6, 60.0  / 1e6],
      "o1-mini":         [3.0  / 1e6, 12.0  / 1e6],
      "o3":              [10.0 / 1e6, 40.0  / 1e6],
      "o3-mini":         [1.1  / 1e6, 4.4   / 1e6],
      "o4-mini":         [1.1  / 1e6, 4.4   / 1e6],
    };
    const [inputRate, outputRate] = pricing[this.model] ?? [2.5 / 1e6, 10.0 / 1e6];
    return inputTokens * inputRate + outputTokens * outputRate;
  }

  private toOpenAIMessage(msg: Message): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }

    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      };
    }

    return { role: msg.role, content: msg.content };
  }

  private parseOpenAIResponse(data: any): LLMResponse {
    if (data.error) {
      const errorMsg = data.error?.message || JSON.stringify(data.error);
      throw new Error(`OpenAI/OpenRouter Error: ${errorMsg}`);
    }

    const choice = data.choices[0];
    const toolCalls =
      choice.message.tool_calls?.map(
        (tc: { id: string; function: { name: string; arguments: string } }) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }),
      ) ?? [];

    return {
      content: choice.message.content ?? "",
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        costUsd: this.estimateCost(
          data.usage?.prompt_tokens ?? 0,
          data.usage?.completion_tokens ?? 0,
        ),
      },
      raw: data,
    };
  }
}

// ── Google Gemini Provider ────────────────────────────────

class GoogleProvider implements LLMProvider {
  name: string;
  private model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: string, apiKey: string, baseUrl?: string) {
    this.name = `google:${model}`;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl =
      baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async complete(
    messages: Message[],
    tools: ToolSchema[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<LLMResponse> {
    const systemMsg = messages.find((m) => m.role === "system");
    const convMessages = messages.filter((m) => m.role !== "system");

    const contents = convMessages.map((m) => this.toGeminiContent(m));

    const body: Record<string, unknown> = { contents };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    if (options?.temperature !== undefined || options?.maxTokens) {
      body.generationConfig = {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens && { maxOutputTokens: options.maxTokens }),
      };
    }

    if (tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      const retryAfter = res.headers.get("retry-after");
      const retryHint = retryAfter ? ` retry-after: ${retryAfter}` : "";
      throw new Error(`Google API error (${res.status}):${retryHint} ${errorText}`);
    }

    const data = await res.json() as GeminiResponse;
    return this.parseGeminiResponse(data);
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    const pricing: Record<string, [number, number]> = {
      "gemini-2.5-pro":    [1.25 / 1e6, 10.0 / 1e6],
      "gemini-2.5-flash":  [0.15 / 1e6, 0.6  / 1e6],
      "gemini-2.0-flash":  [0.1  / 1e6, 0.4  / 1e6],
      "gemini-3.0-pro":    [1.25 / 1e6, 10.0 / 1e6],
      "gemini-3.0-flash":  [0.15 / 1e6, 0.6  / 1e6],
      "gemini-3.1-flash-lite-preview": [0.02 / 1e6, 0.1 / 1e6],
    };
    const [inputRate, outputRate] = pricing[this.model] ?? [1.25 / 1e6, 5.0 / 1e6];
    return inputTokens * inputRate + outputTokens * outputRate;
  }

  private toGeminiContent(msg: Message): Record<string, unknown> {
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "tool") {
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.name,
              response: { content: msg.content },
            },
          },
        ],
      };
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const parts: unknown[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
        });
      }
      return { role: "model", parts };
    }

    return { role, parts: [{ text: msg.content }] };
  }

  private parseGeminiResponse(data: GeminiResponse): LLMResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      return {
        content: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    }

    let content = "";
    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    const usage = data.usageMetadata ?? {};

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        costUsd: this.estimateCost(
          usage.promptTokenCount ?? 0,
          usage.candidatesTokenCount ?? 0,
        ),
      },
      raw: data,
    };
  }
}

// ── Ollama Provider (Local) ───────────────────────────────

class OllamaProvider implements LLMProvider {
  name: string;
  private model: string;
  private baseUrl: string;

  constructor(model: string, baseUrl?: string) {
    this.name = `ollama:${model}`;
    this.model = model;
    this.baseUrl = baseUrl ?? "http://localhost:11434";
  }

  async complete(
    messages: Message[],
    tools: ToolSchema[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<LLMResponse> {
    // Ollama uses OpenAI-compatible API
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    };

    if (options?.temperature !== undefined) body.temperature = options.temperature;

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${errorText}`);
    }

    const data = await res.json() as OllamaResponse;

    const toolCalls =
      data.message?.tool_calls?.map(
        (tc: { function: { name: string; arguments: Record<string, unknown> } }) => ({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }),
      ) ?? [];

    return {
      content: data.message?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        costUsd: 0, // Local = free
      },
      raw: data,
    };
  }

  estimateCost(): number {
    return 0; // Local inference is free
  }
}

// ── OpenRouter Provider ───────────────────────────────────

class OpenRouterProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string, baseUrl?: string) {
    super(model, apiKey, baseUrl ?? "https://openrouter.ai/api");
  }
}

// ── Model Listing ───────────────────────────────────────────

export async function listModels(provider: string, apiKey?: string): Promise<string[]> {
  const models: string[] = [];

  switch (provider) {
    case "anthropic": {
      const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!key) return DEFAULT_MODELS.anthropic;

      try {
        const response = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        });
        const data = await response.json();
        if (data.data) {
          for (const model of data.data) {
            models.push(model.id);
          }
        }
      } catch {
        return DEFAULT_MODELS.anthropic;
      }
      break;
    }

    case "openai": {
      const key = apiKey ?? process.env.OPENAI_API_KEY;
      if (!key) return DEFAULT_MODELS.openai;

      try {
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { "Authorization": `Bearer ${key}` },
        });
        const data = await response.json();
        if (data.data) {
          for (const model of data.data) {
            models.push(model.id);
          }
        }
      } catch {
        return DEFAULT_MODELS.openai;
      }
      break;
    }

    case "google": {
      const key = apiKey ?? process.env.GOOGLE_API_KEY;
      if (!key) return DEFAULT_MODELS.google;
      // Google doesn't have a public models endpoint, use defaults
      return DEFAULT_MODELS.google;
    }

    case "ollama": {
      try {
        const response = await fetch("http://localhost:11434/api/tags");
        const data = await response.json();
        if (data.models) {
          for (const model of data.models) {
            models.push(model.name);
          }
        }
      } catch {
        return DEFAULT_MODELS.ollama;
      }
      break;
    }

    case "openrouter": {
      try {
        const headers: Record<string, string> = {};
        const key = apiKey ?? process.env.OPENROUTER_API_KEY;
        if (key) {
          headers["Authorization"] = `Bearer ${key}`;
        }

        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers,
        });
        const data = await response.json();
        if (data.data) {
          for (const model of data.data) {
            models.push(model.id);
          }
        }
      } catch {
        return DEFAULT_MODELS.openrouter;
      }
      break;
    }

    default:
      return [];
  }

  return models.length > 0 ? models : DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS] || [];
}

const DEFAULT_MODELS: Record<string, string[]> = {
  anthropic: [
    "claude-sonnet-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
  ],
  google: [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-pro",
  ],
  ollama: [
    "llama3.3",
    "qwen2.5",
    "mistral",
  ],
  openrouter: [
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o",
    "google/gemini-2.5-flash",
  ],
};

// ── Type definitions for API responses ────────────────────

interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  usage: { input_tokens: number; output_tokens: number };
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args?: unknown };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface OllamaResponse {
  message?: {
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}
