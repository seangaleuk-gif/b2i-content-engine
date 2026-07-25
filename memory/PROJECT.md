# B2I Content Engine — Project Overview

## Purpose
AI-powered content creation workflow for B2I Digital. Automates blog writing from research through publishing, with AI-driven SEO analysis, image generation, and social media content creation.

## Current Development Phase
**Phase 7 — Eliminate Remaining AI Weaknesses** (Jul 25, 2026)

| Phase | Status | Completed |
|-------|--------|-----------|
| Phase 1 — Frontend UI | Complete | Jul 16, 2026 |
| Phase 2 — Backend Foundation | Complete | Jul 16, 2026 |
| Phase 3 — Research Engine | Complete | Jul 16, 2026 |
| Phase 4 — Blog Generation | Complete | Jul 17, 2026 |
| Phase 5 — SEO, WordPress & Media | Complete | Jul 19, 2026 |
| Phases 1–7 (Pipeline Reliability) | Complete | Jul 20, 2026 |
| Section Lifecycle & SEO Audit Rewrite | Complete | Jul 21, 2026 |
| Keyphrase Budgets & Dynamic SEO Ranges | Complete | Jul 22, 2026 |
| Translation Pipeline (Component-based) | Complete | Jul 24, 2026 |
| Source Localisation & Number Equivalence | Complete | Jul 24, 2026 |

## Features Completed

### Frontend
(unchanged — see previous versions)

### Backend
(unchanged — see previous versions)

### Research Engine
(unchanged — see previous versions)

### Blog Generation (Phase 4)
- **DeepSeek Chat** — AI LLM integration for structured JSON blog content generation
- **Section-by-section generation** — Phased pipeline: Outline → Introduction → H2 Sections → FAQ → Conclusion → Assemble
- **Prompt Builder** — 10 composable, user-editable prompt sections
- **Deterministic Editing Pipeline** — surgical fixers (title, keyphrase, density, readability)
- **Final SEO Normalizer** — tokenization-based protected block preservation, multi-pass keyphrase reduction, paragraph splitting
- **Article integrity pipeline** — structural validation at every mutation stage
- **Internal Linking System** — link injection, sync, suggestions, default links

### Translation Pipeline (Phase 5 — rewritten Jul 24)
- **Component-based translation** — replaces one-shot `json_object` with per-section AI calls via `ArticleDocument`
- **FAQ section detection** — heading text pattern (`faq`, `frequently`, `常見`, `問題`, `問答`, `常見問題集`)
- **FAQPage JSON-LD rebuild** — rebuilt from translated visible FAQ via `renderArticleDocument()`
- **CTA display text localisation** — translates visible CTA text preserving HTML, CSS, URLs, attributes
- **Number preservation** — per-component exact normalized occurrence matching with unit-aware scaling (`1.2 million` ↔ `120萬`)
- **Source localisation** — authoritative domains preserved; research-based replacement with content-similarity threshold
- **Internal-link localisation** — checks for existing `-zh` slug versions, localises only when real Chinese version exists
- **Chinese-aware length metrics** — CJK character count, Latin word count, paragraph count, reading time

### Word Count System
- **`countReadableWords()`** — strips WordPress blocks, HTML, JSON-LD, scripts
- **`formatWordCount()`** — slug-aware display: English → "words", `-zh` → "Chinese characters"
- **`extractScaledNumbers()`** — unit-aware number extraction (`million`/`萬`, `billion`/`億`, `HK$`/`港元`)
- **Word count hard failure** — `evaluatePolicy()` blocks articles outside 2,125-2,875 range

### Pipeline Reliability Refactor (Phases 1–7, Jul 20, 2026)
(unchanged — see previous versions)

## Features Remaining

### Phase 6 — Social Media Publishing (not started)
- AI social post generation
- Platform-specific formatting
- Scheduling and publishing

## Overall Workflow
(unchanged — see previous versions)

## Current State (2026-07-25)

### Build & Tests
- **Build**: Pass
- **Tests**: 586/586 (7 test files)

### Known Pipeline Bugs (requires fix)

1. **CTA loss after `syncBlogFromDocument()`** — `cta-preserve` stage re-injects the CTA into `state.blog` (HTML string) but NOT into `state.articleDoc.cta`. When `factual-scan` or `final-trim` calls `syncBlogFromDocument()`, the HTML is rebuilt from `ArticleDocument` and the re-injected CTA is lost. Final validation then fails with `cta headings=0; signup URLs=0`.

2. **FAQ parity mismatch** — FAQPage JSON-LD is rebuilt from visible FAQ during `faq-recovery`, but `paragraphs-final` (which splits long paragraphs) runs AFTER it. Splitting FAQ paragraphs can change the visible FAQ paragraph structure, causing the schema to no longer match the visible Q&A.

3. **Word count validation inconsistency** — `evaluatePolicy` includes `wcHard` (rejects outside 2,125-2,875), but articles above 2,875 still return `201`. Suspected root cause: `guardStageOutput` in `runTrackedHtmlStage` may restore a pre-validation snapshot after validation passes, replacing `state.blog` with an earlier unsplit version. The route's `finalWordCount` is computed from the restored HTML, bypassing the validated word count.

4. **DeepSeek `deepseek-chat` model name** — API now requires `deepseek-v4-flash` or `deepseek-v4-pro`. Default was changed in `deepseek.ts:132` and `playground/route.ts:23`.

5. **Paragraph splitting lost by later stages** — Fixed by moving `paragraphs-final` to last content-changing position, but `cta-preserve` and `faq-recovery` still run after `final-trim` and can modify content post-split.

### Next Priority
1. Fix CTA loss — move `cta-preserve` after all `syncBlogFromDocument()` stages
2. Fix FAQ parity — run `paragraphs-final` BEFORE `faq-recovery`, or ensure FAQ schema is rebuilt after paragraph splitting
3. Fix word count validation — use one shared counting function everywhere; ensure `state.blog` is the validated HTML at save time
4. Run 3 consecutive production generations with all checks passing
