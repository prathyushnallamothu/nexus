/**
 * Nexus Vision Tools
 *
 * Image analysis using vision-capable LLMs.
 * Supports: local files, URLs, base64 data URIs.
 * Providers: Anthropic Claude (ANTHROPIC_API_KEY), OpenAI (OPENAI_API_KEY).
 */

import type { Tool } from "../types.js";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

// ── Helpers ───────────────────────────────────────────────

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp",
  };
  return map[ext.toLowerCase()] ?? "image/jpeg";
}

/** Load image source → { type, data } for API calls */
async function loadImageSource(source: string): Promise<{ b64: string; mimeType: string } | { url: string }> {
  // Already a data URI
  if (source.startsWith("data:")) {
    const [meta, b64] = source.split(",");
    const mimeType = meta.split(";")[0].replace("data:", "");
    return { b64, mimeType };
  }
  // URL — pass directly for APIs that support it, or fetch for others
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return { url: source };
  }
  // Local file
  if (existsSync(source)) {
    const buf = readFileSync(source);
    const b64 = buf.toString("base64");
    const mimeType = mimeFromExt(extname(source));
    return { b64, mimeType };
  }
  throw new Error(`Image source not found: ${source}`);
}

// ── Anthropic vision ──────────────────────────────────────

async function analyzeWithAnthropic(
  imageSource: string,
  prompt: string,
  model: string,
): Promise<string> {
  const src = await loadImageSource(imageSource);

  let imageContent: any;
  if ("url" in src) {
    imageContent = { type: "image", source: { type: "url", url: src.url } };
  } else {
    imageContent = {
      type: "image",
      source: { type: "base64", media_type: src.mimeType, data: src.b64 },
    };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: [imageContent, { type: "text", text: prompt }] }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Anthropic vision error: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return data.content?.[0]?.text ?? "(no response)";
}

// ── OpenAI vision ─────────────────────────────────────────

async function analyzeWithOpenAI(
  imageSource: string,
  prompt: string,
  model: string,
): Promise<string> {
  const src = await loadImageSource(imageSource);

  let imageUrl: string;
  if ("url" in src) {
    imageUrl = src.url;
  } else {
    imageUrl = `data:${src.mimeType};base64,${src.b64}`;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`OpenAI vision error: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "(no response)";
}

// ── Tools ─────────────────────────────────────────────────

export const analyzeImageTool: Tool = {
  schema: {
    name: "analyze_image",
    description:
      "Analyze an image using a vision-capable AI model. Can describe content, read text (OCR), identify objects, " +
      "analyze charts/diagrams, or answer any question about the image. " +
      "Accepts local file paths, URLs, or base64 data URIs.",
    parameters: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Image source: local file path, HTTPS URL, or base64 data URI (data:image/...;base64,...)",
        },
        prompt: {
          type: "string",
          description: "What to analyze or ask about the image. E.g. 'Describe this image', 'Read all text in the image', 'What is shown in this chart?'",
          default: "Describe this image in detail.",
        },
        model: {
          type: "string",
          description: "Model to use. Defaults to best available: claude-opus-4-5 (Anthropic) or gpt-4o (OpenAI).",
        },
      },
      required: ["image"],
    },
  },
  async execute(args) {
    const imageSource = String(args.image);
    const prompt = String(args.prompt ?? "Describe this image in detail.");

    // Anthropic first (best vision quality)
    if (process.env.ANTHROPIC_API_KEY) {
      const model = String(args.model ?? "claude-opus-4-5");
      return await analyzeWithAnthropic(imageSource, prompt, model);
    }

    // OpenAI fallback
    if (process.env.OPENAI_API_KEY) {
      const model = String(args.model ?? "gpt-4o");
      return await analyzeWithOpenAI(imageSource, prompt, model);
    }

    return "Vision analysis unavailable. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable this feature.";
  },
};

export const readTextFromImageTool: Tool = {
  schema: {
    name: "read_text_from_image",
    description:
      "Extract and read all text from an image (OCR). Useful for screenshots, scanned documents, receipts, signs, etc. " +
      "Returns the raw text content found in the image.",
    parameters: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Image source: local file path, HTTPS URL, or base64 data URI",
        },
      },
      required: ["image"],
    },
  },
  async execute(args) {
    const imageSource = String(args.image);
    const prompt = "Extract and return ALL text visible in this image exactly as it appears. Preserve formatting, line breaks, and structure where possible. If there is no text, say 'No text found'.";

    if (process.env.ANTHROPIC_API_KEY) {
      return await analyzeWithAnthropic(imageSource, prompt, "claude-opus-4-5");
    }
    if (process.env.OPENAI_API_KEY) {
      return await analyzeWithOpenAI(imageSource, prompt, "gpt-4o");
    }

    return "Vision/OCR unavailable. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable.";
  },
};

export const visionTools: Tool[] = [analyzeImageTool, readTextFromImageTool];
