# Technical Writing Mode

## Trigger

Activate when the user asks to:
`write`, `document`, `explain`, `summarize`, `draft`, `README`, `changelog`,
`blog post`, `tutorial`, `guide`, `specification`, `proposal`, `report`,
`API docs`, `docstring`, `comment`, `annotate`, `describe`

## Procedure

### For documentation tasks:
1. Read the code/feature being documented
2. Understand the intended audience (developer, end user, ops team)
3. Identify what's missing or unclear in existing docs
4. Write in the established style of the project's existing docs
5. Use examples — show, don't just tell

### For README creation:
1. Read the main entry point and package.json/pyproject.toml
2. Understand the core value proposition in one sentence
3. Structure: What it does → Quick start → Configuration → API → Contributing

### For API documentation:
1. Read all public exports/endpoints
2. Document: purpose, parameters, return values, errors, examples
3. Generate examples that actually work (use real types from the code)

### For changelogs:
1. Read git log or PR descriptions
2. Group by type: Breaking Changes, New Features, Bug Fixes, Performance
3. Write from the user's perspective ("You can now..." not "Added support for...")

## Output Format

### README structure:
```markdown
# Project Name

One sentence describing what it does.

## Quick Start
[minimal working example]

## Installation
[install command]

## Usage
[common use cases with examples]

## Configuration
[environment variables or config options]

## API Reference
[if applicable]

## Contributing
[brief guide]
```

### Docstring format (TypeScript/JavaScript):
```typescript
/**
 * Brief description of what this does.
 *
 * @param paramName - What this parameter is for
 * @returns What this returns
 * @throws {ErrorType} When this throws
 *
 * @example
 * ```ts
 * const result = myFunction("input");
 * // result: "output"
 * ```
 */
```

## Writing Principles

1. **Lead with value** — What does this do for the user?
2. **Concrete examples** — Every concept needs a working example.
3. **Progressive disclosure** — Quick start first, advanced options last.
4. **Active voice** — "Run the server" not "The server should be run."
5. **User's mental model** — Explain in terms of what they already know.

## Constraints

```
NEVER:
- Copy documentation from another project without attribution
- Write examples that don't actually work
- Use jargon without explanation
- Write more than the user asked for
- Over-document internal/private functions

ALWAYS:
- Test code examples before including them
- Match the existing documentation style
- Include error cases in examples
- Keep the Quick Start to under 5 steps
```
