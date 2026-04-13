/**
 * Nexus Trajectory Types + Outcome Classification
 *
 * Outcome is NOT always "success". We classify based on evidence:
 *   1. Iteration limit hit → partial
 *   2. Failed commands (non-zero exit codes in artifacts)
 *   3. High tool error rate (>50% of tool calls errored)
 *   4. Failure signals in assistant response text
 *   5. User explicit feedback (thumbs down)
 *   6. Default → success with calibrated confidence
 */

import type { Message, BudgetState, ArtifactRecord } from "@nexus/core";
import type { OutcomeType } from "./db.js";

// ── Trajectory ─────────────────────────────────────────────

export interface Trajectory {
  /** User's original task message */
  task: string;
  /** Full message history */
  messages: Message[];
  /** Final classified outcome */
  outcome: OutcomeType;
  /** Human-readable reason for outcome classification */
  outcomeReason: string;
  /** Confidence 0–1 in the outcome classification */
  outcomeConfidence: number;
  /** Cost and performance */
  budget: BudgetState;
  /** Wall-clock duration in ms */
  durationMs: number;
  /** Routing path used */
  routingPath: "system1" | "system2";
  /** Skill ID used (if System 1) */
  skillUsed?: string;
  /** Artifacts produced during the run */
  artifacts: ArtifactRecord[];
  /** User-provided feedback (overrides auto classification) */
  userFeedback?: "positive" | "negative";
  /** Whether the agent hit its iteration limit */
  hitIterationLimit: boolean;
  /** Session ID */
  sessionId: string;
  /** Project context */
  projectId?: string;
  /** Unix timestamp */
  timestamp: number;
}

// ── Outcome Classification ─────────────────────────────────

export interface OutcomeClassification {
  outcome: OutcomeType;
  confidence: number;
  reason: string;
  signals: string[];
}

/** Patterns in assistant responses that indicate failure */
const FAILURE_SIGNALS = [
  /i (couldn't|could not|was unable to|failed to)\b/i,
  /\b(failed|unsuccessful|did not succeed)\b/i,
  /i encountered an? (error|problem|issue)\b/i,
  /\bsomething went wrong\b/i,
  /\bcannot complete\b/i,
  /\bI'm sorry, but I (couldn't|was unable)\b/i,
];

/** Patterns that indicate partial completion */
const PARTIAL_SIGNALS = [
  /\bpartially\b/i,
  /\bsome of\b/i,
  /\bI (managed|was able) to .+ but (couldn't|could not|was unable to)\b/i,
  /\bincomplete\b/i,
  /\bstill (need|needs|requires)\b/i,
];

/**
 * Classify the outcome of an agent run without requiring user input.
 *
 * Evidence weighting:
 *   +3 iteration limit (strong partial signal)
 *   +2 per failed command artifact
 *   +2 explicit failure signal in response text
 *   +1 partial signal in response text
 *   +1 per tool error message (capped at 3)
 *   −1 explicit success signal ("successfully completed", "done", "finished")
 */
export function classifyOutcome(
  response: string,
  messages: Message[],
  artifacts: ArtifactRecord[],
  hitIterationLimit: boolean,
  userFeedback?: "positive" | "negative",
): OutcomeClassification {
  // User feedback overrides everything
  if (userFeedback === "positive") {
    return { outcome: "success", confidence: 1.0, reason: "User confirmed success", signals: ["user feedback: positive"] };
  }
  if (userFeedback === "negative") {
    return { outcome: "failure", confidence: 1.0, reason: "User reported failure", signals: ["user feedback: negative"] };
  }

  const signals: string[] = [];
  let failureScore = 0;
  let partialScore = 0;

  // 1. Iteration limit
  if (hitIterationLimit) {
    partialScore += 3;
    signals.push("hit iteration limit");
  }

  // 2. Failed command artifacts (non-zero exit codes)
  const failedCmds = artifacts.filter(
    (a) => a.type === "command_run" &&
      a.summary &&
      /exit (code )?[1-9]\d*|error:|failed/i.test(a.summary),
  );
  if (failedCmds.length > 0) {
    failureScore += failedCmds.length * 2;
    signals.push(`${failedCmds.length} command(s) failed`);
  }

  // 3. Tool error messages in conversation
  const toolErrors = messages.filter(
    (m) => m.role === "tool" &&
      (m.content.startsWith("Error") || m.content.startsWith("error:")),
  );
  if (toolErrors.length > 0) {
    const capped = Math.min(toolErrors.length, 3);
    failureScore += capped;
    signals.push(`${toolErrors.length} tool error(s)`);
  }

  // 4. Check total tool calls vs errors ratio
  const totalToolMsgs = messages.filter((m) => m.role === "tool").length;
  if (totalToolMsgs > 0 && toolErrors.length / totalToolMsgs > 0.5) {
    failureScore += 2;
    signals.push(`>50% tool call error rate (${toolErrors.length}/${totalToolMsgs})`);
  }

  // 5. Failure signals in final response
  const responseLower = response.slice(-1000); // only look at end of response
  for (const pattern of FAILURE_SIGNALS) {
    if (pattern.test(responseLower)) {
      failureScore += 2;
      signals.push("response indicates failure");
      break;
    }
  }

  // 6. Partial signals in final response
  for (const pattern of PARTIAL_SIGNALS) {
    if (pattern.test(responseLower)) {
      partialScore += 1;
      signals.push("response indicates partial completion");
      break;
    }
  }

  // 7. Success signals (reduce score)
  const successPatterns = [
    /\bsuccessfully\b/i,
    /\bcompleted\b/i,
    /\bfinished\b/i,
    /\bdone\b/i,
    /\ball set\b/i,
  ];
  const hasSuccessSignal = successPatterns.some((p) => p.test(responseLower));
  if (hasSuccessSignal) {
    signals.push("response indicates success");
  }

  // Classify
  const total = failureScore + partialScore;

  if (failureScore >= 4) {
    return {
      outcome: "failure",
      confidence: Math.min(0.95, 0.6 + failureScore * 0.05),
      reason: signals.join("; "),
      signals,
    };
  }

  if (partialScore >= 3 || (failureScore >= 2 && partialScore >= 1)) {
    return {
      outcome: "partial",
      confidence: Math.min(0.9, 0.55 + total * 0.05),
      reason: signals.join("; "),
      signals,
    };
  }

  if (failureScore >= 2) {
    return {
      outcome: "partial",
      confidence: 0.65,
      reason: signals.join("; "),
      signals,
    };
  }

  // Default: success
  const successConfidence = hasSuccessSignal ? 0.9 : 0.75;
  return {
    outcome: "success",
    confidence: signals.length > 0 ? successConfidence - 0.1 : successConfidence,
    reason: signals.length > 0 ? signals.join("; ") : "No failure signals detected",
    signals,
  };
}

// ── Reflection (LLM-generated analysis) ───────────────────

export interface Reflection {
  /** What strategies worked well */
  successFactors: string[];
  /** What went wrong or could be improved */
  failurePoints: string[];
  /** Where the agent was inefficient */
  efficiencyOpportunities: string[];
  /** Skill recommendation from this trajectory */
  skillRecommendation: {
    action: "create" | "update" | "none";
    skillName?: string;
    description?: string;
    procedure?: string;
    triggers?: string[];
    reason: string;
  };
  /** Facts worth remembering about the user or project */
  memorableContext: string[];
}
