# API Reference

All endpoints require authentication (Supabase session cookie). Unauthenticated requests return **401**.
Protected by `proxy.ts` matching: `/api/projects`, `/api/knowledge`, `/api/prompts`, `/api/dashboard`, `/api/profile`, `/api/internal-links`, `/api/suggested-links`, `/api/publish-blog`.

Note: All server-side repositories use the Supabase REST API (via `@supabase/supabase-js` service role client). Response JSON keys are in snake_case from the database, but the client-side `api-client.ts` normalizes all keys to camelCase automatically.

---

## Dashboard

### `GET /api/dashboard`
Aggregated dashboard data.

**Response 200:**
```json
{
  "stats": {
    "totalProjects": 24,
    "published": 18,
    "drafts": 6,
    "research": 3
  },
  "recentProjects": [{ "id": 1, "name": "...", "status": "draft", "keyword": "...", "updatedAt": "..." }],
  "activity": [{ "id": 1, "action": "Published", "description": "...", "type": "publish", "createdAt": "..." }],
  "profile": { "apiCreditsUsed": 0, "apiCreditsLimit": 10000, "storageUsedBytes": 0, "storageLimitBytes": 5368709120 }
}
```

**Errors**: 401 (Unauthorized), 500 (with `detail` field)

---

## Profile

### `GET /api/profile`
Current user's profile. Auto-creates profile if not exists.

**Response 200:**
```json
{ "id": "uuid", "fullName": "Sean Adams", "role": "editor", "apiCreditsUsed": 0, ... }
```

**Errors**: 401, 500

---

## Projects

### `GET /api/projects`
List all projects for authenticated user.

**Response 200:** `Project[]`

### `POST /api/projects`
Create a new project. Also creates an activity log entry.

**Request:**
```json
{ "name": "Project Name", "status": "draft", "keyword": "seo", "audience": "Marketers", "country": "US" }
```

**Response 201:** `Project`

### `GET /api/projects/[id]`
Get single project by ID. Returns 404 if not found or not owned by user.

### `PATCH /api/projects/[id]`
Update project fields. Logs activity for content saves and status changes to "published".

**Response 200:** `Project`

### `DELETE /api/projects/[id]`
Delete project. Returns 404 if not found.

**Response 200:** `{ "success": true }`

---

## Blog Versions

### `GET /api/projects/[id]/versions`
List all blog versions for a project, ordered by `version_number DESC`.

**Response 200:** `BlogVersion[]`

Each version object:
```json
{
  "id": 1,
  "projectId": 1,
  "userId": "uuid",
  "versionNumber": 3,
  "title": "SEO Blog Title",
  "slug": "url-friendly-slug",
  "metaDescription": "Meta description...",
  "excerpt": "Excerpt text...",
  "blog": "## Full Markdown Content...",
  "faq": [{ "question": "...", "answer": "..." }],
  "internalLinks": ["/page-1"],
  "externalLinks": ["https://example.com"],
  "categories": ["SEO"],
  "tags": ["digital-marketing"],
  "readingTime": "5 min read",
  "wordCount": 1523,
  "summary": "Brief summary...",
  "model": "deepseek-chat",
  "tokenUsage": { "promptTokens": 500, "completionTokens": 1000, "totalTokens": 1500 },
  "generationTimeMs": 8500,
  "status": "draft",
  "createdAt": "2026-07-17T..."
}
```

### `DELETE /api/projects/[id]/versions`
Delete all blog versions for a project.

**Response 200:** `{ "success": true }`

---

## Research

### `GET /api/projects/[id]/research`
Get all research sources for a project, ordered by position.

**Response 200:** `ResearchSource[]`

### `POST /api/projects/[id]/research/generate`
Triggers Brave Search API research for the project's keyword/topic.

- Clears all existing research for the project
- Calls Brave Search (GET with `X-Subscription-Token` header) with retry (max 3 attempts)
- Saves results categorized as: web (google), discussion, faq, news
- Creates activity log entry

**Request:** `{}` (no body required — uses `project.keyword` or `project.name`)

**Response 201:**
```json
{ "success": true, "query": "AI lead generation", "sourcesFound": 15, "sources": [...] }
```

**Errors**: 400 (no keyword/topic), 401, 404 (project not found), 500 (API failure)

---

## SEO

### `GET /api/projects/[id]/seo`
Get all SEO checks for a project (12 checks per audit).

**Response 200:** `SeoCheck[]`

### `POST /api/projects/[id]/seo/audit`
Run a 12-check SEO audit on the project's blog content. Clears old checks, stores new results in `seo_checks` table.

**Request:**
```json
{
  "title": "Optional override title",
  "metaDescription": "Optional override meta",
  "slug": "Optional override slug",
  "keyword": "Optional override keyword",
  "blog": "Blog content to audit (uses project.content if not provided)"
}
```

**Response 201:**
```json
{
  "overallScore": 72,
  "checks": [
    { "label": "SEO Title Length", "description": "...", "status": "pass", "score": 100, "fix": "", "category": "Meta" },
    { "label": "Meta Description Length", "description": "...", "status": "warning", "score": 50, "fix": "...", "category": "Meta" },
    { "label": "Focus Keyphrase in H1", "description": "...", "status": "fail", "score": 0, "fix": "...", "category": "Keywords" },
    { "label": "Keyphrase in First 100 Words", "description": "...", "status": "pass", "score": 100, "fix": "", "category": "Keywords" },
    { "label": "Keyphrase in H2", "description": "...", "status": "warning", "score": 60, "fix": "...", "category": "Keywords" },
    { "label": "Keyphrase Density", "description": "...", "status": "pass", "score": 100, "fix": "", "category": "Keywords" },
    { "label": "Internal Links", "description": "...", "status": "warning", "score": 50, "fix": "...", "category": "Links" },
    { "label": "External Links", "description": "...", "status": "pass", "score": 100, "fix": "", "category": "Links" },
    { "label": "Paragraph Length", "description": "...", "status": "pass", "score": 100, "fix": "", "category": "Readability" },
    { "label": "Image Alt Text", "description": "...", "status": "warning", "score": 60, "fix": "...", "category": "Accessibility" },
    { "label": "FAQ Schema", "description": "...", "status": "fail", "score": 0, "fix": "...", "category": "Structured Data" },
    { "label": "Reading Level", "description": "...", "status": "pass", "score": 100, "fix": "", "category": "Readability" }
  ],
  "summary": { "passed": 6, "warnings": 4, "failed": 2 }
}
```

**Errors**: 400 (no blog content), 401, 404 (project not found), 500

---

## Images (Phase 5)
### `GET /api/projects/[id]/images`
Get all images for a project.

**Response 200:** `Image[]`

### `POST /api/projects/[id]/images/generate`
Generate an image using Hugging Face FLUX.1-dev. Stores result URL and prompt in `images` table.

**Request:**
```json
{ "type": "featured", "prompt": "Optional custom prompt", "width": 1200, "height": 630 }
```

**Response 201:**
```json
{ "id": 1, "url": "https://...", "prompt": "...", "type": "featured", "status": "generated" }
```

**Supported types**: `featured` (1200×630), `social` (1080×1080), `facebook` (1200×628)

### `POST /api/projects/[id]/images/regenerate`
Regenerate an existing image with optional new prompt. Uses existing type/dimensions if not overridden.

**Request:**
```json
{ "imageId": 1, "prompt": "Updated prompt" }
```

### `POST /api/projects/[id]/images/download`
Return the image binary or URL for download.

### `DELETE /api/projects/[id]/images`
Delete an image record.

**Request:**
```json
{ "imageId": 1 }
```

---

## Translation (Phase 5)

### `POST /api/projects/[id]/translate`
Translate blog content from English to Traditional Chinese (zh-HK) using DeepSeek API. Stores translated version with language switcher URL cross-references.

**Request:**
```json
{ "projectId": 1 }
```

**Response 201:**
```json
{
  "success": true,
  "enVersion": { "title": "...", "blog": "...", "slug": "..." },
  "zhVersion": { "title": "...", "blog": "...", "slug": "..." },
  "languageSwitcher": { "en": "/blog/slug", "zh": "/zh/blog/slug" }
}
```

---

## Social

### `GET /api/projects/[id]/social`
Get all social media posts for a project, ordered by `created_at DESC`.

**Response 200:** `SocialPost[]`

---

## Internal Links (Phase 5)

### `GET /api/internal-links`
List all internal links for user + pending suggestion count.

**Response 200:**
```json
{
  "links": [{ "id": 1, "displayText": "Creator-Led Marketing", "url": "/blog/creator-led-marketing-hong-kong", "keywords": ["creator marketing"], "priority": 5, "active": true, "pinned": true, ... }],
  "pendingSuggestions": 3
}
```

### `POST /api/internal-links`
Create a new internal link.

**Request:**
```json
{ "displayText": "Link Text", "url": "/blog/target-page", "keywords": ["key1", "key2"], "priority": 3, "active": true }
```

**Response 201:** `InternalLink`

### `GET /api/internal-links/[id]`
Get single internal link.

### `PATCH /api/internal-links/[id]`
Update internal link fields.

### `DELETE /api/internal-links/[id]`
Delete internal link.

---

## Suggested Links (Phase 5)

### `GET /api/suggested-links`
Get all pending link suggestions for current user.

**Response 200:**
```json
{
  "suggestions": [{ "id": 1, "phrase": "creator marketing", "suggestedUrl": "/blog/creator-led-marketing-hong-kong", "confidence": 0.85, "status": "pending", ... }]
}
```

### `POST /api/suggested-links`
Approve or reject a suggestion. Accepted action: `"approve"` or `"reject"`.

**Request:**
```json
{ "id": 1, "action": "approve" }
```

**Response 200:**
```json
{ "success": true, "suggestion": { "id": 1, "status": "approved", ... } }
```

---

## Publish Blog (Phase 5)

### `POST /api/publish-blog`
Publish a project (sets status to "published") and syncs internal links from the latest blog version content.

**Request:**
```json
{ "projectId": 1 }
```

**Response 200:**
```json
{ "success": true, "projectId": 1, "linksSynced": 5, "message": "Project published successfully" }
```

**Errors**: 400 (missing projectId), 401, 404 (project not found), 500

---

## WordPress Publishing (Phase 5)

### `POST /api/projects/[id]/publish-wordpress`
Publish blog content directly to WordPress via REST API with Application Password authentication. Resolves category/tag names to IDs, writes Yoast SEO meta fields, and supports bilingual (EN + ZH-HK) publish.

**Request:**
```json
{ "projectId": 1, "language": "en" }
```

**Response 200:**
```json
{
  "success": true,
  "postId": 123,
  "url": "https://b2i-hub.com/blog/slug",
  "yoastMeta": { "title": "...", "metadesc": "...", "focuskw": "..." }
}
```

**Env vars required**: `WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD`

**Errors**: 400 (missing projectId), 401, 404 (project not found), 500 (API failure)

---

## Knowledge Base

### `GET /api/knowledge`
List all knowledge items for user.

**Response 200:** `KnowledgeItem[]`

### `POST /api/knowledge`
Create a knowledge item.

**Request:**
```json
{ "title": "Doc Title", "content": "...", "tags": ["tag1"], "pinned": false }
```

**Response 201:** `KnowledgeItem`

### `GET /api/knowledge/[id]`
Get single knowledge item. Returns 404 if not found.

### `PATCH /api/knowledge/[id]`
Update knowledge item fields.

### `DELETE /api/knowledge/[id]`
Delete knowledge item. Returns 404 if not found.

---

## Prompts

### `GET /api/prompts`
List all prompts for user.

**Response 200:** `Prompt[]`

### `POST /api/prompts`
Create a prompt.

**Request:**
```json
{ "name": "Prompt Name", "purpose": "Description", "tags": ["tag"], "template": "Write about {topic}", "variables": { "topic": "" } }
```

**Response 201:** `Prompt`

### `GET /api/prompts/[id]`
Get single prompt.

### `PATCH /api/prompts/[id]`
Update prompt fields.

### `DELETE /api/prompts/[id]`
Delete prompt.

---

## Debug

### `GET /api/debug`
Diagnostic endpoint. Tests 5 layers: cookies, Supabase client, auth, DB connection, DB query.

**Response 200:**
```json
{
  "cookies": { "count": 3, "names": ["sb-jwpn...-auth-token", ...] },
  "client": { "created": true },
  "auth": { "authenticated": true, "userId": "uuid", "error": null },
  "db": { "connected": true },
  "dbQuery": { "rowCount": 1 }
}
```

---

## Auth

### `POST /auth/login`
(Page, not API) Email/password login form. Calls `supabase.auth.signInWithPassword()`.

### `GET /auth/callback`
OAuth callback. Exchanges `?code=` query param for Supabase session, then redirects.

### `POST /auth/signout`
Signs out current session and redirects to `/auth/login`.

---

## Blog Generation (Phase 4)

### `POST /api/generate-blog`
Generate structured blog content using DeepSeek Chat V3.1 AI. Runs a 5-step logging pipeline (database context → prompt assembly → DeepSeek request → response → output). Creates a new blog version and logs request metadata to ai_logs.

**Continuation Loop**: If generated body word count is below the target, makes up to 3 additional AI calls requesting expansion. Each continuation sends a tiny JSON response instruction — the full article is never re-sent. Continuation responses parsed as `{ additionalContent: "..." }`.

**Request:**
```json
{
  "projectId": 1
}
```

**Response 201:**
```json
{
  "success": true,
  "version": 3,
  "title": "SEO-Optimized Blog Title",
  "slug": "url-friendly-slug",
  "metaDescription": "Compelling meta description...",
  "excerpt": "2-3 sentence excerpt...",
  "blog": "## Full Markdown Content...",
  "faq": [{ "question": "What is...?", "answer": "Answer text..." }],
  "internalLinks": ["/page-1", "/page-2"],
  "externalLinks": ["https://source.com"],
  "categories": ["category-1"],
  "tags": ["tag-1", "tag-2"],
  "readingTime": "5 min read",
  "wordCount": 1523,
  "summary": "Brief summary...",
  "model": "deepseek-chat",
  "generationTimeMs": 8500,
  "tokenUsage": { "promptTokens": 500, "completionTokens": 1000, "totalTokens": 1500 }
}
```

**Pipeline (server-side logs):**
- STEP1: Database values — project fields, research/knowledge counts, prompt section keys
- STEP2: Prompt assembly — system prompt chars, user message chars, word count presence
- STEP3: DeepSeek request — model, max_tokens: 32768, response_format: json_object
- STEP4: DeepSeek response — model, tokens in/out/total, content length, finish_reason
- STEP5: Blog output — title, blog char/word count, FAQ count, continuation status, generation time

**Errors**: 400 (missing projectId), 401 (Unauthorized), 404 (project not found), 500 (AI API failure or JSON parse failure)

---

## Prompt Sections (Phase 4)

### `GET /api/prompt-sections`
List all prompt sections for the authenticated user. Auto-seeds defaults from `default-prompts.ts` on first access if no sections exist. On `POST /api/generate-blog`, `seedDefaults()` force-upserts all 10 sections on every generation.

**Response 200:**
```json
{
  "sections": [
    { "id": 1, "sectionKey": "brand_voice", "content": "You are a professional...", "updatedAt": "..." },
    { "id": 2, "sectionKey": "seo_rules", "content": "Apply these SEO best practices...", "updatedAt": "..." },
    { "id": 3, "sectionKey": "cta", "content": "...", "updatedAt": "..." },
    { "id": 4, "sectionKey": "publish_checklist", "content": "...", "updatedAt": "..." }
  ]
}
```

### `POST /api/prompt-sections`
Upsert a prompt section by `sectionKey` per user. UNIQUE constraint on `(user_id, section_key)`.

**Request:**
```json
{ "sectionKey": "brand_voice", "content": "Updated brand voice content..." }
```

**Response 200:** `{ "section": { ... } }`

**Errors**: 400 (missing sectionKey/content), 401, 500

---

## AI Playground (Phase 4)

### `POST /api/playground`
Test raw prompt generation without saving a version or logging. Used by the Playground page for prompt experimentation. Calls DeepSeek API directly.

**Request:**
```json
{
  "systemPrompt": "You are a professional blog writer...",
  "userPrompt": "Write a 500-word blog post about AI..."
}
```

**Response 200:**
```json
{
  "content": "## AI: The Future of...\n\n..."
}
```

**Errors**: 400 (missing prompts), 401, 500 (AI API failure)
