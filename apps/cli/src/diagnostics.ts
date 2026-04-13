/**
 * Nexus CLI diagnostics, setup, and crash logging.
 */

import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BUDGET_USD, DEFAULT_MODEL, NEXUS_HOME } from "./config.js";

export type DiagnosticLevel = "pass" | "warn" | "fail" | "info";

export interface DiagnosticCheck {
  level: DiagnosticLevel;
  name: string;
  message: string;
  remediation?: string;
}

const REQUIRED_HOME_DIRS = ["skills", "audit", "sessions", "cron", "logs"];

function providerForModel(model: string): string {
  const idx = model.indexOf(":");
  if (idx !== -1) return model.slice(0, idx);
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  if (model.startsWith("gemini")) return "google";
  if (model.startsWith("llama") || model.startsWith("mistral") || model.startsWith("qwen")) return "ollama";
  return "openai";
}

function envKeyForProvider(provider: string): string | null {
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  return envMap[provider] ?? null;
}

function commandAvailable(command: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 3000 });
  return result.status === 0;
}

export function validateConfig(): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const provider = providerForModel(DEFAULT_MODEL);
  const requiredKey = envKeyForProvider(provider);

  if (!DEFAULT_MODEL.includes(":")) {
    checks.push({
      level: "warn",
      name: "Model format",
      message: `NEXUS_MODEL is "${DEFAULT_MODEL}". Provider prefix was inferred as "${provider}".`,
      remediation: "Use an explicit provider prefix, for example anthropic:claude-sonnet-4-20250514.",
    });
  } else {
    checks.push({
      level: "pass",
      name: "Model format",
      message: `Using ${DEFAULT_MODEL}.`,
    });
  }

  if (!Number.isFinite(BUDGET_USD) || BUDGET_USD <= 0) {
    checks.push({
      level: "fail",
      name: "Budget",
      message: `NEXUS_BUDGET must be a positive number. Current value resolves to "${String(BUDGET_USD)}".`,
      remediation: "Set NEXUS_BUDGET=2.0 or another positive decimal value.",
    });
  } else {
    checks.push({
      level: "pass",
      name: "Budget",
      message: `Session budget is $${BUDGET_USD.toFixed(2)}.`,
    });
  }

  if (requiredKey) {
    const value = process.env[requiredKey];
    checks.push({
      level: value ? "pass" : "fail",
      name: `${provider} credentials`,
      message: value ? `${requiredKey} is set.` : `${requiredKey} is missing.`,
      remediation: value ? undefined : `Add ${requiredKey}=... to .env or your shell environment.`,
    });
  } else {
    checks.push({
      level: "info",
      name: `${provider} credentials`,
      message: "No API key is required by Nexus for this provider.",
    });
  }

  const sandbox = process.env.NEXUS_SANDBOX ?? "local";
  if (!["local", "docker"].includes(sandbox)) {
    checks.push({
      level: "fail",
      name: "Sandbox mode",
      message: `Unsupported NEXUS_SANDBOX value "${sandbox}".`,
      remediation: "Use NEXUS_SANDBOX=local or NEXUS_SANDBOX=docker.",
    });
  } else {
    checks.push({
      level: "pass",
      name: "Sandbox mode",
      message: `Sandbox mode is ${sandbox}.`,
    });
  }

  if (sandbox === "docker") {
    const dockerOk = commandAvailable("docker", ["info"]);
    checks.push({
      level: dockerOk ? "pass" : "fail",
      name: "Docker",
      message: dockerOk ? "Docker is available." : "Docker is not available.",
      remediation: dockerOk ? undefined : "Start Docker or set NEXUS_SANDBOX=local.",
    });
  }

  if (!existsSync(NEXUS_HOME)) {
    checks.push({
      level: "fail",
      name: "Nexus home",
      message: `${NEXUS_HOME} does not exist.`,
      remediation: "Run nexus setup.",
    });
  } else {
    checks.push({
      level: "pass",
      name: "Nexus home",
      message: NEXUS_HOME,
    });
  }

  for (const dir of REQUIRED_HOME_DIRS) {
    const path = join(NEXUS_HOME, dir);
    checks.push({
      level: existsSync(path) ? "pass" : "warn",
      name: `Home directory: ${dir}`,
      message: existsSync(path) ? path : `${path} has not been created yet.`,
      remediation: existsSync(path) ? undefined : "Run nexus setup.",
    });
  }

  const bunAvailable = commandAvailable("bun");
  checks.push({
    level: bunAvailable ? "pass" : "fail",
    name: "Bun",
    message: bunAvailable ? "Bun is available." : "Bun is not available.",
    remediation: bunAvailable ? undefined : "Install Bun 1.0 or newer.",
  });

  return checks;
}

export function hasBlockingConfigIssue(checks = validateConfig()): boolean {
  return checks.some((check) => check.level === "fail");
}

export function printDoctorReport(checks = validateConfig()): void {
  const colors: Record<DiagnosticLevel, (text: string) => string> = {
    pass: chalk.green,
    warn: chalk.yellow,
    fail: chalk.red,
    info: chalk.dim,
  };

  console.log(chalk.cyan("\n  Nexus Doctor\n"));
  for (const check of checks) {
    const marker = check.level === "pass" ? "PASS" : check.level === "warn" ? "WARN" : check.level === "fail" ? "FAIL" : "INFO";
    console.log(`  ${colors[check.level](`[${marker}]`)} ${chalk.white(check.name)} - ${check.message}`);
    if (check.remediation) {
      console.log(`         ${chalk.dim(check.remediation)}`);
    }
  }

  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  console.log("");
  if (failures > 0) {
    console.log(chalk.red(`  ${failures} failure(s), ${warnings} warning(s). Fix failures before running production tasks.\n`));
  } else {
    console.log(chalk.green(`  Doctor passed with ${warnings} warning(s).\n`));
  }
}

export function runFirstRunSetup(): DiagnosticCheck[] {
  if (!existsSync(NEXUS_HOME)) {
    mkdirSync(NEXUS_HOME, { recursive: true });
  }

  for (const dir of REQUIRED_HOME_DIRS) {
    mkdirSync(join(NEXUS_HOME, dir), { recursive: true });
  }

  const envExample = resolve(process.cwd(), ".env.example");
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envExample) && !existsSync(envFile)) {
    const marker = [
      "# Nexus local configuration",
      "# Copy values from .env.example and fill in the provider key you use.",
      "",
    ].join("\n");
    writeFileSync(envFile, marker + readFileSync(envExample, "utf-8"), "utf-8");
  }

  writeStructuredLog("info", "setup.completed", {
    cwd: process.cwd(),
    nexusHome: NEXUS_HOME,
  });

  return validateConfig();
}

export function printSetupReport(): void {
  console.log(chalk.cyan("\n  Nexus Setup\n"));
  const checks = runFirstRunSetup();
  console.log(chalk.green(`  Created runtime directories under ${NEXUS_HOME}.`));
  if (existsSync(resolve(process.cwd(), ".env"))) {
    console.log(chalk.green("  Found .env."));
  }
  printDoctorReport(checks);
}

export function writeStructuredLog(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    mkdirSync(join(NEXUS_HOME, "logs"), { recursive: true });
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    appendFileSync(join(NEXUS_HOME, "logs", "nexus.jsonl"), JSON.stringify(payload) + "\n", "utf-8");
  } catch {
    // Logging must never crash Nexus.
  }
}

export function installCrashHandlers(): void {
  process.on("uncaughtException", (error) => {
    writeStructuredLog("error", "process.uncaughtException", {
      message: error.message,
      stack: error.stack,
    });
    console.error(chalk.red(`Fatal: ${error.message}`));
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    writeStructuredLog("error", "process.unhandledRejection", { message, stack });
    console.error(chalk.red(`Fatal: ${message}`));
    process.exit(1);
  });
}
