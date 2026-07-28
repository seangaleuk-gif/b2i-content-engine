# Structured Content Migration

## Original HTML-First Architecture

Before the migration, `ArticleDocument` stored editorial content as raw WordPress HTML strings:

```ts
interface ArticleComponent {
  id: string;
  html: string;        // WordPress HTML like "<!-- wp:paragraph --><p>Content</p><!-- /wp:paragraph -->"
  wordCount: number;
  status: ComponentStatus;
}
```

AI responses were expected to return full WordPress HTML with `<!-- wp:* -->` block comments. The generation pipeline accepted AI-generated HTML, attempted regex-based repair (`rebalanceWpBlocks`, `stripHeadingBlocks`), and stored the result directly. The parser (`parseArticleDocumentFromHtml`) extracted HTML from rendered articles and stored it back as `.html` strings.

Problems with the old approach:
- AI-generated HTML frequently had malformed block comments, nested `<p>` tags, and orphaned markers.
- Regex-based repair was fragile and could produce `wp:wp:paragraph` artifacts.
- No structured content validation existed — AI could generate H2s, CTA content, or raw prose anywhere.
- FAQ recovery scanned raw HTML and frequently absorbed conclusion/CTA text into FAQ answers.

## Target Structured-Content Architecture

### Canonical Model

```ts
interface ArticleComponent {
  id: string;
  blocks: EditorialBlock[];  // structured typed blocks
  status: ComponentStatus;
}
```

`EditorialBlock` is a discriminated union:

```ts
type EditorialBlock =
  | { id: string; type: "paragraph"; content: InlineContent[] }
  | { id: string; type: "subheading"; level: 3; content: InlineContent[] }
  | { id: string; type: "list"; ordered: boolean; items: InlineContent[][] }
  | { id: string; type: "quote"; content: InlineContent[] }
  | { id: string; type: "table"; headers: InlineContent[][]; rows: InlineContent[][][] };
```

### Data Flow

```
AI (DeepSeek) → {"blocks": [...]} JSON
  → normalizeAiEditorialPayload() validates and transforms
  → EditorialBlock[] stored directly in ArticleDocument
  → renderEditorialBlocksToWordPress() produces WP HTML (only at render time)
  → parseWordPressEditorialBlocks() reconstructs blocks from legacy HTML (only at legacy bridge boundary)
```

### No Round-Trip Between AI and Storage

Generated blocks are stored directly. The service must NOT render → then parse → then store. `parseWordPressEditorialBlocks` is used only for:
- Legacy HTML reconstruction (existing published articles)
- Temporary HTML-stage bridge output
- Translation output that arrives as WordPress HTML

## Completed Migration Stages

| # | Stage | Key Files Changed |
|---|---|---|
| 1 | Create `EditorialBlock` / `InlineContent` types | `article-content.ts` |
| 2 | Create `normalizeAiEditorialPayload` with validation | `article-content.ts` |
| 3 | Create `renderEditorialBlocksToWordPress` | `article-content.ts` |
| 4 | Add `parseWordPressEditorialBlocks` (parse5 DOM parser) | `article-content.ts` |
| 5 | Add CTA-scoped rejection option | `article-content.ts` (NormalizationOptions) |
| 6 | Add `validateEditorialBlocks`, `extractPlainText`, `countWords`, `clone` | `article-content.ts` |
| 7 | Update `ArticleDocument` — remove `html`, add `blocks` | `article-document.ts` |
| 8 | Update `renderArticleDocument` to use blocks | `article-document.ts` |
| 9 | Update `parseArticleDocumentFromHtml` | `article-document.ts` (uses parse5 parser) |
| 10 | Add conclusion markers, FAQ heading marker | `article-document.ts` |
| 11 | Update pipeline legacy bridge | `blog-generation-pipeline.ts` |
| 12 | Update service: store blocks, parse legacy HTML | `blog-generation-service.ts` |
| 13 | Update service: seed `visibleFaq` from FAQ section | `blog-generation-service.ts` |
| 14 | Update service-level tests with DI mock | `blog-generation-service.test.ts` |
| 15 | Update default prompts for structured JSON | `default-prompts.ts`, `prompt-builder.ts` |
| 16 | Update translation route minimal doc | `translate/route.ts` |
| 17 | Centralize translation HTML round trip | `translation-service.ts`, `editorial-block-translation.ts` |
| 18 | Add block-level number/link utilities | `editorial-block-protection.ts` |
| 19 | Remove parser link-text duplication | `article-content.ts` |
| 20 | Translation DTO infrastructure (Stage 0) | `translation-dto.ts`, `translation-dto.test.ts` |
| 21 | Centralized number grammar | `translation-number-grammar.ts` |

## Translation Architecture (Current)

```
EditorialBlock[]
→ protectNumbersInEditorialBlocks()          ← block-level, authoritative
→ renderEditorialBlocksToWordPress()         ← AI bridge (protected HTML)
→ AI translates HTML
→ parseWordPressEditorialBlocks()
→ structure-aware placeholder integrity      ← parsed inline text nodes
→ restoreNumbersInEditorialBlocks()          ← block-level, authoritative
→ checkBlockNumbersPreserved()               ← authoritative
→ checkBlockLinksPreserved()                 ← authoritative
→ HTML shadow diagnostics                    ← rendered restored content
→ EditorialBlock[]
```

Key points:
- `translateEditorialBlocks()` owns the full lifecycle.
- Block-level number protection is authoritative. HTML `protectNumbersInHtml` / `tryRestoreNumbersInHtml` are no longer used for editorial translation.
- Structured number/link validation is authoritative. HTML shadow validators run diagnostic-only.
- Placeholder integrity validates parsed structured inline nodes (text, strong, emphasis, link) — not raw HTML.
- The parser duplication bug (text nodes inside `<a>`, `<strong>`, `<em>` creating duplicate inline content) was fixed at its source. `deduplicateInlineContent()` was removed.

## Controlled Legacy Bridge

Processors that still require HTML operate through a controlled render → process → parse → validate → commit bridge:

```
ArticleDocument.blocks
  → renderArticleDocument()            # produce full HTML
  → renderComponentHtml(section)       # produce single component HTML
  → legacy processor (normalizer, factual-scan, trim, expand, etc.)
  → parseWordPressEditorialBlocks()    # reconstruct blocks from HTML
  → ArticleDocument.blocks
  → validate and commit or rollback
```

Rules enforced by `runTrackedHtmlStage`:
1. Snapshot `state.articleDoc` before the stage.
2. Render to `state.blog`.
3. Pass HTML to the legacy stage.
4. Parse the result back via `parseArticleDocumentFromHtml`.
5. If parsing fails (null doc), restore the pre-stage snapshot.
6. If parsing succeeds, commit the new doc and regenerate `state.blog`.
7. Never use non-null assertions on parser results.

### Why the Bridge Is Needed

The following processors have not yet been migrated to structured blocks and require the bridge:

- **SEO normalizer** (`final-seo-normalizer.ts`) — edits component HTML strings directly via a local `{ html: string }` helper type (not `ArticleComponent.html`); should eventually edit `EditorialBlock.content[i].text`
- **Factual scan** (`factual-risk-scanner.ts`) — removes unsupported sentences from HTML
- **Final trim** — removes last paragraph from sections when over word limit
- **Expansion/trim** (`section-expander.ts`) — adds/removes content from sections
- **Claim check** (`component-regenerator.ts`) — regenerates sections via AI
- **Service round trip** — `blog-generation-service.ts` performs render→parse round trip

All legacy stages go through `runTrackedHtmlStage` and correctly render → process → parse → validate → commit.

## Translation DTO (Stage 0 — Complete, Isolated)

`src/lib/services/translation-dto.ts` provides a complete translation DTO layer that is fully isolated from production translation:

- **`serializeTranslationPayload()`** — Converts number-protected `EditorialBlock[]` to a text-only DTO. URLs and `sourceType` are stored in an application-owned `linkMap`, never exposed to the AI. Number placeholders remain inside text fields. Canonical `EditorialBlock.id` values are never included.
- **`extractTranslationJson()`** — Strict JSON parser accepting only clean JSON objects (with optional code fence). Rejects prose before/after JSON, multiple objects, and malformed JSON.
- **`normalizeTranslationPayload()`** — Validates exact structural parity with the source payload: block count, type, seq, inline node count/type/seq, list shape, table dimensions, link references. Rejects unexpected keys, empty text, raw HTML, Markdown, signup URLs, and conclusion CTA content.
- **`validateConclusionPolicy()`** — Reuses the canonical `CTA_CONTENT_RE` from `article-content.ts` via `disallowCtaContent` policy.
- **`reconstructEditorialBlocks()`** — Reconstructs canonical `EditorialBlock[]` from the normalized DTO. Copies IDs, structural fields, and link destinations from source blocks. Never trusts protected fields from the AI.
- **`validateReconstructedTranslation()`** — Post-reconstruction validation: `validateEditorialBlocks()`, `checkBlockNumbersPreserved()`, `checkBlockLinksPreserved()`.

57 isolated contract tests cover serialization, parsing, structural validation, content policy, reconstruction, and number placeholders.

**The DTO is not yet integrated into production translation.** The HTML bridge remains authoritative.

## Conclusion Structured Translation Shadow

`runConclusionStructuredShadow()` in `editorial-block-translation.ts` runs a structured JSON translation path for the conclusion alongside the existing HTML path, controlled by `ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true` or dependency injection:

1. Uses the same protected blocks and protection state as the HTML path (no double protection).
2. Serializes to DTO via `serializeTranslationPayload()`.
3. Sends the DTO JSON to a structured AI callback.
4. Normalizes and reconstructs via `normalizeTranslationPayload()` + `reconstructEditorialBlocks()`.
5. Validates placeholder integrity, restores numbers, runs `validateEditorialBlocks()`, conclusion CTA policy, number and link preservation.
6. Produces a diagnostic `StructuredTranslationShadowResult` — never affects `zhDoc.conclusion.blocks`.
7. Supports one repair attempt; failure does not affect the authoritative conclusion.

Disabled by default. Zero API calls when disabled. 20 focused tests cover feature control, payload safety, success, repair, and result isolation.

The production shadow callbacks use a dedicated `STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM` prompt (not `TITLE_META_SYSTEM`). Two builder functions (`buildStructuredConclusionTranslationPrompt`, `buildStructuredConclusionRepairPrompt`) construct the AI requests. The environment defaults (`ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true`) include both initial and repair callbacks, supporting exactly one structured repair attempt.

## Centralized Number Grammar

`src/lib/services/translation-number-grammar.ts` is the single source of truth for the numeric-expression grammar used by both block-level and HTML-level translation protection:

- `NUMBER_EXPRESSION_SOURCE` — the joined regex alternatives as a string
- `createNumberExpressionRegex(flags?)` — returns a fresh `RegExp` instance (avoids shared `lastIndex` state)

Both `editorial-block-protection.ts` and `translation-validator.ts` construct their regexes from this module. 22 duplicated alternatives eliminated.

### Supported Formats

| Category | Examples |
|---|---|
| Percentages | `50%`, `12.5%`, `50％` |
| Currencies | `HK$50,000`, `USD 500`, `CNY100` |
| Comma-separated | `1,000`, `50,000` |
| Decimals | `3.5`, `0.25` |
| Dates | `2026-01-15`, `01/15/2026`, `January 15, 2026` |
| Numeric ranges | `10–20` |
| Letter suffixes | `3x`, `2.5x`, `3×`, `10K`, `50k`, `1.2M`, `2B` |
| CJK currency suffixes | `500港元`, `1,200港幣` |
| Scaled English | `5 million`, `3.5 billion` |
| Plain numbers | `100`, `7` (adjacent to punctuation) |

### Excluded from Number Matches

- Partial words: `3xample`, `10Kitchen`, `1.2Millionaire`, `version3beta`
- Complete placeholders: `__NUM_0__`, `__NUM_12__` (digits inside placeholders are not editorial numbers)

32 grammar-parity tests verify both the must-match and must-reject corpora.

### Root Cause (Live Evaluation Failure)

Suffix expressions such as `3x`, `10K` and `1.2M` were not previously protected because the old word-boundary rule (`\b\d{1,3}...\b`) required a word boundary after the last digit, but `3` and `x` are both `\w` characters. When unprotected expressions reached the AI, a value such as `3x` could become `3倍` in Chinese, introducing a raw digit that the regex then counted as a newly extra number.

The mismatch was **introduced in the AI-returned structured text**. Restoration did not create the extra numbers. Post-restoration validation detected them.

## Live Synthetic Evaluation

Two runs of `conclusion-shadow-evaluator.ts` (10 deterministic fixtures):

**Initial run (pre-fix):** 8/10 final passes, 2 number-preservation failures, 2 repair attempts, 0 repair successes.

**Successful rerun (after suffix fix + centralized grammar):** 10/10 initial passes, 0 repairs, 10/10 final passes, 0 preservation or policy failures.

All surrogate links, numbers, percentages, currencies, date formats, lists, and tables preserved. Traditional Chinese quality acceptable with appropriate Hong Kong Cantonese phrasing.

Reports in `tmp/structured-translation-evaluation/` (gitignored).

## Current Authority

- **HTML conclusion translation remains authoritative.** `zhDoc.conclusion.blocks` is assigned only from the HTML path.
- **Structured conclusion translation remains diagnostic-only.** The shadow path produces a `structuredShadowResult` that never affects `zhDoc.conclusion.blocks`, `failedComponents`, or publishing output.
- **No full article was generated, published, or stored** during any evaluator run.

## Real-Content Conclusion Shadow Evidence (2026-07-28)

### Fixture Provenance

| Fixture | Provenance |
|---|---|
| `real-multi-paragraph` | **Adapted** from `blog-generation-pipeline.test.ts` L75 conclusion fixture. Original text expanded with Hong Kong brand presence framing. |
| `real-internal-links` | **Newly written** representative example with realistic B2I Hub blog URLs. |
| `real-mixed-formatting-numeric` | **Adapted** from `blog-generation-pipeline.test.ts` L305. Numeric values composed as representative examples. |
| `real-summary-list` | **Newly written** representative example. |
| `real-with-dates` | **Newly written** representative example. |
| `real-richest` | **Newly written** representative example combinin table + ordered list + links + numbers. |

**None of the six real-content fixtures are verbatim copies from genuine production articles.** They are either adapted from test fixtures or newly written. URLs use `b2ihub.com` and `example-org.com.hk` test domains. No company-identifying information, private URLs, unpublished campaign data, or personal data is present.

### Live Evaluation Results (16 fixtures: 10 synthetic + 6 real-content)

| Metric | Combined | Synthetic (10) | Real-content (6) |
|---|---|---|---|
| Initial passes | 15/16 | 10/10 | 5/6 |
| Repair attempts | 1 | 0 | 1 |
| Repair successes | 1 | — | 1 |
| Final passes | 16/16 | 10/10 | 6/6 |
| Final failures | 0 | 0 | 0 |
| AI requests | 17 | 10 | 7 |
| Structural failures | 0 | 0 | 0 |
| Placeholder failures | 0 | 0 | 0 |
| Number failures | 0 | 0 | 0 |
| Link failures | 0 | 0 | 0 |
| CTA-policy failures | 0 | 0 | 0 |
| Average character ratio | 0.64 | 0.69 | 0.52 |

### Failure History

Run 1 (pre-prompt-fix): `real-with-dates` failed with "number mismatch (extra: 1)" — AI preserved all 5 placeholders but introduced an extra Latin-digit number alongside date context.

**Fix applied:**
1. `STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM` prompt gained a rule: "Do NOT write any literal number alongside a __NUM_N__ placeholder. Every number in the output must be represented exclusively by its __NUM_N__ placeholder — no exceptions."
2. `buildStructuredConclusionRepairPrompt()` gained a `NUMBER ERROR` section: when errors include "number mismatch", the repair prompt explicitly instructs the AI to fix literal-number leakage.

Run 2 (post-fix): **15/16 initial passes, 1 successful repair, 16/16 final passes, 0 failures.** The `real-with-dates` repair succeeded.

### Language Quality Assessment (Real-Content Fixtures)

| Fixture | Pass | Quality | Notes |
|---|---|---|---|
| `real-multi-paragraph` | ✅ | acceptable | Traditional Chinese, natural Hong Kong phrasing, all ideas preserved |
| `real-internal-links` | ✅ | acceptable | Uses Cantonese "我哋嘅", "呢啲", link labels intact |
| `real-mixed-formatting-numeric` | ✅ | acceptable with minor wording concerns | Slightly awkward "以及高達...在6個月內" word order; numbers preserved |
| `real-summary-list` | ✅ | acceptable | All 4 bullet points translated, natural Hong Kong wording |
| `real-with-dates` | ✅ | acceptable (repaired) | Initial run had extra Latin-digit number; repair used Chinese numerals "二〇二四年" |
| `real-richest` | ✅ | acceptable | Table/ordered-list/links/numbers preserved; minor English retention ("2.5 months" instead of "2.5個月") |

### Reports

JSON: `tmp/structured-translation-evaluation/evaluation-2026-07-28T08-43-25-604Z.json`
Markdown: `tmp/structured-translation-evaluation/evaluation-2026-07-28T08-43-25-604Z.md`

Neither report contains URLs, link-map values, API keys, environment values, request headers, or full prompts.

## Genuine Production-Derived Conclusion Shadow Evidence

### Definition

A qualifying evidence item must originate from a real conclusion passed through an actual `translateArticle()` call. It may come from a real manually initiated article translation, an existing unpublished generated article being translated, or an ordinary application translation request while shadow mode is enabled.

It must not be a newly written fixture, copied from a test fixture, a synthetic evaluator example, or generated solely to increase the evidence count.

### Privacy-Safe Local Recording

`src/lib/services/conclusion-shadow-evidence.ts` records privacy-safe metadata only:

```ts
interface ConclusionShadowEvidenceRecord {
  timestamp: string;
  evidenceId: string;                    // random hash
  componentIdHash: string;               // one-way hash
  sourceStructureSignature: string;      // structural fingerprint
  shadowPassed: boolean;
  repaired: boolean;
  errorCategories: string[];             // bounded categories only
  blockCount: number;
  blockTypes: string[];
  hasMultipleParagraphs: boolean;
  hasStrong: boolean;
  hasEmphasis: boolean;
  hasLinks: boolean;
  linkCount: number;
  hasList: boolean;
  hasTable: boolean;
  placeholderCount: number;
  hasDate: boolean;
  hasCurrency: boolean;
  hasPercentage: boolean;
  hasRange: boolean;
  hasSuffixNumber: boolean;
  numberPreserved: boolean;
  linksPreserved: boolean;
  placeholderIntegrityPassed: boolean;
  conclusionPolicyPassed: boolean;
  sourceCharacters: number;
  translatedCharacters: number;
  characterRatio: number;
}
```

The record contains no article title, slug, complete source conclusion, complete translated conclusion, URLs, link labels, link-map contents, API keys, prompts, or business-identifying information.

### Environment Flags

| Flag | Purpose |
|---|---|
| `ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true` | Required to run the structured shadow |
| `ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE=true` | Required to write evidence records |

Both must be `true` for evidence to be recorded. Shadow enabled alone runs the diagnostic without writing evidence. Evidence flag alone produces no structured request.

### Storage

Local gitignored directory: `tmp/structured-translation-production-evidence/`
Format: Newline-delimited JSON files per record.

No evidence is written to Supabase, WordPress, application article records, analytics services, or publishing metadata. Evidence-recording failure never fails article translation.

### Error Categories

Raw validator messages are reduced to bounded categories: `api_or_network`, `malformed_json`, `schema`, `block_structure`, `inline_structure`, `placeholder`, `number_preservation`, `link_preservation`, `conclusion_policy`, `empty_translation`, `configuration`, `unknown`.

### Integration Boundary

Evidence is recorded at exactly one point: after `runConclusionStructuredShadow()` completes in `translation-service.ts`. The recorder receives only the final diagnostic result (`StructuredTranslationShadowResult`) and safe structural metrics — never the private link map or complete block text.

### Evidence Summary Script

`scripts/summarize-conclusion-shadow-evidence.ts` reads local evidence records and reports: total samples, initial-pass count, repaired-pass count, final-pass count, final-failure count, failure-category totals, structural diversity counts, link/number/placeholder/CTA-policy failures, and average character ratio. Makes zero AI calls.

### Collection Limit

This stage supports collecting a small evidence set from normal use. No articles are generated automatically. No repeated translations are created solely for testing. No authority-switch threshold has been defined.

### Current State

**No production samples collected yet.** The evidence infrastructure is in place awaiting a normal `translateArticle()` call with both environment flags enabled.

## Remaining Future Work

| Item | Priority |
|---|---|
| Enable evidence collection during real translations | **Next stage** — set `ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION=true` and `ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE=true` during normal translation |
| Service round-trip elimination (`blog-generation-service.ts`) | Medium |
| SEO normalizer block mutation | Medium |

## Migration History

| Date | Tests | Key Milestone |
|---|---|---|
| 2026-07-27 | 851/883 | Checkpoint: ArticleComponent `.html` removed, production code migration complete |
| 2026-07-27 | 944/944 | Test fixtures migrated, FAQ parity strengthened |
| 2026-07-28 | 969/969 | Translation HTML round trip centralized |
| 2026-07-28 | 1009/1009 | Structured block-level number/link utilities |
| 2026-07-28 | 1023/1023 | Structured number/link validation authoritative |
| 2026-07-28 | 1038/1038 | Block-level number protection authoritative |
| 2026-07-28 | 1054/1054 | Placeholder integrity validates parsed blocks |
| 2026-07-28 | 1057/1057 | Parser duplication fixed, `deduplicateInlineContent` removed |
| 2026-07-28 | 1114/1114 | Translation DTO infrastructure (Stage 0) — serialization, strict parsing, normalization, link-map reconstruction, conclusion policy, isolated from production |
| 2026-07-28 | 1149/1149 | Controlled synthetic-fixture evaluator, shared callback factory, dry-run mode |
| 2026-07-28 | 1156/1156 | Number grammar suffix fix (`3x`, `10K`, `1.2M` protection) |
| 2026-07-28 | 1188/1188 | Centralized number grammar (`translation-number-grammar.ts`), 32 grammar-parity tests, 10/10 live evaluation |
| 2026-07-28 | 1189/1189 | Real-content conclusion shadow evidence collection: 15/16 initial passes, 1 successful repair, 16/16 final passes, 0 failures. Prompt fix for literal-number leakage. 1 regression test added. HTML remains authoritative. |
