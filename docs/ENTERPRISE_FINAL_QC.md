# Enterprise final quality-control implementation

## Exact runtime order

English generation keeps the existing staged, section-by-section generator.
After the canonical `ArticleDocument` is assembled, the added order is:

1. protect CTA and application-owned blocks;
2. complete-document diagnosis (no edits);
3. deterministically select safe prose block IDs only;
4. request bounded block patches through the existing editorial transaction;
5. independently accept or reject each returned patch (no rewrite suggestions);
6. apply accepted patches to a clone and rerun deterministic integrity checks;
7. commit the clone only if every blocking finding is resolved;
8. run final trim/normalization;
9. run the one canonical final policy gate;
10. save, read back, reconstruct, and rerun acceptance.

Traditional Chinese keeps exactly two substantive calls: complete-document
translation, then the existing editorial call strengthened into a full aligned
source/target review. The second call may return only field-level edits for
server-issued IDs. Code then rebuilds schema, validates source/target structure,
numbers, URLs, meaning strength, terminology, naturalness, FAQ, CTA and markup,
and rejects the document if any required unit remains unresolved.

Publication selects a Chinese version through its stored source English version
ID. Both saved HTML values must reconstruct and round-trip through
`ArticleDocument`. The English policy and Chinese parity/quality/SEO gates run
freshly. WordPress receives two drafts; both raw readbacks must match before
either post is published. A failed attempt is compensated by deleting every
post created by that attempt.

## Model-call boundaries

- English E1: complete-document diagnosis only.
- English E2: selected safe-block patch proposal only (skipped when clean).
- English E3: independent patch acceptance only (skipped when no changes).
- Chinese T1: existing complete-document translation.
- Chinese T2: complete aligned review plus targeted field edits and one document
  acceptance decision. No third substantive translation call was added.

Models never assemble the final document, choose arbitrary paths, edit links,
CTA, schema, language switchers, block types, or WordPress markup, and never own
the final save/publish decision.

## Required audit trail

English stage logs contain the run ID, findings, selected unit IDs, returned
patch fingerprints, accepted/rejected decisions and reasons, applied changes,
unresolved findings, overflow, diagnostics and final acceptance. The saved
English version stores the non-content acceptance record for a fresh publication
gate. Chinese version metadata stores selected units/reasons, decisions and field
edits, counts, status, document acceptance and unresolved unit IDs. Publication
logs version pairing, every fresh gate result and the final decision.

## Rollout

Use `ENABLE_FULL_DOCUMENT_EDITORIAL=true` with
`FULL_DOCUMENT_EDITORIAL_MODE=shadow` first. Evaluate false-positive rates and
token size before changing to `enforce`. Enable
`ENABLE_FULL_DOCUMENT_ZH_REVIEW=true` after confirming the two-call provider
budget in the target environment. Feature flags preserve the previous working
English generator while the final layer is evaluated.
