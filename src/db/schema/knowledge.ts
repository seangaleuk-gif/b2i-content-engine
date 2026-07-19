import { pgTable, serial, uuid, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const knowledgeItems = pgTable("knowledge_items", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnowledgeItem = typeof knowledgeItems.$inferSelect;
export type NewKnowledgeItem = typeof knowledgeItems.$inferInsert;
