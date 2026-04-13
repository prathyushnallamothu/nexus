/**
 * Nexus Sandbox — Backwards-compatible re-export
 *
 * The full sandbox system lives in ./sandbox/
 * This file re-exports the public API and also keeps the legacy
 * Sandbox + getSandbox + sandboxModeAvailable exports working.
 */

export * from "./sandbox/index.js";

// ── Legacy compat ──────────────────────────────────────────
// Keep old API working for any code that imported from sandbox.ts directly.

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execAsync = promisify(exec);

export type SandboxMode = "docker" | "local";

export interface SandboxOptions {
  image?: string;
  memoryLimit?: string;
  cpuShares?: number;
  networkMode?: "none" | "bridge" | "host";
  timeoutMs?: number;
  volumes?: string[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxMode: SandboxMode;
}

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

/** @deprecated Use SandboxManager from ./sandbox/index.js */
export class Sandbox {
  private opts: Required<SandboxOptions>;
  private containerId: string | null = null;
  private workDir: string | null = null;

  constructor(opts?: SandboxOptions) {
    this.opts = {
      image: opts?.image ?? "node:20-slim",
      memoryLimit: opts?.memoryLimit ?? "512m",
      cpuShares: opts?.cpuShares ?? 512,
      networkMode: opts?.networkMode ?? "bridge",
      timeoutMs: opts?.timeoutMs ?? 30_000,
      volumes: opts?.volumes ?? [],
    };
  }

  async run(command: string, cwd?: string): Promise<SandboxResult> {
    const startTime = Date.now();
    if (isDockerAvailable()) return this._runInDocker(command, cwd, startTime);
    console.warn("[nexus/sandbox] Docker not available — running locally (no isolation)");
    return this._runLocally(command, cwd, startTime);
  }

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

  async exec(command: string): Promise<SandboxResult> {
    const startTime = Date.now();
    if (!this.containerId) return this._runLocally(command, undefined, startTime);
    try {
      const { stdout, stderr } = await execAsync(
        `docker exec ${this.containerId} sh -c ${JSON.stringify(command)}`,
        { timeout: this.opts.timeoutMs },
      );
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - startTime, sandboxMode: "docker" };
    } catch (err: any) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, exitCode: err.code ?? 1, durationMs: Date.now() - startTime, sandboxMode: "docker" };
    }
  }

  async stop(): Promise<void> {
    if (this.containerId) {
      try { await execAsync(`docker stop ${this.containerId}`); } catch { /* already stopped */ }
      this.containerId = null;
    }
    if (this.workDir && existsSync(this.workDir)) {
      try { rmSync(this.workDir, { recursive: true }); } catch {}
      this.workDir = null;
    }
  }

  createWorkDir(): string {
    this.workDir = mkdtempSync(join(tmpdir(), "nexus-sandbox-"));
    return this.workDir;
  }

  private async _runInDocker(command: string, cwd: string | undefined, startTime: number): Promise<SandboxResult> {
    const volumes = [...this.opts.volumes];
    if (cwd) volumes.push(`${cwd}:/workspace`);
    const volArgs = volumes.flatMap((v) => ["-v", v]).join(" ");
    const cmd = ["docker run --rm", `--memory ${this.opts.memoryLimit}`, `--cpu-shares ${this.opts.cpuShares}`, `--network ${this.opts.networkMode}`, volArgs, `-w ${cwd ? "/workspace" : "/tmp"}`, this.opts.image, "sh", "-c", JSON.stringify(command)].filter(Boolean).join(" ");
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: this.opts.timeoutMs });
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - startTime, sandboxMode: "docker" };
    } catch (err: any) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, exitCode: err.code ?? 1, durationMs: Date.now() - startTime, sandboxMode: "docker" };
    }
  }

  private async _runLocally(command: string, cwd: string | undefined, startTime: number): Promise<SandboxResult> {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: this.opts.timeoutMs });
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - startTime, sandboxMode: "local" };
    } catch (err: any) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, exitCode: err.code ?? 1, durationMs: Date.now() - startTime, sandboxMode: "local" };
    }
  }
}

let _sandbox: Sandbox | null = null;

/** @deprecated Use createSandboxManager() instead */
export function getSandbox(opts?: SandboxOptions): Sandbox {
  if (!_sandbox) _sandbox = new Sandbox(opts);
  return _sandbox;
}

/** @deprecated Use SandboxManager.list() instead */
export function sandboxModeAvailable(): SandboxMode {
  return isDockerAvailable() ? "docker" : "local";
}
