// ── Canonical Final Article Policy ──
// ALL final article postconditions are defined here.
// analyzeFinalArticle() computes every metric.
// evaluatePolicy() is the single pass/fail gate.
// No other validator, invariant check, or fallback gate may override this result.

import {
  extractReadableText,
  extractH2Texts,
  extractParagraphTexts,
  countExactPhrase,
  countReadableWords,
  countSentences,
  getFirstNReadableWords,
  countCtaHeadingTags,
  hasLanguageSwitcher,
} from "@/lib/seo/seo-text-utils";
import { detectNestedParagraphs, extractVisibleFaqFromArticle, validateFaqParity, CONCLUSION_START_MARKER, CONCLUSION_END_MARKER, FAQ_HEADING_MARKER } from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import {
  paragraphSentenceLimit,
  englishKeyphraseDensity,
  computeKeyphraseDensity,
  computeKeyphraseTargets,
  dynamicH2Range,
  dynamicFaqRange,
  internalLinkRange,
  englishWordTolerance,
  englishTitleRange,
} from "@/lib/content-standards";
import { analyzePublicationQuality } from "@/lib/blog/publication-quality";

/** Legacy alias — prefer englishWordTolerance from content-standards. */
export const computeWordCountTolerance = englishWordTolerance;

// ── Policy ──

export interface FinalArticlePolicy {
  wordCountMin: number;
  wordCountMax: number;
  h2Min: number;
  h2Max: number;
  faqEntryMin: number;
  faqEntryMax: number;
  keyphraseCountMin: number;
  keyphraseCountMax: number;
  titleMinLength: number;
  titleMaxLength: number;
  maxSentencesPerParagraph: number;
  internalLinkMin: number;
  internalLinkMax: number;
  requireLanguageSwitcher: boolean;
  requiredCtaHeadingCount: number;
  requiredSignupUrlCount: number;
  requiredFaqBlockCount: number;
  requiredFaqJsonLdCount: number;
  requiredWpBlockBalance: boolean;
  requiredFaqParity: boolean;
  maxClaimConflicts: number;
  maxMalformedProseIssues: number;
  maxRepeatedIdeaPairs: number;
  maxConclusionWordRatio: number;
  maxConclusionNewNumericClaims: number;
  minimumFactualScore: number;
  minimumEditorialScore: number;
  enforcePublicationQuality: boolean;
}

export function buildPolicy(
  requestedWordCount: number,
  wordCountMin?: number,
  wordCountMax?: number,
  keyphrase?: string,
): FinalArticlePolicy {
  const kpTargets = keyphrase ? computeKeyphraseTargets(requestedWordCount, keyphrase) : { min: 1, max: Math.ceil(requestedWordCount / 50), preferred: 1 };
  const tolerance = englishWordTolerance(requestedWordCount);
  const { min: titleMin, max: titleMax } = englishTitleRange();
  const { min: h2Min, max: h2Max } = dynamicH2Range(requestedWordCount);
  const { min: faqEntryMin, max: faqEntryMax } = dynamicFaqRange(requestedWordCount);
  const { min: linkMin, max: linkMax } = internalLinkRange();
  return {
    wordCountMin: wordCountMin ?? tolerance.min,
    wordCountMax: wordCountMax ?? tolerance.max,
    h2Min,
    h2Max,
    faqEntryMin,
    faqEntryMax,
    keyphraseCountMin: 0,
    keyphraseCountMax: kpTargets.max,
    titleMinLength: titleMin,
    titleMaxLength: titleMax,
    maxSentencesPerParagraph: paragraphSentenceLimit(),
    internalLinkMin: linkMin,
    internalLinkMax: linkMax,
    requireLanguageSwitcher: true,
    requiredCtaHeadingCount: 1,
    requiredSignupUrlCount: 1,
    requiredFaqBlockCount: 1,
    requiredFaqJsonLdCount: 1,
    requiredWpBlockBalance: true,
    requiredFaqParity: true,
    maxClaimConflicts: 0,
    maxMalformedProseIssues: 0,
    maxRepeatedIdeaPairs: 3,
    maxConclusionWordRatio: 0.18,
    maxConclusionNewNumericClaims: 0,
    minimumFactualScore: 100,
    minimumEditorialScore: 80,
    enforcePublicationQuality: process.env.ENABLE_EDITORIAL_POLISH === "true",
  };
}

// ── Unified metrics ──

export interface FinalArticleMetrics {
  readableWordCount: number;
  h2Count: number;
  faqEntryCount: number;
  exactKeyphraseCount: number;
  keyphraseDensity: number;
  exactKeyphraseInH2: boolean;
  longParagraphCount: number;
  keyphraseInFirst100Words: boolean;
  uniqueInternalLinkCount: number;
  externalSourceLinkCount: number;
  ctaHeadingCount: number;
  signupUrlCount: number;
  faqBlockCount: number;
  faqJsonLdCount: number;
  hasLanguageSwitcher: boolean;
  nestedParagraphCount: number;
  malformedHeadingCount: number;
  wpBlockCountMismatch: boolean;
  faqParityValid: boolean;
  titleLength: number;
  metaDescriptionLength: number;
  fleschReadingEase: number;
  hasPlaceholderContent: boolean;
  hasRawProseOutsideBlocks: boolean;
  duplicateFaqSchemaCount: number;
  duplicateCtaBlockCount: number;
  hasConclusionContent: boolean;
  claimConflictCount?: number;
  malformedProseCount?: number;
  repeatedIdeaPairCount?: number;
  roboticPhraseCount?: number;
  conclusionWordCount?: number;
  conclusionWordRatio?: number;
  conclusionNewNumericClaimCount?: number;
  factualScore?: number;
  editorialScore?: number;
}

// ── Helpers ──

export function countUniqueInternalLinks(html: string): number {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(stripped)) !== null) {
    const href = m[1];
    if (href.startsWith("/#")) continue;
    if (/signup/i.test(href)) continue;
    if (/auth\//i.test(href)) continue;
    if (/^\/(?:knowledge|playground|projects|prompts|settings|profile|login|signout)/i.test(href)) continue;
    if (href.startsWith("/blog/")) {
      seen.add(href.replace(/\/$/, ""));
    } else if (/^https?:\/\/b2ihub\.com\/blog\//i.test(href)) {
      seen.add(href.replace(/^https?:\/\/b2ihub\.com/i, "").replace(/\/$/, ""));
    }
  }
  return seen.size;
}

export function countExternalSourceLinks(html: string): number {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(stripped)) !== null) {
    const href = m[1];
    if (!/^https?:\/\//i.test(href)) continue;
    if (/b2ihub\.com/i.test(href)) continue;
    if (/signup|auth|login|facebook\.com|instagram\.com|twitter\.com|linkedin\.com|threads\.net/i.test(href)) continue;
    seen.add(href.replace(/\/$/, ""));
  }
  return seen.size;
}

export function enforceInternalLinkLimit(
  html: string,
  maxLinks: number = 4,
): { html: string; retained: string[]; removed: string[] } {
  const protectedRanges: Array<[number, number]> = [];
  const wpHtmlRe = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wm2: RegExpExecArray | null;
  while ((wm2 = wpHtmlRe.exec(html)) !== null) {
    protectedRanges.push([wm2.index, wm2.index + wm2[0].length]);
  }
  const scriptRe = /<script[\s\S]*?<\/script>/gi;
  let sm2: RegExpExecArray | null;
  while ((sm2 = scriptRe.exec(html)) !== null) {
    protectedRanges.push([sm2.index, sm2.index + sm2[0].length]);
  }
  protectedRanges.sort((a, b) => a[0] - b[0]);

  function isProtected(pos: number): boolean {
    for (const [s, e] of protectedRanges) {
      if (pos >= s && pos < e) return true;
      if (s > pos) break;
    }
    return false;
  }

  interface EditorialLink {
    fullTag: string;
    href: string;
    start: number;
    end: number;
    anchorText: string;
  }

  const allLinks: EditorialLink[] = [];
  const aRe = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let am: RegExpExecArray | null;
  while ((am = aRe.exec(html)) !== null) {
    const href = am[1];
    const start = am.index;
    const end = start + am[0].length;
    if (isProtected(start)) continue;
    if (/signup/i.test(href)) continue;
    if (/auth\//i.test(href)) continue;
    if (/^\/(?:knowledge|playground|projects|prompts|settings|profile|login|signout)/i.test(href)) continue;
    if (href.startsWith("/#")) continue;
    let normalized = href;
    if (/^https?:\/\/b2ihub\.com\/blog\//i.test(href)) {
      normalized = href.replace(/^https?:\/\/b2ihub\.com/i, "").replace(/\/$/, "");
    }
    if (!normalized.startsWith("/blog/")) continue;
    const anchorText = am[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    allLinks.push({ fullTag: am[0], href: normalized.replace(/\/$/, ""), start, end, anchorText });
  }

  const byDest = new Map<string, EditorialLink[]>();
  for (const link of allLinks) {
    const dest = link.href;
    if (!byDest.has(dest)) byDest.set(dest, []);
    byDest.get(dest)!.push(link);
  }

  const retained: string[] = [];
  const removed: string[] = [];

  if (byDest.size <= maxLinks) {
    for (const [dest] of byDest) retained.push(dest);
    return { html, retained, removed };
  }

  const sorted = [...byDest.entries()].sort((a, b) => a[1][0].start - b[1][0].start);
  const kept = sorted.slice(0, maxLinks);
  const excess = sorted.slice(maxLinks);

  for (const [, links] of kept) {
    retained.push(links[0].href);
  }

  const toUnwrap: Array<{ start: number; end: number; href: string }> = [];
  for (const [dest, links] of excess) {
    for (const link of links) {
      toUnwrap.push({ start: link.start, end: link.end, href: dest });
      removed.push(dest);
    }
  }
  toUnwrap.sort((a, b) => b.start - a.start);

  let result = html;
  for (const uw of toUnwrap) {
    const originalTag = result.substring(uw.start, uw.end);
    const aContent = originalTag.replace(/^<a\b[^>]*>/, "").replace(/<\/a>$/, "");
    result = result.substring(0, uw.start) + aContent + result.substring(uw.end);
  }

  console.log(`[link-enforce] retained=${retained.length} removed=${removed.length}`);
  for (const r of removed) console.log(`[link-enforce] removed link: ${r}`);

  return { html: result, retained, removed };
}

// ── Canonical analyzer ──

export function analyzeFinalArticle(
  html: string,
  keyphrase: string,
  title?: string,
  metaDescription?: string,
  targetWordCount?: number,
  canonicalVisibleWordCount?: number,
): FinalArticleMetrics {
  const readableWordCount = canonicalVisibleWordCount ?? countReadableWords(html);
  const readableText = extractReadableText(html);
  const paraTexts = extractParagraphTexts(html);
  const kpLower = keyphrase.toLowerCase().trim();
  const structHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const first100 = getFirstNReadableWords(structHtml, 100).toLowerCase();

  const ctaHeadings = countCtaHeadingTags(html);
  const signupUrls = (html.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
  const wpOpen = (html.match(/<!--\s*wp:\w+/gi) ?? []).length;
  const wpClose = (html.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
  const nestedParagraphs = detectNestedParagraphs(html);
  const bareH2 = (structHtml.match(/<h2[^>]*>/gi) ?? []).length;
  const headingOpeners = (html.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? []).length;
  const malformedHeadings = Math.abs(bareH2 - headingOpeners);

  // Editorial H2 count: exclude headings inside wp:html blocks (CTA, language
  // switcher) and the FAQ heading. Identify the FAQ H2 by FAQ_HEADING_MARKER
  // or strict known heading text.
  const allHarH2s = extractH2Texts(html);
  const wpHtmlH2Patterns: string[] = [];
  {
    const wpHtmlRe = /<!--\s*wp:html\s*-->([\s\S]*?)<!--\s*\/wp:html\s*-->/gi;
    let whm: RegExpExecArray | null;
    while ((whm = wpHtmlRe.exec(html)) !== null) {
      const innerH2s = [...whm[1].matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
      for (const m of innerH2s) {
        wpHtmlH2Patterns.push(m[1].replace(/<[^>]+>/g, "").trim().toLowerCase());
      }
    }
  }
  // Find the FAQ heading: prefer FAQ_HEADING_MARKER; fallback to strict known
  // heading text (complete match only, no substring).
  const faqHeadingText = findFaqHeadingText(html, allHarH2s);
  const editorialH2s = allHarH2s.filter((h) => {
    const hl = h.toLowerCase().trim();
    // dynamicH2Range() applies to editorial H2s. FAQ and protected CTA/switcher
    // headings are additional structural headings and are excluded here.
    if (faqHeadingText && hl === faqHeadingText.toLowerCase().trim()) return false;
    if (wpHtmlH2Patterns.some((inner) => inner === hl)) return false;
    return true;
  });
  const h2Count = editorialH2s.length;

  // FAQ entry count from visible FAQ
  const visibleFaq = extractVisibleFaqFromArticle(html);
  const faqEntryCount = visibleFaq.length;

  // FAQ parity using JSON-parsed schema (not regex)
  let faqParityValid = false;
  const faqSchemaBlock = extractFaqBlock(html);
  if (faqSchemaBlock && visibleFaq.length > 0) {
    const parityResult = validateFaqParity(visibleFaq.map((v) => ({ question: v.question, answerHtml: "", answerText: v.answerText })), faqSchemaBlock);
    faqParityValid = parityResult.valid;
  }

  // Flesch
  const fleschWords = readableText.split(/\s+/).filter(Boolean);
  const fleschSentences = readableText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  let fleschReadingEase = 0;
  if (fleschWords.length > 0 && fleschSentences.length > 0) {
    const syllables = fleschWords.reduce((sum, w) => {
      const word = w.toLowerCase().replace(/[^a-z]/g, "");
      if (word.length <= 3) return sum + 1;
      let count = 0, prevVowel = false;
      for (const ch of word) { const isV = "aeiou".includes(ch); if (isV && !prevVowel) count++; prevVowel = isV; }
      if (word.endsWith("e")) count--;
      return sum + Math.max(1, count);
    }, 0);
    fleschReadingEase = 206.835 - 1.015 * (fleschWords.length / fleschSentences.length) - 84.6 * (syllables / fleschWords.length);
  }

  // Placeholder content detection (English + Chinese variants)
  const placeholderPattern = /Content unavailable|No content available|This section is empty|此部分暫無內容/i;
  const hasPlaceholderContent = placeholderPattern.test(readableText);

  // Raw prose outside supported WordPress blocks: hard-fail any non-whitespace prose
  const strippedOfAllWp = html
    .replace(/<!--\s*wp:\w+(?:\s[^>]*)?\s*-->[\s\S]*?<!--\s*\/wp:\w+\s*-->/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasRawProseOutsideBlocks = strippedOfAllWp.length > 0 && /\S/.test(strippedOfAllWp);

  // Count valid FAQ schema blocks by parsed JSON-LD (enumerate individual blocks)
  const validFaqSchemaBlocks: string[] = [];
  {
    const schemaRe = /<!--\s*wp:html\s*-->([\s\S]*?)<!--\s*\/wp:html\s*-->/gi;
    let sm: RegExpExecArray | null;
    while ((sm = schemaRe.exec(html)) !== null) {
      const inner = sm[1];
      const scriptMatch = inner.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (scriptMatch) {
        try {
          const parsed = JSON.parse(scriptMatch[1]);
          if (parsed?.["@type"] === "FAQPage" && Array.isArray(parsed.mainEntity)) {
            validFaqSchemaBlocks.push(sm[0]);
          }
        } catch {
          // Not valid JSON — not an FAQ schema block
        }
      }
    }
  }
  const faqBlockCount = validFaqSchemaBlocks.length;
  const duplicateFaqSchemaCount = Math.max(0, validFaqSchemaBlocks.length - 1);

  // CTA duplication: extract canonical CTA, remove it, then check for
  // signup URLs, canonical CTA button text, or heading phrases elsewhere.
  const canonicalCtaHtml = extractCanonicalCtaBlock(html);
  const htmlWithoutCta = canonicalCtaHtml ? html.replace(canonicalCtaHtml, "") : html;
  const signupOutsideCta = (htmlWithoutCta.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
  const ctaButtonTextOutside = (htmlWithoutCta.match(/Create Your Free Profile/i) ?? []).length;
  const ctaHeadingOutside = (htmlWithoutCta.match(/Ready to grow your brand/i) ?? []).length;
  const duplicateCtaBlockCount = signupOutsideCta + ctaButtonTextOutside + ctaHeadingOutside + (canonicalCtaHtml ? 0 : 1);

  // Conclusion detection: exactly one start and one end marker in order.
  // Extract readable content between them; empty or HTML-only content fails.
  const concStartCount = countOccurrences(html, CONCLUSION_START_MARKER);
  const concEndCount = countOccurrences(html, CONCLUSION_END_MARKER);
  const concStartIdx = html.indexOf(CONCLUSION_START_MARKER);
  const concEndIdx = html.indexOf(CONCLUSION_END_MARKER);
  let conclusionContent = "";
  let hasConclusionContent = false;
  if (concStartCount === 1 && concEndCount === 1 && concEndIdx > concStartIdx) {
    conclusionContent = html.substring(concStartIdx + CONCLUSION_START_MARKER.length, concEndIdx)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    hasConclusionContent = conclusionContent.length >= 3; // at least a short readable word
  }
  const publication = analyzePublicationQuality(html);

  return {
    readableWordCount,
    h2Count,
    faqEntryCount,
    exactKeyphraseCount: countExactPhrase(readableText, keyphrase),
    keyphraseDensity: computeKeyphraseDensity(countExactPhrase(readableText, keyphrase), keyphrase, readableWordCount),
    exactKeyphraseInH2: editorialH2s.some((h) => h.toLowerCase().includes(kpLower)),
    longParagraphCount: paraTexts.filter((t) => countSentences(t) > paragraphSentenceLimit()).length,
    keyphraseInFirst100Words: first100.includes(kpLower),
    uniqueInternalLinkCount: countUniqueInternalLinks(html),
    externalSourceLinkCount: countExternalSourceLinks(html),
    ctaHeadingCount: ctaHeadings,
    signupUrlCount: signupUrls,
    faqBlockCount,
    faqJsonLdCount: faqBlockCount,
    hasLanguageSwitcher: hasLanguageSwitcher(html),
    nestedParagraphCount: nestedParagraphs,
    malformedHeadingCount: malformedHeadings,
    wpBlockCountMismatch: wpOpen !== wpClose,
    faqParityValid,
    titleLength: (title || "").length,
    metaDescriptionLength: (metaDescription || "").length,
    fleschReadingEase,
    hasPlaceholderContent,
    hasRawProseOutsideBlocks,
    duplicateFaqSchemaCount,
    duplicateCtaBlockCount,
    hasConclusionContent,
    ...publication,
  };
}

function countOccurrences(text: string, substr: string): number {
  let count = 0, pos = 0;
  while ((pos = text.indexOf(substr, pos)) >= 0) { count++; pos += substr.length; }
  return count;
}

/**
 * Identify the FAQ H2 heading text. Prefers the FAQ_HEADING_MARKER (the first
 * WordPress H2 block immediately following the marker). Falls back to strict
 * complete heading text matching.
 */
function findFaqHeadingText(html: string, allH2Texts: string[]): string | null {
  const markerIdx = html.indexOf(FAQ_HEADING_MARKER);
  if (markerIdx >= 0) {
    const afterMarker = html.substring(markerIdx + FAQ_HEADING_MARKER.length);
    const headingRe = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*\n?<h2\b[^>]*>([\s\S]*?)<\/h2>/i;
    const headingMatch = afterMarker.match(headingRe);
    if (headingMatch) {
      return headingMatch[1].replace(/<[^>]+>/g, "").trim();
    }
  }
  const strictFaqHeadings = ["frequently asked questions", "faq", "faqs", "常見問題"];
  for (const h of allH2Texts) {
    const hTrimmed = h.toLowerCase().trim();
    if (strictFaqHeadings.includes(hTrimmed)) return h;
  }
  return null;
}

/** Enumerate individual wp:html blocks and select the one containing app.b2ihub.com/signup. */
function extractCanonicalCtaBlock(html: string): string | null {
  const wpHtmlRe = /<!--\s*wp:html\s*-->([\s\S]*?)<!--\s*\/wp:html\s*-->/gi;
  let whm: RegExpExecArray | null;
  while ((whm = wpHtmlRe.exec(html)) !== null) {
    if (/app\.b2ihub\.com\/signup/.test(whm[1])) {
      return whm[0];
    }
  }
  return null;
}

// ── Single pass/fail gate ──

export function evaluatePolicy(
  metrics: FinalArticleMetrics,
  policy: FinalArticlePolicy,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { warningBelow: kpWarning, stuffingAbove: kpStuffing } = englishKeyphraseDensity();

  // ── Hard failures (block the article) ──
  const wcHard = metrics.readableWordCount >= policy.wordCountMin
    && metrics.readableWordCount <= policy.wordCountMax;
  const h2Hard = metrics.h2Count >= policy.h2Min && metrics.h2Count <= policy.h2Max;
  const faqEntryHard = metrics.faqEntryCount >= policy.faqEntryMin && metrics.faqEntryCount <= policy.faqEntryMax;
  const paraHard = metrics.longParagraphCount === 0;
  const kpStuffHard = metrics.keyphraseDensity <= kpStuffing;
  const linksHard = metrics.uniqueInternalLinkCount <= policy.internalLinkMax;
  const ctaHard = metrics.ctaHeadingCount === policy.requiredCtaHeadingCount;
  const signupHard = metrics.signupUrlCount === policy.requiredSignupUrlCount;
  const switcherHard = !policy.requireLanguageSwitcher || metrics.hasLanguageSwitcher;
  const faqBlockHard = metrics.faqBlockCount >= policy.requiredFaqBlockCount;
  const faqJsonHard = metrics.faqJsonLdCount >= policy.requiredFaqJsonLdCount;
  const wpHard = !policy.requiredWpBlockBalance || !metrics.wpBlockCountMismatch;
  const nestedHard = metrics.nestedParagraphCount === 0;
  const headingsHard = metrics.malformedHeadingCount === 0;
  const faqParityHard = !policy.requiredFaqParity || metrics.faqParityValid;
  const placeholderHard = !metrics.hasPlaceholderContent;
  const rawProseHard = !metrics.hasRawProseOutsideBlocks;
  const dupFaqSchemaHard = metrics.duplicateFaqSchemaCount === 0;
  const dupCtaHard = metrics.duplicateCtaBlockCount === 0;
  const conclusionHard = metrics.hasConclusionContent;
  const claimConflicts = metrics.claimConflictCount ?? 0;
  const malformedProse = metrics.malformedProseCount ?? 0;
  const repeatedIdeas = metrics.repeatedIdeaPairCount ?? 0;
  const conclusionRatio = metrics.conclusionWordRatio ?? 0;
  const conclusionNewNumbers = metrics.conclusionNewNumericClaimCount ?? 0;
  const factualScore = metrics.factualScore ?? 100;
  const editorialScore = metrics.editorialScore ?? 100;
  const publicationGate = policy.enforcePublicationQuality;
  const claimsHard = !publicationGate || claimConflicts <= policy.maxClaimConflicts;
  const malformedProseHard = !publicationGate || malformedProse <= policy.maxMalformedProseIssues;
  const repeatedIdeasHard = !publicationGate || repeatedIdeas <= policy.maxRepeatedIdeaPairs;
  const conclusionRatioHard = !publicationGate || conclusionRatio <= policy.maxConclusionWordRatio;
  const conclusionNumbersHard = !publicationGate || conclusionNewNumbers <= policy.maxConclusionNewNumericClaims;
  const factualScoreHard = !publicationGate || factualScore >= policy.minimumFactualScore;
  const editorialScoreHard = !publicationGate || editorialScore >= policy.minimumEditorialScore;

  // ── Soft warnings (never block) ──
  const kpSoft = metrics.keyphraseDensity >= kpWarning;
  const h2KpOk = metrics.exactKeyphraseInH2;
  const first100Ok = metrics.keyphraseInFirst100Words;
  const titleOk = metrics.titleLength >= policy.titleMinLength && metrics.titleLength <= policy.titleMaxLength;
  const metaOk = true;

  // Hard failure reasons
  if (!wcHard) reasons.push(`word count=${metrics.readableWordCount} (range: ${policy.wordCountMin}-${policy.wordCountMax})`);
  if (!h2Hard) reasons.push(`H2 count=${metrics.h2Count} (range: ${policy.h2Min}-${policy.h2Max})`);
  if (!faqEntryHard) reasons.push(`FAQ entries=${metrics.faqEntryCount} (range: ${policy.faqEntryMin}-${policy.faqEntryMax})`);
  if (!paraHard) reasons.push(`long paragraphs=${metrics.longParagraphCount}`);
  if (!kpStuffHard) reasons.push(`kp stuffing: ${metrics.keyphraseDensity.toFixed(2)}% > ${kpStuffing}%`);
  if (!linksHard) reasons.push(`internal links=${metrics.uniqueInternalLinkCount}`);
  if (!ctaHard) reasons.push(`cta headings=${metrics.ctaHeadingCount}`);
  if (!signupHard) reasons.push(`signup URLs=${metrics.signupUrlCount}`);
  if (!switcherHard) reasons.push("language switcher missing");
  if (!faqBlockHard) reasons.push(`FAQ blocks=${metrics.faqBlockCount}`);
  if (!faqJsonHard) reasons.push(`FAQ JSON-LD=${metrics.faqJsonLdCount}`);
  if (!wpHard) reasons.push("WP block count mismatch");
  if (!nestedHard) reasons.push(`nested paragraphs=${metrics.nestedParagraphCount}`);
  if (!headingsHard) reasons.push(`malformed headings=${metrics.malformedHeadingCount}`);
  if (!faqParityHard) reasons.push("FAQ parity mismatch");
  if (!placeholderHard) reasons.push("placeholder content found");
  if (!rawProseHard) reasons.push("raw prose outside WordPress blocks");
  if (!dupFaqSchemaHard) reasons.push(`duplicate FAQ schemas=${metrics.duplicateFaqSchemaCount}`);
  if (!dupCtaHard) reasons.push(`duplicate CTA blocks=${metrics.duplicateCtaBlockCount}`);
  if (!conclusionHard) reasons.push("conclusion content missing");
  if (!claimsHard) reasons.push(`factual contradictions=${claimConflicts}`);
  if (!malformedProseHard) reasons.push(`malformed prose issues=${malformedProse}`);
  if (!repeatedIdeasHard) reasons.push(`repeated idea pairs=${repeatedIdeas}`);
  if (!conclusionRatioHard) {
    reasons.push(`conclusion share=${(conclusionRatio * 100).toFixed(1)}% (max: ${(policy.maxConclusionWordRatio * 100).toFixed(0)}%)`);
  }
  if (!conclusionNumbersHard) reasons.push(`new numeric claims in conclusion=${conclusionNewNumbers}`);
  if (!factualScoreHard) reasons.push(`factual score=${factualScore} (minimum: ${policy.minimumFactualScore})`);
  if (!editorialScoreHard) reasons.push(`editorial score=${editorialScore} (minimum: ${policy.minimumEditorialScore})`);

  // Soft warning reasons
  if (!kpSoft) reasons.push(`[SOFT] kp density=${metrics.keyphraseDensity.toFixed(2)}% < ${kpWarning}%`);
  if (!h2KpOk) reasons.push("[SOFT] no H2 keyphrase");
  if (!first100Ok) reasons.push("[SOFT] keyphrase not in first 100 words");
  if (!titleOk) reasons.push(`[SOFT] title length=${metrics.titleLength} (range: ${policy.titleMinLength}-${policy.titleMaxLength})`);
  if (!publicationGate && claimConflicts > policy.maxClaimConflicts) {
    reasons.push(`[SOFT] factual contradictions=${claimConflicts} (editorial polish disabled)`);
  }
  if (!publicationGate && malformedProse > policy.maxMalformedProseIssues) {
    reasons.push(`[SOFT] malformed prose issues=${malformedProse} (editorial polish disabled)`);
  }
  if (!publicationGate && repeatedIdeas > policy.maxRepeatedIdeaPairs) {
    reasons.push(`[SOFT] repeated idea pairs=${repeatedIdeas} (editorial polish disabled)`);
  }
  if (!publicationGate && conclusionRatio > policy.maxConclusionWordRatio) {
    reasons.push(`[SOFT] conclusion share=${(conclusionRatio * 100).toFixed(1)}% (editorial polish disabled)`);
  }

  const passed = wcHard && h2Hard && faqEntryHard && paraHard && kpStuffHard
    && linksHard && ctaHard && signupHard && switcherHard
    && faqBlockHard && faqJsonHard && wpHard && nestedHard && headingsHard && faqParityHard
    && placeholderHard && rawProseHard && dupFaqSchemaHard && dupCtaHard && conclusionHard
    && claimsHard && malformedProseHard && repeatedIdeasHard && conclusionRatioHard
    && conclusionNumbersHard && factualScoreHard && editorialScoreHard;

  return { passed, reasons };
}
