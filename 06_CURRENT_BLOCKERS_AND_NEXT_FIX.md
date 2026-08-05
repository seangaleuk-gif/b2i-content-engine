# Current Blockers and Exact Next Fix

> **Authoritative handoff:** `NEW_CHAT_HANDOFF.md`. This file is superseded for current status by the handoff; kept as a historical record of the fixed/verified items.

## Resolved and verified

The previous finalization defects are fixed and verified in a fresh live English generation:

```text
Final validation: PASS
editorial score=94 (minimum: 80)
repeatedPairs=0
malformed=0
FAQ parity valid=true canonical=6 rendered=6 schema=6
external links=6
```

- **FAQ canonical-body-schema parity** — fixed via entity-decoded FAQ extraction and the `final-preflight` parity check. Do not revisit without evidence.
- **Malformed paragraph repair persistence** — fixed via targeted-repair persistence (malformed/weakened/repetition commit even when the general polish is rejected) and the deterministic malformed fallback; plus last-resort malformed resolution before repetition repair.
- **Editorial repetition deadlock** — fixed: keyphrase tokens are excluded from word-set overlap (fixes false positives), repetition repair preserves the earlier paragraph and rewrites only the later duplicate, validates word-set overlap (< 0.55), and applies a bounded deterministic fallback after two failed AI attempts.
- **Robotic `remember` false positive** — fixed (imperative-only detection).
- **Editorial candidate word-count overrun** — fixed by trimming an otherwise improved candidate before rejection (thresholds unchanged).

## Live-verified (now complete)

1. **Automatic research + external links on a normal generation** — verified: `[research-dispatch] willRun=true`, approved research > 0, `[external-links:final] saved=6`, external URLs present in readable body content.
2. **Traditional Chinese translation end-to-end** — verified: project 19, version 6, saved ID 202; 40 API calls, 0 retries, 26 deterministic editorial changes; validation, persistence and audit passed.

## Next task (audit only)

A professional architecture audit of the translation pipeline (see `NEW_CHAT_HANDOFF.md` section 2). Audit-only; no code changes until the user manually switches thinking off.

## Pre-existing technical debt (unchanged baseline)

- 18 failing tests across 6 files (no new regressions) — see `07_TEST_BUILD_LINT_STATUS.md`.
- 2 TypeScript errors in `section-expander.test.ts`.
- 468 lint findings (285 errors / 183 warnings).

## Prohibited changes without evidence

Do not change:

- DeepSeek thinking-mode implementation, model, token budgets, retry multipliers
- General generation prompts
- Editorial minimum (80) or repetition overlap threshold (0.55)
- SEO/factual thresholds
- Translation architecture
- Database schema or persistence
- Concurrency
- Lint configuration
