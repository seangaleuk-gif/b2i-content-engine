# Coding-Assistant Working Rules

## User expectations

The user expects professional-grade diagnosis and repair, not speculative changes.

## Required behavior

- Read the handoff files before editing.
- Inspect actual code before proposing a root cause.
- Keep changes narrowly scoped to the proven issue.
- Do not reinterpret the requested architecture.
- Do not perform unrelated cleanup.
- Do not silently weaken thresholds or acceptance rules.
- Do not describe a build as production ready unless real generation and translation acceptance tests pass.
- Never claim a failure is pre-existing without comparative evidence.
- Report partial or failed work honestly.

## Code changes

- Preserve single ownership.
- Remove superseded paths rather than adding compatibility wrappers.
- Use canonical `ArticleDocument` state.
- Use stable block IDs.
- Keep AI access inside `AiService`.
- Keep final pass/fail inside the centralized validation path.
- Add behavioral regression tests for every bug fix.

## Testing reports

Every completion report must include:

1. Exact root cause proven by code/logs
2. Files changed
3. Behavioral change
4. Targeted test results
5. Full-suite results and exact delta
6. TypeScript result
7. Build result
8. Remaining known failures
9. Anything not verified

## Lint

Do not bulk-fix lint during pipeline repair. Lint cleanup is a separate maintenance task.

## Database and SQL

Do not ask the coding assistant to execute or invent database SQL unless explicitly requested. Any SQL or migration requiring manual execution must be separated and clearly labeled for the user to run manually.

## Real generation tests

The application cannot reliably substitute unit tests for a real external DeepSeek generation. After code-level verification, the user performs the real English generation. Do not claim end-to-end success before that run completes.

## Prompt/report style

- Be concise and direct.
- Do not bury the requested action under long explanations.
- Do not ask the user to upload ZIPs inside coding instructions.
- Do not refer to artificial phases/stages unless they are actual pipeline stages.
- Do not stray from the requested architecture.
