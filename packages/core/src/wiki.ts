/**
 * Nexus Wiki — LLM-maintained persistent knowledge base
 *
 * Architecture (from llmwiki.md):
 *   Raw sources  — immutable session transcripts, ingested files (agent reads, never writes)
 *   Wiki         — LLM-generated markdown files in .nexus/wiki/ (agent owns entirely)
 *   Schema       — SCHEMA.md that tells the agent how to maintain the wiki
 *
 * Directory layout:
 *   .nexus/wiki/
 *     SCHEMA.md          ← Agent's constitution for maintaining this wiki
 *     index.md           ← Master catalog: every page + one-line summary
 *     log.md             ← Chronological append-only ingest/update log
 *     user/
 *       profile.md       ← User preferences, working style, goals
 *     projects/
 *       <name>/
 *         overview.md    ← Stack, architecture, key files, entry points
 *         decisions.md   ← Important decisions + rationale
 *         todos.md       ← Open items discovered during sessions
 *     skills/
 *       <id>.md          ← How to do X, learned from experience
 *     concepts/
 *       <slug>.md        ← Technical concepts, patterns, anti-patterns
 *     sessions/
 *       <date>-<slug>.md ← Session summaries (from raw transcripts)
 *     insights/
 *       patterns.md      ← Recurring patterns observed across sessions
 *       anti-patterns.md ← Things that reliably don't work
 *   .nexus/raw/
 *     sessions/          ← Immutable raw session transcripts (source of truth)
 *     ingested/          ← Immutable user-provided documents
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, statSync, appendFileSync,
} from "node:fs";
import { join, relative, dirname, basename } from "node:path";

// ── Types ─────────────────────────────────────────────────

export interface WikiPage {
  path: string;       // Relative to wikiDir, e.g. "projects/nexus/overview.md"
  title: string;      // First H1 heading
  summary: string;    // First paragraph or ≤120 chars
  updatedAt: number;  // epoch ms
  size: number;       // bytes
}

export interface LintIssue {
  severity: "error" | "warn" | "info";
  page: string;
  message: string;
}

export type MemoryType =
  | "user_preference"
  | "project_fact"
  | "project_decision"
  | "procedure"
  | "session_summary"
  | "todo"
  | "environment_fact"
  | "concept"
  | "observation";

export type MemorySourceType = "session" | "ingested" | "wiki" | "manual" | "tool";

export interface MemoryCitation {
  sourceType: MemorySourceType;
  /** Source path, usually under .nexus/raw or a wiki page path. */
  sourcePath: string;
  /** Optional session id or external source id. */
  sourceId?: string;
  /** Message index in the raw transcript when known. */
  messageIndex?: number;
  /** Short supporting quote/snippet. */
  quote?: string;
  /** ISO timestamp for when this citation was created or observed. */
  timestamp: string;
}

export interface WikiPageMetadata {
  path: string;
  type: MemoryType;
  confidence: number;
  citations: MemoryCitation[];
  tags: string[];
  project?: string;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type WikiPageMetadataInput = Partial<
  Omit<WikiPageMetadata, "path" | "createdAt" | "updatedAt">
>;

// ── SCHEMA.md — agent's wiki constitution ─────────────────

const SCHEMA_MD = `# Nexus Wiki — Schema & Conventions

This wiki is your persistent, compounding knowledge base.
You write and maintain every file here. The human reads.
You never modify files in \`.nexus/raw/\` — those are immutable sources.

## Directory Structure

\`\`\`
wiki/
  SCHEMA.md          ← This file (your operating manual)
  index.md           ← Master catalog — update after every write
  log.md             ← Append-only chronological log
  user/
    profile.md       ← User preferences, working style, communication style
  projects/
    <name>/
      overview.md    ← Tech stack, architecture, key files, how to run
      decisions.md   ← Important decisions + rationale (ADR-style)
      todos.md       ← Open items, known issues, future work
  skills/
    <id>.md          ← How to do X, with examples and success criteria
  concepts/
    <slug>.md        ← Technical concepts, patterns, anti-patterns
  sessions/
    <YYYY-MM-DD>-<slug>.md ← Session summaries
  insights/
    patterns.md      ← Recurring patterns observed across sessions
    anti-patterns.md ← Things that reliably don't work
  .meta/
    <encoded-page>.json ← Structured metadata + source citations
\`\`\`

## Page Conventions

Every page must start with:
\`\`\`
# Title

> One-line summary (used in index.md)

Updated: YYYY-MM-DD
\`\`\`

Use standard markdown. Cross-reference with \`[[page-slug]]\` or relative links.
Keep pages focused — one concept per page. Split if a page exceeds ~300 lines.

## Structured Metadata

Every durable memory page may have a sidecar JSON file in \`.meta/\`.
Metadata records:
- \`type\`: user_preference, project_fact, project_decision, procedure, session_summary, todo, environment_fact, concept, observation
- \`confidence\`: 0–1 confidence in the synthesized memory
- \`citations\`: source pointers back to raw sessions, ingested docs, wiki pages, tools, or manual input
- \`tags\`, \`project\`, and arbitrary \`attributes\`

When relying on remembered facts, cite the wiki page path and, when available, the citation source path.

## Operations

### Session Start
1. Read \`index.md\` to see what knowledge exists
2. Read \`user/profile.md\` for user context
3. Read project overview for the active project (if known)
4. Read recent sessions in \`sessions/\` if task context is needed

### During Session
- When you learn a new fact about the user → update \`user/profile.md\`
- When you make an important architectural decision → update \`projects/<name>/decisions.md\`
- When you discover a new pattern → update \`insights/patterns.md\`
- When you create a reusable skill → write \`skills/<id>.md\`

### Session End (on /exit or farewell)
1. Write a session summary to \`sessions/YYYY-MM-DD-<slug>.md\`
   - What was asked / accomplished
   - Files modified
   - Decisions made
   - Open items
2. Update \`projects/<name>/todos.md\` with any new open items
3. Append an entry to \`log.md\`
4. Update \`index.md\` for any new pages

### Ingesting External Documents
When the user shares a document to ingest:
1. Confirm it's in \`.nexus/raw/ingested/\` (immutable)
2. Read it carefully
3. Write/update relevant wiki pages (entities, concepts, summaries)
4. Append an ingest entry to \`log.md\`
5. Update \`index.md\`

### Lint Pass (on /wiki lint)
Check for:
- Orphan pages (not in index.md)
- Stale pages (not updated in >30 days while project is active)
- Missing cross-references (concept mentioned but no page exists)
- Contradictions between pages
- Pages exceeding 300 lines without sub-pages

## index.md Format

\`\`\`markdown
# Wiki Index

| Page | Summary | Updated |
|------|---------|---------|
| [user/profile](user/profile.md) | User preferences and working style | 2026-04-12 |
| [projects/nexus/overview](projects/nexus/overview.md) | Nexus monorepo — TypeScript AI agent | 2026-04-12 |
\`\`\`

## log.md Format

Each entry: \`## [YYYY-MM-DD HH:MM] <type> | <title>\`
Types: \`session\`, \`ingest\`, \`skill\`, \`lint\`, \`decision\`

\`\`\`markdown
## [2026-04-12 08:56] session | Initial Nexus setup
Completed MCP integration, added 40 tools, refactored CLI.
Files: packages/protocols/src/mcp-manager.ts, apps/cli/src/index.ts
\`\`\`
`;

// ── WikiStore ─────────────────────────────────────────────

export class WikiStore {
  readonly wikiDir: string;
  readonly rawDir: string;
  readonly metaDir: string;

  /**
   * Optional FTS5 indexer hook — injected by initWikiTools() after WikiSearchIndex
   * is created.  Called on every writePage() so the search index stays in sync.
   */
  indexer: ((pagePath: string, title: string, summary: string, body: string, mtime: number) => void) | null = null;

  constructor(nexusHome: string) {
    this.wikiDir = join(nexusHome, "wiki");
    this.rawDir  = join(nexusHome, "raw");
    this.metaDir = join(this.wikiDir, ".meta");
    this._bootstrap();
  }

  // ── Bootstrap ───────────────────────────────────────────

  private _bootstrap(): void {
    const dirs = [
      this.wikiDir,
      join(this.wikiDir, "user"),
      join(this.wikiDir, "projects"),
      join(this.wikiDir, "skills"),
      join(this.wikiDir, "concepts"),
      join(this.wikiDir, "sessions"),
      join(this.wikiDir, "insights"),
      this.metaDir,
      join(this.rawDir, "sessions"),
      join(this.rawDir, "ingested"),
    ];
    for (const d of dirs) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }

    // Write SCHEMA.md if missing
    const schemaPath = join(this.wikiDir, "SCHEMA.md");
    if (!existsSync(schemaPath)) {
      writeFileSync(schemaPath, SCHEMA_MD, "utf-8");
    }

    // Write empty index + log if missing
    const indexPath = join(this.wikiDir, "index.md");
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, [
        "# Wiki Index\n",
        "| Page | Summary | Updated |",
        "|------|---------|---------|",
        "| [SCHEMA](SCHEMA.md) | Wiki conventions and agent operating manual | " + today() + " |",
        "",
      ].join("\n"), "utf-8");
    }

    const logPath = join(this.wikiDir, "log.md");
    if (!existsSync(logPath)) {
      writeFileSync(logPath, `# Wiki Log\n\n## [${nowLabel()}] init | Wiki initialized\nNexus wiki created.\n`, "utf-8");
    }

    // Bootstrap user/profile.md
    const profilePath = join(this.wikiDir, "user", "profile.md");
    if (!existsSync(profilePath)) {
      writeFileSync(profilePath, [
        "# User Profile\n",
        "> User preferences, working style, and context.\n",
        `Updated: ${today()}\n`,
        "## Preferences\n",
        "_No preferences recorded yet. Update as you learn them._\n",
        "## Working Style\n",
        "_Not yet observed._\n",
        "## Goals\n",
        "_Not yet recorded._\n",
      ].join("\n"), "utf-8");
    }

    // Bootstrap insights pages — use _updateIndexEntry so they appear in index.md
    for (const [name, title, summary] of [
      ["patterns.md", "Patterns", "Recurring patterns observed across sessions"],
      ["anti-patterns.md", "Anti-Patterns", "Things that reliably don't work"],
    ] as const) {
      const p = join(this.wikiDir, "insights", name);
      if (!existsSync(p)) {
        const content = `# ${title}\n\n> ${summary}\n\nUpdated: ${today()}\n\n_None recorded yet._\n`;
        writeFileSync(p, content, "utf-8");
        this._updateIndexEntry(`insights/${name}`, summary);
      }
    }
  }

  // ── Read ────────────────────────────────────────────────

  readPage(pagePath: string): string {
    const full = join(this.wikiDir, pagePath);
    if (!existsSync(full)) return `(page not found: ${pagePath})`;
    return readFileSync(full, "utf-8");
  }

  readIndex(): string {
    return this.readPage("index.md");
  }

  readSchema(): string {
    return this.readPage("SCHEMA.md");
  }

  // ── Write ───────────────────────────────────────────────

  writePage(
    pagePath: string,
    content: string,
    logSummary?: string,
    metadata?: WikiPageMetadataInput,
  ): void {
    const full = join(this.wikiDir, pagePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
    const title   = extractTitle(content);
    const summary = extractSummary(content);
    this._updateIndexEntry(pagePath, summary);
    if (logSummary) {
      this.appendLog("edit", basename(pagePath, ".md"), logSummary);
    }
    // Sync FTS5 index if one is attached
    if (this.indexer) {
      const mtime = statSync(full).mtimeMs;
      this.indexer(pagePath, title, summary, content, mtime);
    }
    if (metadata) {
      this.writeMetadata(pagePath, metadata);
    }
  }

  appendLog(type: string, title: string, body: string): void {
    const entry = `\n## [${nowLabel()}] ${type} | ${title}\n${body}\n`;
    appendFileSync(join(this.wikiDir, "log.md"), entry, "utf-8");
  }

  // ── Structured metadata + citations ───────────────────

  getMetadata(pagePath: string): WikiPageMetadata | null {
    const path = this._metadataPath(pagePath);
    if (!existsSync(path)) return null;
    try {
      return normalizeMetadata(pagePath, JSON.parse(readFileSync(path, "utf-8")));
    } catch {
      return null;
    }
  }

  writeMetadata(pagePath: string, metadata: WikiPageMetadataInput): WikiPageMetadata {
    const existing = this.getMetadata(pagePath);
    const now = new Date().toISOString();
    const next = normalizeMetadata(pagePath, {
      ...(existing ?? {}),
      ...metadata,
      citations: mergeCitations(existing?.citations ?? [], metadata.citations ?? []),
      tags: [...new Set([...(existing?.tags ?? []), ...(metadata.tags ?? [])])],
      attributes: {
        ...(existing?.attributes ?? {}),
        ...(metadata.attributes ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const path = this._metadataPath(pagePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
    return next;
  }

  addCitation(pagePath: string, citation: MemoryCitation): WikiPageMetadata {
    return this.writeMetadata(pagePath, {
      citations: [citation],
    });
  }

  // ── Search ──────────────────────────────────────────────

  search(query: string, category?: string): WikiPage[] {
    const q = query.toLowerCase();
    const pages = this.listPages(category);
    return pages
      .filter((p) => {
        const content = this.readPage(p.path).toLowerCase();
        return content.includes(q) || p.title.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Prioritise title matches
        const aTitle = a.title.toLowerCase().includes(q) ? 1 : 0;
        const bTitle = b.title.toLowerCase().includes(q) ? 1 : 0;
        return bTitle - aTitle;
      });
  }

  // ── List ────────────────────────────────────────────────

  listPages(category?: string): WikiPage[] {
    const root = category ? join(this.wikiDir, category) : this.wikiDir;
    if (!existsSync(root)) return [];
    return this._scanDir(root);
  }

  private _scanDir(dir: string): WikiPage[] {
    const pages: WikiPage[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        pages.push(...this._scanDir(full));
      } else if (entry.endsWith(".md")) {
        const rel  = relative(this.wikiDir, full);
        const text = readFileSync(full, "utf-8");
        pages.push({
          path:      rel,
          title:     extractTitle(text) || rel,
          summary:   extractSummary(text),
          updatedAt: stat.mtimeMs,
          size:      stat.size,
        });
      }
    }
    return pages;
  }

  // ── Lint ────────────────────────────────────────────────

  lint(): LintIssue[] {
    const issues: LintIssue[] = [];
    const indexContent = this.readIndex();
    const allPages = this.listPages();

    for (const page of allPages) {
      if (page.path === "index.md" || page.path === "SCHEMA.md" || page.path === "log.md") continue;

      // Not in index
      if (!indexContent.includes(page.path)) {
        issues.push({ severity: "warn", page: page.path, message: "Page not referenced in index.md" });
      }

      // Very large page
      if (page.size > 15_000) {
        issues.push({ severity: "info", page: page.path, message: `Large page (${Math.round(page.size / 1024)}KB) — consider splitting` });
      }

      // Stale (not updated in 30 days)
      const ageDays = (Date.now() - page.updatedAt) / (1000 * 60 * 60 * 24);
      if (ageDays > 30 && !page.path.startsWith("sessions/")) {
        issues.push({ severity: "info", page: page.path, message: `Stale page (${Math.round(ageDays)} days)` });
      }

      // Missing Updated date
      const content = this.readPage(page.path);
      if (!content.includes("Updated:")) {
        issues.push({ severity: "warn", page: page.path, message: "Missing 'Updated: YYYY-MM-DD' header" });
      }
    }

    return issues;
  }

  // ── Raw source management ─────────────────────────────

  saveRawSession(sessionId: string, content: string): string {
    const path = join(this.rawDir, "sessions", `${sessionId}.md`);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  saveRawIngested(filename: string, content: string): string {
    const path = join(this.rawDir, "ingested", filename);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  listRawSessions(): string[] {
    const dir = join(this.rawDir, "sessions");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse() : [];
  }

  listRawIngested(): string[] {
    const dir = join(this.rawDir, "ingested");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  readRaw(type: "sessions" | "ingested", filename: string): string {
    const path = join(this.rawDir, type, filename);
    return existsSync(path) ? readFileSync(path, "utf-8") : `(not found: ${filename})`;
  }

  // ── Private helpers ───────────────────────────────────

  private _updateIndexEntry(pagePath: string, summary: string): void {
    const indexPath = join(this.wikiDir, "index.md");
    let index = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : "# Wiki Index\n\n| Page | Summary | Updated |\n|------|---------|---------|";

    const linkName = pagePath.replace(/\.md$/, "").replace(/\//g, "/");
    const row = `| [${linkName}](${pagePath}) | ${summary.slice(0, 80)} | ${today()} |`;
    const rowRegex = new RegExp(`\\|\\s*\\[${escapeRegex(linkName)}\\][^\\n]*\\|[^\\n]*\\|[^\\n]*\\|`);

    if (rowRegex.test(index)) {
      index = index.replace(rowRegex, row);
    } else {
      // Add after table header
      index = index.replace(/(\|[-|: ]+\|\n)/, `$1${row}\n`);
    }

    writeFileSync(indexPath, index, "utf-8");
  }

  private _metadataPath(pagePath: string): string {
    return join(this.metaDir, `${encodeURIComponent(pagePath)}.json`);
  }
}

// ── Helpers ───────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowLabel(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

function extractTitle(md: string): string {
  const m = md.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : "";
}

function extractSummary(md: string): string {
  // Try blockquote summary first ("> one-liner")
  const bq = md.match(/^>\s+(.+)/m);
  if (bq) return bq[1].trim().slice(0, 120);
  // Otherwise use first non-heading, non-empty paragraph
  const lines = md.split("\n");
  for (const line of lines) {
    const l = line.trim();
    if (l && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("|") && !l.startsWith("Updated")) {
      return l.slice(0, 120);
    }
  }
  return "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMetadata(pagePath: string, raw: Partial<WikiPageMetadata>): WikiPageMetadata {
  const now = new Date().toISOString();
  return {
    path: pagePath,
    type: isMemoryType(raw.type) ? raw.type : "concept",
    confidence: clampConfidence(raw.confidence),
    citations: Array.isArray(raw.citations)
      ? raw.citations.map(normalizeCitation).filter(Boolean) as MemoryCitation[]
      : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : [],
    project: raw.project ? String(raw.project) : undefined,
    attributes: raw.attributes && typeof raw.attributes === "object" && !Array.isArray(raw.attributes)
      ? raw.attributes
      : {},
    createdAt: raw.createdAt ? String(raw.createdAt) : now,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : now,
  };
}

function normalizeCitation(raw: unknown): MemoryCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<MemoryCitation>;
  if (!obj.sourcePath) return null;
  return {
    sourceType: isSourceType(obj.sourceType) ? obj.sourceType : "manual",
    sourcePath: String(obj.sourcePath),
    sourceId: obj.sourceId ? String(obj.sourceId) : undefined,
    messageIndex: typeof obj.messageIndex === "number" ? obj.messageIndex : undefined,
    quote: obj.quote ? String(obj.quote).slice(0, 500) : undefined,
    timestamp: obj.timestamp ? String(obj.timestamp) : new Date().toISOString(),
  };
}

function mergeCitations(existing: MemoryCitation[], incoming: MemoryCitation[]): MemoryCitation[] {
  const merged = [...existing];
  const seen = new Set(existing.map(citationKey));
  for (const citation of incoming.map(normalizeCitation).filter(Boolean) as MemoryCitation[]) {
    const key = citationKey(citation);
    if (!seen.has(key)) {
      merged.push(citation);
      seen.add(key);
    }
  }
  return merged;
}

function citationKey(c: MemoryCitation): string {
  return [c.sourceType, c.sourcePath, c.sourceId ?? "", c.messageIndex ?? "", c.quote ?? ""].join("|");
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : 1;
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && [
    "user_preference",
    "project_fact",
    "project_decision",
    "procedure",
    "session_summary",
    "todo",
    "environment_fact",
    "concept",
    "observation",
  ].includes(value);
}

function isSourceType(value: unknown): value is MemorySourceType {
  return typeof value === "string" && ["session", "ingested", "wiki", "manual", "tool"].includes(value);
}
