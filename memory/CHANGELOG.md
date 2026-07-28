# Changelog

## 2026-07-27 — Stage 7 Completion: Canonical Standards, Chinese Pipeline Hardening, Verification

### Canonical Content Standards Module
- **`src/lib/content-standards.ts`**: Single source of truth for all structural and quality thresholds. Functions: `englishWordTolerance()`, `dynamicH2Range()`, `dynamicFaqRange()`, `englishTitleRange()`, `chineseTitleRange()`, `englishMetaRange()`, `chineseMetaRange()`, `englishKeyphraseDensity()`, `chineseKeyphraseDensity()`, `paragraphSentenceLimit()`, `internalLinkRange()`, `externalLinkRange()`, `chineseCharRange()`, `translationFaqCount()`, `computeKeyphraseDensity()`, `computeKeyphraseTargets()`, `getKeyphraseContentWordCount()`.
- **6 word-count bands**: 500–999, 1,000–1,499, 1,500–1,999, 2,000–2,999, 3,000–3,999, 4,000–5,000 with dynamic H2 and FAQ ranges per band.
- **Integrated into English pipeline**: prompt-builder, blog-generation-service, final-article-policy, final-seo-normalizer, component-regenerator, section-expander, quality-scorer, seo-auditor runAudit.
- **Integrated into Chinese pipeline**: runChineseAudit uses canonical title/meta ranges, paragraph limit, link range, keyphrase-density thresholds via `chineseTitleRange()`, `chineseMetaRange()`, `chineseKeyphraseDensity()`, `paragraphSentenceLimit()`, `internalLinkRange()`.

### Translation Pipeline Refactor (Module Split)
- **Five files**: `translation-types.ts` (types, RetryBudget), `translation-ai.ts` (AI calls, prompts), `translation-validator.ts` (number protection, leakage, completeness), `translation-assembler.ts` (FAQ schema, localisation), `translation-service.ts` (orchestration only).
- **AiService** remains single AI gateway; `createDeepSeekClient()` stays private.

### Deterministic Number Protection
- `protectNumbersInHtml()` replaces numbers/percentages/currencies/dates with `__NUM_N__` placeholders before translation.
- `tryRestoreNumbersInHtml()` verifies every placeholder survives, restores exact original values.
- Hard-fail on missing/duplicated placeholders.
- One-shot targeted retry (temperature 0.1) for sections, introduction, and conclusion when numbers are lost.

### Introduction English Retry
- `INTRO_RETRY_STRICT` prompt with stricter Chinese-only instruction.
- One-shot retry after main translation if `hasExcessiveEnglish()` detects English prose.
- Hard-fail if retry still has English.

### FAQ Boundary Validation
- Dynamic `max_tokens` calculation from input size: `min(8192, max(4096, inputTokens * 2))`.
- `finish_reason=length` is immediate throw — never parse truncated output.
- Reject answers containing: signup URLs, CTA button/heading text, conclusion text, FAQPage schema, `<h2>` markup, `<strong>` markup (duplicated visible FAQ).
- Reject answers >3× source length.
- Validate exact source count and one-to-one order before assembly.

### Metadata Range Compliance
- No filler padding (`完整指南`, CTA text) for short title/meta.
- One-shot retry with exact CJK range requirement when outside bounds.
- One deterministic cleanup pass: trim trailing punctuation/whitespace only.
- Hard-fail if still below minimum after retry.

### CTA Preservation
- `cta-preserve` always re-injects canonical CTA when damaged (not just when `articleDoc.cta` is null).
- After CTA re-injection, rebuilds FAQ schema from current visible FAQ entries.
- FAQ schema also rebuilt after word-count trim (`wc-check` stage).
- CTA `max_tokens` increased from 2048 to 4096.

### Pipeline Nested Paragraph Fix
- `runTrackedHtmlStage` flattens nested `<p>` tags using `detectNestedParagraphs()` + iterative unwrap before stage validation.
- `flattenNestedParagraphs()` in `splitLongParagraphs` as secondary safeguard.
- Prevents `assertValidStageInput` from rejecting HTML with AI-generated nested paragraphs.

### Unified Sentence Detection
- `splitSentences()` in `seo-text-utils.ts`: character-by-character detector with abbreviation/URL/decimal handling.
- `countSentences()` uses `splitSentences` for consistent counting.
- `splitLongParagraphs()` and `countLongParagraphs()` both use `splitSentences` from `seo-text-utils` — unified across pipeline and validation.

### Chinese SEO Audit Hardening
- **Unified density**: Both `keyphrase_count` and `keyphrase_density` checks use same `zhDensity` calculation: `(exactCount * kpCjkLen / zhCharCount) * 100`.
- **FAQ parity**: Structure-only validation (counts match + no empty answers) — exact text comparison removed as too fragile.
- **Paired English version**: `summary` field stores `source-en-version:<id>`. SEO audit reads this to find exact paired English version. Legacy fallback: slug matching (strip `-zh`).
- **Paired English FAQ**: Falls back to `extractVisibleFaqFromArticle(enBlog)` when saved DB `faq` field is empty.
- **Chinese keyphrase**: Taken from saved version's `excerpt` field. If empty or lacks CJK, route returns clear error — never falls back to English project keyword.
- **Canonical thresholds**: All checks use `chineseTitleRange()`, `chineseMetaRange()`, `chineseKeyphraseDensity()`, `paragraphSentenceLimit()`, `internalLinkRange()` from `content-standards`.

### Retry Budget Fix
- `record()` only sets `exhausted=true` when `remaining <= 0` — not on `capped` flag.
- `capped` flag logged with `(capped)` suffix but does not trigger exhaustion.
- `chatWithRetry` in `deepseek.ts` populates `result.attemptsUsed` with actual retries consumed.
- Logging shows actual retries used, not allowance difference.

### Save / Readback / Version Filtering
- `blogVersionRepository.findById(id)` added for post-save readback.
- Both translate and generate-blog routes: `create` → `findById` → 201 only if readback succeeds.
- `GET /api/projects/[id]/versions?language=en|zh` filters by slug suffix.
- Outdated detection: compares `_auditedVersionId` from server against latest matching-language version's ID.
- UI uses server-provided `overallScore` (weighted category-based) instead of recalculating simple average.

### Dead Code Removed
- `generation-constants.ts`: `KEYPHRASE_MIN`, `KEYPHRASE_MAX`, `ARTICLE_DENSITY_MIN_PERCENT`, `ARTICLE_DENSITY_MAX_PERCENT`, `SECTION_OVERUSE_THRESHOLD`, `SECTION_OVERUSE_WORD_LIMIT`, `EXTERNAL_LINKS_MIN`, `EXTERNAL_LINKS_MAX`.
- `seo-auditor.ts`: `DENSITY_DISPLAY_MAX`, `KP_DENSITY_STUFFING`, `KeyphraseScore`, `scoreKeyphraseCount`.
- `text-utils.ts`: Local `splitSentences` replaced by canonical version from `seo-text-utils.ts`.

### Tests: 842 passing (10 files)

---

## 2026-07-26 — Chinese Translation Pipeline, SEO Audit, Retry Budget, Assembly Fixes

### Traditional Chinese Translation Pipeline
- **Metadata + keyphrase combined call**: Meta description and English focus keyphrase translated together in a single request (padded with introduction text to avoid DeepSeek `empty_response` on tiny prompts). Structured JSON attempt first; plain-text JSON fallback second; finally a one-shot plain-text keyphrase translation if both JSON attempts fail.
- **Keyphrase sanitization**: Non-CJK characters (English letters, spaces) stripped from AI output. Clean CJK-only keyphrase stored in `excerpt` field on the saved version.
- **12-call normal flow**: Metadata+keyphrase, title, introduction, 6× combined H2+body sections, conclusion, FAQ, CTA — 12 normal API calls per translation.
- **Combined H2 + section body**: Single AI call returns JSON `{heading, body}` replacing prior separate H2 heading call. Section-body validation remains unchanged. Heading fallback call if empty or mostly English.
- **Retry budget**: `RetryBudget` class scoped per `translateArticle()` call, not module-level. 12 shared retries across the entire translation. Every component gets its first API attempt regardless of budget exhaustion. Caps only retries (attempts 2 and 3).

### Chinese SEO Audit
- **`runChineseAudit()`**: Parallel to `runAudit()` with Chinese-specific rules: character count range 3,800–5,500 (hard fail below 3,200), title 25–35 chars, meta 80–120 chars, keyphrase in first 200 CJK chars, Flesch N/A (excluded from scoring).
- **FAQ schema**: Audits only the LAST `FAQPage` JSON-LD block. Rejects empty `acceptedAnswer.text`. Enforces exact visible/schema parity. First attempt retries on `finish_reason=length` with `max_tokens: 2048`.
- **CJK keyphrase guard**: If the stored keyword has no CJK characters, keyphrase checks show as not_applicable — no false failures for English keywords.
- **Chinese SEO tab**: New `/projects/[id]/chinese-seo` route with saved audit reload, version tracking, and outdated indicator.

### SEO Audit Version & Language Separation
- **Audit route**: English audits find latest non-`-zh` version; Chinese audits find latest `-zh` version. Previous behaviour used `findLatest()` regardless of language.
- **Language-prefixed categories**: Chinese checks stored with `zh-` prefix on `category` field (e.g. `zh-SEO Fundamentals`). Added `findByProjectAndLanguage()` and `deleteByProjectAndLanguage()` to seo repository.
- **GET route**: Accepts `?language=en|zh` query parameter.

### Hard Validation Gate (Translation Route)
- **Critical fix**: Route now blocks saving when `failedComponents` is non-empty: `throw AppError.badRequest(...)`. Previously only logged the failure.
- Failed components: introduction, title, each section, section-heading fallback, conclusion, FAQ, meta-description, faq-count, cta.
- Number mismatches (`numbersMatch: false`) correctly set `passed: false` in `translateWithRetry`.

### Assembly Defect Fixes
- **English blocks stripped**: `FAQPage` JSON-LD schemas stripped from section bodies before assembly using regex with optional whitespace (`"@type"\s*:\s*"FAQPage"`).
- **CTA CJK check**: Translated CTA must contain CJK characters — if not, marked as hard failure.
- **FAQ count**: Enforced 4–6 entries before building `faqSchema`. Count outside range blocks saving.
- **Same-array FAQ + schema**: Visible FAQ and `faqSchema` built from the same `zhFaq` array — wording matches exactly.

### Cost Optimisation
- `MAX_RETRIES` reduced from 1 to 0 — outer retry loop removed; inner `chatWithRetry` (3 tries) sufficient.
- `translateText` max_tokens reduced from 4096 to 512; CTA from 4096 to 1024; FAQ from 8192 to 4096.
- Dead `METADATA_ZH_SYSTEM` constant and `{keyphrase}` placeholder removed from `TRANSLATION_SYSTEM`.

### SEO Auditor Updates
- Long paragraphs changed from hard fail (0) to minimum score 60/warning (soft per pipeline policy).
- External links: 0 acceptable (pass 100, not fail 0).
- Internal links: 0–4 range (not 3–5).
- Keyphrase density: weighted formula matching pipeline, stuffing threshold at 3%.
- Keyphrase in first 100 words: warning (60) not fail (0).
- Keyphrase in H2: warning (60) not fail (0).

### Tests: 620 passing (7 files)

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
