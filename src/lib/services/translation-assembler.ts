import type { ArticleDocument, FaqEntry } from "@/lib/blog/article-document";
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
  if (!faqSection || !faqSection.html) return [];
  return extractFaqFromHtml(faqSection.html);
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

// ── Source localisation ──

const AUTHORITATIVE_DOMAINS = [
  "facebook.com", "instagram.com", "threads.net", "about.meta.com",
  "developers.facebook.com", "help.instagram.com",
  "support.google.com", "developers.google.com",
  "gov.hk", "hongkong.gov.hk", "censtatd.gov.hk",
  "who.int", "un.org", "oecd.org",
  "investopedia.com", "statista.com",
  "acm.org", "ieee.org", "scholar.google.com",
  "nature.com", "science.org", "springer.com",
];
const AUTHORITATIVE_PREFIXES = AUTHORITATIVE_DOMAINS.map((d) => `https://${d}`);

function isAuthoritative(url: string): boolean {
  return AUTHORITATIVE_PREFIXES.some((p) => url.replace(/^https?:\/\/(www\.)?/, "https://").startsWith(p));
}

function urlDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function domainName(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function textMatchSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function hasNumbers(text: string): boolean { return /\d/.test(text); }

function extractNumbers(text: string): Set<string> {
  return new Set((text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "")));
}

function isChineseDomain(url: string): boolean {
  return /\.hk$|\.cn$|\.tw$|\.mo$|^zh\.|chinese/i.test(urlDomain(url));
}

function isB2iDomain(url: string): boolean { return /b2ihub\.com/i.test(url); }

export function localiseSources(html: string, research: ResearchItem[]): SourceDecision[] {
  const decisions: SourceDecision[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (!href.startsWith("http")) continue;
    if (isB2iDomain(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    if (isAuthoritative(href)) {
      decisions.push({ originalUrl: href, finalUrl: href, decision: "preserved", reason: "Authoritative primary source", matchScore: 10 });
      continue;
    }
    const domain = domainName(href);
    const researchCandidates = research.filter((r) => !isB2iDomain(r.url) && !seen.has(r.url));
    let bestCandidate: ResearchItem | null = null;
    let bestScore = 0, bestContentScore = 0;
    for (const candidate of researchCandidates) {
      let score = 0, contentScore = 0;
      if (isChineseDomain(candidate.url)) score += 3;
      const titleSim = textMatchSimilarity(candidate.title || "", m[0] || domain);
      score += titleSim * 5;
      if (titleSim > 0.1) contentScore += titleSim * 5;
      if (hasNumbers(candidate.snippet)) {
        const srcNums = extractNumbers(html.substring(Math.max(0, m.index - 200), m.index + 200));
        const candNums = extractNumbers(candidate.snippet + " " + candidate.title);
        const shared = [...srcNums].filter((n) => candNums.has(n));
        if (shared.length > 0) { score += 2; contentScore += 2; }
      }
      if (candidate.snippet && candidate.snippet.length > 20) { score += 1; contentScore += 0.5; }
      if (urlDomain(candidate.url) === domain) score += 1;
      if (score > bestScore) { bestScore = score; bestCandidate = candidate; bestContentScore = contentScore; }
    }
    if (bestCandidate && bestScore >= 4 && bestContentScore >= 1) {
      decisions.push({ originalUrl: href, finalUrl: bestCandidate.url, decision: "replaced", reason: `Matched research candidate (score ${bestScore.toFixed(1)})`, matchScore: Math.round(bestScore) });
    } else {
      decisions.push({ originalUrl: href, finalUrl: href, decision: "preserved", reason: bestScore > 0 ? `No suitable Chinese source (best ${bestScore.toFixed(1)})` : "No matching research candidate", matchScore: Math.round(bestScore) });
    }
  }
  return decisions;
}

export function applySourceDecisions(html: string, decisions: SourceDecision[]): string {
  let result = html;
  for (const d of decisions) {
    if (d.originalUrl !== d.finalUrl) {
      result = result.replace(new RegExp(`(<a\\b[^>]*href\\s*=\\s*")${escapeRegex(d.originalUrl)}(")`, "gi"), `$1${d.finalUrl}$2`);
    }
  }
  return result;
}

// ── Internal-link localisation ──

export function localiseInternalLinks(html: string, zhSlugs?: Set<string>): InternalLinkDecision[] {
  if (!zhSlugs || zhSlugs.size === 0) return [];
  const decisions: InternalLinkDecision[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*href="(\/blog\/[^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    const baseSlug = href.replace(/\/$/, "").replace(/^\/(?:blog\/)?/, "");
    const zhHref = `/blog/${baseSlug}-zh`;
    if (zhSlugs.has(baseSlug)) {
      decisions.push({ originalUrl: href, finalUrl: zhHref, hasChineseVersion: true, reason: `Chinese version exists for "${baseSlug}"` });
    } else {
      decisions.push({ originalUrl: href, finalUrl: href, hasChineseVersion: false, reason: `No Chinese version for "${baseSlug}"` });
    }
  }
  return decisions;
}

export function applyInternalLinkDecisions(html: string, decisions: InternalLinkDecision[]): string {
  return html;
}

export function applyLocalisations(html: string, sourceDecisions: SourceDecision[], _internalDecisions: InternalLinkDecision[]): string {
  let result = html;
  for (const d of sourceDecisions) {
    if (d.originalUrl !== d.finalUrl) {
      result = result.replace(new RegExp(`(<a\\b[^>]*href\\s*=\\s*")${escapeRegex(d.originalUrl)}(")`, "gi"), `$1${d.finalUrl}$2`);
    }
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
