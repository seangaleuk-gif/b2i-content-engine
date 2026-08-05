// ── Canonical English translation-source document ──
// Stage 1 of the approved translation-architecture migration.
//
// Purpose: a deterministic, immutable representation of the approved English
// ArticleDocument so that every future Traditional Chinese translation,
// editorial and semantic-validation stage can reference the exact corresponding
// English source field by a stable source ID.
//
// Contract:
//  - Building never mutates the approved English ArticleDocument.
//  - Source IDs are document paths built from indices (never UUIDs), so the
//    same English document always yields the same IDs.
//  - Original inline links, formatting nodes, WordPress block structure and
//    protected content are preserved verbatim.
//  - No claim IDs or evidence ownership are invented; only evidence/link
//    metadata already present on the English document is carried forward
//    (insertedLinks).
//  - This module is additive and deliberately NOT wired into production
//    translation orchestration yet.
//
// Purity: this module imports no AI provider and performs no API calls, number
// protection, prompts or translation validation. It reuses existing extraction
// utilities for links/numbers where numbers/URLs need to be surfaced per unit.

import type {
  ArticleDocument,
  InsertedLink,
} from "@/lib/blog/article-document";
import {
  type EditorialBlock,
  extractPlainTextFromEditorialBlocks,
  cloneEditorialBlocks,
} from "@/lib/blog/article-content";
import {
  extractLinksFromEditorialBlocks,
  extractNumbersFromEditorialBlocks,
} from "./editorial-block-protection";
import { extractLinks, extractVisibleNumbers } from "./translation-validator";

// ── Document model ──

export interface TranslationSourceMetadata {
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  focusKeyphrase: string;
  targetWordCount: number;
}

export interface TranslationSourceSection {
  heading: string;
  sectionType: "main" | "mistakes" | "faq-heading" | "conclusion-heading";
  blocks: EditorialBlock[];
}

export interface TranslationSourceFaqEntry {
  question: string;
  answerHtml: string;
  answerText: string;
}

export interface TranslationSourceCta {
  html: string;
  fingerprint: string;
}

export interface TranslationSourceDocument {
  metadata: TranslationSourceMetadata;
  introduction: EditorialBlock[];
  sections: TranslationSourceSection[];
  conclusion: EditorialBlock[];
  faq: TranslationSourceFaqEntry[];
  cta: TranslationSourceCta | null;
  insertedLinks: InsertedLink[];
}

// ── Source unit model ──

export type TranslationSourceUnitType =
  | "metadata-title"
  | "metadata-meta-description"
  | "metadata-excerpt"
  | "introduction-block"
  | "section-heading"
  | "section-block"
  | "conclusion-block"
  | "faq-question"
  | "faq-answer"
  | "cta";

/** One translatable unit, addressed by a stable document-path source ID. */
export type TranslationSourceUnit =
  | { sourceId: string; type: "metadata-title"; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "metadata-meta-description"; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "metadata-excerpt"; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "introduction-block"; blockIndex: number; block: EditorialBlock; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "section-heading"; sectionIndex: number; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "section-block"; sectionIndex: number; blockIndex: number; block: EditorialBlock; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "conclusion-block"; blockIndex: number; block: EditorialBlock; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "faq-question"; faqIndex: number; text: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "faq-answer"; faqIndex: number; answerHtml: string; answerText: string; links: string[]; numbers: string[] }
  | { sourceId: string; type: "cta"; html: string; links: string[]; numbers: string[] };

// ── Immutable build ──

/**
 * Build the canonical English translation-source document from an approved
 * English ArticleDocument. The input is never mutated; all mutable content is
 * deep-cloned into the returned representation.
 */
export function buildTranslationSourceDocument(enDoc: ArticleDocument): TranslationSourceDocument {
  const doc: TranslationSourceDocument = {
    metadata: {
      title: enDoc.metadata.title,
      slug: enDoc.metadata.slug,
      metaDescription: enDoc.metadata.metaDescription,
      excerpt: enDoc.metadata.excerpt,
      focusKeyphrase: enDoc.metadata.focusKeyphrase,
      targetWordCount: enDoc.metadata.targetWordCount,
    },
    introduction: cloneEditorialBlocks(enDoc.introduction.blocks),
    sections: enDoc.sections.map((section) => ({
      heading: section.heading,
      sectionType: section.sectionType,
      blocks: cloneEditorialBlocks(section.blocks),
    })),
    conclusion: cloneEditorialBlocks(enDoc.conclusion.blocks),
    faq: enDoc.visibleFaq.map((entry) => ({
      question: entry.question,
      answerHtml: entry.answerHtml,
      answerText: entry.answerText,
    })),
    cta: enDoc.cta
      ? { html: enDoc.cta.html, fingerprint: enDoc.cta.fingerprint }
      : null,
    insertedLinks: enDoc.insertedLinks.map((link) => ({ ...link })),
  };

  // Deterministic fail-fast: the builder must never emit duplicate source IDs.
  const { unique, duplicates } = verifyTranslationSourceIdUniqueness(doc);
  if (!unique) {
    throw new Error(`Duplicate translation source IDs: ${duplicates.join(", ")}`);
  }

  return doc;
}

// ── Unit builders (shared by enumeration and retrieval) ──

function textUnitFields(text: string): { text: string; links: string[]; numbers: string[] } {
  return { text, links: extractLinks(text), numbers: extractVisibleNumbers(text) };
}

function htmlUnitFields(html: string): { links: string[]; numbers: string[] } {
  return { links: extractLinks(html), numbers: extractVisibleNumbers(html) };
}

function blockUnitBase(block: EditorialBlock): { text: string; links: string[]; numbers: string[] } {
  return {
    text: extractPlainTextFromEditorialBlocks([block]),
    links: extractLinksFromEditorialBlocks([block]),
    numbers: extractNumbersFromEditorialBlocks([block]),
  };
}

function metadataTitleUnit(doc: TranslationSourceDocument): TranslationSourceUnit {
  return { sourceId: "metadata.title", type: "metadata-title", ...textUnitFields(doc.metadata.title) };
}

function metadataMetaDescriptionUnit(doc: TranslationSourceDocument): TranslationSourceUnit {
  return { sourceId: "metadata.metaDescription", type: "metadata-meta-description", ...textUnitFields(doc.metadata.metaDescription) };
}

function metadataExcerptUnit(doc: TranslationSourceDocument): TranslationSourceUnit {
  return { sourceId: "metadata.excerpt", type: "metadata-excerpt", ...textUnitFields(doc.metadata.excerpt) };
}

function introductionBlockUnit(doc: TranslationSourceDocument, blockIndex: number): TranslationSourceUnit {
  const block = doc.introduction[blockIndex];
  return { sourceId: `introduction.block.${blockIndex}`, type: "introduction-block", blockIndex, block, ...blockUnitBase(block) };
}

function sectionHeadingUnit(doc: TranslationSourceDocument, sectionIndex: number): TranslationSourceUnit {
  return { sourceId: `section.${sectionIndex}.heading`, type: "section-heading", sectionIndex, ...textUnitFields(doc.sections[sectionIndex].heading) };
}

function sectionBlockUnit(doc: TranslationSourceDocument, sectionIndex: number, blockIndex: number): TranslationSourceUnit {
  const block = doc.sections[sectionIndex].blocks[blockIndex];
  return { sourceId: `section.${sectionIndex}.block.${blockIndex}`, type: "section-block", sectionIndex, blockIndex, block, ...blockUnitBase(block) };
}

function conclusionBlockUnit(doc: TranslationSourceDocument, blockIndex: number): TranslationSourceUnit {
  const block = doc.conclusion[blockIndex];
  return { sourceId: `conclusion.block.${blockIndex}`, type: "conclusion-block", blockIndex, block, ...blockUnitBase(block) };
}

function faqQuestionUnit(doc: TranslationSourceDocument, faqIndex: number): TranslationSourceUnit {
  return { sourceId: `faq.${faqIndex}.question`, type: "faq-question", faqIndex, ...textUnitFields(doc.faq[faqIndex].question) };
}

function faqAnswerUnit(doc: TranslationSourceDocument, faqIndex: number): TranslationSourceUnit {
  const entry = doc.faq[faqIndex];
  const surface = entry.answerHtml || entry.answerText;
  return {
    sourceId: `faq.${faqIndex}.answer`,
    type: "faq-answer",
    faqIndex,
    answerHtml: entry.answerHtml,
    answerText: entry.answerText,
    ...htmlUnitFields(surface),
  };
}

function ctaUnit(doc: TranslationSourceDocument): TranslationSourceUnit {
  if (!doc.cta) {
    throw new Error("Translation source document has no CTA to resolve");
  }
  return { sourceId: "cta", type: "cta", html: doc.cta.html, ...htmlUnitFields(doc.cta.html) };
}

// ── Enumeration in canonical document order ──
// intro → sections (heading then body blocks) → conclusion → FAQ (question then
// answer per entry) → CTA. Matches renderArticleDocument ordering.

export function enumerateTranslationSourceUnits(doc: TranslationSourceDocument): TranslationSourceUnit[] {
  const units: TranslationSourceUnit[] = [];
  units.push(metadataTitleUnit(doc));
  units.push(metadataMetaDescriptionUnit(doc));
  units.push(metadataExcerptUnit(doc));
  for (let i = 0; i < doc.introduction.length; i++) units.push(introductionBlockUnit(doc, i));
  for (let i = 0; i < doc.sections.length; i++) {
    units.push(sectionHeadingUnit(doc, i));
    for (let j = 0; j < doc.sections[i].blocks.length; j++) units.push(sectionBlockUnit(doc, i, j));
  }
  for (let i = 0; i < doc.conclusion.length; i++) units.push(conclusionBlockUnit(doc, i));
  for (let i = 0; i < doc.faq.length; i++) {
    units.push(faqQuestionUnit(doc, i));
    units.push(faqAnswerUnit(doc, i));
  }
  if (doc.cta) units.push(ctaUnit(doc));
  return units;
}

// ── Source ID parsing and retrieval ──

interface ParsedSourceId {
  kind: TranslationSourceUnitType;
  index?: number;
  secondary?: number;
}

/** Parse a document-path source ID into a structured kind + indices. */
export function parseTranslationSourceId(sourceId: string): ParsedSourceId | null {
  const trimmed = sourceId.trim();
  if (trimmed === "metadata.title") return { kind: "metadata-title" };
  if (trimmed === "metadata.metaDescription") return { kind: "metadata-meta-description" };
  if (trimmed === "metadata.excerpt") return { kind: "metadata-excerpt" };
  if (trimmed === "cta") return { kind: "cta" };

  let m = /^introduction\.block\.(\d+)$/.exec(trimmed);
  if (m) return { kind: "introduction-block", index: Number(m[1]) };

  m = /^conclusion\.block\.(\d+)$/.exec(trimmed);
  if (m) return { kind: "conclusion-block", index: Number(m[1]) };

  m = /^section\.(\d+)\.heading$/.exec(trimmed);
  if (m) return { kind: "section-heading", index: Number(m[1]) };

  m = /^section\.(\d+)\.block\.(\d+)$/.exec(trimmed);
  if (m) return { kind: "section-block", index: Number(m[1]), secondary: Number(m[2]) };

  m = /^faq\.(\d+)\.question$/.exec(trimmed);
  if (m) return { kind: "faq-question", index: Number(m[1]) };

  m = /^faq\.(\d+)\.answer$/.exec(trimmed);
  if (m) return { kind: "faq-answer", index: Number(m[1]) };

  return null;
}

function resolveParsed(doc: TranslationSourceDocument, parsed: ParsedSourceId): TranslationSourceUnit {
  const { kind, index = 0, secondary = 0 } = parsed;
  switch (kind) {
    case "metadata-title":
      return metadataTitleUnit(doc);
    case "metadata-meta-description":
      return metadataMetaDescriptionUnit(doc);
    case "metadata-excerpt":
      return metadataExcerptUnit(doc);
    case "introduction-block":
      if (index >= doc.introduction.length) throw new Error(`Translation source ID not found: introduction.block.${index}`);
      return introductionBlockUnit(doc, index);
    case "section-heading":
      if (index >= doc.sections.length) throw new Error(`Translation source ID not found: section.${index}.heading`);
      return sectionHeadingUnit(doc, index);
    case "section-block":
      if (index >= doc.sections.length) throw new Error(`Translation source ID not found: section.${index}.block.${secondary}`);
      if (secondary >= doc.sections[index].blocks.length) throw new Error(`Translation source ID not found: section.${index}.block.${secondary}`);
      return sectionBlockUnit(doc, index, secondary);
    case "conclusion-block":
      if (index >= doc.conclusion.length) throw new Error(`Translation source ID not found: conclusion.block.${index}`);
      return conclusionBlockUnit(doc, index);
    case "faq-question":
      if (index >= doc.faq.length) throw new Error(`Translation source ID not found: faq.${index}.question`);
      return faqQuestionUnit(doc, index);
    case "faq-answer":
      if (index >= doc.faq.length) throw new Error(`Translation source ID not found: faq.${index}.answer`);
      return faqAnswerUnit(doc, index);
    case "cta":
      return ctaUnit(doc);
    default:
      throw new Error(`Unknown translation source ID kind: ${String(kind)}`);
  }
}

/** Retrieve a source unit by its stable source ID. Throws deterministically on malformed or missing IDs. */
export function getTranslationSourceUnit(doc: TranslationSourceDocument, sourceId: string): TranslationSourceUnit {
  const parsed = parseTranslationSourceId(sourceId);
  if (!parsed) throw new Error(`Unknown translation source ID: "${sourceId}"`);
  return resolveParsed(doc, parsed);
}

// ── Uniqueness verification ──

export function verifyTranslationSourceIdUniqueness(doc: TranslationSourceDocument): { unique: boolean; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const unit of enumerateTranslationSourceUnits(doc)) {
    if (seen.has(unit.sourceId)) duplicates.push(unit.sourceId);
    seen.add(unit.sourceId);
  }
  return { unique: duplicates.length === 0, duplicates };
}

// ── Serialization / reconstruction ──

/** Serialize the source document to a lossless JSON string. */
export function serializeTranslationSourceDocument(doc: TranslationSourceDocument): string {
  return JSON.stringify(doc);
}

/** Reconstruct a source document from its serialized form, validating the shape. */
export function parseTranslationSourceDocument(json: string): TranslationSourceDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON for translation source document");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Translation source document must be a JSON object");
  }
  const candidate = value as TranslationSourceDocument;
  if (
    !candidate.metadata
    || typeof candidate.metadata !== "object"
    || !Array.isArray(candidate.introduction)
    || !Array.isArray(candidate.sections)
    || !Array.isArray(candidate.conclusion)
    || !Array.isArray(candidate.faq)
    || !Array.isArray(candidate.insertedLinks)
  ) {
    throw new Error("Invalid translation source document shape");
  }
  return candidate;
}
