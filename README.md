# B2I Content Engine

Automated blog article generation for the B2I Hub platform.

## Architecture

| Layer | Module | Responsibility |
|-------|--------|---------------|
| Route | `src/app/api/generate-blog/route.ts` | Auth, validation, persistence, response |
| Service | `src/lib/services/blog-generation-service.ts` | Generation, recovery, orchestration |
| Pipeline | `src/lib/pipeline/blog-generation-pipeline.ts` | Post-assembly stages with fingerprints |
| Document | `src/lib/blog/article-document.ts` | Canonical article model + HTML parser |
| Validation | `src/lib/blog/final-article-policy.ts` | `analyzeFinalArticle()` + `evaluatePolicy()` |
| AI | `src/lib/services/deepseek.ts` | `AiService` — single AI provider gateway |
| Auth | `src/lib/services/auth.ts` | `getCurrentUserId()` — single identity resolver |
| Authorization | `src/lib/services/project-authorization.ts` | `requireProjectAccess()` — project ownership |
| Errors | `src/lib/services/errors.ts` | `AppError` + `toErrorResponse()` — single error model |

## Getting Started

```bash
bun install
bun run build
bun test
```

## Key rules

- `ArticleDocument` is the single canonical article state
- `state.blog` is rendered only through `renderArticleDocument()`
- Final validation uses only `analyzeFinalArticle()` and `evaluatePolicy()`
- AI calls go through `AiService` only
- Identity is resolved only by `getCurrentUserId()`; x-user-id headers are ignored
- All API error responses go through `toErrorResponse()`; no route-local error construction
- Internal error details are never exposed in API responses
- No compatibility wrappers, stubs, or legacy execution paths
- Build: 390 tests passing, 0 failing
