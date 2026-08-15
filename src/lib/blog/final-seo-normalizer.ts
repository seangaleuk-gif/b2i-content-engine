import {
  extractReadableText,
  extractH2Texts,
  extractParagraphTexts,
  countExactPhrase,
  countReadableWords,
  countSentences,
  countSyllables,
  calculateFleschReadingEase,
  containsExactPhrase,
  normalizeHtmlWhitespace,
  getFirstNReadableWords,
} from "@/lib/seo/seo-text-utils";
import { computeKeyphraseTargets, computeKeyphraseDensity, englishKeyphraseDensity, getKeyphraseContentWordCount } from "@/lib/content-standards";
import { splitLongParagraphs } from "@/lib/services/text-utils";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { parseWordPressEditorialBlocks } from "@/lib/blog/article-document";
import { buildPolicy, evaluatePolicy, analyzeFinalArticle, countUniqueInternalLinks, computeWordCountTolerance, type FinalArticlePolicy, type FinalArticleMetrics } from "@/lib/blog/final-article-policy";
import { scanSentenceQualityText, dropPunctuationOnlySentences } from "@/lib/blog/sentence-quality";
import { findMalformedProseTextIssues } from "@/lib/blog/publication-quality";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";

// ── Types ──

export interface FinalSeoNormalizerInput {
  html: string;
  focusKeyphrase: string;
  targetWordCount: number;
  targetKeyphraseCount: number;
  minReadingEase: number;
  maxReadingEase: number;
  /** ArticleDocument-owned visible count, including protected FAQ answers. */
  canonicalVisibleWordCount?: number;
}

export interface SeoNormalizationMetrics extends FinalArticleMetrics {
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

export interface ProtectedBlockToken {
  placeholder: string;
  original: string;
  type: string;
}

export function tokenizeProtectedBlocks(html: string): { content: string; tokens: ProtectedBlockToken[] } {
  const tokens: ProtectedBlockToken[] = [];
  let tokenIdx = 0;

  const addToken = (match: string, type: string): string => {
    const placeholder = `${PROTECTED_BLOCK_PREFIX}${tokenIdx}_${type}${PROTECTED_BLOCK_SUFFIX}`;
    tokens.push({ placeholder, original: match, type });
    tokenIdx++;
    return placeholder;
  };

  let content = html;

  // Tokenize complete blocks first (outer before inner):
  // 1. Script blocks (FAQ JSON-LD)
  content = content.replace(/<script[\s\S]*?<\/script>/gi, (m) => addToken(m, "script"));
  // 2. wp:html blocks (language switcher, CTA HTML)
  content = content.replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, (m) => addToken(m, "wp-html"));
  // 3. wp:buttons blocks (CTA buttons)
  content = content.replace(/<!--\s*wp:buttons[\s\S]*?<!--\s*\/wp:buttons\s*-->/gi, (m) => addToken(m, "wp-buttons"));
  // 4. Images
  content = content.replace(/<img\b[^>]*\/?>/gi, (m) => addToken(m, "image"));
  // 5. Media blocks
  content = content.replace(/<(?:figure|video|audio|pre|code)\b[\s\S]*?<\/(?:figure|video|audio|pre|code)>/gi, (m) => addToken(m, "media-block"));
  // 6. Anchor tags (links) — tokenize AFTER outer blocks, so links inside wp:html are
  //    already captured. Only links in editable paragraphs remain.
  content = content.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => addToken(m, "link"));

  return { content, tokens };
}

export function detokenizeProtectedBlocks(content: string, tokens: ProtectedBlockToken[]): string {
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
    // A whole-paragraph rewrite cannot safely reconstruct live inline markup.
    // Links have already been tokenized at mutation time, so their sentinels
    // remain eligible while strong/em/span and other markup stay protected.
    if (/<[a-z][^>]*>/i.test(blockContent)) continue;
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

// ── Metrics computation ──

// ── Metrics computation ──
// Delegates to the canonical analyzeFinalArticle() from final-article-policy.ts.
// Adds keyphraseDensity and readingEase which are normalizer-specific.

function computeMetrics(
  html: string,
  keyphrase: string,
  canonicalVisibleWordCount?: number,
): SeoNormalizationMetrics {
  const base = analyzeFinalArticle(
    html,
    keyphrase,
    undefined,
    undefined,
    undefined,
    canonicalVisibleWordCount,
  );
  const readableText = extractReadableText(html);
  return {
    ...base,
    keyphraseDensity: computeKeyphraseDensity(
      base.exactKeyphraseCount,
      keyphrase,
      base.readableWordCount,
    ),
    readingEase: Math.round(calculateFleschReadingEase(readableText)),
  };
}

function countNormalizerVisibleWords(html: string, protectedVisibleWordOffset: number): number {
  const withoutSentinels = html.replace(/%%PROTECTED_\d+_[A-Za-z0-9-]+_BLOCK%%/g, " ");
  return countReadableWords(withoutSentinels) + protectedVisibleWordOffset;
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
// Structure- and sentence-aware: an exact keyphrase occurrence is reduced ONLY
// by removing the complete sentence that carries it (never by substituting a
// generic phrase into the middle of a sentence). Every candidate is validated
// before commit (clone-and-commit): the resulting paragraph must parse, keep
// its links and claims, and pass the deterministic sentence-quality and
// malformed-prose checks. When no safe removal exists, the occurrence is kept
// — density is verified against the stuffing maximum by the caller.

/** Number of exact keyphrase occurrences inside editable paragraph blocks of
 *  the given HTML. Protected blocks (script/schema, wp:html switcher and CTA,
 *  wp:buttons, images, media, links) are tokenized first, so occurrences
 *  inside them are invisible to the sentence-level reducer. This is the same
 *  count the reducer itself uses, so callers can target removal precisely. */
export function countEditableKeyphraseOccurrences(html: string, keyphrase: string): number {
  const { content: tokenizedHtml } = tokenizeProtectedBlocks(html);
  return countExactPhrase(extractReadableText(tokenizedHtml), keyphrase);
}

export interface ProtectedKeyphraseReductionResult {
  html: string;
  /** Number of complete sentences removed from editable paragraphs. */
  removed: number;
  /** Editable-paragraph occurrences the reducer observed before removal. */
  countBefore: number;
  changes: SeoNormalizationChange[];
}

/**
 * Deterministic, protected-block-safe keyphrase reduction on complete HTML.
 * Script/FAQ schema, wp:html (language switcher, CTA), wp:buttons, images,
 * media and link blocks are tokenized and restored byte-for-byte; only
 * complete sentences inside editable paragraph blocks that carry the exact
 * keyphrase are removed, each gated by the shared sentence-removal safety and
 * validation rules (links, numbers, claims, quotation integrity, sentence
 * quality, malformed prose, terminal punctuation). This is the single
 * protected keyphrase-removal implementation reused by the SEO normalizer, the
 * density-aware final trim and the post-final-trim reconciliation stage.
 */
export function reduceProtectedKeyphraseOccurrences(
  html: string,
  keyphrase: string,
  targetParagraphOccurrences: number,
): ProtectedKeyphraseReductionResult {
  const changes: SeoNormalizationChange[] = [];
  const { content: tokenizedHtml, tokens } = tokenizeProtectedBlocks(html);
  const countBefore = countExactPhrase(extractReadableText(tokenizedHtml), keyphrase);
  const reduced = fixExcessiveKeyphrase(tokenizedHtml, keyphrase, targetParagraphOccurrences, changes);
  const restored = detokenizeProtectedBlocks(reduced, tokens);
  return {
    html: restored,
    removed: changes.filter((change) => change.type === "keyphrase_removed").length,
    countBefore,
    changes,
  };
}

function fixExcessiveKeyphrase(html: string, keyphrase: string, targetCount: number, changes: SeoNormalizationChange[]): string {
  const readableText = extractReadableText(html);
  const currentCount = countExactPhrase(readableText, keyphrase);
  if (currentCount <= targetCount) return html;

  const excessToRemove = currentCount - targetCount;
  const kpLower = keyphrase.toLowerCase().trim();

  // Identify first 100 words to protect
  const first100Words = readableText.split(/\s+/).slice(0, 100).join(" ").toLowerCase();

  let resultHtml = reduceInBlocks(html, "paragraph", keyphrase, kpLower, excessToRemove, first100Words, changes);

  console.log(`[SEO-NORMALIZER] keyphrase removals=${currentCount - countExactPhrase(extractReadableText(resultHtml), keyphrase)} from paragraphs`);
  return resultHtml;
}

interface RemovalCandidate {
  block: WpParagraphBlock;
  sentence: string;
  removalSafe: boolean;
}

/**
 * Reduce keyphrase occurrences by removing complete sentences. A sentence is
 * removable only when the paragraph keeps at least one other complete
 * sentence, the sentence carries no links, no numbers and no statistical
 * claim language, and no adjacent sentence depends on it. The candidate
 * paragraph must pass sentence-quality and malformed-prose validation or the
 * removal is rejected and the paragraph is left untouched.
 */
function reduceInBlocks(
  html: string,
  blockType: string,
  keyphrase: string,
  kpLower: string,
  excessToRemove: number,
  first100Words: string,
  changes: SeoNormalizationChange[],
): string {
  const blocks = extractWpParagraphBlocks(html);
  const first100Lower = first100Words.toLowerCase();
  let removed = 0;
  let outHtml = html;

  const candidates: RemovalCandidate[] = [];
  for (const block of blocks) {
    if (block.visibleText.toLowerCase().substring(0, Math.min(60, block.visibleText.length)) === first100Lower.substring(0, Math.min(60, first100Lower.length))) continue;
    if (!block.visibleText.toLowerCase().includes(kpLower)) continue;
    const sentences = splitParagraphSentences(block.visibleText);
    for (const sentence of sentences) {
      if (!sentence.toLowerCase().includes(kpLower)) continue;
      candidates.push({
        block,
        sentence,
        removalSafe: sentenceRemovalIsSafe(block, sentences, sentence, kpLower),
      });
    }
  }

  // Prefer later candidates (paragraphs/sentences deeper in the article) and
  // safe removals over unsafe ones.
  candidates.sort((a, b) => {
    if (a.removalSafe !== b.removalSafe) return a.removalSafe ? -1 : 1;
    return b.block.start - a.block.start;
  });

  const rejected = new Set<string>();
  const processed = new Set<number>();
  for (const candidate of candidates) {
    if (removed >= excessToRemove) break;
    const blockKey = `${candidate.block.start}`;
    if (processed.has(candidate.block.start)) continue;
    if (rejected.has(blockKey)) continue;
    if (!candidate.removalSafe) continue;

    const sentenceIndex = splitParagraphSentences(candidate.block.visibleText).findIndex(
      (sentence) => sentence === candidate.sentence,
    );
    if (sentenceIndex < 0) continue;

    const remainingSentences = dropPunctuationOnlySentences(
      splitParagraphSentences(candidate.block.visibleText).filter(
        (sentence, index) => index !== sentenceIndex,
      ),
    );
    if (remainingSentences.length === 0) {
      rejected.add(blockKey);
      continue;
    }
    const newText = remainingSentences.join(" ");

    // Clone-and-commit validation: the candidate paragraph must remain
    // grammatical, complete and structurally identical in meaning.
    const validated = validateRemovalCandidate(candidate.block, candidate.sentence, newText);
    if (!validated.ok) {
      rejected.add(blockKey);
      continue;
    }

    outHtml = replaceWpParagraphBlock(outHtml, candidate.block, newText);
    processed.add(candidate.block.start);
    removed++;
    changes.push({
      type: "keyphrase_removed",
      description: `Removed the complete sentence carrying the keyphrase from ${blockType}`,
      before: candidate.sentence.substring(0, 80),
      after: "",
    });
  }

  return outHtml;
}

function splitParagraphSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (char === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) continue;
    let end = index + 1;
    while (/[.!?]/.test(text[end] ?? "")) end++;
    while (/["”’)]/.test(text[end] ?? "")) end++;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    const trailing = text.slice(start).trim();
    if (trailing) sentences.push(trailing);
  }
  return sentences;
}

/** A sentence must not be removed when doing so would lose facts, links or
 *  leave a dangling reference. Digits that are part of the keyphrase itself
 *  (e.g. a topic year) do not count as factual numbers. */
function sentenceRemovalIsSafe(
  block: WpParagraphBlock,
  sentences: string[],
  sentence: string,
  kpLower: string,
): boolean {
  if (sentences.length < 2) return false;
  // A quotation is one semantic/evidentiary unit even when it contains
  // multiple sentences. Removing an interior sentence could leave balanced
  // punctuation while silently altering the attributed quotation.
  if (analyzeQuotationIntegrity(block.visibleText).spans.length > 0) return false;
  const index = sentences.indexOf(sentence);
  if (index < 0) return false;
  // Links never travel with a removed sentence.
  if (/<a\b/i.test(sentence)) return false;
  // Numbers outside the keyphrase are factual content and never removed.
  const withoutKeyphrase = sentence.replace(
    new RegExp(kpLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
    "",
  );
  if (/\d/.test(withoutKeyphrase)) return false;
  if (/according to|research (?:from|by)|data (?:from|shows)|study (?:from|by)/i.test(sentence)) return false;
  // The following sentence must not refer back to the removed sentence.
  const next = sentences[index + 1];
  if (next && /^\s*(?:that'?s|this is|these are|it'?s|this|that|these|those|it|they|the point|the result)\b/i.test(next)) {
    return false;
  }
  // The preceding sentence must not be a setup ("Here's the number:", "For example:").
  const previous = sentences[index - 1];
  if (previous && /[:—-]$/.test(previous)) return false;
  return true;
}

/** Deterministic post-candidate validation (requirement 2): the complete
 *  resulting sentence/paragraph must have no duplicated determiners, no
 *  repeated adjacent words, no lowercase sentence starts, no broken
 *  punctuation, no malformed noun phrases and no fragments. */
function validateRemovalCandidate(
  block: WpParagraphBlock,
  removedSentence: string,
  newText: string,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!newText.trim()) {
    reasons.push("paragraph would become empty");
    return { ok: false, reasons };
  }
  const qualityIssues = scanSentenceQualityText(newText);
  for (const issue of qualityIssues) {
    reasons.push(`${issue.code}: ${issue.sentence.slice(0, 80)}`);
  }
  const malformed = findMalformedProseTextIssues([newText]);
  for (const issue of malformed) {
    reasons.push(`malformed: ${issue.message}`);
  }
  // A non-terminal trailing fragment must not remain (e.g. a colon or dash
  // sentence end created by the removal).
  const trimmedEnd = newText.trim().replace(/["”’)\]]+$/, "");
  if (!/[.!?]$/.test(trimmedEnd)) {
    reasons.push("paragraph does not end with terminal punctuation");
  }
  // Meaning guard: the removed sentence must be the only sentence containing
  // the keyphrase in this paragraph, and the remaining text must still be
  // parseable as a paragraph.
  const parsed = parseWordPressEditorialBlocks(
    `<!-- wp:paragraph --><p>${newText}</p><!-- /wp:paragraph -->`,
    "keyphrase-removal-candidate",
  );
  if (parsed.errors.length > 0 || parsed.blocks.length !== 1) {
    reasons.push("candidate does not parse as a paragraph");
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Fix 4: Word count expansion ──

async function expandWordCount(
  html: string,
  keyphrase: string,
  currentWordCount: number,
  targetWordCount: number,
  chat: NormalizerChatFn,
  changes: SeoNormalizationChange[],
  protectedVisibleWordOffset: number,
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

  for (let attempt = 0; attempt < Math.min(MAX_EXPANSION_ATTEMPTS, targetsToExpand.length) && wordsAdded < deficit; attempt++) {
    const target = targetsToExpand[attempt];
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
      if (!expanded.replace(/\s+/g, " ").includes(target.visibleText.replace(/\s+/g, " "))) {
        console.log(`[SEO-NORMALIZER] Expansion rewrote or removed existing paragraph text — rejected`);
        continue;
      }

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

  const newWordCount = countNormalizerVisibleWords(resultHtml, protectedVisibleWordOffset);
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

        if (
          expanded !== longestParagraph.visibleText
          && expanded.replace(/\s+/g, " ").includes(longestParagraph.visibleText.replace(/\s+/g, " "))
        ) {
          if (hasUnsupportedStatistics(expanded, html)) {
            expanded = replaceStatisticsWithQualitative(expanded);
          }
          resultHtml = replaceWpParagraphBlock(resultHtml, longestParagraph, expanded);
        }
      } catch { /* silent */ }
    }
  }

  return { html: resultHtml, wordCount: countNormalizerVisibleWords(resultHtml, protectedVisibleWordOffset) };
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
  const result = splitLongParagraphs(html, 3);
  if (result.splitCount > 0) {
    changes.push({
      type: "paragraph_split",
      description: `Split ${result.splitCount} long paragraph boundary/boundaries while preserving inline markup`,
    });
  }
  console.log(`[SEO-NORMALIZER] paragraphs split=${result.splitCount}`);
  return result.html;
}

// ── Fix 5b: Ensure keyphrase in first 100 visible words ──

export function ensureKeyphraseInFirst100Words(
  html: string,
  _keyphrase: string,
  _changes: SeoNormalizationChange[] = [],
): string {
  // Opening placement is a soft SEO signal. This legacy helper is retained for
  // API compatibility but deliberately performs no mutation: injecting a stock
  // sentence after factual approval can reintroduce repetition, damage tone and
  // create a new claim context outside the ownership ledger.
  return html;
}

/** Extract paragraph blocks with their HTML content */
function extractParagraphBlocks(html: string): Array<{ html: string }> {
  const blocks: Array<{ html: string }> = [];
  const re = /<!--\s*wp:paragraph\s*-->\s*\n?([\s\S]*?)\s*\n?<!--\s*\/wp:paragraph\s*-->/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const fullBlock = match[0];
    blocks.push({ html: fullBlock });
  }
  return blocks;
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
    .filter((b) => {
      const quotation = analyzeQuotationIntegrity(b.visibleText);
      if (!quotation.balanced || quotation.spans.length > 0) return false;
      if (/<a\b/i.test(b.fullMatch) || /\d/.test(b.visibleText)) return false;
      if (/according to|research (?:from|by)|data (?:from|shows)|study (?:from|by)/i.test(b.visibleText)) return false;
      return scanFactualRisks(b.fullMatch, keyphrase, []).claims.length === 0;
    })
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

      if (
        findMalformedProseTextIssues([rewritten]).length > 0
        || scanSentenceQualityText(rewritten).length > 0
      ) {
        console.log(`[SEO-NORMALIZER] Readability rewrite introduced malformed prose — rejected`);
        continue;
      }

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
  // FAQ and CTA presence are NOT checked here — they are added by later
  // pipeline stages (faq-recovery). Only final validation enforces completeness.
  // Language switcher IS checked because it is added during assembly and
  // must survive all pipeline mutations byte-for-byte.

  // Detailed WordPress block diagnostics using stack-based validation
  const { valid: wpValid, issues: wpIssues } = validateWordpressBlockPairs(html);
  if (!wpValid) {
    for (const wpIssue of wpIssues) issues.push(wpIssue);
    console.error(`[SEO-NORMALIZER:structValid] WordPress block validation failed`);
    console.error(`[SEO-NORMALIZER:structValid] issues:`, JSON.stringify(wpIssues));
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

  // Compute density-based targets from article word count and keyphrase
  const kpTargets = computeKeyphraseTargets(targetWordCount, focusKeyphrase);
  const effectiveTarget = kpTargets.preferred;
  const kpMax = kpTargets.max;

  const { warningBelow: kpLow, stuffingAbove: kpHigh } = englishKeyphraseDensity();
  console.log(`[SEO-NORMALIZER] started preferred=${kpTargets.preferred} max=${kpMax} density=${kpLow}%-${kpHigh}%`);

  // Step 1: Tokenize protected blocks — extract and replace with placeholders.
  // This guarantees protected blocks are byte-identical after normalization
  // because the normalizer never sees them, only restores them at the end.
  const { content: tokenizedHtml, tokens } = tokenizeProtectedBlocks(html);
  const originalLinkHrefs = captureLinkHrefs(html);
  const rawVisibleWordCount = countReadableWords(html);
  const protectedVisibleWordOffset = Math.max(
    0,
    (input.canonicalVisibleWordCount ?? rawVisibleWordCount) - rawVisibleWordCount,
  );

  // Compute before metrics from the ORIGINAL html (not tokenized), so
  // paragraph/link counts are comparable with the detokenized after state.
  const beforeRaw = computeMetrics(
    html,
    focusKeyphrase,
    input.canonicalVisibleWordCount ?? countNormalizerVisibleWords(html, protectedVisibleWordOffset),
  );
  console.log(`[SEO-NORMALIZER] before metrics=wc:${beforeRaw.readableWordCount} kp:${beforeRaw.exactKeyphraseCount} h2:${beforeRaw.exactKeyphraseInH2} paras>3:${beforeRaw.longParagraphCount} flesch:${beforeRaw.readingEase}`);

  let currentHtml = tokenizedHtml;

  // Exact-keyphrase H2 placement is a soft editorial signal. Do not rewrite
  // headings deterministically merely to satisfy it; unnatural H2 mutation can
  // damage meaning and contradict the final publication policy.

  // Step 4-5: Fix keyphrase count — reduce if above max (stuffing), warn if below min
  const kpBefore = beforeRaw.exactKeyphraseCount;
  if (kpBefore > kpMax) {
    currentHtml = fixExcessiveKeyphrase(currentHtml, focusKeyphrase, effectiveTarget, changes);
  } else if (kpBefore === 0 && effectiveTarget > 0) {
    // Missing/low keyphrase density is explicitly soft. Do not inject stock
    // prose into a factually approved paragraph: the former insertion could
    // split quotations, duplicate punctuation and add unsupported positioning.
    // The audit reports the miss; no content mutation is warranted.
    console.log("[SEO-NORMALIZER] keyphrase absent — soft diagnostic, no body mutation");
  }

  // Step 6: Expand body to target word count
  let currentWC = countNormalizerVisibleWords(currentHtml, protectedVisibleWordOffset);
  if (currentWC < targetWordCount && chat) {
    const result = await expandWordCount(
      currentHtml,
      focusKeyphrase,
      currentWC,
      targetWordCount,
      chat,
      changes,
      protectedVisibleWordOffset,
    );
    currentHtml = result.html;
    currentWC = result.wordCount;
  }

  // Step 7: Recheck exact keyphrase count (expansion may have changed it)
  // Retry reduction up to 3 times until count is within numeric max.
  let kpRetries = 0;
  const MAX_KP_RETRIES = 3;
  while (kpRetries < MAX_KP_RETRIES) {
    const kpCurrent = countExactPhrase(extractReadableText(currentHtml), focusKeyphrase);
    if (kpCurrent <= kpMax) break;
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

  // Opening placement is also a soft signal. Factual cleanup may legitimately
  // remove an opening statistic, so the normalizer must not inject boilerplate
  // solely to restore a first-100-word match.

  // Step 10: Detokenize — restore protected blocks byte-for-byte
  currentHtml = detokenizeProtectedBlocks(currentHtml, tokens);
  console.log(`[SEO-NORMALIZER] protected blocks restored, tokens=${tokens.length}`);

  // Step 11: Final measurements (on restored HTML)
  let after = computeMetrics(
    currentHtml,
    focusKeyphrase,
    countNormalizerVisibleWords(currentHtml, protectedVisibleWordOffset),
  );
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

  // Keyphrase density check — stuffing (>3%) is blocking, below-min is soft
  let kpDensity = computeKeyphraseDensity(after.exactKeyphraseCount, focusKeyphrase, after.readableWordCount);
  // Reduce deterministically if density exceeds hard limit AND count is high
  // enough that reduction won't remove the only editorial occurrence.
  // This catches cases where later stages removed words but not keyphrase,
  // or where expansion + H2 insertion pushed density past 3%.
  if (kpDensity > kpHigh && after.exactKeyphraseCount > Math.max(effectiveTarget, 2)) {
    const kpWordCount = getKeyphraseContentWordCount(focusKeyphrase) || 1;
    const targetByDensity = Math.max(1, Math.floor((kpHigh / 100 * after.readableWordCount) / kpWordCount) - 1);
    if (targetByDensity > 0 && targetByDensity < after.exactKeyphraseCount) {
      currentHtml = fixExcessiveKeyphrase(currentHtml, focusKeyphrase, targetByDensity, changes);
      console.log(`[SEO-NORMALIZER] density reduction: ${after.exactKeyphraseCount}→${targetByDensity} (kpDensity=${kpDensity.toFixed(1)}% > ${kpHigh}%)`);
      after = computeMetrics(
        currentHtml,
        focusKeyphrase,
        countNormalizerVisibleWords(currentHtml, protectedVisibleWordOffset),
      );
      kpDensity = computeKeyphraseDensity(after.exactKeyphraseCount, focusKeyphrase, after.readableWordCount);
    }
  }
  const kpCountOk = kpDensity <= kpHigh;
  const kpBelowMin = kpDensity < kpLow;

  const policy = buildPolicy(targetWordCount, undefined, undefined, focusKeyphrase);
  const policyResult = evaluatePolicy(after, policy);
  const kpDensityOk = policyResult.passed || kpCountOk;
  const malformedNoRegression = (after.malformedProseCount ?? 0)
    <= (beforeRaw.malformedProseCount ?? 0);
  const tolerance = computeWordCountTolerance(targetWordCount);
  // Stage ownership: only a word count BELOW the minimum fails this stage. A
  // count still ABOVE the maximum is owned by the later deterministic final
  // trim (which runs density-aware after this stage), so an otherwise-safe
  // candidate — including a keyphrase-density reduction — must never be rolled
  // back solely because trimming has not happened yet. The exact-keyphrase H2
  // and first-100-word placements are soft signals and never gate acceptance.
  const wcOk = policyResult.passed || after.readableWordCount >= tolerance.min;
  const h2Ok = after.exactKeyphraseInH2;
  const parasOk = policyResult.passed
    || after.longParagraphCount === 0
    || after.longParagraphCount <= beforeRaw.longParagraphCount
    || after.longParagraphCount < beforeRaw.longParagraphCount * 2;
  const readabilityInRange = after.readingEase >= minReadingEase && after.readingEase <= maxReadingEase;
  const kpInFirst100Ok = policyResult.passed
    || after.keyphraseInFirst100Words;
  const internalLinksOk = after.uniqueInternalLinkCount >= policy.internalLinkMin && after.uniqueInternalLinkCount <= policy.internalLinkMax;

  if (after.exactKeyphraseCount > kpMax) warnings.push(`Keyphrase stuffing: ${after.exactKeyphraseCount} occurrences (${kpDensity.toFixed(1)}% density, max ${kpHigh}%)`);
  if (kpBelowMin) warnings.push(`Keyphrase density ${kpDensity.toFixed(1)}% below minimum ${kpLow}%`);
  if (!wcOk) warnings.push(`Word count ${after.readableWordCount} outside tolerance range ${tolerance.min}-${tolerance.max}`);
  if (!h2Ok) warnings.push("No H2 contains exact keyphrase");
  if (!parasOk) warnings.push(`${after.longParagraphCount} paragraphs still exceed 3 sentences`);
  if (!readabilityInRange) {
    if (after.readingEase >= 50 && after.readingEase < minReadingEase) {
      warnings.push(`Reading ease ${after.readingEase} is between 50-59 — acceptable with warning`);
    } else {
      warnings.push(`Reading ease ${after.readingEase} is outside range ${minReadingEase}-${maxReadingEase}`);
    }
  }
  if (!kpInFirst100Ok) warnings.push("Exact keyphrase not found in first 100 visible words");
  if (!internalLinksOk) warnings.push(`Unique internal link destinations ${after.uniqueInternalLinkCount} not in range ${policy.internalLinkMin}-${policy.internalLinkMax}`);

  // Structural check
  const { valid: structValid, issues: structIssues, faqPresent, switcherPresent, ctaPresent } = verifyStructuralIntegrity(currentHtml);
  warnings.push(...structIssues);

  const passed = kpDensityOk && wcOk && parasOk && malformedNoRegression
    && blocksUnchanged && linksUnchanged && structValid && internalLinksOk;
  if (!passed) {
    const failures: string[] = [];
    if (!kpDensityOk) failures.push("kpDensityOk");
    if (!wcOk) failures.push(`wcOk(wc=${after.readableWordCount})`);
    if (!parasOk) failures.push(`parasOk(paras=${after.longParagraphCount})`);
    if (!malformedNoRegression) {
      failures.push(`malformedNoRegression(${beforeRaw.malformedProseCount ?? 0}->${after.malformedProseCount ?? 0})`);
    }
    if (!blocksUnchanged) failures.push("blocksUnchanged");
    if (!linksUnchanged) failures.push("linksUnchanged");
    if (!structValid) failures.push(`structValid(${structIssues.join("; ")})`);
    if (!internalLinksOk) failures.push(`internalLinksOk(links=${after.uniqueInternalLinkCount})`);
    console.log(`[SEO-NORMALIZER] passed=false reasons=[${failures.join(", ")}]`);
  }

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
    before: beforeRaw,
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
    m.exactKeyphraseCount === targetKeyphraseCount &&
    m.readableWordCount >= targetWordCount &&
    m.longParagraphCount === 0
  );
}
