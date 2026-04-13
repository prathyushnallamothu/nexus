# Memory System

Nexus maintains a persistent knowledge base that compounds across sessions. The Memory System stores facts, procedures, and episodic memories for cross-session recall.

## Memory Types

### Semantic Memory

Facts and general knowledge:
- User preferences and settings
- Project information and conventions
- Technical concepts and definitions
- Best practices and patterns

Stored in `.nexus/memory/semantic/` as vector embeddings for semantic search.

### Episodic Memory

Specific events and experiences:
- Task outcomes and learnings
- Decisions and rationales
- Errors and their resolutions
- Success factors and failures

Stored in `.nexus/memory/episodic/` as structured records.

### Wiki Memory

Persistent knowledge base in markdown:
- Project documentation
- Skill documentation
- Session summaries
- Insights and patterns

Stored in `.nexus/wiki/` as markdown files with FTS5 full-text search.

## Wiki System

The wiki is your primary memory interface. It's a living knowledge base that grows with every session.

### Wiki Structure

```
.nexus/wiki/
├── index.md              # Wiki index
├── user/
│   └── profile.md        # User model (preferences, patterns)
├── projects/
│   └── <project-name>/
│       ├── overview.md    # Project overview
│       ├── decisions.md   # Architectural decisions
│       └── todos.md       # Open items
├── skills/
│   └── <skill-id>.md     # Skill documentation
├── concepts/
│   └── <slug>.md         # Technical concepts
├── insights/
│   └── patterns.md       # Reusable patterns
└── sessions/
    └── YYYY-MM-DD-<slug>.md  # Session summaries
```

### Wiki Tools

Nexus has built-in wiki tools:

- `wiki_read` — Read a wiki page
- `wiki_write` — Write/update a wiki page
- `wiki_log` — Append to chronological log
- `wiki_search` — Search across wiki content
- `wiki_list` — List pages by category
- `wiki_lint` — Health-check the wiki
- `wiki_ingest` — Ingest external documents
- `wiki_save_session` — Archive session transcripts
- `wiki_recall` — FTS5 full-text search (primary memory retrieval)
- `wiki_similar` — Find related pages
- `wiki_observe` — Record user observations

### Using the Wiki

#### Recall Relevant Context

At session start, Nexus recalls relevant prior context:

```
❯ I'm working on the authentication system
```

Nexus automatically runs `wiki_recall` to surface relevant information about authentication from previous sessions.

#### Record Observations

```
❯ I prefer TypeScript over JavaScript for new projects
```

Nexus records this observation and updates your user profile:

```markdown
# User Profile

> Model of user preferences, patterns, and behaviors

Updated: 2025-01-20

## Preferences
- Prefers TypeScript over JavaScript
- Likes concise code
- Values test coverage

## Patterns
- Starts with documentation
- Uses git frequently
- Asks for explanations
```

#### Document Decisions

```
❯ We decided to use PostgreSQL instead of MongoDB because...
```

Nexus documents the decision in the project's decisions.md:

```markdown
# Architectural Decisions

> Key architectural decisions and their rationales

Updated: 2025-01-20

## Database Choice (2025-01-20)

**Decision**: Use PostgreSQL instead of MongoDB

**Rationale**:
- Better for complex queries
- ACID compliance
- Mature tooling
- Team experience

**Trade-offs**:
- Less flexible schema
- Requires migrations
```

#### Save Session Summaries

At session end, Nexus saves a summary:

```markdown
# 2025-01-20-auth-refactor

> Refactored authentication system

**What was asked**: Refactor the authentication system to use JWT tokens

**What was built**:
- Implemented JWT token generation
- Added token refresh logic
- Updated API endpoints
- Added unit tests

**Files modified**:
- src/auth/jwt.ts (new)
- src/api/auth.ts (modified)
- tests/auth.test.ts (new)

**Decisions**:
- Used RS256 for token signing
- Set 1-hour token expiration
- Implemented refresh token rotation

**Open items**:
- Add rate limiting
- Implement token revocation
```

## Memory Recall

Nexus uses FTS5 full-text search with BM25 ranking to recall relevant information:

```
❯ /wiki recall "authentication"
```

Searches across all wiki pages and returns the most relevant matches with scores.

## User Modeling

Nexus builds a model of you over time:

- **Preferences** — What you like and dislike
- **Patterns** — How you typically work
- **Decision history** — Choices you've made
- **Feedback signals** — What you approve or disapprove

This model is used to personalize Nexus's behavior.

## Memory Nudges

Nexus periodically nudges you to refresh important facts:

```
❯ Reminder: You last worked on this project 2 weeks ago. Key context:
- Using PostgreSQL for database
- Authentication uses JWT tokens
- Next milestone: Add rate limiting
```

## Cross-Session Recall

Nexus recalls context across sessions:

1. At session start, it runs `wiki_recall` with your opening message
2. It loads your user profile
3. It loads the active project overview if relevant
4. It surfaces relevant skills and patterns

## Memory Compression

Nexus compresses memory to manage size:

- Old sessions are archived
- Duplicate information is merged
- Less-used memories become less prominent
- Frequently-used memories are strengthened

## Best Practices

1. **Let Nexus manage the wiki** — Don't manually edit wiki files. Let Nexus write them.
2. **Use wiki_recall** — Ask Nexus to recall relevant context before starting a task.
3. **Review session summaries** — Check that session summaries capture important information.
4. **Run wiki_lint** — Periodically health-check the wiki for orphans and stale pages.
5. **Ingest external docs** — Use `wiki_ingest` to add external documentation to your wiki.

## Next Steps

- [Skills System](./skills.md) — How Nexus learns from tasks
- [Modes](./modes.md) — Create specialized agents
- [Tools](./tools.md) — Available tools and how to use them
