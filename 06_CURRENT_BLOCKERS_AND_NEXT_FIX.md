# Current Blockers and Exact Next Fix

## Latest final failure

```text
Final validation failed: FAQ parity mismatch; malformed prose issues=1; editorial score=36 (minimum: 80); [SOFT] no H2 keyphrase
```

## Evidence from the latest run

### FAQ sequence

- The factual FAQ scanner removed one precise factual sentence.
- Later, `faq-recovery` logged that it regenerated schema from five protected FAQ entries.
- Final validation then reported FAQ parity mismatch.

### Editorial/malformed sequence

The editorial validator reported these stable block IDs during candidate rejection:

- `section:section-2:section-2-wp-5` — incomplete sentence ending
- `section:section-5:section-5-wp-4` — broken quoted fragment

AI repair calls completed successfully, but final validation still found one malformed-prose issue.

### Editorial score

- Original/editorial baseline observed around 33.
- Final accepted fallback scored 36.
- Minimum is 80.
- Several candidates were rejected for malformed prose, FAQ parity, no score improvement, word-count excess, long paragraphs, and repetition regression.

## Working hypotheses — not yet proven

1. FAQ schema recovery may be using a stale protected FAQ snapshot after the factual scanner changed the visible FAQ answer.
2. Malformed repair may be applied to a temporary candidate, stale document snapshot, wrong block reference, or overwritten by a later fallback/restore.

The coder must prove the root causes with state tracing before claiming them.

## Exact required fix

### A. Canonical FAQ consistency

Trace FAQ state through:

1. initial FAQ generation
2. canonical `visibleFaq` population
3. factual FAQ scan
4. claim ownership
5. editorial mutation
6. FAQ recovery
7. FAQ schema generation
8. final rendering
9. final validation

Requirements:

- Establish one canonical FAQ source after all mutations.
- Update canonical FAQ answers immediately when factual text is removed.
- Render the visible FAQ body from the current canonical entries.
- Generate FAQPage schema from those same current entries.
- Never regenerate schema from a stale protected snapshot.
- Preserve five entries unless an entire entry is invalid.
- Log counts and mismatch index without logging the full article.

Required diagnostics:

```text
canonical FAQ count
rendered FAQ count
schema FAQ count
normalized mismatch index
```

### B. Malformed repair persistence

For each reported block ID:

- Locate it in the current canonical `ArticleDocument`.
- Log stable ID and validation status before repair.
- Apply repaired content directly to the canonical block.
- Revalidate that exact block immediately.
- Track its fingerprint through later stages.
- Prove no later restore or fallback brings the old text back.

If AI repair fails, regenerate only the individual paragraph using local section context. Do not rewrite the entire article.

### C. Final preflight

Immediately before final validation:

- Re-run malformed validation.
- Rebuild visible FAQ and schema from the canonical FAQ.
- Confirm FAQ parity.
- Run the existing editorial scorer.

Final validation must not discover a malformed issue that a prior stage claimed to repair.

### D. Editorial score

Do not lower the minimum of 80.

After FAQ and malformed consistency are fixed:

- Run the existing scorer.
- Report exact deductions.
- Repair only responsible paragraphs or repetition pairs.
- Do not globally rewrite the article unless a guarded candidate demonstrably improves it without regressions.

## Required regression tests

- Factual removal from one FAQ answer, followed by matching body/schema regeneration
- Five-entry canonical/rendered/schema FAQ parity
- Stable-block malformed repair persists through later stages
- A rejected later candidate cannot restore the malformed original
- Final preflight catches mismatch before final validation
- Editorial minimum remains 80

## Prohibited changes for this task

Do not change:

- DeepSeek thinking-mode implementation
- DeepSeek model
- token budgets
- retry multipliers
- prompts
- stage order unless root cause is proven to be ordering
- SEO thresholds
- factual thresholds
- editorial minimum
- translation architecture
- database schema or persistence
- concurrency
- lint configuration
