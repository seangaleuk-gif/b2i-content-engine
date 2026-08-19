# B2I Content Engine — English Pipeline Handover

**Date:** 16 August 2026  
**Current build observed:** `b2i-english-2026-08-20-2`

## Current Status

The English generation pipeline has made substantial progress and several previously blocking defects have been fixed and verified.

Recent live generations prove that the core staged generation architecture can reach final validation successfully on different topics.

However, the remaining pattern is no longer best treated as a sequence of isolated bugs. Multiple destructive/mutating stages have exposed different ways they can damage otherwise valid content while still passing later validation.

The recommended next step is therefore **one focused mutation-layer consolidation audit**, not another narrow one-off patch.

Do **not** freeze the English pipeline yet.

Do **not** redesign the generator.

Do **not** change model, thinking mode, token limits, retry policy, timeout settings, research architecture, persistence architecture, or the staged generation architecture unless a proven mutation-contract issue specifically requires it.

---

# Core Architecture That Must Remain

English generation architecture:

Research  
→ Outline  
→ Introduction  
→ Section-by-section generation  
→ FAQ  
→ Conclusion  
→ Canonical `ArticleDocument` assembly  
→ Deterministic processing / mutation stages  
→ Final-document QC  
→ Persistence

Important architecture rules:

- `ArticleDocument` is canonical.
- WordPress HTML is derived from canonical content.
- Do not replace staged generation with a whole-article model call.
- Do not weaken validation.
- Do not weaken factual / claim ownership.
- Do not weaken grounding or source relevance.
- Do not weaken SEO requirements.
- Do not weaken protected content.
- Persistence must remain fail-closed.
- CTA / FAQ / schema / language switcher / links / protected WordPress blocks must remain protected.
- Fix the earliest owning producer or shared contract, not a late cleanup symptom.

---

# Current Generation Strategy

The workflow had been:

broken live generation  
→ prove exact root cause  
→ smallest safe fix  
→ rerun live generation

That worked for several individual defects, but the live runs now show a broader architectural pattern:

**destructive/mutating stages do not all share a sufficiently complete definition of document-semantic integrity.**

The result has been repeated variation of the same class of failure:

- paragraph splitting creating coherence problems;
- SEO normalization reintroducing problems already guarded elsewhere;
- factual-removal side effects;
- deletion-created discourse damage;
- final trim removing content while leaving structural remnants;
- final QC sometimes declaring damaged output clean.

The next step should consolidate those rules into one shared post-mutation integrity contract.

---

# Major Repairs Already Completed

## 1. Sentence-quality shared contract

Fixed:

- lowercase sentence starts;
- punctuation-only residue;
- abbreviation-aware splitting;
- exact keyphrase lowercase exceptions;
- curly apostrophe normalization;
- dangling ending detection;
- overbroad malformed noun-phrase triggers;
- missing auxiliary inversion;
- finite-predicate fragment detection;
- sentence-quality parity between malformed-prose checks and final QC.

Examples now correctly handled:

- `What they do stop for?` → invalid
- `What do they stop for?` → valid
- `Why does this matter?` → valid
- `Native social videos with narrative, emotional value, and a duration under 60 seconds.` → fragment

---

## 2. Final trim / integrity framework

Implemented:

- punctuation residue purge;
- stage-aware `article-integrity-contract.ts`;
- snapshot → mutate → validate → rollback/fail-closed lifecycle;
- protected-content checks;
- link checks;
- factual / SEO / FAQ / CTA / schema / coherence / word-count / grounding checks;
- density-aware trim;
- final SEO reconcile;
- factual-carrier preservation;
- orphan-transition handling;
- debug trace for fingerprints, word count, keyphrase density, violations and block changes.

---

## 3. Pipeline failure snapshots

Diagnostic-only snapshots are stored under:

`debug/pipeline-failures/`

They include:

- build;
- project;
- failing stage;
- violations;
- rollback;
- fingerprints;
- word count;
- keyphrase count;
- changed blocks;
- pre-state;
- candidate `ArticleDocument`.

Snapshots never replace normal persistence.

---

## 4. External-link punctuation

Fixed source-title punctuation so links ending in `.`, `?`, or `!` do not receive duplicate punctuation such as `?.`.

---

## 5. Unsupported factual claim enforcement

Added:

- `scanUnsupportedClaimsInDocument`;
- absolute factual checks at multiple final boundaries;
- claim-specific removed vs skipped handling;
- fail-closed behavior when unsupported claims cannot be safely removed.

---

## 6. Temporal freshness

Added deterministic handling for stale relative-future language.

---

## 7. Final-document diagnosis token runaway

Fixed the final editorial diagnosis layer so it no longer runs into pathological output lengths.

Current behavior:

- bounded prompt;
- no whole-document echo;
- short block-ID findings;
- parser response cap;
- malformed / oversized responses fail safely;
- shadow mode remains non-mutating.

---

## 8. Editorial hardening

Previously fixed:

- source relevance;
- FAQ keyphrase naturalness;
- internal-link anchor specificity;
- removal of generic internal-link fallback;
- quote provenance;
- SEO reconcile naturalness;
- component-aware transition coherence;
- bounded editorial diagnosis findings.

---

# Grounding Incident — Fixed

A live run previously failed with an ungrounded-section false negative around:

`Budgeting for 2026: Where to Invest`

Root cause:

exact-token grounding did not recognise morphology such as:

- budget / budgeting / budgets
- invest / investment
- spend / spending

Implemented:

`src/lib/blog/topic-token-normalizer.ts`

Shared morphology normalization is now reused across:

- content relevance;
- claim ownership;
- incidental-evidence filtering;
- producer grounding.

A producer-level grounding gate now runs after section normalization.

Final QC remains absolute.

This fix worked in later live generations.

---

# Boilerplate / Event Leakage Incident — Partially Addressed

Two separate issues were discovered.

## Boilerplate false positive

Legitimate privacy advice was being caught by overly broad patterns such as bare:

- cookie consent
- privacy policy
- privacy notice

Patterns were narrowed to publisher self-reference such as:

- `our privacy policy`
- `this site's cookie preferences`
- `we use cookies`

## Event-page leakage

Promotional event text such as:

`Every session is curated...`

was being admitted as evidence.

A generic promotional event pattern was added.

However, later successful article generations still showed event/conference-style promotional copy in some cases.

This remains a **systemic editorial candidate**, but should not be mixed into the mutation-contract consolidation unless the audit proves it belongs there.

---

# Orphan Transition / Stable Identity Incident — Fixed

A failure occurred when the same coherence defect moved from one positional block ID to another after external-link insertion.

Root causes:

1. `splitLongParagraphs` could split immediately before a transition sentence.
2. integrity delta identity used positional block IDs too heavily.

Implemented:

- shared `transition-rules.ts`;
- authoritative `opensWithOrphanTransition`;
- paragraph producer avoids splitting before transition sentences;
- stable coherence identities based on semantic content;
- block reindexing no longer creates false-positive "new" violations.

---

# Factual-Removal WordPress Structure Incident

A different-title live generation failed with:

`Unexpected closing block wp:paragraph`

Investigation showed:

- section structure was valid before factual removal;
- factual removal was the relevant mutation boundary;
- common structural probes were safe;
- exact production corruption shape could not be reproduced from existing fixtures.

Defensive hardening added:

- producer WordPress structure assertion;
- pre-factual structural assertion;
- post-factual-removal structural assertion;
- precise fail-closed diagnostics.

Important status:

**structural containment is fixed.**

The exact corrupting production shape was not conclusively reproduced, so the historical mutation statement itself was never proven.

Later live generation showed factual removal completing successfully without the malformed-HTML failure.

---

# `unfinished-example` False Positive — Fixed

A live generation failed because this complete sentence was classified as `unfinished-example`:

`For example, if you want to have deeper, more personal conversations, a private Facebook group or a Discord server might work better than a public page.`

Proven root cause:

`PENDING_EXAMPLE_PATTERN` matched `want to` inside the `if` conditional and incorrectly treated the sentence as a dangling setup.

Generic fix:

- conditional pending actions are no longer treated as unfinished when the sentence contains a complete outcome;
- complete `For example, if...`, `For example, a...`, and `For example, you can...` structures remain valid;
- genuinely unfinished examples still fail.

A second issue was also fixed:

SEO normalization independently performed paragraph splitting without the same coherence protection as the normal paragraph stage.

SEO paragraph splitting now reuses authoritative coherence validation and stable identities.

Verification after this fix:

- **2,646 passed / 0 failed**
- TypeScript clean
- changed-file lint clean
- production build successful

---

# Latest Live Generation — Different Topic

Topic tested:

**How Hong Kong Small Businesses Can Use Customer Communities to Grow in 2026**

Focus keyphrase:

**Hong Kong customer community marketing**

Target audience:

Hong Kong SME owners, local brand owners, marketers, and solo entrepreneurs looking to build stronger customer communities and grow through trust, retention, and word of mouth.

The run reached:

- final preflight valid;
- final QC clean;
- final editorial diagnosis completed;
- final validation passed;
- word count = 2,857;
- keyphrase occurrences = 15;
- keyphrase density = 2.63%.

So the previous `unfinished-example` blocker did **not** recur.

---

# Newly Proven Mutation-Layer Problems

The final article still exposed defects that final QC missed.

## 1. Empty / orphan H3 subsections after final trim

The finished article contained consecutive H3 headings with no body content beneath them.

Example sequence:

- `Choose the Right Space`
- `Tailor Content to Local Culture`
- `Start with a Small, Engaged Group`
- `Use Smart Tools to Keep Momentum`

The first three headings had no substantive body before the next heading.

The debug trace proved `final-trim` removed the paragraphs that belonged beneath those H3s while leaving the headings themselves.

This is a deterministic structural mutation defect.

Final QC still reported:

`headings=0`

So the authoritative final structural contract currently does not define an empty H3 subsection as invalid.

---

## 2. Deletion-created dangling discourse opening

The original introduction began with an unsupported comparative claim.

Factual scan removed it.

The next sentence became the new opening:

`That's why customer community marketing has become such a powerful way for brands to grow.`

That is semantically dependent on the deleted premise.

The current coherence / factual-removal contract did not catch it.

This shows that deletion safety needs to include discourse dependency, not only grammar and block structure.

---

# Why the Strategy Changes Now

The remaining live failures and quality regressions are no longer best understood as independent bugs.

The same higher-level weakness keeps appearing:

**a mutator performs a locally valid operation but leaves the document semantically or structurally invalid in a way that a later stage does not consistently detect.**

Examples include:

- orphan transition;
- unfinished example;
- malformed WordPress structure;
- dangling references after deletion;
- empty H3 subsections after trim;
- final QC missing structurally damaged but technically parseable output.

Continuing with endless one-off patches risks a whack-a-mole cycle.

The recommended next task is therefore a **single focused architecture audit of every destructive/mutating stage** and the introduction of one shared post-mutation semantic integrity contract.

---

# Recommended Next Step

**Thinking level: High**

Run the following prompt exactly as the next coding task.

```text
Perform a focused architecture audit and consolidation of the B2I English pipeline's destructive/mutating stages.

Do NOT redesign generation.
Do NOT replace staged generation.
Do NOT change models, prompts, token limits, retry policy, research, factual ownership, SEO targets, or persistence architecture unless a proven mutation-contract issue requires it.

PROBLEM NOW PROVEN

We have fixed several individually valid bugs, but live runs keep exposing new mutation-side effects:

- paragraph splitting created orphan transitions;
- SEO normalization could reintroduce coherence problems;
- factual removal exposed structural corruption cases;
- deletion can leave dangling semantic references;
- final trim can remove all body content under an H3 while leaving the heading;
- final QC can still declare such output clean.

These are variations of one architectural issue:

Destructive stages do not all enforce the same complete post-mutation document-semantic integrity contract.

GOAL

Create one authoritative shared post-mutation integrity layer and make every destructive stage use it.

Do not simply add dozens of independent regex checks.

1. INVENTORY ALL DESTRUCTIVE/MUTATING STAGES

Audit every stage that can delete, split, reorder, replace, rewrite, insert, compact, or regenerate existing article content, including at minimum:

- paragraph normalization
- regeneration
- SEO normalization
- factual unsupported-claim removal
- claim ownership cleanup
- temporal repair
- internal links
- external links
- malformed-prose repair
- final trim
- final SEO reconcile
- FAQ recovery
- any other ArticleDocument mutator discovered in the code

For each stage report:

- mutation type;
- canonical vs rendered-HTML mutation;
- existing pre/post validation;
- rollback behaviour;
- which integrity dimensions it currently protects;
- which dimensions it can currently violate without detection.

2. DEFINE ONE SHARED POST-MUTATION DOCUMENT INTEGRITY CONTRACT

Build on the existing integrity/coherence infrastructure rather than creating a parallel system.

The shared contract should cover at least:

STRUCTURAL
- valid WordPress block structure;
- canonical/rendered cache parity;
- protected block preservation;
- valid FAQ/schema/CTA/switcher structure;
- link integrity.

CONTENT STRUCTURE
- H2/H3 hierarchy remains valid;
- no empty/orphan H3 subsection;
- headings retain substantive owned body content;
- source-only paragraphs do not count as subsection body;
- lists/tables/quotes count as substantive body where appropriate.

SEMANTIC COHERENCE
- no orphan transitions;
- no unfinished examples;
- no dangling/forward references;
- no deletion-created discourse openings such as `That's why...`, `This means...`, `As a result...`, `That approach...` when their antecedent/setup was removed;
- no heading/body semantic detachment caused by deletion or movement.

LANGUAGE QUALITY
- sentence completeness;
- malformed prose;
- no punctuation residue.

FACTUAL / OWNERSHIP
- unsupported factual claims;
- claim ownership;
- grounding/relevance.

SEO / REQUIRED CONTENT
- keyphrase density bounds;
- required protected SEO metadata/content behaviour;
- word-count ownership remains stage-aware.

Do not make soft editorial preferences into hard blockers unless they already are hard requirements.

3. USE STABLE SEMANTIC IDENTITIES

The existing stable coherence-identity work must remain.

Mutation deltas must distinguish:

- pre-existing violation;
- relocated/reindexed same violation;
- genuinely introduced violation;
- resolved violation.

Do not use positional block IDs alone for delta identity.

4. APPLY THE CONTRACT CONSISTENTLY

Every destructive stage should follow the same lifecycle where appropriate:

pre-state snapshot
→ mutate candidate
→ validate shared integrity contract
→ accept OR rollback/fail at the owning stage

Do not allow a stage to commit a candidate with a newly introduced hard semantic/structural violation and hope final QC catches it later.

Absolute invariants must still be checked at final QC even if pre-existing.

5. FIX ONLY PROVEN GAPS FOUND BY THE AUDIT

Known gaps that must be addressed:

A. final trim must not leave H3 headings with zero substantive owned body.

B. deletion must not leave a paragraph that semantically depends on deleted preceding content, e.g. latest production intro changed from an unsupported opening claim to:

`That's why customer community marketing has become such a powerful way...`

after factual removal deleted the premise.

Create a generic discourse-dependency rule, not a phrase-specific patch.

C. final QC must detect both conditions even if they somehow enter the document before the final stage.

For any additional gaps discovered, only fix them if you can demonstrate a realistic mutation path that violates the contract.

Do not speculative-overengineer.

6. CENTRALISE, DO NOT DUPLICATE

Where rules already exist in:

- coherence.ts
- article-integrity-contract.ts
- sentence-quality
- WordPress structure validation
- factual scanners
- protected-content validators

reuse and compose them.

Do not create different definitions of the same invariant in paragraph normalization, SEO normalization, final trim, and final QC.

7. REGRESSION MATRIX

Build a mutation-contract regression suite covering at minimum:

- delete first sentence → no dangling `That's why` / `This means` / `As a result` dependency;
- delete middle paragraph → neighbouring prose remains coherent;
- delete only H3 body → mutation rejected or entire subsection handled structurally;
- multiple H3 bodies → one may be removed while substantive content remains;
- list/table/quote counts correctly as H3 body;
- source-only content does not;
- paragraph split cannot introduce orphan transition;
- SEO split cannot introduce coherence violation;
- factual removal preserves structure;
- external link insertion cannot create semantic/structural regression;
- final trim cannot create any new hard integrity violation;
- final SEO reconcile cannot create any new hard integrity violation;
- pre-existing absolute violation is still caught by final QC;
- block reindexing does not produce false-positive deltas.

Preserve all current regressions and recent fixes.

8. VERIFICATION

Run:

- focused mutation-contract tests;
- all affected stage suites;
- full serial test suite;
- tsc --noEmit;
- changed-file lint;
- production build.

REPORT BACK WITH

1. Complete mutator inventory.
2. Existing validation coverage matrix.
3. Proven gaps.
4. Shared contract architecture adopted.
5. Exact production issues fixed.
6. Files changed.
7. New regression count.
8. Full verification totals.
9. Any mutation stages still intentionally exempt and why.

IMPORTANT

This is a consolidation/hardening pass, not permission to refactor unrelated working architecture.

Minimise changes outside the mutation/integrity layer.
```

---

# What To Do After This Audit

If the audit and implementation pass:

1. Do not immediately make more editorial tweaks.
2. Run several live generations on genuinely different topics.
3. Check:
   - final validation;
   - persistence;
   - finished article structure;
   - H2/H3 ownership;
   - no dangling discourse;
   - no malformed prose;
   - no unsupported claims;
   - no broken protected content;
   - no repeated systemic SEO/editorial defect.
4. If 2–3 different-topic generations succeed cleanly, freeze/checkpoint the English pipeline.
5. Only then move focus back to translation hardening.

---

# Important Working Rules For The Next Chat

- Live production proof matters more than tests alone.
- Failed generations do not count as saved versions.
- Do not assign a version number unless persistence logs prove it.
- Use **Low thinking** for a narrow proven localized root cause.
- Use **High thinking** for shared contract / cross-stage architecture.
- Use **Max** only for architecture-wide redesign.
- Debug tracing should reduce diagnosis effort; unknown root cause alone is not a reason to use High.
- Do not change model/thinking/token/timeout/retry settings unless separately proven necessary.
- Do not bundle unrelated polish into a blocker fix.
- Do not chase every small editorial imperfection in one successful article.
- Repeated defects across successful generations are the signal for systemic cleanup.
- Preserve all recent successful fixes while consolidating the mutation layer.

---

# Current Verification Baseline

Latest confirmed automated verification before the newest live success:

**2,646 passed / 0 failed (112 files)**

plus:

- `tsc --noEmit` clean;
- changed-file lint clean on added code;
- production build successful.

The mutation-layer consolidation task should report a new complete baseline after implementation.

---

# Bottom Line

The English pipeline is much stronger than it was, and the major historic blockers have generally stayed fixed.

The remaining weakness is now architectural enough to justify one consolidation pass:

**all destructive stages must share the same authoritative post-mutation semantic integrity contract.**

Do that once, verify it thoroughly, then resume different-topic live generation and aim to freeze the English pipeline after 2–3 clean consecutive successful runs.
