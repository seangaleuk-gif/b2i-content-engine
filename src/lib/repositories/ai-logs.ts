import { getDb } from "@/db";
import type { AiLog, NewAiLog } from "@/db/schema/ai-logs";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const aiLogRepository = {
  async findByUser(userId: string, limit = 50): Promise<AiLog[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("ai_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  },

  async create(data: NewAiLog): Promise<AiLog> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("ai_logs")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },
};
