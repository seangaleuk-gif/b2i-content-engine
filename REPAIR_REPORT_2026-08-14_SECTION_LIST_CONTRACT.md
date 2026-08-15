# B2I English Generation — Section/List Contract Repair

Date: 2026-08-14  
Build: `b2i-english-2026-08-20-2`

## Production failure

Section 3 failed after its existing targeted retry with one paragraph reported as an unfinished colon/dash setup and four following list blocks reported as empty. The ZIP did not contain that request's raw DeepSeek payload, so the exact field names cannot be proven. The error pattern does prove that both attempts returned `type: "list"` blocks without the canonical non-empty `items: string[]` shape.

## Root causes

1. The shared system prompt named the allowed block types but the repair prompt showed only a paragraph example; it did not restate exact list/table shapes.
2. The normalizer accepted only `items: string[]`. Common unambiguous singleton list shapes (`text`, `item`, or string-valued `items`) were treated as content-free.
3. Sentence completeness was evaluated one block at a time. A normal setup paragraph such as `Use these safeguards:` could not be validated together with the list/table it introduces.
4. Later malformed-prose selection and coherence/final scanners also lacked the same sequence context, so accepting the producer output alone would only have moved the failure downstream.
5. Compaction claim preservation classified colon-led setup text in isolation, which could incorrectly exclude a supported claim from equivalence checks.

## Fixes

- Added `src/lib/blog/editorial-block-contract.ts` as the single exact producer contract used by generation, repair and component regeneration.
- Added bounded singleton-list canonicalization. It never guesses objects/nested structures, never discards conflicting fields and retains hard rejection for genuinely empty lists.
- Adjacent list blocks with the same ordered/unordered setting are merged without changing visible text or order.
- Added recovery logging using component/block identifiers only.
- Added context-aware colon completeness. It applies only to a paragraph immediately followed by a non-empty list/table. Dash endings remain invalid.
- Propagated that rule through AI normalization, malformed-prose scanning/selection, deterministic repair ownership, coherence, expansion/compaction, final QC and pre-save validation.
- Advanced the generation build ID for live-run identification.

## Safety retained

- No model, thinking mode, token budget, timeout, broad retry budget, SEO threshold or factual/ownership rule changed.
- The staged generator and canonical `ArticleDocument` remain unchanged.
- No CTA, FAQ, schema, language switcher, link or WordPress protection was weakened.
- Standalone colon setups, empty lists, conflicting aliases, unsafe markup, unsupported objects and dash-ended fragments still fail closed.
- No persistence path changed.

## Verification

- Offline English-path suite: 1,159/1,159 passed.
- Final focused suite: 169/169 passed.
- `tsc --noEmit`: passed.
- `next build`: passed with inert build-only Supabase placeholders because the uploaded ZIP intentionally contained no environment file.
- Lint: 269 errors / 175 warnings, exactly matching the uploaded input baseline; no new lint findings.
- No live provider call was made.

## Controlled live-run acceptance

The next run must log `build=b2i-english-2026-08-20-2`. If DeepSeek emits singleton list aliases, the log should show `[editorial-payload-normalization]` recoveries and generation should continue. Any real empty/conflicting list must still trigger the single targeted repair and then fail closed if unresolved.
