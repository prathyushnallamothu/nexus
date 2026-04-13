# Quickstart

Your first conversation with Nexus — from install to chatting in 2 minutes.

## 1. Install Nexus

```bash
git clone https://github.com/your-org/nexus.git
cd nexus
bun install
bun run dev setup
```

The setup wizard will ask you to:
- Choose your AI provider (Anthropic, OpenAI, Google, OpenRouter, Ollama)
- Enter your API key
- Select a model
- Set your budget (default $2.00 per session)

## 2. Start Chatting

```bash
bun run dev
```

You'll see the Nexus banner:

```
  ══════════════════════════════════════════════════════════
  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
  ══════════════════════════════════════════════════════════

  Model:  anthropic:claude-sonnet-4-20250514
  Budget: $2.00 per session
  Dir:    /path/to/nexus
  Skills: 0 learned · Modes: 5 loaded

  Type your message. Alt+Enter for newline. /help for commands.
```

Type a message and press Enter:

```
❯ What can you help me with?
```

Nexus will respond and can use tools for file operations, web search, terminal commands, and more — all out of the box.

## 3. Try Key Features

### Ask it to use the terminal

```
❯ Create a new directory called my-project and initialize a git repository
```

Nexus will use the `shell` tool to execute commands:
- `mkdir my-project`
- `cd my-project`
- `git init`

### Use slash commands

```
❯ /skills
```

Lists all learned skills. Initially empty, but Nexus will create skills from your tasks.

```
❯ /stats
```

Shows routing statistics and learning progress:
- How many tasks went through System 1 (fast) vs System 2 (full)
- Number of learned skills
- Success rates

```
❯ /modes
```

Lists available modes:
- `coding` — Software development tasks
- `research` — Analysis and investigation
- `code-review` — Structured code review
- `devops` — Infrastructure and deployment
- `writing` — Content creation

### Switch modes

```
❯ /mode research
```

Nexus switches to research mode with specialized instructions for analysis tasks.

### Multi-line input

Press `Alt+Enter` to insert a newline without sending:

```
❯ Create a Python script that:
  - Reads a CSV file
  - Filters rows where status = 'active'
  - Calculates the average of the value column
  - Writes results to a new CSV
```

Press `Enter` to send the multi-line message.

### Interrupt the agent

Press `Ctrl+C` to interrupt a long-running task. Nexus will stop and ask if you want to continue or cancel.

### Resume a session

Nexus automatically saves your conversation history. Just run `bun run dev` again to resume.

## 4. Watch It Learn

After a few tasks, check the stats:

```
❯ /stats

Routing: 3 fast / 7 full (10 total)
Skills: 2 learned
```

Nexus has learned 2 skills from your tasks. Next time you ask a similar question, it will use System 1 (fast path) instead of full reasoning.

## 5. Explore Further

### Create a custom mode

Create `modes/my-task.md`:

```markdown
# My Task Mode

You are specialized for [your specific task type].

Focus on:
- [key aspect 1]
- [key aspect 2]

Rules:
- [rule 1]
- [rule 2]
```

Then switch to it:

```
❯ /mode my-task
```

### Configure MCP servers

Connect to external tools via the Model Context Protocol. Edit `.nexus/mcp.json`:

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

### Schedule automated tasks

Use the built-in cron scheduler:

```
❯ Every morning at 9am, check Hacker News for AI news and summarize it
```

Nexus will create a cron job that runs automatically.

### Check your wiki memory

Nexus maintains a persistent knowledge base in `.nexus/wiki/`:

```
❯ /wiki recall "what projects am I working on?"
```

Searches across all wiki pages for relevant information.

## Quick Reference

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
| `/exit` | Exit Nexus |

## Next Steps

- [Configuration](../user-guide/configuration.md) — Advanced configuration options
- [Skills System](../user-guide/skills.md) — How Nexus learns from tasks
- [Memory System](../user-guide/memory.md) — Persistent knowledge base
- [Modes](../user-guide/modes.md) — Create specialized agents
- [Tools](../user-guide/tools.md) — Available tools and how to use them
