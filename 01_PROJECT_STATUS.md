# B2I Content Engine — Current Project Status

**Date:** 31 July 2026

## Product

B2I Content Engine is a private content-generation application for B2I Hub, a Hong Kong platform connecting local SMEs and creators directly. The engine generates SEO-focused English WordPress articles and Traditional Chinese translations.

## Current stack

- Next.js 16.2.10
- TypeScript
- Supabase
- DeepSeek API
- Current generation model: `deepseek-v4-flash`
- Canonical article representation: `ArticleDocument`
- WordPress block output

## Current verified state

### Build and runtime

- `npm run build`: passes.
- `next start`: starts successfully.
- Application routes compile and production startup succeeds.

### DeepSeek request layer

The excessive reasoning-token problem has been repaired:

- Every request now explicitly sends `thinking: { type: "enabled" | "disabled" }`.
- Routine generation, repair, metadata, and translation stages use thinking disabled.
- Reserved high-level factual/evidence/quality diagnosis stages use thinking enabled.
- No request relies on DeepSeek's provider default.
- Routine production calls now show `reasoning_tokens=0` and generally complete on attempt one.
- Any `finish_reason: "length"` response is treated as truncated and unusable, even when it contains partial content.
- Partial JSON is never returned to the parser.
- Token escalation remains an emergency fallback.

### Latest real English generation

The latest run completed all DeepSeek generation and post-processing stages quickly, but final validation rejected the article:

```text
Final validation failed: FAQ parity mismatch; malformed prose issues=1; editorial score=36 (minimum: 80); [SOFT] no H2 keyphrase
```

Therefore:

- English generation is **not yet passing end to end**.
- Translation must not be acceptance-tested until English generation passes and the article is inspected.
- The soft missing-H2-keyphrase warning was not the cause of failure.

## Current blockers

1. FAQ parity mismatch between the canonical FAQ, rendered FAQ body, and FAQ schema.
2. A malformed paragraph survives successful repair calls and reaches final validation.
3. Editorial candidates are rejected, leaving the original article at score 36.

## Important baseline correction

`B2I-Content-Engine-Nuclear-Fix-v2-Malformed-Prose-Repair.zip` produced a decent article previously, but it is not a currently verified working baseline in the present environment. Do not restore it blindly or describe it as production ready.

## Current acceptance sequence

1. Fix FAQ parity and malformed repair persistence only.
2. Run targeted tests, full suite, TypeScript validation, and production build.
3. Generate one English article.
4. Inspect article quality and final audit.
5. Only after English passes, test Traditional Chinese translation.
