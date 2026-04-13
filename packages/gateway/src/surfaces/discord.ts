/**
 * Discord Surface Adapter
 *
 * Handles:
 * - Receiving events via Discord Interactions API (HTTP-based)
 * - Webhook-based message delivery
 * - Guild/DM awareness
 * - Bot mention filtering
 */

import { normalizeDiscord, type NormalizedMessage } from "../normalizer.js";
import type { MessageHandler } from "../index.js";

export interface DiscordConfig {
  /** Discord Bot Token */
  botToken: string;
  /** Discord Application ID */
  applicationId?: string;
  /** Only respond to direct @mentions */
  mentionOnly?: boolean;
  /** Allowed guild IDs (empty = all guilds) */
  allowedGuilds?: string[];
}

export class DiscordSurface {
  private config: DiscordConfig;
  private handler?: MessageHandler;
  private readonly baseUrl = "https://discord.com/api/v10";

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Handle a raw Discord gateway event (MESSAGE_CREATE, etc.)
   */
  async handleEvent(eventType: string, data: any): Promise<void> {
    if (eventType !== "MESSAGE_CREATE" && eventType !== "MESSAGE_UPDATE") return;

    // Filter bots
    if (data.author?.bot) return;

    // Filter by guild
    if (
      this.config.allowedGuilds?.length &&
      data.guild_id &&
      !this.config.allowedGuilds.includes(data.guild_id)
    ) return;

    const normalized = normalizeDiscord(data);
    if (!normalized.content.trim()) return;

    // Attach reply
    normalized.reply = async (text: string) => {
      await this.sendMessage(data.channel_id, text, data.id);
    };

    this.handler?.(normalized).catch((err) => {
      console.error("[discord] Handler error:", err);
    });
  }

  /**
   * Handle a Discord Interactions webhook payload (slash commands / interactions).
   */
  async handleInteraction(body: any): Promise<{ status: number; body: unknown }> {
    // Interaction PING
    if (body.type === 1) {
      return { status: 200, body: { type: 1 } };
    }

    // Application command (type 2) or component interaction (type 3)
    if (body.type === 2 || body.type === 3) {
      const content = body.data?.options?.[0]?.value ??
        body.data?.custom_id ??
        body.data?.name ?? "";

      const normalized: NormalizedMessage = {
        id: body.id,
        surface: "discord",
        threadId: body.channel_id ?? crypto.randomUUID(),
        author: body.member?.user?.username ?? body.user?.username ?? "unknown",
        content,
        timestamp: Date.now(),
        raw: body,
      };

      // For interactions, we need to defer then follow-up
      const interactionToken = body.token;
      const appId = body.application_id;
      normalized.reply = async (text: string) => {
        await this.sendInteractionFollowup(appId, interactionToken, text);
      };

      // Immediately defer response
      setTimeout(() => {
        this.handler?.(normalized).catch(console.error);
      }, 0);

      return { status: 200, body: { type: 5 } }; // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }

    return { status: 400, body: { error: "Unknown interaction type" } };
  }

  /** Send a message to a Discord channel */
  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<void> {
    const payload: Record<string, unknown> = { content };
    if (replyToMessageId) {
      payload.message_reference = { message_id: replyToMessageId };
    }

    const response = await fetch(`${this.baseUrl}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${this.config.botToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[discord] sendMessage error:", err);
    }
  }

  private async sendInteractionFollowup(appId: string, token: string, content: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/webhooks/${appId}/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[discord] followup error:", err);
    }
  }
}
