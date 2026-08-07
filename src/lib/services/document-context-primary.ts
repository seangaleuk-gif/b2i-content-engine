// ── Controlled primary-path trial for the document-context translation ──
//
// When ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true, the verified
// document-context path becomes the SOLE Traditional Chinese translation path:
//   1. coherent document translation (~7 calls);
//   2. three existing bilingual editorial batches;
//   3. deterministic terminology cleanup;
//   4. deterministic CTA localization;
//   5. existing structural/factual validation;
//   6. the retained polished document is saved as the production Chinese version.
//
// The old 38-45-call pipeline is NOT deleted and NOT invoked in primary mode. A
// failure returns a clear error with the failed stage and safe diagnostics; it
// never saves, never falls back to the old pipeline, and never makes extra AI
// repair calls. Disabling the flag restores the old pipeline immediately.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import type { ChatMessage } from "@/lib/services/deepseek";
import { chineseLengthMetrics } from "./translation-validator";
import { deriveChineseKeyphrase } from "./translation-glossary";
import { buildFaqSchemaJson } from "./translation-assembler";
import type { TranslationResult } from "./translation-types";
import type { ShadowProviderResponse } from "./shadow-number-protection";
import { runDocumentContextTranslationShadow, type DocumentContextTranslationShadowResult } from "./document-context-translation-shadow";
import { analyzeDocQuality, emptyQualityReport } from "./shadow-cantonese-quality";
import { runEditorialReview, isFullDocumentZhReviewEnabled } from "./document-context-editorial-review";
import { buildTranslationSourceDocument } from "./translation-source-document";
import { buildZhHkStyleContract } from "./zh-hk-style-contract";
import { analyzeZhHkLanguageQuality } from "./zh-hk-language-quality";
import { chatWithBudget } from "./translation-ai";
import { RetryBudget } from "./translation-types";

export const DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG = "ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY";

export function isDocumentContextTranslationPrimaryEnabled(): boolean {
  return process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] === "true";
}

export interface DocumentContextPrimaryDeps {
  /** Override the provider call (used by tests). */
  callProvider?: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>;
  projectId?: number;
  outputDir?: string;
  /** Brand Voice text. Blank/missing uses the canonical default. */
  brandVoice?: string;
}

export interface DocumentContextPrimaryFailure {
  stage: string;
  diagnostics: string[];
}

export class PrimaryDocumentContextTranslationError extends Error {
  stage: string;
  diagnostics: string[];
  constructor(stage: string, diagnostics: string[]) {
    super(`Document-context primary translation failed at "${stage}": ${diagnostics.join("; ")}`);
    this.name = "PrimaryDocumentContextTranslationError";
    this.stage = stage;
    this.diagnostics = diagnostics;
  }
}

function extractFaqSchemaJson(faqSchemaHtml: string | undefined | null): unknown | null {
  if (!faqSchemaHtml) return null;
  const m = faqSchemaHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  const trimmed = m[1].trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Validate a completed document-context result against the primary trial requirements. */
export function validatePrimaryDocumentContextResult(result: DocumentContextTranslationShadowResult): DocumentContextPrimaryFailure | null {
  if (!result.enabled) {
    return { stage: "enablement", diagnostics: ["document-context path did not enable"] };
  }
  if (result.assembly.status !== "assembled") {
    return { stage: "assembly", diagnostics: [`status=${result.assembly.status}`, `missing=[${result.assembly.missingUnits.join(",")}]`] };
  }
  if (!result.allChunksCompleted || result.failedChunkCount > 0 || result.partialChunkCount > 0) {
    return { stage: "coherent-translation", diagnostics: [`all_completed=${result.allChunksCompleted}`, `failed=${result.failedChunkCount}`, `partial=${result.partialChunkCount}`] };
  }
  const cov = result.coverage.translatedSubstantive;
  if (cov.total === 0 || cov.translated < cov.total) {
    return { stage: "coverage", diagnostics: [`translated=${cov.translated}/${cov.total}`] };
  }
  const doc = result.preview.retainedDoc;
  if (!doc) return { stage: "document", diagnostics: ["no retained document"] };

  // Bounded editorial review must have completed. A failed/incomplete/invalid review
  // means the new translation is NOT saved — no silent fallback to the unreviewed doc.
  if (result.review?.status === "failed") {
    return { stage: "review", diagnostics: result.review.failure ? [result.review.failure] : result.review.diagnostics };
  }
  if (isFullDocumentZhReviewEnabled() && (
    result.review?.status !== "run"
    || result.review.documentAccepted !== true
    || (result.review.unresolvedUnitIds?.length ?? 0) > 0
  )) {
    return { stage: "review", diagnostics: ["complete-document semantic acceptance is missing"] };
  }

  const html = renderArticleDocument(doc);
  if (/__NUM_\d+__/.test(html)) {
    return { stage: "placeholders", diagnostics: ["unresolved placeholder tokens remain"] };
  }

  if (doc.visibleFaq.length > 0) {
    const rebuilt = JSON.parse(buildFaqSchemaJson(doc.visibleFaq)) as unknown;
    const current = extractFaqSchemaJson(doc.faqSchema?.html);
    if (!current || JSON.stringify(current) !== JSON.stringify(rebuilt)) {
      return { stage: "faq-parity", diagnostics: ["visible FAQ and FAQ schema diverged"] };
    }
  }

  // Severity-based translation-quality gate. Only CRITICAL or MAJOR findings
  // reject the primary result; minor and advisory findings are retained as
  // diagnostics and never reject or revert.
  let report = result.editorial.quality;
  if (!report) {
    report = analyzeDocQuality(doc);
    result.editorial.quality = report;
  }
  const fatal = report.findings.filter((f) => f.severity === "critical" || f.severity === "major");
  if (fatal.length > 0) {
    const categories = fatal.map((f) => `${f.severity}:${f.messageCode}`);
    return { stage: "quality", diagnostics: categories };
  }

  return null;
}

/** Run the document-context path as the primary translation and map it to a saveable result. */
export async function runPrimaryDocumentContextTranslation(
  enDoc: ArticleDocument,
  deps: DocumentContextPrimaryDeps = {},
): Promise<TranslationResult> {
  const result = await runDocumentContextTranslationShadow(enDoc, {
    projectId: deps.projectId,
    outputDir: deps.outputDir,
    callProvider: deps.callProvider,
    brandVoice: deps.brandVoice,
    primary: true,
  });

  // ── Bounded editorial review (the 2nd substantive call) ──
  // Runs only when the translation assembled cleanly. Selects at-risk units
  // deterministically, makes ONE review call, validates + applies patches. A
  // failed/incomplete/invalid review must NOT be silently ignored — the save gate
  // rejects on result.review.failed (no fallback to the unreviewed translation).
  if (result.assembly.status === "assembled" && result.allChunksCompleted && result.preview.retainedDoc) {
    const budget = new RetryBudget(1);
    const callProvider = deps.callProvider
      ?? ((messages: ChatMessage[], options: Record<string, unknown>, label: string) =>
        chatWithBudget(messages, options as Record<string, unknown>, label, budget));
    const sourceDoc = buildTranslationSourceDocument(enDoc);
    const styleContract = buildZhHkStyleContract(deps.brandVoice);
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc,
      zhDoc: result.preview.retainedDoc,
      qualityReport: result.editorial.quality ?? emptyQualityReport(),
      styleContract,
      callProvider,
    });
    result.review = {
      enabled: true,
      status: outcome.status,
      callCount: outcome.callCount,
      selectedUnitIds: outcome.selectedUnitIds,
      selectedReasons: outcome.selectedReasons,
      patches: outcome.decisions.map((p) => ({ sourceUnitId: p.sourceUnitId, decision: p.decision, reasonCodes: p.reasonCodes, edits: p.edits })),
      appliedPatchCount: outcome.appliedEditCount,
      retainedCount: outcome.retainedCount,
      failure: outcome.failure,
      diagnostics: outcome.diagnostics,
      truncated: outcome.truncated,
      documentAccepted: outcome.documentAccepted,
      unresolvedUnitIds: outcome.unresolvedUnitIds,
    };
    if (outcome.status === "run") {
      result.preview.retainedDoc = outcome.doc;
      result.editorial.quality = analyzeZhHkLanguageQuality(outcome.doc, enDoc);
    }
  }

  const failure = validatePrimaryDocumentContextResult(result);
  if (failure) {
    throw new PrimaryDocumentContextTranslationError(failure.stage, failure.diagnostics);
  }

  const doc = result.preview.retainedDoc as ArticleDocument;
  // The primary path must expose a deterministic Chinese keyphrase for SEO/save.
  if (!/[\u3400-\u9fff]/.test(doc.metadata.focusKeyphrase || "")) {
    doc.metadata.focusKeyphrase = deriveChineseKeyphrase(enDoc.metadata.focusKeyphrase || "");
  }
  const html = renderArticleDocument(doc);
  const lengthMetrics = chineseLengthMetrics(html);

  return {
    doc,
    html,
    title: doc.metadata.title,
    metaDescription: doc.metadata.metaDescription,
    metrics: [],
    failedComponents: [],
    warnings: [],
    sourceDecisions: [],
    internalLinkDecisions: [],
    review: result.review ? {
      selectedUnitIds: result.review.selectedUnitIds,
      selectedReasons: result.review.selectedReasons,
      decisions: result.review.patches,
      appliedEditCount: result.review.appliedPatchCount,
      retainedCount: result.review.retainedCount,
      status: result.review.status,
      failure: result.review.failure,
      documentAccepted: result.review.documentAccepted,
      unresolvedUnitIds: result.review.unresolvedUnitIds,
    } : undefined,
    ...lengthMetrics,
  };
}
