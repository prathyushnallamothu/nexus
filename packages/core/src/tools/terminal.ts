/**
 * Nexus Terminal Tools
 *
 * Async shell execution with background process management.
 * Replaces the old synchronous execSync with spawn-based async.
 */

import type { Tool } from "../types.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// ── Background Process Registry ──────────────────────────

interface ProcessEntry {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  status: "running" | "done" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const processes = new Map<string, ProcessEntry>();
let processCounter = 0;

// ── Dangerous Command Detection ──────────────────────────

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|--force|-[a-zA-Z]*r|--recursive)/i,
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bdd\s+/i,
  /\b(chmod|chown)\s+.*-R\s+\//i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-fd/i,
  /\bnpm\s+publish\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bcurl\s+.*\|\s*(sh|bash|zsh)\b/i,
  /\bwget\s+.*\|\s*(sh|bash|zsh)\b/i,
  /\bsudo\b/i,
  />\s*\/dev\/(sda|null)\b/,
  /\b:(){.*};:\b/, // fork bomb
];

function isDangerous(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Command matches dangerous pattern: ${pattern.source}`;
    }
  }
  return null;
}

// ── Shell Tool (Async) ──────────────────────────────────

/**
 * Run a shell command asynchronously.
 *
 * Improvements over execSync:
 *   - Non-blocking (async by default)
 *   - Background mode for long-running commands
 *   - Configurable timeout
 *   - Dangerous command detection
 *   - Smart output truncation
 */
export const shellTool: Tool = {
  schema: {
    name: "shell",
    description:
      "Execute a shell command and return its output. Supports foreground (wait for result) and background (runs async) modes. " +
      "Dangerous commands (rm -rf, sudo, force push, etc.) are blocked for safety. " +
      "For long-running commands, use background=true and check status with process_status.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: {
          type: "string",
          description:
            "Working directory for the command. Defaults to current directory.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Max execution time in milliseconds (default 30000, max 120000). Only for foreground.",
          default: 30000,
        },
        background: {
          type: "boolean",
          description:
            "Run in background. Returns immediately with a process ID you can check later.",
          default: false,
        },
      },
      required: ["command"],
    },
  },
  async execute(args) {
    const command = String(args.command);
    const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd();
    const timeoutMs = Math.min(Number(args.timeout_ms ?? 30_000), 120_000);
    const background = Boolean(args.background);

    // Safety check
    const dangerousReason = isDangerous(command);
    if (dangerousReason) {
      return `⚠️ BLOCKED: ${dangerousReason}\n\nThis command was blocked because it could be destructive. If you really need to run it, ask the user for explicit confirmation.`;
    }

    if (background) {
      return runBackground(command, cwd);
    }

    return runForeground(command, cwd, timeoutMs);
  },
};

/** Run a command and wait for it to complete */
function runForeground(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PAGER: "cat" },
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Cap output to prevent memory issues
      if (stdout.length > 1_048_576) {
        killed = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      const parts: string[] = [];
      const trimmedOut = stdout.trim();
      const trimmedErr = stderr.trim();

      if (trimmedOut) {
        if (trimmedOut.length > 10_000) {
          parts.push(
            trimmedOut.slice(0, 5000) +
              `\n\n... (${trimmedOut.length - 10000} chars truncated) ...\n\n` +
              trimmedOut.slice(-5000),
          );
        } else {
          parts.push(trimmedOut);
        }
      }

      if (trimmedErr) {
        parts.push(`stderr:\n${trimmedErr.slice(0, 3000)}`);
      }

      if (killed) {
        parts.push(
          `\n(command ${stdout.length > 1_048_576 ? "output exceeded 1MB" : "timed out"})`,
        );
      }

      parts.push(`exit code: ${code ?? 1}`);
      resolve(parts.join("\n\n") || "(no output)");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error spawning command: ${err.message}`);
    });
  });
}

/** Start a background process and return immediately */
function runBackground(command: string, cwd: string): string {
  const id = `proc_${++processCounter}`;

  const child = spawn("sh", ["-c", command], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PAGER: "cat" },
  });

  const entry: ProcessEntry = {
    id,
    command,
    pid: child.pid ?? -1,
    startedAt: Date.now(),
    status: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
  };

  processes.set(id, entry);

  child.stdout?.on("data", (data: Buffer) => {
    entry.stdout += data.toString();
    // Cap at 1MB
    if (entry.stdout.length > 1_048_576) {
      entry.stdout =
        entry.stdout.slice(0, 500_000) +
        "\n...(truncated)...\n" +
        entry.stdout.slice(-500_000);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    entry.stderr += data.toString();
  });

  child.on("close", (code) => {
    entry.status = code === 0 ? "done" : "error";
    entry.exitCode = code;
  });

  child.on("error", (err) => {
    entry.status = "error";
    entry.stderr += `\nSpawn error: ${err.message}`;
  });

  return `Background process started: ${id} (PID ${child.pid})\nCommand: ${command}\nUse process_status to check progress.`;
}

/**
 * Check status of a background process.
 */
export const processStatusTool: Tool = {
  schema: {
    name: "process_status",
    description:
      "Check the status and output of a background process started with shell(background=true). " +
      "Returns status (running/done/error), exit code, and recent output.",
    parameters: {
      type: "object",
      properties: {
        process_id: {
          type: "string",
          description: "Process ID returned by shell(background=true)",
        },
        tail_lines: {
          type: "number",
          description:
            "Number of output lines to return from the end (default 50)",
          default: 50,
        },
      },
      required: ["process_id"],
    },
  },
  async execute(args) {
    const pid = String(args.process_id);
    const tailLines = Number(args.tail_lines ?? 50);

    const entry = processes.get(pid);
    if (!entry) {
      const available = [...processes.keys()].join(", ") || "(none)";
      return `Process "${pid}" not found. Available: ${available}`;
    }

    const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
    const lines: string[] = [
      `Process: ${entry.id} (PID ${entry.pid})`,
      `Command: ${entry.command}`,
      `Status: ${entry.status}`,
      `Elapsed: ${elapsed}s`,
    ];

    if (entry.exitCode !== null) {
      lines.push(`Exit code: ${entry.exitCode}`);
    }

    const outLines = entry.stdout.trim().split("\n");
    const tail = outLines.slice(-tailLines).join("\n");
    if (tail) {
      lines.push(`\nOutput (last ${Math.min(tailLines, outLines.length)} lines):\n${tail}`);
    }

    if (entry.stderr.trim()) {
      lines.push(
        `\nStderr:\n${entry.stderr.trim().split("\n").slice(-20).join("\n")}`,
      );
    }

    return lines.join("\n");
  },
};

/** All terminal tools */
export const terminalTools: Tool[] = [shellTool, processStatusTool];
