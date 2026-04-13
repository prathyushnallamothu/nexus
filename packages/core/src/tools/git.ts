/**
 * Nexus Git Tools
 *
 * Dedicated git operations — status, diff, commit, branch, log.
 * Safer and more structured than raw `shell("git ...")`.
 */

import type { Tool } from "../types.js";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message?: string };
    throw new Error(execError.stderr?.trim() || execError.message || "Git command failed");
  }
}

export const gitStatusTool: Tool = {
  schema: {
    name: "git_status",
    description:
      "Show the current git status — modified, staged, and untracked files. Also shows the current branch.",
    parameters: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Repository directory. Defaults to current directory.",
        },
      },
    },
  },
  async execute(args) {
    const cwd = resolve(String(args.cwd ?? "."));
    const branch = git("branch --show-current", cwd);
    const status = git("status --short", cwd);
    const ahead = git("rev-list --count @{u}..HEAD 2>/dev/null || echo 0", cwd);

    return [
      `Branch: ${branch}`,
      ahead !== "0" ? `Ahead by ${ahead} commit(s)` : "",
      "",
      status || "(working tree clean)",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

export const gitDiffTool: Tool = {
  schema: {
    name: "git_diff",
    description:
      "Show the diff of changed files. By default shows unstaged changes. Use staged=true for staged changes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Specific file to diff (optional, defaults to all files)",
        },
        staged: {
          type: "boolean",
          description: "Show staged (--cached) diff instead of unstaged",
          default: false,
        },
        cwd: {
          type: "string",
          description: "Repository directory. Defaults to current directory.",
        },
      },
    },
  },
  async execute(args) {
    const cwd = resolve(String(args.cwd ?? "."));
    const staged = args.staged ? "--cached" : "";
    const path = args.path ? `-- "${args.path}"` : "";
    const diff = git(`diff ${staged} ${path}`.trim(), cwd);

    if (!diff) return "(no changes)";

    // Truncate large diffs
    if (diff.length > 15_000) {
      const lines = diff.split("\n");
      return (
        lines.slice(0, 300).join("\n") +
        `\n\n... (${lines.length - 300} more lines, diff truncated)`
      );
    }
    return diff;
  },
};

export const gitCommitTool: Tool = {
  schema: {
    name: "git_commit",
    description:
      "Stage and commit changes. Stages the specified files (or all changes) and creates a commit.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Files to stage. If empty, stages all changes (git add -A).",
        },
        cwd: {
          type: "string",
          description: "Repository directory.",
        },
      },
      required: ["message"],
    },
  },
  async execute(args) {
    const cwd = resolve(String(args.cwd ?? "."));
    const message = String(args.message);
    const files = args.files as string[] | undefined;

    if (files?.length) {
      for (const file of files) {
        git(`add "${file}"`, cwd);
      }
    } else {
      git("add -A", cwd);
    }

    const result = git(`commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
    return result;
  },
};

export const gitLogTool: Tool = {
  schema: {
    name: "git_log",
    description:
      "Show recent commit history. Returns commit hash, author, date, and message.",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of commits to show (default 10, max 50)",
          default: 10,
        },
        oneline: {
          type: "boolean",
          description: "Compact one-line format",
          default: true,
        },
        cwd: {
          type: "string",
          description: "Repository directory.",
        },
      },
    },
  },
  async execute(args) {
    const cwd = resolve(String(args.cwd ?? "."));
    const count = Math.min(Number(args.count ?? 10), 50);
    const oneline = args.oneline !== false;

    const format = oneline
      ? "--oneline"
      : '--format="%h %an (%ar) %s"';

    return git(`log -n ${count} ${format}`, cwd);
  },
};

export const gitBranchTool: Tool = {
  schema: {
    name: "git_branch",
    description:
      "List, create, or switch branches. Action defaults to 'list'.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "'list', 'create', or 'switch'",
          enum: ["list", "create", "switch"],
          default: "list",
        },
        name: {
          type: "string",
          description: "Branch name (required for create/switch)",
        },
        cwd: {
          type: "string",
          description: "Repository directory.",
        },
      },
    },
  },
  async execute(args) {
    const cwd = resolve(String(args.cwd ?? "."));
    const action = String(args.action ?? "list");
    const name = args.name ? String(args.name) : "";

    switch (action) {
      case "list":
        return git("branch -a", cwd);
      case "create":
        if (!name) throw new Error("Branch name required for create");
        return git(`checkout -b "${name}"`, cwd);
      case "switch":
        if (!name) throw new Error("Branch name required for switch");
        return git(`checkout "${name}"`, cwd);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
};

/** All git tools */
export const gitTools: Tool[] = [
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitLogTool,
  gitBranchTool,
];
