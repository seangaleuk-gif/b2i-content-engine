import type { TelemetryReport } from "@/lib/services/generation-telemetry";
import type { QualityScore } from "@/lib/services/quality-scorer";
import { getCacheStats } from "@/lib/services/prompt-compiler";

export interface AnalyticsRecord {
  projectId: number;
  articleTitle: string;
  pipelineVersion: string;
  generationTimeMs: number;
  targetWordCount: number;
  actualWordCount: number;
  qualityScore: number;
  seoScore: number;
  readabilityScore: number;
  structureScore: number;
  formattingScore: number;
  contentScore: number;
  retryCount: number;
  componentRegenerations: number;
  recoveredParallelTasks: number;
  unrecoveredParallelTasks: number;
  semanticWarningCount: number;
  semanticErrorCount: number;
  aiCallCount: number;
  totalPromptChars: number;
  totalCompletionChars: number;
  outlineTimeMs: number;
  parallelTimeMs: number;
  parallelRecoveryTimeMs: number;
  faqTimeMs: number;
  regenerationTimeMs: number;
  topFailureReasons: string | null;
  warnings: string | null;
  extraMetrics: Record<string, unknown>;
}

function n(value: number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

function s(value: string | undefined | null): string | null {
  return value || null;
}

export function buildAnalyticsRecord(
  projectId: number,
  articleTitle: string,
  telemetry: TelemetryReport,
  qualityScore: QualityScore,
  targetWordCount: number,
  actualWordCount: number,
  warnings: string[],
  semanticWarnings: number,
  semanticErrors: number,
): AnalyticsRecord {
  const stage = telemetry.stageTimings;
  const promptChars = telemetry.aiCalls.reduce((s, c) => s + c.promptChars, 0);
  const completionChars = telemetry.aiCalls.reduce((s, c) => s + c.completionChars, 0);

  const failureReasons = telemetry.taskFailures
    .map((f) => `${f.stage}:${f.error.substring(0, 80)}`)
    .join("; ");

  return {
    projectId,
    articleTitle: s(articleTitle) || "Untitled",
    pipelineVersion: "14",
    generationTimeMs: n(telemetry.totalTimeMs),
    targetWordCount: n(targetWordCount),
    actualWordCount: n(actualWordCount),
    qualityScore: n(qualityScore.overall),
    seoScore: n(qualityScore.seo.score),
    readabilityScore: n(qualityScore.readability.score),
    structureScore: n(qualityScore.structure.score),
    formattingScore: n(qualityScore.formatting.score),
    contentScore: n(qualityScore.content.score),
    retryCount: n(telemetry.retryCount),
    componentRegenerations: n(telemetry.regenerations),
    recoveredParallelTasks: n(telemetry.recoveredTasks),
    unrecoveredParallelTasks: n(telemetry.unrecoveredTasks),
    semanticWarningCount: n(semanticWarnings),
    semanticErrorCount: n(semanticErrors),
    aiCallCount: telemetry.aiCalls.length,
    totalPromptChars: promptChars,
    totalCompletionChars: completionChars,
    outlineTimeMs: n(stage.outline),
    parallelTimeMs: n(stage.parallel_block),
    parallelRecoveryTimeMs: n(stage.parallel_recovery),
    faqTimeMs: n(stage.faq),
    regenerationTimeMs: n(stage.regeneration),
    topFailureReasons: s(failureReasons) || null,
    warnings: warnings.length > 0 ? s(warnings.join("; ")) : null,
    extraMetrics: { promptCache: getCacheStats() },
  };
}
