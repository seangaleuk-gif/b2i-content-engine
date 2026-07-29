// ── Factual-Risk Scanner ──
// Post-generation scan that flags unsupported precise claims in editable article content.
// Uses only supplied project research text — never the live web.
//
// Supported claims are retained.
// Unsupported claims in editable content trigger targeted regeneration.
// If regeneration still has unsupported claims, the offending sentence is removed.

import {
  parseWordPressEditorialBlocks,
  renderEditorialBlocksToWordPress,
  type EditorialBlock,
} from "@/lib/blog/article-document";

// ── Types ──

export interface FactualRisk {
  /** Array of claims found in the article text */
  claims: ScannedClaim[];
  /** Whether the article contains any high-risk (likely unsupported) claims */
  hasHighRisk: boolean;
}

export interface ScannedClaim {
  /** The exact claim text fragment */
  text: string;
  /** Position in the HTML where the claim starts */
  htmlPosition: number;
  /** The claim category */
  category: ClaimCategory;
  /** Whether this claim appears to be supported by research text */
  supported: boolean;
  /** Section index (which H2 section this appears in) */
  sectionIndex: number;
}

export type ClaimCategory =
  | "percentage"
  | "currency_amount"
  | "numerical_growth"
  | "platform_metric"
  | "platform_feature"
  | "publishing_cadence"
  | "testimonial_quote"
  | "business_result";

export interface EvidenceLedgerEntry {
  title: string;
  snippet: string;
  url: string;
  normalizedText: string;
  quantities: number[];
  geography: "hong-kong" | "global" | "unspecified";
  statisticQualifier: "average" | "median" | "unspecified";
}

// ── Claim detection patterns ──

const CLAIM_PATTERNS: Array<{ category: ClaimCategory; regex: RegExp }> = [
  // Percentages
  { category: "percentage", regex: /\d{1,3}(?:\.\d+)?%\s*(?:of|increase|decrease|growth|drop|rise|fall|more|less|jump|surge)/gi },
  { category: "percentage", regex: /(?:over|nearly|almost|approximately|about)\s*\d{1,3}(?:\.\d+)?%/gi },
  {
    category: "platform_metric",
    regex: /\b(?:average|median)\s+engagement rate[^.!?]{0,100}?\d{1,3}(?:\.\d+)?%/gi,
  },
  {
    category: "platform_metric",
    regex: /\b\d{1,3}(?:\.\d+)?%[^.!?]{0,100}?(?:average|median)\s+engagement rate\b/gi,
  },
  // Numerical growth claims
  { category: "numerical_growth", regex: /(?:increased|decreased|grew|fell|rose|dropped|doubled|tripled|jumped|surged)\s+(?:by|from|to)\s+\d+/gi },
  { category: "numerical_growth", regex: /(?:jumped|surged|shot up|soared|plummeted|plunged)\s+(?:\d+)/gi },
  { category: "numerical_growth", regex: /\d+\s*(?:percent|per cent|times|x)\s+(?:increase|decrease|growth|drop|rise|fall|more)/gi },
  { category: "numerical_growth", regex: /\b\d+(?:\.\d+)?\s*x\s+(?:higher|lower|more|greater|better|faster)\b/gi },
  // Platform thresholds, recommended cadence and claimed peak-time windows
  { category: "platform_metric", regex: /\b\d[\d,]*\s+followers?\b/gi },
  {
    category: "platform_metric",
    regex: /\b\d+(?:\.\d+)?(?:,\d{3})*\s*(?:billion|million|thousand|bn|m|k)?\+?\s+(?:monthly active\s+|daily active\s+)?users?\b/gi,
  },
  { category: "publishing_cadence", regex: /\b\d+(?:\s*[–—-]\s*\d+)?\s+(?:posts?|threads?)\s+(?:per|a)\s+(?:day|week|month)\b/gi },
  { category: "platform_metric", regex: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi },
  { category: "platform_metric", regex: /\b(?:target|aim for|benchmark of)\s+\d+(?:\s*[–—-]\s*\d+)?%/gi },
  // Dated or current platform-capability claims must be present in research.
  { category: "platform_feature", regex: /\bas of \d{4},?[^.!?]{0,140}\b(?:launched|available|supports?|allows?|offers?)\b[^.!?]*/gi },
  {
    category: "platform_feature",
    regex:
      /\bthreads\b[^.!?]{0,100}\b(?:ads?|advertising|analytics|insights|links?|features?)\b[^.!?]{0,100}\b(?:available|unavailable|launched|rolled out|supported|allowed|offered|does not|doesn't|is not|isn't|are not|aren't|now|currently|yet)\b[^.!?]*/gi,
  },
  {
    category: "platform_feature",
    regex:
      /\bthreads\b[^.!?]{0,100}\b(?:supports?|allows?|offers?|includes?|has launched)\b[^.!?]{0,80}\b(?:ads?|advertising|analytics|insights|links?|features?)\b[^.!?]*/gi,
  },
  // Business results
  { category: "business_result", regex: /generated?\s+\d+\s*(?:percent|%|times|x|more)/gi },
  { category: "business_result", regex: /(?:sales|revenue|traffic|leads|conversions?)\s+(?:rose|increased|grew|jumped|surged)\s+\d+/gi },
  { category: "business_result", regex: /\d+\s*(?:percent|%)\s+(?:increase|decrease|growth|boost|rise|drop)\s+in\s+(?:sales|revenue|traffic|leads|conversions?|engagement|visits?)/gi },
  // Testimonials with quotation marks
  { category: "testimonial_quote", regex: /"[^"]{10,}"/gi },
  // Unnamed business testimonials
  { category: "testimonial_quote", regex: /(?:a|one)\s+(?:local|small|Hong Kong)\s+(?:business|brand|company|shop|store|cafe|bakery|studio)\s+(?:told us|shared|reported|said|noted|found|experienced|saw)/gi },
  // "X more" claims
  { category: "business_result", regex: /\d+\s*(?:times|x)\s+more\s+(?:sales|revenue|traffic|leads|engagement|visits?|conversions?)/gi },
];

// ── Research-source text extraction ──

export function buildEvidenceLedger(
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): EvidenceLedgerEntry[] {
  return (research ?? []).map((item) => {
    const title = decodeHtmlEntities(item.title ?? "");
    const snippet = decodeHtmlEntities(item.snippet ?? "");
    const normalizedText = `${title} ${snippet}`.replace(/\s+/g, " ").trim().toLowerCase();
    const geography = /\b(?:hong kong|hk)\b|香港/i.test(normalizedText)
      ? "hong-kong"
      : /\b(?:global|globally|worldwide|world average)\b|全球/i.test(normalizedText)
        ? "global"
        : "unspecified";
    const statisticQualifier = /\bmedian\b/i.test(normalizedText)
      ? "median"
      : /\baverage\b/i.test(normalizedText)
        ? "average"
        : "unspecified";
    return {
      title,
      snippet,
      url: item.url ?? "",
      normalizedText,
      quantities: extractQuantities(normalizedText),
      geography,
      statisticQualifier,
    };
  });
}

// ── Scanner ──

export function scanFactualRisks(
  html: string,
  keyphrase: string,
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): FactualRisk {
  const bodyText = decodeHtmlEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());

  const evidenceLedger = buildEvidenceLedger(research);

  // Find H2 section boundaries for claim positioning
  const h2Positions: number[] = [];
  const h2Re = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi;
  let h2m: RegExpExecArray | null;
  while ((h2m = h2Re.exec(html)) !== null) {
    h2Positions.push(h2m.index);
  }

  function findSectionIndex(pos: number): number {
    let idx = 0;
    for (let i = h2Positions.length - 1; i >= 0; i--) {
      if (pos >= h2Positions[i]) { idx = i; break; }
    }
    return idx;
  }

  const claims: ScannedClaim[] = [];

  for (const { category, regex } of CLAIM_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(bodyText)) !== null) {
      // Deduplicate by matching text
      const text = m[0].trim();
      if (claims.some((c) => normalizeForMatch(c.text) === normalizeForMatch(text))) continue;

      // Visible text may cross inline markup or use encoded entities. Never
      // discard a risky claim merely because it has no exact raw-HTML match.
      const htmlPos = html.indexOf(m[0]);
      const safeHtmlPos = htmlPos >= 0 ? htmlPos : 0;

      // Check if claim is in a protected block (CTA, switcher, schema)
      const beforeClaim = html.substring(0, safeHtmlPos);
      const lastOpenComment = beforeClaim.lastIndexOf("<!--");
      const lastCloseComment = beforeClaim.lastIndexOf("-->");
      if (lastOpenComment > lastCloseComment) continue; // Inside a comment block

      const sectionIndex = findSectionIndex(safeHtmlPos);
      const claimText = decodeHtmlEntities(m[0]).toLowerCase();

      // Check if the claim number is supported by research text
      let supported = false;
      if (evidenceLedger.length > 0) {
        // Extract the number from the claim
        const claimQuantity = extractFirstQuantity(claimText);
        if (claimQuantity !== null) {
          const keywords = claimText
            .replace(/\d+[\d.,]*/g, "")
            .trim()
            .split(/\s+/)
            .filter((word) => word.length >= 3);
          const claimGeography = /\b(?:hong kong|hk)\b|香港/i.test(claimText)
            ? "hong-kong"
            : "unspecified";
          const claimQualifier = /\bmedian\b/i.test(claimText)
            ? "median"
            : /\baverage\b/i.test(claimText)
              ? "average"
              : "unspecified";
          supported = evidenceLedger.some((entry) => {
            const hasSameQuantity = entry.quantities.some(
              (quantity) => Math.abs(quantity - claimQuantity) < Number.EPSILON,
            );
            const keywordOverlap = keywords.filter(
              (word) => entry.normalizedText.includes(word),
            ).length;
            const geographyMatches = claimGeography !== "hong-kong"
              || entry.geography === "hong-kong";
            const qualifierMatches = claimQualifier === "unspecified"
              || entry.statisticQualifier === claimQualifier;
            return hasSameQuantity
              && keywordOverlap >= Math.min(2, keywords.length)
              && geographyMatches
              && qualifierMatches;
          });
        } else {
          const keywords = claimText
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .split(/\s+/)
            .filter((word) => word.length >= 4);
          supported = evidenceLedger.some((entry) => {
            const keywordOverlap = keywords.filter(
              (word) => entry.normalizedText.includes(word),
            ).length;
            return keywordOverlap >= Math.min(3, keywords.length);
          });
        }
      }

      claims.push({
        text: m[0],
        htmlPosition: safeHtmlPos,
        category,
        supported,
        sectionIndex,
      });
    }
  }

  const hasHighRisk = claims.some((c) => !c.supported);
  return { claims, hasHighRisk };
}

// ── Claim removal from section body ──

export function removeUnsupportedSentences(
  sectionHtml: string,
  unsupportedClaims: ScannedClaim[],
): { html: string; sentencesRemoved: number } {
  if (unsupportedClaims.length === 0) {
    return { html: sectionHtml, sentencesRemoved: 0 };
  }

  let modified = sectionHtml;
  let removed = 0;

  const paragraphRe =
    /<!--\s*wp:paragraph\s*-->\s*\n?<p\b[^>]*>[\s\S]*?<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi;
  const paragraphs = [...sectionHtml.matchAll(paragraphRe)];

  // Work backwards so replacements never invalidate later source positions.
  for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
    const match = paragraphs[paragraphIndex];
    const paragraphHtml = match[0];
    const parsed = parseWordPressEditorialBlocks(
      paragraphHtml,
      `factual-repair-${paragraphIndex}`,
    );
    const paragraph = parsed.blocks[0];
    if (
      parsed.errors.length > 0
      || parsed.blocks.length !== 1
      || paragraph?.type !== "paragraph"
    ) {
      continue;
    }

    const text = paragraph.content.map((node) => node.text).join("");
    const relevantClaims = unsupportedClaims.filter((claim) =>
      normalizeForMatch(text).includes(normalizeForMatch(claim.text)),
    );
    if (relevantClaims.length === 0) continue;

    const ranges = sentenceRanges(text).filter((range) => {
      const sentence = normalizeForMatch(text.slice(range.start, range.end));
      return relevantClaims.some((claim) => sentence.includes(normalizeForMatch(claim.text)));
    });
    if (ranges.length === 0) continue;

    // Links are immutable pipeline assets. If a claimed sentence contains an
    // anchor, leave it for regeneration/rejection rather than deleting the URL.
    const linkedRanges = inlineLinkRanges(paragraph);
    const safeRanges = ranges.filter(
      (range) => !linkedRanges.some((link) => rangesOverlap(range, link)),
    );
    if (safeRanges.length === 0) continue;

    const repaired = removeTextRanges(paragraph, safeRanges);
    const repairedText = repaired.content.map((node) => node.text).join("").trim();
    const replacement = repairedText
      ? renderEditorialBlocksToWordPress([repaired])
      : "";
    const start = match.index ?? 0;
    modified = modified.slice(0, start) + replacement + modified.slice(start + paragraphHtml.length);
    removed += safeRanges.length;
  }

  return { html: modified, sentencesRemoved: removed };
}

function extractFirstQuantity(text: string): number | null {
  return extractQuantities(text)[0] ?? null;
}

function extractQuantities(text: string): number[] {
  const quantities: number[] = [];
  const regex =
    /\b(\d+(?:\.\d+)?(?:,\d{3})*)\s*(billion|million|thousand|bn|m|k)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const base = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = match[2]?.toLowerCase();
    const multiplier = scale === "billion" || scale === "bn"
      ? 1_000_000_000
      : scale === "million" || scale === "m"
        ? 1_000_000
        : scale === "thousand" || scale === "k"
          ? 1_000
          : 1;
    quantities.push(base * multiplier);
  }
  return quantities;
}

interface TextRange {
  start: number;
  end: number;
}

function normalizeForMatch(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim().toLowerCase();
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (decimal) return decodeCodePoint(decimal, 10, entity);
      if (hexadecimal) return decodeCodePoint(hexadecimal, 16, entity);
      return name ? (named[name.toLowerCase()] ?? entity) : entity;
    },
  );
}

function decodeCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isFinite(codePoint)
    || codePoint < 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
}

function sentenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const regex = /[^.!?]+(?:[.!?]+(?:["”’)]*)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (!match[0].trim()) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function inlineLinkRanges(paragraph: Extract<EditorialBlock, { type: "paragraph" }>): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  for (const node of paragraph.content) {
    const next = cursor + node.text.length;
    if (node.type === "link") ranges.push({ start: cursor, end: next });
    cursor = next;
  }
  return ranges;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function removeTextRanges(
  paragraph: Extract<EditorialBlock, { type: "paragraph" }>,
  ranges: TextRange[],
): Extract<EditorialBlock, { type: "paragraph" }> {
  let cursor = 0;
  const content = paragraph.content.flatMap((node) => {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;
    let retained = "";
    let localCursor = nodeStart;
    for (const range of ranges) {
      if (!rangesOverlap({ start: nodeStart, end: nodeEnd }, range)) continue;
      const keepUntil = Math.max(nodeStart, range.start);
      if (keepUntil > localCursor) {
        retained += node.text.slice(localCursor - nodeStart, keepUntil - nodeStart);
      }
      localCursor = Math.max(localCursor, Math.min(nodeEnd, range.end));
    }
    if (localCursor < nodeEnd) retained += node.text.slice(localCursor - nodeStart);
    retained = retained.replace(/\s+/g, " ");
    return retained ? [{ ...node, text: retained }] : [];
  });

  if (content.length > 0) {
    content[0].text = content[0].text.trimStart();
    content[content.length - 1].text = content[content.length - 1].text.trimEnd();
  }
  return { ...paragraph, content };
}

// ── Format claims for logging ──

export function formatClaimLog(claims: ScannedClaim[]): string {
  const supported = claims.filter((c) => c.supported);
  const unsupported = claims.filter((c) => !c.supported);
  const lines: string[] = [];
  lines.push(`Claims found: ${claims.length} (${unsupported.length} unsupported)`);
  for (const c of unsupported) {
    lines.push(`  [UNSUPPORTED] [${c.category}] section=${c.sectionIndex} text="${c.text.substring(0, 80)}"`);
  }
  for (const c of supported) {
    lines.push(`  [SUPPORTED]   [${c.category}] section=${c.sectionIndex} text="${c.text.substring(0, 80)}"`);
  }
  return lines.join("\n");
}
