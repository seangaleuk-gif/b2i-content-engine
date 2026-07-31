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

The visible FAQ and schema must always be generated from the same current canonical FAQ entries. A stale protected FAQ snapshot must never overwrite a later factual or editorial mutation.

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

Repairs must target stable block IDs, not array positions, labels such as “editable text 4,” or fuzzy paragraph matching.

For every repair:

- Locate the block in the current canonical document by stable ID.
- Replace the canonical block content.
- Re-run validation on that exact block immediately.
- Confirm later stages do not restore the previous content.

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
- Editorial score below the configured minimum

### Soft warnings

Examples include:

- Exact keyphrase missing from an H2
- Low keyphrase density
- Keyphrase missing from first 100 words
- Slight word-count deviation when policy marks it soft

Do not promote a soft warning into the root cause of an unrelated hard failure.

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

## No architectural reinterpretation

Implement requested fixes exactly. Do not replace the architecture with a supposedly simpler design. Do not introduce wrappers that leave old logic active beside new logic.
