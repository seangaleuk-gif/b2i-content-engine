import { generationAnalyticsRepository } from "@/lib/repositories";

export interface PromptRecommendation {
  category: "seo" | "content" | "performance" | "reliability" | "structure";
  priority: "low" | "medium" | "high";
  title: string;
  description: string;
  evidence: string;
}

export interface LearningReport {
  summary: {
    articles: number;
    averageQuality: number;
    averageGenerationTime: number;
    averageWords: number;
    averageRetries: number;
  };
  recommendations: PromptRecommendation[];
  trends: {
    quality: number[];
    generationTime: number[];
    retries: number[];
  };
  versionComparison: {
    version: string;
    count: number;
    avgQuality: number;
    avgTime: number;
    avgRetries: number;
  }[];
  scores: {
    avgSeo: number;
    avgReadability: number;
    avgStructure: number;
    avgFormatting: number;
    avgContent: number;
  };
}

export async function generateLearningReport(): Promise<LearningReport> {
  const [stats, versionComparison, recentRows, scores] = await Promise.all([
    generationAnalyticsRepository.getStats(),
    generationAnalyticsRepository.getVersionComparison(),
    generationAnalyticsRepository.getRecentRows(100),
    generationAnalyticsRepository.getAggregatedScores(),
  ]);

  const recs = buildRecommendations(stats, recentRows, scores, versionComparison);
  const trends = buildTrends(recentRows);

  return {
    summary: {
      articles: stats.total,
      averageQuality: stats.avgQuality,
      averageGenerationTime: stats.avgTime,
      averageWords: stats.avgWords,
      averageRetries: stats.avgRetries,
    },
    recommendations: recs,
    trends,
    versionComparison,
    scores,
  };
}

// ── Recommendation engine ──

function buildRecommendations(
  stats: { total: number; avgQuality: number; avgTime: number; avgWords: number; avgRetries: number; avgSemanticWarnings: number; totalFailures: number },
  recentRows: Record<string, unknown>[],
  scores: { avgSeo: number; avgReadability: number; avgStructure: number; avgFormatting: number; avgContent: number },
  versionComparison: { version: string; count: number; avgQuality: number; avgTime: number; avgRetries: number }[],
): PromptRecommendation[] {
  const recs: PromptRecommendation[] = [];

  // SEO
  if (scores.avgSeo < 22) {
    recs.push({ category: "seo", priority: "high", title: "SEO score below target", description: `Average SEO score is ${scores.avgSeo}/30 across ${stats.total} articles.`, evidence: `Target: 26/30. Actual: ${scores.avgSeo}/30.` });
  } else if (scores.avgSeo < 26) {
    recs.push({ category: "seo", priority: "medium", title: "SEO score borderline", description: `Average SEO score is ${scores.avgSeo}/30. Room for improvement.`, evidence: `Target: 26+/30. Current: ${scores.avgSeo}/30.` });
  }

  // Readability
  if (scores.avgReadability < 14) {
    recs.push({ category: "content", priority: "high", title: "Readability consistently below target", description: `Average readability score is ${scores.avgReadability}/20.`, evidence: `Target: 16+/20. Actual: ${scores.avgReadability}/20. Consider simpler sentence guidance.` });
  }

  // Word count
  if (stats.avgWords < 1500 && stats.total > 5) {
    recs.push({ category: "content", priority: "high", title: "Word count consistently below target", description: `Average word count is ${stats.avgWords} across ${stats.total} articles.`, evidence: `Expected: 2000+. Actual: ${stats.avgWords}. Consider increasing per-section word targets.` });
  }

  // Retries
  if (stats.avgRetries > 2) {
    recs.push({ category: "reliability", priority: "high", title: "High retry rate", description: `Average ${stats.avgRetries.toFixed(1)} retries per generation.`, evidence: `Acceptable: <1.5. Actual: ${stats.avgRetries.toFixed(1)}. Review section and readability prompts.` });
  } else if (stats.avgRetries > 1) {
    recs.push({ category: "reliability", priority: "medium", title: "Moderate retry rate", description: `Average ${stats.avgRetries.toFixed(1)} retries per generation.`, evidence: `Target: <1. Current: ${stats.avgRetries.toFixed(1)}.` });
  }

  // Semantic warnings
  if (stats.avgSemanticWarnings > 3 && stats.total > 10) {
    recs.push({ category: "content", priority: "medium", title: "Frequent semantic warnings", description: `Average ${stats.avgSemanticWarnings} semantic warnings per article.`, evidence: `Acceptable: <2. Actual: ${stats.avgSemanticWarnings}. Review section guidance and anti-duplication instructions.` });
  }

  // Failure rate
  if (stats.total > 10 && stats.totalFailures / stats.total > 0.1) {
    recs.push({ category: "reliability", priority: "high", title: "Generation failure rate above 10%", description: `${stats.totalFailures}/${stats.total} articles had unrecovered failures.`, evidence: `Acceptable: <5%. Actual: ${Math.round(stats.totalFailures / stats.total * 100)}%.` });
  }

  // Formatting
  if (scores.avgFormatting < 10) {
    recs.push({ category: "structure", priority: "medium", title: "Formatting score low", description: `Average formatting score is ${scores.avgFormatting}/15.`, evidence: `Target: 12+/15. WordPress blocks or FAQ schema may be failing.` });
  }

  // Structure
  if (scores.avgStructure < 16) {
    recs.push({ category: "structure", priority: "medium", title: "Structure score below target", description: `Average structure score is ${scores.avgStructure}/20.`, evidence: `Target: 18+/20. Check H2 count, FAQ count, CTA, and language switcher.` });
  }

  // Content score
  if (scores.avgContent < 8) {
    recs.push({ category: "content", priority: "high", title: "Content score critically low", description: `Average content score is ${scores.avgContent}/15.`, evidence: `Word count, keyphrase density, or external links are frequently failing.` });
  }

  // Performance regression (version comparison)
  if (versionComparison.length >= 2) {
    const latest = versionComparison[versionComparison.length - 1];
    const previous = versionComparison[versionComparison.length - 2];
    if (latest.avgTime > previous.avgTime * 1.15) {
      const pct = Math.round((latest.avgTime / previous.avgTime - 1) * 100);
      recs.push({ category: "performance", priority: "medium", title: "Generation time regression", description: `${latest.version} is ${pct}% slower than ${previous.version} (${latest.avgTime}ms vs ${previous.avgTime}ms).`, evidence: `Regression detected across ${latest.count} articles. Review recent pipeline changes.` });
    }
    if (latest.avgQuality < previous.avgQuality - 2) {
      recs.push({ category: "content", priority: "high", title: "Quality score regression", description: `${latest.version} quality dropped from ${previous.avgQuality} to ${latest.avgQuality}.`, evidence: `Quality decrease across ${latest.count} articles. Review recent changes.` });
    }
  }

  // Performance (absolute)
  if (stats.avgTime > 30000 && stats.total > 5) {
    recs.push({ category: "performance", priority: "low", title: "Generation time above 30s", description: `Average generation takes ${(stats.avgTime / 1000).toFixed(1)}s.`, evidence: `Target: <20s. Consider parallelization improvements or reducing API calls.` });
  }

  return recs;
}

// ── Trend analysis ──

function buildTrends(recentRows: Record<string, unknown>[]): { quality: number[]; generationTime: number[]; retries: number[] } {
  const quality: number[] = [];
  const generationTime: number[] = [];
  const retries: number[] = [];

  // Calculate rolling averages (window of 5)
  const window = 5;
  for (let i = 0; i <= recentRows.length - window; i++) {
    const slice = recentRows.slice(i, i + window);
    quality.push(Math.round(slice.reduce((s, r) => s + (Number(r.quality_score) || 0), 0) / window));
    generationTime.push(Math.round(slice.reduce((s, r) => s + (Number(r.generation_time_ms) || 0), 0) / window));
    retries.push(Math.round(slice.reduce((s, r) => s + (Number(r.retry_count) || 0), 0) / window * 10) / 10);
  }

  return { quality, generationTime, retries };
}
