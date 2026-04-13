/**
 * Nexus — Skills Marketplace I/O
 *
 * Implements:
 *   1. SKILL.md parser  — parse YAML frontmatter + Markdown body → Nexus Skill
 *   2. SKILL.md emitter — export Nexus Skill → SKILL.md format
 *   3. GitHubSkillInstaller — fetch SKILL.md from any GitHub repo
 *   4. SkillsDirScanner   — scan local .claude/skills/ or .agents/skills/ directories
 *   5. SkillsShClient     — search the skills.sh / agentskills.io registry
 *
 * SKILL.md format (ANTHROPIC open standard, Dec 2025):
 * ---
 * name: skill-name           # required, max 64 chars, lowercase slug
 * description: What it does. # required, max 1024 chars
 * license: Apache-2.0        # optional
 * compatibility: ...         # optional
 * metadata:                  # optional key-value block
 *   author: example-org
 *   version: "1.0"
 * allowed-tools: Bash Read   # optional, space-separated
 * ---
 * # Body — pure Markdown step-by-step instructions
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { Skill, SkillMatch } from "./skills.js";

// ── Types ──────────────────────────────────────────────────

export interface SkillMdFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  "allowed-tools"?: string;
}

export interface ParsedSkillMd {
  frontmatter: SkillMdFrontmatter;
  body: string;
  /** Raw YAML text before parsing */
  rawYaml: string;
  /** Source path or URL */
  source?: string;
}

export interface InstallResult {
  skill: Omit<Skill, "id" | "version" | "status" | "changelog" | "confidence" | "createdAt" | "updatedAt">;
  source: string;
  parsed: ParsedSkillMd;
}

export interface RegistrySkill {
  name: string;
  description: string;
  repo: string;       // e.g. "org/repo"
  url: string;        // GitHub URL
  stars?: number;
  tags?: string[];
  installCount?: number;
}

// ── Minimal YAML Frontmatter Parser ───────────────────────

/**
 * Parse SKILL.md content into frontmatter + body.
 * Handles the subset of YAML used in SKILL.md files:
 *   - Top-level string scalars (key: value)
 *   - One level of nested mapping (metadata:)
 *   - Quoted and unquoted values
 */
export function parseSkillMd(content: string, source?: string): ParsedSkillMd {
  // Extract frontmatter block
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat whole content as body, derive name from source
    const name = source ? basename(source, ".md").replace(/[-_]/g, " ") : "imported-skill";
    return {
      frontmatter: { name, description: content.slice(0, 120).replace(/\n/g, " ").trim() },
      body: content,
      rawYaml: "",
      source,
    };
  }

  const rawYaml = fmMatch[1]!;
  const body = (fmMatch[2] ?? "").trim();

  const fm = parseSimpleYaml(rawYaml);

  return {
    frontmatter: {
      name: String(fm.name ?? (source ? basename(source, ".md") : "unnamed")),
      description: String(fm.description ?? ""),
      license: fm.license ? String(fm.license) : undefined,
      compatibility: fm.compatibility ? String(fm.compatibility) : undefined,
      metadata: fm.metadata && typeof fm.metadata === "object" ? fm.metadata as Record<string, string> : undefined,
      "allowed-tools": fm["allowed-tools"] ? String(fm["allowed-tools"]) : undefined,
    },
    body,
    rawYaml,
    source,
  };
}

/**
 * Parse a simple YAML document into a plain object.
 * Supports:
 *   - key: value (string scalars, quoted or unquoted)
 *   - Nested block mappings (metadata:)
 *   - Multiline values (>- / | styles treated as single string)
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    // Skip comments and blank lines at top level
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }

    // Top-level key
    const topMatch = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)?$/);
    if (!topMatch) { i++; continue; }

    const key = topMatch[1]!;
    const rest = (topMatch[2] ?? "").trim();

    // Empty value — may be start of nested block
    if (!rest) {
      // Peek ahead for indented lines
      const nested: Record<string, string> = {};
      i++;
      while (i < lines.length) {
        const nestedLine = lines[i]!;
        if (!nestedLine.trim() || nestedLine.trim().startsWith("#")) { i++; continue; }
        // Check indent
        if (!/^\s+/.test(nestedLine)) break;
        const nestedMatch = nestedLine.match(/^\s+([a-zA-Z][\w-]*)\s*:\s*(.*)?$/);
        if (nestedMatch) {
          nested[nestedMatch[1]!] = stripYamlQuotes((nestedMatch[2] ?? "").trim());
        }
        i++;
      }
      result[key] = Object.keys(nested).length > 0 ? nested : undefined;
      continue;
    }

    // Inline value
    result[key] = stripYamlQuotes(rest);
    i++;
  }

  return result;
}

function stripYamlQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ── SKILL.md → Nexus Skill converter ─────────────────────

/**
 * Convert a parsed SKILL.md into a Nexus Skill (minus auto-generated fields).
 * - allowed-tools → tags + triggers
 * - metadata → additional tags
 * - body → procedure
 * - name → triggers (slug-based)
 */
export function skillMdToNexus(
  parsed: ParsedSkillMd,
  opts?: { importedFrom?: string; projectId?: string },
): InstallResult["skill"] {
  const { frontmatter: fm, body } = parsed;

  // Extract tags from metadata + compatibility
  const tags: string[] = [];
  if (fm.metadata?.author) tags.push(`author:${fm.metadata.author}`);
  if (fm.metadata?.version) tags.push(`version:${fm.metadata.version}`);
  if (fm.license) tags.push(`license:${fm.license}`);
  if (fm.compatibility) tags.push("compatibility:" + fm.compatibility.replace(/\s+/g, "-").toLowerCase());

  // Extract allowed-tools as tags
  const allowedTools = fm["allowed-tools"]
    ? fm["allowed-tools"].split(/\s+/).filter(Boolean).map((t) => `tool:${t}`)
    : [];
  tags.push(...allowedTools);

  // Infer category from name/description
  const category = inferCategory(fm.name, fm.description, body);

  // Build triggers from name slug words + explicit keywords in body
  const nameTriggers = fm.name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const triggers = Array.from(new Set([fm.name.toLowerCase(), ...nameTriggers]));

  return {
    name: fm.name,
    description: fm.description,
    procedure: body || `Follow the steps described in ${fm.name}.`,
    category,
    tags,
    triggers,
    scope: opts?.projectId ? "project" : "global",
    projectId: opts?.projectId,
    provenance: {
      createdBy: "import",
      sourceTrajectoryIds: [],
      importedFrom: opts?.importedFrom ?? parsed.source,
    },
  };
}

function inferCategory(name: string, description: string, body: string): string {
  const text = `${name} ${description} ${body}`.toLowerCase();

  const categoryMap: Array<[string, string[]]> = [
    ["coding",    ["code", "program", "script", "function", "debug", "test", "compile", "typescript", "python", "javascript", "rust", "go"]],
    ["git",       ["git", "commit", "branch", "merge", "pull request", "pr", "diff", "push", "clone"]],
    ["data",      ["data", "csv", "json", "database", "sql", "query", "table", "schema"]],
    ["devops",    ["docker", "kubernetes", "deploy", "ci/cd", "pipeline", "terraform", "helm", "k8s"]],
    ["writing",   ["write", "draft", "document", "report", "readme", "blog", "email", "summarize"]],
    ["research",  ["research", "search", "find", "analyze", "investigate", "explore"]],
    ["security",  ["security", "auth", "permission", "vulnerability", "scan", "audit"]],
    ["files",     ["file", "directory", "folder", "rename", "move", "copy", "delete", "read", "write"]],
    ["web",       ["http", "api", "rest", "graphql", "curl", "request", "endpoint", "url", "web"]],
    ["testing",   ["test", "spec", "jest", "vitest", "coverage", "assertion"]],
  ];

  for (const [cat, keywords] of categoryMap) {
    if (keywords.some((k) => text.includes(k))) return cat;
  }
  return "general";
}

// ── Nexus Skill → SKILL.md emitter ───────────────────────

/**
 * Convert a Nexus Skill back to SKILL.md format.
 * Enables interoperability with other SKILL.md consumers.
 */
export function nexusToSkillMd(skill: Skill): string {
  const lines: string[] = ["---"];

  // Sanitize name to lowercase slug
  const slugName = skill.name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 64);
  lines.push(`name: ${slugName}`);
  lines.push(`description: ${skill.description.slice(0, 1024).replace(/\n/g, " ")}`);

  // Extract license from tags
  const licenseTag = skill.tags.find((t) => t.startsWith("license:"));
  if (licenseTag) lines.push(`license: ${licenseTag.replace("license:", "")}`);

  // Extract compatibility from tags
  const compatTag = skill.tags.find((t) => t.startsWith("compatibility:"));
  if (compatTag) lines.push(`compatibility: ${compatTag.replace("compatibility:", "").replace(/-/g, " ")}`);

  // Extract allowed-tools from tags
  const toolTags = skill.tags.filter((t) => t.startsWith("tool:")).map((t) => t.replace("tool:", ""));
  if (toolTags.length > 0) lines.push(`allowed-tools: ${toolTags.join(" ")}`);

  // metadata block
  const authorTag = skill.tags.find((t) => t.startsWith("author:"));
  const versionTag = skill.tags.find((t) => t.startsWith("version:"));
  const metadataEntries: string[] = [];
  if (authorTag) metadataEntries.push(`  author: ${authorTag.replace("author:", "")}`);
  if (versionTag) metadataEntries.push(`  version: "${versionTag.replace("version:", "")}"`);
  metadataEntries.push(`  category: ${skill.category}`);
  metadataEntries.push(`  scope: ${skill.scope}`);
  metadataEntries.push(`  nexus-status: ${skill.status}`);
  metadataEntries.push(`  nexus-confidence: "${(skill.confidence.point * 100).toFixed(0)}%"`);
  lines.push("metadata:");
  lines.push(...metadataEntries);

  lines.push("---");
  lines.push("");
  lines.push(`# ${skill.name}`);
  lines.push("");
  lines.push(skill.procedure);
  lines.push("");

  return lines.join("\n");
}

// ── GitHub Skill Installer ────────────────────────────────

const SKILL_MD_PATHS = [
  "SKILL.md",
  ".agents/skills/SKILL.md",
  ".claude/skills/SKILL.md",
  "skills/SKILL.md",
];

const GITHUB_RAW = "https://raw.githubusercontent.com";
const GITHUB_API = "https://api.github.com";

export class GitHubSkillInstaller {
  private timeout: number;

  constructor(opts?: { timeout?: number }) {
    this.timeout = opts?.timeout ?? 15_000;
  }

  /**
   * Install a skill from a GitHub repo reference.
   * @param ref - "org/repo" or "org/repo@branch" or full GitHub URL
   */
  async fetchFromGitHub(ref: string): Promise<InstallResult[]> {
    const { org, repo, branch } = this.parseRef(ref);

    // Try each candidate path
    const candidates = SKILL_MD_PATHS;
    const results: InstallResult[] = [];
    const errors: string[] = [];

    for (const path of candidates) {
      for (const br of branch ? [branch] : ["main", "master"]) {
        const url = `${GITHUB_RAW}/${org}/${repo}/${br}/${path}`;
        try {
          const content = await this.fetchText(url);
          if (content) {
            const parsed = parseSkillMd(content, url);
            const skill = skillMdToNexus(parsed, {
              importedFrom: `github:${org}/${repo}`,
            });
            results.push({ skill, source: url, parsed });
            break; // Got one for this path
          }
        } catch (err: any) {
          errors.push(`${url}: ${err.message}`);
        }
      }
      if (results.length > 0) break; // Found at least one SKILL.md
    }

    // If no direct SKILL.md found, try listing .agents/skills/ via API
    if (results.length === 0) {
      const apiResults = await this.listSkillsViaApi(org, repo, branch ?? "main");
      results.push(...apiResults);
    }

    if (results.length === 0) {
      throw new Error(
        `No SKILL.md found in ${org}/${repo}. Tried: ${candidates.join(", ")}.\nErrors: ${errors.slice(0, 3).join("; ")}`,
      );
    }

    return results;
  }

  /**
   * Discover multiple SKILL.md files in a repo's skills directory.
   * Recursively searches subdirectories for SKILL.md files.
   */
  private async listSkillsViaApi(org: string, repo: string, branch: string): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    for (const dir of [".agents/skills", ".claude/skills", "skills"]) {
      try {
        await this.recursiveListFiles(org, repo, dir, branch, results);
        if (results.length > 0) break;
      } catch { /* try next dir */ }
    }

    return results;
  }

  /**
   * Recursively list files in a GitHub directory, finding all SKILL.md files.
   */
  private async recursiveListFiles(
    org: string,
    repo: string,
    path: string,
    branch: string,
    results: InstallResult[],
  ): Promise<void> {
    try {
      const apiUrl = `${GITHUB_API}/repos/${org}/${repo}/contents/${path}?ref=${branch}`;
      const resp = await fetch(apiUrl, {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "nexus-agent/1.0",
          ...(process.env.GITHUB_TOKEN ? { "Authorization": `token ${process.env.GITHUB_TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!resp.ok) return;
      const items = await resp.json() as Array<{ name: string; type: string; path: string; download_url?: string }>;

      for (const item of items) {
        if (item.type === "file" && item.name.endsWith(".md")) {
          if (item.download_url) {
            try {
              const content = await this.fetchText(item.download_url);
              if (content) {
                const parsed = parseSkillMd(content, item.download_url);
                const skill = skillMdToNexus(parsed, {
                  importedFrom: `github:${org}/${repo}`,
                });
                results.push({ skill, source: item.download_url, parsed });
              }
            } catch { /* skip */ }
          }
        } else if (item.type === "dir") {
          // Recursively search subdirectories
          await this.recursiveListFiles(org, repo, item.path, branch, results);
        }
      }
    } catch { /* skip errors */ }
  }

  private async fetchText(url: string): Promise<string | null> {
    const resp = await fetch(url, {
      headers: { "User-Agent": "nexus-agent/1.0" },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.trim() || null;
  }

  private parseRef(ref: string): { org: string; repo: string; branch?: string } {
    // Handle full GitHub URLs
    if (ref.startsWith("https://github.com/")) {
      ref = ref.replace("https://github.com/", "");
    }

    // Handle org/repo@branch
    const atIdx = ref.indexOf("@");
    let branch: string | undefined;
    if (atIdx !== -1) {
      branch = ref.slice(atIdx + 1);
      ref = ref.slice(0, atIdx);
    }

    const parts = ref.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid GitHub ref: "${ref}". Expected "org/repo" or "org/repo@branch"`);

    return { org: parts[0]!, repo: parts[1]!, branch };
  }
}

// ── Local Directory Scanner ───────────────────────────────

const LOCAL_SKILL_DIRS = [
  ".claude/skills",
  ".agents/skills",
  "~/.claude/skills",
  "~/.config/agents/skills",
];

export class SkillsDirScanner {
  /**
   * Scan known local skill directories for SKILL.md files.
   * Returns all valid parsed skills found.
   */
  scan(baseDir = process.cwd()): InstallResult[] {
    const results: InstallResult[] = [];

    for (const relDir of LOCAL_SKILL_DIRS) {
      const dir = relDir.startsWith("~")
        ? join(process.env.HOME ?? "/tmp", relDir.slice(2))
        : join(baseDir, relDir);

      if (!existsSync(dir)) continue;

      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (!entry.endsWith(".md")) continue;
          const filePath = join(dir, entry);
          try {
            const content = readFileSync(filePath, "utf-8");
            const parsed = parseSkillMd(content, filePath);
            const skill = skillMdToNexus(parsed, { importedFrom: `file:${filePath}` });
            results.push({ skill, source: filePath, parsed });
          } catch { /* skip bad files */ }
        }
      } catch { /* dir not readable */ }
    }

    return results;
  }

  /**
   * Export a Nexus Skill to a local SKILL.md file in the project skill dir.
   */
  exportSkill(skill: Skill, outputDir = ".agents/skills"): string {
    mkdirSync(outputDir, { recursive: true });
    const fileName = skill.id + ".md";
    const filePath = join(outputDir, fileName);
    writeFileSync(filePath, nexusToSkillMd(skill), "utf-8");
    return filePath;
  }
}

// ── skills.sh Registry Client ─────────────────────────────

/**
 * Client for the skills.sh registry (Vercel Labs skill discovery directory).
 *
 * skills.sh is a directory that links to GitHub repos containing SKILL.md files.
 * It has 91,641+ skills ranked by install count.
 *
 * Since skills.sh doesn't publish a public API, we use two strategies:
 *   1. GitHub Search API — search for SKILL.md files matching the query
 *   2. GitHub Topics — search repos tagged with 'agent-skill' or 'skill-md'
 */
export class SkillsShClient {
  private githubToken?: string;
  private timeout: number;

  constructor(opts?: { githubToken?: string; timeout?: number }) {
    this.githubToken = opts?.githubToken ?? process.env.GITHUB_TOKEN;
    this.timeout = opts?.timeout ?? 20_000;
  }

  /**
   * Search for skills matching a query.
   * Uses GitHub Code Search to find SKILL.md files.
   */
  async search(query: string, limit = 10): Promise<RegistrySkill[]> {
    // Strategy 1: GitHub Code Search for SKILL.md with matching content
    const ghResults = await this.searchGitHub(query, limit);
    if (ghResults.length > 0) return ghResults;

    // Strategy 2: Topic-based repo search
    return this.searchByTopic(query, limit);
  }

  /**
   * Get top skills from the skills.sh registry.
   * Returns curated popular skills by topic/category.
   */
  async browse(category?: string, limit = 20): Promise<RegistrySkill[]> {
    const topic = category ? `skill-${category}` : "agent-skill";
    return this.searchReposByTopic(topic, limit);
  }

  private async searchGitHub(query: string, limit: number): Promise<RegistrySkill[]> {
    try {
      // Search for SKILL.md files containing the query
      const searchQuery = encodeURIComponent(`${query} filename:SKILL.md`);
      const url = `${GITHUB_API}/search/code?q=${searchQuery}&per_page=${Math.min(limit, 30)}`;
      const resp = await this.apiGet(url);
      if (!resp.ok) return [];

      const data = await resp.json() as {
        items?: Array<{
          name: string;
          path: string;
          repository: { full_name: string; html_url: string; stargazers_count?: number; description?: string };
        }>;
      };

      return (data.items ?? []).map((item) => ({
        name: item.repository.full_name.split("/")[1] ?? item.repository.full_name,
        description: item.repository.description ?? `Skill from ${item.repository.full_name}`,
        repo: item.repository.full_name,
        url: item.repository.html_url,
        stars: item.repository.stargazers_count,
        tags: [],
      }));
    } catch {
      return [];
    }
  }

  private async searchByTopic(query: string, limit: number): Promise<RegistrySkill[]> {
    const topic = query.toLowerCase().replace(/\s+/g, "-");
    return this.searchReposByTopic(`skill-${topic}`, limit);
  }

  private async searchReposByTopic(topic: string, limit: number): Promise<RegistrySkill[]> {
    try {
      const url = `${GITHUB_API}/search/repositories?q=topic:${encodeURIComponent(topic)}+in:topics&sort=stars&per_page=${Math.min(limit, 30)}`;
      const resp = await this.apiGet(url);
      if (!resp.ok) {
        // Fallback: search for agent-skill in description
        return this.searchReposByKeyword(topic.replace("skill-", ""), limit);
      }

      const data = await resp.json() as {
        items?: Array<{
          full_name: string; html_url: string; description?: string;
          stargazers_count: number; topics?: string[];
        }>;
      };

      return (data.items ?? []).map((r) => ({
        name: r.full_name.split("/")[1] ?? r.full_name,
        description: r.description ?? "No description",
        repo: r.full_name,
        url: r.html_url,
        stars: r.stargazers_count,
        tags: r.topics ?? [],
      }));
    } catch {
      return [];
    }
  }

  private async searchReposByKeyword(keyword: string, limit: number): Promise<RegistrySkill[]> {
    try {
      const q = encodeURIComponent(`${keyword} agent skill SKILL.md in:readme`);
      const url = `${GITHUB_API}/search/repositories?q=${q}&sort=stars&per_page=${Math.min(limit, 30)}`;
      const resp = await this.apiGet(url);
      if (!resp.ok) return [];

      const data = await resp.json() as {
        items?: Array<{
          full_name: string; html_url: string; description?: string;
          stargazers_count: number; topics?: string[];
        }>;
      };

      return (data.items ?? []).map((r) => ({
        name: r.full_name.split("/")[1] ?? r.full_name,
        description: r.description ?? "No description",
        repo: r.full_name,
        url: r.html_url,
        stars: r.stargazers_count,
        tags: r.topics ?? [],
      }));
    } catch {
      return [];
    }
  }

  private apiGet(url: string): Promise<Response> {
    return fetch(url, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "nexus-agent/1.0",
        ...(this.githubToken ? { "Authorization": `token ${this.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(this.timeout),
    });
  }
}

// ── Convenience: install from file path ──────────────────

/**
 * Parse and convert a local SKILL.md file to a Nexus skill.
 */
export function installFromFile(filePath: string): InstallResult {
  const content = readFileSync(filePath, "utf-8");
  const parsed = parseSkillMd(content, filePath);
  const skill = skillMdToNexus(parsed, { importedFrom: `file:${filePath}` });
  return { skill, source: filePath, parsed };
}
