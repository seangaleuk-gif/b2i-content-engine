# B2I Content Engine — Project Overview

## Purpose
AI-powered content creation workflow for B2I Digital. Automates blog writing from research through publishing, with AI-driven SEO analysis, image generation, and social media content creation.

## Current Development Phase
**Phase 5 — SEO, WordPress & Media** (in progress, Jul 18, 2026)

| Phase | Status | Completed |
|-------|--------|-----------|
| Phase 1 — Frontend UI | Complete | Jul 16, 2026 |
| Phase 2 — Backend Foundation | Complete | Jul 16, 2026 |
| Phase 3 — Research Engine | Complete | Jul 16, 2026 |
| Phase 4 — Blog Generation | Complete | Jul 17, 2026 |
| Phase 5 — SEO, WordPress & Media | In Progress | Jul 18, 2026 |

## Features Completed

### Frontend
- Dashboard with stats cards, recent projects, activity feed, resource gauges
- Projects list with search, filtering, and status badges
- Project workspace (3-column: workflow steps, markdown editor, context panel)
- 9-stage workflow stepper: Research, Competitor Analysis, Outline, Blog, SEO Audit, Images, Social, Translation, Publish
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
- **DeepSeek Chat V3.1** — AI LLM integration for structured JSON blog content generation (`max_tokens: 32768`)
- **Continuation Loop** — up to 3 additional AI calls to expand content when word count is below target; continuation uses tiny JSON responses (no full article re-sending)
- **Prompt Builder** — assembles system and user prompts from 10 composable, user-editable prompt sections (brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure, social_rules, image_rules, translation_rules, cta, publish_checklist)
- **CRITICAL FORMAT REQUIREMENT** at start of system prompt (WordPress blocks required)
- **Internal Linking Instructions** inline section with 7 B2I Hub URLs and context
- **Output format description** — WordPress blocks only (NO Markdown)
- **MANDATORY OUTPUT REQUIREMENTS** at end (CTA, links, FAQ schema, language switcher)
- **Prompt Sections** — pre-seeded defaults via `default-prompts.ts`, force-upserted on every generation via `seedDefaults()`, UNIQUE constraint on (user_id, section_key)
- **Blog Versions** — sequential versioned content storage per project (title, slug, meta_description, blog, faq, links, categories, tags, reading_time, word_count, token_usage, etc.)
- **AI Logging** — 5-step logging pipeline: STEP1 (database values) → STEP2 (prompt assembly) → STEP3 (DeepSeek request) → STEP4 (DeepSeek response) → STEP5 (blog output) with duration tracking
- **Autosave** — debounced automatic content persistence in the project workspace editor
- **Generator Progress** — loading states and progress feedback during blog generation
- **AI Playground** — `POST /api/playground` endpoint + `/playground` page for raw prompt testing

### SEO Audit Engine (Phase 5)
- **12-check analysis engine** (`seo-auditor.ts`) — title length, meta description length, keyphrase in H1/first 100 words/H2/density, internal links count, external links count, paragraph length, image alt text, FAQ schema presence, reading level (Flesch-Kincaid)
- **`POST /api/projects/[id]/seo/audit`** — runs audit, clears old checks, stores results in `seo_checks` table
- **SEO page** — working Run Audit button with score gauge, category breakdown, 12 detailed check cards

### Internal Linking System (Phase 5)
- **`link-injector.ts`** — injects active links into blog content (skips headings/code, 500+ char spacing, max 15 links)
- **`link-sync.ts`** — auto-extracts blog links from content on publish
- **`link-suggester.ts`** — scans content for link opportunities
- **`default-links.ts`** — 7 B2I Hub default links with seeding per user (`created_by` column)
- **CRUD endpoints** — `GET/POST /api/internal-links`, `GET/PATCH/DELETE /api/internal-links/[id]`
- **Suggested links** — `GET/POST /api/suggested-links` (approve/reject suggestions)
- **Publish endpoint** — `POST /api/publish-blog` publishes project and syncs links
- **Admin UI** — `/settings/links` full management page with stats, table, add/edit modal, pending suggestions

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

## Features Remaining

### Phase 5 — Wrap-Up (in progress)
- Auto-fix suggestions from SEO audit results
- Scheduled/automated audit runs

### Phase 6 — Social Media Publishing (not started)
- AI social post generation
- Platform-specific formatting
- Scheduling and publishing

## Overall Workflow
1. **Create Project** → Set topic, keyword, audience, country (via NewProjectModal)
2. **Research** → Brave Search gathers web results, discussions, FAQ, news
3. **Competitor Analysis** → Analyze competitor headlines and strategies
4. **Outline** → AI builds content outline
5. **Write Blog** → AI generates structured JSON blog (title, meta, body, FAQ, links, etc.) with continuation loop
6. **SEO Audit** → Run 12-check analysis (title length, meta, keyphrase usage, links, readability, schema)
7. **Generate Images** → AI creates featured/social images
8. **Generate Social** → AI creates platform-specific posts
9. **Translation** → Traditional Chinese (HK) translation with locale-appropriate rules
10. **Publish** → One-click publish + auto-sync internal links
11. **View Blog** → Rendered blog post with WordPress block stripping, FAQ cards, link rendering
