# NEXUS ◆

**The AI agent that gets smarter and cheaper over time.**

> Fully open-source. Self-hosted. Every LLM provider. Powered by Bun.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue)](https://www.typescriptlang.org/)

Nexus is an autonomous AI agent that learns from every task. Unlike coding copilots tethered to an IDE or chatbot wrappers around a single API, Nexus uses a **dual-process architecture** inspired by cognitive science to continuously improve performance and reduce costs over time.

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/nexus.git
cd nexus
bun install

# 2. Run the setup wizard (recommended)
bun run dev setup

# Or configure manually
echo "ANTHROPIC_API_KEY=sk-..." > .env

# 3. Run
bun run dev
```

The setup wizard will guide you through provider selection, API key configuration, model selection, and budget settings.

## 📚 Documentation

- **[Getting Started](docs/getting-started/installation.md)** — Installation and quickstart
- **[Configuration](docs/user-guide/configuration.md)** — Configuration options
- **[Skills System](docs/user-guide/skills.md)** — How Nexus learns from tasks
- **[Modes](docs/user-guide/modes.md)** — Create specialized agents
- **[Memory System](docs/user-guide/memory.md)** — Persistent knowledge base
- **[Tools](docs/user-guide/tools.md)** — Available tools
- **[Architecture](docs/developer-guide/architecture.md)** — System architecture
- **[CLI Reference](docs/reference/cli-commands.md)** — CLI commands
- **[FAQ](docs/reference/faq.md)** — Frequently asked questions

## ✨ Key Features

### System 1/2 Dual-Process Routing
Inspired by Kahneman's "Thinking, Fast and Slow":
- **System 1**: Fast, automatic skill execution (60-80% cheaper)
- **System 2**: Slow, deliberate full LLM reasoning
- Router assesses task risk and complexity automatically

### Experience Learner
Autonomous skill creation and improvement:
- **Skill Creation** — Learns from task trajectories
- **Skill Mutation** — Self-mutates on failure
- **Wilson Confidence** — Statistical skill evaluation
- **Auto Retirement** — Removes underperforming skills

### Cost Optimization
- **Task #1**: Full reasoning → $0.15, 3 minutes
- **Task #100**: Skill match → $0.04, 45 seconds
- **Task #1000**: Internalized → $0.01, 10 seconds

### Multi-Provider Support
- Anthropic (Claude)
- OpenAI (GPT)
- Google Gemini
- Ollama (local, free)
- OpenRouter (200+ models)
- Zero SDK dependencies — direct HTTP calls

### Zero-Code Modes
Drop a `.md` file in `modes/` to create a specialized agent:
- **Coding** — Software development
- **Research** — Analysis and investigation
- **Code Review** — Structured code review
- **DevOps** — Infrastructure and deployment
- **Writing** — Content creation

### Enterprise Security
- Prompt firewall (12 injection patterns)
- Permission system (path + tool-level)
- Audit logger (immutable trail)
- Behavioral monitoring (anomaly detection)
- Dynamic supervision (HITL approval)

### Persistent Memory
- Wiki knowledge base with FTS5 search
- Semantic memory with vector embeddings
- Episodic memory for task outcomes
- User modeling (preferences, patterns)
- Cross-session recall

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI (Interactive REPL · Bun Runtime)          │
├─────────────────────────────────────────────────┤
│  Intelligence Layer                              │
│  ├── System 1/2 Dual-Process Router              │
│  ├── Skill Store (Wilson Confidence)            │
│  ├── Experience Learner (Reflect + Evolve)      │
│  ├── Mode Manager (Zero-Code Specialization)    │
│  └── Memory Manager (Wiki + Semantic)           │
├─────────────────────────────────────────────────┤
│  Governance Layer                                │
│  ├── Permission Guard                            │
│  ├── Policy Engine                               │
│  ├── Approval Queue                              │
│  ├── Budget Store                                │
│  ├── Audit Logger                                │
│  └── Behavioral Monitor                          │
├─────────────────────────────────────────────────┤
│  Middleware Pipeline                             │
│  ├── Timing · Prompt Firewall · Budget Enforcer │
│  ├── Permission · Network · Supervision          │
│  ├── Memory Context · Artifact Tracker          │
│  └── Tool Compactor · Output Scanner · Logger   │
├─────────────────────────────────────────────────┤
│  Agent Core (Tool Dispatch + LLM Loop)          │
├─────────────────────────────────────────────────┤
│  Provider Abstraction (Zero SDK Dependencies)    │
│  ├── Anthropic · OpenAI · Google · Ollama       │
│  └── OpenRouter                                  │
├─────────────────────────────────────────────────┤
│  Runtime Layer                                   │
│  ├── MCP Manager · Cron Scheduler                │
│  └── Sandbox Manager                            │
└─────────────────────────────────────────────────┘
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_MODEL` | `anthropic:claude-sonnet-4-20250514` | Model to use |
| `NEXUS_BUDGET` | `2.0` | Budget per session in USD |
| `NEXUS_HOME` | `.nexus/` | Directory for data |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GOOGLE_API_KEY` | — | Google API key |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |

### Setup Wizard

```bash
bun run dev setup
```

Interactive wizard for:
- Provider selection
- API key configuration
- Model selection
- Budget setting
- Skill installation

### Doctor Command

```bash
bun run dev doctor
```

Check configuration and diagnose issues.

## 📖 Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/model` | Show current model |
| `/skills` | List learned skills |
| `/modes` | List available modes |
| `/mode <name>` | Switch to a mode |
| `/stats` | Show routing & learning stats |
| `/wiki recall <query>` | Search wiki memory |
| `/tools` | List available tools |
| `/exit` | Exit Nexus |

## 📁 Project Structure

```
nexus/
├── packages/
│   ├── core/            # Agent loop, middleware, tools, types
│   ├── providers/       # Multi-provider LLM abstraction
│   ├── intelligence/    # Skills, router, learner, modes
│   ├── governance/      # Security, permissions, audit
│   ├── protocols/       # MCP, A2A, Agent Cards
│   └── runtime/        # Cron, sandbox, scheduling
├── apps/
│   ├── cli/             # Interactive CLI
│   └── web/             # Web UI (planned)
├── docs/                # Documentation
├── modes/               # Zero-code modes
│   ├── coding.md
│   ├── research.md
│   ├── code-review.md
│   ├── devops.md
│   └── writing.md
└── .nexus/              # Runtime data
    ├── skills/          # Learned skills
    ├── memory/          # Semantic and episodic memory
    ├── wiki/            # Persistent knowledge base
    ├── audit/           # Audit logs
    ├── sessions/        # Session transcripts
    ├── cron/            # Scheduled jobs
    └── governance/      # Permissions, approvals, budgets
```

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Inspired by cognitive science (Kahneman's dual-process theory)
- Compatible with [agentskills.io](https://agentskills.io) format
- Built on [Bun](https://bun.sh) for performance
- Uses [Model Context Protocol](https://modelcontextprotocol.io) for extensibility

## 🔗 Links

- [Documentation](docs/)
- [GitHub Issues](https://github.com/your-org/nexus/issues)
- [Discord](https://discord.gg/nexus) (coming soon)
- [Twitter](https://twitter.com/nexus_ai) (coming soon)
