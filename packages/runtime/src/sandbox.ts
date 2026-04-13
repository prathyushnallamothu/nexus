/**
 * Nexus Execution Sandbox
 *
 * Docker-based sandboxing for agent tool execution.
 * Isolates filesystem mutations, network access, and process execution.
 *
 * Falls back to direct local execution when Docker is not available,
 * with a warning logged to the console.
 */

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execAsync = promisify(exec);

export type SandboxMode = "docker" | "local";

export interface SandboxOptions {
  /** Docker image to use. Defaults to node:20-slim */
  image?: string;
  /** Memory limit for the container */
  memoryLimit?: string;
  /** CPU shares */
  cpuShares?: number;
  /** Network mode. 'none' for fully isolated */
  networkMode?: "none" | "bridge" | "host";
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Additional volume mounts: host_path:container_path */
  volumes?: string[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxMode: SandboxMode;
}

const DEFAULT_OPTS: Required<SandboxOptions> = {
  image: "node:20-slim",
  memoryLimit: "512m",
  cpuShares: 512,
  networkMode: "bridge",
  timeoutMs: 30_000,
  volumes: [],
};

// ── Docker availability check ─────────────────────────────

let _dockerAvailable: boolean | null = null;

function isDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execSync("docker info --format '{{.ServerVersion}}'", { stdio: "pipe" });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

// ── Sandbox execution ─────────────────────────────────────

export class Sandbox {
  private opts: Required<SandboxOptions>;
  private containerId: string | null = null;
  private workDir: string | null = null;

  constructor(opts?: SandboxOptions) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /**
   * Run a command in a sandboxed environment.
   * Uses Docker if available, falls back to direct local execution.
   */
  async run(command: string, cwd?: string): Promise<SandboxResult> {
    const startTime = Date.now();

    if (isDockerAvailable()) {
      return this._runInDocker(command, cwd, startTime);
    } else {
      console.warn("[nexus/sandbox] Docker not available — running locally (no isolation)");
      return this._runLocally(command, cwd, startTime);
    }
  }

  /**
   * Start a persistent container for multiple commands.
   * More efficient than creating a new container per command.
   */
  async start(mountDir?: string): Promise<void> {
    if (!isDockerAvailable()) return;

    const volumes = [...this.opts.volumes];
    if (mountDir) volumes.push(`${mountDir}:/workspace`);

    const volArgs = volumes.flatMap((v) => ["-v", v]).join(" ");
    const cmd = [
      "docker run -d --rm",
      `--memory ${this.opts.memoryLimit}`,
      `--cpu-shares ${this.opts.cpuShares}`,
      `--network ${this.opts.networkMode}`,
      volArgs,
      `-w ${mountDir ? "/workspace" : "/tmp"}`,
      this.opts.image,
      "tail -f /dev/null",
    ].filter(Boolean).join(" ");

    const { stdout } = await execAsync(cmd);
    this.containerId = stdout.trim();
  }

  /**
   * Run a command in the persistent container.
   */
  async exec(command: string): Promise<SandboxResult> {
    const startTime = Date.now();

    if (!this.containerId) {
      return this._runLocally(command, undefined, startTime);
    }

    try {
      const { stdout, stderr } = await execAsync(
        `docker exec ${this.containerId} sh -c ${JSON.stringify(command)}`,
        { timeout: this.opts.timeoutMs },
      );
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - startTime, sandboxMode: "docker" };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.code ?? 1,
        durationMs: Date.now() - startTime,
        sandboxMode: "docker",
      };
    }
  }

  /**
   * Stop and remove the persistent container.
   */
  async stop(): Promise<void> {
    if (this.containerId) {
      try { await execAsync(`docker stop ${this.containerId}`); } catch { /* already stopped */ }
      this.containerId = null;
    }

    if (this.workDir && existsSync(this.workDir)) {
      try { rmSync(this.workDir, { recursive: true }); } catch { /* best effort */ }
      this.workDir = null;
    }
  }

  /** Create an isolated workspace directory (temp dir). */
  createWorkDir(): string {
    this.workDir = mkdtempSync(join(tmpdir(), "nexus-sandbox-"));
    return this.workDir;
  }

  private async _runInDocker(command: string, cwd: string | undefined, startTime: number): Promise<SandboxResult> {
    const volumes = [...this.opts.volumes];
    if (cwd) volumes.push(`${cwd}:/workspace`);
    const volArgs = volumes.flatMap((v) => ["-v", v]).join(" ");

    const cmd = [
      "docker run --rm",
      `--memory ${this.opts.memoryLimit}`,
      `--cpu-shares ${this.opts.cpuShares}`,
      `--network ${this.opts.networkMode}`,
      volArgs,
      `-w ${cwd ? "/workspace" : "/tmp"}`,
      this.opts.image,
      "sh", "-c", JSON.stringify(command),
    ].filter(Boolean).join(" ");

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: this.opts.timeoutMs });
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - startTime, sandboxMode: "docker" };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.code ?? 1,
        durationMs: Date.now() - startTime,
        sandboxMode: "docker",
      };
    }
  }

  private async _runLocally(command: string, cwd: string | undefined, startTime: number): Promise<SandboxResult> {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: this.opts.timeoutMs });
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - startTime, sandboxMode: "local" };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.code ?? 1,
        durationMs: Date.now() - startTime,
        sandboxMode: "local",
      };
    }
  }
}

let _sandbox: Sandbox | null = null;

export function getSandbox(opts?: SandboxOptions): Sandbox {
  if (!_sandbox) _sandbox = new Sandbox(opts);
  return _sandbox;
}

export function sandboxModeAvailable(): SandboxMode {
  return isDockerAvailable() ? "docker" : "local";
}
