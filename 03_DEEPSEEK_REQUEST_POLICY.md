# DeepSeek Request Policy

## Confirmed API syntax

Thinking mode is controlled with a top-level structured object:

```ts
thinking: { type: "disabled" }
```

or:

```ts
thinking: { type: "enabled" }
```

`thinking: false` is invalid and returns HTTP 400 because DeepSeek expects a `ThinkingOptions` structure.

## Current implementation

### Files changed (protected)

- `src/lib/services/deepseek.ts`
- `src/lib/services/blog-generation-service.ts`
- `src/lib/services/translation-ai.ts`
- `src/lib/services/deepseek.test.ts`

### Explicit mode guarantee

Every DeepSeek request body must contain `thinking: { type }`. No call may rely on the provider default.

Unmapped stages currently log a warning and default to disabled. New call sites must be deliberately mapped rather than silently left ambiguous.

## Thinking disabled stages

Routine deterministic work uses thinking disabled:

- `outline`
- `outline_retry`
- `intro`
- `intro_retry`
- `intro_repair`
- `faq`
- `section_N`
- `section_N_repair`
- `conclusion`
- conclusion retry and repair
- editorial malformed repair
- editorial post-cleanup repair
- editorial repetition repair
- editorial prose-only fallback
- editorial polish
- claim rewriting / `claim_fix`
- generic pipeline fixers
- section expansion and trimming
- SEO-normalizer AI helpers
- text translation
- HTML translation
- section-heading translation
- FAQ translation
- CTA translation
- conclusion shadow translation and repair
- strict translation repair
- editorial translation repair
- final metadata generation

## Thinking enabled stages

Reserved high-level reasoning stages:

- `factual-risk`
- `evidence-reconciliation`
- `quality-diagnosis`

Do not enable thinking for routine generation merely because the output is important. Use it only where deeper reasoning is deliberately required and tested.

## Token budgets

Current stage budgets:

| Stage | Initial max tokens |
|---|---:|
| Outline | 4,096 |
| Introduction | 6,144 |
| Intro retry/repair | 8,192 |
| Article section | 8,192 |
| Section repair | 8,192 |
| FAQ | 6,144 |
| Conclusion | 6,144 |
| Conclusion retry/repair | 8,192 |
| Editorial/large repair calls | commonly 16,384 |

Global safety cap:

```text
32,768
```

Exhaustion escalation:

- Retry 1: original × 1.5
- Retry 2: original × 2
- Always cap at 32,768

Do not raise all budgets or set an effectively unlimited ceiling without real production measurements.

## Response handling

### Valid completion

Only accept a response as complete when:

- `finish_reason === "stop"`
- `message.content` is non-empty
- the expected parser/validator accepts it

### Truncated response

Every `finish_reason === "length"` response is unusable, including partial non-empty content.

Required behavior:

1. Classify as truncated or token exhaustion.
2. Never pass partial JSON to a parser.
3. Never accept partial prose as a successful result.
4. Retry through the shared controlled escalation path.

### Reasoning content

`reasoning_content` is diagnostic/provider output only.

- Never parse it as the answer.
- Never place it into article content.
- Never expose it in logs.

## Sanitized logging

Log only:

- stage
- request ID
- model
- thinking mode
- attempt
- max tokens
- timeout
- approximate input tokens
- finish reason
- completion tokens
- reasoning tokens
- content length
- reasoning-content length

Never log API keys, prompts, article content, translations, or full model responses.

## Verified production effect

After explicit thinking was disabled, real generations show:

- `reasoning_tokens=0`
- `reasoning_chars=n/a`
- routine stages succeeding on attempt one
- no reasoning-token-exhaustion loop
- normal generation speed restored

This subsystem is complete and protected. Do not modify it unless a defect is proven with evidence.
