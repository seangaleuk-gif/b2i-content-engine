# B2I Content Engine — Complete Coder Handoff

**Authoritative handoff date:** 31 July 2026 (updated evening)

> **SUPERSEDED** by `NEW_CHAT_HANDOFF.md` (1 August 2026). The statements below that say translation is "awaiting verification", FAQ parity is 5/5/5, and research/external links are "live pending" are now stale. Traditional Chinese translation is live verified (project 19, version 6, saved ID 202), FAQ parity is 6/6/6, and research/external links are live verified. See `NEW_CHAT_HANDOFF.md` for the current authoritative state.

This is a detailed reference for a new coding chat. Read the actual code, tests, and logs before proposing fixes. Older statements in other Markdown files that contradict this file are stale.

---

## 00. Read first

- English generation is the **production-verified working baseline**. Do not destabilise it.
- DeepSeek routine stages use **thinking disabled** (`thinking: { type: "disabled" }`). Do not change thinking-mode, model, token budgets, or retry architecture without evidence.
- FAQ parity and malformed-repair persistence are **fixed and verified in a real run**.
- Editorial threshold remains **80**.
- Repetition repair now targets the **later duplicate paragraph**, validates word-set overlap, and has a **bounded deterministic fallback**.
- Traditional Chinese is the **only translation target**. Simplified Chinese is out of scope.
- Translation module tests are **93/93 passing**, but live Traditional Chinese translation is **still awaiting verification**.
- Automatic research and external-link fixes are **implemented and test-covered**; final live verification of a normal generation without manual research may still be pending.
- Test baseline: **18 pre-existing failures, no new regressions**.
- Lint baseline: **468 findings** (285 errors, 183 warnings).
- Build passes. Two pre-existing TypeScript errors remain in `section-expander.test.ts`.

Status separation used throughout this handoff:

- **Production verified** — proven by a real generation that passed final validation.
- **Implemented and test verified** — covered by targeted/full-suite tests only.
- **Awaiting live verification** — code complete and tested; needs a real run.
- **Pre-existing technical debt** — known failures/errors unchanged across recent work.

---

## 01. Current project status

### Product

B2I Content Engine is a private content-generation application for B2I Hub, a Hong Kong platform connecting local SMEs and creators. The engine generates SEO-focused English WordPress articles and Traditional Chinese translations.

### Stack

- Next.js 16.2.10, TypeScript, Supabase, DeepSeek API (`deepseek-v4-flash`)
- Canonical article representation: `ArticleDocument`
- WordPress block output
- Research provider: Brave Search (`src/lib/services/brave.ts`)

### Verified English baseline (production verified)

The latest fresh live English generation (new factual topic, no manual research selected) **passed final validation**:

```text
editorial score=94 (minimum: 80)
repeatedPairs=0
malformed=0
robotic=2
conclusionRatio=0.056
FAQ parity valid=true canonical=5 rendered=5 schema=5
word count=2767 (range 2125-2875)
final validation PASS
```

Also verified in that run:

- Repetition repair accepted with score **30 → 94** using the new preserve/replace targeting.
- `[editorial-repetition-pair]` diagnostics emitted stable block IDs, overlap, keyphrase/numbers/links flags, and text.
- DeepSeek routine stages: `thinking=disabled`, `reasoning_tokens=0`, first-attempt completion.

### Translation status (implemented and test verified; live pending)

- Traditional Chinese is the only translation target. Simplified Chinese is out of scope.
- Translation unit tests: **93/93 passing** (editorial-block-translation.test.ts).
- Live Traditional Chinese translation acceptance is **still awaiting verification** (one full Traditional Chinese translation must pass validation, persistence, and audit against the verified English article).

### Research and external links (implemented and test verified; live pending)

- Automatic research dispatch is implemented in `runBlogGeneration` (auto when no research rows exist; manual rows suppress auto; provider failure degrades with a clear warning; no fake sources).
- External-link stage injects from approved sources, logs candidates/inject/final counts, and warns when zero eligible sources exist.
- `generated.externalLinks` metadata now reflects the real final article links.
- A normal generation **without manual research** must still be run once to confirm `[research-dispatch] willRun=true`, approved research > 0, and `[external-links:final] saved > 0`.

### Acceptance sequence

1. English generation is the protected baseline (verified).
2. Finish automatic research/external-link live verification.
3. Run and audit one full Traditional Chinese translation.
4. Manual article inspection before each production claim.

---

## 02. Architecture non-negotiables

- `ArticleDocument` is the single canonical mutable article representation. `state.blog` is a rendered cache only, updated only through `syncBlogFromDocument()`.
- The visible FAQ and FAQPage schema are generated from the same current canonical FAQ entries (`articleDoc.visibleFaq`). No stale protected FAQ snapshot may overwrite later factual or editorial mutations. `final-preflight` verifies canonical/rendered/schema parity immediately before final validation.
- All post-assembly processing lives in `blog-generation-pipeline.ts`. No parallel pipelines, compatibility wrappers, or duplicated validators.
- Repairs target stable block IDs (`kind:componentId:blockId`), never array positions or fuzzy labels. Revalidate the exact block immediately; prove no later restore resurrects old text.
- Final pass/fail is owned only by `analyzeFinalArticle()` → `evaluatePolicy()` → `runFinalValidation()`. No second gate.
- Hard failures: WordPress block imbalance, nested paragraphs, malformed headings/prose, severe keyphrase stuffing, FAQ block/schema parity mismatch, CTA/signup mismatch, internal-link maximum breach, editorial score below minimum (80).
- Soft warnings (never block): keyphrase missing from H2/first 100 words, low density, slight word-count deviation.
- All AI provider access goes through `AiService` (`deepseek.ts`). No other module instantiates clients, implements retries/timeouts, or omits explicit thinking mode.
- Single owners: `auth.ts` (identity), `project-authorization.ts` (project access), `errors.ts` (`AppError`/`toErrorResponse`).
- Research ownership: `runBlogGeneration` dispatches automatic research via `runBraveResearchWithRetry` and persists rows through `researchRepository`; the pipeline consumes `context.research` for prompts, factual scanning, claim ownership, and external-link injection.
- External-link counting uses the canonical definition (`countEditorialExternalLinks` / `extractEditorialExternalLinkUrls`): script/schema blocks, CTA signup, language switcher, internal B2I URLs, and relative URLs excluded.
- Editorial polish: malformed/weakened/repetition targeted repairs persist to canonical even when the general polish is rejected; the general polish remains gated at score 80.

---

## 03. DeepSeek request policy

Confirmed API syntax (do not change):

```ts
thinking: { type: "disabled" }   // routine stages
thinking: { type: "enabled" }    // reserved reasoning stages
// thinking: false is invalid (HTTP 400)
```

- Every request body carries an explicit `thinking` object; no provider default reliance.
- Routine stages (outline, intro, sections, FAQ, conclusion, retries/repairs, editorial malformed/post-cleanup/repetition/prose-only/general polish, claim fix, expansion/trim, SEO helpers, all translation calls, metadata): **thinking disabled**.
- Reserved reasoning stages: `factual-risk`, `evidence-reconciliation`, `quality-diagnosis`: thinking enabled.
- Every `finish_reason === "length"` response is rejected as truncated, including partial non-empty content. Partial JSON never reaches parsers.
- Reasoning content is never parsed, placed into articles, or logged.
- Token escalation: retry 1 = ×1.5, retry 2 = ×2, global cap 32,768. Stage budgets: outline 4,096; intro 6,144; intro retry/repair 8,192; sections 8,192; FAQ/conclusion 6,144; conclusion retry/repair 8,192; editorial/large repair calls commonly 16,384.
- Sanitized logging only: stage, request ID, model, thinking mode, attempt, tokens, finish reason, lengths. Never API keys, prompts, article content, or full responses.
- This subsystem is complete and protected. Do not modify it without evidence of a defect.

---

## 04. English generation pipeline

Flow (implementation authoritative; do not reorder without proof):

```text
request validation
→ research dispatch (automatic when no approved rows exist)
→ research/evidence preparation
→ outline
→ introduction and sections
→ FAQ and conclusion
→ assemble ArticleDocument
→ section expansion/trim and component regeneration
→ SEO normalization
→ factual scan
→ claim ownership cleanup
→ malformed-prose repair
→ editorial repair/polish with guarded acceptance (malformed → weakened → repetition → general → prose-only)
→ internal links (link-injector)
→ external links (approved research sources)
→ external dedup
→ link enforcement
→ factual final confirmation
→ language switcher and CTA preservation
→ final trim
→ FAQ recovery/schema generation
→ word-count check
→ final preflight (malformed re-check, FAQ rebuild, parity confirmation, external-link final count)
→ final validation
→ persistence/readback
```

### Research dispatch (implemented)

- `runBlogGeneration` reads existing `research_sources` rows. If none exist and the project has a keyword/topic, it runs `runBraveResearchWithRetry`, deduplicates by URL, persists rows, and re-reads them into `context.research`.
- Manual research rows suppress automatic research.
- Provider failure or zero results: generation continues without research (degraded mode) with a clear warning — never fabricated sources.
- Logs: `[research-dispatch]`, `[research:start]`, `[research:provider]`, `[research:results]`, `[research:handoff]`.

### External links (implemented)

- `external-links` stage: `[external-links:candidates] researchSources=n eligible=n rejected=n`, `[external-links:inject] requested=n inserted=n skipped=n`, zero-eligible warning pushed to `state.warnings`.
- `final-preflight` logs `[external-links:final] saved=n urls=[...]`.
- `evidenceRelevanceScore` attaches a source when the paragraph shares a quantity, contains a quotation (≥6 shared tokens), or shares ≥6 lexical tokens with the source (prose-only sources).
- Links inserted as `Source: <a href="...">title</a>.` citation paragraphs at section block boundaries; B2I-owned domains excluded; deduplicated.

### Editorial rules

- Editorial minimum remains **80**.
- Repetition repair: deterministic targeting preserves the **earlier** paragraph and rewrites only the **later** duplicate; prompt supplies the preserved partner text and duplicated idea; per-target overlap must drop below 0.55 or the candidate is rejected; after two failed AI attempts the bounded deterministic fallback removes the echoed sentences (keeping numbers, links, quotes, protected sentences, and the exact keyphrase) or removes the block only when nothing protected is lost.
- Malformed repair persists by stable block ID even when the general polish is rejected (`targeted repairs persisted`).
- FAQ parity verified by `final-preflight` before final validation.

### Current latest-run metrics (production verified)

```text
editorial score=94 | repeatedPairs=0 | malformed=0 | robotic=2 | conclusionRatio=0.056
FAQ parity valid=true canonical=5 rendered=5 schema=5
word count=2767 (2125-2875) | final validation PASS
```

---

## 05. Translation pipeline

- **Target: Traditional Chinese only. Simplified Chinese is out of scope.**
- Status: unit tests **93/93 passing** (editorial-block-translation.test.ts). Live Traditional Chinese acceptance is **awaiting verification**: one full translation must pass validation, persistence, and the Chinese SEO audit against the verified English article.
- Thinking disabled for all routine translation calls (plain text, editorial HTML/block, headings, FAQ, CTA, conclusion shadow/repair, strict repair, editorial repair, metadata).
- Required behavior: natural Traditional Chinese for Hong Kong readers; preserve numbers, percentages, currencies, dates, URLs, named sources, link destinations; preserve structure, heading/FAQ counts and order, CTA, schema, switcher; regenerate Chinese FAQ schema from final canonical entries; validate title/meta/keyphrase/body/parity before saving; never damage the English article; verified save/readback.
- Safeguards implemented and test-covered: deterministic number protection/restoration, English-leakage detection, source-echo rejection (`isSourceEcho`) for unchanged English candidates (including numeric-interrupted word runs), FAQ boundary validation, metadata range compliance, structured fallback, conclusion shadow evaluation, source-English version pairing, Chinese SEO audit, atomic/compensated persistence.
- Historical defects (enFaqCount=0, empty metadata responses, range failures, English fallback, parity mismatch, lost numbers, field normalization) must be rechecked against the current code before being claimed as fixed.

---

## 06. Current blockers and next fixes

### Resolved (production verified)

- FAQ canonical-body-schema parity mismatch — fixed.
- Malformed paragraph repair persistence — fixed (targeted repairs persist; deterministic fallback removes fragments).
- Editorial repetition deadlock — fixed (targeted later-paragraph repair with overlap validation + bounded fallback).
- Robotic `remember` false positive — fixed (imperative-only detection).

### Awaiting live verification

1. **Automatic research + external links on a normal generation** (no manual research selected). Run one generation and confirm `[research-dispatch] willRun=true`, `[research:results] approved>0`, `[research:handoff] externalLinkCandidates>0`, `[external-links:final] saved>0`, and external URLs present in readable body content.
2. **Traditional Chinese translation end-to-end** against the verified English article (validation, persistence, audit).

### Pre-existing technical debt (do not fold into new work)

- 18 failing tests across 6 files, unchanged baseline (see 07).
- 2 TypeScript errors in `section-expander.test.ts`.
- 468 lint findings (285 errors / 183 warnings), dominated by `no-explicit-any` and `no-unused-vars`.

### Prohibited changes without evidence

DeepSeek thinking-mode/model/budgets/retries, general generation prompts, editorial threshold (80), SEO/factual thresholds, translation architecture, database/Supabase, concurrency, lint configuration.

---

## 07. Test, build, lint, TypeScript status

### Full suite (verified 31 July 2026 evening)

```text
Test Files  6 failed | 24 passed (30)
Tests       18 failed | 1442 passed (1460)
```

The 18 failures are the **unchanged pre-existing baseline** (no new regressions). Failing files:

- `src/lib/blog/final-seo-normalizer.test.ts` (4)
- `src/lib/pipeline/blog-generation-e2e.test.ts` (1 — language-switcher fixture href guard)
- `src/lib/services/component-regenerator.test.ts` (2)
- `src/lib/services/conclusion-shadow-evidence.test.ts` (4 — real DeepSeek calls time out / 401 without valid credentials)
- `src/lib/services/section-expander.test.ts` (2)
- `src/lib/services/translation-service.test.ts` (5)

### Targeted suites (all passing)

- `deepseek.test.ts` 28/28
- `blog-generation-service.test.ts` 22/22 (includes research dispatch tests)
- `editorial-repetition-repair.test.ts` 14/14
- `blog-generation-pipeline.test.ts` 73/73
- `editorial-block-translation.test.ts` 93/93
- `publication-quality.test.ts` + `editorial-polish.test.ts` passing

### TypeScript

`npx tsc --noEmit`: exactly 2 errors, both pre-existing in `src/lib/services/section-expander.test.ts` (29:24, 63:24). Byte-identical to the previous baseline.

### Production build

`npm run build`: passes (compiled ~5-6s, TypeScript ~8-11s, 26/26 static pages, no warnings).

### Lint baseline

```text
468 problems: 285 errors, 183 warnings
```

Top categories: 269 `no-explicit-any` errors, 176 `no-unused-vars` warnings, 7 `prefer-const`, 5 `no-require-imports`, React compiler diagnostics, minor a11y/image warnings. Do not bulk-fix lint during feature work.

### Reporting rule

Reports must distinguish: new failures, unchanged known failures, fixed failures, tests not run.

---

## 08. Changelog — 31 July 2026

- DeepSeek: explicit thinking-mode control (routine stages disabled), truncation rejection, token escalation capped at 32,768. Protected.
- FAQ parity: entity-decoded extraction + `final-preflight` parity check. Production verified.
- Malformed persistence: targeted repairs (malformed/weakened/repetition) committed even when the general polish is rejected; deterministic malformed fallback. Production verified.
- Repetition repair: order-based targeting (preserve earlier, rewrite later), preserve/replace prompt context, per-target overlap validation (< 0.55), bounded deterministic fallback (sentence dedup / safe removal). Tests 14/14; production verified (score 30 → 94).
- Robotic detector: `remember` now imperative-only (false positive fix).
- Research: automatic dispatch in `runBlogGeneration` with manual suppression, dedupe, persistence, degraded-mode warnings, `[research-dispatch]` diagnostics. Test verified; live pending.
- External links: candidates/inject/final diagnostics, zero-eligible warning, prose-overlap relevance fallback (≥6 shared tokens), canonical `extractEditorialExternalLinkUrls`, real `externalLinks` metadata. Test verified; live pending.

---

## 09. Coder working rules

- Read the handoff files, then inspect actual code and logs before proposing a root cause.
- Keep coder prompts concise; do not bury the requested action under explanation.
- Protect the verified English pipeline. Do not revisit fixed architecture without evidence.
- Changes narrowly scoped to the proven issue; no unrelated cleanup; no silent threshold weakening.
- Preserve single ownership; remove superseded paths; use stable block IDs; AI access via `AiService`; final gate only via the centralized validation path.
- Add behavioural regression tests for every fix.
- Reports must include: root cause, files changed, behavioural change, targeted results, full-suite delta, TypeScript, build, remaining failures, not-verified items.
- Do not claim end-to-end success before the user's real generation/translation runs.
- Never expose API keys, prompts, or article content in logs.

---

## 10. Next chat start prompt

See `NEW_CHAT_START_PROMPT.md` — a concise ready-to-copy prompt for the next chat.
