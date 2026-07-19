import { getDb } from "@/db";
import type { SeoCheck, NewSeoCheck } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const seoRepository = {
  async findByProject(projectId: number): Promise<SeoCheck[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("seo_checks")
      .select("*")
      .eq("project_id", projectId)
      .order("id");
    if (error) throw error;
    return data;
  },

  async findByProjectAndCategory(projectId: number, category: string): Promise<SeoCheck[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("seo_checks")
      .select("*")
      .eq("project_id", projectId)
      .eq("category", category)
      .order("id");
    if (error) throw error;
    return data;
  },

  async create(data: NewSeoCheck): Promise<SeoCheck> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("seo_checks")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async createMany(items: NewSeoCheck[]): Promise<SeoCheck[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("seo_checks")
      .insert(items.map((item) => toSnakeCase(item as Record<string, unknown>)))
      .select();
    if (error) throw error;
    return data;
  },

  async update(id: number, data: Partial<NewSeoCheck>): Promise<SeoCheck | undefined> {
    const db = getDb() as any;
    const { data: updated, error } = await db
      .from("seo_checks")
      .update(toSnakeCase(data as Record<string, unknown>))
      .eq("id", id)
      .select();
    if (error) throw error;
    return updated?.[0];
  },

  async deleteByProject(projectId: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("seo_checks")
      .delete()
      .eq("project_id", projectId);
    if (error) throw error;
  },
};
