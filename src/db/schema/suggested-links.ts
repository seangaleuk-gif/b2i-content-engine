import { pgTable, serial, uuid, integer, text, real, jsonb, timestamp } from "drizzle-orm/pg-core";

export const suggestedLinks = pgTable("suggested_links", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  phrase: text("phrase").notNull(),
  suggestedUrl: text("suggested_url").notNull(),
  sourceContent: text("source_content"),
  projectId: integer("project_id"),
  confidence: real("confidence").notNull().default(0.5),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SuggestedLink = typeof suggestedLinks.$inferSelect;
export type NewSuggestedLink = typeof suggestedLinks.$inferInsert;
