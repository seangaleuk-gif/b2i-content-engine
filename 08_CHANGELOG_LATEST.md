# Latest Changelog — 1 August 2026

## Traditional Chinese translation — live verified (newest)

- Full live translation saved: project 19, version 6, saved ID 202; 40 API calls, 0 retries, 26 deterministic editorial changes; `deepseek-v4-flash`, thinking disabled.
- Structural translation works: full article saved, no duplicated article, FAQ/schema parity preserved, CTA preserved, links and protected content preserved.
- Deterministic Cantonese editorial normalization added: source-label and paragraph punctuation, terminology/register normalization, literal-phrase repair, unsupported-claim softening, heading variants, and consistent FAQ/schema parity.
- Natural Hong Kong code-switching allowed (`followers`, `post`, `唔 work`, `KPI`, `Reel`, platform/agency/company names); genuine untranslated English sentences still fail.
- Next task: translation-pipeline architecture audit (see `NEW_CHAT_HANDOFF.md` section 2).

## English generation — final verified run (31 July 2026)

- Fresh live English generation passed final validation: editorial score 94, repeated pairs 0, malformed 0, FAQ parity 6/6/6, external links 6, internal links 4, keyphrase density 1.08%.
- Auto-research and external-link generation live verified.
- Keyphrase exclusion consistent across editorial and final validation.
- Repetition false-positive fixed (keyphrase excluded from overlap); malformed last-resort resolution; editorial candidate word-count trimming.

## Verified baseline

- Full suite: 18 pre-existing failures, 1,473 passing (1491 total), zero new regressions.
- Lint: 468 (285 errors / 183 warnings). Build passes. 2 pre-existing TypeScript errors in `section-expander.test.ts`.

---

## Earlier changelog (31 July 2026)

## DeepSeek request layer (protected, earlier in the day)

- Explicit thinking-mode control: every request sends `thinking: { type: "enabled" | "disabled" }`; `thinking: false` is HTTP 400.
- Routine stages (generation, repair, metadata, translation) use thinking disabled; reserved reasoning stages (`factual-risk`, `evidence-reconciliation`, `quality-diagnosis`) use thinking enabled.
- Every `finish_reason === "length"` response rejected as truncated, including partial content; partial JSON never reaches parsers.
- Token escalation: ×1.5 / ×2, global cap 32,768.
- Verified effect: `reasoning_tokens=0`, first-attempt completion, no exhaustion loops.

## FAQ parity and malformed persistence (fixed, production verified)

- FAQ visible-body/schema parity: HTML round-trips no longer double-encode FAQ `answerText`/`question`; schema and visible body stay in parity; `final-preflight` verifies canonical/rendered/schema counts immediately before final validation.
- Malformed repair persistence: successful targeted repairs (malformed, weakened, repetition) are committed to canonical state even when the score-gated general polish is rejected (`targeted repairs persisted`), so a later restore can never resurrect a repaired fragment.

## Editorial repetition repair (fixed, production verified)

- Root cause: the repetition pass was blind (no partner context) and its selection ranked by word count, which picked the longer later paragraph as "strongest".
- Fix: order-based targeting preserves the earlier paragraph and rewrites only the later duplicate; the prompt supplies the preserved partner text and duplicated idea; per-target overlap must drop below 0.55 or the candidate is rejected; after two failed AI attempts a bounded deterministic fallback removes echoed sentences (keeping numbers, links, quotes, protected sentences, exact keyphrase) or removes the block only when nothing protected is lost.
- Live result: `[editorial-repetition-repair] accepted score=30 → 94`, final editorial score 94, repeatedPairs 0.

## Robotic detector fix

- `remember` is only counted as a robotic phrase in imperative form (sentence-start), eliminating false positives such as "people will remember your brand".

## Research and external links (implemented and test verified; live verification pending)

- Automatic research dispatch in `runBlogGeneration`: runs `runBraveResearchWithRetry` when no approved `research_sources` rows exist; manual rows suppress auto; provider failure/empty degrades with a clear warning; no fabricated sources.
- External links: injected from eligible approved sources; `[external-links:candidates]` / `[external-links:inject]` / `[external-links:final]` diagnostics; explicit warning when zero eligible sources; prose-overlap relevance fallback (≥6 shared tokens) so non-numeric sources can be linked; canonical `extractEditorialExternalLinkUrls`; `generated.externalLinks` metadata now reflects the real final article.
- Status: covered by service and e2e tests; a live normal generation without manual research is the remaining verification.

## Translation (implemented and test verified; live verification pending)

- Editorial-block translation suite: 93/93 passing, including source-echo rejection for unchanged English candidates ("Hello World with 25% growth" etc.), CJK-aware completeness metric, structured fallback, and fail-closed parse handling.
- Live Traditional Chinese translation still awaiting verification against the verified English baseline.

## Verified baseline

- Fresh live English generation passed: editorial score 94, repeatedPairs 0, malformed 0, FAQ parity valid, final validation PASS.
- Full suite: 18 pre-existing failures, 1442 passed (1460 total), zero new regressions.
- Lint: 468 (285 errors / 183 warnings). Build passes. 2 pre-existing TypeScript errors in `section-expander.test.ts`.
