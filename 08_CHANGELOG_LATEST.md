# Latest Changelog — 31 July 2026

## DeepSeek empty-content diagnosis

Observed failures:

```text
DeepSeek response had no content in choices
```

Isolated diagnostics established that `deepseek-v4-flash` was using thinking mode by default. Reasoning tokens count against `max_tokens`. When reasoning consumed the full budget, responses returned HTTP 200 with:

- `finish_reason: "length"`
- empty `message.content`
- non-empty `reasoning_content`

The original wrapper reduced this to a generic empty-response error.

## Token-exhaustion observability and retry

Implemented in `deepseek.ts`:

- `token_exhaustion` error classification
- finish-reason and usage inspection
- sanitized response metrics
- retry budget escalation ×1.5 and ×2
- global cap 32,768

Stage budgets were raised to accommodate reasoning-model output.

Focused tests were added and passed.

## Runaway reasoning evidence

A production attempt showed routine calls exhausting 6K, 8K, 12K, and 16K token budgets, including a small section-trimming prompt. Some calls returned partial truncated JSON with `finish_reason=length`. This proved that indefinitely raising token ceilings was not an acceptable production strategy.

## Explicit thinking-mode control

Live probing confirmed:

```ts
thinking: { type: "disabled" }
```

disables reasoning, while:

```ts
thinking: false
```

is rejected with HTTP 400.

Implemented:

- `ThinkingMode` type
- stage-to-mode mapping
- explicit `thinking` object in every request
- routine generation/translation thinking disabled
- reserved reasoning stages thinking enabled
- unmapped stage warning with disabled fallback
- translation component name forwarded as stage

## Truncated response handling

Implemented a `truncated` response path:

- every `finish_reason === "length"` response is rejected
- partial non-empty content is never accepted
- truncated JSON never reaches parsing
- controlled escalation remains available

## Verified performance improvement

The next production generation showed:

- thinking disabled on routine stages
- zero reasoning tokens
- first-attempt completion across normal generation stages
- restored generation speed
- no reasoning-token-exhaustion loop

## Current downstream failure

The same run reached final validation and failed on:

- FAQ parity mismatch
- one malformed-prose issue
- editorial score 36, minimum 80
- soft warning: exact keyphrase missing from an H2

DeepSeek request behavior is no longer the current blocker.

## Current next repair

Fix canonical FAQ synchronization and stable-block malformed-repair persistence. Do not alter the completed DeepSeek work.
