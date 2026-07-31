# B2I Content Engine — Translation and Temporal Freshness Audit

**Audit date:** 30 July 2026  
**Scope:** English temporal correctness, Hong Kong Traditional Chinese generation, metadata recovery, FAQ/CTA handling, SEO audit pairing, canonical rendering and bilingual persistence.

## Production failures addressed

### 1. Expired future wording in a current article

A 2026 English article contained wording such as:

> Advertising features expected to expand later in 2025.

The statement was not necessarily invented, but its predictive tense had expired. It was being presented as current guidance rather than as a historical forecast.

### 2. Translation stopped before the body

The translation log showed this sequence:

1. The initial Chinese metadata request returned empty model choices twice.
2. A later attempt returned a short title.
3. The preferred title-length check triggered another provider call.
4. All retries for that metadata-only repair returned empty choices.
5. The metadata exception aborted the whole translation before article blocks were processed.

The same run logged `enFaqCount=0` even though the English article visibly contained FAQ entries.

## Implemented temporal-freshness gate

English generation now receives an explicit generation date. The pipeline then runs a deterministic temporal stage after factual and claim-ownership cleanup and before malformed-prose repair.

The gate distinguishes:

- Valid historical facts: `Awareness increased to 66% by Q1 2025.`
- Explicitly historical forecasts: `At the time, advertising features were expected to expand later in 2025.`
- Expired predictions: `Advertising features are expected to expand later in 2025.`
- Unanchored relative wording: `later this year`, `coming soon`, `今年稍後`, `即將推出`.
- Valid current status with a historical launch date: `Threads ads launched in 2025 and are currently available.`

Safe stale sentences are removed before editorial polish. Anything that cannot be removed without risking links or structure remains a hard failure at final validation. The same English and Chinese temporal checks run on translated metadata and rendered Chinese content.

## Professional translation architecture

The repaired path follows a source-first publishing workflow rather than treating translation as one large free-form model call.

### Canonical document first

- A source preflight rejects stale English temporal wording before any translation API calls are spent.
- The saved English HTML is reconstructed into the canonical `ArticleDocument`.
- Introduction, sections, FAQ, conclusion and CTA keep their original order and ownership.
- Chinese HTML is always rendered from the returned Chinese `ArticleDocument`; regex-mutated HTML cannot be saved.

### Block-level semantic translation

- Each editorial component is translated completely with surrounding-section context.
- Translation instructions prioritize meaning, intent and emphasis over literal English word order.
- A conservative Hong Kong glossary keeps terms such as creator, SME, organic reach, campaign, engagement and CTA consistent.
- Brand/platform names, numbers, dates, sources, URLs and proper nouns are immutable.
- WordPress block type/order, list and table dimensions, inline emphasis and link positions must remain identical.

### Independent recovery boundaries

- Heading and body translation are independent, so malformed JSON around one cannot destroy the other.
- FAQ entries translate and validate one at a time; one empty response cannot discard the other valid entries.
- FAQ question and answer have separate last-resort recovery calls.
- CTA failure uses a structure-preserving deterministic fallback and is still checked by the final gate.
- A failed component can be cleared after a later targeted repair succeeds; stale failure flags no longer reject recovered content.

### Metadata is no longer a startup gate

- A deterministic Chinese keyphrase is available before translation begins.
- The article body, headings, FAQ and conclusion are translated first.
- SEO title, meta description and excerpt are generated only after a complete Chinese draft exists.
- Empty combined metadata output triggers deterministic parity-safe fallbacks rather than aborting translation.
- Preferred 25–35 title and 80–120 meta-description ranges remain warnings, not fatal retry loops.
- The exact Chinese keyphrase is placed in the title without forcing another provider call solely for length.

### Chinese editorial quality gate

Only components with deterministic quality signals receive a dedicated Chinese editorial repair. It checks:

- English leakage and untranslated blocks.
- Literal or robotic sentence structure.
- Simplified/Mainland terminology.
- Half-width punctuation inside Chinese prose.
- Duplicate Chinese paragraphs.
- Missing or extra numbers.
- Changed source names or brand names.
- Changed URL sequence.
- Missing blocks, list items, table cells, emphasis or link positions.
- Incomplete translation relative to the English source.

### Final fail-closed parity

The translation cannot be persisted with:

- English fallback content.
- Missing/extra sections or FAQ entries.
- Changed numbers, dates, currencies or percentages.
- Changed or invented URLs.
- Missing named sources or brands.
- Non-canonical language switcher or slug.
- CTA/schema/FAQ mismatch.
- Stale English or Chinese temporal wording.
- Rendered HTML that differs from the canonical Chinese document.

## FAQ count repair

FAQ extraction now understands the canonical `.faq-item` renderer and preserves each answer's HTML. The translation and SEO routes use this canonical extraction when the saved `faq` column is absent or empty. The supplied English article was checked directly and returns five FAQ entries with answer HTML preserved.

## Version metadata and excerpt correction

The previous translation route stored the Chinese focus keyphrase in the `excerpt` field. That made the saved excerpt incorrect and coupled Chinese SEO auditing to an unrelated content field.

New Chinese versions now store:

- The real translated excerpt in `excerpt`.
- The paired English version ID and Chinese focus keyphrase in a versioned JSON envelope in `summary`.

The translation route, Chinese SEO audit API and Chinese SEO page all use the same parser. Legacy `source-en-version:<ID>` versions remain readable, including their old excerpt-keyphrase fallback.

## Persistence safety

The bilingual save remains compensated and readback-verified:

1. Create the Chinese version.
2. Update the paired English version with its canonical language switcher.
3. Read both versions back and compare exact slug/HTML values.
4. On any failure, restore English and remove the new Chinese version, including ambiguous client-timeout cases where the remote create may actually have succeeded.

## Verification completed

- Repository AST audit: **185 TypeScript/TSX files, 0 syntax errors or duplicate object properties**.
- Strict semantic TypeScript audit of the complete changed translation/freshness production graph: **0 diagnostics**, using local declarations only for unavailable third-party packages.
- Runtime temporal checks: English expired prediction rejected; Chinese expired prediction rejected; valid historical launch plus current status accepted.
- Runtime metadata checks: structured source pairing/keyphrase round-trip and legacy pairing passed.
- Runtime FAQ extraction against the supplied article: **5 entries**, answer HTML preserved.
- Runtime translation gate checks: valid current Chinese wording accepted; stale Chinese prediction rejected.
- Architecture invariant audit: metadata occurs after body translation; component recovery clears stale failures; canonical excerpt/keyphrase storage is enforced; freshness repair precedes malformed-prose repair.
- `git diff --check`: passed.

## Native dependency limitation

The package upload did not include usable dependencies. An explicit `npm ci` attempt against the public npm registry timed out and left only empty package directories. Therefore the native commands could not execute in this environment:

```text
npm test      -> vitest: not found
npm run build -> next: not found
```

On the development laptop, run:

```bash
rm -rf node_modules
npm ci
npm test
npm run lint
npm run build
```

Do not deploy until those native commands pass in the real dependency environment.
