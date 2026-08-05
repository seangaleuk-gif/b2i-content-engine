# B2I Translation Handoff — Traditional Chinese Document-Context Pipeline

This handoff gives a new AI coding session the full context needed to continue the Traditional Chinese translation work without re-running audits or rediscovering the architecture.

> Read this file first. Where it conflicts with older handoffs, this file wins for the document-context primary path.

---

## 1. Project and baseline

- **Project name:** B2I Content Engine.
- **Stack:** Next.js (App Router, TypeScript), Supabase, DeepSeek API (`deepseek-v4-flash`).
- **Last confirmed working English generation baseline:**
  - `B2I Content Engine — Nuclear Fix v2`
  - `B2I-Content-Engine-Nuclear-Fix-v2-Malformed-Prose-Repair.zip`
- The verified English generation pipeline is the protected baseline and **must not be modified** during translation work.
- Later builds must **not** automatically be treated as verified English baselines without live verification.
- **English blog generation remains unchanged.**

---

## 2. Current Traditional Chinese architecture

Enabling:

```env
ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true
```

uses the verified document-context path as the **sole** translation path.

**Current provider architecture (primary path):**

- **7 source-aligned document-context translation calls** (V4 Flash, thinking disabled, native JSON output).
- **No editorial calls.** `editorial-bilingual-a`, `editorial-bilingual-b` and `editorial-monolingual-proofread` are **not invoked** by the active workflow.
- Finding-token editorial bookkeeping is **inactive in production**.
- Deterministic validation, deterministic post-processing, deterministic assembly.
- No extra repair call.
- No silent fallback.
- No duplicate shadow run during a primary run.
- No SQL or migration.

**Active zh-HK flow:**

```text
English source
→ 7 source-aligned DeepSeek V4 Flash translation calls
→ deterministic validation
→ deterministic post-processing
→ assemble
→ save
```

**Historical:** The 7+3 editorial architecture was removed from the active zh-HK workflow. **Version 22** was the final successful 7+3 run (saved as DB ID **218**). The **current confirmed baseline is Version 23**, saved as DB ID **219**, completed with coverage **105/105**, **no editorial calls**, and saved successfully.

**If the primary path fails:**
- No Chinese version is saved.
- The English article remains unchanged.
- The old pipeline is not invoked automatically.

The primary path may save only when: coverage is complete, assembly succeeds, deterministic validation passes, protected content and source integrity hold, FAQ/schema parity holds, numbers/URLs/links/structure pass, no unresolved placeholders remain, and there are no critical or major final-quality findings.

---

## 3. Current environment configuration

```env
ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW=true
ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true
ENABLE_SHADOW_BILINGUAL_EDITORIAL_POLISH=false
ENABLE_EDITORIAL_POLISH=false

DEEPSEEK_TRANSLATION_MODEL=deepseek-v4-flash
DEEPSEEK_TRANSLATION_THINKING=false
```

The resolved translation budgets (see section 8):

```env
DEEPSEEK_TRANSLATION_MAX_TOKENS=8000
DEEPSEEK_TRANSLATION_TIMEOUT_MS=60000
```

There are no active editorial budgets because there are no editorial calls.

---

## 4. Implemented translation systems

Implemented features (all present in the repository):

- **Immutable English source units** with deterministic source-unit IDs.
- **Complete coverage validation** (substantive translated/total, e.g. 105/105).
- **Deterministic assembly** of a Chinese `ArticleDocument` independent of the production Chinese document.
- **Faithful source-aligned translation** — every source unit translated exactly once, meaning/claims/examples/certainty/paragraph purpose preserved.
- **Reusable faithful translation contract** (injected into every chunk) — faithful sentence-by-sentence translation; natural professional Hong Kong Cantonese; preserve all meaning; never add/remove/summarise/expand/reinterpret; translate idioms by intended meaning; keep source tone; consistent terminology throughout; avoid formal written Chinese, Mainland `營銷`-based terms and excessive slang.
- **Strengthened canonical glossary** (influencer marketing → 創作者市場推廣, creator/influencer → 創作者, follower → 粉絲, engagement → 互動, campaign → 推廣活動, agency → 市場推廣公司, brand awareness → 品牌知名度, nano-influencer → 超小型創作者, micro-influencer → 微型創作者, etc.).
- **Approved English-to-zh-HK examples** grouped into 7 general mistake categories (English idioms, literal sentence structures, professional vs slang-heavy wording, spoken Cantonese mixed with formal Chinese, one-size-fits-all expressions, agency and creator terminology, marketing and analytics language). Examples teach general style only — no article-specific replacement rules.
- **Deterministic post-processing** (no AI): CTA localization, terminology cleanup, FAQ-schema rebuild, source-reference localization, severity-based quality report.
- **Deterministic typography normalization** (removes CJK-boundary spaces, normalizes punctuation spacing, dedupes terminal punctuation).
- **Citation and source-title protection** (source titles never translated, rewritten, or glossary-normalized; no duplicated terminal punctuation).
- **URL, number and protected-HTML preservation**.
- **Traditional Chinese CTA localization** (approved Chinese copy; URL/styling/attributes preserved).
- **Visible FAQ and FAQ-schema parity**.
- **Local preview exports** (JSON + HTML under `.tmp/shadow-previews/`).

**Severity behaviour:** Critical and major findings reject a translation. Minor and advisory findings remain **diagnostic** — they do not trigger retries, fallback, or extra calls, and do not prevent a valid article from saving.

---

## 5. Important files

Inspected against the current repository. Behaviour below is what is actually present.

| File | Current purpose |
| --- | --- |
| `src/lib/services/document-context-primary.ts` | Primary-path orchestration. Reads `ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY`; runs `runDocumentContextTranslationShadow` in primary mode; validates the result (critical/major findings, placeholders, FAQ parity, quality report); maps the retained `ArticleDocument` into a `TranslationResult` for the existing save mechanism; throws `PrimaryDocumentContextTranslationError` on failure (no save, no fallback, no old-pipeline call). The save gate no longer depends on an editorial stage. |
| `src/lib/services/document-context-translation-shadow.ts` | The shadow/primary runner: builds the source document + chunk plan, runs the 7 source-aligned translation calls, validates coverage, assembles the document, applies deterministic post-processing (`applyFaithfulDocumentPostProcessing`), aggregates diagnostics, and triggers the local preview export. The active workflow makes **no editorial calls**; `result.editorial` is a `not-run` diagnostic stub carrying the deterministic quality report and localized source references. |
| `src/lib/services/document-context-shadow-preview.ts` | Assembly + `applyFaithfulDocumentPostProcessing` (deterministic CTA localization, FAQ-schema rebuild, source-reference localization, severity quality report) and the preview payload builders. The three editorial orchestration functions (`runShadowEditorialPolish`, `runShadowEditorialBatch`, `runShadowMonolingualProofread`) and the finding-token bookkeeping machinery remain in source as **retained dead code** — they are not called by the active workflow and must not be removed unless handled in a separate cleanup task. |
| `src/lib/services/document-context-translation-shadow-prompt.ts` | Prompt construction for the 7 translation chunks (system + user): reusable `FAITHFUL_TRANSLATION_CONTRACT`, glossary, categorical style examples, nearby source context, and the exact `sourceUnitId` units. |
| `src/lib/services/translation-glossary.ts` | Canonical Hong Kong terminology glossary (strengthened), forbidden Mainland marketing terms, register markers, and the deterministic glossary prompt. |
| `src/lib/services/translation-style-examples.ts` | Versioned, category-grouped approved English-to-zh-HK style examples + reusable principles; every translation chunk receives the full set. |
| `src/lib/services/shadow-cantonese-quality.ts` | Deterministic quality pass: stable terminology glossary, `normalizeCantoneseTypographyText`, citation trailing-punctuation fix, CTA localization, `classifyBlockEnglish`, `analyzeDocQuality`, severity-based `QualityReport`, `applyShadowCantoneseQuality`. |
| `src/lib/services/source-reference-localization.ts` | Deterministic source-reference localization + validation (trailing-publisher-suffix stripping, canonical publisher appended once, `luna.hk → Luna`, duplicate-publisher validation, never-invent for unknown hosts). |
| `src/lib/services/b2i-cantonese-language-pack.ts` | Versioned language pack (terminology, style principles, approved examples, unapproved candidates) and `retrieveCantoneseExamples`/`buildLanguagePackExamplePrompt` (used for diagnostics). |
| `src/lib/services/deepseek-model-routing.ts` | Per-purpose routing: model, thinking mode, reasoning effort, `maxTokens`, `timeoutMs` from env with safe integer parsing and documented defaults (translation 8000/60000). |
| `src/lib/services/deepseek.ts` | The DeepSeek client and `AiService`. Builds `thinking: { type }` + `reasoning_effort`, parses only `message.content`, never exposes `reasoning_content`, classifies `token_exhaustion`/`truncated`/`empty_response`, owns retries/timeouts/tracing. `createDeepSeekClient()` is private to this module. |
| `src/lib/services/translation-service.ts` | The old production translation pipeline plus the primary-path early branch. When `isDocumentContextTranslationPrimaryEnabled()` is true it returns `runPrimaryDocumentContextTranslation` immediately; otherwise it runs the full old 38–45-call pipeline. |

**Corresponding test files (where useful):**

- `src/lib/services/document-context-primary.test.ts`
- `src/lib/services/document-context-translation-contract.test.ts`
- `src/lib/services/document-context-translation-shadow.test.ts` / `.integration.test.ts`
- `src/lib/services/document-context-roundtrip.test.ts`
- `src/lib/services/document-context-translation-shadow-prompt.test.ts`
- `src/lib/services/translation-glossary.test.ts`
- `src/lib/services/translation-style-examples.test.ts`
- `src/lib/services/source-reference-localization.test.ts`
- `src/lib/services/shadow-cantonese-quality.test.ts`
- `src/lib/services/deepseek-model-routing.test.ts`
- `src/lib/services/deepseek.test.ts`
- `src/lib/services/shadow-preview-export.test.ts`

---

## 6. Verified live behaviour

- **Version 22** — final successful **7+3** run, saved as DB ID **218**.
- The 7+3 editorial architecture was then removed from the active zh-HK workflow.
- **Version 23** — current confirmed baseline, saved as DB ID **219**, completed with:
  - 7 source-aligned translation calls;
  - **0 editorial calls**;
  - coverage **105/105**;
  - no editorial bookkeeping;
  - saved successfully.

**Translation quality:** Current output is **structurally faithful and much closer to the English source** than the previous editorial-polished path.

**Version history:** Old versions remain in version history while the newest saved version appears in the UI.

---

## 7. Current status — reusable translation contract

The reusable **faithful-translation contract**, **strengthened canonical glossary**, and **approved English-to-zh-HK examples** improvement has been **implemented and verified** (see section 4). Every translation chunk receives the same contract, glossary and categorical examples. This is the only remaining quality-improvement work for the direct translation path, and it is now in place.

Remaining work is **only** to keep refining the reusable direct-translation contract, glossary and approved English-to-zh-HK examples as new live runs reveal wording issues.

---

## 8. Routing (current implementation)

### Translation calls (7 × `document-context-shadow-chunk-*`)
- V4 Flash.
- Thinking disabled.
- 8,000 maximum output tokens.
- 60-second timeout.
- Native JSON output (`responseFormat.type = "json_object"`).

### Editorial calls
- None. `ENABLE_SHADOW_BILINGUAL_EDITORIAL_POLISH=false` and `ENABLE_EDITORIAL_POLISH=false`; the active workflow never invokes `editorial-bilingual-a`, `editorial-bilingual-b` or `editorial-monolingual-proofread`.

**Rules:**
- Parse **only** final `content`.
- **Never** parse, store, export, or log reasoning text.
- `finish_reason=length` with empty content and exhausted reasoning → **`token_exhaustion`**.
- `finish_reason=length` with partial content → **truncated final output** (rejected).
- `finish_reason=stop` with valid complete JSON → **success**.
- **No automatic retry.**
- **No fallback model.**
- **No old-pipeline fallback.**

Budget env values are parsed strictly (positive integers only); invalid/empty/zero/negative/non-numeric values safely fall back to the defaults.

---

## 9. Constraints for future work

- Preserve exactly **one active translation pipeline**: 7 source-aligned translation calls → deterministic validation → deterministic post-processing → assemble → save.
- **Do not** add another editor, translation path, fallback, feature flag, SQL change, or extra API call.
- **Do not** re-enable or restore the bilingual/monolingual editorial calls or their finding-token bookkeeping.
- **Do not** alter the verified English pipeline (English blog generation remains unchanged).
- **Do not** create an expanding phrase blacklist.
- **Do not** perform arbitrary sentence rewriting deterministically.
- **Do not** add SQL or migrations.
- **Do not** publish partial or invalid output.
- Retained editorial functions remain **dead code** and should not be removed unless handled in a separate cleanup task.
- **Do not** ask the coding assistant to run live generation or translation.
- **The user performs live runs manually.**
- Use **Standard mode with thinking off** for implementation.
- Use thinking mode **only** for code-change-free audits.

---

## 10. Testing baseline

Latest verified baseline:

- Full suite: **1,938 tests passed / 11 documented pre-existing failures**.
- Lint: clean on changed files.
- Build: successful.
- TypeScript: only the two documented pre-existing `section-expander.test.ts` errors.
- Only known `.tmp/shadow-previews` Turbopack file-count warning.
- **Zero new regressions.**

After the reusable translation-contract/glossary/examples improvement was implemented, the suite is **1,946 passed / 11 pre-existing failures** (0 new regressions).

Existing failures must **not** be reported as new regressions.

---

## 11. Expected logs

Expected translation logs:

```text
document-context-shadow-chunk-*
model=deepseek-v4-flash
thinking=disabled
max_tokens=8000
timeout=60000ms
```

Expected completion (no editorial stage):

```text
coverage=105/105
assembly=assembled
editorial=not-run
accepted=0
rejected=0
```

Then a normal blog-version creation log.

---

## 12. Preview location

```text
C:\Users\sean_\b2i-content-engine\.tmp\shadow-previews\
```

- Real live files begin with `project-19-`.
- `project-0-*` files are test artifacts.

---

## 13. Immediate next action

1. Confirm the current Version 23 baseline and reusable translation contract are stable.
2. If a future live run reveals wording issues, refine only the reusable faithful-translation contract, canonical glossary, and approved English-to-zh-HK examples (no new path, editor, flag, fallback, SQL or API call).
3. Run the targeted contract/glossary/examples suites plus the full suite, lint, build and `tsc --noEmit`.
4. Do not run a live translation.
5. Report the results to the user.
6. The user will then rebuild, restart and run the live translation manually.
