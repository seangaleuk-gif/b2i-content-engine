# New Coding Chat — Start Message

You are continuing work on the B2I Content Engine. Read `NEW_CHAT_HANDOFF.md` (the authoritative handoff) first, then inspect the actual code, tests, and logs before recommending or making any change. Treat `NEW_CHAT_HANDOFF.md` as authoritative where older documentation conflicts with it.

## Verified working state

- English generation is the production-verified baseline (Nuclear Fix v2). Auto-research and external-link generation are working. Do not alter it.
- The active Traditional Chinese (zh-HK) pipeline is exactly **two substantive DeepSeek calls**: one full-document thinking-enabled translation (`max_tokens=65536`) + one bounded editorial review of deterministically selected at-risk units (`max_tokens=12000`).
- Version 28 completed 105/105 coverage and saved successfully. A forensic audit found semantic/register/naturalness problems (e.g. 被見到／被相信, 精製廣告, 濫用創作者, 人肉廣告板, 大名人, 創作者或者KOL) that the deterministic gate cannot catch — this is why the bounded editorial-review call was added.
- The real Cantonese corpus (Words.hk + HKCanCor via PyCantonese 5.0.0) is stored under `src/data/cantonese/` and used for deterministic validation + review-candidate selection only. Corpus examples are **not** injected into the AI translation prompt.
- Simplified Chinese is out of scope.

## Protected, do not revisit without evidence

- English pipeline.
- The one-call translation + bounded editorial review architecture (exactly two substantive calls).
- `max_tokens=65536` for the translation call; thinking enabled for translation and review.
- The real Cantonese corpus and its import pipeline; the authoritative B2I glossary over corpus suggestions.
- Deterministic parity/quality validators and the no-partial-save gate.
- No third call, no retries that generate alternative translations, no fallback pipeline, no SQL/migrations.

## Next action

The bounded editorial-review call is new and its live effect is **not yet verified**. The next action is to have the user run one production translation and inspect the review diagnostics (`result.review`: selected units, reasons, applied patches) to confirm it repairs the Version 28 problems. Then tune candidate selection based on the real output. Do not run a live translation yourself.

## Workflow rules

- The user manually runs all live generations and translations. Do not instruct the coder to run a live generation or translation unless the user explicitly requests it.
- Never mix architecture diagnosis and implementation in one task.
- Keep changes small, reversible and protected by regression tests.
- Report exact root causes, files changed, targeted and full-suite results, TypeScript, build, remaining failures, and anything not verified.
