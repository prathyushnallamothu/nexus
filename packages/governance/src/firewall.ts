/**
 * Nexus Prompt Firewall
 *
 * Dedicated security module for prompt injection detection,
 * output scanning, and behavioral policy enforcement.
 *
 * This expands on the basic promptFirewall() in core/middleware.ts
 * with multi-layer detection, configurable policies, and audit integration.
 */

import type { Middleware, AgentContext, NextFn } from "@nexus/core";

// ── Injection Detection ───────────────────────────────────

export interface InjectionPattern {
  name: string;
  pattern: RegExp;
  severity: "low" | "medium" | "high" | "critical";
  action: "log" | "warn" | "block";
}

const DEFAULT_INJECTION_PATTERNS: InjectionPattern[] = [
  // Classic prompt injections
  {
    name: "ignore_instructions",
    pattern: /ignore\s+(all\s+)?(?:previous|prior|above)\s+instructions/i,
    severity: "critical",
    action: "block",
  },
  {
    name: "role_override",
    pattern: /you\s+are\s+now\s+(a\s+)?(?:an?\s+)?(?:evil|unrestricted|jailbroken|DAN|developer|admin)/i,
    severity: "critical",
    action: "block",
  },
  {
    name: "system_override",
    pattern: /\bsystem\s*:\s*override\b|\[SYSTEM\].*override/i,
    severity: "high",
    action: "block",
  },
  {
    name: "system_tags",
    pattern: /<\/?system>|<\/?prompt>/i,
    severity: "high",
    action: "block",
  },
  {
    name: "code_system_block",
    pattern: /```(?:system|prompt)\s*\n/i,
    severity: "high",
    action: "block",
  },
  {
    name: "llama_format_injection",
    pattern: /\[\s*INST\s*\]|\[\/\s*INST\s*\]/,
    severity: "medium",
    action: "warn",
  },
  {
    name: "gpt_format_injection",
    pattern: /###\s*(?:Human|Assistant|System)\s*:/,
    severity: "medium",
    action: "warn",
  },
  {
    name: "new_instructions",
    pattern: /IMPORTANT:\s*(?:new|override|forget|ignore|disregard)/i,
    severity: "high",
    action: "block",
  },
  {
    name: "jailbreak_attempt",
    pattern: /(?:jailbreak|DAN|do anything now|pretend you have no restrictions)/i,
    severity: "critical",
    action: "block",
  },
  // Fake SYSTEM/directive prefix injection
  {
    name: "fake_system_directive",
    pattern: /^(?:SYSTEM|DIRECTIVE|ADMIN|ROOT)\s*:\s*(?:new|override|forget|ignore|output|print|reveal)/im,
    severity: "high",
    action: "block",
  },
  // Repetition/DoS pattern
  {
    name: "repetition_dos",
    pattern: /(?:repeat|print|say|output|write|echo)\s+(?:the\s+following\s+)?\d{2,}\s+times/i,
    severity: "medium",
    action: "block",
  },
  // Indirect injection via file content
  {
    name: "file_injection_marker",
    pattern: /---\s*NEXUS_INJECTION\s*---/i,
    severity: "critical",
    action: "block",
  },
];

// ── Output Scanning ───────────────────────────────────────

export interface LeakagePattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_LEAKAGE_PATTERNS: LeakagePattern[] = [
  {
    name: "openai_key",
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    replacement: "[REDACTED:API_KEY]",
  },
  {
    name: "anthropic_key",
    pattern: /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
    replacement: "[REDACTED:API_KEY]",
  },
  {
    name: "private_key",
    // Match from BEGIN header to END footer, or just the BEGIN header line alone
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----(?:[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----|[^\n]*)/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
  {
    name: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{30,}=*/g,
    replacement: "Bearer [REDACTED:TOKEN]",
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED:AWS_KEY]",
  },
  {
    name: "aws_secret_key",
    pattern: /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*=\s*[A-Za-z0-9/+]{20,}/g,
    replacement: "[REDACTED:AWS_SECRET]",
  },
  {
    name: "password_in_string",
    pattern: /(?:password|passwd|secret|api_?key)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    replacement: "[REDACTED:CREDENTIAL]",
  },
  {
    name: "connection_string",
    pattern: /(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s'"]+/gi,
    replacement: "[REDACTED:CONNECTION_STRING]",
  },
];

// ── Firewall Result ───────────────────────────────────────

export interface FirewallResult {
  blocked: boolean;
  reason?: string;
  matchedPattern?: string;
  severity?: InjectionPattern["severity"];
  redacted?: boolean;
  redactedPatterns?: string[];
}

// ── Firewall class ────────────────────────────────────────

export class PromptFirewall {
  private injectionPatterns: InjectionPattern[];
  private leakagePatterns: LeakagePattern[];
  private blockList: Set<string> = new Set();
  private violations: Array<{ timestamp: number; type: string; pattern: string; content: string }> = [];

  constructor(opts?: {
    additionalInjectionPatterns?: InjectionPattern[];
    additionalLeakagePatterns?: LeakagePattern[];
    blockList?: string[];
  }) {
    this.injectionPatterns = [
      ...DEFAULT_INJECTION_PATTERNS,
      ...(opts?.additionalInjectionPatterns ?? []),
    ];
    this.leakagePatterns = [
      ...DEFAULT_LEAKAGE_PATTERNS,
      ...(opts?.additionalLeakagePatterns ?? []),
    ];
    for (const item of opts?.blockList ?? []) {
      this.blockList.add(item.toLowerCase());
    }
  }

  /**
   * Scan an input message for prompt injection attempts.
   */
  scanInput(content: string): FirewallResult {
    // Check block list
    const lower = content.toLowerCase();
    for (const blocked of this.blockList) {
      if (lower.includes(blocked)) {
        this._recordViolation("blocklist", blocked, content);
        return { blocked: true, reason: "Content matches block list", matchedPattern: blocked, severity: "high" };
      }
    }

    // Check injection patterns from most severe to least
    const byPriority = [...this.injectionPatterns].sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.severity] - order[b.severity];
    });

    for (const ip of byPriority) {
      if (ip.pattern.test(content)) {
        this._recordViolation("injection", ip.name, content);

        if (ip.action === "block") {
          return {
            blocked: true,
            reason: `Injection pattern detected: ${ip.name}`,
            matchedPattern: ip.name,
            severity: ip.severity,
          };
        }

        // warn/log — don't block but flag
        return {
          blocked: false,
          reason: `Suspicious pattern detected (${ip.severity}): ${ip.name}`,
          matchedPattern: ip.name,
          severity: ip.severity,
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Scan output for sensitive data leakage and redact it.
   */
  scanOutput(content: string): { content: string; redacted: boolean; patterns: string[] } {
    let result = content;
    const redactedPatterns: string[] = [];

    for (const lp of this.leakagePatterns) {
      // Reset lastIndex before each use — /g regexes are stateful
      lp.pattern.lastIndex = 0;
      if (lp.pattern.test(result)) {
        lp.pattern.lastIndex = 0; // reset again before replace
        result = result.replace(lp.pattern, lp.replacement);
        redactedPatterns.push(lp.name);
        this._recordViolation("leakage", lp.name, "[output]");
      }
    }

    return { content: result, redacted: redactedPatterns.length > 0, patterns: redactedPatterns };
  }

  /** Get violation history for audit */
  getViolations() {
    return [...this.violations];
  }

  /** Add a pattern to the block list at runtime */
  addToBlockList(term: string): void {
    this.blockList.add(term.toLowerCase());
  }

  private _recordViolation(type: string, pattern: string, content: string): void {
    this.violations.push({
      timestamp: Date.now(),
      type,
      pattern,
      content: content.slice(0, 100),
    });
    // Keep last 200 violations
    if (this.violations.length > 200) this.violations.shift();
  }
}

// ── Middleware factory ─────────────────────────────────────

export function firewallMiddleware(
  firewall?: PromptFirewall,
  opts?: { blockOnDetection?: boolean },
): Middleware {
  const fw = firewall ?? new PromptFirewall();
  const blockOnDetection = opts?.blockOnDetection ?? true;

  return {
    name: "prompt-firewall",
    async execute(ctx: AgentContext, next: NextFn) {
      // Scan incoming user message
      const lastUserMsg = [...ctx.messages].reverse().find((m) => m.role === "user");

      if (lastUserMsg) {
        const inputResult = fw.scanInput(lastUserMsg.content);

        if (inputResult.blocked && blockOnDetection) {
          ctx.meta["firewall_blocked"] = true;
          ctx.meta["firewall_reason"] = inputResult.reason;
          ctx.abort(`Firewall: ${inputResult.reason}`);
          return;
        }

        if (inputResult.matchedPattern) {
          ctx.meta["firewall_flagged"] = true;
          ctx.meta["firewall_pattern"] = inputResult.matchedPattern;
          ctx.meta["firewall_severity"] = inputResult.severity;
        }
      }

      await next();

      // Scan output for leakage
      const lastAssistantMsg = [...ctx.messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistantMsg?.content) {
        const outputResult = fw.scanOutput(lastAssistantMsg.content);
        if (outputResult.redacted) {
          lastAssistantMsg.content = outputResult.content;
          ctx.meta["output_redacted"] = true;
          ctx.meta["output_redacted_patterns"] = outputResult.patterns;
        }
      }
    },
  };
}
