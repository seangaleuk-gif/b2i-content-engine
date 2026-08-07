# Enterprise final-QC validation record

Date: 2026-08-05

## Verified

- `npx tsc --noEmit`: passed.
- Focused deterministic/mocked regression suite: 157 tests passed across the
  English final-document transaction, zh-HK editorial review, naturalness
  gates, glossary normalization, translation metadata, bilingual pairing,
  WordPress compensation and section-expansion safety.
- ESLint on the newly added modules and directly affected standalone modules:
  passed with zero errors and zero warnings.
- `next build`: passed with inert build-only Supabase placeholders. No network,
  database, WordPress or AI provider calls were made by this build.
- Source comparison against the untouched uploaded ZIP: only the documented
  implementation, tests and documentation differ; generated build/test output
  was removed before packaging.

## Deliberately not executed

The unrestricted legacy test command was not run because the repository
contains production/provider integration paths that can call DeepSeek. Running
that command without an isolated provider configuration could transmit article
fixtures externally. The audited suite used an explicit allowlist of pure or
mocked tests instead.

## Existing repository debt outside this change

The repository-wide ESLint command reports 274 errors and 184 warnings in
legacy application, script and test files. These include existing `any` usage,
CommonJS imports, React hook warnings and unused symbols. The focused lint set
for this implementation is clean. This enterprise-QC change does not attempt a
broad unrelated lint migration, which would materially increase risk to the
working generation pipeline.

## Required rollout configuration

Start English in shadow mode:

```text
ENABLE_FULL_DOCUMENT_EDITORIAL=true
FULL_DOCUMENT_EDITORIAL_MODE=shadow
```

After evaluating real output and token size, change the mode to `enforce`.
Enable `ENABLE_FULL_DOCUMENT_ZH_REVIEW=true` only when the deployed provider
budget supports the existing translation call plus one complete-document review
call. Do not enable enforce mode for previously saved shadow-only English
versions; they intentionally fail fresh publication acceptance and must be
regenerated under enforce mode.
