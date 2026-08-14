import { getDb } from "@/db";
import type { BlogFaqItem, BlogVersion, NewBlogVersion } from "@/db/schema/blog-versions";

type BlogVersionRow = Record<string, unknown>;

export interface ProjectContentSyncResult {
  versionId: number | null;
  versionNumber: number | null;
  blog: string;
}

export type AtomicEnglishBlogVersion = Omit<NewBlogVersion, "versionNumber" | "createdAt">;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toFaqItems(value: unknown): BlogFaqItem[] {
  if (!Array.isArray(value)) return [];
  const items: BlogFaqItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const answerSource = record.answer ?? record.answerText ?? record.answerHtml;
    const answer = typeof answerSource === "string" ? answerSource.trim() : "";
    if (question && answer) items.push({ question, answer });
  }
  return items;
}

function toFiniteNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid blog version ${field}: ${String(value)}`);
  }
  return parsed;
}

function toNullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toFiniteNumber(value, field);
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid blog version createdAt: ${String(value)}`);
  }
  return parsed;
}

/**
 * Supabase returns database column names in snake_case, while the application
 * and Drizzle schema use camelCase. Normalize once at the repository boundary
 * so callers receive the BlogVersion shape promised by the TypeScript contract.
 */
export function normalizeBlogVersionRow(input: unknown): BlogVersion {
  const row = (input ?? {}) as BlogVersionRow;
  return {
    id: toFiniteNumber(row.id, "id"),
    projectId: toFiniteNumber(row.projectId ?? row.project_id, "projectId"),
    userId: String(row.userId ?? row.user_id ?? ""),
    versionNumber: toFiniteNumber(row.versionNumber ?? row.version_number, "versionNumber"),
    title: (row.title ?? null) as string | null,
    slug: (row.slug ?? null) as string | null,
    metaDescription: (row.metaDescription ?? row.meta_description ?? null) as string | null,
    excerpt: (row.excerpt ?? null) as string | null,
    blog: (row.blog ?? null) as string | null,
    faq: toFaqItems(row.faq),
    internalLinks: toStringArray(row.internalLinks ?? row.internal_links),
    externalLinks: toStringArray(row.externalLinks ?? row.external_links),
    categories: toStringArray(row.categories),
    tags: toStringArray(row.tags),
    readingTime: (row.readingTime ?? row.reading_time ?? null) as string | null,
    wordCount: toNullableNumber(row.wordCount ?? row.word_count, "wordCount"),
    summary: (row.summary ?? null) as string | null,
    model: (row.model ?? null) as string | null,
    promptVersion: (row.promptVersion ?? row.prompt_version ?? null) as string | null,
    generationTimeMs: toNullableNumber(row.generationTimeMs ?? row.generation_time_ms, "generationTimeMs"),
    tokenUsage: ((row.tokenUsage ?? row.token_usage ?? null) as Record<string, unknown> | null),
    status: String(row.status ?? "draft"),
    createdAt: toDate(row.createdAt ?? row.created_at),
  };
}

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const blogVersionRepository = {
  async findById(id: number): Promise<BlogVersion | null> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_versions")
      .select("*")
      .eq("id", id)
      .single();
    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return normalizeBlogVersionRow(data);
  },

  async findByProject(projectId: number): Promise<BlogVersion[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_versions")
      .select("*")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(normalizeBlogVersionRow);
  },

  async findLatest(projectId: number): Promise<BlogVersion | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_versions")
      .select("*")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false })
      .limit(1);
    if (error) throw error;
    return data?.[0] ? normalizeBlogVersionRow(data[0]) : undefined;
  },

  async create(data: NewBlogVersion): Promise<BlogVersion> {
    const db = getDb() as any;
    const snakeData = toSnakeCase(data as unknown as Record<string, unknown>);
    console.log(`[blog-versions] create project=${(data as any).projectId} version=${(data as any).versionNumber} snakeData keys:`, Object.keys(snakeData));
    const { data: created, error } = await db
      .from("blog_versions")
      .insert(snakeData)
      .select()
      .single();
    if (error) {
      console.error(`[blog-versions] create error:`, error);
      throw error;
    }
    console.log(`[blog-versions] created: id=${(created as any)?.id} version_number=${(created as any)?.version_number}`);
    return normalizeBlogVersionRow(created);
  },

  /**
   * Saves a generated English version and promotes projects.content in the
   * same database transaction. Version allocation happens while the project
   * row is locked, so concurrent English generations cannot allocate or
   * promote out of order.
   */
  async createEnglishVersionAtomically(data: AtomicEnglishBlogVersion): Promise<BlogVersion> {
    const db = getDb() as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>;
    };
    const { data: created, error } = await db.rpc("save_generated_english_blog_version", {
      p_project_id: data.projectId,
      p_user_id: data.userId,
      p_payload: data,
    });
    if (error) throw error;

    const rawRow = Array.isArray(created) ? created[0] : created;
    if (!rawRow || typeof rawRow !== "object") {
      throw new Error("Atomic English blog-version save returned an invalid result");
    }
    return normalizeBlogVersionRow(rawRow);
  },

  async update(id: number, data: Partial<NewBlogVersion>): Promise<BlogVersion> {
    const db = getDb() as any;
    const snakeData = toSnakeCase(data as unknown as Record<string, unknown>);
    const { data: updated, error } = await db
      .from("blog_versions")
      .update(snakeData)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return normalizeBlogVersionRow(updated);
  },

  async delete(id: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("blog_versions")
      .delete()
      .eq("id", id);
    if (error) throw error;
  },

  async getNextVersionNumber(projectId: number): Promise<number> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_versions")
      .select("version_number")
      .eq("project_id", projectId);
    if (error) throw error;
    const versions: number[] = (data ?? []).map((r: any) => r.version_number ?? 0);
    const maxVersion = versions.length > 0 ? Math.max(...versions) : 0;
    console.log(`[blog-versions] getNextVersionNumber for project ${projectId}: existing=${JSON.stringify(versions)}, max=${maxVersion}, next=${maxVersion + 1}`);
    return maxVersion + 1;
  },

  /**
   * Atomically points projects.content at the latest committed version.
   *
   * The database function locks the project row before selecting the latest
   * version, so two generation requests cannot leave projects.content pointing
   * at an older version merely because their HTTP handlers completed out of
   * order. The fallback is used only when the project has no saved version.
   */
  async synchronizeProjectContentToLatestEnglish(
    projectId: number,
    userId: string,
    fallbackContent: string,
  ): Promise<ProjectContentSyncResult> {
    const db = getDb() as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>;
    };
    const { data, error } = await db.rpc("sync_project_content_to_latest_english_blog_version", {
      p_project_id: projectId,
      p_user_id: userId,
      p_fallback_content: fallbackContent,
    });
    if (error) throw error;

    const rawRow = Array.isArray(data) ? data[0] : data;
    const row = rawRow && typeof rawRow === "object"
      ? rawRow as Record<string, unknown>
      : null;
    if (!row || typeof row.blog !== "string") {
      throw new Error("Project content synchronization returned an invalid result");
    }
    return {
      versionId: row.version_id === null || row.version_id === undefined
        ? null
        : toFiniteNumber(row.version_id, "synchronized version id"),
      versionNumber: row.version_number === null || row.version_number === undefined
        ? null
        : toFiniteNumber(row.version_number, "synchronized version number"),
      blog: row.blog,
    };
  },
};
