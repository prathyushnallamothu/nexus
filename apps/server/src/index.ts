import { Hono } from "hono";
import { createGateway, type NormalizedMessage } from "@nexus/gateway";
import {
  NexusAgent,
  builtinTools,
  budgetEnforcer,
  promptFirewall,
  outputScanner,
  timing,
  logger,
} from "@nexus/core";
import { createProvider, parseModelString } from "@nexus/providers";
import {
  SkillStore,
  DualProcessRouter,
  System1Executor,
  ExperienceLearner,
} from "@nexus/intelligence";
import {
  AuditLogger,
  PermissionGuard,
  DynamicSupervisor,
  BehavioralMonitor,
  permissionMiddleware,
  supervisionMiddleware,
  monitorMiddleware,
} from "@nexus/governance";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { cors } from "hono/cors";
import { A2AManager } from "@nexus/protocols";
import { getMetrics, getRecentTraces } from "@nexus/runtime";

const app = new Hono();
app.use('/api/*', cors());
const gateway = createGateway();
const a2aManager = new A2AManager();

// ── Setup Nexus Backend (similar to CLI) ─────────────────────

const DEFAULT_MODEL = process.env.NEXUS_MODEL ?? "openrouter:google/gemma-4-31b-it";
const BUDGET_USD = parseFloat(process.env.NEXUS_BUDGET ?? "2.0");
const NEXUS_HOME = join(process.cwd(), ".nexus");

if (!existsSync(NEXUS_HOME)) mkdirSync(NEXUS_HOME, { recursive: true });

const skillStore = new SkillStore(join(NEXUS_HOME, "skills"));
const router = new DualProcessRouter(skillStore);
const providerConfig = parseModelString(DEFAULT_MODEL);
const provider = createProvider(providerConfig);
const learner = new ExperienceLearner(provider, skillStore);
const system1 = new System1Executor(provider);

const auditLogger = new AuditLogger(join(NEXUS_HOME, "audit"));
const permissionGuard = new PermissionGuard(process.cwd());
const supervisor = new DynamicSupervisor({
  onApprovalNeeded: async (decision) => {
    // In headless API mode, we generally deny or hold pending Human Review.
    // For now we deny.
    console.warn(`[SUPERVISOR] Auto-denied HITL request for tool: ${decision.toolName}`);
    return false;
  },
});
const monitor = new BehavioralMonitor();

const agent = new NexusAgent({
  config: {
    model: DEFAULT_MODEL,
    systemPrompt: "You are Nexus. A platform-agnostic AI agent.",
    tools: builtinTools,
    middleware: [
      timing(),
      monitorMiddleware(monitor),
      promptFirewall(),
      budgetEnforcer({ limitUsd: BUDGET_USD }),
      permissionMiddleware(permissionGuard),
      supervisionMiddleware(supervisor),
      outputScanner(),
      logger({ verbose: true }),
    ],
    maxIterations: 10,
    maxContextTokens: 32000,
  },
  provider,
  onEvent: (event) => {
    auditLogger.createEventHandler()(event);
    monitor.createEventHandler()(event);
    // You could emit this event over WebSocket to connected clients!
  },
});

// A simple in-memory session manager for the API
const sessionMemories = new Map<string, any[]>();

// Wire gateway to agent
gateway.onMessage(async (msg) => {
  console.log(`[GATEWAY] Received msg from ${msg.surface} [${msg.threadId}]`);
  
  if (!sessionMemories.has(msg.threadId)) {
    sessionMemories.set(msg.threadId, []);
  }
  const history = sessionMemories.get(msg.threadId)!;

  try {
    const decision = router.route(msg.content);
    let responseText = "";

    if (decision.path === "system1" && decision.skillMatch) {
      const result = await system1.execute(msg.content, decision.skillMatch, builtinTools);
      responseText = result.response;
      history.push({ role: "user", content: msg.content }, { role: "assistant", content: responseText });
    } else {
      const result = await agent.run(msg.content, history);
      responseText = result.response;
      history.push(...result.messages.filter((m: any) => m.role !== "system"));
      
      // Background learn
      learner.learn({
        task: msg.content,
        messages: history,
        outcome: "success",
        budget: result.budget,
        durationMs: 0,
        routingPath: "system2",
        timestamp: Date.now(),
      }).catch(console.error);
    }

    return responseText;
  } catch (err: any) {
    console.error("[GATEWAY ERR]", err);
    return `Error processing task: ${err.message}`;
  }
});

// ── API Routes (Surfaces) ───────────────────────────────────

// Generic REST endpoint for web clients
app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const { message, threadId = "default-api" } = body;

  if (!message) return c.json({ error: "No message provided" }, 400);

  const normalized: NormalizedMessage = {
    id: crypto.randomUUID(),
    surface: "api",
    threadId,
    author: "api-user",
    content: message,
    timestamp: Date.now(),
  };

  const reply = await gateway.dispatch(normalized);
  return c.json({ response: reply });
});

// Mock Slack Events Webhook Endpoint
app.post("/api/webhooks/slack", async (c) => {
  const body = await c.req.json();
  // Slack URL verification challenge
  if (body.type === "url_verification") return c.text(body.challenge);

  // Normal message handling
  if (body.event?.type === "message" && !body.event.bot_id) {
    const normalized: NormalizedMessage = {
      id: body.event_id,
      surface: "slack",
      threadId: body.event.channel,
      author: body.event.user,
      content: body.event.text,
      timestamp: parseFloat(body.event.ts) * 1000,
    };
    
    // In production, we'd fire & forget and POST back to Slack API. 
    // For demo, we just dispatch and log.
    gateway.dispatch(normalized).then(reply => {
      console.log(`[Slack Reply Mock] To ${normalized.threadId}: ${reply}`);
    });
  }

});

// ── Dashboard API Routes ──────────────────────────────────────

// GET /api/metrics — observability counters + skill/audit counts
app.get("/api/metrics", (c) => {
  const metrics = getMetrics();
  const skills = skillStore.getAll();
  const auditEntries = auditLogger.getRecent(200);
  return c.json({
    totalLlmCalls: metrics.totalLlmCalls,
    totalCostUsd: metrics.totalCostUsd,
    system1Routes: metrics.system1Routes,
    system2Routes: metrics.system2Routes,
    totalToolCalls: metrics.totalToolCalls,
    skillsCount: skills.length,
    auditEntries: auditEntries.length,
    uptime: process.uptime(),
  });
});

// GET /api/skills — all skills with procedures
app.get("/api/skills", (c) => {
  const skills = skillStore.getAll();
  return c.json({ skills });
});

// GET /api/audit?limit=50 — recent audit log entries
app.get("/api/audit", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const entries = auditLogger.getRecent(limit);
  return c.json({ entries });
});

// GET /api/sessions — active session list
app.get("/api/sessions", (c) => {
  const sessions = Array.from(sessionMemories.entries()).map(([threadId, history]) => {
    const messageCount = history.length;
    const lastMessage = history[history.length - 1];
    return {
      id: threadId,
      threadId,
      messageCount,
      lastActivity: lastMessage?.timestamp ?? new Date().toISOString(),
      status: "active",
    };
  });
  return c.json({ sessions });
});

// GET /api/config — runtime configuration snapshot
app.get("/api/config", (c) => {
  return c.json({
    model: DEFAULT_MODEL,
    budgetUsd: BUDGET_USD,
    nexusHome: NEXUS_HOME,
    sandboxMode: !!process.env.NEXUS_SANDBOX,
    maxIterations: 10,
    maxContextTokens: 32000,
    version: "0.2.0",
  });
});

// GET /api/traces — recent OTel trace buffer
app.get("/api/traces", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const traces = getRecentTraces(limit);
  return c.json({ traces });
});

// ── Interop & Protocols ───────────────────────────────────────

// POST /api/a2a — A2A task submission endpoint
app.post("/api/a2a", async (c) => {
  const body = await c.req.json();
  const taskText = a2aManager.extractTaskText(body);
  const task = a2aManager.createTask(
    { role: "user", parts: [{ type: "text", text: taskText }] },
    body.sessionId,
  );

  const normalized: NormalizedMessage = {
    id: task.id,
    surface: "api",
    threadId: body.sessionId ?? task.id,
    author: "a2a-agent",
    content: taskText,
    timestamp: Date.now(),
  };

  try {
    const reply = await gateway.dispatch(normalized);
    const completed = a2aManager.completeTask(task.id, reply ?? "");
    return c.json(completed);
  } catch (err: any) {
    const failed = a2aManager.failTask(task.id, err.message);
    return c.json(failed, 500);
  }
});

// A2A Agent Card Discovery Endpoint
app.get("/.well-known/agent.json", (c) => {
  return c.json(a2aManager.getAgentCard());
});

export default {
  port: 8080,
  fetch: app.fetch,
};
