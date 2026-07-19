import { getDb } from "@/db";
import type { InternalLink, NewInternalLink } from "@/db/schema";

export const internalLinksRepository = {
  async findByUser(userId: string): Promise<InternalLink[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("internal_links")
      .select("*")
      .eq("created_by", userId)
      .order("priority", { ascending: false });
    if (error) throw error;
    return data;
  },

  async findActiveByUser(userId: string): Promise<InternalLink[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("internal_links")
      .select("*")
      .eq("created_by", userId)
      .eq("active", true)
      .order("priority", { ascending: false });
    if (error) throw error;
    return data;
  },

  async create(data: NewInternalLink): Promise<InternalLink> {
    const db = getDb() as any;
    const record = data as Record<string, unknown>;
    const { data: created, error } = await db
      .from("internal_links")
      .insert({
        created_by: record.userId ?? record.created_by,
        display_text: record.displayText ?? record.display_text,
        url_slug: record.urlSlug ?? record.url_slug,
        keywords: record.keywords ?? [],
        priority: record.priority ?? 2,
        min_per_article: record.minPerArticle ?? record.min_per_article ?? 1,
        max_per_article: record.maxPerArticle ?? record.max_per_article ?? 3,
        active: record.active ?? true,
      })
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async update(id: number, data: Partial<NewInternalLink>): Promise<InternalLink> {
    const db = getDb() as any;
    const record = data as Record<string, unknown>;
    const snakeData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (record.displayText !== undefined || record.display_text !== undefined) snakeData.display_text = record.displayText ?? record.display_text;
    if (record.urlSlug !== undefined || record.url_slug !== undefined) snakeData.url_slug = record.urlSlug ?? record.url_slug;
    if (record.keywords !== undefined) snakeData.keywords = record.keywords;
    if (record.priority !== undefined) snakeData.priority = record.priority;
    if (record.minPerArticle !== undefined || record.min_per_article !== undefined) snakeData.min_per_article = record.minPerArticle ?? record.min_per_article;
    if (record.maxPerArticle !== undefined || record.max_per_article !== undefined) snakeData.max_per_article = record.maxPerArticle ?? record.max_per_article;
    if (record.active !== undefined) snakeData.active = record.active;
    const { data: updated, error } = await db
      .from("internal_links")
      .update(snakeData)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return updated;
  },

  async delete(id: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db.from("internal_links").delete().eq("id", id);
    if (error) throw error;
  },

  async findBySlug(urlSlug: string): Promise<InternalLink | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("internal_links")
      .select("*")
      .eq("url_slug", urlSlug)
      .limit(1);
    if (error) throw error;
    return data?.[0];
  },
};
