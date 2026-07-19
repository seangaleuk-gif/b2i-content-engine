# TODO

## Previous Sprint — Phase 3: Research Engine + AI Project Memory (Completed)

- [x] ~~Install Serper SDK~~ (Jul 16 — replaced by Brave Search on Jul 18)
- [x] ~~Add `SERPER_API_KEY` to .env~~ (Jul 16 — replaced by `BRAVE_API_KEY` on Jul 18)
- [x] ~~Create Serper research service with retry logic~~ (Jul 16 — replaced by Brave on Jul 18)
- [x] ~~Create `POST /api/projects/[id]/research/generate` endpoint~~ (Jul 16)
- [x] ~~Update Research page with Generate button + loading/error/success states~~ (Jul 16)
- [x] ~~Create `/memory` folder and all 7 markdown files~~ (Jul 16)
- [x] ~~Populate memory files with accurate current state~~ (Jul 16, Jul 17, Jul 18)
- [x] ~~Test Serper integration end-to-end~~ (validated with real API key)
- [x] ~~Add "Competitor", "Authority", and "Statistic" type parsing from Serper organic results~~ (Phase 4)
- [x] ~~Handle Serper API rate limiting gracefully~~ (Phase 4)

## Previous Sprint — Phase 4: Blog Generation (Completed Jul 17, 2026)

- [x] ~~Add DeepSeek API key to settings~~ (Jul 17)
- [x] ~~Create DeepSeek AI blog generation service (`deepseek.ts` + `chatWithRetry`)~~ (Jul 17)
- [x] ~~Create prompt builder with section management (`prompt-builder.ts`)~~ (Jul 17)
- [x] ~~Create 8 default prompt sections (`default-prompts.ts`: brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure, social_rules, image_rules, translation_rules)~~ (Jul 17)
- [x] ~~Create `prompt_sections` table + seed on first access~~ (Jul 17)
- [x] ~~Create `POST /api/generate-blog` endpoint with 5-step logging pipeline~~ (Jul 17)
- [x] ~~Create `GET/POST /api/prompt-sections` endpoints~~ (Jul 17)
- [x] ~~Create `POST /api/playground` endpoint for prompt testing~~ (Jul 17)
- [x] ~~Create `GET/DELETE /api/projects/[id]/versions` endpoints~~ (Jul 17)
- [x] ~~Create blog versions system (`blog_versions` table + repository with auto-versioning)~~ (Jul 17)
- [x] ~~Create AI request/response logging (`ai_logs` table + repository)~~ (Jul 17)
- [x] ~~Add autosave to project workspace (debounced content persistence)~~ (Jul 17)
- [x] ~~Update workspace with Generate button + loading/generation progress state~~ (Jul 17)
- [x] ~~Create Playground page (`/playground`) for interactive prompt testing~~ (Jul 17)
- [x] ~~Create NewProjectModal component (Topic, Keyword, Audience, Country) + Modal component~~ (Jul 17)
- [x] ~~Create 4 missing workspace stages: Competitor, Outline, Translation, Publish pages~~ (Jul 17)
- [x] ~~Create dynamic workflow stepper (step statuses + progress bar computed from project data)~~ (Jul 17)
- [x] ~~Switch data layer from Drizzle direct Postgres to Supabase REST API (resolved pooler DNS issues)~~ (Jul 17)
- [x] ~~Normalize camelCase/snake_case serialization (api-client.ts + repository toSnakeCase helpers)~~ (Jul 17)
- [x] ~~Fix Research page Copy button (clipboard copy for source title + URL)~~ (Jul 17)
- [x] ~~Fix DeepSeek response parsing (Chat Completions format: `choices[0].message.content`)~~ (Jul 17)
- [x] ~~Set `max_tokens: 16384` for DeepSeek generation~~ (Jul 17 — increased to 32768 on Jul 18)
- [x] ~~Add word count instruction to prompt builder user message~~ (Jul 17)

## Current Sprint — Phase 5: SEO Automation & Internal Linking (In Progress)

- [x] ~~Create SEO analysis service (`seo-auditor.ts`: 12-check engine)~~ (Jul 18)
- [x] ~~Create `POST /api/projects/[id]/seo/audit` endpoint~~ (Jul 18)
- [x] ~~Update SEO page with working Run Audit button, score gauge, category breakdown, detailed check cards~~ (Jul 18)
- [x] ~~Create internal links table + schema (`internal_links`)~~ (Jul 18)
- [x] ~~Create suggested links table + schema (`suggested_links`)~~ (Jul 18)
- [x] ~~Create `link-injector.ts` service (skip headings/code, 500+ char spacing, max 15)~~ (Jul 18)
- [x] ~~Create `link-sync.ts` service (auto-extract on publish)~~ (Jul 18)
- [x] ~~Create `link-suggester.ts` service (scan for opportunities)~~ (Jul 18)
- [x] ~~Create `default-links.ts` (7 B2I Hub default links + seeding)~~ (Jul 18)
- [x] ~~Create `GET/POST /api/internal-links` + `GET/PATCH/DELETE /api/internal-links/[id]` endpoints~~ (Jul 18)
- [x] ~~Create `GET/POST /api/suggested-links` endpoint (approve/reject)~~ (Jul 18)
- [x] ~~Create `POST /api/publish-blog` endpoint (publish + sync links)~~ (Jul 18)
- [x] ~~Create Settings → Links admin page (`/settings/links`) with stats, table, modal, suggestions~~ (Jul 18)
- [x] ~~Switch research engine from Serper to Brave Search API~~ (Jul 18)
- [x] ~~Add continuation loop to blog generation (up to 3 attempts, tiny JSON responses)~~ (Jul 18)
- [x] ~~Update prompt builder with CRITICAL FORMAT REQUIREMENT at top~~ (Jul 18)
- [x] ~~Add Internal Linking Instructions inline section to prompt builder~~ (Jul 18)
- [x] ~~Add MANDATORY OUTPUT REQUIREMENTS section to prompt builder~~ (Jul 18)
- [x] ~~Add `cta` and `publish_checklist` prompt sections (8 → 10 total)~~ (Jul 18)
- [x] ~~Change `seedDefaults()` to force-upsert all 10 sections on every generation~~ (Jul 18)
- [x] ~~Add UNIQUE constraint on prompt_sections (user_id, section_key)~~ (Jul 18)
- [x] ~~Create Blog View page (`/projects/[id]/blog`) with WordPress block stripping, FAQ cards~~ (Jul 18)
- [x] ~~Update word count to strip WordPress blocks, HTML, JSON-LD — "body content only"~~ (Jul 18)
- [x] ~~Change word_count default from 0 to 2500~~ (Jul 18)
- [x] ~~Update memory files with Phase 5 changes~~ (Jul 18)
- [ ] Create automated/scheduled SEO audit runs
- [ ] Auto-fix suggestions from SEO audit results

## Next Sprint — Phase 6: WordPress Integration

- [ ] Add WordPress connection settings fields
- [ ] Create WordPress REST API service
- [ ] One-click publishing to WordPress
- [ ] Post status syncing

## Future Ideas

- [ ] Image generation (DALL-E / Stable Diffusion integration)
- [ ] Social media post generation (AI-powered per platform)
- [ ] Translation/l10n improvements
- [ ] Team/collaboration features
- [ ] Analytics dashboard
- [ ] Content calendar
- [ ] Email newsletter integration
- [ ] Webhook notifications
- [ ] Dark/light theme toggle
- [ ] Mobile responsive layout
