# FAQ

Frequently asked questions about Nexus.

## General

### What is Nexus?

Nexus is an autonomous AI agent that learns from every task. It uses a dual-process architecture (System 1/2) to reduce costs and improve performance over time.

### How is Nexus different from other AI agents?

**Key differences:**
- **System 1/2 routing** — 60-80% cost reduction on routine tasks
- **Experience learner** — Skills self-mutate on failure
- **Wilson confidence** — Statistical skill evaluation
- **Zero SDK deps** — Direct HTTP calls to providers
- **TypeScript/Bun** — Web-developer friendly

### Is Nexus open source?

Yes, Nexus is fully open source under the MIT license.

### Can I use Nexus commercially?

Yes, the MIT license allows commercial use.

## Installation

### What are the system requirements?

**Minimum:**
- 2GB RAM
- 1 CPU core
- 100MB disk space

**Recommended:**
- 4GB RAM
- 2 CPU cores
- 1GB disk space

### Do I need Bun?

Yes, Nexus requires Bun 1.0 or later. Bun is a fast JavaScript runtime.

### Can I use Node.js instead of Bun?

No, Nexus is built specifically for Bun to leverage its performance benefits.

## Configuration

### Which LLM providers does Nexus support?

- Anthropic (Claude)
- OpenAI (GPT)
- Google Gemini
- OpenRouter (200+ models)
- Ollama (local, free)

### How do I switch providers?

Set `NEXUS_MODEL` to your preferred model:

```bash
NEXUS_MODEL=openai:gpt-4o
OPENAI_API_KEY=sk-...
bun run dev
```

### How do I set a budget?

Set `NEXUS_BUDGET`:

```bash
NEXUS_BUDGET=5.0
bun run dev
```

### What happens when I exceed the budget?

Nexus will warn you at 80% of the budget and stop before exceeding it. No charges beyond the budget limit.

## Skills

### How does Nexus learn skills?

Nexus analyzes task trajectories, reflects on what worked, and creates skills for repeatable tasks. Skills are evaluated using Wilson score intervals.

### Can I create skills manually?

Yes, you can create skills manually in `.nexus/skills/`, but we recommend letting Nexus learn from your tasks.

### How do I share skills with others?

Export skills in agentskills.io format:

```bash
nexus skills export ./skills-export/
```

### Can I import skills from Hermes?

Yes, Nexus is compatible with the agentskills.io format used by Hermes.

## Memory

### Where is my data stored?

Data is stored in `.nexus/` by default. You can change this with `NEXUS_HOME`.

### Is my data private?

Yes, all data is stored locally. Nexus does not send your data to any third-party services (except to the LLM provider you choose).

### Can I back up my data?

Yes, simply back up the `.nexus/` directory.

### How do I clear my memory?

Delete the `.nexus/memory/` and `.nexus/wiki/` directories.

## Security

### Is Nexus safe to use?

Nexus includes multiple security layers:
- Prompt firewall (injection detection)
- Permission guard (access control)
- Audit logging (immutable trail)
- Behavioral monitoring (anomaly detection)

### Can Nexus access my entire filesystem?

No, Nexus respects permission settings. Configure allowed paths in `.nexus/governance/permissions.json`.

### Does Nexus send my code to third parties?

Nexus sends code only to the LLM provider you choose (Anthropic, OpenAI, etc.). Check your provider's privacy policy.

## Performance

### How much does Nexus cost?

Costs depend on:
- Your chosen model
- Task complexity
- Skill usage (System 1 is 60-80% cheaper)

Typical costs:
- First task: $0.15
- After learning: $0.01-0.04

### Why is Nexus cheaper than other agents?

System 1 routing uses learned skills instead of full LLM reasoning for routine tasks, reducing costs by 60-80%.

### How fast is Nexus?

Nexus is fast because:
- Bun runtime (faster than Node.js)
- System 1 fast path (3-5x faster for routine tasks)
- Parallel tool execution

## Troubleshooting

### "API key not found"

Set the appropriate environment variable:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### "Budget exceeded"

Increase the budget:
```bash
NEXUS_BUDGET=5.0
```

### "Context limit reached"

Increase the context window:
```bash
NEXUS_MAX_CONTEXT_TOKENS=200000
```

### "Bun not found"

Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

### Skills not being used

Check skill confidence with `/stats`. Skills need high Wilson confidence (0.8+) to be trusted.

## Comparison

### Nexus vs Hermes

| Feature | Nexus | Hermes |
|---------|-------|--------|
| Language | TypeScript/Bun | Python |
| Routing | System 1/2 | Single path |
| Learning | Skill mutation | Skill creation only |
| Confidence | Wilson score | None |
| Platforms | CLI only | 15+ platforms |
| Gateway | Planned | Implemented |
| Cost | 60-80% cheaper | Standard |

### Nexus vs Claude

| Feature | Nexus | Claude |
|---------|-------|--------|
| Tools | 40+ built-in | Limited |
| Learning | Autonomous | None |
| Memory | Persistent wiki | Session only |
| Multi-provider | 5+ providers | Anthropic only |
| Cost | Optimized | Standard |

## Next Steps

- [Getting Started](../getting-started/quickstart.md) — Start using Nexus
- [Configuration](../user-guide/configuration.md) — Configure Nexus
- [Troubleshooting](./troubleshooting.md) — Common issues
