import { type ArticleDocument, type FaqEntry, renderComponentHtml } from "@/lib/blog/article-document";
import type { SourceDecision, InternalLinkDecision, ResearchItem } from "./translation-types";

// ── FAQ schema builder ──

export function buildFaqSchemaJson(entries: FaqEntry[]): string {
  const mainEntity = entries.map((e) => ({
    "@type": "Question",
    name: e.question,
    acceptedAnswer: { "@type": "Answer", text: e.answerText },
  }));
  return JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity }, null, 2);
}

// ── FAQ extraction from ArticleDocument ──

export function extractFaqFromDoc(doc: ArticleDocument): FaqEntry[] {
  if (doc.visibleFaq.length > 0) return doc.visibleFaq;
  const faqSection = doc.sections.find((s) =>
    s.sectionType === "faq-heading" || /faq|frequently|常見|問題|問答|常見問題集/i.test(s.heading)
  );
  if (!faqSection || !faqSection.blocks || faqSection.blocks.length === 0) return [];
  return extractFaqFromHtml(renderComponentHtml(faqSection));
}

function extractFaqFromHtml(html: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const qaRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>\s*(?:<\/p>\s*<!--\s*\/wp:paragraph\s*-->\s*<!--\s*wp:paragraph\s*-->\s*<p>)?\s*([\s\S]*?)(?=<strong\b|<h2\b|<!--\s*wp:heading|<!--\s*wp:html|$)/gi;
  let m;
  while ((m = qaRe.exec(html)) !== null) {
    const question = m[1].replace(/<[^>]+>/g, "").trim();
    const answerRaw = m[2].replace(/<\/p>\s*<!--\s*\/wp:paragraph\s*-->/i, "");
    const answerHtml = m[2].trim();
    const answerText = answerRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if ((question.endsWith("?") || question.endsWith("？")) && answerText.length > 10) {
      entries.push({ question, answerHtml, answerText });
    }
  }
  return entries;
}

// ── URL preservation ──
// Translation never substitutes or localises editorial URLs. Research and
// internal links are evidence-bearing parts of the approved English document.

function isB2iDomain(url: string): boolean { return /b2ihub\.com/i.test(url); }

export function localiseSources(html: string, _research: ResearchItem[]): SourceDecision[] {
  const decisions: SourceDecision[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const href = match[1];
    if (!/^https?:\/\//i.test(href) || isB2iDomain(href) || seen.has(href)) continue;
    seen.add(href);
    decisions.push({
      originalUrl: href,
      finalUrl: href,
      decision: "preserved",
      reason: "Translation preserves the approved source URL exactly",
      matchScore: 10,
    });
  }
  return decisions;
}

export function applySourceDecisions(html: string, _decisions: SourceDecision[]): string {
  return html;
}

export function localiseInternalLinks(html: string, _zhSlugs?: Set<string>): InternalLinkDecision[] {
  const decisions: InternalLinkDecision[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*href=["'](\/blog\/[^"']*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const href = match[1];
    if (seen.has(href)) continue;
    seen.add(href);
    decisions.push({
      originalUrl: href,
      finalUrl: href,
      hasChineseVersion: false,
      reason: "Translation preserves editorial internal URLs exactly",
    });
  }
  return decisions;
}

export function applyInternalLinkDecisions(html: string, _decisions: InternalLinkDecision[]): string {
  return html;
}

export function applyLocalisations(html: string, _sourceDecisions: SourceDecision[], _internalDecisions: InternalLinkDecision[]): string {
  return html;
}
