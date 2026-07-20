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
- **NON-NEGOTIABLE HARD REQUIREMENTS** block at top of user message (title 50-70, keyphrase 3-5, H2 keyphrase, Flesch 60-70) with PRE-OUTPUT VALIDATION checklist
- **Internal Linking Instructions** — 3-5 UNIQUE internal links, max 5, language switcher excluded
- **MANDATORY OUTPUT REQUIREMENTS** at end (CTA, links, FAQ schema, language switcher, meta 155-200)
- **Prompt Sections** — pre-seeded defaults via `default-prompts.ts`, force-upserted on every generation via `seedDefaults()`, UNIQUE constraint on (user_id, section_key)
- **Blog Versions** — sequential versioned content storage per project (title, slug, meta_description, blog, faq, links, categories, tags, reading_time, word_count, token_usage, etc.)
- **Deterministic Editing Pipeline** — `src/lib/services/fixers.ts` with 4 surgical fixers (title, H2 keyphrase, density, readability) using escalating specificity (general → location → replacement), diff mindset, protected sections, exact deltas. Chain: validate → fixer → re-validate → repeat.
- **Post-generation validation** — server-side checks after generation: title length, keyphrase count, H2 keyphrase presence, Flesch Reading Ease. Blog rejected (422) if any fail after targeted fixers.
- **Version badge** — displays current version (v1, v2, v3) in workspace toolbar + editor area, updates on generation/restore/URL param
- **Autosave** — debounced automatic content persistence in the project workspace editor
- **Generator Progress** — loading states and progress feedback during blog generation
- **AI Playground** — `POST /api/playground` endpoint + `/playground` page for raw prompt testing

### SEO Audit Engine (Phase 5)
- **12-check analysis engine** (`seo-auditor.ts`) — title length (50-70), meta description length (155-200, with 120-154 gap closed), keyphrase in H1/first 100 words/H2/density, unique internal links (3-5, wp:html blocks excluded, deduped by href), external links (counted from inline HTML + blog_versions.external_links array), paragraph length, image alt text, FAQ schema presence, reading level (Flesch-Kincaid 60-70)
- **`POST /api/projects/[id]/seo/audit`** — runs audit, clears old checks, stores results in `seo_checks` table; reads meta_description from blog_versions (server-side priority); `DELETE` handler clears checks on version restore/generation
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
