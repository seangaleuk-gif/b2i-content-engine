import { pgTable, serial, uuid, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export interface BlogFaqItem {
  question: string;
  answer: string;
}

export const blogVersions = pgTable("blog_versions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  userId: uuid("user_id").notNull(),
  versionNumber: integer("version_number").notNull().default(1),
  title: text("title"),
  slug: text("slug"),
  metaDescription: text("meta_description"),
  excerpt: text("excerpt"),
  blog: text("blog"),
  faq: jsonb("faq").$type<BlogFaqItem[]>().default([]),
  internalLinks: jsonb("internal_links").$type<string[]>().default([]),
  externalLinks: jsonb("external_links").$type<string[]>().default([]),
  categories: jsonb("categories").$type<string[]>().default([]),
  tags: jsonb("tags").$type<string[]>().default([]),
  readingTime: text("reading_time"),
  wordCount: integer("word_count").default(0),
  summary: text("summary"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  generationTimeMs: integer("generation_time_ms"),
  tokenUsage: jsonb("token_usage").$type<Record<string, unknown> | null>(),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface BlogVersion {
  id: number;
  projectId: number;
  userId: string;
  versionNumber: number;
  title: string | null;
  slug: string | null;
  metaDescription: string | null;
  excerpt: string | null;
  blog: string | null;
  faq: BlogFaqItem[];
  internalLinks: string[];
  externalLinks: string[];
  categories: string[];
  tags: string[];
  readingTime: string | null;
  wordCount: number | null;
  summary: string | null;
  model: string | null;
  promptVersion: string | null;
  generationTimeMs: number | null;
  tokenUsage: Record<string, unknown> | null;
  status: string;
  createdAt: Date;
}

export interface NewBlogVersion {
  projectId: number;
  userId: string;
  versionNumber?: number;
  title?: string | null;
  slug?: string | null;
  metaDescription?: string | null;
  excerpt?: string | null;
  blog?: string | null;
  faq?: BlogFaqItem[];
  internalLinks?: string[];
  externalLinks?: string[];
  categories?: string[];
  tags?: string[];
  readingTime?: string | null;
  wordCount?: number | null;
  summary?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  generationTimeMs?: number | null;
  tokenUsage?: Record<string, unknown> | null;
  status?: string;
  createdAt?: Date;
}
