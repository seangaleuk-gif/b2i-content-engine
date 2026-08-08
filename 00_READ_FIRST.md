# B2I Content Engine — Read First

**Authoritative handoff date:** 8 August 2026

The authoritative handoff is `NEW_CHAT_HANDOFF.md`. Read it and the other files in this pack before inspecting or modifying code. Older statements in project Markdown files that conflict with the handoff are stale. `B2I-MASTER-HANDOFF-2026-07-31.md` is superseded by `NEW_CHAT_HANDOFF.md`.

## Current verified state (summary)

- The latest B2I-9 full-pipeline root audit is documented in
  `FULL_PIPELINE_ROOT_AUDIT_2026-08-08.md`.
- Staged English generation and canonical `ArticleDocument` ownership are
  preserved.
- Malformed model WordPress output is rejected; production stages do not call
  `rebalanceWpBlocks()`.
- Traditional Chinese acceptance is unified before save, after readback and at
  publication, including source-aware literal-translation checks.
- Simplified Chinese is out of scope.
- Offline/mocked verification: English blog/pipeline/generation/route
  **1,044/1,044**; selected translation/service/route suites **495/495**;
  TypeScript pass; production
  build pass.
- Lint: **444 findings** (268 errors/176 warnings), versus a fresh run on the
  exact recovered input baseline of 445 (269/176).
- The provider-capable document-context batch was safety-blocked and is not
  claimed as passing. Live production verification remains required.

## Next task

Deploy the audited package in a controlled environment, run one English
generation and three consecutive live Traditional Chinese translations, and
retain the resulting diagnostics as operational acceptance evidence.

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
