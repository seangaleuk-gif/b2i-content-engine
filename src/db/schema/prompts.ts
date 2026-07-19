import { pgTable, serial, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const prompts = pgTable("prompts", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  name: text("name").notNull(),
  purpose: text("purpose").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  template: text("template").notNull(),
  variables: jsonb("variables").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
