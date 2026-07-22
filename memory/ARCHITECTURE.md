# Architecture

## Folder Structure
```
b2i-content-engine/
├── proxy.ts                     # Next.js 16 auth middleware (session refresh)
├── drizzle.config.ts            # Drizzle Kit config (schema types only, not used at runtime)
├── next.config.ts               # Next.js config
├── tsconfig.json                # TypeScript: strict, ES2017, bundler, @/* alias
├── memory/                      # AI project memory (this folder)
├── supabase/
│   ├── init.sql                 # Initial migration (phases 1-3, idempotent)
│   └── phase4-migration.sql     # Phase 4 tables: prompt_sections, blog_versions, ai_logs
├── src/
│   ├── app/                     # Next.js App Router pages & API routes
│   │   ├── layout.tsx           # Root layout (html/body + AppLayout)
│   │   ├── page.tsx             # / dashboard
│   │   ├── auth/                # Auth pages (login, callback, signout)
│   │   ├── api/                 # REST API routes (47 endpoints)
│   │   │   ├── dashboard/       # GET aggregated dashboard data
│   │   │   ├── profile/         # GET current user profile
│   │   │   ├── projects/        # GET/POST + [id]/GET/PATCH/DELETE
│   │   │   ├── generate-blog/   # POST blog generation (Phase 4)
│   │   │   ├── playground/      # POST prompt playground (Phase 4)
│   │   │   ├── prompt-sections/ # GET/POST prompt sections CRUD (Phase 4)
│   │   │   ├── internal-links/  # GET/POST + [id]/GET/PATCH/DELETE (Phase 5)
│   │   │   ├── suggested-links/ # GET/POST approve/reject suggestions (Phase 5)
│   │   │   ├── publish-blog/    # POST publish + sync links (Phase 5)
│   │   │   ├── projects/[id]/versions/       # GET/DELETE blog versions (Phase 4)
│   │   │   ├── projects/[id]/research/       # GET + /generate POST
│   │   │   ├── projects/[id]/seo/            # GET + /audit POST (Phase 5)
│   │   │   ├── projects/[id]/images/         # GET + /generate POST + /download + /delete (Phase 5)
│   │   │   ├── projects/[id]/social/         # GET
│   │   │   ├── projects/[id]/translate/      # POST DeepSeek translation (Phase 5)
│   │   │   ├── projects/[id]/publish-wordpress/ # POST WordPress REST API publish (Phase 5)
│   │   │   ├── knowledge/                    # GET/POST + [id]/GET/PATCH/DELETE
│   │   │   ├── prompts/                      # GET/POST + [id]/GET/PATCH/DELETE
│   │   │   └── debug/                        # GET diagnostic endpoint
│   │   ├── playground/          # Playground page (prompt testing)
│   │   ├── projects/            # Project pages
│   │   │   ├── page.tsx         # Projects list
│   │   │   └── [id]/            # Workspace + 9-stage stepper sub-pages:
│   │   │       ├── page.tsx     # Blog editor workspace
│   │   │       ├── research/    # Research page
│   │   │       ├── competitor/  # Competitor analysis (Phase 4)
│   │   │       ├── outline/     # Content outline (Phase 4)
│   │   │       ├── seo/         # SEO audit page
│   │   │       ├── images/      # Image generator (Hugging Face FLUX.1-dev)
│   │   │       ├── social/      # Social media page
│   │   │       ├── translation/ # Translation page (Phase 4)
│   │   │       ├── publish/     # Publish page (Phase 4)
│   │   │       └── blog/        # Blog view page (Phase 5)
│   │   ├── knowledge/           # Knowledge base page
│   │   ├── prompts/             # Prompt library page
│   │   └── settings/            # Settings page
│   │       └── links/           # Internal links admin (Phase 5)
│   ├── components/
│   │   ├── layout/              # AppLayout, Sidebar
│   │   └── ui/                  # Badge, Button, Card, EmptyState, Input, Modal, NewProjectModal, ProgressBar, Skeleton
│   ├── db/
│   │   ├── index.ts             # Supabase REST API client singleton (getDb) — replaced Drizzle Postgres connection
│   │   └── schema/              # 15 Drizzle table definitions (TypeScript types only, not used for queries)
│   └── lib/
│       ├── api-client.ts        # Typed fetch wrapper with camelCase normalization (snakeToCamel)
│       ├── use-data.ts          # React data-fetching hook
│       ├── utils.ts             # relativeTime, formatDate
│       ├── repositories/        # 16 data access modules (Supabase REST API)
│       │   ├── projects.ts      # Supabase .from("projects").select/insert/update/delete
│       │   ├── profiles.ts
│       │   ├── knowledge.ts
│       │   ├── prompts.ts
│       │   ├── research.ts
│       │   ├── seo.ts
│       │   ├── images.ts
│       │   ├── social.ts
│       │   ├── activity.ts
│       │   ├── prompt-sections.ts   # Phase 4 — upsert + seedDefaults (force-upserts all 10 sections)
│       │   ├── blog-versions.ts     # Phase 4 — auto-versioning
│       │   ├── ai-logs.ts           # Phase 4 — request/response logging
│       │   ├── internal-links.ts    # Phase 5 — CRUD for managed internal links
│       │   ├── suggested-links.ts   # Phase 5 — pending suggestions CRUD
│       │   ├── wordpress.ts         # Phase 5 — WordPress publish + URL tracking
│       │   └── translation.ts       # Phase 5 — Translation version storage
│       ├── services/            # Business logic
│       │   ├── auth.ts          # getCurrentUserId via Supabase session
│       │   ├── brave.ts         # Brave Search API client (replaced Serper) — GET, X-Subscription-Token header
│       │   ├── brave-types.ts   # Brave API response type definitions
│       │   ├── deepseek.ts      # DeepSeek Chat V3.1 client (chat, chatWithRetry)
│       │   ├── prompt-builder.ts   # Assembles prompts from 10 sections + context + inline linking instructions
│       │   ├── default-prompts.ts  # 10 pre-seeded prompt section defaults (cta + publish_checklist added)
│       │   ├── seo-auditor.ts      # Phase 5 — 14-check weighted SEO analysis (null scores, canonical text, FAQ schema parsing)
│       │   ├── fixers.ts            # Phase 5 — 4 surgical fixers (title, H2, density, readability) with escalating specificity
│       │   ├── section-expander.ts  # Phase 5 — expandToMinimum / trimToMaximum with append-only expansion
│       │   ├── article-postprocessors.ts  # Phase 5 — language switcher, external link inserter
│       │   ├── component-regenerator.ts  # Phase 5 — regenerateSection, generateIntroduction, generateConclusion
│       │   ├── link-sync.ts        # Phase 5 — auto-extracts blog links on publish
│       │   ├── link-suggester.ts   # Phase 5 — scans content for link opportunities
│       │   ├── default-links.ts    # Phase 5 — 7 B2I Hub default links with seeding
│       │   ├── wordpress.ts        # Phase 5 — WordPress REST API client (Application Password auth, Yoast meta)
│       │   ├── image-generation.ts # Phase 5 — Hugging Face FLUX.1-dev image generation
│       │   ├── translation.ts      # Phase 5 — DeepSeek Traditional Chinese (zh-HK) translation
│       │   ├── text-utils.ts       # Phase 1 — shared cleanBodyText(), robustJsonParse(), repairMetaDescription()
│       │   ├── generation-constants.ts # Phase 7 — shared numeric thresholds + keyphrase range + per-component budgets
│       │   ├── deepseek-diagnostics.ts  # Phase 8 — detects malformed JSON patterns in AI responses
│       ├── lib/blog/              # Blog assembly and normalization
│       │   ├── final-seo-normalizer.ts    # Phase 8 — tokenization-based protected block preservation + multi-pass keyphrase reduction
│       │   ├── article-integrity.ts       # Phase 8 — structural integrity baseline + validation against pre-normalization snapshot
│       │   ├── article-final-invariants.ts # Phase 8 — non-destructive final invariant check (CTA, signup, FAQ, WP blocks)
│       │   └── protected-block-extractor.ts # Phase 8 — bounded CTA/FAQ extraction from conclusion only
│       ├── lib/seo/               # Shared SEO text utilities
│       │   └── seo-text-utils.ts          # Phase 8 — canonical text extraction used by both auditor and normalizer
│       └── supabase/            # server, client, proxy utilities
```

## Tech Stack
| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router, Turbopack) | 16.2.10 |
| React | | 19.2.4 |
| Language | TypeScript | ^5 |
| Styling | Tailwind CSS | ^4 |
| Icons | lucide-react | ^1.24.0 |
| Auth | Supabase Auth + @supabase/ssr | ^0.12.3 |
| Database | PostgreSQL (Supabase) | — |
| Data Access | Supabase REST API (@supabase/supabase-js) | ^2.110.6 |
| Schema Types | Drizzle ORM (types only, not used at runtime) | ^0.45.2 |
| Migrations | drizzle-kit | ^0.31.10 |
| HTTP Client | Native fetch (wrapped) | — |
| Search API | Brave Search API (replaced Serper) | — |
| AI LLM | DeepSeek Chat V3.1 (via REST API) | — |

## Component Hierarchy
```
RootLayout (app/layout.tsx)
└── AppLayout (layout/AppLayout.tsx) [client]
    ├── Sidebar (layout/Sidebar.tsx) [client]
    │   ├── Nav Links (Dashboard, Projects, Knowledge, Prompts, Settings)
    │   ├── System Status (API Usage, Storage, CPU)
    │   └── User Profile + Sign Out
    └── Children (page content)
```

## Data Flow
```
Browser (React Client Component)
  → useData hook (client-side fetch)
    → api-client.ts (typed fetch wrapper, auto snake→camelCase conversion)
      → Next.js API Route Handler
        → getCurrentUserId() (Supabase Auth)
        → Repository (Supabase REST API: db.from("table").select/insert/update/delete)
          → getDb() → Supabase REST API (postgREST) → PostgreSQL
        → Response (JSON in snake_case, converted to camelCase by api-client)
  → React State → UI Render
```

## Supabase REST API Data Layer
- **Connection**: `getDb()` creates a `@supabase/supabase-js` client with `SUPABASE_SERVICE_ROLE_KEY`, bypassing pooler DNS issues that affected the Drizzle `postgres.js` direct TCP connection
- **Auth**: Service role key bypasses RLS on the server side; per-user isolation handled in application code via `.eq("user_id", userId)` or `.eq("created_by", userId)`
- **Query pattern**: `db.from("table_name").select("*").eq("user_id", userId).order("col")`
- **Mutation pattern**: `db.from("table_name").insert(snakeCaseData).select().single()`
- **camelCase ↔ snake_case**:
  - Server-side: each repository has a `toSnakeCase()` helper that converts camelCase TS objects to snake_case for Supabase inserts/updates
  - Client-side: `api-client.ts` has a `normalize()` function that recursively converts all incoming snake_case JSON keys to camelCase via `snakeToCamel()`

## DeepSeek Logging Pipeline (5 Steps)
```
[generate-blog:STEP1] Project from DB — logs name, keyword, audience, country, word_count, research/knowledge counts
[generate-blog:STEP2] Prompt Assembly — logs system/user prompt char counts, word count presence, message preview
[generate-blog:STEP3] DeepSeek Request — logs model, max_tokens (32768), response_format (json_object), total prompt size
[generate-blog:STEP4] DeepSeek Response — logs model, token usage (in/out/total), content length, content preview, finish_reason
[generate-blog:STEP5] Blog Output — logs parsed title, blog char/word count, FAQ count, generation time, continuation status, publish log ID
```

## Prompt Builder Architecture
```
Default Prompts (default-prompts.ts)
  → 10 single-responsibility sections: brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure, social_rules, image_rules, translation_rules, cta, publish_checklist
  → Force-upserted into prompt_sections table via seedDefaults() on EVERY generation
  → Each module owns one concern — no duplication across modules

Prompt Builder (prompt-builder.ts)
  → Reads sections from context.promptSections (fetched from DB)
  → buildSystemPrompt(context, modules?): if modules array provided, returns only those sections + CRITICAL FORMAT. If omitted, returns full prompt (backward compatible).
  → STAGE_SYSTEM_PROMPTS: defines module sets per generation stage:
      outline      → brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure
      introduction → brand_voice, seo_rules, formatting_rules, hong_kong_context
      section      → brand_voice, seo_rules, formatting_rules, hong_kong_context, blog_structure
      faq          → brand_voice, seo_rules, formatting_rules
      conclusion   → brand_voice, formatting_rules, cta
  → buildUserMessage(): project details → NON-NEGOTIABLE HARD REQUIREMENTS (deterministic keyphrase target via keyphraseTarget()) → research sources → translation rules → word count instruction → PRE-OUTPUT VALIDATION checklist → JSON output format
  → Outputs { systemPrompt, userMessage }

Blog Generation (POST /api/generate-blog)
  → Section-by-section pipeline:
      A. Outline: title + H2 headings (maxTokens: 8192) — robustJsonParse with AI retry on failure
      B. Introduction: dynamic word target = total × 8% (maxTokens: 4096)
      C. H2 Sections: one call per heading, dynamic word target = (total − reserved) / h2Count. App pre-modifies keyphrase H2 heading in code. AI returns body only {"body": "..."}. (maxTokens: 8192 each)
      D. FAQ: 4-6 QA + schema block (maxTokens: 8192)
      E. Conclusion: dynamic word target = total × 6% (maxTokens: 4096)
      F. Assemble: code joins all sections — app wraps headings in wp:heading blocks
  → Meta repair: repairMetaDescription() in code (append CTA / truncate at sentence boundary)
  → Validation: 3 checks (title, keyphrase count, Flesch). H2 keyphrase guaranteed by app (Phase 4).
  → Surgical fixer pipeline:
      fixTitle → fixKeyphraseDensity → fixReadability
      3 attempts each, paragraph-scoped AI edits (not full article)
  → Saves to blog_versions
  → Updates project.content
  → Returns { success, version, title, blog, etc. }

Surgical Fixers (src/lib/services/fixers.ts)
  → 3 fixers: fixTitle, fixKeyphraseDensity, fixReadability
  → fixTitle: deterministic truncation/prepend first. AI fallback sends only title (200 chars), returns 5 alternatives, code picks first valid one.
  → fixKeyphraseDensity: extracts paragraph blocks, ranks by keyphrase count, sends only target paragraph (~500 chars) to AI.
  → fixReadability: extracts paragraph blocks, scores each for Flesch individually, sends only 3 worst-scoring (~1,500 chars) to AI.
  → Operates on smallest possible unit — never sends full article.
  → fixKeyphraseH2 removed (obsoleted by app-owned headings in Phase 4).
  → Escalating specificity per attempt: general → location → replacement
```

## SEO Audit Engine (2026-07-21 rewrite, 2026-07-22 dynamic ranges)
```
seo-auditor.ts → runAudit({ title, metaDescription, keyword, blog, faq, targetWordCount, targetKeyphraseCount })
  → 14 checks: SEO Title Length, Meta Length, Keyphrase in SEO Title (not H1),
    Body Word Count, Keyphrase in First 100 Words, Exact Keyphrase in H2,
    Exact Keyphrase Count (dynamic range, density-aware scoring), Keyphrase Density (%),
    Paragraph Length (bilingual, CTA/FAQ excluded, tiered scoring),
    Reading Level (Flesch 60-70),
    Internal Links (3-5 unique, wp:html excluded, deduplicated),
    External Links (≥ 2), FAQ Schema (JSON.parse + @type validation),
    Image Alt Text (not_applicable when no images)
  → Keyphrase range: dynamic word-count-aware (keyphraseRangeForWordCount)
  → Density-aware scoring: healthy density prevents harsh count failure
  → Weighted scoring: SEO Fundamentals 35%, Content & Keyphrase 25%,
    Readability 15%, Links 10%, Structure & Schema 10%, Images 5%
  → not_applicable redistributes weight across applicable categories
  → score: number | null (null for not_applicable — seo_checks.score is nullable)
  → POST /api/projects/[id]/seo/audit — immutable snapshot from latest saved version
  → DELETE /api/projects/[id]/seo/audit — clears checks on version restore/generation
```

## Section Lifecycle (2026-07-21)
```
GeneratedSection[] — created once after outline, never filtered/compacted/rebuilt
  → index: matches outline position (0,1,2,3,4,5)
  → heading: from h2Headings[index], never rebuilt from HTML
  → status: "pending" → "generated" | "recovered" | "missing" → "expanded" | "regenerated"
  → body: written by index from parallel, recovery, expansion results

Invariant: sections.length === outline.length at every lifecycle stage
  → logSectionState("stage") logs count, indexes, statuses, body words
  → Failed section stays at original index with body: "", status: "missing"
  → Missing sections prioritized by expander for full-body generation

## Internal Linking System
```
Default Links (default-links.ts)
  → 7 B2I Hub URLs with keywords, priority, min/max per article
  → seedDefaultLinks(userId) inserts if not exists (checked by created_by + url)

Link Injector (link-injector.ts)
  → InjectLinks(content, links) → replaces keyword occurrences with <a> tags
  → Skips headings, code blocks, pre blocks, existing links, wp:html blocks
  → 500+ char spacing between links, max 15 total links

Link Sync (link-sync.ts)
  → syncLinksFromContent(content, userId) → extracts <a href="/blog/..."> from content
  → Upserts to internal_links table by created_by + url

Link Suggester (link-suggester.ts)
  → suggestLinks(content) → scans for link-worthy phrases matched against active links
  → Returns confidence-scored suggestions → stored in suggested_links table
```

## Authentication
- **Provider**: Supabase Auth (email/password)
- **Session storage**: Cookies (`sb-{project-ref}-auth-token`)
- **Server-side**: `createServerClient` from `@supabase/ssr` with `cookies()` from `next/headers`
- **Client-side**: `createBrowserClient` from `@supabase/ssr` with `document.cookie` fallback
- **Auto-profile**: `handle_new_user()` trigger creates `profiles` row on signup

## Final SEO Normalizer (2026-07-22)
```
normalizeFinalSeo({ html, focusKeyphrase, targetWordCount, targetKeyphraseCount, ... })
  → Tokenization — scripts, wp:html, images, media blocks replaced with placeholders
  → H2 keyphrase fix — ensures one H2 contains exact keyphrase
  → Keyphrase reduction — paragraph-level + global reduction, multi-pass
  → Word count expansion — AI-powered, unsupported statistics blocked
  → Paragraph splitting — deterministic sentence-level splits
  → Readability — targeted paragraph rewrites, max 3 attempts
  → Detokenization — protected blocks restored byte-for-byte
  → Pass/fail — uses dynamic kpRange, not exact target
  → safety.protectedBlocksUnchanged always true (blocks never seen by normalizer)
```

## Per-Component Keyphrase Budgets (2026-07-22)
```
allocateComponentKeyphraseBudgets({ articleBudget, components })
  → Phase 1: Required placements (intro 1-2, designated H2 1-2)
  → Phase 2: Main sections with preferred=0 get 1
  → Phase 3: Upgrade main-section maxes from 1 to 2
  → Phase 4: Priority-based distribution of remaining budget
  → Invariant: preferredTotal === min(articlePreferred, totalCapacity)
  → Heading classification: detects mistakes/FAQ patterns to avoid double-counting

buildComponentBudgetPrompt(budget, focusKeyphrase)
  → Injects "EXACT KEYPHRASE BUDGET FOR THIS COMPONENT" into prompts
  → Local budget (preferred, max), not article-wide target
  → Designated H2: "Do not repeatedly restate the exact phrase"
  → max=0: "Do not use the exact keyphrase anywhere in this component"
```

## Article Integrity Pipeline (2026-07-22)
```
createArticleIntegrityBaseline(html)
  → Captures wp block counts, link hrefs, FAQ/switcher/CTA blocks, scripts

validateFinalArticleIntegrity(html, baseline)
  → Checks: wp block balance, nested <p>, bare H2, unclosed tags, link preservation
  → Excludes <script> and wp:html blocks from tag counting

validateFinalArticleInvariants(article)
  → Non-destructive: CTA=1, signup=1, FAQ=1, balanced WP blocks
  → Returns { valid, errors, counts } — never mutates

Stage guards at: assembly, expansion, trim, paragraphs, regeneration, switcher, links
  → guardStageOutput(currentHtml, previousHtml, baseline, stage)
  → Invalid output rejected, previous valid HTML restored
```
- **Protected paths**: `proxy.ts` guards `/projects`, `/knowledge`, `/prompts`, `/settings`, `/api/*`
