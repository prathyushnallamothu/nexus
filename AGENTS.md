# Nexus Project Context

> This file is automatically loaded by Nexus as project context.

## Architecture

Nexus is a TypeScript monorepo using npm workspaces:

```
nexus/
├── packages/
│   ├── core/          # Agent loop, middleware, tools, types
│   └── providers/     # LLM provider abstraction (Anthropic, OpenAI, Google, Ollama, OpenRouter)
├── apps/
│   └── cli/           # Interactive CLI application
└── package.json       # Workspace root
```

## Coding Standards

- TypeScript strict mode
- ES2022 target, NodeNext module resolution
- ESM only (type: "module" in package.json)
- No external SDK dependencies for LLM calls (direct HTTP)
- Middleware follows Koa-style next() pattern
- All tools implement the `Tool` interface from @nexus/core

## Key Files

- `packages/core/src/agent.ts` — The agent loop
- `packages/core/src/middleware.ts` — Built-in middleware
- `packages/core/src/tools.ts` — Built-in tools
- `packages/core/src/types.ts` — Core type definitions
- `packages/providers/src/providers.ts` — Multi-provider LLM layer
- `apps/cli/src/index.ts` — CLI entry point

## Commands

```bash
npm install          # Install dependencies
npm run build        # Build all packages
npm run dev          # Build + run CLI
```

## Design Principles

1. **Middleware-first**: All cross-cutting concerns (safety, budgets, logging) are middleware
2. **Provider-agnostic**: No LLM SDK dependencies; direct HTTP calls only
3. **Event-driven**: Agent emits events for observability
4. **Budget-aware**: Every run tracks cost down to $0.0001
5. **Composable**: Tools, middleware, and providers are all pluggable
