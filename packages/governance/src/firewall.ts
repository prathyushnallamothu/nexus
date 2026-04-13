/**
 * Nexus Prompt Firewall
 *
 * Dedicated security module for prompt injection detection,
 * output scanning, and behavioral policy enforcement.
 *
 * This expands on the basic promptFirewall() in core/middleware.ts
 * with multi-layer detection, configurable policies, and audit integration.
 *
 * Supports optional ML-based detection following the Goose pattern.
 */

import type { Middleware, AgentContext, NextFn } from "@nexus/core";

// ── ML Detection Interface ────────────────────────────────

export interface MLClassifier {
  classify(input: string): Promise<{ isMalicious: boolean; confidence: number; label?: string }>;
}

/**
 * Simple heuristic-based ML classifier fallback.
 * In production, this would call an external ML service or load a local model.
 */
class HeuristicMLClassifier implements MLClassifier {
  async classify(input: string): Promise<{ isMalicious: boolean; confidence: number; label?: string }> {
    const lower = input.toLowerCase();
    const suspiciousPatterns = [
      /ignore\s+(all\s+)?(?:previous|prior|above)\s+instructions/i,
      /you\s+are\s+now\s+(a\s+)?(?:evil|unrestricted|jailbroken|DAN)/i,
      /jailbreak|do anything now|pretend you have no restrictions/i,
      /system\s*:\s*override/i,
      /important:\s*(?:new|override|forget|ignore)/i,
    ];

    let matchCount = 0;
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(lower)) matchCount++;
    }

    const confidence = Math.min(matchCount * 0.25, 0.95);
    return {
      isMalicious: matchCount >= 2,
      confidence,
      label: matchCount >= 2 ? "prompt_injection" : undefined,
    };
  }
}

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
  private mlClassifier: MLClassifier | null = null;
  private mlEnabled: boolean = false;

  constructor(opts?: {
    additionalInjectionPatterns?: InjectionPattern[];
    additionalLeakagePatterns?: LeakagePattern[];
    blockList?: string[];
    mlClassifier?: MLClassifier;
    enableML?: boolean;
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
    this.mlClassifier = opts?.mlClassifier ?? new HeuristicMLClassifier();
    this.mlEnabled = opts?.enableML ?? false;
  }

  /** Enable or disable ML-based detection at runtime */
  setMLEnabled(enabled: boolean): void {
    this.mlEnabled = enabled;
  }

  /** Set a custom ML classifier */
  setMLClassifier(classifier: MLClassifier): void {
    this.mlClassifier = classifier;
  }

  /**
   * Scan an input message for prompt injection attempts.
   * Uses ML classifier when enabled, otherwise falls back to regex patterns.
   */
  async scanInput(content: string): Promise<FirewallResult> {
    // Check block list first (always enabled)
    const lower = content.toLowerCase();
    for (const blocked of this.blockList) {
      if (lower.includes(blocked)) {
        this._recordViolation("blocklist", blocked, content);
        return { blocked: true, reason: "Content matches block list", matchedPattern: blocked, severity: "high" };
      }
    }

    // ML-based detection if enabled
    if (this.mlEnabled && this.mlClassifier) {
      try {
        const mlResult = await this.mlClassifier.classify(content);
        if (mlResult.isMalicious) {
          this._recordViolation("ml_detection", mlResult.label || "unknown", content);
          return {
            blocked: true,
            reason: `ML classifier detected ${mlResult.label || "malicious"} content (confidence: ${(mlResult.confidence * 100).toFixed(0)}%)`,
            matchedPattern: mlResult.label,
            severity: "critical",
          };
        }
      } catch (error) {
        // ML classifier failed - fall back to regex patterns
        console.warn(`ML classifier failed, falling back to regex patterns: ${error}`);
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
        const inputResult = await fw.scanInput(lastUserMsg.content);

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
