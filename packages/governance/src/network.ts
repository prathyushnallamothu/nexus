/**
 * Nexus Network Guard
 *
 * Enforces allow/deny lists on outbound network calls made by tools.
 * Integrates with the policy engine for config-driven rules.
 *
 * Features:
 *   - Domain allow/deny lists (exact, wildcard *.example.com, subdomain)
 *   - HTTP vs HTTPS enforcement
 *   - Timeout budgets per domain
 *   - Request logging for audit
 */

import type { Middleware, AgentContext, NextFn, Tool } from "@nexus/core";

// ── Types ──────────────────────────────────────────────────

export interface NetworkPolicy {
  allowDomains?: string[];     // ["github.com", "*.anthropic.com"]
  denyDomains?: string[];      // ["*.onion", "169.254.169.254"]
  allowHttp?: boolean;         // default false
  denyPrivateRanges?: boolean; // block 10.x, 172.16.x, 192.168.x, 127.x (SSRF protection)
  timeoutMs?: number;          // per-request timeout
}

export interface NetworkCheckResult {
  allowed: boolean;
  reason: string;
  domain: string;
}

// ── Always-denied domains ──────────────────────────────────

const ALWAYS_DENIED_DOMAINS: string[] = [
  "169.254.169.254",         // AWS IMDS
  "metadata.google.internal", // GCP metadata
];

const ALWAYS_DENIED_PATTERNS: RegExp[] = [
  /\.internal$/i,
  /\.local$/i,
];

// Private IPv4 CIDR ranges as octets for fast matching
const PRIVATE_RANGE_CHECKS: Array<(hostname: string) => boolean> = [
  // 127.0.0.0/8
  (h) => /^127\./.test(h),
  // 10.0.0.0/8
  (h) => /^10\./.test(h),
  // 172.16.0.0/12
  (h) => {
    const m = h.match(/^172\.(\d+)\./);
    if (!m) return false;
    const b = parseInt(m[1], 10);
    return b >= 16 && b <= 31;
  },
  // 192.168.0.0/16
  (h) => /^192\.168\./.test(h),
  // ::1 IPv6 loopback
  (h) => h === "::1" || h === "[::1]",
  // fc00::/7 IPv6 unique local
  (h) => /^fe[89ab][0-9a-f]:/i.test(h) || /^fc[0-9a-f][0-9a-f]:/i.test(h),
];

// ── Domain matching ────────────────────────────────────────

/**
 * Match a resolved domain against a policy pattern.
 * - Exact: "github.com" matches "github.com" only
 * - Wildcard prefix: "*.github.com" matches any subdomain of github.com
 */
function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".github.com"
    return domain.endsWith(suffix) && domain.length > suffix.length;
  }
  return domain === pattern;
}

/** Extract the hostname from a URL string. Returns the raw string on parse failure. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** True if URL uses the http: scheme (not https:). */
function isHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

// ── NetworkGuard ───────────────────────────────────────────

export class NetworkGuard {
  private policy: NetworkPolicy;
  private log: Array<{ url: string; result: NetworkCheckResult; timestamp: number }> = [];

  constructor(policy?: NetworkPolicy) {
    this.policy = policy ?? {};
  }

  /**
   * Check whether a given URL is permitted by the network policy.
   * This is the core gate — call it before any outbound fetch.
   */
  check(url: string): NetworkCheckResult {
    const domain = extractDomain(url);
    const result = this._check(url, domain);
    this.log.push({ url, result, timestamp: Date.now() });
    return result;
  }

  private _check(url: string, domain: string): NetworkCheckResult {
    // 1. Always-denied exact domains
    if (ALWAYS_DENIED_DOMAINS.includes(domain)) {
      return {
        allowed: false,
        reason: `Domain "${domain}" is always denied (SSRF protection)`,
        domain,
      };
    }

    // 2. Always-denied patterns (*.internal, *.local)
    for (const pattern of ALWAYS_DENIED_PATTERNS) {
      if (pattern.test(domain)) {
        return {
          allowed: false,
          reason: `Domain "${domain}" matches always-denied pattern ${pattern.source}`,
          domain,
        };
      }
    }

    // 3. Private IP range protection
    if (this.policy.denyPrivateRanges !== false) {
      // Default-on when policy is provided with denyPrivateRanges unset,
      // fully optional — callers can explicitly set false to disable.
      if (this.policy.denyPrivateRanges === true || this.policy.denyPrivateRanges === undefined) {
        for (const check of PRIVATE_RANGE_CHECKS) {
          if (check(domain)) {
            return {
              allowed: false,
              reason: `Domain "${domain}" resolves to a private IP range (SSRF protection)`,
              domain,
            };
          }
        }
      }
    }

    // 4. HTTP enforcement
    if (isHttp(url) && this.policy.allowHttp !== true) {
      return {
        allowed: false,
        reason: `HTTP requests are not allowed — use HTTPS`,
        domain,
      };
    }

    // 5. Policy deny list
    const denyDomains = this.policy.denyDomains ?? [];
    const deniedByPolicy = denyDomains.find((p) => domainMatchesPattern(domain, p));
    if (deniedByPolicy) {
      return {
        allowed: false,
        reason: `Domain "${domain}" is denied by policy (matched: ${deniedByPolicy})`,
        domain,
      };
    }

    // 6. Policy allow list (if specified, only listed domains are permitted)
    const allowDomains = this.policy.allowDomains ?? [];
    if (allowDomains.length > 0) {
      const allowedByPolicy = allowDomains.find((p) => domainMatchesPattern(domain, p));
      if (!allowedByPolicy) {
        return {
          allowed: false,
          reason: `Domain "${domain}" is not in the allow list`,
          domain,
        };
      }
    }

    return {
      allowed: true,
      reason: "OK",
      domain,
    };
  }

  /**
   * Monkey-patch the global `fetch` to enforce this network policy.
   * Returns a restore function — call it to remove the patch.
   */
  patchFetch(): () => void {
    const guard = this;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

      const checkResult = guard.check(url);
      if (!checkResult.allowed) {
        throw new Error(`[nexus:network] Request blocked: ${checkResult.reason}`);
      }

      // Apply timeout budget if configured
      const timeoutMs = guard.policy.timeoutMs;
      if (timeoutMs !== undefined) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const mergedInit: RequestInit = {
          ...init,
          signal: controller.signal,
        };
        try {
          const response = await originalFetch(input, mergedInit);
          clearTimeout(timer);
          return response;
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      }

      return originalFetch(input, init);
    } as typeof globalThis.fetch;

    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  /**
   * Wrap a Tool so that any `url`-shaped argument is checked before
   * the underlying execute() runs.
   */
  wrapTool(tool: Tool): Tool {
    const guard = this;
    return {
      schema: tool.schema,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        // Scan all string arguments for URLs
        for (const [key, value] of Object.entries(args)) {
          if (typeof value !== "string") continue;
          if (!_looksLikeUrl(value)) continue;

          const result = guard.check(value);
          if (!result.allowed) {
            throw new Error(
              `[nexus:network] Tool "${tool.schema.name}" arg "${key}" blocked: ${result.reason}`,
            );
          }
        }
        return tool.execute(args);
      },
    };
  }

  /** Return the request log for audit purposes. */
  getLog(): Array<{ url: string; result: NetworkCheckResult; timestamp: number }> {
    return [...this.log];
  }

  /** Clear the in-memory request log. */
  clearLog(): void {
    this.log = [];
  }
}

/** Heuristic: treat strings that look like http(s) URLs as URLs. */
function _looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// ── networkMiddleware ──────────────────────────────────────

/**
 * Middleware that wraps all tools' execute() to check URL-shaped
 * arguments against the NetworkGuard before execution.
 */
export function networkMiddleware(guard: NetworkGuard): Middleware {
  return {
    name: "network-guard",
    async execute(ctx: AgentContext, next: NextFn) {
      const originalTools = ctx.tools;
      ctx.tools = originalTools.map((tool) => guard.wrapTool(tool));
      await next();
      ctx.tools = originalTools;
    },
  };
}
