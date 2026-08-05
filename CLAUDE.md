@AGENTS.md

B2I Content Engine — See AGENTS.md and B2I-MASTER-HANDOFF-2026-07-31.md for the full architecture and current verified state. Key entry points:
- `src/app/api/generate-blog/route.ts` — route handler (~110 lines, orchestration only)
- `src/lib/services/blog-generation-service.ts` — generation, research dispatch, recovery
- `src/lib/pipeline/blog-generation-pipeline.ts` — post-assembly pipeline
- `src/lib/pipeline/editorial-polish.ts` — editorial repair (malformed/weakened/repetition/general), repetition pair targeting, deterministic fallback
- `src/lib/blog/article-document.ts` — canonical article model + HTML parser
- `src/lib/blog/final-article-policy.ts` — centralized validation (hard vs soft)
- `src/lib/blog/publication-quality.ts` — editorial scorer, repeated-pair detector, robotic phrases
- `src/lib/blog/final-seo-normalizer.ts` — SEO normalization (density-based)
- `src/lib/services/deepseek.ts` — `AiService` (sole AI provider access)
- `src/lib/services/brave.ts` — Brave research provider (automatic research dispatch)
- `src/lib/services/article-postprocessors.ts` — external-link injection, language switcher
- `src/lib/services/auth.ts` — single authentication authority
- `src/lib/services/project-authorization.ts` — project ownership checks
- `src/lib/services/errors.ts` — `AppError` + `toErrorResponse()` (single error model)
- `src/lib/services/text-utils.ts` — `rebalanceWpBlocks()` (stack-based WP block validation)
- `src/lib/blog/protected-block-extractor.ts` — FAQ/CTA extraction and stripping
- `src/lib/blog/article-integrity.ts` — integrity baselines and validation
- `src/lib/services/generation-constants.ts` — density-based keyphrase targets, word count tolerances
- `src/lib/services/section-expander.ts` — AI section expansion with block rebalancing
- `src/lib/services/link-injector.ts` — internal link injection (0–4 unique destinations)
