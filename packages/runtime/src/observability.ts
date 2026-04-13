/**
 * Nexus Observability
 *
 * OpenTelemetry-compatible tracing for the agent loop.
 * Every LLM call, tool execution, and middleware pass generates a span.
 *
 * When an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT),
 * spans are exported to Jaeger/Grafana Tempo/etc.
 * Otherwise traces are buffered in-memory and can be read via getRecentTraces().
 */

import api from "@opentelemetry/api";

export type { Tracer, Span } from "@opentelemetry/api";

export interface SpanAttributes {
  sessionId?: string;
  model?: string;
  toolName?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  [key: string]: string | number | boolean | undefined;
}

// ── Tracer singleton ──────────────────────────────────────

const TRACER_NAME = "nexus";
let _initialized = false;

export async function initObservability(options?: {
  serviceName?: string;
  otlpEndpoint?: string;
}): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const otlpEndpoint =
    options?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!otlpEndpoint) return;

  try {
    // Dynamically import SDK to keep startup fast when not configured
    const { NodeSDK } = await import("@opentelemetry/sdk-node" as any);
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http" as any);
    const { Resource } = await import("@opentelemetry/resources" as any);

    const sdk = new NodeSDK({
      resource: new Resource({ "service.name": options?.serviceName ?? "nexus" }),
      traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
    });
    sdk.start();
  } catch (err) {
    console.warn("[nexus/observability] OpenTelemetry SDK init failed:", err);
  }
}

export function getTracer(): api.Tracer {
  return api.trace.getTracer(TRACER_NAME, "0.1.0");
}

// ── Span helpers ──────────────────────────────────────────

export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: api.Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes: attributes as any }, async (span) => {
    const startMs = Date.now();
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 /* OK */ });
      recordTrace({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        spanName: name,
        spanType: name.split(".")[1] ?? "unknown",
        status: "ok",
        durationMs: Date.now() - startMs,
        attributes: attributes as any,
      });
      return result;
    } catch (err) {
      span.setStatus({ code: 2 /* ERROR */, message: err instanceof Error ? err.message : String(err) });
      recordTrace({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        spanName: name,
        spanType: name.split(".")[1] ?? "unknown",
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
        attributes: attributes as any,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ── In-memory trace buffer ────────────────────────────────

export interface TraceRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanName: string;
  spanType: string;
  sessionId?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  status: "ok" | "error";
  errorMessage?: string;
  attributes?: Record<string, unknown>;
  createdAt: Date;
}

const _traceBuffer: TraceRecord[] = [];
const MAX_BUFFER = 500;

export function recordTrace(record: Omit<TraceRecord, "createdAt">): void {
  _traceBuffer.push({ ...record, createdAt: new Date() });
  if (_traceBuffer.length > MAX_BUFFER) _traceBuffer.shift();
}

export function getRecentTraces(limit = 50): TraceRecord[] {
  return _traceBuffer.slice(-limit);
}

export function clearTraceBuffer(): void {
  _traceBuffer.length = 0;
}

// ── Metrics accumulator ───────────────────────────────────

interface Metrics {
  totalLlmCalls: number;
  totalToolCalls: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalSessions: number;
  system1Routes: number;
  system2Routes: number;
}

const _metrics: Metrics = {
  totalLlmCalls: 0,
  totalToolCalls: 0,
  totalCostUsd: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalSessions: 0,
  system1Routes: 0,
  system2Routes: 0,
};

export function recordMetric(key: keyof Metrics, value = 1): void {
  _metrics[key] = (_metrics[key] ?? 0) + value;
}

export function getMetrics(): Readonly<Metrics> {
  return { ..._metrics };
}
