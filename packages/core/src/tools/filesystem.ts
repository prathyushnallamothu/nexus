/**
 * Nexus Filesystem Tools
 *
 * Read, write, patch, list, and search files.
 */

import type { Tool } from "../types.js";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

/**
 * Read a file from disk.
 */
export const readFileTool: Tool = {
  schema: {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the full file content as a string.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      if (lines.length > 500) {
        return `${lines.slice(0, 500).join("\n")}\n\n... (${lines.length - 500} more lines truncated)`;
      }
      return content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read file "${filePath}": ${msg}`);
    }
  },
};

/**
 * Write content to a file, creating directories as needed.
 */
export const writeFileTool: Tool = {
  schema: {
    name: "write_file",
    description:
      "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    const content = String(args.content);
    try {
      const dir = filePath.replace(/[/\\][^/\\]*$/, "");
      if (!existsSync(dir)) {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, content, "utf-8");
      return `File written: ${filePath} (${content.length} chars)`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write file "${filePath}": ${msg}`);
    }
  },
};

/**
 * Apply a targeted patch to a file — edit specific lines without rewriting the whole file.
 *
 * This is far more reliable than write_file for modifications because:
 *   1. You only specify what changes, reducing errors
 *   2. You can't accidentally delete content you meant to keep
 *   3. The LLM doesn't need to reproduce the entire file
 */
export const patchFileTool: Tool = {
  schema: {
    name: "patch_file",
    description:
      "Apply targeted edits to a file. Finds the exact 'old_text' in the file and replaces it with 'new_text'. " +
      "Much safer than write_file for modifications — you only specify what changes. " +
      "The old_text must match EXACTLY (including whitespace and indentation).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to patch" },
        old_text: {
          type: "string",
          description: "Exact text to find and replace (must match exactly)",
        },
        new_text: {
          type: "string",
          description: "Replacement text",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    const oldText = String(args.old_text);
    const newText = String(args.new_text);

    try {
      const content = readFileSync(filePath, "utf-8");
      const idx = content.indexOf(oldText);

      if (idx === -1) {
        // Try to help the LLM fix the match
        const lines = oldText.split("\n");
        const firstLine = lines[0].trim();
        const approxMatch = content
          .split("\n")
          .findIndex((l) => l.trim() === firstLine);

        if (approxMatch >= 0) {
          return `Error: old_text not found exactly. A similar line exists at line ${approxMatch + 1}. Check whitespace/indentation.`;
        }
        return `Error: old_text not found in "${filePath}". Read the file first to see its current content.`;
      }

      // Check for multiple matches
      const secondIdx = content.indexOf(oldText, idx + 1);
      if (secondIdx !== -1) {
        return `Error: old_text found multiple times in "${filePath}". Provide more context to make the match unique.`;
      }

      const newContent = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
      writeFileSync(filePath, newContent, "utf-8");

      const linesChanged = newText.split("\n").length;
      return `Patched "${filePath}": replaced ${oldText.split("\n").length} lines with ${linesChanged} lines.`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to patch file "${filePath}": ${msg}`);
    }
  },
};

/**
 * List files in a directory.
 */
export const listFilesTool: Tool = {
  schema: {
    name: "list_files",
    description:
      "List files and directories in a given path. Returns names with type indicators (/ for dirs).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path to list. Defaults to current directory.",
          default: ".",
        },
      },
    },
  },
  async execute(args) {
    const dirPath = resolve(String(args.path ?? "."));
    try {
      const entries = readdirSync(dirPath);
      const result = entries.map((entry) => {
        try {
          const fullPath = join(dirPath, entry);
          const stat = statSync(fullPath);
          return stat.isDirectory() ? `${entry}/` : entry;
        } catch {
          return entry;
        }
      });
      return result.join("\n") || "(empty directory)";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list directory "${dirPath}": ${msg}`);
    }
  },
};

/**
 * Search for text in files (like grep/ripgrep).
 */
export const searchFilesTool: Tool = {
  schema: {
    name: "search_files",
    description:
      "Search for a text pattern in files within a directory. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text or regex pattern to search for",
        },
        path: {
          type: "string",
          description:
            "Directory to search in. Defaults to current directory.",
          default: ".",
        },
        include: {
          type: "string",
          description: "File glob pattern to include, e.g. '*.ts' or '*.py'",
        },
      },
      required: ["pattern"],
    },
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const searchPath = resolve(String(args.path ?? "."));
    const include = args.include ? `--include="${args.include}"` : "";

    try {
      const isWindows = process.platform === "win32";
      let command: string;

      if (isWindows) {
        command = `findstr /S /N /I /C:"${pattern.replace(/"/g, "")}" "${searchPath}\\*"`;
        if (args.include) {
          const ext = String(args.include).replace("*", "");
          command = `findstr /S /N /I /C:"${pattern.replace(/"/g, "")}" "${searchPath}\\*${ext}"`;
        }
      } else {
        command = `grep -rn ${include} "${pattern}" "${searchPath}" 2>/dev/null | head -50`;
      }

      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 512 * 1024,
      }).trim();

      if (!output) return "No matches found.";
      const lines = output.split("\n");
      if (lines.length > 50) {
        return (
          lines.slice(0, 50).join("\n") +
          `\n\n... (${lines.length - 50} more matches)`
        );
      }
      return output;
    } catch {
      return "No matches found.";
    }
  },
};

/** All filesystem tools */
export const filesystemTools: Tool[] = [
  readFileTool,
  writeFileTool,
  patchFileTool,
  listFilesTool,
  searchFilesTool,
];
