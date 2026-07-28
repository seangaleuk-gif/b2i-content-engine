// ── Structured Editorial Content ──
// H2 headings remain owned by ArticleSection.heading and are NOT
// represented in EditorialBlock.  EditorialBlock covers only inline
// content inside sections: paragraphs, H3 subheadings, lists, quotes,
// and tables.

// ── Structured internal model ──

export type InlineContent =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "emphasis"; text: string }
  | {
      type: "link";
      text: string;
      href: string;
      sourceType?: "editorial-external" | "internal";
    };

export type EditorialBlock =
  | {
      id: string;
      type: "paragraph";
      content: InlineContent[];
    }
  | {
      id: string;
      type: "subheading";
      level: 3;
      content: InlineContent[];
    }
  | {
      id: string;
      type: "list";
      ordered: boolean;
      items: InlineContent[][];
    }
  | {
      id: string;
      type: "quote";
      content: InlineContent[];
    }
  | {
      id: string;
      type: "table";
      headers: InlineContent[][];
      rows: InlineContent[][][];
    };

// ── AI-facing simple payload model ──

export type AiEditorialBlock =
  | { type: "paragraph"; text: string }
  | { type: "subheading"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface AiEditorialPayload {
  blocks: AiEditorialBlock[];
}

export interface NormalizationOptions {
  /** When true, reject blocks containing CTA/registration content. Use only for conclusion generation. */
  disallowCtaContent?: boolean;
}

// ── Helpers ──

const ALLOWED_BLOCK_TYPES = new Set([
  "paragraph",
  "subheading",
  "list",
  "quote",
  "table",
]);

const WP_COMMENT_RE = /<!--[\s\S]*?-->/;
const HTML_TAG_RE = /<[a-z][\s\S]*?>/i;
const UNSAFE_LINK_RE = /^(?:javascript|data|file|vbscript):/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeLink(href: string): boolean {
  if (UNSAFE_LINK_RE.test(href)) return false;
  if (href.startsWith("/")) return true;
  if (/^https?:\/\//i.test(href)) return true;
  return false;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textToInlineContent(text: string): InlineContent[] {
  return [{ type: "text", text }];
}

function idFor(componentId: string, blockIndex: number, blockType: string): string {
  return `${componentId}-${blockType}-${blockIndex}`;
}

export const CTA_CONTENT_RE = /create your free profile|ready to grow your brand|app\.b2ihub\.com\/signup/i;

function checkForDisallowedContent(text: string, errors: string[], context: string, opts?: NormalizationOptions): void {
  if (WP_COMMENT_RE.test(text)) {
    errors.push(`${context}: contains WordPress block comment syntax`);
  }
  if (HTML_TAG_RE.test(text)) {
    errors.push(`${context}: contains raw HTML tags`);
  }
  if (opts?.disallowCtaContent && CTA_CONTENT_RE.test(text)) {
    errors.push(`${context}: contains prohibited CTA content`);
  }
}

// ── Normalizer ──

export function normalizeAiEditorialPayload(
  input: unknown,
  componentId: string,
  opts?: NormalizationOptions,
): {
  blocks: EditorialBlock[];
  errors: string[];
} {
  const errors: string[] = [];
  let rawBlocks: unknown[];

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.blocks)) {
      rawBlocks = obj.blocks;
    } else {
      errors.push("AI payload must contain a 'blocks' array");
      return { blocks: [], errors };
    }
  } else if (Array.isArray(input)) {
    rawBlocks = input;
  } else {
    errors.push("AI payload must be an object with 'blocks' or a direct array");
    return { blocks: [], errors };
  }

  const blocks: EditorialBlock[] = [];

  for (let i = 0; i < rawBlocks.length; i++) {
    const raw = rawBlocks[i];
    if (!raw || typeof raw !== "object") {
      errors.push(`Block ${i}: expected an object, got ${typeof raw}`);
      continue;
    }
    const rb = raw as Record<string, unknown>;
    const blockType = rb.type;
    if (typeof blockType !== "string" || !ALLOWED_BLOCK_TYPES.has(blockType)) {
      errors.push(`Block ${i}: unknown or missing block type "${String(blockType)}"`);
      continue;
    }

    const id = idFor(componentId, i, blockType);

    switch (blockType) {
      case "paragraph": {
        const text = typeof rb.text === "string" ? normalizeWhitespace(rb.text) : "";
        if (!text) {
          errors.push(`Block ${i}: paragraph has empty text`);
          continue;
        }
        checkForDisallowedContent(text, errors, `Block ${i} paragraph`, opts);
        blocks.push({ id, type: "paragraph", content: textToInlineContent(text) });
        break;
      }
      case "subheading": {
        const text = typeof rb.text === "string" ? normalizeWhitespace(rb.text) : "";
        if (!text) {
          errors.push(`Block ${i}: subheading has empty text`);
          continue;
        }
        if (rb.level === 2 || rb.level === "2") {
          errors.push(`Block ${i}: subheading requests disallowed level 2`);
          continue;
        }
        checkForDisallowedContent(text, errors, `Block ${i} subheading`, opts);
        blocks.push({ id, type: "subheading", level: 3, content: textToInlineContent(text) });
        break;
      }
      case "list": {
        const ordered = rb.ordered === true;
        const itemsRaw = Array.isArray(rb.items) ? rb.items : [];
        if (itemsRaw.length === 0) {
          errors.push(`Block ${i}: list has no items`);
          continue;
        }
        const items: InlineContent[][] = [];
        for (let j = 0; j < itemsRaw.length; j++) {
          const itemText = typeof itemsRaw[j] === "string" ? normalizeWhitespace(itemsRaw[j]) : "";
          if (!itemText) {
            errors.push(`Block ${i}: list item ${j} is empty`);
            continue;
          }
          checkForDisallowedContent(itemText, errors, `Block ${i} list item ${j}`, opts);
          items.push(textToInlineContent(itemText));
        }
        if (items.length === 0) {
          errors.push(`Block ${i}: list has no valid items after filtering`);
          continue;
        }
        blocks.push({ id, type: "list", ordered, items });
        break;
      }
      case "quote": {
        const text = typeof rb.text === "string" ? normalizeWhitespace(rb.text) : "";
        if (!text) {
          errors.push(`Block ${i}: quote has empty text`);
          continue;
        }
        checkForDisallowedContent(text, errors, `Block ${i} quote`, opts);
        blocks.push({ id, type: "quote", content: textToInlineContent(text) });
        break;
      }
      case "table": {
        const headers = Array.isArray(rb.headers) ? rb.headers : [];
        const rows = Array.isArray(rb.rows) ? rb.rows : [];
        if (headers.length === 0) {
          errors.push(`Block ${i}: table has no headers`);
          continue;
        }
        if (rows.length === 0) {
          errors.push(`Block ${i}: table has no rows`);
          continue;
        }
        const headerCols = headers.length;
        const parsedHeaders: InlineContent[][] = [];
        for (let j = 0; j < headers.length; j++) {
          const h = typeof headers[j] === "string" ? normalizeWhitespace(headers[j]) : "";
          if (!h) {
            errors.push(`Block ${i}: table header ${j} is empty`);
            continue;
          }
          checkForDisallowedContent(h, errors, `Block ${i} table header ${j}`, opts);
          parsedHeaders.push(textToInlineContent(h));
        }
        if (parsedHeaders.length === 0) {
          errors.push(`Block ${i}: table has no valid headers after filtering`);
          continue;
        }
        const parsedRows: InlineContent[][][] = [];
        for (let j = 0; j < rows.length; j++) {
          const row = Array.isArray(rows[j]) ? rows[j] : [];
          if (row.length !== headerCols) {
            errors.push(`Block ${i}: table row ${j} has ${row.length} columns, expected ${headerCols}`);
            continue;
          }
          const parsedRow: InlineContent[][] = [];
          for (let k = 0; k < row.length; k++) {
            const cell = typeof row[k] === "string" ? normalizeWhitespace(row[k]) : "";
            if (!cell) {
              errors.push(`Block ${i}: table row ${j} cell ${k} is empty`);
              continue;
            }
            checkForDisallowedContent(cell, errors, `Block ${i} table row ${j} cell ${k}`, opts);
            parsedRow.push(textToInlineContent(cell));
          }
          if (parsedRow.length === headerCols) {
            parsedRows.push(parsedRow);
          }
        }
        if (parsedRows.length === 0) {
          errors.push(`Block ${i}: table has no valid rows after filtering`);
          continue;
        }
        blocks.push({
          id,
          type: "table",
          headers: parsedHeaders,
          rows: parsedRows,
        });
        break;
      }
    }
  }

  return { blocks, errors };
}

// ── Canonical renderer ──

function renderInlineContent(content: InlineContent[]): string {
  return content
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.text);
        case "strong":
          return `<strong>${escapeHtml(node.text)}</strong>`;
        case "emphasis":
          return `<em>${escapeHtml(node.text)}</em>`;
        case "link": {
          if (!isSafeLink(node.href)) {
            return escapeHtml(node.text);
          }
          return `<a href="${escapeHtml(node.href)}">${escapeHtml(node.text)}</a>`;
        }
      }
    })
    .join("");
}

export function renderEditorialBlocksToWordPress(blocks: EditorialBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": {
        const inner = renderInlineContent(block.content);
        parts.push(`<!-- wp:paragraph --><p>${inner}</p><!-- /wp:paragraph -->`);
        break;
      }
      case "subheading": {
        const inner = renderInlineContent(block.content);
        parts.push(`<!-- wp:heading {"level":3} --><h3>${inner}</h3><!-- /wp:heading -->`);
        break;
      }
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items
          .map((item) => `  <li>${renderInlineContent(item)}</li>`)
          .join("\n");
        parts.push(
          `<!-- wp:list {"ordered":${block.ordered}} --><${tag}>\n${items}\n</${tag}><!-- /wp:list -->`,
        );
        break;
      }
      case "quote": {
        const inner = renderInlineContent(block.content);
        parts.push(`<!-- wp:quote --><blockquote><p>${inner}</p></blockquote><!-- /wp:quote -->`);
        break;
      }
      case "table": {
        const headerCells = block.headers
          .map((h) => `      <th>${renderInlineContent(h)}</th>`)
          .join("\n");
        const headerRow = `    <tr>\n${headerCells}\n    </tr>`;
        const bodyRows = block.rows
          .map(
            (row) =>
              `    <tr>\n${row
                .map((cell) => `      <td>${renderInlineContent(cell)}</td>`)
                .join("\n")}\n    </tr>`,
          )
          .join("\n");
        parts.push(
          `<!-- wp:table --><figure class="wp-block-table"><table>\n  <thead>\n${headerRow}\n  </thead>\n  <tbody>\n${bodyRows}\n  </tbody>\n</table></figure><!-- /wp:table -->`,
        );
        break;
      }
    }
  }

  return parts.join("\n\n");
}

// ── Utilities ──

export function validateEditorialBlocks(blocks: EditorialBlock[]): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Unique IDs
    if (seenIds.has(block.id)) {
      errors.push(`Block ${i}: duplicate ID "${block.id}"`);
    }
    seenIds.add(block.id);

    // Common checks
    if (!block || typeof block !== "object") {
      errors.push(`Block ${i}: not an object`);
      continue;
    }

    const unknownKeys = Object.keys(block).filter(
      (k) => !["id", "type", "content", "level", "ordered", "items", "headers", "rows"].includes(k),
    );
    if (unknownKeys.length > 0) {
      errors.push(`Block ${i}: unknown keys ${unknownKeys.join(", ")}`);
    }

    switch (block.type) {
      case "paragraph":
      case "quote": {
        if (!Array.isArray((block as any).content)) {
          errors.push(`Block ${i}: ${block.type} missing content array`);
          break;
        }
        const content = (block as any).content as InlineContent[];
        if (content.length === 0) {
          errors.push(`Block ${i}: ${block.type} has no content`);
          break;
        }
        // Check for unsafe links
        for (const node of content) {
          if (node.type === "link" && !isSafeLink(node.href)) {
            errors.push(`Block ${i}: unsafe link "${node.href}"`);
          }
        }
        // Check for HTML / WP comments
        const pt = extractPlainTextFromEditorialBlocks([block]);
        if (WP_COMMENT_RE.test(pt)) {
          errors.push(`Block ${i}: contains WordPress comment syntax`);
        }
        if (HTML_TAG_RE.test(pt)) {
          errors.push(`Block ${i}: contains raw HTML tags`);
        }
        break;
      }
      case "subheading": {
        const sb = block as any;
        if (sb.level !== 3) {
          errors.push(`Block ${i}: subheading has level ${sb.level}, expected 3`);
        }
        if (!Array.isArray(sb.content)) {
          errors.push(`Block ${i}: subheading missing content array`);
          break;
        }
        if (sb.content.length === 0) {
          errors.push(`Block ${i}: subheading has no content`);
          break;
        }
        for (const node of sb.content as InlineContent[]) {
          if (node.type === "link" && !isSafeLink(node.href)) {
            errors.push(`Block ${i}: unsafe link "${node.href}"`);
          }
        }
        const pt = extractPlainTextFromEditorialBlocks([block]);
        if (WP_COMMENT_RE.test(pt)) {
          errors.push(`Block ${i}: contains WordPress comment syntax`);
        }
        if (HTML_TAG_RE.test(pt)) {
          errors.push(`Block ${i}: contains raw HTML tags`);
        }
        break;
      }
      case "list": {
        const list = block as any;
        if (!Array.isArray(list.items)) {
          errors.push(`Block ${i}: list missing items array`);
          break;
        }
        if (list.items.length === 0) {
          errors.push(`Block ${i}: list has no items`);
          break;
        }
        for (let j = 0; j < list.items.length; j++) {
          const item = list.items[j] as InlineContent[];
          if (!Array.isArray(item) || item.length === 0) {
            errors.push(`Block ${i}: list item ${j} has no content`);
          }
        }
        for (const item of list.items as InlineContent[][]) {
          for (const node of item) {
            if (node.type === "link" && !isSafeLink(node.href)) {
              errors.push(`Block ${i}: unsafe link "${node.href}"`);
            }
          }
        }
        const pt = extractPlainTextFromEditorialBlocks([block]);
        if (WP_COMMENT_RE.test(pt)) {
          errors.push(`Block ${i}: contains WordPress comment syntax`);
        }
        if (HTML_TAG_RE.test(pt)) {
          errors.push(`Block ${i}: contains raw HTML tags`);
        }
        break;
      }
      case "table": {
        const table = block as any;
        if (!Array.isArray(table.headers) || table.headers.length === 0) {
          errors.push(`Block ${i}: table has no headers`);
          break;
        }
        if (!Array.isArray(table.rows) || table.rows.length === 0) {
          errors.push(`Block ${i}: table has no rows`);
          break;
        }
        const colCount = table.headers.length;
        for (let j = 0; j < table.headers.length; j++) {
          const h = table.headers[j] as InlineContent[];
          if (!Array.isArray(h) || h.length === 0) {
            errors.push(`Block ${i}: table header ${j} has no content`);
          }
        }
        for (let j = 0; j < table.rows.length; j++) {
          const row = table.rows[j] as InlineContent[][];
          if (!Array.isArray(row)) {
            errors.push(`Block ${i}: table row ${j} is not an array`);
            continue;
          }
          if (row.length !== colCount) {
            errors.push(
              `Block ${i}: table row ${j} has ${row.length} columns, expected ${colCount}`,
            );
          }
          for (let k = 0; k < row.length; k++) {
            const cell = row[k] as InlineContent[];
            if (!Array.isArray(cell) || cell.length === 0) {
              errors.push(`Block ${i}: table row ${j} cell ${k} has no content`);
            }
          }
        }
        // Check all content for safe links
        const allCells = [...table.headers, ...table.rows.flat()] as InlineContent[][];
        for (const cell of allCells) {
          for (const node of cell) {
            if (node.type === "link" && !isSafeLink(node.href)) {
              errors.push(`Block ${i}: unsafe link "${node.href}"`);
            }
          }
        }
        const pt = extractPlainTextFromEditorialBlocks([block]);
        if (WP_COMMENT_RE.test(pt)) {
          errors.push(`Block ${i}: contains WordPress comment syntax`);
        }
        if (HTML_TAG_RE.test(pt)) {
          errors.push(`Block ${i}: contains raw HTML tags`);
        }
        break;
      }
      default: {
        errors.push(`Block ${i}: unknown block type "${(block as any).type}"`);
      }
    }
  }

  // Check all blocks for signup URLs (universally invalid in editorial content)
  const fullText = extractPlainTextFromEditorialBlocks(blocks);
  const urlRe = /app\.b2ihub\.com\/signup/i;
  if (urlRe.test(fullText)) {
    errors.push(`Blocks contain signup URL`);
  }

  return errors;
}

export function extractPlainTextFromEditorialBlocks(blocks: EditorialBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "subheading":
      case "quote": {
        for (const node of block.content) {
          parts.push(node.text);
        }
        break;
      }
      case "list": {
        for (const item of block.items) {
          for (const node of item) {
            parts.push(node.text);
          }
        }
        break;
      }
      case "table": {
        for (const row of [block.headers, ...block.rows]) {
          for (const cell of row) {
            for (const node of cell) {
              parts.push(node.text);
            }
          }
        }
        break;
      }
    }
  }

  return parts.join(" ");
}

export function countEditorialBlockWords(blocks: EditorialBlock[]): number {
  const text = extractPlainTextFromEditorialBlocks(blocks);
  return text.split(/\s+/).filter(Boolean).length;
}

export function cloneEditorialBlocks(blocks: EditorialBlock[]): EditorialBlock[] {
  return JSON.parse(JSON.stringify(blocks));
}

// ── WordPress HTML → EditorialBlock parser ──

import * as parse5 from "parse5";

export function parseWordPressEditorialBlocks(
  html: string,
  componentId: string,
): {
  blocks: EditorialBlock[];
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const blocks: EditorialBlock[] = [];

  // Extract WordPress block pairs: <!-- wp:type ... --> content <!-- /wp:type -->
  const blockRe = /<!--\s*wp:(paragraph|heading|list|quote|table)(?:\s*\{[^}]*\})?\s*-->([\s\S]*?)<!--\s*\/wp:\1\s*-->/gi;
  let bm: RegExpExecArray | null;
  let blockIndex = 0;

  while ((bm = blockRe.exec(html)) !== null) {
    const wpType = bm[1].toLowerCase();
    const innerHtml = bm[2].trim();
    const id = `${componentId}-wp-${blockIndex}`;

    if (!innerHtml) {
      warnings.push(`${id}: empty WordPress block content`);
      blockIndex++;
      continue;
    }

    try {
      switch (wpType) {
        case "paragraph": {
          const content = parseInlineContent(innerHtml, errors, warnings, id);
          if (content.length > 0) {
            blocks.push({ id, type: "paragraph", content });
          } else {
            warnings.push(`${id}: paragraph has no inline content after parsing`);
          }
          break;
        }
        case "heading": {
          // Determine heading level from wp:heading attributes or HTML tag
          const levelMatch = bm[0].match(/"level"\s*:\s*(\d+)/);
          const level = levelMatch ? parseInt(levelMatch[1], 10) : 3;
          if (level === 2) {
            errors.push(`${id}: H2 heading not allowed in editorial content`);
            blockIndex++;
            continue;
          }
          const content = parseInlineContent(innerHtml, errors, warnings, id);
          if (content.length > 0) {
            blocks.push({ id, type: "subheading", level: level === 3 ? 3 : 3, content });
          }
          break;
        }
        case "list": {
          const ordered = /wp:list\s*\{[^}]*"ordered"\s*:\s*true/.test(bm[0]);
          const items = parseListItems(innerHtml, errors, warnings, id);
          if (items.length > 0) {
            blocks.push({ id, type: "list", ordered, items });
          } else {
            warnings.push(`${id}: list has no items after parsing`);
          }
          break;
        }
        case "quote": {
          const content = parseInlineContent(innerHtml, errors, warnings, id);
          if (content.length > 0) {
            blocks.push({ id, type: "quote", content });
          }
          break;
        }
        case "table": {
          const parsed = parseTable(innerHtml, errors, warnings, id);
          if (parsed) {
            blocks.push({ id, type: "table", ...parsed });
          }
          break;
        }
      }
    } catch (e: any) {
      errors.push(`${id}: parse error — ${e.message}`);
    }
    blockIndex++;
  }

  return { blocks, errors, warnings };
}

function parseInlineContent(html: string, errors: string[], warnings: string[], blockId: string): InlineContent[] {
  const content: InlineContent[] = [];
  // Strip outermost <p>, <blockquote>, <h3> etc. tags and get inner
  const doc = parse5.parseFragment(html) as any;
  walkNodes(doc, (node: any) => {
    if (node.nodeName === "#text" && node.value && node.value.trim()) {
      // Skip text nodes whose parent is a formatting or link element —
      // those handlers already capture the text via extractText() and
      // would otherwise create duplicate content nodes.
      const parent = node.parentNode?.nodeName;
      if (parent === "a" || parent === "strong" || parent === "b" || parent === "em" || parent === "i") return;
      content.push({ type: "text", text: node.value.trim() });
    } else if (node.nodeName === "strong" || node.nodeName === "b") {
      const text = extractText(node);
      if (text) content.push({ type: "strong", text });
    } else if (node.nodeName === "em" || node.nodeName === "i") {
      const text = extractText(node);
      if (text) content.push({ type: "emphasis", text });
    } else if (node.nodeName === "a") {
      const href = node.attrs?.find((a: any) => a.name === "href")?.value || "";
      const text = extractText(node);
      if (text && href) {
        if (/^(https?:\/\/|\/)/i.test(href)) {
          content.push({ type: "link", text, href });
        } else {
          warnings.push(`${blockId}: unsafe link "${href}" — storing as plain text`);
          content.push({ type: "text", text });
        }
      }
    } else if (node.nodeName === "br") {
      // silent ignore
    } else if (node.nodeName === "#comment") {
      // ignore
    } else if (node.nodeName === "script" || node.nodeName === "style" || node.nodeName === "iframe") {
      errors.push(`${blockId}: executable element <${node.nodeName}> rejected`);
    }
  });
  return content;
}

function extractText(node: any): string {
  let result = "";
  if (node.childNodes) {
    for (const child of node.childNodes) {
      if (child.nodeName === "#text") {
        result += child.value || "";
      } else if (child.childNodes) {
        result += extractText(child);
      }
    }
  }
  return result.replace(/\s+/g, " ").trim();
}

function walkNodes(node: any, fn: (node: any) => void): void {
  fn(node);
  if (node.childNodes) {
    for (const child of node.childNodes) {
      walkNodes(child, fn);
    }
  }
}

function parseListItems(html: string, errors: string[], warnings: string[], blockId: string): InlineContent[][] {
  const items: InlineContent[][] = [];
  const doc = parse5.parseFragment(html) as any;
  for (const child of doc.childNodes || []) {
    if (child.nodeName === "li" || child.nodeName === "ol" || child.nodeName === "ul") {
      if (child.nodeName === "li") {
        const content = parseInlineContent(serializeNode(child), errors, warnings, blockId);
        if (content.length > 0) items.push(content);
      }
      // Handle nested list tags
      if (child.childNodes) {
        for (const sub of child.childNodes) {
          if (sub.nodeName === "li") {
            const content = parseInlineContent(serializeNode(sub), errors, warnings, blockId);
            if (content.length > 0) items.push(content);
          }
        }
      }
    }
  }
  return items;
}

function parseTable(html: string, errors: string[], warnings: string[], blockId: string): { headers: InlineContent[][]; rows: InlineContent[][][] } | null {
  const headers: InlineContent[][] = [];
  const rows: InlineContent[][][] = [];
  const doc = parse5.parseFragment(html) as any;
  let inHeader = false;

  for (const child of doc.childNodes || []) {
    if (child.nodeName === "thead") {
      inHeader = true;
      for (const row of child.childNodes || []) {
        if (row.nodeName === "tr") {
          for (const cell of row.childNodes || []) {
            if (cell.nodeName === "th") {
              const content = parseInlineContent(serializeNode(cell), errors, warnings, blockId);
              if (content.length > 0) headers.push(content);
            }
          }
        }
      }
      inHeader = false;
    } else if (child.nodeName === "tr") {
      const rowCells: InlineContent[][] = [];
      for (const cell of child.childNodes || []) {
        if (cell.nodeName === "td" || cell.nodeName === "th") {
          const content = parseInlineContent(serializeNode(cell), errors, warnings, blockId);
          if (content.length > 0) rowCells.push(content);
        }
      }
      if (rowCells.length > 0) rows.push(rowCells);
    } else if (child.nodeName === "tbody" && child.childNodes) {
      for (const row of child.childNodes) {
        if (row.nodeName === "tr") {
          const rowCells: InlineContent[][] = [];
          for (const cell of row.childNodes || []) {
            if (cell.nodeName === "td" || cell.nodeName === "th") {
              const content = parseInlineContent(serializeNode(cell), errors, warnings, blockId);
              if (content.length > 0) rowCells.push(content);
            }
          }
          if (rowCells.length > 0) rows.push(rowCells);
        }
      }
    } else if (child.nodeName === "table" && child.childNodes) {
      // Recursively handle nested table
      const nested = parseTable(serializeNode(child), errors, warnings, blockId);
      if (nested) {
        headers.push(...nested.headers);
        rows.push(...nested.rows);
      }
    }
  }

  if (headers.length === 0 && rows.length === 0) return null;
  return { headers: headers.length > 0 ? headers : rows[0]?.map(() => [{ type: "text" as const, text: "" }]), rows };
}

function serializeNode(node: any): string {
  // Simple serialization: just return the inner HTML content
  if (node.nodeName === "#text") return node.value || "";
  let result = "";
  if (node.childNodes) {
    for (const child of node.childNodes) {
      result += serializeNode(child);
    }
  }
  return result;
}

