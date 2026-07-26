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

Current build passes with **481 tests passing and 0 failing**.

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

Current state (2026-07-26):
- Route orchestration extracted to ~110 lines
- Pipeline module handles all post-assembly stages with fingerprint tracking; order: expansion → trim → paragraphs → regeneration → language-switcher → external-links → external-dedup → internal-links → seo-normalization → title-repair → factual-scan → link-enforce → final-trim → faq-recovery → paragraphs-final → cta-preserve → final-validation
- ArticleDocument is the canonical article model with HTML parser
- FinalArticlePolicy centralizes all validation rules (hard vs soft)
- AiService centralizes all AI provider access; `ChatResult` now includes `finishReason`
- auth.ts is the single authentication authority; x-user-id headers are ignored
- project-authorization.ts provides requireProjectAccess() only; delegates identity to auth.ts
- AppError + toErrorResponse() is the single error model; no route-local error response construction
- Article-wide keyphrase density replaces fixed occurrence ranges; per-section quotas removed
- Word count uses tolerance ranges: ±10% below 2,000, ±15% at 2,000+
- Internal links: 0–4 unique B2I Hub destinations; external links counted separately
- FAQ guaranteed: outline requires FAQ H2, post-processing appends if missing, recovery generates JSON-LD
- Long paragraphs and keyphrase-in-first-100 are soft warnings, not hard failures
- Visibility metrics strip wp:html and scripts before counting
- Single signup CTA enforced with structural extraction + fallback stripping
- `rebalanceWpBlocks()` with stack-based matching validates WP blocks at 3 boundaries
- `verifyStructuralIntegrity` checks WP blocks and language switcher only; FAQ/CTA completeness deferred to final validation
- Protected blocks tokenized/detokenized; `<a>` tag and `<strong>` FAQ extraction handle multiple formats
- **Chinese translation pipeline**: 12 normal API calls (metadata+keyphrase, title, introduction, 6× combined H2+body sections, conclusion, FAQ, CTA). RetryBudget (12 shared retries, per-request scoped). Fallback keyphrase translation via single `translateText` call if combined metadata JSON fails. Metadata padded with introduction text to exceed 500-token empty_response threshold.
- **Chinese SEO audit**: `runChineseAudit()` in `seo-auditor.ts`. Chinese-specific ranges (title 25-35, meta 80-120, body 3800-5500, hard fail <3200). Flesch N/A (excluded from scoring). CJK keyphrase guard. FAQ audits only last `FAQPage` block, enforces parity, retries on length-truncation.
- **Version/language filtering**: English SEO finds latest non-`-zh` version; Chinese finds latest `-zh`. Category prefix `zh-` separates storage. `?language=en|zh` on GET /seo.
- **Hard validation gate**: Translation route blocks save on any `failedComponents` (was missing — critical fix). Number mismatches, completeness failures, FAQ count outside 4-6, CTA without CJK text, meta-description failures all prevent saving.
- **Assembly fixes**: English FAQPage schemas stripped from section bodies before render. CTA CJK check. FAQ count 4-6 enforcement. Same-array visible FAQ + schema.
- **Cost optimizations**: `MAX_RETRIES=0` (was 1). translateText 512 tok, CTA 1024 tok, FAQ 4096 tok. Dead `METADATA_ZH_SYSTEM` and `{keyphrase}` placeholder removed.
- **Tests**: 620 passing (7 files), 0 failing
- Safe starting points: `src/lib/pipeline/blog-generation-pipeline.ts` for English pipeline stages; `src/lib/services/translation-service.ts` for Chinese translation flow; `src/lib/services/seo-auditor.ts` for both English and Chinese audits
