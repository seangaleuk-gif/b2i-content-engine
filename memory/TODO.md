# TODO

## Previous Sprints — Phases 1–7 (Completed)
(see CHANGELOG.md for full history)

## Current Sprint — Pipeline Bug Fixes & 3 Consecutive Clean Generations (Jul 25, 2026)

### Bug Fix 1: CTA loss after syncBlogFromDocument()
- [ ] Move `cta-preserve` pipeline stage to run AFTER all `syncBlogFromDocument()`-calling stages (`factual-scan`, `link-enforce`, `final-trim`, `faq-recovery`)
- [ ] Also update `state.articleDoc.cta` when CTA is re-injected, so `syncBlogFromDocument()` includes it
- [ ] Verify: exactly one CTA block, one CTA heading, one signup URL in final saved HTML
- [ ] Add regression test: CTA preserved after factual-scan removes unsupported sentences

### Bug Fix 2: FAQ parity after paragraph splitting
- [ ] Move `faq-recovery` AFTER `paragraphs-final` so schema is rebuilt from final split visible FAQ
- [ ] OR rebuild FAQ schema as part of `paragraphs-final` pipeline stage
- [ ] Verify: exact visible FAQ / FAQPage JSON-LD parity in final validation
- [ ] Add regression test: FAQ schema question count matches visible FAQ count after paragraph split

### Bug Fix 3: Word count validation consistency
- [ ] Use one shared `countReadableWords()` for pipeline policy, route, post-save readback
- [ ] Log word count + HTML fingerprint before validation, before save, after readback
- [ ] Ensure `guardStageOutput` does not restore pre-validation HTML after validation passes
- [ ] Add regression tests for 2,875/2,876 word boundary (just above/below max)
- [ ] Verify: articles below 2,125 or above 2,875 return 500, not 201

### Verification
- [ ] Run `npx vitest run` (expect 586+ passing)
- [ ] Run `npx next build` (expect clean compilation)
- [ ] Run real `/api/generate-blog` production flow until 3 consecutive saved-and-read-back generations pass all agreed checks
- [ ] Restart consecutive count from zero if any run fails
- [ ] Update all memory .md files with results

## Next Sprint — Phase 8: WordPress Integration (Actual Publishing)
(unchanged)

## Future Ideas
(unchanged)
