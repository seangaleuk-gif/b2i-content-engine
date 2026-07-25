# Known Bugs

## Active

### 1. CTA loss after syncBlogFromDocument()
- **Description**: The `cta-preserve` pipeline stage re-injects the CTA block into `state.blog` (HTML string) when the CTA is missing. However, later stages (`factual-scan`, `final-trim`) call `syncBlogFromDocument()`, which rebuilds HTML from `state.articleDoc`. The re-injected CTA is NOT persisted in `state.articleDoc.cta`, so it gets lost on rebuild. Final validation then fails with `cta headings=0; signup URLs=0`.
- **Reproduction**: Run `/api/generate-blog` — approximately 60% of runs fail with CTA-related validation errors.
- **Suspected cause**: `cta-preserve` modifies `state.blog` but not `state.articleDoc.cta`. `syncBlogFromDocument()` only reads from `ArticleDocument`.
- **Fix**: Move `cta-preserve` to run AFTER all `syncBlogFromDocument()`-calling stages (`factual-scan`, `link-enforce`, `final-trim`, `faq-recovery`), just before `paragraphs-final`.
- **Status**: Open — targeted fix identified
- **Date discovered**: Jul 25, 2026

### 2. FAQ parity mismatch after paragraph splitting
- **Description**: `faq-recovery` extracts visible FAQ from the HTML and rebuilds FAQPage JSON-LD. But `paragraphs-final` (which splits long paragraphs) runs AFTER `faq-recovery`. If FAQ paragraphs are split, the visible FAQ structure changes, but the schema (already rebuilt) doesn't match the new split structure.
- **Reproduction**: Run `/api/generate-blog` — occasionally fails with `FAQ parity mismatch` in final validation.
- **Suspected cause**: Pipeline order: `faq-recovery` → `paragraphs-final` → `final-validation`. The FAQ schema is rebuilt before paragraph splitting.
- **Fix**: Move `faq-recovery` AFTER `paragraphs-final` so schema is rebuilt from the final (split) visible FAQ structure. Or rebuild FAQ schema as part of paragraphs-final.
- **Status**: Open — targeted fix identified
- **Date discovered**: Jul 25, 2026

### 3. Word count validation above 2,875 still returns 201
- **Description**: `evaluatePolicy()` includes `wcHard` which should reject articles with word count outside 2,125-2,875. However, articles with `wordCount > 3,000` still return `201`. The route computes `finalWordCount` from `finalBlogHtml`, but the pipeline's validation may run on a different snapshot.
- **Reproduction**: Run `/api/generate-blog` consistently — word counts above 2,875 return 201 instead of 500.
- **Suspected cause**: `guardStageOutput` in `runTrackedHtmlStage` may restore a pre-validation snapshot of `state.blog` after validation passes. The restored HTML has a different (higher) word count, which the route then saves.
- **Fix**: Consolidate to one shared `countReadableWords()` call used by pipeline policy, route, and post-save readback. Log word count and HTML fingerprint at every critical point.
- **Status**: Open — root cause identified
- **Date discovered**: Jul 25, 2026

### 4. Supabase Node.js 20 deprecation warning
- **Description**: `@supabase/supabase-js` warns about Node.js 20 deprecation at startup
- **Reproduction**: Run `npm run dev` or `npm run build`
- **Suspected cause**: `@supabase/supabase-js@2.110.6` requires Node.js >= 22
- **Status**: Open — non-blocking warning
- **Date discovered**: Jul 16, 2026

### 5. Research page 500 when `BRAVE_API_KEY` not set
- **Description**: Clicking "Generate Research" fails if `BRAVE_API_KEY` is not configured with a valid key
- **Reproduction**: Set placeholder key and click Generate
- **Suspected cause**: Placeholder value fails API authentication
- **Status**: Expected behavior — user must set a real Brave Search API key
- **Date discovered**: Jul 18, 2026

### 6. Translated article `wordCount` must use CJK character count
- **Description**: The route stores `wordCount` using `countReadableWords()` for translated Chinese articles. For `zh-HK` content, this should store CJK character count, not whitespace words.
- **Reproduction**: Translate an English article to Chinese.
- **Suspected cause**: Route uses `countReadableWords()` for all articles.
- **Fix**: Use `result.zhCharCount` for `-zh` slug. Update already applied in route (uses `result.zhCharCount` from `TranslationResult`).
- **Status**: Fixed Jul 25, 2026

---

## Resolved

| # | Description | Discovered | Resolved |
|---|-------------|------------|----------|
| 1 | Tables not created — API routes 500 when profiles table missing | Jul 16 | Jul 16 |
| 2 | Supabase pooler DNS — Drizzle `postgres.js` direct TCP connection failed on Windows | Jul 17 | Jul 17 |
| 3 | Route group 404 — `(dashboard)` directory caused 404 on Windows | Jul 16 | Jul 16 |
| 4 | camelCase/snake_case mismatch — Drizzle schema uses camelCase but DB has snake_case | Jul 16 | Jul 17 |
| 5 | DeepSeek response format — client expected `result.output` but API returns Chat Completions | Jul 17 | Jul 17 |
| 6 | Drizzle upsert syntax — `$onConflictDoUpdate` vs `onConflictDoUpdate` | Jul 17 | Jul 17 |
| 7 | Workflow stepper hardcoded — step statuses were static | Jul 17 | Jul 17 |
| 8 | word_count not passed to prompt | Jul 17 | Jul 17 |
| 9 | Copy button on research page | Jul 17 | Jul 17 |
| 10 | DeepSeek truncation on long posts | Jul 17 | Jul 18 |
| 11 | DeepSeek `deepseek-chat` model name outdated | Jul 25 | Jul 25 — changed to `deepseek-v4-flash` |
| 12 | FAQ recovery corrupted link destinations | Jul 25 | Jul 25 — changed insertion to last `wp:html` block |
| 13 | Paragraph splitting lost by later `syncBlogFromDocument()` | Jul 25 | Jul 25 — moved `paragraphs-final` to last content-changing position |
| 14 | Quality scorer used `scoreMin` instead of tolerance range | Jul 25 | Jul 25 — changed to `scoreInRange` |
| 15 | Quality scorer ran Flesch on Chinese content | Jul 25 | Jul 25 — skipped for `zh` slug |
| 16 | Keyphrase used fixed occurrence range instead of density formula | Jul 25 | Jul 25 — changed to density-based |
