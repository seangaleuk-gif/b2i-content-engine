@AGENTS.md

B2I Content Engine — See AGENTS.md for full architecture. Key entry points:
- `src/app/api/generate-blog/route.ts` — route handler (~110 lines, orchestration only)
- `src/lib/services/blog-generation-service.ts` — generation and recovery
- `src/lib/pipeline/blog-generation-pipeline.ts` — post-assembly pipeline
- `src/lib/blog/article-document.ts` — canonical article model
- `src/lib/blog/final-article-policy.ts` — centralized validation
- `src/lib/services/deepseek.ts` — `AiService` (sole AI provider access)
