import { getDb } from "@/db";
import type { SocialPost, NewSocialPost } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const socialRepository = {
  async findByProject(projectId: number): Promise<SocialPost[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("social_posts")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async findByProjectAndPlatform(projectId: number, platform: string): Promise<SocialPost[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("social_posts")
      .select("*")
      .eq("project_id", projectId)
      .eq("platform", platform)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async create(data: NewSocialPost): Promise<SocialPost> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("social_posts")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async createMany(items: NewSocialPost[]): Promise<SocialPost[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("social_posts")
      .insert(items.map((item) => toSnakeCase(item as Record<string, unknown>)))
      .select();
    if (error) throw error;
    return data;
  },

  async update(id: number, data: Partial<NewSocialPost>): Promise<SocialPost | undefined> {
    const db = getDb() as any;
    const { data: updated, error } = await db
      .from("social_posts")
      .update(toSnakeCase(data as Record<string, unknown>))
      .eq("id", id)
      .select();
    if (error) throw error;
    return updated?.[0];
  },

  async deleteByProject(projectId: number): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("social_posts")
      .delete()
      .eq("project_id", projectId);
    if (error) throw error;
  },
};
