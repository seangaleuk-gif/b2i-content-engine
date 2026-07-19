import { pgTable, serial, uuid, integer, text, timestamp } from "drizzle-orm/pg-core";

export const aiLogs = pgTable("ai_logs", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  projectId: integer("project_id"),
  model: text("model").notNull(),
  promptSize: integer("prompt_size"),
  completionSize: integer("completion_size"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  tokensTotal: integer("tokens_total"),
  generationTimeMs: integer("generation_time_ms"),
  status: text("status").notNull().default("success"),
  errorMessage: text("error_message"),
  endpoint: text("endpoint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiLog = typeof aiLogs.$inferSelect;
export type NewAiLog = typeof aiLogs.$inferInsert;
