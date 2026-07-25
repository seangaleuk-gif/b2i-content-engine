# Changelog

## 2026-07-25 — Translation QA Fixes, Source Localisation, Numeric Equivalence, Paragraph Splitting

### Translation QA Script Fixes
- **Brand-preservation false positives**: `checkBrands()` now detects which brands actually appear in English source text, only requires those in output. Case-insensitive.
- **Malformed-heading false positive**: `editorialHeadings()` strips `wp:html` blocks, scripts, JSON-LD before counting. CTA `<h2>` inside `wp:html` no longer counted as mismatch.
- **Chinese length reporting**: QA script displays `ZH Chinese characters: N` for `-zh` articles using the saved `word_count` field (CJK chars).
- **Number comparison**: Replaced raw total-count comparison with component-level exact normalized occurrence matching. Reports every lost/extra value by name.
- **Secrets removal**: Hardcoded Supabase keys removed from scripts. Now loaded from `.env.local` via `dotenv`. Fails clearly when required variables missing.
- **API model name fix**: Default model changed from `deepseek-chat` to `deepseek-v4-flash` in `deepseek.ts` and `playground/route.ts`.

### Source Localisation
- **`localiseSources()`** — For non-authoritative URLs, research items are scored by Chinese domain bonus (+3), title/anchor text similarity (×5), number match (+2), snippet quality (+1), same-domain (+1). Replacement threshold: score ≥ 4 AND content similarity ≥ 1.
- **Authoritative domains preserved**: `gov.hk`, `censtatd.gov.hk`, `facebook.com`, `instagram.com`, `meta.com`, `google.com`, WHO, UN, OECD, Statista, academic publishers.
- **`applySourceDecisions()`** — Safe regex-based replacement in rendered HTML, preserving all anchor attributes.
- **`localiseInternalLinks()`** — Checks for existing `-zh` slug versions in DB; localises only when real Chinese version exists.
- **`SourceDecision` type** — Tracks `originalUrl`, `finalUrl`, `decision`, `reason`, `matchScore`.

### Unit-Aware Numeric Equivalence
- **`extractScaledNumbers()`** — Replaces `extractVisibleNumbers()` + `normalizeNumber()`. Converts `1.2 million` ↔ `120萬`, `2.5 billion` ↔ `25億`, `500 thousand` ↔ `50萬`, `HK$1.2 million` ↔ `120萬港元`.
- Supports: `thousand`/`千`, `million`/`萬`, `billion`/`億`, `HK$`/`港元`, `US$`, full-width percent.
- Currency mismatch (`US$1.2M` ≠ `120萬港元`) correctly rejected.
- **`checkNumbersPreserved()`** uses count-based occurrence matching (per value, not total).

### Word Count Hard Failure
- **`evaluatePolicy()`**: Word count changed from SOFT warning to HARD failure. Articles outside 2,125-2,875 range now blocked.
- **`scoreArticle()`**: Word count uses `scoreInRange(value, min, max)` with tolerance range, not `scoreMin(≥target)`.
- Flesch readability skipped for Chinese content (slug ends with `-zh`).
- Keyphrase scoring uses density-based formula (`KEYPHRASE_DENSITY_MIN`/`MAX`).

### Final-Trim Aggressiveness
- **`final-trim`**: Increased max passes from 3 to 8. Loops until under `wordMax`. Target per pass: `Math.max(30, ceil(stillExcess / sectionCount))`. Breaks when `passRemoved === 0`.

### Paragraph Splitting Fix
- **`splitLongParagraphs()`**: Improved sentence boundary detection with Chinese punctuation (。！？), abbreviation handling (Mr., Dr., etc.), character-by-character scanning.
- **`countLongParagraphs()`**: Shared function used by pipeline, SEO audit, final validation, and post-save readback.
- **Pipeline order**: `paragraphs-final` moved to last content-changing position (after `faq-recovery`, before `final-validation`) so no later `syncBlogFromDocument()` can rejoin split paragraphs.
- **Post-save readback**: Route calls `countLongParagraphs()` on final HTML and rejects if any editorial paragraph exceeds 3 sentences.

### Bug Fixes
- **FAQ recovery corrupted links**: Changed insertion point from conclusion-text match to before last `wp:html` block.
- **Quality scorer tests**: Updated 4 tests expecting soft word-count → hard failure.
- **Pipeline order tests**: Updated 3 test stage lists to include `paragraphs-final`.

### Known Pipeline Bugs (still open)
1. **CTA loss**: `cta-preserve` re-injects CTA into `state.blog` but NOT `state.articleDoc.cta`. `syncBlogFromDocument()` rebuilds from document, losing the CTA.
2. **FAQ parity after paragraph split**: `faq-recovery` runs before `paragraphs-final`. Split FAQ paragraphs change visible structure but schema is already rebuilt.
3. **Word count validation inconsistency**: Articles >2,875 words still return 201. Suspected: `guardStageOutput` restores pre-validation snapshot after validation passes.

### Tests: 586 passing (7 files)

---

## 2026-07-22 — Keyphrase Budget System, Dynamic SEO Ranges, Normalizer Fixes
[... previous content preserved ...]

## 2026-07-21 — Section Lifecycle, SEO Audit Rewrite, Null Scores
[... previous content preserved ...]

## 2026-07-20 — Pipeline Reliability Refactor (Phases 1–7)
[... previous content preserved ...]

## 2026-07-18 — Phase 5: SEO, WordPress & Media
[... previous content preserved ...]

## 2026-07-17 — Phase 4: Blog Generation
[... previous content preserved ...]

## 2026-07-16 (earlier)
[... previous content preserved ...]
