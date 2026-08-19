# B2I Content Engine — Updated Chat Handoff
**Date:** 16 August 2026  
**Project:** B2I Content Engine  
**Branch:** `deepseek-harness-audit`  
**Production build:** `b2i-english-2026-08-20-2`

## Purpose of this update

This file contains the important changes **since** `B2I-Content-Engine-Chat-Handoff-2026-08-15.md`.

The previous handoff remains the baseline for the broader architecture, v19 success, persistence/RPC repairs, grounding, ownership, keyphrase-density work, and the integrity-contract architecture.

This update covers:
- sentence-quality false-positive hardening
- quarantined pipeline-failure snapshots
- external-link terminal punctuation repair
- absolute unsupported-claim enforcement
- latest live production status
- current blocking bug: temporal-freshness scope/repair

---

# Current production status

The latest **confirmed saved English version is still v19** for project 13.

Several later live runs progressed far through the pipeline but correctly failed closed before persistence. Therefore:

- **v19 remains the latest confirmed saved English version**
- do **not** call the failed runs v20
- the next successful persisted English generation should become v20, assuming no other successful save occurs first

The most recent live run reached:

**generation → SEO normalization → factual cleanup → claim ownership → temporal freshness**

and stopped at `temporal-freshness` because one stale relative-time sentence remained in the introduction.

The latest failure is **not** a persistence problem.

---

# 1. Shared sentence-quality false-positive repair

The previous handoff ended with a known false-positive issue where valid sentences were being classified as incomplete/dangling, including:

- `That is the balance worth aiming for.`
- `Let’s dive in.`

## Proven causes

Two separate rule defects were found.

### Curly apostrophe handling

`Let’s dive in.` used a curly apostrophe (`’`), while the structural exception only handled ASCII `'`.

Fix:

```ts
text.replace(/[’‘]/g, "'")
```

was added at the authoritative detector boundary so equivalent apostrophe forms are normalized before sentence-ending analysis.

### Overbroad malformed noun-phrase rule

`MALFORMED_NOUN_PHRASE_RE` treated words including:

- `more`
- `most`
- `such`

as malformed determiner triggers.

That incorrectly flagged grammatical phrases such as:

- `what matters most this year`
- `more these days`
- `such a challenge`

The invalid triggers were removed while retaining structurally useful malformed-pattern terms such as broader/wider/larger/bigger/smaller/higher/lower/greater/lesser/other/same/whole/entire.

## Enforcement parity hardening

The audit also exposed that final-QC had stronger absolute sentence-quality coverage than earlier boundaries.

After the fix:

- malformed-prose repair now applies an **absolute sentence-quality hard gate**
- final-preflight now applies the **same absolute sentence-quality scanner**
- integrity-contract delta semantics remain intact for stage ownership
- debug trace now emits `present` violations at the earliest observed stage, not only introduced/resolved deltas
- final-QC remains the final absolute gate

## Verification

At completion of this repair:

- **2,522 passed / 0 failed (104 files)**
- `tsc --noEmit`: clean
- build: successful
- changed-test lint: clean

An earlier focused checkpoint commit was created:

`8fed859 Harden incomplete sentence ending detection`

Whether all later sentence-quality changes were committed in the same or a subsequent commit should be confirmed with Git before assuming repository history.

---

# 2. Quarantined pipeline-failure snapshot system

A diagnostic-only failure quarantine system was added so rejected ArticleDocument candidates are preserved for debugging **before rollback destroys them**.

Main file:

`src/lib/pipeline/pipeline-failure-snapshot.ts`

Default output directory:

`debug/pipeline-failures/`

Example artifact:

`debug/pipeline-failures/2026-08-15T15-23-42-438Z_external-links_project-13.json`

The directory is ignored by Git.

## Artifact purpose

When a mutating stage fails the integrity contract:

1. tracer records the rejection
2. rejected candidate is captured while still present in `state.articleDoc`
3. diagnostic JSON is written
4. rollback restores the pre-stage snapshot
5. artifact is best-effort updated with rollback result
6. the original integrity error is thrown

The rejected article is **never** written to Supabase, `blog_versions`, project content, or any normal persistence path.

## Artifact schema

Schema:

`pipeline-failure-snapshot/v1`

Contains:

- timestamp
- production build identifier
- project ID
- stage name
- contract violations
- owned violations
- rollback action/result
- pre/post fingerprints
- word counts
- keyphrase occurrences/density
- changed blocks
- before/after changed content
- `firstIntroduced` attribution
- tracer deltas for sentence-quality, malformed, coherence, factual, ownership, SEO, links and protected content
- complete pre-stage ArticleDocument
- complete rejected candidate ArticleDocument

## Rollback status hardening

Artifacts are initially captured with:

```json
"rollback": { "action": "restore-snapshot", "result": "pending" }
```

Then `updateIntegrityRejectionRollback(...)` best-effort patches the artifact to:

- `success`
- or `failed`

A diagnostic update failure can never mask the original integrity error.

## Build identifier hardening

The snapshot now reuses the same production constant as generation logs:

`GENERATION_BUILD_ID`

Current value:

`b2i-english-2026-08-20-2`

No duplicate package-version build string is maintained.

## Retention

Only the newest **30** failure artifacts are retained.

Retention deletion failures are warnings only.

## Verification

Final quarantine-system verification:

- **2,532 passed / 0 failed (105 files)**
- targeted snapshot tests: 10/10
- TypeScript: clean
- production build: successful
- debug-enabled vs disabled successful output remains byte-identical

---

# 3. External-link terminal punctuation bug — FIXED

The new quarantine system immediately exposed the exact rejected canonical block from a real production failure.

Rejected block:

```json
[
  {"type":"text","text":"Source: "},
  {"type":"link","text":"How is AR changing digital marketing in Hong Kong?","href":"https://stateglobe.com/..."},
  {"type":"text","text":"."}
]
```

Readable output became effectively:

`Source: How is AR changing digital marketing in Hong Kong? .`

The sentence-quality gates correctly rejected this as:

- `punctuation-fragment`
- `sentence-quality:fragment`

## Proven root cause

Both external-link producers appended a period unconditionally:

- canonical `insertExternalResearchLinksIntoDocument`
- legacy/rendered `insertExternalResearchLinks`

A source title already ending in `?`, `!`, or `.` therefore became:

- `? .`
- `! .`
- `. .`

## Fix

One shared helper now determines whether punctuation is needed:

```ts
export function citationTerminalPunctuation(title: string): string {
  const content = String(title ?? "").trimEnd();
  const withoutClosers = content.replace(/["'“”‘’)\]}>]+$/, "");
  if (/[.!?]$/.test(withoutClosers.trimEnd())) return "";
  return ".";
}
```

It also looks past closing quotes/parentheses/brackets.

Both canonical and HTML-level producers use the same helper.

No cleanup-after-insertion patch was added and sentence-quality validation was not weakened.

## Production regression fixture

Added:

`fixtures/external-links-ar-question.json`

based on the real quarantined AR section and real StateGlobe question-title source.

## Verification

At completion:

- targeted external-link tests: **22/22**
- full suite: **2,544 passed / 0 failed (105 files)**
- TypeScript: clean
- changed-file lint: clean
- build: successful
- real quarantined production probe: `MALFORMED: []`, `SQ: []`

## Live proof

A subsequent real generation confirmed the fix.

External links:

- requested = 6
- inserted = 6
- skipped = 0

The real question-title citation appeared correctly as:

`Source: How is AR changing digital marketing in Hong Kong?`

No external-link sentence-quality rejection occurred.

---

# 4. Unsupported-claim enforcement gap — FIXED

After external links were repaired, a later real run made it almost to final QC but failed on:

`The old playbook of interrupt, repeat, and hope doesn’t work here anymore`

The factual scanner had already identified that claim as unsupported earlier, yet it survived to final QC.

## Proven root cause

This was **not stale rendered state**.

It was a skipped safe-removal case.

The unsupported sentence carried a protected inline link, for example:

`as our <a href="/blog/guide">marketing guide</a> shows`

`removeUnsupportedSentences` correctly refused to delete through the protected inline link range.

However:

- another unsupported claim elsewhere was successfully removed
- aggregate `sentencesRemoved` increased
- the link-protected unsupported claim remained
- old factual cleanup only logged a warning
- factual integrity ownership was delta-based, so the pre-existing unsupported claim did not count as a newly introduced violation
- final-preflight did not perform an absolute factual scan
- final-QC was the only absolute unsupported-claim gate

Therefore the pipeline incorrectly continued until final QC.

## Fix

Added authoritative canonical scanner:

`scanUnsupportedClaimsInDocument(doc, keyphrase, research)`

in:

`src/lib/blog/factual-risk-scanner.ts`

It:

- renders from canonical ArticleDocument
- uses the existing factual scanner
- returns unsupported claims with `componentId` / `blockId`
- avoids stale `state.blog` as the source of truth

## Factual boundary changes

### factual-scan

After cleanup, an **absolute canonical unsupported-claim verification** runs.

If any unsupported claim remains:

- stage fails closed
- snapshot is restored
- exact component/block/category/claim is reported

Logging now distinguishes:

- `REMOVED unsupported [...]`
- `SKIPPED unsupported [...] reason="..."`

A skipped unsupported claim is never treated as successful cleanup.

### factual-final

Now uses the same authoritative absolute scanner and fails closed.

### final-preflight

Now includes the same absolute unsupported-claim gate.

### final-QC

Now also scans the canonical ArticleDocument via the same scanner instead of using potentially stale rendered `state.blog` content.

## Verification

At completion:

- **2,551 passed / 0 failed (106 files)**
- 7 new unsupported-claim boundary regressions
- TypeScript: clean
- changed-file lint: clean apart from unchanged pipeline baseline
- build: successful

## Live proof from latest run

The latest production run demonstrates this repair working correctly.

Two unsupported claims were detected and removed:

- `does more than grab attention; it builds a two-way relationship`
- `no longer works`

The logs reported each as `REMOVED`, and the debug trace explicitly marked both unsupported factual violations as `resolved`.

The pipeline then continued past factual-scan and claim-ownership successfully.

So the previous factual enforcement gap is now proven fixed in a real generation.

---

# 5. Latest live production run — current blocking failure

Latest log:

`Pasted text(20260816-004927).txt`

Build:

`b2i-english-2026-08-20-2`

Project:

`13`

Research:

- manual research
- 13 sources
- research handoff successful

DeepSeek:

- thinking disabled
- max observed concurrency = 2
- one `section_2` request was `terminated` on attempt 1 and succeeded on retry
- FAQ had one network failure and succeeded on retry

These recovered model/network retries were **not** the cause of the generation failure.

## Assembly

Initial canonical assembly:

- 3,328 words
- keyphrase occurrences: 16
- density: 2.40%

## Sentence-quality observation

An existing repeated-adjacent-word violation was observed in section 4 and moved during paragraph restructuring.

The tracer correctly attributed:

`firstIntroduced=paragraphs section-4/section-4-wp-10 repeated-adjacent-word`

This was not yet the blocking failure because the pipeline stopped earlier at temporal freshness.

It remains something later sentence-quality repair should handle if the run proceeds beyond the current blocker.

## SEO normalization

SEO normalization reduced:

- words: 3,328 → 3,180
- keyphrase occurrences: 16 → 8
- density: 2.40% → 1.26%

Candidate accepted.

## Factual cleanup

Two unsupported claims were correctly removed.

Post factual-scan:

- words: 3,142
- keyphrase occurrences: 8
- density: 1.27%
- factual contract: valid

Claim ownership then passed with no removals.

## Current failure: temporal freshness

The temporal-freshness stage attempted a repair and changed section 5, but then failed and rolled back.

Trace:

```text
stage=temporal-freshness ... accepted=false rollback=true
```

Blocking sentence in the **introduction**:

`Either way, they will influence how you plan your content, your campaigns, and your customer relationships in the coming months.`

Error:

```text
Temporal freshness repair was rejected without changing the working article:
stale temporal claims=1;
unresolved intro: Either way, they will influence how you plan your content, your campaigns, and your customer relationships in the coming months.
```

This suggests temporal repair is not covering the introduction with the same scope/path as normal sections, or introduction repair is being restored/omitted.

The detector itself should **not** be weakened. `in the coming months` is valid prose at publication time but ages poorly in an evergreen article.

---

# Current next repair

## Recommended thinking level: Low

This failure is currently narrow enough for Low because the exact unresolved phrase and component are known.

The next coder should prove why temporal freshness repair handles section content but leaves the introduction unresolved.

Likely investigation points:

- introduction omitted from repair candidate loop
- introduction handled by a separate path
- introduction candidate repaired but stale state restored
- scanner and repair scopes differ

## Required architecture

Temporal freshness should use canonical ArticleDocument and cover, where applicable:

- introduction
- all sections
- conclusion
- FAQ

Do not:

- whitelist `in the coming months`
- weaken stale-time detection
- patch final output after the temporal stage
- change model/settings/SEO behaviour

If temporal wording cannot be repaired safely, fail closed with exact component/block attribution.

Debug trace should show the violation as:

- `resolved` when genuinely repaired
- or `present` / blocking when unresolved

## Ready-to-copy coder prompt

```text
Audit and fix the latest temporal-freshness rejection.

Production evidence:

The temporal-freshness stage changed `section-5`, but then rejected and rolled back because this remained in the introduction:

`Either way, they will influence how you plan your content, your campaigns, and your customer relationships in the coming months.`

Error:
`stale temporal claims=1; unresolved intro: ... in the coming months.`

First prove why the temporal repair handled section content but did not repair the intro. Check whether introduction blocks are omitted from the repair candidate loop, handled by a different path, or restored from stale state.

Fix the root scope/ownership issue generically:
- temporal freshness scanning and repair must cover introduction, all sections, conclusion and FAQ where applicable;
- use the canonical ArticleDocument;
- do not weaken or remove the stale-relative-time detector;
- do not whitelist `in the coming months`;
- repair relative phrases into durable wording where safe;
- if a stale phrase cannot be safely repaired, fail closed with component/block attribution;
- retain rollback behavior;
- debug trace must show the specific temporal violation as resolved when repaired or present/blocking when unresolved.

Add regressions for stale relative wording in:
- introduction
- normal section
- conclusion
- FAQ
and verify durable/non-temporal wording remains unchanged.

Also add the exact production sentence as a regression.

Run targeted tests, full suite, tsc, changed-file lint and production build.

Report the proven root cause, changed files and verification.
```

---

# Git / checkpoint status

Several checkpoints were recommended/created during this period, but the exact current remote state is not fully confirmed in this handoff.

Known commit from the sentence-ending repair:

`8fed859 Harden incomplete sentence ending detection`

Subsequent recommended commits included:

- quarantine/sentence-quality hardening
- external-link citation punctuation fix
- unsupported-claim fail-closed enforcement

Do **not** assume all are pushed without checking.

Before further Git work run:

```powershell
git status
git log -5 --oneline
```

If needed also:

```powershell
git status -sb
```

The debug failure directory should remain ignored:

`debug/pipeline-failures/`

---

# Debugging workflow now in effect

Keep:

```env
ENABLE_PIPELINE_DEBUG_TRACE=true
```

For every live failure:

1. identify the first failing stage
2. inspect `present`, `introduced`, `resolved`, and `firstIntroduced`
3. inspect the quarantine JSON if an integrity-contract rejection occurs
4. compare pre-stage vs rejected candidate ArticleDocument
5. fix the first corrupting producer/shared contract
6. do not weaken the final gate
7. add a regression based on the real production shape
8. run full tests + TypeScript + changed-file lint + production build
9. only then run another live generation

Quarantine artifacts are diagnostic only and must never become normal blog persistence.

---

# Important workflow preference

Before every new coding-assistant prompt, recommend exactly one thinking level:

- **Low** — narrow proven bug with a clear producer/scope
- **High** — multiple plausible architectural paths or cross-boundary ownership/parity issue
- **Max** — broad architectural redesign or highly uncertain system-level investigation

Keep coder prompts concise, complete, and ready to copy.

---

# Current bottom line

## Confirmed working/live-proven repairs since the previous handoff

- sentence-quality false positives hardened
- sentence-quality/preflight/final-QC parity strengthened
- rejected pipeline candidates are now quarantined before rollback
- rollback result and production build are recorded in quarantine artifacts
- external-link question-title punctuation bug fixed and live-proven
- absolute unsupported-claim enforcement fixed and live-proven

## Current blocker

`temporal-freshness` fails because stale relative-time wording remains in the **introduction** while the stage repairs section content.

The exact unresolved sentence is known:

`Either way, they will influence how you plan your content, your campaigns, and your customer relationships in the coming months.`

## Persistence state

Fail-closed behaviour is working correctly.

No failed candidate has been saved.

**Latest confirmed saved English version remains project 13 v19.**
