# Architecture

Nexus uses a 7-layer modular architecture with a dual-process routing system inspired by cognitive science.

## High-Level Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI (Interactive REPL · Bun Runtime)           │
├─────────────────────────────────────────────────┤
│  Intelligence Layer                              │
│  ├── System 1/2 Dual-Process Router              │
│  ├── Skill Store (Procedural Memory)             │
│  ├── Experience Learner (Reflect + Evolve)       │
│  ├── Mode Manager (Zero-Code Specialization)     │
│  └── Memory Manager (Wiki + Semantic)           │
├─────────────────────────────────────────────────┤
│  Governance Layer                                │
│  ├── Permission Guard                            │
│  ├── Policy Engine                               │
│  ├── Approval Queue                              │
│  ├── Budget Store                                │
│  ├── Audit Logger                                │
│  ├── Behavioral Monitor                          │
│  └── Network Guard                               │
├─────────────────────────────────────────────────┤
│  Middleware Pipeline                             │
│  ├── Timing                                      │
│  ├── Prompt Firewall (Injection Detection)       │
│  ├── Budget Enforcer (Cost Limits)               │
│  ├── Permission Middleware                       │
│  ├── Network Middleware                          │
│  ├── Supervision Middleware                      │
│  ├── Monitor Middleware                          │
│  ├── Memory Context Builder                      │
│  ├── Artifact Tracker                            │
│  ├── Tool Compactor                              │
│  ├── Output Scanner                              │
│  └── Logger                                      │
├─────────────────────────────────────────────────┤
│  Agent Core (Tool Dispatch + LLM Loop)          │
│  ├── Tool Registry                               │
│  ├── Tool Executor                               │
│  ├── LLM Provider                                │
│  └── Context Manager                             │
├─────────────────────────────────────────────────┤
│  Provider Abstraction (Zero SDK Dependencies)    │
│  ├── Anthropic                                   │
│  ├── OpenAI                                      │
│  ├── Google Gemini                               │
│  ├── Ollama (Local)                              │
│  └── OpenRouter                                  │
├─────────────────────────────────────────────────┤
│  Runtime Layer                                   │
│  ├── MCP Manager                                 │
│  ├── Cron Scheduler                              │
│  └── Sandbox Manager                             │
└─────────────────────────────────────────────────┘
```

## Layer Details

### 1. CLI Layer

**Purpose:** User interface and interaction

**Components:**
- Interactive REPL with readline support
- Slash command parser
- Banner display
- Event handlers

**Key File:** `apps/cli/src/index.ts`

### 2. Intelligence Layer

**Purpose:** Learning, routing, and specialization

**Components:**
- **Dual-Process Router** — Routes tasks to System 1 (fast) or System 2 (full)
- **Skill Store** — Manages learned skills with Wilson confidence
- **Experience Learner** — Reflects, evolves, approves, and retires skills
- **Mode Manager** — Loads and manages zero-code modes
- **Memory Manager** — Wiki memory and semantic search

**Key Files:** `packages/intelligence/src/`

#### System 1/2 Dual-Process Router

Inspired by Kahneman's "Thinking, Fast and Slow":
- **System 1**: Fast, automatic, skill-based execution (60-80% cheaper)
- **System 2**: Slow, deliberate, full LLM reasoning

Router assesses task risk and complexity:
- Low risk + skill match → System 1
- High risk or no skill → System 2

#### Experience Learner

5-stage learning pipeline:
1. **STORE** — Save task trajectories
2. **REFLECT** — LLM analyzes what worked/didn't
3. **EVOLVE** — Mutate skills based on failures
4. **APPROVE** — Wilson confidence evaluation
5. **RETIRE** — Remove underperforming skills

### 3. Governance Layer

**Purpose:** Security, permissions, and audit

**Components:**
- **Permission Guard** — Path and tool-level access control
- **Policy Engine** — Security policy enforcement
- **Approval Queue** — HITL approval for dangerous operations
- **Budget Store** — Budget tracking and enforcement
- **Audit Logger** — Immutable audit trail
- **Behavioral Monitor** — Anomaly detection
- **Network Guard** — Network access control

**Key Files:** `packages/governance/src/`

### 4. Middleware Pipeline

**Purpose:** Cross-cutting concerns

**Components:**
- Timing, prompt firewall, budget enforcer
- Permission, network, supervision middleware
- Memory context builder, artifact tracker
- Tool compactor, output scanner, logger

**Key Files:** `packages/core/src/middleware/`

### 5. Agent Core

**Purpose:** Tool dispatch and LLM loop

**Components:**
- **Tool Registry** — Manages available tools
- **Tool Executor** — Executes tools in parallel
- **LLM Provider** — Multi-provider abstraction
- **Context Manager** — Manages conversation context

**Key Files:** `packages/core/src/agent.ts`

#### Agent Loop

```
1. Build context (messages + tools + memory)
2. Run middleware (before)
3. Call LLM with retry logic
4. Parse tool calls
5. Execute tools in parallel
6. Compress context if needed
7. Check budget
8. Repeat until tool calls complete
9. Run middleware (after)
10. Return response
```

### 6. Provider Layer

**Purpose:** Multi-LLM provider support

**Components:**
- Anthropic, OpenAI, Google, Ollama, OpenRouter
- Direct HTTP calls (zero SDK dependencies)
- Token estimation
- Error handling and retry

**Key Files:** `packages/providers/src/`

### 7. Runtime Layer

**Purpose:** Integration and orchestration

**Components:**
- **MCP Manager** — Model Context Protocol integration
- **Cron Scheduler** — Scheduled task execution
- **Sandbox Manager** — Code execution sandboxing

**Key Files:** `packages/runtime/src/`

## Data Flow

### Request Flow

```
User Input → CLI → Router → [Middleware] → Agent Core → Provider → LLM
                                                      ↓
                                                   Tool Execution
                                                      ↓
                                                 [Middleware] → Response
```

### Learning Flow

```
Task Execution → Trajectory Storage → Reflection → Skill Creation/Mutation
                                                    ↓
                                              Shadow Evaluation
                                                    ↓
                                              Approval (Auto/Manual)
                                                    ↓
                                              Trusted Status
                                                    ↓
                                              Retirement (if needed)
```

## Key Design Principles

### 1. Middleware-First

Cross-cutting concerns are handled by middleware, not core logic. This keeps the agent core clean and focused.

### 2. Provider-Agnostic

Zero SDK dependencies means easy addition of new providers. Direct HTTP calls to provider APIs.

### 3. Type-Safe

Full TypeScript coverage with strict mode enabled. Types are exported for consumer use.

### 4. Composable

All layers are composable. Use only what you need.

### 5. Observable

All events are emitted for monitoring and debugging.

## Performance Optimizations

### System 1 Fast Path

Routine tasks use skill execution instead of full LLM reasoning:
- 60-80% cost reduction
- 3-5x faster execution
- Lower token usage

### Context Compression

When approaching token limits:
- Summarize old messages
- Remove redundant tool outputs
- Keep recent context high-fidelity

### Parallel Tool Execution

Independent tools run in parallel:
- Faster overall execution
- Better resource utilization
- Lower latency

### Skill Command Cache

O(1) lookup for skill commands:
- Fast routing
- Minimal overhead
- Scalable to thousands of skills

## Security Architecture

### Defense in Depth

Multiple layers of security:
1. Prompt firewall (injection detection)
2. Permission guard (access control)
3. Network guard (network restrictions)
4. Supervision (HITL approval)
5. Audit logging (immutable trail)
6. Behavioral monitoring (anomaly detection)

### Zero Trust

All operations are monitored:
- Tool calls are tracked
- File access is logged
- Network requests are audited
- Anomalies are detected

### Immutable Audit Trail

All actions are logged to an immutable audit trail:
- Hash chain for integrity
- SQLite-backed for reliability
- Queryable for investigations

## Extensibility

### Custom Middleware

Add custom middleware for your needs:

```typescript
const customMiddleware: Middleware = async (context, next) => {
  // Your logic
  return next(context);
};
```

### Custom Tools

Add custom tools to the tool registry:

```typescript
const customTool = {
  schema: {
    name: "custom_tool",
    description: "A custom tool",
    parameters: { /* ... */ },
  },
  handler: async (params) => {
    // Your logic
  },
};
```

### Custom Modes

Add zero-code modes by dropping markdown files in `modes/`:

```markdown
# My Mode

> Description

Focus on:
- Task 1
- Task 2
```

## Next Steps

- [CLI Reference](../reference/cli-commands.md) — CLI commands and options
- [Contributing](./contributing.md) — How to contribute
- [FAQ](../reference/faq.md) — Frequently asked questions
