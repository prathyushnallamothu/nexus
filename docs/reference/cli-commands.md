# CLI Reference

Complete reference for Nexus CLI commands and options.

## Commands

### `nexus` (default)

Start the interactive REPL:

```bash
bun run dev
# or
nexus
```

**Options:**
- None — starts the interactive REPL

### `nexus setup`

Run the interactive setup wizard:

```bash
bun run dev setup
# or
nexus setup
```

**What it does:**
- Prompts for provider selection
- Collects API key
- Selects model
- Sets budget
- Offers skill installation

### `nexus doctor`

Check configuration and diagnose issues:

```bash
bun run dev doctor
# or
nexus doctor
```

**Checks:**
- Model format
- Budget value
- API key presence
- Nexus home directory
- Required subdirectories
- Bun availability
- Docker availability (if using docker sandbox)

**Exit codes:**
- `0` — All checks pass
- `1` — One or more failures

## Slash Commands

Slash commands are available within the REPL:

### `/help`

Show available commands:

```
❯ /help
```

### `/clear`

Clear conversation history:

```
❯ /clear
```

### `/model`

Show current model:

```
❯ /model
```

### `/skills`

List learned skills:

```
❯ /skills
```

**Options:**
- `view <name>` — View a specific skill
- `delete <name>` — Delete a skill

### `/modes`

List available modes:

```
❯ /modes
```

### `/mode <name>`

Switch to a mode:

```
❯ /mode research
```

**Special modes:**
- `default` — Return to default behavior
- `coding` — Software development
- `research` — Analysis and investigation
- `code-review` — Structured code review
- `devops` — Infrastructure and deployment
- `writing` — Content creation

### `/stats`

Show routing and learning statistics:

```
❯ /stats
```

**Output:**
- Routing stats (System 1 vs System 2)
- Skill count and success rates
- Token usage and costs
- Memory usage

### `/wiki recall <query>`

Search wiki memory:

```
❯ /wiki recall "authentication"
```

**Other wiki commands:**
- `/wiki read <page>` — Read a wiki page
- `/wiki write <page>` — Write a wiki page
- `/wiki search <query>` — Search wiki content
- `/wiki list <category>` — List pages by category
- `/wiki lint` — Health-check the wiki

### `/tools`

List available tools:

```
❯ /tools
```

**Output:**
- Built-in tools
- MCP tools (if configured)
- Tool descriptions

### `/exit`

Exit Nexus:

```
❯ /exit
```

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_MODEL` | `anthropic:claude-sonnet-4-20250514` | Model to use |
| `NEXUS_BUDGET` | `2.0` | Budget per session in USD |
| `NEXUS_HOME` | `.nexus/` | Directory for data |
| `NEXUS_MAX_ITERATIONS` | `25` | Max tool-calling iterations |
| `NEXUS_MAX_CONTEXT_TOKENS` | `128000` | Max context window |
| `NEXUS_SANDBOX` | `local` | Execution mode |

### Provider API Keys

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google |
| `OPENROUTER_API_KEY` | OpenRouter |

## Configuration Files

### `.env`

Environment variables for configuration:

```bash
ANTHROPIC_API_KEY=sk-ant-...
NEXUS_MODEL=anthropic:claude-sonnet-4-20250514
NEXUS_BUDGET=2.0
```

### `.nexus/config.json`

Advanced configuration:

```json
{
  "model": "anthropic:claude-sonnet-4-20250514",
  "budget": 2.0,
  "maxIterations": 25,
  "maxContextTokens": 128000,
  "sandbox": "local"
}
```

### `.nexus/mcp.json`

MCP server configuration:

```json
{
  "memory": {
    "name": "Memory",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "enabled": true
  }
}
```

### `.nexus/governance/permissions.json`

Permission configuration:

```json
{
  "allowedPaths": ["/path/to/project"],
  "deniedPaths": ["/etc", "/system"],
  "toolPermissions": {
    "shell": { "allowed": true, "approvalRequired": true }
  }
}
```

## REPL Features

### Multi-line Input

Press `Alt+Enter` to insert a newline without sending:

```
❯ Create a script that:
  - Reads a CSV
  - Filters rows
  - Writes results
```

Press `Enter` to send.

### Interrupt

Press `Ctrl+C` to interrupt a long-running task.

### History

Use arrow keys to navigate command history.

### Tab Completion

Tab completion for slash commands and file paths (coming soon).

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error or failure |

## Examples

### Basic Usage

```bash
# Start Nexus
bun run dev

# Use a specific model
NEXUS_MODEL=openai:gpt-4o bun run dev

# Set a budget
NEXUS_BUDGET=5.0 bun run dev
```

### Setup

```bash
# Run setup wizard
bun run dev setup

# Check configuration
bun run dev doctor
```

### Advanced

```bash
# Use custom home directory
NEXUS_HOME=/path/to/nexus-data bun run dev

# Use Docker sandbox
NEXUS_SANDBOX=docker bun run dev

# Increase iteration limit
NEXUS_MAX_ITERATIONS=50 bun run dev
```

## Troubleshooting

### "API key not found"

Set the appropriate environment variable:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### "Budget exceeded"

Increase the budget or reduce token usage:
```bash
NEXUS_BUDGET=5.0 bun run dev
```

### "Context limit reached"

Increase the context window:
```bash
NEXUS_MAX_CONTEXT_TOKENS=200000 bun run dev
```

## Next Steps

- [FAQ](./faq.md) — Frequently asked questions
- [Troubleshooting](./troubleshooting.md) — Common issues and solutions
