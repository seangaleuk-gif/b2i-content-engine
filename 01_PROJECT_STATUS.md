# B2I Content Engine — Current Project Status

**Date:** 1 August 2026

> **Authoritative handoff:** `NEW_CHAT_HANDOFF.md`. This file is a summary of current status; see the handoff for the full verified state.

## Product

B2I Content Engine is a private content-generation application for B2I Hub, a Hong Kong platform connecting local SMEs and creators directly. The engine generates SEO-focused English WordPress articles and Traditional Chinese translations.

## Current stack

- Next.js 16.2.10
- TypeScript
- Supabase
- DeepSeek API (`deepseek-v4-flash`)
- Brave Search (research provider)
- Canonical article representation: `ArticleDocument`
- WordPress block output

## Current verified state

### Build and runtime

- `npm run build`: passes (26/26 static pages).
- Application routes compile and production startup succeeds.

### DeepSeek request layer (protected)

- Every request explicitly sends `thinking: { type: "enabled" | "disabled" }`.
- Routine generation, repair, metadata, and translation stages use thinking disabled.
- Reserved high-level reasoning stages use thinking enabled.
- No request relies on the provider default; routine calls show `reasoning_tokens=0` and complete on attempt one.
- Every `finish_reason: "length"` response is rejected as truncated; partial JSON never reaches parsers.
- Token escalation remains a capped emergency fallback (max 32,768).

### English generation (production verified)

The latest fresh live English generation passed final validation:

```text
editorial score=94 (minimum: 80)
repeatedPairs=0
malformed=0
FAQ parity valid=true canonical=6 rendered=6 schema=6
external links=6
internal links=4
keyphrase density=1.08%
word count in range (2125-2875)
final validation PASS
```

Also verified in that run:

- Auto-research and external-link generation working (research dispatch `willRun=true`, links injected/retained/saved/counted).
- Keyphrase exclusion consistent across editorial and final validation.
- FAQ and malformed consistency fixes hold through the full pipeline.

### Translation (live verified)

- Traditional Chinese is the only translation target. Simplified Chinese is out of scope.
- Latest live translation saved successfully: project 19, version 6, saved ID 202; 40 API calls, 0 retries, 26 deterministic editorial changes; `deepseek-v4-flash`, thinking disabled.
- Structural translation works: full article saved; no duplicated article; source-label and paragraph punctuation fixed; FAQ/schema parity preserved; CTA preserved; links and protected content preserved; natural HK code-switching allowed.

### Research and external links (live verified)

- Automatic research dispatch runs when no approved research rows exist; manual research suppresses it; provider failures degrade with a clear warning.
- External links are injected from approved research sources with diagnostics; zero-eligible warnings are surfaced.
- `externalLinks` metadata reflects the real final article.

## Current blockers

None blocking. The next task is a translation-pipeline architecture audit (see `NEW_CHAT_HANDOFF.md` section 2).

## Pre-existing technical debt

- 18 failing tests (unchanged baseline, no new regressions) — see `07_TEST_BUILD_LINT_STATUS.md`.
- 2 TypeScript errors in `section-expander.test.ts`.
- 468 lint findings (285 errors / 183 warnings).

## Acceptance sequence

1. English generation is the protected baseline (verified).
2. Finish automatic research/external-link live verification.
3. Run and audit one Traditional Chinese translation.
4. Manual article inspection before each production claim.
