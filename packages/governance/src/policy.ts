/**
 * Nexus Policy Engine
 *
 * Loads nexus-policy.json (or nexus-policy.yaml treated as JSON) from
 * the project root. Evaluates every agent action against policy rules
 * before execution. Supports dry-run mode and version history rollback.
 *
 * Policy scopes:
 *   commands   — shell command patterns (deny / require_approval)
 *   paths      — filesystem allow/deny roots
 *   models     — allowed LLM models, per-call cost cap
 *   network    — domain allow/deny, HTTP policy
 *   secrets    — scanning settings
 *   deploys    — deploy approval requirements
 *   tools      — per-tool permission overrides
 *
 * Presets:
 *   local-dev  — permissive, great for solo development
 *   repo-only  — restricted to git repo, no external net except GitHub
 *   ci         — read-heavy, no HITL, $5 budget cap, no deploys
 *   production — all deploys HITL, secrets scanned everywhere, tight audit
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ── Types ──────────────────────────────────────────────────

export type PolicyPreset = "local-dev" | "repo-only" | "ci" | "production";

export interface NexusPolicy {
  version: string;          // "1.0"
  preset?: PolicyPreset;    // optional base preset
  dryRun?: boolean;         // if true, evaluate only — never block
  updatedAt?: string;

  commands?: {
    deny?: string[];          // regex patterns
    require_approval?: string[];
    warn?: string[];
  };

  paths?: {
    allow?: string[];
    deny?: string[];
    roots?: string[];         // filesystem roots (absolute paths allowed)
  };

  models?: {
    allow?: string[];         // glob patterns like "claude-*"
    deny?: string[];
    max_cost_per_call?: number;
  };

  network?: {
    allow_domains?: string[];
    deny_domains?: string[];
    allow_http?: boolean;     // default false in production
    timeout_ms?: number;
  };

  secrets?: {
    scan_writes?: boolean;
    scan_outputs?: boolean;
    scan_diffs?: boolean;
    extra_patterns?: string[]; // additional regex patterns
  };

  deploys?: {
    require_approval?: boolean;
    allowed_environments?: string[];
    protected_environments?: string[];
  };

  tools?: Record<string, {   // per-tool overrides
    level?: "allow" | "deny" | "require_approval";
    reason?: string;
  }>;
}

export interface PolicyAction {
  type: "command" | "file" | "network" | "model" | "deploy" | "tool";
  value: string;
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  level: "allow" | "deny" | "require_approval" | "warn";
  reason: string;
  matchedRule?: string;
  isDryRun: boolean;
}

// ── Presets ────────────────────────────────────────────────

export const POLICY_PRESETS: Record<PolicyPreset, NexusPolicy> = {
  "local-dev": {
    version: "1.0",
    preset: "local-dev",
    dryRun: false,
    commands: {
      warn: [
        "rm\\s+-rf",
        "git\\s+push.*--force",
        "git\\s+push.*-f\\b",
      ],
    },
    paths: {
      allow: ["./"],
    },
    models: {},
    network: {
      allow_http: true,
    },
    secrets: {
      scan_writes: false,
      scan_outputs: false,
      scan_diffs: false,
    },
    deploys: {
      require_approval: false,
    },
  },

  "repo-only": {
    version: "1.0",
    preset: "repo-only",
    dryRun: false,
    paths: {
      roots: ["./"],
    },
    network: {
      allow_domains: [
        "github.com",
        "api.github.com",
        "*.githubusercontent.com",
      ],
      allow_http: false,
    },
    secrets: {
      scan_writes: true,
    },
  },

  "ci": {
    version: "1.0",
    preset: "ci",
    dryRun: false,
    paths: {
      allow: ["./dist", "./build", "./.next"],
    },
    models: {
      max_cost_per_call: 0.05,
    },
    deploys: {
      require_approval: false,
    },
    secrets: {
      scan_outputs: true,
    },
    network: {
      allow_http: false,
    },
  },

  "production": {
    version: "1.0",
    preset: "production",
    dryRun: false,
    commands: {
      require_approval: [
        "git\\s+push",
        "npm\\s+publish",
        "docker\\s+push",
        "kubectl\\s+apply",
      ],
    },
    deploys: {
      require_approval: true,
      protected_environments: ["production", "prod"],
    },
    secrets: {
      scan_writes: true,
      scan_outputs: true,
      scan_diffs: true,
    },
    network: {
      allow_http: false,
    },
  },
};

// ── Helpers ────────────────────────────────────────────────

/** Merge two policies — explicit fields override preset fields. */
function mergePolicies(base: NexusPolicy, override: NexusPolicy): NexusPolicy {
  return {
    ...base,
    ...override,
    commands: { ...base.commands, ...override.commands },
    paths: { ...base.paths, ...override.paths },
    models: { ...base.models, ...override.models },
    network: { ...base.network, ...override.network },
    secrets: { ...base.secrets, ...override.secrets },
    deploys: { ...base.deploys, ...override.deploys },
    tools: { ...base.tools, ...override.tools },
  };
}

/** Match a value against an array of regex pattern strings. */
function matchesAny(value: string, patterns: string[]): string | null {
  for (const p of patterns) {
    try {
      if (new RegExp(p, "i").test(value)) return p;
    } catch {
      // skip invalid patterns
    }
  }
  return null;
}

/** Glob-style model matching: supports exact and "claude-*" prefix wildcards. */
function matchesGlob(value: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

// ── PolicyStore ────────────────────────────────────────────

interface PolicyHistoryEntry {
  version: number;
  policy: NexusPolicy;
  savedAt: string;
}

export class PolicyStore {
  private policyPath: string;
  private historyPath: string;
  private current: NexusPolicy | null = null;

  constructor(nexusHome: string) {
    const governanceDir = resolve(nexusHome, "governance");
    this.policyPath = resolve(governanceDir, "policy.json");
    this.historyPath = resolve(governanceDir, "policy-history.json");
  }

  /** Load policy from disk. Returns null if no policy file exists yet. */
  load(): NexusPolicy | null {
    if (!existsSync(this.policyPath)) {
      this.current = null;
      return null;
    }
    try {
      const raw = readFileSync(this.policyPath, "utf-8");
      this.current = JSON.parse(raw) as NexusPolicy;
      return this.current;
    } catch {
      this.current = null;
      return null;
    }
  }

  /** Save a new policy version to disk and append the old version to history. */
  save(policy: NexusPolicy): void {
    mkdirSync(dirname(this.policyPath), { recursive: true });

    const prev = this.current;
    if (prev) {
      this._appendHistory(prev);
    }

    const toSave: NexusPolicy = {
      ...policy,
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(this.policyPath, JSON.stringify(toSave, null, 2), "utf-8");
    this.current = toSave;
  }

  /** Return the currently-loaded policy (loads from disk if needed). */
  getCurrent(): NexusPolicy | null {
    if (!this.current) this.load();
    return this.current;
  }

  /** Return history entries, newest first. */
  getHistory(): PolicyHistoryEntry[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const raw = readFileSync(this.historyPath, "utf-8");
      return JSON.parse(raw) as PolicyHistoryEntry[];
    } catch {
      return [];
    }
  }

  /**
   * Rollback to a specific version index (0 = most recent saved version).
   * Saves that historical entry as the new current policy.
   */
  rollback(version: number): NexusPolicy {
    const history = this.getHistory();
    if (version < 0 || version >= history.length) {
      throw new RangeError(`No history entry at version ${version} (${history.length} entries available)`);
    }
    const entry = history[version];
    this.save(entry.policy);
    return entry.policy;
  }

  private _appendHistory(policy: NexusPolicy): void {
    mkdirSync(dirname(this.historyPath), { recursive: true });
    const existing = this.getHistory();

    const newEntry: PolicyHistoryEntry = {
      version: existing.length,
      policy,
      savedAt: new Date().toISOString(),
    };

    const updated = [newEntry, ...existing].slice(0, 20); // keep last 20
    writeFileSync(this.historyPath, JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ── PolicyEngine ───────────────────────────────────────────

export class PolicyEngine {
  private store: PolicyStore;

  constructor(nexusHome: string) {
    this.store = new PolicyStore(nexusHome);
  }

  /** Access the underlying store (for load/save/rollback). */
  getStore(): PolicyStore {
    return this.store;
  }

  /**
   * Evaluate an action against the current policy.
   * Throws if the policy cannot be loaded and no fallback is available.
   * In dry-run mode the decision is returned but never blocks execution.
   */
  evaluate(action: PolicyAction): PolicyDecision {
    const raw = this.store.getCurrent();
    const policy = this._resolvedPolicy(raw);
    return this._evaluate(action, policy, false);
  }

  /**
   * Dry-run evaluate: never throws, always returns a full PolicyDecision.
   * The returned decision has `isDryRun: true`.
   */
  dryRun(action: PolicyAction): PolicyDecision {
    const raw = this.store.getCurrent();
    const policy = this._resolvedPolicy(raw);
    return this._evaluate(action, policy, true);
  }

  // ── Internal evaluation logic ──────────────────────────

  private _resolvedPolicy(raw: NexusPolicy | null): NexusPolicy {
    if (!raw) {
      // No policy on disk — default to local-dev preset
      return POLICY_PRESETS["local-dev"];
    }
    if (raw.preset && POLICY_PRESETS[raw.preset]) {
      // Merge: preset is the base, explicit policy fields override
      const preset = POLICY_PRESETS[raw.preset];
      return mergePolicies(preset, raw);
    }
    return raw;
  }

  private _evaluate(
    action: PolicyAction,
    policy: NexusPolicy,
    forceDryRun: boolean,
  ): PolicyDecision {
    const isDryRun = forceDryRun || (policy.dryRun === true);

    // 1. Tool overrides (most specific — checked first)
    if (action.type === "tool" && policy.tools) {
      const toolOverride = policy.tools[action.value];
      if (toolOverride) {
        const level = toolOverride.level ?? "allow";
        const allowed = level === "allow";
        return {
          allowed: isDryRun ? true : allowed,
          level,
          reason: toolOverride.reason ?? `Tool override: ${level}`,
          matchedRule: `tools.${action.value}`,
          isDryRun,
        };
      }
    }

    // 2. Commands
    if (action.type === "command") {
      const deny = policy.commands?.deny ?? [];
      const requireApproval = policy.commands?.require_approval ?? [];
      const warn = policy.commands?.warn ?? [];

      const deniedRule = matchesAny(action.value, deny);
      if (deniedRule) {
        return {
          allowed: isDryRun ? true : false,
          level: "deny",
          reason: `Command denied by policy rule`,
          matchedRule: deniedRule,
          isDryRun,
        };
      }

      const approvalRule = matchesAny(action.value, requireApproval);
      if (approvalRule) {
        return {
          allowed: isDryRun ? true : false,
          level: "require_approval",
          reason: `Command requires approval`,
          matchedRule: approvalRule,
          isDryRun,
        };
      }

      const warnRule = matchesAny(action.value, warn);
      if (warnRule) {
        return {
          allowed: true,
          level: "warn",
          reason: `Command flagged by policy`,
          matchedRule: warnRule,
          isDryRun,
        };
      }
    }

    // 3. Paths
    if (action.type === "file") {
      const denied = policy.paths?.deny ?? [];
      const denyRule = matchesAny(action.value, denied);
      if (denyRule) {
        return {
          allowed: isDryRun ? true : false,
          level: "deny",
          reason: `Path denied by policy`,
          matchedRule: denyRule,
          isDryRun,
        };
      }

      const allowed = policy.paths?.allow ?? [];
      const roots = policy.paths?.roots ?? [];
      const combined = [...allowed, ...roots];
      if (combined.length > 0) {
        const allowRule = matchesAny(action.value, combined);
        if (!allowRule) {
          // Not in any allow list
          const normalised = resolve(action.value);
          const inRoot = roots.some((r) => normalised.startsWith(resolve(r)));
          if (!inRoot) {
            return {
              allowed: isDryRun ? true : false,
              level: "deny",
              reason: `Path not in allowed roots`,
              matchedRule: "paths.roots",
              isDryRun,
            };
          }
        }
      }
    }

    // 4. Network
    if (action.type === "network") {
      let domain: string;
      try {
        domain = new URL(action.value).hostname;
      } catch {
        domain = action.value;
      }

      const isHttp = action.value.startsWith("http://");
      if (isHttp && policy.network?.allow_http === false) {
        return {
          allowed: isDryRun ? true : false,
          level: "deny",
          reason: `HTTP (non-HTTPS) requests are not allowed`,
          matchedRule: "network.allow_http",
          isDryRun,
        };
      }

      const denyDomains = policy.network?.deny_domains ?? [];
      const deniedDomain = denyDomains.find((d) => domainMatches(domain, d));
      if (deniedDomain) {
        return {
          allowed: isDryRun ? true : false,
          level: "deny",
          reason: `Domain denied by policy`,
          matchedRule: deniedDomain,
          isDryRun,
        };
      }

      const allowDomains = policy.network?.allow_domains ?? [];
      if (allowDomains.length > 0) {
        const matchedAllow = allowDomains.find((d) => domainMatches(domain, d));
        if (!matchedAllow) {
          return {
            allowed: isDryRun ? true : false,
            level: "deny",
            reason: `Domain not in allow list`,
            matchedRule: "network.allow_domains",
            isDryRun,
          };
        }
      }
    }

    // 5. Models
    if (action.type === "model") {
      const deny = policy.models?.deny ?? [];
      const deniedModel = deny.find((p) => matchesGlob(action.value, p));
      if (deniedModel) {
        return {
          allowed: isDryRun ? true : false,
          level: "deny",
          reason: `Model denied by policy`,
          matchedRule: deniedModel,
          isDryRun,
        };
      }

      const allow = policy.models?.allow ?? [];
      if (allow.length > 0) {
        const allowedModel = allow.find((p) => matchesGlob(action.value, p));
        if (!allowedModel) {
          return {
            allowed: isDryRun ? true : false,
            level: "deny",
            reason: `Model not in allow list`,
            matchedRule: "models.allow",
            isDryRun,
          };
        }
      }

      const maxCost = policy.models?.max_cost_per_call;
      if (maxCost !== undefined) {
        const callCost = action.context?.costUsd as number | undefined;
        if (callCost !== undefined && callCost > maxCost) {
          return {
            allowed: isDryRun ? true : false,
            level: "deny",
            reason: `Model call cost $${callCost.toFixed(4)} exceeds per-call cap of $${maxCost}`,
            matchedRule: "models.max_cost_per_call",
            isDryRun,
          };
        }
      }
    }

    // 6. Deploys
    if (action.type === "deploy") {
      const protected_ = policy.deploys?.protected_environments ?? [];
      if (protected_.includes(action.value)) {
        if (policy.deploys?.require_approval) {
          return {
            allowed: isDryRun ? true : false,
            level: "require_approval",
            reason: `Deploy to protected environment "${action.value}" requires approval`,
            matchedRule: "deploys.protected_environments",
            isDryRun,
          };
        }
      }

      if (policy.deploys?.require_approval) {
        return {
          allowed: isDryRun ? true : false,
          level: "require_approval",
          reason: `All deploys require approval`,
          matchedRule: "deploys.require_approval",
          isDryRun,
        };
      }

      const allowed_ = policy.deploys?.allowed_environments;
      if (allowed_ && allowed_.length > 0 && !allowed_.includes(action.value)) {
        return {
          allowed: isDryRun ? true : false,
          level: "deny",
          reason: `Environment "${action.value}" is not in allowed_environments`,
          matchedRule: "deploys.allowed_environments",
          isDryRun,
        };
      }
    }

    // Default: allow
    return {
      allowed: true,
      level: "allow",
      reason: "No matching deny rule",
      isDryRun,
    };
  }
}

// ── Domain matching helper ─────────────────────────────────

/**
 * Match a domain against a policy domain pattern.
 * - "github.com" matches exactly "github.com"
 * - "*.github.com" matches any subdomain of github.com (e.g. "api.github.com")
 */
function domainMatches(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".github.com"
    return domain.endsWith(suffix) && domain.length > suffix.length;
  }
  return domain === pattern;
}
