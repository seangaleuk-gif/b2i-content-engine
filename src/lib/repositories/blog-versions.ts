import { getDb } from "@/db";
import type { BlogVersion, NewBlogVersion } from "@/db/schema/blog-versions";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const blogVersionRepository = {
  async findByProject(projectId: number): Promise<BlogVersion[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_versions")
      .select("*")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false });
    if (error) throw error;
    return data;
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
    return data?.[0];
  },

  async create(data: NewBlogVersion): Promise<BlogVersion> {
    const db = getDb() as any;
    const snakeData = toSnakeCase(data as Record<string, unknown>);
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
    return created;
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
};
