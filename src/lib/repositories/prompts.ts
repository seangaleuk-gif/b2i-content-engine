import { getDb } from "@/db";
import type { Prompt, NewPrompt } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const promptRepository = {
  async findByUser(userId: string): Promise<Prompt[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("prompts")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async findById(id: number): Promise<Prompt | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("prompts")
      .select("*")
      .eq("id", id)
      .limit(1);
    if (error) throw error;
    return data?.[0];
  },

  async findByIdAndUser(id: number, userId: string): Promise<Prompt | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("prompts")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .limit(1);
    if (error) throw error;
    return data?.[0];
  },

  async create(data: NewPrompt): Promise<Prompt> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("prompts")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async update(id: number, data: Partial<NewPrompt>): Promise<Prompt | undefined> {
    const db = getDb() as any;
    const snakeData = toSnakeCase(data as Record<string, unknown>);
    snakeData.updated_at = new Date();
    const { data: updated, error } = await db
      .from("prompts")
      .update(snakeData)
      .eq("id", id)
      .select();
    if (error) throw error;
    return updated?.[0];
  },

  async delete(id: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("prompts")
      .delete()
      .eq("id", id);
    if (error) throw error;
  },
};
