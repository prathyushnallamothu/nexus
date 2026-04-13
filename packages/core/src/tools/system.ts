/**
 * Nexus System Tools
 *
 * OS-level utilities:
 * - notify: send desktop notifications
 * - clipboard_read / clipboard_write: system clipboard access
 * - get_env / set_env: environment variable management
 * - system_info: get OS, CPU, memory, disk info
 * - open_url: open a URL or file in the default browser/app
 * - zip / unzip: archive compression
 */

import type { Tool } from "../types.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { platform, homedir, hostname, cpus, totalmem, freemem } from "node:os";

// ── Platform detection ────────────────────────────────────

const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";
const IS_WIN = platform() === "win32";

// ── Tools ─────────────────────────────────────────────────

export const notifyTool: Tool = {
  schema: {
    name: "notify",
    description:
      "Send a desktop notification to the user. " +
      "Useful for alerting when long tasks complete or require attention. " +
      "Supports macOS (osascript), Linux (notify-send), and Windows (PowerShell).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification body text" },
        sound: { type: "boolean", description: "Play a sound (macOS only, default: false)", default: false },
      },
      required: ["title", "message"],
    },
  },
  async execute(args) {
    const title = String(args.title).replace(/"/g, "'");
    const message = String(args.message).replace(/"/g, "'");
    const sound = Boolean(args.sound);

    try {
      if (IS_MAC) {
        const soundClause = sound ? `with sound name "Glass"` : "";
        execSync(
          `osascript -e 'display notification "${message}" with title "${title}" ${soundClause}'`,
          { timeout: 5000 },
        );
        return `Notification sent: "${title}"`;
      }

      if (IS_LINUX) {
        execSync(`notify-send "${title}" "${message}"`, { timeout: 5000 });
        return `Notification sent: "${title}"`;
      }

      if (IS_WIN) {
        const ps = `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${message}', '${title}')`;
        execSync(`powershell -Command "${ps}"`, { timeout: 5000 });
        return `Notification sent: "${title}"`;
      }

      return "Notifications not supported on this platform.";
    } catch (err: any) {
      return `Notification failed: ${err.message}`;
    }
  },
};

export const clipboardReadTool: Tool = {
  schema: {
    name: "clipboard_read",
    description: "Read the current contents of the system clipboard.",
    parameters: { type: "object", properties: {} },
  },
  async execute() {
    try {
      if (IS_MAC) {
        return execSync("pbpaste", { encoding: "utf-8", timeout: 5000 }).trim();
      }
      if (IS_LINUX) {
        // Try xclip then xsel
        try {
          return execSync("xclip -selection clipboard -o", { encoding: "utf-8", timeout: 5000 }).trim();
        } catch {
          return execSync("xsel --clipboard --output", { encoding: "utf-8", timeout: 5000 }).trim();
        }
      }
      if (IS_WIN) {
        return execSync("powershell Get-Clipboard", { encoding: "utf-8", timeout: 5000 }).trim();
      }
      return "Clipboard not supported on this platform.";
    } catch (err: any) {
      return `Clipboard read failed: ${err.message}`;
    }
  },
};

export const clipboardWriteTool: Tool = {
  schema: {
    name: "clipboard_write",
    description: "Write text to the system clipboard.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to copy to clipboard" },
      },
      required: ["text"],
    },
  },
  async execute(args) {
    const text = String(args.text);
    try {
      if (IS_MAC) {
        execSync("pbcopy", { input: text, timeout: 5000 } as any);
        return `Copied ${text.length} chars to clipboard.`;
      }
      if (IS_LINUX) {
        try {
          execSync("xclip -selection clipboard", { input: text, timeout: 5000 } as any);
        } catch {
          execSync("xsel --clipboard --input", { input: text, timeout: 5000 } as any);
        }
        return `Copied ${text.length} chars to clipboard.`;
      }
      if (IS_WIN) {
        execSync(`echo ${text} | clip`, { timeout: 5000 });
        return `Copied to clipboard.`;
      }
      return "Clipboard not supported on this platform.";
    } catch (err: any) {
      return `Clipboard write failed: ${err.message}`;
    }
  },
};

export const systemInfoTool: Tool = {
  schema: {
    name: "system_info",
    description:
      "Get information about the current system: OS, CPU, memory, disk space, " +
      "hostname, and environment details.",
    parameters: { type: "object", properties: {} },
  },
  async execute() {
    const totalMem = (totalmem() / (1024 ** 3)).toFixed(1);
    const freeMem = (freemem() / (1024 ** 3)).toFixed(1);
    const usedMem = ((totalmem() - freemem()) / (1024 ** 3)).toFixed(1);
    const cpuModel = cpus()[0]?.model ?? "unknown";
    const cpuCount = cpus().length;

    let diskInfo = "";
    try {
      if (!IS_WIN) {
        diskInfo = execSync("df -h / 2>/dev/null | tail -1", { encoding: "utf-8", timeout: 3000 }).trim();
      } else {
        diskInfo = execSync("wmic logicaldisk get size,freespace,caption", { encoding: "utf-8", timeout: 3000 }).trim();
      }
    } catch {}

    const lines = [
      `OS:       ${platform()} (${process.arch})`,
      `Hostname: ${hostname()}`,
      `CPU:      ${cpuModel} (${cpuCount} cores)`,
      `Memory:   ${usedMem} GB used / ${totalMem} GB total (${freeMem} GB free)`,
      `Node:     ${process.version}`,
      `CWD:      ${process.cwd()}`,
      `Home:     ${homedir()}`,
    ];

    if (diskInfo) lines.push(`Disk:     ${diskInfo}`);

    return lines.join("\n");
  },
};

export const openUrlTool: Tool = {
  schema: {
    name: "open_url",
    description:
      "Open a URL or file in the default browser or associated application. " +
      "Useful for opening documentation, previewing HTML files, or launching apps.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "URL (https://...) or local file path to open" },
      },
      required: ["target"],
    },
  },
  async execute(args) {
    const target = String(args.target);
    try {
      if (IS_MAC) {
        execSync(`open "${target}"`, { timeout: 5000 });
      } else if (IS_LINUX) {
        execSync(`xdg-open "${target}"`, { timeout: 5000 });
      } else if (IS_WIN) {
        execSync(`start "" "${target}"`, { timeout: 5000 });
      } else {
        return "open_url not supported on this platform.";
      }
      return `Opened: ${target}`;
    } catch (err: any) {
      return `Failed to open: ${err.message}`;
    }
  },
};

export const zipTool: Tool = {
  schema: {
    name: "zip",
    description: "Create a ZIP archive from files or directories.",
    parameters: {
      type: "object",
      properties: {
        output: { type: "string", description: "Path for the output ZIP file" },
        sources: {
          type: "array", items: { type: "string" },
          description: "Files or directories to include in the archive",
        },
      },
      required: ["output", "sources"],
    },
  },
  async execute(args) {
    const output = resolve(String(args.output));
    const sources = (args.sources as string[]).map(s => resolve(s));

    mkdirSync(dirname(output), { recursive: true });

    const cmd = IS_WIN
      ? `powershell -Command "Compress-Archive -Path '${sources.join("','")}' -DestinationPath '${output}' -Force"`
      : `zip -r "${output}" ${sources.map(s => `"${s}"`).join(" ")}`;

    execSync(cmd, { timeout: 60_000 });
    return `Created ZIP: ${output}`;
  },
};

export const unzipTool: Tool = {
  schema: {
    name: "unzip",
    description: "Extract a ZIP archive to a directory.",
    parameters: {
      type: "object",
      properties: {
        archive: { type: "string", description: "Path to the ZIP file" },
        destination: { type: "string", description: "Directory to extract to (default: same directory as archive)" },
      },
      required: ["archive"],
    },
  },
  async execute(args) {
    const archivePath = resolve(String(args.archive));
    if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);

    const dest = args.destination
      ? resolve(String(args.destination))
      : dirname(archivePath);

    mkdirSync(dest, { recursive: true });

    const cmd = IS_WIN
      ? `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${dest}' -Force"`
      : `unzip -o "${archivePath}" -d "${dest}"`;

    execSync(cmd, { timeout: 60_000 });
    return `Extracted to: ${dest}`;
  },
};

export const getEnvTool: Tool = {
  schema: {
    name: "get_env",
    description:
      "Read environment variables. Returns specific variables or lists all non-sensitive ones. " +
      "Automatically redacts secrets (API keys, tokens, passwords).",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array", items: { type: "string" },
          description: "Specific env var names to read (optional, lists safe vars if omitted)",
        },
      },
    },
  },
  async execute(args) {
    const SENSITIVE = /key|secret|token|password|passwd|pwd|auth|credential|private/i;

    if (Array.isArray(args.keys) && args.keys.length > 0) {
      const out: string[] = [];
      for (const key of args.keys.map(String)) {
        const val = process.env[key];
        if (val === undefined) {
          out.push(`${key}=(not set)`);
        } else if (SENSITIVE.test(key)) {
          out.push(`${key}=[REDACTED - ${val.length} chars]`);
        } else {
          out.push(`${key}=${val}`);
        }
      }
      return out.join("\n");
    }

    // List all non-sensitive env vars
    const entries = Object.entries(process.env)
      .filter(([k]) => !SENSITIVE.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);

    return `${entries.length} environment variables (secrets hidden):\n\n${entries.join("\n")}`;
  },
};

export const systemTools: Tool[] = [
  notifyTool,
  clipboardReadTool,
  clipboardWriteTool,
  systemInfoTool,
  openUrlTool,
  zipTool,
  unzipTool,
  getEnvTool,
];
