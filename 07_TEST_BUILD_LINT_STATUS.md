# Test, TypeScript, Build, and Lint Status

**Verified:** 1 August 2026 (evening, latest development totals)

> These totals are current only as of the latest recorded run. **Do not present them as current after future code changes unless rerun.**

## Full suite

```text
Tests       11 failed | 1630 passed (1641 total)
```

The 11 failures are the **unchanged pre-existing baseline** — zero new regressions from the coherent-chunk translation shadow, the bilingual editorial shadow, or the deterministic Cantonese repair work.

Failing files and counts:

- `src/lib/blog/final-seo-normalizer.test.ts` — 4 (pre-existing contract/empty-state tests)
- `src/lib/pipeline/blog-generation-e2e.test.ts` — 1 (pre-existing language-switcher fixture href guard; production-safe)
- `src/lib/services/component-regenerator.test.ts` — 2 (pre-existing)
- `src/lib/services/section-expander.test.ts` — 2 (pre-existing; same file carries the 2 known TypeScript errors)
- `src/lib/services/translation-service.test.ts` — 2 (pre-existing; includes real-DeepSeek timeouts)

## Shadow suites (all passing)

- `translation-source-document.test.ts` — 20/20
- `translation-chunk-planner.test.ts` — 23/23
- `document-context-translation-shadow.test.ts` — 34/34
- `document-context-translation-shadow.integration.test.ts` — 6/6
- `translation-ai.test.ts` — 3/3
- `document-context-shadow-preview.test.ts` — 23/23
- **Total shadow suites: 110/110** (before the latest audit-only task)

## Other targeted suites (all passing)

- `src/lib/services/translation-editorial-normalization.test.ts` — 57/57
- `src/lib/blog/final-seo-normalizer.test.ts` — 5/5 Chinese final editorial diagnostics (of 424 total in the file)
- `src/lib/services/editorial-block-translation.test.ts` — 93/93
- `src/lib/pipeline/blog-generation-pipeline.test.ts`, `blog-generation-service.test.ts`, `editorial-repetition-repair.test.ts`, `publication-quality.test.ts`, `editorial-polish.test.ts` — passing

## TypeScript

`npx tsc --noEmit`:

```text
2 errors
src/lib/services/section-expander.test.ts (29:24, 63:24)
```

Both byte-identical to the previous baseline (pre-existing). No new TypeScript errors.

## Production build

- `npm run build`: passes
- Next.js/Turbopack compilation: passes
- TypeScript in build graph: passes
- No build warnings

## Lint baseline

```text
467 problems: 284 errors, 183 warnings
```

Down one from the prior 468 baseline (one `as any` cast removed in `chatWithBudget`). No new lint issues from the shadow work.

## Reporting rule

Reports must distinguish:

- new failures
- unchanged known failures
- fixed failures
- tests not run
