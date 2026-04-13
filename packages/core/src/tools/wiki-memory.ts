/**
 * Nexus Wiki Memory Tools
 *
 * Cross-session semantic memory using FTS5 full-text search (BM25) over the wiki.
 *
 * Tool inventory:
 *   wiki_recall   — ranked FTS5 retrieval across all wiki pages (primary cross-session memory)
 *   wiki_similar  — find pages related to a given page (content-based discovery)
 *   wiki_observe  — append a structured user observation (Honcho-style user modelling)
 *
 * Architecture vs competitors:
 *   OpenClaw  — FTS5 + vector over raw session chunks → ours searches synthesised wiki pages
 *               (already structured, cross-referenced, no chunking artefacts)
 *   Hermes    — Honcho user modelling via external service → ours is local, in-wiki, zero-cost
 */

import type { Tool } from "../types.js";
import { WikiStore, type MemoryCitation } from "../wiki.js";
import { WikiSearchIndex, type FTSResult } from "../wiki-index.js";

// ── Singleton accessors ───────────────────────────────────

let _store: WikiStore | null = null;
let _index: WikiSearchIndex | null = null;

export function initWikiMemoryTools(store: WikiStore, index: WikiSearchIndex): void {
  _store = store;
  _index = index;
}

function getStore(): WikiStore {
  if (!_store) throw new Error("Wiki memory not initialised — call initWikiTools() first");
  return _store;
}

function getIndex(): WikiSearchIndex {
  if (!_index) throw new Error("Wiki index not initialised — call initWikiTools() first");
  return _index;
}

// ── wiki_recall ────────────────────────────────────────────

export const wikiRecallTool: Tool = {
  schema: {
    name: "wiki_recall",
    description: [
      "Ranked full-text search across all wiki pages using FTS5 BM25.",
      "This is the primary cross-session memory retrieval tool.",
      "Use this to recall facts, decisions, patterns, or context from previous sessions.",
      "Results are ranked by relevance (title matches weighted 10×, summary 5×, body 1×).",
      "Returns matched pages with highlighted snippets showing where the match occurred.",
      "Examples: wiki_recall('authentication flow'), wiki_recall('user prefers dark mode'),",
      "wiki_recall('why we chose SQLite'), wiki_recall('todo items for nexus')",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language or keyword query to search for",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 8, max: 20)",
        },
        category: {
          type: "string",
          description: "Optional category filter: 'user', 'projects', 'skills', 'concepts', 'sessions', 'insights'",
        },
      },
      required: ["query"],
    },
  },
  async execute(args) {
    const index = getIndex();
    const query  = String(args.query);
    const limit  = Math.min(Number(args.limit ?? 8), 20);
    const cat    = args.category ? String(args.category) : undefined;

    const results = index.recall(query, limit);
    const filtered = cat ? results.filter((r: FTSResult) => r.category === cat) : results;

    if (filtered.length === 0) {
      return `No wiki pages found matching "${query}".\n\nTip: Try broader terms, or use wiki_list to browse all pages.`;
    }

    const lines: string[] = [
      `**${filtered.length}** result(s) for \`${query}\`:\n`,
    ];

    for (const r of filtered) {
      const metadata = getStore().getMetadata(r.path);
      lines.push(`### [${r.title}](${r.path})`);
      lines.push(`> ${r.summary}`);
      if (metadata) {
        lines.push(`\nMetadata: \`${metadata.type}\`, confidence ${(metadata.confidence * 100).toFixed(0)}%`);
        const citations = formatCitations(metadata.citations);
        if (citations.length > 0) {
          lines.push("Citations:");
          lines.push(...citations);
        }
      }
      if (r.snippet && r.snippet !== r.summary) {
        lines.push(`\n…${r.snippet}…`);
      }
      lines.push("");
    }

    return lines.join("\n");
  },
};

// ── wiki_similar ───────────────────────────────────────────

export const wikiSimilarTool: Tool = {
  schema: {
    name: "wiki_similar",
    description: [
      "Find wiki pages similar to a given page using content-based matching.",
      "Extracts distinctive terms from the target page's title and summary,",
      "then queries the FTS5 index to find related pages.",
      "Useful for discovering cross-references, related concepts, or connected sessions.",
      "Pass a relative page path like 'concepts/dual-process-routing.md' or 'user/profile.md'.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Relative path of the page to find similar pages for (e.g. 'concepts/caching.md')",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 6)",
        },
      },
      required: ["page"],
    },
  },
  async execute(args) {
    const index = getIndex();
    const page  = String(args.page);
    const limit = Math.min(Number(args.limit ?? 6), 15);

    const results = index.similar(page, limit);

    if (results.length === 0) {
      return `No similar pages found for \`${page}\`. Either the page isn't indexed yet or no related content exists.`;
    }

    const lines: string[] = [`**${results.length}** page(s) similar to \`${page}\`:\n`];
    for (const r of results) {
      lines.push(`- **[${r.title}](${r.path})** — ${r.summary}`);
      if (r.snippet) lines.push(`  _…${r.snippet}…_`);
    }

    return lines.join("\n");
  },
};

// ── wiki_observe ───────────────────────────────────────────

export const wikiObserveTool: Tool = {
  schema: {
    name: "wiki_observe",
    description: [
      "Record a structured observation about the user.",
      "Appends to user/observations.md — the raw observation log.",
      "Use this whenever you learn something meaningful about the user:",
      "preferences, working patterns, goals, communication style, recurring needs.",
      "Observations accumulate over sessions and can be synthesised into user/profile.md.",
      "Examples:",
      "  - 'Prefers concise explanations over verbose ones'",
      "  - 'Uses dark mode, works in VSCode'",
      "  - 'Working on a SaaS product targeting developers'",
      "  - 'Frustrated by slow feedback loops, appreciates quick iteration'",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        observation: {
          type: "string",
          description: "A concise, factual observation about the user (1–2 sentences)",
        },
        category: {
          type: "string",
          enum: ["preference", "style", "goal", "context", "pattern", "frustration", "skill"],
          description: "Type of observation (default: 'preference')",
        },
      },
      required: ["observation"],
    },
  },
  async execute(args) {
    const store       = getStore();
    const index       = getIndex();
    const observation = String(args.observation);
    const category    = String(args.category ?? "preference");
    const today       = new Date().toISOString().slice(0, 10);

    const obsPath = "user/observations.md";
    const existing = store.readPage(obsPath);

    let content: string;

    if (existing.startsWith("(page not found")) {
      // First observation — create the page
      content = [
        "# User Observations",
        "",
        "> Raw observation log — facts learned about the user across sessions.",
        "",
        `Updated: ${today}`,
        "",
        "## Observations",
        "",
        `- [${today}] \`${category}\` ${observation}`,
        "",
      ].join("\n");
    } else {
      // Append to existing page
      const entry = `- [${today}] \`${category}\` ${observation}`;

      if (existing.includes("## Observations")) {
        // Insert after the ## Observations heading
        content = existing.replace(
          /## Observations\n/,
          `## Observations\n\n${entry}\n`,
        );
      } else {
        content = existing.trimEnd() + `\n\n${entry}\n`;
      }

      // Update the Updated: date
      content = content.replace(/Updated: \d{4}-\d{2}-\d{2}/, `Updated: ${today}`);
    }

    store.writePage(obsPath, content);
    store.writeMetadata(obsPath, {
      type: "observation",
      confidence: 0.8,
      tags: ["user", category],
      citations: [{
        sourceType: "manual",
        sourcePath: "current-session",
        quote: observation,
        timestamp: new Date().toISOString(),
      }],
    });

    // Also update index directly since writePage already calls indexer,
    // but we want to confirm the entry is live immediately.
    const allObs = store.readPage(obsPath);
    index.update(obsPath, "User Observations", "Raw observation log about the user", allObs, Date.now());

    // Count total observations
    const count = (allObs.match(/^- \[/mg) ?? []).length;

    return [
      `✓ Observation recorded in user/observations.md`,
      `  Category: ${category}`,
      `  Total observations: ${count}`,
      ``,
      `Tip: When observations accumulate (≥5 new ones), read user/observations.md`,
      `and wiki_write an updated user/profile.md synthesising all insights.`,
    ].join("\n");
  },
};

// ── Collection ─────────────────────────────────────────────

export const wikiMemoryTools: Tool[] = [
  wikiRecallTool,
  wikiSimilarTool,
  wikiObserveTool,
];

function formatCitations(citations: MemoryCitation[]): string[] {
  return citations.slice(0, 3).map((citation) => {
    const quote = citation.quote ? ` — "${citation.quote.slice(0, 120)}"` : "";
    const sourceId = citation.sourceId ? `#${citation.sourceId}` : "";
    return `- ${citation.sourceType}: \`${citation.sourcePath}${sourceId}\`${quote}`;
  });
}
