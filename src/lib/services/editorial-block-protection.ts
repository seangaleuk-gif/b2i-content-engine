// ── Structured block-level number and link utilities ──
// Temporary parity utilities that mirror the existing HTML-based
// protection/validation in translation-validator.ts but operate
// directly on EditorialBlock[] / InlineContent nodes.

import { type EditorialBlock, type InlineContent } from "@/lib/blog/article-content";
import { createNumberExpressionRegex } from "./translation-number-grammar";

const NUMBER_RE = createNumberExpressionRegex();

// ── Inline content traversal ──

function walkInlineContent(
  nodes: InlineContent[],
  fn: (node: InlineContent) => void,
): void {
  for (const node of nodes) {
    fn(node);
  }
}

function cloneInlineContent(nodes: InlineContent[]): InlineContent[] {
  return nodes.map((n) => {
    if (n.type === "link") {
      return { ...n, text: n.text, href: n.href };
    }
    return { ...n, text: n.text };
  });
}

function cloneEditorialBlocks(blocks: EditorialBlock[]): EditorialBlock[] {
  return JSON.parse(JSON.stringify(blocks));
}

// ── Number extraction ──

export function extractNumbersFromEditorialBlocks(blocks: EditorialBlock[]): string[] {
  const numbers: string[] = [];
  forEachInlineText(blocks, (text) => {
    let m: RegExpExecArray | null;
    const re = new RegExp(NUMBER_RE.source, "gi");
    while ((m = re.exec(text)) !== null) {
      numbers.push(m[0]);
    }
  });
  return numbers;
}

// ── Link extraction ──

export function extractLinksFromEditorialBlocks(blocks: EditorialBlock[]): string[] {
  const links: string[] = [];
  forEachInlineNode(blocks, (node) => {
    if (node.type === "link") {
      links.push(node.href);
    }
  });
  return links;
}

// ── Number protection (returns new blocks, never mutates source) ──

export interface NumberProtectionState {
  placeholders: string[];
  originalValues: string[];
}

export function protectNumbersInEditorialBlocks(
  blocks: EditorialBlock[],
): { blocks: EditorialBlock[]; state: NumberProtectionState } {
  const result = cloneEditorialBlocks(blocks);
  const placeholders: string[] = [];
  const originalValues: string[] = [];
  let index = 0;

  forEachInlineTextInPlace(result, (text, replace) => {
    const replaced = text.replace(NUMBER_RE, (match) => {
      placeholders.push(`__NUM_${index}__`);
      originalValues.push(match);
      return `__NUM_${index++}__`;
    });
    if (replaced !== text) {
      replace(replaced);
    }
  });

  return { blocks: result, state: { placeholders, originalValues } };
}

export function restoreNumbersInEditorialBlocks(
  blocks: EditorialBlock[],
  state: NumberProtectionState,
): EditorialBlock[] {
  const result = cloneEditorialBlocks(blocks);

  forEachInlineTextInPlace(result, (text, replace) => {
    let replaced = text;
    for (let i = 0; i < state.placeholders.length; i++) {
      const ph = state.placeholders[i];
      const escaped = ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      replaced = replaced.replace(new RegExp(escaped, "g"), state.originalValues[i]);
    }
    if (replaced !== text) {
      replace(replaced);
    }
  });

  return result;
}

// ── Block-level number preservation check ──

export function checkBlockNumbersPreserved(
  sourceBlocks: EditorialBlock[],
  translatedBlocks: EditorialBlock[],
): { lost: string[]; extras: string[] } {
  const srcNums = extractNumbersFromEditorialBlocks(sourceBlocks);
  const tgtNums = extractNumbersFromEditorialBlocks(translatedBlocks);

  const srcCounts: Record<string, number> = {};
  const tgtCounts: Record<string, number> = {};
  for (const n of srcNums) srcCounts[n] = (srcCounts[n] || 0) + 1;
  for (const n of tgtNums) tgtCounts[n] = (tgtCounts[n] || 0) + 1;

  const lost: string[] = [];
  const extras: string[] = [];

  for (const [n, c] of Object.entries(srcCounts)) {
    const tgtC = tgtCounts[n] || 0;
    if (tgtC < c) lost.push(...Array(c - tgtC).fill(n));
  }
  for (const [n, c] of Object.entries(tgtCounts)) {
    const srcC = srcCounts[n] || 0;
    if (srcC < c) extras.push(...Array(c - srcC).fill(n));
  }

  return { lost, extras };
}

// ── Block-level link preservation check ──

export function checkBlockLinksPreserved(
  sourceBlocks: EditorialBlock[],
  translatedBlocks: EditorialBlock[],
): string[] {
  const srcLinks = extractLinksFromEditorialBlocks(sourceBlocks);
  const tgtLinks = extractLinksFromEditorialBlocks(translatedBlocks);
  return srcLinks.filter((l) => !tgtLinks.includes(l) && !l.startsWith("#"));
}

// ── Internal traversal helpers ──

function forEachInlineNode(
  blocks: EditorialBlock[],
  fn: (node: InlineContent) => void,
): void {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "subheading":
      case "quote":
        walkInlineContent(block.content, fn);
        break;
      case "list":
        for (const item of block.items) {
          walkInlineContent(item, fn);
        }
        break;
      case "table":
        for (const header of block.headers) {
          walkInlineContent(header, fn);
        }
        for (const row of block.rows) {
          for (const cell of row) {
            walkInlineContent(cell, fn);
          }
        }
        break;
    }
  }
}

function forEachInlineText(
  blocks: EditorialBlock[],
  fn: (text: string) => void,
): void {
  forEachInlineNode(blocks, (node) => {
    fn(node.text);
  });
}

function forEachInlineTextInPlace(
  blocks: EditorialBlock[],
  fn: (text: string, replace: (newText: string) => void) => void,
): void {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "subheading":
      case "quote":
        for (let i = 0; i < block.content.length; i++) {
          const node = block.content[i];
          const originalText = node.text;
          fn(originalText, (newText) => { block.content[i] = { ...node, text: newText }; });
        }
        break;
      case "list":
        for (const item of block.items) {
          for (let i = 0; i < item.length; i++) {
            const node = item[i];
            const originalText = node.text;
            fn(originalText, (newText) => { item[i] = { ...node, text: newText }; });
          }
        }
        break;
      case "table":
        for (const header of block.headers) {
          for (let i = 0; i < header.length; i++) {
            const node = header[i];
            const originalText = node.text;
            fn(originalText, (newText) => { header[i] = { ...node, text: newText }; });
          }
        }
        for (const row of block.rows) {
          for (const cell of row) {
            for (let i = 0; i < cell.length; i++) {
              const node = cell[i];
              const originalText = node.text;
              fn(originalText, (newText) => { cell[i] = { ...node, text: newText }; });
            }
          }
        }
        break;
    }
  }
}
