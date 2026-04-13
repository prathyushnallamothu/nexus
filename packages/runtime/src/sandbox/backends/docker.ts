/**
 * Docker Sandbox Backend
 *
 * Runs commands in isolated Docker containers.
 * Each SandboxHandle maps to one persistent container.
 *
 * Features:
 *   - Container-per-task (reused across multiple exec() calls)
 *   - Network isolation via --network flag (none/bridge/host/custom)
 *   - Memory + CPU limits
 *   - Streaming via docker logs + exec
 *   - File upload/download via docker cp
 *   - Artifact extraction via docker cp + glob
 *   - Health check via docker inspect
 *   - Auto-pull image if not present
 */

import { exec, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, statSync, existsSync } from "node:fs";
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

const execAsync = promisify(exec);

// ── Docker availability ───────────────────────────────────────────────────────

let _dockerAvailable: boolean | null = null;

function checkDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execSync("docker info --format '{{.ServerVersion}}'", { stdio: "pipe" });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

// ── MIME type helper ──────────────────────────────────────────────────────────

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

// ── DockerBackend ─────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = "node:20-slim";
const NEXUS_LABEL = "nexus-sandbox=true";

export class DockerBackend implements SandboxBackend {
  readonly type = "docker" as const;

  get available(): boolean {
    return checkDockerAvailable();
  }

  // ── create ──────────────────────────────────────────────────────────────────

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const random = randomBytes(4).toString("hex");
    const now = Date.now();
    const image = spec.image ?? DEFAULT_IMAGE;
    const containerName = `nexus-${spec.taskId.replace(/[^a-z0-9-]/gi, "-")}-${random}`;

    // Try to pull the image if not present (best effort)
    try {
      execSync(`docker image inspect ${image}`, { stdio: "pipe" });
    } catch {
      try {
        await execAsync(`docker pull ${image}`);
      } catch {
        /* ignore pull errors — run may still succeed if image is cached */
      }
    }

    // Build docker run arguments
    const args: string[] = [
      "run", "-d",
      "--name", containerName,
      "--label", NEXUS_LABEL,
      "--label", `nexus-task-id=${spec.taskId}`,
    ];

    // Network
    const networkMode = spec.network?.mode ?? "bridge";
    if (networkMode === "none") {
      args.push("--network", "none");
    } else if (networkMode === "host") {
      args.push("--network", "host");
    } else {
      // bridge or isolated — use bridge (caller enforces domain policy separately)
      args.push("--network", "bridge");
    }

    // Resources
    if (spec.resources?.memoryMb) {
      args.push("--memory", `${spec.resources.memoryMb}m`);
    }
    if (spec.resources?.cpuShares) {
      args.push("--cpu-shares", String(spec.resources.cpuShares));
    }

    // Volume mount
    const hasMount = Boolean(spec.localWorkdir);
    const containerWorkdir = spec.workdir ?? (hasMount ? "/workspace" : "/tmp");
    if (spec.localWorkdir) {
      args.push("-v", `${spec.localWorkdir}:/workspace`);
    }

    // Working directory
    args.push("-w", containerWorkdir);

    // Environment variables
    const envVars: Record<string, string> = spec.env ?? {};
    for (const [k, v] of Object.entries(envVars)) {
      args.push("-e", `${k}=${v}`);
    }

    // Image + keep-alive command
    args.push(image, "tail", "-f", "/dev/null");

    try {
      const { stdout } = await execAsync(`docker ${args.map((a) => JSON.stringify(a)).join(" ")}`);
      const containerId = stdout.trim();

      return {
        id: `docker-${spec.taskId}-${random}`,
        taskId: spec.taskId,
        backendType: "docker",
        state: "running",
        backendId: containerId,
        workdir: containerWorkdir,
        localWorkdir: spec.localWorkdir,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: spec.ttlMs ? now + spec.ttlMs : undefined,
        metadata: {
          containerName,
          image,
          env: JSON.stringify(envVars),
        },
      };
    } catch (err: any) {
      throw new Error(`DockerBackend.create failed: ${err.message}`);
    }
  }

  // ── exec ─────────────────────────────────────────────────────────────────────

  async exec(handle: SandboxHandle, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const start = Date.now();
    const containerId = handle.backendId;

    const args: string[] = ["exec", "-i"];
    if (opts?.cwd) args.push("--workdir", opts.cwd);
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }
    args.push(containerId, "sh", "-c", command);

    const timeoutMs = opts?.timeoutMs ?? 30_000;

    try {
      const { stdout, stderr } = await execAsync(
        `docker ${args.map((a) => JSON.stringify(a)).join(" ")}`,
        {
          timeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
          ...(opts?.stdin ? { input: opts.stdin } : {}),
        },
      );
      return {
        stdout,
        stderr,
        exitCode: 0,
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err: any) {
      const timedOut = err.name === "AbortError" || (err.killed && err.signal === "SIGTERM");
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
    const containerId = handle.backendId;

    const spawnArgs: string[] = ["exec", "-i"];
    if (opts?.cwd) spawnArgs.push("--workdir", opts.cwd);
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        spawnArgs.push("--env", `${k}=${v}`);
      }
    }
    spawnArgs.push(containerId, "sh", "-c", command);

    const child = spawn("docker", spawnArgs);

    if (opts?.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    // Interleave stdout/stderr via shared event queue
    const queue: Array<LogEvent | null> = [];
    let notify: (() => void) | null = null;
    let pending = 2;

    function push(event: LogEvent | null) {
      queue.push(event);
      notify?.();
      notify = null;
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
      if (pending === 0) push(null);
    }

    drain(child.stdout, "stdout");
    drain(child.stderr, "stderr");

    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        if (event === null) return;
        yield event;
      }
      await new Promise<void>((r) => { notify = r; });
    }
  }

  // ── upload ───────────────────────────────────────────────────────────────────

  async upload(handle: SandboxHandle, localPath: string, sandboxPath: string): Promise<void> {
    const containerId = handle.backendId;
    await execAsync(`docker cp ${JSON.stringify(localPath)} ${containerId}:${sandboxPath}`);
  }

  // ── download ─────────────────────────────────────────────────────────────────

  async download(handle: SandboxHandle, sandboxPath: string, localPath: string): Promise<void> {
    const containerId = handle.backendId;
    mkdirSync(dirname(localPath), { recursive: true });
    await execAsync(`docker cp ${containerId}:${sandboxPath} ${JSON.stringify(localPath)}`);
  }

  // ── extractArtifacts ─────────────────────────────────────────────────────────

  async extractArtifacts(
    handle: SandboxHandle,
    patterns: string[],
    destDir: string,
  ): Promise<ArtifactRef[]> {
    mkdirSync(destDir, { recursive: true });
    const containerId = handle.backendId;
    const artifacts: ArtifactRef[] = [];
    const now = Date.now();

    for (const pattern of patterns) {
      try {
        const findCmd = `docker exec ${containerId} sh -c ${JSON.stringify(
          `find /workspace -name ${JSON.stringify(pattern)} -type f 2>/dev/null`,
        )}`;
        const { stdout } = await execAsync(findCmd);
        const filePaths = stdout.trim().split("\n").filter(Boolean);

        for (const filePath of filePaths) {
          const relPath = filePath.startsWith("/workspace/")
            ? filePath.slice("/workspace/".length)
            : basename(filePath);
          const localDest = join(destDir, relPath);
          mkdirSync(dirname(localDest), { recursive: true });

          try {
            await execAsync(`docker cp ${containerId}:${filePath} ${JSON.stringify(localDest)}`);
            const sizeBytes = existsSync(localDest) ? statSync(localDest).size : 0;
            artifacts.push({
              sandboxPath: filePath,
              localPath: localDest,
              sizeBytes,
              mimeType: guessMimeType(filePath),
              extractedAt: now,
            });
          } catch {
            /* skip files that fail to copy */
          }
        }
      } catch {
        /* skip patterns that find fails on */
      }
    }

    return artifacts;
  }

  // ── healthCheck ──────────────────────────────────────────────────────────────

  async healthCheck(handle: SandboxHandle): Promise<HealthCheckResult> {
    const start = Date.now();
    const containerId = handle.backendId;

    try {
      const { stdout } = await execAsync(
        `docker inspect ${containerId} --format '{{.State.Status}}'`,
      );
      const status = stdout.trim();
      const latencyMs = Date.now() - start;

      if (status === "running") {
        return { health: "healthy", latencyMs, checkedAt: Date.now() };
      } else if (status === "paused") {
        return { health: "degraded", latencyMs, message: "container is paused", checkedAt: Date.now() };
      } else {
        return {
          health: "unhealthy",
          latencyMs,
          message: `container status: ${status}`,
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
    const containerId = handle.backendId;
    try {
      await execAsync(`docker stop ${containerId}`);
    } catch {
      /* already stopped — that's fine */
    }
    try {
      await execAsync(`docker rm -f ${containerId}`);
    } catch {
      /* already removed */
    }
    (handle as { state: string }).state = "destroyed";
  }

  // ── pause ────────────────────────────────────────────────────────────────────

  async pause(handle: SandboxHandle): Promise<void> {
    await execAsync(`docker pause ${handle.backendId}`);
    (handle as { state: string }).state = "paused";
  }

  // ── resume ───────────────────────────────────────────────────────────────────

  async resume(handle: SandboxHandle): Promise<SandboxHandle> {
    await execAsync(`docker unpause ${handle.backendId}`);
    const updated: SandboxHandle = {
      ...handle,
      state: "running",
      lastUsedAt: Date.now(),
    };
    return updated;
  }

  // ── list ─────────────────────────────────────────────────────────────────────

  async list(): Promise<SandboxHandle[]> {
    try {
      const { stdout } = await execAsync(
        `docker ps --filter label=${NEXUS_LABEL} --format '{{json .}}'`,
      );
      const lines = stdout.trim().split("\n").filter(Boolean);
      const handles: SandboxHandle[] = [];
      const now = Date.now();

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            ID: string;
            Names: string;
            Status: string;
            Labels: string;
            Image: string;
          };

          // Parse task ID from label
          const labelParts = parsed.Labels?.split(",") ?? [];
          const taskLabelEntry = labelParts.find((l) => l.startsWith("nexus-task-id="));
          const taskId = taskLabelEntry?.split("=")[1] ?? "unknown";

          const state = parsed.Status?.startsWith("Up") ? "running" : "stopped";

          handles.push({
            id: `docker-${taskId}-${parsed.ID.slice(0, 8)}`,
            taskId,
            backendType: "docker",
            state: state as any,
            backendId: parsed.ID,
            workdir: "/workspace",
            createdAt: now,
            lastUsedAt: now,
            metadata: {
              containerName: parsed.Names,
              image: parsed.Image,
              env: "{}",
            },
          });
        } catch {
          /* skip malformed lines */
        }
      }

      return handles;
    } catch {
      return [];
    }
  }
}
