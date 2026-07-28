// ── Translation DTO: structured editorial-block → AI-bound payload → EditorialBlock[] ──
// Stage 0: serialization, normalization, reconstruction, and contract tests only.
// Not yet integrated into production translation.
//
// URLs are never exposed to the AI.  Link destinations are reconstructed from an
// application-owned link map.
// Number placeholders such as __NUM_0__ are preserved inside text fields.

import { type EditorialBlock, type InlineContent, CTA_CONTENT_RE, validateEditorialBlocks } from "@/lib/blog/article-content";
import { checkBlockNumbersPreserved, checkBlockLinksPreserved } from "./editorial-block-protection";

// ── Types ──

export type TranslationInlineNode =
  | { type: "text"; seq: number; text: string }
  | { type: "strong"; seq: number; text: string }
  | { type: "emphasis"; seq: number; text: string }
  | { type: "link"; seq: number; linkRef: string; text: string };

export type TranslationBlock =
  | { type: "paragraph"; seq: number; nodes: TranslationInlineNode[] }
  | { type: "subheading"; seq: number; nodes: TranslationInlineNode[] }
  | { type: "list"; seq: number; ordered: boolean; items: Array<{ seq: number; nodes: TranslationInlineNode[] }> }
  | { type: "quote"; seq: number; nodes: TranslationInlineNode[] }
  | { type: "table"; seq: number; headers: Array<{ seq: number; nodes: TranslationInlineNode[] }>; rows: Array<{ seq: number; cells: Array<{ seq: number; nodes: TranslationInlineNode[] }> }> };

export interface TranslationComponentPayload {
  componentKind: "introduction" | "section" | "conclusion";
  blocks: TranslationBlock[];
}

export interface TranslationLinkData {
  href: string;
  sourceType?: string;
}

export type TranslationLinkMap = Map<string, TranslationLinkData>;

// ── Serialization ──

export function serializeTranslationPayload(
  protectedBlocks: EditorialBlock[],
  componentKind: TranslationComponentPayload["componentKind"],
): { payload: TranslationComponentPayload; linkMap: TranslationLinkMap } {
  if (protectedBlocks.length === 0) {
    return { payload: { componentKind, blocks: [] }, linkMap: new Map() };
  }

  const linkMap: TranslationLinkMap = new Map();
  let linkCounter = 0;
  const blocks: TranslationBlock[] = [];

  for (let i = 0; i < protectedBlocks.length; i++) {
    const source = protectedBlocks[i];
    const seq = i;

    switch (source.type) {
      case "paragraph":
      case "subheading":
      case "quote": {
        const nodes = serializeInlineNodes(source.content, linkMap, () => `link-${linkCounter++}`);
        blocks.push({ type: source.type, seq, nodes } as TranslationBlock);
        break;
      }
      case "list": {
        const items = source.items.map((item, j) => ({
          seq: j,
          nodes: serializeInlineNodes(item, linkMap, () => `link-${linkCounter++}`),
        }));
        blocks.push({ type: "list", seq, ordered: source.ordered, items });
        break;
      }
      case "table": {
        const headers = source.headers.map((h, j) => ({
          seq: j,
          nodes: serializeInlineNodes(h, linkMap, () => `link-${linkCounter++}`),
        }));
        const rows = source.rows.map((row, j) => ({
          seq: j,
          cells: row.map((cell, k) => ({
            seq: k,
            nodes: serializeInlineNodes(cell, linkMap, () => `link-${linkCounter++}`),
          })),
        }));
        blocks.push({ type: "table", seq, headers, rows });
        break;
      }
    }
  }

  return { payload: { componentKind, blocks }, linkMap };
}

function serializeInlineNodes(
  nodes: InlineContent[],
  linkMap: TranslationLinkMap,
  nextRef: () => string,
): TranslationInlineNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return { type: "text", seq: i, text: node.text };
      case "strong":
        return { type: "strong", seq: i, text: node.text };
      case "emphasis":
        return { type: "emphasis", seq: i, text: node.text };
      case "link": {
        const ref = nextRef();
        linkMap.set(ref, { href: node.href, sourceType: node.sourceType });
        return { type: "link", seq: i, linkRef: ref, text: node.text };
      }
    }
  });
}

// ── Strict JSON extraction ──

export function extractTranslationJson(raw: string): { json: unknown; error?: string } {
  let trimmed = raw.trim();

  // Accept one complete clean JSON code fence
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  // Reject prose before the first structural character ({)
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace > 0) {
    const beforeBrace = trimmed.substring(0, firstBrace).trim();
    if (beforeBrace.length > 0) {
      return { json: null, error: "prose before JSON not allowed" };
    }
  }

  // Reject prose after the final }
  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace >= 0 && lastBrace < trimmed.length - 1) {
    const afterBrace = trimmed.substring(lastBrace + 1).trim();
    if (afterBrace.length > 0) {
      return { json: null, error: "prose after JSON not allowed" };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { json: null, error: `invalid JSON: ${(e as Error).message}` };
  }

  // Confirm top-level is a plain object, not array or primitive
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { json: null, error: "top-level value must be a JSON object" };
  }

  return { json: parsed };
}

// ── Strict normalization and structural validation ──

export function normalizeTranslationPayload(
  raw: string,
  sourcePayload: TranslationComponentPayload,
): { payload: TranslationComponentPayload | null; errors: string[] } {
  const errors: string[] = [];

  // 1. Extract JSON
  const extracted = extractTranslationJson(raw);
  if (extracted.error) {
    errors.push(extracted.error);
    return { payload: null, errors };
  }

  const obj = extracted.json as Record<string, unknown>;

  // 2. Top-level keys
  const allowedTopKeys = ["componentKind", "blocks"];
  const topKeys = Object.keys(obj);
  for (const key of topKeys) {
    if (!allowedTopKeys.includes(key)) {
      errors.push(`unexpected top-level key: "${key}"`);
    }
  }

  // 3. componentKind
  if (obj.componentKind !== sourcePayload.componentKind) {
    errors.push(`componentKind mismatch: expected "${sourcePayload.componentKind}", got "${String(obj.componentKind)}"`);
  }

  // 4. blocks array
  if (!Array.isArray(obj.blocks)) {
    errors.push("blocks must be an array");
    return { payload: null, errors };
  }

  const rawBlocks = obj.blocks as unknown[];
  if (rawBlocks.length !== sourcePayload.blocks.length) {
    errors.push(`block count mismatch: expected ${sourcePayload.blocks.length}, got ${rawBlocks.length}`);
    if (rawBlocks.length !== sourcePayload.blocks.length) {
      // Can still validate what we can
    }
  }

  const blocks: TranslationBlock[] = [];

  for (let i = 0; i < sourcePayload.blocks.length && i < rawBlocks.length; i++) {
    const sourceBlock = sourcePayload.blocks[i];
    const rawBlock = rawBlocks[i] as Record<string, unknown>;
    const idx = `block ${i}`;

    if (typeof rawBlock !== "object" || rawBlock === null) {
      errors.push(`${idx}: expected object`);
      continue;
    }

    // Check for unexpected keys
    const allowedBlockKeys = ["type", "seq", "nodes", "ordered", "items", "headers", "rows"];
    for (const key of Object.keys(rawBlock)) {
      if (!allowedBlockKeys.includes(key)) {
        errors.push(`${idx}: unexpected key "${key}"`);
      }
    }

    // seq
    if (rawBlock.seq !== sourceBlock.seq) {
      errors.push(`${idx}: seq mismatch, expected ${sourceBlock.seq}, got ${String(rawBlock.seq)}`);
    }

    // type
    if (rawBlock.type !== sourceBlock.type) {
      errors.push(`${idx}: type mismatch, expected "${sourceBlock.type}", got "${String(rawBlock.type)}"`);
      continue;
    }

    // Validate based on block type
    switch (sourceBlock.type) {
      case "paragraph":
      case "subheading":
      case "quote": {
        const nodes = validateInlineNodes(rawBlock.nodes as unknown[], sourceBlock, idx, errors);
        if (nodes) {
          blocks.push({ type: sourceBlock.type, seq: sourceBlock.seq, nodes } as TranslationBlock);
        }
        break;
      }
      case "list": {
        if (rawBlock.ordered !== sourceBlock.ordered) {
          errors.push(`${idx}: ordered flag mismatch`);
        }
        if (!Array.isArray(rawBlock.items)) {
          errors.push(`${idx}: missing items array`);
        } else {
          const items = validateListItems(rawBlock.items as unknown[], sourceBlock, idx, errors);
          if (items) {
            blocks.push({ type: "list", seq: sourceBlock.seq, ordered: sourceBlock.ordered, items });
          }
        }
        break;
      }
      case "table": {
        const table = validateTable(rawBlock as Record<string, unknown>, sourceBlock, idx, errors);
        if (table) blocks.push(table);
        break;
      }
    }
  }

  return { payload: errors.length === 0 ? { componentKind: sourcePayload.componentKind, blocks } : null, errors };
}

function getSourceInlineCount(source: TranslationBlock): number {
  switch (source.type) {
    case "paragraph":
    case "subheading":
    case "quote":
      return source.nodes.length;
    case "list":
      return source.items.length;
    case "table":
      return source.headers.length + source.rows.reduce((s, r) => s + r.cells.length, 0);
  }
}

function validateInlineNodes(
  rawNodes: unknown[],
  source: TranslationBlock,
  prefix: string,
  errors: string[],
): TranslationInlineNode[] | null {
  const allowedNodeKeys = ["type", "seq", "text", "linkRef"];
  const sourceNodes = source.type === "paragraph" || source.type === "subheading" || source.type === "quote"
    ? source.nodes
    : [];

  if (!Array.isArray(rawNodes)) {
    errors.push(`${prefix}: nodes must be an array`);
    return null;
  }

  if (rawNodes.length !== sourceNodes.length) {
    errors.push(`${prefix}: inline node count mismatch, expected ${sourceNodes.length}, got ${rawNodes.length}`);
    return null;
  }

  if (sourceNodes.length === 0) return [];

  const result: TranslationInlineNode[] = [];

  for (let j = 0; j < sourceNodes.length; j++) {
    const expected = sourceNodes[j];
    const raw = rawNodes[j] as Record<string, unknown>;
    const nid = `${prefix} inline node ${j}`;

    if (typeof raw !== "object" || raw === null) {
      errors.push(`${nid}: expected object`);
      return null;
    }

    // Check for unexpected keys
    for (const key of Object.keys(raw)) {
      if (!allowedNodeKeys.includes(key)) {
        errors.push(`${nid}: unexpected key "${key}"`);
      }
    }

    if (raw.seq !== expected.seq) {
      errors.push(`${nid}: seq mismatch, expected ${expected.seq}, got ${String(raw.seq)}`);
      return null;
    }

    if (raw.type !== expected.type) {
      errors.push(`${nid}: type mismatch, expected "${expected.type}", got "${String(raw.type)}"`);
      return null;
    }

    const text = typeof raw.text === "string" ? raw.text.trim() : "";

    // Validate text content
    validateTextContent(text, nid, errors);

    if (!text) {
      errors.push(`${nid}: empty text`);
      return null;
    }

    if (expected.type === "link") {
      const ref = raw.linkRef;
      if (typeof ref !== "string" || !ref) {
        errors.push(`${nid}: missing or invalid linkRef`);
        return null;
      }
      result.push({ type: "link", seq: expected.seq, linkRef: ref, text });
    } else {
      result.push({ type: expected.type as "text" | "strong" | "emphasis", seq: expected.seq, text });
    }
  }

  return result;
}

function validateListItems(
  rawItems: unknown[],
  source: TranslationBlock,
  prefix: string,
  errors: string[],
): Array<{ seq: number; nodes: TranslationInlineNode[] }> | null {
  const sourceItems = source.type === "list" ? source.items : [];
  if (rawItems.length !== sourceItems.length) {
    errors.push(`${prefix}: list item count mismatch, expected ${sourceItems.length}, got ${rawItems.length}`);
    return null;
  }

  const result: Array<{ seq: number; nodes: TranslationInlineNode[] }> = [];

  for (let j = 0; j < sourceItems.length; j++) {
    const rawItem = rawItems[j] as Record<string, unknown>;
    const iid = `${prefix} list item ${j}`;

    if (typeof rawItem !== "object" || rawItem === null) {
      errors.push(`${iid}: expected object`);
      return null;
    }

    if (rawItem.seq !== j) {
      errors.push(`${iid}: seq mismatch, expected ${j}, got ${String(rawItem.seq)}`);
    }

    if (!Array.isArray(rawItem.nodes)) {
      errors.push(`${iid}: missing nodes array`);
      return null;
    }

    if (rawItem.nodes.length !== sourceItems[j].nodes.length) {
      errors.push(`${iid}: inline node count mismatch, expected ${sourceItems[j].nodes.length}, got ${rawItem.nodes.length}`);
      return null;
    }

    const nodes = validateInlineNodesInItem(rawItem.nodes as unknown[], sourceItems[j].nodes, iid, errors);
    if (!nodes) return null;
    result.push({ seq: j, nodes });
  }

  return result;
}

function validateInlineNodesInItem(
  rawNodes: unknown[],
  sourceNodes: TranslationInlineNode[],
  prefix: string,
  errors: string[],
): TranslationInlineNode[] | null {
  const allowedNodeKeys = ["type", "seq", "text", "linkRef"];

  if (rawNodes.length !== sourceNodes.length) {
    errors.push(`${prefix}: inline node count mismatch`);
    return null;
  }

  const result: TranslationInlineNode[] = [];

  for (let j = 0; j < sourceNodes.length; j++) {
    const expected = sourceNodes[j];
    const raw = rawNodes[j] as Record<string, unknown>;
    const nid = `${prefix} node ${j}`;

    if (typeof raw !== "object" || raw === null) {
      errors.push(`${nid}: expected object`);
      return null;
    }

    for (const key of Object.keys(raw)) {
      if (!allowedNodeKeys.includes(key)) {
        errors.push(`${nid}: unexpected key "${key}"`);
      }
    }

    if (raw.seq !== expected.seq) {
      errors.push(`${nid}: seq mismatch`);
      return null;
    }

    if (raw.type !== expected.type) {
      errors.push(`${nid}: type mismatch`);
      return null;
    }

    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    validateTextContent(text, nid, errors);
    if (!text) {
      errors.push(`${nid}: empty text`);
      return null;
    }

    if (expected.type === "link") {
      const ref = raw.linkRef;
      if (typeof ref !== "string" || !ref) {
        errors.push(`${nid}: missing or invalid linkRef`);
        return null;
      }
      result.push({ type: "link", seq: expected.seq, linkRef: ref, text });
    } else {
      result.push({ type: expected.type as "text" | "strong" | "emphasis", seq: expected.seq, text });
    }
  }

  return result;
}

function validateTable(
  raw: Record<string, unknown>,
  source: TranslationBlock,
  prefix: string,
  errors: string[],
): TranslationBlock | null {
  const sourceTable = source.type === "table" ? source : null;
  if (!sourceTable) return null;

  const sHeaders = sourceTable.headers;
  const sRows = sourceTable.rows;

  if (!Array.isArray(raw.headers)) {
    errors.push(`${prefix}: missing headers array`);
    return null;
  }
  if (!Array.isArray(raw.rows)) {
    errors.push(`${prefix}: missing rows array`);
    return null;
  }

  if (raw.headers.length !== sHeaders.length) {
    errors.push(`${prefix}: header count mismatch, expected ${sHeaders.length}, got ${raw.headers.length}`);
    return null;
  }
  if (raw.rows.length !== sRows.length) {
    errors.push(`${prefix}: row count mismatch, expected ${sRows.length}, got ${raw.rows.length}`);
    return null;
  }

  const headers: Array<{ seq: number; nodes: TranslationInlineNode[] }> = [];
  for (let j = 0; j < raw.headers.length; j++) {
    const rh = raw.headers[j] as Record<string, unknown>;
    if (rh.seq !== j) errors.push(`${prefix} header ${j}: seq mismatch`);
    const nodes = validateInlineNodesInItem(rh.nodes as unknown[], sHeaders[j].nodes, `${prefix} header ${j}`, errors);
    if (!nodes) return null;
    headers.push({ seq: j, nodes });
  }

  const rows: Array<{ seq: number; cells: Array<{ seq: number; nodes: TranslationInlineNode[] }> }> = [];
  for (let j = 0; j < raw.rows.length; j++) {
    const rr = raw.rows[j] as Record<string, unknown>;
    if (!Array.isArray(rr.cells)) {
      errors.push(`${prefix} row ${j}: missing cells array`);
      return null;
    }
    if (rr.cells.length !== sRows[j].cells.length) {
      errors.push(`${prefix} row ${j}: cell count mismatch, expected ${sRows[j].cells.length}, got ${rr.cells.length}`);
      return null;
    }

    const cells: Array<{ seq: number; nodes: TranslationInlineNode[] }> = [];
    for (let k = 0; k < rr.cells.length; k++) {
      const rc = rr.cells[k] as Record<string, unknown>;
      if (rc.seq !== k) errors.push(`${prefix} row ${j} cell ${k}: seq mismatch`);
      const nodes = validateInlineNodesInItem(rc.nodes as unknown[], sRows[j].cells[k].nodes, `${prefix} row ${j} cell ${k}`, errors);
      if (!nodes) return null;
      cells.push({ seq: k, nodes });
    }
    rows.push({ seq: j, cells });
  }

  return { type: "table", seq: sourceTable.seq, headers, rows };
}

// ── Text-value validation ──

const WP_COMMENT_RE = /<!--[\s\S]*?-->/;
const HTML_TAG_RE = /<[a-z][\s\S]*?>/i;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+/m;
const FENCED_CODE_RE = /^```/m;
const MARKDOWN_LIST_PREFIX_RE = /^[\s]*[-*+]\s+/m;
const B2I_SIGNUP_RE = /app\.b2ihub\.com\/signup/i;

function validateTextContent(text: string, context: string, errors: string[]): void {
  if (WP_COMMENT_RE.test(text)) {
    errors.push(`${context}: contains WordPress comment`);
  }
  if (HTML_TAG_RE.test(text)) {
    errors.push(`${context}: contains raw HTML tag`);
  }
  if (MARKDOWN_LINK_RE.test(text)) {
    errors.push(`${context}: contains Markdown link`);
  }
  if (MARKDOWN_HEADING_RE.test(text)) {
    errors.push(`${context}: contains Markdown heading`);
  }
  if (FENCED_CODE_RE.test(text)) {
    errors.push(`${context}: contains fenced code`);
  }
  if (MARKDOWN_LIST_PREFIX_RE.test(text)) {
    errors.push(`${context}: contains Markdown list prefix`);
  }
  if (B2I_SIGNUP_RE.test(text)) {
    errors.push(`${context}: contains B2I signup URL`);
  }
}

// ── Conclusion-specific CTA check ──

export function validateConclusionPolicy(blocks: TranslationBlock[], errors: string[]): void {
  const text = extractAllDtoText(blocks);
  if (CTA_CONTENT_RE.test(text)) {
    errors.push("conclusion contains prohibited CTA content");
  }
}

function extractAllDtoText(blocks: TranslationBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "subheading":
      case "quote":
        for (const node of block.nodes) parts.push(node.text);
        break;
      case "list":
        for (const item of block.items) {
          for (const node of item.nodes) parts.push(node.text);
        }
        break;
      case "table":
        for (const h of block.headers) {
          for (const node of h.nodes) parts.push(node.text);
        }
        for (const row of block.rows) {
          for (const cell of row.cells) {
            for (const node of cell.nodes) parts.push(node.text);
          }
        }
        break;
    }
  }
  return parts.join(" ");
}

// ── Reconstruction ──

export function reconstructEditorialBlocks(
  normalizedPayload: TranslationComponentPayload,
  sourceBlocks: EditorialBlock[],
  linkMap: TranslationLinkMap,
): { blocks: EditorialBlock[]; errors: string[] } {
  const errors: string[] = [];
  const blocks: EditorialBlock[] = [];

  if (normalizedPayload.blocks.length !== sourceBlocks.length) {
    errors.push("block count mismatch during reconstruction");
    return { blocks, errors };
  }

  for (let i = 0; i < sourceBlocks.length; i++) {
    const source = sourceBlocks[i];
    const dto = normalizedPayload.blocks[i];
    const id = source.id;

    switch (source.type) {
      case "paragraph":
      case "subheading":
      case "quote": {
        if (dto.type !== source.type) {
          errors.push(`block ${i} type mismatch during reconstruction`);
          continue;
        }
        const content = reconstructInlineNodes(dto.nodes, source.content, linkMap, `block ${i}`, errors);
        if (!content) continue;
        if (source.type === "subheading") {
          blocks.push({ id, type: "subheading", level: source.level, content } as EditorialBlock);
        } else {
          blocks.push({ id, type: source.type, content } as EditorialBlock);
        }
        break;
      }
      case "list": {
        if (dto.type !== "list") {
          errors.push(`block ${i} type mismatch during reconstruction`);
          continue;
        }
        const items = reconstructListItems(dto.items, source.items, linkMap, `block ${i}`, errors);
        if (!items) continue;
        blocks.push({ id, type: "list", ordered: source.ordered, items } as EditorialBlock);
        break;
      }
      case "table": {
        if (dto.type !== "table") {
          errors.push(`block ${i} type mismatch during reconstruction`);
          continue;
        }
        const table = reconstructTable(dto, source, linkMap, `block ${i}`, errors);
        if (!table) continue;
        blocks.push({ id, type: "table", ...table } as EditorialBlock);
        break;
      }
    }
  }

  return { blocks, errors };
}

function reconstructInlineNodes(
  dtoNodes: TranslationInlineNode[],
  sourceContent: InlineContent[],
  linkMap: TranslationLinkMap,
  context: string,
  errors: string[],
): InlineContent[] | null {
  if (dtoNodes.length !== sourceContent.length) {
    errors.push(`${context}: inline node count mismatch during reconstruction`);
    return null;
  }

  const result: InlineContent[] = [];

  for (let j = 0; j < sourceContent.length; j++) {
    const sourceNode = sourceContent[j];
    const dtoNode = dtoNodes[j];

    if (dtoNode.type !== sourceNode.type) {
      errors.push(`${context} inline node ${j}: type mismatch during reconstruction`);
      return null;
    }

    switch (sourceNode.type) {
      case "text":
        result.push({ type: "text", text: dtoNode.text });
        break;
      case "strong":
        result.push({ type: "strong", text: dtoNode.text });
        break;
      case "emphasis":
        result.push({ type: "emphasis", text: dtoNode.text });
        break;
      case "link": {
        const ref = dtoNode.type === "link" ? dtoNode.linkRef : null;
        const linkData = ref ? linkMap.get(ref) : undefined;
        if (!linkData) {
          errors.push(`${context} inline node ${j}: missing linkData for ref "${ref}"`);
          return null;
        }
        result.push({ type: "link", text: dtoNode.text, href: linkData.href, sourceType: linkData.sourceType as "editorial-external" | "internal" | undefined });
        break;
      }
    }
  }

  return result;
}

function reconstructListItems(
  dtoItems: Array<{ seq: number; nodes: TranslationInlineNode[] }>,
  sourceItems: InlineContent[][],
  linkMap: TranslationLinkMap,
  context: string,
  errors: string[],
): InlineContent[][] | null {
  if (dtoItems.length !== sourceItems.length) {
    errors.push(`${context}: list item count mismatch during reconstruction`);
    return null;
  }

  const items: InlineContent[][] = [];
  for (let j = 0; j < sourceItems.length; j++) {
    const nodes = reconstructInlineNodes(dtoItems[j].nodes, sourceItems[j], linkMap, `${context} list item ${j}`, errors);
    if (!nodes) return null;
    items.push(nodes);
  }
  return items;
}

function reconstructTable(
  dto: TranslationBlock,
  source: EditorialBlock,
  linkMap: TranslationLinkMap,
  context: string,
  errors: string[],
): { headers: InlineContent[][]; rows: InlineContent[][][] } | null {
  if (dto.type !== "table" || source.type !== "table") return null;

  if (dto.headers.length !== source.headers.length) {
    errors.push(`${context}: header count mismatch during reconstruction`);
    return null;
  }
  if (dto.rows.length !== source.rows.length) {
    errors.push(`${context}: row count mismatch during reconstruction`);
    return null;
  }

  const headers: InlineContent[][] = [];
  for (let j = 0; j < dto.headers.length; j++) {
    const nodes = reconstructInlineNodes(dto.headers[j].nodes, source.headers[j], linkMap, `${context} header ${j}`, errors);
    if (!nodes) return null;
    headers.push(nodes);
  }

  const rows: InlineContent[][][] = [];
  for (let j = 0; j < dto.rows.length; j++) {
    const cells: InlineContent[][] = [];
    if (dto.rows[j].cells.length !== source.rows[j].length) {
      errors.push(`${context} row ${j}: cell count mismatch during reconstruction`);
      return null;
    }
    for (let k = 0; k < dto.rows[j].cells.length; k++) {
      const nodes = reconstructInlineNodes(dto.rows[j].cells[k].nodes, source.rows[j][k], linkMap, `${context} row ${j} cell ${k}`, errors);
      if (!nodes) return null;
      cells.push(nodes);
    }
    rows.push(cells);
  }

  return { headers, rows };
}

// ── Post-reconstruction validation ──
// Compares restored source blocks against restored reconstructed blocks.
// Intended for use AFTER number restoration (protected == restored).

export interface ReconstructedValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateReconstructedTranslation(
  sourceBlocks: EditorialBlock[],
  reconstructedBlocks: EditorialBlock[],
): ReconstructedValidationResult {
  const errors: string[] = [];

  const validationErrors = validateEditorialBlocks(reconstructedBlocks);
  errors.push(...validationErrors);

  const numCheck = checkBlockNumbersPreserved(sourceBlocks, reconstructedBlocks);
  if (numCheck.lost.length > 0) errors.push(`numbers lost: ${numCheck.lost.join(", ")}`);
  if (numCheck.extras.length > 0) errors.push(`numbers extra: ${numCheck.extras.join(", ")}`);

  const linksLost = checkBlockLinksPreserved(sourceBlocks, reconstructedBlocks);
  if (linksLost.length > 0) errors.push(`links lost: ${linksLost.join(", ")}`);

  return { valid: errors.length === 0, errors };
}
