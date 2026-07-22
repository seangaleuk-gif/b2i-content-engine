# B2I Content Engine — Project Overview

## Purpose
AI-powered content creation workflow for B2I Digital. Automates blog writing from research through publishing, with AI-driven SEO analysis, image generation, and social media content creation.

## Current Development Phase
**Phase 7 — Eliminate Remaining AI Weaknesses** (Jul 20, 2026)

| Phase | Status | Completed |
|-------|--------|-----------|
| Phase 1 — Frontend UI | Complete | Jul 16, 2026 |
| Phase 2 — Backend Foundation | Complete | Jul 16, 2026 |
| Phase 3 — Research Engine | Complete | Jul 16, 2026 |
| Phase 4 — Blog Generation | Complete | Jul 17, 2026 |
| Phase 5 — SEO, WordPress & Media | Complete | Jul 19, 2026 |
| Phases 1–7 (Pipeline Reliability) | Complete | Jul 20, 2026 |

## Features Completed

### Frontend
- Dashboard with stats cards, recent projects, activity feed, resource gauges
- Projects list with search, filtering, and status badges
- Project workspace (3-column: workflow steps, markdown editor, context panel)
- 10-stage workflow stepper: Research, Blog Generation, Competitor Analysis, Outline, Blog, SEO Audit, Images, Social, Translation, Publish
- Workflow progress computed from project data (research done, blog content, SEO checks, images, social posts)
- Blog View as a standalone tab page (`/projects/[id]/blog`) — not part of the stepper
- Dynamic workflow stepper — step statuses (complete/in-progress/pending) and progress bar computed from actual project data
- Auto-redirect to Research step for newly created projects
- Research page with 4 category views (Web Results, Discussions, FAQ, News) powered by Brave Search API
- SEO audit page with working Run Audit button, score gauge, category breakdown, and 12 detailed check cards
- Image generator (Featured, Social, Facebook cards) with prompt editing + Copy button fix
- Social media generator (Threads, Facebook, LinkedIn, Instagram, Newsletter)
- Knowledge base with tag badges and detail panel
- Prompt library with variable substitution and two-pane view
- Settings page — 7 tabs: General, AI, WordPress, SEO, Appearance, Security, Links
- Internal Links admin page (`/settings/links`) — stats, table, add/edit modal, pending suggestions with approve/reject
- Blog View page (`/projects/[id]/blog`) — renders published blog with WordPress block stripping, FAQ cards, internal/external link rendering
- Lottie-compatible loading skeletons across all pages
- Modal component (backdrop blur, ESC close) + NewProjectModal (Topic, Keyword, Audience, Country fields)
- AI Playground page — interactive prompt testing with live generation preview
- Blog Generator — generate button on workspace with loading/progress states + autosave

### Backend
- Supabase Auth (email/password login, OAuth callback, sign-out)
- Next.js 16 proxy for session management and route protection
- PostgreSQL database with 14 tables (profiles, projects, knowledge_items, prompts, research_sources, seo_checks, images, social_posts, activity_log, prompt_sections, blog_versions, ai_logs, internal_links, suggested_links)
- Supabase REST API data layer (via `@supabase/supabase-js` client with service role key) — replaced Drizzle ORM direct Postgres connection to resolve pooler DNS issues
- Drizzle ORM schema definitions retained as TypeScript types
- Row-Level Security (RLS) on all tables with per-user isolation
- Auto-profile trigger on user signup
- Auto-updated_at trigger on timestamped tables
- 14 repository modules with full CRUD methods
- 47 API routes across 13+ pages
- Brave Search API integration for web research (replaced Serper)
- camelCase ↔ snake_case normalization in api-client.ts (client-side) and toSnakeCase helpers in repositories (server-side)

### Research Engine (Phase 3 — updated Phase 5)
- **Brave Search API** (replaced Serper) — GET request with `X-Subscription-Token` header
- Research generation endpoint (POST /api/projects/[id]/research/generate)
- Clears old research before each new generation
- Activity logging for research events
- 4 category views: Web Results, Discussions, FAQ, News
- Working Generate button with loading/error/success states

### Blog Generation (Phase 4)
- **DeepSeek Chat** — AI LLM integration for structured JSON blog content generation
- **Section-by-section generation** — phased pipeline: Outline → Introduction → H2 Sections → FAQ → Conclusion → Assemble. Each section is a separate, focused DeepSeek call (maxTokens: 4096-8192 vs old 32768 single-shot).
- **Prompt Builder** — assembles system and user prompts from 10 composable, user-editable prompt sections (brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure, social_rules, image_rules, translation_rules, cta, publish_checklist)
- **NON-NEGOTIABLE HARD REQUIREMENTS** block at top of user message (title 50-70, dynamic keyphrase count, H2 keyphrase, Flesch 60-70) with PRE-OUTPUT VALIDATION checklist
- **Per-component keyphrase budgets** — deterministic 4-phase allocator distributes article-wide target across components. Each component prompt receives local budget preventing individual sections from trying to satisfy the article-wide target.
- **Dynamic keyphrase range** — `keyphraseRangeForWordCount()` replaces static 3-5. Ranges scale with word count (800 words: 3-5, 2500: 8-15, 3500: 10-20). Density-aware scoring prevents contradictory count/density results.
- **Internal Linking Instructions** — 3-5 UNIQUE internal links, max 5, language switcher excluded
- **MANDATORY OUTPUT REQUIREMENTS** at end (CTA, links, FAQ schema, language switcher, meta 155-200)
- **Prompt Sections** — pre-seeded defaults via `default-prompts.ts`, force-upserted on every generation via `seedDefaults()`, UNIQUE constraint on (user_id, section_key)
- **Blog Versions** — sequential versioned content storage per project (title, slug, meta_description, blog, faq, links, categories, tags, reading_time, word_count, token_usage, etc.)
- **Deterministic Editing Pipeline** — `src/lib/services/fixers.ts` with 4 surgical fixers (title, H2 keyphrase, density, readability) using escalating specificity (general → location → replacement), diff mindset, protected sections, exact deltas. Chain: validate → fixer → re-validate → repeat.
- **Post-generation validation** — server-side checks after generation: title length, keyphrase count, H2 keyphrase presence, Flesch Reading Ease. Blog rejected (422) if any fail after targeted fixers.
- **Final SEO Normalizer** — tokenization-based protected block preservation, multi-pass keyphrase reduction, paragraph splitting, readability improvement. Runs after all post-processing, before save.
- **Article integrity pipeline** — structural validation at every mutation stage. Baseline captured post-assembly, verified after each stage. Final invariant check before save (CTA=1, signup=1, FAQ=1, balanced WP blocks).
- **CTA/FAQ extraction** — bounded search prevents overmatching across WordPress blocks. Conclusion-only extraction for CTA blocks.
- **Version badge** — displays current version (v1, v2, v3) in workspace toolbar + editor area, updates on generation/restore/URL param
- **Autosave** — debounced automatic content persistence in the project workspace editor
- **Generator Progress** — loading states and progress feedback during blog generation
- **AI Playground** — `POST /api/playground` endpoint + `/playground` page for raw prompt testing

### SEO Audit Engine (Phase 5 — Rewritten Jul 21)
- **14-check weighted analysis** — SEO Title Length, Meta Length, Keyphrase in SEO Title (not H1 — checks `title` field), Body Word Count, Keyphrase in First 100 Words, Exact Keyphrase in H2 (exact + close-variant matching), Exact Keyphrase Count (separate from density), Keyphrase Density (%), Paragraph Length (3-sentence max), Reading Level (Flesch 60-70), Internal Links (3-5 unique, wp:html + script blocks excluded, deduplicated by href), External Links (≥ 2), FAQ Schema (`JSON.parse()` with `@type: "FAQPage"` validation), Image Alt Text (`not_applicable` when no images)
- **Weighted scoring**: SEO Fundamentals (35%), Content & Keyphrase (25%), Readability (15%), Links (10%), Structure & Schema (10%), Images (5%). `not_applicable` weight redistributed proportionally.
- **Null score support**: `seo_checks.score` nullable. `not_applicable` → score: `null`. UI shows "N/A". Weighted scoring excludes nulls.
- **Immutable audit snapshot**: Reads latest saved blog version once — doesn't mix request body or draft content.
- **`POST /api/projects/[id]/seo/audit`** — runs audit, clears old checks, stores results; `DELETE` handler clears checks on version restore/generation
- **SEO page** — working Run Audit button with score gauge, category breakdown, 12 detailed check cards

### Internal Linking System (Phase 5)
- **`link-injector.ts`** — injects active links into blog content (skips headings/code/existing links/wp:html blocks, 500+ char spacing, max 5 links total)
- **`link-sync.ts`** — auto-extracts blog links from content on publish
- **`default-links.ts`** — 7 B2I Hub default links with seeding per user
- **CRUD endpoints** — `GET/POST /api/internal-links`, `GET/PATCH/DELETE /api/internal-links/[id]`

### WordPress Publishing (Phase 5)
- **WordPress REST API** integration with Application Password authentication (`WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD` env vars)
- **Category/Tag resolution** — name-to-ID lookup before post creation
- **Yoast SEO meta fields** — `_yoast_wpseo_title`, `_yoast_wpseo_metadesc`, `_yoast_wpseo_focuskw` written to post meta on publish
- **Bilingual publish** — publishes both EN and ZH-HK versions as separate WordPress posts with language cross-reference
- **Published URL tracking** — stores WordPress permalink back to the project record

### Image Generation (Phase 5)
- **Hugging Face FLUX.1-dev** integration via Inference API (`HUGGINGFACE_API_KEY` env var)
- **Evolution path**: Pollinations API → Agnes API → Hugging Face FLUX.1-dev
- **Generate/Regenerate/Download/Delete** button actions per image
- **Three image types**: Featured (1200×630), Social (1080×1080), Facebook (1200×628)
- **Prompt editing** with inline editing and regeneration

### Translation (Phase 5)
- **Traditional Chinese (zh-HK)** translation via DeepSeek API
- **Language switcher URL cross-referencing** — EN ↔ ZH URL mapping embedded in translated content
- **Side-by-side display** — both EN and ZH versions rendered together on the Translation page
- **Locale-appropriate rules** — British spelling, HKD currency, local district names, Cantonese proverbs

### Word Count System
- **`countBodyWords()`** — server-side word counter that strips WordPress blocks, HTML, JSON-LD, code blocks
- **`calculateWordCount()`** — client-side word counter that strips markup
- **Word count instruction** — explicitly says "body content only" (headings, paragraphs, list items, table cells — not HTML/JSON-LD/block comments)
- **`word_count` default** — changed from 0 to 2500

### Pipeline Reliability Refactor (Phases 1–7, Jul 20, 2026)
- **Shared text cleaning** — `cleanBodyText()` in `text-utils.ts` strips wp:html, scripts, JSON-LD, HTML, URLs, code blocks. Single source for all validators.
- **Stage-targeted prompt modules** — `buildSystemPrompt()` accepts `modules[]` parameter. Each generation stage gets only needed modules (3-5 per stage). 58% token reduction vs full prompt.
- **Single-responsibility prompt modules** — every module owns one concern. 17 duplicated instructions eliminated. Deterministic language throughout.
- **Application-owned H2 headings** — code selects best H2 for keyphrase via semantic matching, modifies heading text in code. AI writes body only.
- **Surgical fixers** — paragraph-scoped editing (not full article). `fixKeyphraseH2` removed. Title/density/readability send only target paragraphs (200-1,500 chars vs 10,000 chars before). 92-95% token reduction.
- **Dynamic word count targets** — sections receive exact word targets: `(total − reserved) / h2Count` instead of "200-300 words."
- **Meta description code repair** — `repairMetaDescription()` appends/truncates in code. No AI needed.
- **JSON repair** — `robustJsonParse()` tries 5 strategies before throwing. Outline gets one AI retry on failure.
- **Deterministic keyphrase target** — `keyphraseTarget(wordCount)` returns exact count. AI receives "include exactly X times."
- **Shared generation constants** — `generation-constants.ts`: single source of truth for all numeric thresholds.

## Features Remaining

### Phase 6 — Social Media Publishing (not started)
- AI social post generation
- Platform-specific formatting
- Scheduling and publishing

## Overall Workflow
1. **Create Project** → Set topic, keyword, audience, country (via NewProjectModal)
2. **Research** → Brave Search gathers web results, discussions, FAQ, news
3. **Outline** → AI generates title, slug, meta, and H2 headings
4. **Blog Generation** → Phased pipeline: Outline → Introduction → H2 Sections → FAQ → Conclusion → Assemble. Application owns structure, AI writes content.
5. **Validation & Fixing** → Code-based checks (title, keyphrase, Flesch) with surgical paragraph-scoped AI fixers
6. **Link Injection** → Auto-injects internal links into blog content
7. **SEO Audit** → 12-check analysis (title, meta, keyphrase, links, readability, schema)
8. **Generate Images** → Hugging Face FLUX.1-dev image generation
9. **Translation** → Traditional Chinese (HK) via DeepSeek API
10. **Publish** → One-click publish + auto-sync internal links
11. **View Blog** → Rendered blog post with WordPress block stripping, FAQ cards, link rendering

## Current State (2026-07-22)

### Build & Tests
- **Build**: Pass
- **Tests**: 160/160
- **Test file**: `src/lib/blog/final-seo-normalizer.test.ts`

### Helpers Wired into Production

| Helper | Location | Consumers |
|--------|----------|-----------|
| `extractMalformedJsonStringProperty()` | `text-utils.ts` | `robustJsonParse()` — called when normal parse fails |
| `countCtaHeadingTags()` | `seo-text-utils.ts` | `article-final-invariants.ts`, `[QUALITY-CHECK]` diagnostic |
| `hasLanguageSwitcher()` | `seo-text-utils.ts` | `quality-scorer.ts` (equivalent regex), route diagnostic |
| `getFirstNReadableWords()` | `seo-text-utils.ts` | `[QUALITY-CHECK]` diagnostic |
| `countEditorialExternalLinks()` | `seo-text-utils.ts` | `[QUALITY-CHECK]` diagnostic |
| `keyphraseRangeForWordCount()` | `generation-constants.ts` | generate-blog route, SEO auditor, quality scorer, component regenerator |
| `allocateComponentKeyphraseBudgets()` | `generation-constants.ts` | generate-blog route |
| `extractCtaFromConclusion()` | `protected-block-extractor.ts` | generate-blog route |

### Remaining Unfixed Checks
1. Word count range in quality scorer uses `scoreMin` not `wordCountRange()`
2. Content validator and integrity checker use separate WordPress parsing
3. Normalizer link destination verification still needed despite block restoration

### Next Priority
1. Run one production generation with keyphrase "threads marketing hong kong"
2. Capture `[KP-BUDGET]`, `[KP-COMPONENT]`, `[KP-RAW-ASSEMBLED]`, `[KP-FINAL]`, `[QUALITY-CHECK]`, `[JSON-PARSE]` logs
3. Verify keyphrase count within dynamic range, no duplicate CTA, all structural checks pass
4. Consolidate content validator with integrity checker's WordPress block parsing
5. Wire `wordCountRange()` into quality scorer
