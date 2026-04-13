/**
 * Nexus Identity Manager
 *
 * Multi-user identity model with roles and per-identity policy overrides.
 * Integrates with budget scoping and audit logging.
 *
 * Roles:
 *   owner      — full access, can manage identities
 *   admin      — can change policy, approve HITL
 *   developer  — normal agent usage
 *   viewer     — read-only, no tool execution
 *   ci         — CI/CD identity, no HITL, reduced budget
 *
 * Identity resolution:
 *   1. NEXUS_USER_ID env var
 *   2. git config user.email
 *   3. OS username
 *   4. "anonymous"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { NexusPolicy } from "./policy.js";

// ── Types ──────────────────────────────────────────────────

export type IdentityRole = "owner" | "admin" | "developer" | "viewer" | "ci";

export interface Identity {
  id: string;
  name: string;
  email?: string;
  role: IdentityRole;
  policyOverrides?: Partial<NexusPolicy>;  // overrides merged onto base policy
  budgetLimitUsd?: number;                 // per-session override
  createdAt: number;
  updatedAt: number;
  lastActiveAt?: number;
}

interface IdentityStore {
  identities: Identity[];
  updatedAt: number;
}

// ── IdentityManager ────────────────────────────────────────

export class IdentityManager {
  private storePath: string;
  private cache: IdentityStore | null = null;

  constructor(storePath: string) {
    this.storePath = resolve(storePath);
  }

  // ── Resolution ───────────────────────────────────────

  /**
   * Auto-detect the current user identity.
   *
   * Resolution order:
   *   1. NEXUS_USER_ID environment variable (look up identity by id)
   *   2. git config user.email (look up by email, or create a developer identity)
   *   3. OS username ($USER / $USERNAME / os.userInfo)
   *   4. "anonymous"
   *
   * If no match is found in the store a transient (unsaved) Identity is returned.
   */
  resolve(): Identity {
    const store = this._load();

    // 1. NEXUS_USER_ID
    const envUserId = process.env["NEXUS_USER_ID"];
    if (envUserId) {
      const found = store.identities.find((i) => i.id === envUserId);
      if (found) return found;
    }

    // 2. git config user.email
    const gitEmail = _gitEmail();
    if (gitEmail) {
      const found = store.identities.find((i) => i.email === gitEmail);
      if (found) return found;

      // Auto-create a developer identity from git config
      const gitName = _gitName() ?? gitEmail.split("@")[0] ?? "unknown";
      return this.create({
        name: gitName,
        email: gitEmail,
        role: "developer",
      });
    }

    // 3. OS username
    const osUser = _osUsername();
    if (osUser) {
      const found = store.identities.find((i) => i.name === osUser);
      if (found) return found;

      return this.create({
        name: osUser,
        role: "developer",
      });
    }

    // 4. Anonymous
    const anon = store.identities.find((i) => i.id === "anonymous");
    if (anon) return anon;

    return this.create({
      name: "anonymous",
      role: "viewer",
    });
  }

  // ── CRUD ─────────────────────────────────────────────

  /** Look up an identity by id. */
  get(id: string): Identity | null {
    return this._load().identities.find((i) => i.id === id) ?? null;
  }

  /** Return all identities. */
  list(): Identity[] {
    return [...this._load().identities];
  }

  /** Create and persist a new identity. */
  create(identity: Omit<Identity, "id" | "createdAt" | "updatedAt">): Identity {
    const now = Date.now();
    const newIdentity: Identity = {
      ...identity,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };

    const store = this._load();
    store.identities.push(newIdentity);
    this._save(store);
    return newIdentity;
  }

  /** Apply partial updates to an existing identity. Returns null if not found. */
  update(id: string, updates: Partial<Identity>): Identity | null {
    const store = this._load();
    const idx = store.identities.findIndex((i) => i.id === id);
    if (idx === -1) return null;

    const updated: Identity = {
      ...store.identities[idx],
      ...updates,
      id,                          // id is immutable
      createdAt: store.identities[idx].createdAt, // createdAt is immutable
      updatedAt: Date.now(),
    };

    store.identities[idx] = updated;
    this._save(store);
    return updated;
  }

  /** Remove an identity. Returns true if it existed, false otherwise. */
  remove(id: string): boolean {
    const store = this._load();
    const before = store.identities.length;
    store.identities = store.identities.filter((i) => i.id !== id);
    if (store.identities.length === before) return false;
    this._save(store);
    return true;
  }

  /** Update the lastActiveAt timestamp for an identity. */
  touch(id: string): void {
    const store = this._load();
    const idx = store.identities.findIndex((i) => i.id === id);
    if (idx === -1) return;
    store.identities[idx] = {
      ...store.identities[idx],
      lastActiveAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._save(store);
    this.cache = store;
  }

  // ── Permission checks ─────────────────────────────────

  /**
   * True if the identity is allowed to execute tools.
   * The "viewer" role is read-only and cannot run tools.
   */
  canExecuteTools(identity: Identity): boolean {
    return identity.role !== "viewer";
  }

  /**
   * True if the identity can approve HITL requests.
   * Only "owner" and "admin" can approve.
   */
  canApprove(identity: Identity): boolean {
    return identity.role === "owner" || identity.role === "admin";
  }

  /**
   * True if the identity can change the global policy.
   * Only "owner" and "admin" have this right.
   */
  canManagePolicy(identity: Identity): boolean {
    return identity.role === "owner" || identity.role === "admin";
  }

  // ── Internal storage ──────────────────────────────────

  private _load(): IdentityStore {
    if (this.cache) return this.cache;

    if (!existsSync(this.storePath)) {
      this.cache = { identities: [], updatedAt: Date.now() };
      return this.cache;
    }

    try {
      const raw = readFileSync(this.storePath, "utf-8");
      this.cache = JSON.parse(raw) as IdentityStore;
      return this.cache;
    } catch {
      this.cache = { identities: [], updatedAt: Date.now() };
      return this.cache;
    }
  }

  private _save(store: IdentityStore): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const toSave: IdentityStore = { ...store, updatedAt: Date.now() };
    writeFileSync(this.storePath, JSON.stringify(toSave, null, 2), "utf-8");
    this.cache = toSave;
  }
}

// ── Convenience export ─────────────────────────────────────

/**
 * Resolve the current user identity without needing to construct an
 * IdentityManager instance directly.
 */
export function resolveCurrentIdentity(storePath: string): Identity {
  return new IdentityManager(storePath).resolve();
}

// ── Platform helpers ───────────────────────────────────────

function _gitEmail(): string | null {
  try {
    const out = execSync("git config user.email", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function _gitName(): string | null {
  try {
    const out = execSync("git config user.name", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function _osUsername(): string | null {
  // Try env vars first (cross-platform, no native module needed)
  const env = process.env["USER"] ?? process.env["USERNAME"] ?? process.env["LOGNAME"];
  if (env && env.trim()) return env.trim();

  // Fallback: os.userInfo() — synchronous, no import needed at top level
  try {
    const os = require("node:os") as typeof import("node:os");
    const info = os.userInfo();
    return info.username || null;
  } catch {
    return null;
  }
}
