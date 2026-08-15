-- ============================================================================
-- Phase 15: atomic English-generation version persistence
-- Date: 2026-08-14
--
-- Run once in the Supabase SQL editor before deploying the matching code.
-- This migration is idempotent and never deletes or rewrites saved versions.
--
-- Uniqueness is enforced for ENGLISH versions only. A Traditional Chinese
-- (-zh) version is allowed to share the version number of its English source,
-- so a global (project_id, version_number) unique index is wrong for the
-- bilingual model. If genuine duplicate ENGLISH version numbers already exist,
-- it fails closed and reports the affected projects so an operator can resolve
-- them deliberately.
-- ============================================================================

DO $$
DECLARE
  duplicate_projects text;
BEGIN
  SELECT string_agg(project_id::text, ', ' ORDER BY project_id)
  INTO duplicate_projects
  FROM (
    SELECT project_id
    FROM blog_versions
    WHERE slug IS NULL OR slug !~* '-zh$'
    GROUP BY project_id, version_number
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_projects IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce blog version uniqueness: duplicate English (project_id, version_number) rows exist for project(s): %',
      duplicate_projects;
  END IF;
END
$$;

-- Remove the old global uniqueness index if it was ever applied. It is wrong
-- for the bilingual model because it treats a Chinese version sharing its
-- English source's version number as a duplicate.
DROP INDEX IF EXISTS blog_versions_project_version_unique;

CREATE UNIQUE INDEX IF NOT EXISTS blog_versions_project_version_english_unique
  ON blog_versions (project_id, version_number)
  WHERE slug IS NULL OR slug !~* '-zh$';

CREATE OR REPLACE FUNCTION save_generated_english_blog_version(
  p_project_id integer,
  p_user_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  next_version integer;
  saved blog_versions%ROWTYPE;
BEGIN
  -- This row lock is the transaction boundary for both allocation and
  -- projects.content promotion. It also verifies project ownership.
  PERFORM 1
  FROM projects
  WHERE id = p_project_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project % is unavailable to user %', p_project_id, p_user_id
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(p_payload->>'slug', '') ~* '-zh$' THEN
    RAISE EXCEPTION 'English generation cannot save a Traditional Chinese slug: %', p_payload->>'slug'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO next_version
  FROM blog_versions
  WHERE project_id = p_project_id
    AND (slug IS NULL OR slug !~* '-zh$');

  INSERT INTO blog_versions (
    project_id,
    user_id,
    version_number,
    title,
    slug,
    meta_description,
    excerpt,
    blog,
    faq,
    internal_links,
    external_links,
    categories,
    tags,
    reading_time,
    word_count,
    summary,
    model,
    prompt_version,
    generation_time_ms,
    token_usage,
    status
  ) VALUES (
    p_project_id,
    p_user_id,
    next_version,
    p_payload->>'title',
    p_payload->>'slug',
    p_payload->>'metaDescription',
    p_payload->>'excerpt',
    p_payload->>'blog',
    COALESCE(p_payload->'faq', '[]'::jsonb),
    COALESCE(p_payload->'internalLinks', '[]'::jsonb),
    COALESCE(p_payload->'externalLinks', '[]'::jsonb),
    COALESCE(p_payload->'categories', '[]'::jsonb),
    COALESCE(p_payload->'tags', '[]'::jsonb),
    p_payload->>'readingTime',
    NULLIF(p_payload->>'wordCount', '')::integer,
    p_payload->>'summary',
    p_payload->>'model',
    p_payload->>'promptVersion',
    NULLIF(p_payload->>'generationTimeMs', '')::integer,
    p_payload->'tokenUsage',
    COALESCE(NULLIF(p_payload->>'status', ''), 'draft')
  )
  RETURNING * INTO saved;

  UPDATE projects
  SET content = COALESCE(saved.blog, ''), updated_at = now()
  WHERE id = p_project_id AND user_id = p_user_id;

  RETURN to_jsonb(saved);
END;
$$;

CREATE OR REPLACE FUNCTION sync_project_content_to_latest_english_blog_version(
  p_project_id integer,
  p_user_id uuid,
  p_fallback_content text DEFAULT ''
)
RETURNS TABLE(version_id integer, version_number integer, blog text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  latest_id integer;
  latest_number integer;
  latest_blog text;
BEGIN
  -- Serialize project-content promotion for this project and verify ownership.
  PERFORM 1
  FROM projects
  WHERE id = p_project_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project % is unavailable to user %', p_project_id, p_user_id
      USING ERRCODE = '42501';
  END IF;

  SELECT bv.id, bv.version_number, COALESCE(bv.blog, '')
  INTO latest_id, latest_number, latest_blog
  FROM blog_versions bv
  WHERE bv.project_id = p_project_id AND bv.user_id = p_user_id
    AND (bv.slug IS NULL OR bv.slug !~ '-zh$')
  ORDER BY bv.version_number DESC, bv.id DESC
  LIMIT 1;

  IF latest_id IS NULL THEN
    latest_blog := COALESCE(p_fallback_content, '');
  END IF;

  UPDATE projects
  SET content = latest_blog, updated_at = now()
  WHERE id = p_project_id AND user_id = p_user_id;

  RETURN QUERY SELECT latest_id, latest_number, latest_blog;
END;
$$;

REVOKE ALL ON FUNCTION sync_project_content_to_latest_english_blog_version(integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_project_content_to_latest_english_blog_version(integer, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION save_generated_english_blog_version(integer, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_generated_english_blog_version(integer, uuid, jsonb)
  TO service_role;
