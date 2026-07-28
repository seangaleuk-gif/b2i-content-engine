# TODO

## Previous Sprints — Phases 1–7, Pipeline Bug Fixes, Chinese Translation Pipeline (Completed)
(see CHANGELOG.md for full history)

## Completed — Stage 7 (Jul 27, 2026)

### Content Standards Module
- `src/lib/content-standards.ts`: canonical thresholds for all structural and quality rules.
- 6 word-count bands with dynamic H2/FAQ ranges.
- Integrated into English and Chinese pipelines.
- All hardcoded thresholds replaced by canonical functions.

### Translation Pipeline Refactor
- Five-module split: `types` / `ai` / `validator` / `assembler` / `orchestration`.
- Deterministic number protection with placeholders + targeted retries.
- Introduction English retry.
- FAQ boundary validation (dynamic budget, truncation failure, content scanning).
- Metadata range compliance (retry + hard-fail, no filler padding).
- Retry budget fixed (`capped` does not trigger exhaustion).
- Unified Chinese density calculation.
- Paired English version stored in `summary` field; SEO audit reads exact source.
- Paired English FAQ fallback parsing.

### Pipeline Fixes
- Nested `<p>` flattening before stage validation.
- CTA always re-injected (not just when null).
- Post-CTA FAQ schema rebuild.
- Word count trim after FAQ recovery + CTA.
- Unified sentence detection (all functions use `splitSentences`).

### Verification
- ✅ 842 tests passing (10 files)
- ✅ Build clean
- ✅ 3 consecutive production translations passed (versions 24-26)
- ✅ All 6 word-count tiers verified
- ✅ `.md` files updated

## Next Sprint — Phase 8: WordPress Integration (Actual Publishing)
- (unchanged — see previous sprint notes)

## Future Ideas
- (unchanged — see previous sprint notes)
