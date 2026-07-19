import { pgTable, serial, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const promptSections = pgTable("prompt_sections", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  sectionKey: text("section_key").notNull(),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PromptSection = typeof promptSections.$inferSelect;
export type NewPromptSection = typeof promptSections.$inferInsert;
