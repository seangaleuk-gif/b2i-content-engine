-- ====================================================================
-- Phase 5: Blog & SEO Systems Fix Migration
-- Date: 2026-07-18
-- Run in Supabase SQL Editor. Idempotent.
--
-- Note: prompt_sections are force-upserted by seedDefaults() in
-- default-prompts.ts on every POST /api/generate-blog call.
-- No manual prompt_sections INSERT needed — the app handles it.
-- ====================================================================

-- ============================================================
-- 1. BLOG VERSIONS — remove duplicate version_number rows
--    Left over from old double-save bug in generate-blog/route.ts
--    (first save before link injector + second save after).
--    Keeps the row with highest id for each (project_id, version_number).
-- ============================================================
DELETE FROM blog_versions
WHERE id NOT IN (
  SELECT MAX(id)
  FROM blog_versions
  GROUP BY project_id, version_number
);

-- ============================================================
-- 2. SEO CHECKS — clear old checks that used stale data
--    Old audit runs may have used 5-7 link range, overcounted
--    language switcher links, or counted duplicates instead of
--    unique hrefs. Re-run audit after this migration.
-- ============================================================
DELETE FROM seo_checks;

-- ============================================================
-- 3. INTERNAL LINKS — clear stale defaults by URL slug
--    App re-seeds via seedDefaultLinks() in default-links.ts
--    on next POST /api/generate-blog call.
-- ============================================================
DELETE FROM internal_links
WHERE url_slug IN (
  '/blog/creator-led-marketing-hong-kong',
  '/blog/content-that-converts',
  '/blog/how-to-land-your-first-brand-deal-in-hong-kong-pitch-scripts-7-day-plan',
  '/blog/how-much-can-hong-kong-influencers-really-earn-rates-packages-the-money-side',
  '/blog/become-brand-ready-hong-kong',
  '/blog/where-hong-kong-micro-influencers-find-paid-brand-deals-platforms-outreach',
  '/blog/how-to-close-better-deals-negotiation-media-kits-b2i-hub-verification'
);

-- ============================================================
-- 4. VERIFY — check data consistency after cleanup
-- ============================================================
SELECT 'blog_versions' AS table_name,
       COUNT(*) AS row_count,
       COUNT(DISTINCT (project_id, version_number)) AS unique_version_pairs,
       COUNT(*) - COUNT(DISTINCT (project_id, version_number)) AS duplicate_rows
FROM blog_versions
UNION ALL
SELECT 'seo_checks', COUNT(*), 0, 0 FROM seo_checks
UNION ALL
SELECT 'internal_links', COUNT(*), 0, 0 FROM internal_links;

-- ============================================================
-- 5. CODE ↔ DATABASE REFERENCE
-- ============================================================
-- | Code File                     | DB Table/Column               | Value              |
-- |-------------------------------|-------------------------------|--------------------|
-- | seo-auditor.ts:266            | seo_checks (via runAudit)     | 3-5 pass range     |
-- | seo-auditor.ts:262-281        | seo_checks (via runAudit)     | dedup by href Set  |
-- | seo-auditor.ts:234-250        | seo_checks (via runAudit)     | wp:html excluded   |
-- | prompt-builder.ts:149         | prompt_sections (app-seeded)  | 3-5 unique links   |
-- | prompt-builder.ts:192         | prompt_sections (app-seeded)  | 3-5 unique links   |
-- | link-injector.ts:7            | (in-memory, not in DB)        | MAX_TOTAL_LINKS=5  |
-- | seo/audit/route.ts:23         | blog_versions.meta_description| server priority    |
-- | blog-versions.ts:57-60        | blog_versions.version_number  | Math.max()         |
-- | generate-blog/route.ts:294-326| blog_versions                 | single save/gen    |
-- | generate-blog/route.ts:328-330| projects.content              | updated after save |
