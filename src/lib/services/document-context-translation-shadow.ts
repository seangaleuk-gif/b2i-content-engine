// ── Disabled-by-default coherent-chunk translation shadow (Stage 2B) ──
//
// Connects TranslationSourceDocument + TranslationChunkPlan + the structured
// chunk-response contract to DeepSeek as a DIAGNOSTIC shadow. When the feature
// flag is off (default) it does nothing and makes zero provider calls.
//
// The shadow NEVER affects the canonical Traditional Chinese document, component
// repairs, failedComponents, final validation, the saved blog version, route
// success/failure, or metadata/FAQ schema/CTA used by production. It builds and
// returns a diagnostic result object only.
//
// Numbers are protected before provider submission using the production-proven
// placeholder utilities, so formatting variants (10,000 vs 10000) can never
// produce false positives. Metadata units are advisory: number differences there
// warn but never invalidate the chunk.
//
// This module is additive and not part of the primary translation path.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { DeepSeekError, type ChatMessage } from "@/lib/services/deepseek";
import { extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-content";
import {
  buildTranslationSourceDocument,
  serializeTranslationSourceDocument,
  enumerateTranslationSourceUnits,
  type TranslationSourceDocument,
  type TranslationSourceUnit,
} from "./translation-source-document";
import {
  buildTranslationChunkPlan,
  serializeTranslationChunkPlan,
  validateStructuredChunkResponse,
  buildDocumentBrief,
  type TranslationChunk,
  type TranslatedUnitResult,
  type PerUnitValidationResult,
} from "./translation-chunk-planner";
import { buildDocumentContextShadowMessages, chunkSourceText } from "./document-context-translation-shadow-prompt";
import {
  parseWithJsonDiagnostics,
  extractFirstBalancedJsonObject,
  type JsonParseDiagnostics,
} from "./document-context-json-recovery";
import { retrieveCantoneseExamples, B2I_CANTONESE_LANGUAGE_PACK_VERSION } from "./b2i-cantonese-language-pack";
import { buildCantoneseStyleExamplePrompt } from "./translation-style-examples";
import { resolveModelRouting } from "./deepseek-model-routing";
import { resolveResolvedBudgets } from "./deepseek-model-routing";
import { chatWithBudget } from "./translation-ai";
import { RetryBudget } from "./translation-types";
import { buildZhHkStyleContract } from "./zh-hk-style-contract";
import { BRAND_VOICE_VERSION } from "./brand-voice";
import { protectChunkForSubmission, restoreResponseUnits, type ShadowProviderResponse, type ShadowTokenUsage } from "./shadow-number-protection";
import { assembleShadowDocument, applyFaithfulDocumentPostProcessing, type ShadowAssemblyInfo, type ShadowEditorialInfo, type ShadowPreviewInfo } from "./document-context-shadow-preview";
import { exportShadowPreview } from "./shadow-preview-export";
import { logBlockedQualityFindings } from "./zh-hk-language-quality";

export const DOCUMENT_CONTEXT_SHADOW_FLAG = "ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW";
export const SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG = "ENABLE_SHADOW_BILINGUAL_EDITORIAL_POLISH";
export const PREVIOUS_CONTEXT_MAX_CHARS = 500;
const SHADOW_RETRY_BUDGET = 1;

export type { ShadowTokenUsage, ShadowProviderResponse } from "./shadow-number-protection";

export function isDocumentContextTranslationShadowEnabled(): boolean {
  return process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] === "true";
}

export function isShadowBilingualEditorialPolishEnabled(): boolean {
  return process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG] === "true";
}

export interface DocumentContextShadowDeps {
  /** Override the provider call (used by tests). Defaults to the budgeted DeepSeek client. */
  callProvider?: (
    messages: ChatMessage[],
    options: Record<string, unknown>,
    label: string,
  ) => Promise<ShadowProviderResponse>;
  /** Project whose article produced this shadow preview (used for the dev export filename). */
  projectId?: number;
  /** Override the dev preview export directory (used by tests). Defaults to `.tmp/shadow-previews`. */
  outputDir?: string;
  /** Brand Voice text. Blank/missing uses the canonical default. */
  brandVoice?: string;
  /** Primary-path mode: run the document-context translation as the sole path,
   *  regardless of the shadow feature flag, and always run the three editorial
   *  batches. Used only for the controlled primary-path trial. */
  primary?: boolean;
}

export type ShadowErrorCategory =
  | "ID contract"
  | "number parity"
  | "URL parity"
  | "structure parity"
  | "malformed JSON"
  | "truncation"
  | "provider error";

/** Diagnostic data for a single invalid unit, ready for a future targeted repair stage. */
export interface ShadowUnitRepairData {
  sourceUnitId: string;
  sourceUnit: TranslationSourceUnit;
  returnedUnit: TranslatedUnitResult | null;
  categories: string[];
  missingPlaceholders: string[];
  extraPlaceholders: string[];
}

export interface ShadowChunkResult {
  chunkId: string;
  role: string;
  sourceUnitIds: string[];
  expectedUnitCount: number;
  returnedUnitCount: number;
  translatedSourceUnitIds: string[];
  /** Restored (Chinese) translated units for valid units — used as next-chunk context. */
  translatedUnits: TranslatedUnitResult[];
  valid: boolean;
  partialValid: boolean;
  errors: string[];
  perUnit: PerUnitValidationResult[];
  invalidUnits: ShadowUnitRepairData[];
  contractFailures: string[];
  parityFailures: string[];
  failingUnitIds: string[];
  categories: ShadowErrorCategory[];
  missingIds: string[];
  extraIds: string[];
  duplicateIds: string[];
  reorderedIds: string[];
  durationMs: number;
  attemptCount: number;
  tokenUsage: ShadowTokenUsage | null;
  finishReason?: string;
  truncated: boolean;
  providerErrorType?: string;
  previousContextApplied: boolean;
  /** Diagnostics: retrieved Cantonese style-example IDs for this chunk. */
  styleExampleIds?: string[];
  /** Diagnostics: retrieval scores per retrieved example. */
  styleExampleScores?: Array<{ id: string; score: number }>;
  /** Safe malformed-JSON diagnostics for the raw chunk response. */
  jsonDiagnostics?: JsonParseDiagnostics;
}

export interface TranslatedSubstantiveCoverage {
  translated: number;
  total: number;
}

export interface WholeDocumentHandlingCoverage {
  translated: number;
  protected: number;
  unresolved: number;
  total: number;
}

export interface DocumentContextTranslationShadowResult {
  enabled: boolean;
  sourceDocumentFingerprint: string | null;
  planFingerprint: string | null;
  totalPlannedChunks: number;
  substantiveChunkCallCount: number;
  skippedProtectedChunks: number;
  providerAttemptCount: number;
  validChunkCount: number;
  partialChunkCount: number;
  failedChunkCount: number;
  chunkResults: ShadowChunkResult[];
  contractFailures: string[];
  protectedParityFailures: string[];
  coverage: {
    translatedSubstantive: TranslatedSubstantiveCoverage;
    wholeDocument: WholeDocumentHandlingCoverage;
  };
  allChunksCompleted: boolean;
  /** Complete Chinese shadow document assembled from validated units. */
  assembly: ShadowAssemblyInfo;
  /** Bilingual whole-document editorial polish result. */
  editorial: ShadowEditorialInfo;
  /** Bounded editorial-review result (the 2nd substantive call). */
  review: ShadowEditorialReviewInfo;
  /** Reviewable preview-only marker and retained document. */
  preview: ShadowPreviewInfo;
  warnings: string[];
  /** Diagnostics: B2I Cantonese language-pack version + retrieved example IDs. */
  languagePack: ShadowLanguagePackDiagnostics;
  /** Diagnostics: Brand Voice version, hash and whether the canonical default was used. */
  brandVoice: {
    version: string;
    brandVoiceHash: string;
    usedDefault: boolean;
    styleProfileVersion: string;
    hardRuleCount: number;
    advisoryRuleCount: number;
  };
}

export interface ShadowEditorialReviewInfo {
  enabled: boolean;
  status: "not-run" | "run" | "failed";
  /** Number of editorial-review calls made (0 or 1). */
  callCount: number;
  selectedUnitIds: string[];
  selectedReasons: Array<{ sourceUnitId: string; reasons: string[]; mandatory: boolean }>;
  patches: Array<{
    sourceUnitId: string;
    decision: "replace" | "retain";
    reasonCodes: string[];
    edits?: Array<{ fieldId: string; replacementText: string }>;
  }>;
  appliedPatchCount: number;
  retainedCount: number;
  failure: string | null;
  diagnostics: string[];
  truncated: boolean;
  documentAccepted?: boolean;
  unresolvedUnitIds?: string[];
}

export interface ShadowLanguagePackDiagnostics {
  version: string;
  retrievedExampleIds: string[];
  retrievalScores: Array<{ chunkId: string; id: string; score: number }>;
  exampleCount: number;
  promptBudgetChars: number;
  glossaryApplications: number;
  critical: number;
  major: number;
  minor: number;
  advisory: number;
  resolvedBudgets: {
    translation: { maxTokens: number; timeoutMs: number };
    editorial: { maxTokens: number; timeoutMs: number };
  };
}

function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function chunkIndexFromId(chunkId: string): number {
  const match = /^chunk\.(\d+)$/.exec(chunkId);
  return match ? Number(match[1]) : 0;
}

function classifyContractErrors(errors: string[]): { contractFailures: string[]; parityFailures: string[] } {
  const contractFailures = errors.filter((error) =>
    /missing source units|unexpected\/unknown source units|duplicated source units|out of canonical order|unit count mismatch/.test(error),
  );
  const parityFailures = errors.filter((error) => !contractFailures.includes(error));
  return { contractFailures, parityFailures };
}

function analyzeIds(expected: string[], returned: string[]): {
  missing: string[]; extra: string[]; duplicates: string[]; reordered: string[];
} {
  const missing = expected.filter((id) => !returned.includes(id));
  const seen = new Set<string>();
  const duplicates = returned.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  const extra = returned.filter((id) => !expected.includes(id));
  const reordered =
    missing.length === 0 && extra.length === 0 && duplicates.length === 0
    && returned.length === expected.length
    && JSON.stringify(returned) !== JSON.stringify(expected)
      ? [expected.join(",")]
      : [];
  return { missing, extra, duplicates, reordered };
}

function classifyShadowErrors(errors: string[], truncated: boolean, providerErrorType?: string): ShadowErrorCategory[] {
  const cats = new Set<ShadowErrorCategory>();
  if (providerErrorType) {
    cats.add(providerErrorType === "truncated" ? "truncation" : "provider error");
  } else if (truncated) {
    cats.add("truncation");
  }
  for (const error of errors) {
    if (/malformed|invalid JSON/.test(error)) {
      cats.add("malformed JSON");
    } else if (/missing source units|unexpected\/unknown source units|duplicated source units|out of canonical order|unit count mismatch/.test(error)) {
      cats.add("ID contract");
    } else if (/numbers? (lost|extra|changed)|number.*lost|placeholder/.test(error)) {
      cats.add("number parity");
    } else if (/URLs? (lost|changed)|unexpected URLs|link/.test(error)) {
      cats.add("URL parity");
    } else if (/structure changed|block structure/.test(error)) {
      cats.add("structure parity");
    } else if (/provider error|timeout|network|api_failure/.test(error)) {
      cats.add("provider error");
    }
  }
  return [...cats];
}

/**
 * Build the single full-document translation chunk: every translatable source unit
 * (all units except the deterministically-handled protected CTA) assigned to ONE
 * call, in canonical order. Protected blocks are reinserted unchanged by assembly.
 */
export function buildFullDocumentChunk(sourceDoc: TranslationSourceDocument): TranslationChunk {
  const units = enumerateTranslationSourceUnits(sourceDoc).filter((unit) => unit.type !== "cta");
  return {
    chunkId: "chunk.0",
    role: "document",
    sourceUnitIds: units.map((unit) => unit.sourceId),
    units,
    documentBrief: buildDocumentBrief(sourceDoc),
    previousChunkContext: null,
    expectedOutputStructure: { kind: "translated-unit-list", description: "", fieldsPerUnit: [] },
    maxOutputTokens: 65536,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    fingerprint: "full-document",
  };
}

/** Bounded, deterministic previous-chunk context: preceding heading + last 1-2 paragraphs. */
export function buildBoundedPreviousContext(units: TranslatedUnitResult[]): string {
  const parts: string[] = [];
  let heading = "";
  const paragraphs: string[] = [];
  for (const unit of units) {
    const pushParagraph = (text: string): void => {
      if (text && paragraphs.length < 2) paragraphs.push(text);
    };
    if (unit.text) {
      if (/\.heading$/.test(unit.sourceUnitId)) heading = unit.text;
      else pushParagraph(unit.text);
    } else if (unit.block) {
      pushParagraph(extractPlainTextFromEditorialBlocks([unit.block]));
    } else if (unit.answerText) {
      pushParagraph(unit.answerText);
    }
  }
  if (heading) parts.push(`前文標題：${heading}`);
  paragraphs.forEach((paragraph) => parts.push(`前文段落：${paragraph}`));
  let context = parts.join("\n");
  if (context.length > PREVIOUS_CONTEXT_MAX_CHARS) {
    context = `${context.slice(0, PREVIOUS_CONTEXT_MAX_CHARS)}…`;
  }
  return context;
}

function emptyResult(forceEnabled = false): DocumentContextTranslationShadowResult {
  return {
    enabled: forceEnabled || isDocumentContextTranslationShadowEnabled(),
    sourceDocumentFingerprint: null,
    planFingerprint: null,
    totalPlannedChunks: 0,
    substantiveChunkCallCount: 0,
    skippedProtectedChunks: 0,
    providerAttemptCount: 0,
    validChunkCount: 0,
    partialChunkCount: 0,
    failedChunkCount: 0,
    chunkResults: [],
    contractFailures: [],
    protectedParityFailures: [],
    coverage: {
      translatedSubstantive: { translated: 0, total: 0 },
      wholeDocument: { translated: 0, protected: 0, unresolved: 0, total: 0 },
    },
    allChunksCompleted: false,
    assembly: { status: "not-run", missingUnits: [], doc: null },
    editorial: {
      enabled: false,
      status: "not-run",
      batchCount: 0,
      attemptCount: 0,
      acceptedBatchCount: 0,
      rejectedBatchCount: 0,
      providerFailedCount: 0,
      validationRejectedCount: 0,
      skippedCount: 0,
      changedUnitCount: 0,
      unchangedUnitCount: 0,
      batches: [],
      failure: null,
      preEditorialDoc: null,
      polishedDoc: null,
      perUnitValid: 0,
      perUnitInvalid: 0,
      tokenUsage: null,
      invariantFailures: [],
      quality: null,
    },
    review: {
      enabled: false, status: "not-run", callCount: 0, selectedUnitIds: [],
      selectedReasons: [], patches: [], appliedPatchCount: 0, retainedCount: 0,
      failure: null, diagnostics: [], truncated: false,
      documentAccepted: false, unresolvedUnitIds: [],
    },
    preview: { previewOnly: true, retainedDoc: null, retainedSource: "none", stored: false, exportPath: null, timestamp: "" },
    warnings: [],
    languagePack: {
      version: B2I_CANTONESE_LANGUAGE_PACK_VERSION,
      retrievedExampleIds: [],
      retrievalScores: [],
      exampleCount: 0,
      promptBudgetChars: 1200,
      glossaryApplications: 0,
      critical: 0,
      major: 0,
      minor: 0,
      advisory: 0,
      resolvedBudgets: { translation: { maxTokens: 8000, timeoutMs: 60000 }, editorial: { maxTokens: 32768, timeoutMs: 180000 } },
    },
    brandVoice: { version: BRAND_VOICE_VERSION, brandVoiceHash: "", usedDefault: true, styleProfileVersion: BRAND_VOICE_VERSION, hardRuleCount: 0, advisoryRuleCount: 0 },
  };
}

function overlayPlaceholderIntegrity(
  perUnit: PerUnitValidationResult[],
  integrity: Map<string, { lost: string[]; extra: string[] }>,
): PerUnitValidationResult[] {
  return perUnit.map((unit) => {
    const int = integrity.get(unit.sourceUnitId);
    if (!int) return unit;
    const missing = int.lost;
    const extra = int.extra;
    const hasIssue = missing.length > 0 || extra.length > 0;
    if (!hasIssue) return { ...unit, missingPlaceholders: missing, extraPlaceholders: extra };
    if (unit.advisory) {
      return {
        ...unit,
        missingPlaceholders: missing,
        extraPlaceholders: extra,
        warnings: [...unit.warnings, `${unit.sourceUnitId}: number placeholder lost/extra (advisory)`],
      };
    }
    return {
      ...unit,
      valid: false,
      categories: [...unit.categories, "number parity"],
      missingPlaceholders: missing,
      extraPlaceholders: extra,
      warnings: [...unit.warnings, `${unit.sourceUnitId}: missing/duplicated number placeholder`],
    };
  });
}

async function translateShadowChunk(
  chunk: TranslationChunk,
  sourceDoc: TranslationSourceDocument,
  previousContext: string,
  callProvider: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>,
  brandProfile = "",
): Promise<ShadowChunkResult> {
  const label = `document-context-shadow-chunk-${chunkIndexFromId(chunk.chunkId)}`;
  const base: ShadowChunkResult = {
    chunkId: chunk.chunkId,
    role: chunk.role,
    sourceUnitIds: chunk.sourceUnitIds,
    expectedUnitCount: chunk.sourceUnitIds.length,
    returnedUnitCount: 0,
    translatedSourceUnitIds: [],
    translatedUnits: [],
    valid: false,
    partialValid: false,
    errors: [],
    perUnit: [],
    invalidUnits: [],
    contractFailures: [],
    parityFailures: [],
    failingUnitIds: [],
    categories: [],
    missingIds: [],
    extraIds: [],
    duplicateIds: [],
    reorderedIds: [],
    durationMs: 0,
    attemptCount: 0,
    tokenUsage: null,
    truncated: false,
    previousContextApplied: Boolean(previousContext),
  };

  const started = Date.now();
  try {
    const { protectedChunk, restoreStates } = protectChunkForSubmission(chunk);
    // Local, deterministic retrieval of approved Cantonese style examples (diagnostics).
    const retrieved = retrieveCantoneseExamples(chunkSourceText(chunk), { domainTerm: chunk.role });
    base.styleExampleIds = retrieved.map((r) => r.example.id);
    base.styleExampleScores = retrieved.map((r) => ({ id: r.example.id, score: r.score }));
    // Every chunk receives the FULL approved style-example set (categorical guidance),
    // not a retrieved subset, so style teaching is consistent across the document.
    // NOTE: automatically retrieved HKCanCor/Words.hk corpus examples are deliberately
    // NOT injected here — they are spoken/neutral and not a reliable professional-blog
    // register signal. The corpus remains available for deterministic validation only.
    const styleExamples = buildCantoneseStyleExamplePrompt();
    const messages = buildDocumentContextShadowMessages(protectedChunk.documentBrief, protectedChunk, sourceDoc, previousContext, styleExamples, brandProfile);
    const routing = resolveModelRouting(label);
    const response = await callProvider(messages, {
      maxTokens: routing.maxTokens,
      timeoutMs: routing.timeoutMs,
      temperature: 0.3,
      model: routing.model,
      thinkingMode: routing.thinkingMode,
      reasoningEffort: routing.reasoningEffort,
      responseFormat: { type: "json_object" },
      maxRetries: 0,
    }, label);
    base.durationMs = Date.now() - started;
    base.attemptCount = response.attemptsUsed !== undefined ? response.attemptsUsed + 1 : 1;
    base.tokenUsage = response.usage ?? null;
    base.finishReason = response.finishReason;
    base.truncated = Boolean(response.truncated) || response.finishReason === "length";

    let parsed: unknown;
    let jsonDiagnostics: JsonParseDiagnostics | null = null;
    const firstParse = parseWithJsonDiagnostics(response.content);
    if (firstParse.parsed !== null) {
      parsed = firstParse.parsed;
    } else if (firstParse.diagnostics) {
      // Initial parse failed. Capture full diagnostics, then attempt a NON-destructive
      // outer-wrapper recovery: scan for the first balanced top-level JSON object
      // (respecting strings/escapes) and re-parse ONLY that slice. The recovered
      // slice is accepted only if it passes the complete response contract below
      // (all expected units, no missing/extra/duplicate, valid structures/fields).
      jsonDiagnostics = firstParse.diagnostics;
      const recoveredSlice = extractFirstBalancedJsonObject(response.content);
      let recoveredParsed: unknown = null;
      if (recoveredSlice !== null) {
        try {
          recoveredParsed = JSON.parse(recoveredSlice);
        } catch {
          recoveredParsed = null;
        }
      }
      if (recoveredParsed === null) {
        base.jsonDiagnostics = jsonDiagnostics;
        base.errors.push(`malformed structured response (invalid JSON): ${jsonDiagnostics.errorMessage}`);
        base.categories = classifyShadowErrors(base.errors, base.truncated);
        return base;
      }
      parsed = recoveredParsed;
      jsonDiagnostics = { ...jsonDiagnostics, recovered: true };
      base.jsonDiagnostics = jsonDiagnostics;
    } else {
      base.errors.push("malformed structured response (invalid JSON)");
      base.categories = classifyShadowErrors(base.errors, base.truncated);
      return base;
    }

    const parsedResponse = parsed as { units?: TranslatedUnitResult[] };
    const returnedUnits = Array.isArray(parsedResponse.units) ? parsedResponse.units : [];
    base.returnedUnitCount = returnedUnits.length;
    base.translatedSourceUnitIds = returnedUnits.map((unit) => unit.sourceUnitId);

    const restored = restoreResponseUnits(returnedUnits, restoreStates);
    const validation = validateStructuredChunkResponse(chunk, { units: restored.units });
    const idAnalysis = analyzeIds(chunk.sourceUnitIds, base.translatedSourceUnitIds);
    const perUnit = overlayPlaceholderIntegrity(validation.units, restored.integrity);

    // Outer-wrapper recovery is only trusted when the recovered response satisfies
    // the FULL contract: every expected unit present, none missing/extra/duplicate,
    // and all structures/protected fields valid. Otherwise the recovered units are
    // discarded and the hard failure stands with improved diagnostics.
    if (jsonDiagnostics?.recovered) {
      const recoveredComplete =
        validation.errors.length === 0
        && idAnalysis.missing.length === 0
        && idAnalysis.extra.length === 0
        && idAnalysis.duplicates.length === 0
        && perUnit.length === chunk.sourceUnitIds.length
        && perUnit.every((unit) => unit.valid);
      if (!recoveredComplete) {
        base.jsonDiagnostics = jsonDiagnostics;
        base.errors.push(`malformed structured response (invalid JSON): ${jsonDiagnostics.errorMessage} — recovered outer wrapper rejected by complete response contract`);
        base.categories = classifyShadowErrors(base.errors, base.truncated);
        return base;
      }
    }

    base.errors = validation.errors;
    const { contractFailures } = classifyContractErrors(validation.errors);
    base.contractFailures = contractFailures;
    base.parityFailures = perUnit.flatMap((unit) =>
      unit.categories
        .filter((c) => c === "number parity" || c === "URL parity" || c === "structure parity")
        .map((c) => `${unit.sourceUnitId}: ${c}`),
    );
    base.perUnit = perUnit;
    // Improved parity diagnostics: log expected vs returned type/shape for every
    // failed structure-parity unit (no article prose, unit IDs + signatures only).
    for (const unit of perUnit) {
      if (unit.structureParity?.changed) {
        console.warn(
          `[document-context-shadow] structure parity | unit=${unit.sourceUnitId} | expected=${unit.structureParity.expected ?? "?"} | returned=${unit.structureParity.returned ?? "?"}`,
        );
      }
    }
    base.missingIds = idAnalysis.missing;
    base.extraIds = idAnalysis.extra;
    base.duplicateIds = idAnalysis.duplicates;
    base.reorderedIds = idAnalysis.reordered;

    const hardInvalid = perUnit.filter((unit) => !unit.advisory && !unit.valid);
    const validCount = perUnit.filter((unit) => unit.valid).length;
    base.valid = validation.errors.length === 0 && hardInvalid.length === 0;
    base.partialValid = !base.valid && validCount > 0 && hardInvalid.length > 0;
    base.translatedSourceUnitIds = perUnit.filter((unit) => unit.valid).map((unit) => unit.sourceUnitId);
    base.failingUnitIds = perUnit.filter((unit) => !unit.valid).map((unit) => unit.sourceUnitId);

    const restoredById = new Map(restored.units.map((unit) => [unit.sourceUnitId, unit]));
    base.invalidUnits = perUnit
      .filter((unit) => !unit.valid)
      .map((unit) => ({
        sourceUnitId: unit.sourceUnitId,
        sourceUnit: chunk.units.find((source) => source.sourceId === unit.sourceUnitId) ?? chunk.units[0],
        returnedUnit: restoredById.get(unit.sourceUnitId) ?? null,
        categories: unit.categories,
        missingPlaceholders: unit.missingPlaceholders,
        extraPlaceholders: unit.extraPlaceholders,
      }));

    const unitCategories = [...new Set(hardInvalid.flatMap((unit) => unit.categories))] as ShadowErrorCategory[];
    base.categories = [...new Set([...classifyShadowErrors(validation.errors, base.truncated), ...unitCategories])];
    const validIds = new Set(base.translatedSourceUnitIds);
    base.translatedUnits = restored.units.filter((unit) => validIds.has(unit.sourceUnitId));

    return base;
  } catch (error) {
    base.durationMs = Date.now() - started;
    base.attemptCount = 1;
    const isDeepSeek = error instanceof DeepSeekError;
    const errType = isDeepSeek ? error.type : undefined;
    base.providerErrorType = errType;
    base.truncated = errType === "truncated";
    if (errType === "truncated") {
      base.finishReason = "length";
      base.errors.push("truncation: response exceeded the output token budget");
    } else {
      base.errors.push(`provider error: ${error instanceof Error ? error.message : String(error)}`);
    }
    base.categories = classifyShadowErrors(base.errors, base.truncated, errType);
    return base;
  }
}

/**
 * Run the diagnostic shadow against the immutable approved English document.
 * When the flag is off, returns an empty disabled result and makes no provider
 * calls. Never mutates its input and never persists anything.
 */
export async function runDocumentContextTranslationShadow(
  enDoc: ArticleDocument,
  deps: DocumentContextShadowDeps = {},
): Promise<DocumentContextTranslationShadowResult> {
  const base = emptyResult(!!deps.primary);
  if (!base.enabled) return base;

  try {
    const sourceDoc = buildTranslationSourceDocument(enDoc);
    const plan = buildTranslationChunkPlan(sourceDoc);
    const sourceDocumentFingerprint = stableHash(serializeTranslationSourceDocument(sourceDoc));
    const planFingerprint = stableHash(serializeTranslationChunkPlan(plan));

    const budget = new RetryBudget(SHADOW_RETRY_BUDGET);
    const callProvider = deps.callProvider
      ?? ((messages: ChatMessage[], options: Record<string, unknown>, label: string) =>
        chatWithBudget(messages, options as Record<string, unknown>, label, budget));

    // ── Compile the Brand Voice into the zh-HK style contract once ──
    const styleContract = buildZhHkStyleContract(deps.brandVoice);

    // ── Single full-document translation call ──
    // The complete English article is supplied once as read-only context and every
    // translatable source unit (all units except the deterministically-handled
    // protected CTA) is assigned to the ONE call. Protected blocks (CTA/schema/
    // language switcher) are reinserted unchanged by deterministic assembly.
    const fullChunk = buildFullDocumentChunk(sourceDoc);
    const substantiveTotal = fullChunk.sourceUnitIds.length;
    const protectedUnitCount = Math.max(0, plan.totalSourceUnits - substantiveTotal);

    const result: DocumentContextTranslationShadowResult = {
      ...base,
      enabled: true,
      sourceDocumentFingerprint,
      planFingerprint,
      totalPlannedChunks: 1,
      substantiveChunkCallCount: 1,
      skippedProtectedChunks: protectedUnitCount,
      allChunksCompleted: true,
      brandVoice: {
        version: styleContract.version,
        brandVoiceHash: styleContract.brandVoiceHash,
        usedDefault: styleContract.usedDefault,
        styleProfileVersion: styleContract.version,
        hardRuleCount: styleContract.hardRules.length,
        advisoryRuleCount: styleContract.advisoryRules.length,
      },
    };

    const chunkResult = await translateShadowChunk(fullChunk, sourceDoc, "", callProvider, styleContract.translationProfile);
    result.chunkResults.push(chunkResult);
    result.providerAttemptCount += chunkResult.attemptCount;
    result.contractFailures.push(...chunkResult.contractFailures);
    result.protectedParityFailures.push(...chunkResult.parityFailures);
    if (chunkResult.valid) {
      result.validChunkCount++;
    } else if (chunkResult.partialValid) {
      result.partialChunkCount++;
      result.allChunksCompleted = false;
    } else {
      result.failedChunkCount++;
      result.allChunksCompleted = false;
    }
    if (!chunkResult.valid) {
      console.warn(
        `[document-context-shadow] ${chunkResult.chunkId} ${chunkResult.partialValid ? "PARTIAL" : "FAILED"} | expected=${chunkResult.expectedUnitCount} returned=${chunkResult.returnedUnitCount} valid_units=${chunkResult.translatedSourceUnitIds.length} missing=[${chunkResult.missingIds.join(",")}] extra=[${chunkResult.extraIds.join(",")}] dup=[${chunkResult.duplicateIds.join(",")}] failing=[${chunkResult.failingUnitIds.join(",")}] cats=[${chunkResult.categories.join(",")}]`,
      );
    }

    const validatedUnitIds = new Set<string>();
    for (const chunkResult of result.chunkResults) {
      for (const id of chunkResult.translatedSourceUnitIds) validatedUnitIds.add(id);
    }
    const translatedCount = validatedUnitIds.size;
    const unresolved = Math.max(0, substantiveTotal - translatedCount);
    result.coverage = {
      translatedSubstantive: { translated: translatedCount, total: substantiveTotal },
      wholeDocument: { translated: translatedCount, protected: protectedUnitCount, unresolved, total: plan.totalSourceUnits },
    };

    // ── Assemble the complete Chinese shadow document from validated units ──
    const translatedMap = new Map<string, TranslatedUnitResult>();
    for (const chunkResult of result.chunkResults) {
      for (const unit of chunkResult.translatedUnits) translatedMap.set(unit.sourceUnitId, unit);
    }
    const { doc: assembledDoc, missing: assemblyMissing } = assembleShadowDocument(enDoc, sourceDoc, translatedMap);
    if (assembledDoc) {
      result.assembly = { status: "assembled", missingUnits: [], doc: assembledDoc };
      // Faithful source-aligned translation: NO bilingual A/B or monolingual editorial
      // calls. Deterministic post-processing (CTA localization, terminology cleanup,
      // source-reference localization, FAQ schema, severity quality report) still runs;
      // the processed document is validated and saved directly.
      const post = applyFaithfulDocumentPostProcessing(enDoc, assembledDoc);
      result.editorial = {
        enabled: false, status: "not-run", batchCount: 0, attemptCount: 0,
        acceptedBatchCount: 0, rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: 1, changedUnitCount: 0, unchangedUnitCount: 0,
        batches: [], failure: null, preEditorialDoc: assembledDoc, polishedDoc: null,
        perUnitValid: 0, perUnitInvalid: 0, tokenUsage: null, invariantFailures: [], quality: post.quality,
        sourceReferences: post.sourceReferences,
        sourceFindings: post.sourceFindings,
      };
      result.preview = { previewOnly: true, retainedDoc: post.doc, retainedSource: "pre-editorial", stored: false, exportPath: null, timestamp: new Date().toISOString() };
      logBlockedQualityFindings(post.quality);
    } else {
      result.assembly = { status: "incomplete", missingUnits: assemblyMissing, doc: null };
      result.preview = { previewOnly: true, retainedDoc: null, retainedSource: "none", stored: false, exportPath: null, timestamp: new Date().toISOString() };
    }

    // ── Aggregate B2I Cantonese language-pack diagnostics ──
    const retrievedIds: string[] = [];
    const retrievalScores: Array<{ chunkId: string; id: string; score: number }> = [];
    for (const chunkResult of result.chunkResults) {
      for (const id of chunkResult.styleExampleIds ?? []) retrievedIds.push(id);
      for (const s of chunkResult.styleExampleScores ?? []) retrievalScores.push({ chunkId: chunkResult.chunkId, id: s.id, score: s.score });
    }
    const qualityReport = result.editorial.quality;
    result.languagePack = {
      version: B2I_CANTONESE_LANGUAGE_PACK_VERSION,
      retrievedExampleIds: [...new Set(retrievedIds)],
      retrievalScores,
      exampleCount: retrievedIds.length,
      promptBudgetChars: 1200,
      glossaryApplications: qualityReport?.glossaryNormalizations ?? 0,
      critical: qualityReport?.criticalCount ?? 0,
      major: qualityReport?.majorCount ?? 0,
      minor: qualityReport?.minorCount ?? 0,
      advisory: qualityReport?.advisoryCount ?? 0,
      resolvedBudgets: resolveResolvedBudgets(),
    };

    // ── Development-only local export of the finished preview ──
    // Writes the preview JSON + a readable HTML beside it under `.tmp/shadow-previews/`.
    // Failure must never reject the translation or discard the shadow result.
    const projectId = deps.projectId ?? 0;
    try {
      const exported = exportShadowPreview(result, { projectId, outputDir: deps.outputDir });
      if (result.preview) result.preview.exportPath = exported.htmlPath;
      console.log(
        `[document-context-shadow] preview exported | json=${exported.jsonPath} html=${exported.htmlPath} assembly=${result.assembly.status} editorial=${result.editorial.status} accepted=${result.editorial.acceptedBatchCount} rejected=${result.editorial.rejectedBatchCount} changed=${result.editorial.changedUnitCount} retained=${result.preview.retainedSource}`,
      );
    } catch (error) {
      console.warn(`[document-context-shadow] preview export failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log(
      `[document-context-shadow] enabled | chunks=${result.totalPlannedChunks} substantive_calls=${result.substantiveChunkCallCount} protected=${result.skippedProtectedChunks} attempts=${result.providerAttemptCount} valid_chunks=${result.validChunkCount} partial_chunks=${result.partialChunkCount} failed_chunks=${result.failedChunkCount} coverage=${translatedCount}/${substantiveTotal} assembly=${result.assembly.status} editorial=${result.editorial.status} editorial_accepted=${result.editorial.acceptedBatchCount} editorial_rejected=${result.editorial.rejectedBatchCount} editorial_changed=${result.editorial.changedUnitCount} preview=${result.preview.retainedSource}`,
    );

    return result;
  } catch (error) {
    base.warnings.push(`shadow failed: ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`[document-context-shadow] shadow failed: ${error instanceof Error ? error.message : String(error)}`);
    return base;
  }
}
