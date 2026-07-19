-- ============================================================================
-- Phase 4 Migration: prompt_sections, blog_versions, ai_logs
-- ============================================================================

-- ============================================================================
-- 01 TABLES
-- ============================================================================
CREATE TABLE IF NOT EXISTS "prompt_sections" (
  "id"          serial PRIMARY KEY,
  "user_id"     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "section_key" text NOT NULL,
  "content"     text NOT NULL,
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "blog_versions" (
  "id"               serial PRIMARY KEY,
  "project_id"       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "user_id"          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "version_number"   integer NOT NULL DEFAULT 1,
  "title"            text,
  "slug"             text,
  "meta_description" text,
  "excerpt"          text,
  "blog"             text,
  "faq"              jsonb DEFAULT '[]'::jsonb,
  "internal_links"   jsonb DEFAULT '[]'::jsonb,
  "external_links"   jsonb DEFAULT '[]'::jsonb,
  "categories"       jsonb DEFAULT '[]'::jsonb,
  "tags"             jsonb DEFAULT '[]'::jsonb,
  "reading_time"     text,
  "word_count"       integer DEFAULT 2500,
  "summary"          text,
  "model"            text,
  "prompt_version"   text,
  "generation_time_ms" integer,
  "token_usage"      jsonb,
  "status"           text NOT NULL DEFAULT 'draft',
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ai_logs" (
  "id"                 serial PRIMARY KEY,
  "user_id"            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "project_id"         integer REFERENCES projects(id) ON DELETE CASCADE,
  "model"              text NOT NULL,
  "prompt_size"        integer,
  "completion_size"    integer,
  "tokens_in"          integer,
  "tokens_out"         integer,
  "tokens_total"       integer,
  "generation_time_ms" integer,
  "status"             text NOT NULL DEFAULT 'success',
  "error_message"      text,
  "endpoint"           text NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 02 INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_prompt_sections_user_id_key" ON "prompt_sections" ("user_id", "section_key");
CREATE INDEX IF NOT EXISTS "idx_blog_versions_project_id"      ON "blog_versions" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_blog_versions_user_id"         ON "blog_versions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_ai_logs_user_id"               ON "ai_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_ai_logs_project_id"            ON "ai_logs" ("project_id");

-- ============================================================================
-- 03 ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE "prompt_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blog_versions"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_logs"         ENABLE ROW LEVEL SECURITY;

-- prompt_sections
DROP POLICY IF EXISTS "Users can view own prompt sections"   ON "prompt_sections";
DROP POLICY IF EXISTS "Users can insert own prompt sections" ON "prompt_sections";
DROP POLICY IF EXISTS "Users can update own prompt sections" ON "prompt_sections";
DROP POLICY IF EXISTS "Users can delete own prompt sections" ON "prompt_sections";
CREATE POLICY "Users can view own prompt sections"   ON "prompt_sections" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own prompt sections" ON "prompt_sections" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own prompt sections" ON "prompt_sections" FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can delete own prompt sections" ON "prompt_sections" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- blog_versions (through project ownership)
DROP POLICY IF EXISTS "Users can view versions of own projects"    ON "blog_versions";
DROP POLICY IF EXISTS "Users can insert versions to own projects"  ON "blog_versions";
DROP POLICY IF EXISTS "Users can update versions of own projects"  ON "blog_versions";
DROP POLICY IF EXISTS "Users can delete versions from own projects" ON "blog_versions";
CREATE POLICY "Users can view versions of own projects"    ON "blog_versions" FOR SELECT TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert versions to own projects"  ON "blog_versions" FOR INSERT TO authenticated WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can update versions of own projects"  ON "blog_versions" FOR UPDATE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete versions from own projects" ON "blog_versions" FOR DELETE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- ai_logs
DROP POLICY IF EXISTS "Users can view own ai logs"   ON "ai_logs";
DROP POLICY IF EXISTS "Users can insert own ai logs" ON "ai_logs";
DROP POLICY IF EXISTS "Users can delete own ai logs" ON "ai_logs";
CREATE POLICY "Users can view own ai logs"   ON "ai_logs" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own ai logs" ON "ai_logs" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can delete own ai logs" ON "ai_logs" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ============================================================================
-- 04 TRIGGERS
-- ============================================================================
DROP TRIGGER IF EXISTS trg_prompt_sections_updated_at ON "prompt_sections";
CREATE TRIGGER trg_prompt_sections_updated_at BEFORE UPDATE ON "prompt_sections" FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ============================================================================
-- 05 SEED DATA — prompt_sections defaults
-- ============================================================================
INSERT INTO "prompt_sections" ("user_id", "section_key", "content")
SELECT
  u.id,
  s.section_key,
  s.content
FROM auth.users u
CROSS JOIN (
  VALUES
    ('brand_voice',
     'You are a professional content writer for a Hong Kong-based digital marketing agency. Write in a confident, authoritative, yet approachable tone. Prioritize clarity and actionable insights. Avoid overly casual language, slang, or buzzwords. Target a business-savvy audience that values expertise and local market understanding.'),
    ('seo_rules',
     'Optimize every blog post for search engines. Include the primary keyword in the title (H1), first 100 words, at least one H2, and the meta description. Use secondary keywords naturally in H2 and H3 headings. Keep paragraphs under 4 sentences. Include 2-5 internal links to related content. Include 2-5 authoritative external links. Write a compelling meta description between 120-155 characters. Use descriptive alt text for all images. Maintain keyword density between 0.5-2%.'),
    ('formatting_rules',
     'Write all content in Markdown. Use H1 for the title only. Use H2 for major sections and H3 for subsections. Use bullet points for lists (not numbered unless sequential). Use bold for emphasis sparingly. Include a table of contents after the introduction with anchor links. Use blockquotes for key takeaways or notable quotes. Keep code blocks to a minimum unless the topic is technical. Wrap images with descriptive alt text and a caption.'),
    ('hong_kong_context',
     'Tailor content for the Hong Kong audience. Reference local market conditions, regulatory environment, and business culture where relevant. Use Hong Kong-specific examples and case studies when possible. Mention relevant Hong Kong districts, landmarks, or institutions to build local relevance. Be mindful of bilingual (English/Traditional Chinese) audience expectations. Acknowledge Hong Kong''s role as a gateway between Mainland China and global markets. Avoid politically sensitive topics.'),
    ('blog_structure',
     'Structure every blog post as follows: 1) Compelling H1 title with primary keyword. 2) Introduction (2-3 paragraphs) that hooks the reader and previews the content. 3) Table of Contents with anchor links. 4) Body sections with H2/H3 headings, each covering a distinct sub-topic. 5) Key Takeaways section with 3-5 bullet points. 6) FAQ section with 3-5 common questions and concise answers. 7) Call-to-Action that encourages reader engagement. Target 1500-2500 words unless otherwise specified.'),
    ('social_rules',
     'When creating social media posts from blog content: For LinkedIn — professional tone, 3-5 hashtags, include a question to encourage comments, 1300-2000 characters. For Facebook — conversational tone, 2-3 hashtags, include an engaging question, 150-300 characters. For Twitter/X — concise, 1-2 hashtags, include link to blog, under 280 characters. Always mention the key benefit or insight. Do not simply repeat the blog title.'),
    ('image_rules',
     'Generate image prompts suitable for AI image generation tools. Use descriptive, vivid language. Specify style preferences: clean, modern, professional. For blog featured images: 1200x630 pixels, horizontal orientation. For in-content images: 800x600 pixels. Avoid text in images. Prefer illustrations over photography for abstract concepts. Include color palette suggestions: corporate blue, teal, white, with accent colors for contrast.'),
    ('translation_rules',
     'When translating content to Traditional Chinese (Hong Kong): Use zh-HK locale conventions. Prefer Traditional Chinese characters (繁體中文). Use Hong Kong-specific terminology rather than Mainland China or Taiwan variants. Maintain the original tone and formatting structure. Translate technical terms accurately — when no direct equivalent exists, use the English term followed by Chinese explanation in parentheses. Preserve all Markdown formatting, links, and HTML structure. Adapt idioms and cultural references for Hong Kong readers.')
) AS s(section_key, content)
ON CONFLICT DO NOTHING;
