import { pgTable, serial, uuid, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const internalLinks = pgTable("internal_links", {
  id: serial("id").primaryKey(),
  createdBy: uuid("created_by").notNull(),
  displayText: text("display_text").notNull(),
  urlSlug: text("url_slug").notNull(),
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  priority: integer("priority").notNull().default(1),
  minPerArticle: integer("min_per_article").notNull().default(1),
  maxPerArticle: integer("max_per_article").notNull().default(3),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InternalLink = typeof internalLinks.$inferSelect;
export type NewInternalLink = typeof internalLinks.$inferInsert;
