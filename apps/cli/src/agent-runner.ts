/**
 * Nexus CLI — Agent message processor
 */

import chalk from "chalk";
import type { Message, BudgetState, Tool } from "@nexus/core";
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

/**
 * Creates a processMessage function that processes a user input through the
 * intelligence routing layer and returns the response.
 *
 * @param deps          Agent and intelligence layer dependencies
 * @param sessionMessages Mutable message array (updated in-place)
 * @param onDone        Called when processing completes (used to prompt or drain queue)
 */
export function createProcessor(
  deps: ProcessorDeps,
  sessionMessages: Message[],
  onDone: () => void,
): ProcessMessageFn {
  const { agent, allTools, router, system1, learner, modeManager } = deps;

  return async function processMessage(input: string): Promise<void> {
    const startTime = Date.now();

    try {
      // ── Step 1: Route (System 1 vs System 2) ──────────
      const decision = router.route(input);

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

      if (decision.path === "system1" && decision.skillMatch) {
        // ── System 1: Fast Path ───────────────────────────
        console.log(
          chalk.blue(
            `  ⚡ System 1: Using skill "${decision.skillMatch.skill.name}" ` +
              `(${(decision.skillMatch.confidence * 100).toFixed(0)}% match)`,
          ),
        );

        const result = await system1.execute(input, decision.skillMatch, allTools);
        response = result.response;
        budget = {
          limitUsd: BUDGET_USD,
          spentUsd: result.costUsd,
          tokensIn: 0,
          tokensOut: 0,
          llmCalls: 1,
          toolCalls: 0,
        };
        allMessages = [
          { role: "user", content: input },
          { role: "assistant", content: response },
        ];
      } else {
        // ── System 2: Full Reasoning ──────────────────────
        if (decision.skillMatch) {
          console.log(
            chalk.dim(`  ○ Skill hint: "${decision.skillMatch.skill.name}" (building track record)`),
          );
        }

        const result = await agent.run(input + modeContext, sessionMessages);
        response = result.response;
        budget = result.budget;
        allMessages = result.messages;
      }

      const durationMs = Date.now() - startTime;

      // ── Display response ──────────────────────────────
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

      // ── Step 2: Learn (background) ────────────────────
      const trajectory: Trajectory = {
        task: input,
        messages: allMessages,
        outcome: "success",
        budget,
        durationMs,
        routingPath: decision.path,
        skillUsed: decision.skillMatch?.skill.id,
        timestamp: Date.now(),
      };

      learner.learn(trajectory).then((result) => {
        if (result.evolvedSkill) {
          console.log(chalk.magenta(`  ◆ Learned new skill: "${result.evolvedSkill.name}"`));
        }
      }).catch(() => {});
    } catch (error) {
      console.log(
        chalk.red(`\n  Error: ${error instanceof Error ? error.message : String(error)}\n`),
      );
    } finally {
      onDone();
    }
  };
}
