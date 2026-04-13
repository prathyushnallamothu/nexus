#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as {
  version?: string;
};
const versionFile = readFileSync(resolve(root, "VERSION"), "utf-8").trim();

if (!packageJson.version) {
  console.error("package.json is missing a version field.");
  process.exit(1);
}

if (packageJson.version !== versionFile) {
  console.error(`Version mismatch: package.json=${packageJson.version}, VERSION=${versionFile}`);
  process.exit(1);
}

console.log(`Version OK: ${versionFile}`);
