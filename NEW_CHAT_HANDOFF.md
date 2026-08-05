# B2I Content Engine — New Chat Handoff

**Date:** 4 August 2026

**This is the authoritative, self-contained entry point for a new coding chat.** Read the actual code, tests, logs and previews before proposing fixes. Where an older `.md` file conflicts with this handoff, this file wins.

Sections:

1. [Executive status](#1-executive-status)
2. [Proven working architecture](#2-proven-working-architecture)
3. [Historical failures and fixes](#3-historical-failures-and-fixes)
4. [Successful live runs](#4-successful-live-runs)
5. [Cantonese language resource (corpus)](#5-cantonese-language-resource-corpus)
6. [Bounded editorial review call](#6-bounded-editorial-review-call)
7. [Brand Voice and style integration](#7-brand-voice-and-style-integration)
8. [Current uncertainty](#8-current-uncertainty)
9. [Next required work](#9-next-required-work)
10. [Do-not-change list](#10-do-not-change-list)
11. [Verification status](#11-verification-status)
12. [Separate maintenance items](#12-separate-maintenance-items)
13. [Working rules for the new chat](#working-rules-for-the-new-chat)
14. [Key files and safe starting points](#key-files-and-safe-starting-points)
15. [Superseded documents](#superseded-documents)

---

## 1. Executive status

**Project:** B2I Content Engine
**Stack:** Next.js, TypeScript, Supabase, DeepSeek API
**Purpose:** generate SEO-focused English blogs and translate them into professional Hong Kong Traditional Chinese/Cantonese.

**The user manually runs all live generations and translations. The coder must not run a live API generation or translation unless explicitly requested.**

The active zh-HK translation path is now **exactly two substantive DeepSeek calls**: one full-document thinking-enabled translation, then one bounded editorial review of deterministically selected at-risk units. Version 28 completed with **105/105 coverage and saved successfully** under this architecture (real corpus active). A forensic audit of Version 28 found semantic/register/naturalness problems that the deterministic gate cannot catch, which is why the bounded editorial-review call was added.

The audit that directly drives the current state is `AUDIT_TRANSLATION_EDITORIAL_FINAL_TRIM_2026-07-31.md` (historical) and the Version 28 review in the conversation logs. The deterministic gate passes 0 major findings while missing real problems, so a bounded AI review is now part of the pipeline.

---

## 2. Proven working architecture

Active zh-HK pipeline (do not change):

```text
Call 1: complete full-document zh-HK translation (thinking enabled)
→ deterministic validation and review-candidate selection
→ Call 2: bounded editorial review of selected units only (thinking enabled)
→ validate patches
→ assemble
→ save
```

Exactly **two** substantive DeepSeek calls maximum. No third call, no retries that generate alternative translations, no full-document second translation, no fallback translation pipeline, no SQL changes, no changes to English generation.

Routing (`src/lib/services/deepseek-model-routing.ts`):

```text
Full-document translation (label document-context-shadow-chunk-0):
deepseek-v4-flash, thinking=enabled, reasoning_effort=medium, max_tokens=65536, timeout=180000ms, native JSON

Bounded editorial review (label document-context-editorial-review):
deepseek-v4-flash, thinking=enabled, reasoning_effort=medium, max_tokens=12000, timeout=120000ms, native JSON

Legacy editorial-polish labels (editorial-bilingual-a/b, editorial-monolingual-proofread):
retained dead code, non-thinking, NOT invoked.
```

Translation prompt: uses the complete English article as read-only context, every translatable source unit assigned, the reusable `FAITHFUL_TRANSLATION_CONTRACT`, the authoritative glossary, and the **manually approved B2I style examples**. Automatically retrieved HKCanCor/Words.hk corpus examples are **not** injected into the AI translation prompt (Version 28 was worse than Version 26 on 9/10 sampled comparisons).

Key orchestrators:

- `src/lib/services/document-context-translation-shadow.ts` — one full-document translation call + deterministic validation + assembly + post-processing; result now carries a `review` field.
- `src/lib/services/document-context-primary.ts` — primary orchestration + the bounded editorial review (2nd call) + save gate (`validatePrimaryDocumentContextResult`), which now rejects on `review.failed`.
- `src/lib/services/document-context-editorial-review.ts` — deterministic candidate selection, review prompt, patch parse/validate/apply, orchestration.
- `src/lib/services/document-context-shadow-preview.ts` — `assembleShadowDocument`, `applyFaithfulDocumentPostProcessing`, preview payloads.
- `src/lib/services/document-context-translation-shadow-prompt.ts` — prompt builders + `FAITHFUL_TRANSLATION_CONTRACT`.
- `src/lib/services/deepseek.ts` + `translation-ai.ts` — `AiService` gateway, `chatWithBudget`.

Failure behaviour (no partial save, no silent fallback):

```text
Translation fails/incomplete/truncated → rejected (coverage / structure / number / URL / FAQ parity)
Review call fails / is incomplete / returns an invalid patch → rejected at stage "review"
Deterministic quality gate critical/major findings → rejected at stage "quality"
```

### Proven structural systems

- Canonical `ArticleDocument` / `TranslationSourceDocument` / `sourceUnitId` — one canonical mutable article representation.
- Full-document single translation chunk (`buildFullDocumentChunk`) — all substantive units (non-CTA) in one call; CTA/schema/switcher reinserted deterministically.
- `validateStructuredChunkResponse` + `validateUnitProtectedFields` (exported) — sourceUnitId, structure, number, URL, block-type and inline-node parity.
- Native JSON Output.
- Deterministic post-processing: CTA localization, terminology cleanup, source-reference localization, FAQ schema, severity quality report.
- The zh-HK quality gate (`analyzeZhHkLanguageQuality` / `applyZhHkLanguageQuality` in `src/lib/services/zh-hk-language-quality.ts`) — the deterministic language pack.
- No-partial-save gate.

---

## 3. Historical failures and fixes

Chronological summary of the work in this conversation (all resolved):

### Full-document read-only context + assigned-unit isolation
- Each translation call now receives the complete English article as read-only context and clearly-marked assigned source units; only assigned units may be returned; silent internal verification is required before output. Covered by `document-context-translation-contract.test.ts` and `document-context-translation-shadow-prompt.test.ts`.

### Replace 7 calls with one full-document call
- The 7 coherent translation calls were replaced by exactly **one** full-document thinking-enabled call with a 65,536-token budget (provider safety cap raised). `TranslationChunkRole` gained `"document"`.

### Output limit 32,000 → 65,536
- Translation max tokens raised to 65,536; provider cap raised to permit it; editorial default stays 32,768; English generation and the DeepSeek client default unchanged.

### Deterministic zh-HK language pack
- `src/lib/services/zh-hk-language-quality.ts` — a comprehensive reusable language pack (safe character normalisation, HK terminology, mandatory marketing glossary, forbidden terms, English allowlist + auto entity extraction, literal patterns, diagnostics, save behaviour). Covers ≥300 entries; efficient Set/Map lookups.

### Structure-parity failures (Version 27, 99/105)
- Six citation blocks (`paragraph[text,link:URL,text]`) were rejected because the model flattened the inline link → `paragraph[text]`. Fix: structural-preservation prompt instruction + "examples are language-only" + parity diagnostics now log expected vs returned type/shape per failed unit; generic parity tests added (`structure-parity.test.ts`). This fixed Version 27 → Version 28 (105/105 saved).

### False-positive `literal-untranslated-verb`
- `post`, `TikTok`, `StarNgage` were wrongly blocked as untranslated verbs. Fix: shared `isAllowedEnglishToken` exemption (allowlist + auto-extracted entities) applied consistently to every English-leak detector; `work` still blocks. Covered in `zh-hk-language-quality.test.ts`.

### Seed-fallback corpus replaced with real licensed data
- Real Words.hk JSON endpoints (`https://words.hk/faiman/analysis/wordslist.json`, `englishindex.json`) and HKCanCor via pinned PyCantonese 5.0.0 (`pycantonese.hkcancor()`). Production import fails loudly on any failure/min-count miss; seed (`--seed`) is unit-test-only; atomic writes; manifest with checksums/versions/dates/licences/counts. See section 5.

### Corpus examples removed from the translation prompt
- Version 28 was worse than Version 26 on 9/10 sampled comparisons (被見到/被相信, 精製廣告, 濫用創作者, 人肉廣告板, 仲快賣到貨, 大名人, 由大粉絲數量, etc.). HKCanCor is a useful local resource but its spoken/neutral examples are not a professional-blog register signal, so they were removed from the AI translation prompt and retained only for deterministic validation + candidate selection.

### Bounded editorial review call added
- The Version 28 audit proved the single-call architecture reached its practical quality ceiling. A bounded editorial review (2nd call) was added to repair meaning, terminology, register and naturalness problems on deterministically selected units. See section 6.

---

## 4. Successful live runs

### Version 28 (current, saved)

```text
coverage=105/105
one full-document translation call (thinking enabled, 65536)
+ one bounded editorial review call
real Cantonese corpus active
saved successfully
```

Preview: `.tmp/shadow-previews/project-19-2026-08-04T08-47-44-604Z.json`

Earlier saved runs in the conversation timeline: V26 = `project-19-2026-08-04T05-07-27-435Z.json` (one-call, pre-real-corpus, better on the sampled register units). V27 = `project-19-2026-08-04T08-28-49-941Z.json` (99/105, structure-parity blocked, not saved).

**Facts:**

- Version 28 saved 105/105 but still contains semantic/register/naturalness problems (e.g. 被見到／被相信, 精製廣告, 濫用創作者, 人肉廣告板, 大名人, 創作者或者KOL).
- The deterministic gate passed 0 major findings while missing all of these — the deterministic gate guarantees coverage/consistency, not publish-readiness.
- The bounded editorial review is the mitigation, but its live effect is **not yet verified** (the user must run a live translation).

---

## 5. Cantonese language resource (corpus)

Stored under `src/data/cantonese/` (real licensed data):

- `wordslist.json` → `cantonese-lexicon.json` (61,234 unique entries; raw 62,274 keys).
- `englishindex.json` → `english-cantonese-index.json` (40,845 English terms; raw 40,839) + a B2I domain overlay (`DOMAIN_OVERLAY`) so corpus suggestions never override the mandatory glossary.
- HKCanCor via PyCantonese 5.0.0 → `cantonese-frequency.json` (7,221 words), `cantonese-ngrams.json` (33,503), `cantonese-examples.jsonl` (10,272 filtered utterances; 5,890 rejected), `cantonese-variants.json` (17).
- `manifest.json` — provenance `live`, checksums, versions (pycantonese 5.0.0), retrieval dates, licences, counts.
- `ATTRIBUTION.md` — sources, URLs, licences, attribution.

Import (offline, reproducible):

- `scripts/import-cantonese-language-data.ts` — downloads + validates + gates + atomic writes; production fails loudly on any failure or if any minimum is missed (lexicon ≥20k, English terms ≥1k, HKCanCor occurrences ≥100k, examples ≥5k); seed via `--seed` is unit-test-only and tagged `provenance: "seed-test"`.
- `scripts/export-hkcancor.py` — pinned PyCantonese 5.0.0 exporter (occurrences, unique words, frequencies, utterances, Jyutping, POS, file/participant ids).
- `scripts/cantonese-seed.json` — unit-test-only fallback.

Runtime index service: `src/lib/services/cantonese-corpus.ts` — cached Set/Map indexes (valid words, variants, English→Cantonese candidates, frequency, n-grams, POS, examples, metadata); deterministic example retrieval (`retrieveCorpusCantoneseExamples`) and post-translation validation (`validateCantoneseCorpus`).

**Corpus is deterministic-only.** It is never sent to DeepSeek. It is used for word validation, preferred variants, terminology lookup, frequency/n-gram diagnostics, and review-candidate selection.

---

## 6. Bounded editorial review call

`src/lib/services/document-context-editorial-review.ts`

Flow (inside `runPrimaryDocumentContextTranslation`):

```text
translation + validation → selectEditorialReviewCandidates (capped 25)
→ runEditorialReview (1 review call)
→ validateEditorialReviewPatches
→ applyEditorialReviewPatches
→ recompute deterministic quality
→ save gate (rejects on review.failed)
```

Candidate selection conditions (any of):

1. Existing objective findings (terminology inconsistency, glossary collision, redundant alternatives, untranslated English, calques, slang, Mainland wording, malformed Cantonese, unnatural passive).
2. Source-claim risk (numbers/percentages/prices, causal language, risk/effectiveness/outcome, attribution like "according to / X says", superlatives, negation).
3. Translation-risk patterns (distinct concepts → same Chinese term (collision, corroborating only), one term translated inconsistently, creator/influencer/KOL/tier terms, named-concept mismatch).

Units with only an unknown-corpus-token finding are never selected. Cap = **25**; prioritisation: factual/claim → attribution → meaning collision → terminology consistency → naturalness/register. Each selection is logged with reasons (`[document-context-shadow] review select | unit=… | reasons=[…]`).

Review prompt sends only selected units (EN + current ZH + protected numbers/URLs) + adjacent read-only context (previous/next) + authoritative glossary + professional HK Cantonese style contract. The reviewer must preserve exact meaning/claim strength, remove invented claims/additions/unsupported attribution, repair omissions/inversions, use natural professional Cantonese, and return JSON patches only. It is explicitly forbidden to summarise, add information, strengthen/weaken claims, change numbers/URLs/attribution, change block type/inline structure, or edit unselected units.

Patch format: `{ "sourceUnitId", "decision": "replace"|"retain", "replacement": {...}, "reasonCodes": [...] }`. Unknown IDs and duplicate patches are rejected; every selected unit must have exactly one decision.

Patch validation reuses the existing validators (`validateUnitProtectedFields`, structure/number/URL parity, block-type/inline parity, list/table dimensions, FAQ structure) plus unexpected-English detection and source-aware glossary enforcement. Only selected units may change; FAQ schema is rebuilt. A failed/incomplete/invalid review sets `review.status = "failed"` and the save gate rejects with stage `review` (no silent fallback).

---

## 7. Brand Voice and style integration

- One canonical default (`BRAND_VOICE_DEFAULT`) in `src/lib/services/brand-voice.ts`; English generation gets the English brand profile; Chinese derives language-specific profiles via `buildZhHkStyleContract` in `src/lib/services/zh-hk-style-contract.ts`.
- English rules do not leak into Cantonese; Cantonese rules do not affect English generation.
- Intended register: professional conversational Hong Kong Cantonese for a business blog — natural and warm, not slang-heavy, not Mainland formal Chinese, not a legal document, not a casual group chat.
- The authoritative glossary (`translation-glossary.ts`) and the manually approved B2I style examples remain in the translation prompt (higher priority than any corpus/candidate data).

---

## 8. Current uncertainty

- **The bounded editorial review call is new and its live effect on publish-readiness is unverified.** The user must run a live translation to confirm it improves the Version 28 problems.
- Semantic claim-inversion and fabricated-attribution cases (e.g. "reduces risk" must not become "real voices create real risks", Ykone attribution must not be fabricated) are handled by candidate selection + the review prompt contract, **not** by deterministic patch validation (which cannot judge meaning).
- The deterministic gate guarantees coverage/consistency but not publish-readiness; advisory findings are noise and are not reliable review candidates by themselves.
- Corpus examples are a spoken/neutral resource and are not a professional-blog register signal; whether any automated example retrieval helps blog register is unresolved (current decision: do not inject into the translation prompt).

---

## 9. Next required work

Suggested priority order:

1. **Verify the review call live** — run one production translation (user action) and check the review diagnostics (`result.review`), selected units, applied patches, and whether the Version 28 problems are repaired.
2. **Tune candidate selection** — review the logged `review select` reasons and adjust the deterministic selectors / cap / prioritisation based on real output.
3. **Consider strengthening the review prompt** — add explicit guidance for claim-strength and attribution preservation if the live review still inverts claims or fabricates attribution.
4. Keep the deterministic language-pack improvements (add the known calques/slang/passive detectors as advisory review-candidate signals if needed).

---

## 10. Do-not-change list

Unless a forensic audit disproves them, preserve:

- The verified English generation baseline (**B2I Content Engine — Nuclear Fix v2**); later v3.x builds must not be treated as verified English baselines.
- The active zh-HK architecture: one full-document translation call + one bounded editorial review = **exactly two** substantive DeepSeek calls.
- The complete real Cantonese corpus and its import pipeline; do not remove or rebuild it.
- The authoritative B2I glossary over corpus suggestions (nano/micro/mid/top, creator/KOL distinctions).
- Corpus examples are **not** injected into the AI translation prompt.
- Thinking enabled for the translation (65536) and review (12000) calls.
- `max_tokens=65536` for the translation call.
- The deterministic parity/quality validators and the no-partial-save gate.
- No third call, no retries that generate alternative translations, no fallback translation pipeline, no SQL/migrations unless explicitly requested and marked for manual execution.
- English generation untouched.

---

## 11. Verification status

Latest completed verification (this conversation):

```text
2041 passed
11 documented pre-existing failures
0 new regressions
next build successful
tsc --noEmit: only 2 pre-existing section-expander.test.ts errors
lint clean on changed files
```

The 11 failures are the documented pre-existing failures (final-seo-normalizer ×4, blog-generation-e2e ×1, component-regenerator ×2, section-expander ×2, translation-service ×2), all in files untouched by this work — English generation is unchanged.

---

## 12. Separate maintenance items

- `.tmp/shadow-previews` contains tens of thousands of files (22k+); Turbopack warns about build performance. This is a separate maintenance task, not the cause of any translation failure.
- `supabase/phase5-fixes-migration.sql` is open in the editor — SQL/migrations must be separated and marked for manual execution; do not silently create or run SQL.

---

## Working rules for the new chat

- Audit prompts are run in **Max mode / thinking on**; audits make **no code changes**.
- Implementation prompts are run in **Standard mode / thinking off**.
- **Do not mix audit and implementation.**
- The user manually runs all live generations and translations; do not run a live translation unless explicitly requested.
- SQL or migrations must be clearly separated and marked for manual execution. Do not silently create or run SQL.
- Preserve the verified English pipeline and the exact requested architecture; do not reinterpret or expand it.
- Do not add a third AI call, fallback pipeline, editor, feature flag, or translation path without explicit instruction.
- Keep prompts concise, complete and ready to copy.
- Update documentation after major verified stages.

---

## Key files and safe starting points

- `src/lib/services/document-context-translation-shadow.ts` — one-call translation runner + assembly + `review` result field.
- `src/lib/services/document-context-primary.ts` — primary orchestration + bounded editorial review (2nd call) + save gate.
- `src/lib/services/document-context-editorial-review.ts` — candidate selection, review prompt, patch parse/validate/apply.
- `src/lib/services/document-context-shadow-preview.ts` — assembly + deterministic post-processing + preview payloads.
- `src/lib/services/document-context-translation-shadow-prompt.ts` — prompt builders + `FAITHFUL_TRANSLATION_CONTRACT`.
- `src/lib/services/translation-chunk-planner.ts` — chunk plan, `validateStructuredChunkResponse`, `validateUnitProtectedFields`.
- `src/lib/services/zh-hk-language-quality.ts` — deterministic zh-HK language pack (quality gate) + `collectAlignedUnits`.
- `src/lib/services/cantonese-corpus.ts` — cached corpus indexes + retrieval + `validateCantoneseCorpus`.
- `src/lib/services/translation-glossary.ts` — authoritative glossary + forbidden terms.
- `src/lib/services/deepseek-model-routing.ts` — routing for translation + review + legacy editorial labels.
- `scripts/import-cantonese-language-data.ts`, `scripts/export-hkcancor.py` — corpus import/exporter.
- `src/data/cantonese/` — real processed corpus + `manifest.json` + `ATTRIBUTION.md`.

Key tests:

- `src/lib/services/document-context-editorial-review.test.ts`
- `src/lib/services/document-context-primary.test.ts`
- `src/lib/services/document-context-translation-contract.test.ts`
- `src/lib/services/document-context-translation-shadow.test.ts`
- `src/lib/services/document-context-roundtrip.test.ts`
- `src/lib/services/document-context-shadow-preview.test.ts`
- `src/lib/services/document-context-translation-shadow-prompt.test.ts`
- `src/lib/services/zh-hk-language-quality.test.ts`
- `src/lib/services/cantonese-corpus.test.ts`
- `src/lib/services/structure-parity.test.ts`
- `src/lib/services/deepseek-model-routing.test.ts`
- `scripts/import-cantonese-language-data.test.ts`

---

## Superseded documents

- `B2I-MASTER-HANDOFF-2026-07-31.md` — superseded by this handoff.
- `B2I-TRANSLATION-HANDOFF.md` — historical; superseded by this handoff.
- `00_READ_FIRST.md` … `09_CODER_WORKING_RULES.md` — historical archive; this handoff wins where they conflict.
- `NEW_CHAT_START_PROMPT.md` — kept as a short ready-to-copy start message; points to this handoff.
- `memory/*` — historical archives; superseded by this handoff.
