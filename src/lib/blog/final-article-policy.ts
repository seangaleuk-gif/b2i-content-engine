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
import { keyphraseRangeForWordCount, MAX_SENTENCES_PER_PARAGRAPH } from "@/lib/services/generation-constants";
import { detectNestedParagraphs } from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";

// ── Policy ──

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
): FinalArticlePolicy {
  const kpRange = keyphraseRangeForWordCount(requestedWordCount);
  return {
    wordCountMin: wordCountMin ?? requestedWordCount,
    wordCountMax: wordCountMax ?? requestedWordCount,
    keyphraseCountMin: kpRange.min,
    keyphraseCountMax: kpRange.max,
    titleMinLength: 40,
    titleMaxLength: 70,
    requireKeyphraseInFirst100Words: true,
    maxSentencesPerParagraph: MAX_SENTENCES_PER_PARAGRAPH,
    internalLinkMin: 3,
    internalLinkMax: 5,
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
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(stripped)) !== null) {
    const href = m[1];
    if (!href.startsWith("/")) continue;
    if (href.startsWith("/#")) continue;
    if (/-zh\b/i.test(href)) continue;
    if (/signup/i.test(href)) continue;
    if (/auth\//i.test(href)) continue;
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
  const first100 = getFirstNReadableWords(html, 100).toLowerCase();
  const structHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");

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
    // Loose match: visible FAQ questions within <h3> tags
    const visibleFaqCount = (html.match(/<h3\b[^>]*>/gi) ?? []).length;
    faqParityValid = schemaQuestionCount > 0 && visibleFaqCount === schemaQuestionCount;
  }

  return {
    readableWordCount: countReadableWords(html),
    exactKeyphraseCount: countExactPhrase(readableText, keyphrase),
    keyphraseDensity: 0,
    exactKeyphraseInH2: h2Texts.some((h) => h.toLowerCase().includes(kpLower)),
    longParagraphCount: paraTexts.filter((t) => countSentences(t) > MAX_SENTENCES_PER_PARAGRAPH).length,
    keyphraseInFirst100Words: first100.includes(kpLower),
    uniqueInternalLinkCount: countUniqueInternalLinks(html),
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

/** Evaluate metrics against policy. The ONLY pass/fail decision for final article validity. */
export function evaluatePolicy(
  metrics: FinalArticleMetrics,
  policy: FinalArticlePolicy,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const wcOk = metrics.readableWordCount >= policy.wordCountMin;
  const kpOk = metrics.exactKeyphraseCount >= policy.keyphraseCountMin
    && metrics.exactKeyphraseCount <= policy.keyphraseCountMax;
  const h2Ok = metrics.exactKeyphraseInH2;
  const parasOk = metrics.longParagraphCount === 0;
  const first100Ok = !policy.requireKeyphraseInFirst100Words || metrics.keyphraseInFirst100Words;
  const linksOk = metrics.uniqueInternalLinkCount >= policy.internalLinkMin
    && metrics.uniqueInternalLinkCount <= policy.internalLinkMax;
  const ctaOk = metrics.ctaHeadingCount === policy.requiredCtaHeadingCount;
  const signupOk = metrics.signupUrlCount === policy.requiredSignupUrlCount;
  const faqOk = metrics.faqBlockCount === policy.requiredFaqBlockCount;
  const faqJsonOk = metrics.faqJsonLdCount === policy.requiredFaqJsonLdCount;
  const wpOk = !policy.requiredWpBlockBalance || !metrics.wpBlockCountMismatch;
  const nestedOk = metrics.nestedParagraphCount === 0;
  const headingsOk = metrics.malformedHeadingCount === 0;
  const faqParityOk = !policy.requiredFaqParity || metrics.faqParityValid;

  if (!wcOk) reasons.push(`wc=${metrics.readableWordCount}/${policy.wordCountMin}`);
  if (!kpOk) reasons.push(`kp=${metrics.exactKeyphraseCount}/${policy.keyphraseCountMin}-${policy.keyphraseCountMax}`);
  if (!h2Ok) reasons.push("no H2 keyphrase");
  if (!parasOk) reasons.push(`long paragraphs=${metrics.longParagraphCount}`);
  if (!first100Ok) reasons.push("keyphrase not in first 100 words");
  if (!linksOk) reasons.push(`internal links=${metrics.uniqueInternalLinkCount}`);
  if (!ctaOk) reasons.push(`cta headings=${metrics.ctaHeadingCount}`);
  if (!signupOk) reasons.push(`signup URLs=${metrics.signupUrlCount}`);
  if (!faqOk) reasons.push(`FAQ blocks=${metrics.faqBlockCount}`);
  if (!faqJsonOk) reasons.push(`FAQ JSON-LD=${metrics.faqJsonLdCount}`);
  if (!wpOk) reasons.push("WP block count mismatch");
  if (!nestedOk) reasons.push(`nested paragraphs=${metrics.nestedParagraphCount}`);
  if (!headingsOk) reasons.push(`malformed headings=${metrics.malformedHeadingCount}`);
  if (!faqParityOk) reasons.push("FAQ parity mismatch");

  return {
    passed: wcOk && kpOk && h2Ok && parasOk && first100Ok && linksOk
      && ctaOk && signupOk && faqOk && faqJsonOk && wpOk && nestedOk && headingsOk && faqParityOk,
    reasons,
  };
}
