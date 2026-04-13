/**
 * Nexus CLI — Interactive Setup Wizard
 */

import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// @ts-ignore - prompts types not available, will be resolved by @types/prompts
import prompts from "prompts";

import { NEXUS_HOME } from "./config.js";

// ── Types ─────────────────────────────────────────────────────

export interface WizardConfig {
  apiKey?: string;
  provider: string;
  model: string;
  budget: number;
  platforms: string[];
  skills: string[];
  createEnv: boolean;
}

export interface ProviderInfo {
  name: string;
  id: string;
  envKey: string | null;
  models: string[];
  defaultModel: string;
}

// ── Provider Configuration ─────────────────────────────────────

const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: {
    name: "Anthropic (Claude)",
    id: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      "anthropic:claude-sonnet-4-20250514",
      "anthropic:claude-3-5-sonnet-20241022",
      "anthropic:claude-3-5-haiku-20241022",
      "anthropic:claude-3-opus-20240229",
    ],
    defaultModel: "anthropic:claude-sonnet-4-20250514",
  },
  openai: {
    name: "OpenAI",
    id: "openai",
    envKey: "OPENAI_API_KEY",
    models: [
      "openai:gpt-4o",
      "openai:gpt-4o-mini",
      "openai:gpt-4-turbo",
      "openai:gpt-3.5-turbo",
    ],
    defaultModel: "openai:gpt-4o",
  },
  google: {
    name: "Google Gemini",
    id: "google",
    envKey: "GOOGLE_API_KEY",
    models: [
      "google:gemini-2.5-flash",
      "google:gemini-2.5-pro",
      "google:gemini-2.0-flash",
      "google:gemini-2.0-pro",
    ],
    defaultModel: "google:gemini-2.5-flash",
  },
  openrouter: {
    name: "OpenRouter (200+ models)",
    id: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    models: [
      "openrouter:anthropic/claude-sonnet-4",
      "openrouter:openai/gpt-4o",
      "openrouter:google/gemini-2.5-flash",
    ],
    defaultModel: "openrouter:anthropic/claude-sonnet-4",
  },
  ollama: {
    name: "Ollama (local, free)",
    id: "ollama",
    envKey: null,
    models: [
      "ollama:llama3.3",
      "ollama:qwen2.5",
      "ollama:mistral",
    ],
    defaultModel: "ollama:llama3.3",
  },
};

const PLATFORMS = [
  { id: "telegram", name: "Telegram", description: "Chat via Telegram bot" },
  { id: "discord", name: "Discord", description: "Chat via Discord bot" },
  { id: "slack", name: "Slack", description: "Chat via Slack app" },
];

const RECOMMENDED_SKILLS = [
  { id: "git-workflow", name: "Git Workflow", description: "Standard Git operations and best practices" },
  { id: "code-review", name: "Code Review", description: "Structured code review with severity levels" },
  { id: "testing", name: "Testing", description: "Test generation and debugging strategies" },
  { id: "documentation", name: "Documentation", description: "Documentation generation and maintenance" },
];

// ── Wizard Functions ────────────────────────────────────────────

export async function runSetupWizard(): Promise<WizardConfig> {
  console.log(chalk.cyan("\n  ══════════════════════════════════════════════════════════"));
  console.log(chalk.cyan("  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗"));
  console.log(chalk.cyan("  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝"));
  console.log(chalk.cyan("  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗"));
  console.log(chalk.cyan("  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║"));
  console.log(chalk.cyan("  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║"));
  console.log(chalk.cyan("  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝"));
  console.log(chalk.cyan("  ══════════════════════════════════════════════════════════\n"));
  console.log(chalk.white("  Welcome to Nexus! This wizard will help you configure your AI agent.\n"));

  const config: WizardConfig = {
    provider: "anthropic",
    model: "anthropic:claude-sonnet-4-20250514",
    budget: 2.0,
    platforms: [],
    skills: [],
    createEnv: false,
  };

  // Step 1: Provider Selection
  console.log(chalk.yellow("  Step 1/5: Choose your AI provider\n"));
  const providerChoice = await prompts({
    type: "select",
    name: "provider",
    message: "Which AI provider do you want to use?",
    choices: Object.values(PROVIDERS).map((p) => ({
      title: p.name,
      value: p.id,
      description: p.envKey ? `Requires ${p.envKey}` : "No API key required (local)",
    })),
    initial: 0,
  });

  if (!providerChoice.provider) {
    console.log(chalk.red("\n  Setup cancelled."));
    process.exit(0);
  }

  config.provider = providerChoice.provider;
  const providerInfo = PROVIDERS[config.provider];

  // Step 2: API Key Configuration
  console.log(chalk.yellow("\n  Step 2/5: Configure API key\n"));
  
  if (providerInfo.envKey) {
    const existingKey = process.env[providerInfo.envKey];
    const hasExistingKey = !!existingKey;

    if (hasExistingKey) {
      console.log(chalk.green(`  ✓ Found existing ${providerInfo.envKey} in environment`));
      
      const useExisting = await prompts({
        type: "confirm",
        name: "useExisting",
        message: "Use existing API key?",
        initial: true,
      });

      if (!useExisting.useExisting) {
        const apiKey = await prompts({
          type: "password",
          name: "key",
          message: `Enter your ${providerInfo.envKey}:`,
          validate: (value: string) => value.length > 0 || "API key cannot be empty",
        });
        config.apiKey = apiKey.key;
        config.createEnv = true;
      }
    } else {
      console.log(chalk.dim(`  ${providerInfo.envKey} not found in environment`));
      
      const apiKey = await prompts({
        type: "password",
        name: "key",
        message: `Enter your ${providerInfo.envKey}:`,
        validate: (value: string) => value.length > 0 || "API key cannot be empty",
      });

      if (!apiKey.key) {
        console.log(chalk.red("\n  Setup cancelled."));
        process.exit(0);
      }

      config.apiKey = apiKey.key;
      config.createEnv = true;
    }
  } else {
    console.log(chalk.green(`  ✓ ${providerInfo.name} requires no API key (local)`));
  }

  // Step 3: Model Selection
  console.log(chalk.yellow("\n  Step 3/5: Choose your model\n"));
  const modelChoice = await prompts({
    type: "select",
    name: "model",
    message: "Which model do you want to use?",
    choices: providerInfo.models.map((m) => ({
      title: m,
      value: m,
    })),
    initial: 0,
  });

  if (!modelChoice.model) {
    console.log(chalk.red("\n  Setup cancelled."));
    process.exit(0);
  }

  config.model = modelChoice.model;

  // Step 4: Budget Configuration
  console.log(chalk.yellow("\n  Step 4/5: Set session budget\n"));
  const budgetChoice = await prompts({
    type: "number",
    name: "budget",
    message: "Maximum budget per session (USD):",
    initial: 2.0,
    min: 0.1,
    max: 100,
    float: true,
  });

  if (budgetChoice.budget === undefined) {
    console.log(chalk.red("\n  Setup cancelled."));
    process.exit(0);
  }

  config.budget = budgetChoice.budget;

  // Step 5: Optional Features
  console.log(chalk.yellow("\n  Step 5/5: Optional features\n"));
  
  // Platform setup (currently informational since gateway not implemented)
  const platformChoice = await prompts({
    type: "multiselect",
    name: "platforms",
    message: "Select messaging platforms (gateway required - coming soon):",
    choices: PLATFORMS.map((p) => ({
      title: p.name,
      value: p.id,
      description: p.description,
      disabled: true,
    })),
    instructions: "Gateway not yet implemented (see roadmap Phase 1)",
  });

  config.platforms = platformChoice.platforms || [];

  // Skill installation
  const skillChoice = await prompts({
    type: "multiselect",
    name: "skills",
    message: "Select recommended skills to install:",
    choices: RECOMMENDED_SKILLS.map((s) => ({
      title: s.name,
      value: s.id,
      description: s.description,
    })),
    instructions: "Space to select, Enter to confirm",
  });

  config.skills = skillChoice.skills || [];

  // Summary
  console.log(chalk.cyan("\n  ══════════════════════════════════════════════════════════"));
  console.log(chalk.cyan("  Configuration Summary\n"));
  console.log(chalk.white(`  Provider:    ${chalk.green(providerInfo.name)}`));
  console.log(chalk.white(`  Model:       ${chalk.green(config.model)}`));
  console.log(chalk.white(`  Budget:      ${chalk.green(`$${config.budget.toFixed(2)}`)}`));
  if (config.apiKey) {
    console.log(chalk.white(`  API Key:     ${chalk.green("••••••••••••" + config.apiKey.slice(-4))}`));
  }
  if (config.skills.length > 0) {
    console.log(chalk.white(`  Skills:      ${chalk.green(config.skills.join(", "))}`));
  }
  console.log(chalk.cyan("  ══════════════════════════════════════════════════════════\n"));

  const confirm = await prompts({
    type: "confirm",
    name: "confirm",
    message: "Save this configuration?",
    initial: true,
  });

  if (!confirm.confirm) {
    console.log(chalk.yellow("\n  Setup cancelled. No changes were made."));
    process.exit(0);
  }

  return config;
}

export async function applyWizardConfig(config: WizardConfig): Promise<void> {
  console.log(chalk.cyan("\n  Applying configuration...\n"));

  // Ensure Nexus home exists
  if (!existsSync(NEXUS_HOME)) {
    mkdirSync(NEXUS_HOME, { recursive: true });
    console.log(chalk.green(`  ✓ Created ${NEXUS_HOME}`));
  }

  // Create required directories
  const dirs = ["skills", "audit", "sessions", "cron", "logs", "wiki", "governance", "memory"];
  for (const dir of dirs) {
    const dirPath = join(NEXUS_HOME, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      console.log(chalk.green(`  ✓ Created ${dir}/`));
    }
  }

  // Write .env file if needed
  if (config.createEnv && config.apiKey) {
    const providerInfo = PROVIDERS[config.provider];
    const envPath = resolve(process.cwd(), ".env");
    
    let envContent = "";
    if (existsSync(envPath)) {
      envContent = readFileSync(envPath, "utf-8");
      // Update existing key if present
      const keyPattern = new RegExp(`^${providerInfo.envKey}=.*$`, "m");
      if (keyPattern.test(envContent)) {
        envContent = envContent.replace(keyPattern, `${providerInfo.envKey}=${config.apiKey}`);
        console.log(chalk.green(`  ✓ Updated ${providerInfo.envKey} in .env`));
      } else {
        envContent += `\n${providerInfo.envKey}=${config.apiKey}`;
        console.log(chalk.green(`  ✓ Added ${providerInfo.envKey} to .env`));
      }
    } else {
      envContent = `# Nexus Configuration\n${providerInfo.envKey}=${config.apiKey}`;
      console.log(chalk.green(`  ✓ Created .env with ${providerInfo.envKey}`));
    }

    writeFileSync(envPath, envContent, "utf-8");
  }

  // Write model and budget to .env
  const envPath = resolve(process.cwd(), ".env");
  let envContent = "";
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
  }

  // Update or add NEXUS_MODEL
  const modelPattern = /^NEXUS_MODEL=.*$/m;
  if (modelPattern.test(envContent)) {
    envContent = envContent.replace(modelPattern, `NEXUS_MODEL=${config.model}`);
  } else {
    envContent += `\nNEXUS_MODEL=${config.model}`;
  }
  console.log(chalk.green(`  ✓ Set NEXUS_MODEL=${config.model}`));

  // Update or add NEXUS_BUDGET
  const budgetPattern = /^NEXUS_BUDGET=.*$/m;
  if (budgetPattern.test(envContent)) {
    envContent = envContent.replace(budgetPattern, `NEXUS_BUDGET=${config.budget}`);
  } else {
    envContent += `\nNEXUS_BUDGET=${config.budget}`;
  }
  console.log(chalk.green(`  ✓ Set NEXUS_BUDGET=${config.budget}`));

  writeFileSync(envPath, envContent.trim() + "\n", "utf-8");

  // Install skills (placeholder - will be implemented when skill marketplace is ready)
  if (config.skills.length > 0) {
    console.log(chalk.yellow(`  ⚠ Skill installation not yet implemented (coming in Phase 1)`));
    console.log(chalk.dim(`     Selected skills: ${config.skills.join(", ")}`));
  }

  console.log(chalk.green("\n  ✓ Configuration saved successfully!\n"));
  console.log(chalk.white("  Next steps:"));
  console.log(chalk.white("    1. Run 'nexus' to start the agent"));
  console.log(chalk.white("    2. Run 'nexus doctor' to verify your setup"));
  console.log(chalk.white("    3. Run 'nexus setup' again to reconfigure\n"));
}
