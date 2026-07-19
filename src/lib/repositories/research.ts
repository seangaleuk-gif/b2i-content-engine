import { getDb } from "@/db";
import type { ResearchSource, NewResearchSource } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const researchRepository = {
  async findByProject(projectId: number): Promise<ResearchSource[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("research_sources")
      .select("*")
      .eq("project_id", projectId)
      .order("position");
    if (error) throw error;
    return data;
  },

  async findByProjectAndCategory(projectId: number, category: string): Promise<ResearchSource[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("research_sources")
      .select("*")
      .eq("project_id", projectId)
      .eq("category", category)
      .order("position");
    if (error) throw error;
    return data;
  },

  async create(data: NewResearchSource): Promise<ResearchSource> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("research_sources")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async createMany(items: NewResearchSource[]): Promise<ResearchSource[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("research_sources")
      .insert(items.map((item) => toSnakeCase(item as Record<string, unknown>)))
      .select();
    if (error) throw error;
    return data;
  },

  async deleteByProject(projectId: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("research_sources")
      .delete()
      .eq("project_id", projectId);
    if (error) throw error;
  },
};
