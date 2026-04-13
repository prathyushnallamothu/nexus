/**
 * SSH Sandbox Backend
 *
 * Runs commands on a remote host via SSH.
 * The remote host provides isolation from the local machine.
 *
 * Connection config via environment:
 *   NEXUS_SSH_HOST       — required
 *   NEXUS_SSH_USER       — default: current user
 *   NEXUS_SSH_PORT       — default: 22
 *   NEXUS_SSH_KEY        — path to private key (default: ~/.ssh/id_rsa)
 *   NEXUS_SSH_PASSWORD   — password auth (not recommended)
 *
 * Each sandbox is an isolated directory on the remote host:
 *   /tmp/nexus-sandbox-{taskId}/
 *
 * Commands are executed via:
 *   ssh -i {keyPath} -p {port} {user}@{host} 'cd {workdir} && {command}'
 */

import { exec, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir, userInfo } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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

// ── SSHConfig ─────────────────────────────────────────────────────────────────

export interface SSHConfig {
  host: string;
  user?: string;
  port?: number;
  keyPath?: string;
  password?: string;         // not recommended, for testing
  connectTimeoutMs?: number;
  knownHostsFile?: string;
}

// ── Availability cache ────────────────────────────────────────────────────────

let _sshAvailable: boolean | null = null;

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

// ── SSHBackend ────────────────────────────────────────────────────────────────

export class SSHBackend implements SandboxBackend {
  readonly type = "ssh" as const;

  private readonly config: Required<SSHConfig>;

  constructor(config?: SSHConfig) {
    const host = config?.host ?? process.env["NEXUS_SSH_HOST"] ?? "";
    const user =
      config?.user ??
      process.env["NEXUS_SSH_USER"] ??
      (() => { try { return userInfo().username; } catch { return "root"; } })();
    const port =
      config?.port ??
      (process.env["NEXUS_SSH_PORT"] ? parseInt(process.env["NEXUS_SSH_PORT"]!, 10) : 22);
    const keyPath =
      config?.keyPath ??
      process.env["NEXUS_SSH_KEY"] ??
      join(homedir(), ".ssh", "id_rsa");
    const password = config?.password ?? process.env["NEXUS_SSH_PASSWORD"] ?? "";
    const connectTimeoutMs = config?.connectTimeoutMs ?? 10_000;
    const knownHostsFile = config?.knownHostsFile ?? join(homedir(), ".ssh", "known_hosts");

    this.config = { host, user, port, keyPath, password, connectTimeoutMs, knownHostsFile };
  }

  get available(): boolean {
    if (_sshAvailable !== null) return _sshAvailable;
    if (!this.config.host) {
      _sshAvailable = false;
      return false;
    }
    // A quick SSH no-op to verify connectivity; if it fails, mark unavailable.
    // We run this synchronously during first access (same as Docker availability check pattern).
    try {
      execSync(
        `ssh ${this._sshBaseArgs().join(" ")} ${this.config.user}@${this.config.host} exit 0`,
        { stdio: "pipe", timeout: this.config.connectTimeoutMs },
      );
      _sshAvailable = true;
    } catch {
      _sshAvailable = false;
    }
    return _sshAvailable;
  }

  // ── SSH arg builder ──────────────────────────────────────────────────────────

  /** Build base SSH flags (no command yet). */
  private _sshBaseArgs(): string[] {
    const args: string[] = [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `ConnectTimeout=${Math.ceil(this.config.connectTimeoutMs / 1000)}`,
      "-o", `UserKnownHostsFile=${this.config.knownHostsFile}`,
      "-p", String(this.config.port),
      "-i", this.config.keyPath,
    ];
    return args;
  }

  /** Full SSH args array for spawning. */
  private _sshArgs(remoteCommand: string): string[] {
    return [
      ...this._sshBaseArgs(),
      `${this.config.user}@${this.config.host}`,
      remoteCommand,
    ];
  }

  /** SCP args for upload. */
  private _scpArgs(src: string, dest: string): string[] {
    return [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `ConnectTimeout=${Math.ceil(this.config.connectTimeoutMs / 1000)}`,
      "-o", `UserKnownHostsFile=${this.config.knownHostsFile}`,
      "-P", String(this.config.port),
      "-i", this.config.keyPath,
      src,
      dest,
    ];
  }

  private _remoteTarget(path: string): string {
    return `${this.config.user}@${this.config.host}:${path}`;
  }

  // ── create ──────────────────────────────────────────────────────────────────

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const random = randomBytes(4).toString("hex");
    const now = Date.now();
    const remoteDir = `/tmp/nexus-sandbox-${spec.taskId}-${random}`;

    // Create remote directory
    const mkdirCmd = `mkdir -p ${remoteDir}`;
    try {
      await execAsync(`ssh ${this._sshArgs(mkdirCmd).join(" ")}`);
    } catch (err: any) {
      throw new Error(`SSHBackend.create: failed to mkdir on remote — ${err.message}`);
    }

    const workdir = spec.workdir ?? remoteDir;

    return {
      id: `ssh-${spec.taskId}-${random}`,
      taskId: spec.taskId,
      backendType: "ssh",
      state: "running",
      backendId: `${this.config.user}@${this.config.host}:${remoteDir}`,
      workdir,
      localWorkdir: spec.localWorkdir,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: spec.ttlMs ? now + spec.ttlMs : undefined,
      metadata: {
        remoteDir,
        host: this.config.host,
        user: this.config.user,
        port: String(this.config.port),
        env: JSON.stringify(spec.env ?? {}),
      },
    };
  }

  // ── exec ─────────────────────────────────────────────────────────────────────

  async exec(handle: SandboxHandle, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const start = Date.now();
    const remoteDir = handle.metadata["remoteDir"] ?? handle.workdir;
    const cwd = opts?.cwd ?? remoteDir;

    // Build env prefix
    const envEntries = { ...(JSON.parse(handle.metadata["env"] ?? "{}") as Record<string, string>), ...opts?.env };
    const envPrefix = Object.entries(envEntries)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    const envStr = envPrefix ? `export ${envPrefix}; ` : "";

    const remoteCmd = `cd ${cwd} && ${envStr}${command}`;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    try {
      const { stdout, stderr } = await execAsync(
        `ssh ${this._sshArgs(remoteCmd).join(" ")}`,
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
    const remoteDir = handle.metadata["remoteDir"] ?? handle.workdir;
    const cwd = opts?.cwd ?? remoteDir;

    const envEntries = { ...(JSON.parse(handle.metadata["env"] ?? "{}") as Record<string, string>), ...opts?.env };
    const envPrefix = Object.entries(envEntries)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    const envStr = envPrefix ? `export ${envPrefix}; ` : "";

    const remoteCmd = `cd ${cwd} && ${envStr}${command}`;
    const child = spawn("ssh", this._sshArgs(remoteCmd));

    if (opts?.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

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
    const remoteDir = handle.metadata["remoteDir"] ?? handle.workdir;
    const remoteDest = `${remoteDir}/${sandboxPath}`;

    // Ensure parent directory exists on remote
    const parentDir = remoteDest.substring(0, remoteDest.lastIndexOf("/"));
    if (parentDir) {
      await execAsync(`ssh ${this._sshArgs(`mkdir -p ${parentDir}`).join(" ")}`);
    }

    const scpArgs = this._scpArgs(localPath, this._remoteTarget(remoteDest));
    await execAsync(`scp ${scpArgs.join(" ")}`);
  }

  // ── download ─────────────────────────────────────────────────────────────────

  async download(handle: SandboxHandle, sandboxPath: string, localPath: string): Promise<void> {
    const remoteDir = handle.metadata["remoteDir"] ?? handle.workdir;
    const remoteSrc = `${remoteDir}/${sandboxPath}`;

    mkdirSync(dirname(localPath), { recursive: true });

    const scpArgs = this._scpArgs(this._remoteTarget(remoteSrc), localPath);
    await execAsync(`scp ${scpArgs.join(" ")}`);
  }

  // ── extractArtifacts ─────────────────────────────────────────────────────────

  async extractArtifacts(
    handle: SandboxHandle,
    patterns: string[],
    destDir: string,
  ): Promise<ArtifactRef[]> {
    mkdirSync(destDir, { recursive: true });
    const remoteDir = handle.metadata["remoteDir"] ?? handle.workdir;
    const artifacts: ArtifactRef[] = [];
    const now = Date.now();

    for (const pattern of patterns) {
      try {
        const findCmd = `find ${remoteDir} -name ${JSON.stringify(pattern)} -type f 2>/dev/null`;
        const { stdout } = await execAsync(
          `ssh ${this._sshArgs(findCmd).join(" ")}`,
        );
        const filePaths = stdout.trim().split("\n").filter(Boolean);

        for (const remotePath of filePaths) {
          const relPath = remotePath.startsWith(remoteDir + "/")
            ? remotePath.slice(remoteDir.length + 1)
            : basename(remotePath);
          const localDest = join(destDir, relPath);
          mkdirSync(dirname(localDest), { recursive: true });

          try {
            const scpArgs = this._scpArgs(this._remoteTarget(remotePath), localDest);
            await execAsync(`scp ${scpArgs.join(" ")}`);

            // Get remote file size
            let sizeBytes = 0;
            try {
              const { stdout: szOut } = await execAsync(
                `ssh ${this._sshArgs(`stat -c %s ${remotePath}`).join(" ")}`,
              );
              sizeBytes = parseInt(szOut.trim(), 10) || 0;
            } catch { /* ignore */ }

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
      } catch {
        /* skip patterns that find fails on */
      }
    }

    return artifacts;
  }

  // ── healthCheck ──────────────────────────────────────────────────────────────

  async healthCheck(handle: SandboxHandle): Promise<HealthCheckResult> {
    const start = Date.now();
    const pingCmd = "echo ping";

    try {
      const { stdout } = await execAsync(
        `ssh ${this._sshArgs(pingCmd).join(" ")}`,
        { timeout: this.config.connectTimeoutMs },
      );
      const latencyMs = Date.now() - start;

      if (stdout.trim() === "ping") {
        return { health: "healthy", latencyMs, checkedAt: Date.now() };
      }
      return {
        health: "degraded",
        latencyMs,
        message: "unexpected ping response",
        checkedAt: Date.now(),
      };
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
    const remoteDir = handle.metadata["remoteDir"];
    if (remoteDir && remoteDir.startsWith("/tmp/nexus-sandbox-")) {
      try {
        await execAsync(
          `ssh ${this._sshArgs(`rm -rf ${remoteDir}`).join(" ")}`,
        );
      } catch {
        /* best effort */
      }
    }
    (handle as { state: string }).state = "destroyed";
  }

  // ── list ─────────────────────────────────────────────────────────────────────

  async list(): Promise<SandboxHandle[]> {
    // SSH backend has no persistent registry — enumerate remote temp dirs
    try {
      const listCmd = "ls /tmp/ 2>/dev/null | grep '^nexus-sandbox-'";
      const { stdout } = await execAsync(
        `ssh ${this._sshArgs(listCmd).join(" ")}`,
        { timeout: this.config.connectTimeoutMs },
      );
      const dirs = stdout.trim().split("\n").filter(Boolean);
      const now = Date.now();

      return dirs.map((dir) => {
        const remoteDir = `/tmp/${dir}`;
        // dir format: nexus-sandbox-{taskId}-{random}
        const parts = dir.split("-");
        const taskId = parts.slice(2, -1).join("-") || dir;
        return {
          id: `ssh-${taskId}-${parts.at(-1) ?? ""}`,
          taskId,
          backendType: "ssh" as const,
          state: "running" as const,
          backendId: `${this.config.user}@${this.config.host}:${remoteDir}`,
          workdir: remoteDir,
          createdAt: now,
          lastUsedAt: now,
          metadata: {
            remoteDir,
            host: this.config.host,
            user: this.config.user,
            port: String(this.config.port),
            env: "{}",
          },
        };
      });
    } catch {
      return [];
    }
  }
}
