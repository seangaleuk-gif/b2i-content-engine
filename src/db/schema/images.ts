import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const images = pgTable("images", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  type: text("type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  prompt: text("prompt").notNull().default(""),
  url: text("url"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
