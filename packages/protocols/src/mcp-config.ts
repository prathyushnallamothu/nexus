/**
 * Nexus MCP Configuration
 *
 * Manages ~/.nexus/mcp.json — the registry of all configured MCP servers.
 * Supports stdio, SSE, and StreamableHTTP transports.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────

export type McpTransport = "stdio" | "sse" | "http";

export interface McpServerConfig {
  /** Display name */
  name: string;
  /** Transport type */
  transport: McpTransport;

  // Stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // HTTP / SSE fields
  url?: string;
  headers?: Record<string, string>;

  /** Enabled / disabled without removing */
  enabled: boolean;
  /** Per-call timeout ms (default 30000) */
  timeoutMs?: number;
  /** Connection timeout ms (default 15000) */
  connectTimeoutMs?: number;
  /** Tool include/exclude filter */
  tools?: {
    include?: string[];
    exclude?: string[];
  };
  /** Added at timestamp */
  addedAt: number;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

// ── Config file location ──────────────────────────────────

function defaultConfigPath(): string {
  // Check env first, fall back to ~/.nexus/mcp.json
  const nexusHome = process.env.NEXUS_HOME ?? join(homedir(), ".nexus");
  return join(nexusHome, "mcp.json");
}

// ── Environment variable interpolation ───────────────────

function interpolate(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? "");
}

function interpolateObj(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = interpolate(v);
  return out;
}

// ── McpConfigStore ────────────────────────────────────────

export class McpConfigStore {
  private configPath: string;
  private config: McpConfig = { servers: {} };

  constructor(configPath?: string) {
    this.configPath = configPath ?? defaultConfigPath();
    this._load();
  }

  private _load(): void {
    try {
      if (!existsSync(this.configPath)) return;
      this.config = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch {
      this.config = { servers: {} };
    }
  }

  private _save(): void {
    const dir = this.configPath.replace(/[/\\][^/\\]*$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /** Return all enabled servers with env vars interpolated */
  getEnabled(): Array<{ id: string; config: McpServerConfig }> {
    return Object.entries(this.config.servers)
      .filter(([, c]) => c.enabled)
      .map(([id, c]) => ({
        id,
        config: {
          ...c,
          env: c.env ? interpolateObj(c.env) : undefined,
          headers: c.headers ? interpolateObj(c.headers) : undefined,
        },
      }));
  }

  getAll(): Array<{ id: string; config: McpServerConfig }> {
    return Object.entries(this.config.servers).map(([id, config]) => ({ id, config }));
  }

  get(id: string): McpServerConfig | null {
    return this.config.servers[id] ?? null;
  }

  add(id: string, cfg: Omit<McpServerConfig, "addedAt">): McpServerConfig {
    const entry: McpServerConfig = { ...cfg, addedAt: Date.now() };
    this.config.servers[id] = entry;
    this._save();
    return entry;
  }

  remove(id: string): boolean {
    if (!this.config.servers[id]) return false;
    delete this.config.servers[id];
    this._save();
    return true;
  }

  toggle(id: string, enabled: boolean): boolean {
    const s = this.config.servers[id];
    if (!s) return false;
    s.enabled = enabled;
    this._save();
    return true;
  }

  update(id: string, patch: Partial<McpServerConfig>): boolean {
    const s = this.config.servers[id];
    if (!s) return false;
    Object.assign(s, patch);
    this._save();
    return true;
  }

  get configFilePath(): string {
    return this.configPath;
  }
}
