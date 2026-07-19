import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const socialPosts = pgTable("social_posts", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  platform: text("platform").notNull(),
  content: text("content").notNull().default(""),
  characterCount: integer("character_count").notNull().default(0),
  hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SocialPost = typeof socialPosts.$inferSelect;
export type NewSocialPost = typeof socialPosts.$inferInsert;
