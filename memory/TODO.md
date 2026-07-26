# TODO

## Previous Sprints — Phases 1–7, Pipeline Bug Fixes, Chinese Translation Pipeline (Completed)
(see CHANGELOG.md for full history)

## Current Sprint — 3 Consecutive Clean Translations & Hardening

### Translation Pipeline
- [ ] Achieve 3 consecutive Chinese translations passing all hard checks (numbers, completeness, English checks, FAQ 4-6 count, CTA CJK, keyphrase density)
- [ ] Reduce AI output variability: investigate prompt engineering for numeric preservation
- [ ] Investigate `hasExcessiveEnglish` false positives — brand names and technical terms inflate English ratio
- [ ] Consider per-component retry budget allocation (critical sections get higher priority)

### Verification
- [ ] Run real `/api/projects/[id]/translate` until 3 consecutive versions save successfully with score ≥ 90
- [ ] Run `npx vitest run` (expect 620 passing)
- [ ] Run `npx next build` (expect clean compilation)
- [ ] Update all memory .md files with results

## Next Sprint — Phase 8: WordPress Integration (Actual Publishing)
- (unchanged — see previous sprint notes)

## Future Ideas
- (unchanged — see previous sprint notes)
