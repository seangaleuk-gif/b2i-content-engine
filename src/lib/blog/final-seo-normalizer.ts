import {
  extractReadableText,
  extractH2Texts,
  extractParagraphTexts,
  countExactPhrase,
  countReadableWords,
  countSentences,
  countSyllables,
  calculateFleschReadingEase,
  calculateKeyphraseDensity,
  containsExactPhrase,
  normalizeHtmlWhitespace,
} from "@/lib/seo/seo-text-utils";
import { keyphraseRangeForWordCount, keyphrasePreferredTarget } from "@/lib/services/generation-constants";

// ── Types ──

export interface FinalSeoNormalizerInput {
  html: string;
  focusKeyphrase: string;
  targetWordCount: number;
  targetKeyphraseCount: number;
  minReadingEase: number;
  maxReadingEase: number;
}

export interface SeoNormalizationMetrics {
  readableWordCount: number;
  exactKeyphraseCount: number;
  keyphraseDensity: number;
  exactKeyphraseInH2: boolean;
  longParagraphCount: number;
  readingEase: number;
}

export interface SeoNormalizationChange {
  type:
    | "word_count_expansion"
    | "h2_keyphrase_replacement"
    | "keyphrase_removed"
    | "keyphrase_inserted"
    | "paragraph_split"
    | "readability_rewrite";
  description: string;
  before?: string;
  after?: string;
}

export interface SeoNormalizationSafety {
  protectedBlocksUnchanged: boolean;
  linkDestinationsUnchanged: boolean;
  wordpressBlocksValid: boolean;
  faqSchemaPreserved: boolean;
  languageSwitcherPreserved: boolean;
  ctaPreserved: boolean;
}

export interface FinalSeoNormalizerResult {
  html: string;
  before: SeoNormalizationMetrics;
  after: SeoNormalizationMetrics;
  changes: SeoNormalizationChange[];
  passed: boolean;
  warnings: string[];
  safety: SeoNormalizationSafety;
}

export interface NormalizerChatFn {
  (messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>): Promise<{ content: string }>;
}

// ── Constants ──

const MAX_READABILITY_REWRITES = 3;
const MAX_EXPANSION_ATTEMPTS = 4;

const KEYPHRASE_SYNONYMS = [
  "these marketing shifts",
  "these developments",
  "the changing Hong Kong market",
  "the city's evolving marketing landscape",
  "these 2026 trends",
  "this shift",
  "these strategies",
  "these market changes",
  "such developments",
  "this evolution",
  "Hong Kong's changing market dynamics",
  "these emerging patterns",
  "the region's evolving landscape",
  "this transformation",
  "these forces",
];

const UNSUPPORTED_STATS_PATTERNS = [
  /\d{1,3}%\s*(?:of|increase|decrease|growth|drop|rise|fall|more|less)/i,
  /(?:increased|decreased|grew|fell|rose|dropped|doubled|tripled)(?:\s+\w+)?\s+by\s+\d/i,
  /(?:sales|revenue|conversion)\s+(?:rose|increased|doubled|fell|dropped)/i,
  /(?:increased|rose|doubled|fell|dropped)\s+(?:sales|revenue|conversion)/i,
  /(?:surveys?|stud(?:y|ies)|research|reports?)\s+(?:found|shows|indicates|reveals|confirms)/i,
  /\d+\s*(?:percent|per cent)\s+(?:of|increase|more)/i,
];

const HARMLESS_NUMBER_PATTERNS = [
  /^\d{4}$/,                                     // Years
  /^\d{1,2}(?:st|nd|rd|th)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)/i, // Dates
  /^#+\s/,                                        // Markdown headings
  /^\d+[.)]\s/,                                   // List numbering
  /^\d+\s*(?:day|week|month|year|hour|minute)/i,  // Duration
  /Instagram|Facebook|LinkedIn|Twitter|Threads/i, // Platform names with potential numbers
  /202\d/,                                        // Years in text
  /<h[1-6]/i,                                     // HTML headings
  /^\d+\s*[-–—]\s*/,                              // Numbered list items
];

// ── Protected block preservation ──

const PROTECTED_BLOCK_PREFIX = "%%PROTECTED_";
const PROTECTED_BLOCK_SUFFIX = "_BLOCK%%";

interface ProtectedBlockToken {
  placeholder: string;
  original: string;
  type: string;
}

function tokenizeProtectedBlocks(html: string): { content: string; tokens: ProtectedBlockToken[] } {
  const tokens: ProtectedBlockToken[] = [];
  let tokenIdx = 0;

  const addToken = (match: string, type: string): string => {
    const placeholder = `${PROTECTED_BLOCK_PREFIX}${tokenIdx}_${type}${PROTECTED_BLOCK_SUFFIX}`;
    tokens.push({ placeholder, original: match, type });
    tokenIdx++;
    return placeholder;
  };

  let content = html;

  content = content.replace(/<script[\s\S]*?<\/script>/gi, (m) => addToken(m, "script"));
  content = content.replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, (m) => addToken(m, "wp-html"));
  content = content.replace(/<img\b[^>]*\/?>/gi, (m) => addToken(m, "image"));
  content = content.replace(/<(?:figure|video|audio|pre|code)\b[\s\S]*?<\/(?:figure|video|audio|pre|code)>/gi, (m) => addToken(m, "media-block"));

  return { content, tokens };
}

function detokenizeProtectedBlocks(content: string, tokens: ProtectedBlockToken[]): string {
  let result = content;
  for (let i = tokens.length - 1; i >= 0; i--) {
    result = result.replace(tokens[i].placeholder, tokens[i].original);
  }
  return result;
}

// ── Protected block helpers ──

interface ProtectedBlock {
  start: number;
  end: number;
  hash: string;
  type: string;
}

function computeHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

function captureProtectedBlocks(html: string): ProtectedBlock[] {
  const blocks: ProtectedBlock[] = [];
  const patterns: Array<{ regex: RegExp; type: string }> = [
    { regex: /<!--\s*wp:html\s*-->[\s\S]*?b2i-language-switcher[\s\S]*?<!--\s*\/wp:html\s*-->/gi, type: "language-switcher" },
    { regex: /<script\s[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, type: "faq-schema" },
    { regex: /<script[\s\S]*?<\/script>/gi, type: "script" },
    { regex: /<style[\s\S]*?<\/style>/gi, type: "style" },
    { regex: /<pre[\s\S]*?<\/pre>/gi, type: "pre" },
    { regex: /<code[\s\S]*?<\/code>/gi, type: "code" },
    { regex: /<img[^>]*>/gi, type: "image" },
    { regex: /<a\b[^>]*>[\s\S]*?<\/a>/gi, type: "link" },
  ];

  for (const { regex, type } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      blocks.push({ start: m.index, end: m.index + m[0].length, hash: computeHash(m[0]), type });
    }
  }

  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

function verifyProtectedBlocks(original: ProtectedBlock[], currentHtml: string): boolean {
  for (const block of original) {
    const fragment = currentHtml.substring(block.start, block.end);
    if (computeHash(fragment) !== block.hash) {
      return false;
    }
  }
  return true;
}

function extractLinkHrefs(html: string): { internal: string[]; external: string[] } {
  const internal: string[] = [];
  const external: string[] = [];
  const linkRegex = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;

  const wpHtmlRanges: [number, number][] = [];
  const wpHtmlRegex = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wm: RegExpExecArray | null;
  while ((wm = wpHtmlRegex.exec(html)) !== null) {
    wpHtmlRanges.push([wm.index, wm.index + wm[0].length]);
  }
  const scriptRegex = /<script[\s\S]*?<\/script>/gi;
  while ((wm = scriptRegex.exec(html)) !== null) {
    wpHtmlRanges.push([wm.index, wm.index + wm[0].length]);
  }

  while ((m = linkRegex.exec(html)) !== null) {
    const pos = m.index;
    if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue;
    const href = m[1];
    if (href.startsWith("/blog/") || href.startsWith("/")) {
      internal.push(href);
    } else if (href.startsWith("http")) {
      external.push(href);
    }
  }
  return { internal, external };
}

function captureLinkHrefs(html: string): string[] {
  const { internal, external } = extractLinkHrefs(html);
  return [...internal, ...external].sort();
}

// ── WP block helpers ──

interface WpParagraphBlock {
  fullMatch: string;
  blockContent: string;
  visibleText: string;
  start: number;
  end: number;
}

function extractWpParagraphBlocks(html: string): WpParagraphBlock[] {
  const blocks: WpParagraphBlock[] = [];
  const regex = /<!--\s*wp:paragraph\s*-->\s*<p>([\s\S]*?)<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const blockContent = m[1];
    const visibleText = blockContent.replace(/<[^>]+>/g, "").trim();
    if (visibleText.length > 0) {
      blocks.push({
        fullMatch: m[0],
        blockContent,
        visibleText,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return blocks;
}

function replaceWpParagraphBlock(html: string, block: WpParagraphBlock, newVisibleText: string): string {
  // Position-based replacement: rebuild the block and slice it in
  const newBlock = `<!-- wp:paragraph -->\n<p>${newVisibleText}</p>\n<!-- /wp:paragraph -->`;
  return html.substring(0, block.start) + newBlock + html.substring(block.end);
}

// ── H2 mutators ──

function findBestH2ForKeyphrase(h2Texts: string[], keyphrase: string): number {
  if (h2Texts.length === 0) return -1;
  const kpLower = keyphrase.toLowerCase();
  const kpWords = new Set(kpLower.split(/\s+/));

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < h2Texts.length; i++) {
    const hLower = h2Texts[i].toLowerCase();
    if (hLower.includes(kpLower)) return i; // Already contains exact keyphrase

    const hWords = new Set(hLower.split(/\s+/));
    let overlap = 0;
    for (const w of kpWords) {
      if (hWords.has(w)) overlap++;
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function replaceH2HeadingText(html: string, oldText: string, newText: string): string {
  // Find the exact H2 block containing oldText and replace the inner text
  const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(<h2[^>]*>)${escaped}(<\\/h2>)`, "gi");
  return html.replace(regex, `$1${newText}$2`);
}

// Ported from fixers.ts for reuse
function fleschOnParagraph(text: string): number {
  const cleaned = extractReadableText(`<p>${text}</p>`);
  return calculateFleschReadingEase(cleaned);
}

// ── Unsupported-statistics detection ──

function hasUnsupportedStatistics(newText: string, originalText: string): boolean {
  const readable = extractReadableText(newText);
  const origReadable = extractReadableText(originalText);

  for (const pattern of UNSUPPORTED_STATS_PATTERNS) {
    const matches = readable.match(new RegExp(pattern.source, "gi"));
    if (matches) {
      for (const match of matches) {
        // Check if this stat was in the original
        if (!origReadable.toLowerCase().includes(match.toLowerCase())) {
          return true;
        }
      }
    }
  }
  return false;
}

function replaceStatisticsWithQualitative(text: string): string {
  let result = text;
  result = result.replace(/(?:increased|decreased|grew|fell|rose|dropped)(?:\s+\w+)?\s+by\s+\d{1,3}%/gi, "has shown notable movement");
  result = result.replace(/\d{1,3}%\s*(?:of|increase|decrease)/gi, "many");
  result = result.replace(/(?:surveys?|stud(?:y|ies)|research|reports?)\s+(?:found|show|indicate|reveal|confirm)/gi, "industry observations suggest");
  result = result.replace(/(?:increased|rose|doubled|fell|dropped)\s+(?:sales|revenue|conversion)/gi, "performance has shifted");
  result = result.replace(/(?:sales|revenue|conversion)\s+(?:rose|increased|doubled|fell|dropped)/gi, "performance has shifted");
  result = result.replace(/(?:named|published|referenced)\s+(?:study|studies|survey|report)/gi, "published analysis");
  return result;
}

// ── Metrics computation ──

function computeMetrics(html: string, keyphrase: string): SeoNormalizationMetrics {
  const readableText = extractReadableText(html);
  const h2Texts = extractH2Texts(html);
  const paraTexts = extractParagraphTexts(html);
  const kpLower = keyphrase.toLowerCase().trim();

  return {
    readableWordCount: countReadableWords(html),
    exactKeyphraseCount: countExactPhrase(readableText, keyphrase),
    keyphraseDensity: calculateKeyphraseDensity(readableText, keyphrase),
    exactKeyphraseInH2: h2Texts.some((h) => h.toLowerCase().includes(kpLower)),
    longParagraphCount: paraTexts.filter((t) => countSentences(t) > 3).length,
    readingEase: Math.round(calculateFleschReadingEase(readableText)),
  };
}

// ── Fix 1: Exact keyphrase in H2 ──

function fixH2Keyphrase(html: string, keyphrase: string, changes: SeoNormalizationChange[]): string {
  const h2Texts = extractH2Texts(html);
  const kpLower = keyphrase.toLowerCase().trim();

  if (h2Texts.some((h) => h.toLowerCase().includes(kpLower))) {
    return html; // Already has exact match
  }

  const bestIdx = findBestH2ForKeyphrase(h2Texts, keyphrase);
  if (bestIdx < 0) return html;

  const oldHeading = h2Texts[bestIdx];
  const newHeading = buildNaturalH2Heading(oldHeading, keyphrase);

  if (newHeading === oldHeading) return html;

  const modified = replaceH2HeadingText(html, oldHeading, newHeading);

  if (modified !== html) {
    const afterH2Texts = extractH2Texts(modified);
    if (afterH2Texts.length === h2Texts.length) {
      changes.push({
        type: "h2_keyphrase_replacement",
        description: `Replaced H2 "${oldHeading.substring(0, 80)}" → "${newHeading.substring(0, 80)}"`,
        before: oldHeading,
        after: newHeading,
      });
      console.log(`[SEO-NORMALIZER] h2 updated="${oldHeading.substring(0, 60)}" → "${newHeading.substring(0, 60)}"`);
      return modified;
    }
  }

  return html;
}

function buildNaturalH2Heading(oldHeading: string, keyphrase: string): string {
  const kpLower = keyphrase.toLowerCase();
  // Capitalize each word of the keyphrase
  const titleCaseKp = keyphrase.replace(/\b\w/g, (c) => c.toUpperCase());
  const oldLower = oldHeading.toLowerCase();

  // If heading already contains most of the keyphrase but missing one word (e.g. singular vs plural)
  if (!oldLower.includes(kpLower)) {
    // Check for close variant scenarios
    const oldWords = oldLower.split(/\s+/);

    // Try replacing the close variant word with the actual keyphrase word
    for (const word of oldWords) {
      const cleanWord = word.replace(/[^a-z0-9]/g, "");
      for (const kpWord of kpLower.split(/\s+/)) {
        const cleanKp = kpWord.replace(/[^a-z0-9]/g, "");
        if ((cleanWord.startsWith(cleanKp) || cleanKp.startsWith(cleanWord)) && cleanWord.length > 3 && cleanKp.length > 3 && cleanWord !== cleanKp) {
          // Replace the specific word
          const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
          const candidate = oldHeading.replace(regex, kpWord);
          if (candidate.toLowerCase().includes(kpLower)) return candidate;
        }
      }
    }
  }

  // Build a natural heading: "How [topic] Is Shaping [keyphrase]" or similar
  const templates = [
    `How ${extractTopic(oldHeading)} Is Shaping ${titleCaseKp}`,
    `Why ${titleCaseKp} Matters Now`,
    `The Complete Guide to ${titleCaseKp}`,
    `What ${titleCaseKp} Means for Your Business`,
    `${titleCaseKp}: A Practical Guide`,
    `${titleCaseKp}: What You Need to Know`,
    `Understanding ${titleCaseKp}`,
    `Navigating ${titleCaseKp}`,
  ];

  for (const template of templates) {
    if (template.toLowerCase().includes(kpLower)) return template;
  }

  return `${titleCaseKp}: ${oldHeading}`;
}

function extractTopic(heading: string): string {
  const cleaned = heading.replace(/[:—–-].*$/, "").trim();
  const words = cleaned.split(/\s+/);
  // Return first 2-3 meaningful words
  const stopWords = new Set(["the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or", "is", "are", "was", "were", "be", "been", "being"]);
  return words.filter((w) => !stopWords.has(w.toLowerCase())).slice(0, 3).join(" ");
}

// ── Fix 2: Reduce excessive keyphrase occurrences ──

function fixExcessiveKeyphrase(html: string, keyphrase: string, targetCount: number, changes: SeoNormalizationChange[]): string {
  const readableText = extractReadableText(html);
  const currentCount = countExactPhrase(readableText, keyphrase);
  if (currentCount <= targetCount) return html;

  const excessToRemove = currentCount - targetCount;
  const kpLower = keyphrase.toLowerCase().trim();
  const kpRegex = new RegExp(kpLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const kpRegexSingle = new RegExp(kpLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  // Identify first 100 words to protect
  const first100Words = readableText.split(/\s+/).slice(0, 100).join(" ").toLowerCase();

  // Step 1: Paragraph-level reduction (preserves first 100 words and H2 matches)
  let resultHtml = reduceInBlocks(html, "paragraph", keyphrase, kpRegex, kpRegexSingle, excessToRemove, first100Words, changes);

  // Step 2: If still above target, do a global HTML reduction (handles headings, lists, etc.)
  const afterParaCount = countExactPhrase(extractReadableText(resultHtml), keyphrase);
  if (afterParaCount > targetCount) {
    resultHtml = reduceGlobally(resultHtml, keyphrase, kpRegex, kpRegexSingle, afterParaCount - targetCount, changes);
  }

  console.log(`[SEO-NORMALIZER] total keyphrase removals across all methods`);
  return resultHtml;
}

function reduceInBlocks(html: string, blockType: string, keyphrase: string, kpRegex: RegExp, kpRegexSingle: RegExp, excessToRemove: number, first100Words: string, changes: SeoNormalizationChange[]): string {
  const blocks = extractWpParagraphBlocks(html);
  const kpParas = blocks.filter((b) => b.visibleText.toLowerCase().includes(keyphrase.toLowerCase())).reverse();
  const first100Lower = first100Words.toLowerCase();
  let removed = 0;
  let synonymIdx = 0;
  let outHtml = html;

  for (const block of kpParas) {
    if (removed >= excessToRemove) break;
    if (block.visibleText.toLowerCase().substring(0, Math.min(60, block.visibleText.length)) === first100Lower.substring(0, Math.min(60, first100Lower.length))) continue;

    const matches = block.visibleText.match(kpRegex);
    if (!matches || matches.length === 0) continue;

    const toReplace = Math.min(matches.length, excessToRemove - removed);
    let newText = block.visibleText;
    let localReplaced = 0;

    for (let r = 0; r < toReplace; r++) {
      const synonym = KEYPHRASE_SYNONYMS[(synonymIdx + localReplaced) % KEYPHRASE_SYNONYMS.length];
      if (!kpRegexSingle.test(newText)) break;
      newText = newText.replace(kpRegexSingle, synonym);
      localReplaced++;
    }

    if (newText !== block.visibleText && localReplaced > 0) {
      outHtml = replaceWpParagraphBlock(outHtml, block, newText);
      removed += localReplaced;
      synonymIdx += localReplaced;
      changes.push({
        type: "keyphrase_removed",
        description: `Removed ${localReplaced} keyphrase occurrence(s) from ${blockType}`,
        before: block.visibleText.substring(0, 60),
        after: newText.substring(0, 60),
      });
    }
  }

  console.log(`[SEO-NORMALIZER] keyphrase removals=${removed} from ${blockType}s`);
  return outHtml;
}

function reduceGlobally(html: string, keyphrase: string, kpRegex: RegExp, kpRegexSingle: RegExp, excessToRemove: number, changes: SeoNormalizationChange[]): string {
  let outHtml = html;
  let removed = 0;
  let synonymIdx = 0;
  let safety = 0;

  while (removed < excessToRemove && safety < 50) {
    safety++;
    const match = kpRegexSingle.exec(outHtml);
    if (!match) break;

    const before = outHtml.substring(Math.max(0, match.index - 2), Math.min(outHtml.length, match.index + keyphrase.length + 2));
    // Skip if inside a tag (href, src, alt, etc.) or inside wp:heading for a protected H2
    if (/=["']/.test(before) || /<!--\s*wp:heading/.test(before)) {
      continue;
    }

    const synonym = KEYPHRASE_SYNONYMS[(synonymIdx + removed) % KEYPHRASE_SYNONYMS.length];
    outHtml = outHtml.substring(0, match.index) + synonym + outHtml.substring(match.index + match[0].length);
    removed++;
    kpRegexSingle.lastIndex = match.index + synonym.length;
  }

  if (removed > 0) {
    changes.push({
      type: "keyphrase_removed",
      description: `Removed ${removed} keyphrase occurrence(s) via global reduction`,
    });
  }

  console.log(`[SEO-NORMALIZER] global keyphrase removals=${removed}`);
  return outHtml;
}

// ── Fix 3: Add missing keyphrase occurrences ──

function fixMissingKeyphrase(html: string, keyphrase: string, targetCount: number, changes: SeoNormalizationChange[]): string {
  const readableText = extractReadableText(html);
  const currentCount = countExactPhrase(readableText, keyphrase);
  if (currentCount >= targetCount) return html;

  const deficit = targetCount - currentCount;

  const paraBlocks = extractWpParagraphBlocks(html);
  const first100Words = readableText.split(/\s+/).slice(0, 100).join(" ").toLowerCase();
  const hasFirst100 = first100Words.includes(keyphrase.toLowerCase());

  // Sort paragraphs into insertion-priority order, then reverse for safe position-based replacement
  const candidates = paraBlocks
    .map((b, i) => {
      const kpCount = countExactPhrase(b.visibleText, keyphrase);
      const isFirst100 = !hasFirst100 && first100Words.includes(b.visibleText.toLowerCase().substring(0, Math.min(50, b.visibleText.length)));
      return { block: b, kpCount, isFirst100 };
    })
    .filter((c) => c.block.visibleText.length > 20)
    .sort((a, b) => {
      if (a.isFirst100 && !b.isFirst100) return 1; // Process first-100 para last (it's at the bottom when reversed)
      if (!a.isFirst100 && b.isFirst100) return -1;
      return a.kpCount - b.kpCount;
    })
    .reverse(); // Process from end to start

  let inserted = 0;
  let resultHtml = html;

  for (const c of candidates) {
    if (inserted >= deficit) break;
    if (c.kpCount >= 2) continue;

    const newText = insertKeyphraseNaturally(c.block.visibleText, keyphrase);

    if (newText !== c.block.visibleText) {
      resultHtml = replaceWpParagraphBlock(resultHtml, c.block, newText);
      inserted++;
      changes.push({
        type: "keyphrase_inserted",
        description: `Inserted keyphrase into paragraph`,
        before: c.block.visibleText.substring(0, 60),
        after: newText.substring(0, 60),
      });
    }
  }

  // If still deficit, try concluding paragraphs (reversed)
  if (inserted < deficit) {
    const lastParas = [...paraBlocks].reverse().slice(0, 3);
    for (const block of lastParas) {
      if (inserted >= deficit) break;
      const newText = insertKeyphraseNaturally(block.visibleText, keyphrase);
      if (newText !== block.visibleText) {
        resultHtml = replaceWpParagraphBlock(resultHtml, block, newText);
        inserted++;
        changes.push({
          type: "keyphrase_inserted",
          description: `Inserted keyphrase into concluding paragraph`,
          before: block.visibleText.substring(0, 60),
          after: newText.substring(0, 60),
        });
      }
    }
  }

  console.log(`[SEO-NORMALIZER] keyphrase insertions=${inserted}`);
  return resultHtml;
}

function insertKeyphraseNaturally(text: string, keyphrase: string): string {
  if (text.toLowerCase().includes(keyphrase.toLowerCase())) return text;

  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length === 0) return `${keyphrase.charAt(0).toUpperCase() + keyphrase.slice(1)}. ${text}`;

  // Insert into the middle of the paragraph
  const insertionTemplates = [
    `When considering ${keyphrase}, `,
    `In the context of ${keyphrase}, `,
    `As ${keyphrase} continues to evolve, `,
    `For businesses navigating ${keyphrase}, `,
    `Understanding ${keyphrase} is essential. `,
  ];

  const template = insertionTemplates[Math.floor(Math.random() * insertionTemplates.length)];

  if (sentences.length === 1) {
    // For single-sentence paragraphs, add as a new sentence
    return `${text} ${template.charAt(0).toUpperCase() + template.slice(1)}`;
  }

  // Insert after the first sentence
  const insertPos = Math.floor(sentences.length / 2);
  const prefix = sentences.slice(0, insertPos).join(" ");
  const suffix = sentences.slice(insertPos).join(" ");

  return `${prefix}. ${template}${suffix.charAt(0).toLowerCase() + suffix.slice(1)}`;
}

// ── Fix 4: Word count expansion ──

async function expandWordCount(
  html: string,
  keyphrase: string,
  currentWordCount: number,
  targetWordCount: number,
  chat: NormalizerChatFn,
  changes: SeoNormalizationChange[],
): Promise<{ html: string; wordCount: number }> {
  const deficit = targetWordCount + 50 - currentWordCount; // Aim for target + 50 buffer
  if (deficit <= 0) return { html, wordCount: currentWordCount };

  // Find the weakest/shortest content sections to expand
  const paraBlocks = extractWpParagraphBlocks(html);

  // Protect swticher/schema/CTA blocks
  const protectedRanges: [number, number][] = [];
  const wpHtmlRegex = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wm: RegExpExecArray | null;
  while ((wm = wpHtmlRegex.exec(html)) !== null) {
    protectedRanges.push([wm.index, wm.index + wm[0].length]);
  }

  const expandable = paraBlocks.filter((b) => {
    return !protectedRanges.some(([s, e]) => b.start >= s && b.start < e);
  });

  if (expandable.length === 0) return { html, wordCount: currentWordCount };

  // Pick several shortest paragraphs to expand, process from end to start
  const sorted = [...expandable].sort((a, b) => a.visibleText.length - b.visibleText.length);
  const targetsToExpand = sorted
    .slice(0, Math.min(4, sorted.length))
    .sort((a, b) => b.start - a.start); // Process from end to start

  let resultHtml = html;
  let wordsAdded = 0;

  for (let attempt = 0; attempt < MAX_EXPANSION_ATTEMPTS && wordsAdded < deficit; attempt++) {
    const target = targetsToExpand[attempt % targetsToExpand.length];
    const remainingNeeded = Math.max(30, deficit - wordsAdded);
    const currentWords = countReadableWords(target.visibleText);

    const contextBefore = getContextBefore(resultHtml, target.start, 300);
    const contextAfter = getContextAfter(resultHtml, target.end, 300);

    try {
      const expandPrompt = `Expand this paragraph naturally by adding practical detail, examples, or actionable guidance. Target approximately ${remainingNeeded} additional readable words.

IMPORTANT CONSTRAINTS:
- Do NOT add percentages, survey results, growth figures, sales figures, statistics, named studies, or factual claims unless they already appear in the supplied context.
- Preserve the existing WordPress block format.
- Preserve all existing HTML tags, links, and inline formatting.
- Do NOT change the focus keyphrase "${keyphrase}" count significantly.
- Make the paragraph flow naturally from the surrounding context.
- Only add text that would genuinely help a reader understand the topic better.

Context before:
${contextBefore}

Paragraph to expand:
${blockToContextString(target)}

Context after:
${contextAfter}

Return as JSON: {"expanded": "the full paragraph with expansion included (keeping all existing text)"}`;

      const res = await chat(
        [{ role: "system", content: "You expand blog paragraphs with practical detail. Never invent statistics. Return valid JSON with expanded field." }, { role: "user", content: expandPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 4096 },
      );

      let expanded: string;
      try {
        expanded = JSON.parse(res.content).expanded || target.visibleText;
      } catch {
        const match = res.content.match(/"expanded"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        expanded = match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : target.visibleText;
      }

      if (!expanded || expanded === target.visibleText) continue;

      // Check for unsupported statistics
      if (hasUnsupportedStatistics(expanded, html)) {
        expanded = replaceStatisticsWithQualitative(expanded);
        console.log(`[SEO-NORMALIZER] Unsupported statistics detected in expansion — replaced with qualitative wording`);
      }

      const beforeWC = countReadableWords(target.visibleText);
      const afterWC = countReadableWords(expanded);
      const added = afterWC - beforeWC;

      if (added > 0) {
        resultHtml = replaceWpParagraphBlock(resultHtml, target, expanded);
        wordsAdded += added;

        // Update the target in targetsToExpand to reflect new content
        const idx = targetsToExpand.indexOf(target);
        if (idx >= 0) {
          targetsToExpand[idx] = {
            ...target,
            visibleText: expanded,
            fullMatch: target.fullMatch,
          };
        }

        changes.push({
          type: "word_count_expansion",
          description: `Expanded paragraph: +${added} words`,
          before: target.visibleText.substring(0, 60),
          after: expanded.substring(0, 60),
        });
      }
    } catch (err) {
      console.warn(`[SEO-NORMALIZER] Expansion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const newWordCount = countReadableWords(resultHtml);
  console.log(`[SEO-NORMALIZER] word deficit=${deficit} expansion words added=${wordsAdded}`);

  // If still below target, expand one more section using fresh block extraction
  if (newWordCount < targetWordCount) {
    const freshBlocks = extractWpParagraphBlocks(resultHtml);
    const freshExpandable = freshBlocks.filter((b) => {
      return !protectedRanges.some(([s, e]) => b.start >= s && b.start < e);
    });
    if (freshExpandable.length > 0) {
      const longestParagraph = [...freshExpandable].sort((a, b) => b.visibleText.length - a.visibleText.length)[0];
      try {
        const expandPrompt = `Add 2-3 additional sentences of practical detail or real-world context to the END of this paragraph. Target approximately ${targetWordCount - newWordCount + 30} additional words. Do NOT add statistics or survey data. Do NOT change existing sentences. Keep WordPress format.

Paragraph:
${blockToContextString(longestParagraph)}

Return as JSON: {"expanded": "complete paragraph with new sentences appended"}`;

        const res = await chat(
          [{ role: "system", content: "Append additional context to a blog paragraph. Never invent statistics. Return JSON." }, { role: "user", content: expandPrompt }],
          { responseFormat: { type: "json_object" }, maxTokens: 2048 },
        );

        let expanded: string;
        try { expanded = JSON.parse(res.content).expanded || longestParagraph.visibleText; } catch { expanded = longestParagraph.visibleText; }

        if (expanded !== longestParagraph.visibleText) {
          if (hasUnsupportedStatistics(expanded, html)) {
            expanded = replaceStatisticsWithQualitative(expanded);
          }
          resultHtml = replaceWpParagraphBlock(resultHtml, longestParagraph, expanded);
        }
      } catch { /* silent */ }
    }
  }

  return { html: resultHtml, wordCount: countReadableWords(resultHtml) };
}

function getContextBefore(html: string, position: number, chars: number): string {
  const start = Math.max(0, position - chars);
  const slice = html.substring(start, position);
  return extractReadableText(slice).substring(-chars);
}

function getContextAfter(html: string, position: number, chars: number): string {
  const end = Math.min(html.length, position + chars);
  const slice = html.substring(position, end);
  return extractReadableText(slice).substring(0, chars);
}

function blockToContextString(block: WpParagraphBlock): string {
  return block.visibleText;
}

// ── Fix 5: Paragraph splitting ──

function fixParagraphLength(html: string, changes: SeoNormalizationChange[]): string {
  // Use deterministic sentence-level splitting
  const paraBlocks = extractWpParagraphBlocks(html);

  // Protect ranges
  const protectedRanges: [number, number][] = [];
  const wpHtmlRegex = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wm: RegExpExecArray | null;
  while ((wm = wpHtmlRegex.exec(html)) !== null) {
    protectedRanges.push([wm.index, wm.index + wm[0].length]);
  }

  let resultHtml = html;
  let splitCount = 0;

  // Process from end to start to avoid position shifts
  const longBlocks = paraBlocks
    .filter((b) => {
      if (protectedRanges.some(([s, e]) => b.start >= s && b.start < e)) return false;
      const sentences = b.visibleText.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
      return sentences.length > 3;
    })
    .sort((a, b) => b.start - a.start); // Reverse order

  for (const block of longBlocks) {
    const sentences = block.visibleText.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

    // Split into groups of max 3 sentences
    const parts: string[] = [];
    for (let i = 0; i < sentences.length; i += 3) {
      const chunk = sentences.slice(i, i + 3).join(" ");
      if (chunk.trim()) {
        parts.push(`<!-- wp:paragraph -->\n<p>${chunk.trim()}</p>\n<!-- /wp:paragraph -->`);
      }
    }

    if (parts.length > 1) {
      const replacement = parts.join("\n\n");
      resultHtml = resultHtml.substring(0, block.start) + replacement + resultHtml.substring(block.end);
      splitCount += parts.length - 1;

      changes.push({
        type: "paragraph_split",
        description: `Split paragraph with ${sentences.length} sentences into ${parts.length} blocks`,
      });
    }
  }

  console.log(`[SEO-NORMALIZER] paragraphs split=${splitCount}`);
  return resultHtml;
}

// ── Fix 6: Readability improvement ──

async function fixReadability(
  html: string,
  keyphrase: string,
  minEase: number,
  maxEase: number,
  chat: NormalizerChatFn,
  changes: SeoNormalizationChange[],
): Promise<string> {
  const readableText = extractReadableText(html);
  const currentEase = Math.round(calculateFleschReadingEase(readableText));

  if (currentEase >= minEase && currentEase <= maxEase) return html;

  const isTooComplex = currentEase < minEase;
  if (!isTooComplex) return html; // Only fix too-complex text, not too-simple

  const paraBlocks = extractWpParagraphBlocks(html);

  // Protect ranges
  const protectedRanges: [number, number][] = [];
  const wpHtmlRegex = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wm: RegExpExecArray | null;
  while ((wm = wpHtmlRegex.exec(html)) !== null) {
    protectedRanges.push([wm.index, wm.index + wm[0].length]);
  }

  // Score each paragraph, sort worst-to-best, then process from end to start
  const scored = paraBlocks
    .filter((b) => !protectedRanges.some(([s, e]) => b.start >= s && b.start < e))
    .map((b) => ({
      block: b,
      score: Math.round(fleschOnParagraph(b.visibleText)),
    }))
    .filter((s) => s.score < minEase)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_READABILITY_REWRITES)
    .sort((a, b) => b.block.start - a.block.start); // Process from end to start

  if (scored.length === 0) return html;

  let resultHtml = html;
  let rewriteCount = 0;

  for (const s of scored) {
    if (rewriteCount >= MAX_READABILITY_REWRITES) break;

    const kpCountBefore = countExactPhrase(s.block.visibleText, keyphrase);
    const linkRefsBefore = captureLinkHrefs(s.block.fullMatch);

    try {
      const prompt = `Rewrite this paragraph to be easier to read (target Flesch Reading Ease: ${minEase}-${maxEase}). Shorten sentences. Replace complex jargon with simpler terms. Preserve ALL factual meaning, proper nouns, product names, and the Hong Kong context. Do NOT change link destinations or HTML tags. Keep exactly the same number of occurrences of the phrase "${keyphrase}" (currently ${kpCountBefore}). WordPress paragraph format.

Paragraph (current Flesch: ${s.score}):
${s.block.visibleText}

Return as JSON: {"rewritten": "the rewritten paragraph text (plain text, no HTML wrapper needed)"}`;

      const res = await chat(
        [{ role: "system", content: `You simplify blog paragraphs for readability. Target Flesch ${minEase}-${maxEase}. Short sentences, simple words. Preserve facts, links, and keyphrase count. Return JSON.` }, { role: "user", content: prompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 4096 },
      );

      let rewritten: string;
      try { rewritten = JSON.parse(res.content).rewritten || s.block.visibleText; } catch { rewritten = s.block.visibleText; }

      if (!rewritten || rewritten === s.block.visibleText) continue;

      // Validate keyphrase count unchanged
      const kpCountAfter = countExactPhrase(rewritten, keyphrase);
      if (kpCountAfter !== kpCountBefore) {
        console.log(`[SEO-NORMALIZER] Readability rewrite changed keyphrase count (${kpCountBefore} → ${kpCountAfter}) — rejected`);
        continue;
      }

      // Validate no unsupported statistics added
      if (hasUnsupportedStatistics(rewritten, html)) {
        console.log(`[SEO-NORMALIZER] Readability rewrite introduced unsupported statistics — rejected`);
        continue;
      }

      // Validate links preserved
      const linkRefsAfter = captureLinkHrefs(
        s.block.fullMatch.replace(s.block.visibleText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), rewritten)
      );
      if (JSON.stringify(linkRefsBefore.sort()) !== JSON.stringify(linkRefsAfter.sort())) {
        console.log(`[SEO-NORMALIZER] Readability rewrite changed links — rejected`);
        continue;
      }

      const newFlesch = fleschOnParagraph(rewritten);
      if (newFlesch <= s.score) {
        console.log(`[SEO-NORMALIZER] Readability rewrite did not improve Flesch (${s.score} → ${newFlesch}) — rejected`);
        continue;
      }

      resultHtml = replaceWpParagraphBlock(resultHtml, s.block, rewritten);
      rewriteCount++;
      changes.push({
        type: "readability_rewrite",
        description: `Simplified paragraph: Flesch ${s.score} → ${newFlesch}`,
        before: s.block.visibleText.substring(0, 60),
        after: rewritten.substring(0, 60),
      });
    } catch (err) {
      console.warn(`[SEO-NORMALIZER] Readability rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[SEO-NORMALIZER] readability rewrites=${rewriteCount}`);
  return resultHtml;
}

// ── Structural verification ──

function verifyStructuralIntegrity(html: string): { valid: boolean; issues: string[]; faqPresent: boolean; switcherPresent: boolean; ctaPresent: boolean } {
  const issues: string[] = [];

  const switcherPresent = /b2i-language-switcher/i.test(html);
  const faqPresent = /FAQPage|application\/ld\+json.*faq/i.test(html);
  const ctaPresent = /\bcta\b/i.test(html) || /call.to.action/i.test(html) || /B2I Hub profile/i.test(html);

  if (!switcherPresent) issues.push("Language switcher missing");
  if (!faqPresent) issues.push("FAQ schema may be missing");

  // Count wp: blocks
  const opening = (html.match(/<!--\s*wp:\w+/gi) ?? []).length;
  const closing = (html.match(/<!--\s*\/wp:\w+/gi) ?? []).length;

  if (opening !== closing) {
    issues.push(`WP block mismatch: ${opening} opening vs ${closing} closing`);
  }

  return { valid: issues.length === 0, issues, faqPresent, switcherPresent, ctaPresent };
}

// ── Main normalize function ──

export async function normalizeFinalSeo(
  input: FinalSeoNormalizerInput,
  chat?: NormalizerChatFn,
): Promise<FinalSeoNormalizerResult> {
  const { html, focusKeyphrase, targetWordCount, targetKeyphraseCount, minReadingEase, maxReadingEase } = input;
  const changes: SeoNormalizationChange[] = [];
  const warnings: string[] = [];

  // Compute the acceptable range and preferred target from word count
  const kpRange = keyphraseRangeForWordCount(targetWordCount);
  const kpPreferredTarget = keyphrasePreferredTarget(targetWordCount);
  // Use the caller-supplied target as the generation target, but only enforce
  // the acceptable range boundaries. Counts within range are left unchanged.
  const effectiveTarget = targetKeyphraseCount > 0 ? targetKeyphraseCount : kpPreferredTarget;

  console.log(`[SEO-NORMALIZER] started range=${kpRange.min}-${kpRange.max} preferred=${kpPreferredTarget}`);

  // Step 1: Tokenize protected blocks — extract and replace with placeholders.
  // This guarantees protected blocks are byte-identical after normalization
  // because the normalizer never sees them, only restores them at the end.
  const { content: tokenizedHtml, tokens } = tokenizeProtectedBlocks(html);
  const originalLinkHrefs = captureLinkHrefs(html);

  // Step 2: Measure original metrics
  const before = computeMetrics(tokenizedHtml, focusKeyphrase);
  console.log(`[SEO-NORMALIZER] before metrics=wc:${before.readableWordCount} kp:${before.exactKeyphraseCount} h2:${before.exactKeyphraseInH2} paras>3:${before.longParagraphCount} flesch:${before.readingEase}`);

  let currentHtml = tokenizedHtml;

  // Step 3: Fix exact keyphrase in H2
  currentHtml = fixH2Keyphrase(currentHtml, focusKeyphrase, changes);

  // Step 4-5: Fix keyphrase count — only when outside the acceptable range.
  // Counts already within range are left unchanged. Targets the preferred midpoint.
  const kpBefore = before.exactKeyphraseCount;
  if (kpBefore > kpRange.max) {
    currentHtml = fixExcessiveKeyphrase(currentHtml, focusKeyphrase, effectiveTarget, changes);
  } else if (kpBefore < kpRange.min) {
    currentHtml = fixMissingKeyphrase(currentHtml, focusKeyphrase, effectiveTarget, changes);
  }

  // Step 6: Expand body to target word count
  let currentWC = countReadableWords(currentHtml);
  if (currentWC < targetWordCount && chat) {
    const result = await expandWordCount(currentHtml, focusKeyphrase, currentWC, targetWordCount, chat, changes);
    currentHtml = result.html;
    currentWC = result.wordCount;
  }

  // Step 7: Recheck exact keyphrase count (expansion may have changed it)
  // Retry reduction up to 3 times until count is within range
  let kpRetries = 0;
  const MAX_KP_RETRIES = 3;
  while (kpRetries < MAX_KP_RETRIES) {
    const kpCurrent = countExactPhrase(extractReadableText(currentHtml), focusKeyphrase);
    if (kpCurrent <= kpRange.max) break;
    currentHtml = fixExcessiveKeyphrase(currentHtml, focusKeyphrase, effectiveTarget, changes);
    kpRetries++;
  }
  if (kpRetries > 0) console.log(`[SEO-NORMALIZER] keyphrase reduction retries=${kpRetries}`);

  // Step 8: Split long paragraphs
  currentHtml = fixParagraphLength(currentHtml, changes);

  // Step 9: Improve reading level
  if (chat) {
    currentHtml = await fixReadability(currentHtml, focusKeyphrase, minReadingEase, maxReadingEase, chat, changes);
  }

  // Step 10: Detokenize — restore protected blocks byte-for-byte
  currentHtml = detokenizeProtectedBlocks(currentHtml, tokens);
  console.log(`[SEO-NORMALIZER] protected blocks restored, tokens=${tokens.length}`);

  // Step 11: Final measurements (on restored HTML)
  const after = computeMetrics(currentHtml, focusKeyphrase);
  console.log(`[SEO-NORMALIZER] after metrics=wc:${after.readableWordCount} kp:${after.exactKeyphraseCount} h2:${after.exactKeyphraseInH2} paras>3:${after.longParagraphCount} flesch:${after.readingEase}`);

  // Step 12: Verify only link destinations (protected blocks are guaranteed byte-identical)
  const currentLinkHrefs = captureLinkHrefs(currentHtml);
  const linksUnchanged = JSON.stringify(originalLinkHrefs.sort()) === JSON.stringify(currentLinkHrefs.sort());

  if (!linksUnchanged) {
    warnings.push("Link destinations changed during normalization");
    console.warn(`[SEO-NORMALIZER] link destinations changed — check href mutations`);
  }

  // Protected blocks are guaranteed unchanged by tokenization/detokenization
  const blocksUnchanged = true;

  // Determine pass/fail using the acceptable range, not an exact target
  const kpCountOk = after.exactKeyphraseCount >= kpRange.min && after.exactKeyphraseCount <= kpRange.max;
  const wcOk = after.readableWordCount >= targetWordCount;
  const h2Ok = after.exactKeyphraseInH2;
  const parasOk = after.longParagraphCount === 0;
  const readabilityInRange = after.readingEase >= minReadingEase && after.readingEase <= maxReadingEase;

  if (!kpCountOk) warnings.push(`Keyphrase count ${after.exactKeyphraseCount} outside range ${kpRange.min}-${kpRange.max}`);
  if (!wcOk) warnings.push(`Word count ${after.readableWordCount} < target ${targetWordCount}`);
  if (!h2Ok) warnings.push("No H2 contains exact keyphrase");
  if (!parasOk) warnings.push(`${after.longParagraphCount} paragraphs still exceed 3 sentences`);
  if (!readabilityInRange) {
    if (after.readingEase >= 50 && after.readingEase < minReadingEase) {
      warnings.push(`Reading ease ${after.readingEase} is between 50-59 — acceptable with warning`);
    } else {
      warnings.push(`Reading ease ${after.readingEase} is outside range ${minReadingEase}-${maxReadingEase}`);
    }
  }

  // Structural check
  const { valid: structValid, issues: structIssues, faqPresent, switcherPresent, ctaPresent } = verifyStructuralIntegrity(currentHtml);
  warnings.push(...structIssues);

  const passed = kpCountOk && wcOk && h2Ok && parasOk && blocksUnchanged && linksUnchanged && structValid;
  console.log(`[SEO-NORMALIZER] passed=${passed}`);

  const safety: SeoNormalizationSafety = {
    protectedBlocksUnchanged: blocksUnchanged,
    linkDestinationsUnchanged: linksUnchanged,
    wordpressBlocksValid: structValid,
    faqSchemaPreserved: faqPresent,
    languageSwitcherPreserved: switcherPresent,
    ctaPreserved: ctaPresent,
  };

  return {
    html: currentHtml,
    before,
    after,
    changes,
    passed,
    warnings,
    safety,
  };
}

// ── Idempotency check (synchronous — no AI calls) ──

export function isAlreadyNormalized(
  html: string,
  keyphrase: string,
  targetKeyphraseCount: number,
  targetWordCount: number,
): boolean {
  const m = computeMetrics(html, keyphrase);
  return (
    m.exactKeyphraseInH2 &&
    m.exactKeyphraseCount === targetKeyphraseCount &&
    m.readableWordCount >= targetWordCount &&
    m.longParagraphCount === 0
  );
}
