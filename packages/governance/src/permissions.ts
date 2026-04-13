/**
 * Permission Guard
 *
 * Path-based access control for file system operations.
 * Defines allowed/denied directories and file patterns,
 * preventing the agent from touching sensitive areas.
 *
 * Extended with:
 *   - fsRoots: absolute path roots that are always allowed
 *   - toolPermissions: per-tool allow/block overrides with arg pattern matching
 *   - readOnly: block all write operations
 *   - allowedExtensions / blockedExtensions: file-extension filtering
 */

import type { Middleware, AgentContext, NextFn } from "@nexus/core";
import { resolve, relative, sep, extname } from "node:path";

export interface PermissionPolicy {
  /** Directories the agent can access (relative to workdir) */
  allowedPaths: string[];
  /** Directories explicitly blocked */
  blockedPaths: string[];
  /** File patterns to block (glob-like) */
  blockedPatterns: RegExp[];
  /** Whether to allow access outside the working directory */
  allowOutsideWorkdir: boolean;

  /**
   * Absolute path roots that are always allowed regardless of workdir.
   * Example: ["/tmp/nexus-sandbox"]
   */
  fsRoots?: string[];

  /**
   * Per-tool permission overrides.
   * Evaluated in addition to path checks.
   */
  toolPermissions?: {
    [toolName: string]: {
      /** Explicitly allow or deny this tool */
      allow?: boolean;
      /** Block the call if any arg (stringified) matches one of these */
      blockedArgPatterns?: RegExp[];
      /** Block the call unless at least one arg matches one of these */
      requiredArgPatterns?: RegExp[];
      /** Human-readable reason shown in the block message */
      reason?: string;
    };
  };

  /** When true, all write operations are blocked */
  readOnly?: boolean;

  /**
   * Whitelist of allowed file extensions (e.g. [".ts", ".json"]).
   * When set, files with other extensions are blocked.
   */
  allowedExtensions?: string[];

  /**
   * Blacklist of blocked file extensions (e.g. [".exe", ".sh"]).
   * Takes precedence over allowedExtensions.
   */
  blockedExtensions?: string[];
}

/** Tools that perform write operations */
const WRITE_TOOLS = new Set(["write_file", "execute_command", "shell", "bash"]);

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

    // fsRoots: absolute roots that bypass workdir restriction
    if (this.policy.fsRoots && this.policy.fsRoots.length > 0) {
      for (const root of this.policy.fsRoots) {
        if (absolutePath.startsWith(root)) {
          // Still apply blocked paths and patterns even inside fsRoots
          return this._checkBlockedPathsAndPatterns(absolutePath, relativePath, targetPath);
        }
      }
    }

    // Check if outside workdir
    if (!this.policy.allowOutsideWorkdir) {
      if (relativePath.startsWith("..") || relativePath.startsWith(`.${sep}..`)) {
        this.recordViolation(targetPath, "Outside working directory");
        return { allowed: false, reason: "Path is outside the working directory" };
      }
    }

    // Extension checks
    const extResult = this._checkExtension(absolutePath, targetPath);
    if (!extResult.allowed) return extResult;

    return this._checkBlockedPathsAndPatterns(absolutePath, relativePath, targetPath);
  }

  /**
   * Check tool-level permissions.
   * Evaluates tool allow/block flags, readOnly mode, and arg pattern rules.
   */
  checkTool(toolName: string, args: Record<string, unknown>): { allowed: boolean; reason: string } {
    // readOnly: block write tools
    if (this.policy.readOnly && WRITE_TOOLS.has(toolName)) {
      const reason = `Tool "${toolName}" is blocked: policy is read-only`;
      this.recordViolation(toolName, reason);
      return { allowed: false, reason };
    }

    const toolPolicy = this.policy.toolPermissions?.[toolName];
    if (!toolPolicy) return { allowed: true, reason: "OK" };

    // Explicit deny
    if (toolPolicy.allow === false) {
      const reason = toolPolicy.reason ?? `Tool "${toolName}" is not permitted`;
      this.recordViolation(toolName, reason);
      return { allowed: false, reason };
    }

    // Arg-level checks — stringify all arg values for pattern matching
    const argString = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");

    if (toolPolicy.blockedArgPatterns) {
      for (const pattern of toolPolicy.blockedArgPatterns) {
        if (pattern.test(argString)) {
          const reason = toolPolicy.reason ?? `Tool "${toolName}" blocked: argument matches forbidden pattern ${pattern.source}`;
          this.recordViolation(toolName, reason);
          return { allowed: false, reason };
        }
      }
    }

    if (toolPolicy.requiredArgPatterns && toolPolicy.requiredArgPatterns.length > 0) {
      const satisfied = toolPolicy.requiredArgPatterns.some((p) => p.test(argString));
      if (!satisfied) {
        const reason = toolPolicy.reason ?? `Tool "${toolName}" blocked: arguments do not satisfy required patterns`;
        this.recordViolation(toolName, reason);
        return { allowed: false, reason };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  /** Enable or disable read-only mode at runtime */
  setReadOnly(readOnly: boolean): void {
    this.policy.readOnly = readOnly;
  }

  /** Add an absolute path root that is always accessible */
  addFsRoot(root: string): void {
    const absRoot = resolve(root);
    if (!this.policy.fsRoots) this.policy.fsRoots = [];
    if (!this.policy.fsRoots.includes(absRoot)) {
      this.policy.fsRoots.push(absRoot);
    }
  }

  /** Get all recorded violations */
  getViolations(): Array<{ path: string; reason: string; timestamp: number }> {
    return [...this.violations];
  }

  private _checkExtension(absolutePath: string, originalPath: string): { allowed: boolean; reason: string } {
    const ext = extname(absolutePath).toLowerCase();
    if (!ext) return { allowed: true, reason: "OK" };

    if (this.policy.blockedExtensions && this.policy.blockedExtensions.includes(ext)) {
      const reason = `Access denied: file extension ${ext} is blocked`;
      this.recordViolation(originalPath, reason);
      return { allowed: false, reason };
    }

    if (this.policy.allowedExtensions && this.policy.allowedExtensions.length > 0) {
      if (!this.policy.allowedExtensions.includes(ext)) {
        const reason = `Access denied: file extension ${ext} is not in the allowed list`;
        this.recordViolation(originalPath, reason);
        return { allowed: false, reason };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  private _checkBlockedPathsAndPatterns(
    absolutePath: string,
    relativePath: string,
    originalPath: string,
  ): { allowed: boolean; reason: string } {
    // Check blocked paths
    for (const blocked of this.policy.blockedPaths) {
      const blockedAbs = resolve(this.workdir, blocked);
      if (absolutePath.startsWith(blockedAbs)) {
        this.recordViolation(originalPath, `Blocked directory: ${blocked}`);
        return { allowed: false, reason: `Access denied: ${blocked} is a protected directory` };
      }
    }

    // Check blocked patterns
    for (const pattern of this.policy.blockedPatterns) {
      if (pattern.test(absolutePath) || pattern.test(relativePath)) {
        this.recordViolation(originalPath, `Blocked pattern: ${pattern.source}`);
        return { allowed: false, reason: `Access denied: file matches blocked pattern ${pattern.source}` };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  private recordViolation(path: string, reason: string): void {
    this.violations.push({ path, reason, timestamp: Date.now() });
  }
}

/**
 * Permission Middleware
 *
 * Wraps file tools (read_file, write_file, search_files, list_files)
 * with path permission checks, and applies tool-level permission checks
 * (including readOnly mode) to every tool call.
 */
export function permissionMiddleware(guard: PermissionGuard): Middleware {
  const FILE_TOOLS = new Set(["read_file", "write_file", "search_files", "list_files"]);

  return {
    name: "permission-guard",
    async execute(ctx: AgentContext, next: NextFn) {
      const originalTools = ctx.tools;

      ctx.tools = originalTools.map((tool) => {
        const toolName: string = tool.schema.name;
        const isFileTool = FILE_TOOLS.has(toolName);

        return {
          schema: tool.schema,
          execute: async (args: Record<string, unknown>) => {
            // Tool-level permission check (readOnly, per-tool rules)
            const toolResult = guard.checkTool(toolName, args);
            if (!toolResult.allowed) {
              throw new Error(`\uD83D\uDD12 ${toolResult.reason}`);
            }

            // Path-level check for file tools
            if (isFileTool) {
              const path = String(args.path ?? args.cwd ?? ".");
              const pathResult = guard.check(path);
              if (!pathResult.allowed) {
                throw new Error(`\uD83D\uDD12 ${pathResult.reason}`);
              }
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
