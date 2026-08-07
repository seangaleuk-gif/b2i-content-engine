# B2I Content Engine — Handoff
**Date:** 7 August 2026  
**Project:** B2I Content Engine  
**Purpose:** Continue the English-generation stabilization work, then bring the Traditional Chinese translation pipeline into full parity without reopening already-fixed English architecture.

## 1. Current state

The English blog-generation pipeline has been heavily repaired and is now much safer than the earlier versions. Versions 15, 16 and 17 are preserved as read-only regression fixtures. Version 17 is the latest confirmed successfully saved English version for project/blog 13 (`version_number=17`, DB record `id=230`).

The earlier generic `"heading"` repair-schema blocker is already fixed and regression-covered. The next attempted version 18 reached final trimming but did **not** save because contextual `So, ...` prose was falsely classified as an orphan transition. That defect, its ambiguous compaction diagnostics, the late-sibling concurrency boundary, rollback coverage and the pre-save canonical-representation boundary are now repaired in this codebase.

No live production generation was run during this audit. The next operator action is one controlled English generation; if it saves cleanly, freeze English and continue Traditional Chinese parity work.

## 1A. Final-QC fragment / stale-scan fix (this audit)

### Proven root cause

A production attempt reached final deterministic QC and failed with two unresolved findings:

```text
type=malformed-prose component=section-2 block=section-2-wp-8 issues=incomplete sentence ending
type=fragment          component=section-3 block=section-3-wp-3 sentence="."
```

Forensic conclusion (not inferred from log order — verified by reading `final-qc-scan`):

1. **Stale-scan defect (Q11 = YES).** In `blog-generation-pipeline.ts`, `final-qc-scan` computed `coherence`, `malformed`, `sentenceQuality` and `boilerplate` **before** the `removeOffTopicSourceCitations` mutation and never recomputed them after it — only `relevance`/`ungrounded`/`headings`/`unsupportedClaims` were recomputed. The log printed the removal message and then reported **pre-removal** findings. After the removal shifts block indices and sentence boundaries, only post-mutation findings are trustworthy. This violated the "Final-QC transaction requirement".

2. **Producer.** The two blocks existed malformed on entry to final QC. `final-trim` ran only Pass 1 whole-paragraph removal (`shortened=0`), so it cannot create an interior `.` fragment in a surviving block. `removeUnsupportedSentences` correctly removes whole sentence ranges; the residual defect class is a paragraph left as terminal punctuation only (`.`, `..`) or ending in a dangling `stop-word.` (`…to.`, `…and.`). `removeTextRanges` had no guard against leaving that residue.

### Fixes

- **`src/lib/pipeline/blog-generation-pipeline.ts`** — `final-qc-scan` is now an explicit deterministic transaction: snapshot before, collect the exact off-topic citation block IDs, remove, re-render from `ArticleDocument`, integrity-guard, accept-or-restore, then **recompute every final scanner against the modified document** before computing `unresolved`. Added `[final-qc-scan] candidate=off-topic-citation-removal beforeFingerprint=… afterFingerprint=… pass=… removedBlockIds=[…] rollback=…` diagnostics.
- **`src/lib/blog/content-relevance.ts`** — added `collectOffTopicSourceCitationBlockIds` (single detection shared by the removal and its diagnostics) and reimplemented `removeOffTopicSourceCitations` on top of it so a reported block is exactly the block removed.
- **`src/lib/blog/factual-risk-scanner.ts`** — added `finalizeRemovedParagraph` guard after `removeTextRanges`: a punctuation-only paragraph is removed as a whole block; a trailing dangling `stop-word.` residue is stripped deterministically (plain-text blocks only) so the paragraph scans clean. Never deletes substantive prose, links or numbers.

### Tests

- New `src/lib/blog/final-qc-fragment-regression.test.ts` (12 tests): dot-only removal, trailing `stop-word.` residue, embedded-link preservation, pure off-topic citation removed as one whole block, embedded citation not partially deleted, stale-scan/recompute, parse→render→parse, snapshot restoration, deterministic malformed repair, hard-gate retained.
- Full suite: **2,269 passed / 0 failed** (82 files). `tsc --noEmit` clean. Build passes. Lint: no new findings vs baseline (pipeline baseline 14 err/13 warn → current 13 err/13 warn; changed regions clean). `git diff --check` clean.
- Fixtures `blog-13-v15.json`, `v16.json`, `v17.json` unchanged (tracked, `git status` clean).

### Remaining risks

- The `stop-word.` strip only rewrites plain-text paragraphs; a paragraph ending in `…to.` that also carries an inline link is left to the existing hard gate (reject, zero writes) rather than risk breaking the anchor. This is intentional.
- The fragment class can still originate from model output or other upstream inline editors; this fix guarantees the two deterministic removal paths never create it and the final gate reports only post-mutation truth.

## 2. Stack and architecture

- Next.js 16.2.10
- TypeScript
- Supabase
- DeepSeek API
- Current English model in production logs: `deepseek-v4-flash`
- Thinking disabled for the normal generation stages shown in logs
- WordPress block output
- Canonical internal representation: `ArticleDocument`
- Staged English generation
- Full-document editorial diagnosis in **shadow mode**; it must remain diagnosis-only unless explicitly redesigned later

Current high-level flow:

1. Research handoff
2. Outline
3. Introduction
4. Section-by-section drafting
5. Per-section repair where needed
6. FAQ
7. Conclusion
8. Canonical `ArticleDocument` assembly
9. SEO normalization
10. Factual scanning
11. Claim ownership enforcement
12. Malformed-prose repair
13. Link injection/enforcement
14. Post-ownership SEO reconciliation
15. Canonical CTA restoration
16. Final trim / bounded compaction fallback
17. FAQ/schema recovery
18. Canonical word-count check
19. Final preflight
20. Final canonical QC scan
21. Full-document shadow editorial diagnosis
22. Pre-save policy gate
23. Version save
24. SEO audit

## 3. Immutable regression versions

For **project/blog ID 13**:

- Version 15 — DB record `228`
- Version 16 — DB record `229`
- Version 17 — DB record `230`
- Version 18 does not exist from the latest failed run

Do not overwrite or mutate versions 15, 16 or 17.

# 4. Recent English pipeline repairs

## A. Version 15 — destructive final trimming

The old residual trim fallback deleted arbitrary sentences and paragraphs.

Observed damage included:

- unfinished example: `A good example: imagine a local skincare brand that wants to launch a new serum.`
- orphan transitions such as a section beginning with `Instead,`
- stripped supporting explanations

Old log evidence included:

- `shortenedSentences=20`
- `removedParagraphs=5`

### Repair

New/major file:

- `src/lib/blog/coherence.ts`

Current behavior:

- structure-aware paragraph removal
- no section-boundary crossing
- protection for examples, setups, transitions, evidence, links, keyphrase-bearing content and protected blocks
- section word floor
- post-trim coherence validation
- incomplete sentences, orphan transitions, dangling references and thin/empty sections block publication
- bounded section-compaction fallback exists when deterministic compression cannot safely finish

## B. Source boilerplate

Bad publisher text had entered articles, including:

- legal/disclaimer text
- `All rights belong to their respective owners.`

### Repair

Key file:

- `src/lib/blog/source-boilerplate.ts`

Detection now covers:

- legal disclaimers
- opinion notices
- privacy/cookie/terms notices
- navigation/footer junk
- liability notices
- `all rights reserved`
- `all rights belong to`
- `rights belong to their respective owners`
- copyright notices
- reproduction notices
- publisher ownership statements

Filtered at:

1. evidence ledger
2. prompt context
3. final canonical QC

Final scan covers paragraphs, quotes, list items, table cells, subheadings and FAQ questions/answers. Remaining boilerplate is a hard failure.

## C. Factual-risk / claim-strength validation

Earlier scanning missed stronger claims next to weaker supported ones.

Examples:

- `hit rock bottom`
- `simply won't work anymore`
- `no longer guarantees attention`
- `thousands of messages daily`
- `every customer`
- `no brand can succeed without`
- `always leads to`
- `leads to fewer returns`

### Repair

Key file:

- `src/lib/blog/factual-risk-scanner.ts`

Current behavior:

- independent clauses scanned separately
- one supported clause cannot support a stronger neighboring clause
- evidence matching considers subject, outcome, population, timeframe, modality, certainty and comparative/absolute strength

Expanded claim concepts include:

- `market_wide_claim`
- `format-ineffectiveness`
- `absolute-outcome`
- `message-volume`
- `every-customer`
- `no-brand-can`
- `rock-bottom`

Unsupported stronger claims must be removed, safely softened without new facts, or block saving.

## D. Claim ownership + dependent references

Version 16 exposed:

- a supported `78%` claim was removed by ownership enforcement
- dependent prose remained: `That's a striking number, and it makes sense.`

### Repair

Claim removal is dependency-aware.

Patterns include:

- `that's a striking number`
- `that number`
- `that figure`
- `this result`
- `these findings`
- `this shows`
- `the point is`

It checks neighboring and cross-paragraph dependencies, including cases separated by a `Source:` citation.

## E. SEO keyphrase corruption

Version 16 proved `reduceInBlocks` / `reduceGlobally` in:

- `src/lib/blog/final-seo-normalizer.ts`

were corrupting prose by replacing keyphrases at arbitrary positions.

Bad outputs included:

- `the broader these market changes picture`
- `the this shift landscape`
- `these these 2026 trends`
- `the the city's evolving marketing landscape`
- `the the changing Hong Kong market`

### Repair

`KEYPHRASE_SYNONYMS` was removed from this path.

Current reduction:

- removes complete sentences only
- no arbitrary mid-sentence substitution
- protects links, numbers and attributions
- validates resulting prose before commit
- restores prior snapshot if unsafe
- can leave one extra natural occurrence if density remains under the existing maximum

New file:

- `src/lib/blog/sentence-quality.ts`

Checks include duplicated determiners, repeated adjacent words, lowercase sentence starts, broken punctuation, malformed noun phrases and fragments.

## F. Exact keyphrase in editorial H2

Earlier SEO checks incorrectly credited the FAQ H2.

### Repair

Key files include:

- `src/lib/blog/post-ownership-seo-reconcile.ts`
- SEO auditor/final policy code

FAQ/CTA/protected headings no longer satisfy the editorial-H2 requirement.

Version 17 then exposed an unnatural concatenated heading:

`The State of Digital Marketing in Hong Kong for 2026: Hong Kong Marketing Trends 2026`

Heading logic was repaired toward natural output such as:

`Hong Kong Marketing Trends 2026: The State of Digital Marketing`

Heading naturalness rejects repeated years and duplicated topic/Hong Kong wording.

## G. Title casing

Old deterministic title repair could produce:

`Hong kong marketing trends 2026`

### Repair

`normalizeEnglishTitleCasing` in:

- `src/lib/services/text-utils.ts`

preserves proper nouns/acronyms such as `Hong Kong`, `HSBC`, `AI`.

## H. SEO audit measurement mismatch

Earlier logs confused targets with measurements and later showed:

- pipeline canonical count `2851`
- SEO audit count `2575`

### Repair

Pipeline and SEO audit now use the same authoritative canonical visible-word counter.

Logs distinguish:

- target word count
- measured canonical word count
- measured FAQ count
- paired English FAQ count for Chinese audits

## I. Source-to-section relevance

Version 17 placed unrelated evidence in the privacy section.

### Repair

New file:

- `src/lib/blog/content-relevance.ts`

Current behavior:

- explicit `Source:` citations need meaningful overlap with the section H2
- fully ungrounded sections can be rejected
- link quotas never override relevance
- an off-by-one section-heading mapping bug in external-link placement was fixed

## J. Final canonical QC

The final deterministic QC stage now runs after mutating stages and before save.

It checks:

- coherence
- malformed prose
- sentence quality
- source boilerplate
- unsupported claim-strength inflation
- source-to-section relevance
- heading naturalness
- WordPress integrity
- protected-content integrity

Deterministic violations block saving.

Shadow editorial stays diagnosis-only.

# 5. Final-trim bounded fallback repair

A later production run correctly failed after structure-aware trimming created:

1. an incomplete/truncated MWI quotation
2. an orphan `Instead,` transition

The hard gate caught the damage and no version was saved.

The fallback was strengthened in:

- `src/lib/pipeline/blog-generation-pipeline.ts`

Current behavior:

1. Snapshot complete pre-trim state.
2. Run deterministic compression.
3. Run `validateCoherence`.
4. On violation, restore complete pre-trim snapshot.
5. Identify only violating sections.
6. Run bounded compaction only on those sections.
7. Pass full section, heading, links/citations, neighbor context and owned evidence.
8. Accept only if shorter, above section floor, link-equivalent, claim-equivalent, ownership-clean, unsupported-claim-free, quote-complete, coherent, topic-relevant, WordPress-valid and final count is 2,125–2,875.
9. Quotes are verbatim-or-remove-whole.
10. Orphan transitions cannot survive.
11. Rejected compaction restores its own snapshot.
12. Unresolved fallback failure remains a hard zero-write failure.

Relevant regression file:

- `src/lib/pipeline/final-trim-fallback.test.ts`

Latest completed verification for the final-trim/canonical-boundary repair:

- 2,256 tests passed before the final self-audit edge-case addition; the final packaged count is recorded in `FINAL_AUDIT_REPORT_2026-08-07.md`
- 0 failed
- 81 test files
- `tsc --noEmit`: clean
- `next build`: passes with inert build-only public Supabase placeholders
- repository lint remains a pre-existing debt; changed-file comparison introduced no new lint findings
- no changes to model routing, thinking, token budgets, general retry budgets, SEO thresholds, translation workflow, persistence semantics or shadow-mode meaning

# 6. RESOLVED LATEST BLOCKER — contextual transition at final trim

The latest failed version-18 attempt reached final trim. The paragraph beginning `So, what does this mean for your business?` was already in the canonical document and had a valid preceding substantive explanation, with a `Source:` citation between them. The old coherence rule looked only at the immediately preceding paragraph, treated the citation as no antecedent, and produced a false `orphan-transition` finding.

The production log proves the finding was pre-existing rather than introduced by deterministic trimming: the trim was rejected and rolled back, the bounded compaction candidate was rejected and rolled back, and the same finding remained. The historic compaction log proves rejection occurred at the JSON/schema parser boundary, but the old implementation discarded whether the exact subclass was invalid JSON or schema-invalid JSON. That missing evidence cannot be reconstructed honestly.

Current repairs:

- contextual transition validation skips `Source:` citation paragraphs and looks at the nearest complete substantive paragraph;
- genuine contrast-dependent `Instead, ...` openings still require an actual contrasting proposition;
- final trim logs pre-trim, post-trim, newly introduced and final coherence findings separately;
- every compaction rejection logs the exact failed gate, section, safe diagnostic and rollback result;
- rejected candidates restore complete canonical state;
- in-flight concurrent siblings settle before failure escapes and no new task starts after a failure;
- the route refuses to start persistence unless `ArticleDocument`, rendered cache and the exact generated payload agree;
- generated slug/excerpt/FAQ now come from the final pipeline state rather than stale assembly inputs.

No version 18 was created by the failed run. No live run was performed during this audit.

# 7. Immediate next task

Run one controlled production English generation using this exact package. Do not make further architecture changes before seeing that result.

Verify from one log:

- `preTrimCoherenceViolations`, `postTrimCoherenceViolations`, `newTrimIntroducedViolations` and `finalCoherenceViolations` are present;
- any compaction rejection has an exact `reason=...` and `rollback=success`;
- final canonical agreement and final policy pass before `getNextVersionNumber`/save;
- version 18 is created only after all generation tasks have settled;
- saved HTML, title, slug, meta, excerpt and FAQ match the final canonical document.

If version 18 saves and the saved article is structurally normal, freeze English generation and continue Traditional Chinese localisation parity. Preserve model routing, thinking configuration, token budgets, broad retry budgets, SEO thresholds, translation workflow, persistence semantics and shadow-editorial semantics.

# 8. English freeze rule

The English pipeline has been under repair for weeks. Do not keep moving the finish line.

Once one new production generation:

- completes
- passes final deterministic QC
- saves successfully
- has no obvious broken prose or markup
- has correct FAQ/schema/CTA/link structure

treat English as stable enough for production.

Do not redesign English because of ordinary editorial imperfections.

Only reopen it for a new reproducible hard defect.

# 9. Translation/localisation is the next major milestone

The user explicitly wants Traditional Chinese translation working **in harmony with the English blog pipeline**.

Translation is **not yet declared complete**.

Intended architecture:

**Final canonical English `ArticleDocument` → immutable translation source → Traditional Chinese localisation → translation-specific QC → save**

Do not translate from stale rendered HTML or an intermediate English stage.

The English source must remain unchanged.

Once version 18 saves, use version 18 as the primary immutable translation fixture instead of version 17.

## 10. Traditional Chinese requirements

### Structure

Preserve:

- section order
- H2/H3 hierarchy
- paragraph/list/quote structure unless an approved localisation transformation applies
- WordPress block validity
- internal-link destinations
- external/source-link destinations
- canonical CTA structure
- exact signup URL
- FAQ order/count
- FAQ schema parity
- language switcher structure

### Meaning / factual parity

Preserve:

- names
- numbers
- dates
- percentages
- attributions
- factual claims
- uncertainty/modality
- comparative strength
- claim ownership
- source-to-section relevance

Chinese must not invent facts, omit supported facts, strengthen claims, weaken important qualifications or move evidence to unrelated sections.

### Hong Kong localisation quality

Detect/repair:

- literal English syntax
- calques
- awkward translated connectors
- repeated pronouns
- Mainland-oriented wording where natural Hong Kong wording is expected
- Simplified Chinese
- accidental untranslated English prose
- inconsistent terminology
- overly formal written Chinese when brand voice should be natural/conversational
- awkward literal translations of marketing idioms

### Full-document Chinese review

Review the complete translated article with full context.

Targeted repairs must:

- edit only translatable text
- never mutate protected WordPress markup
- never alter link destinations
- never mutate CTA structure
- regenerate schema from canonical translated FAQ rather than directly patching schema
- use clone-and-commit
- restore the complete Chinese snapshot on rejection
- rerun structural/factual/parity checks after accepted patches

### Final Chinese save boundary

Immediately before save:

1. render from final canonical Chinese `ArticleDocument`
2. confirm rendered-cache equality
3. validate WordPress integrity
4. validate English↔Chinese semantic parity
5. validate Traditional Chinese consistency
6. detect Simplified Chinese / material untranslated English
7. run Hong Kong localisation and calque checks
8. validate factual strength and claim ownership parity
9. validate source links and section relevance
10. validate FAQ/schema parity
11. validate canonical CTA
12. run malformed-prose/coherence checks
13. confirm English source remains byte-for-byte unchanged

Any hard failure must create zero Chinese DB writes.

# 11. Key recent files

Major new/support modules:

- `src/lib/blog/coherence.ts`
- `src/lib/blog/source-boilerplate.ts`
- `src/lib/blog/sentence-quality.ts`
- `src/lib/blog/content-relevance.ts`

Major modified files:

- `src/lib/blog/factual-risk-scanner.ts`
- `src/lib/blog/final-seo-normalizer.ts`
- `src/lib/blog/final-article-policy.ts`
- `src/lib/blog/post-ownership-seo-reconcile.ts`
- `src/lib/blog/publication-quality.ts`
- `src/lib/services/text-utils.ts`
- `src/lib/services/article-postprocessors.ts`
- `src/lib/pipeline/blog-generation-pipeline.ts`
- `src/lib/services/blog-generation-service.ts`
- `src/lib/seo-auditor.ts`
- `src/app/api/projects/[id]/seo/audit/route.ts`
- `src/app/api/generate-blog/route.test.ts`

Regression fixtures/tests:

- `fixtures/blog-13-v15.json`
- `fixtures/blog-13-v16.json`
- `fixtures/blog-13-v17.json`
- `src/lib/pipeline/publication-quality-regression.test.ts`
- `src/lib/pipeline/publication-quality-v16-regression.test.ts`
- `src/lib/pipeline/publication-quality-v17-regression.test.ts`
- `src/lib/pipeline/final-trim-fallback.test.ts`

Treat fixtures as read-only regression evidence.

# 12. Invariants not to casually change

Recent fixes intentionally did not change:

- model routing
- normal thinking settings
- token budgets
- general retry budgets
- translation workflow
- SEO thresholds
- claim-ownership policy values
- persistence semantics
- shadow-editorial meaning

Preserve them unless a new proven root cause requires otherwise.

# 13. What the next chat should do

1. Read `FINAL_AUDIT_REPORT_2026-08-07.md` and preserve every listed invariant.
2. Deploy/load this audited package without changing feature-flag meaning or model configuration.
3. Generate one fresh English article for project 13.
4. Expected next saved version: **18**.
5. Inspect the new final-trim/compaction/pre-save diagnostics.
6. If version 18 saves and final QC is clean, freeze English.
7. Immediately move to Traditional Chinese localisation parity using version 18 as immutable source.

The goal is no longer endless English perfection. The goal is a stable English → Traditional Chinese production system.

# 14. How to classify future issues

## A. Hard pipeline defect — fix in code

Examples:

- malformed WordPress structure
- deterministic prose corruption
- unknown schema block causing abort
- missing/duplicated FAQ/schema
- broken protected links/CTA
- unsupported factual claim passing a hard gate
- translation meaning drift
- save occurring after deterministic hard failure

## B. Recoverable generation variance — use existing repair/fallback

Examples:

- model emits a safe alias for an allowed block type
- one section is too long
- one bounded retry is needed
- a section needs bounded compaction

## C. Normal editorial imperfection — do not redesign

Examples:

- a sentence could be more elegant
- a heading is acceptable but not perfect
- a reasonable marketing line could be phrased better
- a human editor might make a tiny stylistic tweak

Do not treat category C as another architecture emergency.

# 15. Latest known verification baseline

See `FINAL_AUDIT_REPORT_2026-08-07.md` for the final packaged verification counts and remaining risks. The generic `"heading"` alias and contextual final-trim failures are both resolved in this package. The immediate next action is a controlled live generation, not another speculative English-pipeline redesign.
