# B2I Content Engine Editorial Audit

**Status: historical audit record — superseded by `B2I-MASTER-HANDOFF-2026-07-31.md`.**

This document records the editorial audit performed 30–31 July 2026. All findings below are resolved in the current code unless stated otherwise.

## Resolved findings

### FAQ canonical-body-schema parity (fixed, production verified)

- Root cause: HTML round-trips re-parsed FAQ `answerText`/`question` without decoding entities, so the FAQPage schema (rendered from the encoded text) mismatched the entity-decoded visible body.
- Fix: entity decoding in `extractVisibleFaqFromArticle`/`extractFaqPairsFromSectionBody`; `final-preflight` verifies canonical/rendered/schema counts immediately before final validation.
- Verified: live run `[final-preflight] FAQ parity valid=true canonical=5 rendered=5 schema=5`. (Later verified runs report 6/6/6; see `NEW_CHAT_HANDOFF.md`.)

### Malformed paragraph repair persistence (fixed, production verified)

- Root cause: the editorial transaction discarded successful targeted repairs when the final editorial score was below 80, so a repaired malformed block was resurrected.
- Fix: targeted repairs (malformed, weakened, repetition) commit to canonical state even when the score-gated general polish is rejected; deterministic malformed fallback removes unresolvable fragments.
- Verified: live run `malformedRemaining=0`.

### Editorial repetition deadlock (fixed, production verified)

- Root cause: repetition repair was blind (no partner context) and selected the "strongest" paragraph by word count, often preserving the later duplicate.
- Fix: order-based targeting preserves the earlier paragraph and rewrites only the later duplicate; the prompt supplies the preserved partner and duplicated idea; per-target overlap must drop below 0.55; bounded deterministic fallback after two failed AI attempts.
- Verified: live run `[editorial-repetition-repair] accepted score=30 → 94`, final editorial score 94, repeatedPairs 0.

### Robotic phrase false positive (fixed)

- `remember` is only counted as robotic in imperative form; "people will remember" no longer deducts points.

## Current editorial state (2026-07-31 evening)

- Editorial minimum: 80 (unchanged).
- Fresh live generation: editorial score 94, repeatedPairs 0, malformed 0, robotic 2, final validation PASS.
- Remaining live verification: automatic research + external links on a normal generation; Traditional Chinese translation end-to-end.
- Pre-existing debt: 18 failing tests (unchanged baseline), 2 TypeScript errors in `section-expander.test.ts`, 468 lint findings.
