/**
 * Nexus Sandbox Git Integration
 *
 * Branch-per-task lifecycle:
 *   nexus/task-{taskId} branches are created when a task starts,
 *   committed when work is extracted, and cleaned up when done.
 *
 * This enables:
 *   - Full isolation between concurrent tasks
 *   - Easy review of what a task changed
 *   - Safe rollback by deleting the task branch
 */

import { execSync, execFileSync } from "node:child_process";

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();
}

function runFile(file: string, args: string[], cwd: string): string {
  return execFileSync(file, args, { cwd, stdio: "pipe" }).toString().trim();
}

// ── TaskBranchManager ─────────────────────────────────────────────────────────

export interface CreateBranchOpts {
  base?: string;   // base branch / ref (default: current HEAD)
  push?: boolean;  // push to remote after creation (default: false)
}

export interface CommitOpts {
  add?: string[];  // paths to stage; defaults to "." (all changes)
}

export interface CreatePROpts {
  title?: string;
  body?: string;
  draft?: boolean;
}

export interface CleanupOpts {
  deleteRemote?: boolean; // also delete remote branch (default: false)
  force?: boolean;        // force-delete even if not merged (default: false)
}

export interface BranchStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export class TaskBranchManager {
  private readonly cwd: string;
  private readonly branchPrefix: string;

  constructor(opts?: { cwd?: string; branchPrefix?: string }) {
    this.cwd = opts?.cwd ?? process.cwd();
    this.branchPrefix = opts?.branchPrefix ?? "nexus/task-";
  }

  private _branchName(taskId: string): string {
    return `${this.branchPrefix}${taskId}`;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Check whether cwd is inside a git repository. */
  isGitRepo(): boolean {
    try {
      run("git rev-parse --git-dir", this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Return the name of the current branch. */
  getCurrentBranch(): string {
    return run("git rev-parse --abbrev-ref HEAD", this.cwd);
  }

  /**
   * Create a branch `nexus/task-{taskId}` from `base` (default: current HEAD).
   * Returns the branch name and base SHA.
   */
  createBranch(
    taskId: string,
    opts?: CreateBranchOpts,
  ): Promise<{ branch: string; base: string }> {
    return new Promise((resolve, reject) => {
      try {
        const branch = this._branchName(taskId);
        const base = opts?.base ?? run("git rev-parse HEAD", this.cwd);

        // Create branch at base ref
        runFile("git", ["checkout", "-b", branch, base], this.cwd);

        if (opts?.push) {
          try {
            runFile("git", ["push", "-u", "origin", branch], this.cwd);
          } catch {
            // Non-fatal: no remote configured or no network
          }
        }

        resolve({ branch, base });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Checkout an existing branch. */
  async switchToBranch(branch: string): Promise<void> {
    runFile("git", ["checkout", branch], this.cwd);
  }

  /**
   * Stage files and commit.
   * Returns the new commit SHA, or null if there was nothing to commit.
   */
  async commitWork(
    taskId: string,
    message?: string,
    opts?: CommitOpts,
  ): Promise<string | null> {
    try {
      const paths = opts?.add ?? ["."];
      runFile("git", ["add", "--", ...paths], this.cwd);

      // Check if there's anything staged
      const status = run("git status --porcelain", this.cwd);
      if (!status) return null;

      const msg = message ?? `nexus: work for task ${taskId}`;
      runFile("git", ["commit", "--no-verify", "-m", msg], this.cwd);

      return run("git rev-parse HEAD", this.cwd);
    } catch {
      return null;
    }
  }

  /**
   * Create a GitHub PR for the task branch.
   * Returns the PR URL, or null if `gh` is not installed or creation fails.
   */
  async createPR(taskId: string, opts?: CreatePROpts): Promise<string | null> {
    try {
      const branch = this._branchName(taskId);
      const title = opts?.title ?? `[nexus] Task ${taskId}`;
      const body = opts?.body ?? `Automated changes from Nexus task \`${taskId}\`.`;

      const args = [
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ];
      if (opts?.draft) args.push("--draft");

      return runFile("gh", args, this.cwd);
    } catch {
      return null;
    }
  }

  /**
   * Delete the local task branch (and optionally the remote).
   * Non-fatal — logs rather than throws.
   */
  async cleanup(taskId: string, opts?: CleanupOpts): Promise<void> {
    const branch = this._branchName(taskId);

    // Switch away from the branch if we're on it
    try {
      if (this.getCurrentBranch() === branch) {
        runFile("git", ["checkout", "-"], this.cwd);
      }
    } catch { /* best effort */ }

    // Delete local branch
    try {
      const deleteFlag = opts?.force ? "-D" : "-d";
      runFile("git", ["branch", deleteFlag, branch], this.cwd);
    } catch { /* best effort */ }

    // Delete remote branch
    if (opts?.deleteRemote) {
      try {
        runFile("git", ["push", "origin", "--delete", branch], this.cwd);
      } catch { /* best effort — no remote or already gone */ }
    }
  }

  /** List all local branches with the task prefix. */
  listTaskBranches(): string[] {
    try {
      const out = run(
        `git branch --list "${this.branchPrefix}*" --format="%(refname:short)"`,
        this.cwd,
      );
      return out ? out.split("\n").filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Return ahead/behind counts and dirty status for a task branch.
   * Returns null if the branch doesn't exist.
   */
  getStatus(taskId: string): BranchStatus | null {
    const branch = this._branchName(taskId);
    try {
      // Verify branch exists
      runFile("git", ["rev-parse", "--verify", branch], this.cwd);

      // Get tracking status (ahead / behind)
      let ahead = 0;
      let behind = 0;
      try {
        const revList = run(
          `git rev-list --left-right --count ${branch}...@{u}`,
          this.cwd,
        );
        const parts = revList.split(/\s+/);
        ahead  = parseInt(parts[0] ?? "0", 10);
        behind = parseInt(parts[1] ?? "0", 10);
      } catch {
        // No upstream tracking branch
      }

      // Check dirty (uncommitted changes on this branch)
      let dirty = false;
      try {
        // Temporarily get status from within that branch without switching
        const wt = run(
          `git stash list | wc -l`,
          this.cwd,
        );
        void wt; // not used, just to avoid lint error
        const porcelain = run(`git -C "${this.cwd}" status --porcelain`, this.cwd);
        dirty = porcelain.length > 0 && this.getCurrentBranch() === branch;
      } catch { /* best effort */ }

      return { branch, ahead, behind, dirty };
    } catch {
      return null;
    }
  }
}

// ── Convenience functions ─────────────────────────────────────────────────────

let _default: TaskBranchManager | null = null;

function _getDefault(): TaskBranchManager {
  if (!_default) _default = new TaskBranchManager();
  return _default;
}

/** Convenience: create a task branch using a default TaskBranchManager. */
export function createTaskBranch(
  taskId: string,
  opts?: CreateBranchOpts,
): Promise<{ branch: string; base: string }> {
  return _getDefault().createBranch(taskId, opts);
}

/** Convenience: clean up a task branch using a default TaskBranchManager. */
export function cleanupTaskBranch(
  taskId: string,
  opts?: CleanupOpts,
): Promise<void> {
  return _getDefault().cleanup(taskId, opts);
}
