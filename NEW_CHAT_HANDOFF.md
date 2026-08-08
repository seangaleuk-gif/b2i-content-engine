# B2I Content Engine — New Chat Handoff

Start here for the audited B2I-9 package dated 8 August 2026.

1. Read `FULL_PIPELINE_ROOT_AUDIT_2026-08-08.md` for the latest implemented root
   fixes, exact pipeline order, acceptance boundaries, logging, regression
   coverage, verification results and remaining risks.
2. Read the opening **Latest audited package state** section of `HANDOFF.md`.
   The rest of that file is useful historical context, but older counts and
   instructions are superseded by the full-pipeline audit.
3. Preserve the staged English generator and canonical `ArticleDocument`.
   Never replace the pipeline with one full-article model call.
4. Keep protected WordPress markup, links, CTA, FAQ/schema and language switcher
   application-owned. Invalid model output is rejected; production code does
   not guess structural repairs.
5. Keep `ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true`; remove/unset the
   obsolete translation shadow flags. Enable complete-document zh-HK review for
   enforced saves.
6. Before calling the package production-verified, run one controlled English
   generation and three consecutive live Traditional Chinese translations.
   Unit/build results do not replace that operational requirement.

Verified in this package:

- TypeScript: pass
- Production build: pass
- English blog/pipeline/generation/route tests: 1,044/1,044
- Selected offline translation/service/route tests: 495/495
- Lint: 444 findings (268 errors/176 warnings), versus the exact recovered
  input's fresh 445 (269/176)

The live-provider document-context test batch was not run because the execution
safety layer blocked possible fixture transmission to DeepSeek. Do not describe
that batch as passing.
