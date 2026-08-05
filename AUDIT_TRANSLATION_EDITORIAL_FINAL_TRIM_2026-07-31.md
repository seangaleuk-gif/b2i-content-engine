# B2I Content Engine Repair Audit — 31 July 2026

## Scope

This repair addresses the three supplied production failure patterns while keeping the stable English generation architecture isolated:

1. Traditional Chinese translation rejected after 36 successful API calls.
2. English generation failed final validation at 2,893 words against a 2,875-word maximum.
3. English generation failed because editorial quality remained 78/100 against the unchanged 80-point minimum.

No database, persistence, concurrency, SEO threshold, factual-scanner threshold, DeepSeek thinking implementation, retry architecture, or English generation prompt was changed.

## Failure 1 — Traditional Chinese translation rejection

### Proven causes

- **Genuine English leakage:** at least one section remained substantially English after the initial HTML translation and both repair attempts. The existing fail-closed behavior correctly prevented that candidate from being saved.
- **Over-broad named-entity detection:** every capitalised phrase found in research titles could be treated as immutable. Ordinary words such as `Need`, `Audience`, `Which`, `Mouth`, `Marketers`, and `Is Threads` were therefore misclassified as protected names.
- **Representation mismatch in number validation:** final component parity rechecked numbers through rendered WordPress HTML instead of the canonical `EditorialBlock[]` used by the translation pipeline. This created a second, inconsistent source of number-parity decisions.
- **Heading calls used unassigned stage labels:** thinking still defaulted safely to disabled, but the labels produced avoidable “no thinking mode assigned” warnings.

### Repair

- Added a **structure-first JSON recovery path** after failed HTML translation/repair. The model may change text fields only; the application retains block structure, links, order, and number placeholders.
- The recovery path validates JSON shape, stable editorial structure, placeholders, exact numbers, URL sequence, Chinese completeness, English leakage, and conclusion rules before acceptance.
- Recovery also runs when the original provider call or HTML candidate parsing throws.
- Restricted research-derived protected names to application-owned brands and publisher names that can be tied directly to the research URL/hostname.
- Moved body-component number parity to canonical `EditorialBlock[]` comparison. Metadata, headings, FAQ, CTA, and schema retain their appropriate boundary checks.
- Translation heading and structured-recovery stage labels now use the existing `translate-` prefix, so routine thinking mode is explicitly resolved as disabled without changing the thinking-mode implementation.

### Expected behavior now

A provider can still occasionally return unusable translation. That external variability cannot be eliminated. The pipeline now has an independent, structure-safe recovery route and no longer rejects valid Chinese because ordinary title words were mistaken for brands. If all guarded attempts remain invalid, translation still fails closed and the English article remains untouched.

## Failure 2 — Final word count 2,893 / 2,875

### Proven cause

The existing trim removed 14 words but could not find another whole removable paragraph under its safety rules. It then stopped 18 words above the hard maximum, so final validation correctly rejected the article.

### Repair

Added a bounded residual trim immediately after the existing trim:

- first removes one complete trailing sentence from a safe, fact-free plain paragraph;
- if still required, removes one complete safe paragraph;
- never slices words or leaves sentence fragments;
- never edits the introduction, conclusion, FAQ, CTA, schema, or language switcher;
- rejects paragraphs containing links, numbers, currencies, years, detected claims, attribution language, or the exact focus keyphrase;
- respects the minimum word count and minimum useful section size.

### Expected behavior now

Small residual overruns such as the supplied 18-word excess should normally close automatically. A generation may still fail word count when no fact-free/keyphrase-free prose can be removed safely. That is intentional fail-closed behavior, not a random failure.

## Failure 3 — Editorial score 78 / 80

### Proven cause

The log shows targeted malformed/repetition repairs persisted and malformed prose reached zero, but broader editorial candidates were rejected for `numeric facts changed`. The candidate path already protects numeric expressions and factual sentences at stable block level. A second article-wide comparison used raw rendered HTML, creating a contradictory validation path that could reject a fact-safe candidate before it had a chance to reach the 80-point gate.

### Repair

- Replaced the raw rendered-HTML numeric comparison with a canonical numeric signature bound to each stable component ID and block ID.
- Exact numeric expressions, suffixes, currencies, percentages, and dates must remain in the same stable paragraph.
- A number cannot be changed, added, removed, or moved between blocks.
- Added explicit editorial score-breakdown diagnostics for malformed prose, repeated idea pairs, robotic phrases, conclusion ratio, and conclusion penalty.
- The minimum editorial score remains **80**.

### Expected behavior now

The specific false rejection is avoidable and has been repaired. A genuinely weak article can still finish below 80 when no guarded candidate safely improves it. In that case, final validation should continue to reject it rather than lowering the standard.

## Files changed

- `src/lib/services/translation-ai.ts`
- `src/lib/services/editorial-block-translation.ts`
- `src/lib/services/editorial-block-translation.test.ts`
- `src/lib/services/translation-service.ts`
- `src/lib/services/translation-service.test.ts`
- `src/lib/pipeline/editorial-polish.ts`
- `src/lib/pipeline/editorial-polish.test.ts`
- `src/lib/pipeline/blog-generation-pipeline.ts`
- `src/lib/pipeline/blog-generation-pipeline.test.ts`

## Verification performed in this workspace

### Passed

- TypeScript syntax transpilation for all nine changed source/test files.
- Targeted semantic TypeScript check across the changed modules and imported internal dependencies.
- Targeted runtime harness:
  1. structure-first fallback recovers an English HTML echo;
  2. structure-first fallback recovers a provider exception;
  3. ordinary capitalised title words do not cause false named-entity rejection, including a translated H2;
  4. residual trim closes a small overrun while preserving CTA and focus-keyphrase prose;
  5. a real numeric fact change remains rejected;
  6. equal numeric sets cannot move between stable blocks.
- Mocked DeepSeek request check confirms translation headings and structured recovery resolve `thinking=disabled` with zero reasoning tokens.

### Could not run here

`npm ci` is blocked by the workspace package mirror returning HTTP 404 for `zod-validation-error@4.0.2`. Because dependencies could not be installed, the following commands could not start:

- `npm run lint` — `eslint: not found`
- `npm test` — `vitest: not found`
- `npm run build` — `next: not found`

This is an environment/dependency-install limitation, not a passing result. Full lint, Vitest, TypeScript, build, and real DeepSeek generation/translation must be run in the normal project environment before production acceptance.

## Required local acceptance run

```bash
npm ci
npm run lint
npm test
npx tsc --noEmit
npm run build
```

Then run, in order:

1. one new English topic through full generation and final validation;
2. Traditional Chinese translation of a known-good English version;
3. audit FAQ parity, headings, body completeness, numbers, entities, CTA, schema, switcher, SEO, persistence, and readback;
4. Traditional Chinese is the only translation target. Simplified Chinese is out of scope.

Do not describe translation as production-stable until that real Traditional Chinese run passes.
