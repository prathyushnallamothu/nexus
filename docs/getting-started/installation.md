# Installation

Install Nexus on your local machine or any infrastructure. Nexus runs on Bun, a fast JavaScript runtime.

## Prerequisites

- **Bun** 1.0 or later ([install](https://bun.sh/docs/installation))
- **Node.js** 18+ (for some tools, optional)
- An API key for your preferred LLM provider

## Quick Install

```bash
# 1. Clone the repository
git clone https://github.com/prathyushnallamothu/nexus.git
cd nexus

# 2. Install dependencies
bun install

# 3. Run the setup wizard
bun run dev setup
```

The setup wizard will guide you through:
- Choosing your AI provider (Anthropic, OpenAI, Google, OpenRouter, Ollama)
- Setting your API key
- Selecting a model
- Configuring your budget
- Optional: installing recommended skills

## Manual Installation

If you prefer manual configuration:

```bash
# 1. Clone and install
git clone https://github.com/prathyushnallamothu/nexus.git
cd nexus
bun install

# 2. Create .env file
echo "ANTHROPIC_API_KEY=sk-..." > .env
echo "NEXUS_MODEL=anthropic:claude-sonnet-4-20250514" >> .env
echo "NEXUS_BUDGET=2.0" >> .env

# 3. Run
bun run dev
```

## Provider API Keys

Set the appropriate environment variable for your provider:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...

# Google Gemini
GOOGLE_API_KEY=AIza...

# OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Ollama (local, no key needed)
# Just set: NEXUS_MODEL=ollama:llama3.3
```

## System Requirements

**Minimum:**
- 2GB RAM
- 1 CPU core
- 100MB disk space

**Recommended:**
- 4GB RAM
- 2 CPU cores
- 1GB disk space (for skills, memory, logs)

## Platform-Specific Notes

### Windows

Nexus runs on Windows via WSL2 or PowerShell. WSL2 is recommended for better compatibility with Unix-based tools.

```powershell
# PowerShell
git clone https://github.com/prathyushnallamothu/nexus.git
cd nexus
bun install
bun run dev setup
```

### macOS

```bash
# Homebrew (recommended)
brew install oven-sh/bun/bun

# Then proceed with normal installation
git clone https://github.com/prathyushnallamothu/nexus.git
cd nexus
bun install
bun run dev setup
```

### Linux

```bash
# Most distributions
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Then proceed with normal installation
git clone https://github.com/prathyushnallamothu/nexus.git
cd nexus
bun install
bun run dev setup
```

## Docker Installation

Run Nexus in a Docker container for isolation:

```bash
# Build the image
docker build -t nexus .

# Run with your API key
docker run -it \
  -e ANTHROPIC_API_KEY=sk-... \
  -v $(pwd)/.nexus:/app/.nexus \
  nexus
```

## Verification

After installation, verify everything is working:

```bash
# Run the doctor command
bun run dev doctor

# Start Nexus
bun run dev
```

You should see the Nexus banner with your model, budget, and loaded skills.

## Next Steps

- [Quickstart Tutorial](./quickstart.md) — Your first conversation with Nexus
- [Configuration](../user-guide/configuration.md) — Advanced configuration options
- [Modes](../user-guide/modes.md) — Create specialized agents
