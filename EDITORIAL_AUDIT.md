# B2I Content Engine Editorial Audit

Reviewed: 29 July 2026

Scope:

- Uploaded source project
- `generated-blog.html`
- `gen-response.json`
- Pasted SEO audit showing `Audited v? (id: ?)`
- Latest 2,671-word Threads article supplied after the initial archive
- Editorial-polish architecture, factual cleanup, canonical rendering, audit version targeting and final validation

## Supplied article findings

The supplied articles can pass an SEO checklist while still being unsafe to
publish. The latest article’s most important defects were:

1. Mutually incompatible Hong Kong Threads audience figures:
   - `4 million monthly active users`
   - `over 400,000 users`
2. Incompatible publishing advice:
   - `Post 2–3 times daily`
   - `Schedule three Threads per week`
3. Incompatible product-feature guidance:
   - use polls `when polls become available`
   - use the platform’s `native polls`
4. A `6.25%` global median was presented as a Hong Kong average.
5. A corrupt production token (`manyf`) survived the old audit.
6. The conclusion contained approximately 638 words—about 25% of the article—
   and introduced new tactics and examples instead of synthesising the body.
7. The failed-croissant example and authenticity advice were repeated across
   independently generated sections.
8. The audit reported 100/100 despite these problems because it measured
   mechanical SEO, not factual consistency or editorial publishability.

The earlier archived article also contained broken fragments, contradictory
link-capability claims and unsupported cadence, time-window, follower-threshold
and engagement guidance. Regression coverage now includes both defect groups.

Images and the permissive internal-link range were intentionally left unchanged.

## Root causes corrected

### Editorial transaction

The previous editor mapped public block IDs back to section array indexes. A
stable component identifier could therefore resolve to the wrong section. It
also skipped malformed or unknown edits and could commit the valid subset.

The replacement implementation:

- extracts only paragraphs, list blocks and existing H3 blocks;
- assigns stable opaque IDs from component and block identity;
- returns structured edits only;
- validates every edit before applying any edit;
- applies edits to a cloned `ArticleDocument`;
- rejects duplicate, unknown, protected, malformed or structurally changed
  edits atomically;
- commits only after WordPress round-trip and production validation pass;
- returns the original object unchanged on rejection.

### Fact and link protection

- Exact `href` order and link count are immutable.
- Anchor text may change, but surrounding linked-sentence wording is locked.
- Sentences containing numbers, factual attributions or links cannot be
  semantically rewritten by the editor.
- New unsupported factual-risk patterns are rejected.
- Precise platform features, dated availability claims, multiplier claims,
  follower thresholds, posting cadence, time windows and percentage targets are
  scanned against supplied research.
- Contradictory Threads post-link capability claims are detected before the
  editorial stage.
- HTML entities are decoded consistently for scanning, evidence matching and
  sentence removal, so `aren&#39;t` cannot evade targeted cleanup.
- Claims split by inline markup are retained as risks instead of being silently
  discarded when no exact raw-HTML position exists.
- Scaled quantities are compared by magnitude, so `4 million` cannot be
  supported by evidence that says `4 billion`.
- Evidence is evaluated per source entry, including Hong Kong/global scope and
  average/median qualifiers. Matching a number somewhere in combined research
  is no longer sufficient.
- Cross-article checks detect incompatible audience sizes, publishing cadence
  and platform-feature availability before the editor runs.

### Conclusion discipline

- Contradictory conclusion content is eligible for targeted conclusion
  regeneration rather than section regeneration.
- Conclusion generation is capped to its own allocation and explicitly
  prohibited from introducing facts, links, offers or new advice.
- An overgrown conclusion is deterministically reduced by removing complete,
  unlinked, non-numeric interior blocks.
- Final publication policy rejects a conclusion above 18% of article words or
  one that introduces numeric claims absent from the main body.

### Factual and editorial scoring

- English audits now include separate 15% Factual Reliability and 15%
  Editorial Quality categories.
- Publication-blocking factual or prose failures cap the audit below 80.
- The latest supplied article produces three deterministic claim conflicts,
  two malformed-prose findings and a 25% conclusion share; its revised audit
  score is 78 rather than 100.
- Final policy enforces these new publication checks when
  `ENABLE_EDITORIAL_POLISH=true`. With the flag disabled, the editorial
  transaction and its additional final gate remain off.

### Sentence cleanup

The old unsupported-claim remover used string offsets across complete WordPress
HTML. It could concatenate the wrong suffix and leave fragments. Cleanup now:

- parses complete WordPress paragraph blocks;
- removes only complete sentence ranges;
- preserves both neighbouring sentences;
- never removes a sentence containing an inline link;
- removes an empty paragraph as one complete block;
- rejects generation if an unsupported claim cannot be removed safely.

### Inline spacing

The HTML parser previously trimmed every inline text node, which changed:

`business in <a>Hong Kong</a> today`

into:

`business in<a>Hong Kong</a>today`

Inline edge spaces are now preserved during parse/render round-trips, and the
editorial transaction performs deterministic node-level spacing repair before
commit.

### Canonical word count

`countCanonicalVisibleWords(articleDoc)` is now the only article-level word
counter used by editorial validation, expansion/trim state, the final gate,
API save/readback and the saved-article English SEO audit. CTA,
language-switcher and JSON-LD copy are excluded consistently.

### SEO audit version

The API returned properties beginning with underscores. The client response
normalizer changed those property names, so the UI always rendered question
marks. The API and both audit pages now use typed, ordinary fields:

- `auditedVersionId`
- `auditedVersionNumber`

The audit request also sends the selected version number, and the route audits
that exact language/version rather than silently selecting the latest version.
The versions API now normalizes Supabase snake_case columns to the camelCase
client contract, preventing `versionNumber` from becoming undefined.

## Final protected order

1. Language switcher
2. Internal links
3. External links
4. SEO normalization
5. Factual cleanup and link enforcement
6. Final paragraph normalization
7. Editorial polish when `ENABLE_EDITORIAL_POLISH=true`
8. CTA preservation
9. Final trim
10. FAQ schema regeneration from protected canonical FAQ entries
11. Canonical word-count check
12. Final validation

## Verification

- `npx vitest run`: 1,294 tests passed
- `npx tsc --noEmit`: passed
- `npm run build`: passed with non-secret placeholder Supabase build variables
- Production build warning retained: the pre-existing translation evidence
  writer uses a dynamic filesystem path and causes a Turbopack NFT trace warning.
  It does not fail compilation or page generation.

Three real production generations were not executed in this workspace because
the upload contains no configured Supabase or DeepSeek environment variables.
No access-token file was read or reused. Real generation results must not be
claimed from mocks, fixtures or placeholder credentials.

## Credential remediation

The uploaded project also contained a plaintext access-token file, a hard-coded
Supabase service-role key in two scripts, and a hard-coded test-account password
in generation/translation scripts. The returned archive excludes the token file
and reads all script credentials from environment variables. Rotate the exposed
service-role key, access token and test password before using the project again.
