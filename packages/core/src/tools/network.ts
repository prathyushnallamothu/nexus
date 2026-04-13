/**
 * Nexus Network Tools
 *
 * HTTP API client and file download tools.
 * - http_request: full REST API client (GET/POST/PUT/PATCH/DELETE)
 * - download_file: download any URL to disk
 * - check_url: check if a URL is reachable and return status/headers
 */

import type { Tool } from "../types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

// ── Helpers ───────────────────────────────────────────────

function parseResponseBody(text: string, contentType: string): string {
  if (contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  if (contentType.includes("text/html")) {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{3,}/g, "\n\n")
      .trim();
  }
  return text;
}

// ── Tools ─────────────────────────────────────────────────

export const httpRequestTool: Tool = {
  schema: {
    name: "http_request",
    description:
      "Make an HTTP request to any URL. Supports GET, POST, PUT, PATCH, DELETE. " +
      "Handles JSON, form data, and plain text bodies. " +
      "Use this for calling REST APIs, webhooks, and web services.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Request URL" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          description: "HTTP method (default: GET)",
          default: "GET",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Request headers (e.g. {'Authorization': 'Bearer token', 'Content-Type': 'application/json'})",
        },
        body: {
          description: "Request body. Objects are JSON-serialized automatically. Strings sent as-is.",
        },
        params: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "URL query parameters (appended to URL)",
        },
        timeout_ms: {
          type: "number",
          description: "Request timeout in milliseconds (default: 30000)",
          default: 30000,
        },
        max_response_chars: {
          type: "number",
          description: "Maximum response body characters to return (default: 10000)",
          default: 10000,
        },
        follow_redirects: {
          type: "boolean",
          description: "Follow HTTP redirects (default: true)",
          default: true,
        },
      },
      required: ["url"],
    },
  },
  async execute(args) {
    let url = String(args.url);
    const method = String(args.method ?? "GET").toUpperCase();
    const timeoutMs = Number(args.timeout_ms ?? 30_000);
    const maxChars = Number(args.max_response_chars ?? 10_000);

    // Append query params
    if (args.params && typeof args.params === "object") {
      const searchParams = new URLSearchParams(args.params as Record<string, string>);
      const qs = searchParams.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }

    // Build headers
    const headers: Record<string, string> = {
      "User-Agent": "Nexus-Agent/1.0",
      ...(args.headers as Record<string, string> ?? {}),
    };

    // Build body
    let bodyStr: string | undefined;
    if (args.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof args.body === "object") {
        bodyStr = JSON.stringify(args.body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      } else {
        bodyStr = String(args.body);
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      redirect: args.follow_redirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const rawText = await res.text();
    const body = parseResponseBody(rawText, contentType);

    // Build response summary
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    const truncated = body.length > maxChars
      ? body.slice(0, maxChars) + `\n\n... (${body.length - maxChars} more chars truncated)`
      : body;

    const statusLine = `HTTP ${res.status} ${res.statusText}`;
    const headerSummary = Object.entries(responseHeaders)
      .filter(([k]) => ["content-type", "content-length", "x-request-id", "location"].includes(k))
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    return `${statusLine}\n${headerSummary}\n\n${truncated}`;
  },
};

export const downloadFileTool: Tool = {
  schema: {
    name: "download_file",
    description:
      "Download a file from a URL and save it to disk. " +
      "Returns the local path and file size. " +
      "Use for downloading documents, images, datasets, and other files.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download from" },
        destination: {
          type: "string",
          description: "Local path to save the file (optional, defaults to current directory with filename from URL)",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional request headers (e.g. for authenticated downloads)",
        },
        timeout_ms: {
          type: "number",
          description: "Download timeout in milliseconds (default: 60000)",
          default: 60000,
        },
      },
      required: ["url"],
    },
  },
  async execute(args) {
    const url = String(args.url);
    const timeoutMs = Number(args.timeout_ms ?? 60_000);

    // Determine destination path
    let dest: string;
    if (args.destination) {
      dest = resolve(String(args.destination));
    } else {
      const urlObj = new URL(url);
      const filename = basename(urlObj.pathname) || "download";
      dest = resolve(process.cwd(), filename);
    }

    // Ensure destination directory exists
    mkdirSync(dirname(dest), { recursive: true });

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Nexus-Agent/1.0",
        ...(args.headers as Record<string, string> ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);

    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);

    const kb = (buf.length / 1024).toFixed(1);
    const mb = (buf.length / (1024 * 1024)).toFixed(2);
    const size = buf.length > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
    const contentType = res.headers.get("content-type") ?? "unknown";

    return `Downloaded ${size} (${contentType})\nSaved to: ${dest}`;
  },
};

export const checkUrlTool: Tool = {
  schema: {
    name: "check_url",
    description:
      "Check if a URL is reachable. Returns HTTP status, response time, " +
      "and key headers. Useful for health checks and URL validation.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to check" },
        method: {
          type: "string",
          enum: ["GET", "HEAD"],
          description: "HTTP method to use (default: HEAD for speed)",
          default: "HEAD",
        },
        timeout_ms: { type: "number", description: "Timeout ms (default: 10000)", default: 10000 },
      },
      required: ["url"],
    },
  },
  async execute(args) {
    const url = String(args.url);
    const method = String(args.method ?? "HEAD").toUpperCase();
    const timeoutMs = Number(args.timeout_ms ?? 10_000);
    const t0 = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: { "User-Agent": "Nexus-Agent/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const ms = Date.now() - t0;

      const headers: string[] = [];
      for (const [k, v] of [
        ["content-type", res.headers.get("content-type")],
        ["content-length", res.headers.get("content-length")],
        ["server", res.headers.get("server")],
        ["last-modified", res.headers.get("last-modified")],
        ["x-powered-by", res.headers.get("x-powered-by")],
      ]) {
        if (v) headers.push(`  ${k}: ${v}`);
      }

      const status = res.ok ? "✓ reachable" : "✗ error";
      return `${status} — HTTP ${res.status} ${res.statusText} (${ms}ms)\n${headers.join("\n")}`;
    } catch (err: any) {
      const ms = Date.now() - t0;
      return `✗ unreachable — ${err.message} (${ms}ms)`;
    }
  },
};

export const networkTools: Tool[] = [httpRequestTool, downloadFileTool, checkUrlTool];
