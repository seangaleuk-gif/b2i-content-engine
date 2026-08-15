// ── Shared block-type-aware sentence-completeness validator ──
// One deterministic rule set for "is this block's prose complete?" used by:
//   - AI block acceptance (reject incomplete prose at the producer),
//   - malformed-prose scanning and repair,
//   - coherence validation (incomplete-sentence check),
//   - trim/compaction candidate validation,
//   - final QC and pre-save validation.
//
// Contract:
//   - Paragraphs, quotes and FAQ answers must contain complete prose. A block
//     that ends without terminal punctuation (or ends with an unfinished
//     setup) is incomplete.
//   - Headings, subheadings, list labels/items, table cells, titles, meta
//     descriptions and excerpts do NOT require sentence punctuation, but must
//     still reject unmistakable fragments ("go a", "is designed to",
//     "connect with", "works because", punctuation-only residue).
//   - Valid abbreviations, links, quotations, apostrophes, measurements and
//     stranded-preposition constructions are preserved (never flagged).
//   - This validator never guesses missing words and never appends
//     punctuation; it only reports.
//
// This module is a leaf: it must not import publication-quality,
// editorial-polish or any other validator so every consumer can depend on it
// without creating import cycles.

import { findSentenceBoundaryOffsets } from "@/lib/seo/seo-text-utils";

export type SentenceCompletenessKind =
  | "paragraph" // full prose — terminal punctuation required
  | "quote" // full prose — terminal punctuation required
  | "faq-answer" // full prose — terminal punctuation required
  | "list-item" // structural — no punctuation required
  | "table-cell" // structural — no punctuation required
  | "subheading" // structural — no punctuation required
  | "heading" // structural — no punctuation required
  | "title" // structural — no punctuation required
  | "meta-description" // structural — no punctuation required
  | "excerpt"; // structural — no punctuation required

export type SentenceCompletenessIssueCode =
  | "missing-terminal-punctuation" // prose kinds only
  | "trailing-fragment"; // structural kinds (and unmistakable tails)

export interface TrailingFragment {
  /** UTF-16 offset where the trailing fragment begins in the normalized text. */
  start: number;
  /** UTF-16 offset where the trailing fragment ends (text length). */
  end: number;
  /** The fragment text. */
  text: string;
}

export interface SentenceCompletenessIssue {
  code: SentenceCompletenessIssueCode;
  message: string;
  /** Non-null when the issue is a removable trailing tail. */
  trailingFragment: TrailingFragment | null;
}

export interface SentenceCompletenessAnalysis {
  complete: boolean;
  issues: SentenceCompletenessIssue[];
  /** The unmistakable trailing fragment of a prose block, if any. */
  trailingFragment: TrailingFragment | null;
}

export interface SentenceCompletenessOptions {
  /**
   * A paragraph ending in a colon is complete when the next canonical block
   * is the non-empty list/table it introduces. Callers must derive this from
   * the surrounding block sequence; it is never enabled for isolated prose.
   */
  allowColonBeforeStructuredContinuation?: boolean;
}

const PROSE_KINDS = new Set<SentenceCompletenessKind>([
  "paragraph",
  "quote",
  "faq-answer",
]);

export function isProseKind(kind: SentenceCompletenessKind): boolean {
  return PROSE_KINDS.has(kind);
}

/** Source: citations are citation metadata, not prose sentences. */
export function isSourceCitationText(text: string): boolean {
  return /^\s*sources?:\s/i.test(text);
}

/** Closing delimiters that belong to the preceding sentence. Apostrophes
 *  (possessives/contractions) are deliberately excluded. */
const CLOSING_DELIM_RE = /["\u201D\u2019)\]}]+$/;

/** Terminal sentence punctuation. */
const TERMINAL_MARK_RE = /[.!?]$/;

/** Unfinished-setup ending ("Here's what you need to know:") — a colon or
 *  dash that promises a continuation which is not present. */
const SETUP_ENDING_RE = /[:—–-]$/;

/** Bare determiners at the very end of a text are unmistakably fragmentary
 *  ("go a", "choose the", "pick an"). Matched case-sensitively so label-style
 *  items ("Item A", "Plan B") are never false positives, and only when at
 *  least one word precedes the determiner (a lone "A"/"The" item is an
 *  ambiguous label, not a provable fragment). */
const BARE_DETERMINER_END_RE = /\b[a-z]+\s+(?:a|an|the)\s*$/;

/** Dangling tail words: a preposition/infinitive-marker/conjunction at the
 *  very end without the phrase it introduces. Stranded-preposition
 *  constructions ("What are you waiting for?", "This is what we plan for.")
 *  are legitimate when an interrogative/relative pronoun earlier in the text
 *  supplies the object — those are never flagged. */
const DANGLING_TAIL_END_RE =
  /\b(?:to|with|for|from|of|at|into|onto|upon|because|and|or|but|as|than|that|which|while|when|if|so|yet|nor)\s*$/i;

const WH_ANTECEDENT_RE =
  /\b(?:what|which|who|whom|whose|where|how|why|when)\b/i;

/** Trailing hyphen/dash residue ("market-") is a mid-word cut. */
const TRAILING_HYPHEN_RE = /[—-]$/;

/** Punctuation-only residue (".", "...", "—"). */
const PUNCTUATION_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;
const PUNCTUATION_MARK_RE = /[.!?—–…]/;

function normalizeText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** True when the ending of `text` is an unmistakable fragment signature. */
export function hasUnmistakableFragmentEnding(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (PUNCTUATION_ONLY_RE.test(trimmed) && PUNCTUATION_MARK_RE.test(trimmed)) return true;
  if (TRAILING_HYPHEN_RE.test(trimmed)) return true;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  // Bare determiner and dangling tail signatures are unmistakable only when
  // at least one word precedes them; a lone "A", "The", "To" or "With" is an
  // ambiguous structural label, not a provable fragment.
  if (wordCount >= 2 && BARE_DETERMINER_END_RE.test(trimmed)) return true;
  if (
    wordCount >= 2
    && DANGLING_TAIL_END_RE.test(trimmed)
    && !WH_ANTECEDENT_RE.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/**
 * Analyze the sentence completeness of a single text unit. `kind` selects the
 * prose contract: prose kinds require terminal punctuation, structural kinds
 * only reject unmistakable fragments.
 */
export function analyzeSentenceCompleteness(
  text: string,
  kind: SentenceCompletenessKind,
  options?: SentenceCompletenessOptions,
): SentenceCompletenessAnalysis {
  const normalized = normalizeText(text);
  if (!normalized) return { complete: true, issues: [], trailingFragment: null };

  // Source citations are citation metadata regardless of the surrounding kind.
  if (isSourceCitationText(normalized)) kind = "heading";

  if (!isProseKind(kind)) {
    // Structural kinds: no punctuation required, unmistakable fragments only.
    if (hasUnmistakableFragmentEnding(normalized)) {
      return {
        complete: false,
        issues: [{
          code: "trailing-fragment",
          message: "text ends with an unmistakable fragment",
          trailingFragment: { start: 0, end: normalized.length, text: normalized },
        }],
        trailingFragment: { start: 0, end: normalized.length, text: normalized },
      };
    }
    return { complete: true, issues: [], trailingFragment: null };
  }

  // Prose kinds: complete sentences with terminal punctuation are required.
  const tail = normalized.replace(CLOSING_DELIM_RE, "");
  if (options?.allowColonBeforeStructuredContinuation && /:$/.test(tail)) {
    return { complete: true, issues: [], trailingFragment: null };
  }
  if (TERMINAL_MARK_RE.test(tail) && !SETUP_ENDING_RE.test(tail)) {
    return { complete: true, issues: [], trailingFragment: null };
  }

  // Incomplete: find the unmistakable trailing fragment. Everything after the
  // last unambiguous sentence boundary is the tail.
  const boundaries = findSentenceBoundaryOffsets(normalized);
  let trailingFragment: TrailingFragment | null = null;
  if (boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const fragmentText = normalized.slice(lastBoundary).trim();
    if (fragmentText) {
      const start = normalized.indexOf(fragmentText, lastBoundary);
      trailingFragment = { start, end: normalized.length, text: fragmentText };
    }
  }
  if (!trailingFragment) {
    // No complete sentence at all: the whole block is the fragment.
    trailingFragment = { start: 0, end: normalized.length, text: normalized };
  }

  const isSetupEnding = SETUP_ENDING_RE.test(tail);
  const message = boundaries.length === 0
    ? isSetupEnding
      ? "prose block is an unfinished setup (ends with a colon or dash)"
      : "prose block contains no complete sentence"
    : trailingFragment && hasUnmistakableFragmentEnding(trailingFragment.text)
      ? "prose block ends with an unmistakable trailing fragment"
      : "prose block is missing terminal punctuation";

  return {
    complete: false,
    issues: [{
      code: "missing-terminal-punctuation",
      message,
      trailingFragment,
    }],
    trailingFragment,
  };
}

/** Convenience: complete only when the text is valid prose for the kind. */
export function isSentenceComplete(
  text: string,
  kind: SentenceCompletenessKind,
  options?: SentenceCompletenessOptions,
): boolean {
  return analyzeSentenceCompleteness(text, kind, options).complete;
}
