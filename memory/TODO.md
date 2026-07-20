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
- [x] ~~Create automated/scheduled SEO audit runs~~ (Jul 19 — deterministic editing pipeline replaces this)
- [x] ~~Auto-fix suggestions from SEO audit results~~ (Jul 19 — surgical fixers with escalating specificity)
- [x] ~~Replace continuation loop with section-by-section generation~~ (Jul 19)
- [x] ~~Implement validate-after-every-fix pipeline~~ (Jul 19)
- [x] ~~Add project delete + multi-select bulk delete~~ (Jul 19)
- [x] ~~Fix duplicate blog versions, settings save, blog tab refresh~~ (Jul 19)
- [x] ~~Add 10th tab (Blog Generation) to WorkflowStepper~~ (Jul 19)
- [x] ~~Add version badge to workspace~~ (Jul 19)
- [x] ~~Tag filtering on Blog tab~~ (Jul 19)

## Completed Sprint — Pipeline Reliability Refactor (Phases 1–7, Jul 20, 2026)

### Phase 1 — Fix Validation Bugs
- [x] Create shared `cleanBodyText()` function (removes JSON-LD, wp:html, scripts, URLs)
- [x] Fix JSON-LD corrupting Flesch Reading Ease scores
- [x] Fix JSON-LD corrupting keyphrase count
- [x] Fix wp:html CTA text included in body analysis
- [x] Fix URLs counted as words in readability
- [x] Replace 3 duplicate text-cleaning implementations

### Phase 2A — Fix Prompt Distribution
- [x] Refactor `buildSystemPrompt()` to accept module list
- [x] Send targeted prompt modules to every generation stage
- [x] Define `STAGE_SYSTEM_PROMPTS` per-stage module sets
- [x] Replace 4 hardcoded one-liner system prompts
- [x] ~58% token reduction in system prompts

### Phase 3 — Rewrite Default Prompt Modules
- [x] Single-responsibility redesign — every module owns one concern
- [x] Move all SEO truth to `seo_rules` only
- [x] `publish_checklist` becomes reference-based verification
- [x] Remove B2I Hub product info from `hong_kong_context`
- [x] Remove 17 duplicated instructions across modules
- [x] Deterministic language throughout (measurable, not vague)

### Phase 4 — Application Owns Article Structure
- [x] Application selects best H2 for keyphrase (semantic matching)
- [x] Application modifies H2 heading text in code (prepend keyphrase)
- [x] AI generates body content only (`{"body": "..."}` not `{"heading": "...", "body": "..."}`)
- [x] Remove `hasKeyphraseInH2` tracking and `isH2WithKeyphrase` flag
- [x] Section prompt includes prev/next heading context

### Phase 5A–5B — Fixer Audit & Surgical Editors
- [x] Audit all 4 fixers — classify remove/replace/keep
- [x] Remove `fixKeyphraseH2` (obsoleted by Phase 4)
- [x] Rewrite `fixTitle` — sends only title (200 chars), AI returns 5 alternatives
- [x] Rewrite `fixKeyphraseDensity` — paragraph-scoped (~500 chars)
- [x] Rewrite `fixReadability` — paragraph-scoped, 3 worst paragraphs (~1,500 chars)
- [x] Remove escalating specificity, PROTECTED, DIFF_MINDSET
- [x] 92-95% fixer prompt size reduction

### Phase 6 — Benchmarking
- [x] 5-article benchmark across diverse topics
- [x] Measure word count, Flesch, title/meta length, keyphrase, generation time
- [x] Identify remaining weaknesses (word count below target, meta too short, JSON failures)

### Phase 7 — Eliminate Remaining AI Weaknesses
- [x] Dynamic word count targets per section
- [x] `repairMetaDescription()` code-based (append CTA / truncate)
- [x] `robustJsonParse()` 5-step JSON repair with AI retry on failure
- [x] Deterministic keyphrase target (`keyphraseTarget(wordCount)`)
- [x] Shared generation constants (`generation-constants.ts`)

## Next Sprint — Phase 8: WordPress Integration (Actual Publishing)

- [ ] WordPress REST API publish endpoint (exists — needs testing/refinement)
- [ ] Post status syncing after publish
- [ ] Bilingual publish flow (EN + ZH-HK)

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
