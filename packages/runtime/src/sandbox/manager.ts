/**
 * Nexus Sandbox Manager
 *
 * Orchestrates per-task sandbox lifecycle:
 *   - Create one sandbox per task (or resume an existing one)
 *   - Health-check loop with auto-recreate on unhealthy sandboxes
 *   - TTL-based cleanup of idle sandboxes
 *   - Artifact extraction to {nexusHome}/artifacts/{taskId}/
 *   - Persists sandbox state to {nexusHome}/sandboxes.db (SQLite)
 *   - Emits structured events for observability
 *
 * Design principle:
 *   Full permissions INSIDE the sandbox.
 *   Restricted (policy-governed) OUTSIDE.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SandboxBackend,
  SandboxHandle,
  SandboxSpec,
  SandboxHealth,
  SandboxEvent,
  SandboxEventHandler,
  ExecOpts,
  ExecResult,
  LogEvent,
  ArtifactRef,
  HealthCheckResult,
  BackendType,
} from "./types.js";

// Use bun:sqlite at runtime; avoid tsc resolution issues
const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

// ── DB row type ───────────────────────────────────────────────────────────────

interface SandboxRow {
  id: string;
  task_id: string;
  backend_type: string;
  state: string;
  backend_id: string;
  workdir: string;
  local_workdir: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
  metadata_json: string;
  spec_json: string;
}

// ── SandboxManager ────────────────────────────────────────────────────────────

export interface SandboxManagerConfig {
  nexusHome: string;
  backends: SandboxBackend[];          // ordered by preference
  defaultSpec?: Partial<SandboxSpec>;  // defaults merged into every create()
  healthCheckIntervalMs?: number;      // default 30 000
  ttlCheckIntervalMs?: number;         // default 60 000
  onEvent?: SandboxEventHandler;
}

export class SandboxManager {
  private readonly nexusHome: string;
  private readonly backends: SandboxBackend[];
  private readonly defaultSpec: Partial<SandboxSpec>;
  private readonly healthCheckIntervalMs: number;
  private readonly ttlCheckIntervalMs: number;
  private readonly onEvent?: SandboxEventHandler;

  /** In-memory live handles. */
  _handles: Map<string, SandboxHandle> = new Map();

  /** Spec used to create each handle (needed for recreate). */
  private _specs: Map<string, SandboxSpec> = new Map();

  /** Last known health per taskId. */
  private _health: Map<string, SandboxHealth> = new Map();

  /** SQLite database for persisted state. */
  _db: InstanceType<typeof Database>;

  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  private _ttlTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SandboxManagerConfig) {
    this.nexusHome = opts.nexusHome;
    this.backends = opts.backends;
    this.defaultSpec = opts.defaultSpec ?? {};
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 30_000;
    this.ttlCheckIntervalMs = opts.ttlCheckIntervalMs ?? 60_000;
    this.onEvent = opts.onEvent;

    mkdirSync(this.nexusHome, { recursive: true });

    this._db = new Database(join(this.nexusHome, "sandboxes.db"));
    this._db.exec("PRAGMA journal_mode=WAL;");
    this._initSchema();
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  private _initSchema(): void {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL UNIQUE,
        backend_type  TEXT NOT NULL,
        state         TEXT NOT NULL,
        backend_id    TEXT NOT NULL,
        workdir       TEXT NOT NULL,
        local_workdir TEXT,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER NOT NULL,
        expires_at    INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        spec_json     TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_sandboxes_task_id ON sandboxes(task_id);
      CREATE INDEX IF NOT EXISTS idx_sandboxes_state   ON sandboxes(state);
    `);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private _emit(event: SandboxEvent): void {
    try { this.onEvent?.(event); } catch { /* best effort */ }
  }

  // ── Backend selection ─────────────────────────────────────────────────────

  _bestBackend(spec: SandboxSpec): SandboxBackend {
    if (spec.backendType) {
      const match = this.backends.find(
        (b) => b.type === spec.backendType && b.available,
      );
      if (match) return match;
    }
    const fallback = this.backends.find((b) => b.available);
    if (!fallback) {
      throw new Error("[SandboxManager] No available backend found");
    }
    return fallback;
  }

  // ── DB persistence ────────────────────────────────────────────────────────

  private _upsert(handle: SandboxHandle, spec: SandboxSpec): void {
    const stmt = this._db.prepare(`
      INSERT INTO sandboxes
        (id, task_id, backend_type, state, backend_id, workdir, local_workdir,
         created_at, last_used_at, expires_at, metadata_json, spec_json)
      VALUES
        ($id, $task_id, $backend_type, $state, $backend_id, $workdir, $local_workdir,
         $created_at, $last_used_at, $expires_at, $metadata_json, $spec_json)
      ON CONFLICT(task_id) DO UPDATE SET
        id            = excluded.id,
        backend_type  = excluded.backend_type,
        state         = excluded.state,
        backend_id    = excluded.backend_id,
        workdir       = excluded.workdir,
        local_workdir = excluded.local_workdir,
        last_used_at  = excluded.last_used_at,
        expires_at    = excluded.expires_at,
        metadata_json = excluded.metadata_json,
        spec_json     = excluded.spec_json
    `);
    stmt.run({
      $id: handle.id,
      $task_id: handle.taskId,
      $backend_type: handle.backendType,
      $state: handle.state,
      $backend_id: handle.backendId,
      $workdir: handle.workdir,
      $local_workdir: handle.localWorkdir ?? null,
      $created_at: handle.createdAt,
      $last_used_at: handle.lastUsedAt,
      $expires_at: handle.expiresAt ?? null,
      $metadata_json: JSON.stringify(handle.metadata),
      $spec_json: JSON.stringify(spec),
    });
  }

  private _markDestroyed(taskId: string): void {
    this._db.prepare(
      `UPDATE sandboxes SET state = 'destroyed' WHERE task_id = $task_id`,
    ).run({ $task_id: taskId });
  }

  private _loadLiveSandboxes(): Array<{ handle: SandboxHandle; spec: SandboxSpec }> {
    const rows = this._db.prepare(
      `SELECT * FROM sandboxes WHERE state = 'running'`,
    ).all() as SandboxRow[];

    return rows.map((row) => ({
      handle: {
        id: row.id,
        taskId: row.task_id,
        backendType: row.backend_type as BackendType,
        state: row.state as SandboxHandle["state"],
        backendId: row.backend_id,
        workdir: row.workdir,
        localWorkdir: row.local_workdir ?? undefined,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at ?? undefined,
        metadata: JSON.parse(row.metadata_json) as Record<string, string>,
      } satisfies SandboxHandle,
      spec: JSON.parse(row.spec_json) as SandboxSpec,
    }));
  }

  // ── Touch ─────────────────────────────────────────────────────────────────

  private _touch(handle: SandboxHandle): void {
    handle.lastUsedAt = Date.now();
    if (handle.expiresAt !== undefined && this._specs.has(handle.taskId)) {
      const spec = this._specs.get(handle.taskId)!;
      if (spec.ttlMs) handle.expiresAt = handle.lastUsedAt + spec.ttlMs;
    }
    this._db.prepare(
      `UPDATE sandboxes SET last_used_at = $last_used_at, expires_at = $expires_at WHERE task_id = $task_id`,
    ).run({
      $last_used_at: handle.lastUsedAt,
      $expires_at: handle.expiresAt ?? null,
      $task_id: handle.taskId,
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get or create the sandbox for a task.
   * If one exists and is healthy, return it.
   * If unhealthy, recreate it.
   */
  async acquire(taskId: string, spec?: Partial<SandboxSpec>): Promise<SandboxHandle> {
    const existing = this._handles.get(taskId);
    if (existing) {
      const hcResult = await this.healthCheck(taskId);
      if (hcResult.health === "healthy" || hcResult.health === "degraded") {
        this._touch(existing);
        return existing;
      }
      // Unhealthy — recreate below
      await this._recreate(taskId);
      return this._handles.get(taskId)!;
    }

    const fullSpec: SandboxSpec = {
      ...this.defaultSpec,
      ...spec,
      taskId,
    };

    const backend = this._bestBackend(fullSpec);
    const handle = await backend.create(fullSpec);

    this._handles.set(taskId, handle);
    this._specs.set(taskId, fullSpec);
    this._upsert(handle, fullSpec);

    this._emit({ type: "created", handle });
    return handle;
  }

  /**
   * Release a sandbox. Optionally extract artifacts first.
   * Destroys the sandbox unless keepAlive is true.
   */
  async release(
    taskId: string,
    opts?: { keepAlive?: boolean; extractArtifacts?: string[] },
  ): Promise<void> {
    const handle = this._handles.get(taskId);
    if (!handle) return;

    if (opts?.extractArtifacts?.length) {
      await this.extractArtifacts(taskId, opts.extractArtifacts);
    }

    if (!opts?.keepAlive) {
      const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
      try {
        await backend.destroy(handle);
      } catch { /* best effort */ }

      handle.state = "destroyed";
      this._markDestroyed(taskId);
      this._handles.delete(taskId);
      this._specs.delete(taskId);
      this._health.delete(taskId);

      this._emit({ type: "destroyed", taskId, reason: "released" });
    }
  }

  /** Run a command in the task's sandbox. */
  async exec(taskId: string, command: string, opts?: ExecOpts): Promise<ExecResult> {
    const handle = this._getOrThrow(taskId);
    const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
    this._touch(handle);
    return backend.exec(handle, command, opts);
  }

  /** Stream command output from the task's sandbox. */
  stream(taskId: string, command: string, opts?: ExecOpts): AsyncIterable<LogEvent> {
    const handle = this._getOrThrow(taskId);
    const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
    this._touch(handle);

    const self = this;
    async function* gen(): AsyncIterable<LogEvent> {
      for await (const event of backend.stream(handle, command, opts)) {
        self._emit({ type: "log", taskId, event });
        yield event;
      }
    }
    return gen();
  }

  /** Upload a file into the task's sandbox. */
  async upload(taskId: string, localPath: string, sandboxPath: string): Promise<void> {
    const handle = this._getOrThrow(taskId);
    const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
    this._touch(handle);
    return backend.upload(handle, localPath, sandboxPath);
  }

  /** Download a file from the task's sandbox. */
  async download(taskId: string, sandboxPath: string, localPath: string): Promise<void> {
    const handle = this._getOrThrow(taskId);
    const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
    this._touch(handle);
    return backend.download(handle, sandboxPath, localPath);
  }

  /** Extract files matching glob patterns to {nexusHome}/artifacts/{taskId}/. */
  async extractArtifacts(taskId: string, patterns: string[]): Promise<ArtifactRef[]> {
    const handle = this._getOrThrow(taskId);
    const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
    const destDir = join(this.nexusHome, "artifacts", taskId);
    mkdirSync(destDir, { recursive: true });
    this._touch(handle);

    const artifacts = await backend.extractArtifacts(handle, patterns, destDir);
    for (const artifact of artifacts) {
      this._emit({ type: "artifact_extracted", taskId, artifact });
    }
    return artifacts;
  }

  /** Run a health check on the task's sandbox. Emits health_change if status changed. */
  async healthCheck(taskId: string): Promise<HealthCheckResult> {
    const handle = this._handles.get(taskId);
    if (!handle) {
      return { health: "unknown", latencyMs: 0, message: "No sandbox for task", checkedAt: Date.now() };
    }
    const backend = this._bestBackend(this._specs.get(taskId) ?? { taskId });
    const result = await backend.healthCheck(handle);

    const prev = this._health.get(taskId) ?? "unknown";
    if (prev !== result.health) {
      this._health.set(taskId, result.health);
      this._emit({ type: "health_change", taskId, from: prev, to: result.health });
    }
    return result;
  }

  /** Get the live handle for a task, or null. */
  get(taskId: string): SandboxHandle | null {
    return this._handles.get(taskId) ?? null;
  }

  /** List all live handles. */
  list(): SandboxHandle[] {
    return Array.from(this._handles.values());
  }

  /** Destroy all live sandboxes. */
  async destroyAll(): Promise<void> {
    const tasks = Array.from(this._handles.keys());
    await Promise.allSettled(tasks.map((id) => this.release(id)));
  }

  /** Start the health-check and TTL cleanup loops. Loads surviving handles from DB. */
  start(): void {
    this._restoreFromDB();

    this._healthLoop = setInterval(async () => {
      for (const taskId of this._handles.keys()) {
        try { await this.healthCheck(taskId); } catch { /* best effort */ }
      }
    }, this.healthCheckIntervalMs);

    this._ttlLoop = setInterval(async () => {
      const now = Date.now();
      for (const [taskId, handle] of this._handles) {
        if (handle.expiresAt !== undefined && handle.expiresAt < now) {
          await this.release(taskId).catch(() => {});
        }
      }
    }, this.ttlCheckIntervalMs);
  }

  /** Stop the loops and persist final state. */
  stop(): void {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this._ttlTimer)    { clearInterval(this._ttlTimer);    this._ttlTimer    = null; }

    // Persist current last_used_at for all live handles
    for (const [taskId, handle] of this._handles) {
      const spec = this._specs.get(taskId);
      if (spec) this._upsert(handle, spec);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private get _healthLoop() { return this._healthTimer; }
  private set _healthLoop(t: ReturnType<typeof setInterval> | null) { this._healthTimer = t; }
  private get _ttlLoop()    { return this._ttlTimer; }
  private set _ttlLoop(t: ReturnType<typeof setInterval> | null) { this._ttlTimer = t; }

  private _getOrThrow(taskId: string): SandboxHandle {
    const handle = this._handles.get(taskId);
    if (!handle) throw new Error(`[SandboxManager] No sandbox for task: ${taskId}`);
    return handle;
  }

  /** Restore surviving sandboxes from DB on startup, health-checking each. */
  private _restoreFromDB(): void {
    const survivors = this._loadLiveSandboxes();
    for (const { handle, spec } of survivors) {
      this._handles.set(handle.taskId, handle);
      this._specs.set(handle.taskId, spec);
    }

    // Fire-and-forget health checks for restored handles
    for (const taskId of this._handles.keys()) {
      this.healthCheck(taskId).catch(() => {});
    }
  }

  /** Destroy and recreate a sandbox for a task. */
  async _recreate(taskId: string): Promise<void> {
    const oldHandle = this._handles.get(taskId);
    const spec = this._specs.get(taskId);
    if (!spec) return;

    if (oldHandle) {
      const backend = this._bestBackend(spec);
      try { await backend.destroy(oldHandle); } catch { /* best effort */ }
      this._handles.delete(taskId);
      this._markDestroyed(taskId);
    }

    const backend = this._bestBackend(spec);
    const newHandle = await backend.create(spec);
    this._handles.set(taskId, newHandle);
    this._upsert(newHandle, spec);

    this._emit({ type: "recreated", taskId, handle: newHandle });
  }
}
