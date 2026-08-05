# Architecture and Non-Negotiable Rules

## Canonical article state

`ArticleDocument` in `src/lib/blog/article-document.ts` is the single canonical mutable article representation.

- `introduction.blocks`, `sections[].blocks`, and `conclusion.blocks` contain canonical editorial blocks.
- `articleDoc.visibleFaq` is the canonical structured FAQ after all mutations.
- `state.blog` is a rendered cache only.
- Rendered HTML must never become an independent competing source of truth.
- Direct `state.blog = ...` mutation outside the centralized renderer is forbidden.

## Protected application-owned content

The AI does not own these components:

- Language switcher
- CTA/signup block
- Visible FAQ structure
- FAQPage JSON-LD schema

The visible FAQ and schema must always be generated from the same current canonical FAQ entries. A stale protected FAQ snapshot must never overwrite a later factual or editorial mutation. `final-preflight` verifies canonical/rendered/schema parity immediately before final validation.

## Pipeline ownership

All post-assembly processing belongs to `src/lib/pipeline/blog-generation-pipeline.ts`.

Each mutating stage must:

1. Receive the current canonical state.
2. Capture an integrity baseline or snapshot.
3. Apply its mutation.
4. Parse/validate the mutated result when using a legacy HTML bridge.
5. Commit only a valid candidate.
6. Restore the direct-input snapshot when rejected.
7. Synchronize rendered HTML from the canonical document.

Do not add parallel pipelines, hidden compatibility paths, duplicated validators, or separate fallback ownership.

## Legacy HTML bridge

Some stages still use controlled HTML processing. They must follow:

```text
render canonical blocks → process HTML → parse back → validate → commit or restore
```

No stage may mutate an HTML string and silently leave `ArticleDocument` stale.

## Stable block identity

Repairs must target stable block IDs (`kind:componentId:blockId`), not array positions, labels such as "editable text 4," or fuzzy paragraph matching.

For every repair:

- Locate the block in the current canonical document by stable ID.
- Replace the canonical block content.
- Re-run validation on that exact block immediately.
- Confirm later stages do not restore the previous content.

Targeted editorial repairs (malformed, weakened, repetition) persist to canonical state even when the score-gated general polish is rejected.

## Validation ownership

Final pass/fail ownership remains:

```text
analyzeFinalArticle() → evaluatePolicy() → runFinalValidation()
```

No module may create a second independent final gate.

### Hard failures

Examples include:

- Broken WordPress block structure
- Nested paragraphs
- Malformed headings or prose
- Severe keyphrase stuffing
- FAQ count or FAQ schema parity mismatch
- CTA/signup mismatch
- Internal-link maximum breach
- Editorial score below the configured minimum (80)

### Soft warnings

Examples include:

- Exact keyphrase missing from an H2
- Low keyphrase density
- Keyphrase missing from first 100 words
- Slight word-count deviation when policy marks it soft

Do not promote a soft warning into the root cause of an unrelated hard failure.

## Editorial repetition repair

- The earlier paragraph of a near-duplicate pair is always preserved; only the later paragraph is rewritten.
- The repair prompt receives the preserved partner text and the duplicated idea.
- A candidate is rejected when its target still overlaps the preserved paragraph at ≥ 0.55 word-set overlap.
- After two failed AI attempts, a bounded deterministic fallback removes echoed sentences (keeping numbers, links, quotes, protected sentences, and exact keyphrase occurrences) or removes the block only when nothing protected is lost.
- The overlap threshold (0.55) and the editorial minimum (80) are fixed; do not lower them.

## Research and external links

- Research dispatch is owned by `runBlogGeneration`: automatic by default when no approved `research_sources` rows exist; manual rows suppress automatic research; provider failures degrade with a clear warning and never fabricate sources.
- The pipeline consumes `context.research` for prompts, factual scanning, claim ownership, and external-link injection.
- External links are injected only from approved research sources (valid http(s), non-B2I domains), with candidates/inject/final diagnostics and an explicit warning when zero eligible sources exist.
- External-link counting uses the canonical definition (`countEditorialExternalLinks` / `extractEditorialExternalLinkUrls`): FAQ schema script blocks, CTA signup, language switcher, internal B2I URLs, and relative URLs are excluded. The SEO audit reads the same canonical metric.

## AI provider ownership

All provider access goes through `AiService` in `src/lib/services/deepseek.ts`.

No other module may:

- Instantiate a DeepSeek client
- Implement separate retry logic
- Implement separate timeout handling
- Omit explicit thinking mode
- Parse reasoning content as final content

## Authentication and errors

Retain the existing single-owner architecture:

- `auth.ts`: user identity
- `project-authorization.ts`: project access
- `errors.ts`: `AppError` and response conversion

Do not expose internal provider errors, stack traces, filesystem paths, or database details in public responses.

## Translation scope

Traditional Chinese is the only translation target. Simplified Chinese is out of scope. Do not add Simplified Chinese code paths, prompts, or tests without explicit user instruction.

## No architectural reinterpretation

Implement requested fixes exactly. Do not replace the architecture with a supposedly simpler design. Do not introduce wrappers that leave old logic active beside new logic.
