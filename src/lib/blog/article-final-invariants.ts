// ── Final Article Invariant Validator ──
// Non-destructive validation run immediately before returning a completed article.

import { countCtaHeadingTags } from "@/lib/seo/seo-text-utils";
import { detectNestedParagraphs } from "@/lib/blog/article-document";
// Inspects protected-block counts, WordPress structure, and HTML integrity.
// Never modifies the article — only reports invariants.

export interface FinalInvariantResult {
  valid: boolean;
  errors: string[];
  counts: FinalInvariantCounts;
}

export interface FinalInvariantCounts {
  ctaHeadings: number;
  signupUrls: number;
  faqBlocks: number;
  faqJsonLd: number;
  totalH2: number;
  wpOpen: number;
  wpClose: number;
  nestedParagraphs: number;
  malformedHeadings: number;
}

export function validateFinalArticleInvariants(article: string): FinalInvariantResult {
  const errors: string[] = [];
  const structHtml = article
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");

  const ctaHeadings = countCtaHeadingTags(article);
  const signupUrls = (article.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
  const faqBlocks = (article.match(/FAQPage/gi) ?? []).length;
  const faqJsonLd = (article.match(/application\/ld\+json/i) ?? []).length;
  const totalH2 = (structHtml.match(/<h2[^>]*>/gi) ?? []).length;
  const wpOpen = (article.match(/<!--\s*wp:\w+/gi) ?? []).length;
  const wpClose = (article.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
  const nestedParagraphs = detectNestedParagraphs(article);

  // Malformed H2 blocks
  const bareH2 = (structHtml.match(/<h2[^>]*>/gi) ?? []).length;
  const headingOpeners = (article.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? []).length;
  const malformedHeadings = Math.abs(bareH2 - headingOpeners);

  // Invariant checks
  if (ctaHeadings !== 1) errors.push(`CTA heading count=${ctaHeadings} (expected 1)`);
  if (signupUrls !== 1) errors.push(`Signup URL count=${signupUrls} (expected 1)`);
  if (faqBlocks !== 1) errors.push(`FAQPage count=${faqBlocks} (expected 1)`);
  if (faqJsonLd !== 1) errors.push(`FAQ JSON-LD count=${faqJsonLd} (expected 1)`);
  if (wpOpen !== wpClose) errors.push(`WP block mismatch: ${wpOpen} open / ${wpClose} close`);
  if (nestedParagraphs > 0) errors.push(`${nestedParagraphs} nested paragraph(s)`);
  if (malformedHeadings > 0) errors.push(`${malformedHeadings} malformed heading block(s)`);

  return {
    valid: errors.length === 0,
    errors,
    counts: { ctaHeadings, signupUrls, faqBlocks, faqJsonLd, totalH2, wpOpen, wpClose, nestedParagraphs, malformedHeadings },
  };
}
