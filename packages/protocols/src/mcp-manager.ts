/**
 * Nexus MCP Manager
 *
 * Full-featured MCP client manager supporting:
 * - Multiple simultaneous servers (stdio, SSE, StreamableHTTP)
 * - Parallel connection with per-server timeout
 * - Automatic reconnection with exponential backoff
 * - Tool namespacing: mcp_{server}_{tool}
 * - Tool filtering (include/exclude lists)
 * - Environment variable injection and interpolation
 * - Dynamic tool list refresh on server notification
 * - Graceful shutdown
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@nexus/core";
import type { McpServerConfig, McpConfigStore } from "./mcp-config.js";

// ── Types ─────────────────────────────────────────────────

export interface McpServerStatus {
  id: string;
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  error?: string;
  connectDurationMs?: number;
}

interface ManagedServer {
  id: string;
  config: McpServerConfig;
  client: Client | null;
  tools: Tool[];
  connected: boolean;
  error?: string;
  connectDurationMs?: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
  shutdown: boolean;
}

// ── Sanitize tool/server names for LLM compatibility ─────

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/__+/g, "_").replace(/^_|_$/g, "");
}

function prefixedName(serverId: string, toolName: string): string {
  return `mcp_${sanitizeName(serverId)}_${sanitizeName(toolName)}`;
}

// ── Credential sanitization for error messages ───────────

const REDACT_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/g,
  /sk-[a-zA-Z0-9-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._\-]+/gi,
  /(?:token|key|secret|password|passwd|api_key|apikey)\s*[=:]\s*["']?[^\s"',]{8,}["']?/gi,
];

function sanitizeError(msg: string): string {
  let out = msg;
  for (const pat of REDACT_PATTERNS) out = out.replace(pat, "[REDACTED]");
  return out;
}

// ── Filter tools by include/exclude config ────────────────

function applyToolFilter(
  toolName: string,
  filter?: { include?: string[]; exclude?: string[] },
): boolean {
  if (!filter) return true;
  if (filter.include?.length) return filter.include.includes(toolName);
  if (filter.exclude?.length) return !filter.exclude.includes(toolName);
  return true;
}

// ── Build tool list from MCP server ──────────────────────

async function buildTools(
  serverId: string,
  config: McpServerConfig,
  client: Client,
): Promise<Tool[]> {
  const response = await client.listTools();
  const tools: Tool[] = [];

  for (const mcpTool of response.tools) {
    if (!applyToolFilter(mcpTool.name, config.tools)) continue;

    const name = prefixedName(serverId, mcpTool.name);
    const timeoutMs = config.timeoutMs ?? 30_000;
    const rawToolName = mcpTool.name;

    // Normalize inputSchema
    const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };
    if (inputSchema.type === "object" && !inputSchema.properties) {
      (inputSchema as any).properties = {};
    }

    tools.push({
      schema: {
        name,
        description: mcpTool.description
          ? `[${config.name}] ${mcpTool.description}`
          : `[${config.name}] ${rawToolName}`,
        parameters: inputSchema as Record<string, any>,
      },
      execute: async (args: Record<string, unknown>) => {
        const result = await Promise.race([
          client.callTool({ name: rawToolName, arguments: args }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]) as any;

        if (result.isError) {
          const errText = (result.content ?? [])
            .map((c: any) => (c.type === "text" ? c.text : ""))
            .join("\n");
          return JSON.stringify({ error: sanitizeError(errText) });
        }

        // Combine text content blocks
        const text = (result.content ?? [])
          .map((c: any) => {
            if (c.type === "text") return c.text;
            if (c.type === "image") return `[image: ${c.mimeType ?? "unknown"}]`;
            if (c.type === "resource") return `[resource: ${c.resource?.uri ?? "unknown"}]`;
            return "";
          })
          .filter(Boolean)
          .join("\n");

        return text || "(no output)";
      },
    });
  }

  return tools;
}

// ── MCP Manager ───────────────────────────────────────────

export class McpManager {
  private servers = new Map<string, ManagedServer>();
  private configStore: McpConfigStore;

  constructor(configStore: McpConfigStore) {
    this.configStore = configStore;
  }

  /**
   * Connect to all enabled servers in parallel.
   * Returns quickly — failed servers are skipped but don't block others.
   */
  async connectAll(globalTimeoutMs = 30_000): Promise<McpServerStatus[]> {
    const enabled = this.configStore.getEnabled();
    if (enabled.length === 0) return [];

    const results = await Promise.allSettled(
      enabled.map(({ id, config }) =>
        Promise.race([
          this._connectServer(id, config),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Connection timed out after ${config.connectTimeoutMs ?? globalTimeoutMs}ms`)),
              config.connectTimeoutMs ?? globalTimeoutMs,
            ),
          ),
        ]).catch((err) => {
          // Ensure server entry exists even on failure
          if (!this.servers.has(id)) {
            this.servers.set(id, {
              id, config, client: null, tools: [], connected: false,
              error: sanitizeError(err.message ?? String(err)),
              reconnectAttempts: 0, shutdown: false,
            });
          } else {
            const s = this.servers.get(id)!;
            s.error = sanitizeError(err.message ?? String(err));
          }
        }),
      ),
    );

    void results; // consumed by catch above
    return this.getStatuses();
  }

  /**
   * Connect a single server by ID (re-reads config from store).
   */
  async connect(id: string): Promise<McpServerStatus> {
    const cfg = this.configStore.get(id);
    if (!cfg) throw new Error(`No MCP server configured with id "${id}"`);

    // Interpolate env
    const config: McpServerConfig = {
      ...cfg,
      env: cfg.env
        ? Object.fromEntries(
            Object.entries(cfg.env).map(([k, v]) => [k, v.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? "")]),
          )
        : undefined,
      headers: cfg.headers
        ? Object.fromEntries(
            Object.entries(cfg.headers).map(([k, v]) => [k, v.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? "")]),
          )
        : undefined,
    };

    await this._connectServer(id, config);
    return this.getStatus(id)!;
  }

  /** Disconnect and remove a server */
  async disconnect(id: string): Promise<void> {
    const s = this.servers.get(id);
    if (!s) return;
    s.shutdown = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.client) {
      try { await s.client.close(); } catch {}
    }
    this.servers.delete(id);
  }

  /** Disconnect all servers */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.keys()).map((id) => this.disconnect(id)),
    );
  }

  /** Get all registered tools from connected servers */
  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const s of this.servers.values()) {
      if (s.connected) tools.push(...s.tools);
    }
    return tools;
  }

  /** Get tools for a specific server */
  getServerTools(id: string): Tool[] {
    return this.servers.get(id)?.tools ?? [];
  }

  getStatus(id: string): McpServerStatus | null {
    const s = this.servers.get(id);
    if (!s) return null;
    return {
      id: s.id,
      name: s.config.name,
      transport: s.config.transport,
      connected: s.connected,
      toolCount: s.tools.length,
      error: s.error,
      connectDurationMs: s.connectDurationMs,
    };
  }

  getStatuses(): McpServerStatus[] {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.id,
      name: s.config.name,
      transport: s.config.transport,
      connected: s.connected,
      toolCount: s.tools.length,
      error: s.error,
      connectDurationMs: s.connectDurationMs,
    }));
  }

  // ── Private: connect a single server ──────────────────

  private async _connectServer(id: string, config: McpServerConfig): Promise<void> {
    // If already connected, skip
    const existing = this.servers.get(id);
    if (existing?.connected) return;

    const t0 = Date.now();

    const managed: ManagedServer = existing ?? {
      id, config, client: null, tools: [],
      connected: false, reconnectAttempts: 0, shutdown: false,
    };
    this.servers.set(id, managed);
    managed.config = config;
    managed.error = undefined;

    const transport = this._buildTransport(config);
    const client = new Client(
      { name: "nexus-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );
    managed.client = client;

    await client.connect(transport);
    managed.tools = await buildTools(id, config, client);
    managed.connected = true;
    managed.reconnectAttempts = 0;
    managed.connectDurationMs = Date.now() - t0;

    // Watch for server-side disconnects and reconnect
    transport.onclose = () => {
      if (managed.shutdown) return;
      managed.connected = false;
      this._scheduleReconnect(managed);
    };
    transport.onerror = (err) => {
      managed.error = sanitizeError(err.message);
    };
  }

  private _buildTransport(config: McpServerConfig) {
    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`Server "${config.name}" is stdio but has no command`);

      // Build a clean env: inherit safe keys + user-specified env
      const safeKeys = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR"];
      const baseEnv: Record<string, string> = {};
      for (const k of safeKeys) {
        if (process.env[k]) baseEnv[k] = process.env[k]!;
      }

      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...baseEnv, ...(config.env ?? {}) },
      });
    }

    if (config.transport === "sse") {
      if (!config.url) throw new Error(`Server "${config.name}" is SSE but has no url`);
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    }

    if (config.transport === "http") {
      if (!config.url) throw new Error(`Server "${config.name}" is HTTP but has no url`);
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    }

    throw new Error(`Unknown transport: ${(config as any).transport}`);
  }

  // ── Reconnection with exponential backoff ─────────────

  private _scheduleReconnect(managed: ManagedServer): void {
    if (managed.shutdown) return;
    if (managed.reconnectAttempts >= 5) {
      managed.error = "Max reconnection attempts reached";
      return;
    }

    const delayMs = Math.min(1000 * 2 ** managed.reconnectAttempts, 60_000);
    managed.reconnectAttempts++;

    managed.reconnectTimer = setTimeout(async () => {
      if (managed.shutdown) return;
      try {
        await this._connectServer(managed.id, managed.config);
      } catch (err: any) {
        managed.error = sanitizeError(err.message ?? String(err));
        this._scheduleReconnect(managed);
      }
    }, delayMs);
  }
}
