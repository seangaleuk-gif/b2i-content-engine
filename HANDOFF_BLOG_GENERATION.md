# B2I Content Engine — Blog Generation Handoff
**Date:** 8 August 2026
**Project:** B2I Content Engine
**Scope:** English blog-generation pipeline only

## 1. Current status

The English blog-generation pipeline has successfully completed a full production generation and saved:

- Project 13
- Version 18
- DB id 231
- Canonical word count: 2,829
- FAQ parity: 6 / 6 / 6
- Final QC: clean
- Shadow editorial: 0 findings / 0 unresolved
- No final-trim/coherence failure

The previous Section 5 generic `heading` schema blocker is fixed.

The only remaining proven English issue is narrow:

- v18 has no normal editorial H2 containing the exact focus keyphrase `Hong Kong Marketing Trends 2026`
- the only H2 containing that exact phrase is the FAQ heading
- the v18 production log also lacked the expected `post-ownership-seo-reconcile` entry

That is the next and final English fix before freezing the generator.

## 2. Deep audit/root-fix checkpoint completed before v18

Before the successful v18 run, a full production-grade English pipeline audit/root-fix pass was completed.

Main fixes from that audit:

1. Duplicate H2 detection and repair before section drafting.
2. Safe outline fallbacks without repeated `Hong Kong`.
3. Prevention of late SEO stages recreating invalid headings.
4. Source-relevance repair moved before expansion and word-count gates.
5. External-link insertion now requires both body relevance and owning-H2 relevance.
6. Immutable outline-owned FAQ heading and bounded FAQ repair.
7. Escaped, round-trip-safe canonical H2 rendering.
8. Safe canonical slug and language-switcher URL generation.
9. Plain-text outline metadata and content-free JSON diagnostics.
10. Protection against false positives in legitimate comparative headings.
11. Fail-closed validation of non-object outline responses.
12. FAQ CTA checks across both questions and answers.
13. Correct post-insertion external-link diagnostics.

Verification from that audit:

- English generation/pipeline/route tests: 1,044 / 1,044 passed
- Translation/acceptance/route tests: 495 / 495 passed
- Total: 1,539 passed / 0 failed
- TypeScript: passed
- Production build: passed
- Lint: 444 existing findings
- No quality threshold was weakened
- Staged English generator remained intact
- Canonical `ArticleDocument` architecture remained intact

## 3. Core English architecture

Stack:

- Next.js 16.2.10
- TypeScript
- Supabase
- DeepSeek API
- Production English model: `deepseek-v4-flash`
- Thinking disabled for normal generation stages shown in logs
- WordPress block output
- Canonical internal representation: `ArticleDocument`

High-level generation flow:

1. Research handoff
2. Outline
3. Introduction
4. Section-by-section drafting
5. Per-section repair where needed
6. FAQ
7. Conclusion
8. Canonical `ArticleDocument` assembly
9. Title/meta repair
10. SEO normalization
11. Factual scanning
12. Claim ownership enforcement
13. Malformed-prose repair
14. Internal-link insertion
15. External-link insertion
16. Link enforcement
17. Post-ownership SEO reconciliation
18. Canonical CTA restoration
19. Final trim / bounded compaction fallback
20. FAQ/schema recovery
21. Canonical word-count check
22. Final preflight
23. Final canonical QC
24. Full-document shadow editorial diagnosis
25. Pre-save policy
26. Version persistence
27. SEO audit

Shadow editorial remains diagnosis-only.

## 4. Saved versions / regression history

For project/blog ID 13:

- v15 — DB id 228
- v16 — DB id 229
- v17 — DB id 230
- v18 — DB id 231

Do not overwrite or mutate these saved versions.

Versions 15–17 were used as regression evidence.

Version 18 is the latest successfully saved English production version.

## 5. Major English repairs completed

### A. Destructive final trimming

Earlier trim logic deleted arbitrary sentences and paragraphs, causing:

- unfinished examples
- orphan transitions
- lost supporting explanations
- truncated quotations

This was replaced with structure-aware compression.

Important file:

- `src/lib/blog/coherence.ts`

Current behavior:

- respects section boundaries
- protects examples, setup sentences, transitions, evidence, links and protected content
- enforces section word floors
- validates coherence after mutation
- treats incomplete sentences, orphan transitions, dangling references and thin/empty sections as hard failures

### B. Final-trim rollback and targeted compaction

Current final-trim fallback:

1. snapshot complete pre-trim state
2. run deterministic compression
3. validate coherence
4. restore complete snapshot if unsafe
5. identify only affected sections
6. compact only those sections
7. validate candidate before commit
8. restore candidate snapshot on rejection
9. unresolved failure remains a hard zero-write failure

Compaction acceptance checks include:

- shorter than source
- minimum section word floor
- final canonical word-count range
- link equivalence
- claim equivalence
- claim ownership
- unsupported-claim check
- quote integrity
- coherence
- source relevance
- WordPress integrity

Quotes must be preserved verbatim or removed as a complete unit.

### C. Pre/post trim coherence baseline

The final-trim path now records:

- `preTrimCoherenceViolations`
- `postTrimCoherenceViolations`
- `newTrimIntroducedViolations`

This distinguishes defects already present before trimming from defects actually introduced by trimming.

In v18:

```text
[final-trim] preTrimCoherenceViolations=[]
[final-trim] skipped (wc=2829 <= 2875)
[final-trim] postTrimCoherenceViolations=[]
[final-trim] newTrimIntroducedViolations=[]
```

So v18 had no final-trim coherence issue.

### D. Contextual orphan-transition detection

Earlier, normal text such as:

`So, what does this mean for your business?`

could be falsely classified as orphaned.

The validator was improved so transition words are not judged only by regex/trigger word.

Examples checked contextually include:

- So
- Instead
- However
- Therefore
- But
- Yet
- As a result

A transition only fails when the surrounding substantive context genuinely lacks the antecedent/contrast/reason it depends on.

Genuinely orphaned transitions still fail.

### E. Source boilerplate protection

Publisher/legal/footer text had previously entered generated articles.

Important file:

- `src/lib/blog/source-boilerplate.ts`

Current detection includes:

- legal disclaimers
- opinion notices
- privacy/cookie/terms notices
- navigation/footer junk
- liability notices
- copyright notices
- ownership statements
- reproduction notices

Remaining source boilerplate is a hard final-QC failure.

### F. Factual-risk / claim-strength validation

Important file:

- `src/lib/blog/factual-risk-scanner.ts`

The system now evaluates claims independently at clause level.

Evidence matching considers:

- subject
- outcome
- population
- timeframe
- modality
- certainty
- comparative/absolute strength

A weak supported source claim cannot support a stronger neighboring statement.

Important claim types include:

- market-wide assertions
- universal claims
- absolute outcomes
- causal claims
- performance claims
- message-volume claims
- `rock bottom` style claims

Unsupported stronger claims must be removed, safely weakened without adding facts, or block saving.

### G. Claim ownership and dependent prose

Earlier ownership cleanup could remove a fact but leave dependent sentences such as:

`That's a striking number, and it makes sense.`

Claim removal is now dependency-aware across neighboring paragraphs and source-citation boundaries.

Dependent text is removed/repaired with the owned claim when necessary.

### H. SEO keyphrase corruption

The old SEO normalizer performed unsafe phrase substitution and produced malformed English such as:

- `the this shift landscape`
- `these these 2026 trends`
- `the the changing Hong Kong market`

Important file:

- `src/lib/blog/final-seo-normalizer.ts`

That substitution behavior was removed.

Keyphrase reduction is now sentence-aware and rollback-protected.

Important file:

- `src/lib/blog/sentence-quality.ts`

Checks include:

- duplicate determiners
- repeated adjacent words
- lowercase sentence starts
- broken punctuation
- malformed noun phrases
- fragments

### I. Source-to-section relevance

Important file:

- `src/lib/blog/content-relevance.ts`

External/source links must be relevant to:

- the passage/body content
- the owning H2

Links are no longer inserted simply to satisfy quota.

An earlier section/H2 off-by-one mapping bug was fixed.

In v18:

- 6 external links were requested
- only 4 were inserted
- 2 were safely skipped

This is intended behavior.

### J. Generic `heading` schema blocker

A previous production generation failed because DeepSeek returned:

```json
{"type":"heading"}
```

inside a repaired section.

Root cause:

`normalizeAiEditorialPayload` in:

- `src/lib/blog/article-content.ts`

only accepted canonical editorial block types.

Fix:

- `heading` is now a bounded safe alias
- implicit heading → canonical H3 `subheading`
- explicit level 3 → canonical H3 `subheading`
- explicit level 2 remains rejected
- unsupported levels remain rejected
- empty headings remain rejected

Regression coverage proves:

- safe generic heading succeeds
- explicit H3 succeeds
- explicit H2 fails
- unsupported level fails
- empty heading fails
- full generation repair path accepts only safe aliasing

Verification after this fix:

- 2,249 tests passed / 0 failed
- 81 test files
- `tsc --noEmit`: clean
- production build: passes
- no new lint findings

## 6. Version 18 production run

The latest production run successfully reached persistence.

Important final stages:

```text
[SEO-NORMALIZER] before metrics=wc:3029 kp:17 h2:false paras>3:4 flesch:62
[SEO-NORMALIZER] keyphrase removals=9 from paragraphs
[SEO-NORMALIZER] paragraphs split=4
[SEO-NORMALIZER] after metrics=wc:2840 kp:8 h2:false paras>3:0 flesch:62
```

Factual scanning removed unsupported statements safely.

Claim ownership completed.

External-link injection retained four relevant external sources.

CTA was restored canonically.

Final trim:

```text
[final-trim] preTrimCoherenceViolations=[]
[final-trim] skipped (wc=2829 <= 2875)
[final-trim] postTrimCoherenceViolations=[]
[final-trim] newTrimIntroducedViolations=[]
```

FAQ/schema:

```text
[faq-recovery] regenerated schema from 6 protected FAQ entries
```

Word count:

```text
[wc-check] canonical word count=2829 range=2125-2875
```

Final preflight:

```text
[final-preflight] deterministic malformed repair repaired=0 removed=2 unresolved=0
```

FAQ parity:

```text
[final-preflight] FAQ parity valid=true canonical=6 rendered=6 schema=6
```

Final QC:

```text
[final-qc-scan] clean coherence=0 malformed=0 sentenceQuality=0 boilerplate=0 relevance=0 headings=0 unsupported=0
```

Shadow editorial:

```text
findings=0
selected=0
acceptedPatches=0
rejectedPatches=0
unresolved=0
status=shadow
```

Save:

```text
[blog-versions] getNextVersionNumber for project 13:
existing=[10,11,12,13,14,15,16,17]
max=17
next=18
```

Then:

```text
[blog-versions] created: id=231 version_number=18
```

So the English pipeline is now proven capable of completing end to end.

## 7. CURRENT ISSUE — exact focus keyphrase missing from editorial H2

This is the only remaining proven English issue.

The focus keyphrase is:

`Hong Kong Marketing Trends 2026`

The SEO normalizer explicitly reported:

```text
h2:false
```

both before and after normalization.

The saved v18 article does not contain the exact keyphrase inside any normal editorial H2.

The only H2 containing the exact phrase is the FAQ heading:

`Frequently Asked Questions About Hong Kong Marketing Trends 2026`

The FAQ H2 must NOT count toward the editorial-H2 SEO requirement.

Also, the expected production log line:

```text
[post-ownership-seo-reconcile]
```

was absent from the v18 run.

This must be traced rather than patched with a second parallel workaround.

Investigate whether the reconciliation stage:

1. did not execute
2. executed but did not log
3. ran and later had its heading overwritten
4. incorrectly counted the FAQ H2
5. used stale metrics and returned early

Final required invariant:

Before persistence, at least one normal editorial H2 must contain the exact focus keyphrase.

Excluded headings:

- FAQ
- CTA
- protected/non-editorial headings

The result must remain natural.

Good example:

`Hong Kong Marketing Trends 2026: The State of Digital Marketing`

Bad example:

`The State of Digital Marketing in Hong Kong for 2026: Hong Kong Marketing Trends 2026`

## 8. Recommended next coder task

Perform one focused repair only.

Do not reopen the broad English audit.

Required work:

1. trace the actual production execution of `post-ownership-seo-reconcile`
2. identify exactly why v18 reached persistence with `h2:false`
3. repair the existing reconciliation path rather than adding a duplicate system
4. add a final deterministic save-boundary check for a qualifying editorial H2
5. exclude FAQ/CTA/protected headings
6. preserve natural heading construction
7. rerun relevant validations after any heading mutation
8. add regressions proving a later stage cannot remove the qualifying H2 unnoticed
9. keep persistence blocked if the requirement cannot be repaired safely

Do not change:

- model routing
- thinking settings
- token budgets
- broad retry budgets
- SEO thresholds
- factual scanning
- claim ownership
- trimming/compaction
- persistence semantics
- shadow-editorial semantics

Use:

- Code mode
- High thinking

## 9. English freeze rule

Once the exact-keyphrase editorial-H2 guarantee is fixed and verified:

**FREEZE ENGLISH GENERATION.**

Do not perform another broad audit.

Do not redesign the pipeline for ordinary editorial imperfections.

Only reopen English later for a reproducible hard defect such as:

- structural corruption
- factual-validation bypass
- broken WordPress markup
- broken protected CTA/link
- deterministic prose corruption
- incorrect persistence behavior
- a genuine production-blocking regression

The goal is now to finish the production workflow rather than chase theoretical perfection.

## 10. Important files

Recent core files include:

- `src/lib/blog/article-content.ts`
- `src/lib/blog/coherence.ts`
- `src/lib/blog/source-boilerplate.ts`
- `src/lib/blog/sentence-quality.ts`
- `src/lib/blog/content-relevance.ts`
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

Important regression tests/fixtures include:

- `fixtures/blog-13-v15.json`
- `fixtures/blog-13-v16.json`
- `fixtures/blog-13-v17.json`
- `src/lib/pipeline/publication-quality-regression.test.ts`
- `src/lib/pipeline/publication-quality-v16-regression.test.ts`
- `src/lib/pipeline/publication-quality-v17-regression.test.ts`
- `src/lib/pipeline/final-trim-fallback.test.ts`
- `src/lib/blog/article-content.test.ts`
- `src/lib/services/blog-generation-service.test.ts`

Treat saved versions/regression fixtures as read-only.

## 11. Invariants that should not be casually changed

Preserve unless a new proven root cause requires otherwise:

- staged generation architecture
- canonical `ArticleDocument`
- model routing
- normal thinking configuration
- token budgets
- broad retry budgets
- SEO thresholds
- claim-ownership policy
- factual-validation model
- final-trim rollback semantics
- zero-write hard-failure behavior
- persistence semantics
- shadow editorial as diagnosis-only

## 12. Next acceptance point

The English pipeline should be considered finished when:

1. the exact focus keyphrase is guaranteed in at least one normal editorial H2
2. FAQ/CTA headings cannot satisfy that requirement
3. final QC remains clean
4. all regression tests remain green
5. `tsc --noEmit` passes
6. production build passes
7. one final controlled production run confirms the fix

After that:

**Stop English pipeline work.**
