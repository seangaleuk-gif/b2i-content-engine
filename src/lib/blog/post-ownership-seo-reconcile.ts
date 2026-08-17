// ── Post-Ownership SEO Reconciliation ──
// Factual-scan and claim-ownership sentence removal run AFTER SEO
// normalisation and can remove keyphrase placements. This deterministic stage
// runs immediately after ownership enforcement and restores the exact
// keyphrase in one suitable editorial H2 and naturally in the first 100
// readable words, while keeping keyphrase density inside 0.5%–3%.
//
// It never introduces unsupported claims, ownership violations, repetition or
// changes to protected content (CTA, language switcher, FAQ/schema, links,
// application-owned blocks). Reconciliation is computed on a cloned document
// and committed to the canonical document only when every guarantee holds.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import {
  countExactPhrase,
  extractReadableText,
  getFirstNReadableWords,
} from "@/lib/seo/seo-text-utils";
import { computeKeyphraseDensity, englishKeyphraseDensity } from "@/lib/content-standards";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { validateClaimOwnership, type ClaimOwnershipLedger } from "@/lib/blog/claim-ownership";
import { titleCaseKeyphrase } from "@/lib/services/text-utils";
import { scanSentenceQualityText, lowercaseStartValidTokensFromKeyphrase } from "@/lib/blog/sentence-quality";
import { findMalformedProseTextIssues } from "@/lib/blog/publication-quality";
import {
  assessHeadingNaturalness,
  assessHeadingTextNaturalness,
  repairHeadingNaturalness,
} from "@/lib/blog/content-relevance";

export interface PostOwnershipSeoReconcileResult {
  h2KeyphraseRestored: boolean;
  first100KeyphraseRestored: boolean;
  changedHeading: string | null;
  changedComponentIds: string[];
  keyphraseCountBefore: number;
  keyphraseCountAfter: number;
  densityBefore: number;
  densityAfter: number;
  ownershipViolationsAfter: number;
}

function readableKeyphraseCount(doc: ArticleDocument, keyphrase: string): number {
  return countExactPhrase(extractReadableText(renderArticleDocument(doc)), keyphrase);
}

/** The editorial H2s are the canonical section headings of non-FAQ,
 *  non-conclusion sections only. The FAQ heading, the conclusion heading and
 *  the CTA heading (a protected block) never count as editorial-H2 placement. */
function editorialHeadingTexts(doc: ArticleDocument): string[] {
  return doc.sections
    .filter(
      (section) =>
        section.sectionType !== "faq-heading"
        && section.sectionType !== "conclusion-heading",
    )
    .map((section) => section.heading);
}

/** Pick the most suitable editorial H2 to carry the keyphrase: the one with
 *  the highest word overlap, preferring earlier sections for natural flow. */
function bestHeadingForKeyphrase(
  sections: Array<{ id: string; heading: string }>,
  keyphrase: string,
): { id: string; heading: string } | null {
  if (sections.length === 0) return null;
  const kpWords = keyphrase.toLowerCase().split(/\s+/).filter(Boolean);
  const kpLower = keyphrase.toLowerCase();
  let best: { id: string; heading: string } | null = null;
  let bestOverlap = -1;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (let index = 0; index < sections.length; index++) {
    const heading = sections[index].heading;
    const hLower = heading.toLowerCase();
    if (hLower.includes(kpLower)) return null;
    const overlap = [...new Set(hLower.split(/\s+/))]
      .filter((word) => kpWords.includes(word))
      .length;
    if (overlap > bestOverlap || (overlap === bestOverlap && index < bestIndex)) {
      bestOverlap = overlap;
      bestIndex = index;
      best = sections[index];
    }
  }
  return best;
}

/** Build a natural editorial H2 that contains the exact keyphrase. When the
 *  heading already ends with a prefix of the keyphrase (e.g. "…Hong Kong
 *  Marketing" + "hong kong marketing trends 2026"), the remaining words are
 *  appended naturally ("…Hong Kong Marketing Trends 2026"). When the heading
 *  already covers the topic and year (e.g. "The State of Digital Marketing in
 *  Hong Kong for 2026"), appending the keyphrase would duplicate the topic, so
 *  the keyphrase is PREPENDED instead ("Hong Kong Marketing Trends 2026: The
 *  State of Digital Marketing"). As a last resort the ": Keyphrase" suffix is
 *  used only when the heading does not cover the topic. */
export function buildNaturalHeading(heading: string, keyphrase: string): string {
  const kpLower = keyphrase.toLowerCase();
  if (heading.toLowerCase().includes(kpLower)) return heading;

  const titleCase = titleCaseKeyphrase(keyphrase);
  const kpHasYear = /\b(?:19|20)\d{2}\b/.test(kpLower);

  // When the keyphrase itself carries the year, a heading that repeats the
  // year ("...for 2026" / "...in Hong Kong for 2026") is stripped so the
  // result never contains two years.
  let trimmed = heading.replace(/[:：\s]+$/, "").trim();
  if (kpHasYear) {
    const stripped = trimmed
      .replace(/\s+(?:for\s+(?:19|20)\d{2}|in\s+(?:Hong Kong\s+)?for\s+(?:19|20)\d{2}|in\s+(?:19|20)\d{2})$/i, "")
      .trim();
    if (stripped !== trimmed) {
      trimmed = stripped || trimmed;
      // The year is now carried by the keyphrase: prepend it for a natural
      // "Keyphrase: Topic" title/subtitle form.
      const prefix = `${titleCase}: ${trimmed}`;
      return prefix.length <= 90
        && assessHeadingTextNaturalness(prefix, keyphrase).length === 0
        ? prefix
        : heading;
    }
  }

  const kpWords = kpLower.split(/\s+/).filter(Boolean);
  const hLower = trimmed.toLowerCase();
  const headingLowerWords = hLower.split(/\s+/);

  // A heading that already covers the topic must not receive a duplicated
  // ": Keyphrase" append.
  if (headingAlreadyCoversTopic(trimmed, keyphrase)) {
    const prefix = `${titleCase}: ${trimmed}`;
    return prefix.length <= 90
      && assessHeadingTextNaturalness(prefix, keyphrase).length === 0
      ? prefix
      : heading;
  }

  // Longest keyphrase-prefix that matches the heading tail (word boundaries).
  for (let matchLen = kpWords.length - 1; matchLen >= 1; matchLen--) {
    const tail = headingLowerWords.slice(-matchLen);
    const kpPrefix = kpWords.slice(0, matchLen);
    if (tail.join(" ") === kpPrefix.join(" ")) {
      const missing = kpWords.slice(matchLen);
      const suffix = missing.map((word) => titleCaseKeyphrase(word)).join(" ");
      const candidate = `${trimmed} ${suffix}`;
      if (candidate.length <= 90 && assessHeadingTextNaturalness(candidate, keyphrase).length === 0) {
        return candidate;
      }
    }
  }

  const candidate = `${trimmed}: ${titleCase}`;
  if (candidate.length <= 90 && assessHeadingTextNaturalness(candidate, keyphrase).length === 0) {
    return candidate;
  }
  const prefix = `${titleCase}: ${trimmed}`;
  return prefix.length <= 90 && assessHeadingTextNaturalness(prefix, keyphrase).length === 0
    ? prefix
    : heading;
}

/** True when the heading already states the keyphrase's topic and year, so
 *  appending the keyphrase would be a duplicated concatenation. */
function headingAlreadyCoversTopic(heading: string, keyphrase: string): boolean {
  const lower = heading.toLowerCase();
  const words = keyphrase.toLowerCase().split(/\s+/).filter(Boolean);
  const year = words.find((word) => /^\d{4}$/.test(word));
  const contentWords = words.filter((word) => !/^\d{4}$/.test(word) && word.length > 2);
  if (year && lower.includes(year)) {
    const covered = contentWords.filter((word) => lower.includes(word)).length;
    return covered >= 2;
  }
  return contentWords.filter((word) => lower.includes(word)).length >= Math.max(2, contentWords.length - 1);
}

/** Keyphrase content words that form a phrase: "hong kong", "marketing
 *  trends", "trends 2026". If the paragraph ALREADY contains such an adjacent
 *  pair outside the inserted exact-keyphrase occurrence, inserting the full
 *  keyphrase would read as duplication ("...hong kong marketing trends 2026,
 *  Hong Kong marketing is changing fast."). */
const KEYPHRASE_PAIR_STOP_WORDS = new Set([
  "the", "a", "an", "for", "of", "in", "on", "at", "to", "with", "and", "or",
  "that", "this", "these", "those", "how", "what", "when", "why", "where",
  "is", "are", "will", "be", "it", "its", "you", "your",
]);

function keyphraseContentWords(keyphrase: string): string[] {
  return (keyphrase.toLowerCase().match(/[a-z0-9]+/gi) ?? [])
    .filter((word) => word.length > 2);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the text carries a keyphrase-word phrase (an adjacent pair of
 *  keyphrase content words) OUTSIDE the exact keyphrase occurrence itself.
 *  Rejects repairs that would duplicate the keyphrase's own phrasing. */
function hasDuplicatedKeyphrasePhrasing(text: string, keyphrase: string): boolean {
  const lower = text.toLowerCase();
  const kpLower = keyphrase.toLowerCase();
  if (!lower.includes(kpLower)) return false;
  const remainder = lower.replace(new RegExp(escapeRegexLiteral(kpLower), "g"), " ");
  const words = keyphraseContentWords(keyphrase);
  for (let index = 0; index < words.length - 1; index++) {
    const pair = `${words[index]} ${words[index + 1]}`;
    if (pair.split(/\s+/).every((word) => KEYPHRASE_PAIR_STOP_WORDS.has(word))) continue;
    if (remainder.includes(pair)) return true;
  }
  return false;
}

/** Lowercasing the paragraph's first word after prepending the lead must never
 *  break a proper-noun phrase ("Hong Kong" → "hong Kong"). A capitalized
 *  first word followed by another capitalized word, or a first word that keeps
 *  an interior capital (brand casing), means the repair cannot read naturally. */
function lowercaseWouldBreakProperNoun(firstSentence: string): boolean {
  const words = firstSentence.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const first = words[0];
  if (!/^[A-Z]/.test(first)) return false;
  if (/[A-Z]/.test(first.slice(1))) return true;
  if (words[1] && /^[A-Z]/.test(words[1])) return true;
  return false;
}

/**
 * Insert the exact keyphrase naturally at the start of the introduction's
 * first paragraph so it appears inside the first 100 readable words. Inline
 * content (links, emphasis, strong) is preserved node-for-node: only a leading
 * text node is prepended and the first alpha of the first sentence is
 * lowercased in place, so an injected internal link in the opening paragraph
 * can never be lost by the reconciliation.
 *
 * The candidate is committed ONLY when it passes the same sentence-quality,
 * malformed-prose, duplication and capitalization gates used by every other
 * deterministic repair. A repair that would create keyword-shaped prose,
 * duplicated keyphrase phrasing, a broken proper-noun casing or malformed
 * grammar is NOT committed — the soft first-100 signal stays unsatisfied
 * rather than corrupting the introduction.
 */
function insertKeyphraseInIntroduction(
  doc: ArticleDocument,
  keyphrase: string,
): { changed: boolean } {
  const intro = doc.introduction;
  const target = intro.blocks.findIndex((block) => {
    if (block.type !== "paragraph") return false;
    const text = block.content.map((node) => node.text).join("").trim();
    return text.length >= 20;
  });
  if (target < 0) return { changed: false };
  const block = intro.blocks[target] as Extract<EditorialBlock, { type: "paragraph" }>;
  const fullText = block.content.map((node) => node.text).join("");
  if (fullText.toLowerCase().includes(keyphrase.toLowerCase())) {
    return { changed: false };
  }
  const firstSentence = fullText.match(/^[^.!?]+[.!?]+/)?.[0];
  if (!firstSentence) return { changed: false };

  // Naturalness gates. The lead must not duplicate keyphrase phrasing already
  // present in the paragraph, and lowercasing the opening must not break a
  // proper-noun phrase such as "Hong Kong".
  const lead = `When it comes to ${keyphrase}, `;
  const candidateText = `${lead}${fullText}`;
  const validTokens = lowercaseStartValidTokensFromKeyphrase(keyphrase);
  if (hasDuplicatedKeyphrasePhrasing(candidateText, keyphrase)) return { changed: false };
  if (lowercaseWouldBreakProperNoun(firstSentence)) return { changed: false };
  if (scanSentenceQualityText(candidateText, { validLowercaseTokens: validTokens }).length > 0) {
    return { changed: false };
  }
  if (findMalformedProseTextIssues([candidateText], ["paragraph"]).length > 0) {
    return { changed: false };
  }
  // The repaired first 100 readable words must actually contain the keyphrase.
  const first100 = getFirstNReadableWords(renderArticleDocument(doc), 100).toLowerCase();
  const kpLower = keyphrase.toLowerCase();
  if (!first100.includes(kpLower) && !candidateText.toLowerCase().includes(kpLower)) {
    return { changed: false };
  }

  let newContent = [...block.content];
  // Lowercase the first alpha of the first sentence in place (node-aware), so
  // the lead reads naturally without rebuilding the paragraph as one text node.
  const alphaMatch = fullText.match(/[a-zA-Z]/);
  if (alphaMatch && alphaMatch.index !== undefined) {
    let cursor = 0;
    for (let index = 0; index < newContent.length; index++) {
      const node = newContent[index];
      const nodeEnd = cursor + node.text.length;
      if (alphaMatch.index >= cursor && alphaMatch.index < nodeEnd) {
        const local = alphaMatch.index - cursor;
        newContent[index] = {
          ...node,
          text: node.text.slice(0, local) + node.text[local].toLowerCase() + node.text.slice(local + 1),
        };
        break;
      }
      cursor = nodeEnd;
    }
  }
  // Prepend the lead as a text node (merging into an existing leading text
  // node when possible). Link/strong/emphasis nodes are never replaced.
  if (newContent[0].type === "text") {
    newContent[0] = { ...newContent[0], text: lead + newContent[0].text };
  } else {
    newContent = [{ type: "text", text: lead }, ...newContent];
  }

  const newBlock: Extract<EditorialBlock, { type: "paragraph" }> = {
    ...block,
    content: newContent,
  };
  intro.blocks[target] = newBlock;
  return { changed: true };
}

/**
 * Restore missing keyphrase placements deterministically after factual and
 * ownership enforcement. The canonical document is committed only when the
 * reconciled clone keeps density inside 0.5%–3%, introduces no unsupported
 * claims and introduces no ownership violations.
 */
export function reconcilePostOwnershipKeyphrase(
  doc: ArticleDocument,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
  ledger?: ClaimOwnershipLedger,
): PostOwnershipSeoReconcileResult {
  const result: PostOwnershipSeoReconcileResult = {
    h2KeyphraseRestored: false,
    first100KeyphraseRestored: false,
    changedHeading: null,
    changedComponentIds: [],
    keyphraseCountBefore: 0,
    keyphraseCountAfter: 0,
    densityBefore: 0,
    densityAfter: 0,
    ownershipViolationsAfter: 0,
  };
  const kpLower = keyphrase.toLowerCase().trim();
  if (!kpLower) return result;
  result.keyphraseCountBefore = readableKeyphraseCount(doc, keyphrase);
  const wordCountBefore = countCanonicalVisibleWords(doc);
  result.densityBefore = computeKeyphraseDensity(
    result.keyphraseCountBefore,
    keyphrase,
    wordCountBefore,
  );

  const candidate = structuredClone(doc);
  const changedIds = new Set<string>();

  // 1. One suitable editorial H2. The FAQ heading and CTA heading never count:
  // placement and detection both use the canonical editorial section headings.
  const hasKpInH2 = editorialHeadingTexts(candidate).some((heading) =>
    heading.toLowerCase().includes(kpLower),
  );
  let changedHeading: string | null = null;
  if (!hasKpInH2) {
    const editorialSections = candidate.sections
      .filter(
        (section) =>
          section.sectionType !== "faq-heading"
          && section.sectionType !== "conclusion-heading",
      )
      .map((section) => ({ id: section.id, heading: section.heading }));
    const target = bestHeadingForKeyphrase(editorialSections, keyphrase);
    if (target) {
      const newHeading = buildNaturalHeading(target.heading, keyphrase);
      if (newHeading !== target.heading) {
        const section = candidate.sections.find((item) => item.id === target.id);
        if (section) {
          changedHeading = target.heading;
          section.heading = newHeading;
          changedIds.add(target.id);
        }
      }
    }
  }

  // 2. First 100 readable words.
  const first100 = getFirstNReadableWords(renderArticleDocument(candidate), 100).toLowerCase();
  if (!first100.includes(kpLower)) {
    if (insertKeyphraseInIntroduction(candidate, keyphrase).changed) {
      changedIds.add(candidate.introduction.id);
    }
  }

  // 3. Guarantees. Reject the whole reconciliation unless every guarantee holds.
  const { warningBelow: kpWarning, stuffingAbove: kpStuffing } = englishKeyphraseDensity();
  const finalWordCount = countCanonicalVisibleWords(candidate);
  const density = computeKeyphraseDensity(
    readableKeyphraseCount(candidate, keyphrase),
    keyphrase,
    finalWordCount,
  );
  const unsupported = scanFactualRisks(
    renderArticleDocument(candidate),
    keyphrase,
    research,
  ).claims.filter((claim) => !claim.supported);
  const ownershipViolations = ledger
    ? validateClaimOwnership(candidate, ledger, keyphrase, research)
    : [];
  result.ownershipViolationsAfter = ownershipViolations.length;

  const safe = density >= kpWarning
    && density <= kpStuffing
    && unsupported.length === 0
    && ownershipViolations.length === 0
    && assessHeadingNaturalness(candidate, keyphrase).length === 0;

  if (safe && changedIds.size > 0) {
    // Commit the reconciled clone onto the canonical document.
    doc.sections = candidate.sections;
    doc.introduction = candidate.introduction;
    result.h2KeyphraseRestored = changedHeading !== null;
    result.first100KeyphraseRestored = changedIds.has(candidate.introduction.id);
    result.changedHeading = changedHeading;
    result.changedComponentIds = [...changedIds];
  }

  result.keyphraseCountAfter = readableKeyphraseCount(doc, keyphrase);
  result.densityAfter = computeKeyphraseDensity(
    result.keyphraseCountAfter,
    keyphrase,
    countCanonicalVisibleWords(doc),
  );
  return result;
}

export interface EditorialH2EnforcementResult {
  /** True when at least one natural editorial H2 carries the exact keyphrase. */
  satisfied: boolean;
  /** The editorial H2 text that was replaced, or null when nothing changed. */
  changedHeading: string | null;
  /** The canonical section ID whose heading was repaired, or null. */
  changedSectionId: string | null;
  /** The heading text after enforcement, or null when not applicable. */
  headingAfter: string | null;
  /** Human-readable reasons for an unsatisfied guarantee. */
  reasons: string[];
}

/**
 * Authoritative save-boundary guarantee for the English pipeline: at least one
 * normal editorial H2 must contain the exact focus keyphrase, and every
 * editorial heading must remain natural. FAQ, conclusion and CTA/protected
 * headings never count as editorial-H2 placement.
 *
 * When the keyphrase is missing (or the only keyphrase-bearing editorial H2 is
 * a duplicated/unnatural concatenation), the existing natural reconciliation
 * helpers pick the most suitable editorial H2 and rebuild its heading so the
 * exact keyphrase appears naturally. The mutation is committed only when the
 * repaired heading carries the exact keyphrase and passes the shared
 * naturalness gate. The caller must fail closed (block persistence) when this
 * returns `satisfied: false`.
 */
export function enforceEditorialH2Keyphrase(
  doc: ArticleDocument,
  keyphrase: string,
): EditorialH2EnforcementResult {
  const kpLower = keyphrase.toLowerCase().trim();
  const empty: EditorialH2EnforcementResult = {
    satisfied: false,
    changedHeading: null,
    changedSectionId: null,
    headingAfter: null,
    reasons: [],
  };
  if (!kpLower) {
    return { ...empty, reasons: ["empty focus keyphrase"] };
  }

  const editorialSections = doc.sections
    .filter(
      (section) =>
        section.sectionType !== "faq-heading"
        && section.sectionType !== "conclusion-heading",
    )
    .map((section) => ({ id: section.id, heading: section.heading }));

  if (editorialSections.length === 0) {
    return { ...empty, reasons: ["no editorial H2 available"] };
  }

  // A natural editorial H2 that already carries the exact keyphrase is
  // compliant; the article is left unchanged.
  const existing = editorialSections.find((section) =>
    section.heading.toLowerCase().includes(kpLower),
  );
  if (
    existing
    && assessHeadingTextNaturalness(existing.heading, keyphrase, existing.id).length === 0
  ) {
    return {
      satisfied: true,
      changedHeading: null,
      changedSectionId: null,
      headingAfter: existing.heading,
      reasons: [],
    };
  }

  // When the only keyphrase-bearing editorial heading is unnatural (for
  // example a duplicated year/topic append such as
  // "The State of Digital Marketing in Hong Kong for 2026: Hong Kong
  // Marketing Trends 2026"), strip the duplication first and then re-apply the
  // keyphrase naturally. An unresolvable duplication stays a hard failure.
  const existingSection = existing
    ? doc.sections.find((section) => section.id === existing.id)
    : undefined;
  const baseHeading = existingSection
    ? (() => {
        const repair = repairHeadingNaturalness(
          existingSection.heading,
          keyphrase,
          existingSection.id,
        );
        return repair.resolved && repair.changed ? repair.heading : existingSection.heading;
      })()
    : null;

  const candidateSections = baseHeading !== null
    ? editorialSections.map((section) =>
        section.id === existing!.id ? { ...section, heading: baseHeading } : section,
      )
    : editorialSections;

  const target = bestHeadingForKeyphrase(candidateSections, keyphrase);
  if (!target) {
    return {
      ...empty,
      reasons: ["no suitable editorial H2 to repair naturally"],
    };
  }

  const newHeading = buildNaturalHeading(target.heading, keyphrase);
  if (newHeading === target.heading || !newHeading.toLowerCase().includes(kpLower)) {
    return {
      ...empty,
      reasons: ["natural repair could not produce a keyphrase-bearing editorial H2"],
    };
  }
  const violations = assessHeadingTextNaturalness(newHeading, keyphrase, target.id);
  if (violations.length > 0) {
    return {
      ...empty,
      reasons: [`repaired heading fails naturalness: ${violations.map((v) => v.code).join(", ")}`],
    };
  }

  const section = doc.sections.find((item) => item.id === target.id);
  if (!section) {
    return { ...empty, reasons: ["target editorial section not found"] };
  }
  const previous = section.heading;
  section.heading = newHeading;
  return {
    satisfied: true,
    changedHeading: previous,
    changedSectionId: target.id,
    headingAfter: newHeading,
    reasons: [],
  };
}
