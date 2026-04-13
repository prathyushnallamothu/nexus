/**
 * Slack Surface Adapter
 *
 * Handles:
 * - Receiving events via Slack Events API (webhook)
 * - Sending replies via Slack Web API
 * - URL verification challenge
 * - Bot mention filtering
 * - Thread-aware conversations
 */

import { normalizeSlack, type NormalizedMessage } from "../normalizer.js";
import type { MessageHandler } from "../index.js";

export interface SlackConfig {
  /** Slack Bot Token (xoxb-...) */
  botToken: string;
  /** Slack Signing Secret for request verification */
  signingSecret?: string;
  /** Only respond to direct mentions? */
  mentionOnly?: boolean;
  /** Bot user ID (to filter self-messages) */
  botUserId?: string;
}

export class SlackSurface {
  private config: SlackConfig;
  private handler?: MessageHandler;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Handle a raw Slack Events API payload.
   * Returns response body for the HTTP layer.
   */
  async handlePayload(body: any): Promise<{ status: number; body: unknown }> {
    // URL verification challenge
    if (body.type === "url_verification") {
      return { status: 200, body: { challenge: body.challenge } };
    }

    const event = body.event;
    if (!event) return { status: 200, body: { ok: true } };

    // Skip bot messages
    if (event.bot_id || event.subtype === "bot_message") {
      return { status: 200, body: { ok: true } };
    }

    // Skip self
    if (this.config.botUserId && event.user === this.config.botUserId) {
      return { status: 200, body: { ok: true } };
    }

    // Only respond to mentions if configured
    if (this.config.mentionOnly && this.config.botUserId) {
      const isMentioned = (event.text ?? "").includes(`<@${this.config.botUserId}>`);
      if (!isMentioned && event.channel_type !== "im") {
        return { status: 200, body: { ok: true } };
      }
    }

    const normalized = normalizeSlack(event, body);
    if (!normalized.content.trim()) return { status: 200, body: { ok: true } };

    // Attach reply function
    normalized.reply = async (text: string) => {
      await this.sendMessage(event.channel, text, event.thread_ts ?? event.ts);
    };

    // Process async (Slack requires 200 within 3 seconds)
    if (this.handler) {
      this.handler(normalized).catch((err) => {
        console.error("[slack] Handler error:", err);
      });
    }

    return { status: 200, body: { ok: true } };
  }

  /** Send a message to a Slack channel */
  async sendMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    const payload: Record<string, unknown> = { channel, text };
    if (threadTs) payload.thread_ts = threadTs;

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.botToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json() as any;
    if (!data.ok) {
      console.error("[slack] sendMessage error:", data.error);
    }
  }

  /** Send a typing indicator */
  async sendTyping(channelId: string): Promise<void> {
    // Slack doesn't have a native typing indicator for bots via Events API
    // This would require WebSocket connection (Bolt SDK)
    void channelId;
  }
}
