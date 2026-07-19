# B2I Content Engine — Backend Documentation

## Architecture Overview

```
src/
├── db/                          # Database layer
│   ├── index.ts                 # Lazy-initialized Drizzle + Postgres connection
│   ├── schema/                  # Drizzle ORM table definitions
│   │   ├── index.ts             # Barrel export
│   │   ├── activity.ts          # Activity log table
│   │   ├── images.ts            # Generated images table
│   │   ├── knowledge.ts         # Knowledge base items table
│   │   ├── profiles.ts          # User profiles table
│   │   ├── projects.ts          # Content projects table
│   │   ├── prompts.ts           # Prompt templates table
│   │   ├── research.ts          # Research sources table
│   │   ├── seo.ts               # SEO audit checks table
│   │   └── social.ts            # Social media posts table
│   ├── migrations/
│   │   └── 0000_initial_schema.sql  # Initial DDL migration
│   └── scripts/
│       └── migrate.ts           # Migration runner script
├── lib/
│   ├── api-client.ts            # Type-safe fetch wrapper
│   ├── repositories/            # Data access layer
│   │   ├── index.ts             # Barrel export
│   │   ├── activity.ts
│   │   ├── images.ts
│   │   ├── knowledge.ts
│   │   ├── profiles.ts
│   │   ├── projects.ts
│   │   ├── prompts.ts
│   │   ├── research.ts
│   │   ├── seo.ts
│   │   └── social.ts
│   ├── services/
│   │   └── auth.ts              # Auth helper (getCurrentUser, getCurrentUserId)
│   ├── supabase/
│   │   ├── client.ts            # Supabase browser client
│   │   ├── server.ts            # Supabase server client (with cookies)
│   │   └── proxy.ts             # Proxy session refresh helper
│   ├── use-data.ts              # React data-fetching hook
│   └── utils.ts                 # Relative time, date formatting
├── components/ui/
│   └── EmptyState.tsx           # Reusable empty state component
├── app/
│   ├── layout.tsx               # Root layout (html/body only)
│   ├── globals.css              # Global styles (Tailwind theme)
│   ├── auth/
│   │   ├── layout.tsx           # Auth pages layout (no sidebar)
│   │   ├── login/page.tsx       # Email/password login
│   │   ├── callback/route.ts    # OAuth/password callback handler
│   │   └── signout/route.ts     # Sign-out handler
│   ├── api/                     # REST API routes
│   │   ├── dashboard/route.ts   # GET aggregated dashboard data
│   │   ├── profile/route.ts     # GET user profile
│   │   ├── projects/route.ts    # GET (list) / POST (create)
│   │   ├── projects/[id]/route.ts   # GET / PATCH / DELETE
│   │   ├── projects/[id]/research/route.ts
│   │   ├── projects/[id]/seo/route.ts
│   │   ├── projects/[id]/images/route.ts
│   │   ├── projects/[id]/social/route.ts
│   │   ├── knowledge/route.ts   # GET (list) / POST
│   │   ├── knowledge/[id]/route.ts   # GET / PATCH / DELETE
│   │   ├── prompts/route.ts     # GET (list) / POST
│   │   └── prompts/[id]/route.ts    # GET / PATCH / DELETE
│   └── (dashboard)/             # Authenticated pages (route group)
│       ├── layout.tsx           # Dashboard layout (with sidebar)
│       ├── page.tsx             # Dashboard home
│       ├── projects/
│       ├── knowledge/
│       ├── prompts/
│       └── settings/
└── proxy.ts                     # Next.js 16 auth proxy (session refresh)
```

---

## 1. Supabase Setup

### Prerequisites
1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Get your project URL and anon key from Settings > API
3. Get your service role key for admin operations
4. Get your database connection string from Settings > Database > Connection string (use the Session pooler URI)

### Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### Run Database Migration

```bash
npx tsx src/db/scripts/migrate.ts
```

This creates all tables, indexes, and seed data.

---

## 2. Database Schema

### Profiles
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | References `auth.users` |
| full_name | text | Display name |
| avatar_url | text | Avatar URL (optional) |
| role | text | admin, editor (default) |
| api_credits_used | integer | Credits consumed |
| api_credits_limit | integer | Max credits (default 10000) |
| storage_used_bytes | bigint | Storage consumed |
| storage_limit_bytes | bigint | Storage limit (default 5GB) |
| updated_at | timestamptz | Last update |

### Projects
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| user_id | uuid (FK) | Owner |
| name | text | Project name |
| status | text | draft, published, research |
| keyword | text | Target keyword |
| audience | text | Target audience |
| country | text | Target country |
| word_count | integer | Word count |
| content | text | Markdown content |
| seo_score | integer | SEO score (optional) |
| published_url | text | Published URL (optional) |
| created_at | timestamptz | Created timestamp |
| updated_at | timestamptz | Last updated |

### Knowledge Items
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| user_id | uuid (FK) | Owner |
| title | text | Document title |
| content | text | Document content |
| tags | jsonb | String array of tags |
| pinned | boolean | Pinned status |
| created_at | timestamptz | Created timestamp |
| updated_at | timestamptz | Last updated |

### Prompts
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| user_id | uuid (FK) | Owner |
| name | text | Prompt name |
| purpose | text | Description |
| tags | jsonb | String array of tags |
| template | text | Prompt template text |
| variables | jsonb | Variable definitions |
| created_at | timestamptz | Created timestamp |
| updated_at | timestamptz | Last updated |

### Research Sources
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| project_id | integer (FK) | Parent project |
| category | text | google, paa, related, competitor, statistic, quote, authority |
| title | text | Source title |
| url | text | Source URL |
| snippet | text | Source excerpt |
| position | integer | Display order |
| created_at | timestamptz | Created timestamp |

### SEO Checks
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| project_id | integer (FK) | Parent project |
| label | text | Check label |
| description | text | Check description |
| status | text | pass, fail, warning, pending |
| score | integer | 0-100 |
| fix | text | Suggested fix |
| category | text | Meta, Headings, Keywords, etc. |
| created_at | timestamptz | Created timestamp |

### Images
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| project_id | integer (FK) | Parent project |
| type | text | featured, social, facebook |
| width | integer | Image width |
| height | integer | Image height |
| prompt | text | Generation prompt |
| url | text | Generated image URL (nullable) |
| status | text | pending, generated, failed |
| created_at | timestamptz | Created timestamp |

### Social Posts
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| project_id | integer (FK) | Parent project |
| platform | text | threads, facebook, linkedin, etc. |
| content | text | Post content |
| character_count | integer | Character count |
| hashtags | jsonb | String array of hashtags |
| status | text | draft, published |
| created_at | timestamptz | Created timestamp |

### Activity Log
| Column | Type | Description |
|--------|------|-------------|
| id | serial (PK) | Auto-increment |
| user_id | uuid (FK) | User |
| project_id | integer (FK) | Related project (nullable) |
| action | text | Action name (e.g., "Published") |
| description | text | Description |
| type | text | publish, draft, research, audit, social |
| created_at | timestamptz | Event timestamp |

---

## 3. Drizzle ORM Configuration

**Config file:** `drizzle.config.ts`

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

**Usage:** The database connection is lazy-initialized via a Proxy. Import `db` from `@/db` and use it like a regular Drizzle instance:

```typescript
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

const allProjects = await db.select().from(projects).where(eq(projects.userId, userId));
```

**Generate migrations after schema changes:**
```bash
npx drizzle-kit generate
```

**Apply migrations:**
```bash
npx tsx src/db/scripts/migrate.ts
```

---

## 4. Repository Layer

Located in `src/lib/repositories/`. Each repository provides data access methods for one entity. All methods use Drizzle ORM for type-safe queries.

**Available repositories:**
| Repository | Methods |
|-----------|---------|
| `projectRepository` | findByUser, findById, findByIdAndUser, create, update, delete, countByUser, countByUserAndStatus |
| `profileRepository` | findById, create, update, findOrCreate |
| `knowledgeRepository` | findByUser, findById, findByIdAndUser, create, update, delete |
| `promptRepository` | findByUser, findById, findByIdAndUser, create, update, delete |
| `researchRepository` | findByProject, findByProjectAndCategory, create, createMany, deleteByProject |
| `seoRepository` | findByProject, findByProjectAndCategory, create, createMany, update, deleteByProject |
| `imageRepository` | findByProject, findByProjectAndType, create, update, deleteByProject |
| `socialRepository` | findByProject, findByProjectAndPlatform, create, createMany, update, deleteByProject |
| `activityRepository` | findByUser, create, deleteByProject |

---

## 5. Authentication

### Flow
1. User visits any protected route
2. `proxy.ts` checks for Supabase session cookie
3. If no session, redirect to `/auth/login`
4. User logs in with email/password
5. Supabase sets session cookie
6. User redirected back to `/`

### Proxy (`proxy.ts`)
Next.js 16 uses `proxy` (formerly middleware). Handles:
- Session cookie refresh on each request
- Redirects unauthenticated users from protected routes to `/auth/login`
- Protected paths: `/`, `/projects`, `/knowledge`, `/prompts`, `/settings`, `/api/*`

### Server Components / API Routes
Use `getCurrentUser()` or `getCurrentUserId()` from `@/lib/services/auth` to get the authenticated user:

```typescript
import { getCurrentUserId } from "@/lib/services/auth";

export async function GET() {
  const userId = await getCurrentUserId(); // throws if not authenticated
  // ... fetch data for userId
}
```

---

## 6. API Routes

All endpoints require authentication. Responses are JSON.

### Dashboard
```
GET /api/dashboard
```
Returns: `{ stats, recentProjects, activity, profile }`

### Profile
```
GET /api/profile
```
Returns: Profile object

### Projects
```
GET    /api/projects            # List all projects for user
POST   /api/projects            # Create project
GET    /api/projects/[id]       # Get single project
PATCH  /api/projects/[id]       # Update project (also creates activity log)
DELETE /api/projects/[id]       # Delete project
```

### Knowledge
```
GET    /api/knowledge           # List all items
POST   /api/knowledge           # Create item
GET    /api/knowledge/[id]      # Get single item
PATCH  /api/knowledge/[id]      # Update item
DELETE /api/knowledge/[id]      # Delete item
```

### Prompts
```
GET    /api/prompts             # List all prompts
POST   /api/prompts             # Create prompt
GET    /api/prompts/[id]        # Get single prompt
PATCH  /api/prompts/[id]        # Update prompt
DELETE /api/prompts/[id]        # Delete prompt
```

### Research
```
GET /api/projects/[id]/research  # Get research sources for a project
```

### SEO
```
GET /api/projects/[id]/seo       # Get SEO checks for a project
```

### Images
```
GET /api/projects/[id]/images    # Get images for a project
```

### Social
```
GET /api/projects/[id]/social    # Get social posts for a project
```

---

## 7. Frontend Data Hooks

### `useData<T>(fetcher, deps)`
Custom React hook for data fetching with loading/error states:

```typescript
const { data, loading, error, refetch } = useData<Project[]>(() =>
  api.get("/api/projects")
);
```

### `api` client (`src/lib/api-client.ts`)
Type-safe fetch wrapper:
```typescript
import { api } from "@/lib/api-client";

const projects = await api.get<Project[]>("/api/projects");
const newProject = await api.post<Project>("/api/projects", { name: "New" });
await api.patch(`/api/projects/${id}`, { status: "published" });
await api.delete(`/api/projects/${id}`);
```

---

## 8. Empty States

The `EmptyState` component (`src/components/ui/EmptyState.tsx`) is used across all data views when no records exist:

```tsx
<EmptyState
  title="No projects yet"
  description="Create your first project to get started."
  actionLabel="New Project"
  onAction={() => router.push("/projects/new")}
/>
```

---

## 9. File Conventions (Next.js 16)

- **`proxy.ts`** — Replaces `middleware.ts`. Node.js runtime only. Export a `proxy` function.
- **`route.ts`** — API route handlers. `params` is a `Promise` (must be awaited).
- **`'use server'`** — Server Actions (available but not yet used — mutations go through API routes).
- **Route Groups** — `(dashboard)` groups authenticated pages with sidebar layout.

---

## 10. Getting Started

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables (see Section 1).

3. Run database migration:
```bash
npx tsx src/db/scripts/migrate.ts
```

4. Start dev server:
```bash
npm run dev
```

5. Visit `http://localhost:3000`
