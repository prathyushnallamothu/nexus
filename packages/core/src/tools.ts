/**
 * Nexus Built-in Tools
 *
 * The seed toolset for a coding agent.
 * Tool curation matters more than tool quantity.
 */

import type { Tool } from "./types.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Read a file from disk.
 */
export const readFileTool: Tool = {
  schema: {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the full file content as a string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      if (lines.length > 500) {
        return `${lines.slice(0, 500).join("\n")}\n\n... (${lines.length - 500} more lines truncated)`;
      }
      return content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read file "${filePath}": ${msg}`);
    }
  },
};

/**
 * Write content to a file, creating directories as needed.
 */
export const writeFileTool: Tool = {
  schema: {
    name: "write_file",
    description:
      "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    const content = String(args.content);
    try {
      const dir = filePath.replace(/[/\\][^/\\]*$/, "");
      if (!existsSync(dir)) {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, content, "utf-8");
      return `File written: ${filePath} (${content.length} chars)`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write file "${filePath}": ${msg}`);
    }
  },
};

/**
 * List files in a directory.
 */
export const listFilesTool: Tool = {
  schema: {
    name: "list_files",
    description:
      "List files and directories in a given path. Returns names with type indicators (/ for dirs).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list. Defaults to current directory.",
          default: ".",
        },
      },
    },
  },
  async execute(args) {
    const dirPath = resolve(String(args.path ?? "."));
    try {
      const entries = readdirSync(dirPath);
      const result = entries.map((entry) => {
        try {
          const fullPath = join(dirPath, entry);
          const stat = statSync(fullPath);
          return stat.isDirectory() ? `${entry}/` : entry;
        } catch {
          return entry;
        }
      });
      return result.join("\n") || "(empty directory)";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list directory "${dirPath}": ${msg}`);
    }
  },
};

/**
 * Run a shell command.
 */
export const shellTool: Tool = {
  schema: {
    name: "shell",
    description:
      "Execute a shell command and return its output. Use for running scripts, installing packages, git operations, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: {
          type: "string",
          description: "Working directory for the command. Defaults to current directory.",
        },
      },
      required: ["command"],
    },
  },
  async execute(args) {
    const command = String(args.command);
    const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd();
    try {
      const output = execSync(command, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024, // 1MB
        stdio: ["pipe", "pipe", "pipe"],
      });
      const trimmed = output.trim();
      if (trimmed.length > 10_000) {
        return trimmed.slice(0, 10_000) + "\n\n... (output truncated)";
      }
      return trimmed || "(no output)";
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const stderr = execError.stderr ?? execError.message ?? String(error);
      throw new Error(`Command failed: ${stderr}`);
    }
  },
};

/**
 * Search for text in files (like grep/ripgrep).
 */
export const searchFilesTool: Tool = {
  schema: {
    name: "search_files",
    description:
      "Search for a text pattern in files within a directory. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regex pattern to search for" },
        path: {
          type: "string",
          description: "Directory to search in. Defaults to current directory.",
          default: ".",
        },
        include: {
          type: "string",
          description: "File glob pattern to include, e.g. '*.ts' or '*.py'",
        },
      },
      required: ["pattern"],
    },
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const searchPath = resolve(String(args.path ?? "."));
    const include = args.include ? `--include="${args.include}"` : "";

    try {
      // Try ripgrep first, fall back to findstr on Windows
      const isWindows = process.platform === "win32";
      let command: string;

      if (isWindows) {
        command = `findstr /S /N /I /C:"${pattern.replace(/"/g, "")}" "${searchPath}\\*"`;
        if (args.include) {
          const ext = String(args.include).replace("*", "");
          command = `findstr /S /N /I /C:"${pattern.replace(/"/g, "")}" "${searchPath}\\*${ext}"`;
        }
      } else {
        command = `grep -rn ${include} "${pattern}" "${searchPath}" 2>/dev/null | head -50`;
      }

      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 512 * 1024,
      }).trim();

      if (!output) return "No matches found.";
      const lines = output.split("\n");
      if (lines.length > 50) {
        return lines.slice(0, 50).join("\n") + `\n\n... (${lines.length - 50} more matches)`;
      }
      return output;
    } catch {
      return "No matches found.";
    }
  },
};

// ── Web Search ────────────────────────────────────────────

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

    // ── Exa ──────────────────────────────────────────────
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
          const data = await res.json() as any;
          const results: SearchResult[] = (data.results ?? []).map((r: any) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.text ?? r.highlights?.[0] ?? "",
            published: r.publishedDate,
          }));
          return formatResults(results, "Exa");
        }
      } catch {}
    }

    // ── Tavily ───────────────────────────────────────────
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
          const data = await res.json() as any;
          const results: SearchResult[] = (data.results ?? []).map((r: any) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.content ?? "",
            published: r.published_date,
          }));
          return formatResults(results, "Tavily");
        }
      } catch {}
    }

    // ── Serper ───────────────────────────────────────────
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
          const data = await res.json() as any;
          const results: SearchResult[] = (data.organic ?? []).map((r: any) => ({
            title: r.title ?? "",
            url: r.link ?? "",
            snippet: r.snippet ?? "",
            published: r.date,
          }));
          return formatResults(results, "Serper");
        }
      } catch {}
    }

    // ── DuckDuckGo HTML fallback (no key needed) ─────────
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Nexus/1.0)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const html = await res.text();
        const results: SearchResult[] = [];
        // Parse result blocks from DDG HTML
        const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match: RegExpExecArray | null;
        while ((match = blockRe.exec(html)) !== null && results.length < numResults) {
          // Unwrap DDG redirect URLs to get the real destination
          let url = match[1];
          try {
            const uddg = new URL(url.startsWith("/") ? `https://duckduckgo.com${url}` : url).searchParams.get("uddg");
            if (uddg) url = decodeURIComponent(uddg);
          } catch {}
          results.push({
            url,
            title: match[2].replace(/<[^>]+>/g, "").trim(),
            snippet: match[3].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim(),
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

      // Strip HTML tags for readability
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
        return content.slice(0, maxChars) + `\n\n... (truncated, ${content.length - maxChars} more chars)`;
      }
      return content || "(empty page)";
    } catch (err: any) {
      if (err.name === "AbortError") return `Timeout fetching ${url}`;
      return `Failed to fetch ${url}: ${err.message}`;
    }
  },
};

// ── Code Execution Sandbox ────────────────────────────────

/**
 * Run arbitrary code in an isolated environment.
 * Uses Docker when available, falls back to local execution with a warning.
 */
export const runCodeTool: Tool = {
  schema: {
    name: "run_code",
    description:
      "Execute code in an isolated sandbox. Supports Python, JavaScript/Node.js, TypeScript (via tsx), Bash, and Ruby. " +
      "Returns stdout, stderr, and exit code. Use for testing algorithms, running calculations, or validating code snippets.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Language: 'python', 'javascript', 'typescript', 'bash', 'ruby'",
          enum: ["python", "javascript", "typescript", "bash", "ruby"],
        },
        code: { type: "string", description: "Code to execute" },
        timeout_ms: {
          type: "number",
          description: "Max execution time in milliseconds (default 15000, max 60000)",
          default: 15000,
        },
      },
      required: ["language", "code"],
    },
  },
  async execute(args) {
    const { exec: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const execAsync = promisify(execCb);
    const lang = String(args.language).toLowerCase();
    const code = String(args.code);
    const timeoutMs = Math.min(Number(args.timeout_ms ?? 15_000), 60_000);

    // Write code to a temp file
    const ext: Record<string, string> = {
      python: "py",
      javascript: "js",
      typescript: "ts",
      bash: "sh",
      ruby: "rb",
    };
    const fileExt = ext[lang] ?? "txt";
    let workDir: string | null = null;

    try {
      workDir = mkdtempSync(join(tmpdir(), "nexus-run-"));
      const filePath = join(workDir, `code.${fileExt}`);
      writeFileSync(filePath, code, "utf-8");

      // Build run command
      const runners: Record<string, string> = {
        python: `python3 "${filePath}"`,
        javascript: `node "${filePath}"`,
        typescript: `npx tsx "${filePath}"`,
        bash: `bash "${filePath}"`,
        ruby: `ruby "${filePath}"`,
      };
      const command = runners[lang];
      if (!command) throw new Error(`Unsupported language: ${lang}`);

      // Try Docker if available, fallback to local
      let useDocker = false;
      try {
        execCb("docker info", { stdio: "ignore" } as any);
        useDocker = false; // Keep local for now — Docker needs language-specific images
      } catch {}

      const dockerImages: Record<string, string> = {
        python: "python:3.11-slim",
        javascript: "node:20-slim",
        typescript: "node:20-slim",
        bash: "alpine:latest",
        ruby: "ruby:3.2-slim",
      };

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      if (useDocker && dockerImages[lang]) {
        const image = dockerImages[lang];
        const mountCmd = lang === "typescript"
          ? `docker run --rm --memory 256m --network none -v "${workDir}:/code" -w /code ${image} sh -c "npm install -g tsx 2>/dev/null; tsx code.ts"`
          : `docker run --rm --memory 256m --network none -v "${workDir}:/code" -w /code ${image} ${lang === "python" ? "python3 code.py" : lang === "bash" ? "bash code.sh" : "node code.js"}`;
        try {
          const result = await execAsync(mountCmd, { timeout: timeoutMs });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (err: any) {
          stdout = err.stdout ?? "";
          stderr = err.stderr ?? err.message;
          exitCode = err.code ?? 1;
        }
      } else {
        try {
          const result = await execAsync(command, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
          });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (err: any) {
          stdout = err.stdout ?? "";
          stderr = err.stderr ?? err.message;
          exitCode = typeof err.code === "number" ? err.code : 1;
        }
      }

      const parts: string[] = [];
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
      parts.push(`exit code: ${exitCode}`);
      return parts.join("\n\n");
    } finally {
      if (workDir) {
        try { rmSync(workDir, { recursive: true }); } catch {}
      }
    }
  },
};

// ── Image Generation ──────────────────────────────────────

/**
 * Generate an image from a text prompt.
 * Supports fal.ai (FAL_API_KEY) and OpenAI DALL-E (OPENAI_API_KEY).
 * Returns the image URL or a base64 data URI.
 */
export const generateImageTool: Tool = {
  schema: {
    name: "generate_image",
    description:
      "Generate an image from a text description. Returns a URL to the generated image. " +
      "Requires FAL_API_KEY (fal.ai) or OPENAI_API_KEY (DALL-E 3) to be set.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate" },
        size: {
          type: "string",
          description: "Image dimensions: '1024x1024' (default), '1792x1024', '1024x1792'",
          default: "1024x1024",
        },
        style: {
          type: "string",
          description: "Style hint: 'natural' or 'vivid' (DALL-E only)",
          default: "natural",
        },
      },
      required: ["prompt"],
    },
  },
  async execute(args) {
    const prompt = String(args.prompt);
    const size = String(args.size ?? "1024x1024");
    const style = String(args.style ?? "natural");

    // ── fal.ai ────────────────────────────────────────────
    if (process.env.FAL_API_KEY) {
      try {
        const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Key ${process.env.FAL_API_KEY}`,
          },
          body: JSON.stringify({
            prompt,
            image_size: size.replace("x", "_").toLowerCase(),
            num_images: 1,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const url = data.images?.[0]?.url ?? data.image?.url;
          if (url) return `Generated image (via fal.ai):\n${url}`;
        }
      } catch {}
    }

    // ── OpenAI DALL-E 3 ───────────────────────────────────
    if (process.env.OPENAI_API_KEY) {
      try {
        const res = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt,
            n: 1,
            size,
            style,
            response_format: "url",
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const url = data.data?.[0]?.url;
          if (url) return `Generated image (via DALL-E 3):\n${url}`;
        }
      } catch {}
    }

    return (
      "Image generation unavailable. Set FAL_API_KEY (fal.ai/flux) or OPENAI_API_KEY (DALL-E 3) to enable this feature.\n" +
      `Prompt was: "${prompt}"`
    );
  },
};

/** All built-in tools */
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  shellTool,
  searchFilesTool,
  webSearchTool,
  fetchUrlTool,
  runCodeTool,
  generateImageTool,
];
