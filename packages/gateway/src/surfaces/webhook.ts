/**
 * Webhook Surface Adapter
 *
 * Handles incoming webhooks from:
 * - GitHub (PR comments, issue mentions, review requests)
 * - Linear (issue assignments, comment mentions)
 * - Jira (issue transitions, comment mentions)
 * - Custom sources
 *
 * Implements the Open SWE pattern:
 * "Deterministic thread IDs from source" — the same GitHub issue always
 * maps to the same session, so follow-up events continue the same conversation.
 */

import { normalizeWebhook, type WebhookConfig, type NormalizedMessage } from "../normalizer.js";
import type { MessageHandler } from "../index.js";

export interface WebhookSurfaceConfig {
  /** Allowed sources and their configurations */
  sources: WebhookSourceConfig[];
  /** Secret for webhook signature verification */
  secret?: string;
}

export interface WebhookSourceConfig extends WebhookConfig {
  /** Path suffix for this source, e.g. '/github' */
  path: string;
  /** Webhook secret for signature verification */
  secret?: string;
  /** Filter: only process these event types */
  eventTypes?: string[];
}

export class WebhookSurface {
  private config: WebhookSurfaceConfig;
  private handler?: MessageHandler;

  constructor(config: WebhookSurfaceConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Handle an incoming webhook request.
   * @param path - the URL path (e.g. '/github')
   * @param headers - request headers (for signature verification)
   * @param body - parsed JSON body
   */
  async handleRequest(
    path: string,
    headers: Record<string, string>,
    body: any,
  ): Promise<{ status: number; body: unknown }> {
    const sourceConfig = this.config.sources.find((s) => path.endsWith(s.path));
    if (!sourceConfig) {
      return { status: 404, body: { error: "Unknown webhook source" } };
    }

    // Verify signature if secret is set
    if (sourceConfig.secret) {
      const valid = await this._verifySignature(sourceConfig.source, sourceConfig.secret, headers, body);
      if (!valid) {
        return { status: 401, body: { error: "Invalid webhook signature" } };
      }
    }

    // Filter by event type
    const eventType = headers["x-github-event"] ?? headers["x-linear-event"] ?? headers["x-event-type"];
    if (sourceConfig.eventTypes?.length && eventType && !sourceConfig.eventTypes.includes(eventType)) {
      return { status: 200, body: { skipped: true, reason: `Event type ${eventType} not in allowlist` } };
    }

    const normalized = normalizeWebhook(body, sourceConfig);
    if (!normalized.content.trim()) {
      return { status: 200, body: { skipped: true, reason: "Empty content" } };
    }

    // Attach reply based on source
    normalized.reply = this._createReplyFn(sourceConfig.source, body);

    this.handler?.(normalized).catch((err) => {
      console.error(`[webhook:${sourceConfig.source}] Handler error:`, err);
    });

    return { status: 200, body: { ok: true } };
  }

  private _createReplyFn(source: string, originalPayload: any): (text: string) => Promise<void> {
    switch (source) {
      case "github":
        return async (text: string) => {
          // Post a comment on the issue/PR
          const repo = originalPayload.repository?.full_name;
          const issueNumber = originalPayload.pull_request?.number ?? originalPayload.issue?.number;
          if (!repo || !issueNumber) return;

          const token = process.env.GITHUB_TOKEN;
          if (!token) { console.warn("[webhook] GITHUB_TOKEN not set"); return; }

          await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({ body: text }),
          });
        };

      case "linear":
        return async (text: string) => {
          const issueId = originalPayload.data?.id;
          if (!issueId) return;

          const token = process.env.LINEAR_API_KEY;
          if (!token) { console.warn("[webhook] LINEAR_API_KEY not set"); return; }

          await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { Authorization: token, "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `mutation { commentCreate(input: { issueId: "${issueId}", body: ${JSON.stringify(text)} }) { success } }`,
            }),
          });
        };

      default:
        return async (text: string) => {
          console.log(`[webhook:${source}] Reply (no send mechanism): ${text}`);
        };
    }
  }

  private async _verifySignature(
    source: string,
    secret: string,
    headers: Record<string, string>,
    body: any,
  ): Promise<boolean> {
    try {
      if (source === "github") {
        const signature = headers["x-hub-signature-256"];
        if (!signature) return false;

        const payload = JSON.stringify(body);
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
        const computed = "sha256=" + Buffer.from(sig).toString("hex");
        return computed === signature;
      }

      return true; // Other sources: skip verification
    } catch {
      return false;
    }
  }
}
