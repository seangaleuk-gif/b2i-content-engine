import { getDb } from "@/db";

function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[snakeKey] = value;
  }
  return out;
}

export const generationAnalyticsRepository = {
  async insert(record: Record<string, unknown>): Promise<void> {
    const db = getDb() as any;
    const { error } = await db
      .from("blog_generation_analytics")
      .insert(toSnakeCase(record));
    if (error) {
      console.error("[analytics:insert] Failed:", error.message);
    }
  },

  async getRecent(limit = 50): Promise<Record<string, unknown>[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_generation_analytics")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[analytics:getRecent] Failed:", error.message);
      return [];
    }
    return data || [];
  },

  async getStats(): Promise<{
    total: number;
    avgQuality: number;
    avgTime: number;
    avgWords: number;
    avgRetries: number;
    avgSemanticWarnings: number;
    totalFailures: number;
  }> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_generation_analytics")
      .select("quality_score, generation_time_ms, actual_word_count, retry_count, semantic_warning_count, semantic_error_count, unrecovered_parallel_tasks");
    if (error || !data) return { total: 0, avgQuality: 0, avgTime: 0, avgWords: 0, avgRetries: 0, avgSemanticWarnings: 0, totalFailures: 0 };

    const rows = data as Record<string, unknown>[];
    const total = rows.length;
    if (total === 0) return { total: 0, avgQuality: 0, avgTime: 0, avgWords: 0, avgRetries: 0, avgSemanticWarnings: 0, totalFailures: 0 };

    const avg = (f: string) => Math.round(rows.reduce((s: number, r: Record<string, unknown>) => s + (Number(r[f]) || 0), 0) / total);
    return { total, avgQuality: avg("quality_score"), avgTime: avg("generation_time_ms"), avgWords: avg("actual_word_count"), avgRetries: avg("retry_count"), avgSemanticWarnings: avg("semantic_warning_count"), totalFailures: rows.filter((r: Record<string, unknown>) => (Number(r.unrecovered_parallel_tasks) || 0) > 0 || (Number(r.semantic_error_count) || 0) > 0).length };
  },

  async getVersionComparison(): Promise<{ version: string; count: number; avgQuality: number; avgTime: number; avgRetries: number }[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_generation_analytics")
      .select("pipeline_version, quality_score, generation_time_ms, retry_count");
    if (error || !data) return [];

    const rows = data as Record<string, unknown>[];
    const groups = new Map<string, { q: number[]; t: number[]; r: number[] }>();
    for (const r of rows) {
      const v = String(r.pipeline_version || "unknown");
      const g = groups.get(v) || { q: [], t: [], r: [] };
      g.q.push(Number(r.quality_score) || 0);
      g.t.push(Number(r.generation_time_ms) || 0);
      g.r.push(Number(r.retry_count) || 0);
      groups.set(v, g);
    }

    return [...groups.entries()].map(([v, g]) => ({
      version: v,
      count: g.q.length,
      avgQuality: Math.round(g.q.reduce((s, x) => s + x, 0) / g.q.length),
      avgTime: Math.round(g.t.reduce((s, x) => s + x, 0) / g.t.length),
      avgRetries: Math.round((g.r.reduce((s, x) => s + x, 0) / g.r.length) * 10) / 10,
    })).sort((a, b) => a.version.localeCompare(b.version));
  },

  async getRecentRows(limit = 100): Promise<Record<string, unknown>[]> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_generation_analytics")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  },

  async getAggregatedScores(): Promise<{ avgSeo: number; avgReadability: number; avgStructure: number; avgFormatting: number; avgContent: number }> {
    const db = getDb() as any;
    const { data, error } = await db
      .from("blog_generation_analytics")
      .select("seo_score, readability_score, structure_score, formatting_score, content_score");
    if (error || !data) return { avgSeo: 0, avgReadability: 0, avgStructure: 0, avgFormatting: 0, avgContent: 0 };

    const rows = data as Record<string, unknown>[];
    const n = rows.length;
    if (n === 0) return { avgSeo: 0, avgReadability: 0, avgStructure: 0, avgFormatting: 0, avgContent: 0 };

    const avg = (f: string) => Math.round(rows.reduce((s: number, r: Record<string, unknown>) => s + (Number(r[f]) || 0), 0) / n);
    return { avgSeo: avg("seo_score"), avgReadability: avg("readability_score"), avgStructure: avg("structure_score"), avgFormatting: avg("formatting_score"), avgContent: avg("content_score") };
  },
};
