<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# B2I Content Engine — Architecture

## Canonical article state

`ArticleDocument` (in `src/lib/blog/article-document.ts`) is the single canonical mutable article representation. No other model, string, or array independently represents article content.

`state.blog` is rendered only through the centralized `syncBlogFromDocument()` / `renderArticleDocument()` function. Direct `state.blog = ...` assignments are forbidden outside that renderer.

## Pipeline

Post-assembly processing is owned by `blog-generation-pipeline.ts`. Every stage:
- Accepts and returns `PipelineState`
- Captures its own direct-input integrity baseline
- Runs its mutation internally
- Accepts or restores its direct-input fallback internally
- Records genuine before/after fingerprints

Full pipeline state (articleDoc, title, metaDescription, counters, normalization state) is restored via `PipelineSnapshot` when a guarded mutation is rejected.

## Final validation

Final article validation uses only `analyzeFinalArticle()` and `evaluatePolicy()` (in `final-article-policy.ts`). All structural invariants, FAQ parity, CTA/signup counts, WordPress block balance, and nested paragraph checks are metrics within `FinalArticleMetrics` and thresholds within `FinalArticlePolicy`. No separate validator, invariant check, or fallback gate overrides this result.

### Hard vs soft validation

Hard failures (block article): WordPress block imbalance, nested paragraphs, malformed headings, severe keyphrase stuffing (>3% density), FAQ block count mismatch, FAQ JSON-LD mismatch, CTA/signup count mismatch, internal link count above max.

Soft warnings (do not block): long paragraphs exceeding sentence limit, keyphrase not in first 100 words, keyphrase density below 0.5%, keyphrase missing from some headings, word count slightly outside tolerance.

`evaluatePolicy()` is the single pass/fail gate. No module may independently reject an article for soft SEO quality issues.

### FAQ requirements

Every blog article must include a visible FAQ section and matching `FAQPage` JSON-LD schema. FAQ is guaranteed by:
- Outline prompt requires final FAQ H2 heading
- Post-outline processing appends FAQ heading if AI omits it
- FAQ-recovery stage extracts visible Q&A, generates `FAQPage` JSON-LD, inserts before conclusion
- Final validation enforces FAQ block count, JSON-LD presence, and visible/schema parity

### Keyphrase policy

Article-wide weighted keyphrase density replaces fixed occurrence ranges:
- `density = (occurrences × kpContentWords / articleWordCount) × 100`
- Below 0.5%: soft warning
- ~1%: preferred target
- Above 3%: hard stuffing failure

Per-section keyphrase budget allocation is removed. No section is forced to contain the exact keyphrase.

### Link policy

Internal links: 0–4 unique B2I Hub blog destinations. `wp:html` blocks stripped before counting (excludes language switcher, CTA, signup, navigation). External source links counted separately. Duplicate destinations prevented.

### Word count policy

User-selected word count treated as tolerance range:
- Below 2,000 words: ±10%
- 2,000 words or more: ±15%
- Both minimum and maximum enforced.

## Route orchestration

`src/app/api/generate-blog/route.ts` is approximately 110 lines and contains only:
- Authentication
- Request validation
- Service invocation (`runBlogGeneration()`)
- Persistence (blog version + project update with compensation rollback)
- Non-fatal AI logging
- Response mapping
- Error handling

## Generation service

All generation and recovery orchestration lives in `src/lib/services/blog-generation-service.ts`. The route does not contain DeepSeek calls, prompt assembly, section generation, retry logic, or recovery.

## AI provider access

All AI provider access goes through `AiService` (in `src/lib/services/deepseek.ts`). `AiService` owns retries, timeouts, metrics, tracing, and token accounting.

`createDeepSeekClient()` is a private function within the `deepseek.ts` module. It must never be imported or called outside `AiService`.

## Authentication

`src/lib/services/auth.ts` is the single authentication authority. `getCurrentUserId()` resolves identity from Supabase-authenticated session cookie or bearer token. No other module may independently resolve user identity.

Client-supplied `x-user-id` headers are ignored. Identity comes only from verified Supabase sessions.

`src/lib/services/project-authorization.ts` provides `requireProjectAccess()` for project ownership checks. It delegates identity resolution to `auth.ts`. No route may duplicate ownership verification or session resolution.

Route handlers import `getCurrentUserId` from `auth.ts` directly. There is no separate identity-resolution function in `project-authorization.ts`.

## Error handling

`src/lib/services/errors.ts` provides the single `AppError` class and the single `toErrorResponse()` converter. All API error responses must be constructed by `toErrorResponse()` only.

`AppError` carries `status`, `code`, `message`, and optional internal `cause`. The `cause` is logged to the server console but never included in API responses.

Routes must not construct `NextResponse.json({ error: ... })` directly. Route-level validation failures use `throw AppError.badRequest(...)`. Ownership failures use `throw AppError.forbidden()`. Not-found conditions use `throw AppError.notFound(...)`. Service failures use `throw AppError.internal(...)`.

Non-`AppError` throws are mapped to a generic 500 response with `{ error: "Internal server error", code: "INTERNAL_ERROR" }`. Internal messages, provider errors, database errors, stack traces, and filesystem paths are never exposed in public responses.

## Build and tests

Current build passes with **842 tests passing and 0 failing** (10 test files).

## Contributor rules

### 1. Do not change the architecture

Implement the requested architecture exactly. Do not replace it with a "cleaner", "simpler", or "more practical" design. If a requested architecture cannot be implemented exactly, stop and explain why instead of choosing a different solution.

### 2. Single ownership only

Every responsibility must have exactly one owner. Never introduce duplicated logic, compatibility layers, legacy execution paths, fallback ownership, or parallel implementations. If ownership moves, remove the previous owner.

### 3. No compatibility wrappers

Do not create wrappers that leave the old implementation in place. When a module is extracted, the original implementation must be removed unless there is a documented migration requirement.

### 4. Canonical state

`ArticleDocument` is the only canonical mutable article representation. `state.blog` is rendered from `ArticleDocument`. No stage may independently mutate rendered HTML and treat it as authoritative.

### 5. Pipeline ownership

All post-assembly processing belongs to `blog-generation-pipeline.ts`. The pipeline owns: expansion, trimming, paragraph normalization, regeneration, internal links, deduplication, language switcher, SEO normalization, FAQ recovery, and final validation. Do not duplicate this logic elsewhere.

### 6. Validation ownership

Final article validation has one path only: `analyzeFinalArticle()` → `evaluatePolicy()` → `runFinalValidation()`. No module may introduce additional pass/fail decisions outside this path.

### 7. AI ownership

All provider interaction must go through `AiService`. No module may create provider clients, implement its own retries, timeout handling, rate limiting, or duplicate AI logging. `createDeepSeekClient()` is private to the AI service.

### 8. Behaviour over implementation

Passing tests are not enough. Every architectural change must include behavioural tests proving the required behaviour. Tests must verify behaviour — not merely that functions exist or are called.

### 9. Do not silently weaken requirements

Never replace requirements such as "every", "single owner", "canonical", or "only" with partial implementations or best-effort behaviour.

### 10. Reports must be factual

Completion reports must reflect the actual implementation. Do not overstate progress, omit known limitations, or describe planned work as completed. Include exact files changed, responsibilities moved, tests added, build result, and test totals.

### 11. Preserve architectural integrity

Every refactor must leave the codebase simpler than before. Never increase architectural debt in order to complete a task. When in doubt: remove duplication, remove obsolete code, remove dead paths, reduce ownership ambiguity. Never add them.

### 12. Deterministic over AI for numbers, dates and currencies

Numbers, percentages, dates and currencies must never depend on the AI repeating them correctly. Before final assembly, every translated component must be scanned for lost or mutated numeric values. Deterministic code — not AI instruction — is the primary safeguard. AI-based number preservation is a best-effort supplement only.

### 13. Targeted retries for predictable AI failures

When a component repeatedly hits the same predictable failure (e.g. introduction consistently exceeds the English threshold for the same source article), the pipeline must have one targeted retry path for that component rather than throwing the entire translation away. The retry uses the same prompt with `temperature: 0.3` and must count against the global retry budget.

### 14. Soft Chinese SEO warnings must never block saving

Chinese SEO warnings (title/metadata outside preferred range, character count slightly outside range, keyphrase slightly outside density) are quality targets only. Only hard failures (number loss, completeness below threshold, FAQ count outside 4-6, English blocks, missing CTA, malformed FAQ schema) may prevent saving.

### 15. Chinese SEO must use the saved Chinese keyphrase

The Chinese SEO audit must receive its keyphrase from the saved version's `excerpt` field (which stores the AI-translated Chinese keyphrase). It must not fall back to the English project keyword. If the saved `excerpt` contains a valid CJK keyphrase, the audit must use it for all keyphrase checks.

### 16. Three consecutive clean real translations are still required

No set of fixes is complete until three consecutive production translations each: save successfully, pass all hard checks, and score at least 90 on the Chinese SEO audit. Unit tests, fixtures, and manual API calls that skip the full route do not count.

### 17. "AI limitation" is not the final answer where deterministic safeguards apply

If a numeric mismatch, English leakage, or FAQ-count variation can be prevented by deterministic code (pre-verification, regex stripping, forced truncation, or code-level fallback), then the fix must be deterministic, not a prompt change. "The model sometimes drops numbers" is not acceptable when a pre-save number scan and targeted regeneration can fix it. Every deterministic option must be exhausted before attributing a failure to model capability.

## Handoff

Current state (2026-07-27):

### Translation Pipeline Refactor
- **Module split**: `translation-service.ts` (orchestration only), `translation-ai.ts` (AI calls, prompts, retry budget), `translation-validator.ts` (number protection, English leakage, completeness), `translation-assembler.ts` (FAQ schema, source localisation, internal-link localisation), `translation-types.ts` (shared types).
- **AiService** remains the single AI gateway; `createDeepSeekClient()` is private.
- **Deterministic number protection**: `protectNumbersInHtml()` replaces all numbers/percentages/currencies/dates with `__NUM_N__` placeholders before translation; `tryRestoreNumbersInHtml()` verifies every placeholder survives, restores original values, hard-fails on missing/duplicated placeholders.
- **Introduction English retry**: One-shot retry with `INTRO_RETRY_STRICT` if `hasExcessiveEnglish()` detects English prose. 
- **FAQ source-count preservation**: `translationFaqCount(sourceFaqCount)` — Chinese FAQ count must EXACTLY equal English source. No trimming, no padding, no regeneration. `faq-count` hard-fails on mismatch.
- **Section number retry**: One-shot retry for sections, introduction, and conclusion when `tryRestoreNumbersInHtml` detects lost placeholders.
- **Metadata range compliance**: Title/meta retry with exact CJK range requirement when outside bounds. No filler padding — hard-fail if retry fails. One deterministic cleanup pass (trim trailing punctuation only).
- **FAQ boundary validation**: Dynamic token budget based on input size. `finish_reason=length` is an immediate throw. Answers rejected if they contain signup URLs, CTA text, conclusion text, FAQPage schema, headings, `<strong>` markup, or are >3× source length. Exact source count and one-to-one order enforced.
- **CTA max_tokens**: 4096 (was 2048) to prevent truncation.

### Content Standards (canonical, in `src/lib/content-standards.ts`)
- `englishWordTolerance(n)`: ±10% below 2k, ±15% at/above 2k
- `dynamicH2Range(n)` / `dynamicFaqRange(n)`: 6 bands from 500–5,000 words (3-4 to 8-9 H2s, 2-3 to 5-7 FAQs)
- `englishTitleRange()`: 50–70; `chineseTitleRange()`: 25–35
- `englishMetaRange()`: 155–200; `chineseMetaRange()`: 80–120
- Keyphrase density: `englishKeyphraseDensity()` / `chineseKeyphraseDensity()` — below 0.5% warning, 0.5–1.5% preferred, above 3% hard failure
- `paragraphSentenceLimit()`: 3
- `internalLinkRange()`: 0–4; `externalLinkRange()`: 0–Infinity
- `chineseCharRange(n)`: preferred 1.80×, pass 1.52–2.20×, hard min 1.28×
- `translationFaqCount(n)`: exact preservation
- `computeKeyphraseDensity()` / `computeKeyphraseTargets()` / `getKeyphraseContentWordCount()`
- Integrated into English pipeline (prompt-builder, final-article-policy, final-seo-normalizer, component-regenerator, section-expander, quality-scorer, seo-auditor runAudit). Not yet integrated into Chinese SEO.

### English Pipeline
- Pipeline order: expansion → trim → paragraphs → regeneration → external-links → internal-links → seo-normalization → factual-scan → link-enforce → final-trim → faq-recovery → paragraphs-final → cta-preserve → wc-check → final-validation
- `cta-preserve` always re-injects canonical CTA when damaged (not just when `articleDoc.cta` is null), then rebuilds FAQ schema from current visible FAQ.
- `wc-check`: post-CTA word count trim that also rebuilds FAQ schema.
- `runTrackedHtmlStage` flattens nested `<p>` before stage validation using `detectNestedParagraphs` + iterative unwrap.
- `runFinalValidation` passes title/meta to analyzer, tolerates ±1 H2 and 1 long paragraph.
- `splitSentences` (in `seo-text-utils.ts`): character-by-character sentence detector used by both `countSentences` and `splitLongParagraphs` for unified sentence detection.
- `countLongParagraphs` / `splitLongParagraphs` both use `splitSentences` from `seo-text-utils.ts`.

### Chinese SEO
- Uses canonical thresholds from `content-standards.ts` via `chineseTitleRange()`, `chineseMetaRange()`, `chineseKeyphraseDensity()`, `paragraphSentenceLimit()`, `internalLinkRange()`.
- Unified density: both `keyphrase_count` and `keyphrase_density` checks use the same `zhDensity` calculation.
- FAQ parity: structure-only validation (counts match + no empty answers) — exact text comparison removed as too fragile.
- Paired English version: `summary` field stores `source-en-version:<id>`; SEO audit route reads this to find exact paired version. Legacy fallback: slug matching (strip `-zh`).
- Paired English FAQ: falls back to `extractVisibleFaqFromArticle(enBlog)` when DB `faq` field is empty.
- Chinese keyphrase: taken from saved version's `excerpt` field. If empty or lacks CJK, route returns clear error — never falls back to English project keyword.

### Retry Budget
- `RetryBudget` class scoped per `translateArticle()` call. 12 shared retries.
- `record()` only sets `exhausted=true` when `remaining <= 0` (not on `capped` flag). The `capped` (budget cut-off) flag is logged but does not set exhaustion state.
- `chatWithRetry` in `deepseek.ts` now populates `result.attemptsUsed` with the actual number of retries consumed.
- Logging shows actual retries used, not allowance difference.

### Save / Readback / Version Filtering
- `blogVersionRepository.findById(id)` added for post-save readback.
- Both translate and generate-blog routes do `create` → `findById` → 201 only if readback succeeds.
- `GET /api/projects/[id]/versions?language=en|zh` filters by slug suffix.
- UI pages: English SEO uses `.filter()` for immediate display; project pages can pass `?language=en` or `?language=zh`.
- Outdated detection: compares `_auditedVersionId` from server against latest matching-language version's ID.
- UI uses server-provided `overallScore` (weighted category-based) instead of recalculating simple average.

### Hard vs Soft Validation
**Hard failures (block saving):** Word count outside tolerance, H2 count outside dynamic range, FAQ entry count outside dynamic range, any paragraph exceeding sentence limit, keyphrase density >3% (stuffing), more than 4 internal links, FAQ block/schema/parity failures, CTA/signup/switcher missing, WordPress block mismatch, nested paragraphs, malformed headings.

**Soft warnings (never block):** Keyphrase density <0.5%, keyphrase not in H2, keyphrase not in first 100 words, title/meta near misses, reading level outside target.

### Tests
- **842 tests passing, 0 failing** (10 files: 7 existing + content-standards.test.ts + verify-word-count-tiers.test.ts + regression-issues.test.ts)
- All 6 word-count tiers verified (500, 1000, 1500, 2500, 3500, 5000 words) across content-standards, policy builder, boundary tests, SEO audit, Chinese SEO audit, and version filtering.
- 3 consecutive production translations confirmed passing (versions 24-26).

### Known Issues
- DeepSeek v4 `empty_response` on prompts under ~500 input tokens (mitigated by padding).
- Supabase Node.js 20 deprecation warning (non-blocking).
- Chinese translation AI output quality varies per run (number preservation, English leakage). Targeted retries mitigate but do not eliminate.

### Safe Starting Points
- `src/lib/pipeline/blog-generation-pipeline.ts` for English pipeline stages
- `src/lib/services/translation-service.ts` for Chinese translation orchestration
- `src/lib/services/translation-ai.ts` for AI calls and prompts
- `src/lib/services/translation-validator.ts` for number protection and validation
- `src/lib/services/translation-assembler.ts` for FAQ schema and source localisation
- `src/lib/services/seo-auditor.ts` for both English and Chinese audits
- `src/lib/blog/final-article-policy.ts` for canonical validation
- `src/lib/content-standards.ts` for all canonical thresholds
- `src/lib/seo/seo-text-utils.ts` for canonical text extraction and sentence splitting
