# Middleware

Nexus uses a composable middleware pipeline for cross-cutting concerns. Middleware runs before and after the agent loop, enabling concerns like timing, security, budgeting, and logging without modifying core agent logic.

## Middleware Pipeline

```
User Request
    ↓
[Middleware Chain]
    ↓
Agent Loop
    ↓
[Middleware Chain]
    ↓
Response
```

## Built-in Middleware

### Timing

Tracks execution time for each agent turn:

```typescript
timing()
```

Outputs timing information to logs for performance monitoring.

### Prompt Firewall

Detects and blocks prompt injection attempts:

```typescript
promptFirewall()
```

Checks for 12 known injection patterns:
- System prompt override attempts
- Instruction injection
- Role confusion attacks
- Delimiter attacks
- And more

### Budget Enforcer

Enforces budget limits per session:

```typescript
budgetEnforcer({ limitUsd: 2.0 })
```

Tracks token usage and costs. Warns at 80% of budget, stops before exceeding limit.

### Permission Guard

Controls file and tool access:

```typescript
permissionMiddleware(permissionGuard)
```

Enforces path-based and tool-level permissions.

### Network Guard

Controls network access:

```typescript
networkMiddleware(networkGuard)
```

Can deny access to private IP ranges, specific domains, etc.

### Supervision Middleware

Enables human-in-the-loop supervision:

```typescript
supervisionMiddleware(supervisor)
```

Requires approval for dangerous operations.

### Monitor Middleware

Detects anomalous behavior:

```typescript
monitorMiddleware(monitor)
```

Tracks patterns and alerts on suspicious activity.

### Memory Context Builder

Injects relevant memory into context:

```typescript
memoryContextBuilder({ nexusHome: NEXUS_HOME })
```

Searches wiki memory and injects relevant pages into context.

### Artifact Tracker

Records files, commands, and URLs as artifacts:

```typescript
artifactTracker()
```

Tracks all artifacts created during a session.

### Tool Compactor

Truncates huge tool outputs:

```typescript
toolCompactor()
```

Prevents tool outputs from blowing context limits.

### Output Scanner

Scans outputs for sensitive information:

```typescript
outputScanner()
```

Detects and redacts API keys, passwords, etc.

### Logger

Structured logging:

```typescript
logger({ verbose: false })
```

Logs all agent events in structured format.

### After Agent Hooks

Deterministic hooks that run after the agent loop:

```typescript
afterAgent([
  afterAgentHooks.noteFileChanges,
  afterAgentHooks.archiveSessionToWiki({ nexusHome: NEXUS_HOME }),
  afterAgentHooks.suggestCommitIfChanged,
])
```

## Custom Middleware

Create custom middleware by implementing the middleware interface:

```typescript
import type { Middleware } from "@nexus/core";

const customMiddleware: Middleware = async (context, next) => {
  // Before agent logic
  console.log("Before agent:", context);
  
  // Call next middleware
  const result = await next(context);
  
  // After agent logic
  console.log("After agent:", result);
  
  return result;
};
```

## Middleware Order

Middleware runs in the order specified. Typical order:

```typescript
middleware: [
  timing(),                              // 1. Start timing
  monitorMiddleware(monitor),            // 2. Monitor behavior
  promptFirewall(),                      // 3. Check for injection
  memoryContextBuilder({ nexusHome }),   // 4. Inject memory
  budgetEnforcer({ limitUsd: BUDGET }),  // 5. Check budget
  permissionMiddleware(permissionGuard), // 6. Check permissions
  networkMiddleware(networkGuard),       // 7. Check network access
  supervisionMiddleware(supervisor),     // 8. Enable supervision
  artifactTracker(),                     // 9. Track artifacts
  toolCompactor(),                       // 10. Compact tool outputs
  outputScanner(),                       // 11. Scan outputs
  logger({ verbose: false }),            // 12. Log events
  afterAgent([                           // 13. After-agent hooks
    afterAgentHooks.noteFileChanges,
    afterAgentHooks.archiveSessionToWiki({ nexusHome }),
    afterAgentHooks.suggestCommitIfChanged,
  ]),
]
```

## Configuration

Configure middleware in the agent config:

```typescript
const agent = new NexusAgent({
  config: {
    middleware: [
      timing(),
      promptFirewall(),
      budgetEnforcer({ limitUsd: 2.0 }),
      // ... more middleware
    ],
  },
  provider,
});
```

## Best Practices

1. **Order matters** — Middleware runs in the order specified
2. **Keep middleware focused** — Each middleware should do one thing well
3. **Use existing middleware** — Don't reinvent the wheel
4. **Test middleware** — Ensure middleware doesn't break the agent loop
5. **Log appropriately** — Use the logger middleware for debugging

## Advanced Topics

### Conditional Middleware

Enable/disable middleware based on conditions:

```typescript
const conditionalMiddleware = (enabled: boolean): Middleware => {
  if (!enabled) {
    return async (_, next) => next();
  }
  return promptFirewall();
};
```

### Middleware Composition

Compose multiple middleware into one:

```typescript
const securityMiddleware = compose([
  promptFirewall(),
  permissionMiddleware(permissionGuard),
  networkMiddleware(networkGuard),
]);
```

### Middleware Context

Middleware can add context for subsequent middleware:

```typescript
const contextMiddleware: Middleware = async (context, next) => {
  context.customData = { timestamp: Date.now() };
  return next(context);
};
```

## Next Steps

- [Architecture](../developer-guide/architecture.md) — System architecture
- [Security](./security.md) — Security features and best practices
- [CLI Reference](../reference/cli-commands.md) — CLI commands and options
