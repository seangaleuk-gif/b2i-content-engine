# Coding-Assistant Working Rules

## User expectations

The user expects professional-grade diagnosis and repair, not speculative changes, and concise coder prompts.

## Required behavior

- Read the handoff files (start with `B2I-MASTER-HANDOFF-2026-07-31.md`) before editing.
- Inspect actual code and logs before proposing a root cause. Do not guess.
- Keep coder prompts concise and direct; do not bury the requested action under long explanations.
- Protect the verified English pipeline. Do not revisit fixed architecture (FAQ parity, malformed persistence, repetition repair, DeepSeek thinking policy) without evidence.
- Keep changes narrowly scoped to the proven issue.
- Do not reinterpret the requested architecture.
- Do not perform unrelated cleanup.
- Do not silently weaken thresholds or acceptance rules (editorial minimum 80, repetition overlap 0.55).
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
- Keep research dispatch inside `runBlogGeneration` and external-link injection in the pipeline's `external-links` stage.
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

Do not bulk-fix lint during pipeline work. Lint cleanup is a separate maintenance task.

## Database and SQL

Do not ask the coding assistant to execute or invent database SQL unless explicitly requested. Any SQL or migration requiring manual execution must be separated and clearly labeled for the user to run manually.

## Real generation tests

The application cannot reliably substitute unit tests for a real external DeepSeek generation. After code-level verification, the user performs the real English generation. Do not claim end-to-end success before that run completes. The same applies to Traditional Chinese translation.

## Prompt/report style

- Be concise and direct.
- Do not ask the user to upload ZIPs inside coding instructions.
- Do not refer to artificial phases/stages unless they are actual pipeline stages.
- Do not stray from the requested architecture.
