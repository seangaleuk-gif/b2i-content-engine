// ── Shadow preview assembly + bilingual editorial polish (shadow-only) ──
//
// Assembles validated coherent-chunk translations into a complete Chinese
// ArticleDocument (shadow preview) and, when enabled, runs ONE bilingual
// whole-document editorial polish call. Everything here is diagnostic: it never
// touches the production Chinese document, failedComponents or save path, and
// never persists to the production database.
//
// The approved English ArticleDocument is the immutable factual/semantic source.

import type { ArticleDocument, FaqEntry, ProtectedArticleBlock, SourceReferenceUnit } from "@/lib/blog/article-document";
import { fingerprintHtml } from "@/lib/blog/article-document";
import { type EditorialBlock, type InlineContent, renderEditorialBlocksToWordPress } from "@/lib/blog/article-content";
import type { ChatMessage } from "@/lib/services/deepseek";
import { pairedSlugs } from "@/lib/services/article-postprocessors";
import { buildFaqSchemaJson } from "./translation-assembler";
import { buildDocumentBrief, validateStructuredChunkResponse, type TranslationChunk, type TranslatedUnitResult } from "./translation-chunk-planner";
import { enumerateTranslationSourceUnits, parseTranslationSourceId, type TranslationSourceDocument, type TranslationSourceUnit } from "./translation-source-document";
import { protectChunkForSubmission, restoreResponseUnits, type ShadowProviderResponse, type ShadowTokenUsage } from "./shadow-number-protection";
import { buildShadowEditorialBatchMessages, buildShadowMonolingualMessages, buildMonolingualConstraints } from "./document-context-translation-shadow-prompt";
import { hasExcessiveEnglish, hasEnglishHeavyProseBlock } from "./translation-validator";
import { applyShadowCantoneseQuality, buildShadowQualityHints, mergeSourceReferenceFindings, type QualityReport } from "./shadow-cantonese-quality";
import { applyZhHkLanguageQuality } from "./zh-hk-language-quality";
import { applySourceReferenceLocalization, summarizeSourceFindings, isSourceReferenceBlock, type SourceReferenceFinding } from "./source-reference-localization";
import { retrieveCantoneseExamples, buildLanguagePackExamplePrompt, buildTerminologyLedger, buildTerminologyLedgerPrompt } from "./b2i-cantonese-language-pack";
import { lintEditorialDraft, lintMonolingualDocument, buildEditorialFindingsPrompt, buildMonolingualFindingsPrompt, buildFindingTokenMap, isValidFindingResponseToken, isValidReviewedUnchangedReasonCode, EDITORIAL_PATCH_UNIT_KEY, classifyHardFindings, evaluateHardFindingResolution, isValidHardFindingWaiver, APPROVED_ENGLISH_TERMS, type StyleFinding, type EditorialFindingToken, type HardFindingWaiverCode, type HardFindingClassification, type ActionableHardFinding } from "./cantonese-style-linter";
import { resolveModelRouting, EDITORIAL_BILINGUAL_A_LABEL, EDITORIAL_BILINGUAL_B_LABEL, EDITORIAL_MONOLINGUAL_LABEL } from "./deepseek-model-routing";

export type ShadowAssemblyStatus = "not-run" | "incomplete" | "assembled";

export interface ShadowAssemblyInfo {
  status: ShadowAssemblyStatus;
  missingUnits: string[];
  doc: ArticleDocument | null;
}

export type ShadowEditorialStatus = "not-run" | "polished" | "partially-polished" | "pre-editorial";

/** Per-stage editorial outcome: a stage is never "rejected" with empty reasons. */
export type EditorialStageStatus = "accepted" | "provider-failed" | "validation-rejected" | "not-run";

export interface ShadowEditorialBatchResult {
  batchIndex: number;
  sourceUnitIds: string[];
  status: EditorialStageStatus;
  attemptCount: number;
  changedUnitCount: number;
  changedUnitIds: string[];
  perUnitValid: number;
  perUnitInvalid: number;
  tokenUsage: ShadowTokenUsage | null;
  failures: string[];
  /** Named, machine-readable rejection reasons (IDs + codes only, never prose). */
  reasons?: EditorialRejectionReason[];
  /** Nonfatal diagnostics (e.g. exact duplicate patches collapsed), IDs + codes only. */
  diagnostics?: EditorialRejectionReason[];
  /** Provider content character count, preserved even on validation rejection. */
  contentChars?: number;
  /** Per-category linter finding counts supplied to this batch (diagnostic). */
  styleFindingCounts?: Record<string, number>;
  /** Safe observability: unit IDs serialized into the prompt. */
  promptUnitIds?: string[];
  /** Safe observability: allowed patch-target IDs. */
  allowedPatchTargetIds?: string[];
  /** Safe observability: returned patch-target IDs. */
  returnedPatchTargetIds?: string[];
  /** Safe observability: number of patch units returned by the model. */
  returnedPatchCount?: number;
  /** Safe observability: number of returned patches whose reader-facing content actually changed. */
  appliedChangedUnitCount?: number;
  /** Safe observability: number of returned patches that were byte-identical no-ops. */
  noOpPatchCount?: number;
  /** Safe observability: number of finding tokens supplied to the stage. */
  suppliedFindingCount?: number;
  /** Safe observability: findings locally resolved by the application (monolingual). */
  locallyResolvedFindingCount?: number;
  /** Safe observability: number of finding tokens the model marked reviewed-unchanged. */
  reviewedUnchangedFindingCount?: number;
  /** Safe observability: reviewed-unchanged reason-code counts (stable codes only). */
  reviewedUnchangedReasonCounts?: Record<string, number>;
  /** Safe observability: still-present findings without reviewed-unchanged accounting. */
  missingFindingDispositionCount?: number;
  /** Safe observability: reviewed-unchanged entries for findings the final lint resolved (non-blocking). */
  staleReviewedUnchangedCount?: number;
  /** Safe observability: reviewed entries with an unknown finding token (diagnostic only). */
  unknownReviewedFindingCount?: number;
  /** Safe observability: duplicate reviewed entries (diagnostic only). */
  duplicateReviewedFindingCount?: number;
  /** Safe observability: reviewed entries with an invalid reason code (diagnostic only). */
  invalidReviewedReasonCount?: number;
  /** Safe observability: per-finding disposition (IDs only, diagnostic only). */
  findingDispositions?: Array<{ findingToken: string; sourceUnitId: string; ruleId: string; disposition: "resolved" | "reviewed-unchanged" | "missing-disposition" | "stale-reviewed" }>;
  /** Safe observability: finding response tokens supplied in the prompt. */
  suppliedFindingTokens?: string[];
  /** Safe observability: finding tokens the model marked resolved. */
  returnedResolvedFindingTokens?: string[];
  /** Safe observability: finding tokens the model marked reviewed-unchanged. */
  returnedReviewedFindingTokens?: string[];
  /** Safe observability: source-reference unit IDs in scope. */
  sourceReferenceIds?: string[];
  /** Safe observability: quality-gate counts for the monolingual proofread. */
  qualityGate?: EditorialQualityGate;
}

export interface ShadowEditorialInfo {
  enabled: boolean;
  status: ShadowEditorialStatus;
  batchCount: number;
  attemptCount: number;
  acceptedBatchCount: number;
  rejectedBatchCount: number;
  /** Stages that failed at the provider boundary (thinking/routing/call error). */
  providerFailedCount: number;
  /** Stages that failed deterministic validation (patch/finding/quality). */
  validationRejectedCount: number;
  /** Stages not attempted because an earlier stage failed (fail-fast). */
  skippedCount: number;
  changedUnitCount: number;
  unchangedUnitCount: number;
  batches: ShadowEditorialBatchResult[];
  failure: string | null;
  preEditorialDoc: ArticleDocument | null;
  polishedDoc: ArticleDocument | null;
  perUnitValid: number;
  perUnitInvalid: number;
  tokenUsage: ShadowTokenUsage | null;
  invariantFailures: string[];
  /** Severity-based translation-quality report for the final polished document. */
  quality: QualityReport | null;
  /** Aggregated per-category linter finding counts across editorial batches (diagnostic). */
  styleFindingCounts?: Record<string, number>;
  /** Structured, deterministically localized source references on the final doc. */
  sourceReferences?: SourceReferenceUnit[];
  /** Deterministic source-reference validation findings. */
  sourceFindings?: SourceReferenceFinding[];
  /** Source-reference diagnostics for the preview payload and logs. */
  sourceDiagnostics?: {
    sourceReferenceCount: number;
    localizedTitleCount: number;
    officialLocalizedNameCount: number;
    aiLocalizedTitleCount: number;
    canonicalSourceFailures: number;
  };
}

export interface ShadowPreviewInfo {
  previewOnly: true;
  retainedDoc: ArticleDocument | null;
  retainedSource: "polished" | "partially-polished" | "pre-editorial" | "none";
  stored: boolean;
  exportPath: string | null;
  timestamp: string;
}

export function buildFaqSchemaBlock(faq: FaqEntry[]): ProtectedArticleBlock | null {
  if (faq.length === 0) return null;
  const schemaJson = buildFaqSchemaJson(faq);
  const html = `<!-- wp:html -->\n<script type="application/ld+json">\n${schemaJson}\n</script>\n<!-- /wp:html -->`;
  return { id: "zh-faq-schema", type: "faq-schema", html, fingerprint: fingerprintHtml(html) };
}

/**
 * Assemble a complete Chinese ArticleDocument from validated translated units.
 * Reinserts protected CTA/schema/switcher content unchanged and rebuilds the
 * FAQPage schema deterministically from the Chinese FAQ. Fails safely (returns
 * `missing`) if any substantive source unit is unresolved.
 */
export function assembleShadowDocument(
  enDoc: ArticleDocument,
  sourceDoc: TranslationSourceDocument,
  translatedUnits: Map<string, TranslatedUnitResult>,
): { doc: ArticleDocument | null; missing: string[] } {
  const missing: string[] = [];
  const get = (id: string): TranslatedUnitResult | null => {
    const unit = translatedUnits.get(id);
    if (!unit) missing.push(id);
    return unit ?? null;
  };

  const title = get("metadata.title");
  const meta = get("metadata.metaDescription");
  const excerpt = get("metadata.excerpt");

  const introBlocks: EditorialBlock[] = [];
  for (let i = 0; i < sourceDoc.introduction.length; i++) {
    const u = get(`introduction.block.${i}`);
    if (u?.block) introBlocks.push(u.block);
  }

  const sections: ArticleDocument["sections"] = [];
  for (let si = 0; si < sourceDoc.sections.length; si++) {
    const sec = sourceDoc.sections[si];
    const heading = get(`section.${si}.heading`);
    const blocks: EditorialBlock[] = [];
    for (let bj = 0; bj < sec.blocks.length; bj++) {
      const u = get(`section.${si}.block.${bj}`);
      if (u?.block) blocks.push(u.block);
    }
    sections.push({ id: `zh-section-${si}`, heading: heading?.text ?? "", headingLevel: 2, sectionType: sec.sectionType, blocks, status: "generated" });
  }

  const conclusionBlocks: EditorialBlock[] = [];
  for (let i = 0; i < sourceDoc.conclusion.length; i++) {
    const u = get(`conclusion.block.${i}`);
    if (u?.block) conclusionBlocks.push(u.block);
  }

  const faq: FaqEntry[] = [];
  for (let i = 0; i < sourceDoc.faq.length; i++) {
    const q = get(`faq.${i}.question`);
    const a = get(`faq.${i}.answer`);
    faq.push({
      question: q?.text ?? "",
      answerHtml: a?.answerHtml ?? a?.answerText ?? "",
      answerText: a?.answerText ?? a?.answerHtml ?? "",
    });
  }

  if (missing.length > 0) return { doc: null, missing };

  const doc: ArticleDocument = {
    metadata: {
      title: title?.text ?? "",
      slug: pairedSlugs(enDoc.metadata.slug || "blog-post").chineseSlug,
      metaDescription: meta?.text ?? "",
      excerpt: excerpt?.text ?? "",
      targetWordCount: enDoc.metadata.targetWordCount,
      focusKeyphrase: enDoc.metadata.focusKeyphrase,
    },
    languageSwitcher: enDoc.languageSwitcher,
    introduction: { id: "zh-intro", blocks: introBlocks, status: "generated" },
    sections,
    visibleFaq: faq,
    conclusion: { id: "zh-conc", blocks: conclusionBlocks, status: "generated" },
    cta: enDoc.cta,
    faqSchema: buildFaqSchemaBlock(faq),
    insertedLinks: enDoc.insertedLinks,
  };
  return { doc, missing };
}

function unitsToMap(units: TranslatedUnitResult[]): Map<string, TranslatedUnitResult> {
  const map = new Map<string, TranslatedUnitResult>();
  for (const unit of units) map.set(unit.sourceUnitId, unit);
  return map;
}

/** Rebuild a Chinese ArticleDocument from a flat list of units (used for the polished candidate). */
export function assembleShadowDocumentFromUnits(
  enDoc: ArticleDocument,
  sourceDoc: TranslationSourceDocument,
  units: TranslatedUnitResult[],
): { doc: ArticleDocument | null; missing: string[] } {
  return assembleShadowDocument(enDoc, sourceDoc, unitsToMap(units));
}

// ── Candidate / validation chunk helpers ──

function minimalChunk(sourceDoc: TranslationSourceDocument, units: TranslationSourceUnit[]): TranslationChunk {
  return {
    chunkId: "document",
    role: "document",
    sourceUnitIds: units.map((u) => u.sourceId),
    units,
    documentBrief: buildDocumentBrief(sourceDoc),
    maxOutputTokens: 8000,
    previousChunkContext: null,
    expectedOutputStructure: { kind: "translated-unit-list", description: "", fieldsPerUnit: [] },
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    fingerprint: "document",
  } as unknown as TranslationChunk;
}

function extractChineseUnits(doc: ArticleDocument): TranslationSourceUnit[] {
  const units: TranslationSourceUnit[] = [];
  const pushText = (sourceId: string, type: TranslationSourceUnit["type"], text: string): void => {
    units.push({ sourceId, type, text, links: [], numbers: [] } as TranslationSourceUnit);
  };
  const pushBlock = (sourceId: string, type: TranslationSourceUnit["type"], block: EditorialBlock): void => {
    units.push({ sourceId, type, block, blockIndex: 0, text: "", links: [], numbers: [] } as TranslationSourceUnit);
  };
  pushText("metadata.title", "metadata-title", doc.metadata.title);
  pushText("metadata.metaDescription", "metadata-meta-description", doc.metadata.metaDescription);
  pushText("metadata.excerpt", "metadata-excerpt", doc.metadata.excerpt);
  doc.introduction.blocks.forEach((b, i) => pushBlock(`introduction.block.${i}`, "introduction-block", b));
  doc.sections.forEach((s, si) => {
    pushText(`section.${si}.heading`, "section-heading", s.heading);
    s.blocks.forEach((b, bj) => pushBlock(`section.${si}.block.${bj}`, "section-block", b));
  });
  doc.conclusion.blocks.forEach((b, i) => pushBlock(`conclusion.block.${i}`, "conclusion-block", b));
  doc.visibleFaq.forEach((f, i) => {
    pushText(`faq.${i}.question`, "faq-question", f.question);
    units.push({ sourceId: `faq.${i}.answer`, type: "faq-answer", faqIndex: i, answerHtml: f.answerHtml, answerText: f.answerText, links: [], numbers: [] } as TranslationSourceUnit);
  });
  return units;
}

function parseStructuredEditorial(content: string): unknown {
  const cleaned = content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

// ── Bilingual editorial polish (authoritative batch contracts, patch semantics) ──

export interface ShadowEditorialOptions {
  retryLimit?: number;
  maxOutputTokens?: number;
}

/** A single, authoritative contract for one bilingual revision call. */
export interface EditorialBatch {
  index: number;
  batchId: "a" | "b";
  /** Canonical English source-unit IDs owned by this batch (== editableUnitIds). */
  sourceUnitIds: string[];
  sourceUnits: TranslationSourceUnit[];
  /** The only patchable target unit IDs for this batch (never CTA/protected/schema). */
  editableUnitIds: string[];
  /** Explicit alias of editableUnitIds used for patch-target validation. */
  allowedPatchTargetIds: string[];
  /** Source-reference units owned by this batch (their citation blocks are localized here). */
  sourceReferenceIds: string[];
}

/**
 * Branded editorial patch identity. The serialized identifier VALUE is unchanged
 * from the successful Version 19 run (`section.N.block.M`, `metadata.title`, ...);
 * the brand only prevents implicit interchange with other identifier kinds.
 */
export type EditorialSourceUnitId = string & { readonly __brand: "EditorialSourceUnitId" };

export type EditorialCallPurpose =
  | "editorial-bilingual-a"
  | "editorial-bilingual-b"
  | "editorial-monolingual-proofread";

/** One unit as viewed by an editorial call: English source + current Chinese candidate. */
export interface EditorialUnit {
  sourceUnitId: EditorialSourceUnitId;
  type: TranslationSourceUnit["type"];
  /** English source unit (bilingual) or the Chinese candidate itself (monolingual). */
  source: TranslationSourceUnit;
  /** Current Chinese candidate unit, in the same identity namespace as the source. */
  candidate: TranslationSourceUnit;
  isSourceReference: boolean;
}

/**
 * One authoritative per-call contract. Built ONCE per editorial provider call and
 * consumed by prompt serialization, finding selection, token generation, source
 * selection, allowed-patch-target validation, token ownership validation,
 * duplicate/protected validation, patch application and diagnostics. Nothing is
 * independently reconstructed from a different source.
 */
export interface EditorialCallContract {
  purpose: EditorialCallPurpose;
  orderedUnitIds: readonly EditorialSourceUnitId[];
  allowedPatchTargetIds: ReadonlySet<EditorialSourceUnitId>;
  unitsById: ReadonlyMap<EditorialSourceUnitId, EditorialUnit>;
  findingTokens: readonly string[];
  findingTokenToFindingId: ReadonlyMap<string, string>;
  findingTokenToSourceUnitId: ReadonlyMap<string, EditorialSourceUnitId>;
  sourceReferenceIds: readonly EditorialSourceUnitId[];
  protectedUnitIds: ReadonlySet<EditorialSourceUnitId>;
  patchUnitKey: typeof EDITORIAL_PATCH_UNIT_KEY;
}

/** Convert a plain source ID string to a branded editorial patch identity. */
export function editorialSourceUnitId(id: string): EditorialSourceUnitId {
  return id as EditorialSourceUnitId;
}


/** A stable, machine-readable rejection reason (IDs and codes only, never prose). */
export interface EditorialRejectionReason {
  code: string;
  unitId?: string;
  findingId?: string;
  sourceReferenceId?: string;
  /** The finding response token involved, when applicable. */
  responseToken?: string;
  /** The canonical rule ID for a hard-rule rejection. */
  ruleId?: string;
  /** The exact matched phrase that triggered a hard-rule rejection (safe, never prose). */
  matchedMarkerId?: string;
  /** Whether the affected unit had a returned patch. */
  patchReturned?: boolean;
  /** Whether the returned patch actually changed the unit's content. */
  patchApplied?: boolean;
  /** How the model accounted for the finding token (resolved / reviewed-unchanged / …). */
  modelResolutionStatus?: string;
  /** Number of conflicting variants for a duplicate-unit reason. */
  variantCount?: number;
  /** The actual patch identity key the model returned (for shape diagnostics). */
  receivedIdentityKey?: string;
  /** The unit identifier value received (for shape diagnostics). */
  receivedUnitId?: string;
  /** The expected patch identity key. */
  expectedIdentityKey?: string;
  /** The canonical sourceUnitId for monolingual scope diagnostics. */
  sourceUnitId?: string;
  /** Index of the offending patch in the response units array. */
  patchIndex?: number;
  /** Whether the id appeared in the serialized prompt document units. */
  presentInPrompt?: boolean;
  /** Whether the id appeared in the canonical document. */
  presentInDocument?: boolean;
  /** Whether the id was in the validator's allowed scope. */
  presentInAllowedScope?: boolean;
}

const FINDING_REASON_CODES = {
  missing: "missing-finding-accounting",
  unknown: "unknown-finding-id",
  duplicate: "duplicate-finding-accounting",
} as const;

/**
 * Validate the editorial finding contract as structured reasons. Every supplied
 * finding must be accounted for (resolved or reviewed); every accounted ID must
 * be supplied; an ID may not appear twice in either array.
 */
/**
 * LEGACY-ONLY canonical finding-ID accounting. Reads `resolvedFindingIds` /
 * `reviewedUnchangedFindingIds`. Retained ONLY to validate already-persisted
 * previews and historical test fixtures. MUST NEVER be used for a new provider
 * response — the live editorial path uses `validateFindingTokenReasons` and the
 * `F001` batch-scoped response-token contract.
 */
export function validateFindingContractReasons(findings: StyleFinding[], parsed: unknown, allowedUnitIds?: ReadonlySet<string>): EditorialRejectionReason[] {
  const supplied = new Set(findings.map((f) => f.findingId));
  const reasons: EditorialRejectionReason[] = [];

  // A supplied finding must belong to a unit owned by this batch (authoritative contract).
  if (allowedUnitIds) {
    for (const f of findings) {
      if (!allowedUnitIds.has(f.sourceUnitId)) {
        reasons.push({ code: "finding-outside-batch", findingId: f.findingId, unitId: f.sourceUnitId });
      }
    }
  }

  if (supplied.size === 0) return reasons;
  const rec = parsed as { resolvedFindingIds?: unknown; reviewedUnchangedFindingIds?: unknown };
  const resolved: string[] = Array.isArray(rec.resolvedFindingIds) ? rec.resolvedFindingIds.map(String) : [];
  const reviewed: string[] = Array.isArray(rec.reviewedUnchangedFindingIds) ? rec.reviewedUnchangedFindingIds.map(String) : [];
  const accounted = new Set([...resolved, ...reviewed]);

  const missing = [...supplied].filter((id) => !accounted.has(id));
  for (const id of missing) reasons.push({ code: FINDING_REASON_CODES.missing, findingId: id });

  const unknown = [...accounted].filter((id) => !supplied.has(id));
  for (const id of unknown) reasons.push({ code: FINDING_REASON_CODES.unknown, findingId: id });

  // Duplicate finding accounting: an ID repeated within either array.
  const duplicateIds = new Set<string>();
  for (const arr of [resolved, reviewed]) {
    const seen = new Set<string>();
    for (const id of arr) {
      if (seen.has(id) && supplied.has(id)) duplicateIds.add(id);
      seen.add(id);
    }
  }
  for (const id of duplicateIds) reasons.push({ code: FINDING_REASON_CODES.duplicate, findingId: id });

  return reasons;
}

/**
 * LEGACY-ONLY string form of canonical finding-ID accounting (see
 * `validateFindingContractReasons`). Used only to read persisted previews and
 * historical test fixtures. Never used for a new provider response.
 */
export function validateFindingContract(findings: StyleFinding[], parsed: unknown): string[] {
  const reasons = validateFindingContractReasons(findings, parsed);
  const out: string[] = [];
  const missing = reasons.filter((r) => r.code === FINDING_REASON_CODES.missing).map((r) => r.findingId!);
  if (missing.length > 0) out.push(`finding contract: unresolved findings ${missing.join(",")}`);
  const unknown = reasons.filter((r) => r.code === FINDING_REASON_CODES.unknown).map((r) => r.findingId!);
  if (unknown.length > 0) out.push(`finding contract: unknown finding ids ${unknown.join(",")}`);
  return out;
}

/**
 * Validate the batch-scoped finding RESPONSE TOKENS returned by an editorial
 * call against the authoritative per-batch token map. Canonical finding IDs are
 * never reproduced by the model; tokens are mapped back by the application.
 */
export function validateFindingTokenReasons(
  tokenMap: EditorialFindingToken[],
  parsed: unknown,
  allowedUnitIds?: ReadonlySet<string>,
): EditorialRejectionReason[] {
  const reasons: EditorialRejectionReason[] = [];
  const byToken = new Map(tokenMap.map((t) => [t.responseToken, t]));
  const suppliedTokens = new Set(tokenMap.map((t) => t.responseToken));
  if (suppliedTokens.size === 0) return reasons;

  const rec = parsed as {
    resolvedFindingTokens?: unknown;
    reviewedUnchangedFindingTokens?: unknown;
    reviewedUnchangedFindings?: Array<{ findingToken?: unknown; reasonCode?: unknown }>;
  };
  const resolved = Array.isArray(rec.resolvedFindingTokens) ? rec.resolvedFindingTokens.map(String) : [];
  const flatReviewed = Array.isArray(rec.reviewedUnchangedFindingTokens) ? rec.reviewedUnchangedFindingTokens.map(String) : [];
  const reviewedFindings = Array.isArray(rec.reviewedUnchangedFindings)
    ? rec.reviewedUnchangedFindings.map((x) => ({ token: String(x?.findingToken ?? ""), reason: String(x?.reasonCode ?? "") }))
    : [];
  const reasonByToken = new Map<string, string>();
  for (const r of reviewedFindings) reasonByToken.set(r.token, r.reason);
  // Reviewed-unchanged tokens come from either the legacy flat array or the
  // reason-carrying structure; both must carry a valid reason code.
  const reviewed = [...new Set([...flatReviewed, ...reviewedFindings.map((r) => r.token)])];

  const accounted = new Set<string>();
  const seenResolved = new Set<string>();
  const seenReviewed = new Set<string>();

  const inspect = (token: string, seen: Set<string>): void => {
    if (!isValidFindingResponseToken(token)) {
      // Malformed (e.g. a bare number `1` or a canonical `finding-5`).
      reasons.push({ code: "unknown-finding-token", responseToken: token });
      return;
    }
    const entry = byToken.get(token);
    if (!entry) {
      // Well-formed but not this batch's token (e.g. a token from another batch).
      reasons.push({ code: "finding-token-batch-mismatch", responseToken: token });
      return;
    }
    if (allowedUnitIds && !allowedUnitIds.has(entry.sourceUnitId)) {
      reasons.push({ code: "finding-token-unit-mismatch", responseToken: token, findingId: entry.canonicalFindingId, unitId: entry.sourceUnitId });
      accounted.add(token);
      return;
    }
    if (seen.has(token)) {
      reasons.push({ code: "duplicate-finding-token-accounting", responseToken: token, findingId: entry.canonicalFindingId });
    }
    seen.add(token);
    accounted.add(token);
  };

  for (const token of resolved) inspect(token, seenResolved);
  for (const token of reviewed) inspect(token, seenReviewed);

  // A token may not appear in both accounting arrays.
  for (const token of seenResolved) {
    if (seenReviewed.has(token)) {
      reasons.push({ code: "finding-token-in-both-arrays", responseToken: token, findingId: byToken.get(token)?.canonicalFindingId });
    }
  }

  // Every reviewed-unchanged token must carry exactly one valid reason code.
  for (const token of seenReviewed) {
    const reason = reasonByToken.get(token);
    if (!reason) {
      reasons.push({ code: "missing-reviewed-unchanged-reason", responseToken: token, findingId: byToken.get(token)?.canonicalFindingId });
    } else if (!isValidReviewedUnchangedReasonCode(reason)) {
      reasons.push({ code: "invalid-reviewed-unchanged-reason", responseToken: token, findingId: byToken.get(token)?.canonicalFindingId, matchedMarkerId: reason });
    }
  }

  // Every supplied token must be accounted for exactly once.
  for (const token of suppliedTokens) {
    if (!accounted.has(token)) {
      reasons.push({ code: "missing-finding-token-accounting", responseToken: token, findingId: byToken.get(token)?.canonicalFindingId });
    }
  }

  return reasons;
}

/**
 * Live MONOLINGUAL response: the provider no longer reports resolution. It returns
 * only `units` (genuinely changed units) and `reviewedUnchangedFindings` (findings
 * it deliberately left unchanged, each with one valid closed-set reason). Validate
 * the reviewed-unchanged accounting shape early (tokens supplied, no duplicates,
 * valid reason codes). Resolution itself is derived locally after the post-proofread
 * lint — never from the model's opinion.
 */
export function validateMonolingualReviewedFindings(
  tokenMap: EditorialFindingToken[],
  parsed: unknown,
): { reasons: EditorialRejectionReason[]; reviewedFindings: Array<{ token: string; reason: string }>; reasonByToken: Map<string, string> } {
  const reasons: EditorialRejectionReason[] = [];
  const byToken = new Map(tokenMap.map((t) => [t.responseToken, t]));
  const suppliedTokens = new Set(tokenMap.map((t) => t.responseToken));
  const rec = parsed as { reviewedUnchangedFindings?: Array<{ findingToken?: unknown; reasonCode?: unknown }> };
  const reviewedFindings = Array.isArray(rec.reviewedUnchangedFindings)
    ? rec.reviewedUnchangedFindings.map((x) => ({ token: String(x?.findingToken ?? ""), reason: String(x?.reasonCode ?? "") })).filter((r) => r.token)
    : [];
  const reasonByToken = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of reviewedFindings) {
    if (!suppliedTokens.has(r.token)) {
      reasons.push({ code: "unknown-reviewed-finding-token", responseToken: r.token });
    } else if (seen.has(r.token)) {
      reasons.push({ code: "duplicate-reviewed-finding", responseToken: r.token, findingId: byToken.get(r.token)?.canonicalFindingId });
    } else if (!isValidReviewedUnchangedReasonCode(r.reason)) {
      reasons.push({ code: "invalid-reviewed-unchanged-reason", responseToken: r.token, findingId: byToken.get(r.token)?.canonicalFindingId, matchedMarkerId: r.reason });
    }
    seen.add(r.token);
    if (!reasonByToken.has(r.token)) reasonByToken.set(r.token, r.reason);
  }
  return { reasons, reviewedFindings, reasonByToken };
}

/**
 * Derive the final disposition of every supplied MONOLINGUAL finding locally, by
 * comparing the pre-proofread findings against the post-proofread full-document
 * lint. The final document is the source of truth; model accounting is secondary
 * metadata only. Precedence for every supplied finding:
 *
 *   1. defect absent after proofreading → "resolved" (regardless of whether the
 *      model also listed it in `reviewedUnchangedFindings`);
 *   2. defect still present + valid reviewed-unchanged reason → "reviewed-unchanged";
 *   3. defect still present + no reviewed-unchanged record → "missing-disposition".
 *
 * A reviewed-unchanged entry for a finding that the final lint proved was resolved
 * is harmless stale metadata — it never blocks and is counted separately as
 * `staleReviewedUnchangedCount` (IDs only, never prose).
 */
export function resolveMonolingualFindingDispositions(
  suppliedFindings: StyleFinding[],
  tokenByFindingId: Map<string, string>,
  afterFindings: StyleFinding[],
  reviewedReasonByToken: ReadonlyMap<string, string>,
): {
  dispositions: Map<string, "resolved" | "reviewed-unchanged">;
  reasons: EditorialRejectionReason[];
  locallyResolvedFindingCount: number;
  reviewedUnchangedFindingCount: number;
  missingFindingDispositionCount: number;
  staleReviewedUnchangedCount: number;
  staleReviewedEntries: Array<{ findingToken: string; sourceUnitId: string; ruleId: string }>;
} {
  const afterKeySet = new Set(afterFindings.map((f) => `${f.sourceUnitId}\u0000${f.instructionCode}\u0000${f.safeToken ?? ""}`));
  const reasons: EditorialRejectionReason[] = [];
  const dispositions = new Map<string, "resolved" | "reviewed-unchanged">();
  let locallyResolvedFindingCount = 0;
  let reviewedUnchangedFindingCount = 0;
  let missingFindingDispositionCount = 0;
  let staleReviewedUnchangedCount = 0;
  const staleReviewedEntries: Array<{ findingToken: string; sourceUnitId: string; ruleId: string }> = [];
  for (const f of suppliedFindings) {
    const token = tokenByFindingId.get(f.findingId);
    if (!token) continue;
    const key = `${f.sourceUnitId}\u0000${f.instructionCode}\u0000${f.safeToken ?? ""}`;
    const stillPresent = afterKeySet.has(key);
    const inReviewed = reviewedReasonByToken.has(token);
    if (!stillPresent) {
      // Final document wins: the finding is resolved even if the model listed it
      // reviewed-unchanged (stale metadata, non-blocking).
      dispositions.set(token, "resolved");
      locallyResolvedFindingCount += 1;
      if (inReviewed) {
        staleReviewedUnchangedCount += 1;
        staleReviewedEntries.push({ findingToken: token, sourceUnitId: f.sourceUnitId, ruleId: f.instructionCode });
      }
    } else if (inReviewed) {
      dispositions.set(token, "reviewed-unchanged");
      reviewedUnchangedFindingCount += 1;
    } else {
      reasons.push({ code: "missing-finding-disposition", responseToken: token, unitId: f.sourceUnitId, findingId: f.instructionCode });
      missingFindingDispositionCount += 1;
    }
  }
  return { dispositions, reasons, locallyResolvedFindingCount, reviewedUnchangedFindingCount, missingFindingDispositionCount, staleReviewedUnchangedCount, staleReviewedEntries };
}

/**
 * Build a concise rejection log line from structured reasons. Every reason maps
 * to a stable machine-readable code; no failure ever falls into an unexplained
 * bucket. Only IDs and reason codes are logged (never article prose or reasoning).
 */
function summarizeBatchRejection(batchIndex: number, patchCount: number, changedUnitCount: number, reasons: EditorialRejectionReason[]): string {
  const byCode = new Map<string, number>();
  for (const r of reasons) byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
  const codes = [...byCode.entries()].map(([code, count]) => `${code}=${count}`).join(" ");
  const reasonJson = JSON.stringify(reasons);
  return `[document-context-shadow] editorial batch ${batchIndex} REJECTED | patch=${patchCount} changed=${changedUnitCount} codes=[${codes}] reasons=${reasonJson}`;
}

/**
 * Build exactly TWO bilingual revision batches by deterministically splitting
 * all editable units (excluding CTA) in canonical document order into two
 * contiguous halves. Every editable unit is covered exactly once, with no
 * overlap. The third editorial call (monolingual proofread) runs over the whole
 * revised document and is not part of this partition.
 */
/** Source-unit IDs of citation (source-reference) blocks in the English source document. */
function enumerateSourceReferencePositionsFromSourceDoc(sourceDoc: TranslationSourceDocument): string[] {
  const ids: string[] = [];
  sourceDoc.introduction.forEach((b, i) => { if (isSourceReferenceBlock(b)) ids.push(`introduction.block.${i}`); });
  sourceDoc.sections.forEach((s, si) => s.blocks.forEach((b, bi) => { if (isSourceReferenceBlock(b)) ids.push(`section.${si}.block.${bi}`); }));
  sourceDoc.conclusion.forEach((b, i) => { if (isSourceReferenceBlock(b)) ids.push(`conclusion.block.${i}`); });
  return ids;
}

export function buildBilingualEditorialBatches(sourceDoc: TranslationSourceDocument): EditorialBatch[] {
  const allUnits = enumerateTranslationSourceUnits(sourceDoc).filter((u) => u.type !== "cta");
  const ids = allUnits.map((u) => u.sourceId);
  const mid = Math.ceil(ids.length / 2);
  const grouped = [ids.slice(0, mid), ids.slice(mid)];
  const unitById = new Map<string, TranslationSourceUnit>();
  for (const unit of allUnits) unitById.set(unit.sourceId, unit);

  // Source-reference citation unit IDs owned by each batch (derived from the
  // English source document's citation blocks). The batch that owns a citation
  // unit owns its source-title localization findings.
  const citationIds = new Set<string>();
  for (const pos of enumerateSourceReferencePositionsFromSourceDoc(sourceDoc)) {
    citationIds.add(pos);
  }

  return grouped.map((idsArr, index) => {
    const batchId: "a" | "b" = index === 0 ? "a" : "b";
    const sourceUnits = idsArr.map((id) => unitById.get(id)).filter((u): u is TranslationSourceUnit => u !== undefined);
    return {
      index,
      batchId,
      sourceUnitIds: idsArr,
      sourceUnits,
      editableUnitIds: idsArr,
      allowedPatchTargetIds: idsArr,
      sourceReferenceIds: idsArr.filter((id) => citationIds.has(id)),
    };
  });
}

/** Backwards-compatible alias returning the two bilingual revision batches. */
export function buildEditorialBatches(sourceDoc: TranslationSourceDocument): EditorialBatch[] {
  return buildBilingualEditorialBatches(sourceDoc);
}

function toTranslatedResult(u: TranslationSourceUnit): TranslatedUnitResult {
  if (u.type === "faq-answer") return { sourceUnitId: u.sourceId, answerHtml: u.answerHtml, answerText: u.answerText };
  if (u.type === "introduction-block" || u.type === "section-block" || u.type === "conclusion-block") return { sourceUnitId: u.sourceId, block: u.block };
  if (u.type === "cta") return { sourceUnitId: u.sourceId, html: u.html };
  return { sourceUnitId: u.sourceId, text: u.text };
}

/** Canonical HTML rendering of a translated unit, used to detect content changes and English leakage. */
function renderUnitResult(u: TranslatedUnitResult): string {
  if (u.block) return renderEditorialBlocksToWordPress([u.block]);
  if (u.answerHtml !== undefined || u.answerText !== undefined) return `${u.answerHtml ?? ""}${u.answerText ?? ""}`;
  if (u.html !== undefined) return u.html;
  return u.text ?? "";
}

/** Visible plain text of a translated unit, used for editorial quality hints. */
function candidateUnitText(u: TranslatedUnitResult): string {
  if (u.block) return blockVisibleProseText(u.block);
  if (u.answerText !== undefined) return u.answerText;
  return u.text ?? "";
}

/** Concatenated visible text of any editorial block type (list/table/paragraph). */
function blockVisibleProseText(block: EditorialBlock): string {
  const collect = (nodes: InlineContent[]): string => nodes.map((n) => n.text ?? "").join(" ");
  switch (block.type) {
    case "list":
      return block.items.map(collect).join(" ");
    case "table":
      return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
    default:
      return collect(block.content);
  }
}

/** English source text of an editorial batch's units, for local example retrieval. */
function editorialBatchSourceText(units: TranslationSourceUnit[]): string {
  return units.map((unit) => {
    switch (unit.type) {
      case "introduction-block":
      case "section-block":
      case "conclusion-block":
        return blockVisibleProseText(unit.block);
      case "faq-answer":
        return unit.answerText || unit.answerHtml || "";
      case "cta":
        return unit.html || "";
      default:
        return unit.text || "";
    }
  }).join(" ");
}

function candidateResultsFor(doc: ArticleDocument, sourceUnitIds: string[]): TranslatedUnitResult[] {
  const byId = new Map(extractChineseUnits(doc).map((u) => [u.sourceId, u]));
  return sourceUnitIds
    .map((id) => byId.get(id))
    .filter((u): u is TranslationSourceUnit => Boolean(u))
    .map(toTranslatedResult);
}

function firstHeadingOf(units: TranslatedUnitResult[]): string {
  const heading = units.find((u) => /\.heading$/.test(u.sourceUnitId));
  return heading?.text ?? "";
}

function applyPatchToDoc(doc: ArticleDocument, patchById: Map<string, TranslatedUnitResult>): ArticleDocument {
  const out = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
  const introRe = /^introduction\.block\.(\d+)$/;
  const headingRe = /^section\.(\d+)\.heading$/;
  const blockRe = /^section\.(\d+)\.block\.(\d+)$/;
  const concRe = /^conclusion\.block\.(\d+)$/;
  const faqQRe = /^faq\.(\d+)\.question$/;
  const faqARe = /^faq\.(\d+)\.answer$/;
  for (const [id, p] of patchById) {
    let m: RegExpExecArray | null;
    if (id === "metadata.title") out.metadata.title = p.text ?? "";
    else if (id === "metadata.metaDescription") out.metadata.metaDescription = p.text ?? "";
    else if (id === "metadata.excerpt") out.metadata.excerpt = p.text ?? "";
    else if ((m = introRe.exec(id))) out.introduction.blocks[Number(m[1])] = p.block ?? out.introduction.blocks[Number(m[1])];
    else if ((m = headingRe.exec(id))) out.sections[Number(m[1])].heading = p.text ?? "";
    else if ((m = blockRe.exec(id))) out.sections[Number(m[1])].blocks[Number(m[2])] = p.block ?? out.sections[Number(m[1])].blocks[Number(m[2])];
    else if ((m = concRe.exec(id))) out.conclusion.blocks[Number(m[1])] = p.block ?? out.conclusion.blocks[Number(m[1])];
    else if ((m = faqQRe.exec(id))) out.visibleFaq[Number(m[1])].question = p.text ?? "";
    else if ((m = faqARe.exec(id))) {
      out.visibleFaq[Number(m[1])].answerHtml = p.answerHtml ?? "";
      out.visibleFaq[Number(m[1])].answerText = p.answerText ?? "";
    }
  }
  out.faqSchema = buildFaqSchemaBlock(out.visibleFaq);
  return out;
}

/** Safe before/after hard-rule resolution counts for the monolingual quality gate. */
export interface EditorialQualityGate {
  preExistingActionableHardCount: number;
  suppliedActionableHardCount: number;
  resolvedHardCount: number;
  remainingHardCount: number;
  introducedHardCount: number;
  waivedHardCount: number;
  remainingHardRuleIds: string[];
  introducedHardRuleIds: string[];
  beforeFindingCount: number;
  afterFindingCount: number;
}

interface EditorialRunResult {
  status: EditorialStageStatus;
  accepted: boolean;
  doc: ArticleDocument;
  patchById: Map<string, TranslatedUnitResult>;
  patchCount: number;
  changedUnitCount: number;
  changedUnitIds: string[];
  perUnitValid: number;
  perUnitInvalid: number;
  failures: string[];
  reasons: EditorialRejectionReason[];
  /** Nonfatal diagnostics (exact duplicate patch collapses), IDs + codes only. */
  diagnostics?: EditorialRejectionReason[];
  tokenUsage: ShadowTokenUsage | null;
  /** Length of the provider's returned content characters (diagnostic only). */
  contentChars?: number;
  styleFindingCounts?: Record<string, number>;
  /** Safe observability: unit IDs serialized into the prompt. */
  promptUnitIds?: string[];
  /** Safe observability: allowed patch-target IDs. */
  allowedPatchTargetIds?: string[];
  /** Safe observability: returned patch-target IDs. */
  returnedPatchTargetIds?: string[];
  /** Safe observability: number of patch units returned by the model. */
  returnedPatchCount?: number;
  /** Safe observability: number of returned patches whose reader-facing content actually changed. */
  appliedChangedUnitCount?: number;
  /** Safe observability: number of returned patches that were byte-identical no-ops. */
  noOpPatchCount?: number;
  /** Safe observability: number of finding tokens the model marked resolved. */
  suppliedFindingCount?: number;
  /** Safe observability: findings locally resolved by the application (monolingual). */
  locallyResolvedFindingCount?: number;
  /** Safe observability: number of finding tokens the model marked reviewed-unchanged. */
  reviewedUnchangedFindingCount?: number;
  /** Safe observability: reviewed-unchanged reason-code counts (stable codes only). */
  reviewedUnchangedReasonCounts?: Record<string, number>;
  /** Safe observability: still-present findings without reviewed-unchanged accounting. */
  missingFindingDispositionCount?: number;
  /** Safe observability: reviewed-unchanged entries for findings the final lint resolved (non-blocking). */
  staleReviewedUnchangedCount?: number;
  /** Safe observability: reviewed entries with an unknown finding token (diagnostic only). */
  unknownReviewedFindingCount?: number;
  /** Safe observability: duplicate reviewed entries (diagnostic only). */
  duplicateReviewedFindingCount?: number;
  /** Safe observability: reviewed entries with an invalid reason code (diagnostic only). */
  invalidReviewedReasonCount?: number;
  /** Safe observability: per-finding disposition (IDs only, diagnostic only). */
  findingDispositions?: Array<{ findingToken: string; sourceUnitId: string; ruleId: string; disposition: "resolved" | "reviewed-unchanged" | "missing-disposition" | "stale-reviewed" }>;
  /** Safe observability: finding response tokens supplied in the prompt. */
  suppliedFindingTokens?: string[];
  /** Safe observability: finding tokens the model marked resolved. */
  returnedResolvedFindingTokens?: string[];
  /** Safe observability: finding tokens the model marked reviewed-unchanged. */
  returnedReviewedFindingTokens?: string[];
  /** Safe observability: source-reference unit IDs in scope. */
  sourceReferenceIds?: string[];
  /** Safe observability: before/after hard-rule resolution counts for the monolingual quality gate. */
  qualityGate?: EditorialQualityGate;
}

function rejectedRun(currentDoc: ArticleDocument, reasons: EditorialRejectionReason[], tokenUsage: ShadowTokenUsage | null, overrides?: Partial<EditorialRunResult>): EditorialRunResult {
  const status: EditorialStageStatus = overrides?.status ?? "validation-rejected";
  return {
    status,
    accepted: false,
    doc: currentDoc,
    patchById: new Map(),
    patchCount: 0,
    changedUnitCount: 0,
    changedUnitIds: [],
    perUnitValid: 0,
    perUnitInvalid: 0,
    failures: [],
    reasons,
    tokenUsage,
    ...overrides,
  };
}

/** Scope findings to the batch's owned, editable patch targets only. */
function scopeFindingsToBatch(findings: StyleFinding[], batch: EditorialBatch): StyleFinding[] {
  const allowed = new Set(batch.allowedPatchTargetIds);
  return findings.filter((f) => allowed.has(f.sourceUnitId));
}

async function runShadowEditorialBatch(
  enDoc: ArticleDocument,
  sourceDoc: TranslationSourceDocument,
  brief: ReturnType<typeof buildDocumentBrief>,
  batch: EditorialBatch,
  currentDoc: ArticleDocument,
  previousContext: string,
  nextHeading: string,
  callProvider: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>,
  label: string,
  brandPrinciples = "",
): Promise<EditorialRunResult> {
  const candidateResults = candidateResultsFor(currentDoc, batch.sourceUnitIds);
  const candidateUnits = extractChineseUnits(currentDoc).filter((u) => batch.sourceUnitIds.includes(u.sourceId));

  // Unit-level editorial review hints derived from the existing quality
  // classifier (minor/major English findings only). No extra provider call.
  const draftUnits = candidateResults.map((cr) => ({ sourceUnitId: cr.sourceUnitId, text: candidateUnitText(cr) }));
  const qualityHints = buildShadowQualityHints(draftUnits);
  const scopedFindings = scopeFindingsToBatch(lintEditorialDraft(draftUnits), batch);
  const tokenMap = buildFindingTokenMap(scopedFindings);
  const findingsPrompt = buildEditorialFindingsPrompt(scopedFindings, tokenMap);
  const styleFindingCounts: Record<string, number> = {};
  for (const f of scopedFindings) styleFindingCounts[f.category] = (styleFindingCounts[f.category] ?? 0) + 1;

  // ── Build ONE authoritative contract for this call ──
  const contract = buildEditorialCallContract({
    purpose: batch.batchId === "a" ? "editorial-bilingual-a" : "editorial-bilingual-b",
    orderedSourceUnitIds: batch.sourceUnitIds,
    sourceUnits: batch.sourceUnits,
    candidateUnits,
    findings: scopedFindings,
    tokenMap,
    sourceReferenceIds: batch.sourceReferenceIds,
    protectedUnitIds: new Set(["cta"]),
  });

  // ── Validate contract invariants locally before any provider call ──
  const invariantReasons = validateEditorialCallContract(contract);
  if (invariantReasons.length > 0) {
    return rejectedRun(currentDoc, invariantReasons, null, { status: "validation-rejected" });
  }

  // Prompt units come from the contract (never rebuilt elsewhere).
  const sourceUnits = contract.orderedUnitIds.map((id) => contract.unitsById.get(id)!.source);
  const chineseCandidateUnits = contract.orderedUnitIds.map((id) => contract.unitsById.get(id)!.candidate);
  const candidateChunk = minimalChunk(sourceDoc, chineseCandidateUnits);
  const { protectedChunk, restoreStates } = protectChunkForSubmission(candidateChunk);

  // Local, deterministic retrieval of approved Cantonese style examples for this
  // batch's units (deduped by ID via the retrieval budget).
  const retrieved = retrieveCantoneseExamples(editorialBatchSourceText(sourceUnits), { domainTerm: "editorial" });
  const styleExamples = buildLanguagePackExamplePrompt(retrieved);

  let response: ShadowProviderResponse;
  try {
    const routing = resolveModelRouting(label);
    response = await callProvider(
      buildShadowEditorialBatchMessages(brief, sourceUnits, protectedChunk.units, previousContext, nextHeading, qualityHints, styleExamples, findingsPrompt, brandPrinciples),
      { maxTokens: routing.maxTokens, timeoutMs: routing.timeoutMs, temperature: 0.3, model: routing.model, thinkingMode: routing.thinkingMode, reasoningEffort: routing.reasoningEffort, responseFormat: { type: "json_object" }, maxRetries: 0 },
      label,
    );
  } catch {
    return rejectedRun(currentDoc, [{ code: "provider-error" }], null, { status: "provider-failed" });
  }
  const contentChars = response.content.length;

  let parsed: unknown;
  try {
    parsed = parseStructuredEditorial(response.content);
  } catch {
    return rejectedRun(currentDoc, [{ code: "malformed-response" }], response.usage ?? null, { contentChars });
  }

  // Validate the finding RESPONSE TOKENS against the contract's token map + scope.
  const findingReasons = validateFindingTokenReasons(contractTokenMap(contract), parsed, new Set(contract.allowedPatchTargetIds));
  const patchUnits = (parsed as { units?: TranslatedUnitResult[] }).units ?? [];
  const rec = parsed as { resolvedFindingTokens?: unknown; reviewedUnchangedFindingTokens?: unknown };

  // Safe observability captured from the response, shared by every accept/reject path
  // below so a rejected stage retains the same diagnostics as an accepted one. Real
  // change counts (appliedChangedUnitCount / noOpPatchCount) are filled in once the
  // restored patches are compared with the candidates.
  const baseObservability = {
    returnedPatchCount: patchUnits.length,
    appliedChangedUnitCount: 0,
    noOpPatchCount: 0,
    returnedPatchTargetIds: patchUnits.map((u) => u.sourceUnitId),
    suppliedFindingTokens: contract.findingTokens as unknown as string[],
    returnedResolvedFindingTokens: Array.isArray(rec.resolvedFindingTokens) ? rec.resolvedFindingTokens.map(String) : [],
    returnedReviewedFindingTokens: Array.isArray(rec.reviewedUnchangedFindingTokens) ? rec.reviewedUnchangedFindingTokens.map(String) : [],
  };

  if (findingReasons.length > 0) {
    return rejectedRun(currentDoc, findingReasons, response.usage ?? null, { contentChars, ...baseObservability });
  }

  // Runtime response-shape validation (before scope). Enforces the shared
  // `sourceUnitId` key and reports legacy-shaped `unitId` patches clearly.
  const batchUnitById = new Map(contract.orderedUnitIds.map((id) => [id, contract.unitsById.get(id)!.candidate]));
  const shapeReasons = validateEditorialPatchShape(patchUnits, batchUnitById);
  if (shapeReasons.length > 0) {
    return rejectedRun(currentDoc, shapeReasons, response.usage ?? null, { contentChars, changedUnitCount: 0, ...baseObservability });
  }

  // Validate patch targets against the contract's allowed scope (bilingual half).
  const allowed = new Set(contract.allowedPatchTargetIds);
  const patchReasons: EditorialRejectionReason[] = [];
  const seen = new Set<string>();
  for (const unit of patchUnits) {
    if (!allowed.has(editorialSourceUnitId(unit.sourceUnitId))) {
      patchReasons.push({ code: "patch-target-outside-batch", unitId: unit.sourceUnitId });
    } else if (seen.has(unit.sourceUnitId)) {
      patchReasons.push({ code: "duplicate-unit-patch", unitId: unit.sourceUnitId });
    }
    seen.add(unit.sourceUnitId);
  }
  if (patchReasons.length > 0) {
    return rejectedRun(currentDoc, patchReasons, response.usage ?? null, { contentChars, changedUnitCount: 0, ...baseObservability });
  }

  const restored = restoreResponseUnits(patchUnits, restoreStates);
  const patchById = new Map(restored.units.map((u) => [u.sourceUnitId, u]));

  // Validate the full batch (patch applied over unchanged candidate units), not the patch alone.
  const fullBatchResponse = candidateResults.map((cr) => patchById.get(cr.sourceUnitId) ?? cr);
  const batchChunk = minimalChunk(sourceDoc, sourceUnits);
  const validation = validateStructuredChunkResponse(batchChunk, { units: fullBatchResponse });
  const perUnitValid = validation.units.filter((u) => u.valid).length;
  const perUnitInvalid = validation.units.filter((u) => !u.advisory && !u.valid).length;

  // Real-change accounting: only patches whose reader-facing content differs from the
  // candidate count as applied changes; byte-identical patches are no-ops (diagnostics).
  const candidateById = new Map(candidateResults.map((cr) => [cr.sourceUnitId, cr]));
  const changedForEnglish = [...patchById.values()].filter((u) => {
    const current = candidateById.get(u.sourceUnitId);
    return !current || renderUnitResult(current) !== renderUnitResult(u);
  });
  const appliedChangedUnitCount = changedForEnglish.length;
  const observability = {
    ...baseObservability,
    appliedChangedUnitCount,
    noOpPatchCount: patchUnits.length - appliedChangedUnitCount,
  };

  if (!validation.valid) {
    const validationReasons = validation.errors.map((e) => ({ code: validationErrorCode(e), unitId: validationErrorUnitId(e) }));
    return rejectedRun(currentDoc, validationReasons, response.usage ?? null, {
      contentChars, patchCount: patchUnits.length, perUnitValid, perUnitInvalid, changedUnitCount: appliedChangedUnitCount, changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId), ...observability,
    });
  }

  const newDoc = applyPatchToDoc(currentDoc, patchById);

  // English-leak validation is scoped to the units ACTUALLY changed by this
  // patch. Each changed unit is checked individually so the failing source-unit
  // ID and category can be recorded (never article text).
  const englishReasons: EditorialRejectionReason[] = [];
  for (const unit of changedForEnglish) {
    const unitHtml = renderUnitResult(unit);
    const categories: string[] = [];
    if (hasExcessiveEnglish(unitHtml)) categories.push("excessive-english");
    if (hasEnglishHeavyProseBlock(unitHtml)) categories.push("english-heavy-prose-block");
    if (categories.length > 0) englishReasons.push({ code: "english-leak", unitId: unit.sourceUnitId });
  }
  if (englishReasons.length > 0) {
    return rejectedRun(currentDoc, englishReasons, response.usage ?? null, {
      contentChars, patchCount: patchUnits.length, perUnitValid, perUnitInvalid, changedUnitCount: appliedChangedUnitCount, changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId), ...observability,
    });
  }

  return {
    status: "accepted", accepted: true, contentChars, doc: newDoc, patchById, patchCount: patchUnits.length, changedUnitCount: appliedChangedUnitCount,
    changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId), perUnitValid, perUnitInvalid, failures: [], reasons: [], tokenUsage: response.usage ?? null, styleFindingCounts,
    promptUnitIds: contract.orderedUnitIds as unknown as string[],
    allowedPatchTargetIds: [...contract.allowedPatchTargetIds] as unknown as string[],
    sourceReferenceIds: contract.sourceReferenceIds as unknown as string[],
    ...observability,
  };
}

/** Map a structured-validation error string to a stable rejection code. */
function validationErrorCode(error: string): string {
  if (/unknown source unit/.test(error)) return "unknown-patch-target";
  if (/duplicated source unit/.test(error)) return "duplicate-unit-patch";
  if (/unit count mismatch/.test(error)) return "unit-count-mismatch";
  if (/out of canonical order/.test(error)) return "patch-order-violation";
  if (/missing translated (text|block|answer)|missing translated content|missing from response/.test(error)) return "missing-field";
  if (/number parity|numbers? (lost|extra)|unexpected numbers|placeholder/.test(error)) return "number-parity";
  if (/URL parity|URLs? (lost|changed)|unexpected URLs/.test(error)) return "url-parity";
  if (/structure parity|block structure changed/.test(error)) return "structure-parity";
  return "validation-error";
}

/** Best-effort unit ID extracted from a validation error string (never required). */
function validationErrorUnitId(error: string): string | undefined {
  const m = /([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)/i.exec(error);
  return m ? m[1] : undefined;
}

/**
 * Classify duplicate patch entries per unitId. Exact duplicates (byte-identical
 * rendered output) are deterministically collapsed into one patch (nonfatal);
 * conflicting duplicates (different text/metadata) are fatal. Never first-wins or
 * last-wins on conflicts.
 */
export function classifyDuplicatePatchUnits(patchUnits: TranslatedUnitResult[]): {
  units: TranslatedUnitResult[];
  diagnostics: EditorialRejectionReason[];
  fatalReasons: EditorialRejectionReason[];
} {
  const grouped = new Map<string, TranslatedUnitResult[]>();
  for (const u of patchUnits) {
    const arr = grouped.get(u.sourceUnitId);
    if (arr) arr.push(u);
    else grouped.set(u.sourceUnitId, [u]);
  }
  const units: TranslatedUnitResult[] = [];
  const diagnostics: EditorialRejectionReason[] = [];
  const fatalReasons: EditorialRejectionReason[] = [];
  for (const [id, group] of grouped) {
    if (group.length === 1) {
      units.push(group[0]);
      continue;
    }
    const firstRendered = renderUnitResult(group[0]);
    const allIdentical = group.every((u) => renderUnitResult(u) === firstRendered);
    if (allIdentical) {
      units.push(group[0]);
      diagnostics.push({ code: "exact-duplicate-unit-patch-collapsed", unitId: id });
    } else {
      fatalReasons.push({ code: "conflicting-duplicate-unit-patch", unitId: id, variantCount: group.length });
    }
  }
  return { units, diagnostics, fatalReasons };
}

/** The revised-content field a patch must carry for a given source unit type. */
function requiredContentField(unit: TranslationSourceUnit | undefined): "text" | "block" | "answerHtml" | "answerText" | null {
  if (!unit) return null;
  switch (unit.type) {
    case "metadata-title":
    case "metadata-meta-description":
    case "metadata-excerpt":
    case "section-heading":
    case "faq-question":
      return "text";
    case "introduction-block":
    case "section-block":
    case "conclusion-block":
      return "block";
    case "faq-answer":
      return "answerHtml";
    case "cta":
      return null;
    default:
      return null;
  }
}

/**
 * Strict runtime validation of each returned editorial patch object after
 * `JSON.parse`. This never relies on a TypeScript interface, never silently
 * normalizes `unitId` → `sourceUnitId`, and reports named shape failures so a
 * prompt/schema drift cannot hide behind a scope error.
 */
export function validateEditorialPatchShape(
  patchUnits: unknown[],
  unitById: Map<string, TranslationSourceUnit>,
): EditorialRejectionReason[] {
  const reasons: EditorialRejectionReason[] = [];
  patchUnits.forEach((raw, index) => {
    const obj = raw as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      reasons.push({ code: "invalid-patch-object", patchIndex: index });
      return;
    }
    const id = obj[EDITORIAL_PATCH_UNIT_KEY];
    if (id === undefined) {
      // Detect a legacy-shaped patch that substituted `unitId` for the key.
      const legacy = (obj as Record<string, unknown>).unitId;
      if (legacy !== undefined) {
        reasons.push({
          code: "unexpected-patch-identity-key",
          receivedIdentityKey: "unitId",
          receivedUnitId: String(legacy),
          expectedIdentityKey: EDITORIAL_PATCH_UNIT_KEY,
          patchIndex: index,
        });
      } else {
        reasons.push({ code: "missing-source-unit-id", patchIndex: index });
      }
      return;
    }
    if (typeof id !== "string" || id.trim() === "") {
      reasons.push({ code: "invalid-source-unit-id", sourceUnitId: String(id), patchIndex: index });
      return;
    }
    const unit = unitById.get(id);
    if (!unit) {
      // Unknown target: content-shape cannot be validated here; scope check reports it.
      return;
    }
    const field = requiredContentField(unit);
    if (field === "text" && typeof obj.text !== "string") {
      reasons.push({ code: "invalid-patch-content", sourceUnitId: id, patchIndex: index });
    } else if (field === "block" && (typeof obj.block !== "object" || obj.block === null)) {
      reasons.push({ code: "invalid-patch-content", sourceUnitId: id, patchIndex: index });
    } else if (field === "answerHtml" && obj.answerHtml === undefined && obj.answerText === undefined) {
      reasons.push({ code: "invalid-patch-content", sourceUnitId: id, patchIndex: index });
    }
  });
  return reasons;
}

/** True when a parsed source ID refers to a protected (CTA) unit. */
function isProtectedPatchTarget(sourceUnitId: string): boolean {
  return parseTranslationSourceId(sourceUnitId)?.kind === "cta";
}

/** Deduplicate actionable hard findings by (sourceUnitId, ruleId) so each has exactly one supplied token. */
function dedupeActionableHard(actionable: ActionableHardFinding[]): ActionableHardFinding[] {
  const seen = new Set<string>();
  const out: ActionableHardFinding[] = [];
  for (const a of actionable) {
    const key = `${a.sourceUnitId}\u0000${a.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Compute presence flags for a patch target across the prompt/document/allowed sets. */
function scopeFlags(sourceUnitId: string, promptIds: Set<string>, documentIds: Set<string>, allowedIds: Set<string>): {
  presentInPrompt: boolean;
  presentInDocument: boolean;
  presentInAllowedScope: boolean;
} {
  return {
    presentInPrompt: promptIds.has(sourceUnitId),
    presentInDocument: documentIds.has(sourceUnitId),
    presentInAllowedScope: allowedIds.has(sourceUnitId),
  };
}

/**
 * Build the single authoritative contract for one editorial provider call. All
 * unit identity, finding tokens and scopes are derived here; the returned contract
 * is the ONLY source of truth for prompt building and validation. Throws on
 * misaligned source/candidate units so a scope cannot silently diverge.
 */
export function buildEditorialCallContract(opts: {
  purpose: EditorialCallPurpose;
  orderedSourceUnitIds: string[];
  sourceUnits: TranslationSourceUnit[];
  candidateUnits: TranslationSourceUnit[];
  findings: StyleFinding[];
  tokenMap: EditorialFindingToken[];
  sourceReferenceIds: string[];
  protectedUnitIds: ReadonlySet<string>;
}): EditorialCallContract {
  const sourceById = new Map(opts.sourceUnits.map((u) => [u.sourceId, u]));
  const candidateById = new Map(opts.candidateUnits.map((u) => [u.sourceId, u]));
  const sourceRefSet = new Set(opts.sourceReferenceIds);

  const unitsById = new Map<EditorialSourceUnitId, EditorialUnit>();
  for (const id of opts.orderedSourceUnitIds) {
    const source = sourceById.get(id);
    const candidate = candidateById.get(id);
    if (!source) throw new Error(`Editorial contract missing source unit for "${id}"`);
    if (!candidate) throw new Error(`Editorial contract missing candidate unit for "${id}"`);
    unitsById.set(editorialSourceUnitId(id), {
      sourceUnitId: editorialSourceUnitId(id),
      type: source.type,
      source,
      candidate,
      isSourceReference: sourceRefSet.has(id),
    });
  }

  const findingTokenToFindingId = new Map<string, string>();
  const findingTokenToSourceUnitId = new Map<string, EditorialSourceUnitId>();
  for (const t of opts.tokenMap) {
    findingTokenToFindingId.set(t.responseToken, t.canonicalFindingId);
    findingTokenToSourceUnitId.set(t.responseToken, editorialSourceUnitId(t.sourceUnitId));
  }

  return {
    purpose: opts.purpose,
    orderedUnitIds: opts.orderedSourceUnitIds.map(editorialSourceUnitId),
    allowedPatchTargetIds: new Set(opts.orderedSourceUnitIds.map(editorialSourceUnitId)),
    unitsById,
    findingTokens: opts.tokenMap.map((t) => t.responseToken),
    findingTokenToFindingId,
    findingTokenToSourceUnitId,
    sourceReferenceIds: opts.sourceReferenceIds.map(editorialSourceUnitId),
    protectedUnitIds: new Set([...opts.protectedUnitIds].map(editorialSourceUnitId)),
    patchUnitKey: EDITORIAL_PATCH_UNIT_KEY,
  };
}

/** Locally verify every contract invariant before a provider call. Fatal reasons stop the call. */
export function validateEditorialCallContract(contract: EditorialCallContract): EditorialRejectionReason[] {
  const reasons: EditorialRejectionReason[] = [];
  const ordered = new Set(contract.orderedUnitIds);

  // orderedUnitIds are unique
  if (contract.orderedUnitIds.length !== ordered.size) {
    const dups = [...new Set(contract.orderedUnitIds.filter((id, i) => contract.orderedUnitIds.indexOf(id) !== i))];
    reasons.push({ code: "contract-ordered-unit-ids-not-unique", unitId: dups[0] });
  }

  // allowedPatchTargetIds exactly equal orderedUnitIds
  const allowed = contract.allowedPatchTargetIds;
  if (allowed.size !== ordered.size || [...allowed].some((id) => !ordered.has(id))) {
    reasons.push({ code: "contract-allowed-scope-mismatch" });
  }

  // every unitsById key appears in orderedUnitIds
  for (const key of contract.unitsById.keys()) {
    if (!ordered.has(key)) reasons.push({ code: "contract-unitsbyid-not-in-ordered", unitId: key });
  }

  // every finding token maps to one known finding
  for (const token of contract.findingTokens) {
    if (!contract.findingTokenToFindingId.has(token)) reasons.push({ code: "contract-token-no-finding", responseToken: token });
  }

  // every finding token maps to one allowed sourceUnitId
  for (const token of contract.findingTokens) {
    const owner = contract.findingTokenToSourceUnitId.get(token);
    if (!owner || !allowed.has(owner)) reasons.push({ code: "contract-token-owner-outside-scope", responseToken: token });
  }

  // no protected unit appears in allowedPatchTargetIds
  for (const protectedId of contract.protectedUnitIds) {
    if (allowed.has(protectedId)) reasons.push({ code: "contract-protected-unit-in-scope", unitId: protectedId });
  }

  // every source-reference editable unit appears in the intended scope
  for (const refId of contract.sourceReferenceIds) {
    if (!ordered.has(refId)) reasons.push({ code: "contract-source-ref-outside-scope", sourceReferenceId: refId });
  }

  return reasons;
}

/** Bilingual A ∪ B must equal the complete bilingual-editable set, with no overlap. */
export function validateBilingualCoverage(contractA: EditorialCallContract, contractB: EditorialCallContract, completeEditableIds: string[]): EditorialRejectionReason[] {
  const reasons: EditorialRejectionReason[] = [];
  const a = new Set(contractA.orderedUnitIds);
  const b = new Set(contractB.orderedUnitIds);
  const overlap = [...a].filter((id) => b.has(id));
  if (overlap.length > 0) reasons.push({ code: "bilingual-batch-overlap", unitId: overlap[0] });
  const union = new Set([...a, ...b]);
  const missing = completeEditableIds.filter((id) => !union.has(editorialSourceUnitId(id)));
  if (missing.length > 0) reasons.push({ code: "bilingual-coverage-incomplete", unitId: missing[0] });
  return reasons;
}

/** Reconstruct the token-map view of a contract (single source: the contract). */
export function contractTokenMap(contract: EditorialCallContract): EditorialFindingToken[] {
  return contract.findingTokens.map((token) => ({
    canonicalFindingId: contract.findingTokenToFindingId.get(token) ?? token,
    responseToken: token,
    sourceUnitId: contract.findingTokenToSourceUnitId.get(token) ?? "",
  }));
}

/**
 * Run the full-document monolingual proofread over the complete revised Chinese
 * document (thinking disabled). The model receives the whole Chinese article as
 * one coherent unit list plus compact immutable constraints — no English prose
 * beside each unit. It may patch editable units from any article section.
 */
async function runShadowMonolingualProofread(
  sourceDoc: TranslationSourceDocument,
  currentDoc: ArticleDocument,
  callProvider: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>,
  label: string,
  registerGuidance = "",
): Promise<EditorialRunResult> {
  const allUnits = extractChineseUnits(currentDoc).filter((u) => u.type !== "cta");
  const unitIds = allUnits.map((u) => u.sourceId);
  if (new Set(unitIds).size !== unitIds.length) {
    const dup = [...new Set(unitIds.filter((id, i) => unitIds.indexOf(id) !== i))];
    return rejectedRun(currentDoc, [{ code: "duplicate-input-source-unit", unitId: dup[0] }], null, { status: "validation-rejected" });
  }

  // Monolingual, document-level findings over the whole revised Chinese document.
  const draftUnits = allUnits.map((u) => ({ sourceUnitId: u.sourceId, text: candidateUnitText(toTranslatedResult(u)) }));
  const monolingualFindings = lintMonolingualDocument(draftUnits);
  const monoTokenMap = buildFindingTokenMap(monolingualFindings);
  const monolingualFindingsPrompt = buildMonolingualFindingsPrompt(monolingualFindings, monoTokenMap);
  const styleFindingCounts: Record<string, number> = {};
  for (const f of monolingualFindings) styleFindingCounts[f.category] = (styleFindingCounts[f.category] ?? 0) + 1;

  // Locally built terminology ledger (no API call) from the revised Chinese text.
  const ledger = buildTerminologyLedger(draftUnits.map((d) => d.text));
  const ledgerPrompt = buildTerminologyLedgerPrompt(ledger);

  // Source-reference editable units within the monolingual scope (citation blocks).
  const sourceReferenceIds = allUnits
    .filter((u) => (u.type === "introduction-block" || u.type === "section-block" || u.type === "conclusion-block") && u.block && isSourceReferenceBlock(u.block))
    .map((u) => u.sourceId);

  // ── Build ONE authoritative contract for this call ──
  const contract = buildEditorialCallContract({
    purpose: "editorial-monolingual-proofread",
    orderedSourceUnitIds: unitIds,
    sourceUnits: allUnits,
    candidateUnits: allUnits,
    findings: monolingualFindings,
    tokenMap: monoTokenMap,
    sourceReferenceIds,
    protectedUnitIds: new Set(["cta"]),
  });

  // ── Validate contract invariants locally before any provider call ──
  const invariantReasons = validateEditorialCallContract(contract);
  if (invariantReasons.length > 0) {
    return rejectedRun(currentDoc, invariantReasons, null, { status: "validation-rejected" });
  }

  // ── Actionable hard-finding delivery (before the provider call) ──
  // Every actionable hard finding across the full editable document must be
  // supplied to the proofreader with exactly one response token. A missing token
  // fails locally before any provider call with hard-rule-finding-not-supplied.
  const tokenByFindingId = new Map(monoTokenMap.map((t) => [t.canonicalFindingId, t.responseToken]));
  const protectedSet = new Set(contract.protectedUnitIds);
  const isProtectedUnit = (id: string): boolean => protectedSet.has(editorialSourceUnitId(id));
  const waiverFor = (f: StyleFinding): HardFindingWaiverCode | undefined => {
    if (f.safeToken && /^https?:\/\//i.test(f.safeToken)) return "url-part";
    if (f.safeToken && APPROVED_ENGLISH_TERMS.has(f.safeToken)) return "approved-brand";
    return undefined;
  };
  const classification: HardFindingClassification = classifyHardFindings(monolingualFindings, { isProtectedUnit, waiverFor });
  const actionableBefore = dedupeActionableHard(classification.actionable);
  const waivedHard = classification.waived;
  const suppliedActionableHardCount = actionableBefore.length;
  const missingHard = actionableBefore.filter((a) => !tokenByFindingId.has(a.findingId ?? ""));
  if (missingHard.length > 0) {
    const reasons = missingHard.map((a) => ({ code: "hard-rule-finding-not-supplied", unitId: a.sourceUnitId, findingId: a.ruleId }));
    return rejectedRun(currentDoc, reasons, null, { status: "validation-rejected" });
  }
  // Deterministic waivers only — free-form model waivers are rejected.
  const invalidWaiver = waivedHard.filter((w) => !isValidHardFindingWaiver(w.waiverCode));

  // Prompt document units are taken from the contract (never rebuilt elsewhere).
  const chineseUnits = contract.orderedUnitIds.map((id) => contract.unitsById.get(id)!.candidate);
  const candidateChunk = minimalChunk(sourceDoc, chineseUnits);
  const { protectedChunk, restoreStates } = protectChunkForSubmission(candidateChunk);

  const hasSourceReferences = Boolean(currentDoc.sourceReferences && currentDoc.sourceReferences.length > 0);
  const constraints = buildMonolingualConstraints({ hasSourceReferences });

  let response: ShadowProviderResponse;
  try {
    const routing = resolveModelRouting(label);
    response = await callProvider(
      buildShadowMonolingualMessages(protectedChunk.units, {
        constraints,
        terminologyLedger: ledgerPrompt,
        monolingualFindingsPrompt,
        registerGuidance,
      }),
      { maxTokens: routing.maxTokens, timeoutMs: routing.timeoutMs, temperature: 0.3, model: routing.model, thinkingMode: routing.thinkingMode, reasoningEffort: routing.reasoningEffort, responseFormat: { type: "json_object" }, maxRetries: 0 },
      label,
    );
  } catch {
    return rejectedRun(currentDoc, [{ code: "provider-error" }], null, { status: "provider-failed" });
  }
  const contentChars = response.content.length;

  let parsed: unknown;
  try {
    parsed = parseStructuredEditorial(response.content);
  } catch {
    return rejectedRun(currentDoc, [{ code: "malformed-response" }], response.usage ?? null, { contentChars });
  }

  // Finding-token ownership validation from the contract (MONOLINGUAL only accepts
  // `reviewedUnchangedFindings`; the model no longer reports resolution — it is
  // derived locally after the post-proofread lint). Model bookkeeping shape issues
  // (unknown/duplicate/invalid reviewed reasons) are DIAGNOSTIC ONLY — they never
  // reject an otherwise valid article. The final document is the source of truth.
  const { reasons: reviewedShapeReasons, reviewedFindings, reasonByToken } = validateMonolingualReviewedFindings(contractTokenMap(contract), parsed);
  const patchUnits = (parsed as { units?: TranslatedUnitResult[] }).units ?? [];
  const reviewedTokenSet = new Set(reviewedFindings.map((r) => r.token));

  // Safe observability captured from the response, shared by every accept/reject path
  // so a rejected stage retains the same diagnostics as an accepted one. Real change
  // counts (appliedChangedUnitCount / noOpPatchCount) are filled in once the restored
  // patches are compared with the candidates. The live monolingual schema has no
  // resolved tokens, so returnedResolvedFindingTokens is always empty here.
  const baseObservability = {
    returnedPatchCount: patchUnits.length,
    appliedChangedUnitCount: 0,
    noOpPatchCount: 0,
    returnedPatchTargetIds: patchUnits.map((u) => u.sourceUnitId),
    suppliedFindingTokens: contract.findingTokens as unknown as string[],
    returnedResolvedFindingTokens: [] as string[],
    returnedReviewedFindingTokens: [...reviewedTokenSet],
  };
  const reviewedMetadataDiagnostics = {
    unknownReviewedFindingCount: reviewedShapeReasons.filter((r) => r.code === "unknown-reviewed-finding-token").length,
    duplicateReviewedFindingCount: reviewedShapeReasons.filter((r) => r.code === "duplicate-reviewed-finding").length,
    invalidReviewedReasonCount: reviewedShapeReasons.filter((r) => r.code === "invalid-reviewed-unchanged-reason").length,
  };

  // ── 1. Runtime response-shape validation (before any scope check) ──
  const shapeUnitById = new Map(contract.orderedUnitIds.map((id) => [id, contract.unitsById.get(id)!.candidate]));
  const shapeReasons = validateEditorialPatchShape(patchUnits, shapeUnitById);
  if (shapeReasons.length > 0) {
    return rejectedRun(currentDoc, shapeReasons, response.usage ?? null, { contentChars, changedUnitCount: 0, ...baseObservability });
  }

  // ── 2. Patch-target scope validation from the contract (only after shape) ──
  const allowedIds = new Set(contract.allowedPatchTargetIds);
  const patchReasons: EditorialRejectionReason[] = [];
  for (const unit of patchUnits) {
    const id = unit.sourceUnitId;
    if (contract.protectedUnitIds.has(editorialSourceUnitId(id)) || isProtectedPatchTarget(id)) {
      patchReasons.push({ code: "protected-patch-target", sourceUnitId: id, ...scopeFlags(id, allowedIds, allowedIds, allowedIds) });
    } else if (!allowedIds.has(editorialSourceUnitId(id))) {
      patchReasons.push({ code: "unknown-patch-target", sourceUnitId: id, ...scopeFlags(id, allowedIds, allowedIds, allowedIds) });
    }
  }
  if (patchReasons.length > 0) {
    return rejectedRun(currentDoc, patchReasons, response.usage ?? null, { contentChars, changedUnitCount: 0, ...baseObservability });
  }

  // Classify duplicate patches: exact duplicates are collapsed (nonfatal);
  // conflicting duplicates are fatal (never first-wins / last-wins).
  const classified = classifyDuplicatePatchUnits(patchUnits);
  if (classified.fatalReasons.length > 0) {
    return rejectedRun(currentDoc, classified.fatalReasons, response.usage ?? null, { contentChars, changedUnitCount: 0, ...baseObservability });
  }

  const restored = restoreResponseUnits(classified.units, restoreStates);
  const patchById = new Map(restored.units.map((u) => [u.sourceUnitId, u]));

  const candidateResults = contract.orderedUnitIds.map((id) => toTranslatedResult(contract.unitsById.get(id)!.candidate));
  const fullDocResponse = candidateResults.map((cr) => patchById.get(cr.sourceUnitId) ?? cr);
  const docChunk = minimalChunk(sourceDoc, chineseUnits);
  const validation = validateStructuredChunkResponse(docChunk, { units: fullDocResponse });
  const perUnitValid = validation.units.filter((u) => u.valid).length;
  const perUnitInvalid = validation.units.filter((u) => !u.advisory && !u.valid).length;

  // Real-change accounting: only patches whose reader-facing content differs from the
  // candidate count as applied changes; byte-identical patches are no-ops (diagnostics).
  const candidateById = new Map(candidateResults.map((cr) => [cr.sourceUnitId, cr]));
  const changedForEnglish = [...patchById.values()].filter((u) => {
    const current = candidateById.get(u.sourceUnitId);
    return !current || renderUnitResult(current) !== renderUnitResult(u);
  });
  const appliedChangedUnitCount = changedForEnglish.length;
  const observability = {
    ...baseObservability,
    appliedChangedUnitCount,
    noOpPatchCount: patchUnits.length - appliedChangedUnitCount,
  };

  if (!validation.valid) {
    const validationReasons = validation.errors.map((e) => ({ code: validationErrorCode(e), unitId: validationErrorUnitId(e) }));
    return rejectedRun(currentDoc, validationReasons, response.usage ?? null, {
      contentChars, patchCount: patchUnits.length, perUnitValid, perUnitInvalid, changedUnitCount: appliedChangedUnitCount, changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId), ...observability,
    });
  }

  const newDoc = applyPatchToDoc(currentDoc, patchById);

  // ── Before/after editorial quality gate (COMPLETE editable document) ──
  // Only genuinely hard rules (mainland-register / avoidable-code-switching) block
  // publication. Advisory style findings never reject; they remain diagnostics. A hard
  // finding is resolved ONLY when post-patch full-document lint confirms it is gone —
  // accounting a hard token as reviewed-unchanged does NOT satisfy it.
  const postUnits = extractChineseUnits(newDoc).filter((u) => u.type !== "cta").map((u) => ({ sourceUnitId: u.sourceId, text: candidateUnitText(toTranslatedResult(u)) }));
  const afterFindings = lintMonolingualDocument(postUnits);
  const { remaining, introduced } = evaluateHardFindingResolution(actionableBefore, afterFindings);

  const patchTargetSet = new Set(patchUnits.map((u) => u.sourceUnitId));
  const appliedSet = new Set(changedForEnglish.map((u) => u.sourceUnitId));
  const resolvedTokens = new Set(observability.returnedResolvedFindingTokens);
  const reviewedTokens = new Set(observability.returnedReviewedFindingTokens);
  const afterFindingByKey = new Map(afterFindings.map((f) => [`${f.sourceUnitId}\u0000${f.instructionCode}`, f]));
  const actionableFindingIdByKey = new Map(actionableBefore.map((a) => [`${a.sourceUnitId}\u0000${a.ruleId}`, a.findingId ?? ""]));

  const buildHardReason = (sourceUnitId: string, ruleId: string, introducedFlag: boolean): EditorialRejectionReason => {
    const findingId = actionableFindingIdByKey.get(`${sourceUnitId}\u0000${ruleId}`);
    const finding = afterFindingByKey.get(`${sourceUnitId}\u0000${ruleId}`);
    const responseToken = findingId ? tokenByFindingId.get(findingId) : undefined;
    return {
      code: introducedFlag ? "introduced-hard-rule" : "unresolved-hard-rule",
      sourceUnitId,
      ruleId,
      findingId: ruleId,
      responseToken,
      matchedMarkerId: finding?.safeToken,
      patchReturned: patchTargetSet.has(sourceUnitId),
      patchApplied: appliedSet.has(sourceUnitId),
      modelResolutionStatus: responseToken
        ? resolvedTokens.has(responseToken) ? "resolved" : reviewedTokens.has(responseToken) ? "reviewed-unchanged" : "not-accounted"
        : (introducedFlag ? "introduced" : "not-supplied"),
    };
  };

  const gateReasons: EditorialRejectionReason[] = [];
  for (const r of remaining) gateReasons.push(buildHardReason(r.sourceUnitId, r.ruleId, false));
  for (const i of introduced) gateReasons.push(buildHardReason(i.sourceUnitId, i.ruleId, true));
  for (const w of invalidWaiver) gateReasons.push({ code: "invalid-hard-rule-waiver", unitId: w.sourceUnitId, findingId: w.ruleId });

  const gateOutcomes = {
    preExistingActionableHardCount: suppliedActionableHardCount,
    suppliedActionableHardCount,
    resolvedHardCount: suppliedActionableHardCount - remaining.length,
    remainingHardCount: remaining.length,
    introducedHardCount: introduced.length,
    waivedHardCount: waivedHard.length,
    remainingHardRuleIds: remaining.map((r) => r.ruleId),
    introducedHardRuleIds: introduced.map((i) => i.ruleId),
  };
  const qualityGate = { ...gateOutcomes, beforeFindingCount: monolingualFindings.length, afterFindingCount: afterFindings.length };

  // ── Local resolution (monolingual) ──
  // The application — never the model — decides which findings were resolved, by
  // comparing the pre-proofread findings against the post-proofread full-document
  // lint. No-op patches were already excluded from the effective change set. The
  // dispositions and their counters are DIAGNOSTIC ONLY for advisory findings —
  // missing/stale/invalid reviewed metadata never rejects an otherwise valid article.
  const disposition = resolveMonolingualFindingDispositions(
    monolingualFindings,
    tokenByFindingId,
    afterFindings,
    reasonByToken,
  );
  const reviewedUnchangedReasonCounts: Record<string, number> = {};
  for (const r of reviewedFindings) {
    if (isValidReviewedUnchangedReasonCode(r.reason)) {
      reviewedUnchangedReasonCounts[r.reason] = (reviewedUnchangedReasonCounts[r.reason] ?? 0) + 1;
    }
  }
  const staleTokenSet = new Set(disposition.staleReviewedEntries.map((e) => e.findingToken));
  const findingDispositions: Array<{ findingToken: string; sourceUnitId: string; ruleId: string; disposition: "resolved" | "reviewed-unchanged" | "missing-disposition" | "stale-reviewed" }> = [];
  for (const f of monolingualFindings) {
    const token = tokenByFindingId.get(f.findingId);
    if (!token) continue;
    const base = disposition.dispositions.get(token);
    let finalDisposition: "resolved" | "reviewed-unchanged" | "missing-disposition" | "stale-reviewed";
    if (staleTokenSet.has(token)) finalDisposition = "stale-reviewed";
    else if (base === "resolved") finalDisposition = "resolved";
    else if (base === "reviewed-unchanged") finalDisposition = "reviewed-unchanged";
    else finalDisposition = "missing-disposition";
    findingDispositions.push({ findingToken: token, sourceUnitId: f.sourceUnitId, ruleId: f.instructionCode, disposition: finalDisposition });
  }
  const accountingDiagnostics = {
    suppliedFindingCount: monolingualFindings.length,
    locallyResolvedFindingCount: disposition.locallyResolvedFindingCount,
    reviewedUnchangedFindingCount: disposition.reviewedUnchangedFindingCount,
    reviewedUnchangedReasonCounts,
    missingFindingDispositionCount: disposition.missingFindingDispositionCount,
    staleReviewedUnchangedCount: disposition.staleReviewedUnchangedCount,
    ...reviewedMetadataDiagnostics,
    findingDispositions,
  };

  if (gateReasons.length > 0) {
    return rejectedRun(currentDoc, gateReasons, response.usage ?? null, {
      contentChars, patchCount: patchUnits.length, perUnitValid, perUnitInvalid, changedUnitCount: appliedChangedUnitCount, changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId), qualityGate, ...observability, ...accountingDiagnostics,
    });
  }

  const englishReasons: EditorialRejectionReason[] = [];
  for (const unit of changedForEnglish) {
    const unitHtml = renderUnitResult(unit);
    const categories: string[] = [];
    if (hasExcessiveEnglish(unitHtml)) categories.push("excessive-english");
    if (hasEnglishHeavyProseBlock(unitHtml)) categories.push("english-heavy-prose-block");
    if (categories.length > 0) englishReasons.push({ code: "english-leak", unitId: unit.sourceUnitId });
  }
  if (englishReasons.length > 0) {
    return rejectedRun(currentDoc, englishReasons, response.usage ?? null, {
      contentChars, patchCount: patchUnits.length, perUnitValid, perUnitInvalid, changedUnitCount: appliedChangedUnitCount, changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId), qualityGate, ...observability, ...accountingDiagnostics,
    });
  }

  return {
    status: "accepted", accepted: true, contentChars, doc: newDoc, patchById, diagnostics: classified.diagnostics,
    patchCount: classified.units.length, changedUnitCount: appliedChangedUnitCount, changedUnitIds: changedForEnglish.map((u) => u.sourceUnitId),
    perUnitValid, perUnitInvalid, failures: [], reasons: [], tokenUsage: response.usage ?? null, styleFindingCounts,
    qualityGate,
    promptUnitIds: contract.orderedUnitIds as unknown as string[],
    allowedPatchTargetIds: [...contract.allowedPatchTargetIds] as unknown as string[],
    sourceReferenceIds: contract.sourceReferenceIds as unknown as string[],
    ...observability,
    ...accountingDiagnostics,
  };
}

/** Compact Brand Voice guidance injected into the three editorial calls. */
export interface EditorialBrand {
  bilingualPrinciples: string;
  monolingualRegister: string;
}

/**
 * Deterministic faithful-path post-processing (no AI). Runs the Cantonese quality
 * pass (terminology cleanup + CTA localization), rebuilds the FAQ schema, and
 * applies source-reference localization onto the assembled document, returning the
 * processed document plus the source-reference metadata and severity-based quality
 * report. This preserves source handling, CTA/schema/WordPress integrity and the
 * final quality gate without any editorial provider call.
 */
export function applyFaithfulDocumentPostProcessing(
  enDoc: ArticleDocument,
  assembledDoc: ArticleDocument,
): {
  doc: ArticleDocument;
  sourceReferences: SourceReferenceUnit[];
  sourceFindings: SourceReferenceFinding[];
  quality: QualityReport;
} {
  const quality = applyShadowCantoneseQuality(assembledDoc);
  let processed = quality.doc;
  processed.faqSchema = buildFaqSchemaBlock(processed.visibleFaq);
  const localized = applySourceReferenceLocalization(processed, enDoc);
  processed = localized.doc;
  processed.faqSchema = buildFaqSchemaBlock(processed.visibleFaq);
  // Comprehensive deterministic zh-HK language pack: safe corrections + validation.
  const lang = applyZhHkLanguageQuality(processed, enDoc);
  processed = lang.doc;
  processed.faqSchema = buildFaqSchemaBlock(processed.visibleFaq);
  const report = mergeSourceReferenceFindings(lang.report, localized.findings);
  return {
    doc: processed,
    sourceReferences: localized.units,
    sourceFindings: localized.findings,
    quality: report,
  };
}

/**
 * Run the bilingual whole-document editorial polish as THREE bounded batches with
 * compact patch responses, one provider attempt per batch (no retry). Valid patches
 * are applied deterministically onto the pre-editorial assembled document; a rejected
 * batch retains its pre-editorial units while accepted patches from other batches are kept.
 */
export async function runShadowEditorialPolish(
  enDoc: ArticleDocument,
  sourceDoc: TranslationSourceDocument,
  assembledDoc: ArticleDocument,
  callProvider: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>,
  brand: EditorialBrand = { bilingualPrinciples: "", monolingualRegister: "" },
): Promise<ShadowEditorialInfo> {
  const brief = buildDocumentBrief(sourceDoc);
  const bilingualBatches = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0);
  const totalUnits = bilingualBatches.reduce((sum, b) => sum + b.sourceUnitIds.length, 0);
  // Total editorial calls: 2 bilingual revision + 1 monolingual proofread.
  const editorialCallCount = bilingualBatches.length + 1;

  // ── Bilingual coverage invariant: A and B unique, non-overlapping, union = complete editable set ──
  const completeBilingualEditable = enumerateTranslationSourceUnits(sourceDoc)
    .filter((u) => u.type !== "cta")
    .map((u) => u.sourceId);
  const coverageReasons = validateBilingualCoverage(
    { orderedUnitIds: bilingualBatches[0]?.sourceUnitIds.map(editorialSourceUnitId) ?? [] } as unknown as EditorialCallContract,
    { orderedUnitIds: bilingualBatches[1]?.sourceUnitIds.map(editorialSourceUnitId) ?? [] } as unknown as EditorialCallContract,
    completeBilingualEditable,
  );
  if (coverageReasons.length > 0) {
    // A local invariant failure must stop before any provider call and never save.
    const infoLocal: ShadowEditorialInfo = {
      enabled: true, status: "pre-editorial", batchCount: editorialCallCount, attemptCount: 0,
      acceptedBatchCount: 0, rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: editorialCallCount,
      changedUnitCount: 0, unchangedUnitCount: totalUnits, batches: [], failure: `bilingual coverage invariant failed: ${coverageReasons[0].code}`,
      preEditorialDoc: assembledDoc, polishedDoc: assembledDoc, perUnitValid: 0, perUnitInvalid: 0, tokenUsage: null, invariantFailures: coverageReasons.map((r) => r.code), quality: null,
    };
    console.warn(`[document-context-shadow] editorial ABORTED | ${coverageReasons[0].code}`);
    return infoLocal;
  }

  const info: ShadowEditorialInfo = {
    enabled: true,
    status: "not-run",
    batchCount: editorialCallCount,
    attemptCount: 0,
    acceptedBatchCount: 0,
    rejectedBatchCount: 0,
    providerFailedCount: 0,
    validationRejectedCount: 0,
    skippedCount: 0,
    changedUnitCount: 0,
    unchangedUnitCount: totalUnits,
    batches: [],
    failure: null,
    preEditorialDoc: assembledDoc,
    polishedDoc: assembledDoc,
    perUnitValid: 0,
    perUnitInvalid: 0,
    tokenUsage: null,
    invariantFailures: [],
    quality: null,
  };

  /** Log one editorial call's routing + token + change metrics (never text/reasoning). */
  const logEditorialCall = (
    callLabel: string,
    result: EditorialRunResult,
    routing: ReturnType<typeof resolveModelRouting>,
    contentChars: number,
  ): void => {
    const usage = result.tokenUsage;
    console.log(
      `[document-context-shadow] ${callLabel} | purpose=${callLabel} model=${routing.model} thinking=${routing.thinkingMode} max_tokens=${routing.maxTokens} timeout_ms=${routing.timeoutMs} input_tokens=${usage?.promptTokens ?? "n/a"} completion_tokens=${usage?.completionTokens ?? "n/a"} reasoning_tokens=0 content_chars=${contentChars} changed=${result.changedUnitCount} status=${result.status}`,
    );
  };

  const recordBatch = (
    index: number,
    sourceUnitIds: string[],
    result: EditorialRunResult,
  ): void => {
    info.attemptCount += 1;
    info.tokenUsage = result.tokenUsage ?? info.tokenUsage;
    info.perUnitValid += result.perUnitValid;
    info.perUnitInvalid += result.perUnitInvalid;
    if (result.styleFindingCounts) {
      for (const [category, count] of Object.entries(result.styleFindingCounts)) {
        styleFindingCounts[category] = (styleFindingCounts[category] ?? 0) + count;
      }
    }
    const stageStatus: EditorialStageStatus = result.status;
    info.batches.push({
      batchIndex: index,
      sourceUnitIds,
      status: stageStatus,
      attemptCount: 1,
      changedUnitCount: result.changedUnitCount,
      changedUnitIds: result.changedUnitIds,
      perUnitValid: result.perUnitValid,
      perUnitInvalid: result.perUnitInvalid,
      tokenUsage: result.tokenUsage,
      failures: result.failures,
      reasons: result.reasons,
      diagnostics: result.diagnostics,
      contentChars: result.contentChars,
      styleFindingCounts: result.styleFindingCounts,
      promptUnitIds: result.promptUnitIds,
      allowedPatchTargetIds: result.allowedPatchTargetIds,
      returnedPatchTargetIds: result.returnedPatchTargetIds,
      returnedPatchCount: result.returnedPatchCount,
      appliedChangedUnitCount: result.appliedChangedUnitCount,
      noOpPatchCount: result.noOpPatchCount,
      suppliedFindingCount: result.suppliedFindingCount,
      locallyResolvedFindingCount: result.locallyResolvedFindingCount,
      reviewedUnchangedFindingCount: result.reviewedUnchangedFindingCount,
      reviewedUnchangedReasonCounts: result.reviewedUnchangedReasonCounts,
      missingFindingDispositionCount: result.missingFindingDispositionCount,
      staleReviewedUnchangedCount: result.staleReviewedUnchangedCount,
      unknownReviewedFindingCount: result.unknownReviewedFindingCount,
      duplicateReviewedFindingCount: result.duplicateReviewedFindingCount,
      invalidReviewedReasonCount: result.invalidReviewedReasonCount,
      findingDispositions: result.findingDispositions,
      suppliedFindingTokens: result.suppliedFindingTokens,
      returnedResolvedFindingTokens: result.returnedResolvedFindingTokens,
      returnedReviewedFindingTokens: result.returnedReviewedFindingTokens,
      sourceReferenceIds: result.sourceReferenceIds,
      qualityGate: result.qualityGate,
    });
    if (stageStatus === "accepted") {
      info.acceptedBatchCount++;
      info.changedUnitCount += result.changedUnitCount;
    } else {
      info.rejectedBatchCount++;
      if (stageStatus === "provider-failed") info.providerFailedCount++;
      else info.validationRejectedCount++;
      info.invariantFailures.push(...result.reasons.map((r) => `batch${index}:${r.code}${r.unitId ? `:${r.unitId}` : ""}`));
      console.warn(summarizeBatchRejection(index, result.patchCount, result.changedUnitCount, result.reasons));
    }
  };

  /** Record a stage that was never attempted because an earlier stage failed. */
  const recordSkipped = (index: number, sourceUnitIds: string[]): void => {
    info.skippedCount++;
    info.batches.push({
      batchIndex: index,
      sourceUnitIds,
      status: "not-run",
      attemptCount: 0,
      changedUnitCount: 0,
      changedUnitIds: [],
      perUnitValid: 0,
      perUnitInvalid: 0,
      tokenUsage: null,
      failures: [],
      reasons: [],
    });
  };

  let currentDoc = assembledDoc;
  const styleFindingCounts: Record<string, number> = {};

  // ── Fail-fast bilingual revision. ──
  // 1. Run bilingual A. If it fails, stop immediately (do not call B or the
  //    monolingual proofreader).
  // 2. If A passes, run bilingual B. If B fails, do not call the monolingual.
  // 3. If both pass, combine and apply their patches deterministically, then run
  //    the monolingual proofread exactly once.
  const baseDoc = assembledDoc;
  const batchA = bilingualBatches[0];
  const batchB = bilingualBatches[1];

  let bilingualPass = false;
  let resultA: EditorialRunResult | null = null;
  let resultB: EditorialRunResult | null = null;

  if (batchA) {
    const nextHeading = batchB ? firstHeadingOf(candidateResultsFor(baseDoc, batchB.sourceUnitIds)) : "";
    resultA = await runShadowEditorialBatch(enDoc, sourceDoc, brief, batchA, baseDoc, "", nextHeading, callProvider, EDITORIAL_BILINGUAL_A_LABEL, brand.bilingualPrinciples);
    logEditorialCall(EDITORIAL_BILINGUAL_A_LABEL, resultA, resolveModelRouting(EDITORIAL_BILINGUAL_A_LABEL), resultA.contentChars ?? 0);
    recordBatch(0, batchA.sourceUnitIds, resultA);
    if (resultA.status === "accepted") {
      if (batchB) {
        resultB = await runShadowEditorialBatch(enDoc, sourceDoc, brief, batchB, baseDoc, "", "", callProvider, EDITORIAL_BILINGUAL_B_LABEL, brand.bilingualPrinciples);
        logEditorialCall(EDITORIAL_BILINGUAL_B_LABEL, resultB, resolveModelRouting(EDITORIAL_BILINGUAL_B_LABEL), resultB.contentChars ?? 0);
        recordBatch(1, batchB.sourceUnitIds, resultB);
        if (resultB.status === "accepted") {
          bilingualPass = true;
        } else {
          recordSkipped(2, []);
        }
      } else {
        bilingualPass = true;
      }
    } else {
      if (batchB) recordSkipped(1, batchB.sourceUnitIds);
      recordSkipped(2, []);
    }
  } else {
    // No bilingual A (empty source): only the monolingual proofread can run.
    bilingualPass = false;
  }

  // ── Combine and apply both bilingual patches only when both pass. ──
  if (bilingualPass) {
    const overlap = [...(resultA?.patchById.keys() ?? [])].filter((id) => resultB!.patchById.has(id));
    if (overlap.length > 0) {
      // Duplicate target across A and B: reject the combined stage; do not run monolingual.
      bilingualPass = false;
      info.validationRejectedCount += 1;
      info.rejectedBatchCount += 1;
      const overlapReason: EditorialRejectionReason = { code: "duplicate-unit-patch", unitId: overlap[0] };
      console.warn(summarizeBatchRejection(2, 0, 0, [overlapReason]));
      info.invariantFailures.push(`combine:duplicate-unit-patch:${overlap[0]}`);
      recordSkipped(2, []);
    } else {
      const combined = new Map<string, TranslatedUnitResult>([...(resultA?.patchById ?? []), ...(resultB?.patchById ?? [])]);
      currentDoc = applyPatchToDoc(baseDoc, combined);
    }
  }

  // ── Editorial call 3: full-document monolingual proofread.
  //     Runs exactly once ONLY when both bilingual stages are accepted. ──
  if (bilingualPass) {
    const resultM = await runShadowMonolingualProofread(sourceDoc, currentDoc, callProvider, EDITORIAL_MONOLINGUAL_LABEL, brand.monolingualRegister);
    logEditorialCall(EDITORIAL_MONOLINGUAL_LABEL, resultM, resolveModelRouting(EDITORIAL_MONOLINGUAL_LABEL), resultM.contentChars ?? 0);
    const allEditableIds = extractChineseUnits(currentDoc).filter((u) => u.type !== "cta").map((u) => u.sourceId);
    recordBatch(2, allEditableIds, resultM);
    if (resultM.status === "accepted") currentDoc = resultM.doc;
  }

  info.unchangedUnitCount = Math.max(0, totalUnits - info.changedUnitCount);
  info.styleFindingCounts = styleFindingCounts;

  // ── Deterministic Cantonese quality pass (no AI) ──
  // Terminology cleanup + CTA localization over the reassembled polished doc,
  // then the final severity-based quality gate. Never adds a provider call.
  let quality = applyShadowCantoneseQuality(currentDoc);
  let polishedDoc = quality.doc;
  polishedDoc.faqSchema = buildFaqSchemaBlock(polishedDoc.visibleFaq);

  // ── Deterministic source-reference localization (no AI) ──
  // Rebuild every citation block into the clean visible Chinese format using the
  // immutable English originals, attach the structured sourceReferences to the
  // document, and merge source findings into the severity-based quality report.
  const localized = applySourceReferenceLocalization(polishedDoc, enDoc);
  polishedDoc = localized.doc;
  polishedDoc.faqSchema = buildFaqSchemaBlock(polishedDoc.visibleFaq);
  info.sourceReferences = localized.units;
  info.sourceFindings = localized.findings;
  info.sourceDiagnostics = localized.diagnostics;
  quality = { ...quality, report: mergeSourceReferenceFindings(quality.report, localized.findings) };

  // Only CRITICAL or MAJOR findings are grounds to revert an editorial batch.
  // Minor and advisory findings are retained in diagnostics and never revert.
  // Source-reference findings are validated separately and are excluded from
  // the per-batch revert set so a source finding never reverts a localized block.
  const fatalIds = new Set(
    quality.report.findings
      .filter((f) => f.severity === "critical" || f.severity === "major")
      .filter((f) => f.category !== "source-reference")
      .map((f) => f.sourceUnitId),
  );
  if (fatalIds.size > 0) {
    // Revert contaminated source units to their pre-editorial (coherent) value,
    // attribute them to the editorial batches that changed them, and re-clean.
    const preEditorialById = new Map(extractChineseUnits(assembledDoc).map((u) => [u.sourceId, u]));
    const revertPatch = new Map<string, TranslatedUnitResult>();
    for (const id of fatalIds) {
      const pre = preEditorialById.get(id);
      if (pre) revertPatch.set(id, toTranslatedResult(pre));
    }
    if (revertPatch.size > 0) {
      polishedDoc = applyPatchToDoc(polishedDoc, revertPatch);
      quality = applyShadowCantoneseQuality(polishedDoc);
      polishedDoc = quality.doc;
      polishedDoc.faqSchema = buildFaqSchemaBlock(polishedDoc.visibleFaq);
    }
    for (const b of info.batches) {
      if (b.status === "accepted" && b.changedUnitIds.some((id) => fatalIds.has(id))) {
        b.status = "validation-rejected";
        info.acceptedBatchCount--;
        info.rejectedBatchCount++;
        info.validationRejectedCount++;
      }
    }
  }

  for (const f of quality.report.findings) {
    if (f.severity === "critical" || f.severity === "major") {
      console.warn(`[document-context-shadow] quality ${f.severity} | unit=${f.sourceUnitId} code=${f.messageCode}`);
    }
  }

  info.status = info.acceptedBatchCount === info.batchCount && info.rejectedBatchCount === 0
    ? "polished"
    : info.acceptedBatchCount > 0
      ? "partially-polished"
      : "pre-editorial";
  info.failure = info.rejectedBatchCount > 0 ? `${info.rejectedBatchCount} editorial call(s) rejected` : null;
  info.quality = quality.report;
  info.polishedDoc = polishedDoc;
  return info;
}

// ── Preview serialization (diagnostic retrieval; no DB, no production version) ──

export interface ShadowPreviewPayload {
  kind: "b2i-shadow-preview";
  previewOnly: true;
  publishable: false;
  timestamp: string;
  chunkMetrics: {
    totalPlannedChunks: number;
    substantiveChunkCallCount: number;
    providerAttemptCount: number;
    validChunkCount: number;
    partialChunkCount: number;
    failedChunkCount: number;
    translatedCoverage: string;
  };
  /** Safe malformed-JSON diagnostics for the chunk response, when present. */
  jsonDiagnostics: {
    errorMessage: string;
    position: number | null;
    snippet: string | null;
    recovered: boolean;
  } | null;
  assembly: { status: ShadowAssemblyStatus; missingUnits: string[] };
  editorial: {
    enabled: boolean;
    status: ShadowEditorialStatus;
    batchCount: number;
    attemptCount: number;
    acceptedBatchCount: number;
    rejectedBatchCount: number;
    changedUnitCount: number;
    unchangedUnitCount: number;
    perUnitValid: number;
    perUnitInvalid: number;
    tokenUsage: ShadowTokenUsage | null;
    failure: string | null;
    source?: {
      sourceReferenceCount: number;
      localizedTitleCount: number;
      officialLocalizedNameCount: number;
      aiLocalizedTitleCount: number;
      canonicalSourceFailures: number;
      findings: string[];
    } | null;
    styleFindingCounts?: Record<string, number> | null;
    /** Named, machine-readable rejection reasons for every rejected editorial call. */
    rejectionReasons?: EditorialRejectionReason[];
    /** Nonfatal diagnostics (e.g. exact duplicate patches collapsed). */
    diagnostics?: EditorialRejectionReason[];
    /** Provider content-chars per editorial batch index (accurate even on rejection). */
    contentCharsByBatch?: Record<string, number>;
    /** Safe observability: prompt unit IDs per batch (IDs only). */
    promptUnitIdsByBatch?: Record<string, string[]>;
    /** Safe observability: allowed patch-target IDs per batch. */
    allowedPatchTargetIdsByBatch?: Record<string, string[]>;
    /** Safe observability: returned patch-target IDs per batch. */
    returnedPatchTargetIdsByBatch?: Record<string, string[]>;
    /** Safe observability: returned patch-unit count per batch. */
    returnedPatchCountByBatch?: Record<string, number>;
    /** Safe observability: applied real-change count per batch. */
    appliedChangedUnitCountByBatch?: Record<string, number>;
    /** Safe observability: byte-identical no-op patch count per batch. */
    noOpPatchCountByBatch?: Record<string, number>;
    /** Safe observability: supplied finding-token count per batch. */
    suppliedFindingCountByBatch?: Record<string, number>;
    /** Safe observability: locally-resolved finding count per batch (monolingual). */
    locallyResolvedFindingCountByBatch?: Record<string, number>;
    /** Safe observability: reviewed-unchanged finding-token count per batch. */
    reviewedUnchangedFindingCountByBatch?: Record<string, number>;
    /** Safe observability: reviewed-unchanged reason-code counts per batch. */
    reviewedUnchangedReasonCountsByBatch?: Record<string, Record<string, number>>;
    /** Safe observability: still-present findings without reviewed-unchanged accounting per batch. */
    missingFindingDispositionCountByBatch?: Record<string, number>;
    /** Safe observability: stale reviewed-unchanged entries for locally-resolved findings per batch. */
    staleReviewedUnchangedCountByBatch?: Record<string, number>;
    /** Safe observability: unknown reviewed tokens per batch (diagnostic only). */
    unknownReviewedFindingCountByBatch?: Record<string, number>;
    /** Safe observability: duplicate reviewed entries per batch (diagnostic only). */
    duplicateReviewedFindingCountByBatch?: Record<string, number>;
    /** Safe observability: invalid reviewed reason codes per batch (diagnostic only). */
    invalidReviewedReasonCountByBatch?: Record<string, number>;
    /** Safe observability: per-finding disposition per batch (IDs only, diagnostic only). */
    findingDispositionsByBatch?: Record<string, Array<{ findingToken: string; sourceUnitId: string; ruleId: string; disposition: "resolved" | "reviewed-unchanged" | "missing-disposition" | "stale-reviewed" }>>;
    /** Safe observability: quality-gate counts per batch (monolingual). */
    qualityGateByBatch?: Record<string, EditorialQualityGate>;
    /** Safe observability: supplied finding tokens per batch. */
    suppliedFindingTokensByBatch?: Record<string, string[]>;
    /** Safe observability: returned resolved finding tokens per batch. */
    returnedResolvedFindingTokensByBatch?: Record<string, string[]>;
    /** Safe observability: returned reviewed-unchanged finding tokens per batch. */
    returnedReviewedFindingTokensByBatch?: Record<string, string[]>;
    /** Safe observability: source-reference unit IDs per batch. */
    sourceReferenceIdsByBatch?: Record<string, string[]>;
  };
  retainedSource: "polished" | "partially-polished" | "pre-editorial" | "none";
  preEditorialDoc: ArticleDocument | null;
  polishedDoc: ArticleDocument | null;
  quality: {
    critical: number;
    major: number;
    minor: number;
    advisory: number;
    categories: string[];
    affectedSourceUnitIds: string[];
    glossaryNormalizations: number;
    approvedNameExemptions: number;
    findings: Array<{
      sourceUnitId: string;
      category: string;
      severity: string;
      messageCode: string;
      offendingToken: string | null;
      context: string | null;
      tokenInSource: boolean | null;
      tokenInAllowlist: boolean | null;
      tokenInAutoEntities: boolean | null;
      detectorRule: string;
      replacement: string | null;
      action: string;
    }>;
  } | null;
  languagePack: {
    version: string;
    retrievedExampleIds: string[];
    exampleCount: number;
    glossaryApplications: number;
  } | null;
}

/** Build a reviewable, preview-only diagnostic payload (never a production version). */
export function buildShadowPreviewPayload(
  result: {
    totalPlannedChunks: number;
    substantiveChunkCallCount: number;
    providerAttemptCount: number;
    validChunkCount: number;
    partialChunkCount: number;
    failedChunkCount: number;
    coverage: { translatedSubstantive: { translated: number; total: number } };
    assembly: ShadowAssemblyInfo;
    editorial: ShadowEditorialInfo;
    preview: ShadowPreviewInfo;
    languagePack?: {
      version: string;
      retrievedExampleIds: string[];
      exampleCount: number;
      glossaryApplications: number;
    } | null;
    chunkResults?: Array<{
      jsonDiagnostics?: {
        errorMessage: string;
        position: number | null;
        snippet: string | null;
        recovered: boolean;
      } | null;
    }>;
  },
): ShadowPreviewPayload {
  const jsonDiagnostics = result.chunkResults?.find((c) => c.jsonDiagnostics)?.jsonDiagnostics ?? null;
  return {
    kind: "b2i-shadow-preview",
    previewOnly: true,
    publishable: false,
    timestamp: new Date().toISOString(),
    chunkMetrics: {
      totalPlannedChunks: result.totalPlannedChunks,
      substantiveChunkCallCount: result.substantiveChunkCallCount,
      providerAttemptCount: result.providerAttemptCount,
      validChunkCount: result.validChunkCount,
      partialChunkCount: result.partialChunkCount,
      failedChunkCount: result.failedChunkCount,
      translatedCoverage: `${result.coverage.translatedSubstantive.translated}/${result.coverage.translatedSubstantive.total}`,
    },
    jsonDiagnostics,
    assembly: { status: result.assembly.status, missingUnits: result.assembly.missingUnits },
    editorial: {
      enabled: result.editorial.enabled,
      status: result.editorial.status,
      batchCount: result.editorial.batchCount,
      attemptCount: result.editorial.attemptCount,
      acceptedBatchCount: result.editorial.acceptedBatchCount,
      rejectedBatchCount: result.editorial.rejectedBatchCount,
      changedUnitCount: result.editorial.changedUnitCount,
      unchangedUnitCount: result.editorial.unchangedUnitCount,
      perUnitValid: result.editorial.perUnitValid,
      perUnitInvalid: result.editorial.perUnitInvalid,
      tokenUsage: result.editorial.tokenUsage,
      failure: result.editorial.failure,
      source: result.editorial.sourceDiagnostics
        ? {
            ...result.editorial.sourceDiagnostics,
            findings: summarizeSourceFindings(result.editorial.sourceFindings ?? []),
          }
        : null,
      styleFindingCounts: result.editorial.styleFindingCounts ?? null,
      rejectionReasons: result.editorial.batches.flatMap((b) => (b.reasons ?? [])).filter((r) => r.code !== "provider-error"),
      diagnostics: result.editorial.batches.flatMap((b) => (b.diagnostics ?? [])),
      contentCharsByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        acc[String(b.batchIndex)] = b.contentChars ?? 0;
        return acc;
      }, {}),
      // Safe observability: IDs and counters only (no article prose, no reasoning).
      promptUnitIdsByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.promptUnitIds) acc[String(b.batchIndex)] = b.promptUnitIds;
        return acc;
      }, {}),
      allowedPatchTargetIdsByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.allowedPatchTargetIds) acc[String(b.batchIndex)] = b.allowedPatchTargetIds;
        return acc;
      }, {}),
      returnedPatchTargetIdsByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.returnedPatchTargetIds) acc[String(b.batchIndex)] = b.returnedPatchTargetIds;
        return acc;
      }, {}),
      returnedPatchCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.returnedPatchCount !== undefined) acc[String(b.batchIndex)] = b.returnedPatchCount;
        return acc;
      }, {}),
      appliedChangedUnitCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.appliedChangedUnitCount !== undefined) acc[String(b.batchIndex)] = b.appliedChangedUnitCount;
        return acc;
      }, {}),
      noOpPatchCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.noOpPatchCount !== undefined) acc[String(b.batchIndex)] = b.noOpPatchCount;
        return acc;
      }, {}),
      suppliedFindingCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.suppliedFindingCount !== undefined) acc[String(b.batchIndex)] = b.suppliedFindingCount;
        return acc;
      }, {}),
      locallyResolvedFindingCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.locallyResolvedFindingCount !== undefined) acc[String(b.batchIndex)] = b.locallyResolvedFindingCount;
        return acc;
      }, {}),
      reviewedUnchangedFindingCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.reviewedUnchangedFindingCount !== undefined) acc[String(b.batchIndex)] = b.reviewedUnchangedFindingCount;
        return acc;
      }, {}),
      reviewedUnchangedReasonCountsByBatch: result.editorial.batches.reduce<Record<string, Record<string, number>>>((acc, b) => {
        if (b.reviewedUnchangedReasonCounts) acc[String(b.batchIndex)] = b.reviewedUnchangedReasonCounts;
        return acc;
      }, {}),
      missingFindingDispositionCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.missingFindingDispositionCount !== undefined) acc[String(b.batchIndex)] = b.missingFindingDispositionCount;
        return acc;
      }, {}),
      staleReviewedUnchangedCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.staleReviewedUnchangedCount !== undefined) acc[String(b.batchIndex)] = b.staleReviewedUnchangedCount;
        return acc;
      }, {}),
      unknownReviewedFindingCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.unknownReviewedFindingCount !== undefined) acc[String(b.batchIndex)] = b.unknownReviewedFindingCount;
        return acc;
      }, {}),
      duplicateReviewedFindingCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.duplicateReviewedFindingCount !== undefined) acc[String(b.batchIndex)] = b.duplicateReviewedFindingCount;
        return acc;
      }, {}),
      invalidReviewedReasonCountByBatch: result.editorial.batches.reduce<Record<string, number>>((acc, b) => {
        if (b.invalidReviewedReasonCount !== undefined) acc[String(b.batchIndex)] = b.invalidReviewedReasonCount;
        return acc;
      }, {}),
      findingDispositionsByBatch: result.editorial.batches.reduce<Record<string, Array<{ findingToken: string; sourceUnitId: string; ruleId: string; disposition: "resolved" | "reviewed-unchanged" | "missing-disposition" | "stale-reviewed" }>>>((acc, b) => {
        if (b.findingDispositions) acc[String(b.batchIndex)] = b.findingDispositions;
        return acc;
      }, {}),
      qualityGateByBatch: result.editorial.batches.reduce<Record<string, EditorialQualityGate>>((acc, b) => {
        if (b.qualityGate) acc[String(b.batchIndex)] = b.qualityGate;
        return acc;
      }, {}),
      suppliedFindingTokensByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.suppliedFindingTokens) acc[String(b.batchIndex)] = b.suppliedFindingTokens;
        return acc;
      }, {}),
      returnedResolvedFindingTokensByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.returnedResolvedFindingTokens) acc[String(b.batchIndex)] = b.returnedResolvedFindingTokens;
        return acc;
      }, {}),
      returnedReviewedFindingTokensByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.returnedReviewedFindingTokens) acc[String(b.batchIndex)] = b.returnedReviewedFindingTokens;
        return acc;
      }, {}),
      sourceReferenceIdsByBatch: result.editorial.batches.reduce<Record<string, string[]>>((acc, b) => {
        if (b.sourceReferenceIds) acc[String(b.batchIndex)] = b.sourceReferenceIds;
        return acc;
      }, {}),
    },
    retainedSource: result.preview.retainedSource,
    preEditorialDoc: result.assembly.doc,
    polishedDoc: result.editorial.polishedDoc,
    quality: result.editorial.quality
      ? {
          critical: result.editorial.quality.criticalCount,
          major: result.editorial.quality.majorCount,
          minor: result.editorial.quality.minorCount,
          advisory: result.editorial.quality.advisoryCount,
          categories: [...new Set(result.editorial.quality.findings.map((f) => `${f.category}:${f.messageCode}`))],
          affectedSourceUnitIds: result.editorial.quality.findings.map((f) => f.sourceUnitId),
          glossaryNormalizations: result.editorial.quality.glossaryNormalizations,
          approvedNameExemptions: result.editorial.quality.approvedNameExemptions,
          findings: result.editorial.quality.findings
            .filter((f) => f.severity === "critical" || f.severity === "major")
            .map((f) => ({
              sourceUnitId: f.sourceUnitId,
              category: f.category,
              severity: f.severity,
              messageCode: f.messageCode,
              offendingToken: f.offendingToken ?? f.matchedToken ?? null,
              context: f.context ?? null,
              tokenInSource: f.tokenInSource ?? null,
              tokenInAllowlist: f.tokenInAllowlist ?? null,
              tokenInAutoEntities: f.tokenInAutoEntities ?? null,
              detectorRule: f.detectorRule ?? f.messageCode,
              replacement: f.replacement ?? null,
              action: f.action ?? "blocked",
            })),
        }
      : null,
    languagePack: result.languagePack
      ? {
          version: result.languagePack.version,
          retrievedExampleIds: result.languagePack.retrievedExampleIds,
          exampleCount: result.languagePack.exampleCount,
          glossaryApplications: result.languagePack.glossaryApplications,
        }
      : null,
  };
}

/** Serialize the preview payload to JSON (diagnostic retrieval / local export). */
export function serializeShadowPreview(
  result: {
    totalPlannedChunks: number;
    substantiveChunkCallCount: number;
    providerAttemptCount: number;
    validChunkCount: number;
    partialChunkCount: number;
    failedChunkCount: number;
    coverage: { translatedSubstantive: { translated: number; total: number } };
    assembly: ShadowAssemblyInfo;
    editorial: ShadowEditorialInfo;
    preview: ShadowPreviewInfo;
  },
): string {
  return JSON.stringify(buildShadowPreviewPayload(result), null, 2);
}
