// ── Coherent-chunk translation planner (Stage 2A) ──
//
// Deterministically partitions a canonical TranslationSourceDocument into
// context-preserving, order-preserving chunks. This module ONLY plans,
// serializes and validates chunks — it never translates them and never calls an
// AI provider.
//
// Contract:
//  - Source IDs, chunk IDs and fingerprints are derived from indices/paths, never
//    UUIDs, so identical source documents + configuration produce identical plans.
//  - Semantic boundaries are preserved: a section heading stays with its body, an
//    FAQ question stays with its answer, blocks are never split, and canonical
//    document order is retained.
//  - Token budgeting is deterministic and centralized in TranslationChunkPlannerConfig.
//  - The planner fails deterministically when an indivisible source unit cannot fit
//    within the configured safe budget.
//  - This module is additive and NOT wired into production translation orchestration.

import type { EditorialBlock } from "@/lib/blog/article-content";
import { validateEditorialBlocks } from "@/lib/blog/article-content";
import {
  type TranslationSourceDocument,
  type TranslationSourceUnit,
  enumerateTranslationSourceUnits,
  getTranslationSourceUnit,
  serializeTranslationSourceDocument,
} from "./translation-source-document";
import { HK_TRANSLATION_GLOSSARY } from "./translation-glossary";
import {
  checkNumbersPreserved,
  checkLinksPreserved,
  checkNoNewUrls,
} from "./translation-validator";
import {
  checkBlockNumbersPreserved,
  checkBlockLinksPreserved,
  extractLinksFromEditorialBlocks,
} from "./editorial-block-protection";
import { editorialStructureSignature } from "./editorial-block-translation";

// ── Deterministic token estimator ──

export interface TokenEstimator {
  /** Estimate tokens for English/Latin text. */
  englishTokens(text: string): number;
  /** Estimate tokens for Traditional Chinese text. */
  chineseTokens(text: string): number;
}

export const DEFAULT_TOKEN_ESTIMATOR: TokenEstimator = {
  englishTokens: (text) => (text ? Math.max(1, Math.ceil(text.length / 4)) : 0),
  chineseTokens: (text) => (text ? Math.max(1, Math.ceil(text.length / 2)) : 0),
};

// ── Centralized planner configuration ──

export type MetadataPlacement = "with-introduction" | "separate";
export type CtaPlacement = "separate" | "with-conclusion";

export interface TranslationChunkPlannerConfig {
  /** Maximum estimated input tokens (source + brief + overhead) per chunk. */
  maxInputTokens: number;
  /** Provider output-token cap. Used only as safety capacity; chunks are planned far below it. */
  maxOutputTokens: number;
  /** Safety headroom applied to estimated output before comparing against maxOutputTokens. */
  outputHeadroomFactor: number;
  /** Expected Traditional-Chinese output tokens per English source token (>=1: CJK is dense). */
  zhTokenPerEnglishToken: number;
  /** Fixed prompt overhead for the glossary + translation instructions. */
  glossaryInstructionsTokens: number;
  /** Fixed base response overhead for the structured-output wrapper. */
  structuredOutputOverheadTokens: number;
  /** Per-source-unit JSON overhead (keys, quotes, commas, repeated sourceUnitId). */
  perUnitJsonTokens: number;
  /** Additional output overhead per editorial block / faq-answer for block-structure JSON. */
  perBlockOutputStructuralTokens: number;
  /** Allowance per chunk for referencing preceding translated context. */
  previousChunkContextTokens: number;
  /** Per-editorial-block input-side structural markup overhead. */
  blockStructuralTokens: number;
  /** Secondary guard: maximum number of source units per chunk. */
  maxUnitsPerChunk: number;
  /** Whether metadata is grouped with the introduction or its own chunk. */
  metadataPlacement: MetadataPlacement;
  /** Whether the CTA is kept as its own protected chunk. */
  ctaPlacement: CtaPlacement;
}

export const DEFAULT_CHUNK_PLANNER_CONFIG: TranslationChunkPlannerConfig = {
  maxInputTokens: 4700,
  maxOutputTokens: 8000,
  outputHeadroomFactor: 1.25,
  zhTokenPerEnglishToken: 1.15,
  glossaryInstructionsTokens: 1200,
  structuredOutputOverheadTokens: 600,
  perUnitJsonTokens: 30,
  perBlockOutputStructuralTokens: 60,
  previousChunkContextTokens: 400,
  blockStructuralTokens: 30,
  maxUnitsPerChunk: 24,
  metadataPlacement: "with-introduction",
  ctaPlacement: "separate",
};

export class TranslationChunkPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationChunkPlanError";
  }
}

// ── Document brief ──

export interface DocumentBrief {
  englishTitle: string;
  focusKeyphrase: string;
  headingOutline: string[];
  articlePurpose: string;
  terminology: string[];
  languageRegister: string;
  factualRule: string;
  codeSwitchingRule: string;
  canonicalityRule: string;
}

/** Compact, immutable brief. Never includes the full article body. */
export function buildDocumentBrief(sourceDoc: TranslationSourceDocument): DocumentBrief {
  return {
    englishTitle: sourceDoc.metadata.title,
    focusKeyphrase: sourceDoc.metadata.focusKeyphrase,
    headingOutline: sourceDoc.sections.map((section) => section.heading),
    articlePurpose: sourceDoc.metadata.excerpt,
    terminology: HK_TRANSLATION_GLOSSARY.map(([en, zh]) => `${en} → ${zh}`),
    languageRegister: "natural Hong Kong Cantonese",
    factualRule: "Preserve the approved English meaning, qualifications, comparisons, numbers and sources exactly.",
    codeSwitchingRule: "Natural Hong Kong usage such as post, followers, KPI, Reel and 唔 work is allowed.",
    canonicalityRule: "The English source is canonical and must not be independently fact-checked, weakened, strengthened or edited for meaning.",
  };
}

function estimateBriefTokens(brief: DocumentBrief, estimator: TokenEstimator): number {
  let total = 0;
  total += estimator.englishTokens(brief.englishTitle);
  total += estimator.englishTokens(brief.focusKeyphrase);
  total += estimator.englishTokens(brief.articlePurpose);
  total += estimator.englishTokens(brief.languageRegister);
  total += estimator.englishTokens(brief.factualRule);
  total += estimator.englishTokens(brief.codeSwitchingRule);
  total += estimator.englishTokens(brief.canonicalityRule);
  for (const heading of brief.headingOutline) total += estimator.englishTokens(heading);
  for (const term of brief.terminology) total += estimator.englishTokens(term);
  return total;
}

// ── Chunk model ──

export type TranslationChunkRole =
  | "metadata"
  | "introduction"
  | "introduction-part"
  | "section"
  | "section-part"
  | "conclusion"
  | "conclusion-part"
  | "faq"
  | "protected-cta"
  | "document";

export interface TranslationChunkContinuation {
  groupKind: "introduction" | "section" | "conclusion";
  index: number;
  partIndex: number;
  totalParts: number;
  heading?: string;
}

export interface TranslationChunkOutputField {
  sourceUnitId: string;
  fields: string[];
  protected?: boolean;
}

export interface TranslationChunkOutputStructure {
  kind: "translated-unit-list";
  description: string;
  fieldsPerUnit: TranslationChunkOutputField[];
}

export interface TranslationChunk {
  chunkId: string;
  role: TranslationChunkRole;
  sourceUnitIds: string[];
  units: TranslationSourceUnit[];
  sectionHeading?: string;
  continuation?: TranslationChunkContinuation;
  documentBrief: DocumentBrief;
  previousChunkContext: { chunkId: string } | null;
  expectedOutputStructure: TranslationChunkOutputStructure;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  fingerprint: string;
}

export interface TranslationChunkPlan {
  canonicalFingerprint: string;
  chunks: TranslationChunk[];
  chunkIds: string[];
  totalSourceUnits: number;
  coveredSourceUnitIds: string[];
  expectedSourceUnitIds: string[];
  documentBrief: DocumentBrief;
  config: TranslationChunkPlannerConfig;
}

// ── Structured output contract ──

export interface TranslatedUnitResult {
  sourceUnitId: string;
  text?: string;
  block?: EditorialBlock;
  answerHtml?: string;
  answerText?: string;
  html?: string;
}

export interface TranslationChunkResponse {
  units: TranslatedUnitResult[];
}

// ── Deterministic stable hash ──

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

function unitInputTokens(
  unit: TranslationSourceUnit,
  config: TranslationChunkPlannerConfig,
  estimator: TokenEstimator,
): number {
  switch (unit.type) {
    case "metadata-title":
    case "metadata-meta-description":
    case "metadata-excerpt":
    case "section-heading":
    case "faq-question":
      return estimator.englishTokens(unit.text);
    case "introduction-block":
    case "section-block":
    case "conclusion-block":
      return estimator.englishTokens(unit.text) + config.blockStructuralTokens;
    case "faq-answer":
      return estimator.englishTokens(unit.answerText || unit.answerHtml) + config.blockStructuralTokens;
    case "cta":
      return estimator.englishTokens(unit.html) + config.blockStructuralTokens;
  }
}

// ── Internal grouping helpers ──

type SplittableGroupKind = "introduction" | "section" | "conclusion";

interface SplittableGroup {
  kind: SplittableGroupKind;
  role: TranslationChunkRole;
  ids: string[];
  headingId?: string;
  headingText?: string;
  sectionIndex?: number;
  blockIds: string[];
}

interface SubFill {
  ids: string[];
  role: TranslationChunkRole;
  headingText?: string;
  sectionIndex?: number;
  continuation?: TranslationChunkContinuation;
}

/** Split a splittable group into chunk-fittable sub-groups, never splitting a block. */
function splitSplittable(
  group: SplittableGroup,
  fits: (ids: string[]) => boolean,
): SubFill[] {
  const prefix = group.headingId ? [group.headingId] : [];
  const blocks = group.blockIds;

  if (blocks.length === 0) {
    if (prefix.length === 0) return [];
    return [{ ids: prefix, role: group.role }];
  }

  const subs: SubFill[] = [];
  let run = [...prefix];
  for (const bid of blocks) {
    if (fits([...run, bid])) {
      run.push(bid);
      continue;
    }
    if (run.length === prefix.length) {
      // Only heading (or empty) so far: the heading + this single block must fit.
      if (!fits([...prefix, bid])) {
        throw new TranslationChunkPlanError(
          `${group.headingId ? `Section ${group.sectionIndex}` : "A single editorial block"} cannot fit within the configured budget: ${bid}`,
        );
      }
      subs.push({ ids: [...prefix, bid], role: group.role });
      continue;
    }
    subs.push({ ids: run, role: group.role });
    run = [...prefix];
    if (fits([...run, bid])) {
      run.push(bid);
    } else {
      if (!fits([...prefix, bid])) {
        throw new TranslationChunkPlanError(
          `${group.headingId ? `Section ${group.sectionIndex}` : "A single editorial block"} cannot fit within the configured budget: ${bid}`,
        );
      }
      subs.push({ ids: [...prefix, bid], role: group.role });
      run = [...prefix];
    }
  }
  if (run.length > prefix.length) {
    subs.push({ ids: run, role: group.role });
  }

  const baseRole = group.role;
  const total = subs.length;
  return subs.map((sub, index) => {
    const isSection = group.headingId !== undefined;
    const partRole = index === 0
      ? baseRole
      : (baseRole === "introduction" ? "introduction-part" : baseRole === "conclusion" ? "conclusion-part" : "section-part") as TranslationChunkRole;
    const continuation: TranslationChunkContinuation | undefined = isSection
      ? {
          groupKind: "section",
          index: group.sectionIndex ?? 0,
          partIndex: index,
          totalParts: total,
          heading: group.headingText,
        }
      : {
          groupKind: baseRole === "conclusion" ? "conclusion" : "introduction",
          index: 0,
          partIndex: index,
          totalParts: total,
        };
    return { ...sub, role: partRole, headingText: group.headingText, sectionIndex: group.sectionIndex, continuation };
  });
}

function buildExpectedOutputStructure(units: TranslationSourceUnit[]): TranslationChunkOutputStructure {
  return {
    kind: "translated-unit-list",
    description: "Return one translated unit per input sourceUnitId, in the same order, with no added, missing, duplicated or reordered units.",
    fieldsPerUnit: units.map((unit) => {
      switch (unit.type) {
        case "faq-answer":
          return { sourceUnitId: unit.sourceId, fields: ["answerHtml", "answerText"] };
        case "cta":
          return { sourceUnitId: unit.sourceId, fields: ["html"], protected: true };
        case "introduction-block":
        case "section-block":
        case "conclusion-block":
          return { sourceUnitId: unit.sourceId, fields: ["block"] };
        default:
          return { sourceUnitId: unit.sourceId, fields: ["text"] };
      }
    }),
  };
}

// ── Plan construction ──

export function buildTranslationChunkPlan(
  sourceDoc: TranslationSourceDocument,
  config: TranslationChunkPlannerConfig = DEFAULT_CHUNK_PLANNER_CONFIG,
  estimator: TokenEstimator = DEFAULT_TOKEN_ESTIMATOR,
): TranslationChunkPlan {
  if (config.maxInputTokens <= 0 || config.maxOutputTokens <= 0) {
    throw new TranslationChunkPlanError("Planner max input/output token budgets must be positive");
  }

  const units = enumerateTranslationSourceUnits(sourceDoc);
  const expectedSourceUnitIds = units.map((unit) => unit.sourceId);
  const unitById = new Map(units.map((unit) => [unit.sourceId, unit]));

  const brief = buildDocumentBrief(sourceDoc);
  const briefTokens = estimateBriefTokens(brief, estimator);
  const perChunkFixedOverhead =
    config.glossaryInstructionsTokens
    + config.structuredOutputOverheadTokens
    + config.previousChunkContextTokens;
  if (config.maxInputTokens - briefTokens - perChunkFixedOverhead <= 0) {
    throw new TranslationChunkPlanError("Planner fixed overhead exceeds maxInputTokens");
  }

  const unitToken = (id: string): number => unitInputTokens(unitById.get(id)!, config, estimator);
  const sumInput = (ids: string[]): number => ids.reduce((total, id) => total + unitToken(id), 0);
  const chunkInput = (ids: string[]): number => sumInput(ids) + briefTokens + perChunkFixedOverhead;
  const isBlockUnit = (unit: TranslationSourceUnit): boolean =>
    unit.type === "introduction-block" || unit.type === "section-block" || unit.type === "conclusion-block"
    || unit.type === "faq-answer" || unit.type === "cta";
  const chunkOutput = (ids: string[]): number => {
    const sourceTokens = sumInput(ids);
    const blockCount = ids.filter((id) => isBlockUnit(unitById.get(id)!)).length;
    const jsonOverhead = config.structuredOutputOverheadTokens
      + ids.length * config.perUnitJsonTokens
      + blockCount * config.perBlockOutputStructuralTokens;
    return Math.ceil(sourceTokens * config.zhTokenPerEnglishToken) + jsonOverhead;
  };
  const chunkFits = (ids: string[]): boolean =>
    chunkInput(ids) <= config.maxInputTokens
    && chunkOutput(ids) * config.outputHeadroomFactor <= config.maxOutputTokens
    && ids.length <= config.maxUnitsPerChunk;

  // Oversize / indivisible-unit safety gate: every single unit must fit a fresh chunk.
  for (const unit of units) {
    if (!chunkFits([unit.sourceId])) {
      throw new TranslationChunkPlanError(
        `Source unit ${unit.sourceId} (${unitToken(unit.sourceId)} input tokens) cannot fit within the configured budget`,
      );
    }
  }

  // ── Assemble ordered groups ──
  const metadataIds = ["metadata.title", "metadata.metaDescription", "metadata.excerpt"]
    .filter((id) => expectedSourceUnitIds.includes(id));
  if (!chunkFits(metadataIds)) {
    throw new TranslationChunkPlanError("Metadata group cannot fit within the configured budget");
  }

  const introBlockIds = units
    .filter((unit) => unit.type === "introduction-block")
    .map((unit) => unit.sourceId);
  const conclusionBlockIds = units
    .filter((unit) => unit.type === "conclusion-block")
    .map((unit) => unit.sourceId);

  const sectionIndices = [
    ...new Set(
      units
        .filter((unit) => unit.type === "section-heading" || unit.type === "section-block")
        .map((unit) => unit.sectionIndex),
    ),
  ].sort((a, b) => a - b);

  const ctaUnit = units.find((unit) => unit.type === "cta");

  interface PlaceOp {
    flushFirst: boolean;
    ids: string[];
    role: TranslationChunkRole;
    headingText?: string;
    sectionIndex?: number;
    continuation?: TranslationChunkContinuation;
  }

  const ops: PlaceOp[] = [];
  const enqueue = (ids: string[], role: TranslationChunkRole, extras?: Partial<PlaceOp>): void => {
    ops.push({ flushFirst: false, ids, role, ...extras });
  };

  // Metadata
  enqueue(metadataIds, "metadata");
  if (config.metadataPlacement === "separate") {
    ops.push({ flushFirst: true, ids: [], role: "metadata" });
  }

  // Introduction
  const introFills = splitSplittable({ kind: "introduction", role: "introduction", ids: introBlockIds, blockIds: introBlockIds }, chunkFits);
  for (const fill of introFills) enqueue(fill.ids, fill.role, fill);

  // Sections
  for (const index of sectionIndices) {
    const headingId = `section.${index}.heading`;
    const blockIds = units
      .filter((unit) => unit.type === "section-block" && unit.sectionIndex === index)
      .map((unit) => unit.sourceId);
    const headingUnit = unitById.get(headingId);
    const headingText = headingUnit && headingUnit.type === "section-heading" ? headingUnit.text : undefined;
    const sectionFills = splitSplittable(
      { kind: "section", role: "section", ids: [headingId, ...blockIds], headingId, headingText, sectionIndex: index, blockIds },
      chunkFits,
    );
    for (const fill of sectionFills) enqueue(fill.ids, fill.role, fill);
  }

  // Conclusion (own chunk — never piled onto a section chunk)
  ops.push({ flushFirst: true, ids: [], role: "conclusion" });
  const conclusionFills = splitSplittable({ kind: "conclusion", role: "conclusion", ids: conclusionBlockIds, blockIds: conclusionBlockIds }, chunkFits);
  for (const fill of conclusionFills) enqueue(fill.ids, fill.role, fill);

  // FAQ (own chunk — never piled onto a section/conclusion chunk)
  ops.push({ flushFirst: true, ids: [], role: "faq" });
  for (const unit of units) {
    if (unit.type !== "faq-question") continue;
    const pairIds = [`faq.${unit.faqIndex}.question`, `faq.${unit.faqIndex}.answer`];
    if (!chunkFits(pairIds)) {
      throw new TranslationChunkPlanError(`FAQ ${unit.faqIndex} question/answer pair cannot fit within the configured budget`);
    }
    enqueue(pairIds, "faq");
  }

  // CTA
  if (ctaUnit) {
    if (config.ctaPlacement === "separate") {
      ops.push({ flushFirst: true, ids: [], role: "protected-cta" });
    }
    enqueue([ctaUnit.sourceId], "protected-cta");
  }

  // ── Greedy assembly into chunks (respecting canonical order) ──
  interface WorkingChunk {
    role: TranslationChunkRole;
    ids: string[];
    headingText?: string;
    sectionIndex?: number;
    continuation?: TranslationChunkContinuation;
  }
  const working: WorkingChunk[] = [];
  let current: WorkingChunk | null = null;
  const flush = (): void => {
    if (current && current.ids.length > 0) {
      working.push(current);
      current = null;
    }
  };
  for (const op of ops) {
    if (op.flushFirst) {
      flush();
      continue;
    }
    if (op.ids.length === 0) continue;
    if (current && chunkFits([...current.ids, ...op.ids])) {
      current.ids.push(...op.ids);
      if (!current.headingText && op.headingText) current.headingText = op.headingText;
      if (!current.continuation && op.continuation) current.continuation = op.continuation;
      continue;
    }
    flush();
    current = {
      role: op.role,
      ids: [...op.ids],
      headingText: op.headingText,
      sectionIndex: op.sectionIndex,
      continuation: op.continuation,
    };
    if (!chunkFits(current.ids)) {
      throw new TranslationChunkPlanError("A planned chunk exceeds the configured budget");
    }
  }
  flush();

  // ── Build TranslationChunk objects ──
  const chunks: TranslationChunk[] = working.map((entry, index) => {
    const chunkId = `chunk.${index}`;
    const chunkUnits = entry.ids.map((id) => getTranslationSourceUnit(sourceDoc, id));
    const firstSectionHeading = chunkUnits.find((unit) => unit.type === "section-heading")?.text;
    const estimatedInputTokens = chunkInput(entry.ids);
    const estimatedOutputTokens = chunkOutput(entry.ids);
    const expectedOutputStructure = buildExpectedOutputStructure(chunkUnits);
    const fingerprint = stableHash(`${chunkId}|${entry.ids.join(",")}|${JSON.stringify(chunkUnits)}`);
    return {
      chunkId,
      role: entry.role,
      sourceUnitIds: entry.ids,
      units: chunkUnits,
      sectionHeading: firstSectionHeading ?? entry.headingText,
      continuation: entry.continuation,
      documentBrief: brief,
      previousChunkContext: index === 0 ? null : { chunkId: `chunk.${index - 1}` },
      expectedOutputStructure,
      maxOutputTokens: config.maxOutputTokens,
      estimatedInputTokens,
      estimatedOutputTokens,
      fingerprint,
    };
  });

  return {
    canonicalFingerprint: stableHash(serializeTranslationSourceDocument(sourceDoc)),
    chunks,
    chunkIds: chunks.map((chunk) => chunk.chunkId),
    totalSourceUnits: expectedSourceUnitIds.length,
    coveredSourceUnitIds: chunks.flatMap((chunk) => chunk.sourceUnitIds),
    expectedSourceUnitIds,
    documentBrief: brief,
    config,
  };
}

// ── Plan queries and verification ──

export function enumerateTranslationChunks(plan: TranslationChunkPlan): TranslationChunk[] {
  return plan.chunks.map((chunk) => chunk);
}

export function getTranslationChunk(plan: TranslationChunkPlan, chunkId: string): TranslationChunk {
  const chunk = plan.chunks.find((entry) => entry.chunkId === chunkId);
  if (!chunk) throw new TranslationChunkPlanError(`Unknown translation chunk: "${chunkId}"`);
  return chunk;
}

export function verifyTranslationChunkCoverage(plan: TranslationChunkPlan): {
  complete: boolean;
  missing: string[];
  duplicates: string[];
  extra: string[];
} {
  const expected = new Set(plan.expectedSourceUnitIds);
  const assigned = plan.coveredSourceUnitIds;
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of assigned) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  const missing = plan.expectedSourceUnitIds.filter((id) => !seen.has(id));
  const extra = assigned.filter((id) => !expected.has(id));
  return { complete: missing.length === 0 && duplicates.length === 0 && extra.length === 0, missing, duplicates, extra };
}

export function verifyTranslationChunkBoundaries(plan: TranslationChunkPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const chunkFor = new Map<string, number>();
  plan.chunks.forEach((chunk, index) => {
    for (const id of chunk.sourceUnitIds) chunkFor.set(id, index);
  });

  // Section: any chunk holding a section body block must also hold that section's heading.
  const sectionBlockRegex = /^section\.(\d+)\.block\.(\d+)$/;
  const sectionHeadingRegex = /^section\.(\d+)\.heading$/;
  for (const [id, chunkIndex] of chunkFor) {
    const m = sectionBlockRegex.exec(id);
    if (!m) continue;
    const headingId = `section.${m[1]}.heading`;
    const headingChunk = chunkFor.get(headingId);
    if (headingChunk === undefined) {
      errors.push(`Section body ${id} has no heading in the plan`);
    } else if (headingChunk !== chunkIndex) {
      errors.push(`Section body ${id} (chunk ${chunkIndex}) is separated from its heading ${headingId} (chunk ${headingChunk})`);
    }
  }
  for (const [id, chunkIndex] of chunkFor) {
    const m = sectionHeadingRegex.exec(id);
    if (!m) continue;
    const blockIds = [...chunkFor.keys()].filter((key) => key.startsWith(`section.${m[1]}.block.`));
    if (blockIds.length > 0 && !blockIds.some((bid) => chunkFor.get(bid) === chunkIndex)) {
      errors.push(`Section heading ${id} (chunk ${chunkIndex}) has no body block in the same chunk`);
    }
  }

  // FAQ: question and answer must be in the same chunk.
  for (const [id, chunkIndex] of chunkFor) {
    const qm = /^faq\.(\d+)\.question$/.exec(id);
    if (!qm) continue;
    const answerId = `faq.${qm[1]}.answer`;
    if (chunkFor.get(answerId) !== chunkIndex) {
      errors.push(`FAQ ${id} is separated from its answer ${answerId}`);
    }
  }

  // Canonical order preserved across chunks.
  const positions = new Map(plan.expectedSourceUnitIds.map((id, index) => [id, index]));
  let last = -1;
  for (const id of plan.coveredSourceUnitIds) {
    const position = positions.get(id);
    if (position === undefined) {
      errors.push(`Unknown source unit in coverage: ${id}`);
      continue;
    }
    if (position < last) errors.push(`Canonical order violated at ${id}`);
    last = position;
  }

  return { valid: errors.length === 0, errors };
}

export function verifyTranslationChunkPlan(plan: TranslationChunkPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const coverage = verifyTranslationChunkCoverage(plan);
  if (coverage.missing.length > 0) errors.push(`Missing source units: ${coverage.missing.join(", ")}`);
  if (coverage.duplicates.length > 0) errors.push(`Duplicated source units: ${coverage.duplicates.join(", ")}`);
  if (coverage.extra.length > 0) errors.push(`Extra source units: ${coverage.extra.join(", ")}`);
  const boundaries = verifyTranslationChunkBoundaries(plan);
  errors.push(...boundaries.errors);
  return { valid: errors.length === 0, errors };
}

// ── Serialization / reconstruction ──

export function serializeTranslationChunkPlan(plan: TranslationChunkPlan): string {
  return JSON.stringify(plan);
}

export function parseTranslationChunkPlan(json: string): TranslationChunkPlan {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TranslationChunkPlanError("Invalid JSON for translation chunk plan");
  }
  const candidate = value as TranslationChunkPlan;
  if (
    !candidate
    || typeof candidate !== "object"
    || typeof candidate.canonicalFingerprint !== "string"
    || !Array.isArray(candidate.chunks)
    || !Array.isArray(candidate.chunkIds)
    || !Array.isArray(candidate.coveredSourceUnitIds)
    || !Array.isArray(candidate.expectedSourceUnitIds)
    || !candidate.config
  ) {
    throw new TranslationChunkPlanError("Invalid translation chunk plan shape");
  }
  return candidate;
}

// ── Structured output contract validation ──

function sameStringSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface NumberParityResult {
  lost: string[];
  extra: string[];
}

/** Per-source-unit validation result. `advisory` metadata units never hard-fail a chunk. */
export interface PerUnitValidationResult {
  sourceUnitId: string;
  present: boolean;
  valid: boolean;
  /** Metadata units (title/metaDescription/excerpt): number/URL differences are advisory. */
  advisory: boolean;
  categories: string[];
  warnings: string[];
  missingPlaceholders: string[];
  extraPlaceholders: string[];
  numberParity: NumberParityResult;
  urlParity: NumberParityResult;
  structureParity: {
    changed: boolean;
    /** Expected editorial-structure signature (block type + inline node shape). */
    expected?: string;
    /** Returned editorial-structure signature (block type + inline node shape). */
    returned?: string;
  };
}

function isMetadataUnit(source: TranslationSourceUnit): boolean {
  return source.type === "metadata-title"
    || source.type === "metadata-meta-description"
    || source.type === "metadata-excerpt";
}

export function validateUnitProtectedFields(source: TranslationSourceUnit, result: TranslatedUnitResult): PerUnitValidationResult {
  const id = source.sourceId;
  const advisory = isMetadataUnit(source);
  const out: PerUnitValidationResult = {
    sourceUnitId: id,
    present: true,
    valid: true,
    advisory,
    categories: [],
    warnings: [],
    missingPlaceholders: [],
    extraPlaceholders: [],
    numberParity: { lost: [], extra: [] },
    urlParity: { lost: [], extra: [] },
    structureParity: { changed: false },
  };
  const fail = (category: string, message: string): void => {
    if (advisory && (category === "number parity" || category === "URL parity" || category === "missing content")) {
      out.warnings.push(message);
      return;
    }
    out.categories.push(category);
    out.valid = false;
    out.warnings.push(message);
  };

  switch (source.type) {
    case "metadata-title":
    case "metadata-meta-description":
    case "metadata-excerpt":
    case "section-heading":
    case "faq-question": {
      const text = result.text ?? "";
      if (!text) {
        // For metadata with an empty source, an empty translation is acceptable.
        if (advisory && !source.text) {
          out.warnings.push(`${id}: empty translated metadata (source empty, advisory)`);
          return out;
        }
        fail("missing content", `${id}: missing translated text`);
        return out;
      }
      const numbers = checkNumbersPreserved(source.text, text);
      if (numbers.lost.length > 0) { out.numberParity.lost.push(...numbers.lost); fail("number parity", `${id}: numbers lost (${numbers.lost.join(", ")})`); }
      if (numbers.extras.length > 0) { out.numberParity.extra.push(...numbers.extras); fail("number parity", `${id}: unexpected numbers (${numbers.extras.join(", ")})`); }
      const linksLost = checkLinksPreserved(source.text, text);
      const newUrls = checkNoNewUrls(source.text, text);
      if (linksLost.length > 0) { out.urlParity.lost.push(...linksLost); fail("URL parity", `${id}: URLs lost (${linksLost.join(", ")})`); }
      if (newUrls.length > 0) { out.urlParity.extra.push(...newUrls); fail("URL parity", `${id}: unexpected URLs (${newUrls.join(", ")})`); }
      return out;
    }
    case "introduction-block":
    case "section-block":
    case "conclusion-block": {
      if (!result.block) {
        fail("missing content", `${id}: missing translated block`);
        return out;
      }
      const sourceBlock = source.block;
      const sigSrc = editorialStructureSignature([sourceBlock]);
      const sigTgt = editorialStructureSignature([result.block]);
      if (sigSrc.join("|") !== sigTgt.join("|")) {
        out.structureParity.changed = true;
        out.structureParity.expected = sigSrc.join("|");
        out.structureParity.returned = sigTgt.join("|");
        fail("structure parity", `${id}: block structure changed (expected=${sigSrc.join("|")} returned=${sigTgt.join("|")})`);
      }
      for (const blockError of validateEditorialBlocks([result.block])) {
        fail("structure parity", `${id}: ${blockError}`);
      }
      const numbers = checkBlockNumbersPreserved([sourceBlock], [result.block]);
      if (numbers.lost.length > 0) { out.numberParity.lost.push(...numbers.lost); fail("number parity", `${id}: numbers lost (${numbers.lost.join(", ")})`); }
      if (numbers.extras.length > 0) { out.numberParity.extra.push(...numbers.extras); fail("number parity", `${id}: unexpected numbers (${numbers.extras.join(", ")})`); }
      const srcLinks = extractLinksFromEditorialBlocks([sourceBlock]);
      const tgtLinks = extractLinksFromEditorialBlocks([result.block]);
      if (!sameStringSequence(srcLinks, tgtLinks)) {
        out.urlParity.extra.push(...tgtLinks.filter((l) => !srcLinks.includes(l)));
        out.urlParity.lost.push(...srcLinks.filter((l) => !tgtLinks.includes(l)));
        fail("URL parity", `${id}: URLs changed`);
      }
      const linksLost = checkBlockLinksPreserved([sourceBlock], [result.block]);
      if (linksLost.length > 0) { out.urlParity.lost.push(...linksLost); fail("URL parity", `${id}: URLs lost (${linksLost.join(", ")})`); }
      return out;
    }
    case "faq-answer": {
      const surface = result.answerHtml ?? result.answerText ?? "";
      if (!surface) {
        fail("missing content", `${id}: missing translated answer`);
        return out;
      }
      const sourceSurface = source.answerHtml || source.answerText;
      const numbers = checkNumbersPreserved(sourceSurface, surface);
      if (numbers.lost.length > 0) { out.numberParity.lost.push(...numbers.lost); fail("number parity", `${id}: numbers lost (${numbers.lost.join(", ")})`); }
      if (numbers.extras.length > 0) { out.numberParity.extra.push(...numbers.extras); fail("number parity", `${id}: unexpected numbers (${numbers.extras.join(", ")})`); }
      const linksLost = checkLinksPreserved(sourceSurface, surface);
      const newUrls = checkNoNewUrls(sourceSurface, surface);
      if (linksLost.length > 0) { out.urlParity.lost.push(...linksLost); fail("URL parity", `${id}: URLs lost (${linksLost.join(", ")})`); }
      if (newUrls.length > 0) { out.urlParity.extra.push(...newUrls); fail("URL parity", `${id}: unexpected URLs (${newUrls.join(", ")})`); }
      return out;
    }
    case "cta": {
      if (!result.html) {
        fail("missing content", `${id}: missing cta html`);
        return out;
      }
      const numbers = checkNumbersPreserved(source.html, result.html);
      if (numbers.lost.length > 0) { out.numberParity.lost.push(...numbers.lost); fail("number parity", `${id}: numbers lost (${numbers.lost.join(", ")})`); }
      if (numbers.extras.length > 0) { out.numberParity.extra.push(...numbers.extras); fail("number parity", `${id}: unexpected numbers (${numbers.extras.join(", ")})`); }
      const linksLost = checkLinksPreserved(source.html, result.html);
      const newUrls = checkNoNewUrls(source.html, result.html);
      if (linksLost.length > 0) { out.urlParity.lost.push(...linksLost); fail("URL parity", `${id}: URLs lost (${linksLost.join(", ")})`); }
      if (newUrls.length > 0) { out.urlParity.extra.push(...newUrls); fail("URL parity", `${id}: unexpected URLs (${newUrls.join(", ")})`); }
      return out;
    }
  }
  return out;
}

export interface StructuredChunkValidationResult {
  valid: boolean;
  errors: string[];
  units: PerUnitValidationResult[];
}

export function validateStructuredChunkResponse(
  chunk: TranslationChunk,
  response: unknown,
): StructuredChunkValidationResult {
  const errors: string[] = [];
  if (!response || typeof response !== "object") {
    return { valid: false, errors: ["response must be an object"], units: [] };
  }
  const respUnits = (response as TranslationChunkResponse).units;
  if (!Array.isArray(respUnits)) {
    return { valid: false, errors: ["response.units must be an array"], units: [] };
  }

  const returnedIds = respUnits.map((unit) => unit.sourceUnitId);
  if (!sameStringSequence(returnedIds, chunk.sourceUnitIds)) {
    const expected = chunk.sourceUnitIds;
    if (returnedIds.length !== expected.length) {
      errors.push(`unit count mismatch: expected ${expected.length}, got ${returnedIds.length}`);
    }
    const missing = expected.filter((id) => !returnedIds.includes(id));
    const extra = returnedIds.filter((id) => !expected.includes(id));
    const seen = new Set<string>();
    const duplicated = returnedIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    if (missing.length > 0) errors.push(`missing source units: ${missing.join(", ")}`);
    if (extra.length > 0) errors.push(`unexpected/unknown source units: ${extra.join(", ")}`);
    if (duplicated.length > 0) errors.push(`duplicated source units: ${duplicated.join(", ")}`);
    if (returnedIds.length === expected.length && missing.length === 0 && extra.length === 0) {
      errors.push("source units are out of canonical order");
    }
  }

  const unitMap = new Map(chunk.units.map((unit) => [unit.sourceId, unit]));
  const results: PerUnitValidationResult[] = [];

  for (const result of respUnits) {
    const source = unitMap.get(result.sourceUnitId);
    if (!source) {
      results.push({
        sourceUnitId: result.sourceUnitId,
        present: true,
        valid: false,
        advisory: false,
        categories: ["ID contract"],
        warnings: ["unknown source unit"],
        missingPlaceholders: [],
        extraPlaceholders: [],
        numberParity: { lost: [], extra: [] },
        urlParity: { lost: [], extra: [] },
        structureParity: { changed: false },
      });
      continue;
    }
    results.push(validateUnitProtectedFields(source, result));
  }

  for (const id of chunk.sourceUnitIds) {
    if (!returnedIds.includes(id)) {
      results.push({
        sourceUnitId: id,
        present: false,
        valid: false,
        advisory: false,
        categories: ["ID contract"],
        warnings: ["missing from response"],
        missingPlaceholders: [],
        extraPlaceholders: [],
        numberParity: { lost: [], extra: [] },
        urlParity: { lost: [], extra: [] },
        structureParity: { changed: false },
      });
    }
  }

  const resultById = new Map(results.map((r) => [r.sourceUnitId, r]));
  const ordered: PerUnitValidationResult[] = chunk.sourceUnitIds
    .map((id) => resultById.get(id))
    .filter((r): r is PerUnitValidationResult => Boolean(r));
  for (const r of results) {
    if (!chunk.sourceUnitIds.includes(r.sourceUnitId)) ordered.push(r);
  }

  const hardInvalid = ordered.filter((r) => !r.advisory && !r.valid);
  return { valid: errors.length === 0 && hardInvalid.length === 0, errors, units: ordered };
}
