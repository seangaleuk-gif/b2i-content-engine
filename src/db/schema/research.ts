import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const researchSources = pgTable("research_sources", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  category: text("category").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  snippet: text("snippet").notNull().default(""),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ResearchSource = typeof researchSources.$inferSelect;
export type NewResearchSource = typeof researchSources.$inferInsert;
