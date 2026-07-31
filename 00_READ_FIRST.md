# B2I Content Engine — Read First

**Authoritative handoff date:** 31 July 2026, 16:55 Singapore/Hong Kong time

This folder is the current handoff for the next coding-assistant chat. Read every file before proposing or making changes.

## Authority and stale documentation warning

This handoff supersedes old status statements in existing project Markdown files where they conflict with this pack. In particular, old claims such as “842 tests passing,” “1,189 tests passing,” or “Nuclear Fix v2 is the current working baseline” are stale and must not be treated as the present status.

The current project compiles and starts, and DeepSeek request latency has been repaired. However, **English generation still fails final validation**, so there is no currently confirmed production-ready generation baseline.

## Current immediate task

Fix only the latest final-validation consistency defects:

1. FAQ visible-body/schema parity after factual and editorial mutations.
2. Malformed paragraph repair persistence by stable block ID.
3. Re-run the existing editorial scorer after those defects are fixed.
4. Keep the editorial minimum at 80.

Do not change DeepSeek thinking-mode handling, model name, generation prompts, SEO thresholds, factual rules, translation architecture, database code, concurrency, or token budgets while fixing this task.

## Read order

1. `01_PROJECT_STATUS.md`
2. `02_ARCHITECTURE_NON_NEGOTIABLES.md`
3. `03_DEEPSEEK_REQUEST_POLICY.md`
4. `04_ENGLISH_GENERATION_PIPELINE.md`
5. `05_TRANSLATION_PIPELINE.md`
6. `06_CURRENT_BLOCKERS_AND_NEXT_FIX.md`
7. `07_TEST_BUILD_LINT_STATUS.md`
8. `08_CHANGELOG_LATEST.md`
9. `09_CODER_WORKING_RULES.md`
10. `NEW_CHAT_START_PROMPT.md`
