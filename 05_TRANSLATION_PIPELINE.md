# Traditional Chinese Translation Pipeline

## Current status

Translation code and stage-aware DeepSeek thinking configuration are present, but the current branch has **not yet passed a fresh end-to-end Traditional Chinese acceptance test** after the latest English-generation changes.

Do not describe translation as production ready until:

1. English generation passes final validation.
2. The English article is manually inspected.
3. One full Traditional Chinese translation passes validation, persistence, and audit.

## DeepSeek thinking mode

Thinking is explicitly disabled for all routine translation calls, including:

- plain text translation
- editorial HTML/block translation
- heading translation
- per-FAQ translation
- CTA translation
- conclusion shadow and repair calls
- strict repair
- editorial repair
- final metadata generation

`translation-ai.ts` now forwards the component/stage name to `AiService` so the correct thinking policy is applied.

## Required translation behavior

- Translate English into natural Traditional Chinese suitable for Hong Kong readers.
- Do not leave English fallback prose in the final Chinese article.
- Preserve exact numbers, percentages, currencies, dates, URLs, named sources, and link destinations.
- Preserve article structure, heading count/order, FAQ count/order, CTA, schema, and language switcher.
- Translate headings and body content deliberately; do not silently reuse English headings.
- Translate FAQ entries one-to-one.
- Regenerate Chinese FAQ schema from the final canonical translated FAQ entries.
- Validate Chinese title, meta description, focus keyphrase, body completeness, and parity before saving.
- Translation failure must never damage, replace, or roll back the valid English article.
- Save/readback must be verified before returning success.

## Previously implemented or reported safeguards

The current project has previously included work for:

- deterministic number protection and restoration
- strict rejection when number placeholders are missing or duplicated
- English-leakage detection and targeted retry
- FAQ boundary validation
- metadata retries and deterministic fallback
- CTA CJK validation
- source-English version pairing
- Chinese-specific SEO audit
- structured translation DTO and block reconstruction
- conclusion structured shadow evaluation
- atomic or compensated persistence safeguards
- snake_case database row normalization to application camelCase

These safeguards must be inspected in the current code before being claimed as verified. Do not rely only on old Markdown status claims.

## Historical translation defects that must be rechecked

- `enFaqCount=0`
- empty DeepSeek metadata responses aborting translation
- Chinese title/meta range failures
- English fallback content surviving
- FAQ/body/schema mismatch
- lost numbers or links
- incomplete CTA/schema
- incorrect repository field normalization

## Translation acceptance checklist

- Correct source English version selected
- English FAQ count is non-zero and matches the article
- Chinese title and metadata are generated
- All sections translated
- No substantial English prose remains
- Numbers/dates/currencies/URLs/sources preserved
- Heading count and order preserved
- FAQ visible body and schema match
- CTA and language switcher correct
- Chinese SEO audit runs against the saved Chinese version
- Chinese version saves and reads back successfully
- English version remains unchanged
