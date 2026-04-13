#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const git = spawnSync(
  "git",
  [
    "ls-files",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.json",
    "*.md",
    "*.yml",
    "*.yaml",
  ],
  { cwd: root, encoding: "utf-8" },
);

if (git.status !== 0) {
  console.error(git.stderr || "Failed to list tracked files with git.");
  process.exit(1);
}

const checkedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".json",
  ".md",
  ".yml",
  ".yaml",
]);

const files = git.stdout
  .split("\n")
  .filter(Boolean)
  .filter((file) => {
    const dot = file.lastIndexOf(".");
    return dot !== -1 && checkedExtensions.has(file.slice(dot));
  });

const issues: string[] = [];

for (const file of files) {
  const abs = resolve(root, file);
  const content = readFileSync(abs, "utf-8");
  if (content.length > 0 && !content.endsWith("\n")) {
    issues.push(`${relative(root, abs)}: missing final newline`);
  }

  const lines = content.split("\n");
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      issues.push(`${relative(root, abs)}:${index + 1}: trailing whitespace`);
    }
  });
}

if (issues.length > 0) {
  console.error("Formatting check failed:");
  for (const issue of issues.slice(0, 50)) {
    console.error(`  ${issue}`);
  }
  if (issues.length > 50) {
    console.error(`  ... and ${issues.length - 50} more`);
  }
  process.exit(1);
}

console.log(`Formatting check passed (${files.length} files).`);
