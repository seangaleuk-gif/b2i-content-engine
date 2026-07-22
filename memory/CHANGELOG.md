# Changelog

## 2026-07-21 — Section Lifecycle, SEO Audit Rewrite, Null Scores

### Section Lifecycle Fix
- **Authoritative `GeneratedSection[]`** — Created once after outline with all sections as `"pending"`. Never filtered, compacted, or rebuilt from successful results. Failed sections remain at their original index with `body: ""` and `status: "missing"`.
- **Indexed write-back** — Parallel results written into `authoritativeSections[i].body` by index. Recovery writes back by index. Expansion writes back by index.
- **`logSectionState()`** — Logs `count`, `indexes`, `statuses` after every major stage. Ensures `sections.length === outline.length` invariant.
- **Expansion fix** — No longer replaces section content. APPENDS additional blocks to existing body. Accepts only when `afterWC > beforeWC`. Missing sections get full-body generation with `Math.max(250, target * 0.75)` minimum.
- **H2 ownership** — Assembly is the SOLE owner of main H2 headings. `stripMainH2Blocks()` applied to every AI section response, recovery response, and regenerated response.
- **`assembleArticle()`** — Constructs full article from structured `{heading, body}[]` + `faqBlock` + `ctaBlock`. CTA and FAQ are singletons — inserted exactly once, never duplicated or removed.
- **`validateWpBlocks()`** — Reports WordPress block opening/closing counts + mismatches after every reassembly.

### SEO Audit Rewrite
- **14 weighted checks** with category redistribution: SEO Fundamentals (35%), Content & Keyphrase (25%), Readability (15%), Links (10%), Structure & Schema (10%), Images (5%).
- **"Focus Keyphrase in H1" → "Focus Keyphrase in SEO Title"** — checks `title` field, not `<h1>` in blog body.
- **Keyphrase count and density separated** — Count shows occurrences vs. exact target (5). Density shows percentage to 2 decimal places (0.5%-1.5%).
- **Canonical text extraction** — `extractReadableText()` strips wp:html, scripts, HTML tags, URLs, JSON-LD. All word count, keyphrase, and readability checks use this one function.
- **FAQ schema parsing** — Parses `<script type="application/ld+json">` with actual `JSON.parse()`. Validates `@type: "FAQPage"` and `mainEntity` array.
- **H2 close-variant matching** — Detects singular/plural variations as close matches (warning), not exact passes.
- **`not_applicable` status** — Image alt text returns `not_applicable` when no images exist. Score: `null`. Weight redistributed across applicable categories.
- **Word count audit row** — Separate check for body word count vs. target (≥ 95% = warning, ≥ 100% = pass).
- **Null score support** — `seo_checks.score` now nullable (DB column + Drizzle schema). API sends `score: number | null`. UI shows "N/A" for not_applicable. Weighted scoring excludes null scores.

### Generation Pipeline Improvements
- **Buffered generation targets** — `GENERATION_WORD_BUFFER = 1.18`. Internal target = `ceil(requested * 1.18)`. Sections asked for 18% more to reliably hit minimum.
- **`expandToMinimum()` / `trimToMaximum()`** — Section-level expansion/trimming with `originalSections` backup. Rankings use `Math.max(0, allocatedTarget - currentWords)`.
- **Recovery debugging** — `[RECOVERY-STACK]` log captures 5 frames of stack trace. `[RECOVERY-TYPE]` inspects typeof on reduce errors.
- **Language switcher** — Deterministic `renderLanguageSwitcher()` with `b2i-language-switcher` class. Paired slugs via `pairedSlugs()`. Excluded from internal link count.
- **External research links** — `insertExternalResearchLinks()` uses only project research URLs. Filters out B2I-owned domains. Maximum 3 links.
- **Title repair** — `containsExactPhrase()` check + deterministic prepend: `"Keyphrase: What You Need to Know"`. Falls back to AI only if deterministic fails.
- **Paragraph normalization** — `splitLongParagraphs()` splits paragraphs at 3-sentence max. Preserves inline HTML. Applied after expansion and before final save.
- **Link injection protection** — SKIP_SELECTORS already excludes `<h1>-<h6>` headings. Keyphrase protection via character-range skip logic.

### Bug Fixes
- **Section array shrinking** — Fixed: `sectionResults` (filtered to successful only) no longer replaces authoritative array.
- **H2 count changing during expansion** — Fixed: revert to pre-expansion bodies on mismatch.
- **FAQ/CTA disappearing** — Fixed: `assembleArticle()` includes `faqBlock` and `ctaBlock` in every reconstruction.
- **Expansion reducing word count** — Fixed: accepts only when `afterWC > beforeWC`.
- **Recovery `.reduce()` error** — Full stack trace logging added for diagnosis.
- **Word count below target** — Fixed: buffered targets + section expansion.
- **Internal links counted in wp:html** — Fixed: character-range exclusion.
- **Meta description scoring gap** — Fixed: 120-154 now treated as "too short" (was score 0).

---

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

## 2026-07-22 — Keyphrase Budget System, Dynamic SEO Ranges, Normalizer Fixes

### Per-Component Keyphrase Budgets
- **`allocateComponentKeyphraseBudgets()`** — Deterministic 4-phase allocator distributes article-wide keyphrase target across components. Intro gets 1-2, designated H2 section gets 1-2, main sections get 0-2, FAQ/conclusion capped at 1. Invariants enforced: preferred total equals `min(articlePreferred, totalCapacity)` or throws.
- **`buildComponentBudgetPrompt()`** — Injects local budget into each component generation prompt. "EXACT KEYPHRASE BUDGET FOR THIS COMPONENT" with preferred/max limits and natural-language guidance.
- **Heading classification** — Detects Common Mistakes (`/mistake|avoid|pitfall/i`) and FAQ (`/faq|frequently|question/i`) headings. Prevents double-counting by removing synthetic components when headings match.
- **Budget integrated into all 3 generation prompts** — intro, section, and conclusion prompts all receive their component's budget instructions. Removed the old "include exactly X times" global instruction.

### Dynamic Keyphrase Range (Replaces Static 3-5)
- **`keyphraseRangeForWordCount(wordCount)`** — Single source of truth for pass/fail range. 800 words: 3-5, 1200: 4-7, 1800: 6-10, 2500: 8-15, 3500: 10-20, 3501+: 12-25.
- **`keyphrasePreferredTarget(wordCount)`** — Midpoint of range (e.g., 12 for 8-15). Used for generation targets, NOT pass/fail.
- **Density-aware complementary scoring** — Count far outside range but density healthy (0.5-1.5%) → 60 warning (not 0 fail). Both metrics independent but no longer contradictory.
- **All consumers consolidated**: quality-scorer, component-regenerator, prompt-builder, generate-blog route, seo-auditor all use the same `keyphraseRangeForWordCount()` from `generation-constants.ts`.

### SEO Normalizer Hardening
- **Tokenization/detokenization** — Protected blocks (scripts, wp:html, images, media) extracted before normalization, replaced with placeholders, restored byte-for-byte after. Normalizer never sees protected content → `protectedBlocksUnchanged` always true.
- **Multi-pass keyphrase reduction** — `fixExcessiveKeyphrase` now handles paragraph-level AND global reduction (headings, lists, all block types). Retries up to 3 times.
- **Pass/fail uses range** — Normalizer only adjusts when count is outside the `kpRange`, not when it differs from an exact target. Counts within range are left unchanged.

### Article Integrity Pipeline
- **`validateFinalArticleInvariants()`** — Non-destructive check before save. Verifies CTA=1, signup=1, FAQ=1, JSON-LD=1, balanced WP blocks, no nested `<p>`, no malformed H2.
- **Stage guards** — Every mutation stage (assembly, expansion, trim, paragraphs, regeneration, switcher, links) validates output against baseline. Invalid output rejected, previous HTML restored.
- **Integrity gate before save** — 3-tier cascade: accepted normalized HTML → pre-normalization fallback → 422 if both fail.

### CTA/FAQ Extraction Rewrite
- **`extractCtaFromConclusion(conclusion)`** — Searches conclusion only, finds signup URL by position, walks backward to nearest CTA heading. Prevents overmatching across wp:html blocks.
- **`stripProtectedBlocksFromConclusion()`** — Removes exact extracted blocks from conclusion. CTA never duplicated during reassembly.
- **`extractFaqBlock()`** — Extracts FAQ JSON-LD from full article using bounded regex.

### Prompt Cleanup
- **`seo_rules`** — Replaced static "3-5 occurrences" with dynamic range explanation. "Never use a static keyphrase count."
- **`publish_checklist` item 6** — "Keyphrase density is 3-5" → "Exact keyphrase count is within the dynamic range."
- **`blog_structure`** — Fixed CTA/FAQ ordering (CTA before FAQ). Clarified heading count excludes Common Mistakes, FAQ, CTA, conclusion.
- **SQL seed** — Updated `phase5-blog-structure.sql` with dynamic range wording.

### Paragraph Length Audit
- **Bilingual sentence counting** — Added Chinese endings `。！？` to splitter. Mixed English/Chinese paragraphs handled correctly.
- **Exclusion of FAQ/CTA/schema** — `wp:html` and `<script>` blocks excluded from paragraph count.
- **Tiered scoring** — 0 long → 100, 1-2 → 80, 3-5 → 60, >5 → 0. Short articles (≤5 paragraphs) get lenient scoring.

### Bug Fixes
- **Frontend stale version** — Project `useEffect` no longer overwrites fresh content after generation (added `!generatedData` guard).
- **SEO audit keyword** — Client now sends `keyword` in audit POST body. Server resolution: `clientKeyword || projectKeyword` with trim and type-check.
- **Audit POST response discarded** — Client now uses `setLiveAuditResult(result)` immediately, not only waiting for DB refetch.
- **`keyphraseH2Index` TDZ** — Moved H2 selection before budget computation to fix Temporal Dead Zone crash.
- **JSON parse diagnostics** — `robustJsonParse` captures per-strategy errors with position and surrounding context.

### Production Reliability Fixes (Jul 22 afternoon)
- **Malformed JSON repair** — `extractMalformedJsonStringProperty()` in `text-utils.ts`. State-aware scanner tolerates unescaped quotes inside HTML/WP blocks within known JSON string properties (`body`, `intro`, `conclusion`). Runs only after normal parse fails.
- **CTA heading count** — `countCtaHeadingTags()` in `seo-text-utils.ts` counts only actual `<h2>`/`<h3>` elements with CTA text. Wired into `article-final-invariants.ts` and `[QUALITY-CHECK]` diagnostic.
- **Language switcher detection** — Quality scorer changed from visible text (`Read in|閱讀.*版`) to stable class attribute (`b2i-language-switcher`). `hasLanguageSwitcher()` shared helper available.
- **H1/title keyphrase check** — Quality scorer now checks `title` field (SEO title) instead of searching blog body for `<h1>` tags.
- **External links count** — Quality scorer regex now excludes `app.b2ihub.com` (CTA signup link). `countEditorialExternalLinks()` shared helper available.
- **Shared content structure helpers** — `getFirstNReadableWords()`, `countCtaHeadingTags()`, `hasLanguageSwitcher()`, `countEditorialExternalLinks()` added to `seo-text-utils.ts`.

### Diagnostics Added
- `[QUALITY-CHECK]` — titleHasKeyphrase, first100HasKeyphrase, languageSwitcher, ctaHeadingCount, editorialExternalLinks, wordCount, acceptedRange, wpBlocksValid
- `[JSON-PARSE:stage] malformed-string fallback succeeded property=` — when repair works
- `[JSON-PARSE:stage] direct/outerObject/trailingComma FAILED:` — per-strategy error with position and context

### Known Limitations (Jul 22)
- **Word count range in quality scorer** — Uses `scoreMin` with fixed target, not `wordCountRange()`. Dynamic range used by generation.
- **Validator inconsistency** — `validateContent` and integrity checker use different WordPress parsing logic. Need consolidation.
- **Component budget honoring** — Prompts have local budgets but no post-generation validation enforces per-component limits.
- **Normalizer link preservation** — Normalizer restores protected blocks byte-for-byte but link destination verification still runs post-restoration.
