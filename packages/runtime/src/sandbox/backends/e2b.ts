/**
 * Cloud Sandbox Backends
 *
 * E2B (e2b.dev) — primary implementation
 * Modal, Daytona, Runloop — stubs (same interface, easily extensible)
 *
 * E2B provides isolated cloud microVMs with:
 *   - Fast startup (<200ms)
 *   - Persistent filesystem per sandbox
 *   - Built-in code execution API
 *   - 24h default TTL
 *
 * Config via environment:
 *   E2B_API_KEY — required for E2B
 *   E2B_TEMPLATE — sandbox template ID (default: "base")
 *
 * NOTE: E2B SDK (@e2b/code-interpreter) is NOT installed.
 * We call their REST API directly to avoid adding a dependency.
 * API docs: https://e2b.dev/docs/api
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  SandboxBackend,
  SandboxHandle,
  SandboxSpec,
  ExecOpts,
  ExecResult,
  LogEvent,
  ArtifactRef,
  HealthCheckResult,
} from "../types.js";

// ── MIME helper ───────────────────────────────────────────────────────────────

function guessMimeType(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    ts: "text/typescript",
    js: "text/javascript",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    sh: "text/x-shellscript",
    yaml: "application/yaml",
    yml: "application/yaml",
  };
  return ext ? mimeMap[ext] : undefined;
}

// ── E2B REST API types ────────────────────────────────────────────────────────

interface E2BSandbox {
  sandboxId: string;
  templateId: string;
  status: "running" | "paused" | "stopped" | "error";
  startedAt?: string;
  metadata?: Record<string, string>;
}

interface E2BProcessResult {
  processId: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  finished?: boolean;
}

// ── E2BBackend ────────────────────────────────────────────────────────────────

export class E2BBackend implements SandboxBackend {
  readonly type = "e2b" as const;

  private readonly apiKey: string;
  private readonly template: string;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; template?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env["E2B_API_KEY"] ?? "";
    this.template = opts?.template ?? process.env["E2B_TEMPLATE"] ?? "base";
    this.baseUrl = opts?.baseUrl ?? "https://api.e2b.dev";
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  // ── Internal fetch helper ────────────────────────────────────────────────────

  private async _fetch<T>(
    path: string,
    opts: RequestInit & { signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(opts.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`E2B API ${opts.method ?? "GET"} ${path} → ${response.status}: ${body}`);
    }

    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return response.json() as Promise<T>;
    }
    return response.text() as unknown as T;
  }

  // ── create ──────────────────────────────────────────────────────────────────

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const now = Date.now();

    const body = {
      templateId: spec.image ?? this.template,
      metadata: {
        taskId: spec.taskId,
        nexusSandbox: "true",
      },
      ...(spec.ttlMs ? { timeout: Math.ceil(spec.ttlMs / 1000) } : {}),
    };

    const result = await this._fetch<E2BSandbox>("/sandboxes", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const workdir = spec.workdir ?? "/home/user";

    return {
      id: `e2b-${spec.taskId}-${randomBytes(4).toString("hex")}`,
      taskId: spec.taskId,
      backendType: "e2b",
      state: "running",
      backendId: result.sandboxId,
      workdir,
      localWorkdir: spec.localWorkdir,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: spec.ttlMs ? now + spec.ttlMs : undefined,
      metadata: {
        sandboxId: result.sandboxId,
        templateId: result.templateId ?? this.template,
        env: JSON.stringify(spec.env ?? {}),
      },
    };
  }

  // ── exec ─────────────────────────────────────────────────────────────────────

  async exec(handle: SandboxHandle, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const start = Date.now();
    const sandboxId = handle.metadata["sandboxId"] ?? handle.backendId;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    const envEntries = {
      ...(JSON.parse(handle.metadata["env"] ?? "{}") as Record<string, string>),
      ...opts?.env,
    };

    try {
      // Start the process
      const startResult = await this._fetch<E2BProcessResult>(
        `/sandboxes/${sandboxId}/process/start`,
        {
          method: "POST",
          body: JSON.stringify({
            cmd: "sh",
            args: ["-c", command],
            envVars: envEntries,
            cwd: opts?.cwd ?? handle.workdir,
            ...(opts?.stdin ? { stdin: opts.stdin } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      const processId = startResult.processId;

      // Poll for completion
      const pollIntervalMs = 200;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

        const result = await this._fetch<E2BProcessResult>(
          `/sandboxes/${sandboxId}/process/${processId}`,
        );

        if (result.finished) {
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.exitCode ?? 0,
            durationMs: Date.now() - start,
            timedOut: false,
          };
        }
      }

      // Timed out
      return {
        stdout: "",
        stderr: "process timed out",
        exitCode: 124,
        durationMs: Date.now() - start,
        timedOut: true,
      };
    } catch (err: any) {
      const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        stdout: "",
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - start,
        timedOut,
      };
    }
  }

  // ── stream ───────────────────────────────────────────────────────────────────

  async *stream(
    handle: SandboxHandle,
    command: string,
    opts?: ExecOpts,
  ): AsyncIterable<LogEvent> {
    const sandboxId = handle.metadata["sandboxId"] ?? handle.backendId;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    const envEntries = {
      ...(JSON.parse(handle.metadata["env"] ?? "{}") as Record<string, string>),
      ...opts?.env,
    };

    // Start the process
    let processId: string;
    try {
      const startResult = await this._fetch<E2BProcessResult>(
        `/sandboxes/${sandboxId}/process/start`,
        {
          method: "POST",
          body: JSON.stringify({
            cmd: "sh",
            args: ["-c", command],
            envVars: envEntries,
            cwd: opts?.cwd ?? handle.workdir,
            ...(opts?.stdin ? { stdin: opts.stdin } : {}),
          }),
        },
      );
      processId = startResult.processId;
    } catch (err: any) {
      yield { stream: "system", data: `Failed to start process: ${err.message}`, timestamp: Date.now() };
      return;
    }

    // Poll output endpoint every 200ms, yield new output chunks
    const pollIntervalMs = 200;
    const deadline = Date.now() + timeoutMs;
    let lastStdoutLen = 0;
    let lastStderrLen = 0;

    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

      try {
        const result = await this._fetch<E2BProcessResult>(
          `/sandboxes/${sandboxId}/process/${processId}`,
        );

        // Yield any new stdout
        const newStdout = (result.stdout ?? "").slice(lastStdoutLen);
        if (newStdout) {
          for (const line of newStdout.split("\n")) {
            if (line) yield { stream: "stdout", data: line + "\n", timestamp: Date.now() };
          }
          lastStdoutLen += newStdout.length;
        }

        // Yield any new stderr
        const newStderr = (result.stderr ?? "").slice(lastStderrLen);
        if (newStderr) {
          for (const line of newStderr.split("\n")) {
            if (line) yield { stream: "stderr", data: line + "\n", timestamp: Date.now() };
          }
          lastStderrLen += newStderr.length;
        }

        if (result.finished) {
          yield {
            stream: "system",
            data: `process exited with code ${result.exitCode ?? 0}`,
            timestamp: Date.now(),
          };
          return;
        }
      } catch (err: any) {
        yield { stream: "system", data: `poll error: ${err.message}`, timestamp: Date.now() };
        return;
      }
    }

    yield { stream: "system", data: "process timed out", timestamp: Date.now() };
  }

  // ── upload ───────────────────────────────────────────────────────────────────

  async upload(handle: SandboxHandle, localPath: string, sandboxPath: string): Promise<void> {
    const sandboxId = handle.metadata["sandboxId"] ?? handle.backendId;

    let content: Buffer;
    try {
      content = readFileSync(localPath);
    } catch (err: any) {
      throw new Error(`E2BBackend.upload: cannot read local file ${localPath} — ${err.message}`);
    }

    // POST /sandboxes/{sandboxId}/files?path={sandboxPath}
    const url = `${this.baseUrl}/sandboxes/${sandboxId}/files?path=${encodeURIComponent(sandboxPath)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: content as unknown as BodyInit,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`E2BBackend.upload failed: ${response.status} ${body}`);
    }
  }

  // ── download ─────────────────────────────────────────────────────────────────

  async download(handle: SandboxHandle, sandboxPath: string, localPath: string): Promise<void> {
    const sandboxId = handle.metadata["sandboxId"] ?? handle.backendId;

    const url = `${this.baseUrl}/sandboxes/${sandboxId}/files?path=${encodeURIComponent(sandboxPath)}`;
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`E2BBackend.download failed: ${response.status} ${body}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, buffer);
  }

  // ── extractArtifacts ─────────────────────────────────────────────────────────

  async extractArtifacts(
    handle: SandboxHandle,
    patterns: string[],
    destDir: string,
  ): Promise<ArtifactRef[]> {
    mkdirSync(destDir, { recursive: true });
    const artifacts: ArtifactRef[] = [];
    const now = Date.now();

    for (const pattern of patterns) {
      // List matching files via exec
      const result = await this.exec(
        handle,
        `find ${handle.workdir} -name ${JSON.stringify(pattern)} -type f 2>/dev/null`,
      );
      const filePaths = result.stdout.trim().split("\n").filter(Boolean);

      for (const remotePath of filePaths) {
        const relPath = remotePath.startsWith(handle.workdir + "/")
          ? remotePath.slice(handle.workdir.length + 1)
          : basename(remotePath);
        const localDest = join(destDir, relPath);
        mkdirSync(dirname(localDest), { recursive: true });

        try {
          await this.download(handle, remotePath, localDest);
          const sizeBytes = readFileSync(localDest).length;

          artifacts.push({
            sandboxPath: remotePath,
            localPath: localDest,
            sizeBytes,
            mimeType: guessMimeType(remotePath),
            extractedAt: now,
          });
        } catch {
          /* skip files that fail to download */
        }
      }
    }

    return artifacts;
  }

  // ── healthCheck ──────────────────────────────────────────────────────────────

  async healthCheck(handle: SandboxHandle): Promise<HealthCheckResult> {
    const start = Date.now();
    const sandboxId = handle.metadata["sandboxId"] ?? handle.backendId;

    try {
      const result = await this._fetch<E2BSandbox>(`/sandboxes/${sandboxId}`);
      const latencyMs = Date.now() - start;

      if (result.status === "running") {
        return { health: "healthy", latencyMs, checkedAt: Date.now() };
      } else if (result.status === "paused") {
        return { health: "degraded", latencyMs, message: "sandbox is paused", checkedAt: Date.now() };
      } else {
        return {
          health: "unhealthy",
          latencyMs,
          message: `sandbox status: ${result.status}`,
          checkedAt: Date.now(),
        };
      }
    } catch (err: any) {
      return {
        health: "unhealthy",
        latencyMs: Date.now() - start,
        message: err.message,
        checkedAt: Date.now(),
      };
    }
  }

  // ── destroy ──────────────────────────────────────────────────────────────────

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandboxId = handle.metadata["sandboxId"] ?? handle.backendId;
    try {
      await this._fetch(`/sandboxes/${sandboxId}`, { method: "DELETE" });
    } catch {
      /* best effort */
    }
    (handle as { state: string }).state = "destroyed";
  }

  // ── list ─────────────────────────────────────────────────────────────────────

  async list(): Promise<SandboxHandle[]> {
    try {
      const results = await this._fetch<E2BSandbox[]>("/sandboxes");
      const now = Date.now();

      return results
        .filter((s) => s.metadata?.["nexusSandbox"] === "true")
        .map((s) => {
          const taskId = s.metadata?.["taskId"] ?? "unknown";
          return {
            id: `e2b-${taskId}-${s.sandboxId.slice(0, 8)}`,
            taskId,
            backendType: "e2b" as const,
            state: s.status === "running" ? ("running" as const) : ("stopped" as const),
            backendId: s.sandboxId,
            workdir: "/home/user",
            createdAt: s.startedAt ? new Date(s.startedAt).getTime() : now,
            lastUsedAt: now,
            metadata: {
              sandboxId: s.sandboxId,
              templateId: s.templateId,
              env: "{}",
            },
          };
        });
    } catch {
      return [];
    }
  }
}

// ── ModalBackend (stub) ───────────────────────────────────────────────────────

export class ModalBackend implements SandboxBackend {
  readonly type = "modal" as const;
  readonly available = false;

  // TODO: implement using Modal SDK (modal.com)

  create(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  exec(_handle: SandboxHandle, _command: string, _opts?: ExecOpts): Promise<ExecResult> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  stream(_handle: SandboxHandle, _command: string, _opts?: ExecOpts): AsyncIterable<LogEvent> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  upload(_handle: SandboxHandle, _localPath: string, _sandboxPath: string): Promise<void> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  download(_handle: SandboxHandle, _sandboxPath: string, _localPath: string): Promise<void> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  extractArtifacts(
    _handle: SandboxHandle,
    _patterns: string[],
    _destDir: string,
  ): Promise<ArtifactRef[]> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  healthCheck(_handle: SandboxHandle): Promise<HealthCheckResult> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  destroy(_handle: SandboxHandle): Promise<void> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  list(): Promise<SandboxHandle[]> {
    throw new Error(`modal backend not yet implemented. Set type to "e2b" or "docker".`);
  }
}

// ── DaytonaBackend (stub) ─────────────────────────────────────────────────────

export class DaytonaBackend implements SandboxBackend {
  readonly type = "daytona" as const;
  readonly available = false;

  // TODO: implement using Daytona SDK (daytona.io)

  create(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  exec(_handle: SandboxHandle, _command: string, _opts?: ExecOpts): Promise<ExecResult> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  stream(_handle: SandboxHandle, _command: string, _opts?: ExecOpts): AsyncIterable<LogEvent> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  upload(_handle: SandboxHandle, _localPath: string, _sandboxPath: string): Promise<void> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  download(_handle: SandboxHandle, _sandboxPath: string, _localPath: string): Promise<void> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  extractArtifacts(
    _handle: SandboxHandle,
    _patterns: string[],
    _destDir: string,
  ): Promise<ArtifactRef[]> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  healthCheck(_handle: SandboxHandle): Promise<HealthCheckResult> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  destroy(_handle: SandboxHandle): Promise<void> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  list(): Promise<SandboxHandle[]> {
    throw new Error(`daytona backend not yet implemented. Set type to "e2b" or "docker".`);
  }
}

// ── RunloopBackend (stub) ─────────────────────────────────────────────────────

export class RunloopBackend implements SandboxBackend {
  readonly type = "runloop" as const;
  readonly available = false;

  // TODO: implement using Runloop SDK (runloop.ai)

  create(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  exec(_handle: SandboxHandle, _command: string, _opts?: ExecOpts): Promise<ExecResult> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  stream(_handle: SandboxHandle, _command: string, _opts?: ExecOpts): AsyncIterable<LogEvent> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  upload(_handle: SandboxHandle, _localPath: string, _sandboxPath: string): Promise<void> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  download(_handle: SandboxHandle, _sandboxPath: string, _localPath: string): Promise<void> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  extractArtifacts(
    _handle: SandboxHandle,
    _patterns: string[],
    _destDir: string,
  ): Promise<ArtifactRef[]> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  healthCheck(_handle: SandboxHandle): Promise<HealthCheckResult> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  destroy(_handle: SandboxHandle): Promise<void> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
  list(): Promise<SandboxHandle[]> {
    throw new Error(`runloop backend not yet implemented. Set type to "e2b" or "docker".`);
  }
}
