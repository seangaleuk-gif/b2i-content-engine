# B2I Content Engine — Chat Handoff
**Date:** 15 August 2026  
**Project:** B2I Content Engine  
**Current branch:** `deepseek-harness-audit`

## Current status

The English blog-generation pipeline has now completed a successful real production run for **project 13** and **English v19 exists successfully**.

This is the first confirmed end-to-end proof of the current repaired path:

**generation → deterministic processing → final QC → final validation → persistence**

Latest successful production metrics:
- Final canonical word count: **2,853**
- Focus keyphrase occurrences: **14**
- Keyphrase density: **2.45%**
- FAQ parity: **valid — 6 canonical / 6 rendered / 6 schema**
- Final preflight: **clean**
- Final QC:
  - coherence = 0
  - malformed = 0
  - sentence quality = 0
  - boilerplate = 0
  - relevance = 0
  - headings = 0
  - unsupported claims = 0
- Editorial H2 save assertion: **passed**
- Final validation: **passed**
- Persistence: **confirmed — English v19 exists**

Do not treat v20 as current. The next future English version would be v20.

---

# Architecture that must remain unchanged

The English pipeline is intentionally staged:

**Research → Outline → Introduction → Section-by-section generation → FAQ → Conclusion → canonical ArticleDocument assembly → deterministic processing → final-document QC → persistence**

Important constraints:
- `ArticleDocument` is canonical.
- WordPress HTML is derived from canonical structured content.
- Do **not** replace staged generation with one complete-article model call.
- Do **not** weaken validation, factual checking, claim ownership, SEO rules, grounding/relevance, protected-content rules, or persistence fail-closed behaviour.
- CTA, FAQ, FAQ schema, language switcher, links and WordPress structures are protected.
- Fix the first corrupting producer/shared contract, not symptoms with string patches.
- Do not change model, thinking mode, token limits, timeouts or broad retry policy unless a proven root cause requires it.

---

# Major repairs completed

## 1. Sentence-quality consistency

Shared authoritative sentence-quality rules now cover:
- lowercase sentence starts
- punctuation-only residue
- abbreviation-aware sentence splitting
- deterministic sentence repair
- exact focus-keyphrase exceptions

Final preflight and final QC now use the same shared rules.

## 2. Final-trim punctuation residue

`final-trim` previously allowed tiny punctuation-only residue to survive.

Fixed with:
- pass-0 residue purge
- shared node-preserving punctuation-residue removal
- structured handling across editorial polish/final trim

## 3. Shared stage-aware integrity contract

Added:

`src/lib/blog/article-integrity-contract.ts`

Mutating deterministic stages now use snapshot → mutate → validate → rollback/fail-closed behaviour.

The contract protects:
- malformed prose
- sentence quality
- WordPress structure
- protected content
- links
- facts/ownership
- SEO
- FAQ parity
- CTA/switcher/schema
- coherence
- word count
- grounding/relevance

## 4. FAQ parity/entity mismatch

Root cause:
canonical FAQ answers could retain literal entities while schema/readable text used decoded text.

Fixed with symmetric canonical/rendered/schema normalization and entity handling.

## 5. External-link structural corruption

Old external-link insertion used rendered HTML regex/offset surgery and could split paragraphs at legacy inline WordPress comment boundaries.

Production path now uses canonical `ArticleDocument` mutation:

`insertExternalResearchLinksIntoDocument(...)`

External citations are inserted structurally as new blocks instead of slicing rendered HTML.

## 6. Keyphrase-density stuffing

Previous failures:
- SEO normalizer could roll back a safe keyphrase reduction because word count was still above target.
- final trim could remove ordinary words and accidentally raise keyphrase density.

Fixed with:
- corrected SEO normalization acceptance ownership
- density-aware trimming
- `post-ownership-seo-reconcile`
- `final-seo-reconcile`
- removal-attributed SEO drift support for factual/ownership cleanup

## 7. Persistence / Supabase blog-version atomicity

Production initially failed because:

`public.save_generated_english_blog_version(...)`

was missing from the deployed Supabase schema cache.

The migration/RPC path was repaired.

Important bilingual versioning rule:
- English version uniqueness is enforced independently of `-zh` translated rows.
- Partial English-only uniqueness uses:
  `slug IS NULL OR slug !~* '-zh$'`
- next English version calculation also filters English-only rows.

Relevant migration:

`supabase/phase15-blog-version-atomicity.sql`

RPCs:
- `save_generated_english_blog_version(p_project_id integer, p_user_id uuid, p_payload jsonb)`
- `sync_project_content_to_latest_english_blog_version(p_project_id integer, p_user_id uuid, p_fallback_content text)`

Persistence is now **confirmed live** because project 13 successfully contains English **v19**.

## 8. Factual-removal incomplete-sentence corruption

Factual removal could leave dangling linked phrases such as:

`Brands <a>allocate budget</a> to.`

Fixed at the producer level with node-preserving dangling-ending handling.

If unsupported content cannot be removed safely without corrupting protected inline structure, the unsafe mutation is aborted rather than committing malformed prose.

## 9. SEO derived-drift ownership

Factual/ownership cleanup can legitimately reduce keyphrase occurrences by deleting unsupported text.

The integrity contract now permits only mechanically proven **removal-attributed** SEO drift before the dedicated SEO reconciliation stage.

No insertion, rewrite, heading change or unprovable drift is allowed.

## 10. Section grounding/relevance

Previous final QC failure:

`ungrounded-section — section-0`

Root cause:
grounding was checked only at final QC and was not protected by the mutation contract.

Fixed with:
- one authoritative section-grounding rule
- grounding as a first-class integrity-contract category
- grounding-carrier helpers
- factual/ownership removal guards
- grounding-aware final trim
- compaction grounding acceptance gate

A stage can no longer silently turn a grounded section into an ungrounded section.

## 11. Orphan transitions

Previous failure:

`section-4-wp-5[orphan-transition]`

Root cause:
factual/ownership removal could delete an antecedent paragraph while leaving the next paragraph starting with:
- Instead,
- However,
- Therefore,
- This means,
- As a result,
- etc.

Fix:
- transition-openers are now treated as dependent content
- safe plain-text openers may be stripped node-preservingly
- unsafe cases abort the claim-removal mutation
- coherence deltas are now **block-scoped**, preventing a new orphan transition from being masked by a pre-existing violation elsewhere in the same component

---

# Pipeline debug tracing

Professional opt-in stage-by-stage tracing has now been added.

Environment flag:

`ENABLE_PIPELINE_DEBUG_TRACE=true`

Main implementation:

`src/lib/pipeline/pipeline-debug-trace.ts`

The tracer records:
- stage name
- canonical fingerprint before/after
- word count
- keyphrase occurrences/density
- malformed violations
- sentence-quality violations
- coherence violations
- grounding violations
- factual/ownership violations
- FAQ parity
- link/protected-content fingerprints
- integrity-contract result
- rollback state
- exact changed component/block IDs
- concise before/after snippets
- introduced/resolved violations
- first stage where each violation appeared

Example:

`firstIntroduced=claim-ownership section-4/section-4-wp-5 orphan-transition`

The tracing layer is observational only and has an enabled-vs-disabled output-equivalence regression test.

Keep this flag enabled while debugging. It can be disabled once the remaining repair work is complete.

---

# Latest verification baseline

After debug tracing was added:
- Full test suite: **2,519 passed / 0 failed**
- TypeScript: **clean**
- Production build: **compiled successfully**
- Lint: **442 existing findings** — unchanged legacy baseline; new/changed files clean

---

# Git checkpoint

A checkpoint commit was created:

`11c8dcc`

Commit message:

`Stabilize English pipeline integrity and add debug tracing`

At the time of commit:
- branch: `deepseek-harness-audit`
- working tree became clean

Important note:
`git add .` accidentally included generated files under `debug/editorial-failure-*.json`.

A cleanup/amend was recommended:

```powershell
git rm -r --cached debug
Add-Content .gitignore "`ndebug/"
git add .gitignore
git commit --amend --no-edit
git status
```

It is **not confirmed in this handoff whether that cleanup/amend was actually run**.

Also not confirmed here whether the branch was pushed after the checkpoint.

Before further Git work, run:

```powershell
git status
git log -1 --oneline
```

---

# Latest generated article quality

The latest saved v19 article is structurally good and publishable.

Strong points:
- coherent structure
- clean WordPress blocks
- useful H2/H3 hierarchy
- valid lists
- working internal/external links
- FAQ visible content/schema parity
- CTA intact
- keyphrase density in range
- final factual/relevance/coherence gates clean

Remaining editorial-naturalness issues exist but are no longer catastrophic pipeline-integrity failures.

Examples of slightly AI-like/overconfident phrasing:
- “AI becoming the operating system of marketing”
- “Hong Kong consumers in 2026 expect a mind-reading experience”
- “their endorsement carries weight that no paid ad can match”
- “a 15-second clip can say more than a 30-second ad”

Standalone `Source:` paragraphs are also technically valid but editorially clunky.

These are future polish issues, not current hard pipeline failures.

---

# CURRENT KNOWN BUG — next repair

The new debug trace exposed a likely **false positive in the shared incomplete-sentence-ending detector**.

The malformed-prose repair deleted valid sentences including:

`That is the balance worth aiming for.`

and:

`Let’s dive in.`

These are grammatical complete English sentences.

This indicates the current incomplete-ending heuristic is likely overbroad — especially around valid stranded/final prepositions such as:

`...aiming for.`

The next repair should audit the authoritative sentence-completeness/sentence-quality rule and distinguish:
- genuinely dangling/incomplete endings
from
- valid English clauses ending naturally in a preposition or short idiomatic phrase.

Do not simply whitelist the two observed sentences.

The fix should be grammatical/structural and shared by all consumers of the rule.

---

# Recommended next coder task

**Thinking level: High**

Prove why:

`That is the balance worth aiming for.`

and:

`Let’s dive in.`

are classified as `incomplete-sentence-ending`.

Trace the exact shared predicate through:
- `sentence-completeness.ts`
- `sentence-quality.ts`
- publication-quality/final-preflight
- malformed-prose repair

Fix the authoritative rule so valid complete English sentences are not removed while genuinely dangling endings such as malformed `...to.`, `...for.`, `...with.` fragments are still detected.

Requirements:
- no sentence-specific whitelist
- no weakening final QC
- preserve linked/protected content handling
- add positive and negative regression cases
- run full tests, TypeScript, lint and production build

---

# Workflow preference for future chat

Before giving a new coder prompt, clearly recommend one of:
- **Thinking level: Low**
- **Thinking level: High**
- **Thinking level: Max**

Coder prompts should be concise, complete and ready to copy.

For live-generation failures:
1. inspect the `[debug-trace]` output
2. identify `firstIntroduced=...`
3. repair the first corrupting producer/shared contract
4. do not add late cleanup patches
5. verify with regressions + full suite
6. run a real generation only after code verification

---

# Current bottom line

The English pipeline is no longer in the earlier unstable state.

**Confirmed current achievement:**
- full real generation succeeds
- final QC succeeds
- final validation succeeds
- Supabase persistence succeeds
- **project 13 English v19 exists**

The next work is refinement/hardening, beginning with the false-positive `incomplete-sentence-ending` rule.
