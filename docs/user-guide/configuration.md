# Configuration

Configure Nexus to match your needs — providers, models, budgets, paths, and more.

## Environment Variables

Set these in your `.env` file or shell environment.

### Core Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_MODEL` | `anthropic:claude-sonnet-4-20250514` | Model to use (format: `provider:model`) |
| `NEXUS_BUDGET` | `2.0` | Budget per session in USD |
| `NEXUS_HOME` | `.nexus/` | Directory for skills, memory, logs, and data |

### Provider API Keys

| Variable | Provider | Required |
|----------|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic | Yes (for Anthropic models) |
| `OPENAI_API_KEY` | OpenAI | Yes (for OpenAI models) |
| `GOOGLE_API_KEY` | Google | Yes (for Gemini models) |
| `OPENROUTER_API_KEY` | OpenRouter | Yes (for OpenRouter models) |
| — | Ollama | No (local) |

### Advanced Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_MAX_ITERATIONS` | `25` | Maximum tool-calling iterations per turn |
| `NEXUS_MAX_CONTEXT_TOKENS` | `128000` | Maximum context window in tokens |
| `NEXUS_SANDBOX` | `local` | Execution mode: `local` or `docker` |

## Model Selection

Nexus supports multiple LLM providers. Set `NEXUS_MODEL` to your preferred model.

### Anthropic (Claude)

```bash
NEXUS_MODEL=anthropic:claude-sonnet-4-20250514
NEXUS_MODEL=anthropic:claude-3-5-sonnet-20241022
NEXUS_MODEL=anthropic:claude-3-5-haiku-20241022
```

### OpenAI

```bash
NEXUS_MODEL=openai:gpt-4o
NEXUS_MODEL=openai:gpt-4o-mini
NEXUS_MODEL=openai:gpt-4-turbo
NEXUS_MODEL=openai:gpt-3.5-turbo
```

### Google Gemini

```bash
NEXUS_MODEL=google:gemini-2.5-flash
NEXUS_MODEL=google:gemini-2.5-pro
NEXUS_MODEL=google:gemini-2.0-flash
```

### OpenRouter

```bash
NEXUS_MODEL=openrouter:anthropic/claude-sonnet-4
NEXUS_MODEL=openrouter:openai/gpt-4o
NEXUS_MODEL=openrouter:google/gemini-2.5-flash
```

OpenRouter gives you access to 200+ models from various providers.

### Ollama (Local)

```bash
NEXUS_MODEL=ollama:llama3.3
NEXUS_MODEL=ollama:qwen2.5
NEXUS_MODEL=ollama:mistral
```

Ollama runs models locally — no API key needed, but requires a powerful machine.

## Budget Configuration

Set a per-session budget to control costs:

```bash
NEXUS_BUDGET=2.0  # $2.00 per session
NEXUS_BUDGET=5.0  # $5.00 per session
NEXUS_BUDGET=0.50 # $0.50 per session
```

Nexus tracks token usage and costs. When you approach the budget limit, you'll receive warnings. The agent will stop before exceeding the budget.

## Context Window

Set the maximum context window:

```bash
NEXUS_MAX_CONTEXT_TOKENS=128000  # 128K tokens (default)
NEXUS_MAX_CONTEXT_TOKENS=200000  # 200K tokens
```

Larger context windows allow for more conversation history but cost more.

## Iteration Limits

Limit how many tool-calling iterations Nexus can perform per turn:

```bash
NEXUS_MAX_ITERATIONS=25  # Default
NEXUS_MAX_ITERATIONS=50  # More complex tasks
NEXUS_MAX_ITERATIONS=10  # Simpler, faster tasks
```

## Sandbox Mode

Choose how Nexus executes code:

```bash
# Local execution (default)
NEXUS_SANDBOX=local

# Docker isolation (safer)
NEXUS_SANDBOX=docker
```

Docker mode requires Docker to be installed and running.

## Directory Structure

Customize where Nexus stores its data:

```bash
# Default: .nexus/ in current directory
NEXUS_HOME=.nexus/

# Custom location
NEXUS_HOME=/path/to/nexus-data
NEXUS_HOME=~/.nexus
```

Nexus creates these directories under `NEXUS_HOME`:

```
.nexus/
├── skills/          # Learned skills
├── memory/          # Semantic and episodic memory
├── wiki/            # Persistent knowledge base
├── audit/           # Audit logs
├── sessions/        # Session transcripts
├── cron/            # Scheduled jobs
├── logs/            # Structured logs
└── governance/      # Permissions, approvals, budgets
```

## Setup Wizard

Use the interactive setup wizard to configure Nexus:

```bash
bun run dev setup
```

The wizard will:
1. Ask you to choose a provider
2. Prompt for your API key (or detect existing)
3. Let you select a model
4. Set your budget
5. Offer to install recommended skills

## Configuration File

You can also create a `.nexus/config.json` file for advanced configuration:

```json
{
  "model": "anthropic:claude-sonnet-4-20250514",
  "budget": 2.0,
  "maxIterations": 25,
  "maxContextTokens": 128000,
  "sandbox": "local",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-...",
      "baseUrl": "https://api.anthropic.com"
    }
  }
}
```

## MCP Configuration

Configure Model Context Protocol servers in `.nexus/mcp.json`:

```json
{
  "memory": {
    "name": "Memory",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "enabled": true,
    "timeoutMs": 30000,
    "connectTimeoutMs": 15000
  },
  "github": {
    "name": "GitHub",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
    },
    "enabled": true
  }
}
```

## Switching Providers

Change providers at any time — no code changes, no lock-in:

```bash
# From Anthropic to OpenAI
NEXUS_MODEL=openai:gpt-4o
OPENAI_API_KEY=sk-...
bun run dev

# From OpenAI to Ollama (local)
NEXUS_MODEL=ollama:llama3.3
bun run dev
```

## Verification

Verify your configuration:

```bash
bun run dev doctor
```

This checks:
- Model format
- Budget value
- API key presence
- Nexus home directory
- Required subdirectories
- Bun availability
- Docker availability (if using docker sandbox)

## Best Practices

1. **Start with a low budget** — Set `NEXUS_BUDGET=0.50` initially, then increase as needed
2. **Use appropriate models** — Haiku for fast tasks, Sonnet for balanced tasks, Opus for complex reasoning
3. **Monitor costs** — Use `/stats` to track token usage and costs
4. **Secure your API keys** — Never commit `.env` to version control
5. **Use Ollama for privacy** — Run models locally if you need data privacy

## Next Steps

- [Skills System](./skills.md) — How Nexus learns from tasks
- [Memory System](./memory.md) — Persistent knowledge base
- [Modes](./modes.md) — Create specialized agents
- [Middleware](./middleware.md) — Composable middleware pipeline
