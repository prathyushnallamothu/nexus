/**
 * Nexus CLI — Banner & startup display
 */

import chalk from "chalk";
import type { SkillStore, DualProcessRouter, ModeManager } from "@nexus/intelligence";
import { DEFAULT_MODEL, BUDGET_USD } from "./config.js";

export function printBanner(
  skillStore: SkillStore,
  router: DualProcessRouter,
  modeManager: ModeManager,
): void {
  const skills = skillStore.getAll();
  const modes = modeManager.getAll();
  const stats = router.getStats();

  console.log("");
  console.log(chalk.cyan("  ══════════════════════════════════════════════════════════"));
  console.log(chalk.cyan("  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗"));
  console.log(chalk.cyan("  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝"));
  console.log(chalk.cyan("  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗"));
  console.log(chalk.cyan("  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║"));
  console.log(chalk.cyan("  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║"));
  console.log(chalk.cyan("  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝"));
  console.log(chalk.cyan("  ══════════════════════════════════════════════════════════"));
  console.log("");
  console.log(chalk.dim(`  Model:  ${DEFAULT_MODEL}`));
  console.log(chalk.dim(`  Budget: $${BUDGET_USD.toFixed(2)} per session`));
  console.log(chalk.dim(`  Dir:    ${process.cwd()}`));
  console.log(chalk.dim(`  Skills: ${skills.length} learned · Modes: ${modes.length} loaded`));
  if (stats.total > 0) {
    console.log(
      chalk.dim(`  Routing: ${stats.system1} fast / ${stats.system2} full (${stats.total} total)`),
    );
  }
  console.log("");
  console.log(chalk.dim("  Type your message. Alt+Enter for newline. /help for commands."));
  console.log("");
}
