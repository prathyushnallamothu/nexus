# Skills System

Nexus learns from every task. The Skills System captures procedural knowledge and reuses it for similar future tasks, reducing cost and latency over time.

## How Skills Work

When Nexus completes a task:
1. It analyzes the execution trajectory (steps taken, tools used, outcome)
2. It reflects on what worked and what didn't
3. It creates or mutates a skill if the task is repeatable
4. It evaluates the skill's confidence using Wilson score intervals
5. It promotes the skill to trusted status if it performs well

On future tasks:
1. The router checks if a relevant skill exists
2. If found, it uses System 1 (fast path) to execute the skill
3. This is 60-80% cheaper than full reasoning
4. The skill self-mutates if it fails, learning from mistakes

## Skill Lifecycle

```
Task Execution → Trajectory Storage → Reflection → Skill Creation
                                                ↓
                                          Skill Mutation
                                                ↓
                                          Shadow Evaluation
                                                ↓
                                          Approval (auto or manual)
                                                ↓
                                          Trusted Status
                                                ↓
                                          Retirement (if underperforming)
```

### Draft

Newly created skills start in draft status. They are not used for routing yet.

### Pending Review

Skills that pass initial checks move to pending review. They can be used but with caution.

### Trusted

Skills with proven performance (high Wilson confidence) are trusted and used automatically via System 1.

### Retired

Skills that consistently underperform are retired and removed from the skill store.

## Skill Format

Skills are stored as markdown files in `.nexus/skills/`:

```markdown
# deploy-to-vercel

> Deploy a Next.js application to Vercel

Updated: 2025-01-15

## When to Use

Use this skill when you need to deploy a Next.js application to Vercel.

## Prerequisites

- Node.js 18+ installed
- Vercel CLI installed (`npm i -g vercel`)
- Vercel account and authentication

## Procedure

1. Install Vercel CLI: `npm install -g vercel`
2. Login to Vercel: `vercel login`
3. Run deployment: `vercel --prod`
4. Confirm deployment URL

## Success Criteria

- Deployment completes without errors
- Production URL is returned
- Application is accessible at the URL

## Failure Modes

- Authentication failure → Re-run `vercel login`
- Build errors → Check build logs, fix errors, retry
- Timeout → Check Vercel status, retry

## Statistics

- Uses: 15
- Success rate: 93%
- Wilson confidence: 0.87
- Last used: 2025-01-20
```

## Wilson Score Confidence

Nexus uses Wilson score intervals to statistically evaluate skill performance:

- **High confidence (0.8+)**: Skill is trusted and used automatically
- **Medium confidence (0.5-0.8)**: Skill is used with caution
- **Low confidence (<0.5)**: Skill is not used for routing

This prevents premature promotion of unproven skills and ensures only reliable skills are used in System 1.

## Skill Mutation

When a skill fails, Nexus:
1. Analyzes the failure
2. Identifies the problematic step
3. Mutates the skill procedure to fix it
4. Re-evaluates confidence
5. Promotes back to trusted if it performs well

This continuous improvement means skills get better over time.

## Managing Skills

### List Skills

```
❯ /skills
```

Shows all learned skills with their status and confidence.

### View a Skill

```
❯ /skill view deploy-to-vercel
```

Displays the full skill markdown file.

### Delete a Skill

```
❯ /skill delete deploy-to-vercel
```

Removes a skill from the store.

### Export Skills

Skills are compatible with the [agentskills.io](https://agentskills.io) format. Export them to share with others:

```bash
# Export all skills
nexus skills export ./skills-export/

# Export a specific skill
nexus skills export ./skills-export/ deploy-to-vercel
```

### Import Skills

Import skills from agentskills.io format:

```bash
# Import from a directory
nexus skills import ./skills-import/

# Import from agentskills.io
nexus skills install openai/skills/k8s
nexus skills install official/security/1password
```

## Skill Discovery

Nexus automatically discovers skills from:
- Task trajectories (automatic creation)
- agentskills.io marketplace (manual installation)
- Community repositories (manual import)

## Best Practices

1. **Let Nexus learn** — Don't manually create skills. Let Nexus learn from your tasks.
2. **Review before trusting** — Check new skills before they reach trusted status.
3. **Monitor performance** — Use `/stats` to track skill success rates.
4. **Share good skills** — Export and share skills that work well.
5. **Retire bad skills** — Delete skills that consistently underperform.

## Comparison to Other Systems

| Feature | Nexus | Hermes | Goose |
|---------|-------|--------|-------|
| Skill Creation | Automatic from trajectories | Automatic from trajectories | No creation |
| Skill Mutation | Self-mutates on failure | No mutation | No mutation |
| Confidence Scoring | Wilson score intervals | None | None |
| Auto Retirement | Yes | No | No |
| Shadow Evaluation | Yes | No | No |
| agentskills.io | Compatible | Compatible | No |

## Advanced Topics

### Custom Skill Evaluation

Configure how Nexus evaluates skills:

```json
{
  "learning": {
    "autoApprove": true,
    "runShadowEval": false,
    "retirementSuccessThreshold": 0.4,
    "minUsesForTrusted": 5
  }
}
```

### Skill Composition

Skills can reference other skills. Nexus resolves dependencies automatically.

### Project-Scoped Skills

Skills can be project-specific (stored in `.nexus/skills/`) or global (stored in `~/.nexus/skills/`).

## Next Steps

- [Memory System](./memory.md) — Persistent knowledge base
- [Modes](./modes.md) — Create specialized agents
- [Tools](./tools.md) — Available tools and how to use them
