// ── Sentence-Quality Scanner ──
// Deterministic inside-sentence checks that catch the corruption class caused
// by raw keyphrase phrase-substitution ("the this shift landscape",
// "the the city's evolving marketing landscape", "these these 2026 trends",
// "broader these market changes picture") and other deterministic damage:
// duplicated determiners/demonstratives, repeated adjacent words, lowercase
// sentence starts, broken punctuation, malformed noun phrases and fragments.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-document";

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
 *  English. */
const MALFORMED_NOUN_PHRASE_RE =
  /\b(?:broader|wider|larger|bigger|smaller|higher|lower|greater|lesser|more|most|other|same|such|whole|entire)\s+(?:the|this|that|these|those|a|an)\b/i;

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

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (char === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) continue;
    let end = index + 1;
    while (/[.!?]/.test(text[end] ?? "")) end++;
    while (/["”’)]/.test(text[end] ?? "")) end++;
    if (text.slice(start, end).trim()) sentences.push(text.slice(start, end).trim());
    start = end;
    index = end - 1;
  }
  if (start < text.length && text.slice(start).trim()) {
    sentences.push(text.slice(start).trim());
  }
  return sentences;
}

/** Scan plain prose text (a paragraph) for sentence-quality violations. */
export function scanSentenceQualityText(text: string): SentenceQualityIssue[] {
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
    if (isLowercaseSentenceStart(normalized)) {
      add("lowercase-sentence-start", normalized, "sentence starts with a lowercase letter");
    }
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 2 && !/^[A-Z]/.test(normalized)) {
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
  const checkComponent = (componentId: string, blocks: EditorialBlock[]) => {
    for (const block of blocks) {
      if (block.type === "subheading") continue;
      const text = extractPlainTextFromEditorialBlocks([block]);
      const issues = scanSentenceQualityText(text);
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
