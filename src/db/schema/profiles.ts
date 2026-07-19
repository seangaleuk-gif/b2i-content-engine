import { pgTable, uuid, text, integer, bigint, timestamp } from "drizzle-orm/pg-core";

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  avatarUrl: text("avatar_url"),
  role: text("role").notNull().default("editor"),
  apiCreditsUsed: integer("api_credits_used").notNull().default(0),
  apiCreditsLimit: integer("api_credits_limit").notNull().default(10000),
  storageUsedBytes: bigint("storage_used_bytes", { mode: "number" }).notNull().default(0),
  storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" }).notNull().default(5368709120),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
