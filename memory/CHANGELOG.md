# Changelog

## 2026-07-20 — Pipeline Reliability Refactor (Phases 1–7)

### Phase 1 — Fix Validation Bugs
- **Shared text cleaning** — `src/lib/services/text-utils.ts`: single `cleanBodyText()` function strips wp:html blocks, scripts, JSON-LD, HTML tags, URLs, code blocks, and markdown. Replaces 3 duplicate implementations in route.ts and seo-auditor.ts.
- **Fixed JSON-LD corrupting Flesch** — JSON-LD schema text no longer inflates word count or breaks sentence detection.
- **Fixed JSON-LD corrupting keyphrase count** — keyphrases in FAQ schema no longer counted toward density target.
- **Fixed wp:html CTA text in validators** — CTA and language switcher HTML excluded from all body text analysis.
- **Fixed URLs counted as words** — URLs stripped before word counting and Flesch calculation.

### Phase 2A — Fix Prompt Distribution
- **Stage-targeted prompt modules** — `buildSystemPrompt()` refactored to accept `modules?: string[]` parameter. Each generation stage receives only the modules it needs:
  - Outline: brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure
  - Introduction: brand_voice, seo_rules, formatting_rules, hong_kong_context
  - Sections: brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure
  - FAQ: brand_voice, seo_rules, formatting_rules
  - Conclusion: brand_voice, formatting_rules, cta
- **4 hardcoded one-liner system prompts removed** — Intro, Sections, FAQ, Conclusion now use `buildSystemPrompt()` instead of 60-70 char ad-hoc strings.
- **`STAGE_SYSTEM_PROMPTS` constant** — module sets defined in prompt-builder.ts as single source of truth.
- Token savings: 58% reduction vs sending full prompt everywhere (~23,300 chars per generation).

### Phase 3 — Rewrite Default Prompt Modules
- **Single-responsibility redesign** — every module now owns one concern:
  - `brand_voice`: Tone/personality only (removed Flesch score, paragraph limits, validation language)
  - `seo_rules`: Single source of SEO truth (title, meta, keyphrase, links, readability, heading hierarchy)
  - `formatting_rules`: WordPress block syntax only
  - `hong_kong_context`: Regional knowledge only (removed B2I Hub product info, brand colors)
  - `blog_structure`: Section order only (removed SEO counts, formatting, specific URLs)
  - `cta`: HTML blocks only (removed placement instruction → blog_structure)
  - `publish_checklist`: 18 reference items pointing to authoritative modules
- **17 duplicated instructions eliminated** — title length, meta length, internal link counts, Flesch target, brand colors, slug rules all reduced from 3-4 locations to 1.
- **Deterministic language** — "average sentence length 12-16 words" instead of "write simply." Measurable guidance throughout.

### Phase 4 — Application Owns Article Structure
- **Application-owned H2 headings** — heading text modified in code before sending to AI. AI generates only body content, returns `{"body": "..."}`.
- **Keyphrase H2 selection** — three-tier heuristic: semantic match → first non-structural heading → first heading. Replaces arbitrary `index 0 or 1`.
- **Heading guaranteed** — application prepends keyphrase to H2 text in code. Zero AI involvement in heading decisions.
- **Section context expanded** — AI receives previous heading + next heading + current heading for body generation.
- **Removed `hasKeyphraseInH2` tracking** and `isH2WithKeyphrase` per-section flag.

### Phase 5A–5B — Fixer Pipeline Audit & Surgical Editors
- **`fixKeyphraseH2` removed** — obsolete since Phase 4 (app owns headings).
- **`fixTitle` rewritten** — sends only title (200 chars), AI returns 5 alternatives, code picks first valid one. Was sending full article JSON (10K chars).
- **`fixKeyphraseDensity` rewritten** — paragraph-scoped. Extracts paragraph blocks, ranks by keyphrase density, sends only target paragraph (~500 chars). Was sending full article.
- **`fixReadability` rewritten** — paragraph-scoped. Splits article into paragraphs, scores each for Flesch, sends only 3 worst-scoring (~1,500 chars). Was sending full article with maxTokens=32768.
- **FixerContext simplified** — removed `stripHtml`, `parseBlogJson`, `Specificity` type, `PROTECTED`, `DIFF_MINDSET`.
- **Escalating specificity removed** — fixers no longer have general→location→replacement levels.
- Token savings: 92-95% reduction in fixer prompt size.

### Phase 6 — Benchmarking & Quality Validation
- 5-article benchmark across diverse topics (AI creator marketing, restaurants, fitness, beauty, tech).
- Measured: word count, Flesch ease, title/meta length, keyphrase count, H2 keyphrase presence, H2 count, generation time, fixer calls.
- Results: Flesch 63-70 (100% in range), titles close to 50-70, meta 135-156 (below target), word count 1,385-1,744 (below 2,000-2,500 target).
- One article failed mid-generation (JSON parse error — 80% reliability).

### Phase 7 — Eliminate Remaining AI Weaknesses
- **Dynamic word count targets** — `WORD_ALLOCATION` constant (intro 8%, conclusion 6%, FAQ 10%). Sections receive exact target: `(total − reserved) / h2Count` instead of hardcoded "200-300 words."
- **Meta description code repair** — `repairMetaDescription()` appends CTA sentence if < 155 chars, truncates at sentence boundary if > 200 chars. Code-only, no AI.
- **JSON repair** — `robustJsonParse()` tries 5 strategies (direct parse, code block extraction, object matching, trailing comma fix) before throwing. Outline gets one AI retry on failure.
- **Deterministic keyphrase target** — `keyphraseTarget(wordCount)` returns exact count (e.g. 2,200 words → 4 mentions). AI receives "include exactly X times" instead of "3-5 times."
- **Shared generation constants** — `src/lib/services/generation-constants.ts`: `SEO_TITLE_MIN/MAX`, `META_MIN/MAX`, `KEYPHRASE_MIN/MAX`, `FLESCH_MIN/MAX`, `DEFAULT_WORD_COUNT`. Used by route.ts, prompt-builder.ts, seo-auditor.ts.

---

### Added
- **Section-by-section generation** — replaced single-shot DeepSeek call + continuation loop with phased pipeline: A. Outline (title + H2 headings) → B. Introduction → C. H2 Sections (one API call each, inline keyphrase injection) → D. FAQ → E. Conclusion → F. Assemble. Each section is smaller and more controlled (maxTokens: 4096-8192 vs old 32768).
- **Deterministic editing pipeline** (`src/lib/services/fixers.ts`) — 4 surgical fixers with escalating specificity (general → location → replacement), diff mindset, protected sections, and exact deltas. Chain: title → H2 → density → readability.
- **Validate-after-every-fix** — re-runs all checks after each fixer, with 3 attempts per check using escalating specificity. Catches cascading failures immediately.
- **Deterministic title edits** — code truncates (too long: `lastIndexOf(" ") + "…"`) or prepends keyphrase (too short: `Keyphrase: Title`) before falling back to AI.
- **10-step WorkflowStepper** — added "Blog Generation" tab after Research (links to `/projects/[id]` workspace editor), keeping all 9 original tabs.
- **Project delete** — single delete button on each row + multi-select with bulk delete from projects list. Delete button in workspace toolbar. `DELETE /api/projects/[id]/seo/audit` endpoint.
- **Version badge** — displays current version (v1, v2, v3) next to project name in workspace toolbar + editor area. Updates on generation, restore, and URL param.
- **SEO audit meta description fix** — scoring gap (120-154 chars → score 0) closed. Unique internal link counting via `Set<string>`. wp:html block exclusion via character ranges. External links counted from `blog_versions.external_links` array + inline HTML.
- **Settings page Refresh button** — re-fetches from Supabase without saving. `seedDefaults()` removed from GET handler (was overwriting user edits on every load).
- **Tag filtering** — Blog tab accepts `?tag=` URL param for client-side filtering. Tags link to WordPress archive pages (`/blog/tag/` or `/blog/zh/tag/`).
- **Post-generation validation** — 4 hard requirements (title 50-70, keyphrase 3-5, H2 keyphrase, Flesch 60-70) checked server-side. Blog rejected (422) if any fail after fixers.

### Changed
- **Internal link cap**: 15 → 5 (link-injector MAX_TOTAL_LINKS), 7 → 3-5 unique (prompt builder + SEO auditor)
- **Prompt builder**: NON-NEGOTIABLE HARD REQUIREMENTS block at top of user message, PRE-OUTPUT VALIDATION before JSON output, meta description MUST 155-200 in seo_rules, blog_structure, and output format
- **Prompt sections updated**: seo_rules (3-5 unique links, 50-70 title, HARD REQUIREMENT meta), formatting_rules (paragraphs HARD REQUIREMENT), blog_structure (50-70 H1, 3-5 UNIQUE links), publish_checklist (50-70 title)
- **brand_voice**: added simple vs complex writing example, Flesch 60-70 HARD REQUIREMENT
- **API client**: `ApiError` now carries `data` field with full response body for validation failure details
- **WorkflowStepper**: removed `usePathname` dep (was causing 429 rate limit), fetches once on mount
- **Link injector**: `MAX_TOTAL_LINKS = 5`, added `<script>` to skip selectors (FAQ schema protection)
- **Blog versions**: `getNextVersionNumber` uses `Math.max()` over all versions (more reliable than order+limit)

### Fixed
- **Duplicate blog versions** — link injector now runs BEFORE version save (was creating two rows with same version_number)
- **Settings save broken** — GET handler no longer calls `seedDefaults()` (was force-upserting defaults on every page load, destroying user edits). `PromptSection` interface uses camelCase (`sectionKey`) matching api-client normalization.
- **Blog tab not refreshing** — explicit `useEffect` + `refreshData()` on mount and after generation instead of `window.location.reload()`
- **Meta description 0/100 in SEO audit** — scoring gap at 120-154 chars closed (was falling to `else` with score 0)
- **Internal links overcounted** — language switcher links excluded via wp:html character-range filtering + unique href dedup
- **External links showing 0** — now counts from both `blog_versions.external_links` array + inline `<a href="https://...">` in HTML
- **SEO page empty body** — now passes `blog` from target version in POST body to audit route
- **SEO fields not populating** — workspace sidebar now reads from `blog_versions` (title, slug, metaDescription)
- **Publish checklist meta description** — `metaDescriptionSet` now checks `latestEn?.metaDescription` instead of `hasContent`

### Removed
- **Continuation loop** — replaced by section-by-section expansion
- **"Fix everything" retry** — replaced by targeted surgical fixers with escalating specificity
- **Workspace auto-redirect** — removed redirect to Research for new projects (was blocking Blog Generation tab)
- **`usePathname` dep in WorkflowStepper** — caused Supabase Auth 429 rate limiting

---

## 2026-07-18 — Phase 5: SEO, WordPress & Media

### Added
- **SEO Audit Engine** — `src/lib/services/seo-auditor.ts` with `runAudit()` performing 12 checks: SEO title length (50-70 chars), meta description length (155-200 chars), focus keyphrase in H1, keyphrase in first 100 words, keyphrase in at least one H2, keyphrase density (0.5-2%), internal links (5-8), external links (2-5), paragraph length (≤4 sentences), image alt text (all images), FAQ schema presence (FAQPage JSON-LD), Flesch-Kincaid reading level (60-70). Returns `{ overallScore, checks[], summary: { passed, warnings, failed } }`.
- **SEO Audit endpoint** — `POST /api/projects/[id]/seo/audit` clears old checks, runs `runAudit()`, stores 12 results in `seo_checks` table. SEO page now has working Run Audit button with score gauge, category breakdown, and detailed check cards.
- **Internal Linking System** — 5 new services:
  - `link-injector.ts` — injects active links into blog content (skips headings/code blocks/existing links/wp:html blocks, 500+ char spacing, max 15 links)
  - `link-sync.ts` — auto-extracts `<a href="/blog/...">` links from content on publish, upserts to `internal_links` by `created_by` + `url`
  - `link-suggester.ts` — scans content for link-worthy phrases, stores confidence-scored suggestions
  - `default-links.ts` — 7 B2I Hub default links with keywords, priority, min/max per article, pinned status; seeded per user via `seedDefaultLinks()`
  - **CRUD endpoints** — `GET/POST /api/internal-links`, `GET/PATCH/DELETE /api/internal-links/[id]`; `GET/POST /api/suggested-links` (approve/reject)
- **Publish endpoint** — `POST /api/publish-blog` publishes project (status → "published"), creates activity log, syncs internal links from latest blog version
- **Blog View page** — `/projects/[id]/blog` renders published blog with WordPress block stripping, FAQ cards rendered as expandable accordions, internal/external link rendering
- **Internal Links admin page** — `/settings/links` full management UI with stats (total links, active, pending suggestions), filterable table, add/edit modal (display text, URL, keywords, priority, min/max per article, active toggle), pending suggestions panel with approve/reject buttons
- **Continuation Loop** — `POST /api/generate-blog` now attempts up to 3 additional DeepSeek calls when first-pass word count is below target. Each continuation sends a tiny JSON instruction (`{ "additionalContent": "..." }`) — the full article is never re-sent. Expands content until target reached or max attempts exhausted.
- **Prompt Builder — Internal Linking Instructions** — inline section in system prompt with 7 B2I Hub URLs and context on when to use each. "Never force a link" rule, max 3-4 links, contextual anchor text.
- **Prompt Builder — CRITICAL FORMAT REQUIREMENT** — placed at the very start of the system prompt declaring WordPress blocks as non-negotiable.
- **Prompt Builder — MANDATORY OUTPUT REQUIREMENTS** — added at end of system prompt: CTA block, internal links, FAQ schema JSON-LD, language switcher, WordPress block format, categories/tags.
- **Prompt Builder — Output format description** — explicitly states "WordPress blocks only (NO Markdown)".
- **`internal_links` table** — 12 columns: id, created_by (NOT user_id), display_text, url, keywords[jsonb], priority, min_per_article, max_per_article, active, auto_synced, status, pinned, created_at, updated_at
- **`suggested_links` table** — 8 columns: id, user_id, phrase, suggested_url, source_content, project_id, confidence, status (pending/approved/rejected), created_at
- **Brave Search API** — replaced Serper for research engine. Uses GET request with `X-Subscription-Token` header, `BRAVE_API_KEY` env var. Categorizes results as web (google), discussion, faq, news.
- **Research page sidebar** — updated to show 4 category views: Web Results, Discussions, FAQ, News (was 8-category Serper display).

### Changed
- **API endpoint count** — increased from 22 to 28 endpoints (+SEO audit, +internal-links 2, +suggested-links, +publish-blog, +internal-links [id])
- **Repository count** — increased from 12 to 14 (internal-links, suggested-links)
- **Service count** — increased from 5 to 10 (seo-auditor, link-injector, link-sync, link-suggester, default-links)
- **Schema count** — increased from 12 to 15 (internal-links, suggested-links, profiles)
- **Prompt sections** — from 8 to 10 sections (added `cta` and `publish_checklist`). `seedDefaults()` now force-upserts all 10 sections on every generation (not just on first access).
- **Prompt sections table** — now has UNIQUE constraint on `(user_id, section_key)`.
- **`max_tokens`** — increased from 16384 to 32768 for main generation call; continuation calls use 16384.
- **`word_count` default** — changed from 0 to 2500 in `projects` table.
- **Word count measurement** — `countBodyWords()` now strips WordPress blocks, HTML, JSON-LD `<script>` blocks, code fences (` ``` `), Markdown syntax characters. Instruction explicitly says "body content only".
- **Prompt builder system prompt** — reordered: CRITICAL FORMAT REQUIREMENT → brand_voice → hong_kong_context → Internal Linking Instructions → seo_rules → formatting_rules → blog_structure → cta → publish_checklist → social_rules → image_rules → translation_rules → MANDATORY OUTPUT REQUIREMENTS
- **Research engine** — Serper (`serper` npm package) replaced by Brave Search API (native `fetch` with `X-Subscription-Token` header). `SERPER_API_KEY` → `BRAVE_API_KEY`.
- **Workflow stepper** — now 10 stages (added Blog View).

---

## 2026-07-17 — Phase 4: Blog Generation

### Added
- **DeepSeek Chat V3.1 integration** — `src/lib/services/deepseek.ts` client with `chat()` and `chatWithRetry()` (exponential backoff, max 2 retries), error classification (timeout, invalid_json, rate_limit, api_failure, network_failure, empty_response), and 60s request timeout. Response parsed from Chat Completions format (`choices[0].message.content`).
- **max_tokens: 16384** — DeepSeek calls configured with 16K max output tokens (later increased to 32768).
- **Prompt Builder** — `src/lib/services/prompt-builder.ts` with `buildBlogPrompt()` that assembles system and user prompts from composable sections. System prompt: brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure, social_rules, image_rules. User message: project details, research sources (grouped by category), knowledge base (keyword-scored, top 5), translation_rules, JSON output instructions.
- **Default prompts** — `src/lib/services/default-prompts.ts` — 8 pre-seeded prompt sections (brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure, social_rules, image_rules, translation_rules) with comprehensive HK-focused content guidelines.
- **Prompt Sections CRUD** — `prompt_sections` table + repository with `seedDefaults()` (auto-inserts defaults on first read per user), `upsert()` by user+key, and `GET/POST /api/prompt-sections` endpoints.
- **Blog Generation endpoint** — `POST /api/generate-blog` with 5-step logging pipeline: STEP1 (database values + context sizes), STEP2 (prompt assembly chars + word count check), STEP3 (DeepSeek request params), STEP4 (DeepSeek response with finish_reason monitoring), STEP5 (parsed blog output with word count validation). Returns structured JSON: { success, version, title, slug, metaDescription, excerpt, blog, faq, internalLinks, externalLinks, categories, tags, readingTime, wordCount, summary, model, generationTimeMs, tokenUsage }.
- **Blog Versions** — `blog_versions` table with 25 columns for structured blog output (title, slug, meta_description, excerpt, blog, faq[jsonb], internal_links[jsonb], external_links[jsonb], categories[jsonb], tags[jsonb], reading_time, word_count, summary, model, prompt_version, generation_time_ms, token_usage[jsonb], status). Sequential version numbering per project via `getNextVersionNumber()`.
- **AI Logging** — `ai_logs` table tracking model, prompt_size, completion_size, tokens_in/out/total, generation_time_ms, status, error_message, endpoint. Created by `POST /api/generate-blog` on every successful generation.
- **Playground** — `POST /api/playground` endpoint + `/playground` page for raw prompt testing (no versioning, no logging).
- **Blog Versions API** — `GET /api/projects/[id]/versions` (list all versions) and `DELETE /api/projects/[id]/versions` (delete all).
- **NewProjectModal** — reusable form modal (Topic, Keyword, Audience, Country fields) wired to Dashboard and Projects pages, replacing hardcoded "Untitled Project" behavior.
- **Modal component** — `src/components/ui/Modal.tsx` reusable wrapper with backdrop blur, ESC key close.
- **4 new workspace stages** — Competitor Analysis (`/projects/[id]/competitor`), Outline (`/projects/[id]/outline`), Translation (`/projects/[id]/translation`), Publish (`/projects/[id]/publish`) — each with full UI, empty states, and loading skeletons.
- **Dynamic workflow stepper** — step statuses (complete/in-progress/pending) and progress bar now computed dynamically from actual project data. Research is the default first active step for new projects.
- **Autosave** — debounced automatic content persistence in the project workspace editor.
- **Generator progress** — loading states and step-by-step feedback during blog generation in the workspace.
- **Supabase REST API data layer** — `getDb()` now creates a `@supabase/supabase-js` client with service role key instead of Drizzle `postgres.js` direct TCP connection. Resolved pooler DNS issues on Windows.
- **3 new database tables** — `prompt_sections`, `blog_versions`, `ai_logs` via `supabase/phase4-migration.sql` (with RLS policies, indexes, triggers, and seed data).
- **`DEEPSEEK_API_KEY`** environment variable support.
- **Prompt builder word count instruction** — user message now includes an explicit `IMPORTANT — Target Word Count` instruction.
- **Copy button on research page** — clipboard copy for source title + URL.

### Changed
- **API endpoint count** — increased from 16 to 22 endpoints.
- **Repository count** — increased from 9 to 12 (prompt-sections, blog-versions, ai-logs).
- **Prompt sections updated** — all 8 sections rewritten for B2I Hub brand: mission-driven HK voice with Cantonese proverbs, Yoast-compatible SEO rules, WordPress block format (no Markdown), bilingual language switcher, CTA HTML blocks, FAQ Schema JSON-LD, 15-point publish checklist. Added 2 new sections: `cta` and `publish_checklist`. Settings page now has 10 prompt tabs.
- **Service layer** — added `deepseek.ts`, `prompt-builder.ts`, `default-prompts.ts`.
- **Data access** — all repositories now use Supabase REST API (`db.from("table")`) instead of Drizzle ORM queries. Drizzle schemas retained for TypeScript types only.
- **camelCase normalization** — `api-client.ts` client-side: `snakeToCamel()` recursive normalization on all JSON responses. Server-side: `toSnakeCase()` helpers in all repositories for inserts/updates.

### Fixed
- **Supabase pooler DNS** — Drizzle `postgres.js` direct TCP connection failed on Windows due to pooler hostname resolution. Switched to Supabase REST API client.
- **camelCase/snake_case mismatch** — Drizzle schema uses camelCase but DB has snake_case. Added bidirectional normalization.
- **DeepSeek response parsing** — fixed client to parse Chat Completions format (`choices[0].message.content`).
- **Drizzle upsert syntax** — corrected `onConflictDoUpdate` usage for prompt_sections upsert.
- **word_count not passed to prompt** — prompt builder now reads `(project as Record<string, unknown>).word_count` to handle snake_case DB column.
- **Workflow stepper hardcoded** — step statuses now computed dynamically from actual project data.
- **Research Copy button** — added clipboard copy for source title + URL.
- **max_tokens** — set to 16384 (was default 4096) to prevent truncation for longer blog posts.
- **finish_reason monitoring** — logs warnings when `finish_reason === "length"` (truncated) and confirmation when `"stop"` (natural completion).

---

## 2026-07-16

### Added
- **Serper API integration** — Google search research engine with retry logic (max 3 attempts) (replaced by Brave Search on Jul 18)
- **`POST /api/projects/[id]/research/generate`** endpoint — triggers research, saves to DB, logs activity
- **Research page update** — working Generate button with loading spinner, error banner, success banner, and empty state
- **`SERPER_API_KEY`** environment variable added to `.env.local` and `.env.local.example` (replaced by `BRAVE_API_KEY` on Jul 18)
- **`/memory/` directory** — AI project memory with 7 markdown files documenting the entire project
- **`memory/PROJECT.md`** — project purpose, workflow, phases, features completed/remaining
- **`memory/ARCHITECTURE.md`** — folder structure, tech stack, component hierarchy, data flow, auth flow
- **`memory/DATABASE.md`** — all 9 tables with columns, types, constraints, relationships, indexes, triggers
- **`memory/API.md`** — all 16 API endpoints with methods, request/response bodies, error handling
- **`memory/TODO.md`** — sprint-based development checklist with completed tasks marked
- **`memory/KNOWN_BUGS.md`** — 4 documented bugs with reproduction steps and status
- **`memory/CHANGELOG.md`** — this file
- **`src/lib/services/serper.ts`** — Serper API client with `runSerperResearch()` and `runSerperResearchWithRetry()`
- **`serper` npm package (v1.0.6)** added as dependency

### Changed
- **Research page** — added Knowledge Graph section to sidebar, improved URL display (domain-only), added generation states
- **`.env.local`** — added `SERPER_API_KEY` placeholder
- **`.env.local.example`** — added `SERPER_API_KEY` placeholder

### Fixed
- **Database connection** — replaced Proxy pattern with lazy `getDb()` singleton to fix Drizzle method chaining at runtime
- **Route group 404** — removed `(dashboard)` route group, moved pages to root, added `AppLayout` client component
- **Migration SQL** — added `DROP POLICY IF EXISTS` and `DROP TRIGGER IF EXISTS` before all CREATE statements for idempotency
- **`supabase/init.sql`** — kept in sync with migration file

---

## 2026-07-16 (earlier)

### Added
- **Supabase Auth** — email/password login at `/auth/login`, OAuth callback, sign-out
- **Next.js 16 proxy** — session refresh + auth guard for protected routes
- **Drizzle ORM** — 9 table schemas (profiles, projects, knowledge_items, prompts, research_sources, seo_checks, images, social_posts, activity_log)
- **SQL migration** — full DDL with foreign keys, indexes, RLS policies, triggers
- **16 API endpoints** — dashboard, projects CRUD, knowledge CRUD, prompts CRUD, research, SEO, images, social, profile, debug
- **9 repository modules** — type-safe data access layer
- **Supabase server/browser client utilities** — cookie-based auth
- **Frontend data hooks** — `useData<T>` and `api` fetch wrapper
- **UI components** — Badge, Button, Card, EmptyState, Input, ProgressBar, Skeleton, AppLayout, Sidebar
- **11 pages** — Dashboard, Projects, Project Workspace, Research, SEO, Images, Social, Knowledge, Prompts, Settings, Login
- **Empty states** — across all data views with action buttons
- **Loading skeletons** — Skeleton component used across all pages during data fetching
- **Documentation** — `docs/BACKEND.md` with architecture overview
