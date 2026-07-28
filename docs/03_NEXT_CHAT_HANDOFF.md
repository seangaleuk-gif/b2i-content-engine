# Next Chat Handoff

## State When This Session Ended

```
Tests: 1189 passing, 0 failing.
TypeScript: Production code clean. 21 pre-existing errors in
  final-seo-normalizer.test.ts (17) and regression-issues.test.ts (4).
Build: ✅ Turbopack + TypeScript + production build all pass.

Translation DTO infrastructure (Stage 0) is complete.
Conclusion structured translation shadow is implemented.
Centralized number grammar: translation-number-grammar.ts 
  NUMBER_EXPRESSION_SOURCE + createNumberExpressionRegex(flags).
Consumers: editorial-block-protection.ts, translation-validator.ts.
Shared callback factory: createProductionConclusionStructuredShadowOptions.

Synthetic evaluation (10 fixtures): 10/10 initial passes, 0 repairs, 10/10 final passes.
Root cause: 3x, 10K, 1.2M not protected due to word-boundary gap.
Fix: added [xX×] and [KkMmBb] suffix patterns to shared grammar.
Real-content fixtures added: 6 new fixtures (16 total).
  real-multi-paragraph, real-internal-links, real-mixed-formatting-numeric,
  real-summary-list, real-with-dates, real-richest.
All 16 fixtures pass payload-safety checks (dry-run).
MAX_TOTAL_REQUESTS raised to 32 (from 20) for the 16-fixture set.

Live 16-fixture evaluation (2 runs):
  Run 1: 15/16 passes. real-with-dates: extra number (AI leaked literal digit).
  Fix: 
    - STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM: new rule forbidding literal numbers
    - buildStructuredConclusionRepairPrompt: NUMBER ERROR section for number-mismatch
  Run 2: 15/16 initial passes, 1 successful repair, 16/16 final passes. 0 failures.
  Real-content language quality: 4/5 acceptable, 1/5 minor wording concerns.
  1 regression test added for extra-number detection.

6 real-content fixtures are representative examples — not genuine production conclusions.
Next: genuine production-derived conclusion shadow evidence collection via 
  ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true during live translateArticle().

32 grammar-parity tests. 79 block-protection tests.
1189 + 33 = 1222 total tests.

Evidence recorder: src/lib/services/conclusion-shadow-evidence.ts
  - Privacy-safe metadata only. No URLs, no full text, no link-map.
  - Requires BOTH ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true
    AND ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE=true.
  - Error categories: bounded 12-category set, not raw messages.
  - Writes to tmp/structured-translation-production-evidence/ (gitignored).
  - Evidence-recording failure never fails article translation.
Summary script: scripts/summarize-conclusion-shadow-evidence.ts
  - Zero AI calls. Reads local records, reports aggregates.
33 evidence tests: categorization, privacy, flag control, integration, summary.
No production evidence collected yet — waiting for real translateArticle() calls.

HTML conclusion translation remains authoritative.
No article was generated, published or stored.
```

## Current Architecture

```
AI (DeepSeek) → {"blocks":[...]} → normalizeAiEditorialPayload → EditorialBlock[]
→ ArticleDocument (stores blocks exclusively)
→ renderEditorialBlocksToWordPress (only at render time)
→ legacy bridge: render → process → parse → validate → commit
```

### Editorial Translation Flow

```
EditorialBlock[]
→ protectNumbersInEditorialBlocks()       ← block-level, authoritative
→ renderEditorialBlocksToWordPress()      ← AI bridge (protected HTML)
→ AI translates HTML
→ parseWordPressEditorialBlocks()
→ structure-aware placeholder integrity   ← parsed inline text nodes
→ restoreNumbersInEditorialBlocks()       ← block-level, authoritative
→ checkBlockNumbersPreserved()            ← authoritative
→ checkBlockLinksPreserved()              ← authoritative
→ HTML shadow diagnostics                 ← rendered restored content
→ EditorialBlock[]
```

`translateEditorialBlocks()` owns the full lifecycle. FAQ and protected blocks bypass it.

### Key Files

| File | Purpose |
|---|---|
| `src/lib/services/editorial-block-translation.ts` | Centralized helper: protect → render → AI → parse → validate → restore |
| `src/lib/services/editorial-block-protection.ts` | Block-level number/link extraction, protection, restoration, checks |
| `src/lib/services/translation-service.ts` | Orchestration: selects components, provides AI callbacks, tracks status |
| `src/lib/blog/article-content.ts` | Types, normalizer, renderer, parser (parse5) |
| `src/lib/blog/article-document.ts` | `ArticleDocument` type, render function, document parser |
| `src/lib/blog/editorial-block-protection.ts` | Structured number/link utilities |
| `src/lib/services/translation-dto.ts` | Translation DTO (Stage 0): serialization, strict JSON parsing, structural normalization, link-map reconstruction, conclusion policy validation; isolated from production |
| `src/lib/services/translation-number-grammar.ts` | Centralized number expression grammar: `NUMBER_EXPRESSION_SOURCE`, `createNumberExpressionRegex()`; consumed by both block-level and HTML-level protection |

## Completed Migration

All tracked objectives for the structured-content migration checkpoint are complete:

- ✅ `ArticleComponent.html` removed — `blocks: EditorialBlock[]` is canonical
- ✅ Renderer and parser use structured blocks exclusively
- ✅ Translation editorial `.html` reads/writes eliminated
- ✅ All 3 test files migrated to `EditorialBlock[]` fixtures
- ✅ `validateFaqParity` strengthened (empty Q/A rejected)
- ✅ Translation HTML round trip centralized in `translateEditorialBlocks()`
- ✅ Block-level number protection authoritative
- ✅ Structured number/link validation authoritative
- ✅ Placeholder integrity validates parsed inline nodes
- ✅ Parser duplication fixed at source; `deduplicateInlineContent` removed
- ✅ `article-content.test.ts` TypeScript errors resolved
- ✅ **1057 tests passing, 0 failing** (now 1188)
- ✅ Translation DTO infrastructure (Stage 0): serialization, strict JSON extraction, structural normalization, application-owned link reconstruction, conclusion policy validation, canonical block reconstruction, post-reconstruction validation; **fully isolated from production** — HTML bridge remains authoritative
- ✅ Conclusion structured translation shadow implemented (`runConclusionStructuredShadow`): controlled by `ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true` or DI; disabled by default; runs alongside HTML path for conclusion only; diagnostic-only; one repair attempt; does not affect authoritative conclusion
- ✅ Centralized number grammar (`translation-number-grammar.ts`): `NUMBER_EXPRESSION_SOURCE` + `createNumberExpressionRegex()` — shared by block-level and HTML-level protection, eliminating 22 duplicated alternatives
- ✅ Live synthetic evaluation: 10/10 passes, 0 repairs, 0 failures after suffix fix
- ✅ **Production build green**

## Remaining Future Work

| Item | Priority |
|---|---|
| Enable evidence collection during real translations | **Next stage** — set `ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true` and `ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE=true` during normal translation. Then run `scripts/summarize-conclusion-shadow-evidence.ts` to review. |
| Service round-trip elimination (`blog-generation-service.ts`) | Medium |
| SEO normalizer block mutation | Medium |

### Legacy HTML Bridge Areas (Not Migration Scope)

- **Factual scan** — renders section blocks to HTML, removes sentences, parses back
- **Final trim** — renders section HTML, trims, parses back
- **Expansion/trim** — AI adds/removes content, parses back
- **SEO normalizer** — edits rendered HTML strings (should eventually mutate `EditorialBlock[]` directly)

All go through `runTrackedHtmlStage` (snapshot → render → process → parse → validate → commit/rollback).

## Architectural Rules (Never Break)

- `EditorialBlock[]` is canonical. No editorial component may have both `html` and `blocks`.
- `state.articleDoc` is the single source of truth. `state.blog` is a rendered cache only.
- `state.blog` must always be regenerated from `articleDoc` after every committed change.
- Never use non-null assertions on `parseArticleDocumentFromHtml` results (`.doc!` is forbidden).
- The legacy bridge must roll back on parser failure.
- AI must never generate CTA content. CTA is application-owned.
- The renderer (`renderEditorialBlocksToWordPress`) is the only source of WordPress markup.
- No regex-based WordPress repair.
- No raw prose outside supported WordPress blocks.
- Conclusion content comes from conclusion blocks only — never from the last editorial section.
- **Translation and SEO normalisation are temporary HTML compatibility paths.** They should later operate directly on `EditorialBlock[]` text nodes.

## Protected Non-Editorial Content (Do Not Touch)

| Field | Type | Why Protected |
|---|---|---|
| `languageSwitcher.html` | string (HTML) | Deterministic, application-owned, never AI-generated |
| `cta.html` | string (HTML) | Application-owned, injected by `cta-preserve` stage |
| `faqSchema.html` | string (HTML) | Generated from `visibleFaq` by `renderFaqSchema()` |
| `visibleFaq` | `FaqEntry[]` | Structured, sole canonical FAQ source |
| Rendered `state.blog` | string (HTML) | Output of `renderArticleDocument()`, regenerated after each commit |

**Editorial component HTML is NOT persisted to the database.** The database stores `blog` (fully rendered HTML), `faq` (structured pairs), and metadata. `ArticleDocument` is in-memory only.
