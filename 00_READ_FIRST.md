# B2I Content Engine — Read First

**Authoritative handoff date:** 1 August 2026

The authoritative handoff is `NEW_CHAT_HANDOFF.md`. Read it and the other files in this pack before inspecting or modifying code. Older statements in project Markdown files that conflict with the handoff are stale. `B2I-MASTER-HANDOFF-2026-07-31.md` is superseded by `NEW_CHAT_HANDOFF.md`.

## Current verified state (summary)

- **English generation is the production-verified working baseline.** Latest verified live result: editorial score **94**, repeated pairs **0**, malformed **0**, FAQ parity **6/6/6**, external links **6**, internal links **4**, keyphrase density **1.08%**, final validation **PASS**.
- Auto-research and external-link generation are working (live verified).
- Keyphrase exclusion is consistent across editorial and final validation.
- Editorial minimum remains **80**; repetition overlap threshold remains **0.55**.
- **Traditional Chinese translation is live verified** (project 19, version 6, saved ID 202; 40 API calls, 0 retries, 26 deterministic editorial changes; `deepseek-v4-flash`, thinking disabled). Structural translation works; source-label and paragraph punctuation fixed; FAQ/schema parity and CTA preserved; natural HK code-switching allowed.
- Simplified Chinese is out of scope.
- Test baseline: **18 pre-existing failures, 1,473 passing** in the last recorded full-suite result.
- Lint baseline: **468 findings** (285 errors, 183 warnings). Build passes.
- Two pre-existing TypeScript errors remain in `section-expander.test.ts`.

## Next task

A professional architecture audit of the translation pipeline (see `NEW_CHAT_HANDOFF.md` section 2). Audit-only; no code changes until the user manually switches thinking off.

## Read order

1. `NEW_CHAT_HANDOFF.md`
2. `01_PROJECT_STATUS.md`
3. `02_ARCHITECTURE_NON_NEGOTIABLES.md`
4. `03_DEEPSEEK_REQUEST_POLICY.md`
5. `04_ENGLISH_GENERATION_PIPELINE.md`
6. `05_TRANSLATION_PIPELINE.md`
7. `06_CURRENT_BLOCKERS_AND_NEXT_FIX.md`
8. `07_TEST_BUILD_LINT_STATUS.md`
9. `08_CHANGELOG_LATEST.md`
10. `09_CODER_WORKING_RULES.md`
11. `NEW_CHAT_START_PROMPT.md`
