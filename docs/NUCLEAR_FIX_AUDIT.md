# B2I Content Engine — Nuclear Generation and Translation Audit

**Audit date:** 30 July 2026  
**Source:** `B2I-Content-Engine-Final-Evidence-Safe.zip` plus the supplied generation failure log  
**Scope:** English blog generation, evidence allocation, factual scanning, repetition repair, editorial acceptance, SEO normalization, WordPress rendering, Traditional Chinese translation, bilingual persistence and rollback.

## Original failure

The supplied log showed the same approved evidence repeated across the introduction, multiple body sections, FAQ and conclusion—especially **2.4 million**, **36%/66%** and **68.4%**. The factual scanner correctly recognized supported claims, but evidence-bearing paragraphs were protected as complete blocks. The editor therefore could not remove weaker duplicate occurrences. Its candidate retained five repeated-idea pairs, scored 48, was rejected, and atomic rollback restored an article scoring 42. Final validation then failed.


## Follow-up live failure and repair

A production run after the first nuclear fix confirmed that claim ownership worked: five misplaced or duplicate claim occurrences were removed. The run then exposed a separate post-deletion defect. Factual and ownership cleanup left two incomplete sentence endings. The general editor was told only ordinal labels such as `editable text 4`, rejected both attempts, and rollback restored the already-malformed pre-editor article. Final validation correctly failed with two malformed-prose issues and an editorial score of 5.

This follow-up repair adds a dedicated malformed-prose boundary immediately after factual cleanup, claim ownership and final paragraph normalization:

- Canonical malformed-prose findings are resolved to stable `component:block` IDs.
- Simple trailing fragments are trimmed deterministically without touching earlier factual sentences.
- Unresolved blocks are sent alone to a targeted malformed-prose editor with exact issue labels keyed by stable block ID.
- A partial repair is rejected atomically; retry feedback names the unresolved stable block ID rather than a temporary text ordinal.
- Repetition repair waits until malformed prose is clean, so unrelated fragments cannot invalidate a repetition candidate.
- Malformed repair is not required to solve repetition at the same time; each repair stage has one responsibility.
- If two targeted AI attempts fail, a short evidence-free malformed paragraph may be removed only when it contains no links, numbers, attributions or protected factual sentences and the article remains above its minimum word count.

## Root causes confirmed

1. Every content component could see most or all research, so duplicate facts were introduced during generation.
2. Evidence protection operated at paragraph level instead of factual-sentence level.
3. Later expansion and component-regeneration stages could reintroduce facts without an ownership boundary.
4. Repetition repair and general editorial polish competed for the same responsibility.
5. Factual and ownership problems could be discovered too late, after links and editorial changes made repair harder.
6. Outline, FAQ and other prompts contained output-contract contradictions.
7. English and Chinese persistence could leave partial bilingual state after an ambiguous write failure.
8. Translation fallback could retain English content internally; the route needed a strict fail-closed barrier before persistence.
9. A legacy SEO helper still allowed forced keyphrase insertion into approved opening prose.

## Implemented architecture

### 1. Claim Ownership Ledger

A new `claim-ownership.ts` module:

- Converts approved research into stable evidence IDs.
- Assigns each evidence sentence to exactly one main article section.
- Uses deterministic semantic matching, load balancing and outline order for ties.
- Gives each body section only its assigned evidence packet.
- Makes introduction, FAQ and conclusion synthesis-only.
- Removes supported claims appearing outside their owner section.
- Keeps only the strongest occurrence inside the owner section.
- Reports unresolved removals instead of silently accepting them.

The ownership boundary is threaded through initial generation, expansion and component regeneration.

### 2. Correct factual and editorial order

The canonical sequence is now:

1. Generate from section-specific evidence.
2. Normalize and repair SEO without forcing soft placements.
3. Remove unsupported claims.
4. Enforce claim ownership and remove duplicate claim occurrences.
5. Normalize final paragraph boundaries.
6. Repair malformed prose using deterministic trimming and stable block-level targeted repair.
7. Run targeted repetition repair on weaker duplicate blocks.
8. Run general editorial polish.
9. Confirm ownership after editorial changes.
10. Insert application-owned language switcher and links.
11. Confirm facts and ownership again.
12. Restore canonical CTA and FAQ schema.
13. Run the single canonical final-policy gate.

### 3. Sentence-level evidence protection

The editor can now improve ordinary prose around a verified factual sentence while preserving:

- The exact scanner-approved factual sentence.
- Numbers, percentages, dates and currencies.
- Attributions and named sources.
- Exact URL destinations and link count.
- Block type and structure.

Dedicated source-list blocks remain fully protected. A decimal-safe sentence splitter was added so values such as **2.4 million** are not mistaken for two sentences.

### 4. Deterministic repetition repair

Near-duplicate paragraphs are grouped into connected clusters. Code selects the strongest occurrence using evidence, links, attribution, completeness and article order. Only weaker block IDs are sent to targeted repetition repair. The general editor is then evaluated comparatively:

- Repetition may not worsen.
- Editorial score may not regress.
- A below-threshold score must improve.
- No new unsupported fact may appear.
- Claim ownership may not change.

### 5. Single final validation owner

Unsupported factual claims and claim-ownership violations are integrated into `analyzeFinalArticle()` and `evaluatePolicy()`. They are hard failures in the canonical final policy. Opening and H2 exact-keyphrase placement remain soft signals. The legacy opening-keyphrase insertion helper is now a guaranteed no-op.

### 6. Prompt contract cleanup

- Outline planning uses a topic-only brief and cannot receive factual findings, statistics, URLs or the previous saved article.
- Structured JSON stages no longer simultaneously demand WordPress HTML.
- FAQ count follows the canonical word-count tiers.
- FAQ, introduction and conclusion cannot repeat precise body-section evidence.
- Generated source IDs are explicitly forbidden from appearing in published prose.

### 7. Fail-closed Traditional Chinese translation

The Chinese candidate is validated as an `ArticleDocument` before it can be returned or saved. Validation covers:

- Section count, section type and block-shape parity.
- FAQ count and FAQ/schema parity.
- CTA presence and HTML structure.
- Exact URLs and link counts.
- Numbers, percentages, dates, currencies and scaled-number equivalence.
- Protected brand names and named research sources.
- Chinese focus keyphrase.
- Canonical paired slug and language switcher.
- Excessive English leakage.
- Half-width punctuation inside Chinese prose.
- Duplicate Chinese paragraphs.
- Rendered HTML equality with the canonical Chinese document.

Only deterministic problem blocks receive a dedicated Chinese editorial repair. One bounded component retry is available for incomplete, link-drifting, number-drifting or transient translation failures. Any remaining English fallback is diagnostic only: `failedComponents` forces the route to reject the candidate.

### 8. Compensated persistence

English generation and bilingual translation now use exact post-save readback. On failure:

- Project content is restored.
- A newly created English version is deleted.
- The previous English bilingual version is restored.
- A newly created Chinese version is deleted.
- Ambiguous remote-success/client-failure cases are located by canonical version, slug and HTML before rollback.

No database migration or manual SQL is required.

## Added and updated regression coverage

Coverage was added or updated for:

- One owner per research claim.
- Section-specific evidence packets.
- Out-of-owner claim removal.
- Duplicate occurrence removal inside the owner.
- FAQ synthesis-only enforcement.
- Sentence-level editing around protected facts.
- Decimal factual sentences such as `2.4 million`.
- Targeting only weaker repeated paragraphs.
- Comparative editorial acceptance.
- Stable malformed-prose block IDs and issue labels.
- Deterministic trailing-fragment trimming.
- Atomic rejection of partial malformed repair and stable-ID retry.
- Safe evidence-free malformed-block fallback above the word minimum.
- Soft opening/H2 keyphrase policy.
- Translation structure, numbers, names, URLs, FAQ, CTA and schema parity.
- Canonical Chinese render/document equality.
- Compensated English and bilingual persistence.

## Verification completed in this environment

- **Strict semantic TypeScript audit:** 0 diagnostics across the changed production dependency graph, using local declarations only for unavailable third-party packages.
- **Repository AST audit:** 188 TypeScript/TSX files; 0 syntax errors.
- **Executable ownership/editorial invariants:** passed.
  - Unique claim ownership.
  - Out-of-owner removal.
  - Duplicate-owned removal.
  - Weaker repetition targeting.
  - Sentence-level factual lock.
  - Surrounding prose remains editable.
  - Stable malformed block IDs.
  - Deterministic dangling-fragment repair.
  - Partial malformed repair rejected atomically.
  - Retry identifies the unresolved stable block ID.
  - Accepted malformed candidate contains zero malformed prose.
- **Executable translation parity invariants:** passed.
  - Valid canonical Chinese document accepted.
  - Number drift rejected.
  - URL drift rejected.
  - English fallback rejected.
  - Non-canonical language switcher rejected.
- **Executable final-policy invariants:** passed.
  - Clean metrics accepted.
  - Unsupported factual claims hard-fail.
  - Claim-ownership violations hard-fail.
  - Opening/H2 keyphrase placement remains soft.
- **Architecture invariant audit:** passed for evidence allocation, stage ordering, later-generation ownership, canonical validation, fail-closed translation and compensated persistence.
- **Git whitespace/error audit:** `git diff --check` passed.

## Environment limitation

The official repository commands could not execute because the uploaded project contained no installed `node_modules`, and the available npm registry could not supply the locked dependency graph. The direct command results were:

- `npm test` → `vitest: not found`
- `npm run build` → `next: not found`

This is an environment/dependency-availability limitation, not a reported passing build. The code was therefore validated with the strict semantic, AST and executable invariant checks listed above. On a machine with registry access, run:

```bash
npm ci
npm test
npm run lint
npm run build
```

Do not publish until those native commands pass in the deployment environment.
