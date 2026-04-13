/**
 * Nexus Gateway
 *
 * Single control plane for all surfaces.
 * Every message from every surface (CLI, Web, Slack, Discord, Telegram, Webhooks)
 * flows through the gateway, which:
 *   1. Normalizes the message to a common format
 *   2. Resolves or creates a session (thread-based)
 *   3. Applies rate limiting and auth
 *   4. Routes to the registered message handler
 *   5. Dispatches the response back to the originating surface
 */

export type { NormalizedMessage, Attachment } from "./normalizer.js";
export {
  normalizeSlack,
  normalizeDiscord,
  normalizeTelegram,
  normalizeWebhook,
  normalizeCLI,
  normalizeAPI,
} from "./normalizer.js";

export { SlackSurface, type SlackConfig } from "./surfaces/slack.js";
export { DiscordSurface, type DiscordConfig } from "./surfaces/discord.js";
export { TelegramSurface, type TelegramConfig } from "./surfaces/telegram.js";
export { WebhookSurface, type WebhookSurfaceConfig, type WebhookSourceConfig } from "./surfaces/webhook.js";

import type { NormalizedMessage } from "./normalizer.js";

export type MessageHandler = (msg: NormalizedMessage) => Promise<string | void>;
export type RateLimitFn = (authorId: string, surface: string) => Promise<boolean>;

export interface GatewayOptions {
  /** Rate limiter — return true if allowed, false to reject */
  rateLimit?: RateLimitFn;
  /** Allow list of author IDs (empty = allow all) */
  allowList?: string[];
  /** Block list of author IDs */
  blockList?: string[];
  /** Default session timeout in ms (default: 1 hour) */
  sessionTimeoutMs?: number;
}

export class Gateway {
  private handler?: MessageHandler;
  private opts: GatewayOptions;
  private sessionMap = new Map<string, string>(); // threadId → sessionId
  private rateLimitCounters = new Map<string, { count: number; resetAt: number }>();

  constructor(opts?: GatewayOptions) {
    this.opts = { sessionTimeoutMs: 3_600_000, ...opts };
  }

  /** Register the message handler (usually the agent) */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Dispatch a normalized message through the gateway.
   * This is the main entry point for all surfaces.
   */
  async dispatch(msg: NormalizedMessage): Promise<string | void> {
    // Block list check
    if (this.opts.blockList?.includes(msg.author)) {
      console.warn(`[gateway] Blocked message from ${msg.author}`);
      return;
    }

    // Allow list check
    if (this.opts.allowList?.length && !this.opts.allowList.includes(msg.author)) {
      console.warn(`[gateway] Author ${msg.author} not in allow list`);
      return;
    }

    // Rate limiting
    if (this.opts.rateLimit) {
      const allowed = await this.opts.rateLimit(msg.author, msg.surface);
      if (!allowed) {
        console.warn(`[gateway] Rate limited: ${msg.author} on ${msg.surface}`);
        return "Rate limit exceeded. Please wait before sending another message.";
      }
    }

    // Built-in simple rate limiting (10 messages per minute per author)
    if (!this.opts.rateLimit && !this._checkBuiltinRateLimit(msg.author)) {
      return "Too many requests. Please slow down.";
    }

    if (!this.handler) {
      console.error("[gateway] No message handler registered");
      return;
    }

    return this.handler(msg);
  }

  /** Get or create a session ID for a thread */
  getSessionId(threadId: string): string {
    const existing = this.sessionMap.get(threadId);
    if (existing) return existing;

    const sessionId = crypto.randomUUID();
    this.sessionMap.set(threadId, sessionId);
    return sessionId;
  }

  /** Get all active thread → session mappings */
  getSessions(): Map<string, string> {
    return new Map(this.sessionMap);
  }

  /** Clear a session (force new conversation for this thread) */
  clearSession(threadId: string): void {
    this.sessionMap.delete(threadId);
  }

  private _checkBuiltinRateLimit(authorId: string): boolean {
    const now = Date.now();
    const key = authorId;
    const counter = this.rateLimitCounters.get(key);

    if (!counter || counter.resetAt < now) {
      this.rateLimitCounters.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }

    if (counter.count >= 10) return false;
    counter.count++;
    return true;
  }
}

// ── Singleton factory ─────────────────────────────────────

let _gateway: Gateway | null = null;

export function createGateway(opts?: GatewayOptions): Gateway {
  _gateway = new Gateway(opts);
  return _gateway;
}

export function getGateway(): Gateway | null {
  return _gateway;
}
