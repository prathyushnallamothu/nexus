# NEXUS ◆

**The AI agent that gets smarter and cheaper over time.**

> Fully open-source. Self-hosted. Every LLM provider. Powered by Bun.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/nexus.git
cd nexus
bun install

# 2. Set your API key
echo "ANTHROPIC_API_KEY=sk-..." > .env
# Or: OPENAI_API_KEY, GOOGLE_API_KEY, etc.

# 3. Run
bun run dev
```

## How It Works

Nexus uses a **dual-process architecture** that learns from every task:

```
Task → Router → System 1 (fast, cheap) or System 2 (full reasoning)
                        ↓                         ↓
                  Skill Execution          Full Agent Loop
                        ↓                         ↓
                        └──── Experience Learner ──┘
                                     ↓
                              Skill Creation/Mutation
```

- **Task #1**: Full reasoning → $0.15, 3 minutes
- **Task #100**: Skill match → $0.04, 45 seconds
- **Task #1000**: Internalized → $0.01, 10 seconds

## Supported Providers

Set `NEXUS_MODEL` to use any provider:

```bash
# Anthropic (default)
NEXUS_MODEL=anthropic:claude-sonnet-4-20250514

# OpenAI
NEXUS_MODEL=openai:gpt-4o

# Google Gemini
NEXUS_MODEL=google:gemini-2.5-flash

# Ollama (local, free)
NEXUS_MODEL=ollama:llama3.3

# OpenRouter (any model)
NEXUS_MODEL=openrouter:anthropic/claude-sonnet-4
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI (interactive REPL · Bun runtime)           │
├─────────────────────────────────────────────────┤
│  Intelligence Layer                              │
│  ├── System 1/2 Dual-Process Router              │
│  ├── Skill Store (procedural memory)             │
│  ├── Experience Learner (reflect + evolve)       │
│  └── Mode Manager (zero-code specialization)     │
├─────────────────────────────────────────────────┤
│  Middleware Pipeline                             │
│  ├── Timing                                      │
│  ├── Prompt Firewall (injection detection)       │
│  ├── Budget Enforcer (cost limits)               │
│  ├── Output Scanner (leak prevention)            │
│  └── Logger                                      │
├─────────────────────────────────────────────────┤
│  Agent Core (tool dispatch + LLM loop)          │
├─────────────────────────────────────────────────┤
│  Provider Abstraction (zero SDK deps)            │
│  ├── Anthropic    ├── Google Gemini              │
│  ├── OpenAI       ├── Ollama (local)             │
│  └── OpenRouter                                  │
└─────────────────────────────────────────────────┘
```

## Modes

Drop a `.md` file in the `modes/` directory to create a new agent specialty. No code required.

Built-in modes:
- **Coding** — Software development tasks
- **Research** — Analysis and investigation
- **Code Review** — Structured code review with severity levels

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/model` | Show current model |
| `/skills` | List learned skills |
| `/modes` | List available modes |
| `/stats` | Show routing & learning stats |
| `/exit` | Exit Nexus |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `NEXUS_MODEL` | `anthropic:claude-sonnet-4-20250514` | Model to use |
| `NEXUS_BUDGET` | `2.0` | Budget per session in USD |
| `NEXUS_HOME` | `.nexus/` | Directory for skills and data |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GOOGLE_API_KEY` | — | Google API key |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |

## Project Structure

```
nexus/
├── packages/
│   ├── core/            # Agent loop, middleware, tools, types
│   ├── providers/       # Multi-provider LLM abstraction
│   └── intelligence/    # Skills, router, learner, modes
├── apps/
│   └── cli/             # Interactive CLI
├── modes/               # Domain specialization files
│   ├── coding.md
│   ├── research.md
│   └── code-review.md
└── .nexus/              # Runtime data (skills, trajectories)
```

## License

MIT
