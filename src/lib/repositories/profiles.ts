import { getDb } from "@/db";
import type { Profile, NewProfile } from "@/db/schema";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const profileRepository = {
  async findById(userId: string): Promise<Profile | undefined> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .limit(1);
    if (error) throw error;
    return data?.[0];
  },

  async create(data: NewProfile): Promise<Profile> {
    const db = getDb() as any;
    const { data: created, error } = await db
      .from("profiles")
      .insert(toSnakeCase(data as Record<string, unknown>))
      .select()
      .single();
    if (error) throw error;
    return created;
  },

  async update(userId: string, data: Partial<NewProfile>): Promise<Profile | undefined> {
    const db = getDb() as any;
    const snakeData = toSnakeCase(data as Record<string, unknown>);
    snakeData.updated_at = new Date();
    const { data: updated, error } = await db
      .from("profiles")
      .update(snakeData)
      .eq("id", userId)
      .select();
    if (error) throw error;
    return updated?.[0];
  },

  async findOrCreate(userId: string, data: Partial<NewProfile> = {}): Promise<Profile> {
    const existing = await profileRepository.findById(userId);
    if (existing) {
      const name = (existing as Record<string, unknown>).full_name as string;
      if (!name || name.trim() === "") {
        await profileRepository.update(userId, { fullName: data.fullName ?? "User" } as Partial<NewProfile>);
        (existing as Record<string, unknown>).full_name = (data.fullName ?? "User");
      }
      return existing;
    }

    return profileRepository.create({
      id: userId,
      fullName: data.fullName ?? "User",
      role: data.role ?? "editor",
      avatarUrl: data.avatarUrl ?? null,
      apiCreditsUsed: 0,
      apiCreditsLimit: 10000,
      storageUsedBytes: 0,
      storageLimitBytes: 5368709120,
    });
  },
};
