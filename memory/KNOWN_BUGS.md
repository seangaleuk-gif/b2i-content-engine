# Known Bugs

## Active

### 1. DeepSeek v4 `empty_response` on small prompts
- **Description**: DeepSeek v4 Flash returns `empty_response` for prompts under ~500 input tokens. Affects metadata+keyphrase JSON calls (even with `response_format`), tiny keyphrase-only queries, and short plain-text calls.
- **Workaround**: Metadata calls padded with introduction text to exceed 500 input tokens. Keyphrase-only fallback uses a single plain-text `translateText` call (which wraps into a larger prompt). Structured JSON attempt retries without `response_format` on failure.
- **Status**: Working — mitigated by padding and retry logic. Not eliminated.
- **Date discovered**: Jul 26, 2026

### 2. Supabase Node.js 20 deprecation warning
- **Description**: `@supabase/supabase-js` warns about Node.js 20 deprecation at startup
- **Reproduction**: Run `npm run dev` or `npm run build`
- **Suspected cause**: `@supabase/supabase-js@2.110.6` requires Node.js >= 22
- **Status**: Open — non-blocking warning
- **Date discovered**: Jul 16, 2026

### 3. Research page 500 when `BRAVE_API_KEY` not set
- **Description**: Clicking "Generate Research" fails if `BRAVE_API_KEY` is not configured with a valid key
- **Reproduction**: Set placeholder key and click Generate
- **Suspected cause**: Placeholder value fails API authentication
- **Status**: Expected behavior — user must set a real Brave Search API key
- **Date discovered**: Jul 18, 2026

### 4. Chinese translation AI output quality varies per run
- **Description**: The AI (DeepSeek v4) produces output with varying numeric preservation and English content. Section-0 of test article has 5 numbers; AI loses 1 in ~90% of runs. `hasExcessiveEnglish` blocks ~40% of runs. FAQ count varies (4-7). This is an AI output quality limitation, not a pipeline bug.
- **Workaround**: Retry until AI produces compliant output. Validation gates correctly reject non-compliant content.
- **Status**: Open — depends on AI model improvement
- **Date discovered**: Jul 26, 2026

---

## Resolved

| # | Description | Discovered | Resolved |
|---|-------------|------------|----------|
| 1 | Tables not created — API routes 500 when profiles table missing | Jul 16 | Jul 16 |
| 2 | Supabase pooler DNS — Drizzle `postgres.js` direct TCP connection failed on Windows | Jul 17 | Jul 17 |
| 3 | Route group 404 — `(dashboard)` directory caused 404 on Windows | Jul 16 | Jul 16 |
| 4 | camelCase/snake_case mismatch — Drizzle schema uses camelCase but DB has snake_case | Jul 16 | Jul 17 |
| 5 | DeepSeek response format — client expected `result.output` but API returns Chat Completions | Jul 17 | Jul 17 |
| 6 | Drizzle upsert syntax — `$onConflictDoUpdate` vs `onConflictDoUpdate` | Jul 17 | Jul 17 |
| 7 | Workflow stepper hardcoded — step statuses were static | Jul 17 | Jul 17 |
| 8 | word_count not passed to prompt | Jul 17 | Jul 17 |
| 9 | Copy button on research page | Jul 17 | Jul 17 |
| 10 | DeepSeek truncation on long posts | Jul 17 | Jul 18 |
| 11 | DeepSeek `deepseek-chat` model name outdated | Jul 25 | Jul 25 |
| 12 | FAQ recovery corrupted link destinations | Jul 25 | Jul 25 |
| 13 | Paragraph splitting lost by later `syncBlogFromDocument()` | Jul 25 | Jul 25 |
| 14 | Quality scorer used `scoreMin` instead of tolerance range | Jul 25 | Jul 25 |
| 15 | Quality scorer ran Flesch on Chinese content | Jul 25 | Jul 25 |
| 16 | Keyphrase used fixed occurrence range instead of density formula | Jul 25 | Jul 25 |
| 17 | **CTA loss after syncBlogFromDocument()** — `cta-preserve` injected into HTML string but not `articleDoc.cta` | Jul 25 | Jul 26 |
| 18 | **FAQ parity mismatch after paragraph split** — `faq-recovery`/`paragraphs-final` order | Jul 25 | Jul 26 |
| 19 | **Word count validation >2,875 returns 201** — inconsistent `countReadableWords` | Jul 25 | Jul 26 |
| 20 | **chinese_keyword column missing** — DB insert failed on unsupported column | Jul 26 | Jul 26 |
| 21 | **Translation saved despite hard failures** — route logged `failedComponents` but didn't block save | Jul 26 | Jul 26 |
| 22 | **English blocks in Chinese output** — English FAQPage schema, introduction, CTA rendered alongside Chinese | Jul 26 | Jul 26 |
| 23 | **Chinese keyphrase checks N/A** — English project keyword used instead of saved `zhKeyphrase` from `excerpt` | Jul 26 | Jul 26 |
| 24 | **Nested retry multiplication** — outer loop `MAX_RETRIES=1` × inner `chatWithRetry` 3 tries = 6 | Jul 26 | Jul 26 |
| 25 | **Oversized max_tokens** — title 4096, heading 4096, keyphrase 4096, CTA 4096, FAQ 8192 | Jul 26 | Jul 26 |
| 26 | **Dead METADATA_ZH_SYSTEM constant** — unused code from earlier metadata approach | Jul 26 | Jul 26 |
| 27 | **Module-level retry budget shared across concurrent translations** | Jul 26 | Jul 26 |
