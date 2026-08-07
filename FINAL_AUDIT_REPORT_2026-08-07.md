# B2I English Generation — Final Production Audit

**Audit date:** 7 August 2026  
**Audited source:** `B2I-Content-Engine(8).zip`  
**Scope:** English request-to-save path, the exact final-trim failure, and directly relevant deterministic test infrastructure. No live generation or database mutation was performed.

## 1. Exact latest-failure diagnosis

The paragraph beginning `So, what does this mean for your business?` was valid professional prose. The coherence validator treated a transition as orphaned when the immediately preceding paragraph was a `Source:` citation, even though the nearest preceding substantive paragraph was complete and supplied the context being summarized.

The production sequence proves that deterministic trimming did not create the reported finding:

1. deterministic trim reported the finding;
2. the pipeline restored the pre-trim snapshot;
3. bounded compaction was rejected and restored its snapshot;
4. the same finding remained after both restorations.

Therefore the finding existed in the pre-trim canonical document and was a validator false positive. The old code did not log pre-trim findings, so this conclusion is based on the observed rollback sequence plus the validator's directly reproduced behaviour. New pre/post diagnostics make the distinction explicit on future runs.

### Historic compaction rejection

The exact recoverable fact is that the old `parseCompactionBlocksJson` returned `null`; rejection happened at the JSON/schema parser boundary before semantic acceptance gates. The old implementation collapsed syntactically invalid JSON and schema-invalid JSON into that same result and did not retain the raw response. The historic subclass cannot be reconstructed honestly from the surviving log. New code reports `reason=invalid-json` or `reason=schema-invalid` separately, and reports every later gate by name.

## 2. Production pipeline stage map

### Request, research and model assembly

1. Authenticate user and authorize project.
2. Load project and manual research.
3. Run automatic research only when eligible and no manual sources exist.
4. Build prompt/evidence context.
5. Generate and validate outline.
6. Launch bounded concurrent introduction, section, FAQ and conclusion work.
7. Apply each component's bounded normalization/repair path.
8. Settle all in-flight siblings before any fatal task failure escapes.
9. Assemble canonical `ArticleDocument`; rendered WordPress HTML is a derived cache.

### Post-assembly canonical pipeline

1. `assembly`
2. `claim-check`
3. optional `conclusion-discipline` when the existing editorial-polish flag enables it
4. `expansion`
5. `trim`
6. `paragraphs`
7. `regeneration`
8. `seo-normalization`
9. `title-repair`
10. `factual-scan`
11. `claim-ownership`
12. `temporal-freshness`
13. `post-factual-keyphrase`
14. `paragraphs-final`
15. malformed-prose repair and optional existing editorial-polish transaction
16. `claim-ownership-final`
17. `language-switcher`
18. `internal-links`
19. `external-links`
20. `external-dedup`
21. `link-enforce`
22. `factual-final`
23. `post-ownership-seo-reconcile`
24. `cta-preserve`
25. `final-trim`, with bounded targeted compaction only when required
26. `faq-recovery`
27. `wc-check`
28. `final-preflight`
29. `final-qc-scan`
30. optional `final-document-editorial` transaction; shadow mode remains diagnosis-only
31. `final-validation`

### Save boundary and later audit

1. Re-render the final `ArticleDocument` and require exact agreement with the pipeline cache and generated payload, including title, slug, meta description, excerpt and FAQ.
2. Rerun the final deterministic policy against that exact canonical state.
3. Only then request the next version number.
4. Create the version, update project content, read both back and recheck policy.
5. Compensate by restoring project content and deleting the new version if the save transaction fails.
6. Write the non-critical AI log after the compensated save boundary.
7. SEO audit is a separate endpoint. It reads the targeted saved version, rebuilds the canonical document when possible, uses the canonical visible-word scope and then writes SEO checks.

## 3. Canonical ownership and acceptance boundaries

- `ArticleDocument` is the publication authority after assembly.
- `state.blog` is a derived render cache and has one assignment owner.
- HTML-returning stages parse accepted output back into `ArticleDocument`; failed parsing or integrity checks restore the pre-stage snapshot.
- Snapshot coverage now includes the complete serialized document, title, slug, meta, excerpt, counters, SEO normalization result/decision and full-document editorial outcome.
- CTA, language switcher, visible FAQ, FAQ schema, links and WordPress markup live in or render from the canonical document and are covered by structural/protected-content gates.
- The authoritative publication word count is `countCanonicalVisibleWords(ArticleDocument)`. It excludes application-owned protected markup. The saved `word_count`, final trim, final policy and canonical SEO audit scope use that definition.
- Final-document editorial receives a structurally valid complete document, may target only allowed stable block IDs, applies only semantically and deterministically accepted block patches, and is followed by the full final policy again.
- Shadow editorial returns the baseline document, selects no units, applies no patches and cannot change persistence.

## 4. Concrete defects found and repaired

| Severity | Concrete defect | Repair |
|---|---|---|
| P1 | `So, ...` after a `Source:` citation was falsely rejected because coherence checked only the immediate paragraph. | Skip citation metadata and inspect the nearest complete substantive antecedent; keep contrast-dependent `Instead` strict. |
| P1 | Final trim attributed pre-existing coherence findings to deterministic compression. | Log pre/post/new findings and restore the pre-trim snapshot only for newly introduced findings. |
| P2 | Compaction collapsed every parser failure into `candidate JSON rejected`. | Separate invalid JSON from schema-invalid payloads and log every acceptance gate, section, safe diagnostic and rollback result. |
| P1 | Compaction could silently choose the first section when an explicit target ID was unavailable. | Reject with `target-unavailable`; never edit a different section. |
| P1 | Compaction did not preserve/represent H3, ordered-list or table structure. | Add bounded block schemas/rendering and exact structural signatures; retain all existing link, quote, fact, ownership, relevance, WordPress and protected-content gates. |
| P1 | Sentence shortening counted removed characters as removed words. | Count readable words and regression-check reported removal against canonical before/after count. |
| P0 | Snapshot rollback omitted slug, excerpt and full-document editorial outcome. | Include them in clone/restore and resynchronize canonical metadata. |
| P0 | Scalar title/meta state could diverge from canonical document metadata across HTML stages. | Synchronize final scalar metadata into the canonical document at the tracked stage boundary. |
| P1 | `Promise.all` could reject while a sibling model request was still completing, allowing the failed generation boundary to return early. | Stop starting new tasks after first failure and await all already-running siblings before throwing. |
| P1 | The new concurrency boundary initially used `undefined` as its failure sentinel, but promises may reject with `undefined`. | Use a separate failure boolean; regression-covered during self-audit. |
| P0 | The route validated `pipelineState` but could persist a different `generated` HTML/metadata/FAQ representation. | Require exact canonical agreement before even requesting the next version number. |
| P0 | Generated slug and excerpt could come from stale assembly inputs instead of final pipeline state. | Build persisted fields from final pipeline state and verify them against `ArticleDocument.metadata`. |
| P2 | Internal-link and SEO-normalization catches hid the reason for recoverable skips. | Record stage, exact reason, safe diagnostic and recoverability while preserving existing non-fatal semantics. |
| P1 (test safety) | The document-context shadow integration test installed a fake key but left a metadata call capable of contacting DeepSeek. | Add an offline provider guard to the test only; production translation code and flags are unchanged. |

No P3 editorial redesign was performed.

## 5. Compaction acceptance gates and diagnostics

Compaction now permits only bounded complete JSON, including a complete JSON fence or harmless outer prose around one complete object. It never repairs ambiguous/truncated JSON strings. A rejected candidate logs one or more of:

- `invalid-json`
- `schema-invalid`
- `ai-call`
- `target-unavailable`
- `not-shorter`
- `min-section-words`
- `word-count`
- `link-equivalence`
- `claim-equivalence`
- `ownership`
- `unsupported-claim`
- `quote-integrity`
- `coherence:<type>`
- `source-relevance`
- `wordpress-integrity`
- `protected-content`

Each rejection restores its complete snapshot and logs `rollback=success`.

## 6. Files changed

- `HANDOFF.md`
- `FINAL_AUDIT_REPORT_2026-08-07.md`
- `src/app/api/generate-blog/route.ts`
- `src/app/api/generate-blog/route.test.ts`
- `src/lib/blog/coherence.ts`
- `src/lib/pipeline/blog-generation-pipeline.ts`
- `src/lib/pipeline/final-trim-fallback.test.ts`
- `src/lib/pipeline/publication-quality-regression.test.ts`
- `src/lib/services/blog-generation-service.ts`
- `src/lib/services/blog-generation-service.test.ts`
- `src/lib/services/document-context-translation-shadow.integration.test.ts`

No model routing, thinking configuration, token budget, broad retry budget, SEO threshold, translation production workflow, claim-ownership policy value, persistence semantic or shadow-mode meaning was changed.

## 7. Regression coverage

Added or strengthened coverage for:

- contextual `So, ...` after a `Source:` citation;
- a genuinely orphaned `Instead, ...` with no contrast;
- a valid `Instead, ...` with an explicit rejected alternative;
- distinct pre-trim, post-trim and newly introduced coherence findings;
- exact final coherence metadata;
- exact readable-word removal accounting;
- invalid JSON versus schema-invalid compaction output;
- bounded complete Markdown JSON fence recovery;
- exact quote-integrity rejection logging;
- unsafe compaction rollback/protected-content survival;
- in-flight sibling settlement and no later task start after failure;
- rejection with `undefined` still stopping concurrency;
- canonical/generated representation mismatch causing zero writes;
- final-policy failures causing zero version/project writes;
- offline-only document-context shadow integration tests;
- existing safe `heading` alias handling and unsafe schema rejection through the existing schema suites;
- existing v15, v16 and v17 regression fixtures.

## 8. Verification results

- Focused changed-path suite: **51 passed, 0 failed** across 4 files.
- Complete offline suite: **2,257 passed, 0 failed** across 81 files. DeepSeek, Brave, database and Supabase credentials were removed; `DEBUG_EDITORIAL=false` prevented debug artifacts.
- `npx tsc --noEmit`: **passed**.
- Next.js 16.2.10 production build: **passed** with telemetry disabled and inert build-only public Supabase placeholders.
- Full repository lint: **448 existing findings** — 270 errors and 178 warnings. This remains repository debt outside this repair.
- Changed-file lint comparison: baseline **72 findings** (40 errors, 32 warnings); repaired files **70 findings** (39 errors, 31 warnings). No new lint finding was introduced; the changed set reduced the baseline by two.
- `git diff --check`: **passed**.

## 9. Immutable fixture confirmation

`git diff` reports no change to versions 15, 16 or 17.

- `blog-13-v15.json`: `3dfc23a6baecd3cf647ee3758ce5fcc6cd317cd2f40be6002a295f51d15590af`
- `blog-13-v16.json`: `a896946769aee4f9535aff8a41159cc406e4557e13d72a65f2d8a6bc63bee14c`
- `blog-13-v17.json`: `105047b1794ea24971f6747280c0a79b49bc789fdab0bc2814600dd6ec36dcc9`

## 10. Zero-write confirmation

The route performs canonical agreement and final policy checks before `getNextVersionNumber`, version creation or project update. Regression tests assert those repositories are not called for canonical mismatch, general final-policy failure, claim-ownership failure, coherence failure, sentence-quality failure or source-boilerplate failure. The supplied production log also says version 18 was not saved, but this audit did not access or mutate the live database.

## 11. Remaining known risks intentionally not changed

1. **Historic compaction subclass unavailable:** the old raw model response and exact parser subclass were not retained. New logs solve this prospectively.
2. **No live generation in this audit:** model variance, provider latency and the live DB compensation path still require one controlled operator run.
3. **No provider cancellation signal:** already-running siblings are safely awaited and cannot mutate failed state, but they are not actively cancelled because the current request abstraction exposes no safe shared `AbortSignal`. This can waste latency/tokens after a sibling failure.
4. **Persistence uses compensation, not a database transaction:** next-version allocation, version creation and project update remain separate calls. Existing readback and compensation are retained because persistence semantics were explicitly out of scope without a proven direct defect.
5. **Repository lint debt:** 448 findings predate and extend far beyond this bounded repair. Removing them would be unrelated refactoring.
6. **Contextual coherence remains deterministic:** the known citation/transition false positive is fixed and contrast-dependent `Instead` remains strict, but deterministic local-context checks are not a general natural-language entailment engine. Final deterministic QC and optional full-document diagnosis remain the later safeguards.

## 12. Operator handoff

Load this exact package and run one controlled English generation for project 13. Confirm the new final-trim diagnostics, exact compaction reasons if invoked, pre-save canonical agreement, and the expected next version number. If version 18 saves and its readback/final QC is clean, freeze English and proceed with Traditional Chinese localisation parity.
