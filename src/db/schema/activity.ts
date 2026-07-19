import { pgTable, serial, uuid, integer, text, timestamp } from "drizzle-orm/pg-core";

export const activityLog = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  projectId: integer("project_id"),
  action: text("action").notNull(),
  description: text("description").notNull().default(""),
  type: text("type").notNull().default("general"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;
