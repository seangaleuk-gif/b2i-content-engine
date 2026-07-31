# B2I Content Engine — Complete Coder Handoff


---

# FILE: 00_READ_FIRST.md

# B2I Content Engine — Read First

**Authoritative handoff date:** 31 July 2026, 16:55 Singapore/Hong Kong time

This folder is the current handoff for the next coding-assistant chat. Read every file before proposing or making changes.

## Authority and stale documentation warning

This handoff supersedes old status statements in existing project Markdown files where they conflict with this pack. In particular, old claims such as “842 tests passing,” “1,189 tests passing,” or “Nuclear Fix v2 is the current working baseline” are stale and must not be treated as the present status.

The current project compiles and starts, and DeepSeek request latency has been repaired. However, **English generation still fails final validation**, so there is no currently confirmed production-ready generation baseline.

## Current immediate task

Fix only the latest final-validation consistency defects:

1. FAQ visible-body/schema parity after factual and editorial mutations.
2. Malformed paragraph repair persistence by stable block ID.
3. Re-run the existing editorial scorer after those defects are fixed.
4. Keep the editorial minimum at 80.

Do not change DeepSeek thinking-mode handling, model name, generation prompts, SEO thresholds, factual rules, translation architecture, database code, concurrency, or token budgets while fixing this task.

## Read order

1. `01_PROJECT_STATUS.md`
2. `02_ARCHITECTURE_NON_NEGOTIABLES.md`
3. `03_DEEPSEEK_REQUEST_POLICY.md`
4. `04_ENGLISH_GENERATION_PIPELINE.md`
5. `05_TRANSLATION_PIPELINE.md`
6. `06_CURRENT_BLOCKERS_AND_NEXT_FIX.md`
7. `07_TEST_BUILD_LINT_STATUS.md`
8. `08_CHANGELOG_LATEST.md`
9. `09_CODER_WORKING_RULES.md`
10. `NEW_CHAT_START_PROMPT.md`

---

# FILE: 01_PROJECT_STATUS.md

# B2I Content Engine — Current Project Status

**Date:** 31 July 2026

## Product

B2I Content Engine is a private content-generation application for B2I Hub, a Hong Kong platform connecting local SMEs and creators directly. The engine generates SEO-focused English WordPress articles and Traditional Chinese translations.

## Current stack

- Next.js 16.2.10
- TypeScript
- Supabase
- DeepSeek API
- Current generation model: `deepseek-v4-flash`
- Canonical article representation: `ArticleDocument`
- WordPress block output

## Current verified state

### Build and runtime

- `npm run build`: passes.
- `next start`: starts successfully.
- Application routes compile and production startup succeeds.

### DeepSeek request layer

The excessive reasoning-token problem has been repaired:

- Every request now explicitly sends `thinking: { type: "enabled" | "disabled" }`.
- Routine generation, repair, metadata, and translation stages use thinking disabled.
- Reserved high-level factual/evidence/quality diagnosis stages use thinking enabled.
- No request relies on DeepSeek's provider default.
- Routine production calls now show `reasoning_tokens=0` and generally complete on attempt one.
- Any `finish_reason: "length"` response is treated as truncated and unusable, even when it contains partial content.
- Partial JSON is never returned to the parser.
- Token escalation remains an emergency fallback.

### Latest real English generation

The latest run completed all DeepSeek generation and post-processing stages quickly, but final validation rejected the article:

```text
Final validation failed: FAQ parity mismatch; malformed prose issues=1; editorial score=36 (minimum: 80); [SOFT] no H2 keyphrase
```

Therefore:

- English generation is **not yet passing end to end**.
- Translation must not be acceptance-tested until English generation passes and the article is inspected.
- The soft missing-H2-keyphrase warning was not the cause of failure.

## Current blockers

1. FAQ parity mismatch between the canonical FAQ, rendered FAQ body, and FAQ schema.
2. A malformed paragraph survives successful repair calls and reaches final validation.
3. Editorial candidates are rejected, leaving the original article at score 36.

## Important baseline correction

`B2I-Content-Engine-Nuclear-Fix-v2-Malformed-Prose-Repair.zip` produced a decent article previously, but it is not a currently verified working baseline in the present environment. Do not restore it blindly or describe it as production ready.

## Current acceptance sequence

1. Fix FAQ parity and malformed repair persistence only.
2. Run targeted tests, full suite, TypeScript validation, and production build.
3. Generate one English article.
4. Inspect article quality and final audit.
5. Only after English passes, test Traditional Chinese translation.

---

# FILE: 02_ARCHITECTURE_NON_NEGOTIABLES.md

# Architecture and Non-Negotiable Rules

## Canonical article state

`ArticleDocument` in `src/lib/blog/article-document.ts` is the single canonical mutable article representation.

- `introduction.blocks`, `sections[].blocks`, and `conclusion.blocks` contain canonical editorial blocks.
- `articleDoc.visibleFaq` is the canonical structured FAQ after all mutations.
- `state.blog` is a rendered cache only.
- Rendered HTML must never become an independent competing source of truth.
- Direct `state.blog = ...` mutation outside the centralized renderer is forbidden.

## Protected application-owned content

The AI does not own these components:

- Language switcher
- CTA/signup block
- Visible FAQ structure
- FAQPage JSON-LD schema

The visible FAQ and schema must always be generated from the same current canonical FAQ entries. A stale protected FAQ snapshot must never overwrite a later factual or editorial mutation.

## Pipeline ownership

All post-assembly processing belongs to `src/lib/pipeline/blog-generation-pipeline.ts`.

Each mutating stage must:

1. Receive the current canonical state.
2. Capture an integrity baseline or snapshot.
3. Apply its mutation.
4. Parse/validate the mutated result when using a legacy HTML bridge.
5. Commit only a valid candidate.
6. Restore the direct-input snapshot when rejected.
7. Synchronize rendered HTML from the canonical document.

Do not add parallel pipelines, hidden compatibility paths, duplicated validators, or separate fallback ownership.

## Legacy HTML bridge

Some stages still use controlled HTML processing. They must follow:

```text
render canonical blocks → process HTML → parse back → validate → commit or restore
```

No stage may mutate an HTML string and silently leave `ArticleDocument` stale.

## Stable block identity

Repairs must target stable block IDs, not array positions, labels such as “editable text 4,” or fuzzy paragraph matching.

For every repair:

- Locate the block in the current canonical document by stable ID.
- Replace the canonical block content.
- Re-run validation on that exact block immediately.
- Confirm later stages do not restore the previous content.

## Validation ownership

Final pass/fail ownership remains:

```text
analyzeFinalArticle() → evaluatePolicy() → runFinalValidation()
```

No module may create a second independent final gate.

### Hard failures

Examples include:

- Broken WordPress block structure
- Nested paragraphs
- Malformed headings or prose
- Severe keyphrase stuffing
- FAQ count or FAQ schema parity mismatch
- CTA/signup mismatch
- Internal-link maximum breach
- Editorial score below the configured minimum

### Soft warnings

Examples include:

- Exact keyphrase missing from an H2
- Low keyphrase density
- Keyphrase missing from first 100 words
- Slight word-count deviation when policy marks it soft

Do not promote a soft warning into the root cause of an unrelated hard failure.

## AI provider ownership

All provider access goes through `AiService` in `src/lib/services/deepseek.ts`.

No other module may:

- Instantiate a DeepSeek client
- Implement separate retry logic
- Implement separate timeout handling
- Omit explicit thinking mode
- Parse reasoning content as final content

## Authentication and errors

Retain the existing single-owner architecture:

- `auth.ts`: user identity
- `project-authorization.ts`: project access
- `errors.ts`: `AppError` and response conversion

Do not expose internal provider errors, stack traces, filesystem paths, or database details in public responses.

## No architectural reinterpretation

Implement requested fixes exactly. Do not replace the architecture with a supposedly simpler design. Do not introduce wrappers that leave old logic active beside new logic.

---

# FILE: 03_DEEPSEEK_REQUEST_POLICY.md

# DeepSeek Request Policy

## Confirmed API syntax

Thinking mode is controlled with a top-level structured object:

```ts
thinking: { type: "disabled" }
```

or:

```ts
thinking: { type: "enabled" }
```

`thinking: false` is invalid and returns HTTP 400 because DeepSeek expects a `ThinkingOptions` structure.

## Current implementation

### Files changed

- `src/lib/services/deepseek.ts`
- `src/lib/services/blog-generation-service.ts`
- `src/lib/services/translation-ai.ts`
- `src/lib/services/deepseek.test.ts`

### Explicit mode guarantee

Every DeepSeek request body must contain `thinking: { type }`. No call may rely on the provider default.

Unmapped stages currently log a warning and default to disabled. New call sites must be deliberately mapped rather than silently left ambiguous.

## Thinking disabled stages

Routine deterministic work uses thinking disabled:

- `outline`
- `outline_retry`
- `intro`
- `intro_retry`
- `intro_repair`
- `faq`
- `section_N`
- `section_N_repair`
- `conclusion`
- conclusion retry and repair
- editorial malformed repair
- editorial post-cleanup repair
- editorial repetition repair
- editorial prose-only fallback
- editorial polish
- claim rewriting / `claim_fix`
- generic pipeline fixers
- section expansion and trimming
- SEO-normalizer AI helpers
- text translation
- HTML translation
- section-heading translation
- FAQ translation
- CTA translation
- conclusion shadow translation and repair
- strict translation repair
- editorial translation repair
- final metadata generation

## Thinking enabled stages

Reserved high-level reasoning stages:

- `factual-risk`
- `evidence-reconciliation`
- `quality-diagnosis`

Do not enable thinking for routine generation merely because the output is important. Use it only where deeper reasoning is deliberately required and tested.

## Token budgets

Current stage budgets:

| Stage | Initial max tokens |
|---|---:|
| Outline | 4,096 |
| Introduction | 6,144 |
| Intro retry/repair | 8,192 |
| Article section | 8,192 |
| Section repair | 8,192 |
| FAQ | 6,144 |
| Conclusion | 6,144 |
| Conclusion retry/repair | 8,192 |
| Editorial/large repair calls | commonly 16,384 |

Global safety cap:

```text
32,768
```

Exhaustion escalation:

- Retry 1: original × 1.5
- Retry 2: original × 2
- Always cap at 32,768

Do not raise all budgets or set an effectively unlimited ceiling without real production measurements.

## Response handling

### Valid completion

Only accept a response as complete when:

- `finish_reason === "stop"`
- `message.content` is non-empty
- the expected parser/validator accepts it

### Truncated response

Every `finish_reason === "length"` response is unusable, including partial non-empty content.

Required behavior:

1. Classify as truncated or token exhaustion.
2. Never pass partial JSON to a parser.
3. Never accept partial prose as a successful result.
4. Retry through the shared controlled escalation path.

### Reasoning content

`reasoning_content` is diagnostic/provider output only.

- Never parse it as the answer.
- Never place it into article content.
- Never expose it in logs.

## Sanitized logging

Log only:

- stage
- request ID
- model
- thinking mode
- attempt
- max tokens
- timeout
- approximate input tokens
- finish reason
- completion tokens
- reasoning tokens
- content length
- reasoning-content length

Never log API keys, prompts, article content, translations, or full model responses.

## Verified production effect

After explicit thinking was disabled, the latest generation showed:

- `reasoning_tokens=0`
- `reasoning_chars=n/a`
- routine stages succeeding on attempt one
- no reasoning-token-exhaustion loop
- normal generation speed restored

Do not modify this subsystem while fixing the current FAQ/malformed-prose finalization defect.

---

# FILE: 04_ENGLISH_GENERATION_PIPELINE.md

# English Generation Pipeline and Quality Rules

## Observed high-level flow

```text
request validation
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
→ editorial repair/polish with guarded acceptance
→ internal/external links
→ language switcher and CTA preservation
→ final trim
→ FAQ recovery/schema generation
→ final validation
→ persistence/readback
```

The exact implementation remains authoritative. Do not reorder stages unless the requested fix proves ordering is the root cause.

## English output requirements

- WordPress block format only in final article output
- No Markdown in the generated article
- Friendly, practical, professional tone
- Hong Kong context
- B2I Hub voice: warm, honest, mission-driven, creator/SME focused
- H2/H3 structure only
- Visible FAQ plus matching FAQPage JSON-LD
- Deterministic CTA and language switcher
- Internal B2I Hub links and supported external evidence links

## SEO targets

Product targets for a typical approximately 2,500-word article:

- SEO title: 50–70 characters
- Meta description: 155–200 characters
- Approximately 6–7 H2 headings
- Approximately 4–6 FAQ entries, usually 5
- Flesch target around 60–70
- Paragraphs generally no more than 3 sentences
- Exact focus keyphrase in the first 100 words where possible
- Exact focus keyphrase in at least one H2 is desired
- Keyphrase density policy remains the centralized source of truth
- Severe stuffing above the configured maximum remains a hard failure

The latest run had the exact keyphrase missing from an H2, but policy reported it as `[SOFT]`; it did not block the article.

## Factual rules

- Every precise numeric, percentage, date, platform metric, feature-status, or comparative claim must have compatible evidence.
- Unsupported sentences are removed or locally regenerated.
- Evidence scope, subject, geography, and metric must match the claim.
- Claim ownership assigns each approved claim to one intended section.
- Duplicate use outside the owner section is removed.
- The conclusion must not introduce unsupported new numbers or factual claims.
- Example questions and quoted post prompts must not be misclassified as testimonial or evidence claims.

## Editorial rules

- Editorial minimum remains **80**.
- Do not lower the threshold to force an article through.
- Editorial candidates are atomic: accept only when protected facts, structure, FAQ, CTA, links, word count, and quality all remain valid.
- Full-article fallback must not replace a stronger article with a weaker one.
- Repair only the responsible paragraph or repetition pair when possible.
- Stable block IDs must survive repair and later stages.

## Current latest-run metrics

Before final rejection:

- Canonical word count: 2,807
- Allowed range shown by the pipeline: 2,125–2,875
- Final hard failures: FAQ parity mismatch, malformed prose issue, editorial score 36
- Soft warning: no H2 keyphrase

## Current generation acceptance test

A run is accepted only when:

1. DeepSeek stages complete without exhaustion loops.
2. Final validation passes.
3. Editorial score is at least 80.
4. FAQ body and schema match exactly under canonical normalization.
5. No malformed paragraphs survive.
6. WordPress blocks are balanced.
7. CTA and language switcher are intact.
8. Word count, link policy, factual checks, and SEO policy pass.
9. The saved article is read back successfully.
10. The actual article is manually inspected before translation.

---

# FILE: 05_TRANSLATION_PIPELINE.md

# Traditional Chinese Translation Pipeline

## Current status

Translation code and stage-aware DeepSeek thinking configuration are present, but the current branch has **not yet passed a fresh end-to-end Traditional Chinese acceptance test** after the latest English-generation changes.

Do not describe translation as production ready until:

1. English generation passes final validation.
2. The English article is manually inspected.
3. One full Traditional Chinese translation passes validation, persistence, and audit.

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

`translation-ai.ts` now forwards the component/stage name to `AiService` so the correct thinking policy is applied.

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

## Previously implemented or reported safeguards

The current project has previously included work for:

- deterministic number protection and restoration
- strict rejection when number placeholders are missing or duplicated
- English-leakage detection and targeted retry
- FAQ boundary validation
- metadata retries and deterministic fallback
- CTA CJK validation
- source-English version pairing
- Chinese-specific SEO audit
- structured translation DTO and block reconstruction
- conclusion structured shadow evaluation
- atomic or compensated persistence safeguards
- snake_case database row normalization to application camelCase

These safeguards must be inspected in the current code before being claimed as verified. Do not rely only on old Markdown status claims.

## Historical translation defects that must be rechecked

- `enFaqCount=0`
- empty DeepSeek metadata responses aborting translation
- Chinese title/meta range failures
- English fallback content surviving
- FAQ/body/schema mismatch
- lost numbers or links
- incomplete CTA/schema
- incorrect repository field normalization

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

---

# FILE: 06_CURRENT_BLOCKERS_AND_NEXT_FIX.md

# Current Blockers and Exact Next Fix

## Latest final failure

```text
Final validation failed: FAQ parity mismatch; malformed prose issues=1; editorial score=36 (minimum: 80); [SOFT] no H2 keyphrase
```

## Evidence from the latest run

### FAQ sequence

- The factual FAQ scanner removed one precise factual sentence.
- Later, `faq-recovery` logged that it regenerated schema from five protected FAQ entries.
- Final validation then reported FAQ parity mismatch.

### Editorial/malformed sequence

The editorial validator reported these stable block IDs during candidate rejection:

- `section:section-2:section-2-wp-5` — incomplete sentence ending
- `section:section-5:section-5-wp-4` — broken quoted fragment

AI repair calls completed successfully, but final validation still found one malformed-prose issue.

### Editorial score

- Original/editorial baseline observed around 33.
- Final accepted fallback scored 36.
- Minimum is 80.
- Several candidates were rejected for malformed prose, FAQ parity, no score improvement, word-count excess, long paragraphs, and repetition regression.

## Working hypotheses — not yet proven

1. FAQ schema recovery may be using a stale protected FAQ snapshot after the factual scanner changed the visible FAQ answer.
2. Malformed repair may be applied to a temporary candidate, stale document snapshot, wrong block reference, or overwritten by a later fallback/restore.

The coder must prove the root causes with state tracing before claiming them.

## Exact required fix

### A. Canonical FAQ consistency

Trace FAQ state through:

1. initial FAQ generation
2. canonical `visibleFaq` population
3. factual FAQ scan
4. claim ownership
5. editorial mutation
6. FAQ recovery
7. FAQ schema generation
8. final rendering
9. final validation

Requirements:

- Establish one canonical FAQ source after all mutations.
- Update canonical FAQ answers immediately when factual text is removed.
- Render the visible FAQ body from the current canonical entries.
- Generate FAQPage schema from those same current entries.
- Never regenerate schema from a stale protected snapshot.
- Preserve five entries unless an entire entry is invalid.
- Log counts and mismatch index without logging the full article.

Required diagnostics:

```text
canonical FAQ count
rendered FAQ count
schema FAQ count
normalized mismatch index
```

### B. Malformed repair persistence

For each reported block ID:

- Locate it in the current canonical `ArticleDocument`.
- Log stable ID and validation status before repair.
- Apply repaired content directly to the canonical block.
- Revalidate that exact block immediately.
- Track its fingerprint through later stages.
- Prove no later restore or fallback brings the old text back.

If AI repair fails, regenerate only the individual paragraph using local section context. Do not rewrite the entire article.

### C. Final preflight

Immediately before final validation:

- Re-run malformed validation.
- Rebuild visible FAQ and schema from the canonical FAQ.
- Confirm FAQ parity.
- Run the existing editorial scorer.

Final validation must not discover a malformed issue that a prior stage claimed to repair.

### D. Editorial score

Do not lower the minimum of 80.

After FAQ and malformed consistency are fixed:

- Run the existing scorer.
- Report exact deductions.
- Repair only responsible paragraphs or repetition pairs.
- Do not globally rewrite the article unless a guarded candidate demonstrably improves it without regressions.

## Required regression tests

- Factual removal from one FAQ answer, followed by matching body/schema regeneration
- Five-entry canonical/rendered/schema FAQ parity
- Stable-block malformed repair persists through later stages
- A rejected later candidate cannot restore the malformed original
- Final preflight catches mismatch before final validation
- Editorial minimum remains 80

## Prohibited changes for this task

Do not change:

- DeepSeek thinking-mode implementation
- DeepSeek model
- token budgets
- retry multipliers
- prompts
- stage order unless root cause is proven to be ordering
- SEO thresholds
- factual thresholds
- editorial minimum
- translation architecture
- database schema or persistence
- concurrency
- lint configuration

---

# FILE: 07_TEST_BUILD_LINT_STATUS.md

# Test, TypeScript, Build, and Lint Status

## DeepSeek targeted tests

Reported after the explicit thinking/truncation implementation:

- `src/lib/services/deepseek.test.ts`: **28/28 passed**

Coverage includes:

- routine stages explicitly disable thinking
- reserved reasoning stages enable thinking
- every request contains an explicit thinking object
- `length` plus empty content retries
- `length` plus partial content retries
- partial content is never returned for parsing
- normal `stop` content is unchanged
- ordinary empty response retains retry behavior
- reasoning content is never used as final content
- escalation respects the 32,768 cap

## Full suite

Latest reported full-suite status:

- 1,399 tests discovered/reported
- 23 failing

The coder reported these 23 as pre-existing based on a stash comparison, mainly in untracked or previously modified test files such as:

- `section-expander.test.ts`
- `component-regenerator.test.ts`
- `blog-versions.test.ts`

Do not state that these are definitively unrelated without preserving or reproducing the comparison evidence. They remain unresolved technical debt.

## TypeScript

Latest reported result:

- 2 errors
- both in untracked `src/lib/services/section-expander.test.ts`
- reported as pre-existing

Production build still passes.

## Production build

- `npm run build`: passes
- Next.js/Turbopack compilation: passes
- Production startup: passes

## Lint baseline

Latest lint report:

```text
468 problems: 285 errors, 183 warnings
```

Top categories:

- 269 `@typescript-eslint/no-explicit-any` errors
- 176 `@typescript-eslint/no-unused-vars` warnings
- 7 `prefer-const` errors
- 5 `no-require-imports` errors
- React hook/compiler issues in dashboard UI
- minor accessibility/image warnings

The lint backlog does not explain the current final-validation failure.

Do not run broad lint cleanup while repairing generation. In particular:

- Do not refactor all `any` usage.
- Do not modify ESLint configuration.
- Do not suppress rules globally.
- Do not mix dashboard React cleanup with pipeline repair.

## Required verification after the current fix

1. Targeted FAQ and malformed-repair tests
2. Existing DeepSeek tests
3. Full test suite with exact pass/fail delta
4. TypeScript validation
5. Production build
6. One real English generation
7. Manual article inspection

Reports must distinguish:

- new failures
- unchanged known failures
- fixed failures
- tests not run

---

# FILE: 08_CHANGELOG_LATEST.md

# Latest Changelog — 31 July 2026

## DeepSeek empty-content diagnosis

Observed failures:

```text
DeepSeek response had no content in choices
```

Isolated diagnostics established that `deepseek-v4-flash` was using thinking mode by default. Reasoning tokens count against `max_tokens`. When reasoning consumed the full budget, responses returned HTTP 200 with:

- `finish_reason: "length"`
- empty `message.content`
- non-empty `reasoning_content`

The original wrapper reduced this to a generic empty-response error.

## Token-exhaustion observability and retry

Implemented in `deepseek.ts`:

- `token_exhaustion` error classification
- finish-reason and usage inspection
- sanitized response metrics
- retry budget escalation ×1.5 and ×2
- global cap 32,768

Stage budgets were raised to accommodate reasoning-model output.

Focused tests were added and passed.

## Runaway reasoning evidence

A production attempt showed routine calls exhausting 6K, 8K, 12K, and 16K token budgets, including a small section-trimming prompt. Some calls returned partial truncated JSON with `finish_reason=length`. This proved that indefinitely raising token ceilings was not an acceptable production strategy.

## Explicit thinking-mode control

Live probing confirmed:

```ts
thinking: { type: "disabled" }
```

disables reasoning, while:

```ts
thinking: false
```

is rejected with HTTP 400.

Implemented:

- `ThinkingMode` type
- stage-to-mode mapping
- explicit `thinking` object in every request
- routine generation/translation thinking disabled
- reserved reasoning stages thinking enabled
- unmapped stage warning with disabled fallback
- translation component name forwarded as stage

## Truncated response handling

Implemented a `truncated` response path:

- every `finish_reason === "length"` response is rejected
- partial non-empty content is never accepted
- truncated JSON never reaches parsing
- controlled escalation remains available

## Verified performance improvement

The next production generation showed:

- thinking disabled on routine stages
- zero reasoning tokens
- first-attempt completion across normal generation stages
- restored generation speed
- no reasoning-token-exhaustion loop

## Current downstream failure

The same run reached final validation and failed on:

- FAQ parity mismatch
- one malformed-prose issue
- editorial score 36, minimum 80
- soft warning: exact keyphrase missing from an H2

DeepSeek request behavior is no longer the current blocker.

## Current next repair

Fix canonical FAQ synchronization and stable-block malformed-repair persistence. Do not alter the completed DeepSeek work.

---

# FILE: 09_CODER_WORKING_RULES.md

# Coding-Assistant Working Rules

## User expectations

The user expects professional-grade diagnosis and repair, not speculative changes.

## Required behavior

- Read the handoff files before editing.
- Inspect actual code before proposing a root cause.
- Keep changes narrowly scoped to the proven issue.
- Do not reinterpret the requested architecture.
- Do not perform unrelated cleanup.
- Do not silently weaken thresholds or acceptance rules.
- Do not describe a build as production ready unless real generation and translation acceptance tests pass.
- Never claim a failure is pre-existing without comparative evidence.
- Report partial or failed work honestly.

## Code changes

- Preserve single ownership.
- Remove superseded paths rather than adding compatibility wrappers.
- Use canonical `ArticleDocument` state.
- Use stable block IDs.
- Keep AI access inside `AiService`.
- Keep final pass/fail inside the centralized validation path.
- Add behavioral regression tests for every bug fix.

## Testing reports

Every completion report must include:

1. Exact root cause proven by code/logs
2. Files changed
3. Behavioral change
4. Targeted test results
5. Full-suite results and exact delta
6. TypeScript result
7. Build result
8. Remaining known failures
9. Anything not verified

## Lint

Do not bulk-fix lint during pipeline repair. Lint cleanup is a separate maintenance task.

## Database and SQL

Do not ask the coding assistant to execute or invent database SQL unless explicitly requested. Any SQL or migration requiring manual execution must be separated and clearly labeled for the user to run manually.

## Real generation tests

The application cannot reliably substitute unit tests for a real external DeepSeek generation. After code-level verification, the user performs the real English generation. Do not claim end-to-end success before that run completes.

## Prompt/report style

- Be concise and direct.
- Do not bury the requested action under long explanations.
- Do not ask the user to upload ZIPs inside coding instructions.
- Do not refer to artificial phases/stages unless they are actual pipeline stages.
- Do not stray from the requested architecture.

---

# FILE: NEW_CHAT_START_PROMPT.md

# New Coding Chat — Start Message

You are continuing work on the B2I Content Engine. Read every Markdown file in the handoff pack before inspecting or modifying code. Treat the handoff dated 31 July 2026 as authoritative where older project documentation conflicts with it.

The DeepSeek request-layer problem is already fixed and must not be changed:

- every request explicitly sends `thinking: { type: "enabled" | "disabled" }`;
- routine generation and translation use thinking disabled;
- reserved high-level reasoning stages use thinking enabled;
- every `finish_reason: "length"` response is rejected as truncated, including partial content;
- token escalation remains a capped emergency fallback;
- the latest real run showed zero reasoning tokens and first-attempt completion.

The current failure is downstream:

```text
Final validation failed: FAQ parity mismatch; malformed prose issues=1; editorial score=36 (minimum: 80); [SOFT] no H2 keyphrase
```

Fix only the finalization consistency defects.

Required work:

1. Trace the FAQ from generation through factual scanning, claim ownership, editorial processing, recovery, schema generation, rendering, and final validation.
2. Establish one current canonical FAQ source after all mutations.
3. Generate both visible FAQ body and FAQPage schema from that same canonical source.
4. Never restore a stale protected FAQ snapshot after factual text has been removed.
5. Add concise parity diagnostics: canonical count, rendered count, schema count, and normalized mismatch index.
6. Trace these malformed block IDs through every later mutation and restore:
   - `section:section-2:section-2-wp-5`
   - `section:section-5:section-5-wp-4`
7. Apply repairs directly to the canonical `ArticleDocument` block by stable ID, revalidate immediately, and prove no later stage restores the old text.
8. If local AI repair fails, regenerate only the individual paragraph with local section context.
9. Run malformed and FAQ preflight checks immediately before final validation.
10. Keep the editorial minimum at 80. After consistency defects are fixed, report the exact scoring deductions and repair only the responsible blocks if the score remains below 80.

Do not change DeepSeek logic, model, budgets, prompts, SEO/factual thresholds, stage order without proof, translation architecture, database code, concurrency, lint configuration, or unrelated files.

Add regression tests for FAQ mutation/body/schema parity and malformed repair persistence. Run targeted tests, existing DeepSeek tests, the full suite, TypeScript validation, and production build. Report exact root causes, files changed, test/build results, remaining failures, and anything not verified. Do not claim end-to-end success until the user completes a real English generation.
