# Editorial Scanner & Fact-Free Fallback Fix

**Baseline:** v3.3 English Regression Fix  
**Patch:** v3.4  
**Date:** 2026-07-31

## Production failure addressed

The English article reached final validation with an editorial score of 75 after:

1. The factual scanner misclassified quoted example questions as `testimonial_quote` claims and removed them.
2. The broad editorial candidate changed protected numbers and was correctly rejected.
3. The weaker pre-editorial article continued directly to final validation with no safe prose-only fallback.

The soft `no H2 keyphrase` warning was not a cause of failure.

## Changes

### 1. Illustrative quotation classification

Quotation marks alone no longer create a testimonial claim. Generic quoted text is scanned only when its sentence explicitly attributes the words to a speaker or research source.

The following now remain ordinary editorial examples:

- `“Do you agree?”`
- `“Agree or disagree?”`
- `“What’s your biggest frustration with [topic] right now?”`
- Suggested prompts, calls to action, templates and hypothetical dialogue

Explicitly attributed quotations such as `A customer said, “...”` remain subject to strict evidence and source-link validation.

### 2. Cleanup continuity ownership

Factual cleanup and claim-ownership cleanup now report which canonical components actually lost sentences. Only fact-free blocks in those affected components can enter the targeted continuity pass.

The pass is limited to abrupt or isolated prose such as:

- very short paragraphs,
- dangling transition openings,
- setup-only lines,
- lead-ins weakened by deterministic sentence removal.

### 3. Fact-free editorial fallback

When the general editor is rejected for changing protected facts, or when the article remains below the editorial threshold, the pipeline performs a final targeted pass limited to blocks with:

- no numbers, percentages, dates, currencies or times,
- no links,
- no factual attribution,
- no approved or unsupported factual-scanner claim,
- no scanner-protected sentence.

The fallback may improve only repetition, robotic wording, transitions, choppy prose and non-factual practical depth.

### 4. Comparative acceptance

A prose-only fallback is accepted only when:

- editorial score reaches the configured production minimum,
- repetition does not regress,
- factual reliability does not regress,
- no new unsupported claim appears,
- claim ownership remains valid,
- numeric facts and URLs are unchanged,
- malformed prose, structure and word-count constraints remain valid.

### 5. Atomic editorial transaction

The combined editorial transaction is committed only when its final article reaches the production editorial threshold. If the safe fallback cannot reach the threshold, no partial AI editorial edits are committed.

## Files changed

- `src/lib/blog/factual-risk-scanner.ts`
- `src/lib/blog/factual-risk-scanner.test.ts`
- `src/lib/blog/claim-ownership.ts`
- `src/lib/blog/claim-ownership.test.ts`
- `src/lib/pipeline/editorial-polish.ts`
- `src/lib/pipeline/editorial-polish.test.ts`
- `src/lib/pipeline/blog-generation-pipeline.ts`

## Verification performed in this environment

- Repository TypeScript/TSX syntax transpilation: 186 files, 0 errors
- Changed production semantic TypeScript audit with external dependency declarations: 0 diagnostics
- Changed regression-test semantic audit: 0 diagnostics
- Repository AST duplicate-property/declaration audit: 0 findings
- Runtime illustrative-quote classification checks: passed
- Runtime attributed-quotation classification check: passed
- Runtime fact-free block selection check: passed
- Runtime affected-component continuity selection check: passed

## Local verification required

The supplied project does not include installed dependencies. `npm ci` could not complete in this environment because the configured package mirror returns 404 for `zod-validation-error@4.0.2`. Run on the development laptop:

```bash
rm -rf node_modules .next
npm ci
npm test
npm run lint
npm run build
```

Then run one real English generation using the same Threads project and confirm:

- quoted example prompts are retained,
- unsupported factual claims are removed,
- broad numeric-changing editorial candidates are rejected,
- `editorial-prose-only-fallback` runs when the score remains below 80,
- final editorial score is at least 80,
- factual score remains 100,
- no numeric claim changes,
- final validation passes before translation is tested.
