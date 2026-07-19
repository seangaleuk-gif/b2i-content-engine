import { getDb } from "@/db";
import type { ActivityLogEntry, NewActivityLogEntry } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const activityRepository = {
  async findByUser(userId: string, limit = 20): Promise<ActivityLogEntry[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("activity_log")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  },

  async create(data: NewActivityLogEntry): Promise<ActivityLogEntry> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("activity_log")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async deleteByProject(projectId: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("activity_log")
      .delete()
      .eq("project_id", projectId);
    if (error) throw error;
  },
};
