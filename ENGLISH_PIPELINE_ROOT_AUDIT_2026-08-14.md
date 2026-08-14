# B2I Content Engine — English Pipeline Root Audit and Repair

Date: 2026-08-14

## Executive result

The audited English generation code is ready for a controlled production generation after `supabase/phase15-blog-version-atomicity.sql` is applied. No proven code blocker remains in the deterministic English path. The staged generator, canonical `ArticleDocument`, existing quality thresholds, claim-strength rules and fail-closed publication gates remain intact.

This conclusion is based on static execution tracing, deterministic regression fixtures, 1,219 passing English-path tests, a clean TypeScript check and a successful production build. It is not a claim that a live DeepSeek generation was run. The repository-wide `npm test` command was refused by the execution environment because it may run provider-capable tests; the broad offline-safe English suite is documented below.

## Production unmatched-quotation incident

### What can and cannot be proven

The production log identifies `section-0-wp-4` and `section-5-wp-10`, but the ZIP contains neither the generated article nor the per-stage content snapshots from that production request. The exact text of those two blocks and their individual first-corrupting stage therefore cannot be reconstructed from this artifact. Assigning either block to DeepSeek, factual removal or ownership removal would be speculation.

The code audit did prove multiple paths capable of producing or carrying the reported symptom:

1. Several AI output boundaries accepted an otherwise schema-valid string with an unmatched quotation mark.
2. Factual, ownership, source-boilerplate, temporal, SEO, paragraph-splitting and trimming operations reasoned in sentence units without treating a multi-sentence quotation as one semantic unit.
3. The old quotation detector counted punctuation without enough context to distinguish directional smart quotes, straight quoted speech and measurement inch marks.
4. The deterministic malformed repair reported only its editable-block subset, while the immediate boundary scanned the complete canonical document.

All proven producers and carriers above are now repaired. A genuinely incomplete model quotation is rejected at its producer boundary and receives the existing bounded correction opportunity where that producer supports one. An ambiguous quotation is never completed by guessing. Later deterministic transformations preserve or remove a quotation atomically, or fail closed.

### Why `unresolved=1` became boundary `(2)`

The values represented different scopes:

- old `unresolved=1`: unresolved findings returned by the editable paragraph/H3 repair selection;
- boundary `(2)`: hard findings from a second scan of the complete canonical document, including every supported block type and the protected metadata/FAQ surfaces covered by the final gate.

The logic was not artificially forced to one value. Logs now name the scopes explicitly as `unresolvedEditable` and `unresolvedDocument`, and rejected-stage metadata records both block-ID sets before restoring the exact snapshot and throwing.

## Final production order

1. Authenticate the user and authorize project access.
2. Load project configuration, prompt bundle and approved research.
3. Generate and deterministically accept the outline/title/slug/meta/excerpt/H2 plan, with one bounded correction for unsafe output.
4. Build the claim-ownership ledger before prose generation.
5. Lazily generate introduction, ordinary sections, structured FAQ and conclusion with concurrency two; stop starting work after the first fatal failure and await active siblings.
6. Normalize and strictly accept each AI block payload; reject empty, ambiguous, unsupported or quotation-invalid payloads.
7. Assemble the canonical `ArticleDocument`; derive WordPress HTML from it.
8. Claim-conflict check and bounded targeted regeneration.
9. Source-relevance repair for pure off-topic citation blocks.
10. Optional conclusion discipline under the existing editorial-polish flag.
11. Section expansion to the minimum word count.
12. Section trim to the maximum word count.
13. Paragraph normalization.
14. Component regeneration.
15. SEO normalization.
16. Title repair.
17. Factual scan and quote/dependency-safe removal.
18. Claim-ownership enforcement and verification.
19. Temporal-freshness repair with comparative rollback.
20. Soft post-factual keyphrase diagnostic (no forced prose mutation).
21. Final paragraph normalization.
22. Deterministic malformed-prose repair and full-document repair boundary.
23. Optional targeted editorial repair/polish; broad ownership remains with the full-document layer when enabled.
24. Final claim-ownership confirmation.
25. Canonical language-switcher restoration.
26. Internal-link insertion.
27. External-source insertion and deduplication.
28. Internal-link limit enforcement.
29. Final factual and ownership confirmation.
30. Post-ownership SEO reconciliation, with exact-H2 keyphrase still soft.
31. Canonical CTA restoration.
32. Structure-aware final trim and at most one bounded section compaction.
33. FAQ schema regeneration from canonical FAQ data.
34. Canonical word-count parity gate.
35. Final preflight: malformed prose, protected structures, links, FAQ/schema parity and structure.
36. Natural heading reconciliation; exact editorial-H2 keyphrase absence remains soft.
37. Deterministic final QC.
38. Full-document editorial diagnosis/patch transaction when enabled; protected surfaces are not editable.
39. Save-boundary H2 assertion and sole final acceptance policy.
40. Route-level canonical/render agreement and repeat final validation.
41. One atomic database transaction allocates the version number, inserts the English version and promotes `projects.content`.
42. Exact-ID readback and post-save validation; success logging occurs only afterward.
43. The SEO audit endpoint targets the explicit saved version and uses the canonical publication-word scope.

## Repaired defects

### P0 — content corruption or unsafe persistence

#### 1. Unmatched model quotations crossed producer boundaries

Root cause: schema validation checked shapes and supported block types but did not consistently validate quotation integrity for every text-bearing field.

Fix: added a shared contextual quotation analyzer and applied it to all AI editorial blocks, outline headings, FAQ questions/answers, title, meta description and excerpt. Invalid output is rejected at the owning producer; supported correction remains bounded.

#### 2. Sentence-level deletion could split attributed speech

Root cause: factual and ownership cleanup could select one sentence inside a multi-sentence quote, leaving a balanced-looking but materially altered quotation or an unmatched mark.

Fix: sentence removal ranges expand to the entire paired quotation. Ambiguous/unbalanced input is not destructively edited. Cross-paragraph dependency cleanup refuses unsafe quote involvement. Ownership uses the same repaired factual-removal primitive and strict parser.

#### 3. Other deterministic transformations could alter only part of a quote

Root cause: source-boilerplate filtering, stale-temporal repair, keyphrase reduction, readability rewriting, paragraph splitting and final compaction did not share one quote-atomic rule.

Fix: every shortening/rewrite owner now preserves complete quote spans, skips ambiguous quotations, or rejects/restores the candidate. Temporal issues within speech remain unresolved rather than silently changing attributed meaning.

#### 4. Permissive WordPress parsing could accept a partial document

Root cause: some mutation boundaries accepted the subset of blocks they understood and silently discarded unsupported top-level markup, nested blocks, raw residue or inconsistent heading structures.

Fix: added `parseCompleteEditorialRegion`. It first validates WordPress pairing, then requires the whole editable region to be consumed by supported blocks. Unsupported/nested/raw content and H2/H4/level-mismatched model headings are rejected. Only structurally unambiguous H3 content normalizes to a subheading.

#### 5. Internal canonical round-trip could overwrite canonical FAQ with legacy extraction artifacts

Root cause: a legacy rendered-HTML FAQ extractor could replace already-canonical answers with strings containing WordPress markers during a full-document round trip, creating crossed block structure.

Fix: strict internal round-trips preserve the seed document's canonical FAQ data. FAQ schema continues to be regenerated from the final canonical FAQ.

#### 6. Stage integrity guard could compare a mutated candidate with itself

Root cause: structured stages sometimes mutated `ArticleDocument` before `runTrackedHtmlStage` captured its comparison input. Protected loss could therefore be invisible because the guard's “before” representation was already the candidate.

Fix: the guard accepts and uses the true pre-stage snapshot render as its baseline, while the accepted candidate is reparsed into canonical state. Rejection restores the complete snapshot.

#### 7. Link insertion could target markup instead of visible prose

Root cause: the keyword matcher skipped existing anchors but could match text in other HTML attributes or WordPress comments before the visible occurrence.

Fix: all tags and WordPress comments are excluded ranges. Only visible editorial prose can receive an injected anchor.

#### 8. SEO repair could invent or destructively rewrite body copy

Root cause: missing-keyphrase handling could insert a sentence; expansion acceptance did not require the original paragraph to survive exactly; readability/keyphrase removal could touch quoted or evidence-bearing prose.

Fix: missing keyphrase is now a soft diagnostic with no invented body sentence. Expansion must contain the exact original paragraph. Readability and keyphrase reduction skip quotations, links, numbers, attributions and factual-risk content. The whole SEO stage has a malformed-prose non-regression check.

#### 9. Paragraph normalization could cross protected WordPress HTML

Root cause: whole-document paragraph matching could consume across a malformed/unclosed paragraph into `wp:html`, damaging CTA/switcher/schema structure.

Fix: protected `wp:html` blocks are masked and restored byte-for-byte; splitting uses quotation-safe sentence boundaries and refuses structurally unsafe candidates.

#### 10. Version allocation and project promotion were not one transaction

Root cause: application-side `MAX(version)+1`, insertion and `projects.content` promotion were separate operations. Concurrent requests could collide or promote an older version, and a process crash could leave a committed version without the matching project content.

Fix: `save_generated_english_blog_version` locks the authorized project row, allocates the next project version, inserts the row and promotes the exact English HTML inside one PostgreSQL transaction. A unique `(project_id, version_number)` index is an additional invariant. The route uses the database-returned ID/version and never searches for or deletes an ambiguous row.

### P1 — avoidable rejection or unreliable recovery

#### 11. Metadata truncation and sentence boundaries could strand closing punctuation

Fix: meta truncation and shared sentence offsets now carry closing quotes/brackets with the sentence and avoid cuts through a quotation.

#### 12. Section expansion/trim accepted incomplete or silently normalized model output

Fix: expansion/trim accepts only complete supported WordPress fragments with readable-content parity and balanced quotations. Explicit H2 output is rejected instead of silently stripped. A rejected trim restores the exact prior section.

#### 13. Component metadata regeneration could replace valid copy with malformed copy

Fix: alternatives must be normalized plain text and quotation-balanced; invalid candidates retain current canonical metadata.

#### 14. Full-document and final-QC scanners covered different prose surfaces

Fix: the final malformed-prose scan covers metadata, all editorial headings, every editorial block type and FAQ questions/answers. Table cells are scanned independently so punctuation cannot cancel between cells.

### P2 — diagnosis weakness

#### 15. Repair counts hid their scope

Fix: logs and stage metadata distinguish editable-selection results from full-document hard findings.

#### 16. Rejected mutations lacked their true baseline and rollback evidence

Fix: tracked stages log the real input/candidate fingerprints, exact rejection reason and rollback source. Final-document diagnosis is never called with invalid WordPress structure.

### P3 — no redesign

No P3 style issue justified an architectural change. The existing staged generator and quality thresholds were left in place.

## Exact files changed

### Production code

- `src/app/api/generate-blog/route.ts`
- `src/lib/blog/article-content.ts`
- `src/lib/blog/article-document.ts`
- `src/lib/blog/claim-ownership.ts`
- `src/lib/blog/coherence.ts`
- `src/lib/blog/factual-risk-scanner.ts`
- `src/lib/blog/final-seo-normalizer.ts`
- `src/lib/blog/publication-quality.ts`
- `src/lib/blog/quotation-integrity.ts` (new)
- `src/lib/blog/source-boilerplate.ts`
- `src/lib/blog/temporal-freshness.ts`
- `src/lib/pipeline/blog-generation-pipeline.ts`
- `src/lib/repositories/blog-versions.ts`
- `src/lib/seo/seo-text-utils.ts`
- `src/lib/services/blog-generation-service.ts`
- `src/lib/services/component-regenerator.ts`
- `src/lib/services/link-injector.ts`
- `src/lib/services/section-expander.ts`
- `src/lib/services/text-utils.ts`
- `supabase/phase15-blog-version-atomicity.sql` (new)

### Regression tests

- `src/app/api/generate-blog/route.test.ts`
- `src/lib/blog/article-content.test.ts`
- `src/lib/blog/final-seo-normalizer.test.ts`
- `src/lib/blog/publication-quality.test.ts`
- `src/lib/blog/temporal-freshness.test.ts`
- `src/lib/pipeline/blog-generation-pipeline.test.ts`
- `src/lib/pipeline/malformed-prose-boundary-regression.test.ts`
- `src/lib/pipeline/publication-quality-regression.test.ts`
- `src/lib/repositories/blog-version-atomicity-migration.test.ts` (new)
- `src/lib/repositories/blog-versions.test.ts`
- `src/lib/services/blog-generation-service.test.ts`
- `src/lib/services/component-regenerator.test.ts`
- `src/lib/services/link-injector.test.ts` (new)
- `src/lib/services/section-expander.test.ts`
- `src/lib/services/split-long-paragraphs.test.ts`

## Regression coverage

The new/expanded fixtures cover:

- unmatched smart and straight quotations at every model producer;
- valid apostrophes, paired smart/straight speech, numeric quoted text and inch marks;
- multi-sentence quote atomicity in factual, ownership, boilerplate, temporal, SEO, paragraph and compaction paths;
- dangling dependencies after factual removal;
- complete vs partial WordPress parsing, unsupported levels, nested blocks, inline markup and raw residue;
- canonical render/parse/render agreement and FAQ preservation;
- protected CTA/switcher/schema/link restoration from the true pre-stage snapshot;
- visible-text-only internal-link injection;
- missing H2/body keyphrase remaining soft and non-destructive;
- expansion/trim rollback and no silent H2 stripping;
- metadata candidate rejection;
- complete-document malformed-prose scope and per-table-cell scanning;
- zero writes on hard generation/representation/factual/ownership/coherence/malformed failures;
- one-call atomic save, database-allocated version return, exact-ID compensation and no ambiguous deletion;
- migration uniqueness, row lock, English-only reconciliation and service-role permissions.

The exact prior duplicated heading `Hong Kong Marketing Trends 2026: What's Shaping Hong Kong Marketing` is already covered by the current heading-naturalness/outline boundary and deterministically reduces to `Hong Kong Marketing Trends 2026`. Missing exact focus keyphrase in an editorial H2 remains a soft SEO result, not a save blocker.

## Verification

### Offline English path

Command scope: generate-blog route, every `src/lib/blog/*.test.ts`, every `src/lib/pipeline/*.test.ts`, content standards, repository persistence, and all directly involved generation/postprocessor/SEO/WordPress service suites.

Result: **43 files passed; 1,219 tests passed; 0 failed.**

### TypeScript

`npx tsc --noEmit`: **passed**.

### Lint

- Uploaded baseline: **445 findings — 269 errors, 176 warnings**.
- Final code: **444 findings — 269 errors, 175 warnings**.

All changed/new TypeScript files were linted. The repair adds no lint error relative to the uploaded baseline and removes one warning. Existing repository lint debt remains and was not mass-refactored during this pipeline repair.

### Production build

`npm run build` with non-production placeholder build variables: **passed**. Next.js compiled, TypeScript completed, and all 26 static pages were generated.

### Repository-wide test command

The execution environment refused unfiltered `npm test` because the repository includes provider-capable paths that could contact DeepSeek with project fixtures or an API credential. It was not bypassed and is not reported as passing. The 1,219-test deterministic English suite above contains the complete audited English generation, pipeline and route surfaces without live provider transmission.

## Invariant confirmations

- Hard publication gates were not weakened.
- Factual and claim-strength thresholds were not weakened.
- Claim ownership remains a hard gate.
- Exact focus keyphrase in an editorial H2 remains soft SEO behavior.
- The staged section-by-section generator was not replaced by a one-call article generator.
- `ArticleDocument` remains canonical; HTML is a derived cache and the exact validated render is the saved payload.
- CTA, language switcher, FAQ, schema, links and WordPress structure remain application-owned/protected.
- A genuine hard generation or pre-save validation failure performs zero English version writes.
- Existing saved versions are never modified or deleted by the migration. If pre-existing duplicate project/version pairs exist, the migration fails closed for operator review.
- Existing regression fixtures were not weakened to make tests pass.
- DeepSeek model routing, thinking configuration, token budgets and broad retry budgets were not changed.

## Deployment requirement and remaining risks

1. **Apply the migration before deploying the route.** The route intentionally fails closed if `save_generated_english_blog_version` is unavailable. Deploying code first would cause valid generations to fail at persistence.
2. The two original live block payloads are absent, so their per-block historical provenance remains unconfirmed even though every proven producer class is repaired.
3. No live DeepSeek generation was performed. Provider output variance and real database/RLS configuration require one controlled production generation after the migration.
4. A network loss after the atomic database transaction commits but before its response reaches the application is an inherently ambiguous distributed outcome: the request may return an error even though a complete, valid version and matching project content were committed. It cannot create the former half-saved state, and the route never guesses which row to delete.
5. Legacy translation/version-writing paths still use the existing repository API. The new unique index prevents duplicate version numbers, but simultaneous English generation and legacy translation may make the legacy caller receive a unique-conflict error. Updating translation persistence to the same allocator is a separate, bounded follow-up and was not mixed into this English-pipeline repair.
6. The repository retains pre-existing lint debt. It did not regress this audit.

## Final recommendation

Apply `supabase/phase15-blog-version-atomicity.sql`, deploy the matching code, then run one controlled live English generation with normal production logging. Inspect the repair-boundary scope fields, final stage ledger, returned version ID/number, saved canonical word count, FAQ/schema parity, CTA/link fingerprints and the exact readback. Based on the audited code, no proven blocker remains before that controlled run.
