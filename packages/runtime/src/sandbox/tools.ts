/**
 * Nexus Sandbox — Agent Tool Wrappers
 *
 * Provides agent-facing tools that route execution through the SandboxManager.
 * When a sandbox is active, ALL command and file operations are sandboxed.
 * Outside the sandbox, the governance layer (PermissionGuard, PolicyEngine) applies.
 *
 * Tools exposed:
 *   sandbox_exec      — run a shell command inside the active sandbox
 *   sandbox_read      — read a file from the sandbox filesystem
 *   sandbox_write     — write a file to the sandbox filesystem
 *   sandbox_upload    — copy a local file into the sandbox
 *   sandbox_download  — copy a file from the sandbox to local
 *   sandbox_stream    — stream a command's output (yields chunks)
 *   sandbox_status    — show sandbox health and metadata
 *   sandbox_extract   — extract artifact files from sandbox
 */

import type { Tool } from "@nexus/core";
import type { SandboxManager } from "./manager.js";

// ── Tool factory ───────────────────────────────────────────

export function createSandboxTools(manager: SandboxManager, taskId: string): Tool[] {
  return [
    sandboxExecTool(manager, taskId),
    sandboxReadTool(manager, taskId),
    sandboxWriteTool(manager, taskId),
    sandboxUploadTool(manager, taskId),
    sandboxDownloadTool(manager, taskId),
    sandboxStatusTool(manager, taskId),
    sandboxExtractTool(manager, taskId),
  ];
}

// ── sandbox_exec ──────────────────────────────────────────

function sandboxExecTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_exec",
      description:
        "Run a shell command inside the active sandbox. Full permissions apply inside the sandbox. " +
        "Returns stdout, stderr, and exit code. Use this instead of the regular shell tool when working inside a sandbox.",
      parameters: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory inside sandbox (optional)" },
          timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
          stdin: { type: "string", description: "Data to pipe to stdin (optional)" },
        },
        required: ["command"],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const command = String(args["command"] ?? "");
      const cwd = args["cwd"] ? String(args["cwd"]) : undefined;
      const timeoutMs = args["timeout_ms"] ? Number(args["timeout_ms"]) : 30_000;
      const stdin = args["stdin"] ? String(args["stdin"]) : undefined;

      try {
        const result = await manager.exec(taskId, command, { cwd, timeoutMs, stdin });
        const parts: string[] = [];
        if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`);
        if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
        parts.push(`Exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
        parts.push(`Duration: ${result.durationMs}ms`);
        return parts.join("\n\n");
      } catch (err: any) {
        const handle = manager.get(taskId);
        if (!handle) {
          return `Error: No active sandbox for task "${taskId}". Acquire one first.`;
        }
        return `Error executing command: ${err.message}`;
      }
    },
  };
}

// ── sandbox_read ──────────────────────────────────────────

function sandboxReadTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_read",
      description: "Read a file from the sandbox filesystem. Path is relative to the sandbox working directory.",
      parameters: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path inside sandbox (relative to workdir)" },
          encoding: { type: "string", description: "Text encoding (default: utf-8). Use 'base64' for binary files." },
        },
        required: ["path"],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const path = String(args["path"] ?? "");
      const encoding = args["encoding"] ? String(args["encoding"]) : "utf-8";
      const isBase64 = encoding === "base64";

      const result = await manager.exec(taskId, isBase64
        ? `base64 "${path.replace(/"/g, '\\"')}"`
        : `cat "${path.replace(/"/g, '\\"')}"`,
      );

      if (result.exitCode !== 0) {
        return `Error reading file "${path}": ${result.stderr || "file not found"}`;
      }
      return result.stdout;
    },
  };
}

// ── sandbox_write ─────────────────────────────────────────

function sandboxWriteTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_write",
      description: "Write content to a file inside the sandbox. Creates parent directories as needed.",
      parameters: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path inside sandbox (relative to workdir)" },
          content: { type: "string", description: "File content to write" },
          append: { type: "boolean", description: "Append to file instead of overwriting (default: false)" },
        },
        required: ["path", "content"],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const path = String(args["path"] ?? "");
      const content = String(args["content"] ?? "");
      const append = Boolean(args["append"] ?? false);

      // Create parent directories and write file
      const escapedPath = path.replace(/"/g, '\\"');
      const mkdirCmd = `mkdir -p "$(dirname "${escapedPath}")"`;
      const op = append ? ">>" : ">";
      // Write via heredoc to handle special chars safely
      const writeCmd = `cat ${op} "${escapedPath}" << 'NEXUS_EOF'\n${content}\nNEXUS_EOF`;

      const mkResult = await manager.exec(taskId, mkdirCmd);
      if (mkResult.exitCode !== 0) {
        return `Error creating directory for "${path}": ${mkResult.stderr}`;
      }

      const result = await manager.exec(taskId, writeCmd);
      if (result.exitCode !== 0) {
        return `Error writing file "${path}": ${result.stderr}`;
      }
      return `✓ Written ${content.length} bytes to "${path}"`;
    },
  };
}

// ── sandbox_upload ────────────────────────────────────────

function sandboxUploadTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_upload",
      description: "Upload a local file into the sandbox filesystem.",
      parameters: {
        type: "object" as const,
        properties: {
          local_path: { type: "string", description: "Absolute local path of the file to upload" },
          sandbox_path: { type: "string", description: "Destination path inside sandbox (relative to workdir)" },
        },
        required: ["local_path", "sandbox_path"],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const localPath = String(args["local_path"] ?? "");
      const sandboxPath = String(args["sandbox_path"] ?? "");

      try {
        await manager.upload(taskId, localPath, sandboxPath);
        return `✓ Uploaded "${localPath}" → sandbox:"${sandboxPath}"`;
      } catch (err: any) {
        return `Error uploading file: ${err.message}`;
      }
    },
  };
}

// ── sandbox_download ──────────────────────────────────────

function sandboxDownloadTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_download",
      description: "Download a file from the sandbox to the local filesystem.",
      parameters: {
        type: "object" as const,
        properties: {
          sandbox_path: { type: "string", description: "Path inside sandbox to download (relative to workdir)" },
          local_path: { type: "string", description: "Local destination path for the downloaded file" },
        },
        required: ["sandbox_path", "local_path"],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const sandboxPath = String(args["sandbox_path"] ?? "");
      const localPath = String(args["local_path"] ?? "");

      try {
        await manager.download(taskId, sandboxPath, localPath);
        return `✓ Downloaded sandbox:"${sandboxPath}" → "${localPath}"`;
      } catch (err: any) {
        return `Error downloading file: ${err.message}`;
      }
    },
  };
}

// ── sandbox_status ────────────────────────────────────────

function sandboxStatusTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_status",
      description: "Show the current status and health of the active sandbox.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    execute: async (_args: Record<string, unknown>) => {
      const handle = manager.get(taskId);
      if (!handle) {
        return `No active sandbox for task "${taskId}".`;
      }

      const health = await manager.healthCheck(taskId);
      const age = Math.round((Date.now() - handle.createdAt) / 1000);
      const idle = Math.round((Date.now() - handle.lastUsedAt) / 1000);
      const ttl = handle.expiresAt
        ? Math.max(0, Math.round((handle.expiresAt - Date.now()) / 1000))
        : null;

      const lines = [
        `Sandbox: ${handle.id}`,
        `Backend: ${handle.backendType}  (${handle.backendId.slice(0, 16)}...)`,
        `State: ${handle.state}`,
        `Health: ${health.health} (${health.latencyMs}ms)`,
        `Workdir: ${handle.workdir}`,
        `Age: ${age}s  Idle: ${idle}s${ttl !== null ? `  TTL: ${ttl}s` : ""}`,
      ];
      if (health.message) lines.push(`Note: ${health.message}`);
      return lines.join("\n");
    },
  };
}

// ── sandbox_extract ───────────────────────────────────────

function sandboxExtractTool(manager: SandboxManager, taskId: string): Tool {
  return {
    schema: {
      name: "sandbox_extract",
      description:
        "Extract artifact files from the sandbox to the local artifacts directory. " +
        "Returns a list of extracted files with their local paths.",
      parameters: {
        type: "object" as const,
        properties: {
          patterns: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns for files to extract (e.g. ['**/*.py', 'dist/**', 'output.json'])",
          },
        },
        required: ["patterns"],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const patterns = Array.isArray(args["patterns"]) ? args["patterns"].map(String) : [];
      if (patterns.length === 0) return "No patterns specified.";

      try {
        const artifacts = await manager.extractArtifacts(taskId, patterns);
        if (artifacts.length === 0) {
          return `No files matched patterns: ${patterns.join(", ")}`;
        }
        const lines = [`Extracted ${artifacts.length} artifact(s):`];
        for (const a of artifacts) {
          const sizeKb = (a.sizeBytes / 1024).toFixed(1);
          lines.push(`  ${a.sandboxPath} → ${a.localPath} (${sizeKb}KB)`);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `Error extracting artifacts: ${err.message}`;
      }
    },
  };
}
