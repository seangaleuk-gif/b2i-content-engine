import { getDb } from "@/db";
import type { Project, NewProject } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const projectRepository = {
  async findByUser(userId: string): Promise<Project[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("projects")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data as Project[];
  },

  async findById(id: number): Promise<Project | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("projects")
      .select("*")
      .eq("id", id)
      .limit(1);
    if (error) throw error;
    return data?.[0] as Project | undefined;
  },

  async findByIdAndUser(id: number, userId: string): Promise<Project | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("projects")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .limit(1);
    if (error) throw error;
    return data?.[0] as Project | undefined;
  },

  async create(data: NewProject): Promise<Project> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("projects")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created as Project;
  },

  async update(id: number, data: Partial<NewProject>): Promise<Project | undefined> {
    const db = getDb() as any;
    const snakeData = toSnakeCase(data as Record<string, unknown>);
    snakeData.updated_at = new Date();
    const { data: updated, error } = await db
      .from("projects")
      .update(snakeData)
      .eq("id", id)
      .select();
    if (error) throw error;
    return updated?.[0] as Project | undefined;
  },

  async delete(id: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db.from("projects").delete().eq("id", id);
    if (error) throw error;
  },

  async countByUser(userId: string): Promise<number> {
    const db = getDb() as any;
    const { count, error } = await db
      .from("projects")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) throw error;
    return count ?? 0;
  },

  async countByUserAndStatus(userId: string, status: string): Promise<number> {
    const db = getDb() as any;
    const { count, error } = await db
      .from("projects")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", status);
    if (error) throw error;
    return count ?? 0;
  },
};
