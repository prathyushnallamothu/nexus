/**
 * Nexus A2A (Agent-to-Agent) Protocol
 *
 * Implements the A2A v1.0 specification from the Linux Foundation / Google A2A.
 * Enables Nexus to:
 *   1. Publish its capabilities as an Agent Card (/.well-known/agent.json)
 *   2. Delegate tasks to other A2A-compatible agents
 *   3. Accept delegated tasks from other agents
 *   4. Return structured results
 *
 * Agent Card format: https://google.github.io/A2A/spec/
 */

// ── Agent Card ────────────────────────────────────────────

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface AgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
}

export interface AgentCard {
  /** Unique agent identifier */
  agent_id: string;
  /** Schema version */
  schema_version: "1.0";
  /** Human-readable agent name */
  name: string;
  /** Description of what this agent does */
  description: string;
  /** Agent version */
  version: string;
  /** Skills this agent can perform */
  skills: AgentSkill[];
  /** Protocol capabilities */
  capabilities: AgentCapabilities;
  /** Cost model */
  cost_model: {
    currency: "USD";
    rate: "per_token" | "per_task" | "flat";
    estimate_endpoint?: string;
    per_token_usd?: number;
  };
  /** Authentication required */
  auth: {
    type: "oauth2" | "bearer" | "none";
    oauth2?: { authorization_url: string; token_url: string; scopes: string[] };
  };
  /** Endpoint URLs */
  endpoints: {
    /** A2A task submission endpoint */
    a2a: string;
    /** MCP tools endpoint (optional) */
    mcp_tools?: string;
    /** Health check */
    health?: string;
  };
  /** Provider information */
  provider?: {
    organization: string;
    url?: string;
  };
}

// ── Task Types ────────────────────────────────────────────

export type TaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskPart {
  type: "text" | "data" | "file";
  text?: string;
  data?: Record<string, unknown>;
  file?: { name: string; mimeType: string; bytes?: string; uri?: string };
}

export interface Task {
  /** Unique task ID */
  id: string;
  /** Session ID for multi-turn tasks */
  sessionId?: string;
  /** Current status */
  status: { state: TaskStatus; message?: TaskMessage; timestamp: string };
  /** Task artifacts (results) */
  artifacts?: TaskArtifact[];
  /** Task history */
  history?: TaskMessage[];
  /** Task metadata */
  metadata?: Record<string, unknown>;
}

export interface TaskMessage {
  role: "user" | "agent";
  parts: TaskPart[];
  metadata?: Record<string, unknown>;
}

export interface TaskArtifact {
  name?: string;
  description?: string;
  parts: TaskPart[];
  metadata?: Record<string, unknown>;
}

// ── A2A Manager ───────────────────────────────────────────

export interface A2AManagerOptions {
  card?: Partial<AgentCard>;
  /** Bearer token for auth when acting as server */
  serverToken?: string;
  /** Max time to wait for a delegated task (ms) */
  delegationTimeoutMs?: number;
}

export class A2AManager {
  private card: AgentCard;
  private activeTasks: Map<string, Task> = new Map();
  private opts: A2AManagerOptions;

  constructor(opts: A2AManagerOptions = {}) {
    this.opts = opts;
    this.card = {
      agent_id: opts.card?.agent_id ?? "nexus",
      schema_version: "1.0",
      name: opts.card?.name ?? "Nexus",
      description: opts.card?.description ?? "Self-improving AI agent platform that gets smarter and cheaper over time",
      version: opts.card?.version ?? "0.2.0",
      skills: opts.card?.skills ?? [
        {
          id: "code-editing",
          name: "Code Editing",
          description: "Read, write, refactor, and debug code across any language",
          tags: ["code", "refactor", "bug-fix", "implement"],
          examples: ["Fix the authentication bug in src/auth.ts", "Add pagination to the users API"],
        },
        {
          id: "research",
          name: "Research & Analysis",
          description: "Search the web, read documentation, and synthesize findings",
          tags: ["research", "search", "analyze", "summarize"],
          examples: ["Research best practices for database connection pooling"],
        },
        {
          id: "devops",
          name: "DevOps & Deployment",
          description: "Configure CI/CD pipelines, Docker containers, and cloud deployments",
          tags: ["docker", "deploy", "ci", "cd", "kubernetes"],
          examples: ["Create a Dockerfile for this Node.js app"],
        },
        {
          id: "file-management",
          name: "File Management",
          description: "Read, write, search, and organize files in the workspace",
          tags: ["files", "read", "write", "search"],
          examples: ["Find all TODO comments in the codebase"],
        },
      ],
      capabilities: opts.card?.capabilities ?? {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      cost_model: opts.card?.cost_model ?? {
        currency: "USD",
        rate: "per_token",
        per_token_usd: 0.000003,
      },
      auth: opts.card?.auth ?? { type: "bearer" },
      endpoints: opts.card?.endpoints ?? {
        a2a: "/api/a2a",
        health: "/api/health",
      },
      provider: opts.card?.provider ?? {
        organization: "Nexus",
      },
    };
  }

  /** Get the agent card for /.well-known/agent.json */
  getAgentCard(): AgentCard {
    return this.card;
  }

  // ── Server side: accept delegated tasks ──────────────────

  /**
   * Create a new task from an incoming A2A request.
   * Returns the initial task object.
   */
  createTask(message: TaskMessage, sessionId?: string): Task {
    const taskId = crypto.randomUUID();
    const task: Task = {
      id: taskId,
      sessionId,
      status: {
        state: "submitted",
        timestamp: new Date().toISOString(),
      },
      history: [message],
      artifacts: [],
    };
    this.activeTasks.set(taskId, task);
    return task;
  }

  /**
   * Update a task's status and optionally add an artifact.
   */
  updateTask(
    taskId: string,
    state: TaskStatus,
    opts?: { message?: TaskMessage; artifact?: TaskArtifact },
  ): Task | null {
    const task = this.activeTasks.get(taskId);
    if (!task) return null;

    task.status = { state, timestamp: new Date().toISOString(), message: opts?.message };
    if (opts?.message) task.history?.push(opts.message);
    if (opts?.artifact) task.artifacts?.push(opts.artifact);

    return task;
  }

  /**
   * Complete a task with a text result.
   */
  completeTask(taskId: string, resultText: string): Task | null {
    const artifact: TaskArtifact = {
      name: "result",
      parts: [{ type: "text", text: resultText }],
    };
    const agentMsg: TaskMessage = {
      role: "agent",
      parts: [{ type: "text", text: resultText }],
    };
    return this.updateTask(taskId, "completed", { artifact, message: agentMsg });
  }

  /**
   * Fail a task with an error message.
   */
  failTask(taskId: string, error: string): Task | null {
    const agentMsg: TaskMessage = {
      role: "agent",
      parts: [{ type: "text", text: `Error: ${error}` }],
    };
    return this.updateTask(taskId, "failed", { message: agentMsg });
  }

  /** Get a task by ID */
  getTask(taskId: string): Task | null {
    return this.activeTasks.get(taskId) ?? null;
  }

  /** Cancel a task */
  cancelTask(taskId: string): Task | null {
    return this.updateTask(taskId, "cancelled");
  }

  // ── Client side: delegate to other agents ────────────────

  /**
   * Delegate a task to another A2A-compatible agent.
   * Returns the agent's response text.
   */
  async delegate(opts: {
    agentUrl: string;
    task: string;
    sessionId?: string;
    bearerToken?: string;
    timeoutMs?: number;
  }): Promise<{ success: boolean; result?: string; error?: string; task?: Task }> {
    const message: TaskMessage = {
      role: "user",
      parts: [{ type: "text", text: opts.task }],
    };

    const payload = {
      id: crypto.randomUUID(),
      sessionId: opts.sessionId,
      message,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.bearerToken) {
      headers["Authorization"] = `Bearer ${opts.bearerToken}`;
    }

    try {
      const endpoint = opts.agentUrl.endsWith("/api/a2a")
        ? opts.agentUrl
        : `${opts.agentUrl.replace(/\/$/, "")}/api/a2a`;

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        opts.timeoutMs ?? this.opts.delegationTimeoutMs ?? 120_000,
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        return { success: false, error: `Agent returned ${response.status}: ${body}` };
      }

      const data = await response.json() as Task;

      if (data.status.state === "completed") {
        const textPart = data.artifacts?.[0]?.parts.find((p) => p.type === "text");
        return { success: true, result: textPart?.text ?? "(no text result)", task: data };
      }

      if (data.status.state === "failed") {
        const errorPart = data.status.message?.parts.find((p) => p.type === "text");
        return { success: false, error: errorPart?.text ?? "Task failed", task: data };
      }

      return { success: false, error: `Unexpected task state: ${data.status.state}`, task: data };
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { success: false, error: "Delegation timeout" };
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Discover an agent's capabilities by fetching its Agent Card.
   */
  async discoverAgent(agentBaseUrl: string): Promise<AgentCard | null> {
    try {
      const url = `${agentBaseUrl.replace(/\/$/, "")}/.well-known/agent.json`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      return response.json() as Promise<AgentCard>;
    } catch {
      return null;
    }
  }

  /**
   * Convert an incoming A2A request payload to a plain task string.
   * Used by the server-side handler.
   */
  extractTaskText(payload: any): string {
    const message = payload.message;
    if (!message) return JSON.stringify(payload);

    const textPart = message.parts?.find((p: any) => p.type === "text");
    return textPart?.text ?? JSON.stringify(payload);
  }
}
