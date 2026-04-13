/**
 * Nexus Sandbox Secrets Manager
 *
 * Injects secrets into sandboxes as environment variables.
 * Secrets are NEVER written to files inside the sandbox.
 * They are passed only as env vars to exec() calls.
 *
 * Secret storage:
 *   {nexusHome}/secrets/global.env    — global secrets (all tasks)
 *   {nexusHome}/secrets/{taskId}.env  — task-scoped secrets
 *
 * Format: KEY=VALUE (one per line, # comments supported, shell-escaped values)
 *
 * Resolution order:
 *   1. Task-scoped secrets  (most specific)
 *   2. Global secrets
 *   3. process.env (passthrough env vars matching allowList)
 *
 * Security:
 *   - Secrets are redacted in logs (replace value with [REDACTED])
 *   - Secret keys matching common patterns auto-detected and protected
 *   - Exported env map is a copy (not a live reference)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { SandboxSpec } from "./types.js";

// ── Auto-detect passthrough keys ──────────────────────────────────────────────

const AUTO_PASSTHROUGH_KEYS: readonly string[] = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "DOCKER_HUB_TOKEN",
  "NPM_TOKEN",
  "PYPI_TOKEN",
];

const NEXUS_INJECT_PREFIX = "NEXUS_INJECT_";

// ── .env file parser ──────────────────────────────────────────────────────────

/**
 * Parse a .env-style file into a key→value map.
 * Supports:
 *   - # comment lines
 *   - KEY=simple value
 *   - QUOTED="value with spaces"
 *   - MULTI_LINE="line1\nline2"  (escaped sequences expanded)
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1);

    // Strip surrounding quotes and expand escape sequences
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quoteChar = value[0];
      value = value.slice(1, -1);
      if (quoteChar === '"') {
        // Expand \n, \t, \\
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\\\/g, "\\")
          .replace(/\\"/g, '"');
      }
    }

    if (key) result[key] = value;
  }
  return result;
}

/**
 * Serialize a key→value map back to .env file format.
 * Values containing spaces or special characters are double-quoted.
 */
function serializeEnvFile(secrets: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    const needsQuotes = /[\s"'\\]/.test(value) || value.includes("\n");
    if (needsQuotes) {
      const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t");
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

// ── Standalone helper ─────────────────────────────────────────────────────────

/**
 * Replace all known secret values in `text` with `[REDACTED:KEY]`.
 * Safe to call with an empty secrets map.
 */
export function redactSecrets(
  text: string,
  secrets: Record<string, string>,
): string {
  let result = text;
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue;
    // Escape regex special chars in the value
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), `[REDACTED:${key}]`);
  }
  return result;
}

// ── SecretsManager ────────────────────────────────────────────────────────────

export interface SecretsManagerOpts {
  /** Additional env var names to pass through from process.env. */
  passthroughKeys?: string[];
  /** Auto-detect well-known API keys from process.env (default: true). */
  autoDetectSecrets?: boolean;
}

export class SecretsManager {
  private readonly secretsDir: string;
  private readonly passthroughKeys: string[];
  private readonly autoDetectSecrets: boolean;

  constructor(nexusHome: string, opts?: SecretsManagerOpts) {
    this.secretsDir = join(nexusHome, "secrets");
    this.passthroughKeys = opts?.passthroughKeys ?? [];
    this.autoDetectSecrets = opts?.autoDetectSecrets ?? true;

    mkdirSync(this.secretsDir, { recursive: true });
  }

  // ── File paths ────────────────────────────────────────────────────────────

  private _filePath(scope: "global" | string): string {
    return scope === "global"
      ? join(this.secretsDir, "global.env")
      : join(this.secretsDir, `${scope}.env`);
  }

  // ── Read / write helpers ──────────────────────────────────────────────────

  private _read(scope: "global" | string): Record<string, string> {
    const path = this._filePath(scope);
    if (!existsSync(path)) return {};
    try {
      return parseEnvFile(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  }

  private _write(scope: "global" | string, data: Record<string, string>): void {
    writeFileSync(this._filePath(scope), serializeEnvFile(data), "utf8");
  }

  // ── Passthrough from process.env ──────────────────────────────────────────

  private _buildPassthrough(): Record<string, string> {
    const result: Record<string, string> = {};

    // Auto-detect well-known keys
    if (this.autoDetectSecrets) {
      for (const key of AUTO_PASSTHROUGH_KEYS) {
        const val = process.env[key];
        if (val !== undefined) result[key] = val;
      }
    }

    // Explicit passthrough list
    for (const key of this.passthroughKeys) {
      const val = process.env[key];
      if (val !== undefined) result[key] = val;
    }

    // NEXUS_INJECT_* prefix — strip prefix before injecting
    for (const [envKey, envVal] of Object.entries(process.env)) {
      if (envKey.startsWith(NEXUS_INJECT_PREFIX) && envVal !== undefined) {
        const injectedKey = envKey.slice(NEXUS_INJECT_PREFIX.length);
        if (injectedKey) result[injectedKey] = envVal;
      }
    }

    return result;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Resolve all secrets for a task.
   * Resolution order (later wins): passthrough → global → task-scoped.
   * If `requestedKeys` is given, only those keys are returned.
   * Returns a shallow copy — safe to mutate.
   */
  resolve(taskId?: string, requestedKeys?: string[]): Record<string, string> {
    const passthrough = this._buildPassthrough();
    const global = this._read("global");
    const taskScoped = taskId ? this._read(taskId) : {};

    const merged: Record<string, string> = {
      ...passthrough,
      ...global,
      ...taskScoped,
    };

    if (!requestedKeys?.length) return { ...merged };

    const filtered: Record<string, string> = {};
    for (const key of requestedKeys) {
      if (key in merged) filtered[key] = merged[key];
    }
    return filtered;
  }

  /**
   * Store a secret.
   * Scope is a taskId or "global".
   */
  set(key: string, value: string, scope: "global" | string = "global"): void {
    const current = this._read(scope);
    current[key] = value;
    this._write(scope, current);
  }

  /** Delete a secret from a scope. */
  delete(key: string, scope: "global" | string = "global"): void {
    const current = this._read(scope);
    if (key in current) {
      delete current[key];
      this._write(scope, current);
    }
  }

  /** List secret keys (not values) for a scope. */
  list(scope: "global" | string = "global"): string[] {
    return Object.keys(this._read(scope));
  }

  /**
   * Replace all known secret values in `text` with `[REDACTED:KEY]`.
   * Loads secrets for the given taskId (if any) to build the redaction set.
   */
  redact(text: string, taskId?: string): string {
    const secrets = this.resolve(taskId);
    return redactSecrets(text, secrets);
  }

  /**
   * Return a new SandboxSpec with resolved secrets merged into `spec.env`.
   * Only injects secrets listed in `spec.secretRefs` (if given).
   * Does not mutate the original spec.
   */
  injectIntoSpec(spec: SandboxSpec): SandboxSpec {
    const resolved = this.resolve(spec.taskId, spec.secretRefs);
    return {
      ...spec,
      env: { ...resolved, ...(spec.env ?? {}) },
    };
  }
}
