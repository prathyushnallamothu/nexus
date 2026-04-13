/**
 * Nexus CLI — Agent message processor
 *
 * Handles:
 *   - Dual-process routing (System 1 / System 2) with explanations
 *   - Proper outcome classification (not always "success")
 *   - Redirect loop and iteration-limit surface
 *   - Learning pipeline with artifacts, sessionId, hitIterationLimit
 *   - User feedback commands (/thumbsup, /thumbsdown)
 */

import chalk from "chalk";
import type { Message, BudgetState, Tool, ArtifactRecord } from "@nexus/core";
import type { NexusAgent } from "@nexus/core";
import type {
  DualProcessRouter,
  System1Executor,
  ExperienceLearner,
  ModeManager,
  Trajectory,
} from "@nexus/intelligence";
import { BUDGET_USD } from "./config.js";

export interface ProcessorDeps {
  agent: NexusAgent;
  allTools: Tool[];
  router: DualProcessRouter;
  system1: System1Executor;
  learner: ExperienceLearner;
  modeManager: ModeManager;
}

export type ProcessMessageFn = (input: string) => Promise<void>;

export function createProcessor(
  deps: ProcessorDeps,
  sessionMessages: Message[],
  onDone: () => void,
): ProcessMessageFn {
  const { agent, allTools, router, system1, learner, modeManager } = deps;
  const sessionId = `sess_${Date.now().toString(36)}`;

  return async function processMessage(input: string): Promise<void> {
    const startTime = Date.now();

    try {
      // ── Step 1: Route ─────────────────────────────────────
      const decision = router.route(input);

      // Show routing explanation
      if (decision.path === "system2" && decision.skillMatch) {
        // Skill found but gated — show why
        console.log(chalk.dim(`  ○ ${decision.reason}`));
      } else if (decision.path === "system2" && decision.riskFactors.length > 0) {
        console.log(chalk.yellow(`  ⚠ ${decision.reason}: ${decision.riskFactors.join(", ")}`));
      }

      // Check for mode activation
      const mode = modeManager.detect(input);
      let modeContext = "";
      if (mode) {
        console.log(chalk.magenta(`  ◈ Mode: ${mode.name}`));
        modeContext = `\n\n## Active Mode: ${mode.name}\n${mode.content}`;
      }

      let response: string;
      let budget: BudgetState;
      let allMessages: Message[];
      let artifacts: ArtifactRecord[] = [];
      let hitIterationLimit = false;

      if (decision.path === "system1" && decision.skillMatch) {
        // ── System 1: Fast Path ───────────────────────────
        const skill = decision.skillMatch.skill;
        const estCost = decision.estimatedCostUsd != null
          ? chalk.dim(` ~$${decision.estimatedCostUsd.toFixed(4)}`)
          : "";
        console.log(
          chalk.blue(`  ⚡ System 1: "${skill.name}"`) +
          chalk.dim(` (${(decision.skillMatch.confidence * 100).toFixed(0)}% via ${decision.skillMatch.matchMethod}${estCost})`),
        );

        const result = await system1.execute(input, decision.skillMatch, allTools);
        response = result.response;
        budget = {
          limitUsd: BUDGET_USD,
          spentUsd: result.costUsd,
          tokensIn: 0,
          tokensOut: 0,
          llmCalls: 1,
          toolCalls: result.toolsUsed.length,
        };
        allMessages = [
          { role: "user", content: input },
          { role: "assistant", content: response },
        ];
      } else {
        // ── System 2: Full Reasoning ──────────────────────
        if (decision.path === "system1" && !decision.skillMatch) {
          // Shouldn't happen, but fallback gracefully
          console.log(chalk.dim("  Falling back to System 2 (no skill match)"));
        }

        let result = await agent.run(input + modeContext, sessionMessages);

        // ── Redirect loop ─────────────────────────────────
        let redirectHops = 0;
        while (result.redirect && redirectHops < 3) {
          redirectHops++;
          console.log(chalk.dim(`  ↩ Redirect ${redirectHops}: ${result.redirect.slice(0, 80)}…`));
          result = await agent.run(result.redirect, result.messages.filter((m) => m.role !== "system"));
        }

        hitIterationLimit = result.hitIterationLimit ?? false;
        if (hitIterationLimit) {
          console.log(chalk.yellow(`\n  ⚠ Iteration limit — partial work summary follows.\n`));
        }

        response = result.response;
        budget = result.budget;
        allMessages = result.messages;
        artifacts = result.artifacts;

        // Artifact summary
        if (artifacts.length > 0) {
          const byType = artifacts.reduce<Record<string, number>>((acc, a) => {
            acc[a.type] = (acc[a.type] ?? 0) + 1;
            return acc;
          }, {});
          const parts = Object.entries(byType).map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`);
          console.log(chalk.dim(`  📦 ${parts.join(", ")}`));
        }
      }

      const durationMs = Date.now() - startTime;

      // ── Display response ──────────────────────────────────
      console.log("");
      console.log(chalk.white(`  ${response.replace(/\n/g, "\n  ")}`));
      console.log("");

      const pathLabel = decision.path === "system1" ? chalk.blue("S1") : chalk.dim("S2");
      console.log(
        chalk.dim(
          `  ─ ${pathLabel} · ${budget.llmCalls} calls · ${budget.toolCalls} tools · ` +
          `$${budget.spentUsd.toFixed(4)} · ${durationMs}ms`,
        ),
      );
      console.log("");

      // Update session history
      sessionMessages.push(...allMessages.filter((m) => m.role !== "system"));

      // ── Step 2: Learn (background, non-blocking) ──────────
      const trajectory: Trajectory = {
        task: input,
        messages: allMessages,
        // Do NOT hard-code "success" — let classifyOutcome determine the outcome
        outcome: "unknown",
        outcomeReason: "",
        outcomeConfidence: 0,
        budget,
        durationMs,
        routingPath: decision.path,
        skillUsed: decision.skillMatch?.skill.id,
        artifacts,
        hitIterationLimit,
        sessionId,
        timestamp: Date.now(),
      };

      learner.learn(trajectory).then((learnResult) => {
        if (learnResult.evolvedSkill) {
          const icon = learnResult.skillPromoted ? "✦" : "◆";
          const status = learnResult.skillPromoted ? "trusted" : "draft (pending review)";
          console.log(chalk.magenta(
            `  ${icon} Skill learned: "${learnResult.evolvedSkill.name}" [${status}]`,
          ));
        }
        if (learnResult.skillRetired) {
          console.log(chalk.yellow(`  ⚠ Skill retired: ${learnResult.skillRetired}`));
        }
        // Outcome classification feedback (only if different from assumed success)
        if (learnResult.outcome === "failure") {
          console.log(chalk.red(`  ○ Outcome classified as failure: ${learnResult.outcomeConfidence > 0.8 ? "(high confidence)" : ""}`));
        } else if (learnResult.outcome === "partial") {
          console.log(chalk.yellow(`  ○ Outcome classified as partial`));
        }
      }).catch(() => {});
    } catch (error) {
      console.log(chalk.red(`\n  Error: ${error instanceof Error ? error.message : String(error)}\n`));
    } finally {
      onDone();
    }
  };
}
