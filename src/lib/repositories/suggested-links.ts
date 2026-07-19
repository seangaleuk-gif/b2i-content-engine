import { getDb } from "@/db";
import type { SuggestedLink, NewSuggestedLink } from "@/db/schema";
import { internalLinksRepository } from "./internal-links";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const suggestedLinksRepository = {
  async findByUser(userId: string): Promise<SuggestedLink[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("suggested_links")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async findPendingByUser(userId: string): Promise<SuggestedLink[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("suggested_links")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async create(data: NewSuggestedLink): Promise<SuggestedLink> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("suggested_links")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async approve(id: number): Promise<void> {
    const db = getDb() as any;

    const { data: suggestion, error: fetchError } = await db
      .from("suggested_links")
      .select("*")
      .eq("id", id)
      .single();
    if (fetchError) throw fetchError;

    const { error: updateError } = await db
      .from("suggested_links")
      .update({ status: "approved", updated_at: new Date() })
      .eq("id", id);
    if (updateError) throw updateError;

    await internalLinksRepository.create({
      createdBy: suggestion.user_id,
      displayText: suggestion.phrase,
      urlSlug: suggestion.suggested_url,
      keywords: [],
      priority: 2,
      minPerArticle: 1,
      maxPerArticle: 3,
      active: true,
    });
  },

  async reject(id: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("suggested_links")
      .update({ status: "rejected", updated_at: new Date() })
      .eq("id", id);
    if (error) throw error;
  },

  async delete(id: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("suggested_links")
      .delete()
      .eq("id", id);
    if (error) throw error;
  },
};
