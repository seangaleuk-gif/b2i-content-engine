# Known Bugs

## Active

### 1. Supabase Node.js 20 deprecation warning
- **Description**: `@supabase/supabase-js` warns about Node.js 20 deprecation at startup
- **Reproduction**: Run `npm run dev` or `npm run build`
- **Suspected cause**: `@supabase/supabase-js@2.110.6` requires Node.js >= 22, but the environment runs Node.js 20.20.2
- **Status**: Open — non-blocking warning. Upgrade Node.js to v22+ when available
- **Date discovered**: Jul 16, 2026

### 2. Research page 500 when `BRAVE_API_KEY` not set
- **Description**: Clicking "Generate Research" fails if `BRAVE_API_KEY` is not configured with a valid key
- **Reproduction**: Set `BRAVE_API_KEY=your-brave-api-key` (placeholder) and click Generate
- **Suspected cause**: Placeholder value fails API authentication. Error is caught and displayed in UI
- **Status**: Expected behavior — user must set a real Brave Search API key. Error message shown in UI
- **Date discovered**: Jul 18, 2026 (updated from Serper to Brave)

---

## Resolved

| # | Description | Discovered | Resolved |
|---|-------------|------------|----------|
| 1 | Tables not created — API routes 500 when profiles table missing | Jul 16 | Jul 16 |
| 2 | Supabase pooler DNS — Drizzle `postgres.js` direct TCP connection failed on Windows with pooler hostname resolution | Jul 17 | Jul 17 — switched from Drizzle direct connection to Supabase REST API (`@supabase/supabase-js` client with service role key) |
| 3 | Route group 404 — `(dashboard)` directory caused 404 on Windows | Jul 16 | Jul 16 |
| 4 | camelCase/snake_case mismatch — Drizzle schema uses camelCase column names but DB has snake_case | Jul 16 | Jul 17 — added `snakeToCamel()` normalization in `api-client.ts` and `toSnakeCase()` helpers in all repositories |
| 5 | DeepSeek response format — client expected `result.output` but API returns Chat Completions `choices[0].message.content` | Jul 17 | Jul 17 |
| 6 | Drizzle upsert syntax — `$onConflictDoUpdate` vs `onConflictDoUpdate` | Jul 17 | Jul 17 |
| 7 | Workflow stepper hardcoded — step statuses were static | Jul 17 | Jul 17 — dynamic computation from project data |
| 8 | word_count not passed to prompt — prompt builder read `wordCount` from wrong path | Jul 17 | Jul 17 — reads from `(project as Record<string, unknown>).word_count` |
| 9 | Copy button on research page — missing clipboard functionality | Jul 17 | Jul 17 — added clipboard copy for source title + URL |
| 10 | DeepSeek truncation on long posts — word count targets not met due to 16384 max_tokens limit | Jul 17 | Jul 18 — increased max_tokens to 32768 + added continuation loop (up to 3 additional AI calls) |
