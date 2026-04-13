/**
 * Nexus Data Tools
 *
 * Tools for reading and querying structured data:
 * - CSV: parse and query CSV files
 * - JSON: read and jq-style query JSON
 * - SQLite: execute SQL queries against SQLite databases
 * - PDF: extract text from PDF files
 * - Excel: read XLSX/CSV spreadsheets
 */

import type { Tool } from "../types.js";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── CSV ───────────────────────────────────────────────────

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length === 0) return [];

  // Parse a single CSV line handling quoted fields
  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

export const readCsvTool: Tool = {
  schema: {
    name: "read_csv",
    description:
      "Read a CSV file and return its contents as structured data. " +
      "Can filter rows, select columns, and limit results.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the CSV file" },
        columns: {
          type: "array", items: { type: "string" },
          description: "Only return these columns (optional, returns all if omitted)",
        },
        filter_column: { type: "string", description: "Filter rows by this column" },
        filter_value: { type: "string", description: "Only include rows where filter_column contains this value" },
        limit: { type: "number", description: "Maximum rows to return (default: 100)", default: 100 },
        offset: { type: "number", description: "Skip this many rows (default: 0)", default: 0 },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const content = readFileSync(filePath, "utf-8");
    let rows = parseCSV(content);
    const totalRows = rows.length;

    // Filter
    if (args.filter_column && args.filter_value) {
      const col = String(args.filter_column);
      const val = String(args.filter_value).toLowerCase();
      rows = rows.filter(r => (r[col] ?? "").toLowerCase().includes(val));
    }

    // Select columns
    if (Array.isArray(args.columns) && args.columns.length > 0) {
      const cols = args.columns.map(String);
      rows = rows.map(r => {
        const out: Record<string, string> = {};
        for (const c of cols) out[c] = r[c] ?? "";
        return out;
      });
    }

    // Paginate
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 100);
    const page = rows.slice(offset, offset + limit);

    const summary = `CSV: ${totalRows} total rows, showing ${page.length} (offset ${offset})`;
    if (page.length === 0) return `${summary}\n(no matching rows)`;

    // Format as table
    const headers = Object.keys(page[0]);
    const widths = headers.map(h => Math.max(h.length, ...page.map(r => (r[h] ?? "").length)));
    const sep = widths.map(w => "─".repeat(w)).join("─┼─");
    const head = headers.map((h, i) => h.padEnd(widths[i])).join(" │ ");
    const body = page.map(r => headers.map((h, i) => (r[h] ?? "").padEnd(widths[i])).join(" │ ")).join("\n");

    return `${summary}\n\n${head}\n${sep}\n${body}`;
  },
};

// ── JSON ──────────────────────────────────────────────────

export const readJsonTool: Tool = {
  schema: {
    name: "read_json",
    description:
      "Read a JSON file and optionally extract a nested value using dot-notation path. " +
      "Example path: 'users.0.name' or 'config.database.host'",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the JSON file" },
        query: {
          type: "string",
          description: "Dot-notation path to extract (e.g. 'data.items.0'), or leave empty for full content",
        },
        pretty: {
          type: "boolean",
          description: "Pretty-print the output (default: true)",
          default: true,
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default: 8000)",
          default: 8000,
        },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    let data: any;
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (e: any) {
      throw new Error(`Invalid JSON in ${filePath}: ${e.message}`);
    }

    // Apply dot-notation query
    if (args.query) {
      const parts = String(args.query).split(".");
      let current = data;
      for (const part of parts) {
        if (current == null) { data = null; break; }
        current = current[part] ?? current[parseInt(part)];
      }
      data = current;
    }

    const out = args.pretty !== false
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);

    const maxChars = Number(args.max_chars ?? 8000);
    if (out.length > maxChars) {
      return out.slice(0, maxChars) + `\n\n... (${out.length - maxChars} more chars truncated)`;
    }
    return out;
  },
};

// ── SQLite ────────────────────────────────────────────────

export const querySqliteTool: Tool = {
  schema: {
    name: "query_sqlite",
    description:
      "Execute a SQL query against a SQLite database file. " +
      "Use SELECT for reading data, or INSERT/UPDATE/DELETE for modifications. " +
      "Returns results as a formatted table.",
    parameters: {
      type: "object",
      properties: {
        database: { type: "string", description: "Path to the SQLite database file (.db or .sqlite)" },
        sql: { type: "string", description: "SQL query to execute" },
        params: {
          type: "array", items: {},
          description: "Query parameters for parameterized queries (prevents SQL injection)",
        },
        limit: { type: "number", description: "Maximum rows to return (default: 50)", default: 50 },
      },
      required: ["database", "sql"],
    },
  },
  async execute(args) {
    const dbPath = resolve(String(args.database));
    if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

    const sql = String(args.sql);
    const params = Array.isArray(args.params) ? args.params : [];
    const limit = Number(args.limit ?? 50);

    // Try bun:sqlite first (zero dependencies)
    try {
      const { Database } = await import("bun:sqlite" as any);
      const db = new Database(dbPath, { readonly: sql.trim().toUpperCase().startsWith("SELECT") });
      try {
        const stmt = db.prepare(sql);
        if (sql.trim().toUpperCase().startsWith("SELECT")) {
          const rows = stmt.all(...params).slice(0, limit) as Record<string, any>[];
          if (rows.length === 0) return "Query returned 0 rows.";

          const headers = Object.keys(rows[0]);
          const widths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? "").length)));
          const head = headers.map((h, i) => h.padEnd(widths[i])).join(" │ ");
          const sep = widths.map(w => "─".repeat(w)).join("─┼─");
          const body = rows.map(r => headers.map((h, i) => String(r[h] ?? "").padEnd(widths[i])).join(" │ ")).join("\n");
          return `${rows.length} row(s):\n\n${head}\n${sep}\n${body}`;
        } else {
          const result = stmt.run(...params) as any;
          return `Query OK. Changes: ${result.changes ?? 0}, Last insert ID: ${result.lastInsertRowid ?? "N/A"}`;
        }
      } finally {
        db.close();
      }
    } catch (bunErr: any) {
      // If bun:sqlite not available, try better-sqlite3
      try {
        const Database = require("better-sqlite3");
        const db = new Database(dbPath, { readonly: sql.trim().toUpperCase().startsWith("SELECT") });
        try {
          const stmt = db.prepare(sql);
          if (sql.trim().toUpperCase().startsWith("SELECT")) {
            const rows = (stmt.all(...params) as Record<string, any>[]).slice(0, limit);
            if (rows.length === 0) return "Query returned 0 rows.";
            return `${rows.length} row(s):\n\n${JSON.stringify(rows, null, 2)}`;
          } else {
            const result = stmt.run(...params) as any;
            return `Query OK. Changes: ${result.changes ?? 0}`;
          }
        } finally {
          db.close();
        }
      } catch {
        throw new Error(`SQLite unavailable: ${bunErr.message}. Install better-sqlite3 or run in Bun.`);
      }
    }
  },
};

// ── PDF ───────────────────────────────────────────────────

export const readPdfTool: Tool = {
  schema: {
    name: "read_pdf",
    description:
      "Extract text content from a PDF file. " +
      "Returns the readable text from the PDF, page by page. " +
      "Requires pdf-parse (bun add pdf-parse) or falls back to pdftotext (poppler-utils).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the PDF file" },
        pages: {
          type: "string",
          description: "Page range to extract, e.g. '1-5', '1,3,5', or 'all' (default: all)",
          default: "all",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default: 20000)",
          default: 20000,
        },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) throw new Error(`PDF not found: ${filePath}`);

    const maxChars = Number(args.max_chars ?? 20_000);
    const pagesArg = String(args.pages ?? "all");

    // Try pdf-parse
    try {
      const pdfParse = (await import("pdf-parse" as any)).default;
      const buf = readFileSync(filePath);
      const data = await pdfParse(buf);

      let text: string = data.text;
      const totalPages = data.numpages;

      // Page filtering (simple: just truncate for now since pdf-parse gives full text)
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n\n... (${text.length - maxChars} more chars, ${totalPages} pages total)`;
      }
      return `PDF: ${totalPages} pages\n\n${text}`;
    } catch (pdfParseErr) {
      // Fallback: pdftotext CLI (poppler-utils)
      try {
        const { execSync } = await import("node:child_process");
        const out = execSync(`pdftotext "${filePath}" -`, {
          encoding: "utf-8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        });
        const text = out.length > maxChars ? out.slice(0, maxChars) + "\n\n... (truncated)" : out;
        return `PDF content (via pdftotext):\n\n${text}`;
      } catch {
        throw new Error(
          `Cannot read PDF: no suitable library found. ` +
          `Install pdf-parse (bun add pdf-parse) or poppler-utils (brew install poppler).`
        );
      }
    }
  },
};

// ── XML ───────────────────────────────────────────────────

export const readXmlTool: Tool = {
  schema: {
    name: "read_xml",
    description:
      "Read and parse an XML file, returning its content as formatted JSON or plain text. " +
      "Useful for config files, RSS feeds, SVG files, and API responses.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the XML file" },
        max_chars: { type: "number", description: "Maximum characters to return (default: 8000)", default: 8000 },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const content = readFileSync(filePath, "utf-8");
    const maxChars = Number(args.max_chars ?? 8000);

    // Try fast-xml-parser if available
    try {
      const { XMLParser } = await import("fast-xml-parser" as any);
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
      const parsed = parser.parse(content);
      const out = JSON.stringify(parsed, null, 2);
      return out.length > maxChars ? out.slice(0, maxChars) + "\n\n... (truncated)" : out;
    } catch {
      // Return raw XML truncated
      return content.length > maxChars ? content.slice(0, maxChars) + "\n\n... (truncated)" : content;
    }
  },
};

// ── Write JSON helper ─────────────────────────────────────

export const writeJsonTool: Tool = {
  schema: {
    name: "write_json",
    description: "Write data as a formatted JSON file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write to" },
        data: { description: "Data to serialize as JSON (any value)" },
        pretty: { type: "boolean", description: "Pretty-print (default: true)", default: true },
      },
      required: ["path", "data"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    const out = args.pretty !== false
      ? JSON.stringify(args.data, null, 2)
      : JSON.stringify(args.data);
    writeFileSync(filePath, out, "utf-8");
    return `Written ${out.length} chars to ${filePath}`;
  },
};

export const dataTools: Tool[] = [
  readCsvTool,
  readJsonTool,
  writeJsonTool,
  querySqliteTool,
  readPdfTool,
  readXmlTool,
];
