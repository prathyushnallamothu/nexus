/**
 * Nexus Web Tools
 *
 * Web search (multi-provider) and URL fetching.
 */

import type { Tool } from "../types.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

/**
 * Search the web. Uses the first available provider:
 *   EXA_API_KEY     → Exa neural search (best quality)
 *   TAVILY_API_KEY  → Tavily search
 *   SERPER_API_KEY  → Serper (Google)
 *   fallback        → DuckDuckGo HTML scrape (free, no key)
 */
export const webSearchTool: Tool = {
  schema: {
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets. Use for anything requiring up-to-date or external knowledge.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        num_results: {
          type: "number",
          description: "Number of results to return (default 5, max 10)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  async execute(args) {
    const query = String(args.query);
    const numResults = Math.min(Number(args.num_results ?? 5), 10);

    // ── Exa
    if (process.env.EXA_API_KEY) {
      try {
        const res = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.EXA_API_KEY,
          },
          body: JSON.stringify({
            query,
            numResults,
            useAutoprompt: true,
            contents: { text: { maxCharacters: 400 } },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const results: SearchResult[] = (data.results ?? []).map(
            (r: any) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.text ?? r.highlights?.[0] ?? "",
              published: r.publishedDate,
            }),
          );
          return formatResults(results, "Exa");
        }
      } catch {}
    }

    // ── Tavily
    if (process.env.TAVILY_API_KEY) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            max_results: numResults,
            search_depth: "basic",
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const results: SearchResult[] = (data.results ?? []).map(
            (r: any) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
              published: r.published_date,
            }),
          );
          return formatResults(results, "Tavily");
        }
      } catch {}
    }

    // ── Serper
    if (process.env.SERPER_API_KEY) {
      try {
        const res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.SERPER_API_KEY,
          },
          body: JSON.stringify({ q: query, num: numResults }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const results: SearchResult[] = (data.organic ?? []).map(
            (r: any) => ({
              title: r.title ?? "",
              url: r.link ?? "",
              snippet: r.snippet ?? "",
              published: r.date,
            }),
          );
          return formatResults(results, "Serper");
        }
      } catch {}
    }

    // ── DuckDuckGo fallback
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encoded}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Nexus/1.0)",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (res.ok) {
        const html = await res.text();
        const results: SearchResult[] = [];
        const blockRe =
          /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match: RegExpExecArray | null;
        while (
          (match = blockRe.exec(html)) !== null &&
          results.length < numResults
        ) {
          let url = match[1];
          try {
            const uddg = new URL(
              url.startsWith("/") ? `https://duckduckgo.com${url}` : url,
            ).searchParams.get("uddg");
            if (uddg) url = decodeURIComponent(uddg);
          } catch {}
          results.push({
            url,
            title: match[2].replace(/<[^>]+>/g, "").trim(),
            snippet: match[3]
              .replace(/<[^>]+>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .trim(),
          });
        }
        if (results.length > 0) return formatResults(results, "DuckDuckGo");
      }
    } catch {}

    return "Web search unavailable. Set EXA_API_KEY, TAVILY_API_KEY, or SERPER_API_KEY for best results.";
  },
};

function formatResults(results: SearchResult[], provider: string): string {
  if (results.length === 0) return `No results found. (via ${provider})`;
  const lines = results.map((r, i) => {
    const pub = r.published ? ` · ${r.published.slice(0, 10)}` : "";
    return `${i + 1}. **${r.title}**${pub}\n   ${r.url}\n   ${r.snippet}`;
  });
  return `Search results (via ${provider}):\n\n${lines.join("\n\n")}`;
}

/**
 * Fetch the text content of any URL.
 */
export const fetchUrlTool: Tool = {
  schema: {
    name: "fetch_url",
    description:
      "Fetch the text content of a URL. Useful for reading documentation, articles, GitHub files, or any web page after a search.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default 8000)",
          default: 8000,
        },
      },
      required: ["url"],
    },
  },
  async execute(args) {
    const url = String(args.url);
    const maxChars = Number(args.max_chars ?? 8000);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Nexus/1.0)" },
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        return `HTTP ${res.status} ${res.statusText} from ${url}`;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();

      let content = text;
      if (contentType.includes("html")) {
        content = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s{3,}/g, "\n\n")
          .trim();
      }

      if (content.length > maxChars) {
        return (
          content.slice(0, maxChars) +
          `\n\n... (truncated, ${content.length - maxChars} more chars)`
        );
      }
      return content || "(empty page)";
    } catch (err: any) {
      if (err.name === "AbortError") return `Timeout fetching ${url}`;
      return `Failed to fetch ${url}: ${err.message}`;
    }
  },
};

/** All web tools */
export const webTools: Tool[] = [webSearchTool, fetchUrlTool];
