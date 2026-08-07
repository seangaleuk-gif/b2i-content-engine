// ── Source-to-Section Relevance and Heading Naturalness ──
// Deterministic validation that cited evidence supports the section's actual
// H2 topic, and that editorial H2 headings are natural (never a duplicated
// concatenation of the keyphrase onto an already-equivalent heading).

import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderComponentHtml } from "@/lib/blog/article-document";

const TOPIC_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "of", "on", "in", "to", "with",
  "by", "at", "from", "as", "into", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "their",
  "them", "they", "you", "your", "we", "our", "how", "what", "why", "when",
  "where", "who", "which", "new", "best", "top", "more", "most", "all",
  "hong", "kong", "hk", "2026", "for", "the",
]);

/** High-frequency topic-context words that appear in most sources about the
 *  same country/topic. Sharing ONLY these words does not make a source
 *  relevant to a specific section. */
const GENERIC_TOPIC_WORDS = new Set([
  "marketing", "digital", "strategy", "strategies", "media", "market", "markets",
  "brand", "brands", "business", "businesses", "guide", "guides", "trends",
  "local", "top", "best", "hong", "kong", "hk", "2026", "campaign", "campaigns",
]);

export interface SourceRelevanceViolation {
  sectionId: string;
  heading: string;
  url: string;
  sharedWords: string[];
  snippet: string;
}

export interface HeadingNaturalnessViolation {
  sectionId: string;
  heading: string;
  code: "repeated-year" | "duplicated-topic-append" | "duplicated-keyphrase-heading";
  snippet: string;
}

function topicWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word));
}

function linkHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/^https?:\/\//i, "");
}

/**
 * Every explicit `Source:` citation in a section must share meaningful topic
 * words with the section's H2 (title + snippet based). A source is relevant
 * when it shares at least two topic words with the heading, OR at least one
 * specific (non-generic) topic word. A source that only matches generic
 * context ("marketing", "Hong Kong", "2026") is not relevant to a specific
 * section topic — even when the article's external-link count would benefit.
 * Contextual in-paragraph links (not `Source:` citations) are not assessed
 * here: they belong to the external-link injector's own quality rules.
 */
export function assessSourceSectionRelevance(
  doc: ArticleDocument,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): SourceRelevanceViolation[] {
  if (research.length === 0) return [];
  // A URL can map to several research rows with different titles (e.g. one
  // article page with multiple topic Q&A rows). Keep every variant and match
  // the citation against the variant with the best heading overlap, so a
  // source is never judged by an unrelated sibling row.
  const researchByUrl = new Map<string, Array<{ title: string; snippet: string }>>();
  for (const item of research) {
    if (!item.url) continue;
    const list = researchByUrl.get(normalizeUrl(item.url)) ?? [];
    list.push({ title: item.title ?? "", snippet: item.snippet ?? "" });
    researchByUrl.set(normalizeUrl(item.url), list);
  }

  const violations: SourceRelevanceViolation[] = [];
  for (const section of doc.sections) {
    if (section.sectionType !== "main") continue;
    const headingWords = topicWords(section.heading);
    if (headingWords.length === 0) continue;
    const sectionHtml = renderComponentHtml(section);
    const citationParagraphs = [...sectionHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => m[1])
      .filter((body) => /^\s*(?:source|sources)\s*:/i.test(body.replace(/<[^>]+>/g, " ").trim() || ""));
    const citationHtml = citationParagraphs.join(" ");
    for (const href of linkHrefs(citationHtml)) {
      if (/^\/(blog|api)/.test(href)) continue; // internal links are not source citations
      const variants = researchByUrl.get(normalizeUrl(href));
      if (!variants || variants.length === 0) continue; // cannot assess unknown destinations
      // Best variant: most shared topic words with the heading.
      let bestShared: string[] = [];
      let bestHasSpecific = false;
      let bestSnippet = "";
      for (const variant of variants) {
        const sourceWords = topicWords(`${variant.title} ${variant.snippet}`);
        const shared = [...new Set(headingWords.filter((word) => sourceWords.includes(word)))];
        const hasSpecific = shared.some((word) => !GENERIC_TOPIC_WORDS.has(word));
        if (shared.length > bestShared.length || (shared.length === bestShared.length && hasSpecific && !bestHasSpecific)) {
          bestShared = shared;
          bestHasSpecific = hasSpecific;
          bestSnippet = variant.title.slice(0, 120);
        }
      }
      if (bestShared.length < 2 && !bestHasSpecific) {
        violations.push({
          sectionId: section.id,
          heading: section.heading,
          url: href,
          sharedWords: bestShared,
          snippet: bestSnippet,
        });
      }
    }
  }
  return violations;
}

/**
 * A section's body must be grounded in its own heading topic: at least one
 * non-source body sentence must share a meaningful content word with the
 * heading. A fully off-topic section cannot satisfy its H2.
 */
export function assessSectionTopicGrounding(doc: ArticleDocument): string[] {
  const ungrounded: string[] = [];
  for (const section of doc.sections) {
    if (section.sectionType !== "main") continue;
    const headingWords = topicWords(section.heading);
    if (headingWords.length === 0) continue;
    const sectionHtml = renderComponentHtml(section);
    const paragraphs = [...sectionHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
      .filter((text) => text.length > 0 && !/^\s*sources?:/i.test(text));
    const grounded = paragraphs.some((text) => {
      const words = topicWords(text);
      return words.some((word) => headingWords.includes(word));
    });
    if (!grounded) {
      ungrounded.push(`${section.heading} (${section.id})`);
    }
  }
  return ungrounded;
}

const KEYPHRASE_FUNCTION_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "of", "on", "in", "to", "with",
  "by", "at", "from", "as", "into", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "your", "you",
]);

/**
 * An editorial H2 is unnatural when it repeats the same year, appends the
 * title-cased keyphrase to a heading that already covers the topic, or
 * contains the keyphrase twice.
 */
export function assessHeadingNaturalness(
  doc: ArticleDocument,
  keyphrase: string,
): HeadingNaturalnessViolation[] {
  const violations: HeadingNaturalnessViolation[] = [];
  const kpLower = keyphrase.toLowerCase().trim();
  const kpContentWords = kpLower.split(/\s+/).filter((word) => !KEYPHRASE_FUNCTION_WORDS.has(word));
  for (const section of doc.sections) {
    if (section.sectionType !== "main") continue;
    const heading = section.heading;
    const lower = heading.toLowerCase();
    // Repeated year ("2026 ... 2026").
    const years = lower.match(/\b(?:19|20)\d{2}\b/g) ?? [];
    if (new Set(years).size < years.length) {
      violations.push({
        sectionId: section.id,
        heading,
        code: "repeated-year",
        snippet: heading.slice(0, 160),
      });
      continue;
    }
    // The keyphrase appended after a heading that already covers the topic.
    const colonParts = heading.split(/[:：]/).map((part) => part.trim());
    if (colonParts.length >= 2) {
      const prefix = colonParts.slice(0, -1).join(" ").toLowerCase();
      const suffix = colonParts[colonParts.length - 1].toLowerCase();
      const suffixHasKeyphrase = kpLower.length > 0 && suffix.includes(kpLower);
      const prefixCoversTopic = kpContentWords.filter((word) => prefix.includes(word)).length >= 2;
      if (suffixHasKeyphrase && prefixCoversTopic) {
        violations.push({
          sectionId: section.id,
          heading,
          code: "duplicated-topic-append",
          snippet: heading.slice(0, 160),
        });
        continue;
      }
      // Duplicated "Hong Kong" topic phrase across the colon.
      if (prefix.includes("hong kong") && /hong kong/i.test(colonParts[colonParts.length - 1])) {
        violations.push({
          sectionId: section.id,
          heading,
          code: "duplicated-keyphrase-heading",
          snippet: heading.slice(0, 160),
        });
      }
    }
  }
  return violations;
}

/** One-line diagnostics for logging. */
export function formatRelevanceViolations(violations: SourceRelevanceViolation[]): string[] {
  return violations.map((v) =>
    `section=${v.sectionId} heading="${v.heading.slice(0, 60)}" url=${v.url} shared=[${v.sharedWords.join(", ")}] source="${v.snippet}"`,
  );
}

function isPureSourceCitationBlock(html: string): boolean {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^sources?\s*:/i.exec(text);
  if (!match) return false;
  // After the leading "Source:", only the title/URL and a single closing
  // terminal mark may remain — any further sentence means body prose follows.
  const after = text.slice(match[0].length).trim();
  const terminalIndex = after.search(/[.!?]/);
  const tail = terminalIndex >= 0 ? after.slice(terminalIndex + 1).trim() : "";
  return tail.length === 0;
}

/**
 * Find every pure `Source: <a>…</a>.` citation block flagged as off-topic by
 * relevance, keyed by stable block ID. This is the single detection used by
 * both the bounded removal and its diagnostics, so a block that is reported as
 * removed is exactly the block that will be removed.
 */
export function collectOffTopicSourceCitationBlockIds(
  doc: ArticleDocument,
  violations: SourceRelevanceViolation[],
): Array<{ sectionId: string; blockId: string; url: string }> {
  const found: Array<{ sectionId: string; blockId: string; url: string }> = [];
  for (const violation of violations) {
    const section = doc.sections.find((item) => item.id === violation.sectionId);
    if (!section) continue;
    const index = section.blocks.findIndex((block) => {
      if (block.type !== "paragraph") return false;
      const html = renderComponentHtml({ id: section.id, blocks: [block], status: section.status });
      return html.includes(violation.url) && isPureSourceCitationBlock(html);
    });
    if (index < 0) continue;
    found.push({ sectionId: section.id, blockId: section.blocks[index].id, url: violation.url });
  }
  return found;
}

/**
 * Bounded deterministic repair for off-topic source citations: a pure
 * `Source: <a>…</a>.` citation paragraph flagged by relevance is removed from
 * its section (it carries no body claims or numbers). Citations embedded in
 * prose, or violations that survive removal, are never touched here — those
 * remain hard failures.
 */
export function removeOffTopicSourceCitations(
  doc: ArticleDocument,
  violations: SourceRelevanceViolation[],
): number {
  const targets = collectOffTopicSourceCitationBlockIds(doc, violations);
  for (const target of targets) {
    const section = doc.sections.find((item) => item.id === target.sectionId);
    if (!section) continue;
    const index = section.blocks.findIndex((block) => block.id === target.blockId);
    if (index < 0) continue;
    section.blocks.splice(index, 1);
    section.status = "trimmed";
  }
  return targets.length;
}
