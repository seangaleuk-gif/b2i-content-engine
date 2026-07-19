import { getDb } from "@/db";
import type { PromptSection, NewPromptSection } from "@/db/schema/prompt-sections";
import { DEFAULT_PROMPTS } from "@/lib/services/default-prompts";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const promptSectionRepository = {
  async findByUser(userId: string): Promise<PromptSection[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("prompt_sections")
      .select("*")
      .eq("user_id", userId)
      .order("section_key");
    if (error) throw error;

    const seen = new Map<string, PromptSection>();
    for (const row of (data as Record<string, unknown>[]) ?? []) {
      const key = row.section_key as string;
      if (!seen.has(key)) {
        seen.set(key, row as unknown as PromptSection);
      }
    }
    return Array.from(seen.values());
  },

  async findByUserAndKey(userId: string, sectionKey: string): Promise<PromptSection | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("prompt_sections")
      .select("*")
      .eq("user_id", userId)
      .eq("section_key", sectionKey)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data as Record<string, unknown>[])?.[0] as unknown as PromptSection | undefined;
  },

  async upsert(userId: string, sectionKey: string, content: string): Promise<PromptSection> {
    const db = getDb() as any;

    const { data: existingRows } = await db
      .from("prompt_sections")
      .select("id")
      .eq("user_id", userId)
      .eq("section_key", sectionKey)
      .order("id");

    const rows = (existingRows as { id: number }[]) ?? [];

    if (rows.length > 1) {
      const [keep, ...dupes] = rows;
      for (const dupe of dupes) {
        await db.from("prompt_sections").delete().eq("id", dupe.id);
      }
    }

    if (rows.length > 0) {
      const { data, error } = await db
        .from("prompt_sections")
        .update({ content, updated_at: new Date().toISOString() })
        .eq("id", rows[0].id)
        .select()
        .single();
      if (error) throw error;
      return data as PromptSection;
    }

    const { data, error } = await db
      .from("prompt_sections")
      .insert(
        toSnakeCase({
          userId,
          sectionKey,
          content,
        } as Record<string, unknown>)
      )
      .select()
      .single();
    if (error) throw error;
    return data as PromptSection;
  },

  async seedDefaults(userId: string): Promise<void> {
    for (const [key, content] of Object.entries(DEFAULT_PROMPTS)) {
      await this.upsert(userId, key, content);
    }
  },
};
