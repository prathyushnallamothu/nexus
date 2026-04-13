/**
 * Local Sandbox Backend
 *
 * Runs commands directly on the host. No isolation.
 * Used as fallback when Docker/SSH/cloud are unavailable.
 *
 * "Full permissions inside sandbox, restricted outside" boundary
 * is enforced by the caller (SandboxManager + PermissionGuard).
 * Here we just execute.
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, basename } from "node:path";
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

const execAsync = promisify(exec);

// ── Glob helper ───────────────────────────────────────────────────────────────

/**
 * Convert a minimatch-style glob pattern to a RegExp.
 * Supports: `*` (any chars except /), `**` (any chars including /), `?` (single char except /).
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match anything including path separators
        regexStr += ".*";
        i += 2;
        // skip trailing slash if present after **
        if (pattern[i] === "/") i++;
      } else {
        // * — match anything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  return new RegExp("^" + regexStr + "$");
}

/** Recursively list all files under a directory. Returns absolute paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── MIME type helper ──────────────────────────────────────────────────────────

function guessMimeType(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    ts: "text/typescript",
    js: "text/javascript",
    mjs: "text/javascript",
    cjs: "text/javascript",
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

// ── Stream helper ─────────────────────────────────────────────────────────────

async function* _streamLines(
  readable: NodeJS.ReadableStream,
  stream: "stdout" | "stderr",
): AsyncIterable<LogEvent> {
  let buf = "";
  for await (const chunk of readable) {
    buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      yield { stream, data: line + "\n", timestamp: Date.now() };
    }
  }
  if (buf.length > 0) {
    yield { stream, data: buf, timestamp: Date.now() };
  }
}

// ── Recursive copy helper ─────────────────────────────────────────────────────

function _cpSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      _cpSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ── LocalBackend ──────────────────────────────────────────────────────────────

export class LocalBackend implements SandboxBackend {
  readonly type = "local" as const;
  readonly available = true;

  // ── create ──────────────────────────────────────────────────────────────────

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const random = randomBytes(4).toString("hex");
    const now = Date.now();

    let localDir: string;
    let owned = false;

    if (spec.localWorkdir && existsSync(spec.localWorkdir)) {
      // Use the caller-provided directory — we do not own it
      localDir = resolve(spec.localWorkdir);
      owned = false;
    } else {
      // Create a temp directory — we own it and will clean it up on destroy
      localDir = mkdtempSync(join(tmpdir(), `nexus-sandbox-${spec.taskId}-${random}-`));
      owned = true;
    }

    const workdir = spec.workdir ?? localDir;

    const envMeta: Record<string, string> = {};
    if (spec.env && Object.keys(spec.env).length > 0) {
      envMeta["env"] = JSON.stringify(spec.env);
    }

    const handle: SandboxHandle = {
      id: `local-${spec.taskId}-${random}`,
      taskId: spec.taskId,
      backendType: "local",
      state: "running",
      backendId: localDir,
      workdir,
      localWorkdir: localDir,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: spec.ttlMs ? now + spec.ttlMs : undefined,
      metadata: {
        ...envMeta,
        owned: String(owned),
      },
    };

    return handle;
  }

  // ── exec ─────────────────────────────────────────────────────────────────────

  async exec(handle: SandboxHandle, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const start = Date.now();

    // Build environment
    let sandboxEnv: Record<string, string> = {};
    if (handle.metadata["env"]) {
      try {
        sandboxEnv = JSON.parse(handle.metadata["env"]);
      } catch {
        /* ignore malformed env */
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...sandboxEnv,
      ...opts?.env,
    };

    const cwd = opts?.cwd ?? handle.workdir;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env,
        timeout: timeoutMs,
        ...(opts?.stdin ? { input: opts.stdin } : {}),
      });
      return {
        stdout,
        stderr,
        exitCode: 0,
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err: any) {
      const timedOut = err.signal === "SIGTERM" && (err.killed ?? false);
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.code ?? 1,
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
    let sandboxEnv: Record<string, string> = {};
    if (handle.metadata["env"]) {
      try {
        sandboxEnv = JSON.parse(handle.metadata["env"]);
      } catch {
        /* ignore */
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...sandboxEnv,
      ...opts?.env,
    };

    const cwd = opts?.cwd ?? handle.workdir;
    const child = spawn("sh", ["-c", command], { cwd, env });

    if (opts?.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    // Interleave stdout and stderr by feeding both into a shared queue
    const queue: Array<LogEvent | null> = [];
    let resolve: (() => void) | null = null;
    let pending = 2; // stdout + stderr

    function push(event: LogEvent | null) {
      queue.push(event);
      resolve?.();
      resolve = null;
    }

    async function drain(readable: NodeJS.ReadableStream, stream: "stdout" | "stderr") {
      let buf = "";
      for await (const chunk of readable) {
        buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          push({ stream, data: line + "\n", timestamp: Date.now() });
        }
      }
      if (buf.length > 0) push({ stream, data: buf, timestamp: Date.now() });
      pending--;
      if (pending === 0) push(null); // signal done
    }

    drain(child.stdout, "stdout");
    drain(child.stderr, "stderr");

    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        if (event === null) return;
        yield event;
      }
      await new Promise<void>((r) => { resolve = r; });
    }
  }

  // ── upload ───────────────────────────────────────────────────────────────────

  async upload(handle: SandboxHandle, localPath: string, sandboxPath: string): Promise<void> {
    const destPath = resolve(handle.workdir, sandboxPath);
    mkdirSync(dirname(destPath), { recursive: true });
    const srcStat = statSync(localPath);
    if (srcStat.isDirectory()) {
      _cpSync(localPath, destPath);
    } else {
      copyFileSync(localPath, destPath);
    }
  }

  // ── download ─────────────────────────────────────────────────────────────────

  async download(handle: SandboxHandle, sandboxPath: string, localPath: string): Promise<void> {
    const srcPath = resolve(handle.workdir, sandboxPath);
    mkdirSync(dirname(localPath), { recursive: true });
    const srcStat = statSync(srcPath);
    if (srcStat.isDirectory()) {
      _cpSync(srcPath, localPath);
    } else {
      copyFileSync(srcPath, localPath);
    }
  }

  // ── extractArtifacts ─────────────────────────────────────────────────────────

  async extractArtifacts(
    handle: SandboxHandle,
    patterns: string[],
    destDir: string,
  ): Promise<ArtifactRef[]> {
    mkdirSync(destDir, { recursive: true });

    const allFiles = walkDir(handle.workdir);
    const regexes = patterns.map((p) => globToRegex(p));
    const artifacts: ArtifactRef[] = [];
    const now = Date.now();

    for (const absPath of allFiles) {
      const relPath = relative(handle.workdir, absPath);
      const matchesAny = regexes.some((rx) => rx.test(relPath) || rx.test(basename(absPath)));
      if (!matchesAny) continue;

      const destPath = join(destDir, relPath);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(absPath, destPath);

      const sizeBytes = statSync(absPath).size;

      artifacts.push({
        sandboxPath: relPath,
        localPath: destPath,
        sizeBytes,
        mimeType: guessMimeType(absPath),
        extractedAt: now,
      });
    }

    return artifacts;
  }

  // ── healthCheck ──────────────────────────────────────────────────────────────

  async healthCheck(handle: SandboxHandle): Promise<HealthCheckResult> {
    const start = Date.now();
    const workdirExists = existsSync(handle.workdir);
    const latencyMs = Date.now() - start;

    if (handle.state === "destroyed") {
      return {
        health: "unhealthy",
        latencyMs,
        message: "sandbox has been destroyed",
        checkedAt: Date.now(),
      };
    }

    if (!workdirExists) {
      return {
        health: "unhealthy",
        latencyMs,
        message: `workdir does not exist: ${handle.workdir}`,
        checkedAt: Date.now(),
      };
    }

    return { health: "healthy", latencyMs, checkedAt: Date.now() };
  }

  // ── destroy ──────────────────────────────────────────────────────────────────

  async destroy(handle: SandboxHandle): Promise<void> {
    // Only remove the temp dir if we created it
    if (handle.metadata["owned"] === "true") {
      const dir = handle.backendId;
      if (existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
    // Mutate state (the manager holds a reference)
    (handle as { state: string }).state = "destroyed";
  }

  // ── list ─────────────────────────────────────────────────────────────────────

  async list(): Promise<SandboxHandle[]> {
    // LocalBackend has no persistence between instances — no registry
    return [];
  }
}
