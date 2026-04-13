/**
 * Permission Guard
 *
 * Path-based access control for file system operations.
 * Defines allowed/denied directories and file patterns,
 * preventing the agent from touching sensitive areas.
 */

import type { Middleware, AgentContext, NextFn } from "@nexus/core";
import { resolve, relative, sep } from "node:path";

export interface PermissionPolicy {
  /** Directories the agent can access (relative to workdir) */
  allowedPaths: string[];
  /** Directories explicitly blocked */
  blockedPaths: string[];
  /** File patterns to block (glob-like) */
  blockedPatterns: RegExp[];
  /** Whether to allow access outside the working directory */
  allowOutsideWorkdir: boolean;
}

const DEFAULT_POLICY: PermissionPolicy = {
  allowedPaths: ["."], // Current directory
  blockedPaths: [
    ".git/objects",
    ".git/refs",
    "node_modules/.cache",
  ],
  blockedPatterns: [
    /\.env\.production$/,
    /\.pem$/,
    /id_rsa/,
    /\.ssh\//,
    /\.gnupg\//,
  ],
  allowOutsideWorkdir: false,
};

export class PermissionGuard {
  private policy: PermissionPolicy;
  private workdir: string;
  private violations: Array<{ path: string; reason: string; timestamp: number }> = [];

  constructor(workdir: string, policy?: Partial<PermissionPolicy>) {
    this.workdir = resolve(workdir);
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /** Check if a path is allowed */
  check(targetPath: string): { allowed: boolean; reason: string } {
    const absolutePath = resolve(targetPath);
    const relativePath = relative(this.workdir, absolutePath);

    // Check if outside workdir
    if (!this.policy.allowOutsideWorkdir) {
      if (relativePath.startsWith("..") || relativePath.startsWith(`.${sep}..`)) {
        this.recordViolation(targetPath, "Outside working directory");
        return { allowed: false, reason: "Path is outside the working directory" };
      }
    }

    // Check blocked paths
    for (const blocked of this.policy.blockedPaths) {
      const blockedAbs = resolve(this.workdir, blocked);
      if (absolutePath.startsWith(blockedAbs)) {
        this.recordViolation(targetPath, `Blocked directory: ${blocked}`);
        return { allowed: false, reason: `Access denied: ${blocked} is a protected directory` };
      }
    }

    // Check blocked patterns
    for (const pattern of this.policy.blockedPatterns) {
      if (pattern.test(absolutePath) || pattern.test(relativePath)) {
        this.recordViolation(targetPath, `Blocked pattern: ${pattern.source}`);
        return { allowed: false, reason: `Access denied: file matches blocked pattern ${pattern.source}` };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  /** Get all recorded violations */
  getViolations(): Array<{ path: string; reason: string; timestamp: number }> {
    return [...this.violations];
  }

  private recordViolation(path: string, reason: string): void {
    this.violations.push({ path, reason, timestamp: Date.now() });
  }
}

/**
 * Permission Middleware
 *
 * Wraps file tools (read_file, write_file, search_files)
 * with path permission checks.
 */
export function permissionMiddleware(guard: PermissionGuard): Middleware {
  const FILE_TOOLS = new Set(["read_file", "write_file", "search_files", "list_files"]);

  return {
    name: "permission-guard",
    async execute(ctx: AgentContext, next: NextFn) {
      const originalTools = ctx.tools;

      ctx.tools = originalTools.map((tool) => {
        if (!FILE_TOOLS.has(tool.schema.name)) return tool;

        return {
          schema: tool.schema,
          execute: async (args: Record<string, unknown>) => {
            const path = String(args.path ?? args.cwd ?? ".");
            const result = guard.check(path);

            if (!result.allowed) {
              throw new Error(`🔒 ${result.reason}`);
            }

            return tool.execute(args);
          },
        };
      });

      await next();
      ctx.tools = originalTools;
    },
  };
}
