// ── Source-to-Section Relevance and Heading Naturalness ──
// Deterministic validation that cited evidence supports the section's actual
// H2 topic, and that editorial H2 headings are natural (never a duplicated
// concatenation of the keyphrase onto an already-equivalent heading).

import type { ArticleDocument, ArticleSection } from "@/lib/blog/article-document";
import { renderComponentHtml } from "@/lib/blog/article-document";
import { normalizedSentenceTextsOfSectionHtml } from "@/lib/blog/factual-risk-scanner";
import { normalizeTopicToken } from "@/lib/blog/topic-token-normalizer";

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

export interface HeadingNaturalnessRepair {
  original: string;
  heading: string;
  changed: boolean;
  resolved: boolean;
  initialViolations: HeadingNaturalnessViolation[];
  remainingViolations: HeadingNaturalnessViolation[];
}

function topicWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word))
    .map(normalizeTopicToken);
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

/** Single heading/source relevance rule used by both citation production and
 * final validation. A producer can no longer emit a citation that its own
 * final gate is guaranteed to remove. */
export function assessHeadingSourceTextRelevance(
  heading: string,
  sourceText: string,
): { relevant: boolean; sharedWords: string[]; hasSpecificWord: boolean } {
  const headingTokens = topicWords(heading);
  const sourceTokens = topicWords(sourceText);
  const sharedWords = [...new Set(headingTokens.filter((word) => sourceTokens.includes(word)))];
  const hasSpecificWord = sharedWords.some((word) => !GENERIC_TOPIC_WORDS.has(word));
  return {
    relevant: sharedWords.length >= 2 || hasSpecificWord,
    sharedWords,
    hasSpecificWord,
  };
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
        const assessment = assessHeadingSourceTextRelevance(
          section.heading,
          `${variant.title} ${variant.snippet}`,
        );
        const shared = assessment.sharedWords;
        const hasSpecific = assessment.hasSpecificWord;
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
  return findUngroundedSectionIds(doc).map((sectionId) => {
    const section = doc.sections.find((item) => item.id === sectionId);
    return `${section?.heading ?? sectionId} (${sectionId})`;
  });
}

/** Content words of a main section's heading (stop words and location/year
 *  tokens excluded), used for topic-grounding comparisons. */
function sectionHeadingContentWords(section: ArticleSection): string[] {
  return topicWords(section.heading);
}

/**
 * True when the section's body contains at least one non-source paragraph
 * sharing a content word with its heading. This is the single topic-grounding
 * rule shared by the section-relevance scanner, the stage-aware integrity
 * contract and the final QC gate, so a producer can never disagree with the
 * gate about whether a section is grounded.
 */
export function isSectionTopicGrounded(section: ArticleSection): boolean {
  if (section.sectionType !== "main") return true;
  const headingWords = sectionHeadingContentWords(section);
  if (headingWords.length === 0) return true;
  const sectionHtml = renderComponentHtml(section);
  const paragraphs = [...sectionHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0 && !/^\s*sources?:/i.test(text));
  return paragraphs.some((text) => {
    const words = topicWords(text);
    return words.some((word) => headingWords.includes(word));
  });
}

/**
 * Number of distinct non-source body paragraphs that carry at least one
 * heading content word. Used by removal producers (final trim, factual scan)
 * to refuse a candidate that would leave the section with zero grounding.
 * `excludeBlockIndex` simulates removing one block so a producer can verify
 * that an alternative grounding paragraph survives.
 */
export function countSectionGroundingCarriers(
  section: ArticleSection,
  excludeBlockIndex?: number,
): number {
  if (section.sectionType !== "main") return Number.POSITIVE_INFINITY;
  const headingWords = sectionHeadingContentWords(section);
  if (headingWords.length === 0) return Number.POSITIVE_INFINITY;
  let carriers = 0;
  for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
    if (excludeBlockIndex !== undefined && blockIndex === excludeBlockIndex) continue;
    const block = section.blocks[blockIndex];
    if (block.type !== "paragraph" && block.type !== "list") continue;
    const html = renderComponentHtml({
      id: section.id,
      blocks: [block],
      status: section.status,
    });
    const text = html
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^\s*sources?:/i.test(text)) continue;
    if (topicWords(text).some((word) => headingWords.includes(word))) carriers++;
  }
  return carriers;
}

/** True when a candidate body text still carries at least one content word of
 *  the section heading. Used by final-trim sentence shortening to refuse a
 *  shortened remainder that would unground the section. */
export function textCarriesHeadingContentWord(section: ArticleSection, text: string): boolean {
  if (section.sectionType !== "main") return true;
  const headingWords = sectionHeadingContentWords(section);
  if (headingWords.length === 0) return true;
  return topicWords(text).some((word) => headingWords.includes(word));
}

/** Stable section IDs whose body lost all topic grounding. Used by the
 *  stage-aware integrity contract so a mutating stage can never turn a
 *  previously grounded section into an ungrounded one silently. */
export function findUngroundedSectionIds(doc: ArticleDocument): string[] {
  return doc.sections
    .filter((section) => section.sectionType === "main" && !isSectionTopicGrounded(section))
    .map((section) => section.id);
}

/**
 * Complete normalized sentence texts of the section's non-source body
 * paragraphs that carry at least one heading content word. The normalized
 * texts are computed with the EXACT sentence splitting the removal producer
 * uses when matching preserved sentences, so a preserved carrier always
 * matches and survives.
 */
export function groundingCarrierSentenceTexts(section: ArticleSection): string[] {
  if (section.sectionType !== "main") return [];
  const headingWords = sectionHeadingContentWords(section);
  if (headingWords.length === 0) return [];
  const sectionHtml = renderComponentHtml(section);
  return normalizedSentenceTextsOfSectionHtml(sectionHtml).filter((sentence) =>
    topicWords(sentence).some((word) => headingWords.includes(word)),
  );
}

/**
 * Essential grounding carriers: the section's minimum grounded substance.
 * When several paragraphs share a heading word, removing a claim sentence
 * from one of them cannot unground the section, so no preservation is needed
 * and every unsupported claim is still removed. When a single paragraph is
 * the section's only grounding carrier, its carrier sentences must survive
 * removal. Removal producers pass the returned texts through
 * `preserveSentenceTexts`.
 */
export function essentialGroundingCarrierSentenceTexts(section: ArticleSection): string[] {
  if (section.sectionType !== "main") return [];
  if (countSectionGroundingCarriers(section) !== 1) return [];
  return groundingCarrierSentenceTexts(section);
}

const KEYPHRASE_FUNCTION_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "of", "on", "in", "to", "with",
  "by", "at", "from", "as", "into", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "your", "you",
]);

function headingWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function countTokenSequence(words: string[], sequence: string[]): number {
  if (sequence.length === 0 || sequence.length > words.length) return 0;
  let count = 0;
  for (let i = 0; i <= words.length - sequence.length; i++) {
    if (sequence.every((word, offset) => words[i + offset] === word)) count++;
  }
  return count;
}

/**
 * Text-level heading validator shared by the outline acceptance boundary and
 * the final ArticleDocument backstop. Keeping one detector prevents the
 * producer and final gate from drifting apart.
 */
export function assessHeadingTextNaturalness(
  heading: string,
  keyphrase: string,
  sectionId = "outline",
): HeadingNaturalnessViolation[] {
  const violations: HeadingNaturalnessViolation[] = [];
  const words = headingWords(heading);
  const keyphraseWords = headingWords(keyphrase);
  const kpContentWords = keyphraseWords.filter((word) => !KEYPHRASE_FUNCTION_WORDS.has(word));

  const years = words.filter((word) => /^(?:19|20)\d{2}$/.test(word));
  if (new Set(years).size < years.length) {
    violations.push({ sectionId, heading, code: "repeated-year", snippet: heading.slice(0, 160) });
  }

  const colonParts = heading.split(/[:：]/).map((part) => part.trim()).filter(Boolean);
  if (colonParts.length >= 2) {
    const prefixWords = headingWords(colonParts.slice(0, -1).join(" "));
    const suffixWords = headingWords(colonParts[colonParts.length - 1]);
    const suffixHasKeyphrase = countTokenSequence(suffixWords, keyphraseWords) > 0;
    const prefixCoversTopic = kpContentWords.filter((word) => prefixWords.includes(word)).length >= 2;
    if (suffixHasKeyphrase && prefixCoversTopic) {
      violations.push({
        sectionId,
        heading,
        code: "duplicated-topic-append",
        snippet: heading.slice(0, 160),
      });
    }
  }

  const repeatedExactKeyphrase = keyphraseWords.length > 0
    && countTokenSequence(words, keyphraseWords) > 1;
  // Repeating a location can be legitimate in a comparison (for example,
  // "Hong Kong vs Singapore: What Hong Kong Brands Need to Know"). Treat it
  // as mechanical duplication only when the two colon halves also repeat a
  // content topic, or when the second location is a redundant trailing
  // "in/for Hong Kong" suffix. This keeps the production defect detectable
  // without making every second location mention a false positive.
  const colonRepeatedLocationTopic = colonParts.length >= 2 && (() => {
    const prefixWords = headingWords(colonParts.slice(0, -1).join(" "));
    const suffixWords = headingWords(colonParts[colonParts.length - 1]);
    const prefixHasLocation = countTokenSequence(prefixWords, ["hong", "kong"]) > 0;
    const suffixHasLocation = countTokenSequence(suffixWords, ["hong", "kong"]) > 0;
    const locationAndFunctionWords = new Set([...KEYPHRASE_FUNCTION_WORDS, "hong", "kong"]);
    const prefixTopics = new Set(prefixWords.filter((word) =>
      word.length > 2 && !locationAndFunctionWords.has(word),
    ));
    const sharedTopic = suffixWords.some((word) =>
      word.length > 2 && !locationAndFunctionWords.has(word) && prefixTopics.has(word),
    );
    return prefixHasLocation && suffixHasLocation && sharedTopic;
  })();
  const trailingRepeatedLocation = countTokenSequence(words, ["hong", "kong"]) > 1
    && /\b(?:in|for)\s+hong\s+kong\s*$/i.test(heading);
  const repeatedHongKong = colonRepeatedLocationTopic || trailingRepeatedLocation;
  if (repeatedExactKeyphrase || repeatedHongKong) {
    violations.push({
      sectionId,
      heading,
      code: "duplicated-keyphrase-heading",
      snippet: heading.slice(0, 160),
    });
  }

  return violations;
}

function numericTokens(text: string): string[] {
  // Treat alphanumeric forms such as 5G and B2B as numeric-bearing meaning as
  // well. A repair may not silently choose a colon half that drops one.
  return headingWords(text).filter((word) => /\d/.test(word));
}

const HEADING_FRAMING_WORDS = new Set([
  "what", "whats", "shaping", "why", "how", "guide", "overview",
  "introduction", "understanding", "explained", "matters", "state",
  "practical", "look", "future", "next", "steps",
]);

function chooseSafeColonPart(heading: string, keyphrase: string): string | null {
  const parts = heading.split(/[:：]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const requiredNumbers = new Set(numericTokens(heading));
  const keyphraseWords = headingWords(keyphrase);
  const allMeaningful = headingWords(heading)
    .filter((word) => word.length > 2 && !KEYPHRASE_FUNCTION_WORDS.has(word));
  const candidates = parts
    .map((part, index) => {
      const words = headingWords(part);
      const numbers = new Set(numericTokens(part));
      const losesNumber = [...requiredNumbers].some((number) => !numbers.has(number));
      const meaningful = words.filter((word) => word.length > 2 && !KEYPHRASE_FUNCTION_WORDS.has(word));
      const losesSubstantiveTopic = allMeaningful.some((word) =>
        !meaningful.includes(word) && !HEADING_FRAMING_WORDS.has(word),
      );
      const exactKeyphraseBonus = countTokenSequence(words, keyphraseWords) > 0 ? 6 : 0;
      return {
        part,
        index,
        safe: words.length >= 3 && !losesNumber && !losesSubstantiveTopic,
        score: new Set(meaningful).size + exactKeyphraseBonus,
      };
    })
    .filter((candidate) => candidate.safe)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0]?.part ?? null;
}

function removeRepeatedYears(heading: string): string {
  const seen = new Set<string>();
  let repaired = heading.replace(/\b(?:19|20)\d{2}\b/gi, (year) => {
    if (seen.has(year)) return "";
    seen.add(year);
    return year;
  });
  repaired = repaired
    .replace(/\b(?:for|in)\s*(?=[:：,;.!?]|$)/gi, "")
    .replace(/\s+([:：,;.!?])/g, "$1")
    .replace(/([:：,;])\s*([:：,;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s:：,;-]+$/, "")
    .trim();
  return repaired;
}

/**
 * Bounded deterministic repair for the heading defects detected above. It
 * only removes duplicated wording already present in the heading; it never
 * invents a new topic or drops a distinct numeric token. Unresolved headings
 * are returned unchanged so the caller can retry or fail before drafting.
 */
export function repairHeadingNaturalness(
  heading: string,
  keyphrase: string,
  sectionId = "outline",
): HeadingNaturalnessRepair {
  const original = heading.replace(/\s+/g, " ").trim();
  const initialViolations = assessHeadingTextNaturalness(original, keyphrase, sectionId);
  if (initialViolations.length === 0) {
    return {
      original,
      heading: original,
      changed: false,
      resolved: true,
      initialViolations,
      remainingViolations: [],
    };
  }

  let candidate = original;
  const hasColonDuplication = initialViolations.some((violation) =>
    violation.code === "duplicated-topic-append" || violation.code === "duplicated-keyphrase-heading",
  ) && /[:：]/.test(candidate);
  if (hasColonDuplication) candidate = chooseSafeColonPart(candidate, keyphrase) ?? candidate;

  // The outline fallback can otherwise produce "Why Hong Kong ... in Hong
  // Kong". Removing only the redundant trailing location is deterministic.
  const trailingHongKong = /\s+(?:in|for)\s+Hong Kong$/i;
  if (trailingHongKong.test(candidate)) {
    const withoutTail = candidate.replace(trailingHongKong, "").trim();
    if (/\bhong kong\b/i.test(withoutTail)) candidate = withoutTail;
  }

  candidate = removeRepeatedYears(candidate);
  const remainingViolations = assessHeadingTextNaturalness(candidate, keyphrase, sectionId);
  const resolved = remainingViolations.length === 0;
  return {
    original,
    heading: resolved ? candidate : original,
    changed: resolved && candidate !== original,
    resolved,
    initialViolations,
    remainingViolations,
  };
}

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
  for (const section of doc.sections) {
    if (section.sectionType !== "main") continue;
    violations.push(...assessHeadingTextNaturalness(section.heading, keyphrase, section.id));
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
  const seenBlockIds = new Set<string>();
  for (const violation of violations) {
    const section = doc.sections.find((item) => item.id === violation.sectionId);
    if (!section) continue;
    const index = section.blocks.findIndex((block) => {
      if (block.type !== "paragraph") return false;
      const html = renderComponentHtml({ id: section.id, blocks: [block], status: section.status });
      return html.includes(violation.url) && isPureSourceCitationBlock(html);
    });
    if (index < 0) continue;
    const blockId = section.blocks[index].id;
    if (seenBlockIds.has(blockId)) continue;
    seenBlockIds.add(blockId);
    found.push({ sectionId: section.id, blockId, url: violation.url });
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
  let removed = 0;
  for (const target of targets) {
    const section = doc.sections.find((item) => item.id === target.sectionId);
    if (!section) continue;
    const index = section.blocks.findIndex((block) => block.id === target.blockId);
    if (index < 0) continue;
    section.blocks.splice(index, 1);
    section.status = "trimmed";
    removed++;
  }
  return removed;
}
