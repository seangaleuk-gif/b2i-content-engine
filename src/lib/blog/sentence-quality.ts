// ── Sentence-Quality Scanner ──
// Deterministic inside-sentence checks that catch the corruption class caused
// by raw keyphrase phrase-substitution ("the this shift landscape",
// "the the city's evolving marketing landscape", "these these 2026 trends",
// "broader these market changes picture") and other deterministic damage:
// duplicated determiners/demonstratives, repeated adjacent words, lowercase
// sentence starts, broken punctuation, malformed noun phrases and fragments.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";

export type SentenceQualityIssueCode =
  | "duplicated-determiner"
  | "repeated-adjacent-word"
  | "lowercase-sentence-start"
  | "broken-punctuation"
  | "malformed-noun-phrase"
  | "fragment";

export interface SentenceQualityIssue {
  code: SentenceQualityIssueCode;
  sentence: string;
  message: string;
}

/** Determiner/demonstrative pairs that can never be adjacent ("the this",
 *  "the the", "these these", "a this", "the that", ...). "that" is excluded
 *  from the first position because "customers that a real person..." is a
 *  legitimate relative clause, and "those" is excluded from the first position
 *  here because "brands that win are those that..." is legitimate — "those
 *  those" and "those the" are caught by a separate pattern below. */
const DUPLICATED_DETERMINER_RE =
  /\b(?:the|this|these|a|an)\s+(?:the|this|that|these|those|a|an)\b/i;

/** Duplicated "those" forms that are never legitimate ("those those",
 *  "those the", "those these") but "those that" is a valid relative
 *  construction and must not be flagged. */
const DUPLICATED_THOSE_RE =
  /\bthose\s+(?:the|this|these|those|a|an)\b/i;

/** Any adjacent repeated word ("these these", "the the", "and and"). */
const REPEATED_ADJACENT_WORD_RE =
  /\b([a-z]{3,})\s+\1\b/i;

/** Adjective/adverb immediately before a determiner is an ungrammatical noun
 *  phrase ("broader these market changes picture", "the wider the gap").
 *  Only comparative/superlative adjectives and determiner-like words that can
 *  never legitimately precede another determiner are included. Pure adverbs
 *  ("simply", "clearly", "really", "quite") legitimately precede determiners
 *  ("simply the best", "clearly the winner", "quite a challenge") and must
 *  never be flagged — "AI and AR are simply the means to get there." is valid
 *  English. The degree adverbs "more"/"most" are excluded for the same reason:
 *  "what matters most this year" is a degree adverb modifying the verb
 *  "matters" followed by the time adjunct "this year" — not an adjective
 *  modifying the determiner-headed noun phrase ("what matters most" + "this
 *  year", "what matters more these days"). "such" is a predeterminer that
 *  legitimately precedes "a/an" ("such a challenge", "such an opportunity")
 *  and "that" in "in a way such that ...", so it is excluded too. */
const MALFORMED_NOUN_PHRASE_RE =
  /\b(?:broader|wider|larger|bigger|smaller|higher|lower|greater|lesser|other|same|whole|entire)\s+(?:the|this|that|these|those|a|an)\b/i;

/** Broken punctuation: two or more consecutive sentence-end marks, a sentence
 *  ending with a dangling determiner, or stray double spaces. */
const BROKEN_PUNCTUATION_RE =
  /(?:\.\.\.+|!!+|!\.|\.!|\?\?+|\?\.|\.\?)\b|\b(?:the|this|that|these|those|a|an)\s*$|  +/i;

/** Common English words that legitimately open a sentence lowercase. */
const ALLOWED_LOWERCASE_OPENERS = new Set([
  "e.g.", "i.e.", "vs.", "v.", "etc.", "email", "iphone", "ios", "macos",
  "ipad", "imac", "ecommerce", "esports", "eretail", "epayment",
]);

/** Lowercase sentence starts: first word is lowercase and is not an allowed
 *  opener, an abbreviation/acronym, or a number. */
function isLowercaseSentenceStart(sentence: string): boolean {
  const match = sentence.match(/[a-zA-Z]/);
  if (!match || match.index === undefined) return false;
  const firstAlpha = sentence.slice(match.index);
  const firstWord = firstAlpha.split(/\s+/)[0] ?? "";
  if (ALLOWED_LOWERCASE_OPENERS.has(firstWord.toLowerCase())) return false;
  if (/^[a-z]/.test(firstWord) === false) return false;
  // "iPhone", "eBay" style brands start lowercase but contain uppercase later.
  if (/[A-Z]/.test(firstWord.slice(1))) return false;
  if (/^[a-z]{1,2}\.$/.test(firstWord)) return false; // "e.g." style handled above
  return true;
}

// ── Authoritative shared rules ──
// Final sentence-quality QC, the malformed-prose scanner (and therefore the
// final-preflight repair boundary), the final article gate and every
// sentence-removal producer MUST agree on these two rules. They are exported
// from here (the sentence-quality owner) and reused by the malformed-prose
// scanner, so the two gates can never disagree about the same canonical
// document.

/** Valid lowercase token sequences that may legitimately open a sentence.
 *  The exact focus keyphrase is written in lowercase throughout SEO content,
 *  so a sentence that begins with the full keyphrase is a valid lowercase
 *  start, never a defect. */
export function lowercaseStartValidTokensFromKeyphrase(keyphrase: string): ReadonlySet<string> {
  const normalized = keyphrase.toLowerCase().trim().replace(/\s+/g, " ");
  return normalized ? new Set([normalized]) : new Set<string>();
}

export interface AuthoritativeLowercaseStartOptions {
  validLowercaseTokens?: ReadonlySet<string>;
}

/** THE authoritative lowercase-sentence-start rule. A sentence is a defect
 *  only when it is a lowercase start AND does not begin with a valid
 *  lowercase token sequence (the exact focus keyphrase), an allowed opener,
 *  a brand-style word ("iPhone", "eBay"), an abbreviation/acronym or a number.
 *  The underlying scanner excludes those already; the token check adds the
 *  keyphrase so the rule is identical at preflight and at final QC. */
export function isAuthoritativeLowercaseSentenceStart(
  sentence: string,
  options?: AuthoritativeLowercaseStartOptions,
): boolean {
  if (!isLowercaseSentenceStart(sentence)) return false;
  const lower = sentence.toLowerCase();
  for (const token of options?.validLowercaseTokens ?? []) {
    // The sentence begins with the exact keyphrase (valid lowercase token),
    // followed by a word boundary, punctuation or nothing at all.
    if (lower === token) return false;
    if (lower.startsWith(token + " ")) return false;
    if (lower.startsWith(token) && /^[.,;:!?—–]/.test(lower.slice(token.length))) return false;
  }
  return true;
}

const AUTHORITATIVE_PUNCTUATION_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;
const AUTHORITATIVE_PUNCTUATION_MARK_RE = /[.!?—–…]/;

/** THE authoritative punctuation-only-residue rule: text that is nothing but
 *  punctuation/symbols while still carrying a terminal or ellipsis mark. A
 *  block (or a sentence inside a paragraph) reduced to "." is the residue of
 *  a deleted sentence and is always malformed. */
export function isAuthoritativePunctuationOnlyResidue(text: string): boolean {
  return AUTHORITATIVE_PUNCTUATION_ONLY_RE.test(text) && AUTHORITATIVE_PUNCTUATION_MARK_RE.test(text);
}

export interface SentenceTextRange {
  start: number;
  end: number;
  text: string;
}

/** A period after a known abbreviation is NOT a sentence boundary
 *  ("Dr. Smith", "9 a.m. and", "e.g. this", "U.S. brands"). The interior dot
 *  of a multi-part abbreviation ("a.m.", "e.g.", "U.S.") is handled by
 *  `isInteriorAbbreviationDot`. */
const ABBREVIATION_DOT_RE =
  /(?:^|\s)(?:dr|mr|mrs|ms|st|vs|etc|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m|no|fig|vol|pp|inc|ltd|co|jr|sr|prof|gen|gov|est|min|max|avg|approx)\.$/i;

/** Interior dot of a multi-part abbreviation: "." followed immediately by a
 *  single letter and another dot ("a.m.", "p.m.", "e.g.", "U.S."). */
function isInteriorAbbreviationDot(text: string, index: number): boolean {
  return /^[a-zA-Z]\./.test(text.slice(index + 1));
}

/** Character-by-character sentence ranges (offsets into `text`) using the same
 *  splitter as `splitSentences`, shared by the scanners and the repair passes
 *  so they remove exactly the sentences the scanners flag. Periods after known
 *  abbreviations are never treated as boundaries. */
export function sentenceTextRanges(text: string): SentenceTextRange[] {
  const ranges: SentenceTextRange[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (char === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) continue;
    if (char === "." && ABBREVIATION_DOT_RE.test(text.slice(0, index + 1))) continue;
    if (char === "." && isInteriorAbbreviationDot(text, index)) continue;
    let end = index + 1;
    while (/[.!?]/.test(text[end] ?? "")) end++;
    while (/["”’)]/.test(text[end] ?? "")) end++;
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const inner = raw.indexOf(trimmed);
      ranges.push({ start: start + inner, end: start + inner + trimmed.length, text: trimmed });
    }
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    const trailing = text.slice(start).trim();
    if (trailing) {
      const inner = text.slice(start).indexOf(trailing);
      ranges.push({ start: start + inner, end: start + inner + trailing.length, text: trailing });
    }
  }
  return ranges;
}

/** Punctuation-only residue sentences inside a paragraph text. */
export function findAuthoritativePunctuationOnlySentences(text: string): string[] {
  return sentenceTextRanges(text)
    .filter((range) => isAuthoritativePunctuationOnlyResidue(range.text))
    .map((range) => range.text);
}

/** Drop punctuation-only residue sentences from a remainder after a sentence
 *  removal, so a removal can never leave standalone punctuation behind. */
export function dropPunctuationOnlySentences(sentences: string[]): string[] {
  return sentences.filter((sentence) => !isAuthoritativePunctuationOnlyResidue(sentence));
}

/** Remove punctuation-only residue ranges from inline content, node-preserving
 *  (link/strong/emphasis nodes keep their type and href); each removed segment
 *  is replaced with a single space so neighbouring sentences never glue
 *  together and empty nodes are dropped. Returns null when the content has no
 *  residue. This is the single implementation used by the malformed-prose
 *  repair (preflight) and by the sentence-removal producers (final trim,
 *  keyphrase reduction), so a producer can never commit punctuation-only
 *  residue, including inside linked/inline-node paragraphs. */
export function dropPunctuationOnlyResidueFromContent(
  content: InlineContent[],
): InlineContent[] | null {
  const text = content.map((node) => node.text).join("");
  const ranges = sentenceTextRanges(text).filter((range) =>
    isAuthoritativePunctuationOnlyResidue(range.text),
  );
  if (ranges.length === 0) return null;

  const kept: InlineContent[] = [];
  let cursor = 0;
  for (const node of content) {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;
    let retained = "";
    let local = nodeStart;
    for (const range of ranges) {
      if (!(nodeStart < range.end && range.start < nodeEnd)) continue;
      const keepUntil = Math.max(nodeStart, range.start);
      if (keepUntil > local) {
        retained += node.text.slice(local - nodeStart, keepUntil - nodeStart);
      }
      local = Math.max(local, Math.min(nodeEnd, range.end));
      retained += " ";
    }
    if (local < nodeEnd) retained += node.text.slice(local - nodeStart);
    retained = retained.replace(/\s+/g, " ");
    if (retained.trim()) kept.push({ ...node, text: retained });
  }
  if (kept.length === 0) return null;
  kept[0].text = kept[0].text.trimStart();
  kept[kept.length - 1].text = kept[kept.length - 1].text.trimEnd();
  return kept;
}

function splitSentences(text: string): string[] {
  return sentenceTextRanges(text).map((range) => range.text);
}

/** Scan plain prose text (a paragraph) for sentence-quality violations. Uses
 *  the same authoritative lowercase-start and punctuation-only-residue rules
 *  as the malformed-prose scanner, so the final sentence-quality QC and the
 *  final-preflight repair boundary can never disagree on the same document. */
export function scanSentenceQualityText(
  text: string,
  options?: { validLowercaseTokens?: ReadonlySet<string> },
): SentenceQualityIssue[] {
  const issues: SentenceQualityIssue[] = [];
  const seen = new Set<string>();
  const add = (code: SentenceQualityIssueCode, sentence: string, message: string) => {
    const key = `${code}:${sentence}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ code, sentence, message });
  };

  for (const sentence of splitSentences(text)) {
    const normalized = sentence.replace(/\s+/g, " ").trim();
    if (isAuthoritativePunctuationOnlyResidue(normalized)) {
      add("fragment", normalized, "punctuation-only residue from a removed sentence");
    }
    if (DUPLICATED_DETERMINER_RE.test(normalized) || DUPLICATED_THOSE_RE.test(normalized)) {
      add("duplicated-determiner", normalized, "duplicated determiner or demonstrative");
    }
    if (REPEATED_ADJACENT_WORD_RE.test(normalized)) {
      add("repeated-adjacent-word", normalized, "repeated adjacent word");
    }
    if (MALFORMED_NOUN_PHRASE_RE.test(normalized)) {
      add("malformed-noun-phrase", normalized, "adjective/adverb immediately before a determiner");
    }
    if (BROKEN_PUNCTUATION_RE.test(normalized)) {
      add("broken-punctuation", normalized, "broken punctuation");
    }
    if (isAuthoritativeLowercaseSentenceStart(normalized, options)) {
      add("lowercase-sentence-start", normalized, "sentence starts with a lowercase letter");
    }
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 2 && !/^[A-Z]/.test(normalized) && !isAuthoritativePunctuationOnlyResidue(normalized)) {
      add("fragment", normalized, "sentence fragment (two words or fewer)");
    }
  }
  return issues;
}

/** One-line diagnostics for logging. */
export function formatSentenceQualityIssues(issues: SentenceQualityIssue[]): string[] {
  return issues.map((issue) => `code=${issue.code} sentence="${issue.sentence.slice(0, 140)}"`);
}

/**
 * Authoritative sentence-quality scan over the final canonical
 * ArticleDocument (intro, editorial sections and conclusion). Any returned
 * block with issues is unresolved deterministic corruption and must be a hard
 * failure at the final gate and in the pre-save gate.
 */
export function scanSentenceQualityInDocument(doc: ArticleDocument): Array<{
  componentId: string;
  blockId: string;
  issues: SentenceQualityIssue[];
}> {
  const findings: Array<{ componentId: string; blockId: string; issues: SentenceQualityIssue[] }> = [];
  const options = {
    validLowercaseTokens: lowercaseStartValidTokensFromKeyphrase(doc.metadata.focusKeyphrase),
  };
  const checkComponent = (componentId: string, blocks: EditorialBlock[]) => {
    for (const block of blocks) {
      if (block.type === "subheading") continue;
      const text = extractPlainTextFromEditorialBlocks([block]);
      const issues = scanSentenceQualityText(text, options);
      if (issues.length > 0) {
        findings.push({ componentId, blockId: block.id, issues });
      }
    }
  };
  checkComponent(doc.introduction.id, doc.introduction.blocks);
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;
    checkComponent(section.id, section.blocks);
  }
  checkComponent(doc.conclusion.id, doc.conclusion.blocks);
  return findings;
}
