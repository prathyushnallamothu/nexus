import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NexusAgent, writeFileTool, readFileTool, type LLMProvider, type LLMResponse } from "@nexus/core";

function response(partial: Partial<LLMResponse>): LLMResponse {
  return {
    content: partial.content ?? "",
    toolCalls: partial.toolCalls ?? [],
    usage: partial.usage ?? { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
  };
}

describe("integration: fake LLM provider", () => {
  it("executes a deterministic tool workflow without a live provider", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "nexus-fake-llm-"));
    const filePath = join(workdir, "result.txt");
    const responses = [
      response({
        toolCalls: [
          {
            id: "call_write",
            name: "write_file",
            arguments: { path: filePath, content: "hello from fake llm" },
          },
        ],
      }),
      response({
        toolCalls: [
          {
            id: "call_read",
            name: "read_file",
            arguments: { path: filePath },
          },
        ],
      }),
      response({ content: "Workflow complete." }),
    ];

    let idx = 0;
    const provider: LLMProvider = {
      name: "fake",
      async complete() {
        return responses[idx++] ?? response({ content: "done" });
      },
      estimateCost(inputTokens, outputTokens) {
        return (inputTokens + outputTokens) / 1_000_000;
      },
    };

    const agent = new NexusAgent({
      config: {
        model: "fake:test",
        systemPrompt: "Use tools deterministically.",
        tools: [writeFileTool, readFileTool],
        middleware: [],
        maxIterations: 5,
        maxContextTokens: 32000,
      },
      provider,
    });

    const result = await agent.run("write and read a file");
    expect(result.response).toBe("Workflow complete.");
    expect(result.budget.toolCalls).toBe(2);
    expect(readFileSync(filePath, "utf-8")).toBe("hello from fake llm");
  });
});
