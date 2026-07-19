import { getDb } from "@/db";
import type { Image, NewImage } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const imageRepository = {
  async findByProject(projectId: number): Promise<Image[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("images")
      .select("*")
      .eq("project_id", projectId)
      .order("id");
    if (error) throw error;
    return data;
  },

  async findByProjectAndType(projectId: number, type: string): Promise<Image[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("images")
      .select("*")
      .eq("project_id", projectId)
      .eq("type", type)
      .order("id");
    if (error) throw error;
    return data;
  },

  async create(data: NewImage): Promise<Image> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("images")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async update(id: number, data: Partial<NewImage>): Promise<Image | undefined> {
    const db = getDb() as any;
    const { data: updated, error } = await db
      .from("images")
      .update(toSnakeCase(data as Record<string, unknown>))
      .eq("id", id)
      .select();
    if (error) throw error;
    return updated?.[0];
  },

  async deleteByProject(projectId: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("images")
      .delete()
      .eq("project_id", projectId);
    if (error) throw error;
  },
};
