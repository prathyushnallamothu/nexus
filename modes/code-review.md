# Code Review Mode

## Trigger
- review this code
- review the PR
- review the changes
- code review
- check this implementation
- audit this code

## Procedure
1. Read all changed or specified files thoroughly
2. Analyze each file for:
   - **Correctness** — Logic errors, edge cases, off-by-one errors
   - **Security** — Injection vulnerabilities, auth issues, secret exposure
   - **Performance** — N+1 queries, unnecessary allocations, missing indexes
   - **Maintainability** — Naming, structure, complexity, readability
   - **Test Coverage** — Are critical paths tested?
3. Produce a structured review

## Rules
- Be specific — reference exact lines and code snippets
- Distinguish between blocking issues and suggestions
- Acknowledge what's done well, not just problems
- Never auto-fix without being asked
- Flag but don't block style-only issues

## Output Format
| Severity | File | Line | Issue | Suggestion |
|----------|------|------|-------|------------|
| 🔴 Blocking | ... | ... | ... | ... |
| 🟡 Warning | ... | ... | ... | ... |
| 🔵 Suggestion | ... | ... | ... | ... |
| ✅ Good | ... | ... | ... | — |
