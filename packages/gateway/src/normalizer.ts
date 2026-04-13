/**
 * Nexus Message Normalizer
 *
 * Converts platform-specific message payloads (Slack, Discord, Telegram, etc.)
 * into a unified NormalizedMessage format that the agent core understands.
 * All surfaces produce the same type — the agent never knows which surface
 * a message came from.
 */

export interface NormalizedMessage {
  /** Unique message ID */
  id: string;
  /** Which surface this came from */
  surface: "slack" | "discord" | "telegram" | "cli" | "web" | "api" | "webhook" | "whatsapp";
  /** Thread/channel/conversation identifier — maps to a session */
  threadId: string;
  /** Author identifier (user ID or display name) */
  author: string;
  /** The text content */
  content: string;
  /** Attachments (files, images) */
  attachments?: Attachment[];
  /** Unix timestamp in ms */
  timestamp: number;
  /** Raw platform payload for platform-specific features */
  raw?: unknown;
  /** Reply function — call this to send a response back */
  reply?: (text: string) => Promise<void>;
}

export interface Attachment {
  type: "image" | "file" | "audio";
  url?: string;
  name?: string;
  mimeType?: string;
  data?: Buffer;
}

// ── Slack ─────────────────────────────────────────────────

export function normalizeSlack(event: any, body: any): NormalizedMessage {
  return {
    id: body.event_id ?? crypto.randomUUID(),
    surface: "slack",
    threadId: event.thread_ts ?? event.channel ?? crypto.randomUUID(),
    author: event.user ?? "unknown",
    content: stripSlackMentions(event.text ?? ""),
    timestamp: event.ts ? parseFloat(event.ts) * 1000 : Date.now(),
    raw: { event, body },
  };
}

function stripSlackMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, "")
    .trim();
}

// ── Discord ───────────────────────────────────────────────

export function normalizeDiscord(message: any): NormalizedMessage {
  return {
    id: message.id ?? crypto.randomUUID(),
    surface: "discord",
    threadId: message.channel_id ?? message.channelId ?? crypto.randomUUID(),
    author: message.author?.username ?? message.author?.id ?? "unknown",
    content: stripDiscordMentions(message.content ?? ""),
    timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
    raw: message,
  };
}

function stripDiscordMentions(text: string): string {
  return text.replace(/<@!?[0-9]+>/g, "").trim();
}

// ── Telegram ──────────────────────────────────────────────

export function normalizeTelegram(update: any): NormalizedMessage | null {
  const msg = update.message ?? update.edited_message;
  if (!msg) return null;

  const user = msg.from;
  const authorName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || String(user?.id ?? "unknown");
  const chatId = String(msg.chat?.id ?? update.update_id);

  return {
    id: String(msg.message_id ?? crypto.randomUUID()),
    surface: "telegram",
    threadId: chatId,
    author: authorName,
    content: msg.text ?? msg.caption ?? "",
    timestamp: msg.date ? msg.date * 1000 : Date.now(),
    raw: update,
  };
}

// ── Webhook (GitHub, Linear, Jira, etc.) ─────────────────

export interface WebhookConfig {
  /** Source platform identifier */
  source: "github" | "linear" | "jira" | "custom";
  /** Extract the content from the payload */
  contentExtractor?: (payload: any) => string;
  /** Extract the thread ID from the payload */
  threadIdExtractor?: (payload: any) => string;
}

export function normalizeWebhook(payload: any, config: WebhookConfig): NormalizedMessage {
  const defaultContent = JSON.stringify(payload).slice(0, 500);
  const content = config.contentExtractor?.(payload) ?? (() => {
    switch (config.source) {
      case "github": return payload.pull_request?.title ?? payload.issue?.title ?? payload.comment?.body ?? defaultContent;
      case "linear": return payload.data?.title ?? payload.data?.description ?? defaultContent;
      case "jira": return payload.issue?.fields?.summary ?? defaultContent;
      default: return defaultContent;
    }
  })();

  const threadId = config.threadIdExtractor?.(payload) ?? (() => {
    switch (config.source) {
      case "github": return `github:${payload.repository?.full_name}:${payload.pull_request?.number ?? payload.issue?.number ?? "0"}`;
      case "linear": return `linear:${payload.data?.id ?? crypto.randomUUID()}`;
      case "jira": return `jira:${payload.issue?.key ?? crypto.randomUUID()}`;
      default: return `webhook:${crypto.randomUUID()}`;
    }
  })();

  return {
    id: crypto.randomUUID(),
    surface: "webhook",
    threadId,
    author: config.source,
    content,
    timestamp: Date.now(),
    raw: payload,
  };
}

// ── CLI ───────────────────────────────────────────────────

export function normalizeCLI(content: string, sessionId: string): NormalizedMessage {
  return {
    id: crypto.randomUUID(),
    surface: "cli",
    threadId: sessionId,
    author: process.env.USER ?? "local",
    content,
    timestamp: Date.now(),
  };
}

// ── Web / API ─────────────────────────────────────────────

export function normalizeAPI(body: {
  message: string;
  threadId?: string;
  userId?: string;
}): NormalizedMessage {
  return {
    id: crypto.randomUUID(),
    surface: "api",
    threadId: body.threadId ?? crypto.randomUUID(),
    author: body.userId ?? "api-user",
    content: body.message,
    timestamp: Date.now(),
  };
}
