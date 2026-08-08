# B2I Content Engine — Full Generation and Translation Root Audit

**Audit date:** 8 August 2026  
**Input:** exact source recovered from the previously delivered B2I-9 audited ZIP  
**Scope:** research-to-outline-to-save English generation, complete-document English QC, Traditional Chinese translation/review, publication acceptance, canonical state, protected markup, persistence and compensation  
**Rule:** no final threshold was weakened and no full-article English generation call was added.

## Outcome

The production failure

```text
type=heading-duplicated-keyphrase-heading
heading="Hong Kong Marketing Trends 2026: What's Shaping Hong Kong Marketing"
```

was traced to the first accepting producer: `normalizeOutlineHeadings()` accepted
the heading before section drafting. Final QC behaved correctly by rejecting it,
and the route correctly performed zero writes. The root fix now repairs that exact
heading before any section prompt is sent. If a deterministic repair would discard
a distinct topic, number or alphanumeric term, the engine makes one bounded
`outline_quality_retry` call before drafting and fails closed if that retry is still
invalid.

The audit also found twelve additional reproducible boundary defects. All are fixed
at their owning stage and regression-covered below.

## Issues found and root fixes

| # | Proven issue | First owning boundary | Root fix | Failure behaviour |
|---|---|---|---|---|
| 1 | Outline H2 naturalness was checked only near the end, after every section had already been drafted against a bad heading. | Outline acceptance | Added one shared text-level heading detector/repairer used both before drafting and by final QC. The exact production heading becomes `Hong Kong Marketing Trends 2026` before `section_0`. | Unsafe/non-semantic deterministic repair is refused; one targeted outline retry runs before drafting; a second failure aborts with zero writes. |
| 2 | The fallback `Why ${topic} Matters in Hong Kong` could produce `Why Hong Kong Marketing Matters in Hong Kong`. | Outline fallback generation | Every fallback passes through the same shared naturalness owner; the example becomes `Why Hong Kong Marketing Matters`. Repairs may remove only duplicate/framing language, never distinct subject words or numeric-bearing tokens. | Unresolved fallback candidates are skipped; the outline fails if the required H2 range cannot be safely met. |
| 3 | Post-ownership SEO reconciliation could create a new duplicated-location H2 such as `Hong Kong Marketing Trends 2026: Hong Kong Digital Marketing Strategy`. | Post-ownership SEO producer | Every proposed H2 now passes the same shared detector before commit, and the complete candidate has a final heading-naturalness check. H2 placement is soft SEO, so an unsafe mutation is not committed. | Original semantic heading is retained; final QC remains the hard backstop. |
| 4 | Pure off-topic source citations were removed inside `final-qc-scan`, after final trim, word-count check and preflight. That made a stage called “scan” a late mutator and let earlier gates measure a different document. | Source relevance repair ordering | Added `source-relevance-repair` immediately after `claim-check` and before expansion. It selects exact stable block IDs/URLs, derives a multiset-aware link-removal baseline, applies atomically, rescans, logs, and fails closed. `final-qc-scan` is mutation-free again. | Failed integrity or unresolved embedded citation restores the complete pre-stage snapshot and aborts. Expansion and all later gates now see the actual post-removal document. |
| 5 | The external-link injector ranked source relevance mainly against paragraph text and treated H2 overlap only as a score bonus. It could therefore create a citation that the later H2/source relevance gate was guaranteed to reject. | External-link citation producer | Extracted one shared `assessHeadingSourceTextRelevance()` rule. The injector must pass it before a citation can be inserted, and the final scanner uses the same rule. Existing body relevance and evidence matching remain required. | An H2-irrelevant source is not inserted, even when its text strongly matches a paragraph. Final QC stays a mutation-free backstop instead of cleaning up producer output. |
| 6 | The FAQ model could override the accepted FAQ H2 with different text or markup, and malformed/count-invalid FAQ JSON had no targeted retry. | FAQ component acceptance | The outline-owned FAQ H2 is now immutable. FAQ output is deterministically validated for array shape, dynamic count, non-empty string fields, English-only copy, no markup and no CTA/signup copy. One `faq_repair` call is allowed. | A still-invalid repair aborts before `ArticleDocument` assembly; no partial FAQ reaches final QC or persistence. |
| 7 | Canonical H2 strings were interpolated into HTML without escaping. Escaping alone would have caused `&` to double-encode after render→parse→render. | `ArticleDocument` renderer/parser | Main and FAQ H2 text is escaped by the canonical renderer and decoded by the canonical parser. A malicious-looking H2 renders as text, and render→parse→render remains byte-stable. | WordPress structure and canonical cache equality remain enforceable without script/markup injection. |
| 8 | Model-produced slugs were inserted into protected language-switcher hrefs after only removing a suffix. Quotes, paths or markup-like text could enter the href. | Canonical slug pairing | `normalizeArticleSlug()` now produces exactly one lowercase ASCII WordPress path segment. `pairedSlugs()` derives both language slugs from it, and the switcher ignores a mismatched alternate slug and derives the pair from the English slug. | Empty input becomes `blog-post`; unsafe characters cannot reach the protected href. The same owner is used by English and translation paths. |
| 9 | Outline title/meta/excerpt accepted HTML/WordPress comments as plain metadata, and JSON diagnostics logged the first/last 300 characters of model responses. | Outline metadata acceptance and JSON logging | Metadata is normalized to plain text before it enters later prompts/canonical metadata. Script/style contents, tags, WP comments and control characters are removed. JSON diagnostics now log type, length and parse status only—never article snippets. | No model response/article copy is emitted by `robustJsonParse()` diagnostics. |
| 10 | The first shared heading-detector draft treated any second `Hong Kong` mention as mechanical duplication, which would reject legitimate comparisons such as `Hong Kong vs Singapore: What Hong Kong Brands Need to Know`. | Shared heading detector | Location duplication now requires either a repeated topic across colon halves or a redundant trailing `in/for Hong Kong` suffix. The exact production defect and fallback remain detected, while distinct comparison topics remain byte-identical. | Ambiguous headings are left unchanged for later validation; safe deterministic repair never deletes a distinct comparison topic. |
| 11 | A syntactically valid JSON primitive or array from the outline model reached property assignment and could throw an incidental runtime `TypeError`. The no-H2 branch also logged up to 500 characters of the outline payload. | Outline response shape boundary | Require a non-array JSON object before metadata or heading access. The no-H2 diagnostic now logs keys only; a regression uses a private marker and verifies it is never logged. | Invalid outline shape aborts before any component call and before canonical assembly, with zero writes. |
| 12 | FAQ CTA validation examined only answers and only URL-like signup forms, so app-owned CTA wording in a question could pass component acceptance. | FAQ component acceptance | Run the shared canonical CTA pattern plus signup/register detection across the combined question and answer before accepting each FAQ entry. | One bounded `faq_repair` is allowed; a second violation aborts before assembly. |
| 13 | The external-link stage computed `externalAfter` from its unchanged input HTML rather than the returned candidate, so logs could report zero immediately after successful insertion. | External-link stage diagnostics | Count the canonical external links from `result.html`, the same candidate returned for commit. | Diagnostics now report the committed candidate; the end-to-end test requires a positive after-count when links are inserted. |

## Changed files and responsibility

| File | Responsibility in this audit |
|---|---|
| `src/lib/blog/content-relevance.ts` | Shared H2 naturalness/repair and shared H2-to-source relevance ownership. |
| `src/lib/services/blog-generation-service.ts` | Pre-draft outline acceptance, metadata/outline shape checks, FAQ acceptance and bounded retries. |
| `src/lib/blog/post-ownership-seo-reconcile.ts` | Prevent late SEO reconciliation from producing a heading rejected by the final owner. |
| `src/lib/pipeline/blog-generation-pipeline.ts` | Early transactional source repair, mutation-free final QC, corrected external-link diagnostics and stage-order enforcement. |
| `src/lib/services/article-postprocessors.ts` | Safe slug pairing/switcher rendering and producer-side H2/source citation acceptance. |
| `src/lib/blog/article-document.ts` | Escaped canonical H2 rendering plus entity-decoded round-trip parsing. |
| `src/lib/services/text-utils.ts` | Content-free JSON parse diagnostics. |
| `src/lib/blog/heading-naturalness.test.ts` | Production H2, fallback, semantic/numeric safety and comparison false-positive regressions. |
| `src/lib/pipeline/source-relevance-repair.test.ts` | Atomic citation removal, exact logging and snapshot-restore regressions. |
| `src/lib/services/article-postprocessors-security.test.ts` | Slug and protected switcher injection regressions. |
| Existing generation, SEO, reconciliation, final-QC and e2e tests | Producer/final-owner agreement, FAQ repair, metadata/privacy, H2 round-trip and logging regressions. |
| Handoff/read-first/pipeline/status Markdown | Current order, issue list, verification totals, limitations and operator next steps. |

## Exact English pipeline order after the audit

### Staged generation (unchanged architecture)

1. Load project, prompt, research and knowledge context.
2. Resolve manual-versus-automatic research dispatch.
3. Generate outline JSON; retry once only for invalid JSON.
4. Normalize title/meta/excerpt as plain text and normalize the slug pair.
5. Normalize H2 count/order; run shared heading-naturalness acceptance.
6. Apply a safe deterministic H2 repair, or one bounded `outline_quality_retry` before drafting.
7. Build the claim-ownership ledger against accepted section IDs/headings.
8. Generate introduction as structured editable blocks; validate/repair.
9. Draft each accepted H2 section independently as structured blocks; validate/repair each section.
10. Generate structured FAQ entries; run deterministic shape/content/count acceptance and at most one `faq_repair`; keep the outline-owned FAQ H2.
11. Generate conclusion as structured blocks with CTA content disallowed; validate/repair.
12. Assemble the one canonical `ArticleDocument` and render only through `renderArticleDocument()`.

The English article is still never generated in one complete-document call.

### Post-assembly stages

1. `claim-check`
2. `source-relevance-repair`
3. `conclusion-discipline` when editorial polish is enabled
4. `expansion`
5. `trim`
6. `paragraphs`
7. `regeneration`
8. `seo-normalization`
9. `title-repair`
10. `factual-scan`
11. `claim-ownership`
12. `temporal-freshness`
13. `post-factual-keyphrase`
14. `paragraphs-final`
15. `malformed-prose-repair`
16. `editorial-polish` when enabled (targeted block repair; broad ownership is deferred when complete-document editorial is enabled)
17. `claim-ownership-final`
18. `language-switcher`
19. `internal-links`
20. `external-links`
21. `external-dedup`
22. `link-enforce`
23. `factual-final`
24. `post-ownership-seo-reconcile`
25. `cta-preserve`
26. `final-trim`
27. `faq-recovery`
28. `wc-check`
29. `final-preflight`
30. `final-qc-scan` (mutation-free deterministic backstop)
31. `final-document-editorial` when enabled (complete-document diagnosis plus selected block patches only)
32. `final-validation` (validation only)
33. Route canonical-agreement and pre-save validation.
34. Version creation/project update, raw readback, post-save validation, or compensation rollback.

## Model-call boundaries and deterministic acceptance

| Model boundary | Model output scope | Deterministic acceptance before commit |
|---|---|---|
| Outline | Metadata and H2 list only | JSON shape, plain metadata, safe slug, H2 range/order, shared naturalness, no lost semantic/numeric topic on deterministic repair |
| Introduction | Introduction blocks only | Supported block schema, no HTML/WP comments, non-empty; targeted retry |
| Section | One section body, no H2 | Stable accepted H2, supported block schema, H3-only subheadings, URL allowlist, non-empty; targeted retry |
| FAQ | Q&A entries only | Outline H2 immutable, exact dynamic count range, strings/non-empty, English-only, no markup/CTA/signup; one targeted retry |
| Conclusion | Conclusion blocks only | Supported schema, non-empty, no CTA/signup content; targeted retry |
| Expansion/trim/SEO/editorial | One component or selected stable blocks | Typed WordPress pairs, canonical parse/render, ordered link/number parity, protected blocks, comparative policy and snapshot rollback |
| Full-document English editor | Full document for diagnosis; selected editable block IDs for patches | Patch allowlist, per-patch validation, protected sentences/numbers/URLs, candidate policy, unresolved-finding gate and final validation |
| zh-HK translation | One complete aligned document call in the primary path | Unit coverage, number placeholders, structure/URL/name parity, deterministic assembly and quality scan |
| zh-HK editorial review | Complete aligned source/target context; field-level edits only | Editable-field allowlist, number/URL/structure parity, CTA claims, source-aware literalness, naturalness/fluency and explicit document acceptance |

## Traditional Chinese pipeline audit

The translation architecture remains the established document-context primary
path. No legacy fallback is silently invoked in primary mode.

1. Reject a stale English source before translation.
2. Parse the English source into canonical `ArticleDocument` units.
3. Build aligned source units and terminology/style context.
4. Protect numeric tokens and protected surfaces.
5. Make the single complete-document translation call.
6. Validate returned unit coverage, IDs, structures, links, names and placeholders.
7. Assemble the Chinese `ArticleDocument`; localize application-owned CTA/switcher and rebuild FAQ schema deterministically.
8. Run deterministic zh-HK terminology, calque, literalness and quality scans.
9. Make the one complete-document editorial review call when enabled; accept only field-level edits.
10. Require explicit document acceptance and zero unresolved units when the review flag is enabled.
11. Run the shared EN/ZH acceptance owner: meaning/strength, structure, numbers, URLs, terminology, FAQ/schema, CTA, naturalness and source-aware literalness.
12. Run Chinese SEO hard/soft classification.
13. Perform zero-write pre-save acceptance.
14. Create the Chinese version and update the paired English switcher.
15. Read both back, parse and rerun acceptance/SEO; compensate both writes on failure.

The shared renderer/slug fixes in this audit protect both languages. The four
known bad translations (`nice-to-have`, `walking billboard`, `out of touch`,
`keeps everyone honest`) remain covered by the existing source-aware and
zh-HK naturalness gates.

## Canonical/protected-state audit

- `ArticleDocument` remains the only mutable article source of truth.
- Production has exactly one `state.blog =` assignment, inside
  `syncBlogFromDocument()`.
- Production contains no call to `rebalanceWpBlocks()`.
- Complete HTML is rendered only from the canonical document.
- Links, CTA, FAQ/schema, switcher and WordPress markup remain application-owned.
- All HTML-returning stages parse back into `ArticleDocument`, integrity-guard,
  and restore a full direct-input snapshot on rejection.
- English save starts only after canonical agreement plus the same final policy
  gate. Translation save starts only after the shared bilingual acceptance gate.
- Both routes perform readback verification and compensation rollback.

## Logging added/retained

- Outline repair index, violation codes and before/after heading.
- Outline-quality retry reason and boundary (before section calls).
- Ignored FAQ-heading model override versus canonical heading.
- Source-relevance selected stable block IDs, URLs, fingerprints, unresolved
  count and accepted/restored result.
- Existing stage input/output fingerprints, accepted/rejected candidates,
  selected editorial units, returned patches, patch acceptance/rejection,
  applied changes, unresolved findings, final acceptance and save compensation.
- JSON parsing logs type/length/status only; model/article snippets were removed.

## Regression coverage added in this audit

- Exact production duplicated H2 is corrected before the first section prompt.
- Corrected H2 is the heading stored in the canonical document.
- Distinct numeric/alphanumeric and distinct semantic colon topics are never
  discarded by deterministic H2 repair.
- Unsafe H2 repair invokes one quality retry before any section call.
- Location-aware outline fallback does not duplicate `Hong Kong`.
- A legitimate comparison with two contextually distinct `Hong Kong` mentions
  is not misclassified as mechanical duplication.
- Natural H2 remains byte-identical; repeated year is reduced safely.
- Post-ownership SEO does not introduce a duplicated-location H2.
- Source citation removal occurs atomically before expansion and logs exact IDs/URLs.
- Embedded-prose citation is not partially removed; snapshot is restored and the
  generation fails closed.
- External-link injection refuses a body-matching source whose evidence is not
  relevant to the owning H2 under the same rule used by final QC.
- External-link insertion diagnostics count the returned candidate, not the
  pre-insertion input.
- FAQ model cannot override the accepted H2.
- Invalid FAQ shape/count receives one targeted retry; a second invalid result
  fails before assembly.
- CTA/signup wording in either an FAQ question or answer triggers that same
  targeted repair boundary.
- Outline metadata/slug markup is normalized before prompts/protected markup.
- A valid-JSON non-object outline is rejected before component calls without
  logging its model-produced content.
- H2 markup is escaped and entity decoding makes render→parse→render byte-stable.
- Language-switcher hrefs derive only from a safe canonical slug pair.

## Verification performed

- English blog/pipeline/generation/route selection: **1,044/1,044 passed**.
- Offline/mocked translation/acceptance/route selection: **495/495 passed**.
- Total explicitly rerun safe tests: **1,539 passed, 0 failed**.
- `npx tsc --noEmit`: **pass**.
- Production `next build` with non-secret public Supabase placeholders: **pass**;
  all routes generated.
- Fresh side-by-side lint on the exact recovered input versus this package:
  input **445 (269 errors/176 warnings)**; current **444 (268/176)**. No new
  lint finding; one pre-existing error was removed. New test files are lint-clean.

The provider-capable tests `document-context-primary.test.ts`,
`document-context-editorial-review.test.ts`,
`document-context-translation-shadow.test.ts` and
`document-context-shadow-preview.test.ts` were deliberately not run because
they can submit fixture/article content to a live DeepSeek configuration. That
safety boundary was not bypassed. No live production generation or claim of
three consecutive production translations is made by this audit.

## Operational verification still required

Code-level and offline verification cannot prove a non-deterministic provider
run. After deployment, run one controlled English generation using the exact
previously failing topic and then three consecutive Traditional Chinese
translations. Retain stage/review/acceptance logs. Any failure must remain a
zero-write failure; do not weaken final thresholds to force a save.
