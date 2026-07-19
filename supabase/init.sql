-- Migration: 0000_initial_schema
-- Generated: 2026-07-16

-- ============================================================================
-- 01 TABLES
-- ============================================================================
CREATE TABLE IF NOT EXISTS "profiles" (
  "id"                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  "full_name"          text NOT NULL,
  "avatar_url"         text,
  "role"               text NOT NULL DEFAULT 'editor',
  "api_credits_used"   integer NOT NULL DEFAULT 0,
  "api_credits_limit"  integer NOT NULL DEFAULT 10000,
  "storage_used_bytes"  bigint NOT NULL DEFAULT 0,
  "storage_limit_bytes" bigint NOT NULL DEFAULT 5368709120,
  "updated_at"         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "projects" (
  "id"            serial PRIMARY KEY,
  "user_id"       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "name"          text NOT NULL,
  "status"        text NOT NULL DEFAULT 'draft',
  "keyword"       text NOT NULL DEFAULT '',
  "audience"      text NOT NULL DEFAULT '',
  "country"       text NOT NULL DEFAULT 'US',
  "word_count"    integer NOT NULL DEFAULT 0,
  "content"       text DEFAULT '',
  "seo_score"     integer,
  "published_url" text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "knowledge_items" (
  "id"         serial PRIMARY KEY,
  "user_id"    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "title"      text NOT NULL,
  "content"    text NOT NULL DEFAULT '',
  "tags"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pinned"     boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "prompts" (
  "id"         serial PRIMARY KEY,
  "user_id"    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "name"       text NOT NULL,
  "purpose"    text NOT NULL DEFAULT '',
  "tags"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "template"   text NOT NULL,
  "variables"  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "research_sources" (
  "id"         serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "category"   text NOT NULL,
  "title"      text NOT NULL,
  "url"        text NOT NULL DEFAULT '',
  "snippet"    text NOT NULL DEFAULT '',
  "position"   integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "seo_checks" (
  "id"          serial PRIMARY KEY,
  "project_id"  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "label"       text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "status"      text NOT NULL DEFAULT 'pending',
  "score"       integer NOT NULL DEFAULT 0,
  "fix"         text NOT NULL DEFAULT '',
  "category"    text NOT NULL DEFAULT 'general',
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "images" (
  "id"         serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "type"       text NOT NULL,
  "width"      integer NOT NULL,
  "height"     integer NOT NULL,
  "prompt"     text NOT NULL DEFAULT '',
  "url"        text,
  "status"     text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "social_posts" (
  "id"              serial PRIMARY KEY,
  "project_id"      integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "platform"        text NOT NULL,
  "content"         text NOT NULL DEFAULT '',
  "character_count" integer NOT NULL DEFAULT 0,
  "hashtags"        jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status"          text NOT NULL DEFAULT 'draft',
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "activity_log" (
  "id"          serial PRIMARY KEY,
  "user_id"     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "project_id"  integer REFERENCES projects(id) ON DELETE SET NULL,
  "action"      text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "type"        text NOT NULL DEFAULT 'general',
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 02 INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_projects_user_id"            ON "projects" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_projects_status"              ON "projects" ("status");
CREATE INDEX IF NOT EXISTS "idx_knowledge_items_user_id"      ON "knowledge_items" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_prompts_user_id"              ON "prompts" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_research_sources_project_id"  ON "research_sources" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_seo_checks_project_id"        ON "seo_checks" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_images_project_id"            ON "images" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_social_posts_project_id"      ON "social_posts" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_activity_log_user_id"         ON "activity_log" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_activity_log_project_id"      ON "activity_log" ("project_id");

-- ============================================================================
-- 03 ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE "profiles"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_items"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prompts"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "research_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seo_checks"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "images"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_posts"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_log"     ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS "Users can view own profile"   ON "profiles";
DROP POLICY IF EXISTS "Users can insert own profile" ON "profiles";
DROP POLICY IF EXISTS "Users can update own profile" ON "profiles";
CREATE POLICY "Users can view own profile"   ON "profiles" FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "Users can insert own profile" ON "profiles" FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "Users can update own profile" ON "profiles" FOR UPDATE TO authenticated USING (id = auth.uid());

-- projects
DROP POLICY IF EXISTS "Users can view own projects"   ON "projects";
DROP POLICY IF EXISTS "Users can create own projects" ON "projects";
DROP POLICY IF EXISTS "Users can update own projects" ON "projects";
DROP POLICY IF EXISTS "Users can delete own projects" ON "projects";
CREATE POLICY "Users can view own projects"   ON "projects" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can create own projects" ON "projects" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own projects" ON "projects" FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can delete own projects" ON "projects" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- knowledge_items
DROP POLICY IF EXISTS "Users can view own knowledge"   ON "knowledge_items";
DROP POLICY IF EXISTS "Users can insert own knowledge" ON "knowledge_items";
DROP POLICY IF EXISTS "Users can update own knowledge" ON "knowledge_items";
DROP POLICY IF EXISTS "Users can delete own knowledge" ON "knowledge_items";
CREATE POLICY "Users can view own knowledge"   ON "knowledge_items" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own knowledge" ON "knowledge_items" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own knowledge" ON "knowledge_items" FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can delete own knowledge" ON "knowledge_items" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- prompts
DROP POLICY IF EXISTS "Users can view own prompts"   ON "prompts";
DROP POLICY IF EXISTS "Users can insert own prompts" ON "prompts";
DROP POLICY IF EXISTS "Users can update own prompts" ON "prompts";
DROP POLICY IF EXISTS "Users can delete own prompts" ON "prompts";
CREATE POLICY "Users can view own prompts"   ON "prompts" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own prompts" ON "prompts" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own prompts" ON "prompts" FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can delete own prompts" ON "prompts" FOR DELETE TO authenticated USING (user_id = auth.uid());

-- research_sources (through project ownership)
DROP POLICY IF EXISTS "Users can view sources of own projects"    ON "research_sources";
DROP POLICY IF EXISTS "Users can insert sources to own projects"  ON "research_sources";
DROP POLICY IF EXISTS "Users can delete sources from own projects" ON "research_sources";
CREATE POLICY "Users can view sources of own projects"  ON "research_sources" FOR SELECT TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert sources to own projects" ON "research_sources" FOR INSERT TO authenticated WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete sources from own projects" ON "research_sources" FOR DELETE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- seo_checks (through project ownership)
DROP POLICY IF EXISTS "Users can view SEO of own projects"    ON "seo_checks";
DROP POLICY IF EXISTS "Users can insert SEO to own projects"  ON "seo_checks";
DROP POLICY IF EXISTS "Users can update SEO of own projects"  ON "seo_checks";
DROP POLICY IF EXISTS "Users can delete SEO from own projects" ON "seo_checks";
CREATE POLICY "Users can view SEO of own projects"    ON "seo_checks" FOR SELECT TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert SEO to own projects"  ON "seo_checks" FOR INSERT TO authenticated WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can update SEO of own projects"  ON "seo_checks" FOR UPDATE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete SEO from own projects" ON "seo_checks" FOR DELETE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- images (through project ownership)
DROP POLICY IF EXISTS "Users can view images of own projects"    ON "images";
DROP POLICY IF EXISTS "Users can insert images to own projects"  ON "images";
DROP POLICY IF EXISTS "Users can update images of own projects"  ON "images";
DROP POLICY IF EXISTS "Users can delete images from own projects" ON "images";
CREATE POLICY "Users can view images of own projects"    ON "images" FOR SELECT TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert images to own projects"  ON "images" FOR INSERT TO authenticated WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can update images of own projects"  ON "images" FOR UPDATE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete images from own projects" ON "images" FOR DELETE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- social_posts (through project ownership)
DROP POLICY IF EXISTS "Users can view social of own projects"     ON "social_posts";
DROP POLICY IF EXISTS "Users can insert social to own projects"   ON "social_posts";
DROP POLICY IF EXISTS "Users can update social of own projects"   ON "social_posts";
DROP POLICY IF EXISTS "Users can delete social from own projects" ON "social_posts";
CREATE POLICY "Users can view social of own projects"     ON "social_posts" FOR SELECT TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert social to own projects"   ON "social_posts" FOR INSERT TO authenticated WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can update social of own projects"   ON "social_posts" FOR UPDATE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete social from own projects" ON "social_posts" FOR DELETE TO authenticated USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- activity_log
DROP POLICY IF EXISTS "Users can view own activity"   ON "activity_log";
DROP POLICY IF EXISTS "Users can insert own activity" ON "activity_log";
CREATE POLICY "Users can view own activity"   ON "activity_log" FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own activity" ON "activity_log" FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- 04 TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1)), 'editor');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.update_timestamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated_at        ON "profiles";
DROP TRIGGER IF EXISTS trg_projects_updated_at        ON "projects";
DROP TRIGGER IF EXISTS trg_knowledge_items_updated_at ON "knowledge_items";
DROP TRIGGER IF EXISTS trg_prompts_updated_at         ON "prompts";
CREATE TRIGGER trg_profiles_updated_at        BEFORE UPDATE ON "profiles"        FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_projects_updated_at        BEFORE UPDATE ON "projects"        FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_knowledge_items_updated_at BEFORE UPDATE ON "knowledge_items" FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_prompts_updated_at         BEFORE UPDATE ON "prompts"         FOR EACH ROW EXECUTE FUNCTION update_timestamp();
