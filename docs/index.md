# Nexus Documentation

**The AI agent that gets smarter and cheaper over time.**

> Fully open-source. Self-hosted. Every LLM provider. Powered by Bun.

## What is Nexus?

Nexus is an autonomous AI agent that learns from every task. Unlike coding copilots tethered to an IDE or chatbot wrappers around a single API, Nexus uses a **dual-process architecture** that continuously improves:

- **Task #1**: Full reasoning → $0.15, 3 minutes
- **Task #100**: Skill match → $0.04, 45 seconds
- **Task #1000**: Internalized → $0.01, 10 seconds

Nexus runs locally or on any infrastructure, supports every major LLM provider, and builds a persistent knowledge base that compounds across sessions.

## Key Features

- **System 1/2 Dual-Process Routing** — Cognitive science-based architecture that routes routine tasks through fast, cheap skill execution while reserving full reasoning for novel or risky operations
- **Experience Learner** — Autonomous skill creation and mutation from task trajectories with Wilson score confidence intervals
- **Multi-Provider Support** — Anthropic, OpenAI, Google Gemini, Ollama (local), OpenRouter, and more with zero SDK dependencies
- **Middleware Pipeline** — Composable middleware for timing, prompt firewall, budget enforcement, permission guards, audit logging, and behavioral monitoring
- **Zero-Code Modes** — Drop a `.md` file to create specialized agents (coding, research, code review, devops, writing)
- **Wiki Memory System** — Persistent knowledge base with FTS5 full-text search, semantic recall, and user modeling
- **MCP Integration** — Connect to any Model Context Protocol server for extended capabilities
- **Cron Scheduler** — Built-in scheduling for automated tasks
- **Enterprise Security** — Prompt firewall, permission system, audit trail, and dynamic supervision

## Quick Links

- [Installation](./getting-started/installation.md)
- [Quickstart](./getting-started/quickstart.md)
- [Configuration](./user-guide/configuration.md)
- [Skills System](./user-guide/skills.md)
- [Modes](./user-guide/modes.md)
- [Tools](./user-guide/tools.md)
- [Memory System](./user-guide/memory.md)
- [Middleware](./user-guide/middleware.md)
- [Architecture](./developer-guide/architecture.md)
- [CLI Reference](./reference/cli-commands.md)
- [FAQ](./reference/faq.md)
