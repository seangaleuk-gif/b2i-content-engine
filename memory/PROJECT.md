# B2I Content Engine — Project Overview

## Purpose
AI-powered content creation workflow for B2I Digital. Automates blog writing from research through publishing, with AI-driven SEO analysis, image generation, and social media content creation.

## Current Development Phase
**Phase 7 — Eliminate Remaining AI Weaknesses** (Jul 27, 2026) — Completed

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
| Stage 7 — Canonical Standards, Pipeline Hardening, Chinese Translation Refactor | Complete | Jul 27, 2026 |

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

## Current State (2026-07-27)

### Build & Tests
- **Build**: Pass
- **Tests**: 842/842 (10 test files)

### Key Achievements (Stage 7)
- **Canonical content standards** — single `content-standards.ts` for all thresholds
- **Translation pipeline refactor** — 5-module split with clean responsibilities
- **Deterministic number protection** — placeholder-based with targeted retries
- **FAQ boundary validation** — dynamic token budget, content scanning, exact source count
- **Metadata range compliance** — retry with exact range, hard-fail on failure, no filler
- **Unified sentence detection** — `splitSentences` shared across pipeline and validation
- **Paired English version tracking** — `summary` field stores source version ID
- **Retry budget fixed** — `capped` flag no longer sets exhaustion
- **CTA always re-injected** — not gated on null check
- **3 consecutive production translations** — versions 24-26 passed all checks
- **842 tests** — 10 files, all passing

### Known Active Issues
1. DeepSeek v4 `empty_response` on small prompts — mitigated with padding
2. Supabase Node.js 20 deprecation warning — non-blocking
3. Chinese translation AI output quality varies — targeted retries mitigate

### Next Priority
Phase 8: WordPress Integration (Actual Publishing) — see TODO.md
