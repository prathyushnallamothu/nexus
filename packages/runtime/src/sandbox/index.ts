/**
 * Nexus Sandbox — Public API
 *
 * Usage:
 *   import { SandboxManager, DockerBackend, LocalBackend } from "@nexus/runtime/sandbox"
 *
 * Quick start:
 *   const manager = createSandboxManager({ nexusHome: ".nexus" });
 *   manager.start();
 *   const handle = await manager.acquire("my-task-id", {
 *     backendType: "docker",
 *     image: "node:20-slim",
 *     network: { mode: "isolated" },
 *     ttlMs: 3600_000,
 *   });
 *   const result = await manager.exec("my-task-id", "npm test");
 *   await manager.release("my-task-id", { extractArtifacts: ["coverage/**"] });
 */

export * from "./types.js";
export * from "./manager.js";
export * from "./git.js";
export * from "./secrets.js";
export * from "./tools.js";
export { LocalBackend } from "./backends/local.js";
export { DockerBackend } from "./backends/docker.js";
export { SSHBackend } from "./backends/ssh.js";
export { E2BBackend, ModalBackend, DaytonaBackend, RunloopBackend } from "./backends/e2b.js";

// ── Convenience factory ────────────────────────────────────

import { SandboxManager } from "./manager.js";
import { LocalBackend } from "./backends/local.js";
import { DockerBackend } from "./backends/docker.js";
import { SSHBackend } from "./backends/ssh.js";
import { E2BBackend } from "./backends/e2b.js";
import type { SandboxEventHandler, SandboxSpec } from "./types.js";

export interface SandboxManagerOpts {
  nexusHome: string;
  defaultSpec?: Partial<SandboxSpec>;
  healthCheckIntervalMs?: number;
  ttlCheckIntervalMs?: number;
  onEvent?: SandboxEventHandler;
}

/**
 * Create a SandboxManager with all available backends wired in.
 * Backends are tried in order: E2B → Docker → SSH → Local.
 * The first `available` backend for a spec is used.
 */
export function createSandboxManager(opts: SandboxManagerOpts): SandboxManager {
  const backends = [
    new E2BBackend(),
    new DockerBackend(),
    new SSHBackend(),
    new LocalBackend(),
  ];

  return new SandboxManager({
    nexusHome: opts.nexusHome,
    backends,
    defaultSpec: opts.defaultSpec,
    healthCheckIntervalMs: opts.healthCheckIntervalMs,
    ttlCheckIntervalMs: opts.ttlCheckIntervalMs,
    onEvent: opts.onEvent,
  });
}
