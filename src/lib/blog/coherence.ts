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
import {
  ORPHAN_TRANSITION_RE,
  ORPHAN_TRANSITION_PHRASES,
  opensWithDiscourseDependency,
  opensWithStrictDiscourseDependency,
} from "@/lib/blog/transition-rules";

export type CoherenceViolationType =
  | "unfinished-example"
  | "orphan-transition"
  | "dangling-reference"
  | "incomplete-sentence"
  | "thin-section"
  | "empty-section"
  | "empty-subsection"
  | "misplaced-forward-reference";

export interface CoherenceViolation {
  componentId: string;
  blockId: string | null;
  type: CoherenceViolationType;
  snippet: string;
}

/** Stable semantic identity of a coherence violation for delta comparison.
 *  Based on violation type + component identity + normalized offending content
 *  — never the positional block id — so a block inserted BEFORE an existing
 *  violation (which reindexes the block id) is not reclassified as "resolved +
 *  newly introduced". Two violations with the same type and content in the
 *  same component are the same semantic violation; a genuinely different
 *  offending text produces a different identity and is still detected as new. */
export function coherenceViolationIdentity(violation: CoherenceViolation): string {
  const content = (violation.snippet ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${violation.type}|${violation.componentId}|${content}`;
}

/** A section must keep at least this many words to remain a coherent unit
 *  under its heading. */
export const MIN_SECTION_WORDS = 40;

const EXAMPLE_MARKERS =
  /\b(?:a good example|for example|for instance|as an example|imagine|consider|take\s+[\w]+(?:\s+and\s+[\w]+)?\s+for example|here'?s an example)\b/i;

const PENDING_EXAMPLE_PATTERN =
  /\b(?:wants?|plans?|hopes?|aims?|intends?|is (?:thinking|considering|planning|looking)|decides?|needs?|tries?|would like|will try|expects?)\s+to\b/i;

/** A pending-action verb ("want to", "plans to", "hopes to") inside an "if"
 *  conditional clause is part of a COMPLETE conditional example ("For example,
 *  if you want to have deeper conversations, a private group might work
 *  better"), not a dangling setup — the pending action is a condition, and the
 *  main clause supplies the example's outcome. Only a pending action in a
 *  NON-conditional frame marks an unfinished example lead-in. */
const CONDITIONAL_PENDING_RE =
  /\bif\s+[^.!?]{1,60}?\b(?:want|wants|plan|plans|hope|hopes|need|needs|try|tries)\s+to\b/i;

function isConditionalPending(text: string): boolean {
  return CONDITIONAL_PENDING_RE.test(String(text ?? ""));
}

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

// ── Component-aware forward-reference transitions ──
// A forward reference ("In the next section, we'll answer some common
// questions...") must point at the component that ACTUALLY follows the current
// one in canonical document order (intro → main sections → conclusion → FAQ).
// A reference to FAQ questions issued from the final main section (where the
// conclusion comes next) is structurally wrong and is flagged here.

const FORWARD_REFERENCE_RE =
  /\b(?:in the next (?:section|part)|the next (?:section|part)|the following (?:section|part)|in the (?:section|part) below|in the (?:sections|parts) below|coming up (?:next|below)|in the next few (?:sections|parts|steps))\b|\bwe(?:['’]ll| will) (?:answer|cover|explore|look at|discuss|examine|address|dive into|see|turn to|introduce)\b/i;

/** The component type a forward reference promises. "main" covers references
 *  to a generic next topic; "faq"/"conclusion" are determinate references. */
function forwardReferenceTargetType(sentence: string): "faq" | "conclusion" | "main" | null {
  const lower = sentence.toLowerCase();
  if (/\b(?:common )?questions?\b|\bfaq\b|\bfrequently asked\b/.test(lower)) return "faq";
  if (/\b(?:conclusion|wrap[- ]?up|summary|final thoughts?|recap)\b/.test(lower)) return "conclusion";
  if (FORWARD_REFERENCE_RE.test(lower)) return "main";
  return null;
}

/** The component type that actually follows `componentId` in canonical order.
 *  After the conclusion, the visible FAQ is the final component. */
function actualNextComponentType(
  doc: ArticleDocument,
  componentId: string,
): "faq" | "conclusion" | "main" | null {
  const order: Array<{ id: string; type: "main" | "conclusion" }> = [
    ...doc.sections
      .filter(
        (section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading",
      )
      .map((section) => ({ id: section.id, type: "main" as const })),
    { id: doc.conclusion.id, type: "conclusion" as const },
  ];
  const index = order.findIndex((entry) => entry.id === componentId);
  if (index < 0) return null;
  const next = order[index + 1];
  if (next) return next.type;
  return doc.visibleFaq.length > 0 ? "faq" : null;
}

/** True when a forward reference in `sentence` promises a target that does not
 *  match the actual next component in canonical document order. */
function hasMisplacedForwardReference(
  sentence: string,
  doc: ArticleDocument,
  componentId: string,
): boolean {
  if (!FORWARD_REFERENCE_RE.test(sentence)) return false;
  const promised = forwardReferenceTargetType(sentence);
  if (!promised) return false;
  const actual = actualNextComponentType(doc, componentId);
  if (!actual) return false;
  // A reference to the FAQ/conclusion must name the component that actually
  // follows. A generic "main" reference is wrong only when the actual next
  // component is NOT a main section.
  if (promised === "faq" || promised === "conclusion") return promised !== actual;
  return actual !== "main";
}

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

      // 2. Unfinished example: an example marker paragraph is dangling only when
      //    it is a genuine pending setup — a NON-conditional pending-action
      //    verb ("Consider a boutique that plans to test...") or an incomplete
      //    fragment — OR when an incomplete example is the section's last block.
      //    A COMPLETE example sentence is valid regardless of a "want to"/"plan
      //    to" construction inside it: "For example, if you want X, a group
      //    might work better", "For example, a local bakery might share...",
      //    "For example, you can..." all present a substantive completed
      //    example. A following paragraph that refers back to the example ("It
      //    could...", "The brand then...") also counts as the resolution.
      if (EXAMPLE_MARKERS.test(text)) {
        const exampleComplete = isSentenceComplete(text, "paragraph");
        const singleSentence = (text.match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g) ?? []).length <= 1;
        const pending = PENDING_EXAMPLE_PATTERN.test(text) && !isConditionalPending(text);
        const nothingFollows = !next && !exampleComplete;
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

      // 4. Dangling reference / deletion-created discourse opening: a component
      //    opening that refers back to prior content cannot be valid — no
      //    antecedent exists by construction. This catches deletion producers
      //    that remove an opening claim and leave "That's why...", "This
      //    means...", "Given this..." as the new first paragraph. The STRICT
      //    shared rule in transition-rules.ts covers only openers that are
      //    dependent in every context (a section legitimately opening with
      //    "This approach..." is not blocked), and the existing demonstrative-
      //    pronoun rule keeps its historical scope.
      if (i === 0) {
        if (opensWithStrictDiscourseDependency(text) || DANGLING_REFERENCE_RE.test(text)) {
          violations.push({
            componentId,
            blockId: block.id,
            type: "dangling-reference",
            snippet: text.slice(0, 160),
          });
        }
      } else if (opensWithDiscourseDependency(text)) {
        // Deeper in a component the FULL dependency vocabulary still requires a
        // complete substantive antecedent. A missing antecedent (only source
        // citations remain, or every earlier paragraph was deleted) means the
        // dependency dangles — the same signal the orphan-transition rule uses.
        const antecedent = previousSubstantiveParagraph(paragraphs, i);
        if (!antecedent) {
          violations.push({
            componentId,
            blockId: block.id,
            type: "dangling-reference",
            snippet: text.slice(0, 160),
          });
        }
      }
    }

    // 5. Empty H3 subsection: an H3 must own at least one substantive body
    //    block before the next H2/H3 or the component end. A Source-attribution
    //    paragraph alone does not count. Consecutive H3 headings with no body
    //    are orphaned headings and a hard structural violation (survives final
    //    trim and is also caught absolutely by final QC).
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type !== "subheading") continue;
      if (h3HasSubstantiveBody(blocks, i)) continue;
      violations.push({
        componentId,
        blockId: blocks[i].id,
        type: "empty-subsection",
        snippet: plainBlockText(blocks[i]).replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  };

  checkComponent(doc.introduction.id, doc.introduction.blocks);
  for (const section of editorialSections(doc)) {
    checkComponent(section.id, section.blocks);
  }
  checkComponent(doc.conclusion.id, doc.conclusion.blocks);

  // 6. Component-aware forward references. The final paragraph of a component
  //    is the transition point: a forward reference there must match the
  //    component that ACTUALLY follows in canonical document order.
  const transitionComponents: Array<{ componentId: string; blocks: EditorialBlock[] }> = [
    { componentId: doc.introduction.id, blocks: doc.introduction.blocks },
    ...editorialSections(doc).map((section) => ({ componentId: section.id, blocks: section.blocks })),
    { componentId: doc.conclusion.id, blocks: doc.conclusion.blocks },
  ];
  for (const { componentId, blocks } of transitionComponents) {
    const paragraphs = blocks
      .map((block) => ({ block, text: plainBlockText(block).replace(/\s+/g, " ").trim() }))
      .filter((entry) => entry.text.length > 0 && entry.block.type !== "subheading");
    const lastParagraph = paragraphs[paragraphs.length - 1];
    if (lastParagraph && hasMisplacedForwardReference(lastParagraph.text, doc, componentId)) {
      violations.push({
        componentId,
        blockId: lastParagraph.block.id,
        type: "misplaced-forward-reference",
        snippet: lastParagraph.text.slice(0, 160),
      });
    }
  }

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

/** A block counts as substantive subsection body when it carries real content:
 *  a paragraph that is NOT a Source-attribution-only line, or a non-empty
 *  list/table/quote. Source attribution alone never makes an H3 valid. */
function isSubstantiveBodyBlock(block: EditorialBlock): boolean {
  if (block.type === "list" || block.type === "table" || block.type === "quote") {
    return plainBlockText(block).replace(/\s+/g, " ").trim().length > 0;
  }
  if (block.type !== "paragraph") return false;
  const text = plainBlockText(block).replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (isSourceCitation(text)) return false;
  return true;
}

/** The nearest preceding H3 (subheading) block index, or -1 if `blockIndex`
 *  is not inside any H3 subsection. */
function owningH3Index(blocks: EditorialBlock[], blockIndex: number): number {
  for (let index = blockIndex - 1; index >= 0; index--) {
    if (blocks[index].type === "subheading") return index;
  }
  return -1;
}

/** True when block `blockIndex` is the ONLY substantive body block of its H3
 *  subsection (the blocks strictly after the owning H3, up to the next
 *  subheading or the section end). Removing it would orphan the H3. Shared by
 *  every block-removal producer (structure-aware trim, residual safe trim) so
 *  no producer can disagree about what counts as subsection body. */
export function isLastSubstantiveBodyOfSubsection(blocks: EditorialBlock[], blockIndex: number): boolean {
  const h3 = owningH3Index(blocks, blockIndex);
  if (h3 < 0) return false;
  let substantiveCount = 0;
  let thisIsSubstantive = false;
  for (let index = h3 + 1; index < blocks.length; index++) {
    if (blocks[index].type === "subheading") break;
    if (isSubstantiveBodyBlock(blocks[index])) {
      substantiveCount++;
      if (index === blockIndex) thisIsSubstantive = true;
    }
  }
  return thisIsSubstantive && substantiveCount === 1;
}

/** True when the H3 at `h3BlockIndex` owns at least one substantive body block
 *  before the next subheading or the component end. */
function h3HasSubstantiveBody(blocks: EditorialBlock[], h3BlockIndex: number): boolean {
  for (let index = h3BlockIndex + 1; index < blocks.length; index++) {
    if (blocks[index].type === "subheading") break;
    if (isSubstantiveBodyBlock(blocks[index])) return true;
  }
  return false;
}

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
    if (DANGLING_REFERENCE_RE.test(nextText) || opensWithDiscourseDependency(nextText)) return false;
    if (EXAMPLE_MARKERS.test(text) === false && /^this\b|^that\b|^these\b|^those\b|^it\b|^they\b/i.test(nextText)) return false;
  }
  // The previous paragraph must not be an example marker that this paragraph
  // completes.
  const prevBlock = section.blocks[blockIndex - 1];
  if (prevBlock && EXAMPLE_MARKERS.test(plainBlockText(prevBlock))) return false;

  // Subsection integrity: never remove the LAST substantive body block of an
  // H3 subsection — doing so would orphan the H3 (an empty subsection).
  // Source-attribution-only paragraphs are not substantive body, so a
  // subsection that would be left with only a Source citation is still
  // orphaned and the removal is rejected.
  if (isLastSubstantiveBodyOfSubsection(section.blocks, blockIndex)) return false;

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
