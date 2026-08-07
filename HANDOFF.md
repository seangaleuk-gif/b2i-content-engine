# B2I Content Engine — Handoff
**Date:** 7 August 2026  
**Project:** B2I Content Engine  
**Purpose:** Continue the English-generation stabilization work, then bring the Traditional Chinese translation pipeline into full parity without reopening already-fixed English architecture.

## 1. Current state

The English blog-generation pipeline has been heavily repaired and is now much safer than the earlier versions. Versions 15, 16 and 17 are preserved as read-only regression fixtures. Version 17 is the latest successfully saved English version for project/blog 13 (`version_number=17`, DB record `id=230`).

A new attempt that should have become version 18 did **not** save. It failed earlier during Section 5 repair because DeepSeek returned an unsupported block type `"heading"`. That is the current English blocker.

Once that narrow schema/retry issue is fixed and one clean new English version saves, the English pipeline should be frozen and work should move to Traditional Chinese translation parity.

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

Latest completed verification before the current runtime failure:

- 2,242 tests passed
- 0 failed
- 81 test files
- `tsc --noEmit`: clean
- `next build`: passes
- lint baseline: 450 findings (271 errors / 179 warnings)
- new/changed files reported lint-clean
- no changes to model routing, thinking, token budgets, general retry budgets, SEO thresholds, translation workflow, persistence semantics or shadow-mode meaning

# 6. CURRENT BLOCKER — latest production attempt

A fresh English generation was started after the fallback repair.

It failed **before final trim and final QC** during Section 5 repair.

Section:

`Budgeting for 2026: Where to Invest Your Marketing Dollars`

Exact failure:

```text
[generate-blog:POST] Internal server error
[AppError INTERNAL_ERROR] Error: Section 5 ("Budgeting for 2026: Where to Invest Your Marketing Dollars"): generation failed after retry — Block 2: unknown or missing block type "heading"
```

The Section 5 repair response contained:

```json
{
  "type": "heading"
}
```

The section schema does not accept generic `"heading"` there, so validation rejected the repaired section and aborted generation.

The conclusion request had already been launched concurrently, so it completed after the fatal Section 5 error. Its result was not used.

### Important

This was **not random** and it was **not the final-trim/coherence bug returning**.

The current blocker is a narrow section-repair schema/retry robustness problem.

No version 18 was saved.

Project 13 still ends at:

- version 17
- DB record 230

# 7. Immediate next task

Fix only the Section 5 repair-schema issue.

Desired behavior:

- if DeepSeek returns a clearly legitimate section-internal heading using generic `"heading"`, normalize it to the canonical supported H3/subheading representation only when unambiguous and safe
- otherwise reject and use a bounded schema-correction retry with the exact allowed block types
- never silently accept unknown block types
- never crash the entire generation for a recoverable block-type alias
- keep the hard failure if the corrected response remains invalid

Add regression coverage for:

- repair response contains `"type": "heading"`
- valid H3-like heading is safely normalized or schema-corrected
- unknown/unsafe block types remain rejected
- WordPress rendering remains correct
- section facts, links and ownership remain unchanged
- failed repair still produces zero DB writes

Do not change:

- model routing
- thinking configuration
- token budgets
- broad retry budgets
- SEO thresholds
- translation workflow
- persistence semantics
- shadow editorial semantics

Recommended mode:

- **Code mode**
- **High thinking**

Then run one new English generation.

If it successfully saves version 18 and the saved article is structurally normal, freeze English generation.

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

1. Fix the exact Section 5 schema failure:
   `Block 2: unknown or missing block type "heading"`
2. Audit the allowed section block schema and repair normalization/retry path.
3. Make the smallest safe fix.
4. Run focused regression tests.
5. Run complete test suite.
6. Run `tsc --noEmit`.
7. Lint changed/new files.
8. Run production build.
9. Generate one fresh English article for project 13.
10. Expected next saved version: **18**.
11. If version 18 saves and final QC is clean, freeze English.
12. Immediately move to Traditional Chinese localisation parity using version 18 as immutable source.

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

Before the current Section 5 runtime failure:

- **2,242 tests passed**
- **0 failed**
- **81 test files**
- `tsc --noEmit`: clean
- `next build`: passes
- lint baseline: **450 findings**
  - 271 errors
  - 179 warnings
- new/changed files reported lint-clean

The latest production attempt then failed before save on the unsupported `"heading"` block. That is the immediate next issue.
