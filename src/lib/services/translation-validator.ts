// ── Number protection ──

import { createNumberExpressionRegex } from "./translation-number-grammar";

const NUMBER_PROTECT_RE = createNumberExpressionRegex();

export function protectNumbersInHtml(html: string): {
  protectedHtml: string;
  placeholders: string[];
  originalValues: string[];
} {
  const placeholders: string[] = [];
  const originalValues: string[] = [];
  let index = 0;
  const segments = html.split(/(<[^>]*>)/);
  const protectedSegments = segments.map((segment) => {
    if (segment.startsWith("<")) return segment;
    return segment.replace(NUMBER_PROTECT_RE, (match) => {
      placeholders.push(`__NUM_${index}__`);
      originalValues.push(match);
      return `__NUM_${index++}__`;
    });
  });
  return { protectedHtml: protectedSegments.join(""), placeholders, originalValues };
}

export function tryRestoreNumbersInHtml(
  html: string,
  placeholders: string[],
  originalValues: string[],
): { html: string; lost: string[]; extras: string[]; ok: boolean } {
  const lost: string[] = [];
  const extras: string[] = [];
  for (let i = 0; i < placeholders.length; i++) {
    const ph = placeholders[i];
    const escaped = ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = (html.match(new RegExp(escaped, "g")) || []).length;
    if (count === 0) lost.push(originalValues[i]);
    else if (count > 1) extras.push(originalValues[i]);
  }
  const unknownPhs = html.match(/__NUM_\d+__/g) || [];
  const knownSet = new Set(placeholders);
  for (const ph of unknownPhs) { if (!knownSet.has(ph)) extras.push(ph); }
  const ok = lost.length === 0 && extras.length === 0;
  let result = html;
  for (let i = 0; i < placeholders.length; i++) {
    if (lost.includes(originalValues[i])) continue;
    const escaped = placeholders[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), originalValues[i]);
  }
  return { html: result, lost, extras, ok };
}

// ── Number preservation (legacy) ──

export function extractVisibleNumbers(html: string): string[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const numbers: string[] = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/g;
  let m; while ((m = re.exec(cleaned)) !== null) numbers.push(m[0]);
  return numbers;
}

export function normalizeNumber(n: string): string {
  return n.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "").trim();
}

export function extractScaledNumbers(html: string): { raw: string; scaled: string }[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const results: { raw: string; scaled: string }[] = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const match = m[0];
    const isPercent = /[%％]/.test(match);
    const cleanMatch = match.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "");
    const numPart = parseFloat(cleanMatch);
    const after = body.substring(m.index + match.length, m.index + match.length + 12).toLowerCase();
    let scale = 1; let hasScale = false;
    const engWord = after.match(/^\s*(thousand|million|billion|trillion)\b/);
    if (engWord) { const w = engWord[1]; if (w === "thousand") { scale = 1_000; hasScale = true; } else if (w === "million") { scale = 1_000_000; hasScale = true; } else if (w === "billion") { scale = 1_000_000_000; hasScale = true; } }
    const zhChar = after.match(/^\s*(千|萬|億)\s*/);
    if (zhChar) { const ch = zhChar[1]; if (ch === "千") { scale = 1_000; hasScale = true; } else if (ch === "萬") { scale = 10_000; hasScale = true; } else if (ch === "億") { scale = 100_000_000; hasScale = true; } }
    const hasHkdSuffix = !!after.match(/^\s*(?:[千萬億]\s*)?港元的?/);
    const hasHkdPrefix = /^HK?\$/.test(match);
    const hasUsdPrefix = /^US?\$/.test(match) && !hasHkdPrefix;
    const scaledValue = isPercent ? `%:${numPart}`
      : hasScale ? `${hasHkdPrefix || hasHkdSuffix ? "HKD:" : hasUsdPrefix ? "USD:" : ""}${Math.round(numPart * scale)}`
      : hasHkdPrefix || hasHkdSuffix ? `HKD:${numPart}`
      : /^\d+$/.test(String(numPart)) ? String(numPart) : String(numPart).replace(/\.0$/, "");
    results.push({ raw: match, scaled: scaledValue });
  }
  return results;
}

export function checkNumbersPreserved(source: string, translated: string): { lost: string[]; extras: string[] } {
  const srcNums = extractScaledNumbers(source).map((n) => n.scaled);
  const tgtNums = extractScaledNumbers(translated).map((n) => n.scaled);
  const srcCounts: Record<string, number> = {}; const tgtCounts: Record<string, number> = {};
  for (const n of srcNums) srcCounts[n] = (srcCounts[n] || 0) + 1;
  for (const n of tgtNums) tgtCounts[n] = (tgtCounts[n] || 0) + 1;
  const lost: string[] = []; const extras: string[] = [];
  for (const [n, c] of Object.entries(srcCounts)) { const tgtC = tgtCounts[n] || 0; if (tgtC < c) lost.push(...Array(c - tgtC).fill(n)); }
  for (const [n, c] of Object.entries(tgtCounts)) { const srcC = srcCounts[n] || 0; if (srcC < c) extras.push(...Array(c - srcC).fill(n)); }
  return { lost, extras };
}

// ── Completeness & English leakage ──

const COMPLETENESS_RATIO = 0.25;

export function visibleChars(html: string): number {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

export function checkCompleteness(source: string, translated: string, component: string): { passed: boolean; sourceChars: number; translatedChars: number; ratio: number } {
  const sourceChars = visibleChars(source);
  const rawTranslatedChars = visibleChars(translated);
  // CJK characters carry meaning far more densely than Latin script, so a
  // legitimate Chinese translation of short content is naturally compact
  // (e.g. "Click here" → "按此": 10 Latin chars → 2 CJK chars). Weight CJK
  // characters when measuring the effective translated length so valid
  // translations are not discarded as "incomplete". The completeness
  // threshold itself is unchanged; this only corrects the metric for the
  // target language.
  const cjkChars = countCjkChars(translated);
  const translatedChars = rawTranslatedChars + cjkChars;
  const ratio = sourceChars > 0 ? translatedChars / sourceChars : 1;
  const passed = ratio >= COMPLETENESS_RATIO
    && !hasExcessiveEnglish(translated)
    && !hasEnglishHeavyProseBlock(translated);
  return { passed, sourceChars, translatedChars, ratio };
}

export function hasExcessiveEnglish(text: string): boolean {
  const cleaned = stripCitationSourceTitles(text)
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const engRuns = cleaned.match(/\b([A-Za-z]{2,}\s+){4,}[A-Za-z]{2,}\b/g) || [];
  if (engRuns.length === 0) return false;
  return engRuns.join(" ").length > cleaned.length * 0.10;
}

// ── Citation-label exemption ──
// A citation paragraph such as 「來源：<a href="...">English research title</a>」
// or 「來源：English research title」 legitimately carries an English source title
// (an external evidence title that is preserved as a proper noun). The whole
// citation-label block is a source-title line and must not count toward
// English-leakage detection — whether the title is linked or plain text. Only
// blocks that start with a citation label are exempted — ordinary English
// paragraphs, headings and untranslated prose are still detected.

const CITATION_LABEL_RE = /^\s*(?:來源|資料來源|Source)\s*[：:]/iu;

function isCitationLabelBlock(blockHtml: string): boolean {
  const visible = blockHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return CITATION_LABEL_RE.test(visible);
}

/** Remove the complete source-title content inside citation-label blocks (linked or plain-text). */
export function stripCitationSourceTitles(html: string): string {
  return html.replace(/<(p|li|h3|td|th)\b[^>]*>[\s\S]*?<\/\1>/gi, (block: string) => {
    if (!isCitationLabelBlock(block)) return block;
    // Exclude the entire citation-label block: the label marks a source-title
    // line, so any English after it is a preserved source title, not leakage.
    return "";
  });
}

/**
 * English-leakage check at the prose-block granularity used by the final
 * Chinese editorial gate. A component whose overall text is mostly Chinese can
 * hide a single untranslated English block (the whole-component
 * `hasExcessiveEnglish` check measures the English run against the entire
 * component, so one English block in a large component can fall below 10%).
 * Every component-level gate must reject the same English-heavy blocks the
 * final validation rejects, or a repair can be accepted at the component gate
 * and then rejected by the final gate. Citation-label blocks are exempted from
 * the English run because their source titles (linked or plain-text) are
 * preserved evidence, not untranslated prose.
 */
export function hasEnglishHeavyProseBlock(html: string): boolean {
  const proseBlocks = [...html.matchAll(/<(?:p|li|h3|td|th)\b[^>]*>([\s\S]*?)<\/(?:p|li|h3|td|th)>/gi)]
    .map((match) => ({ blockHtml: match[0], inner: match[1] }));
  return proseBlocks.some(({ blockHtml, inner }) => {
    if (isCitationLabelBlock(blockHtml)) {
      // Citation-label blocks are source-title lines (linked or plain-text
      // English title); exclude them entirely from English-leak counting.
      return false;
    }
    const cleaned = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > 0 && hasExcessiveEnglish(cleaned);
  });
}

// ── Source-echo guard ──
// Deterministic protection against unchanged English responses being accepted
// as translations. The consecutive-English-word detector above misses echoes
// whose word runs are interrupted by numbers, percentages or dates (e.g.
// "Hello World with 25% growth"), so candidates whose meaningful text is
// effectively unchanged from the source are rejected before acceptance and
// continue into the repair/retry and structured-fallback flow.

/** Minimum whitespace-delimited Latin tokens the source must contain before an
 *  unchanged response may be classified as a meaningful-English echo. */
export const MIN_ECHO_LATIN_WORDS = 3;
/** Minimum Latin letters inside lowercase-bearing pure-alpha tokens before an
 *  unchanged response may be classified as a meaningful-English echo. */
export const MIN_ECHO_LATIN_LETTERS = 12;

function decodeHtmlEntitiesForComparison(text: string): string {
  return text
    .replace(/&nbsp;/gi, "\u00A0")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Decoded last so "&amp;nbsp;" stays the literal text "&nbsp;".
    .replace(/&amp;/gi, "&");
}

/** Deterministic normalization of HTML for source-echo comparison.
 *  Decodes HTML entities, removes comments and complete script/style blocks,
 *  replaces tags with spaces (so `<p>Hello</p><p>World</p>` becomes
 *  "hello world", never "helloworld"), applies NFKC Unicode normalization,
 *  collapses whitespace, trims, and folds case. Numbers, percentages,
 *  punctuation, brand names, protected placeholders and meaningful text
 *  tokens are all preserved. */
export function normalizeTranslationComparisonText(html: string): string {
  return decodeHtmlEntitiesForComparison(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the translated candidate is effectively unchanged from the
 * English source AND the source contains enough meaningful Latin-script
 * prose to justify translation.
 *
 * Short token-only blocks ("25%", "2025", "Meta", "Meta、Threads、Instagram")
 * are never echoes because countLatinWords counts whitespace-delimited tokens
 * (a CJK-punctuation-joined brand list is one token), and the letter count
 * only considers pure-alpha tokens containing a lowercase letter (an
 * ALL-CAPS brand list contributes nothing).
 *
 * A bilingual sentence containing meaningful untranslated English prose
 * ("Use 「香港創作者」 when describing local creators.") IS an echo; the
 * presence of Chinese characters does not exempt it.
 */
export function isSourceEcho(source: string, translated: string): boolean {
  const normalizedSource = normalizeTranslationComparisonText(source);
  const normalizedTranslated = normalizeTranslationComparisonText(translated);

  if (!normalizedSource || !normalizedTranslated) return false;
  if (normalizedSource !== normalizedTranslated) return false;

  // Meaningful-Latin-prose word count: whitespace-delimited tokens that
  // contain letters but NO digits. Number-bearing constructs ("hk$500",
  // "2.4m", "2025") never count as prose words, so short token blocks such
  // as "HK$500 and 50% off" (2 prose words) are not echoes while "Hello
  // World with 25% growth" (4 prose words) is. CJK-punctuation-joined brand
  // lists ("Meta、Threads、Instagram") are a single token, never three.
  const latinWords = normalizedSource
    .split(/\s+/)
    .filter((token) => /[a-zA-Z]/.test(token) && !/\d/.test(token))
    .length;

  // Letter count considers only pure-alpha tokens containing a lowercase
  // letter, so an ALL-CAPS brand list contributes nothing while prose
  // (even joined without spaces) still does.
  const latinLetterCount = normalizedSource
    .split(/\s+/)
    .filter((token) => /^[A-Za-z]+$/.test(token) && /[a-z]/.test(token))
    .join("")
    .match(/[A-Za-z]/g)?.length ?? 0;

  return latinWords >= MIN_ECHO_LATIN_WORDS || latinLetterCount >= MIN_ECHO_LATIN_LETTERS;
}

// ── Link checks ──

export function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m; while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
}

export function checkLinksPreserved(source: string, translated: string): string[] {
  const srcLinks = extractLinks(source);
  const tgtLinks = extractLinks(translated);
  return srcLinks.filter((l) => !tgtLinks.includes(l) && !l.startsWith("#"));
}

export function checkNoNewUrls(source: string, translated: string): string[] {
  const srcLinks = extractLinks(source);
  const tgtLinks = extractLinks(translated);
  return tgtLinks.filter((l) => !srcLinks.includes(l) && !l.startsWith("#") && !l.startsWith("/blog/") && !l.includes("b2ihub.com"));
}

// ── Chinese length metrics ──

export function countCjkChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
}

export function countLatinWords(text: string): number {
  const cleaned = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\s]+/g, " ").trim();
  return cleaned ? cleaned.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length : 0;
}

export function countParagraphs(html: string): number {
  return (html.match(/<\/p>/gi) || []).length + (html.match(/<\/li>/gi) || []).length;
}

export function estimatedReadingTime(cjkChars: number, latinWords: number): number {
  return Math.max(1, Math.ceil(cjkChars / 300 + latinWords / 200));
}

export function chineseLengthMetrics(html: string): {
  zhCharCount: number;
  latinWordCount: number;
  paragraphCount: number;
  estimatedReadingMinutes: number;
} {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const zhCharCount = countCjkChars(body);
  const latinWordCount = countLatinWords(body);
  const paragraphCount = countParagraphs(html);
  return { zhCharCount, latinWordCount, paragraphCount, estimatedReadingMinutes: estimatedReadingTime(zhCharCount, latinWordCount) };
}
