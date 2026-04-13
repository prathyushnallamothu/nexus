/**
 * Nexus Core Agent Tests
 *
 * Tests for the hardened agent loop: retry, parallel tools,
 * context compression, budget enforcement, abort handling.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { NexusAgent } from "../../packages/core/src/agent.js";
import type {
  AgentEvent,
  LLMProvider,
  LLMResponse,
  Message,
  Tool,
  ToolSchema,
} from "../../packages/core/src/types.js";

// ── Mock Provider ─────────────────────────────────────────

function createMockProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    async complete() {
      const resp = responses[callIndex % responses.length];
      callIndex++;
      return resp;
    },
    estimateCost(inputTokens: number, outputTokens: number) {
      return (inputTokens + outputTokens) * 0.000001;
    },
  };
}

function textResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
  };
}

function toolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  content = "",
): LLMResponse {
  return {
    content,
    toolCalls: [
      { id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: toolName, arguments: args },
    ],
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
  };
}

// ── Mock Tool ─────────────────────────────────────────────

function createMockTool(name: string, result: string, delay = 0): Tool {
  return {
    schema: {
      name,
      description: `Mock tool: ${name}`,
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return result;
    },
  };
}

function createFailingTool(name: string, error: string): Tool {
  return {
    schema: {
      name,
      description: `Failing mock tool: ${name}`,
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      throw new Error(error);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────

describe("NexusAgent: Core", () => {
  it("should return a text response from the LLM", async () => {
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "You are a test agent",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([textResponse("Hello, world!")]),
    });

    const result = await agent.run("Hi");
    expect(result.response).toBe("Hello, world!");
    expect(result.budget.llmCalls).toBe(1);
    expect(result.budget.spentUsd).toBeGreaterThan(0);
  });

  it("should execute tools and return final response", async () => {
    const mockTool = createMockTool("test_tool", "tool result");
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [mockTool],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        toolCallResponse("test_tool", {}),
        textResponse("Done with tools"),
      ]),
    });

    const result = await agent.run("Do something");
    expect(result.response).toBe("Done with tools");
    expect(result.budget.llmCalls).toBe(2);
    expect(result.budget.toolCalls).toBe(1);
  });

  it("should handle tool errors gracefully", async () => {
    const failingTool = createFailingTool("bad_tool", "kaboom");
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [failingTool],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        toolCallResponse("bad_tool", {}),
        textResponse("Handled the error"),
      ]),
    });

    const result = await agent.run("Break things");
    expect(result.response).toBe("Handled the error");
    // The error should be in the messages as a tool result
    const toolMsg = result.messages.find(
      (m) => m.role === "tool" && m.content.includes("kaboom"),
    );
    expect(toolMsg).toBeDefined();
  });

  it("should report 'tool not found' for unknown tool calls", async () => {
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        toolCallResponse("nonexistent_tool", {}),
        textResponse("Recovered"),
      ]),
    });

    const result = await agent.run("Call missing tool");
    const errorMsg = result.messages.find(
      (m) => m.role === "tool" && m.content.includes("not found"),
    );
    expect(errorMsg).toBeDefined();
  });
});

describe("NexusAgent: Budget Enforcement", () => {
  it("should stop when budget is exceeded", async () => {
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 100,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        {
          content: "",
          toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
          usage: { inputTokens: 1000, outputTokens: 1000, costUsd: 0.5 },
        },
        {
          content: "",
          toolCalls: [{ id: "c2", name: "noop", arguments: {} }],
          usage: { inputTokens: 1000, outputTokens: 1000, costUsd: 0.6 },
        },
        textResponse("Should not reach this"),
      ]),
    });

    const result = await agent.run("Expensive task");
    // Budget is $1 default, two calls at $0.5 and $0.6 should exceed
    expect(result.budget.spentUsd).toBeGreaterThanOrEqual(1.0);
  });

  it("should track costs accurately", async () => {
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([textResponse("hi")]),
    });

    const result = await agent.run("Test cost");
    expect(result.budget.spentUsd).toBe(0.001);
    expect(result.budget.tokensIn).toBe(100);
    expect(result.budget.tokensOut).toBe(50);
  });
});

describe("NexusAgent: Iteration Limiting", () => {
  it("should stop after maxIterations", async () => {
    // Provider always returns tool calls — agent should stop at maxIterations
    const neverDoneTool = createMockTool("loop_tool", "keep going");
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [neverDoneTool],
        middleware: [],
        maxIterations: 3,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        toolCallResponse("loop_tool", {}),
      ]),
    });

    const result = await agent.run("Run forever");
    expect(result.hitIterationLimit).toBe(true);
    expect(result.budget.llmCalls).toBeLessThanOrEqual(4); // 3 loop calls + recovery summary
    expect(result.response).toContain("Reached iteration limit");
  });
});

describe("NexusAgent: Parallel Tool Execution", () => {
  it("should execute multiple tool calls concurrently", async () => {
    const startTime = Date.now();
    const slowTool1 = createMockTool("slow1", "result1", 100);
    const slowTool2 = createMockTool("slow2", "result2", 100);

    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [slowTool1, slowTool2],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        {
          content: "",
          toolCalls: [
            { id: "c1", name: "slow1", arguments: {} },
            { id: "c2", name: "slow2", arguments: {} },
          ],
          usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.001 },
        },
        textResponse("Done"),
      ]),
    });

    const result = await agent.run("Run parallel");
    const elapsed = Date.now() - startTime;

    // If run in parallel, should take ~100ms, not ~200ms
    // Allow generous margin for CI
    expect(elapsed).toBeLessThan(500);
    expect(result.budget.toolCalls).toBe(2);

    // Both tool results should be in messages
    const toolResults = result.messages.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(2);
  });
});

describe("NexusAgent: Retry Logic", () => {
  it("should retry on retryable errors", async () => {
    let callCount = 0;
    const flaky: LLMProvider = {
      name: "flaky",
      async complete() {
        callCount++;
        if (callCount === 1) throw new Error("API error (429): rate limit exceeded");
        return textResponse("Recovered!");
      },
      estimateCost() { return 0.001; },
    };

    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: flaky,
      retry: { baseDelayMs: 10, maxDelayMs: 50 }, // Fast retries for test
    });

    const result = await agent.run("Retry me");
    expect(result.response).toBe("Recovered!");
    expect(callCount).toBe(2);
  });

  it("should not retry on non-retryable errors", async () => {
    let callCount = 0;
    const broken: LLMProvider = {
      name: "broken",
      async complete() {
        callCount++;
        throw new Error("Invalid API key");
      },
      estimateCost() { return 0; },
    };

    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: broken,
      retry: { baseDelayMs: 10 },
    });

    const result = await agent.run("Fail fast");
    // Should see the abort
    expect(result.response).toContain("no response");
    expect(callCount).toBe(1); // No retries
  });

  it("should give up after max retry attempts", async () => {
    let callCount = 0;
    const alwaysFails: LLMProvider = {
      name: "always-fails",
      async complete() {
        callCount++;
        throw new Error("API error (500): server error");
      },
      estimateCost() { return 0; },
    };

    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: alwaysFails,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
    });

    const result = await agent.run("Never works");
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });
});

describe("NexusAgent: Context Compression", () => {
  it("should compress context when approaching token limit", async () => {
    // Create a situation where context is very large
    const longHistory: Message[] = [];
    for (let i = 0; i < 50; i++) {
      longHistory.push({
        role: "user",
        content: `This is a long message number ${i} with lots of content to fill up the context window. `.repeat(20),
      });
      longHistory.push({
        role: "assistant",
        content: `This is response number ${i} with detailed information about the topic. `.repeat(15),
      });
    }

    let contextCompressed = false;
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 4000, // Very small limit to trigger compression
      },
      provider: createMockProvider([textResponse("Compressed response")]),
      onEvent: (event) => {
        if (event.type === "context.compressed") {
          contextCompressed = true;
        }
      },
    });

    const result = await agent.run("New message", longHistory);
    expect(contextCompressed).toBe(true);
  });

  it("should preserve system prompt and recent messages during compression", async () => {
    const longHistory: Message[] = [];
    for (let i = 0; i < 30; i++) {
      longHistory.push({
        role: "user",
        content: "x".repeat(500),
      });
      longHistory.push({
        role: "assistant",
        content: "y".repeat(500),
      });
    }

    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "SYSTEM_PROMPT_MARKER",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 4000,
      },
      provider: createMockProvider([textResponse("ok")]),
    });

    const result = await agent.run("Last message", longHistory);

    // System prompt should still be there
    const hasSystem = result.messages.some(
      (m) => m.role === "system" && m.content.includes("SYSTEM_PROMPT_MARKER"),
    );
    expect(hasSystem).toBe(true);

    // Post-compression, message count should be much less than 30*2 + 2
    expect(result.messages.length).toBeLessThan(20);
  });
});

describe("NexusAgent: Events", () => {
  it("should emit all expected events for a simple conversation", async () => {
    const events: AgentEvent[] = [];
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([textResponse("hi")]),
      onEvent: (e) => events.push(e),
    });

    await agent.run("Hello");

    const types = events.map((e) => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("message.user");
    expect(types).toContain("llm.call.start");
    expect(types).toContain("llm.call.end");
    expect(types).toContain("message.assistant");
    expect(types).toContain("session.end");
  });

  it("should emit tool events during tool execution", async () => {
    const events: AgentEvent[] = [];
    const mockTool = createMockTool("test_tool", "ok");

    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [mockTool],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([
        toolCallResponse("test_tool", { x: 1 }),
        textResponse("done"),
      ]),
      onEvent: (e) => events.push(e),
    });

    await agent.run("Use tool");

    const types = events.map((e) => e.type);
    expect(types).toContain("tool.call.start");
    expect(types).toContain("tool.call.end");
  });
});

describe("NexusAgent: Token Estimation", () => {
  it("should estimate tokens correctly", () => {
    const agent = new NexusAgent({
      config: {
        model: "mock",
        systemPrompt: "test",
        tools: [],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider: createMockProvider([]),
    });

    const messages: Message[] = [
      { role: "system", content: "a".repeat(400) }, // ~100 tokens + overhead
      { role: "user", content: "b".repeat(200) },   // ~50 tokens + overhead
    ];

    const estimate = agent.estimateTokens(messages);
    expect(estimate).toBeGreaterThan(140); // At least the raw char count / 4
    expect(estimate).toBeLessThan(200);    // Not wildly inflated
  });
});
