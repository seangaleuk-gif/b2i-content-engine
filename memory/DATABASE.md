# Database Schema

## Overview
- **Database**: PostgreSQL (Supabase)
- **Data Access**: Supabase REST API via `@supabase/supabase-js` (service role key), NOT Drizzle ORM at runtime
- **Drizzle ORM**: Retained for TypeScript schema types only (`src/db/schema/*.ts`), not used for queries
- **Migration**: `supabase/init.sql` (phases 1-3) + `supabase/phase4-migration.sql` (phase 4), run in Supabase SQL Editor
- **RLS**: Enabled on all tables, per-user isolation
- **Serialization**: camelCase in TypeScript, snake_case in PostgreSQL — repositories convert with `toSnakeCase()`, `api-client.ts` converts responses with `snakeToCamel()`

---

## Tables

### `profiles`
User profiles, linked 1:1 to `auth.users`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, FK→auth.users(id) CASCADE | User UUID |
| `full_name` | text | NOT NULL | Display name |
| `avatar_url` | text | nullable | — |
| `role` | text | NOT NULL, DEFAULT 'editor' | — |
| `api_credits_used` | integer | NOT NULL, DEFAULT 0 | — |
| `api_credits_limit` | integer | NOT NULL, DEFAULT 10000 | — |
| `storage_used_bytes` | bigint | NOT NULL, DEFAULT 0 | — |
| `storage_limit_bytes` | bigint | NOT NULL, DEFAULT 5GB | — |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Auto-updated by trigger |

**Indexes**: None (primary key only)

---

### `projects`
Content projects — the core entity.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Owner |
| `name` | text | NOT NULL | Project title |
| `status` | text | NOT NULL, DEFAULT 'draft' | draft\|published\|research\|images\|translation |
| `keyword` | text | NOT NULL, DEFAULT '' | Target keyword |
| `audience` | text | NOT NULL, DEFAULT '' | Target audience |
| `country` | text | NOT NULL, DEFAULT 'US' | Target country |
| `word_count` | integer | NOT NULL, DEFAULT 2500 | Content word count (default changed from 0 to 2500) |
| `content` | text | DEFAULT '' | WordPress block content |
| `seo_score` | integer | nullable | Overall SEO score |
| `published_url` | text | nullable | URL after publishing |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Auto-updated by trigger |

**Indexes**: `idx_projects_user_id`, `idx_projects_status`

---

### `knowledge_items`
Knowledge base documents.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Owner |
| `title` | text | NOT NULL | Document title |
| `content` | text | NOT NULL, DEFAULT '' | Document content |
| `tags` | jsonb | NOT NULL, DEFAULT [] | string[] |
| `pinned` | boolean | NOT NULL, DEFAULT false | — |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Auto-updated by trigger |

**Indexes**: `idx_knowledge_items_user_id`

---

### `prompts`
AI prompt templates with variable substitution.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Owner |
| `name` | text | NOT NULL | Prompt name |
| `purpose` | text | NOT NULL, DEFAULT '' | Description |
| `tags` | jsonb | NOT NULL, DEFAULT [] | string[] |
| `template` | text | NOT NULL | Template with `{variable}` placeholders |
| `variables` | jsonb | NOT NULL, DEFAULT {} | Record<string, string> |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Auto-updated by trigger |

**Indexes**: `idx_prompts_user_id`

---

### `research_sources`
Research results per project (populated by Brave Search API).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `project_id` | integer | NOT NULL, FK→projects(id) CASCADE | Parent project |
| `category` | text | NOT NULL | google\|discussion\|faq\|news\|paa\|related\|knowledge\|competitor\|statistic\|quote\|authority |
| `title` | text | NOT NULL | Source title |
| `url` | text | NOT NULL, DEFAULT '' | Source URL |
| `snippet` | text | NOT NULL, DEFAULT '' | Source excerpt |
| `position` | integer | NOT NULL, DEFAULT 0 | Display order |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_research_sources_project_id`

---

### `seo_checks`
SEO audit checks per project.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `project_id` | integer | NOT NULL, FK→projects(id) CASCADE | Parent project |
| `label` | text | NOT NULL | Check label |
| `description` | text | NOT NULL, DEFAULT '' | Check description |
| `status` | text | NOT NULL, DEFAULT 'pending' | pass\|fail\|warning\|pending |
| `score` | integer | NOT NULL, DEFAULT 0 | 0-100 |
| `fix` | text | NOT NULL, DEFAULT '' | Suggested fix text |
| `category` | text | NOT NULL, DEFAULT 'general' | Meta\|Headings\|Keywords\|Links\|Readability\|Accessibility\|Structured Data |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_seo_checks_project_id`

---

### `images`
AI-generated images per project.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `project_id` | integer | NOT NULL, FK→projects(id) CASCADE | Parent project |
| `type` | text | NOT NULL | featured\|social\|facebook |
| `width` | integer | NOT NULL | Image width |
| `height` | integer | NOT NULL | Image height |
| `prompt` | text | NOT NULL, DEFAULT '' | Generation prompt |
| `url` | text | nullable | Generated image URL |
| `status` | text | NOT NULL, DEFAULT 'pending' | pending\|generated\|failed |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_images_project_id`

---

### `social_posts`
Social media posts per project and platform.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `project_id` | integer | NOT NULL, FK→projects(id) CASCADE | Parent project |
| `platform` | text | NOT NULL | threads\|facebook\|linkedin\|instagram\|newsletter |
| `content` | text | NOT NULL, DEFAULT '' | Post content |
| `character_count` | integer | NOT NULL, DEFAULT 0 | — |
| `hashtags` | jsonb | NOT NULL, DEFAULT [] | string[] |
| `status` | text | NOT NULL, DEFAULT 'draft' | draft\|published |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_social_posts_project_id`

---

### `activity_log`
User activity event log.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | User |
| `project_id` | integer | nullable, FK→projects(id) SET NULL | Related project |
| `action` | text | NOT NULL | Action name |
| `description` | text | NOT NULL, DEFAULT '' | Description |
| `type` | text | NOT NULL, DEFAULT 'general' | publish\|draft\|research\|audit\|social |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_activity_log_user_id`, `idx_activity_log_project_id`

---

### `prompt_sections` (Phase 4)
Prompt section templates per user, pre-seeded from defaults. Composable building blocks for the prompt builder.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Owner |
| `section_key` | text | NOT NULL | Unique section key per user (e.g. "brand_voice", "seo_rules") |
| `content` | text | NOT NULL | Section template content |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Auto-updated by trigger |

**Indexes**: `idx_prompt_sections_user_id_key` (UNIQUE composite on `user_id` + `section_key`)

**RLS Policies**: SELECT, INSERT, UPDATE, DELETE — all restricted to `user_id = auth.uid()`

**Default seeds** (10 sections, force-upserted per user on every `POST /api/generate-blog` via `seedDefaults()`):
- `brand_voice` — professional B2B content writer voice, short sentences, no buzzwords
- `seo_rules` — keyword placement, heading hierarchy, meta descriptions, readability
- `formatting_rules` — WordPress block format only (no Markdown), paragraph limits, tables, blockquotes
- `hong_kong_context` — British spelling, HKD currency, DD Month YYYY dates, local districts, B2I Hub mission
- `blog_structure` — H1 → intro → H2 sections → pitfalls → CTA block → FAQ → FAQ schema → conclusion
- `social_rules` — platform-specific post rules (LinkedIn, Facebook, Instagram, Twitter/X, Threads)
- `image_rules` — AI image generation prompt guidelines, dimensions, style preferences
- `translation_rules` — English ↔ Traditional Chinese (HK) translation conventions
- `cta` — Exact CTA HTML blocks (English + Chinese) for placement before FAQ section
- `publish_checklist` — 15-item pre-publish verification checklist

---

### `blog_versions` (Phase 4)
Versioned blog content snapshots per project. Each generation creates a new version with full structured output.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `project_id` | integer | NOT NULL, FK→projects(id) CASCADE | Parent project |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Creator |
| `version_number` | integer | NOT NULL, DEFAULT 1 | Sequential per project |
| `title` | text | nullable | SEO blog title |
| `slug` | text | nullable | URL-friendly slug |
| `meta_description` | text | nullable | Meta description |
| `excerpt` | text | nullable | Preview excerpt |
| `blog` | text | nullable | Full WordPress block blog content |
| `faq` | jsonb | DEFAULT [] | FAQ items [{question, answer}] |
| `internal_links` | jsonb | DEFAULT [] | Internal link URLs (string[]) |
| `external_links` | jsonb | DEFAULT [] | External link URLs (string[]) |
| `categories` | jsonb | DEFAULT [] | Content categories (string[]) |
| `tags` | jsonb | DEFAULT [] | Content tags (string[]) |
| `reading_time` | text | nullable | Estimated reading time (e.g. "5 min read") |
| `word_count` | integer | DEFAULT 0 | Blog body word count |
| `summary` | text | nullable | Brief summary |
| `model` | text | nullable | AI model used (e.g. "deepseek-chat") |
| `prompt_version` | text | nullable | Prompt version identifier |
| `generation_time_ms` | integer | nullable | Total generation time |
| `token_usage` | jsonb | nullable | Token usage object {promptTokens, completionTokens, totalTokens} |
| `status` | text | NOT NULL, DEFAULT 'draft' | draft |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_blog_versions_project_id`, `idx_blog_versions_user_id`

**RLS Policies**: All operations gated by `project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())`

---

### `ai_logs` (Phase 4)
AI API call logs for debugging, cost tracking, and performance monitoring.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | User |
| `project_id` | integer | nullable, FK→projects(id) CASCADE | Related project (nullable for playground) |
| `model` | text | NOT NULL | Model name (e.g. "deepseek-chat") |
| `prompt_size` | integer | nullable | Total prompt characters |
| `completion_size` | integer | nullable | Response characters |
| `tokens_in` | integer | nullable | Prompt tokens |
| `tokens_out` | integer | nullable | Completion tokens |
| `tokens_total` | integer | nullable | Total tokens |
| `generation_time_ms` | integer | nullable | Request duration |
| `status` | text | NOT NULL, DEFAULT 'success' | success\|error |
| `error_message` | text | nullable | Error details if failed |
| `endpoint` | text | NOT NULL | API endpoint that triggered the call |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: `idx_ai_logs_user_id`, `idx_ai_logs_project_id`

**RLS Policies**: SELECT, INSERT, DELETE — all restricted to `user_id = auth.uid()`

---

### `internal_links` (Phase 5)
Managed internal links for auto-injection into blog content. Uses `created_by` for user ownership.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `created_by` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Owner (NOT `user_id`) |
| `display_text` | text | NOT NULL | Link display text |
| `url` | text | NOT NULL | Target URL (e.g. "/blog/creator-led-marketing-hong-kong") |
| `keywords` | jsonb | NOT NULL, DEFAULT [] | Keyword phrases for injection matching (string[]) |
| `priority` | integer | NOT NULL, DEFAULT 1 | Higher = preferred for injection |
| `min_per_article` | integer | NOT NULL, DEFAULT 1 | Minimum links per article |
| `max_per_article` | integer | NOT NULL, DEFAULT 3 | Maximum links per article |
| `active` | boolean | NOT NULL, DEFAULT true | Whether link is available for injection |
| `auto_synced` | boolean | NOT NULL, DEFAULT false | Whether link was auto-extracted from content |
| `status` | text | NOT NULL, DEFAULT 'active' | active\|inactive |
| `pinned` | boolean | NOT NULL, DEFAULT false | Pinned to top of list |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Auto-updated by trigger |

**Indexes**: Standard (user + url dedup handled in application code)

**Default seeds** (7 B2I Hub links, seeded per user via `seedDefaultLinks()`):
- Creator-Led Marketing in Hong Kong → `/blog/creator-led-marketing-hong-kong`
- Content That Converts → `/blog/content-that-converts`
- Pitch Scripts 7-Day Challenge → `/blog/pitch-scripts-7-day-challenge`
- Influencer Rates and Tax in Hong Kong → `/blog/influencer-rates-tax-hong-kong`
- Become Brand-Ready in Hong Kong → `/blog/become-brand-ready-hong-kong`
- Where to Find Paid Deals in Hong Kong → `/blog/where-to-find-paid-deals-hong-kong`
- Negotiation, Media Kits and Verification → `/blog/negotiation-media-kits-verification`

---

### `suggested_links` (Phase 5)
Link suggestions generated by the link suggester, pending user approval.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | serial | PK | Auto-increment |
| `user_id` | uuid | NOT NULL, FK→auth.users(id) CASCADE | Owner |
| `phrase` | text | NOT NULL | Matched phrase in source content |
| `suggested_url` | text | NOT NULL | Suggested target URL |
| `source_content` | text | nullable | Context snippet where phrase was found |
| `project_id` | integer | nullable | Related project |
| `confidence` | real | NOT NULL, DEFAULT 0.5 | Match confidence score (0.0-1.0) |
| `status` | text | NOT NULL, DEFAULT 'pending' | pending\|approved\|rejected |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | — |

**Indexes**: Standard

---

## Relationships
```
auth.users (1) ──< (N) profiles              (1:1)
auth.users (1) ──< (N) projects              (1:N)
auth.users (1) ──< (N) knowledge_items       (1:N)
auth.users (1) ──< (N) prompts               (1:N)
auth.users (1) ──< (N) activity_log          (1:N)
auth.users (1) ──< (N) prompt_sections       (1:N)
auth.users (1) ──< (N) blog_versions         (1:N)
auth.users (1) ──< (N) ai_logs               (1:N)
auth.users (1) ──< (N) internal_links        (1:N, FK via created_by)
auth.users (1) ──< (N) suggested_links       (1:N)
projects   (1) ──< (N) research_sources       (1:N)
projects   (1) ──< (N) seo_checks             (1:N)
projects   (1) ──< (N) images                 (1:N)
projects   (1) ──< (N) social_posts           (1:N)
projects   (1) ──< (N) activity_log           (1:N, nullable)
projects   (1) ──< (N) blog_versions          (1:N)
projects   (1) ──< (N) ai_logs                (1:N, nullable)
projects   (1) ──< (N) suggested_links        (1:N, nullable)
```

## Migrations
| File | Description |
|------|-------------|
| `src/db/migrations/0000_initial_schema.sql` | Full DDL: 9 tables, FKs, indexes, RLS, triggers (Phases 1-3) |
| `supabase/init.sql` | Copy of initial migration (idempotent: DROP IF EXISTS before CREATE) |
| `supabase/phase4-migration.sql` | Phase 4 tables: prompt_sections, blog_versions, ai_logs + RLS + triggers + seed data |

## Triggers
| Trigger | On | Action |
|---------|-----|--------|
| `on_auth_user_created` | `auth.users` INSERT | Inserts profile row |
| `trg_profiles_updated_at` | `profiles` UPDATE | Sets `updated_at = now()` |
| `trg_projects_updated_at` | `projects` UPDATE | Sets `updated_at = now()` |
| `trg_knowledge_items_updated_at` | `knowledge_items` UPDATE | Sets `updated_at = now()` |
| `trg_prompts_updated_at` | `prompts` UPDATE | Sets `updated_at = now()` |
| `trg_prompt_sections_updated_at` | `prompt_sections` UPDATE | Sets `updated_at = now()` |
| `trg_internal_links_updated_at` | `internal_links` UPDATE | Sets `updated_at = now()` |

## Notes
- **All tables use Row-Level Security (RLS)**. Server-side repositories bypass RLS using the Supabase service role key (`SUPABASE_SERVICE_ROLE_KEY`), with per-user isolation enforced in application code via `.eq("user_id", userId)` or `.eq("created_by", userId)`.
- **Drizzle is type-only**: Table definitions in `src/db/schema/` are only used for `$inferSelect` and `$inferInsert` types. All runtime queries go through the Supabase REST API.
- **Switched from Drizzle direct connection**: The original `postgres.js` Drizzle driver required a direct TCP connection to Supabase's pooler, which caused DNS resolution failures on Windows. Switching to the Supabase REST API (`@supabase/supabase-js` client) resolved this cleanly.
- Auth is handled by Supabase Auth (`auth.users` schema). The `profiles` table extends user data.
- `ON DELETE CASCADE` ensures cleanup when users or projects are deleted.
- `ON DELETE SET NULL` on `activity_log.project_id` and `ai_logs.project_id` preserves history.
- Phase 4 prompt sections are force-upserted via `src/lib/services/default-prompts.ts` on every `POST /api/generate-blog` call (`seedDefaults()` upserts all 10 sections).
- `prompt_sections` has a UNIQUE constraint on `(user_id, section_key)` — upserts keyed on this pair.
- Phase 5 internal links use `created_by` column (not `user_id`) for user ownership. The 7 default links are seeded per user on first access via `seedDefaultLinks()`.
- `projects.word_count` default is 2500 (changed from 0 in Phase 4).
- Word count measurement strips WordPress blocks, HTML, JSON-LD, and code blocks — counts body text only.
