import { pgTable, serial, uuid, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const blogVersions = pgTable("blog_versions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  userId: uuid("user_id").notNull(),
  versionNumber: integer("version_number").notNull().default(1),
  title: text("title"),
  slug: text("slug"),
  metaDescription: text("meta_description"),
  excerpt: text("excerpt"),
  blog: text("blog"),
  faq: jsonb("faq").default([]),
  internalLinks: jsonb("internal_links").default([]),
  externalLinks: jsonb("external_links").default([]),
  categories: jsonb("categories").default([]),
  tags: jsonb("tags").default([]),
  readingTime: text("reading_time"),
  wordCount: integer("word_count").default(0),
  summary: text("summary"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  generationTimeMs: integer("generation_time_ms"),
  tokenUsage: jsonb("token_usage"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BlogVersion = typeof blogVersions.$inferSelect;
export type NewBlogVersion = typeof blogVersions.$inferInsert;
