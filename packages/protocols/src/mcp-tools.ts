/**
 * Nexus MCP Management Tools
 *
 * Agent-callable tools for managing MCP server configurations.
 * These let the agent (or user via agent) add/remove/list/test MCP servers.
 */

import type { Tool } from "@nexus/core";
import type { McpConfigStore } from "./mcp-config.js";
import type { McpManager } from "./mcp-manager.js";

export function createMcpManagementTools(
  configStore: McpConfigStore,
  manager: McpManager,
): Tool[] {

  const mcpListTool: Tool = {
    schema: {
      name: "mcp_list_servers",
      description: "List all configured MCP servers, their connection status, and available tool counts.",
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      const all = configStore.getAll();
      if (all.length === 0) {
        return "No MCP servers configured. Use mcp_add_server to add one.";
      }
      const statuses = manager.getStatuses();
      const statusMap = new Map(statuses.map((s) => [s.id, s]));

      const lines = all.map(({ id, config }) => {
        const st = statusMap.get(id);
        const statusIcon = !config.enabled ? "○ disabled"
          : st?.connected ? `✓ connected (${st.toolCount} tools)`
          : `✗ ${st?.error ?? "not connected"}`;
        const transport = config.transport === "stdio"
          ? `stdio: ${config.command} ${(config.args ?? []).join(" ")}`
          : `${config.transport}: ${config.url}`;
        return `[${id}] ${config.name}\n  ${statusIcon}\n  ${transport}${st?.connectDurationMs ? ` · ${st.connectDurationMs}ms` : ""}`;
      });
      return `${all.length} MCP server(s):\n\n${lines.join("\n\n")}`;
    },
  };

  const mcpAddStdioTool: Tool = {
    schema: {
      name: "mcp_add_server",
      description:
        "Add a new MCP server to the configuration. Supports stdio (subprocess) and HTTP/SSE transports. " +
        "After adding, the server will be connected immediately and its tools made available.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique identifier for this server (e.g. 'github', 'filesystem')" },
          name: { type: "string", description: "Human-readable display name" },
          transport: {
            type: "string",
            enum: ["stdio", "sse", "http"],
            description: "Transport type: stdio (subprocess), sse (Server-Sent Events), http (StreamableHTTP)",
          },
          command: { type: "string", description: "Command to run (stdio only, e.g. 'npx')" },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments (stdio only, e.g. ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])",
          },
          url: { type: "string", description: "Server URL (sse or http transport)" },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Environment variables to pass to the server. Supports ${ENV_VAR} interpolation.",
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "HTTP headers (sse/http transport). Supports ${ENV_VAR} interpolation.",
          },
          include_tools: {
            type: "array",
            items: { type: "string" },
            description: "Only expose these tool names (optional whitelist)",
          },
          exclude_tools: {
            type: "array",
            items: { type: "string" },
            description: "Hide these tool names (optional blacklist)",
          },
          timeout_ms: { type: "number", description: "Per-call timeout ms (default 30000)" },
        },
        required: ["id", "name", "transport"],
      },
    },
    async execute(args) {
      const id = String(args.id).replace(/[^a-zA-Z0-9_-]/g, "_");
      const transport = String(args.transport) as "stdio" | "sse" | "http";

      if (transport === "stdio" && !args.command) {
        return JSON.stringify({ error: "stdio transport requires 'command'" });
      }
      if ((transport === "sse" || transport === "http") && !args.url) {
        return JSON.stringify({ error: `${transport} transport requires 'url'` });
      }

      const cfg = configStore.add(id, {
        name: String(args.name),
        transport,
        command: args.command ? String(args.command) : undefined,
        args: Array.isArray(args.args) ? args.args.map(String) : undefined,
        url: args.url ? String(args.url) : undefined,
        env: args.env as Record<string, string> | undefined,
        headers: args.headers as Record<string, string> | undefined,
        enabled: true,
        timeoutMs: args.timeout_ms ? Number(args.timeout_ms) : undefined,
        tools:
          args.include_tools || args.exclude_tools
            ? {
                include: Array.isArray(args.include_tools) ? args.include_tools.map(String) : undefined,
                exclude: Array.isArray(args.exclude_tools) ? args.exclude_tools.map(String) : undefined,
              }
            : undefined,
      });

      // Immediately try to connect
      let connectResult = "";
      try {
        const status = await manager.connect(id);
        connectResult = status.connected
          ? `Connected successfully — ${status.toolCount} tool(s) available.`
          : `Failed to connect: ${status.error}`;
      } catch (err: any) {
        connectResult = `Connection failed: ${err.message}`;
      }

      return `Added MCP server "${cfg.name}" (id: ${id})\n${connectResult}\n\nConfig saved to: ${configStore.configFilePath}`;
    },
  };

  const mcpRemoveTool: Tool = {
    schema: {
      name: "mcp_remove_server",
      description: "Remove an MCP server from the configuration.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Server ID (from mcp_list_servers)" },
        },
        required: ["id"],
      },
    },
    async execute(args) {
      const id = String(args.id);
      await manager.disconnect(id);
      const removed = configStore.remove(id);
      return removed ? `Removed MCP server "${id}".` : `No server with id "${id}".`;
    },
  };

  const mcpToggleTool: Tool = {
    schema: {
      name: "mcp_toggle_server",
      description: "Enable or disable an MCP server without removing it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Server ID" },
          enabled: { type: "boolean", description: "true to enable, false to disable" },
        },
        required: ["id", "enabled"],
      },
    },
    async execute(args) {
      const id = String(args.id);
      const enabled = Boolean(args.enabled);

      if (!enabled) {
        await manager.disconnect(id);
      }

      const ok = configStore.toggle(id, enabled);
      if (!ok) return `No server with id "${id}".`;

      if (enabled) {
        try {
          const status = await manager.connect(id);
          return `Server "${id}" enabled. ${status.connected ? `Connected — ${status.toolCount} tools.` : `Connection failed: ${status.error}`}`;
        } catch (err: any) {
          return `Server "${id}" enabled but connection failed: ${err.message}`;
        }
      }

      return `Server "${id}" disabled.`;
    },
  };

  const mcpTestTool: Tool = {
    schema: {
      name: "mcp_test_server",
      description: "Test connection to an MCP server and list its available tools.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Server ID to test" },
        },
        required: ["id"],
      },
    },
    async execute(args) {
      const id = String(args.id);
      const cfg = configStore.get(id);
      if (!cfg) return `No server with id "${id}".`;

      try {
        const status = await manager.connect(id);
        if (!status.connected) {
          return `Connection failed: ${status.error}`;
        }

        const tools = manager.getServerTools(id);
        const toolLines = tools.slice(0, 20).map((t) => `  • ${t.schema.name}`);
        if (tools.length > 20) toolLines.push(`  … and ${tools.length - 20} more`);

        return (
          `✓ Connected to "${cfg.name}" in ${status.connectDurationMs}ms\n` +
          `Transport: ${cfg.transport}\n` +
          `Tools (${tools.length}):\n${toolLines.join("\n")}`
        );
      } catch (err: any) {
        return `✗ Connection failed: ${err.message}`;
      }
    },
  };

  const mcpListToolsTool: Tool = {
    schema: {
      name: "mcp_list_tools",
      description: "List all tools available from a specific MCP server.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Server ID (leave empty to list all MCP tools)" },
        },
      },
    },
    async execute(args) {
      const id = args.id ? String(args.id) : null;
      const tools = id ? manager.getServerTools(id) : manager.getAllTools();

      if (tools.length === 0) {
        return id ? `No tools from server "${id}". Is it connected?` : "No MCP tools available.";
      }

      const lines = tools.map((t) => `• ${t.schema.name}\n  ${(t.schema.description ?? "").slice(0, 100)}`);
      return `${tools.length} tool(s)${id ? ` from "${id}"` : " (all MCP servers)"}:\n\n${lines.join("\n\n")}`;
    },
  };

  return [mcpListTool, mcpAddStdioTool, mcpRemoveTool, mcpToggleTool, mcpTestTool, mcpListToolsTool];
}
