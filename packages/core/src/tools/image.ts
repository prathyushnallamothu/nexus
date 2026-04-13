/**
 * Nexus Image Generation Tool
 *
 * Generate images from text prompts via fal.ai or OpenAI DALL-E.
 */

import type { Tool } from "../types.js";

export const generateImageTool: Tool = {
  schema: {
    name: "generate_image",
    description:
      "Generate an image from a text description. Returns a URL to the generated image. " +
      "Requires FAL_API_KEY (fal.ai) or OPENAI_API_KEY (DALL-E 3) to be set.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate",
        },
        size: {
          type: "string",
          description:
            "Image dimensions: '1024x1024' (default), '1792x1024', '1024x1792'",
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

    // ── fal.ai
    if (process.env.FAL_API_KEY) {
      try {
        const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Key ${process.env.FAL_API_KEY}`,
          },
          body: JSON.stringify({
            prompt,
            image_size: size.replace("x", "_").toLowerCase(),
            num_images: 1,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const url = data.images?.[0]?.url ?? data.image?.url;
          if (url) return `Generated image (via fal.ai):\n${url}`;
        }
      } catch {}
    }

    // ── OpenAI DALL-E 3
    if (process.env.OPENAI_API_KEY) {
      try {
        const res = await fetch(
          "https://api.openai.com/v1/images/generations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
          },
        );
        if (res.ok) {
          const data = (await res.json()) as any;
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

/** All image tools */
export const imageTools: Tool[] = [generateImageTool];
