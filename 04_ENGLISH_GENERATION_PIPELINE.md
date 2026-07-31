# English Generation Pipeline and Quality Rules

## Observed high-level flow

```text
request validation
→ research/evidence preparation
→ outline
→ introduction and sections
→ FAQ and conclusion
→ assemble ArticleDocument
→ section expansion/trim and component regeneration
→ SEO normalization
→ factual scan
→ claim ownership cleanup
→ malformed-prose repair
→ editorial repair/polish with guarded acceptance
→ internal/external links
→ language switcher and CTA preservation
→ final trim
→ FAQ recovery/schema generation
→ final validation
→ persistence/readback
```

The exact implementation remains authoritative. Do not reorder stages unless the requested fix proves ordering is the root cause.

## English output requirements

- WordPress block format only in final article output
- No Markdown in the generated article
- Friendly, practical, professional tone
- Hong Kong context
- B2I Hub voice: warm, honest, mission-driven, creator/SME focused
- H2/H3 structure only
- Visible FAQ plus matching FAQPage JSON-LD
- Deterministic CTA and language switcher
- Internal B2I Hub links and supported external evidence links

## SEO targets

Product targets for a typical approximately 2,500-word article:

- SEO title: 50–70 characters
- Meta description: 155–200 characters
- Approximately 6–7 H2 headings
- Approximately 4–6 FAQ entries, usually 5
- Flesch target around 60–70
- Paragraphs generally no more than 3 sentences
- Exact focus keyphrase in the first 100 words where possible
- Exact focus keyphrase in at least one H2 is desired
- Keyphrase density policy remains the centralized source of truth
- Severe stuffing above the configured maximum remains a hard failure

The latest run had the exact keyphrase missing from an H2, but policy reported it as `[SOFT]`; it did not block the article.

## Factual rules

- Every precise numeric, percentage, date, platform metric, feature-status, or comparative claim must have compatible evidence.
- Unsupported sentences are removed or locally regenerated.
- Evidence scope, subject, geography, and metric must match the claim.
- Claim ownership assigns each approved claim to one intended section.
- Duplicate use outside the owner section is removed.
- The conclusion must not introduce unsupported new numbers or factual claims.
- Example questions and quoted post prompts must not be misclassified as testimonial or evidence claims.

## Editorial rules

- Editorial minimum remains **80**.
- Do not lower the threshold to force an article through.
- Editorial candidates are atomic: accept only when protected facts, structure, FAQ, CTA, links, word count, and quality all remain valid.
- Full-article fallback must not replace a stronger article with a weaker one.
- Repair only the responsible paragraph or repetition pair when possible.
- Stable block IDs must survive repair and later stages.

## Current latest-run metrics

Before final rejection:

- Canonical word count: 2,807
- Allowed range shown by the pipeline: 2,125–2,875
- Final hard failures: FAQ parity mismatch, malformed prose issue, editorial score 36
- Soft warning: no H2 keyphrase

## Current generation acceptance test

A run is accepted only when:

1. DeepSeek stages complete without exhaustion loops.
2. Final validation passes.
3. Editorial score is at least 80.
4. FAQ body and schema match exactly under canonical normalization.
5. No malformed paragraphs survive.
6. WordPress blocks are balanced.
7. CTA and language switcher are intact.
8. Word count, link policy, factual checks, and SEO policy pass.
9. The saved article is read back successfully.
10. The actual article is manually inspected before translation.
