/**
 * Telegram Surface Adapter
 *
 * Handles:
 * - Receiving updates via webhook
 * - Sending messages via Bot API
 * - Markdown v2 formatting
 * - Group chat and private chat support
 */

import { normalizeTelegram, type NormalizedMessage } from "../normalizer.js";
import type { MessageHandler } from "../index.js";

export interface TelegramConfig {
  /** Telegram Bot Token */
  botToken: string;
  /** Only process messages from these user IDs (whitelist) */
  allowedUserIds?: number[];
  /** Only process messages from these chat IDs */
  allowedChatIds?: number[];
  /** Parse mode for outgoing messages */
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
}

export class TelegramSurface {
  private config: TelegramConfig;
  private handler?: MessageHandler;
  private readonly apiBase: string;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.apiBase = `https://api.telegram.org/bot${config.botToken}`;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Handle a raw Telegram Update object (from webhook).
   */
  async handleUpdate(update: any): Promise<void> {
    const normalized = normalizeTelegram(update);
    if (!normalized || !normalized.content.trim()) return;

    const msg = update.message ?? update.edited_message;
    if (!msg) return;

    // Allowlist checks
    if (this.config.allowedUserIds?.length && msg.from?.id) {
      if (!this.config.allowedUserIds.includes(msg.from.id)) return;
    }
    if (this.config.allowedChatIds?.length && msg.chat?.id) {
      if (!this.config.allowedChatIds.includes(msg.chat.id)) return;
    }

    const chatId = msg.chat.id;

    // Send typing indicator
    this.sendAction(chatId, "typing").catch(() => {});

    // Attach reply
    normalized.reply = async (text: string) => {
      await this.sendMessage(chatId, text, msg.message_id);
    };

    this.handler?.(normalized).catch((err) => {
      console.error("[telegram] Handler error:", err);
    });
  }

  /** Send a message to a Telegram chat */
  async sendMessage(chatId: number | string, text: string, replyToMessageId?: number): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: this.config.parseMode === "HTML" ? text : this.escapeForMode(text),
      parse_mode: this.config.parseMode ?? "HTML",
    };

    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }

    const response = await fetch(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[telegram] sendMessage error:", err);
    }
  }

  /** Send a chat action (typing, upload_document, etc.) */
  async sendAction(chatId: number | string, action: string): Promise<void> {
    await fetch(`${this.apiBase}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  }

  /**
   * Set the webhook URL for this bot.
   * Call this once during setup.
   */
  async setWebhook(url: string): Promise<boolean> {
    const response = await fetch(`${this.apiBase}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, max_connections: 40 }),
    });
    const data = await response.json() as any;
    return data.ok === true;
  }

  /** Get bot info */
  async getMe(): Promise<any> {
    const response = await fetch(`${this.apiBase}/getMe`);
    return response.json();
  }

  private escapeForMode(text: string): string {
    if (this.config.parseMode === "MarkdownV2") {
      return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
    }
    return text;
  }
}
