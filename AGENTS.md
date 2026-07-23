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

Current build passes with **390 tests passing and 0 failing**.

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

## Handoff

Current state (2026-07-23):
- Route orchestration extracted to ~110 lines
- Pipeline module handles all post-assembly stages with fingerprint tracking
- ArticleDocument is the canonical article model with HTML parser
- FinalArticlePolicy centralizes all validation rules
- AiService centralizes all AI provider access
- auth.ts is the single authentication authority; x-user-id headers are ignored
- project-authorization.ts provides requireProjectAccess() only; delegates identity to auth.ts
- AppError + toErrorResponse() is the single error model; no route-local error response construction
- Safe starting point: `src/lib/pipeline/blog-generation-pipeline.ts` for pipeline stages, `src/lib/services/blog-generation-service.ts` for generation flow
