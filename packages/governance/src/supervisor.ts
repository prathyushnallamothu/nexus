/**
 * Dynamic Supervisor
 *
 * Adjusts oversight level per-action based on risk score:
 *   AUTO   → Silent execution (low risk, routine tasks)
 *   HOTL   → Log + alert, but don't block (medium risk)
 *   HITL   → Pause and ask for human approval (high risk)
 *   BLOCK  → Deny execution entirely (critical risk)
 */

import type { Middleware, AgentContext, NextFn, ToolCall } from "@nexus/core";

export type SupervisionLevel = "auto" | "hotl" | "hitl" | "block";

export interface SupervisionRule {
  /** Pattern to match tool name */
  toolPattern: RegExp;
  /** Pattern to match tool arguments (serialized) */
  argPattern?: RegExp;
  /** Supervision level when matched */
  level: SupervisionLevel;
  /** Human-readable reason */
  reason: string;
}

export interface SupervisionDecision {
  level: SupervisionLevel;
  reason: string;
  toolName: string;
  timestamp: number;
}

/** Default supervision rules */
const DEFAULT_RULES: SupervisionRule[] = [
  // BLOCK — never allow these
  {
    toolPattern: /^shell$/,
    argPattern: /rm\s+-rf\s+[\/\\]|format\s+[a-z]:|del\s+\/s\s+\/q/i,
    level: "block",
    reason: "Destructive system command",
  },
  {
    toolPattern: /^shell$/,
    argPattern: /curl.*\|\s*(sh|bash)|wget.*\|\s*(sh|bash)/i,
    level: "block",
    reason: "Remote code execution attempt",
  },

  // HITL — require approval
  {
    toolPattern: /^shell$/,
    argPattern: /git\s+push.*--force|git\s+push.*-f\b/i,
    level: "hitl",
    reason: "Force push could overwrite remote history",
  },
  {
    toolPattern: /^shell$/,
    argPattern: /npm\s+publish|yarn\s+publish|bun\s+publish/i,
    level: "hitl",
    reason: "Publishing a package to registry",
  },
  {
    toolPattern: /^shell$/,
    argPattern: /DROP\s+(TABLE|DATABASE)|TRUNCATE|DELETE\s+FROM\s+\w+\s*$/i,
    level: "hitl",
    reason: "Destructive database operation",
  },
  {
    toolPattern: /^write_file$/,
    argPattern: /\.env|\.pem|\.key|credentials|secret/i,
    level: "hitl",
    reason: "Writing to sensitive file",
  },

  // HOTL — log and alert but don't block
  {
    toolPattern: /^shell$/,
    argPattern: /git\s+push/i,
    level: "hotl",
    reason: "Pushing to remote repository",
  },
  {
    toolPattern: /^shell$/,
    argPattern: /npm\s+install|bun\s+(add|install)|pip\s+install/i,
    level: "hotl",
    reason: "Installing external packages",
  },
  {
    toolPattern: /^write_file$/,
    argPattern: /package\.json|Dockerfile|docker-compose/i,
    level: "hotl",
    reason: "Modifying infrastructure config",
  },
];

export class DynamicSupervisor {
  private rules: SupervisionRule[];
  private decisions: SupervisionDecision[] = [];
  private approvalCallback?: (decision: SupervisionDecision) => Promise<boolean>;

  constructor(options?: {
    rules?: SupervisionRule[];
    additionalRules?: SupervisionRule[];
    onApprovalNeeded?: (decision: SupervisionDecision) => Promise<boolean>;
  }) {
    this.rules = options?.rules ?? [...DEFAULT_RULES];
    if (options?.additionalRules) {
      this.rules.push(...options.additionalRules);
    }
    this.approvalCallback = options?.onApprovalNeeded;
  }

  /** Evaluate a tool call and return the supervision decision */
  evaluate(toolCall: ToolCall): SupervisionDecision {
    const argsStr = JSON.stringify(toolCall.arguments);

    // Check rules from most restrictive to least
    const rulesByPriority: SupervisionLevel[] = ["block", "hitl", "hotl"];

    for (const priority of rulesByPriority) {
      for (const rule of this.rules) {
        if (rule.level !== priority) continue;

        if (rule.toolPattern.test(toolCall.name)) {
          if (!rule.argPattern || rule.argPattern.test(argsStr)) {
            const decision: SupervisionDecision = {
              level: rule.level,
              reason: rule.reason,
              toolName: toolCall.name,
              timestamp: Date.now(),
            };
            this.decisions.push(decision);
            return decision;
          }
        }
      }
    }

    // Default: auto-approve
    const decision: SupervisionDecision = {
      level: "auto",
      reason: "No matching rule — auto-approved",
      toolName: toolCall.name,
      timestamp: Date.now(),
    };
    this.decisions.push(decision);
    return decision;
  }

  /** Request human approval for HITL decisions */
  async requestApproval(decision: SupervisionDecision): Promise<boolean> {
    if (this.approvalCallback) {
      return this.approvalCallback(decision);
    }
    // Default: deny if no callback is set
    return false;
  }

  /** Get all decisions made this session */
  getDecisions(): SupervisionDecision[] {
    return [...this.decisions];
  }

  /** Get decision summary stats */
  getStats(): Record<SupervisionLevel, number> {
    const stats: Record<SupervisionLevel, number> = { auto: 0, hotl: 0, hitl: 0, block: 0 };
    for (const d of this.decisions) {
      stats[d.level]++;
    }
    return stats;
  }
}

/**
 * Supervision Middleware
 *
 * Wraps tool dispatch with dynamic supervision.
 * Intercepts tool calls before execution to evaluate risk.
 */
export function supervisionMiddleware(supervisor: DynamicSupervisor): Middleware {
  return {
    name: "dynamic-supervisor",
    async execute(ctx: AgentContext, next: NextFn) {
      // Store original tools and wrap them with supervision
      const originalTools = ctx.tools;

      ctx.tools = originalTools.map((tool) => ({
        schema: tool.schema,
        execute: async (args: Record<string, unknown>) => {
          // Evaluate the tool call
          const decision = supervisor.evaluate({
            id: `call_${Date.now()}`,
            name: tool.schema.name,
            arguments: args,
          });

          switch (decision.level) {
            case "block":
              throw new Error(
                `⛔ BLOCKED: ${decision.reason}. This action is not permitted.`,
              );

            case "hitl": {
              const approved = await supervisor.requestApproval(decision);
              if (!approved) {
                throw new Error(
                  `🚫 DENIED: ${decision.reason}. Human approval was not granted.`,
                );
              }
              // Approved — fall through to execute
              break;
            }

            case "hotl":
              // Log but don't block
              ctx.meta["lastSupervisionAlert"] = decision.reason;
              break;

            case "auto":
              // Silent — no action needed
              break;
          }

          return tool.execute(args);
        },
      }));

      await next();

      // Restore original tools
      ctx.tools = originalTools;
    },
  };
}
