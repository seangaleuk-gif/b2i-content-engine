# B2I Content Engine — Project Status

## Overall Goal

A full-stack content generation platform for Hong Kong SMEs. Generates SEO-optimised blog articles with Hong Kong–specific market context, local creator partnerships, and bilingual (English/Traditional Chinese) support. The engine manages the full lifecycle: outline generation, editorial section generation, FAQ/CTA injection, SEO normalisation, factual-scan validation, final validation, and publishing.

## Current Architecture

```
AI (DeepSeek)
  → structured JSON {"blocks":[...]}
  → normalizeAiEditorialPayload() → EditorialBlock[]
  → ArticleDocument (stores blocks as canonical editorial state)
  → renderEditorialBlocksToWordPress() → WordPress HTML
  → legacy HTML stage bridge (render → process → parse → validate → commit)
  → final publishing
```

### Canonical State Model

- **`ArticleDocument`** is the single canonical mutable article representation.
  - `introduction.blocks`, `sections[].blocks`, `conclusion.blocks` are `EditorialBlock[]`.
  - No dual `html` + `blocks` representation exists on editorial components.
- **`state.blog`** is a rendered HTML cache, regenerated from `ArticleDocument` after every committed change. Never treated as canonical.
- **`state.faq`** is synchronised from `articleDoc.visibleFaq`.

### Protected Non-Editorial Content (application-owned, never AI-generated)

| Field | Type | Purpose |
|---|---|---|
| `languageSwitcher.html` | string (HTML) | Bilingual slug toggle, always deterministic |
| `cta.html` | string (HTML) | Signup call-to-action, constant canonical HTML |
| `faqSchema.html` | string (HTML) | `FAQPage` JSON-LD schema generated from `visibleFaq` |
| `visibleFaq` | `FaqEntry[]` | Structured Q&A pairs, sole canonical FAQ source |
| Rendered `state.blog` | string (HTML) | Final article HTML, regenerated after each commit |

**Editorial component HTML is NOT directly persisted to the database.** The database stores:
- `blog` — the full rendered HTML (output of `renderArticleDocument`)
- `faq` — structured FAQ question/answer pairs
- Article metadata (title, slug, meta description, excerpt)

`ArticleDocument` is an in-memory model assembled during generation and not serialized.

## Completed Migration Stages

| Stage | Status | Details |
|---|---|---|
| EditorialBlock types | ✅ Complete | `InlineContent`, `EditorialBlock`, `AiEditorialBlock` in `article-content.ts` |
| AI payload normalisation | ✅ Complete | `normalizeAiEditorialPayload` with CTA-scoped rejection |
| WordPress renderer | ✅ Complete | `renderEditorialBlocksToWordPress` — only source of WP markup |
| Add parse5 DOM parser | ✅ Complete | `parseWordPressEditorialBlocks` for legacy HTML reconstruction |
| Conclusion markers | ✅ Complete | `<!-- b2i-conclusion-start -->` / `<!-- b2i-conclusion-end -->` |
| FAQ heading marker | ✅ Complete | `<!-- b2i-faq-heading -->` |
| Service-level retry tests | ✅ Complete | Dependency-injected `requestDeepSeek`, 13 strict tests |
| FAQ population in assembly | ✅ Complete | `articleDoc.visibleFaq` from FAQ section body |
| Conclusion prompt de-CTA'd | ✅ Complete | Removed CTA module from conclusion stage prompts |
| ArticleComponent → blocks | ✅ Complete (type) | `html` field removed from `ArticleComponent` interface |
| renderArticleDocument → blocks | ✅ Complete | Uses `renderEditorialBlocksToWordPress` |
| parseArticleDocumentFromHtml → blocks | ✅ Complete | Uses `parseWordPressEditorialBlocks` |
| Pipeline legacy bridge | ✅ Complete | Render → process → parse → validate → commit |
| CreatePipelineState faq sync | ✅ Complete | `state.faq` from `articleDoc.visibleFaq` |
| Default prompts updated | ✅ Complete | Structured JSON format, de-CTA'd conclusion |
| Translation editorial `.html` eliminated | ✅ Complete | All 9 reads migrated to `renderComponentHtml()`; dead FAQ assignments removed |
| Test fixture migration | ✅ Complete | All 3 files migrated to `EditorialBlock[]` |
| FAQ parity validator | ✅ Complete | Empty Q/A rejected; 7 regression tests |
| Translation HTML round trip centralized | ✅ Complete | `translateEditorialBlocks()` helper owns lifecycle |
| Structured block-level number/link utilities | ✅ Complete | `editorial-block-protection.ts` with extract, protect, restore, check |
| Structured number/link validation authoritative | ✅ Complete | `checkBlockNumbersPreserved` / `checkBlockLinksPreserved` gate pass/fail |
| Block-level number protection authoritative | ✅ Complete | `protectNumbersInEditorialBlocks` replaces HTML protection |
| Parser link-formatting duplication fixed | ✅ Complete | `parseInlineContent` skips text nodes inside `<a>`, `<strong>`, `<em>` |
| `deduplicateInlineContent()` removed | ✅ Complete | Root cause fixed in parser |
| `article-content.test.ts` TS errors fixed | ✅ Complete | 6 discriminated-union narrowing issues resolved |

## Current Test Count

**1189 passing, 0 failing** (17 test files).

## Current Build Status

- **Turbopack compilation**: ✅ Passes
- **TypeScript type checking**: ✅ Production code clean. 21 pre-existing errors remain in `final-seo-normalizer.test.ts` (17) and `regression-issues.test.ts` (4) — all unrelated to structured-content migration.
- **Production build**: ✅ Passes

## In-Progress and Future Work

| Item | Status | Details |
|---|---|---|
| Collect genuine production-derived conclusion shadow evidence | ⏭️ **Next stage** | The 6 real-content fixtures are representative examples, not genuine production conclusions. The next stage is to capture shadow results from real `translateArticle()` runs with `ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true`. |
| SEO normalizer block mutation | 🔄 Future work | `firstBlock.html` operates on a local `{ html: string }` helper type (not `ArticleComponent`); should eventually edit `EditorialBlock.content[i].text` directly |
| Service round-trip elimination | 🔄 Future work | `blog-generation-service.ts` stores `normalized.blocks` directly instead of render→parse round trip |
| Translation DTO infrastructure | ✅ Complete | `translation-dto.ts` with serialization, strict JSON extraction, structural validation, content-policy checks, reconstruction, and post-reconstruction validation |
| Conclusion structured translation shadow | ✅ Complete | 20 tests for `runConclusionStructuredShadow()` — feature control, payload safety, success, repair, failure, result isolation; 4 orchestration tests + 7 prompt tests in `translation-service.test.ts`. Dedicated `STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM` prompt constant. `buildStructuredConclusionTranslationPrompt()` and `buildStructuredConclusionRepairPrompt()` builders. Production env defaults include both initial and repair callbacks. `TITLE_META_SYSTEM` is no longer used by structured shadow translation. |
| Shared callback factory | ✅ Complete | `createProductionConclusionStructuredShadowOptions(budget)` in `translation-ai.ts`; used by both `translateArticle()` and evaluator |
| Controlled synthetic-fixture evaluator | ✅ Complete | `conclusion-shadow-evaluator.ts` with 10 deterministic fixtures, payload safety gate, dry-run mode. Dry run: 10/10 payload safety checks pass, 0 AI calls. `scripts/evaluate-conclusion-structured-shadow.ts` CLI. Reports in `tmp/structured-translation-evaluation/` (gitignored). |
| Live synthetic-fixture evaluation (fix verified) | ✅ Complete | 2026-07-28. Two runs. First run: 8/10 passes (2 number failures). Second run after fix: **10/10 passes, 0 failures**. 10 AI requests, 0 repairs. |
| Centralized number grammar | ✅ Complete | `translation-number-grammar.ts` — single `NUMBER_EXPRESSION_SOURCE` + `createNumberExpressionRegex()`. Replaced duplicated patterns in `editorial-block-protection.ts` and `translation-validator.ts`. |
| Real-content conclusion shadow evidence collection | ✅ Complete | Added 6 representative real-content fixtures (16 total). Live evaluation: **15/16 initial passes, 1 successful repair, 16/16 final passes, 0 failures**. Language quality assessment: 4 acceptable, 1 acceptable with minor concerns, 1 n/a (repaired). HTML conclusion translation remains authoritative. Regression test for extra-number detection added (1189 tests). |

## Legacy HTML Bridge Areas (Not Planned for This Migration)

These areas use controlled legacy HTML processing and are not part of the current scope:

- **Factual scan** — renders `section.blocks` to HTML, removes unsupported sentences, parses back
- **Final trim** — renders section HTML, trims to word limit, parses back
- **Expansion/trim** — adds/removes section content via AI, parses back
- **SEO normalizer** — edits rendered HTML strings directly (should migrate to `EditorialBlock[]` mutation in a future phase)

All legacy stages go through `runTrackedHtmlStage` which snapshots, renders, processes, parses, validates, and commits or rolls back.

## Current Architectural Rules (Never Break)

1. **`EditorialBlock[]` is canonical.** Content is stored as typed block arrays. No editorial component may have both `html` and `blocks`.
2. **`state.articleDoc` is canonical.** All pipeline stages mutate it. `state.blog` is only a rendered cache, regenerated from `articleDoc` after every commit.
3. **AI never owns CTA.** CTA is injected by the pipeline's `cta-preserve` stage from a constant canonical HTML string.
4. **Legacy HTML stages must be wrapped.** The controlled bridge: render → legacy process → parse → validate → commit. On parse failure, restore pre-stage document.
5. **No non-null assertions on parser results.** `parseArticleDocumentFromHtml().doc!` is forbidden.
6. **The renderer is the only source of WordPress markup.** `renderEditorialBlocksToWordPress` — no manual WP comment construction.
7. **No regex-based WordPress repair.** The `fp()` flatten function is the only exception and is being phased out.
8. **Conclusion content comes from conclusion blocks only.** Never extracted from the last editorial section via pattern matching.
9. **Translation and SEO normalisation are temporary HTML compatibility paths.** They should later operate directly on `EditorialBlock[]` text nodes.
