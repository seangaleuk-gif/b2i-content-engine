# Build Schema Normalization Fix — v3.1

## Reported build failure

Next.js TypeScript validation failed in `src/app/api/projects/[id]/translate/route.ts` because the code accessed `latest.meta_description`, while the declared `BlogVersion` application model exposes `metaDescription`.

## Root cause

`blogVersionRepository` promised camelCase `BlogVersion` objects in TypeScript but returned raw Supabase rows with snake_case database column names. Callers therefore mixed both naming conventions. This produced a compile-time failure in strongly typed code and could also produce missing metadata or word counts at runtime.

## Repair

- Added one repository-boundary normalizer for Supabase blog-version rows.
- `findById`, `findByProject`, `findLatest`, `create`, and `update` now return the camelCase `BlogVersion` shape they declare.
- Removed snake_case property access from the translation route.
- Updated generation readback, SEO auditing, version-list output, and compensation lookup to use the same camelCase contract.
- Added regression tests for both raw snake_case rows and already-normalized camelCase rows.

## Verification completed in this environment

- TypeScript/TSX syntax transpilation: 189 files, 0 errors.
- Repository normalization runtime invariant: passed.
- Scoped TypeScript diagnostic scan: no affected-file semantic errors; only unavailable external package declarations (`next/server`, `vitest`) remained because dependencies are not installed in this environment.
- Direct snake_case access removed from all affected blog-version routes.

## Local verification

Run in the project root:

```bash
npm test
npm run lint
npm run build
```
