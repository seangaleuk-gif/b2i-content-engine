# B2I Content Engine — Latest Repair Handoff
**Updated:** 2026-08-15

## Core rules that remain unchanged

- Keep staged English generation. Do not replace it with one complete-article model call.
- `ArticleDocument` remains canonical; WordPress HTML is derived from it.
- Do not weaken final validation, factual checks, claim ownership, SEO thresholds, protected-content checks, or fail-closed persistence.
- CTA, FAQ, schema, language switcher, links, and WordPress markup remain protected.
- Fix the first corrupting producer/shared contract, not individual final error strings.
- Do not change models, thinking settings, token budgets, timeouts, retries, or pipeline architecture without a separately proven cause.

---

# Latest completed repairs

## 1. Final sentence-quality consistency

### Proven problem
`final-preflight` and `final-qc-scan` disagreed on the same canonical document:
- lowercase sentence start
- punctuation-only residue such as `"."`

### Repair
Shared authoritative sentence-quality rules were introduced and used by malformed-prose scanning, deterministic repair, preflight, and final QC.

Key behavior:
- genuine lowercase starts are detected consistently;
- exact focus-keyphrase lowercase sequences, brands, acronyms, numbers, and intentional lowercase tokens are not falsely changed;
- punctuation-only sentences/residue are detected consistently;
- abbreviation-aware sentence splitting avoids false splits such as `Dr.`, `Mr.`, `a.m.`, `U.S.`;
- deterministic repair preserves inline links/nodes;
- unresolved damage restores the exact snapshot and fails closed.

### Verification
At that stage:
- 2,455 tests passed
- TypeScript passed
- production build passed
- changed files lint-clean

---

## 2. `final-trim` punctuation-residue producer fix

### Proven problem
A short paragraph containing punctuation-only residue could survive `final-trim` because it lost the pass-2 removal competition. The residue then surfaced only at final preflight.

### Repair
`compressDocumentStructureAware` now purges punctuation-only residue inside the final-trim producer before any removal decision.

A shared node-preserving helper:
`dropPunctuationOnlyResidueFromContent()`

is used by both:
- deterministic repair
- final-trim producer

This works inside linked/inline-node paragraphs without damaging links or other inline structure.

### Verification
- 2,457 tests passed
- TypeScript clean
- production build clean

---

## 3. Post-editorial deterministic mutation tail hardened as one system

### New shared integrity contract
Added:

`src/lib/blog/article-integrity-contract.ts`

Every mutating boundary in the deterministic tail now follows:

**snapshot → mutate → validate contract → commit OR exact rollback + fail closed**

The contract covers:
- malformed prose
- sentence quality
- WordPress structure
- protected-content preservation
- internal/external links
- factual claims
- claim ownership
- SEO/keyphrase density/occurrence constraints
- FAQ canonical/rendered/schema semantic parity
- CTA/switcher/schema fingerprints
- coherence
- word-count constraints where stage ownership applies

A stage may only own/alter the categories explicitly assigned to it. New violations outside that ownership reject the candidate immediately.

### Tail stages wired
Includes:
- claim ownership
- malformed-prose repair
- language switcher
- internal links
- external links
- external-link dedup/enforcement
- post-ownership SEO reconcile
- CTA preservation
- final trim
- final SEO reconcile
- FAQ recovery
- final preflight

This prevents corruption from silently surviving until a later gate.

---

## 4. FAQ `answer-mismatch@1` fixed

### Proven root cause
Two FAQ cleanup paths rebuilt plain-text answers from escaped HTML but preserved literal entities such as:

- `&quot;`
- `&amp;`

Canonical FAQ text and schema text therefore diverged semantically.

`validateFaqParity` also normalized the sides asymmetrically.

### Repair
FAQ producers now:
- decode back to true plain text;
- store characters such as `"` and `&` normally in canonical `answerText`;
- escape only when producing HTML.

Parity now uses one authoritative:

`normalizeFaqSemanticText`

for canonical, rendered, and schema content.

It performs the same:
- entity decoding
- JSON-escape unescaping
- whitespace normalization
- case normalization

Real wording differences still fail.

### Verification
- 2,469 tests passed
- TypeScript clean
- production build clean

---

## 5. External-links corruption: first fix proved incomplete

The shared integrity contract immediately exposed that `external-links` could introduce:
- `punctuation-fragment`
- sentence-quality `fragment`

The original producer used regex/offset surgery over rendered WordPress HTML.

### Proven root cause
A lazy WordPress-block regex could mistake an inline/legacy comment such as:

`<!-- /wp:paragraph -->`

inside paragraph content for the true block closer.

This caused:
- incorrect `block.end`
- citation insertion mid-paragraph
- split editorial text
- punctuation detachment
- shifted block IDs

A first boundary-verification patch narrowed the problem but did not eliminate the structural ambiguity.

---

## 6. External-links production path rebuilt on canonical node mutation

### Architectural repair
Production no longer inserts research citations by rendered-HTML offsets.

New canonical producer:

`insertExternalResearchLinksIntoDocument(doc, …)`

It:
- selects citations against `ArticleDocument`;
- inserts each citation as a new paragraph block after the selected canonical block;
- never edits the selected editorial block itself.

Therefore existing:
- editorial characters
- punctuation
- inline links
- strong/emphasis nodes
- sentence boundaries
- IDs
- block order

remain untouched by construction.

### Shared selection logic
Added:

`selectExternalCitationAssignments(...)`

This is shared by canonical and HTML-level paths so citation selection cannot drift.

### HTML fallback
The old HTML-level path remains for direct callers/tests but is hardened with a two-phase WordPress-aware scan and insertion-time boundary verification.

It is no longer the production pipeline path.

### Verification
- 2,479 tests passed
- TypeScript clean
- production build clean
- exact editorial-text round-trip regressions pass
- hostile legacy-comment cases pass
- multi-citation ordering tests pass

---

## 7. English generation successfully reached final validation

A later live production run reached:

- clean final malformed-prose preflight
- FAQ parity valid
- clean final QC
- valid word count
- valid keyphrase density
- successful final validation

Example successful final metrics from the live run:
- word count: 2,856
- keyphrase density: 1.40%
- final QC: zero coherence/malformed/sentence-quality/boilerplate/relevance/heading/unsupported violations

The content pipeline therefore reached the persistence boundary successfully.

---

# Persistence repair

## 8. Missing Supabase RPCs

### Production failure
Save failed with:

`PGRST202`

because Supabase/PostgREST could not find:

`public.save_generated_english_blog_version(p_project_id, p_user_id, p_payload)`

### Proven root cause
The application contract and migration contract matched exactly.

The migration containing the RPCs had simply never been deployed to the production Supabase database.

Required RPCs:
- `save_generated_english_blog_version(integer, uuid, jsonb)`
- `sync_project_content_to_latest_english_blog_version(integer, uuid, text)`

---

## 9. Historical version-number conflict found in project 11

The migration originally attempted a global unique index on:

`(project_id, version_number)`

This exposed project 11:

- row 28 = English v1
- row 29 = second English v1
- row 30 = Chinese `-zh` v1

Rows 28 and 29 had different blog hashes/content, so neither was deleted.

### Historical repair applied
Project 11 is now:

- row 28 = English v1
- row 30 = Chinese v1
- row 29 = English v2

No content was discarded.

---

## 10. Bilingual versioning migration corrected

The original uniqueness rule was wrong for the existing bilingual model because a Chinese translation is allowed to share its English source version number.

### Correct rule
Uniqueness is now enforced for **English versions only**:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS blog_versions_project_version_english_unique
  ON blog_versions (project_id, version_number)
  WHERE slug IS NULL OR slug !~* '-zh$';
```

The old global index is removed if present.

### English next-version calculation corrected
`save_generated_english_blog_version` now calculates the next version using English versions only:

```sql
SELECT COALESCE(MAX(version_number), 0) + 1
INTO next_version
FROM blog_versions
WHERE project_id = p_project_id
  AND (slug IS NULL OR slug !~* '-zh$');
```

Chinese `-zh` rows therefore do not affect English numbering.

### Compensation function
`sync_project_content_to_latest_english_blog_version` also selects only non-`-zh` versions.

### RPC deployment confirmed
Database inspection confirmed both functions now exist with the expected signatures:

- `save_generated_english_blog_version(p_project_id integer, p_user_id uuid, p_payload jsonb)`
- `sync_project_content_to_latest_english_blog_version(p_project_id integer, p_user_id uuid, p_fallback_content text)`

Project 13 was at English v19, so the next successful persisted English generation should become v20.

---

# Current live-production failure

## Latest attempt

The newest production attempt did **not** reach persistence.

It failed at the earlier malformed-prose repair boundary:

`section-2-wp-4[incomplete-sentence-ending]`

Sequence immediately before failure:

1. SEO normalization completed.
2. Factual scan removed multiple unsupported sentences.
3. Claim ownership removed one outside-owner claim.
4. Malformed-prose repair then reported:

`unresolvedEditable=1 unresolvedDocument=1`

and failed on:

`section-2-wp-4[incomplete-sentence-ending]`

### Important implication
Because the deterministic tail now has the shared integrity contract, this defect should ideally have been rejected at the mutation stage that created it.

The next repair must determine:
- whether factual sentence removal created the incomplete remainder;
- whether claim-ownership removal created it;
- whether it existed before those stages;
- why the integrity contract did not reject it immediately at the committing stage.

Do **not** assume the owner before tracing the block.

---

# Exact next repair

Root-cause:

`section-2-wp-4[incomplete-sentence-ending]`

Required work:

1. Trace the exact canonical content of `section-2-wp-4` before and after:
   - factual removal
   - claim ownership
   - any intervening mutation
   - malformed-prose repair

2. Identify the first stage that creates or carries the incomplete ending.

3. Fix the owning producer so sentence/list/item removal cannot leave an incomplete textual remainder.

4. Audit the integrity-contract wiring/ownership for that stage:
   - if malformed/sentence-quality damage is introduced, the candidate must rollback immediately;
   - the corrupting stage must not be allowed to declare newly introduced malformed prose as an owned/acceptable violation unless that ownership is genuinely required by design.

5. Preserve:
   - factual correctness
   - claim ownership
   - quotations
   - links
   - CTA
   - FAQ/schema
   - switcher
   - WordPress structure
   - SEO constraints
   - protected content

6. Add a regression reproducing the exact production shape and proving the first corrupting stage cannot commit the malformed remainder.

7. Do not:
   - add another generic late cleanup layer;
   - weaken malformed-prose/final-QC gates;
   - change models/settings/retries;
   - alter the staged architecture.

8. Run:
   - full test suite
   - `tsc --noEmit`
   - lint
   - production build

Report:
- proven root cause;
- why the integrity contract did not stop it at the owner;
- files changed;
- regression coverage;
- verification results.

---

# Current status summary

### Confirmed stable/repaired
- staged English generation architecture
- WordPress structure protection
- quotation integrity
- heading validation/reconciliation framework
- shared sentence-completeness rules
- structured list recovery
- keyphrase-density reconciliation
- final-trim punctuation residue
- malformed-preflight/final-QC consistency
- FAQ semantic parity
- post-editorial mutation integrity contract
- external-link insertion production architecture
- atomic persistence RPC definitions
- bilingual English-version uniqueness rules
- Supabase RPC deployment

### Still unverified
A fully successful **new** live generation that:
1. passes the current `incomplete-sentence-ending` issue,
2. reaches persistence,
3. calls the newly deployed RPC,
4. saves project 13 as the next English version,
5. completes without compensation.

Until that happens, persistence deployment is structurally confirmed but not yet proven by a successful end-to-end production save.
