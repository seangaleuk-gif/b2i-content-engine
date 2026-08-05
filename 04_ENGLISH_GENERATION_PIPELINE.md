# English Generation Pipeline and Quality Rules

## Observed high-level flow

```text
request validation
→ research dispatch (automatic when no approved rows exist)
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
→ internal links (link-injector)
→ external links (approved research sources)
→ external dedup
→ link enforcement
→ factual final confirmation
→ language switcher and CTA preservation
→ final trim
→ FAQ recovery/schema generation
→ word-count check
→ final preflight (malformed re-check, FAQ parity, external-link final count)
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

A missing exact keyphrase in an H2 is `[SOFT]`; it does not block the article.

## Factual rules

- Every precise numeric, percentage, date, platform metric, feature-status, or comparative claim must have compatible evidence.
- Unsupported sentences are removed or locally regenerated.
- Evidence scope, subject, geography, and metric must match the claim.
- Claim ownership assigns each approved claim to one intended section.
- Duplicate use outside the owner section is removed.
- The conclusion must not introduce unsupported new numbers or factual claims.
- Example questions and quoted post prompts must not be misclassified as testimonial or evidence claims.

## Research and evidence preparation

- Research runs automatically at generation start when no approved `research_sources` rows exist for the project (topic from project keyword/name). Manually generated research rows suppress automatic research.
- Provider failures and zero-result responses degrade to the previous no-research behavior with a clear warning; no sources are fabricated.
- Diagnostics: `[research-dispatch]`, `[research:start]`, `[research:provider]`, `[research:results]`, `[research:handoff]`.
- Approved sources reach outline, section prompts, factual scanning, claim ownership, and external-link injection through `context.research`.

## External links

- The `external-links` stage injects `Source: <a href="...">title</a>.` citations from eligible approved sources (valid http(s), non-B2I domains) into relevant body sections.
- A source attaches when the paragraph shares a quantity with it, contains a quotation with ≥6 shared tokens, or shares ≥6 lexical tokens (prose-only sources).
- Diagnostics: `[external-links:candidates]`, `[external-links:inject]`, `[external-links:final]`.
- When zero eligible sources exist, the pipeline logs and records an explicit warning instead of pretending links were added.
- External-link counting uses the canonical definition (`countEditorialExternalLinks`): FAQ schema script blocks, CTA signup links, language-switcher links, internal B2I URLs, and relative URLs are excluded. The SEO audit reads the same canonical metric.

## Editorial rules

- Editorial minimum remains **80**.
- Do not lower the threshold to force an article through.
- Editorial candidates are atomic: accept only when protected facts, structure, FAQ, CTA, links, word count, and quality all remain valid.
- Targeted repairs (malformed, weakened, repetition) persist to canonical state even when the general polish is rejected.
- Repetition repair preserves the earlier paragraph and rewrites only the later duplicate; overlap must drop below 0.55 or the candidate is rejected; a bounded deterministic fallback applies after two failed AI attempts.
- Full-article fallback must not replace a stronger article with a weaker one.
- Stable block IDs must survive repair and later stages.

## Current verified latest-run metrics

```text
editorial score=94 | repeatedPairs=0 | malformed=0
FAQ parity valid=true canonical=6 rendered=6 schema=6
external links=6 | internal links=4 | keyphrase density=1.08%
word count in range (2125-2875)
final validation PASS
```

## Generation acceptance test

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
