// ── Source Boilerplate Rejection ──
// Deterministic detection of publisher boilerplate that must never enter
// generated content: legal disclaimers, author-opinion notices, privacy/cookie
// text, navigation text, liability statements and unrelated publisher
// announcements. Boilerplate is excluded from evidence and usable quotations,
// and any boilerplate that still reaches the final article is a hard
// final-validation failure.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";

const BOILERPLATE_PATTERNS: RegExp[] = [
  // Legal disclaimers and author-opinion notices
  /\bthe views, information, or opinions expressed\b/i,
  /\bsolely those of the author\b/i,
  /\bdo not necessarily reflect the views of\b/i,
  /\bthe opinions expressed (?:in|herein)\b/i,
  /\bdisclaimer\b/i,
  /\bno representation or warranty\b/i,
  /\b(?:we|the (?:publisher|author|company|brand)) (?:are|is) not responsible\b/i,
  /\bliabilit(?:y|ies)\s+(?:disclaimer|notice|statement)\b/i,
  /\bnot (?:legal|financial|professional|investment|tax) advice\b/i,
  /\bfor (?:informational|information|general) purposes only\b/i,
  /\bas of the date of (?:publication|writing)\b/i,
  // Copyright, ownership and reproduction notices
  /\ball rights reserved\b/i,
  /\ball rights belong to\b/i,
  /\brights belong to (?:their|the) respective owners\b/i,
  /\b(?:copyright|©|\(c\))\b/i,
  /\b(?:may not be reproduced|reproduced without|reproduction prohibited|reproduction without permission|no reproduction)\b/i,
  /\bno part of (?:this|the) (?:content|article|material|site|publication)\b(?:.{0,60})?(?:reproduced|copied|used|distributed)/i,
  /\bwithout (?:the )?(?:prior )?written permission\b/i,
  /\b(?:trademarks?|logos?|brands?) (?:are|is) the (?:property|sole property)\b/i,
  /\bproperty of their respective (?:owners|holders|companies)\b/i,
  /\bowned by their respective owners\b/i,
  /\bfor personal use only\b/i,
  // Privacy / cookies / terms
  /\bprivacy (?:policy|notice|statement)\b/i,
  /\bcookie (?:policy|notice|preferences|consent)\b/i,
  /\bterms of (?:service|use)\b/i,
  /\bthis (?:site|website|page) (?:uses|stores|sets) cookies?\b/i,
  // Navigation / newsletter / sharing prompts
  /\bsubscribe to (?:our )?(?:newsletter|mailing list)\b/i,
  /\bfollow us on\b/i,
  /\bshare (?:this|the) (?:article|post|page)\b/i,
  /\b(?:skip to content|main menu|site map|search this site)\b/i,
  // Unrelated publisher announcements / promotional boilerplate
  /\b(?:event|conference|webinar|workshop) (?:registration|tickets?|sponsors?)\b/i,
  /\ball (?:sessions?|events?) are (?:curated|subject to change)\b/i,
];

/** True when the text is source/publisher boilerplate that must not be used
 *  as evidence or quoted as content. */
export function isSourceBoilerplate(text: string): boolean {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function blockText(block: EditorialBlock): string {
  if (block.type === "list") return block.items.flat().map((node) => node.text).join(" ");
  if (block.type === "table") {
    return [...block.headers, ...block.rows.flat()].flat().map((node) => node.text).join(" ");
  }
  if (block.type === "quote" || block.type === "subheading") {
    return block.content.map((node) => node.text).join(" ");
  }
  return block.content.map((node) => node.text).join(" ");
}

/** Count editorial blocks whose text is boilerplate, plus FAQ questions and
 *  answers. Every editable block type is covered: paragraph, quote, list item,
 *  table cell, subheading, FAQ question and FAQ answer. The CTA, language
 *  switcher and schema are application-owned and never scanned. */
export function countBoilerplateInDocument(doc: ArticleDocument): Array<{
  componentId: string;
  blockId: string;
  blockType: string;
  snippet: string;
}> {
  const findings: Array<{ componentId: string; blockId: string; blockType: string; snippet: string }> = [];
  const checkComponent = (componentId: string, blocks: EditorialBlock[]) => {
    for (const block of blocks) {
      const text = blockText(block);
      if (isSourceBoilerplate(text)) {
        findings.push({
          componentId,
          blockId: block.id,
          blockType: block.type,
          snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
        });
      }
    }
  };
  checkComponent(doc.introduction.id, doc.introduction.blocks);
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;
    checkComponent(section.id, section.blocks);
  }
  checkComponent(doc.conclusion.id, doc.conclusion.blocks);
  doc.visibleFaq.forEach((entry, index) => {
    for (const [label, text] of [["question", entry.question], ["answer", entry.answerText]] as const) {
      if (isSourceBoilerplate(text)) {
        findings.push({
          componentId: `faq-${index}`,
          blockId: `faq-${index}-${label}`,
          blockType: `faq-${label}`,
          snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
        });
      }
    }
  });
  return findings;
}

/** Filter boilerplate sentences out of a research snippet so they can never
 *  become evidence or be quoted into generated content. */
export function stripSourceBoilerplate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < normalized.length; index++) {
    if (!/[.!?]/.test(normalized[index])) continue;
    let end = index + 1;
    while (/[.!?]/.test(normalized[end] ?? "")) end++;
    while (/["\u201D\u2019)\]]/.test(normalized[end] ?? "")) end++;
    if (normalized.slice(start, end).trim()) ranges.push({ start, end });
    while (/\s/.test(normalized[end] ?? "")) end++;
    start = end;
    index = end - 1;
  }
  if (start < normalized.length && normalized.slice(start).trim()) {
    ranges.push({ start, end: normalized.length });
  }

  const rejected = new Set<number>();
  ranges.forEach((range, index) => {
    if (isSourceBoilerplate(normalized.slice(range.start, range.end))) rejected.add(index);
  });
  if (rejected.size === 0) return normalized;

  const quotation = analyzeQuotationIntegrity(normalized);
  if (!quotation.balanced) return "";
  for (const span of quotation.spans) {
    const touchesRejectedSentence = [...rejected].some((index) => {
      const range = ranges[index];
      return range.start < span.end && span.start < range.end;
    });
    if (!touchesRejectedSentence) continue;
    ranges.forEach((range, index) => {
      if (range.start < span.end && span.start < range.end) rejected.add(index);
    });
  }

  return ranges
    .filter((_range, index) => !rejected.has(index))
    .map((range) => normalized.slice(range.start, range.end).trim())
    .filter(Boolean)
    .join(" ");
}
