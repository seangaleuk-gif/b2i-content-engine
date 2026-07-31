# New Coding Chat — Start Message

You are continuing work on the B2I Content Engine. Read every Markdown file in the handoff pack before inspecting or modifying code. Treat the handoff dated 31 July 2026 as authoritative where older project documentation conflicts with it.

The DeepSeek request-layer problem is already fixed and must not be changed:

- every request explicitly sends `thinking: { type: "enabled" | "disabled" }`;
- routine generation and translation use thinking disabled;
- reserved high-level reasoning stages use thinking enabled;
- every `finish_reason: "length"` response is rejected as truncated, including partial content;
- token escalation remains a capped emergency fallback;
- the latest real run showed zero reasoning tokens and first-attempt completion.

The current failure is downstream:

```text
Final validation failed: FAQ parity mismatch; malformed prose issues=1; editorial score=36 (minimum: 80); [SOFT] no H2 keyphrase
```

Fix only the finalization consistency defects.

Required work:

1. Trace the FAQ from generation through factual scanning, claim ownership, editorial processing, recovery, schema generation, rendering, and final validation.
2. Establish one current canonical FAQ source after all mutations.
3. Generate both visible FAQ body and FAQPage schema from that same canonical source.
4. Never restore a stale protected FAQ snapshot after factual text has been removed.
5. Add concise parity diagnostics: canonical count, rendered count, schema count, and normalized mismatch index.
6. Trace these malformed block IDs through every later mutation and restore:
   - `section:section-2:section-2-wp-5`
   - `section:section-5:section-5-wp-4`
7. Apply repairs directly to the canonical `ArticleDocument` block by stable ID, revalidate immediately, and prove no later stage restores the old text.
8. If local AI repair fails, regenerate only the individual paragraph with local section context.
9. Run malformed and FAQ preflight checks immediately before final validation.
10. Keep the editorial minimum at 80. After consistency defects are fixed, report the exact scoring deductions and repair only the responsible blocks if the score remains below 80.

Do not change DeepSeek logic, model, budgets, prompts, SEO/factual thresholds, stage order without proof, translation architecture, database code, concurrency, lint configuration, or unrelated files.

Add regression tests for FAQ mutation/body/schema parity and malformed repair persistence. Run targeted tests, existing DeepSeek tests, the full suite, TypeScript validation, and production build. Report exact root causes, files changed, test/build results, remaining failures, and anything not verified. Do not claim end-to-end success until the user completes a real English generation.
