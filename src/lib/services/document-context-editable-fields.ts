// ── Immutable text-leaf editable fields for the bounded zh-HK editorial review ──
//
// The editorial reviewer must NEVER return complete replacement blocks. Instead the
// server enumerates every editable text leaf of a translated unit, assigns each an
// opaque server-generated fieldId, and maps fieldId → the exact ArticleDocument
// text-node location. The model may only supply replacement text for supplied
// fieldId values; it cannot define structure, nodes, paths, or URLs. The server
// (not the model) reconstructs the final document by applying accepted text edits
// onto a deep clone.
//
// This module is pure data + text transforms: it makes ZERO provider calls. It is
// shared by candidate selection (field enumeration) and by deterministic patch
// application.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import { editorialStructureSignature } from "./editorial-block-translation";

// ── Location model ──

export type BlockRef =
  | { component: "introduction"; blockIndex: number }
  | { component: "section"; sectionIndex: number; blockIndex: number }
  | { component: "conclusion"; blockIndex: number };

export type BlockLeaf =
  | { nodeType: "content"; nodeIndex: number }
  | { nodeType: "list"; itemIndex: number; nodeIndex: number }
  | { nodeType: "table-header"; colIndex: number; nodeIndex: number }
  | { nodeType: "table-cell"; rowIndex: number; colIndex: number; nodeIndex: number };

/** Exact server-side location of one editable text leaf in the ArticleDocument. */
export type FieldLocation =
  | { kind: "metadata"; field: "title" | "metaDescription" | "excerpt" }
  | { kind: "section-heading"; sectionIndex: number }
  | { kind: "faq-question"; faqIndex: number }
  | { kind: "faq-answer"; faqIndex: number }
  | { kind: "block"; ref: BlockRef; leaf: BlockLeaf };

export interface EditableField {
  /** Opaque server-generated ID. The model may not infer the document path from it. */
  fieldId: string;
  /** The source unit this field belongs to. */
  sourceUnitId: string;
  /** Current zh-HK text of the leaf (captured at generation; used for stale checks). */
  currentText: string;
  /** English source text of the leaf (read-only reference for the reviewer). */
  sourceText: string;
  readOnlyContext: {
    blockType: string;
    structureSignature: string;
    nodeType: string;
    isLink: boolean;
  };
  /** Internal exact location; never exposed to the model. */
  location: FieldLocation;
}

export interface FieldIndex {
  fields: EditableField[];
  byId: Map<string, EditableField>;
  byUnit: Map<string, EditableField[]>;
}

// ── Field-ID generation (opaque, deterministic for tests) ──

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

function fieldIdFor(sourceUnitId: string, location: FieldLocation): string {
  return `f_${hashString(`${sourceUnitId}::${JSON.stringify(location)}`)}`;
}

// ── Citation detection (mirrors collectAlignedUnits so indices stay aligned) ──

const CITATION_RE = /^\s*(?:來源|資料來源|Source)\s*[：:]/iu;

function blockVisibleText(block: EditorialBlock): string {
  const collect = (nodes: InlineContent[]): string => nodes.map((n) => n.text ?? "").join("");
  switch (block.type) {
    case "list":
      return block.items.map(collect).join(" ");
    case "table":
      return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
    default:
      return collect(block.content);
  }
}

function isCitationBlock(block: EditorialBlock): boolean {
  return CITATION_RE.test(blockVisibleText(block).trimStart());
}

// ── Leaf iteration (zh + en blocks must have identical structure) ──

function iterBlockLeaves(
  block: EditorialBlock,
  enBlock: EditorialBlock,
): Array<{ leaf: BlockLeaf; zhNode: InlineContent; enNode: InlineContent | undefined }> {
  const out: Array<{ leaf: BlockLeaf; zhNode: InlineContent; enNode: InlineContent | undefined }> = [];
  const zh = block as unknown as { content: InlineContent[]; items: InlineContent[][]; headers: InlineContent[][]; rows: InlineContent[][][] };
  const en = enBlock as unknown as { content: InlineContent[]; items: InlineContent[][]; headers: InlineContent[][]; rows: InlineContent[][][] };
  switch (block.type) {
    case "paragraph":
    case "subheading":
    case "quote":
      zh.content.forEach((n, i) => out.push({ leaf: { nodeType: "content", nodeIndex: i }, zhNode: n, enNode: en.content[i] }));
      break;
    case "list":
      zh.items.forEach((items, itemIndex) =>
        items.forEach((n, nodeIndex) => out.push({ leaf: { nodeType: "list", itemIndex, nodeIndex }, zhNode: n, enNode: en.items[itemIndex]?.[nodeIndex] })),
      );
      break;
    case "table":
      zh.headers.forEach((nodes, colIndex) =>
        nodes.forEach((n, nodeIndex) => out.push({ leaf: { nodeType: "table-header", colIndex, nodeIndex }, zhNode: n, enNode: en.headers[colIndex]?.[nodeIndex] })),
      );
      zh.rows.forEach((row, rowIndex) =>
        row.forEach((nodes, colIndex) =>
          nodes.forEach((n, nodeIndex) => out.push({ leaf: { nodeType: "table-cell", rowIndex, colIndex, nodeIndex }, zhNode: n, enNode: en.rows[rowIndex]?.[colIndex]?.[nodeIndex] })),
        ),
      );
      break;
  }
  return out;
}

// ── Block resolution ──

function getZhBlock(doc: ArticleDocument, ref: BlockRef): EditorialBlock {
  if (ref.component === "introduction") return doc.introduction.blocks[ref.blockIndex];
  if (ref.component === "conclusion") return doc.conclusion.blocks[ref.blockIndex];
  return doc.sections[ref.sectionIndex].blocks[ref.blockIndex];
}

function getEnBlock(doc: ArticleDocument, ref: BlockRef): EditorialBlock {
  if (ref.component === "introduction") return doc.introduction.blocks[ref.blockIndex];
  if (ref.component === "conclusion") return doc.conclusion.blocks[ref.blockIndex];
  return doc.sections[ref.sectionIndex].blocks[ref.blockIndex];
}

function leafNode(block: EditorialBlock, leaf: BlockLeaf): InlineContent {
  switch (leaf.nodeType) {
    case "content": {
      const b = block as unknown as { content: InlineContent[] };
      return b.content[leaf.nodeIndex];
    }
    case "list": {
      const b = block as unknown as { items: InlineContent[][] };
      return b.items[leaf.itemIndex][leaf.nodeIndex];
    }
    case "table-header": {
      const b = block as unknown as { headers: InlineContent[][] };
      return b.headers[leaf.colIndex][leaf.nodeIndex];
    }
    case "table-cell": {
      const b = block as unknown as { rows: InlineContent[][][] };
      return b.rows[leaf.rowIndex][leaf.colIndex][leaf.nodeIndex];
    }
  }
}

// ── Field builder ──

function pushField(
  fields: EditableField[],
  sourceUnitId: string,
  zhText: string,
  enText: string,
  blockType: string,
  structureSignature: string,
  nodeType: string,
  isLink: boolean,
  location: FieldLocation,
): void {
  fields.push({
    fieldId: fieldIdFor(sourceUnitId, location),
    sourceUnitId,
    currentText: zhText,
    sourceText: enText,
    readOnlyContext: { blockType, structureSignature, nodeType, isLink },
    location,
  });
}

function sourceUnitIdForBlockRef(ref: BlockRef): string {
  if (ref.component === "introduction") return `introduction.block.${ref.blockIndex}`;
  if (ref.component === "conclusion") return `conclusion.block.${ref.blockIndex}`;
  return `section.${ref.sectionIndex}.block.${ref.blockIndex}`;
}

/**
 * Build the full editable-field index for a zh-HK document, paired with the
 * English source document for read-only source text. Citation blocks are excluded
 * (they are not editable prose and are not aligned units). Every field's location
 * is the exact ArticleDocument text-node path.
 */
export function buildEditableFieldIndex(zhDoc: ArticleDocument, enDoc: ArticleDocument): FieldIndex {
  const fields: EditableField[] = [];

  const pushMeta = (field: "title" | "metaDescription" | "excerpt", sourceUnitId: string, zh: string, en: string): void => {
    pushField(fields, sourceUnitId, zh, en, "metadata", sourceUnitId, "text", false, { kind: "metadata", field });
  };
  pushMeta("title", "metadata.title", zhDoc.metadata.title, enDoc.metadata.title);
  pushMeta("metaDescription", "metadata.metaDescription", zhDoc.metadata.metaDescription, enDoc.metadata.metaDescription);
  pushMeta("excerpt", "metadata.excerpt", zhDoc.metadata.excerpt, enDoc.metadata.excerpt);

  const introCount = Math.min(zhDoc.introduction.blocks.length, enDoc.introduction.blocks.length);
  for (let i = 0; i < introCount; i++) {
    const ref: BlockRef = { component: "introduction", blockIndex: i };
    addBlockFields(fields, zhDoc, enDoc, ref);
  }

  const secCount = Math.min(zhDoc.sections.length, enDoc.sections.length);
  for (let si = 0; si < secCount; si++) {
    const enHeading = enDoc.sections[si]?.heading ?? "";
    pushField(fields, `section.${si}.heading`, zhDoc.sections[si].heading, enHeading, "heading", `section.${si}.heading`, "text", false, { kind: "section-heading", sectionIndex: si });
    const blockCount = Math.min(zhDoc.sections[si].blocks.length, enDoc.sections[si].blocks.length);
    for (let bi = 0; bi < blockCount; bi++) {
      addBlockFields(fields, zhDoc, enDoc, { component: "section", sectionIndex: si, blockIndex: bi });
    }
  }

  const concCount = Math.min(zhDoc.conclusion.blocks.length, enDoc.conclusion.blocks.length);
  for (let i = 0; i < concCount; i++) {
    addBlockFields(fields, zhDoc, enDoc, { component: "conclusion", blockIndex: i });
  }

  const faqCount = Math.min(zhDoc.visibleFaq.length, enDoc.visibleFaq.length);
  for (let fi = 0; fi < faqCount; fi++) {
    pushField(fields, `faq.${fi}.question`, zhDoc.visibleFaq[fi].question, enDoc.visibleFaq[fi]?.question ?? "", "faq-question", `faq.${fi}.question`, "text", false, { kind: "faq-question", faqIndex: fi });
    // A plain one-paragraph FAQ answer can safely be replaced as one text
    // leaf.  Marked-up answers (links, emphasis, spans or multiple blocks) are
    // protected until they have a structured inline representation; exposing
    // them as one plain field would flatten answerHtml and lose markup.
    if (isPlainFaqAnswerHtml(zhDoc.visibleFaq[fi].answerHtml)) {
      pushField(fields, `faq.${fi}.answer`, zhDoc.visibleFaq[fi].answerText, enDoc.visibleFaq[fi]?.answerText ?? "", "faq-answer", `faq.${fi}.answer`, "text", false, { kind: "faq-answer", faqIndex: fi });
    }
  }

  const byId = new Map<string, EditableField>();
  const byUnit = new Map<string, EditableField[]>();
  for (const f of fields) {
    byId.set(f.fieldId, f);
    const arr = byUnit.get(f.sourceUnitId) ?? [];
    arr.push(f);
    byUnit.set(f.sourceUnitId, arr);
  }
  return { fields, byId, byUnit };
}

function addBlockFields(fields: EditableField[], zhDoc: ArticleDocument, enDoc: ArticleDocument, ref: BlockRef): void {
  const block = getZhBlock(zhDoc, ref);
  const enBlock = getEnBlock(enDoc, ref);
  if (isCitationBlock(block)) return;
  const signature = editorialStructureSignature([block])[0];
  const sourceUnitId = sourceUnitIdForBlockRef(ref);
  for (const { leaf, zhNode, enNode } of iterBlockLeaves(block, enBlock)) {
    const isLink = zhNode.type === "link";
    pushField(
      fields,
      sourceUnitId,
      typeof zhNode.text === "string" ? zhNode.text : "",
      typeof enNode?.text === "string" ? enNode.text : "",
      block.type,
      signature,
      zhNode.type,
      isLink,
      { kind: "block", ref, leaf },
    );
  }
}

// ── Field-value access (get/set by location) ──

export function readFieldValue(doc: ArticleDocument, location: FieldLocation): string {
  switch (location.kind) {
    case "metadata":
      return doc.metadata[location.field];
    case "section-heading":
      return doc.sections[location.sectionIndex].heading;
    case "faq-question":
      return doc.visibleFaq[location.faqIndex].question;
    case "faq-answer":
      return doc.visibleFaq[location.faqIndex].answerText;
    case "block": {
      const block = getZhBlock(doc, location.ref);
      const node = leafNode(block, location.leaf);
      return typeof node.text === "string" ? node.text : "";
    }
  }
}

export function writeFieldValue(doc: ArticleDocument, location: FieldLocation, value: string): void {
  switch (location.kind) {
    case "metadata":
      doc.metadata[location.field] = value;
      return;
    case "section-heading":
      doc.sections[location.sectionIndex].heading = value;
      return;
    case "faq-question":
      doc.visibleFaq[location.faqIndex].question = value;
      return;
    case "faq-answer": {
      const entry = doc.visibleFaq[location.faqIndex];
      if (!isPlainFaqAnswerHtml(entry.answerHtml)) {
        throw new Error(`FAQ ${location.faqIndex} answer contains protected inline markup`);
      }
      entry.answerText = value;
      entry.answerHtml = `<p>${escapeFaqText(value)}</p>`;
      return;
    }
    case "block": {
      const block = getZhBlock(doc, location.ref);
      const node = leafNode(block, location.leaf);
      node.text = value;
      return;
    }
  }
}

function isPlainFaqAnswerHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) return true;
  const match = trimmed.match(/^<p(?:\s[^>]*)?>([\s\S]*?)<\/p>$/i);
  return Boolean(match && !/<\/?[a-z][^>]*>/i.test(match[1]));
}

function escapeFaqText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Apply accepted text edits to a deep clone of the zh document. Only supplied
 * fieldIds are touched; each field is resolved through the server map, must belong
 * to a selected unit, and must not be stale (its current value must still equal the
 * value captured at field generation). Unicode is normalised (NFC) without changing
 * meaning. Returns the new document plus per-edit diagnostics.
 */
export function applyEditableFieldEdits(
  zhDoc: ArticleDocument,
  edits: Array<{ fieldId: string; replacementText: string }>,
  index: FieldIndex,
  selectedUnitIds: ReadonlySet<string>,
): { doc: ArticleDocument; errors: string[]; applied: Array<{ fieldId: string; sourceUnitId: string }> } {
  const errors: string[] = [];
  const applied: Array<{ fieldId: string; sourceUnitId: string }> = [];
  const out = structuredClone(zhDoc) as ArticleDocument;

  for (const edit of edits) {
    const field = index.byId.get(edit.fieldId);
    if (!field) {
      errors.push(`unknown field ${edit.fieldId}`);
      continue;
    }
    if (!selectedUnitIds.has(field.sourceUnitId)) {
      errors.push(`field ${edit.fieldId} belongs to unselected unit ${field.sourceUnitId}`);
      continue;
    }
    // Stale protection: the live value must still equal the value at generation.
    const live = readFieldValue(out, field.location);
    if (live !== field.currentText) {
      errors.push(`stale field ${edit.fieldId} (value changed since generation)`);
      continue;
    }
    const normalized = edit.replacementText.normalize("NFC");
    if (normalized.length === 0) {
      errors.push(`empty replacement for ${edit.fieldId}`);
      continue;
    }
    // A replace decision that returns the current value is not an applied
    // change and must not inflate audit counts.
    if (normalized === live) continue;
    writeFieldValue(out, field.location, normalized);
    applied.push({ fieldId: edit.fieldId, sourceUnitId: field.sourceUnitId });
  }

  return { doc: out, errors, applied };
}
