/**
 * Nexus Event Bus
 *
 * BullMQ-backed event queue for durable, async event processing.
 * Falls back to an in-process EventEmitter when Redis is not available,
 * so the CLI works without Redis.
 */

import { EventEmitter } from "node:events";
import type { AgentEvent } from "@nexus/core";

// ── In-Memory Fallback ────────────────────────────────────

class InMemoryEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  async publish(channel: string, event: AgentEvent): Promise<void> {
    this.emitter.emit(channel, event);
  }

  subscribe(channel: string, handler: (event: AgentEvent) => void): () => void {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }

  get type(): "memory" { return "memory"; }
}

// ── BullMQ Redis-backed Bus ───────────────────────────────

class BullMQEventBus {
  private Queue: any;
  private Worker: any;
  private queue: any;
  private workers: any[] = [];
  private redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  async init() {
    const bullmq = await import("bullmq");
    this.Queue = bullmq.Queue;
    this.Worker = bullmq.Worker;

    const connection = { url: this.redisUrl };
    this.queue = new this.Queue("nexus:events", { connection });
  }

  async publish(channel: string, event: AgentEvent): Promise<void> {
    if (!this.queue) return;
    await this.queue.add(channel, event, { removeOnComplete: 100, removeOnFail: 50 });
  }

  subscribe(channel: string, handler: (event: AgentEvent) => void): () => void {
    if (!this.Worker) return () => {};

    const connection = { url: this.redisUrl };
    const worker = new this.Worker(
      "nexus:events",
      async (job: any) => {
        if (job.name === channel) {
          handler(job.data as AgentEvent);
        }
      },
      { connection },
    );

    this.workers.push(worker);
    return () => {
      worker.close();
      this.workers = this.workers.filter((w) => w !== worker);
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    if (this.queue) await this.queue.close();
  }

  get type(): "bullmq" { return "bullmq"; }
}

// ── Unified Bus ───────────────────────────────────────────

export type EventBusType = "memory" | "bullmq";

export interface IEventBus {
  publish(channel: string, event: AgentEvent): Promise<void>;
  subscribe(channel: string, handler: (event: AgentEvent) => void): () => void;
  close(): Promise<void>;
  readonly type: EventBusType;
}

let _bus: IEventBus | null = null;

/**
 * Get (or create) the global event bus.
 * Uses BullMQ if REDIS_URL is set, otherwise in-memory.
 */
export async function getEventBus(): Promise<IEventBus> {
  if (_bus) return _bus;

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      const bull = new BullMQEventBus(redisUrl);
      await bull.init();
      _bus = bull as unknown as IEventBus;
      return _bus;
    } catch (err) {
      console.warn("[nexus/event-bus] BullMQ init failed, falling back to in-memory:", err);
    }
  }

  _bus = new InMemoryEventBus() as unknown as IEventBus;
  return _bus;
}

export async function closeEventBus(): Promise<void> {
  if (_bus) {
    await _bus.close();
    _bus = null;
  }
}

// ── Convenience helpers ───────────────────────────────────

/**
 * Create a session-scoped event publisher.
 * All events are published to `nexus:sessions:{sessionId}`.
 */
export async function createSessionPublisher(sessionId: string) {
  const bus = await getEventBus();
  return {
    publish: (event: AgentEvent) => bus.publish(`nexus:sessions:${sessionId}`, event),
    subscribe: (handler: (event: AgentEvent) => void) =>
      bus.subscribe(`nexus:sessions:${sessionId}`, handler),
  };
}
