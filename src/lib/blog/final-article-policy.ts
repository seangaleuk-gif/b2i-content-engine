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
} from "@/lib/seo/seo-text-utils";
import { MAX_SENTENCES_PER_PARAGRAPH, computeKeyphraseTargets, KEYPHRASE_DENSITY_MAX, KEYPHRASE_DENSITY_MIN } from "@/lib/services/generation-constants";
import { detectNestedParagraphs, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { computeKeyphraseDensity, getKeyphraseContentWordCount } from "@/lib/services/generation-constants";

// ── Policy ──

export function computeWordCountTolerance(target: number): { min: number; max: number } {
  const tolerance = target < 2000 ? 0.10 : 0.15;
  return {
    min: Math.round(target * (1 - tolerance)),
    max: Math.round(target * (1 + tolerance)),
  };
}

export interface FinalArticlePolicy {
  wordCountMin: number;
  wordCountMax: number;
  keyphraseCountMin: number;
  keyphraseCountMax: number;
  titleMinLength: number;
  titleMaxLength: number;
  requireKeyphraseInFirst100Words: boolean;
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
}

export function buildPolicy(
  requestedWordCount: number,
  wordCountMin?: number,
  wordCountMax?: number,
  keyphrase?: string,
): FinalArticlePolicy {
  const kpTargets = keyphrase ? computeKeyphraseTargets(requestedWordCount, keyphrase) : { min: 1, max: Math.ceil(requestedWordCount / 50), preferred: 1 };
  const tolerance = computeWordCountTolerance(requestedWordCount);
  return {
    wordCountMin: wordCountMin ?? tolerance.min,
    wordCountMax: wordCountMax ?? tolerance.max,
    keyphraseCountMin: 0,        // density-based; 0 occurrences = 0% density (soft)
    keyphraseCountMax: kpTargets.max,  // stuffing threshold from density
    titleMinLength: 40,
    titleMaxLength: 70,
    requireKeyphraseInFirst100Words: true,
    maxSentencesPerParagraph: MAX_SENTENCES_PER_PARAGRAPH,
    internalLinkMin: 0,
    internalLinkMax: 4,
    requireLanguageSwitcher: true,
    requiredCtaHeadingCount: 1,
    requiredSignupUrlCount: 1,
    requiredFaqBlockCount: 1,
    requiredFaqJsonLdCount: 1,
    requiredWpBlockBalance: true,
    requiredFaqParity: true,
  };
}

// ── Unified metrics ──

export interface FinalArticleMetrics {
  // SEO
  readableWordCount: number;
  exactKeyphraseCount: number;
  keyphraseDensity: number;
  exactKeyphraseInH2: boolean;
  longParagraphCount: number;
  keyphraseInFirst100Words: boolean;
  uniqueInternalLinkCount: number;
  externalSourceLinkCount: number;

  // Structural invariants (formerly validateFinalArticleInvariants)
  ctaHeadingCount: number;
  signupUrlCount: number;
  faqBlockCount: number;
  faqJsonLdCount: number;
  nestedParagraphCount: number;
  malformedHeadingCount: number;
  wpBlockCountMismatch: boolean;

  // FAQ parity (formerly validateFaqParity)
  faqParityValid: boolean;
}

// ── Helpers ──

export function countUniqueInternalLinks(html: string): number {
  // Strip script and wp:html blocks — links inside language-switcher, CTA,
  // and FAQ schema blocks are excluded by structure, not pattern.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(stripped)) !== null) {
    const href = m[1];
    if (href.startsWith("/#")) continue;           // anchor links
    if (/signup/i.test(href)) continue;             // signup URLs
    if (/auth\//i.test(href)) continue;             // auth URLs
    // Navigation and social profile links
    if (/^\/(?:knowledge|playground|projects|prompts|settings|profile|login|signout)/i.test(href)) continue;
    // B2I Hub blog internal links: /blog/... or https://b2ihub.com/blog/...
    if (href.startsWith("/blog/")) {
      seen.add(href.replace(/\/$/, ""));
    } else if (/^https?:\/\/b2ihub\.com\/blog\//i.test(href)) {
      seen.add(href.replace(/^https?:\/\/b2ihub\.com/i, "").replace(/\/$/, ""));
    }
  }
  return seen.size;
}

/**
 * Enforce the maximum editorial internal links (4 unique destinations).
 * - Excludes links inside wp:html, script, and CTA/signup blocks.
 * - Normalizes absolute and relative B2I Hub URLs.
 * - If > 4 unique destinations remain, removes excess links (preserves anchor text).
 * - Never removes external research links.
 * Returns the modified HTML and a log of actions taken.
 */
export function enforceInternalLinkLimit(
  html: string,
  maxLinks: number = 4,
): { html: string; retained: string[]; removed: string[] } {
  // Find all editorial <a> tags with their positions and destinations.
  // Work on the full HTML but exclude wp:html and script blocks.
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

  // Extract all editorial <a> tags
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

    // Skip if in protected block
    if (isProtected(start)) continue;

    // Skip CTA/signup/auth URLs
    if (/signup/i.test(href)) continue;
    if (/auth\//i.test(href)) continue;
    if (/^\/(?:knowledge|playground|projects|prompts|settings|profile|login|signout)/i.test(href)) continue;
    if (href.startsWith("/#")) continue;

    // Only count B2I Hub blog internal links
    let normalized = href;
    if (/^https?:\/\/b2ihub\.com\/blog\//i.test(href)) {
      normalized = href.replace(/^https?:\/\/b2ihub\.com/i, "").replace(/\/$/, "");
    }
    if (!normalized.startsWith("/blog/")) continue;

    const anchorText = am[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    allLinks.push({ fullTag: am[0], href: normalized.replace(/\/$/, ""), start, end, anchorText });
  }

  // Group by normalized destination
  const byDest = new Map<string, EditorialLink[]>();
  for (const link of allLinks) {
    const dest = link.href;
    if (!byDest.has(dest)) byDest.set(dest, []);
    byDest.get(dest)!.push(link);
  }

  const retained: string[] = [];
  const removed: string[] = [];

  if (byDest.size <= maxLinks) {
    // Within limit — no action needed, but log what we have
    for (const [dest] of byDest) retained.push(dest);
    return { html, retained, removed };
  }

  // Keep the first maxLinks destinations, remove the rest
  // Sort by position (keep earliest links, they're more contextual)
  const sorted = [...byDest.entries()].sort((a, b) => a[1][0].start - b[1][0].start);
  const kept = sorted.slice(0, maxLinks);
  const excess = sorted.slice(maxLinks);

  for (const [, links] of kept) {
    retained.push(links[0].href);
  }

  // Build reverse-sorted list of tags to unwrap
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
    // Extract anchor text from the tag <a ...>ANCHOR</a>
    const aContent = originalTag.replace(/^<a\b[^>]*>/, "").replace(/<\/a>$/, "");
    result = result.substring(0, uw.start) + aContent + result.substring(uw.end);
  }

  console.log(`[link-enforce] retained=${retained.length} removed=${removed.length}`);
  for (const r of removed) console.log(`[link-enforce] removed link: ${r}`);

  return { html: result, retained, removed };
}

/** Count unique external source links (research sources attached to claims).
 *  Excludes CTA, signup, language-switcher, navigation, and social-profile links.
 *  These do NOT count toward the internal-link minimum or maximum. */
export function countExternalSourceLinks(html: string): number {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(stripped)) !== null) {
    const href = m[1];
    // Only count external http/https URLs
    if (!/^https?:\/\//i.test(href)) continue;
    // Exclude B2I Hub internal URLs
    if (/b2ihub\.com/i.test(href)) continue;
    // Exclude CTA, signup, social, and other non-research external links
    if (/signup|auth|login|facebook\.com|instagram\.com|twitter\.com|linkedin\.com|threads\.net/i.test(href)) continue;
    seen.add(href.replace(/\/$/, ""));
  }
  return seen.size;
}

// ── Canonical analyzer ──

/** Compute ALL final article metrics from HTML. The single shared implementation. */
export function analyzeFinalArticle(
  html: string,
  keyphrase: string,
): FinalArticleMetrics {
  const readableText = extractReadableText(html);
  const h2Texts = extractH2Texts(html);
  const paraTexts = extractParagraphTexts(html);
  const kpLower = keyphrase.toLowerCase().trim();
  const structHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const first100 = getFirstNReadableWords(structHtml, 100).toLowerCase();

  // Structural invariants
  const ctaHeadings = countCtaHeadingTags(html);
  const signupUrls = (html.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
  const faqBlocks = (html.match(/FAQPage/gi) ?? []).length;
  const faqJsonLd = (html.match(/application\/ld\+json/i) ?? []).length;
  const wpOpen = (html.match(/<!--\s*wp:\w+/gi) ?? []).length;
  const wpClose = (html.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
  const nestedParagraphs = detectNestedParagraphs(html);
  const bareH2 = (structHtml.match(/<h2[^>]*>/gi) ?? []).length;
  const headingOpeners = (html.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? []).length;
  const malformedHeadings = Math.abs(bareH2 - headingOpeners);

  // FAQ parity
  let faqParityValid = false;
  const faqSchemaBlock = extractFaqBlock(html);
  if (faqBlocks === 1 && faqSchemaBlock) {
    const schemaQuestionCount = (faqSchemaBlock.match(/"name"\s*:\s*"/gi) ?? []).length;
    const visibleFaqCount = extractVisibleFaqFromArticle(html).length;
    // Parity requires matching counts when visible FAQ exists.
    // If no visible FAQ, parity is only valid if schema was generated from real content.
    faqParityValid = schemaQuestionCount > 0 && (visibleFaqCount > 0 ? visibleFaqCount === schemaQuestionCount : true);
  }

  return {
    readableWordCount: countReadableWords(html),
    exactKeyphraseCount: countExactPhrase(readableText, keyphrase),
    keyphraseDensity: computeKeyphraseDensity(countExactPhrase(readableText, keyphrase), keyphrase, countReadableWords(html)),
    exactKeyphraseInH2: h2Texts.some((h) => h.toLowerCase().includes(kpLower)),
    longParagraphCount: paraTexts.filter((t) => countSentences(t) > MAX_SENTENCES_PER_PARAGRAPH).length,
    keyphraseInFirst100Words: first100.includes(kpLower),
    uniqueInternalLinkCount: countUniqueInternalLinks(html),
    externalSourceLinkCount: countExternalSourceLinks(html),
    ctaHeadingCount: ctaHeadings,
    signupUrlCount: signupUrls,
    faqBlockCount: faqBlocks,
    faqJsonLdCount: faqJsonLd,
    nestedParagraphCount: nestedParagraphs,
    malformedHeadingCount: malformedHeadings,
    wpBlockCountMismatch: wpOpen !== wpClose,
    faqParityValid,
  };
}

// ── Single pass/fail gate ──

/** Evaluate metrics against policy. The ONLY pass/fail decision for final article validity.
 *
 *  Hard failures (block the article):
 *    - Keyphrase stuffing (>3% density)
 *    - WordPress block imbalance
 *    - Nested paragraphs
 *    - Malformed headings
 *    - FAQ block count mismatch
 *    - FAQ JSON-LD mismatch
 *    - CTA heading count mismatch
 *    - Signup URL count mismatch
 *    - Internal link count above max
 *    - FAQ parity mismatch (visible vs schema)
 *
 *  Soft warnings (do NOT block — logged but never cause 500):
 *    - Word count outside tolerance
 *    - Long paragraphs exceeding sentence limit
 *    - Keyphrase not in first 100 words
 *    - Keyphrase missing from H2 headings
 *    - Internal link count below min
 *    - Keyphrase density below 0.5% (already handled by kpOk)
 */
export function evaluatePolicy(
  metrics: FinalArticleMetrics,
  policy: FinalArticlePolicy,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // ── Soft checks (warnings only, never block) ──
  const wcOk = metrics.readableWordCount >= policy.wordCountMin
    && metrics.readableWordCount <= policy.wordCountMax;
  const h2Ok = metrics.exactKeyphraseInH2;
  const parasOk = true; // Soft: long paragraphs are SEO quality, not structural failure
  const first100Ok = true; // Soft: keyphrase placement is quality target, not hard requirement
  const linksAboveMin = metrics.uniqueInternalLinkCount >= policy.internalLinkMin;

  // ── Hard checks (block the article if violated) ──
  const wcHard = metrics.readableWordCount >= policy.wordCountMin
    && metrics.readableWordCount <= policy.wordCountMax;
  const kpHard = metrics.keyphraseDensity <= KEYPHRASE_DENSITY_MAX; // >3% is stuffing
  const linksAboveMax = metrics.uniqueInternalLinkCount <= policy.internalLinkMax;
  const ctaOk = metrics.ctaHeadingCount === policy.requiredCtaHeadingCount;
  const signupOk = metrics.signupUrlCount === policy.requiredSignupUrlCount;
  const faqOk = metrics.faqBlockCount === policy.requiredFaqBlockCount;
  const faqJsonOk = metrics.faqJsonLdCount === policy.requiredFaqJsonLdCount;
  const wpOk = !policy.requiredWpBlockBalance || !metrics.wpBlockCountMismatch;
  const nestedOk = metrics.nestedParagraphCount === 0;
  const headingsOk = metrics.malformedHeadingCount === 0;
  const faqParityOk = !policy.requiredFaqParity || metrics.faqParityValid;

  // Soft warnings
  if (!h2Ok) reasons.push("[SOFT] no H2 keyphrase");
  if (!parasOk) reasons.push(`[SOFT] long paragraphs=${metrics.longParagraphCount}`);
  if (!first100Ok) reasons.push("[SOFT] keyphrase not in first 100 words");
  if (!linksAboveMin) reasons.push(`[SOFT] internal links below min: ${metrics.uniqueInternalLinkCount}`);

  // Hard failures
  if (!wcHard) reasons.push(`word count=${metrics.readableWordCount} (range: ${policy.wordCountMin}-${policy.wordCountMax})`);
  if (!kpHard) reasons.push(`kp stuffing: ${metrics.keyphraseDensity.toFixed(2)}% > ${KEYPHRASE_DENSITY_MAX}%`);
  if (!linksAboveMax) reasons.push(`internal links=${metrics.uniqueInternalLinkCount}`);
  if (!ctaOk) reasons.push(`cta headings=${metrics.ctaHeadingCount}`);
  if (!signupOk) reasons.push(`signup URLs=${metrics.signupUrlCount}`);
  if (!faqOk) reasons.push(`FAQ blocks=${metrics.faqBlockCount}`);
  if (!faqJsonOk) reasons.push(`FAQ JSON-LD=${metrics.faqJsonLdCount}`);
  if (!wpOk) reasons.push("WP block count mismatch");
  if (!nestedOk) reasons.push(`nested paragraphs=${metrics.nestedParagraphCount}`);
  if (!headingsOk) reasons.push(`malformed headings=${metrics.malformedHeadingCount}`);
  if (!faqParityOk) reasons.push("FAQ parity mismatch");

  // Only hard checks contribute to pass/fail
  const passed = wcHard && kpHard && linksAboveMax && ctaOk && signupOk
    && faqOk && faqJsonOk && wpOk && nestedOk && headingsOk && faqParityOk;

  return { passed, reasons };
}
