/**
 * Nexus Sandbox — Core Types
 *
 * SandboxBackend  — pluggable execution backend (Docker/SSH/E2B/local)
 * SandboxHandle   — reference to a live sandbox instance
 * SandboxSpec     — creation spec (image, resources, secrets, network)
 * SandboxManager  — orchestrates per-task lifecycle
 */

// ── Backend identification ────────────────────────────────────────────────────

export type BackendType = "local" | "docker" | "ssh" | "e2b" | "modal" | "daytona" | "runloop";

// ── Sandbox health ────────────────────────────────────────────────────────────

export type SandboxHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

// ── Sandbox lifecycle state ───────────────────────────────────────────────────

export type SandboxState = "creating" | "running" | "paused" | "stopped" | "error" | "destroyed";

// ── Live sandbox reference ────────────────────────────────────────────────────

/** A live sandbox reference (opaque handle returned by create()). */
export interface SandboxHandle {
  id: string;              // unique sandbox ID
  taskId: string;          // which task owns this sandbox
  backendType: BackendType;
  state: SandboxState;
  backendId: string;       // docker container ID, SSH host, E2B sandbox ID, etc.
  workdir: string;         // working directory INSIDE the sandbox
  localWorkdir?: string;   // corresponding local path (for volume-mounted backends)
  createdAt: number;
  lastUsedAt: number;
  expiresAt?: number;      // TTL — destroy after this timestamp if idle
  metadata: Record<string, string>; // backend-specific extras
}

// ── Sandbox creation spec ─────────────────────────────────────────────────────

export interface SandboxSpec {
  taskId: string;
  backendType?: BackendType;       // default: auto-detect best available
  image?: string;                  // Docker image / E2B template
  workdir?: string;                // working directory inside sandbox
  localWorkdir?: string;           // local dir to mount into sandbox
  env?: Record<string, string>;    // environment variables (merged with injected secrets)
  secretRefs?: string[];           // secret keys to inject (resolved by SecretsManager)
  network?: SandboxNetworkPolicy;
  resources?: SandboxResources;
  ttlMs?: number;                  // idle TTL — auto-destroy after this long unused
  resumable?: boolean;             // allow resume after stop
  branch?: string;                 // git branch to create for this task
}

export interface SandboxNetworkPolicy {
  mode: "none" | "isolated" | "bridge" | "host";
  allowDomains?: string[];         // whitelist for isolated mode
  denyDomains?: string[];
}

export interface SandboxResources {
  memoryMb?: number;               // default 512
  cpuShares?: number;              // default 512
  diskMb?: number;                 // default unlimited
  timeoutMs?: number;              // per-command timeout
}

// ── Command execution ─────────────────────────────────────────────────────────

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

// ── Streaming ─────────────────────────────────────────────────────────────────

export interface LogEvent {
  stream: "stdout" | "stderr" | "system";
  data: string;
  timestamp: number;
}

// ── Artifacts ─────────────────────────────────────────────────────────────────

export interface ArtifactRef {
  sandboxPath: string;
  localPath: string;
  sizeBytes: number;
  mimeType?: string;
  extractedAt: number;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  health: SandboxHealth;
  latencyMs: number;
  message?: string;
  checkedAt: number;
}

// ── Backend interface ─────────────────────────────────────────────────────────

/** All sandbox backends implement this interface. */
export interface SandboxBackend {
  readonly type: BackendType;
  readonly available: boolean;      // can be used on this system?

  create(spec: SandboxSpec): Promise<SandboxHandle>;

  exec(handle: SandboxHandle, command: string, opts?: ExecOpts): Promise<ExecResult>;

  /** Stream command output as async iterable of log events. */
  stream(handle: SandboxHandle, command: string, opts?: ExecOpts): AsyncIterable<LogEvent>;

  /** Upload file from local → sandbox. */
  upload(handle: SandboxHandle, localPath: string, sandboxPath: string): Promise<void>;

  /** Download file from sandbox → local. */
  download(handle: SandboxHandle, sandboxPath: string, localPath: string): Promise<void>;

  /** Extract files matching glob patterns from sandbox to local artifacts dir. */
  extractArtifacts(handle: SandboxHandle, patterns: string[], destDir: string): Promise<ArtifactRef[]>;

  /** Health check. */
  healthCheck(handle: SandboxHandle): Promise<HealthCheckResult>;

  /** Destroy the sandbox. */
  destroy(handle: SandboxHandle): Promise<void>;

  /** Pause/resume (not all backends support this). */
  pause?(handle: SandboxHandle): Promise<void>;
  resume?(handle: SandboxHandle): Promise<SandboxHandle>;

  /** List all live sandboxes managed by this backend. */
  list(): Promise<SandboxHandle[]>;
}

// ── Manager events ────────────────────────────────────────────────────────────

export type SandboxEvent =
  | { type: "created"; handle: SandboxHandle }
  | { type: "destroyed"; taskId: string; reason: string }
  | { type: "health_change"; taskId: string; from: SandboxHealth; to: SandboxHealth }
  | { type: "recreated"; taskId: string; handle: SandboxHandle }
  | { type: "artifact_extracted"; taskId: string; artifact: ArtifactRef }
  | { type: "log"; taskId: string; event: LogEvent };

export type SandboxEventHandler = (event: SandboxEvent) => void;
