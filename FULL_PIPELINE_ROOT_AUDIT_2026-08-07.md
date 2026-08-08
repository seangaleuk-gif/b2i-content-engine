# B2I Content Engine — Full Pipeline Root Audit

**Date:** 7 August 2026  
**Audited source:** `B2I-Content-Engine(9).zip`  
**Source SHA-256:** `d22efb2bf45696a20352d5458a63430bee6da3e3a6c2499a12e6d9c029e31e08`

## Outcome

The staged English generator was preserved. No whole-article generation call,
threshold weakening, database-schema change or model/token-budget change was
introduced. The fixes close root defects at the canonical-document,
transaction, structural-validation, word-count, translation-acceptance and
authorization boundaries.

## Root causes fixed

### English generation

1. **Intentional citation deletion used the wrong integrity contract.**
   `final-qc-scan` removed a selected source link but compared the candidate to
   a baseline that still required that link. It also passed a fingerprint where
   fallback HTML was required. Integrity baselines now support exact
   multiset-aware link-occurrence subtraction. The transaction records stable
   block IDs and URLs, validates the candidate against the derived baseline,
   restores the full snapshot on rejection and re-runs every scanner on the
   exact candidate.

2. **Duplicate identical links were invisible to missing-link diagnostics.**
   Set-style `includes()` checks could not detect loss of one of two equal
   `href` values. Link comparison now uses multisets. Repeated relevance
   findings for one citation block are deduplicated and removal counts report
   actual mutations.

3. **Temporal repair required an unrelated absolute word-count recovery.**
   A useful stale-wording repair could be rejected solely because an earlier
   stage had left the article above/below range. Acceptance is now
   baseline-relative: an in-range document must remain in range, an overrun may
   not grow, and a shortfall may not shrink. All factual/editorial non-regression
   checks remain hard. Before/after canonical counts are logged.

4. **Rejected editorial candidates could remain canonical.**
   When broad editorial polish was rejected and no targeted repair existed, the
   chooser returned the rejected working document. The transaction now captures
   a pre-editorial `ArticleDocument`, commits accepted broad work, commits only
   validated targeted repairs when appropriate, otherwise returns the baseline,
   then always re-renders and asserts canonical/cache equality.

5. **Editorial word trimming validated one document and saved another.**
   The comparative validator trimmed a clone but only copied three metrics back
   to the untrimmed candidate. It now replaces the exact candidate in place with
   the validated trimmed document, recomputes its HTML and uses that same object
   for factual, ownership and commit checks.

6. **SEO normalization counted the tokenized/rendered view instead of the
   canonical article.** The normalizer now accepts
   `canonicalVisibleWordCount`, carries the protected FAQ-visible offset through
   expansion and final metrics, uses the canonical denominator for keyphrase
   density, and returns fresh metrics after a second density-reduction pass.

7. **SEO mutations reused stale paragraph offsets.** Keyphrase removal is
   limited to one accepted edit per original block per pass; insertion is
   position-safe and re-extracts fresh fallback blocks; expansion visits each
   selected block once and re-extracts before its bounded final attempt.

8. **SEO paragraph rewrites could discard inline markup.** Whole-paragraph AI
   rewrites exclude live inline-tag paragraphs. Links remain protected tokens.
   Long-paragraph splitting now delegates to the typed structure-aware splitter,
   preserving inline markup and exact WordPress boundaries.

9. **Production stages guessed repairs for malformed WordPress output.**
   `rebalanceWpBlocks()` is no longer called by production generation, expansion,
   trim or SEO normalization. Expansion/trim candidates must be non-empty,
   H2-free and type-balanced. Trims must also be strictly shorter and preserve
   the exact ordered `href` and numeric-token sequences. Invalid candidates are
   rejected rather than rewritten heuristically.

10. **Expansion/trim recalculated an incomplete article word count.** The
    section service now receives a callback over its current working sections;
    the pipeline applies those sections to a clone of the complete
    `ArticleDocument` and counts introduction, headings, sections, conclusion and
    visible FAQ through `countCanonicalVisibleWords()`.

11. **Test injection stopped at initial drafting.** A supplied
    `GenerationOverrides.requestDeepSeek` now owns every pipeline and tracked
    stage call. Tests cannot silently fall through to the real provider. The
    initial language switcher is rendered through the canonical renderer and
    fingerprinted from its actual HTML. Dead regex-based heading repair code was
    removed.

### Traditional Chinese translation/localisation

12. **Removing an English token was treated separately from naturalness and
    meaning acceptance.** `translation-acceptance.ts` is now the shared
    deterministic gate for parity, mandatory zh-HK quality, global calques,
    source-aware literal translations, CTA claims and complete-document review.
    It catches, in aligned source context:

    - `nice-to-have` → `有就最好` / close literal variants;
    - `walking billboard` → `活動廣告板` / `人肉廣告板`;
    - `out of touch` → `失焦`;
    - `keeps everyone honest` → literal `老實啲` / `保持誠實` renderings.

    `失焦` is not globally banned; it is rejected only when aligned with the
    English idiom `out of touch`.

13. **Translation saving had no single zero-write acceptance boundary.** The
    route now evaluates the exact reconstructed English document and candidate
    Chinese document after the Chinese SEO hard gate but before requesting the
    next version number or performing any database mutation. The post-save
    readback and the publication gate use the same acceptance owner.

14. **Default provider retries escaped the shared translation budget.** When a
    `RetryBudget` exists, every call now forwards the budget-capped retry count,
    including calls that would otherwise rely on the default of two retries.
    No-budget calls retain the existing provider default.

15. **Final-document stage labels emitted unassigned-thinking warnings.** The
    diagnosis, patch, acceptance and final-trim-compaction labels are explicitly
    assigned `thinking=disabled`; model routing and budgets are unchanged.

### Persistence and authorization

16. **Version deletion verified project access but not version ownership.** The
    DELETE route now reads the requested version and requires both its
    `projectId` and `userId` to match the authorized route project/current user.
    Cross-project and cross-user targets return not-found and are never deleted.

## Canonical pipeline order

1. claim check
2. conclusion discipline when enabled
3. expansion
4. trim
5. paragraph normalization
6. component regeneration
7. SEO normalization
8. title repair
9. factual scan
10. claim ownership
11. temporal freshness
12. post-factual keyphrase check
13. final paragraph normalization
14. deterministic malformed-prose repair
15. targeted editorial polish when enabled
16. final claim ownership
17. canonical language switcher
18. internal links
19. external links
20. external-link deduplication
21. link enforcement
22. final factual scan
23. post-ownership SEO reconciliation
24. canonical CTA preservation
25. final trim
26. FAQ recovery and schema rebuild
27. canonical word-count check
28. final preflight
29. deterministic final QC transaction
30. full-document editorial when enabled
31. final validation-only gate
32. persistence/readback

The full-document English editor remains an end-stage selective block-patch
transaction. It does not replace staged drafting and does not generate the
complete article in one call.

## Model-call boundaries and deterministic gates

| Boundary | Model may do | Deterministic acceptance |
|---|---|---|
| Outline/drafting | Generate staged component content | JSON/WordPress parsing, component shape, claim ownership |
| Expansion | Return additional blocks for one section | No H2/link/CTA, valid typed WP pairs, positive growth, canonical recount |
| Trim | Return one shorter section body | Valid WP pairs, shorter text, exact ordered links/numbers, canonical recount |
| SEO | Expand/rewrite eligible plain paragraphs | Protected tokens byte-identical, link parity, WP validation, canonical word/density metrics |
| English targeted editor | Return stable-ID replacements | Allowed IDs only, protected sentences/numbers/URLs, full candidate policy and comparative checks |
| English full-document editor | Diagnose whole document; patch selected editable units | Per-patch validation, protected surfaces, unresolved/overflow gate, final policy gate |
| Translation | Translate aligned components | Number placeholders, structure, source/target parity, FAQ/schema, links, CTA and zh-HK acceptance |
| zh-HK document review | Select and correct suspicious aligned units | Field allowlist, meaning/strength parity, mandatory quality, calques/literals, document acceptance |

## Logging contract

Existing stage outputs plus the strengthened transactions must retain:

- run/stage ID, mode, input/output fingerprints and accepted/fallback status;
- selected stable unit/block IDs and selection reasons;
- selected citation URLs for intentional removal;
- returned patches/edits and their target IDs;
- accepted and rejected patches with deterministic rejection reasons;
- applied block IDs and before/after canonical word counts;
- unresolved finding/unit IDs and mandatory-selection overflow;
- parity, protected-content and final policy failures;
- final acceptance status before any save;
- post-save readback acceptance or compensation/rollback result.

No prompt body, credential, session token or full private article is added to
the new logging paths.

## Regression coverage added/strengthened

- duplicate-link multiset preservation and one-occurrence intentional removal;
- duplicate relevance finding deduplication;
- temporal overrun improvement/regression, in-range exit and shortfall
  regression;
- rejected broad editorial rewrite restores the baseline document;
- canonical FAQ-visible offset prevents unnecessary SEO expansion;
- structure-aware paragraph splitting and no production rebalancing;
- expansion/trim structural, URL, numeric and canonical-count acceptance;
- provider override owns post-assembly model calls;
- retry budget caps default-retry calls;
- source-aware `out of touch`/`失焦` rejection and natural replacement pass;
- translation route performs zero writes on failed pre-save acceptance;
- cross-project/cross-user version deletion is rejected.

## Verification

- `npx tsc --noEmit`: **pass**.
- Production `next build` with non-secret placeholder public Supabase build
  variables: **pass**, all routes generated.
- English `src/lib/blog` + `src/lib/pipeline`: **987/987 passed**.
- Translation/service/route selection: **287/287 passed**.
- Focused changed-file selection: **142/142 passed** before the final added
  citation-dedup regression; that regression is included in the 987 total.
- Lint: **446 findings (270 errors / 176 warnings)** versus untouched archive
  baseline **448 (270 errors / 178 warnings)**. No new lint errors; two stale
  warnings were removed with dead code.

The broad provider-capable document-context test batch was blocked by the
execution safety layer because it can send fixture/article content to the live
DeepSeek API. It was not bypassed. The offline/mocked translation, acceptance,
route and publication suites above passed. No claim of three consecutive live
production translations is made.

## Feature flags

Recommended production configuration after deployment validation:

```text
ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true
ENABLE_FULL_DOCUMENT_ZH_REVIEW=true
ENABLE_EDITORIAL_POLISH=true
ENABLE_FULL_DOCUMENT_EDITORIAL=true
FULL_DOCUMENT_EDITORIAL_MODE=enforce
```

Remove or leave unset:

```text
ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW
ENABLE_SHADOW_BILINGUAL_EDITORIAL_POLISH
```

An explicit `false` is equivalent to unset. Do not remove or disable
`ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true`. If English full-document
editorial has not completed shadow evaluation in the deployment environment,
use `FULL_DOCUMENT_EDITORIAL_MODE=shadow` first; shadow mode is diagnostic and
must not be represented as enforce acceptance.

## Remaining operational risks

- AI output remains non-deterministic; one controlled English generation and
  three consecutive real Traditional Chinese translations are still required
  by the repository's production-verification rule.
- Existing repository-wide lint debt remains (270 errors), unchanged by this
  audit. It is not a generation/translation gate because TypeScript and the
  production build pass, but it should be handled as a separate scoped cleanup.
- `NEW_CHAT_HANDOFF.md` was referenced by `AGENTS.md` but missing from the input
  archive. This package adds it as a concise pointer to this audit and the
  updated `HANDOFF.md`.
