import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const seoChecks = pgTable("seo_checks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("pending"),
  score: integer("score"),
  fix: text("fix").notNull().default(""),
  category: text("category").notNull().default("general"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SeoCheck = typeof seoChecks.$inferSelect;
export type NewSeoCheck = typeof seoChecks.$inferInsert;
