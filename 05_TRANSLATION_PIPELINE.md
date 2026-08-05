# Traditional Chinese Translation Pipeline

## Scope

**Traditional Chinese is the only translation target. Simplified Chinese is out of scope.** Do not add Simplified Chinese code paths, prompts, or tests without explicit user instruction.

## Current status

- The **old production translation pipeline is still active and not deleted.** It normally requires approximately 38–44 API calls (introduction, sections, headings, FAQs, conclusion, metadata, title, CTA, strict repairs, structured fallbacks, editorial repairs). The long-term goal is to **replace** it with the coherent-chunk path after controlled verification, not to permanently run both systems.
- Structural translation is live verified: full article saved; source-label and paragraph punctuation fixed; FAQ and schema parity preserved; CTA preserved; links and protected content preserved; natural HK code-switching allowed.
- Deterministic editorial normalization: `normalizeZhDocumentEditorialQuality()` (`src/lib/services/translation-service.ts`) + `CANTONESE_EDITORIAL_REPAIRS` / `FORMAL_REGISTER_MARKERS` / `LITERAL_PHRASE_REPAIRS` (`src/lib/services/translation-glossary.ts`).
- The approved English `ArticleDocument` remains the canonical factual/semantic source. See `NEW_CHAT_HANDOFF.md` for the authoritative status and next task.

## Coherent-chunk translation shadow (feature-flagged, diagnostic)

- Additive, **not** the production path. Modules: `translation-source-document.ts`, `translation-chunk-planner.ts`, `document-context-translation-shadow-prompt.ts`, `document-context-translation-shadow.ts`, `shadow-number-protection.ts`, `document-context-shadow-preview.ts`.
- Flag `ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW`. When true it builds an immutable source document with deterministic unit IDs, plans bounded coherent chunks, protects numbers with placeholders, validates each returned unit individually, reports translated/unresolved/protected coverage separately, and assembles a complete Chinese preview independently of the production Chinese document. It never changes production `zhDoc`, `failedComponents`, the save payload or normal blog versions.
- **Verified live:** 8 chunks (7 substantive + 1 protected), 7 attempts, 0 retries, 0 truncation, 7 valid, coverage 105/105, assembly successful.

## Shadow bilingual editorial (feature-flagged, diagnostic)

- Flag `ENABLE_SHADOW_BILINGUAL_EDITORIAL_POLISH`.
- The original single whole-document call failed (input ~13,214 tokens; output exceeded the 8,000-token cap; truncated). It was replaced with **exactly three bounded batches** (A: metadata+intro+early sections; B: middle sections; C: late sections+conclusion+FAQ).
- One attempt per batch, no retry loop; compact brief + current-batch units + bounded previous/next context; **patch responses contain changed units only**; deterministic patch application; progressive document state; accepted batches retained even if another batch fails. Final statuses: `polished`, `partially-polished`, `pre-editorial`.
- **Verified live:** all three batches completed naturally (no truncation/retries), but all patches were rejected and the preview remained `pre-editorial`. Exact rejection causes were not visible because per-batch failures were not logged; the next task adds per-batch failure diagnostics before changing parser tolerance. **The editorial path has not passed naturalness review.**

## Latest production failure (HTTP 400)

- 44 production calls then HTTP 400 with `zh-section-2-editorial` and `validation:section-2: formal written Chinese; use "同"`.
- Root cause: `PROTECTED_REGISTER_COMPOUNDS` preserves `與其`/`與否`/`參與`; the deterministic normalizer masks them, but `findFormalRegisterIssues()` still flags the `與` inside them — a normalizer/validator contradiction that AI repair cannot resolve. A single style-level register issue is treated as a hard failure. Not stale-state validation.
- Next task aligns `findFormalRegisterIssues()` with the protected compounds, keeps standalone `與 → 同`, and makes remaining formal-register issues advisory rather than hard failures.

## Target end-state

Approved English `ArticleDocument` → ~7 coherent translation calls → ~3 bounded bilingual editorial calls → deterministic number/URL/structure validation → targeted unit repair for genuine failures → save. Replace the old 38–44-call pipeline only after repeated structural passes, naturalness review, a controlled primary-path flag trial, and rollback verification. **Do not delete the old pipeline immediately.**

> **Note:** Do not describe translation as complete on a new run until the saved Chinese article passes validation, persistence and audit, and the English article is confirmed unchanged.

## DeepSeek thinking mode

Thinking is explicitly disabled for all routine translation calls, including:

- plain text translation
- editorial HTML/block translation
- heading translation
- per-FAQ translation
- CTA translation
- conclusion shadow and repair calls
- strict repair
- editorial repair
- final metadata generation

`translation-ai.ts` forwards the component/stage name to `AiService` so the correct thinking policy is applied.

## Required translation behavior

- Translate English into natural Traditional Chinese suitable for Hong Kong readers.
- Do not leave English fallback prose in the final Chinese article.
- Preserve exact numbers, percentages, currencies, dates, URLs, named sources, and link destinations.
- Preserve article structure, heading count/order, FAQ count/order, CTA, schema, and language switcher.
- Translate headings and body content deliberately; do not silently reuse English headings.
- Translate FAQ entries one-to-one.
- Regenerate Chinese FAQ schema from the final canonical translated FAQ entries.
- Validate Chinese title, meta description, focus keyphrase, body completeness, and parity before saving.
- Translation failure must never damage, replace, or roll back the valid English article.
- Save/readback must be verified before returning success.

## Implemented and test-verified safeguards

- Deterministic number protection and restoration (`__NUM_N__` placeholders)
- Strict rejection when number placeholders are missing or duplicated
- English-leakage detection with targeted retry
- Source-echo rejection (`isSourceEcho`): an unchanged English candidate is rejected even when numbers interrupt consecutive-English-word runs (e.g. "Hello World with 25% growth"), and the structured fallback runs; CJK-containing text and short token-only blocks are never misclassified
- FAQ boundary validation
- Metadata range compliance with deterministic cleanup
- CTA CJK validation
- Source-English version pairing (`source-en-version:<id>`)
- Chinese-specific SEO audit
- Structured translation DTO and block reconstruction
- Conclusion structured shadow evaluation
- Atomic/compensated persistence safeguards
- snake_case database row normalization to application camelCase

## Historical translation defects — now resolved (live verified)

- `enFaqCount=0`
- empty DeepSeek metadata responses aborting translation
- Chinese title/meta range failures
- English fallback content surviving
- FAQ/body/schema mismatch
- lost numbers or links
- incomplete CTA/schema
- incorrect repository field normalization
- source-label and paragraph trailing punctuation
- unsupported absolute-claim softening and known-phrase/heading normalization (narrow regexes)

These were verified against the current code, not old Markdown claims.

## Translation acceptance checklist

- Correct source English version selected
- English FAQ count is non-zero and matches the article
- Chinese title and metadata are generated
- All sections translated
- No substantial English prose remains
- Numbers/dates/currencies/URLs/sources preserved
- Heading count and order preserved
- FAQ visible body and schema match
- CTA and language switcher correct
- Chinese SEO audit runs against the saved Chinese version
- Chinese version saves and reads back successfully
- English version remains unchanged
