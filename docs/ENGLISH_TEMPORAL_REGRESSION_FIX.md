# English Temporal Freshness Regression Fix

Date: 2026-07-31

## Failure corrected

The previous freshness stage removed a complete stale sentence directly from the canonical English article. That deletion could change the factual distribution and editorial structure after factual scanning and claim ownership had already completed. In the reported run it left four repeated idea pairs, created one new numeric claim in the conclusion, reduced the factual score to 85, and reduced the editorial score to 47.

## New behavior

1. Stale temporal wording is detected after factual scanning and claim ownership.
2. Deterministic repair removes only the expired predictive clause when a complete supported sentence remains.
3. A whole stale sentence may be removed only when another complete sentence remains in the same plain-text block.
4. Links and inline formatting are never flattened or deleted. Unsafe cases remain unresolved and fail closed.
5. The freshness candidate is compared with the exact pre-stage article.
6. The candidate is rejected and the full pipeline snapshot is restored if any of these regress:
   - factual reliability
   - unsupported factual claims
   - claim ownership
   - factual contradictions
   - conclusion numeric claims
   - repeated ideas
   - malformed prose
   - editorial score
   - accepted word-count range
7. A rejected freshness candidate can no longer continue into editorial polish or final validation as the working article.
8. Valid historical dates remain untouched.

## Exact supplied sentence

Before:

> With the platform's user base still growing and advertising features expected to expand later in 2025, getting your profile ready now positions you ahead of the curve.

After:

> With the platform's user base still growing, getting your profile ready now positions you ahead of the curve.

The stale forecast is removed without deleting the supported guidance or creating a replacement current-status claim.

## Translation isolation

The translation, repository normalization, FAQ typing, metadata fallback, Chinese parity validation, and compensated bilingual persistence changes from v3.2 are preserved. This patch changes only the temporal-freshness module, its tests, and the guarded English pipeline stage.

## Verification

- Exact supplied stale sentence: clause-level rewrite passed.
- Standalone stale sentence surrounded by valid prose: safe sentence removal passed.
- Historical 2023/2025 statistic: preserved.
- Link-bearing stale wording: left unresolved without changing the URL or markup.
- Regression guard: tests cover repetition, conclusion-number, factual-score and editorial-score regression.
- Repository TypeScript/TSX syntax audit: passed.
- Modified production graph strict semantic TypeScript audit: passed.
- Modified regression-test graph strict semantic TypeScript audit: passed.

The native Next.js build and Vitest suite must be run in the installed project environment because this container cannot retrieve the project's npm dependencies from its configured package registry.
