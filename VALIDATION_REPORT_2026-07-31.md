# VALIDATION_REPORT_2026-07-31

Clean verification audit of the latest repaired B2I Content Engine project.
Commands run separately from the project root. No files were modified by the audit.
Logs were captured in full and are appended verbatim at the end of this report.

---

## Environment

- Node version: v26.5.0
- npm version: 11.17.0
- Operating system: Microsoft Windows 11 Home (win32)
- Current project directory: C:\Users\sean_\b2i-content-engine
- Git branch / commit: branch `main`, HEAD `c2c75c7` (`Pre-GPT fixes: translation pipeline, SEO audit, and content standards`)
- Working tree: 52 changed/untracked paths (includes the latest translation/editorial repair in uncommitted changes and commit c2c75c7)
- `node_modules` installed cleanly with `npm ci`: **YES** (exit 0, "added 420 packages, and audited 421 packages in 45s")
- npm ci warnings (non-fatal): 16 audit vulnerabilities (4 moderate, 12 high) reported by npm itself; deprecated @esbuild-kit packages; `allow-scripts` warnings that esbuild@0.18.20/0.25.12/0.28.1, sharp@0.34.5, unrs-resolver@1.12.2 postinstall scripts were not approved. These did not affect ci, lint, test, or build.
- `.env.local` is present (Supabase URLs/keys, DATABASE_URL, BRAVE_API_KEY, DEEPSEEK_API_KEY, AGNES_API_KEY, HF_TOKEN, WP credentials, ENABLE_EDITORIAL_POLISH=true). The DEEPSEEK_API_KEY in `.env.local` is rejected by the DeepSeek API during tests (HTTP 401 "Authentication Fails"); the key was NOT modified.

---

## Lint

- **Result:** FAIL
- **Exit code:** 1
- **Duration:** 13.94 s
- **Total problems:** 468 (285 errors, 183 warnings)
- 7 errors / 0 warnings were "potentially fixable with the --fix option" (not run, per instructions).
- This total is **byte-for-byte identical to the documented baseline** (07_TEST_BUILD_LINT_STATUS.md: "468 problems: 285 errors, 183 warnings"). The repair introduced **no new lint findings**.

### Rule names (distinct problems) and grouped counts

| Rule | Errors | Warnings | Total |
| --- | ---: | ---: | ---: |
| @typescript-eslint/no-explicit-any | 269 | 0 | 269 |
| @typescript-eslint/no-unused-vars | 0 | 176 | 176 |
| prefer-const | 7 | 0 | 7 |
| @typescript-eslint/no-require-imports | 5 | 0 | 5 |
| react-hooks plugin / React Compiler diagnostics | 4 | 0 | 4 |
| react-hooks/exhaustive-deps | 0 | 4 | 4 |
| jsx-a11y/alt-text | 0 | 2 | 2 |
| next/no-img-element | 0 | 1 | 1 |
| **Total** | **285** | **183** | **468** |

React Compiler diagnostics (4 errors): `Calling setState synchronously within an effect can trigger cascading renders` x2 (src/app/projects/[id]/page.tsx:242, src/app/settings/page.tsx:117), `Compilation Skipped: Existing memoization could not be preserved` (src/app/projects/[id]/seo/page.tsx:111), `Expected the dependency list for useCallback to be an array literal` (src/lib/use-data.ts:31).

### Every affected file (93)

```
C:\Users\sean_\b2i-content-engine\debug-parse5.js  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\scripts\check-order.mjs  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\scripts\inspect-article.js  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\scripts\run-production-generation.ts  errors=4 warnings=2
C:\Users\sean_\b2i-content-engine\src\app\api\debug\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\generate-blog\route.ts  errors=3 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\images\delete\route.ts  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\images\generate\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\images\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\research\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\seo\audit\route.ts  errors=3 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\seo\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\translate\route.ts  errors=8 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\versions\route.ts  errors=2 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\projects\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\api\prompt-sections\route.ts  errors=3 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\publish-blog\route.ts  errors=11 warnings=0
C:\Users\sean_\b2i-content-engine\src\app\api\suggested-links\route.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\knowledge\page.tsx  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\WorkflowStepper.tsx  errors=10 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\blog\page.tsx  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\chinese-seo\page.tsx  errors=3 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\competitor\page.tsx  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\images\page.tsx  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\page.tsx  errors=4 warnings=6
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\research\page.tsx  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\seo\page.tsx  errors=1 warnings=2
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\social\page.tsx  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\translation\page.tsx  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\app\projects\page.tsx  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\app\settings\links\page.tsx  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\app\settings\page.tsx  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\src\db\schema\suggested-links.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\blog\article-content.ts  errors=24 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\blog\article-document.ts  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\blog\article-integrity.ts  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\blog\final-article-policy.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\blog\final-seo-normalizer.protection.test.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\blog\final-seo-normalizer.test.ts  errors=20 warnings=19
C:\Users\sean_\b2i-content-engine\src\lib\blog\final-seo-normalizer.ts  errors=1 warnings=17
C:\Users\sean_\b2i-content-engine\src\lib\pipeline\blog-generation-pipeline.test.ts  errors=6 warnings=4
C:\Users\sean_\b2i-content-engine\src\lib\pipeline\blog-generation-pipeline.ts  errors=14 warnings=12
C:\Users\sean_\b2i-content-engine\src\lib\pipeline\verify-word-count-tiers.test.ts  errors=2 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\repositories\activity.ts  errors=3 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\ai-logs.ts  errors=2 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\blog-versions.ts  errors=12 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\generation-analytics.ts  errors=6 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\images.ts  errors=5 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\internal-links.ts  errors=6 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\knowledge.ts  errors=6 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\profiles.ts  errors=3 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\projects.ts  errors=8 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\prompt-sections.ts  errors=3 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\repositories\prompts.ts  errors=6 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\research.ts  errors=5 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\seo.ts  errors=8 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\social.ts  errors=6 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\repositories\suggested-links.ts  errors=6 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\auth.test.ts  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\blog-generation-service.test.ts  errors=2 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\blog-generation-service.ts  errors=21 warnings=19
C:\Users\sean_\b2i-content-engine\src\lib\services\component-regenerator.ts  errors=0 warnings=5
C:\Users\sean_\b2i-content-engine\src\lib\services\conclusion-shadow-evaluator.test.ts  errors=1 warnings=5
C:\Users\sean_\b2i-content-engine\src\lib\services\conclusion-shadow-evaluator.ts  errors=0 warnings=3
C:\Users\sean_\b2i-content-engine\src\lib\services\conclusion-shadow-evidence.test.ts  errors=4 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\deepseek.test.ts  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\services\default-links.ts  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-protection.test.ts  errors=3 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-protection.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-translation.test.ts  errors=5 warnings=8
C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-translation.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\errors.test.ts  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\fixers.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\generation-telemetry.ts  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\services\images.ts  errors=1 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\link-injector.ts  errors=1 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\services\link-suggester.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\project-authorization.test.ts  errors=5 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\prompt-builder.ts  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\services\quality-scorer.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\seo-auditor.ts  errors=5 warnings=6
C:\Users\sean_\b2i-content-engine\src\lib\services\text-utils.ts  errors=2 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-ai.ts  errors=2 warnings=0
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-assembler.ts  errors=0 warnings=6
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-dto.test.ts  errors=4 warnings=6
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-dto.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-service.test.ts  errors=14 warnings=5
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-service.ts  errors=3 warnings=3
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-types.ts  errors=0 warnings=2
C:\Users\sean_\b2i-content-engine\src\lib\services\translation-validator.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\services\wordpress.ts  errors=0 warnings=1
C:\Users\sean_\b2i-content-engine\src\lib\use-data.ts  errors=1 warnings=2
```

### Errors inside files changed by the translation/editorial repair

| Repair file | Errors | Warnings |
| --- | ---: | ---: |
| src/lib/pipeline/blog-generation-pipeline.ts | 14 | 12 |
| src/lib/pipeline/blog-generation-pipeline.test.ts | 6 | 4 |
| src/lib/blog/article-document.ts | 0 | 2 |
| src/lib/services/translation-service.ts | 3 | 3 |
| src/lib/services/translation-ai.ts | 2 | 0 |
| src/lib/services/editorial-block-translation.ts | 0 | 1 |
| src/lib/services/editorial-block-translation.test.ts | 5 | 8 |

All of these are `@typescript-eslint/no-explicit-any` / `no-unused-vars` / `prefer-const` findings of the same classes present across the whole codebase. Totals exactly match the pre-repair baseline, so the repair added no new lint errors.

---

## Tests

- **Result:** FAIL
- **Exit code:** 1
- **Duration:** 37.98 s
- **Total test files:** 29
- **Passed test files:** 22
- **Failed test files:** 7
- **Total tests:** 1411
- **Passed tests:** 1387
- **Failed tests:** 24
- **Skipped tests:** 0

### Comparison with previous known baseline

Previous known baseline (handoff): 1382 passed / 23 failed (1405 tests).
Current verified numbers: **1387 passed / 24 failed (1411 tests)**.
Delta: +6 tests, +5 passed, +1 failed, +1 net new failure. The single new failing test is the structured-fallback test below; every other failing test already failed in the prior working tree.

### Every failing test (24)

1. src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
2. src/lib/blog/final-seo-normalizer.test.ts > normalizer acceptance logic > missing CTA triggers rejection
3. src/lib/blog/final-seo-normalizer.test.ts > pipeline stage 2 integration > internal-links before seo-normalization order is enforced
4. src/lib/blog/final-seo-normalizer.test.ts > single validation path > runFinalValidation is the single gating validation
5. src/lib/blog/final-seo-normalizer.test.ts > single validation path > failed final validation blocks persistence behavior
6. src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
7. src/lib/services/component-regenerator.test.ts > component regeneration boundaries > strips regenerated links that are not present in research
8. src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
9. src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
10. src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
11. src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
12. src/lib/services/editorial-block-translation.test.ts > translateEditorialBlocks > uses the structured fallback when HTML translation echoes English  **<-- NEW failure (repair-related)**
13. src/lib/services/editorial-block-translation.test.ts > translateEditorialBlocks > parser errors throw EditorialBlockTranslationError with component ID
14. src/lib/services/editorial-block-translation.test.ts > structured number/link validation is authoritative > translated visible label with unchanged URL passes
15. src/lib/services/editorial-block-translation.test.ts > structured number/link validation is authoritative > parsed blocks validated before structured number/link checks
16. src/lib/services/editorial-block-translation.test.ts > structured number/link validation is authoritative > diagnostics include component ID in error messages
17. src/lib/services/editorial-block-translation.test.ts > block-level number protection lifecycle > source text without numbers passes through unchanged
18. src/lib/services/section-expander.test.ts > section expansion safety > uses the pipeline canonical word counter after every accepted expansion
19. src/lib/services/section-expander.test.ts > section expansion safety > rejects an AI expansion that invents a link
20. src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper failure is surfaced so English fallback cannot be persisted
21. src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
22. src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
23. src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
24. src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response

### Key assertion differences / stack traces (summary; full output appended)

- **#1 e2e:** `AssertionError: expected false to be true` at blog-generation-e2e.test.ts:256 — `stageOutputs.every(output => output.accepted)`. Root cause previously proven: the language-switcher stage re-renders the fixture's `/blog/test-zh` switcher link to the slug-derived href; `validateFinalArticleIntegrity`'s `extractLinkHrefs` computes `wpHtmlRanges` but never applies the exclusion (dead code), so the href change is flagged as "Missing link destinations: /blog/test-zh". Fixture-only; production is unaffected because the initial switcher href is generated from the same slug.
- **#2 normalizer:** `expected true to be false` at :1330 — `shouldAcceptSeoNormalization` no longer checks `ctaPreserved` (pre-existing working-tree change); the test still expects a missing CTA to reject.
- **#3 normalizer:** `expected false to be true` at :5011 — the working-tree `expectedOrder` moved `internal-links` after `seo-normalization` (matching the actual pipeline); the test still expects the old order to be flagged.
- **#4/#5 normalizer:** `TypeError: Cannot read properties of null (reading 'introduction')` in `countUnsupportedFactualClaims` (final-article-policy.ts:330) via `runFinalValidation` — the test's empty state has a null `articleDoc`.
- **#6/#7 component-regenerator:** assertion on regenerated content not present; and `Error: regenerated-section-unowned returned invalid structured blocks: AI payload must contain a 'blocks' array` (component-regenerator.ts:229).
- **#8-#11 conclusion-shadow-evidence:** all `Error: Test timed out in 5000ms` — these tests drive the real `translateArticle` path with the shadow flags; real DeepSeek calls are made and fail (401 "Authentication Fails" / `DEEPSEEK_API_KEY environment variable is not configured`), exhausting retries until timeout. Environment credential issue, present in the prior baseline.
- **#12 editorial-block-translation (NEW):** `expected '<!-- wp:paragraph --><p>Hello World w…' to contain '香港團隊錄得'` at :204. The English echo `Hello World with 25% growth` was returned as a passed result; the structured fallback never ran.
- **#13/#15/#16 editorial-block-translation:** `promise resolved "{ blocks: [ … ] }" instead of rejecting` — the mock error payloads are no longer rejected but returned as fallback results.
- **#14/#17 editorial-block-translation:** `expected true to be false / expected false to be true` — structured number/link validation not authoritatively blocking.
- **#18/#19 section-expander:** `AssertionError: expected '…Start with a …' to be '…Start with a …'` (invented link not rejected) and canonical word counter mismatch.
- **#20 translation-service:** `expected [ 'zh-intro-editorial', …(10) ] to include 'section-0'`.
- **#21 translation-service:** `expected 2 to be 1` — shadow-disabled default produced 2 conclusion calls.
- **#22-#24 translation-service:** `Error: Test timed out in 5000ms` — real DeepSeek calls (401/timeout) in the structured conclusion shadow callbacks.

### Pre-existing vs repair-connected

- 23 of 24 failures are present in the committed baseline / prior working tree (same files and same failure counts as the documented 23).
- The 1 new failure (#12) is a test added by the latest repair (absent at HEAD and HEAD~1; `+it(...)` in the uncommitted diff) and it fails.

---

## Build

- **Result:** PASS
- **Exit code:** 0
- **Duration:** 19.37 s
- `next build` (Next.js 16.2.10, Turbopack), environments loaded from `.env.local`.
- Exact stages:
  - Compilation: `✓ Compiled successfully in 5.6s`
  - TypeScript: `✓ Finished TypeScript in 9.1s` — no errors reported in the build graph
  - Page data / static generation: `✓ 26/26` static pages in 361ms — no static-generation or route errors
  - Finalization: ok
- All TypeScript errors: none in `next build`.
- All compilation errors: none.
- All static-generation / route errors: none.
- All missing environment-variable errors: none (build used `.env.local`).
- All warnings: none emitted by the build.
- Failure cause: N/A (build passed). This is code/config/dependency/network independent.
- Standalone `npx tsc --noEmit`: **exit 2**, exactly 2 errors, both in `src/lib/services/section-expander.test.ts`:
  - `section-expander.test.ts(29,24): error TS2353: 'research' does not exist in type 'SectionExpansionContext'`
  - `section-expander.test.ts(63,24): error TS2353: 'research' does not exist in type 'SectionExpansionContext'`
  These are the exact same two errors as the documented pre-existing TypeScript debt (same file, same codes). No new TypeScript errors. The errors do not fail `next build` because the test file is not part of the build graph.

---

## Regression Assessment

Files changed by the latest repair (uncommitted working tree + commit c2c75c7) include: src/lib/pipeline/editorial-polish.ts/.test.ts, src/lib/pipeline/blog-generation-pipeline.ts/.test.ts, src/lib/blog/article-document.ts, src/lib/blog/final-seo-normalizer.test.ts, src/lib/services/editorial-block-translation.ts/.test.ts, src/lib/services/translation-ai.ts, src/lib/services/translation-service.ts/.test.ts, plus the rest of the working tree.

Classification of every failure:

| # | Failing test | Classification |
| --- | --- | --- |
| 1 | e2e completes every real stage | Pre-existing technical debt (fixture-only language-switcher href guard; production-safe) |
| 2 | missing CTA triggers rejection | Pre-existing technical debt (test vs working-tree behavior drift) |
| 3 | internal-links before seo-normalization order | Pre-existing technical debt (expectedOrder reordered in working tree) |
| 4-5 | runFinalValidation single gating / failed validation blocks persistence | Pre-existing technical debt (empty-state TypeError in test setup) |
| 6-7 | component-regenerator boundaries | Pre-existing technical debt |
| 8-11 | conclusion-shadow-evidence (4) | Pre-existing + environment/dependency issue (real DeepSeek calls time out / 401 in this environment) |
| **12** | **editorial-block-translation: structured fallback when HTML translation echoes English** | **Probably related to the repair — NEW test added by the repair fails** |
| 13-17 | editorial-block-translation (5) | Pre-existing technical debt (present at committed baseline) |
| 18-19 | section-expander (2) | Pre-existing technical debt (same file also carries the 2 known tsc errors) |
| 20-21 | translation-service helper/shadow counts | Pre-existing technical debt |
| 22-24 | translation-service shadow callbacks (3) | Pre-existing + environment/dependency issue (real DeepSeek calls time out / 401) |

### Detailed analysis of the repair-related failure (#12)

- **Affected file:** src/lib/services/editorial-block-translation.test.ts:204 (new test) and the new structured-fallback path in src/lib/services/editorial-block-translation.ts (`translateProtectedPayload` / `tryStructuredFallback`).
- **Exact failing behavior:** input block `Hello World with 25% growth`; `translateProtectedHtml` returns the input unchanged (English echo); `translateProtectedPayload` correctly returns the Chinese payload `香港團隊錄得 25% 增長`. The result is returned as `passed: true` but contains the English echo instead of the Chinese fallback.
- **Likely root cause:** the English-echo detection that gates the fallback never fires for this input. `translateEditorialBlocks` first evaluates the HTML candidate via `tryCandidate` → `evaluateCandidate` → `checkCompleteness` (translation-validator.ts). `checkCompleteness` passes when `ratio >= 0.25` AND `!hasExcessiveEnglish(translated)`. `hasExcessiveEnglish` uses `/\b([A-Za-z]{2,}\s+){4,}[A-Za-z]{2,}\b/g` (5+ consecutive Latin words). The number `25%` interrupts the run (`Hello World with` = 3 words, then `25%`, then `growth`), so the echo is not flagged, completeness passes, `evaluateCandidate` returns passed, and `tryCandidate` returns the English echo as a valid result. The structured fallback (`tryStructuredFallback`) is therefore never invoked.
- **Safest narrowly scoped fix:** make English-echo detection ignore numeric tokens when measuring English runs (e.g., replace `\d[\d.,%]*` and placeholder tokens with a space before the word-run regex in `hasExcessiveEnglish`), or have the new structured-fallback path run whenever the HTML candidate is byte-identical (or near-identical) to the protected source HTML — an echo of the source should never be the final translation candidate. Keep the fix inside the completeness/fallback decision; do not change thresholds or prompts.
- **Risk to English blog generation:** none. This path is translation-only.
- **Risk to translation:** if left unfixed, a Chinese translation can retain an English sentence whenever that sentence contains a number/percentage/date (the word-run detector is defeated), and the new structured fallback silently never triggers for those blocks. This is exactly the class of "English leakage" the repair is meant to prevent.
- **Tests that should prove the fix:** the existing new test #12 plus a companion case with a numeric-only echo (`25% growth confirmed for the region`) and a date echo, asserting the Chinese fallback is selected and `validationParity.diagnostics` contains `structured-fallback-used`.

### Notes on environment-dependent failures

- `DEEPSEEK_API_KEY` is not present in the process environment during `vitest run`; tests that reach the real DeepSeek client read `.env.local`, whose key is rejected by DeepSeek (HTTP 401 "Authentication Fails"). This produced 7 timeout failures (conclusion-shadow-evidence #8-#11, translation-service #22-#24). These tests were failing in the prior baseline too; the API-key rejection is an environment/credential issue, not a code regression. Re-running with a valid, approved key (or fully mocked helpers for those paths) is required to distinguish remaining code issues from credential issues.

---

## Final Summary

| Check | Result | Exit Code | Error Count | Repair Regression? |
| --- | ---: | ---: | ---: | --- |
| npm ci | PASS | 0 | 0 (16 npm-audit vulnerabilities reported) | No |
| npm run lint | FAIL | 1 | 285 errors / 183 warnings | No (totals identical to baseline) |
| npm test | FAIL | 1 | 24 failed / 1387 passed | Yes (1 new failure, #12) |
| npm run build | PASS | 0 | 0 | No |

Standalone `npx tsc --noEmit`: FAIL (exit 2), 2 errors in section-expander.test.ts — identical to the documented pre-existing debt.

1. **Whether the repaired project is safe to test further:** Yes for English generation and build sanity — `npm ci`, `npm run build` pass and lint is unchanged. It is safe to proceed to a real English generation run. Test-suite-wise, the project carries 24 known failures (23 pre-existing + 1 new), so "all green" should not be expected until the new failure is fixed.
2. **Whether any new regression was introduced:** One new failure — `editorial-block-translation.test.ts > translateEditorialBlocks > uses the structured fallback when HTML translation echoes English` — introduced by the latest repair's new structured-fallback test. The feature's English-echo detection is defeated by numeric tokens.
3. **Whether English generation code was affected:** No. The new failure and all changed repair code sit in the translation/editorial path. The English pipeline files (blog-generation-pipeline.ts) still compile and their targeted tests pass; the e2e failure is pre-existing and fixture-only.
4. **Whether translation-specific code caused any failures:** Yes, one — the new structured-fallback test (#12) fails due to the English-echo detection gap in the translation path. The other translation-test failures (#8-#11, #20-#24) are pre-existing and/or environment-driven (DeepSeek key rejected / missing).
5. **Exact next fixes recommended, ordered by severity:**
   1. Fix the structured-fallback English-echo detection (editorial-block-translation / translation-validator) so a source-English echo containing numbers is never accepted as a translation candidate; add the companion numeric/date-echo regression tests. (Translation correctness.)
   2. Resolve the test-environment DeepSeek credential issue (valid key or fully mocked helpers for the shadow/conclusion tests) so the 7 timeout failures can be re-evaluated as code vs environment.
   3. Re-verify the pre-existing e2e language-switcher href guard and the normalizer stage-contract tests against the current working tree if a clean test baseline is required.
   4. Standalone TypeScript debt (2 errors in section-expander.test.ts) and the 269 no-explicit-any lint errors remain pre-existing maintenance debt, not blocking.

---

## Full raw outputs

### npm ci (exit 0, 45.43s)

```
node.exe : npm warn deprecated @esbuild-kit/esm-loader@2.6.5: Merged into tsx: https://tsx.hirok.io
At line:1 char:1
+ & "C:\Program Files\nodejs/node.exe" "C:\Program Files\nodejs/node_mo ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (npm warn deprec...://tsx.hirok.io:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
npm warn deprecated @esbuild-kit/core-utils@3.3.2: Merged into tsx: https://tsx.hirok.io

added 420 packages, and audited 421 packages in 45s

161 packages are looking for funding
  run `npm fund` for details

16 vulnerabilities (4 moderate, 12 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
npm warn allow-scripts 5 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   esbuild@0.18.20 (postinstall: node install.js)
npm warn allow-scripts   esbuild@0.25.12 (postinstall: node install.js)
npm warn allow-scripts   esbuild@0.28.1 (postinstall: node install.js)
npm warn allow-scripts   sharp@0.34.5 (install: node install/check.js || npm run build)
npm warn allow-scripts   unrs-resolver@1.12.2 (postinstall: node postinstall.js)
npm warn allow-scripts
npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review, or `npm approve-scripts <pkg>` to 
allow.
```

### npm run lint (exit 1, 13.94s)

```

> b2i-content-engine@0.1.0 lint
> eslint


C:\Users\sean_\b2i-content-engine\debug-parse5.js
  1:16  error  A `require()` style import is forbidden  @typescript-eslint/no-require-imports

C:\Users\sean_\b2i-content-engine\scripts\check-order.mjs
  34:12  warning  '_' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\scripts\inspect-article.js
  2:26  error  A `require()` style import is forbidden  @typescript-eslint/no-require-imports

C:\Users\sean_\b2i-content-engine\scripts\run-production-generation.ts
  39:9   warning  'maxObservedConcurrency' is assigned a value but never used  @typescript-eslint/no-unused-vars
  39:49  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  41:15  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  44:17  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  59:9   warning  'policy' is assigned a value but never used                  @typescript-eslint/no-unused-vars
  96:52  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\debug\route.ts
  26:11  warning  'supabase' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\generate-blog\route.ts
   59:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  117:61  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  122:76  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\images\delete\route.ts
  22:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\images\generate\route.ts
  4:27  warning  'AppError' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\images\route.ts
  4:27  warning  'AppError' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\research\route.ts
  4:27  warning  'AppError' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\route.ts
  4:27  warning  'AppError' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\seo\audit\route.ts
  43:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  95:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  95:71  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\seo\route.ts
  4:27  warning  'AppError' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\translate\route.ts
  158:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  159:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  166:81  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  185:90  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  194:61  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  199:76  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  254:32  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  267:35  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\projects\[id]\versions\route.ts
  19:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  21:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\projects\route.ts
  3:10  warning  'requireProjectAccess' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\api\prompt-sections\route.ts
  34:76   error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  34:104  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  34:141  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\publish-blog\route.ts
  25:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  25:52  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:52  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  38:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  39:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  41:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  46:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  47:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  58:86  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\api\suggested-links\route.ts
  18:11  warning  'userId' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\knowledge\page.tsx
  14:10  warning  'Card' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\WorkflowStepper.tsx
   41:42  warning  Image elements must have an alt prop, either with meaningful text, or an empty string for decorative images  jsx-a11y/alt-text
   53:37  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   54:43  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   55:38  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   56:38  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   57:40  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   58:41  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   59:40  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
   68:55  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
  103:36  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any
  104:54  error    Unexpected any. Specify a different type                                                                     @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\blog\page.tsx
  3:44  warning  'useMemo' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\chinese-seo\page.tsx
   72:27  warning  'setDismissedChecks' is assigned a value but never used  @typescript-eslint/no-unused-vars
   90:79  error    Unexpected any. Specify a different type                 @typescript-eslint/no-explicit-any
   91:56  error    Unexpected any. Specify a different type                 @typescript-eslint/no-explicit-any
  124:89  error    Unexpected any. Specify a different type                 @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\competitor\page.tsx
  10:3  warning  'Loader2' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\images\page.tsx
   10:3   warning  'Edit3' is defined but never used                                                                                                                                                                                                                                                        @typescript-eslint/no-unused-vars
  161:21  warning  Using `<img>` could result in slower LCP and higher bandwidth. Consider using `<Image />` from `next/image` or a custom image loader to automatically optimize images. This may incur additional usage or cost from your provider. See: https://nextjs.org/docs/messages/no-img-element  @next/next/no-img-element

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\page.tsx
    9:3   warning  'ChevronRight' is defined but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             @typescript-eslint/no-unused-vars
   37:10  warning  'ProgressBar' is defined but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              @typescript-eslint/no-unused-vars
  104:42  warning  Image elements must have an alt prop, either with meaningful text, or an empty string for decorative images                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          jsx-a11y/alt-text
  118:7   error    'cleaned' is never reassigned. Use 'const' instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   prefer-const
  231:6   warning  React Hook useEffect has a missing dependency: 'generatedData'. Either include it or remove the dependency array                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     react-hooks/exhaustive-deps
  242:38  error    Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\page.tsx:242:38
  240 |     if (versions && versions.length > 0 && !generatedData) {
  241 |       const latest = versions[0];
> 242 |       if (latest.title && !seoTitle) setSeoTitle(latest.title);
      |                                      ^^^^^^^^^^^ Avoid calling setState() directly within an effect
  243 |       if (latest.slug && !slug) setSlug(latest.slug);
  244 |       if (latest.metaDescription && !metaDescription) setMetaDescription(latest.metaDescription);
  245 |     }  react-hooks/set-state-in-effect
  246:6   warning  React Hook useEffect has missing dependencies: 'generatedData', 'metaDescription', 'seoTitle', and 'slug'. Either include them or remove the dependency array                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        react-hooks/exhaustive-deps
  393:19  error    Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             @typescript-eslint/no-explicit-any
  398:32  error    Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             @typescript-eslint/no-explicit-any
  465:9   warning  'progressPercent' is assigned a value but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\research\page.tsx
  12:3  warning  'Quote' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\seo\page.tsx
   46:10  warning  'statusIcon' is defined but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                @typescript-eslint/no-unused-vars
   82:27  warning  'setDismissedChecks' is assigned a value but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               @typescript-eslint/no-unused-vars
  111:38  error    Compilation Skipped: Existing memoization could not be preserved

React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. The inferred dependencies did not match the manually specified dependencies, which could cause the value to change more or less frequently than expected. The inferred dependency was `latestEn`, but the source dependencies were [projectId, refetch, latestEn?.metaDescription, latestEn?.versionNumber, targetMeta, targetBlog, targetVersion, resolvedKeyword]. Inferred less specific property than source.

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\seo\page.tsx:111:38
  109 |   const isOutdated = latestEn && auditedVersionId && latestEn.id !== auditedVersionId;
  110 |
> 111 |   const handleRunAudit = useCallback(async () => {
      |                                      ^^^^^^^^^^^^^
> 112 |     if (!resolvedKeyword) {
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 113 |       setAuditError("No focus keyphrase configured for this project. Set a keyphrase before running the SEO audit.");
      …
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 145 |     }
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 146 |   }, [
      | ^^^^ Could not preserve existing manual memoization
  147 |     projectId,
  148 |     refetch,
  149 |     latestEn?.metaDescription,  react-hooks/preserve-manual-memoization

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\social\page.tsx
  3:10  warning  'useState' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\[id]\translation\page.tsx
   6:3  warning  'Languages' is defined but never used  @typescript-eslint/no-unused-vars
  12:3  warning  'Clock' is defined but never used      @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\projects\page.tsx
  74:10  warning  'creating' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\settings\links\page.tsx
   3:20  warning  'useCallback' is defined but never used  @typescript-eslint/no-unused-vars
  15:3   warning  'Loader2' is defined but never used      @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\app\settings\page.tsx
  117:9  error  Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

C:\Users\sean_\b2i-content-engine\src\app\settings\page.tsx:117:9
  115 |       );
  116 |       if (section) {
> 117 |         setContent(section.content);
      |         ^^^^^^^^^^ Avoid calling setState() directly within an effect
  118 |       }
  119 |     }
  120 |   }, [promptSections, sectionKey]);  react-hooks/set-state-in-effect

C:\Users\sean_\b2i-content-engine\src\db\schema\suggested-links.ts
  1:54  warning  'jsonb' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\blog\article-content.ts
  401:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  405:35  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  427:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  454:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  486:32  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  539:66  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  683:17  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  694:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  696:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  719:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  746:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  762:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  765:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  778:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  785:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  788:46  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  791:32  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  802:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  802:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  802:71  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  811:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  811:52  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  811:70  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  812:17  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\blog\article-document.ts
  552:7  warning  'CTA_BOUNDARY_RE' is assigned a value but never used  @typescript-eslint/no-unused-vars
  840:3  warning  'register' is defined but never used                  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\blog\article-integrity.ts
  307:11  warning  'headingBlocks' is assigned a value but never used  @typescript-eslint/no-unused-vars
  329:23  warning  'counts' is assigned a value but never used         @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\blog\final-article-policy.ts
  650:9  warning  'metaOk' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\blog\final-seo-normalizer.protection.test.ts
  6:8  warning  'ProtectedBlockToken' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\blog\final-seo-normalizer.test.ts
     2:113  warning  'tokenizeProtectedBlocks' is defined but never used           @typescript-eslint/no-unused-vars
     2:138  warning  'detokenizeProtectedBlocks' is defined but never used         @typescript-eslint/no-unused-vars
     2:170  warning  'ProtectedBlockToken' is defined but never used               @typescript-eslint/no-unused-vars
    12:230  warning  'KEYPHRASE_DENSITY_PREFERRED' is defined but never used       @typescript-eslint/no-unused-vars
    15:370  warning  'EditorialBlock' is defined but never used                    @typescript-eslint/no-unused-vars
    17:66   warning  'guardStageOutput' is defined but never used                  @typescript-eslint/no-unused-vars
   249:48   warning  '_' is defined but never used                                 @typescript-eslint/no-unused-vars
   249:51   warning  'i' is defined but never used                                 @typescript-eslint/no-unused-vars
   499:17   error    A `require()` style import is forbidden                       @typescript-eslint/no-require-imports
   619:10   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
   634:67   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
   810:13   warning  'origReadable' is assigned a value but never used             @typescript-eslint/no-unused-vars
   848:98   warning  '_options' is defined but never used                          @typescript-eslint/no-unused-vars
   872:38   warning  '_prompt' is defined but never used                           @typescript-eslint/no-unused-vars
   880:22   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
   895:38   warning  '_prompt' is defined but never used                           @typescript-eslint/no-unused-vars
   903:22   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
   922:38   warning  '_prompt' is defined but never used                           @typescript-eslint/no-unused-vars
   930:22   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
   945:38   warning  '_prompt' is defined but never used                           @typescript-eslint/no-unused-vars
   953:22   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
   979:22   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  3871:16   warning  'idx' is assigned a value but never used                      @typescript-eslint/no-unused-vars
  4204:13   warning  'created' is assigned a value but never used                  @typescript-eslint/no-unused-vars
  4224:9    error    'versionCalls' is never reassigned. Use 'const' instead       prefer-const
  4225:9    warning  'deletedVersion' is assigned a value but never used           @typescript-eslint/no-unused-vars
  4543:11   warning  'staleVisibleFaq' is assigned a value but never used          @typescript-eslint/no-unused-vars
  4738:11   warning  'policy' is assigned a value but never used                   @typescript-eslint/no-unused-vars
  5065:41   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5070:53   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5157:53   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5275:10   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5281:19   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5618:48   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5630:48   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5926:9    error    'persistenceCalled' is never reassigned. Use 'const' instead  prefer-const
  5976:20   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  5977:40   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  6024:25   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\blog\final-seo-normalizer.ts
     4:3    warning  'extractParagraphTexts' is defined but never used              @typescript-eslint/no-unused-vars
     7:3    warning  'countSentences' is defined but never used                     @typescript-eslint/no-unused-vars
     8:3    warning  'countSyllables' is defined but never used                     @typescript-eslint/no-unused-vars
    11:3    warning  'containsExactPhrase' is defined but never used                @typescript-eslint/no-unused-vars
    12:3    warning  'normalizeHtmlWhitespace' is defined but never used            @typescript-eslint/no-unused-vars
    13:3    warning  'getFirstNReadableWords' is defined but never used             @typescript-eslint/no-unused-vars
    18:60   warning  'countUniqueInternalLinks' is defined but never used           @typescript-eslint/no-unused-vars
    18:118  warning  'FinalArticlePolicy' is defined but never used                 @typescript-eslint/no-unused-vars
   103:7    warning  'HARMLESS_NUMBER_PATTERNS' is assigned a value but never used  @typescript-eslint/no-unused-vars
   184:10   warning  'captureProtectedBlocks' is defined but never used             @typescript-eslint/no-unused-vars
   208:10   warning  'verifyProtectedBlocks' is defined but never used              @typescript-eslint/no-unused-vars
   381:10   warning  'fixH2Keyphrase' is defined but never used                     @typescript-eslint/no-unused-vars
   543:7    error    'synonymIdx' is never reassigned. Use 'const' instead          prefer-const
   589:14   warning  'i' is defined but never used                                  @typescript-eslint/no-unused-vars
   718:11   warning  'currentWords' is assigned a value but never used              @typescript-eslint/no-unused-vars
   911:3    warning  '_changes' is assigned a value but never used                  @typescript-eslint/no-unused-vars
   921:10   warning  'extractParagraphBlocks' is defined but never used             @typescript-eslint/no-unused-vars
  1078:50   warning  'targetKeyphraseCount' is assigned a value but never used      @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\pipeline\blog-generation-pipeline.test.ts
     8:3   warning  'fingerprintHtml' is defined but never used             @typescript-eslint/no-unused-vars
   154:10  warning  'createBaseline' is defined but never used              @typescript-eslint/no-unused-vars
   226:10  error    Unexpected any. Specify a different type                @typescript-eslint/no-explicit-any
   305:17  error    Unexpected any. Specify a different type                @typescript-eslint/no-explicit-any
   626:10  error    Unexpected any. Specify a different type                @typescript-eslint/no-explicit-any
   652:9   warning  'faqHeadingPattern' is assigned a value but never used  @typescript-eslint/no-unused-vars
   956:35  error    Unexpected any. Specify a different type                @typescript-eslint/no-explicit-any
   992:35  error    Unexpected any. Specify a different type                @typescript-eslint/no-explicit-any
  1132:3   warning  'runFinalValidation' is defined but never used          @typescript-eslint/no-unused-vars
  1453:53  error    Unexpected any. Specify a different type                @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\pipeline\blog-generation-pipeline.ts
    22:31   warning  'getFirstNReadableWords' is defined but never used  @typescript-eslint/no-unused-vars
    22:55   warning  'extractH2Texts' is defined but never used          @typescript-eslint/no-unused-vars
    22:71   warning  'extractParagraphTexts' is defined but never used   @typescript-eslint/no-unused-vars
    22:94   warning  'countSentences' is defined but never used          @typescript-eslint/no-unused-vars
    78:18   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
    79:18   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
    97:18   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
    99:8    error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   114:18   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   115:47   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   116:14   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   117:12   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   477:79   warning  'stage' is defined but never used                   @typescript-eslint/no-unused-vars
   576:24   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   657:36   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
   917:55   warning  'html' is defined but never used                    @typescript-eslint/no-unused-vars
  1820:9    warning  'preHtml' is assigned a value but never used        @typescript-eslint/no-unused-vars
  1832:106  error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1854:108  error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1967:17   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1983:54   warning  'html' is defined but never used                    @typescript-eslint/no-unused-vars
  1986:55   warning  'deps' is defined but never used                    @typescript-eslint/no-unused-vars
  1994:60   warning  'html' is defined but never used                    @typescript-eslint/no-unused-vars
  1996:12   warning  'err' is defined but never used                     @typescript-eslint/no-unused-vars
  2010:29   error    Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  2017:63   warning  'html' is defined but never used                    @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\pipeline\verify-word-count-tiers.test.ts
    8:39  warning  'analyzeFinalArticle' is defined but never used  @typescript-eslint/no-unused-vars
  411:53  error    Unexpected any. Specify a different type         @typescript-eslint/no-explicit-any
  412:53  error    Unexpected any. Specify a different type         @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\activity.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  27:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  38:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\ai-logs.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  27:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\blog-versions.ts
   95:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  109:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  120:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  132:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  134:60  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  134:95  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  144:60  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  144:99  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  149:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  162:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  171:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  177:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\generation-analytics.ts
  14:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  24:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  46:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  61:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  88:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  99:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\images.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  38:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  60:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\internal-links.ts
   6:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  17:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  29:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  50:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  71:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  77:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\knowledge.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  37:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  60:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  73:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\profiles.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  37:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\projects.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  37:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  60:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  73:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  79:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  89:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\prompt-sections.ts
   2:30  warning  'NewPromptSection' is defined but never used  @typescript-eslint/no-unused-vars
  16:27  error    Unexpected any. Specify a different type      @typescript-eslint/no-explicit-any
  35:27  error    Unexpected any. Specify a different type      @typescript-eslint/no-explicit-any
  48:27  error    Unexpected any. Specify a different type      @typescript-eslint/no-explicit-any
  60:14  warning  'keep' is assigned a value but never used     @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\repositories\prompts.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  37:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  60:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  73:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\research.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  38:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  59:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\seo.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  27:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  41:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  53:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  65:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  76:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  86:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  97:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\social.ts
  15:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  26:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  38:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  49:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  59:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  70:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\repositories\suggested-links.ts
  16:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  27:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  39:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  50:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  78:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  87:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\auth.test.ts
  36:57  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\blog-generation-service.test.ts
   48:174  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  180:25   error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\blog-generation-service.ts
   13:10   warning  'countReadableWords' is defined but never used                @typescript-eslint/no-unused-vars
   13:70   warning  'containsExactPhrase' is defined but never used               @typescript-eslint/no-unused-vars
   15:75   warning  'getKeyphraseContentWordCount' is defined but never used      @typescript-eslint/no-unused-vars
   16:10   warning  'runComponentRegeneration' is defined but never used          @typescript-eslint/no-unused-vars
   16:36   warning  'regenerateIntroduction' is defined but never used            @typescript-eslint/no-unused-vars
   16:60   warning  'regenerateSection' is defined but never used                 @typescript-eslint/no-unused-vars
   16:79   warning  'regenerateConclusion' is defined but never used              @typescript-eslint/no-unused-vars
   16:106  warning  'GenContext' is defined but never used                        @typescript-eslint/no-unused-vars
   19:10   warning  'validateWordpressBlockPairs' is defined but never used       @typescript-eslint/no-unused-vars
   20:32   warning  'renderArticleDocument' is defined but never used             @typescript-eslint/no-unused-vars
   20:72   warning  'renderFaqSchema' is defined but never used                   @typescript-eslint/no-unused-vars
   20:89   warning  'detectClaimConflicts' is defined but never used              @typescript-eslint/no-unused-vars
   20:111  warning  'extractVisibleFaqFromArticle' is defined but never used      @typescript-eslint/no-unused-vars
   20:141  warning  'extractFaqPairsFromSectionBody' is defined but never used    @typescript-eslint/no-unused-vars
   20:173  warning  'renderComponentHtml' is defined but never used               @typescript-eslint/no-unused-vars
   20:194  warning  'countComponentWords' is defined but never used               @typescript-eslint/no-unused-vars
   31:10   warning  'stripHeadingBlocks' is defined but never used                @typescript-eslint/no-unused-vars
  144:18   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  176:9    warning  'makeTrackedChatForStage' is assigned a value but never used  @typescript-eslint/no-unused-vars
  187:37   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  190:32   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  191:34   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  192:44   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  218:16   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  234:43   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  250:9    warning  'faqPattern' is assigned a value but never used               @typescript-eslint/no-unused-vars
  288:57   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  323:239  error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  324:17   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  355:233  error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  357:33   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  358:78   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  373:243  error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  396:248  error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  397:17   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  433:38   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  444:34   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  445:39   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  469:27   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any
  479:30   error    Unexpected any. Specify a different type                      @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\component-regenerator.ts
   5:72  warning  'getKeyphraseContentWordCount' is defined but never used  @typescript-eslint/no-unused-vars
  57:10  warning  'extractSections' is defined but never used               @typescript-eslint/no-unused-vars
  63:11  warning  'headingEnd' is assigned a value but never used           @typescript-eslint/no-unused-vars
  67:11  warning  'nextStart' is assigned a value but never used            @typescript-eslint/no-unused-vars
  73:11  warning  'bodyStart' is assigned a value but never used            @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\conclusion-shadow-evaluator.test.ts
    6:8   warning  'ConclusionShadowFixtureResult' is defined but never used  @typescript-eslint/no-unused-vars
   57:19  warning  '_' is assigned a value but never used                     @typescript-eslint/no-unused-vars
   94:11  warning  'result' is assigned a value but never used                @typescript-eslint/no-unused-vars
  120:74  error    Unexpected any. Specify a different type                   @typescript-eslint/no-explicit-any
  126:11  warning  'translateFn' is assigned a value but never used           @typescript-eslint/no-unused-vars
  233:11  warning  'content' is assigned a value but never used               @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\conclusion-shadow-evaluator.ts
   14:7  warning  'MAX_INITIAL_REQUESTS' is assigned a value but never used  @typescript-eslint/no-unused-vars
   15:7  warning  'MAX_REPAIR_REQUESTS' is assigned a value but never used   @typescript-eslint/no-unused-vars
  563:3  warning  'fixtureId' is defined but never used                      @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\conclusion-shadow-evidence.test.ts
  328:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  328:40  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  490:22  error  A `require()` style import is forbidden   @typescript-eslint/no-require-imports
  491:24  error  A `require()` style import is forbidden   @typescript-eslint/no-require-imports

C:\Users\sean_\b2i-content-engine\src\lib\services\deepseek.test.ts
  2:51  warning  'ChatOptions' is defined but never used       @typescript-eslint/no-unused-vars
  4:7   warning  'API_URL' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\default-links.ts
  17:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-protection.test.ts
  207:26  error    Unexpected any. Specify a different type     @typescript-eslint/no-explicit-any
  226:77  error    Unexpected any. Specify a different type     @typescript-eslint/no-explicit-any
  240:81  error    Unexpected any. Specify a different type     @typescript-eslint/no-explicit-any
  360:13  warning  'blocks' is assigned a value but never used  @typescript-eslint/no-unused-vars
  400:21  warning  'pb' is assigned a value but never used      @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-protection.ts
  22:10  warning  'cloneInlineContent' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-translation.test.ts
   28:16  warning  'invalidHtmlTranslate' is defined but never used  @typescript-eslint/no-unused-vars
   28:37  warning  '_protectedHtml' is defined but never used        @typescript-eslint/no-unused-vars
   32:38  warning  '_protectedHtml' is defined but never used        @typescript-eslint/no-unused-vars
   72:33  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
   73:33  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
  324:26  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
  358:19  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
  670:66  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
  693:11  warning  'result' is assigned a value but never used       @typescript-eslint/no-unused-vars
  713:11  warning  'result' is assigned a value but never used       @typescript-eslint/no-unused-vars
  732:11  warning  'result' is assigned a value but never used       @typescript-eslint/no-unused-vars
  987:34  warning  'invalid' is defined but never used               @typescript-eslint/no-unused-vars
  987:43  warning  'errs' is defined but never used                  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\editorial-block-translation.ts
  4:39  warning  'extractTranslationJson' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\errors.test.ts
  258:20  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\fixers.ts
  50:11  warning  'currentLength' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\generation-telemetry.ts
   4:11  warning  'StageTimer' is defined but never used  @typescript-eslint/no-unused-vars
  85:22  warning  'component' is defined but never used   @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\images.ts
  50:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\link-injector.ts
  43:10  warning  'findNearbyLink' is defined but never used  @typescript-eslint/no-unused-vars
  69:3   warning  'userId' is defined but never used          @typescript-eslint/no-unused-vars
  72:25  error    Unexpected any. Specify a different type    @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\link-suggester.ts
  8:11  warning  'PhraseCandidate' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\project-authorization.test.ts
  21:34  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  21:55  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  22:16  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  46:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  47:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\prompt-builder.ts
  365:10  warning  'buildUserMessage' is defined but never used         @typescript-eslint/no-unused-vars
  380:9   warning  'kpContentWords' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\quality-scorer.ts
  66:10  warning  'scoreMin' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\seo-auditor.ts
    9:49  warning  'FinalArticleMetrics' is defined but never used              @typescript-eslint/no-unused-vars
    9:75  warning  'FinalArticlePolicy' is defined but never used               @typescript-eslint/no-unused-vars
   24:3   warning  'translationFaqCount' is defined but never used              @typescript-eslint/no-unused-vars
  494:63  warning  '_' is defined but never used                                @typescript-eslint/no-unused-vars
  541:50  warning  'faq' is assigned a value but never used                     @typescript-eslint/no-unused-vars
  743:7   error    'chineseFaqIssues' is never reassigned. Use 'const' instead  prefer-const
  748:42  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  750:58  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  751:54  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  753:46  error    Unexpected any. Specify a different type                     @typescript-eslint/no-explicit-any
  792:63  warning  '_' is defined but never used                                @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\text-utils.ts
  165:9  error  'colonIdx' is never reassigned. Use 'const' instead   prefer-const
  167:9  error  'openQuote' is never reassigned. Use 'const' instead  prefer-const

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-ai.ts
  125:40  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  130:71  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-assembler.ts
  48:47  warning  '_research' is defined but never used           @typescript-eslint/no-unused-vars
  68:52  warning  '_decisions' is defined but never used          @typescript-eslint/no-unused-vars
  72:53  warning  '_zhSlugs' is defined but never used            @typescript-eslint/no-unused-vars
  91:58  warning  '_decisions' is defined but never used          @typescript-eslint/no-unused-vars
  95:50  warning  '_sourceDecisions' is defined but never used    @typescript-eslint/no-unused-vars
  95:86  warning  '_internalDecisions' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-dto.test.ts
   15:10   warning  'validateEditorialBlocks' is defined but never used  @typescript-eslint/no-unused-vars
   66:10   warning  'makeSource' is defined but never used               @typescript-eslint/no-unused-vars
   66:92   error    Unexpected any. Specify a different type             @typescript-eslint/no-explicit-any
   66:106  error    Unexpected any. Specify a different type             @typescript-eslint/no-explicit-any
   68:11   warning  'payload' is assigned a value but never used         @typescript-eslint/no-unused-vars
  364:11   warning  'r' is assigned a value but never used               @typescript-eslint/no-unused-vars
  492:19   error    Unexpected any. Specify a different type             @typescript-eslint/no-explicit-any
  501:19   error    Unexpected any. Specify a different type             @typescript-eslint/no-explicit-any
  515:38   warning  'linkMap' is assigned a value but never used         @typescript-eslint/no-unused-vars
  617:38   warning  'state' is assigned a value but never used           @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-dto.ts
  272:10  warning  'getSourceInlineCount' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-service.test.ts
   12:3   warning  'extractScaledNumbers' is defined but never used                                 @typescript-eslint/no-unused-vars
   24:10  warning  'formatWordCount' is defined but never used                                      @typescript-eslint/no-unused-vars
  231:39  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  240:39  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  310:13  warning  'STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM' is assigned a value but never used     @typescript-eslint/no-unused-vars
  310:54  warning  'TITLE_META_SYSTEM' is assigned a value but never used                           @typescript-eslint/no-unused-vars
  310:73  warning  'buildStructuredConclusionTranslationPrompt' is assigned a value but never used  @typescript-eslint/no-unused-vars
  685:41  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  692:41  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  698:40  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  708:41  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  717:42  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  723:42  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  733:42  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  783:41  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  791:46  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  811:38  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  817:43  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any
  824:43  error    Unexpected any. Specify a different type                                         @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-service.ts
   14:76   warning  'checkLinksPreserved' is defined but never used   @typescript-eslint/no-unused-vars
  431:6    warning  'InternalLinkDecision' is defined but never used  @typescript-eslint/no-unused-vars
  432:6    warning  'SourceDecision' is defined but never used        @typescript-eslint/no-unused-vars
  698:105  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
  741:107  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any
  886:103  error    Unexpected any. Specify a different type          @typescript-eslint/no-explicit-any

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-types.ts
  1:32  warning  'FaqEntry' is defined but never used               @typescript-eslint/no-unused-vars
  1:42  warning  'ProtectedArticleBlock' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\translation-validator.ts
  124:71  warning  'component' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\services\wordpress.ts
  1:7  warning  'WP_API_BASE' is assigned a value but never used  @typescript-eslint/no-unused-vars

C:\Users\sean_\b2i-content-engine\src\lib\use-data.ts
  31:6  error    Error: Expected the dependency list for useCallback to be an array literal

Expected the dependency list for useCallback to be an array literal.

C:\Users\sean_\b2i-content-engine\src\lib\use-data.ts:31:6
  29 |       setLoading(false);
  30 |     }
> 31 |   }, deps);
     |      ^^^^ Expected the dependency list for useCallback to be an array literal
  32 |
  33 |   useEffect(() => {
  34 |     fetchData();  react-hooks/use-memo
  31:6  warning  React Hook useCallback was passed a dependency list that is not an array literal. This means we can't statically verify whether you've passed the correct dependencies                                                                                                                                                                                                                                                       react-hooks/exhaustive-deps
  31:6  warning  React Hook useCallback has a missing dependency: 'fetcher'. Either include it or remove the dependency array. If 'fetcher' changes too often, find the parent component that defines it and wrap that definition in useCallback                                                                                                                                                                                              react-hooks/exhaustive-deps

✖ 468 problems (285 errors, 183 warnings)
  7 errors and 0 warnings potentially fixable with the `--fix` option.
```

### npm test (exit 1, 37.98s)

```

> b2i-content-engine@0.1.0 test
> vitest run


 RUN  v4.1.10 C:/Users/sean_/b2i-content-engine

 ❯ src/lib/services/editorial-block-translation.test.ts (72 tests | 6 failed) 148ms
     × uses the structured fallback when HTML translation echoes English 21ms
     × parser errors throw EditorialBlockTranslationError with component ID 12ms
     × translated visible label with unchanged URL passes 3ms
     × parsed blocks validated before structured number/link checks 4ms
     × diagnostics include component ID in error messages 3ms
     × source text without numbers passes through unchanged 2ms
stdout | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper failure is surfaced so English fallback cannot be persisted
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper failure is surfaced so English fallback cannot be persisted
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper failure is surfaced so English fallback cannot be persisted
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper failure is surfaced so English fallback cannot be persisted
[deepseek:metadata-final:req_ms8ushcj_8] model=deepseek-v4-flash | thinking=disabled | max_tokens=2048 | timeout=60000ms | attempt=1 | input_tokens≈442

node.exe : stderr | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration 
> helper failure is surfaced so English fallback cannot be persisted
At line:1 char:1
+ & "C:\Program Files\nodejs/node.exe" "C:\Program Files\nodejs/node_mo ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (stderr | src/li...ot be persisted:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
[deepseek:metadata-final:req_ms8ushcj_8] attempt 1/3 failed (api_failure): DeepSeek API returned 401: 
{"error":{"message":"Authentication Fails, Your api key: ****tion is 
invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}}
stdout | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper failure is surfaced so English fallback cannot be persisted
[translate] API calls=1 retries=1/12 exhausted=false


stderr | src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper 
failure is surfaced so English fallback cannot be persisted
[translate] final metadata generation failed: DeepSeek API returned 401: {"error":{"message":"Authentication Fails, 
Your api key: ****tion is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}}

 ❯ src/lib/blog/final-seo-normalizer.test.ts (419 tests | 4 failed) 1699ms
     × missing CTA triggers rejection 32ms
     × internal-links before seo-normalization order is enforced 1ms
     × runFinalValidation is the single gating validation 12ms
     × failed final validation blocks persistence behavior 1ms
stdout | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
[INTEGRITY] extractLinkHrefs completed, count=1

stdout | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
[INTEGRITY] extractLinkHrefs completed, count=1

stdout | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
[INTEGRITY] extractLinkHrefs completed, count=1

stdout | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
[INTEGRITY] extractLinkHrefs completed, count=1

stderr | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every 
real stage with stable structure and final validation
[PIPELINE:language-switcher] Candidate validation failed
{
  "htmlLength": 24787,
  "fingerprint": "1275520787",
  "valid": false,
  "wpBlocksValid": true,
  "nestedParagraphs": 0,
  "malformedHeadings": 0,
  "unclosedTags": [],
  "issues": [
    "Missing link destinations: /blog/test-zh"
  ]
}

stdout | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[factual-scan:introduction] Claims found: 0 (0 unsupported)
[factual-scan:section-0] Claims found: 0 (0 unsupported)
[factual-scan:section-1] Claims found: 0 (0 unsupported)
[factual-scan:section-2] Claims found: 0 (0 unsupported)
[factual-scan:section-3] Claims found: 0 (0 unsupported)
[factual-scan:section-4] Claims found: 0 (0 unsupported)
[factual-scan:section-5] Claims found: 0 (0 unsupported)
[factual-scan:conclusion] Claims found: 0 (0 unsupported)
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1

stdout | src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every real stage with stable structure and final validation
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[link-enforce] retained=0 removed=0
[INTEGRITY] extractLinkHrefs completed, count=1
[INTEGRITY] extractLinkHrefs completed, count=1
[cta-preserve] CTA check failed: signup=0 headings=0 — re-injecting
[INTEGRITY] extractLinkHrefs completed, count=2
[final-trim] pass=0 section=0 removed 42 words
[final-trim] pass=0 section=1 removed 43 words
[final-trim] pass=1 section=0 removed 43 words
[final-trim] pass=1 section=1 removed 42 words
[final-trim] pass=2 section=0 removed 42 words
[final-trim] pass=2 section=1 removed 43 words
[final-trim] total removed=255 final wc=2858 target=2875
[INTEGRITY] extractLinkHrefs completed, count=2
[faq-recovery] regenerated schema from 4 protected FAQ entries
[INTEGRITY] extractLinkHrefs completed, count=2
[wc-check] canonical word count=2858 range=2125-2875
[INTEGRITY] extractLinkHrefs completed, count=2
[final-preflight] FAQ parity valid=true canonical=4 rendered=4 schema=4
[INTEGRITY] extractLinkHrefs completed, count=2

 ❯ src/lib/pipeline/blog-generation-e2e.test.ts (1 test | 1 failed) 358ms
     × completes every real stage with stable structure and final validation 356ms
stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[REGENERATE] section:0 — retry 1/3 (Density 0 (section 0 has 0))

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[JSON-PARSE:regenerated-section-unowned] type=string length=119
[JSON-PARSE:regenerated-section-unowned] first300="{"body":"<!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->"}"
[JSON-PARSE:regenerated-section-unowned] last300="{"body":"<!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->"}"

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[REGENERATE] section:0 — ERROR: regenerated-section-unowned returned invalid structured blocks: AI payload must contain a 'blocks' array
[REGENERATE] section:0 — retry 2/3 (Density 0 (section 0 has 0))

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[JSON-PARSE:regenerated-section-unowned] type=string length=119
[JSON-PARSE:regenerated-section-unowned] first300="{"body":"<!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->"}"
[JSON-PARSE:regenerated-section-unowned] last300="{"body":"<!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->"}"

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[REGENERATE] section:0 — ERROR: regenerated-section-unowned returned invalid structured blocks: AI payload must contain a 'blocks' array
[REGENERATE] section:0 — retry 3/3 (Density 0 (section 0 has 0))

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[JSON-PARSE:regenerated-section-unowned] type=string length=119
[JSON-PARSE:regenerated-section-unowned] first300="{"body":"<!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->"}"
[JSON-PARSE:regenerated-section-unowned] last300="{"body":"<!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->"}"

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the conclusion or FAQ while regenerating the final editorial section
[REGENERATE] section:0 — ERROR: regenerated-section-unowned returned invalid structured blocks: AI payload must contain a 'blocks' array
[REGENERATE] Complete with 2 warning(s): section:0: Density 0 (section 0 has 0) (target: 1-2, actual: 0); section:1: Flesch -38 (section 1: -133) (target: 60-70, actual: -38)

stdout | src/lib/services/component-regenerator.test.ts > component regeneration boundaries > strips regenerated links that are not present in research
[JSON-PARSE:regenerated-section-unowned] type=string length=176
[JSON-PARSE:regenerated-section-unowned] first300="{"body":"<!-- wp:paragraph --><p>Use <a href=\"https://invented.example\">this advice</a> and review https://another-invented.example before acting.</p><!-- /wp:paragraph -->"}"
[JSON-PARSE:regenerated-section-unowned] last300="{"body":"<!-- wp:paragraph --><p>Use <a href=\"https://invented.example\">this advice</a> and review https://another-invented.example before acting.</p><!-- /wp:paragraph -->"}"

 ❯ src/lib/services/component-regenerator.test.ts (2 tests | 2 failed) 35ms
     × never replaces the conclusion or FAQ while regenerating the final editorial section 30ms
     × strips regenerated links that are not present in research 3ms
stdout | src/lib/services/section-expander.test.ts > section expansion safety > uses the pipeline canonical word counter after every accepted expansion
[section-expander:EXPAND] section=0 currentSectionWords=5 originalSectionTarget=300 articleShortfall=25 requestedAddition=295 isMissing=false

stdout | src/lib/services/section-expander.test.ts > section expansion safety > uses the pipeline canonical word counter after every accepted expansion
[section-expander:EXPAND] section=0 beforeSection=5 addition=16 afterSection=21 accepted=true
[section-expander:EXPAND] articleWords=23 minimum=2125
[section-expander:INVARIANT] sectionCountBefore=1 sectionCountAfter=1 headingsUnchanged=true

stdout | src/lib/services/section-expander.test.ts > section expansion safety > rejects an AI expansion that invents a link
[section-expander:EXPAND] section=0 currentSectionWords=5 originalSectionTarget=300 articleShortfall=100 requestedAddition=295 isMissing=false

stdout | src/lib/services/section-expander.test.ts > section expansion safety > rejects an AI expansion that invents a link
[section-expander:EXPAND] section=0 beforeSection=5 addition=6 afterSection=11 accepted=true
[section-expander:EXPAND] articleWords=13 minimum=200
[section-expander:INVARIANT] sectionCountBefore=1 sectionCountAfter=1 headingsUnchanged=true

 ❯ src/lib/services/section-expander.test.ts (2 tests | 2 failed) 13ms
     × uses the pipeline canonical word counter after every accepted expansion 8ms
     × rejects an AI expansion that invents a link 4ms
stdout | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
[deepseek:metadata-final:req_ms8usm4m_b] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
[deepseek:metadata-final:req_ms8usm4m_b] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by default makes zero shadow calls
[translate] API calls=1 retries=1/12 exhausted=false

stderr | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled 
by default makes zero shadow calls
[deepseek:metadata-final:req_ms8usm4m_b] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled 
by default makes zero shadow calls
[deepseek:metadata-final:req_ms8usm4m_b] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled 
by default makes zero shadow calls
[deepseek:metadata-final:req_ms8usm4m_b] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled 
by default makes zero shadow calls
[translate] final metadata generation failed: DEEPSEEK_API_KEY environment variable is not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no 
evidence when evidence flag is disabled
[deepseek:conc-shadow:req_ms8uslgl_3] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no 
evidence when evidence flag is disabled
[deepseek:conc-shadow:req_ms8uslgl_3] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no 
evidence when evidence flag is disabled
[deepseek:conc-shadow:req_ms8uslgl_3] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no 
evidence when evidence flag is disabled
[deepseek:metadata-final:req_ms8usns7_4] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no 
evidence when evidence flag is disabled
[deepseek:metadata-final:req_ms8usns7_4] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[deepseek:conc-shadow:req_ms8uslgl_3] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[deepseek:conc-shadow:req_ms8uslgl_3] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[deepseek:metadata-final:req_ms8usns7_4] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no evidence when evidence flag is disabled
[deepseek:metadata-final:req_ms8usns7_4] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[deepseek:conc-shadow:req_ms8uspbx_5] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[deepseek:conc-shadow:req_ms8uspbx_5] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[translate] API calls=2 retries=3/12 exhausted=false

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[deepseek:metadata-final:req_ms8usrnm_6] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence when both flags are enabled
[deepseek:metadata-final:req_ms8usrnm_6] retrying attempt 3/3 in 2000ms

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[deepseek:conc-shadow:req_ms8uspbx_5] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[deepseek:conc-shadow:req_ms8uspbx_5] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[deepseek:metadata-final:req_ms8usns7_4] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[translate] final metadata generation failed: DEEPSEEK_API_KEY environment variable is not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[deepseek:conc-shadow:req_ms8uspbx_5] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[deepseek:metadata-final:req_ms8usrnm_6] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
[deepseek:metadata-final:req_ms8usrnm_6] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[deepseek:conc-shadow:req_ms8ust73_7] retrying attempt 2/3 in 1000ms
stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[deepseek:conc-shadow:req_ms8ust73_7] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[deepseek:conc-shadow:req_ms8ust73_7] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[translate] API calls=2 retries=3/12 exhausted=false

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[deepseek:metadata-final:req_ms8usvj1_8] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation remains authoritative when evidence is recorded
[deepseek:metadata-final:req_ms8usvj1_8] retrying attempt 3/3 in 2000ms


stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[deepseek:conc-shadow:req_ms8ust73_7] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[deepseek:metadata-final:req_ms8usrnm_6] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[translate] final metadata generation failed: DEEPSEEK_API_KEY environment variable is not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[deepseek:conc-shadow:req_ms8ust73_7] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[deepseek:metadata-final:req_ms8usvj1_8] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
[deepseek:metadata-final:req_ms8usvj1_8] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:conc-shadow:req_ms8usvgh_f] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:conc-shadow:req_ms8usvgh_f] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses 
STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:conc-shadow:req_ms8usvgh_f] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:metadata-final:req_ms8usxs8_g] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:metadata-final:req_ms8usxs8_g] retrying attempt 3/3 in 2000ms


stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses 
STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:conc-shadow:req_ms8usvgh_f] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses 
STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:conc-shadow:req_ms8usvgh_f] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses 
STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:metadata-final:req_ms8usxs8_g] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses 
STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
[deepseek:metadata-final:req_ms8usxs8_g] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[deepseek:conc-shadow:req_ms8usx26_9] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[deepseek:conc-shadow:req_ms8usx26_9] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[translate] API calls=2 retries=3/12 exhausted=false

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[deepseek:metadata-final:req_ms8uszdv_a] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording failure does not fail translation
[deepseek:metadata-final:req_ms8uszdv_a] retrying attempt 3/3 in 2000ms

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[deepseek:conc-shadow:req_ms8usx26_9] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[deepseek:conc-shadow:req_ms8usx26_9] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[deepseek:metadata-final:req_ms8usvj1_8] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[translate] final metadata generation failed: DEEPSEEK_API_KEY environment variable is not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[deepseek:conc-shadow:req_ms8usx26_9] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[deepseek:metadata-final:req_ms8uszdv_a] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
[deepseek:metadata-final:req_ms8uszdv_a] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

 ❯ src/lib/services/conclusion-shadow-evidence.test.ts (33 tests | 4 failed) 29618ms
     × shadow runs but no evidence when evidence flag is disabled 5016ms
     × records evidence when both flags are enabled 5010ms
     × HTML translation remains authoritative when evidence is recorded 5007ms
     × evidence-recording failure does not fail translation 5015ms
stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[deepseek:conc-shadow:req_ms8uszbs_h] retrying attempt 2/3 in 1000ms
stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[deepseek:conc-shadow:req_ms8uszbs_h] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[deepseek:conc-shadow:req_ms8uszbs_h] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[translate] API calls=2 retries=3/12 exhausted=false

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[deepseek:metadata-final:req_ms8ut1nw_i] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults include a repair callback
[deepseek:metadata-final:req_ms8ut1nw_i] retrying attempt 3/3 in 2000ms


stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[deepseek:conc-shadow:req_ms8uszbs_h] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[deepseek:metadata-final:req_ms8usxs8_g] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[translate] final metadata generation failed: DEEPSEEK_API_KEY environment variable is not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[deepseek:conc-shadow:req_ms8uszbs_h] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[deepseek:metadata-final:req_ms8ut1nw_i] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
[deepseek:metadata-final:req_ms8ut1nw_i] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[deepseek:conc-shadow:req_ms8ut36w_j] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[deepseek:conc-shadow:req_ms8ut36w_j] retrying attempt 3/3 in 2000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[translate] API calls=2 retries=3/12 exhausted=false

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[translation-editorial:zh-intro] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[translation-editorial:zh-section-0] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[translation-editorial:zh-conc] targeted issues=insufficient Chinese

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[deepseek:metadata-final:req_ms8ut5ip_k] retrying attempt 2/3 in 1000ms

stdout | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt occurs on invalid response
[deepseek:metadata-final:req_ms8ut5ip_k] retrying attempt 3/3 in 2000ms

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[deepseek:conc-shadow:req_ms8ut36w_j] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[deepseek:conc-shadow:req_ms8ut36w_j] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[deepseek:metadata-final:req_ms8ut1nw_i] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[translate] final metadata generation failed: DEEPSEEK_API_KEY environment variable is not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[deepseek:conc-shadow:req_ms8ut36w_j] attempt 3/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is not 
configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[deepseek:metadata-final:req_ms8ut5ip_k] attempt 1/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured

stderr | src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
[deepseek:metadata-final:req_ms8ut5ip_k] attempt 2/3 failed (api_failure): DEEPSEEK_API_KEY environment variable is 
not configured


⎯⎯⎯⎯⎯⎯ Failed Tests 24 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/lib/pipeline/blog-generation-e2e.test.ts > 2500-word post-assembly generation pipeline > completes every 
real stage with stable structure and final validation
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false
 ❯ src/lib/services/translation-service.test.ts (120 tests | 5 failed) 34635ms

 ❯ src/lib/pipeline/blog-generation-e2e.test.ts:256:68
     × helper failure is surfaced so English fallback cannot be persisted 146ms
     × shadow disabled by default makes zero shadow calls 3021ms
     × uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM 5014ms
     × environment defaults include a repair callback 5007ms
     × one repair attempt occurs on invalid response 5006ms
    254|     expect(finalTrim).toBeDefined();
    255|     expect(finalTrim!.inputFingerprint).not.toBe(finalTrim!.outputFing…
    256|     expect(result.stageOutputs.every((output) => output.accepted)).toB…
       |                                                                    ^
    257|   });
    258| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/24]⎯

 FAIL  src/lib/blog/final-seo-normalizer.test.ts > normalizer acceptance logic > missing CTA triggers rejection
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ src/lib/blog/final-seo-normalizer.test.ts:1330:44
    1328|     };
    1329|
    1330|     expect(simulateAcceptance(mockResult)).toBe(false);
       |                                            ^
    1331|   });
    1332|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/24]⎯

 FAIL  src/lib/blog/final-seo-normalizer.test.ts > pipeline stage 2 integration > internal-links before 
seo-normalization order is enforced
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/lib/blog/final-seo-normalizer.test.ts:5011:90
    5009|     ];
    5010|     const issues = validatePipelineOrder(state);
    5011|     expect(issues.some((i) => i.code === "STAGE_ORDER" && i.stage === …
       |                                                                                          ^
    5012|   });
    5013| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/24]⎯

 FAIL  src/lib/blog/final-seo-normalizer.test.ts > single validation path > runFinalValidation is the single gating 
validation
TypeError: Cannot read properties of null (reading 'introduction')
 ❯ countUnsupportedFactualClaims src/lib/blog/final-article-policy.ts:330:29
    328| ): number {
    329|   const components = [
    330|     renderComponentHtml(doc.introduction),
       |                             ^
    331|     ...doc.sections
    332|       .filter((section) => section.sectionType !== "faq-heading" && se…
 ❯ analyzeFinalArticle src/lib/blog/final-article-policy.ts:497:7
 ❯ runFinalValidation src/lib/pipeline/blog-generation-pipeline.ts:2033:19
 ❯ src/lib/blog/final-seo-normalizer.test.ts:5618:20

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/24]⎯

 FAIL  src/lib/blog/final-seo-normalizer.test.ts > single validation path > failed final validation blocks persistence 
behavior
TypeError: Cannot read properties of null (reading 'introduction')
 ❯ countUnsupportedFactualClaims src/lib/blog/final-article-policy.ts:330:29
    328| ): number {
    329|   const components = [
    330|     renderComponentHtml(doc.introduction),
       |                             ^
    331|     ...doc.sections
    332|       .filter((section) => section.sectionType !== "faq-heading" && se…
 ❯ analyzeFinalArticle src/lib/blog/final-article-policy.ts:497:7
 ❯ runFinalValidation src/lib/pipeline/blog-generation-pipeline.ts:2033:19
 ❯ src/lib/blog/final-seo-normalizer.test.ts:5630:20

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/24]⎯

 FAIL  src/lib/services/component-regenerator.test.ts > component regeneration boundaries > never replaces the 
conclusion or FAQ while regenerating the final editorial section
AssertionError: expected '<!-- wp:paragraph --><p>Start here. K…' to contain '<!-- wp:paragraph --><p>Use a short p…'

- Expected
+ Received

- <!-- wp:paragraph --><p>Use a short plan. Test one idea. Improve it with feedback.</p><!-- /wp:paragraph -->
+ <!-- wp:paragraph --><p>Start here. Keep it clear.</p><!-- /wp:paragraph -->
+
+ <!-- wp:heading {"level":2} --><h2>Simple opening section</h2><!-- /wp:heading -->
+
+ <!-- wp:paragraph --><p>People plan. Teams act. Results follow.</p><!-- /wp:paragraph -->
+
+ <!-- wp:heading {"level":2} --><h2>Complex final section</h2><!-- /wp:heading -->
+
+ <!-- wp:paragraph --><p>Interdisciplinary commercialization methodologies necessitate extraordinarily sophisticated 
organizational interoperability. Institutionalization consequently accelerates incomprehensible administrative 
fragmentation.</p><!-- /wp:paragraph -->
+
+ <!-- b2i-conclusion-start -->
+
+ <!-- wp:paragraph --><p>The protected conclusion remains exactly where the application placed it.</p><!-- 
/wp:paragraph -->
+
+ <!-- b2i-conclusion-end -->
+
+ <!-- b2i-faq-heading -->
+ <!-- wp:heading {"level":2} --><h2>Frequently Asked Questions</h2><!-- /wp:heading -->
+ <!-- wp:html --><div class="faq-item"><h3>Question?</h3><p>Protected answer.</p></div><!-- /wp:html -->

 ❯ src/lib/services/component-regenerator.test.ts:82:25
     80|
     81|     expect(chatWithRetry).toHaveBeenCalled();
     82|     expect(result.blog).toContain(replacement);
       |                         ^
     83|     expect(result.blog).toContain(CONCLUSION_START_MARKER);
     84|     expect(result.blog).toContain(conclusion);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/24]⎯

 FAIL  src/lib/services/component-regenerator.test.ts > component regeneration boundaries > strips regenerated links 
that are not present in research
Error: regenerated-section-unowned returned invalid structured blocks: AI payload must contain a 'blocks' array
 ❯ parseStructuredEditorialResponse src/lib/services/component-regenerator.ts:229:11
    227|   const normalized = normalizeAiEditorialPayload(payload, componentId);
    228|   if (normalized.errors.length > 0 || normalized.blocks.length === 0) {
    229|     throw new Error(`${componentId} returned invalid structured blocks…
       |           ^
    230|   }
    231|   return renderEditorialBlocksToWordPress(normalized.blocks);
 ❯ regenerateSection src/lib/services/component-regenerator.ts:323:10
 ❯ src/lib/services/component-regenerator.test.ts:102:18

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/24]⎯

 FAIL  src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > shadow runs but no 
evidence when evidence flag is disabled
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/conclusion-shadow-evidence.test.ts:348:3
    346|   });
    347|
    348|   it("shadow runs but no evidence when evidence flag is disabled", asy…
       |   ^
    349|     const { translateArticle } = await import("./translation-service");
    350|     process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "tru…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/24]⎯

 FAIL  src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > records evidence 
when both flags are enabled
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/conclusion-shadow-evidence.test.ts:356:3
    354|   });
    355|
    356|   it("records evidence when both flags are enabled", async () => {
       |   ^
    357|     const { translateArticle } = await import("./translation-service");
    358|     process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "tru…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/24]⎯

 FAIL  src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > HTML translation 
remains authoritative when evidence is recorded
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/conclusion-shadow-evidence.test.ts:369:3
    367|   });
    368|
    369|   it("HTML translation remains authoritative when evidence is recorded…
       |   ^
    370|     const { translateArticle } = await import("./translation-service");
    371|     process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "tru…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[10/24]⎯

 FAIL  src/lib/services/conclusion-shadow-evidence.test.ts > evidence flow via translateArticle > evidence-recording 
failure does not fail translation
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/conclusion-shadow-evidence.test.ts:377:3
    375|   });
    376|
    377|   it("evidence-recording failure does not fail translation", async () …
       |   ^
    378|     const { translateArticle } = await import("./translation-service");
    379|     process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "tru…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[11/24]⎯

 FAIL  src/lib/services/editorial-block-translation.test.ts > translateEditorialBlocks > uses the structured fallback 
when HTML translation echoes English
AssertionError: expected '<!-- wp:paragraph --><p>Hello World w…' to contain '香港團隊錄得'

Expected: "香港團隊錄得"
Received: "<!-- wp:paragraph --><p>Hello World with 25% growth</p><!-- /wp:paragraph -->"

 ❯ src/lib/services/editorial-block-translation.test.ts:204:61
    202|
    203|     expect(result.passed).toBe(true);
    204|     expect(renderEditorialBlocksToWordPress(result.blocks)).toContain(…
       |                                                             ^
    205|     expect(renderEditorialBlocksToWordPress(result.blocks)).toContain(…
    206|     expect(result.validationParity?.diagnostics).toContain("structured…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[12/24]⎯

 FAIL  src/lib/services/editorial-block-translation.test.ts > translateEditorialBlocks > parser errors throw 
EditorialBlockTranslationError with component ID
AssertionError: promise resolved "{ blocks: [ { …(3) } ], …(3) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "blocks": [
+     {
+       "content": [
+         {
+           "text": "Hello",
+           "type": "text",
+         },
+       ],
+       "id": "h2-reject-wp-0",
+       "type": "paragraph",
+     },
+   ],
+   "metrics": {
+     "numbersMatch": 0,
+     "ratio": 1,
+     "sourceChars": 55,
+     "sourceNumbers": 0,
+     "translatedChars": 55,
+     "translatedNumbers": 0,
+   },
+   "passed": false,
+   "translatedHtml": "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->",
  }

 ❯ src/lib/services/editorial-block-translation.test.ts:275:6
    273|         },
    274|       }),
    275|     ).rejects.toThrow(EditorialBlockTranslationError);
       |      ^
    276|     await expect(
    277|       translateEditorialBlocks({

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/24]⎯

 FAIL  src/lib/services/editorial-block-translation.test.ts > structured number/link validation is authoritative > 
translated visible label with unchanged URL passes
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/lib/services/editorial-block-translation.test.ts:552:27
    550|       translateProtectedHtml: async () => "<!-- wp:paragraph --><p><a …
    551|     });
    552|     expect(result.passed).toBe(true);
       |                           ^
    553|   });
    554|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/24]⎯

 FAIL  src/lib/services/editorial-block-translation.test.ts > structured number/link validation is authoritative > 
parsed blocks validated before structured number/link checks
AssertionError: promise resolved "{ blocks: [ { …(3) } ], …(3) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "blocks": [
+     {
+       "content": [
+         {
+           "text": "Hello",
+           "type": "text",
+         },
+       ],
+       "id": "parse-first-wp-0",
+       "type": "paragraph",
+     },
+   ],
+   "metrics": {
+     "numbersMatch": 0,
+     "ratio": 1,
+     "sourceChars": 55,
+     "sourceNumbers": 0,
+     "translatedChars": 55,
+     "translatedNumbers": 0,
+   },
+   "passed": false,
+   "translatedHtml": "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->",
  }

 ❯ src/lib/services/editorial-block-translation.test.ts:565:6
    563|         },
    564|       }),
    565|     ).rejects.toThrow(EditorialBlockTranslationError);
       |      ^
    566|   });
    567|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[15/24]⎯

 FAIL  src/lib/services/editorial-block-translation.test.ts > structured number/link validation is authoritative > 
diagnostics include component ID in error messages
AssertionError: promise resolved "{ blocks: [ { …(3) } ], …(3) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "blocks": [
+     {
+       "content": [
+         {
+           "text": "Hello",
+           "type": "text",
+         },
+       ],
+       "id": "diag-id-wp-0",
+       "type": "paragraph",
+     },
+   ],
+   "metrics": {
+     "numbersMatch": 0,
+     "ratio": 1,
+     "sourceChars": 55,
+     "sourceNumbers": 0,
+     "translatedChars": 55,
+     "translatedNumbers": 0,
+   },
+   "passed": false,
+   "translatedHtml": "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->",
  }

 ❯ src/lib/services/editorial-block-translation.test.ts:592:6
    590|         },
    591|       }),
    592|     ).rejects.toThrow(/diag-id/);
       |      ^
    593|   });
    594| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[16/24]⎯

 FAIL  src/lib/services/editorial-block-translation.test.ts > block-level number protection lifecycle > source text 
without numbers passes through unchanged
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/lib/services/editorial-block-translation.test.ts:684:27
    682|       translateProtectedHtml: async (html) => html,
    683|     });
    684|     expect(result.passed).toBe(true);
       |                           ^
    685|   });
    686| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[17/24]⎯

 FAIL  src/lib/services/section-expander.test.ts > section expansion safety > uses the pipeline canonical word counter 
after every accepted expansion
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ src/lib/services/section-expander.test.ts:40:42
     38|     );
     39|
     40|     expect(measureCanonicalVisibleWords).toHaveBeenCalledTimes(1);
       |                                          ^
     41|     expect(result.finalWordCount).toBe(2200);
     42|     expect(result.expansionResults[0].accepted).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[18/24]⎯

 FAIL  src/lib/services/section-expander.test.ts > section expansion safety > rejects an AI expansion that invents a 
link
AssertionError: expected '<!-- wp:paragraph --><p>Start with a …' to be '<!-- wp:paragraph --><p>Start with a …' // 
Object.is equality

- Expected
+ Received

  <!-- wp:paragraph --><p>Start with a clear plan.</p><!-- /wp:paragraph -->
+
+ <!-- wp:paragraph --><p>Read <a href="https://invented.example">this invented source</a> before acting.</p><!-- 
/wp:paragraph -->

 ❯ src/lib/services/section-expander.test.ts:74:37
     72|     );
     73|
     74|     expect(result.sections[0].body).toBe(sections[0].body);
       |                                     ^
     75|     expect(result.expansionResults[0]).toMatchObject({
     76|       accepted: false,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[19/24]⎯

 FAIL  src/lib/services/translation-service.test.ts > translateArticle — structured helper orchestration > helper 
failure is surfaced so English fallback cannot be persisted
AssertionError: expected [ 'zh-intro-editorial', …(10) ] to include 'section-0'
 ❯ src/lib/services/translation-service.test.ts:220:37
    218|     expect(result.doc.sections.length).toBeGreaterThan(0);
    219|     expect(result.doc.sections[0].blocks.length).toBeGreaterThan(0);
    220|     expect(result.failedComponents).toContain("section-0");
       |                                     ^
    221|     expect(result.failedComponents.some((component) => component.start…
    222|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[20/24]⎯

 FAIL  src/lib/services/translation-service.test.ts > structured translation shadow orchestration > shadow disabled by 
default makes zero shadow calls
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ src/lib/services/translation-service.test.ts:258:64
    256|     await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {…
    257|     // No structured shadow was configured, so zero DTO-related calls
    258|     expect(mockCalls.filter((c) => c === "conclusion").length).toBe(1)…
       |                                                                ^
    259|   });
    260|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[21/24]⎯

 FAIL  src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > uses 
STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/translation-service.test.ts:308:3
    306|
    307| describe("structured conclusion shadow callbacks", () => {
    308|   it("uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYST…
       |   ^
    309|     // Verify the default production callback uses the dedicated prompt
    310|     const { STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM, TITLE_META_SYSTEM…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[22/24]⎯

 FAIL  src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > environment defaults 
include a repair callback
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/translation-service.test.ts:363:3
    361|   });
    362|
    363|   it("environment defaults include a repair callback", async () => {
       |   ^
    364|     process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "tru…
    365|     const mockHelper: typeof import("./editorial-block-translation").t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[23/24]⎯

 FAIL  src/lib/services/translation-service.test.ts > structured conclusion shadow callbacks > one repair attempt 
occurs on invalid response
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/lib/services/translation-service.test.ts:378:3
    376|   });
    377|
    378|   it("one repair attempt occurs on invalid response", async () => {
       |   ^
    379|     process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "tru…
    380|     const mockHelper: typeof import("./editorial-block-translation").t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[24/24]⎯


 Test Files  7 failed | 22 passed (29)
      Tests  24 failed | 1387 passed (1411)
   Start at  19:22:39
   Duration  36.46s (transform 4.65s, setup 0ms, import 9.61s, tests 84.58s, environment 5ms)
```

### npm run build (exit 0, 19.37s)

```

> b2i-content-engine@0.1.0 build
> next build

▲ Next.js 16.2.10 (Turbopack)
- Environments: .env.local

  Creating an optimized production build ...
✓ Compiled successfully in 5.6s
  Running TypeScript ...
  Finished TypeScript in 9.1s ...
  Collecting page data using 7 workers ...
  Generating static pages using 7 workers (0/26) ...
  Generating static pages using 7 workers (6/26) 
  Generating static pages using 7 workers (12/26) 
  Generating static pages using 7 workers (19/26) 
✓ Generating static pages using 7 workers (26/26) in 361ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/dashboard
├ ƒ /api/debug
├ ƒ /api/generate-blog
├ ƒ /api/generation-learning
├ ƒ /api/internal-links
├ ƒ /api/internal-links/[id]
├ ƒ /api/knowledge
├ ƒ /api/knowledge/[id]
├ ƒ /api/playground
├ ƒ /api/profile
├ ƒ /api/projects
├ ƒ /api/projects/[id]
├ ƒ /api/projects/[id]/images
├ ƒ /api/projects/[id]/images/delete
├ ƒ /api/projects/[id]/images/generate
├ ƒ /api/projects/[id]/research
├ ƒ /api/projects/[id]/research/generate
├ ƒ /api/projects/[id]/seo
├ ƒ /api/projects/[id]/seo/audit
├ ƒ /api/projects/[id]/social
├ ƒ /api/projects/[id]/translate
├ ƒ /api/projects/[id]/versions
├ ƒ /api/prompt-sections
├ ƒ /api/prompts
├ ƒ /api/prompts/[id]
├ ƒ /api/publish-blog
├ ƒ /api/suggested-links
├ ƒ /auth/callback
├ ○ /auth/login
├ ƒ /auth/signout
├ ○ /knowledge
├ ○ /playground
├ ○ /projects
├ ƒ /projects/[id]
├ ƒ /projects/[id]/blog
├ ƒ /projects/[id]/chinese-seo
├ ƒ /projects/[id]/competitor
├ ƒ /projects/[id]/images
├ ƒ /projects/[id]/outline
├ ƒ /projects/[id]/publish
├ ƒ /projects/[id]/research
├ ƒ /projects/[id]/seo
├ ƒ /projects/[id]/social
├ ƒ /projects/[id]/translation
├ ○ /prompts
├ ○ /settings
└ ○ /settings/links


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

### npx tsc --noEmit (exit 2, 6.85s)

```
src/lib/services/section-expander.test.ts(29,24): error TS2353: Object literal may only specify known properties, and 'research' does not exist in type 'SectionExpansionContext'.
src/lib/services/section-expander.test.ts(63,24): error TS2353: Object literal may only specify known properties, and 'research' does not exist in type 'SectionExpansionContext'.
```
