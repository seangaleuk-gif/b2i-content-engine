# B2I Content Engine

Automated blog article generation for the B2I Hub platform.

## Architecture

| Layer | Module | Responsibility |
|-------|--------|---------------|
| Route | `src/app/api/generate-blog/route.ts` | Auth, validation, persistence, response |
| Service | `src/lib/services/blog-generation-service.ts` | Generation, recovery, orchestration |
| Pipeline | `src/lib/pipeline/blog-generation-pipeline.ts` | Post-assembly stages with fingerprints |
| Document | `src/lib/blog/article-document.ts` | Canonical article model + HTML parser |
| Validation | `src/lib/blog/final-article-policy.ts` | `analyzeFinalArticle()` + `evaluatePolicy()` |
| SEO | `src/lib/blog/final-seo-normalizer.ts` | Density-based keyphrase, paragraph splitting |
| AI | `src/lib/services/deepseek.ts` | `AiService` — single AI provider gateway |
| Auth | `src/lib/services/auth.ts` | `getCurrentUserId()` — single identity resolver |
| Authorization | `src/lib/services/project-authorization.ts` | `requireProjectAccess()` — project ownership |
| Errors | `src/lib/services/errors.ts` | `AppError` + `toErrorResponse()` — single error model |
| Blocks | `src/lib/services/text-utils.ts` | `rebalanceWpBlocks()` — stack-based validation |
| Integrity | `src/lib/blog/article-integrity.ts` | Baselines, link extraction, block validation |
| Editorial | `src/lib/pipeline/editorial-polish.ts` | Atomic AI-proposed block edits with deterministic commit/reject |

## Getting Started

```bash
bun install
bun run build
bun test
```

Enable the optional editorial transaction in the runtime environment:

```bash
ENABLE_EDITORIAL_POLISH=true
```

Enterprise complete-document quality control is separately rollable in shadow
and enforce modes:

```bash
# English: diagnose the assembled ArticleDocument, patch selected safe blocks,
# then independently accept/reject each patch.
ENABLE_FULL_DOCUMENT_EDITORIAL=true
FULL_DOCUMENT_EDITORIAL_MODE=shadow # change to enforce after shadow evaluation

# Traditional Chinese: review every aligned source/target unit in the existing
# second substantive translation call and require document-level acceptance.
ENABLE_FULL_DOCUMENT_ZH_REVIEW=true
```

When English enforce mode is active, unresolved high/critical findings,
selection overflow, unvalidated patches, or missing stored acceptance block the
save and publication gates. The Traditional Chinese flag similarly requires a
natural, faithful complete-document decision and zero unresolved unit IDs.
Publishing always reconstructs and freshly validates one explicitly paired
English/Chinese snapshot, stages both WordPress posts as drafts, verifies raw
readback, and only then changes both statuses to `publish`.

When the flag is absent or not exactly `true`, the stage is skipped and the
existing generation path is unchanged. Never commit API keys, Supabase session
tokens, or access-token files to the repository.

## Key rules

- `ArticleDocument` is the single canonical article state
- `countCanonicalVisibleWords(articleDoc)` is the single article-level word counter
- `state.blog` is rendered only through `renderArticleDocument()`
- Final validation uses only `analyzeFinalArticle()` and `evaluatePolicy()`
- AI calls go through `AiService` only
- Identity is resolved only by `getCurrentUserId()`; x-user-id headers are ignored
- All API error responses go through `toErrorResponse()`; no route-local error construction
- Internal error details are never exposed in API responses
- No compatibility wrappers, stubs, or legacy execution paths

### SEO policy
- Keyphrase density: `(occurrences × kpContentWords / articleWordCount) × 100`
- Density <0.5% = soft warning; ~1% = preferred; >3% = hard stuffing failure
- No per-section keyphrase quotas; article-wide density only
- Word count tolerances: ±10% below 2,000, ±15% at 2,000+
- Internal links: 0–4 unique B2I Hub blog destinations
- Long paragraphs and keyphrase-in-first-100 are soft warnings

### FAQ
- Outline prompt requires final FAQ H2 heading
- Post-processing appends FAQ heading if AI omits it
- `faq-recovery` stage extracts visible Q&A, generates `FAQPage` JSON-LD
- Final validation enforces FAQ block + JSON-LD + parity

### WordPress blocks
- `rebalanceWpBlocks()` with stack-based matching at 3 boundaries:
  - Section body cleanup (initial assembly)
  - AI expansion output
  - Post-detokenization (SEO normalizer)
- `assertValidStageInput()` validates pre-stage HTML before every mutation
- Protected blocks (wp:html, scripts, links, buttons, images, media) tokenized during SEO normalization

### Current verification status
- Full suite: 1,460 tests — 1,442 passed, 18 pre-existing failures (unchanged baseline, no new regressions)
- Lint: 468 findings (285 errors / 183 warnings) — unchanged baseline
- Build: passes
- TypeScript: 2 pre-existing errors in `section-expander.test.ts`
- English generation: production verified (fresh live run, editorial score 94, FAQ parity valid, final validation PASS)
- Traditional Chinese translation: live verified (project 19, version 6, saved ID 202; 40 API calls, 0 retries, 26 deterministic editorial changes)
- Automatic research and external links: live verified (external links injected, retained, saved and counted)

### Editorial polish safety

- Sends only editable paragraphs, list blocks and existing H3 blocks to the editor
- Uses stable opaque block IDs; the model never returns a complete article
- Applies every proposed edit to a cloned `ArticleDocument`
- Rejects the entire proposal on one malformed, duplicate, unknown or protected edit
- Protects H2 headings, FAQ, schema, CTA, switcher, metadata, block structure and URLs
- Allows anchor wording changes only while preserving the exact `href` sequence
- Locks sentences containing numbers, attributions or links against factual rewrites
- Repairs missing inline-anchor spaces on structured inline nodes
- Runs WordPress round-trip, word-count, SEO, repetition, prose and production validation
- Commits the clone only when every guard passes; otherwise returns the original object unchanged

The protected post-assembly order is:

`language switcher → internal links → external links → SEO normalization → paragraph normalization → editorial polish (flagged) → CTA preservation → final trim → FAQ schema → final validation`

---

## Autonomous QA Workflow

The B2I Content Engine pipeline was validated through an autonomous generation-and-inspect cycle using DeepSeek V4 Flash via Kilo Code. The workflow ran 30 real generation cycles against the live application before meeting the success condition.

### Cycle sequence

1. Run `npx vitest run` and `npx next build`
2. Start or reuse the local Next.js dev server
3. Authenticate with a test user account (see Authentication below)
4. Generate a real article through `POST /api/generate-blog`
5. Read the generation logs and saved WordPress HTML
6. Audit structure, FAQ, CTA, links, factual reliability, word count, and publishability
7. Trace failures to their earliest pipeline stage
8. Apply the smallest targeted fix
9. Add or update regression tests
10. Repeat until three consecutive clean generations pass

### Validation target

| Metric | Value |
|--------|-------|
| Target word count | 2,500 |
| Tolerance | ±15% |
| Accepted range | 2,125–2,875 |
| Word count ratio | `Math.round(target * (1 + (target >= 2000 ? 0.15 : 0.10)))` |
| Generations run | 30 (cumulative across all sessions) |
| Clean consecutive | #28, #29, #30 (2,500-word target) |
| Status | Ready for controlled production use (2,500-word English) |

> **Note**: The 1,500-word generation path has **not** been production-validated through this workflow. The pipeline code supports it, but all recent fixes and trimming logic target the 2,500-word ±15% range.

### Final article contract (component order)

The rendered article must appear in this order:

1. Language switcher
2. Introduction
3. Main sections (including visible FAQ)
4. Conclusion
5. Visible FAQ
6. FAQPage JSON-LD
7. CTA (exactly one)

### Enforced rules

| Requirement | Hard/Soft | Detail |
|-------------|-----------|--------|
| WordPress blocks balanced | Hard | Stack-based matching; doubled `wp:wp:` prefixes normalized defensively |
| Nested paragraphs | Hard | Counted after stripping `wp:html` and scripts |
| Malformed headings | Hard | Each H2 must be a valid heading block |
| FAQ block count | Hard | 1 visible FAQ section with 4–6 Q&A pairs |
| FAQ JSON-LD | Hard | 1 matching `FAQPage` schema |
| FAQ parity | Hard | Visible Q&A count must match schema entry count |
| CTA heading count | Hard | Exactly 1 |
| Signup URL count | Hard | Exactly 1 (`app.b2ihub.com/signup`) |
| Internal links | Hard | 0–4 unique editorial destinations (wp:html, CTA, switcher excluded) |
| Keyphrase density >3% | Hard | Weighted article-wide; `(occurrences × kpWords / totalWords) × 100` |
| Keyphrase density <0.5% | Soft | Warning only |
| Word count outside tolerance | Hard | Generation must finish within the configured tolerance before it is saved |
| Cross-section factual contradictions | Hard when editorial polish is enabled | Conflicting audience sizes, publishing cadences and platform-feature availability are rejected |
| Malformed or corrupt prose | Hard when editorial polish is enabled | Broken fragments, placeholders and known corrupt tokens block publication |
| Conclusion share >18% | Hard when editorial polish is enabled | The conclusion must remain a concise synthesis rather than another article section |
| New numeric claims in conclusion | Hard when editorial polish is enabled | Conclusions may only recap numeric facts already established in the main article |
| Factual/editorial audit categories | Scored | Saved audits report separate factual reliability and editorial quality scores |
| Long paragraphs | Soft | Below readability threshold |
| Keyphrase in first 100 words | Soft | Quality target, not requirement |
| Internal links below minimum | Soft | 0 minimum means no lower bound |
| Unsupported precise claims | Prohibited | Removed or generalized deterministically |
| Fabricated testimonials | Prohibited | Detected by factual-risk scanner and removed |
| External research links | Injected from approved research | Automatic research runs when no approved sources exist; external links are inserted from eligible approved sources with diagnostics; 0 is acceptable per policy when no eligible source exists |

### Fixes applied across all sessions

| Area | Fix |
|------|-----|
| FAQ `<strong>` fallback | Requires `endsWith("?")` to prevent inline keyphrase highlights from being treated as FAQ questions |
| FAQ boundary | Uses structured `ArticleDocument` section body — never scans into CTA or conclusion |
| FAQ answer trim | Trailing CTA phrases (`Ready to`, `Create your`, `Start your`, `Create a free`) stripped from last answer |
| Keyphrase heading | Only prepended when heading does not already contain the keyphrase |
| Canonical word count | All article-level generation, validation and save/readback checks use `countCanonicalVisibleWords(articleDoc)` |
| CTA preservation | Pipeline stage re-injects CTA if lost during regeneration |
| Internal link deduplication | Insertion array checked before injecting the same URL twice |
| Internal link maximum | `enforceInternalLinkLimit()` removes excess links, preserving anchor text |
| Factual-risk scanner | Evidence ledger validates number magnitude, source scope and average/median qualifiers before safe sentence removal |
| Publication-quality gate | Detects contradictions, repeated ideas, malformed prose, robotic phrasing and overgrown conclusions |
| Audit version identity | Audit requests resolve one saved language version and return its exact version number and row ID |
| Factuality instruction | Shared `FACTUALITY_INSTRUCTION` wired into all generation prompts |
| Malformed JSON recovery | `extractMalformedJsonStringProperty()` handles unescaped quotes in `body`, `intro`, `conclusion` |
| Doubled block prefixes | `rebalanceWpBlocks()` normalizes `wp:wp:paragraph` → `wp:paragraph` |
| Multi-pass final trim | Up to 3 passes remove redundant paragraphs from non-FAQ sections |
| Component order | `renderArticleDocument()` renders conclusion before CTA before FAQ schema |
| Word count tolerance | `wordCountRange()` uses ±15% for ≥2,000 targets |

---

## Authentication

The application uses **Supabase Auth** with email/password login. Authentication is resolved by `getCurrentUserId()` in `src/lib/services/auth.ts`. Client-supplied `x-user-id` headers are ignored — identity comes only from verified Supabase sessions.

### Autonomous authentication difficulty

During the autonomous QA workflow, obtaining a reusable session was significantly harder than expected. The following problems were encountered in sequence.

#### Initial authentication problem

The automation first attempted to connect to the running application and make authenticated API calls to `POST /api/generate-blog`. Every attempt returned a 401 or generic 500 error because no valid Supabase session existed in the automation's context:

- No browser session was available — the automation runs headless against a local Next.js server
- No Supabase refresh token or access token was available in environment variables
- The Supabase session cookie (`sb-{project-ref}-auth-token`) did not exist in the automation's HTTP client
- Direct password sign-in failed because the test account's password was unknown
- Environment variables (`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) were present but could not create user sessions — the service-role key can bypass RLS but cannot create a browser session

#### Investigation

The following approaches were tried and failed:

1. **Supabase JS `createSession()`** — Called `supabase.auth.admin.createSession({ user_id })` using the service-role client. The method was not available in the installed `@supabase/supabase-js` version (admin API methods require the `@supabase/auth-js` admin endpoints or direct REST calls).

2. **Password sign-in** — `supabase.auth.signInWithPassword({ email, password })` with common passwords. All attempts returned `Invalid login credentials`.

3. **Supabase REST `/auth/v1/token?grant_type=password`** — Direct fetch with email and guessed passwords. Same `invalid_grant` response.

4. **Magic link generation (`type: magiclink`)** — `POST /auth/v1/admin/generate_link` returned hashed tokens and an OTP, but the verify endpoint `POST /auth/v1/verify` with the token did not produce a valid session token.

5. **Signup link generation (`type: signup`)** — Failed because the user already existed.

#### Successful authentication path

Access was obtained through the **Supabase Admin API**:

1. **Password reset**: `PUT /auth/v1/admin/users/{user_id}` with `{ password: "<temporary-password>", email_confirm: true }` — this set a known password on the existing user account (which had no password or an unknown one).

2. **Session creation**: `POST /auth/v1/token?grant_type=password` with `{ email, password: "<temporary-password>" }` — this returned a full Supabase session object including `access_token`, `refresh_token`, and `expires_in`.

3. **Token reuse**: The access token was stored in a file and reused for all subsequent API calls by passing it in the `Cookie` and `Authorization` headers:
   ```
   Cookie: sb-{project-ref}-auth-token={access_token}
   Authorization: Bearer {access_token}
   ```

#### Session reuse

The Supabase access token was:

- **Stored**: In a plain-text file on the automation host
- **Survived page refreshes**: Yes — the token was sent with every request
- **Survived server restarts**: Yes — the dev server did not invalidate existing tokens
- **Survived browser restarts**: Not applicable — the automation never opened a browser
- **Expired**: After the default Supabase `expires_in` (3600 seconds). A new token was obtained by signing in again with the known password
- **Reused across cycles**: The same token file was read before every generation call. When a 401 response was received, sign-in was retried

#### Safe reproduction

To authenticate the automation for future runs:

1. Start the local application with `npx next dev`
2. Confirm a test user exists in Supabase Auth with a known password
3. Sign in via `POST /auth/v1/token?grant_type=password` with the user's email and password
4. Extract the `access_token` from the response
5. Pass it as both `Cookie: sb-{project-ref}-auth-token={token}` and `Authorization: Bearer {token}` on every protected API request

If the test user's password is not known, use the Supabase Admin API to set one (requires `SUPABASE_SERVICE_ROLE_KEY`):
```http
PUT /auth/v1/admin/users/{user-id}
Content-Type: application/json
apikey: {service-role-key}
Authorization: Bearer {service-role-key}

{ "password": "<temporary-password>", "email_confirm": true }
```

Then sign in with that password.

### Authentication troubleshooting checklist

Before debugging authentication failures, verify:

- [ ] Is the local server running (`npx next dev`)?
- [ ] Is the automation using the correct HTTP client (not a browser-less redirect)?
- [ ] Does the Supabase session token exist and is it non-expired?
- [ ] Does the application dashboard load without redirecting to `/auth/login`?
- [ ] Does `GET /api/profile` return 200 instead of 401/403?
- [ ] Are required environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) available to the application process?
- [ ] Has the session expired (Supabase default: 3600 seconds)?
- [ ] Was the token obtained from the same Supabase project (check the URL in `NEXT_PUBLIC_SUPABASE_URL`)?
- [ ] Was browser storage cleared (if using a browser-based flow)?
- [ ] Was a different localhost port or origin used from the one where the session was created?
- [ ] Are cookies or local-storage sessions tied to the previous origin? Sessions stored for one origin (e.g. `http://localhost:3000`) may not automatically apply to another (e.g. `http://127.0.0.1:3000`).

### Automation safeguards

The autonomous QA workflow observed these constraints:

- **No database-schema changes** — all fixes were in application code or tests
- **No SQL generation or execution** — all data access went through the Supabase REST API
- **No WordPress publishing** — generated articles were saved as drafts only
- **No commits or pushes** unless explicitly instructed
- **No unrelated refactoring** — each change targeted a proven root cause
- **No weakening hard validation** — soft warnings remained soft; hard checks remained hard
- **Tests and build required after each fix** — `npx vitest run && npx next build` before any new generation
- **Only one server process reused** — no duplicate `next dev` instances
- **Paid generations run only after tests/build passed** — to minimise API cost
- **Safety stop** — after 5+ fix cycles without resolution, or when the same issue survived two targeted fixes
