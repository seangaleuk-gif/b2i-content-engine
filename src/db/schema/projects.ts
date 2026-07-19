import { pgTable, serial, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  keyword: text("keyword").notNull().default(""),
  audience: text("audience").notNull().default(""),
  country: text("country").notNull().default("US"),
  wordCount: integer("word_count").notNull().default(2500),
  content: text("content").default(""),
  seoScore: integer("seo_score"),
  publishedUrl: text("published_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
