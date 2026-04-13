import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { McpConfigStore, McpManager } from "@nexus/protocols";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("integration: fake MCP server", () => {
  it("connects to a stdio MCP server and executes a namespaced tool", async () => {
    const home = mkdtempSync(join(tmpdir(), "nexus-fake-mcp-"));
    const store = new McpConfigStore(join(home, "mcp.json"));
    const serverPath = join(__dirname, "..", "fixtures", "fake-mcp-server.mjs");

    store.add("fake", {
      name: "Fake MCP",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      enabled: true,
      timeoutMs: 5000,
      connectTimeoutMs: 5000,
    });

    const manager = new McpManager(store);
    try {
      const statuses = await manager.connectAll(5000);
      expect(statuses[0]?.connected).toBe(true);
      expect(statuses[0]?.toolCount).toBe(1);

      const tool = manager.getAllTools().find((candidate) => candidate.schema.name === "mcp_fake_echo");
      expect(tool).toBeDefined();

      const output = await tool!.execute({ message: "ok" });
      expect(output).toBe("echo:ok");
    } finally {
      await manager.disconnectAll();
    }
  });
});
