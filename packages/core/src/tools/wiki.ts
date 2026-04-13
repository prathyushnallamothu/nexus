/**
 * Nexus Wiki Tools
 *
 * LLM-maintained persistent knowledge base tools.
 * The agent uses these to read, write, and maintain its wiki.
 */

import type { Tool } from "../types.js";
import {
  WikiStore,
  type WikiPage,
  type LintIssue,
  type WikiPageMetadataInput,
  type MemoryCitation,
} from "../wiki.js";
import { WikiSearchIndex } from "../wiki-index.js";
import { initWikiMemoryTools } from "./wiki-memory.js";

// ── Singleton accessors ────────────────────────────────────
// WikiStore + WikiSearchIndex are initialised once and shared across all wiki tools.
// initWikiTools() MUST be called before any tool is used.

let _store: WikiStore | null = null;
let _index: WikiSearchIndex | null = null;

export function initWikiTools(nexusHome: string): void {
  const store = new WikiStore(nexusHome);
  const index = new WikiSearchIndex(nexusHome);

  // Hook indexer into store so every writePage() syncs FTS5 automatically
  store.indexer = (pagePath, title, summary, body, mtime) => {
    index.update(pagePath, title, summary, body, mtime);
  };

  // Sync any pages modified since last index (incremental — fast on startup)
  const staleCount = index.syncStale(store);
  if (staleCount > 0) {
    // Silently synced — no user-visible output needed
  }

  _store = store;
  _index = index;

  // Wire memory tools (wiki_recall, wiki_similar, wiki_observe)
  initWikiMemoryTools(store, index);
}

function getStore(): WikiStore {
  if (!_store) throw new Error("Wiki not initialised — call initWikiTools(nexusHome) first");
  return _store;
}

// ── wiki_read ──────────────────────────────────────────────

export const wikiReadTool: Tool = {
  schema: {
    name: "wiki_read",
    description: [
      "Read a page from the persistent wiki knowledge base.",
      "Pass 'index' to read the master catalog, 'schema' for the operating manual,",
      "or a relative path like 'user/profile.md', 'projects/nexus/overview.md',",
      "'sessions/2026-04-12-setup.md', 'skills/git-rebase.md', etc.",
      "Returns the markdown content of the page.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Page path relative to wiki root, or 'index' / 'schema' shorthand",
        },
      },
      required: ["page"],
    },
  },
  async execute(args) {
    const store = getStore();
    const page = String(args.page);
    if (page === "index") return store.readIndex();
    if (page === "schema") return store.readSchema();
    return store.readPage(page);
  },
};

// ── wiki_write ─────────────────────────────────────────────

export const wikiWriteTool: Tool = {
  schema: {
    name: "wiki_write",
    description: [
      "Write or update a wiki page. Automatically updates index.md and optionally appends to log.md.",
      "Every page MUST follow the schema convention:",
      "  # Title",
      "  ",
      "  > One-line summary",
      "  ",
      "  Updated: YYYY-MM-DD",
      "Use paths like 'user/profile.md', 'projects/<name>/overview.md',",
      "'skills/<id>.md', 'concepts/<slug>.md', 'sessions/<date>-<slug>.md'.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Page path relative to wiki root (e.g. 'user/profile.md')",
        },
        content: {
          type: "string",
          description: "Full markdown content for the page",
        },
        log_summary: {
          type: "string",
          description: "Optional one-line summary to append to log.md (recommended for significant updates)",
        },
        metadata: {
          type: "object",
          description: "Optional structured memory metadata: type, confidence, tags, project, attributes, citations",
        },
        citations: {
          type: "array",
          description: "Optional source citations for this page",
          items: { type: "object" },
        },
      },
      required: ["page", "content"],
    },
  },
  async execute(args) {
    const store = getStore();
    const page = String(args.page);
    const content = String(args.content);
    const logSummary = args.log_summary ? String(args.log_summary) : undefined;
    const metadata = parseMetadataInput(args.metadata, args.citations);

    if (page === "SCHEMA.md" || page === "log.md") {
      return `Error: Cannot overwrite protected file '${page}'. Use wiki_log to append to log.md.`;
    }

    store.writePage(page, content, logSummary, metadata);
    return `✓ Written: ${page} (index.md updated)${logSummary ? "; log entry added" : ""}${metadata ? "; metadata updated" : ""}`;
  },
};

// ── wiki_metadata ─────────────────────────────────────────

export const wikiMetadataTool: Tool = {
  schema: {
    name: "wiki_metadata",
    description: [
      "Read or update structured metadata for a wiki page.",
      "Metadata classifies memory as user_preference, project_fact, project_decision,",
      "procedure, session_summary, todo, environment_fact, concept, or observation,",
      "and stores confidence plus source citations.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "update", "add_citation"],
          description: "Operation to run",
        },
        page: {
          type: "string",
          description: "Page path relative to wiki root",
        },
        metadata: {
          type: "object",
          description: "Metadata fields for update",
        },
        citation: {
          type: "object",
          description: "Citation to append for add_citation",
        },
      },
      required: ["action", "page"],
    },
  },
  async execute(args) {
    const store = getStore();
    const action = String(args.action);
    const page = String(args.page);

    if (action === "get") {
      const metadata = store.getMetadata(page);
      return metadata
        ? JSON.stringify(metadata, null, 2)
        : `No metadata found for ${page}.`;
    }

    if (action === "update") {
      const metadata = parseMetadataInput(args.metadata);
      if (!metadata) return "Error: metadata object is required for update.";
      return JSON.stringify(store.writeMetadata(page, metadata), null, 2);
    }

    if (action === "add_citation") {
      const citation = parseCitation(args.citation);
      if (!citation) return "Error: citation.sourcePath is required for add_citation.";
      return JSON.stringify(store.addCitation(page, citation), null, 2);
    }

    return "Error: action must be get, update, or add_citation.";
  },
};

// ── wiki_log ───────────────────────────────────────────────

export const wikiLogTool: Tool = {
  schema: {
    name: "wiki_log",
    description: [
      "Append a chronological entry to log.md. Use for session summaries, ingest events,",
      "decisions, skill additions. Each entry is timestamped automatically.",
      "Types: 'session', 'ingest', 'skill', 'decision', 'lint', 'edit'",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["session", "ingest", "skill", "decision", "lint", "edit"],
          description: "Entry type",
        },
        title: {
          type: "string",
          description: "Short title for this log entry",
        },
        body: {
          type: "string",
          description: "Detailed description: what happened, files changed, decisions made, etc.",
        },
      },
      required: ["type", "title", "body"],
    },
  },
  async execute(args) {
    const store = getStore();
    store.appendLog(String(args.type), String(args.title), String(args.body));
    return `✓ Log entry added: [${args.type}] ${args.title}`;
  },
};

// ── wiki_search ────────────────────────────────────────────

export const wikiSearchTool: Tool = {
  schema: {
    name: "wiki_search",
    description: [
      "Search the wiki for pages matching a query. Searches titles, summaries, and full content.",
      "Returns matching pages sorted by relevance (title matches first).",
      "Optionally filter by category: 'user', 'projects', 'skills', 'concepts', 'sessions', 'insights'.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        category: {
          type: "string",
          description: "Optional category to restrict search (e.g. 'projects', 'skills')",
        },
      },
      required: ["query"],
    },
  },
  async execute(args) {
    const store = getStore();
    const results = store.search(String(args.query), args.category ? String(args.category) : undefined);
    if (results.length === 0) return "No wiki pages found matching that query.";
    const lines = results.map(
      (p: WikiPage) => `- **${p.path}** — ${p.summary} _(${new Date(p.updatedAt).toISOString().slice(0, 10)})_`
    );
    return `Found ${results.length} page(s):\n\n${lines.join("\n")}`;
  },
};

// ── wiki_list ──────────────────────────────────────────────

export const wikiListTool: Tool = {
  schema: {
    name: "wiki_list",
    description: [
      "List all wiki pages, optionally filtered by category.",
      "Returns paths, titles, summaries and last-updated dates.",
      "Categories: 'user', 'projects', 'skills', 'concepts', 'sessions', 'insights'.",
      "Omit category to list everything.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional category subdirectory to list",
        },
      },
      required: [],
    },
  },
  async execute(args) {
    const store = getStore();
    const pages = store.listPages(args.category ? String(args.category) : undefined);
    if (pages.length === 0) return "No wiki pages found.";
    const lines = pages
      .sort((a: WikiPage, b: WikiPage) => b.updatedAt - a.updatedAt)
      .map((p: WikiPage) => `- **${p.path}** — ${p.summary} _(${new Date(p.updatedAt).toISOString().slice(0, 10)}, ${Math.round(p.size / 1024 * 10) / 10}KB)_`);
    return `${pages.length} wiki page(s):\n\n${lines.join("\n")}`;
  },
};

// ── wiki_lint ──────────────────────────────────────────────

export const wikiLintTool: Tool = {
  schema: {
    name: "wiki_lint",
    description: [
      "Health-check the wiki. Finds orphan pages (not in index.md),",
      "pages missing 'Updated:' headers, large pages (>15KB) that should be split,",
      "and stale non-session pages (>30 days without update).",
      "Use this periodically to keep the wiki clean and consistent.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async execute() {
    const store = getStore();
    const issues = store.lint();
    if (issues.length === 0) return "✓ Wiki lint passed — no issues found.";

    const errors = issues.filter((i: LintIssue) => i.severity === "error");
    const warns  = issues.filter((i: LintIssue) => i.severity === "warn");
    const infos  = issues.filter((i: LintIssue) => i.severity === "info");

    const lines: string[] = [`Wiki lint: ${issues.length} issue(s)\n`];
    if (errors.length) {
      lines.push("**Errors:**");
      errors.forEach((i: LintIssue) => lines.push(`- ❌ ${i.page}: ${i.message}`));
    }
    if (warns.length) {
      lines.push("\n**Warnings:**");
      warns.forEach((i: LintIssue) => lines.push(`- ⚠️  ${i.page}: ${i.message}`));
    }
    if (infos.length) {
      lines.push("\n**Info:**");
      infos.forEach((i: LintIssue) => lines.push(`- ℹ️  ${i.page}: ${i.message}`));
    }

    // Append lint run to log
    store.appendLog("lint", "Wiki lint pass", `${issues.length} issues: ${errors.length} errors, ${warns.length} warnings, ${infos.length} info`);

    return lines.join("\n");
  },
};

// ── wiki_ingest ────────────────────────────────────────────

export const wikiIngestTool: Tool = {
  schema: {
    name: "wiki_ingest",
    description: [
      "Save an external document to the immutable raw/ingested store,",
      "so it can later be processed into wiki pages.",
      "After saving, read the document and update relevant wiki pages yourself:",
      "create summaries, update entity/concept pages, cross-reference, update index.md, append to log.md.",
      "filename should include extension, e.g. 'paper-transformers.md', 'meeting-notes.txt'.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Filename to store under .nexus/raw/ingested/ (include extension)",
        },
        content: {
          type: "string",
          description: "Full content of the document to ingest",
        },
      },
      required: ["filename", "content"],
    },
  },
  async execute(args) {
    const store = getStore();
    store.saveRawIngested(String(args.filename), String(args.content));
    const size = Math.round(String(args.content).length / 1024 * 10) / 10;
    return [
      `✓ Saved to raw/ingested/${args.filename} (${size}KB)`,
      "",
      "Now read this document carefully and:",
      "1. Write/update relevant wiki pages (entities, concepts, summaries)",
      "2. Cross-reference with existing pages",
      "3. Append an ingest entry to log.md with wiki_log",
      "4. Verify index.md is up to date",
    ].join("\n");
  },
};

// ── wiki_save_session ──────────────────────────────────────

export const wikiSaveSessionTool: Tool = {
  schema: {
    name: "wiki_save_session",
    description: [
      "Save the current session transcript to the immutable raw/sessions store.",
      "Call this at session end before writing the session summary wiki page.",
      "session_id should be a unique identifier like 'YYYY-MM-DD-HH-MM' or a slug.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Unique session identifier (e.g. '2026-04-12-14-30' or '2026-04-12-nexus-setup')",
        },
        content: {
          type: "string",
          description: "Full session transcript or summary content to archive",
        },
      },
      required: ["session_id", "content"],
    },
  },
  async execute(args) {
    const store = getStore();
    store.saveRawSession(String(args.session_id), String(args.content));
    return `✓ Session archived to raw/sessions/${args.session_id}.md`;
  },
};

// ── Collection ─────────────────────────────────────────────

export const wikiTools: Tool[] = [
  wikiReadTool,
  wikiWriteTool,
  wikiLogTool,
  wikiMetadataTool,
  wikiSearchTool,
  wikiListTool,
  wikiLintTool,
  wikiIngestTool,
  wikiSaveSessionTool,
];

function parseMetadataInput(metadataRaw: unknown, citationsRaw?: unknown): WikiPageMetadataInput | undefined {
  const raw = metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
    ? metadataRaw as Record<string, unknown>
    : {};
  const citations = parseCitations(citationsRaw ?? raw["citations"]);
  const hasFields = Object.keys(raw).length > 0 || citations.length > 0;
  if (!hasFields) return undefined;
  return {
    type: typeof raw["type"] === "string" ? raw["type"] as WikiPageMetadataInput["type"] : undefined,
    confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : undefined,
    citations,
    tags: Array.isArray(raw["tags"]) ? raw["tags"].map(String) : undefined,
    project: typeof raw["project"] === "string" ? raw["project"] : undefined,
    attributes: raw["attributes"] && typeof raw["attributes"] === "object" && !Array.isArray(raw["attributes"])
      ? raw["attributes"] as Record<string, unknown>
      : undefined,
  };
}

function parseCitations(raw: unknown): MemoryCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseCitation).filter(Boolean) as MemoryCitation[];
}

function parseCitation(raw: unknown): MemoryCitation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!obj["sourcePath"]) return null;
  return {
    sourceType: typeof obj["sourceType"] === "string" ? obj["sourceType"] as MemoryCitation["sourceType"] : "manual",
    sourcePath: String(obj["sourcePath"]),
    sourceId: obj["sourceId"] ? String(obj["sourceId"]) : undefined,
    messageIndex: typeof obj["messageIndex"] === "number" ? obj["messageIndex"] : undefined,
    quote: obj["quote"] ? String(obj["quote"]) : undefined,
    timestamp: obj["timestamp"] ? String(obj["timestamp"]) : new Date().toISOString(),
  };
}
