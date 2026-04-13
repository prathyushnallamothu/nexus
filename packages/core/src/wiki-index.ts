/**
 * Nexus Wiki Search Index
 *
 * SQLite FTS5 full-text search over wiki pages.
 * Uses BM25 ranking with field weights: title×10, summary×5, body×1.
 * Porter stemmer tokenisation for English morphological normalisation.
 *
 * Comparable to OpenClaw's FTS5 approach but integrated into the wiki memory
 * layer — searches synthesised wiki pages (not raw session chunks), so results
 * are already structured and cross-referenced.
 */

import { join } from "node:path";
import type { WikiStore } from "./wiki.js";

// ── Types ─────────────────────────────────────────────────

export interface FTSResult {
  path: string;
  title: string;
  summary: string;
  category: string;
  /** BM25 rank — more negative = better match */
  rank: number;
  /** Highlighted snippet from body */
  snippet: string;
}

// ── WikiSearchIndex ────────────────────────────────────────

export class WikiSearchIndex {
  private db: ReturnType<typeof openDb>;
  private readonly dbPath: string;

  constructor(nexusHome: string) {
    this.dbPath = join(nexusHome, "wiki-index.db");
    this.db = openDb(this.dbPath);
    this._bootstrap();
  }

  // ── Bootstrap ───────────────────────────────────────────

  private _bootstrap(): void {
    // FTS5 virtual table with porter stemmer
    // Column weights for bm25(): path(0)=skip, title(1)=10, summary(2)=5, body(3)=1
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
        path      UNINDEXED,
        title,
        summary,
        body,
        category  UNINDEXED,
        tokenize  = 'porter ascii'
      );
    `);

    // Metadata table — tracks mtime so we can detect stale entries
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_meta (
        path        TEXT    PRIMARY KEY,
        indexed_at  INTEGER NOT NULL,
        file_mtime  INTEGER NOT NULL
      );
    `);
  }

  // ── Index maintenance ────────────────────────────────────

  /** Upsert a page into the FTS5 index */
  update(
    pagePath: string,
    title: string,
    summary: string,
    body: string,
    fileMtime: number,
  ): void {
    const category = pagePath.split("/")[0] ?? "root";

    // FTS5 requires delete-then-insert for updates
    this.db.run(`DELETE FROM wiki_fts WHERE path = ?`, [pagePath]);
    this.db.run(
      `INSERT INTO wiki_fts(path, title, summary, body, category)
       VALUES (?, ?, ?, ?, ?)`,
      [pagePath, title, summary, body, category],
    );
    this.db.run(
      `INSERT OR REPLACE INTO wiki_meta(path, indexed_at, file_mtime)
       VALUES (?, ?, ?)`,
      [pagePath, Date.now(), fileMtime],
    );
  }

  /** Remove a page from the index */
  delete(pagePath: string): void {
    this.db.run(`DELETE FROM wiki_fts  WHERE path = ?`, [pagePath]);
    this.db.run(`DELETE FROM wiki_meta WHERE path = ?`, [pagePath]);
  }

  /** True if the page is not indexed or the file has been updated since indexing */
  isStale(pagePath: string, fileMtime: number): boolean {
    const row = this.db.get<{ file_mtime: number }>(
      `SELECT file_mtime FROM wiki_meta WHERE path = ?`,
      [pagePath],
    );
    return !row || row.file_mtime < fileMtime;
  }

  /** Rebuild the entire index from scratch */
  rebuild(store: WikiStore): number {
    this.db.exec(`DELETE FROM wiki_fts; DELETE FROM wiki_meta;`);
    const pages = store.listPages();
    for (const page of pages) {
      const body = store.readPage(page.path);
      this.update(page.path, page.title, page.summary, body, page.updatedAt);
    }
    return pages.length;
  }

  /** Sync only pages that have changed since last index */
  syncStale(store: WikiStore): number {
    const pages = store.listPages();
    let updated = 0;
    for (const page of pages) {
      if (this.isStale(page.path, page.updatedAt)) {
        const body = store.readPage(page.path);
        this.update(page.path, page.title, page.summary, body, page.updatedAt);
        updated++;
      }
    }
    return updated;
  }

  // ── Search ───────────────────────────────────────────────

  /**
   * FTS5 BM25 full-text search.
   * Applies field weights: title×10, summary×5, body×1.
   * Results sorted best-match first (lowest BM25 rank value).
   */
  search(query: string, limit = 10, category?: string): FTSResult[] {
    try {
      const safe = sanitiseFtsQuery(query);
      if (!safe) return [];

      const whereExtra = category ? ` AND category = ${JSON.stringify(category)}` : "";

      return (
        this.db.all<RawFTSRow>(
          `SELECT path, title, summary, category,
                  bm25(wiki_fts, 0, 10, 5, 1)             AS rank,
                  snippet(wiki_fts, 3, '«', '»', '…', 24) AS snippet
           FROM   wiki_fts
           WHERE  wiki_fts MATCH ?${whereExtra}
           ORDER  BY rank
           LIMIT  ?`,
          [safe, limit],
        )
      ).map(toFTSResult);
    } catch {
      return [];
    }
  }

  /**
   * Find pages semantically similar to a given page.
   * Extracts distinctive terms from the target page's title + summary
   * and runs an OR query — effectively content-based recommendation.
   */
  similar(pagePath: string, limit = 6): FTSResult[] {
    try {
      const row = this.db.get<{ title: string; summary: string }>(
        `SELECT title, summary FROM wiki_fts WHERE path = ?`,
        [pagePath],
      );
      if (!row) return [];

      const terms = extractTerms(`${row.title} ${row.summary}`, 8);
      if (terms.length === 0) return [];

      const query = terms.join(" OR ");
      return (
        this.db.all<RawFTSRow>(
          `SELECT path, title, summary, category,
                  bm25(wiki_fts, 0, 10, 5, 1)             AS rank,
                  snippet(wiki_fts, 3, '«', '»', '…', 18) AS snippet
           FROM   wiki_fts
           WHERE  wiki_fts MATCH ? AND path != ?
           ORDER  BY rank
           LIMIT  ?`,
          [query, pagePath, limit],
        )
      ).map(toFTSResult);
    } catch {
      return [];
    }
  }

  /**
   * Multi-field recall: searches title+summary column subset first (fast path),
   * then falls back to full body search if insufficient results.
   */
  recall(query: string, limit = 8): FTSResult[] {
    const results = this.search(query, limit);
    if (results.length >= Math.min(3, limit)) return results;

    // Broaden: try individual terms
    const terms = extractTerms(query, 4);
    if (terms.length === 0) return results;

    const broadResults = this.search(terms.join(" OR "), limit);
    // Merge, dedup by path
    const seen = new Set(results.map((r) => r.path));
    for (const r of broadResults) {
      if (!seen.has(r.path)) {
        results.push(r);
        seen.add(r.path);
      }
    }
    return results.slice(0, limit);
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

// ── Thin SQLite wrapper (bun:sqlite) ──────────────────────
// Wraps bun:sqlite in a sync API consistent with what the rest of the codebase uses.

interface SyncDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get<T>(sql: string, params?: unknown[]): T | null;
  all<T>(sql: string, params?: unknown[]): T[];
  close(): void;
}

function openDb(path: string): SyncDb {
  // bun:sqlite is available at runtime — dynamic import avoids tsc resolution issues
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path, { create: true });

  // WAL mode for concurrent read performance
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  return {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, params: unknown[] = []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.prepare(sql).run(...(params as any[]));
    },
    get<T>(sql: string, params: unknown[] = []): T | null {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (db.prepare(sql).get(...(params as any[])) as T) ?? null;
    },
    all<T>(sql: string, params: unknown[] = []): T[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return db.prepare(sql).all(...(params as any[])) as T[];
    },
    close() {
      db.close();
    },
  };
}

// ── Helpers ───────────────────────────────────────────────

interface RawFTSRow {
  path: string;
  title: string;
  summary: string;
  category: string;
  rank: number;
  snippet: string;
}

function toFTSResult(r: RawFTSRow): FTSResult {
  return {
    path: r.path,
    title: r.title,
    summary: r.summary,
    category: r.category,
    rank: r.rank,
    snippet: r.snippet,
  };
}

/** Sanitise a user-supplied query for FTS5 MATCH — escapes special chars */
function sanitiseFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // If query already looks like a valid FTS5 expression, pass through
  if (/^[\w\s"*^()\-|]+$/.test(trimmed)) {
    // Quote multi-word phrases that aren't already quoted
    if (/\s/.test(trimmed) && !/"/.test(trimmed) && !/ OR | AND /i.test(trimmed)) {
      return `"${trimmed.replace(/"/g, "")}"`;
    }
    return trimmed;
  }

  // Strip unsafe chars and pass individual terms
  return trimmed.replace(/[^\w\s]/g, " ").trim();
}

const STOPWORDS = new Set([
  "the","and","for","with","this","that","from","have","will","been",
  "are","was","were","not","all","can","but","use","used","uses","each",
  "also","any","into","its","more","when","then","than","them","they",
  "which","your","you","has","had","may","how","what","who","where",
  "about","after","before","their","there","here","some","would","should",
  "could","just","been","being","very","such","even","most","over","only",
]);

/** Extract distinctive terms from text (for similarity queries) */
function extractTerms(text: string, max = 8): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, max);
}
