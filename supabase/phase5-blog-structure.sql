-- Phase 5: Blog Structure Update — Internal Links, Prompt Sections, Categories/Tags
-- Run in Supabase SQL Editor. Idempotent (uses ON CONFLICT / DO NOTHING where applicable).

-- ============================================================
-- 1. PROMPT SECTIONS: Update blog_structure, seo_rules, publish_checklist defaults
--    Note: These are force-upserted by seedDefaults() on every generation.
--          This SQL ensures existing rows match the current codebase.
-- ============================================================

-- blog_structure: 10-point layout with 5-7 internal links
INSERT INTO prompt_sections (user_id, section_key, content, updated_at)
SELECT
  auth.uid(),
  'blog_structure',
  'Structure every B2I Hub blog post with this exact layout:

1. **Language Switcher Block (first element)**: Custom HTML link switching between English and Traditional Chinese versions. Format: "Read in 中文 | Read in English" with href pointing to the alternate version slug.

2. **H1 Title**: Include focus keyphrase. 50-60 characters. Bilingual posts: English title for EN version, Chinese title for ZH version. They do not need to be direct translations — each should be SEO-optimized for its language.

3. **Introduction (2-3 paragraphs)**:
   - Hook: State the problem or insight immediately.
   - Context: Why this matters for HK creators/businesses right now.
   - Promise: What the reader will gain.

4. **H2 Sections (4-6 main points)**: Each covering one actionable strategy or insight. Structure each H2 as:
   - 2-3 paragraphs of explanation
   - Bulleted implementation steps
   - A concrete Hong Kong example or reference

5. **H2: Common Mistakes / What to Avoid**: 3-5 pitfalls with explanations and alternatives.

6. **CTA Block (before FAQ)**: Custom HTML block with the B2I Hub call-to-action. Exact HTML provided in the CTA section of this prompt. Include both English and Chinese versions.

7. **H2: FAQ**: 4-6 questions. Questions use **bold paragraph text**, NOT headings. Answers should be 2-4 sentences each, practical and direct.

8. **FAQ Schema JSON-LD Block**: Custom HTML block containing a <script type="application/ld+json"> with FAQPage schema. Include 4-6 questions from the FAQ section. Generate unique, fully-formed question/answer pairs.

9. **Conclusion (2 paragraphs)**: Summary of key takeaways + final CTA to create a B2I Hub profile.

10. **Internal Links**: Distribute 5-7 links to B2I Hub blog posts throughout the content — aim for 5, never exceed 7. Use descriptive anchor text. Suggested target URLs (pick 5-7 relevant ones per post):
    - /blog/creator-led-marketing-hong-kong
    - /blog/content-that-converts
    - /blog/how-to-land-your-first-brand-deal-in-hong-kong-pitch-scripts-7-day-plan
    - /blog/how-much-can-hong-kong-influencers-really-earn-rates-packages-the-money-side
    - /blog/become-brand-ready-hong-kong
    - /blog/where-hong-kong-micro-influencers-find-paid-brand-deals-platforms-outreach
    - /blog/how-to-close-better-deals-negotiation-media-kits-b2i-hub-verification

- **Categories**: Always assign: "Creator Economy" and "Resources".
- **Tags**: 5-8 relevant tags (lowercase, hyphenated). Examples: hk-creators, influencer-marketing, sme-marketing, ugc-hong-kong, creator-verification, outreach-tips, social-media-hk.',
  NOW()
ON CONFLICT (user_id, section_key)
DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at;

-- seo_rules: Updated internal linking guidelines
INSERT INTO prompt_sections (user_id, section_key, content, updated_at)
SELECT
  auth.uid(),
  'seo_rules',
  'Apply Yoast-compatible SEO best practices:

- **SEO title**: ~60 characters. Must include the focus keyphrase near the beginning. Format: "Primary Keyword — B2I Hub" or "Primary Keyword | B2I Hub". Never truncate mid-word.
- **Meta description**: 155-200 characters. Include focus keyphrase naturally. Write a compelling reason to click. End with a subtle CTA.
- **URL slug**: Clean, keyword-friendly, no dates, no stop words. Use hyphens only. For Chinese-language posts, append "-zh" suffix (e.g. /creator-marketing-hk-zh).
- **Focus keyphrase**: Unique per post. Must appear in: SEO title, meta description, first paragraph, at least one H2 heading, URL slug, and image alt text.
- **Heading hierarchy**: Single H1 (the title). H2 for all major sections. No H4-H6 ever.
- **Internal linking**: 5-7 internal links to specific B2I Hub blog posts — aim for 5, never exceed 7. Use descriptive, keyword-rich anchor text. Do not use generic anchors like "click here" or "read more."
- **External linking**: 2-3 links to high-authority sources (government statistics, industry reports, official documentation). Use target="_blank" and rel="noopener".
- **Keyword density**: Focus keyphrase should appear naturally every 200-300 words. Do not exceed 1% density. Include 3-5 semantically related terms.',
  NOW()
ON CONFLICT (user_id, section_key)
DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at;

-- publish_checklist: Updated internal links count
INSERT INTO prompt_sections (user_id, section_key, content, updated_at)
SELECT
  auth.uid(),
  'publish_checklist',
  'Before marking a post as ready to publish, verify every item on this checklist:

1. ☐ SEO title is ~60 characters and includes focus keyphrase
2. ☐ Meta description is 155-200 characters with focus keyphrase and CTA
3. ☐ URL slug is clean, keyword-friendly, no dates (append -zh for Chinese)
4. ☐ Focus keyphrase is unique to this post and not used on any other published post
5. ☐ Language switcher block is present as the first content element (linked EN↔ZH)
6. ☐ 5-7 internal links to specific B2I Hub blog URLs included with descriptive anchor text (aim for 5, never exceed 7)
7. ☐ 2-3 external links to authoritative sources with target="_blank" rel="noopener"
8. ☐ Categories set to "Creator Economy" and "Resources"
9. ☐ 5-8 relevant tags assigned
10. ☐ FAQ section has 4-6 questions in bold paragraph format (not headings)
11. ☐ FAQ Schema JSON-LD block present with matching questions
12. ☐ CTA block present before FAQ section (English or Chinese depending on language version)
13. ☐ All content is in WordPress block format — no bare Markdown in final output
14. ☐ Cantonese quotes use 「」 (corner brackets) for Chinese text
15. ☐ Target word count met — measured in body text only (headings, paragraphs, list items, table cells). Do NOT count: HTML markup, WordPress block comments, JSON-LD schema code, Custom HTML blocks, or the internal/external links section.',
  NOW()
ON CONFLICT (user_id, section_key)
DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at;

-- ============================================================
-- 2. INTERNAL LINKS: Upsert 7 default B2I Hub blog URLs
--    Note: These are seeded by seedDefaultLinks() per user on first generate.
--          This SQL ensures the table has the correct defaults.
-- ============================================================

-- Clear old defaults (will be re-seeded by app on next generate)
-- Keeps user-created custom links (auto_synced = false and not matching default URLs)
DELETE FROM internal_links
WHERE auto_synced = true
AND url_slug IN (
  '/blog/creator-led-marketing-hong-kong',
  '/blog/content-that-converts',
  '/blog/how-to-land-your-first-brand-deal-in-hong-kong-pitch-scripts-7-day-plan',
  '/blog/how-much-can-hong-kong-influencers-really-earn-rates-packages-the-money-side',
  '/blog/become-brand-ready-hong-kong',
  '/blog/where-hong-kong-micro-influencers-find-paid-brand-deals-platforms-outreach',
  '/blog/how-to-close-better-deals-negotiation-media-kits-b2i-hub-verification'
);

-- ============================================================
-- 3. SEO AUDIT: Ensure internal link pass range is 5-7
--    Note: Managed in code (seo-auditor.ts). This is informational.
-- ============================================================
-- The SEO auditor checks for 5-7 internal links as "pass" (seo-auditor.ts line 244).
-- Previous iterations accidentally reduced this to 3-5. Reverted to match spec.

-- ============================================================
-- 4. VERIFY: Check existing data consistency
-- ============================================================
SELECT section_key,
       LEFT(content, 80) AS preview,
       LENGTH(content) AS char_count,
       updated_at
FROM prompt_sections
WHERE section_key IN ('blog_structure', 'seo_rules', 'publish_checklist')
ORDER BY section_key;
