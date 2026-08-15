// ── Structure-Aware Compression and Coherence Validation ──
//
// The final-trim stage must never damage coherence by deleting arbitrary
// sentences or paragraphs. This module provides:
//
// 1. Structure-aware deterministic compression: repetition and low-value
//    detail are removed first; complete arguments, examples, transitions,
//    evidence, links and heading relationships are preserved. Setup
//    sentences, examples, quotations and comparisons are never left
//    unfinished, and no section is thinned below a floor.
//
// 2. Deterministic coherence validation used immediately after trimming (and
//    again at the final gate): unfinished examples/setups, orphan transitions,
//    dangling references, fragmentary sentences, broken paragraph-to-paragraph
//    continuity and sections too thin to support their heading. Unresolved
//    coherence damage blocks saving.

import type { ArticleDocument, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";
import {
  renderComponentHtml,
  countCanonicalVisibleWords,
  isNonEmptyStructuredContinuation,
} from "@/lib/blog/article-document";
import { countReadableWords } from "@/lib/services/text-utils";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { isSourceBoilerplate } from "@/lib/blog/source-boilerplate";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import { countSectionGroundingCarriers, textCarriesHeadingContentWord } from "@/lib/blog/content-relevance";
import {
  dropPunctuationOnlyResidueFromContent,
  dropPunctuationOnlySentences,
} from "@/lib/blog/sentence-quality";
import {
  isSentenceComplete,
  type SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";

export type CoherenceViolationType =
  | "unfinished-example"
  | "orphan-transition"
  | "dangling-reference"
  | "incomplete-sentence"
  | "thin-section"
  | "empty-section";

export interface CoherenceViolation {
  componentId: string;
  blockId: string | null;
  type: CoherenceViolationType;
  snippet: string;
}

/** A section must keep at least this many words to remain a coherent unit
 *  under its heading. */
export const MIN_SECTION_WORDS = 40;

const EXAMPLE_MARKERS =
  /\b(?:a good example|for example|for instance|as an example|imagine|consider|take\s+[\w]+(?:\s+and\s+[\w]+)?\s+for example|here'?s an example)\b/i;

const PENDING_EXAMPLE_PATTERN =
  /\b(?:wants?|plans?|hopes?|aims?|intends?|is (?:thinking|considering|planning|looking)|decides?|needs?|tries?|would like|will try|expects?)\s+to\b/i;

const ORPHAN_TRANSITION_RE =
  /^\s*(?:instead|however|therefore|meanwhile|moreover|furthermore|nevertheless|nonetheless|consequently|additionally|likewise|similarly|hence|thus|yet|so|but|and)\s*[,:]/i;

const ORPHAN_TRANSITION_PHRASES =
  /^\s*(?:as a result|on the other hand|that said|in addition|at the same time|for this reason|for that reason|in other words)\s*[,:]/i;

const INSTEAD_TRANSITION_RE = /^\s*instead\s*[,:]/i;

/**
 * "Instead" is contrast-dependent in a way that summary/additive transitions
 * are not. A nearby paragraph is an antecedent only when it actually presents
 * an alternative, limitation or rejected approach. This keeps genuine
 * orphaned "Instead" openings blocked while allowing normal summary prose
 * such as "So, what does this mean ...?" after a source citation.
 */
const CONTRAST_ANTECEDENT_RE =
  /\b(?:not|never|no longer|rather than|instead of|but|however|avoid|stop|cannot|can['’]t|do(?:es)?n['’]t|won['’]t|shouldn['’]t|traditional (?:approach|method|model)|generic (?:approach|message|content)|rejected alternative)\b/i;

const DANGLING_REFERENCE_RE =
  /^\s*(?:this|that|these|those|it|they|its|their|them)\s+(?:is|are|was|were|means|mean|shows?|show|suggests?|suggest|makes?|make|reflects?|reflect|represents?|represent)\b/i;

const SETUP_ENDING_RE = /[:—-]$/;

function plainBlockText(block: EditorialBlock): string {
  if (block.type === "list") return block.items.flat().map((node) => node.text).join(" ");
  if (block.type === "table") {
    return [...block.headers, ...block.rows.flat()].flat().map((node) => node.text).join(" ");
  }
  if (block.type === "quote" || block.type === "subheading") {
    return block.content.map((node) => node.text).join(" ");
  }
  return block.content.map((node) => node.text).join(" ");
}

function editorialSections(doc: ArticleDocument): ArticleSection[] {
  return doc.sections.filter(
    (section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading",
  );
}

function isSourceCitation(text: string): boolean {
  return /^\s*sources?:\s*/i.test(text);
}

function hasCompleteSubstantiveAntecedent(text: string): boolean {
  if (isSourceCitation(text)) return false;
  if (countReadableWords(text) < 5) return false;
  const trimmed = text.replace(/["”’)\]]+$/, "");
  return /[.!?]$/.test(trimmed) && !SETUP_ENDING_RE.test(trimmed);
}

function previousSubstantiveParagraph(
  paragraphs: Array<{ block: EditorialBlock; text: string }>,
  currentIndex: number,
): { block: EditorialBlock; text: string } | null {
  for (let index = currentIndex - 1; index >= 0; index--) {
    const candidate = paragraphs[index];
    if (isSourceCitation(candidate.text)) continue;
    return hasCompleteSubstantiveAntecedent(candidate.text) ? candidate : null;
  }
  return null;
}

/**
 * Deterministic coherence validation of the canonical document. Any returned
 * violation is unresolved damage: the article must not save with it.
 */
export function validateCoherence(doc: ArticleDocument): CoherenceViolation[] {
  const violations: CoherenceViolation[] = [];

  const checkComponent = (componentId: string, blocks: EditorialBlock[]) => {
    const paragraphs = blocks
      .map((block) => ({ block, text: plainBlockText(block).replace(/\s+/g, " ").trim() }))
      // H3 subheadings are structural headings, not sentences: they are never
      // required to carry terminal punctuation and never open/close examples.
      .filter((entry) => entry.text.length > 0 && entry.block.type !== "subheading");

    for (let i = 0; i < paragraphs.length; i++) {
      const { block, text } = paragraphs[i];
      const next = paragraphs[i + 1];

      // 1. Incomplete sentence / fragment. Uses the SAME shared
      //    block-type-aware sentence-completeness validator as AI block
      //    acceptance, malformed-prose scanning/repair, trim/compaction
      //    candidate validation and the final QC/pre-save gates, so no
      //    scanner can disagree about a truncated block. Paragraphs, quotes
      //    and FAQ answers require complete prose; list items and table
      //    cells are structural and only unmistakable fragments count.
      const incomplete = ((): boolean => {
        if (block.type === "list") {
          return block.items.some((item) =>
            !isSentenceComplete(item.map((node) => node.text).join("").trim(), "list-item"),
          );
        }
        if (block.type === "table") {
          const cells = [...block.headers, ...block.rows.flat()]
            .map((cell) => cell.map((node) => node.text).join("").trim());
          return cells.some((cell) => !isSentenceComplete(cell, "table-cell"));
        }
        const kind: SentenceCompletenessKind = block.type === "quote" ? "quote" : "paragraph";
        const hasStructuredContinuation = isNonEmptyStructuredContinuation(next?.block);
        return !isSentenceComplete(text, kind, {
          allowColonBeforeStructuredContinuation:
            block.type === "paragraph" && hasStructuredContinuation,
        });
      })();
      if (incomplete) {
        violations.push({
          componentId,
          blockId: block.id,
          type: "incomplete-sentence",
          snippet: text.slice(0, 160),
        });
        continue;
      }

      // 2. Unfinished example: an example marker paragraph is dangling when it
      //    has a single sentence that introduces a pending action without a
      //    resolution, or when nothing follows it in the section. A following
      //    paragraph that refers back to the example ("It could...", "The
      //    brand then...") counts as the resolution.
      if (EXAMPLE_MARKERS.test(text)) {
        const singleSentence = (text.match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g) ?? []).length <= 1;
        const pending = PENDING_EXAMPLE_PATTERN.test(text);
        const nothingFollows = !next;
        const nextRefersBack = Boolean(
          next
          && /^\s*(?:it|they|this|that|these|those|the (?:brand|business|shop|company|store|startup|team|boutique))\b/i.test(next.text),
        );
        if (singleSentence && (pending || nothingFollows) && !nextRefersBack) {
          violations.push({
            componentId,
            blockId: block.id,
            type: "unfinished-example",
            snippet: text.slice(0, 160),
          });
        }
      }

      // 3. Orphan transition: inspect nearby substantive context instead of
      //    treating the immediately previous block as the whole context. A
      //    Source: citation is metadata for the preceding claim, so it is
      //    skipped when looking for an antecedent. "Instead" additionally
      //    requires an actual contrast/alternative signal in that antecedent.
      const transition = ORPHAN_TRANSITION_RE.test(text) || ORPHAN_TRANSITION_PHRASES.test(text);
      if (transition) {
        const antecedent = previousSubstantiveParagraph(paragraphs, i);
        const missingSemanticRelationship = !antecedent
          || (INSTEAD_TRANSITION_RE.test(text) && !CONTRAST_ANTECEDENT_RE.test(antecedent.text));
        if (missingSemanticRelationship) {
          violations.push({
            componentId,
            blockId: block.id,
            type: "orphan-transition",
            snippet: text.slice(0, 160),
          });
        }
      }

      // 4. Dangling reference: a demonstrative pronoun opening the component
      //    (first paragraph) cannot refer back to anything.
      if (i === 0 && DANGLING_REFERENCE_RE.test(text)) {
        violations.push({
          componentId,
          blockId: block.id,
          type: "dangling-reference",
          snippet: text.slice(0, 160),
        });
      }
    }
  };

  checkComponent(doc.introduction.id, doc.introduction.blocks);
  for (const section of editorialSections(doc)) {
    checkComponent(section.id, section.blocks);
  }
  checkComponent(doc.conclusion.id, doc.conclusion.blocks);

  // 5. Sections too thin to support their heading (or empty).
  for (const section of editorialSections(doc)) {
    const words = countReadableWords(renderComponentHtml(section));
    const paragraphCount = section.blocks.filter((block) => block.type === "paragraph" || block.type === "list").length;
    if (paragraphCount === 0) {
      violations.push({
        componentId: section.id,
        blockId: null,
        type: "empty-section",
        snippet: section.heading.slice(0, 160),
      });
    } else if (words < MIN_SECTION_WORDS) {
      violations.push({
        componentId: section.id,
        blockId: null,
        type: "thin-section",
        snippet: `${section.heading} (${words} words)`,
      });
    }
  }

  return violations;
}

/** The paragraph must be safe to remove as a whole block. */
function isRemovableParagraph(
  doc: ArticleDocument,
  section: ArticleSection,
  blockIndex: number,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): boolean {
  const block = section.blocks[blockIndex];
  if (block.type !== "paragraph") return false;
  const text = plainBlockText(block).replace(/\s+/g, " ").trim();
  if (text.length < 20) return false;

  // Protected content and facts can never be deleted.
  if (block.content.some((node) => node.type === "link")) return false;
  if (isSourceBoilerplate(text)) return true; // boilerplate is the preferred removal target
  if (text.toLowerCase().includes(keyphrase.toLowerCase())) return false;
  if (scanFactualRisks(renderComponentHtml({ id: section.id, blocks: [block], status: section.status }), keyphrase, research).claims.length > 0) return false;
  if (/according to|research (?:from|by)|data (?:from|shows)|study (?:from|by)/i.test(text)) return false;
  if (/\d/.test(text)) return false;

  // Boundary preservation: never remove the first or last paragraph of a
  // section (the section opener and closer carry the heading relationship).
  const paragraphIndexes = section.blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.type === "paragraph")
    .map(({ i }) => i);
  if (paragraphIndexes.length <= 1) return false;
  if (blockIndex === paragraphIndexes[0] || blockIndex === paragraphIndexes[paragraphIndexes.length - 1]) return false;

  // Setup/example paragraphs must never be removed (their continuation would dangle).
  if (EXAMPLE_MARKERS.test(text)) return false;

  // A paragraph that opens with a transition carries the previous paragraph's
  // conclusion; removing it would orphan the contrast.
  if (ORPHAN_TRANSITION_RE.test(text) || ORPHAN_TRANSITION_PHRASES.test(text)) return false;

  // The following paragraph must not depend on this paragraph's content.
  const nextBlock = section.blocks[blockIndex + 1];
  if (nextBlock) {
    const nextText = plainBlockText(nextBlock).replace(/\s+/g, " ").trim();
    if (ORPHAN_TRANSITION_RE.test(nextText) || ORPHAN_TRANSITION_PHRASES.test(nextText)) return false;
    if (DANGLING_REFERENCE_RE.test(nextText)) return false;
    if (EXAMPLE_MARKERS.test(text) === false && /^this\b|^that\b|^these\b|^those\b|^it\b|^they\b/i.test(nextText)) return false;
  }
  // The previous paragraph must not be an example marker that this paragraph
  // completes.
  const prevBlock = section.blocks[blockIndex - 1];
  if (prevBlock && EXAMPLE_MARKERS.test(plainBlockText(prevBlock))) return false;

  return true;
}

/** Lowest-value-first score for whole-paragraph removal. */
function removalPriority(
  section: ArticleSection,
  blockIndex: number,
): number {
  const block = section.blocks[blockIndex];
  const text = plainBlockText(block).replace(/\s+/g, " ").trim();
  let score = 0;
  if (isSourceBoilerplate(text)) score -= 100;
  // Short low-value detail paragraphs are cheaper to remove than long ones.
  score += Math.min(30, countReadableWords(renderComponentHtml({ id: section.id, blocks: [block], status: section.status })));
  // Prefer paragraphs further from the section boundaries.
  const distance = Math.min(blockIndex, section.blocks.length - 1 - blockIndex);
  score += Math.max(0, 8 - distance);
  return score;
}

/**
 * Structure-aware deterministic compression. Removes whole low-value
 * paragraphs (never boundaries, examples, transitions, evidence, links or
 * protected content), then — only when the paragraph is still coherent —
 * shortens a paragraph by removing its first or last non-boundary sentence.
 * Never leaves setups, examples or transitions unfinished and never thins a
 * section below MIN_SECTION_WORDS.
 */
export function compressDocumentStructureAware(
  doc: ArticleDocument,
  wordMax: number,
  wordMin: number,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): {
  removedWords: number;
  removedParagraphs: number;
  shortenedSentences: number;
  remainingExcess: number;
} {
  let removedWords = 0;
  let removedParagraphs = 0;
  let shortenedSentences = 0;

  // Pass 0: punctuation-only residue (".") is deleted-sentence debris. The
  // trim producer owns the final compaction boundary: it must NEVER commit
  // punctuation-only residue, including inside linked/inline-node paragraphs.
  // Every editorial paragraph is cleaned of residue sentences first — even
  // when the paragraph would not otherwise be shortened — using the shared
  // node-preserving residue drop, so a residue paragraph can never be carried
  // past final trim into the final-preflight repair boundary.
  for (const section of editorialSections(doc)) {
    for (const block of section.blocks) {
      if (block.type !== "paragraph") continue;
      const originalText = block.content.map((node) => node.text).join("").replace(/\s+/g, " ").trim();
      const cleaned = dropPunctuationOnlyResidueFromContent(block.content);
      if (!cleaned) continue;
      const cleanedText = cleaned.map((node) => node.text).join("").replace(/\s+/g, " ").trim();
      if (!cleanedText || cleanedText === originalText) continue;
      block.content = cleaned;
      section.status = "trimmed";
      removedWords += Math.max(
        0,
        originalText.split(/\s+/).filter(Boolean).length
        - cleanedText.split(/\s+/).filter(Boolean).length,
      );
      shortenedSentences++;
    }
  }

  // Pass 1: whole-paragraph removal (low-value detail first).
  for (let guard = 0; guard < 30 && countCanonicalVisibleWords(doc) > wordMax; guard++) {
    const candidates: Array<{ section: ArticleSection; blockIndex: number; wordCount: number; score: number }> = [];
    for (const section of editorialSections(doc)) {
      const sectionWords = countReadableWords(renderComponentHtml(section));
      for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
        if (!isRemovableParagraph(doc, section, blockIndex, keyphrase, research)) continue;
        const block = section.blocks[blockIndex];
        const blockWords = countReadableWords(renderComponentHtml({ id: section.id, blocks: [block], status: section.status }));
        if (sectionWords - blockWords < MIN_SECTION_WORDS) continue;
        if (countCanonicalVisibleWords(doc) - blockWords < wordMin) continue;
        // Section topic grounding is a hard invariant: never remove the last
        // paragraph carrying a heading content word, or the section becomes
        // ungrounded and fails final QC. This guard only applies to sections
        // that are CURRENTLY grounded — a section that was already ungrounded
        // (pre-existing damage) may still be trimmed; the grounding delta
        // belongs to its introducer, not to the trim producer.
        if (
          countSectionGroundingCarriers(section) > 0
          && countSectionGroundingCarriers(section, blockIndex) === 0
        ) {
          continue;
        }
        candidates.push({
          section,
          blockIndex,
          wordCount: blockWords,
          score: removalPriority(section, blockIndex),
        });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.score - b.score);
    const selected = candidates[0];
    selected.section.blocks.splice(selected.blockIndex, 1);
    selected.section.status = "trimmed";
    removedWords += selected.wordCount;
    removedParagraphs++;
  }

  // Pass 2: sentence-level shortening of non-boundary sentences, only when the
  // paragraph remains complete. Removing the FIRST sentence of a paragraph is
  // preferred over the last: trailing sentences usually carry the conclusion.
  for (let guard = 0; guard < 40 && countCanonicalVisibleWords(doc) > wordMax; guard++) {
    let best: {
      section: ArticleSection;
      blockIndex: number;
      newText: string;
      removedWords: number;
    } | null = null;
    for (const section of editorialSections(doc)) {
      if (countReadableWords(renderComponentHtml(section)) <= MIN_SECTION_WORDS + 15) continue;
      for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
        const block = section.blocks[blockIndex];
        if (block.type !== "paragraph") continue;
        const text = plainBlockText(block).replace(/\s+/g, " ").trim();
        const quotation = analyzeQuotationIntegrity(text);
        // Sentence-level removal cannot safely edit a quotation that spans a
        // sentence boundary. Preserve any paragraph containing quotation
        // syntax as one unit; whole-paragraph removal above remains allowed
        // when every existing dependency/protection rule permits it.
        if (!quotation.balanced || quotation.spans.length > 0) continue;
        if (EXAMPLE_MARKERS.test(text)) continue;
        if (ORPHAN_TRANSITION_RE.test(text) || ORPHAN_TRANSITION_PHRASES.test(text)) continue;
        if (block.content.some((node) => node.type === "link")) continue;
        if (scanFactualRisks(renderComponentHtml({ id: section.id, blocks: [block], status: section.status }), keyphrase, research).claims.length > 0) continue;
        if (/\d/.test(text)) continue;

        const sentences = text.match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
        if (sentences.length < 2) continue;

        // Prefer dropping the first sentence (topic restatement); fall back to
        // the last sentence only when the remainder still closes cleanly.
        // Punctuation-only residue (".") is never kept in a remainder, so a
        // sentence removal can never leave standalone punctuation behind.
        const firstRemainder = dropPunctuationOnlySentences(sentences.slice(1)).join(" ");
        const lastRemainder = dropPunctuationOnlySentences(sentences.slice(0, -1)).join(" ");
        const firstWords = countReadableWords(firstRemainder);
        const lastWords = countReadableWords(lastRemainder);
        const firstDrops = countReadableWords(sentences[0]);
        const lastDrops = countReadableWords(sentences[sentences.length - 1]);

        let candidate: { newText: string; removedWords: number } | null = null;
        if (firstWords >= 12) {
          candidate = { newText: firstRemainder, removedWords: firstDrops };
        } else if (lastWords >= 12) {
          candidate = { newText: lastRemainder, removedWords: lastDrops };
        }
        if (!candidate) continue;
        if (countCanonicalVisibleWords(doc) - candidate.removedWords < wordMin) continue;

        // The following paragraph must not depend on the removed sentence.
        const nextBlock = section.blocks[blockIndex + 1];
        if (nextBlock) {
          const nextText = plainBlockText(nextBlock).replace(/\s+/g, " ").trim();
          if (ORPHAN_TRANSITION_RE.test(nextText) || ORPHAN_TRANSITION_PHRASES.test(nextText)) continue;
        }

        // Section topic grounding is a hard invariant: never shorten away the
        // last sentence carrying a heading content word. When this paragraph
        // is the section's only grounding carrier (and the section is
        // CURRENTLY grounded), the shortened remainder must still share a
        // heading content word (or the section becomes ungrounded and fails
        // final QC — choose another safe removal).
        if (
          countSectionGroundingCarriers(section) > 0
          && countSectionGroundingCarriers(section, blockIndex) === 0
          && !textCarriesHeadingContentWord(section, candidate.newText)
        ) {
          continue;
        }

        if (!best || candidate.removedWords > best.removedWords) {
          best = { section, blockIndex, newText: candidate.newText, removedWords: candidate.removedWords };
        }
      }
    }
    if (!best) break;
    const block = best.section.blocks[best.blockIndex] as Extract<EditorialBlock, { type: "paragraph" }>;
    block.content = [{ type: "text", text: best.newText }];
    best.section.status = "trimmed";
    removedWords += best.removedWords;
    shortenedSentences++;
  }

  return {
    removedWords,
    removedParagraphs,
    shortenedSentences,
    remainingExcess: Math.max(0, countCanonicalVisibleWords(doc) - wordMax),
  };
}

/** Short preview of a sentence for logs. */
export function coherenceViolationSummary(violations: CoherenceViolation[]): string[] {
  return violations.map((v) =>
    `type=${v.type} component=${v.componentId} block=${v.blockId ?? "-"} snippet="${v.snippet}"`,
  );
}
