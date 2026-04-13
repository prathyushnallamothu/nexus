/**
 * Nexus Browser Tools
 *
 * Playwright-based browser automation.
 * Gracefully degrades when Playwright is not installed:
 *   - screenshot_url → falls back to fetch + html2text
 *   - scrape_page → falls back to fetch
 *   - browser_click / browser_fill → require Playwright
 *
 * Install Playwright: bun add playwright && bunx playwright install chromium
 */

import type { Tool } from "../types.js";

// ── Playwright availability ───────────────────────────────

let _playwright: any = null;
let _playwrightChecked = false;

async function getPlaywright(): Promise<any | null> {
  if (_playwrightChecked) return _playwright;
  _playwrightChecked = true;
  try {
    // Dynamic import — playwright is optional; don't fail if not installed
    _playwright = await (Function('m', 'return import(m)') as any)("playwright");
    return _playwright;
  } catch {
    return null;
  }
}

// ── Shared browser instance (lazy, reused) ────────────────

let _browser: any = null;
let _browserContext: any = null;

async function getBrowser(): Promise<{ browser: any; context: any } | null> {
  const pw = await getPlaywright();
  if (!pw) return null;

  if (!_browser || !_browser.isConnected()) {
    _browser = await pw.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    _browserContext = await _browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
  }

  return { browser: _browser, context: _browserContext };
}

// ── HTML → plain text (lightweight) ──────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// ── Tools ─────────────────────────────────────────────────

export const screenshotUrlTool: Tool = {
  schema: {
    name: "screenshot_url",
    description:
      "Take a screenshot of a webpage and return it as a base64 PNG. " +
      "Useful for visually inspecting a page, capturing UI state, or analyzing rendered content. " +
      "Requires Playwright (bun add playwright && bunx playwright install chromium).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to screenshot" },
        full_page: {
          type: "boolean",
          description: "Capture the full scrollable page (default: false = viewport only)",
          default: false,
        },
        wait_ms: {
          type: "number",
          description: "Milliseconds to wait after page load before screenshotting (default: 1000)",
          default: 1000,
        },
        selector: {
          type: "string",
          description: "CSS selector — screenshot only this element (optional)",
        },
      },
      required: ["url"],
    },
  },
  async execute(args) {
    const url = String(args.url);
    const fullPage = Boolean(args.full_page ?? false);
    const waitMs = Number(args.wait_ms ?? 1000);
    const selector = args.selector ? String(args.selector) : null;

    const br = await getBrowser();
    if (!br) {
      return "screenshot_url requires Playwright. Run: bun add playwright && bunx playwright install chromium";
    }

    const page = await br.context.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      if (waitMs > 0) await page.waitForTimeout(waitMs);

      let buf: Buffer;
      if (selector) {
        const el = await page.$(selector);
        if (!el) throw new Error(`Selector "${selector}" not found on page`);
        buf = await el.screenshot({ type: "png" });
      } else {
        buf = await page.screenshot({ type: "png", fullPage });
      }

      const b64 = buf.toString("base64");
      return `data:image/png;base64,${b64}`;
    } finally {
      await page.close();
    }
  },
};

export const scrapePageTool: Tool = {
  schema: {
    name: "scrape_page",
    description:
      "Scrape a webpage and return its clean text content. " +
      "Uses Playwright for JavaScript-rendered pages when available, " +
      "falls back to plain HTTP fetch for static pages. " +
      "Better than fetch_url for SPAs and dynamically rendered content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to scrape" },
        selector: {
          type: "string",
          description: "CSS selector to extract specific content (optional, e.g. 'article', 'main', '#content')",
        },
        wait_for: {
          type: "string",
          description: "CSS selector to wait for before extracting (optional, for dynamic pages)",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default: 10000)",
          default: 10000,
        },
      },
      required: ["url"],
    },
  },
  async execute(args) {
    const url = String(args.url);
    const selector = args.selector ? String(args.selector) : null;
    const waitFor = args.wait_for ? String(args.wait_for) : null;
    const maxChars = Number(args.max_chars ?? 10_000);

    const br = await getBrowser();

    if (br) {
      // Playwright path — handles JS-rendered pages
      const page = await br.context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (waitFor) {
          await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
        }
        await page.waitForTimeout(500);

        let text: string;
        if (selector) {
          const el = await page.$(selector);
          text = el ? await el.innerText() : await page.innerText("body");
        } else {
          text = await page.innerText("body");
        }

        text = text.replace(/\s{3,}/g, "\n\n").trim();
        if (text.length > maxChars) {
          return text.slice(0, maxChars) + `\n\n... (${text.length - maxChars} more chars truncated)`;
        }
        return text || "(empty page)";
      } finally {
        await page.close();
      }
    }

    // HTTP fallback
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Nexus/1.0)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return `HTTP ${res.status} ${res.statusText}`;
    const html = await res.text();
    const text = htmlToText(html);
    return text.length > maxChars ? text.slice(0, maxChars) + `\n\n... (truncated)` : text;
  },
};

export const browserClickTool: Tool = {
  schema: {
    name: "browser_click",
    description:
      "Click an element on a webpage. Use for navigation, button clicks, and form interactions. " +
      "Returns the page content after clicking. Requires Playwright.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to first (if not already open)" },
        selector: { type: "string", description: "CSS selector or text to click (e.g. 'button[type=submit]', 'text=Login')" },
        wait_for: { type: "string", description: "CSS selector to wait for after clicking" },
      },
      required: ["url", "selector"],
    },
  },
  async execute(args) {
    const br = await getBrowser();
    if (!br) return "browser_click requires Playwright. Run: bun add playwright && bunx playwright install chromium";

    const page = await br.context.newPage();
    try {
      await page.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.click(String(args.selector), { timeout: 10_000 });

      if (args.wait_for) {
        await page.waitForSelector(String(args.wait_for), { timeout: 10_000 }).catch(() => {});
      } else {
        await page.waitForTimeout(1000);
      }

      const text = await page.innerText("body");
      return text.replace(/\s{3,}/g, "\n\n").trim().slice(0, 5000);
    } finally {
      await page.close();
    }
  },
};

export const browserFillTool: Tool = {
  schema: {
    name: "browser_fill",
    description:
      "Fill in a form on a webpage and optionally submit it. " +
      "Useful for search forms, login pages, and data entry. Requires Playwright.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        fields: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Map of CSS selectors to values, e.g. {'#username': 'admin', '#password': 'secret'}",
        },
        submit_selector: {
          type: "string",
          description: "Selector to click after filling (e.g. 'button[type=submit]')",
        },
        wait_for: {
          type: "string",
          description: "Selector to wait for after submission",
        },
      },
      required: ["url", "fields"],
    },
  },
  async execute(args) {
    const br = await getBrowser();
    if (!br) return "browser_fill requires Playwright. Run: bun add playwright && bunx playwright install chromium";

    const page = await br.context.newPage();
    try {
      await page.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });

      const fields = (args.fields ?? {}) as Record<string, string>;
      for (const [selector, value] of Object.entries(fields)) {
        await page.fill(selector, value, { timeout: 5_000 });
      }

      if (args.submit_selector) {
        await page.click(String(args.submit_selector), { timeout: 5_000 });
        if (args.wait_for) {
          await page.waitForSelector(String(args.wait_for), { timeout: 10_000 }).catch(() => {});
        } else {
          await page.waitForTimeout(1500);
        }
      }

      const text = await page.innerText("body");
      return text.replace(/\s{3,}/g, "\n\n").trim().slice(0, 5000);
    } finally {
      await page.close();
    }
  },
};

export const browserEvalTool: Tool = {
  schema: {
    name: "browser_eval",
    description:
      "Execute JavaScript in a browser page and return the result. " +
      "Useful for extracting data, checking state, or interacting with page objects. Requires Playwright.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        script: { type: "string", description: "JavaScript expression or function body to evaluate in the page context" },
      },
      required: ["url", "script"],
    },
  },
  async execute(args) {
    const br = await getBrowser();
    if (!br) return "browser_eval requires Playwright. Run: bun add playwright && bunx playwright install chromium";

    const page = await br.context.newPage();
    try {
      await page.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(500);
      const result = await page.evaluate(String(args.script));
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } finally {
      await page.close();
    }
  },
};

export const browserTools: Tool[] = [
  screenshotUrlTool,
  scrapePageTool,
  browserClickTool,
  browserFillTool,
  browserEvalTool,
];
