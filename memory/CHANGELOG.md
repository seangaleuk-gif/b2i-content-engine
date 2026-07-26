# Changelog

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
