// ── FAQ Keyphrase Naturalness ──
// The FAQ is canonical `visibleFaq` content (questions + answerText). The exact
// focus keyphrase must appear in FAQ copy only where it reads naturally — never
// mechanically repeated in every question and answer.
//
// This module provides:
//  1. A non-mutating whole-visible-document repetition/naturalness measurement
//     over every FAQ item (it reads the canonical FAQ entries, which is exactly
//     the editorial text rendered inside the protected FAQ HTML).
//  2. A deterministic producer/reconcile-layer repair that replaces redundant
//     exact-keyphrase occurrences with a natural successor phrase, preserving
//     meaning, question/answer parity and schema consistency.
//
// The body SEO density thresholds are NOT involved: this module only touches
// FAQ copy and never changes body prose.

import type { FaqEntry } from "@/lib/blog/article-document";
import { isSentenceComplete } from "@/lib/blog/sentence-completeness";
import { scanSentenceQualityText, lowercaseStartValidTokensFromKeyphrase } from "@/lib/blog/sentence-quality";
import { findMalformedProseTextIssues } from "@/lib/blog/publication-quality";

export interface FaqKeyphraseItemMetric {
  index: number;
  questionOccurrences: number;
  answerOccurrences: number;
  mechanicallyRepeated: boolean;
}

export interface FaqKeyphraseNaturalnessReport {
  /** True when the exact keyphrase appears naturally: at most one FAQ item
   *  carries it, and it appears at most once across all FAQ copy. */
  natural: boolean;
  totalOccurrences: number;
  items: FaqKeyphraseItemMetric[];
}

function countExactPhraseIn(text: string, phrase: string): number {
  if (!text || !phrase) return 0;
  const lower = text.toLowerCase();
  const needle = phrase.toLowerCase();
  let count = 0;
  let index = 0;
  while ((index = lower.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

/** Non-mutating measurement of exact-keyphrase repetition across every visible
 *  FAQ item (question + answerText). */
export function measureFaqEntriesKeyphraseNaturalness(
  entries: FaqEntry[],
  keyphrase: string,
): FaqKeyphraseNaturalnessReport {
  const kpLower = keyphrase.toLowerCase().trim();
  const items: FaqKeyphraseItemMetric[] = entries.map((entry, index) => {
    const questionOccurrences = kpLower ? countExactPhraseIn(entry.question, kpLower) : 0;
    const answerOccurrences = kpLower ? countExactPhraseIn(entry.answerText, kpLower) : 0;
    return { index, questionOccurrences, answerOccurrences, mechanicallyRepeated: false };
  });
  const totalOccurrences = items.reduce(
    (sum, item) => sum + item.questionOccurrences + item.answerOccurrences,
    0,
  );
  if (!kpLower) return { natural: true, totalOccurrences: 0, items };
  const bearing = items.filter((item) => item.questionOccurrences + item.answerOccurrences > 0);
  const anchor = bearing[0];
  const natural = bearing.length === 0 || (bearing.length === 1 && totalOccurrences === 1);
  if (!natural) {
    for (const item of items) {
      const occurrences = item.questionOccurrences + item.answerOccurrences;
      const isAnchor = Boolean(anchor && item.index === anchor.index);
      item.mechanicallyRepeated = isAnchor ? occurrences > 1 : occurrences > 0;
    }
  }
  return { natural, totalOccurrences, items };
}

export function measureFaqKeyphraseNaturalness(
  doc: { visibleFaq: FaqEntry[] },
  keyphrase: string,
): FaqKeyphraseNaturalnessReport {
  return measureFaqEntriesKeyphraseNaturalness(doc.visibleFaq, keyphrase);
}

/** Natural successor phrase that replaces redundant exact-keyphrase
 *  occurrences while preserving meaning. The first (anchor) FAQ item keeps the
 *  exact keyphrase and establishes the topic, so a demonstrative anaphor reads
 *  naturally in every later item. */
function naturalKeyphraseSuccessor(keyphrase: string): string {
  const lower = keyphrase.toLowerCase();
  if (/\btrends?\b/.test(lower)) return "these trends";
  if (/\bmarketing\b/.test(lower)) return "this market";
  return "this topic";
}

/** Replace occurrences of the keyphrase in `text`, keeping the first
 *  `keepFirst` occurrences and replacing the rest. When an occurrence is
 *  directly preceded by a determiner ("the/this/these/those/a/an"), the bare
 *  noun successor is used ("The hong kong marketing trends 2026" →
 *  "The trends") so the result never reads as a doubled demonstrative. */
function replaceRedundantKeyphraseOccurrences(
  text: string,
  keyphrase: string,
  successor: string,
  keepFirst: number,
): string {
  const kpLower = keyphrase.toLowerCase();
  const lower = text.toLowerCase();
  if (!lower.includes(kpLower)) return text;
  const bareSuccessor = successor.replace(/^these\s+/i, "").replace(/^this\s+/i, "");
  let result = "";
  let cursor = 0;
  let seen = 0;
  let index = 0;
  while ((index = lower.indexOf(kpLower, index)) !== -1) {
    result += text.slice(cursor, index);
    const before = text.slice(0, index).replace(/\s+$/u, "");
    const precededByDeterminer = /\b(?:the|this|these|those|a|an)$/i.test(before);
    if (seen >= keepFirst) {
      result += precededByDeterminer ? bareSuccessor : successor;
      seen++;
    } else {
      result += text.slice(index, index + kpLower.length);
      seen++;
    }
    index += kpLower.length;
    cursor = index;
  }
  result += text.slice(cursor);
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The repaired question/answer must remain complete, grammatical and clean. */
function itemRepairIsValid(question: string, answer: string, keyphrase: string): boolean {
  if (!question.trim() || !answer.trim()) return false;
  if (!isSentenceComplete(answer, "faq-answer")) return false;
  if (scanSentenceQualityText(answer, {
    validLowercaseTokens: lowercaseStartValidTokensFromKeyphrase(keyphrase),
  }).length > 0) {
    return false;
  }
  if (findMalformedProseTextIssues([answer], ["faq-answer"]).length > 0) return false;
  return true;
}

export interface FaqKeyphraseRepairResult {
  repaired: FaqEntry[];
  changedIndexes: number[];
}

/**
 * Deterministic FAQ keyphrase-naturalness repair. Only FAQ items that
 * mechanically repeat the exact keyphrase are touched:
 *  - the anchor item (the first item carrying the keyphrase) keeps its first
 *    occurrence and replaces any later ones;
 *  - every later item replaces ALL of its occurrences.
 * Each repaired item must pass the shared sentence-quality/malformed-prose
 * gates and keep complete prose; a repair that cannot be made safely leaves the
 * item byte-identical. Meaning, question wording, schema parity and protected
 * markup are preserved (answerHtml is regenerated from answerText).
 */
export function repairFaqKeyphraseNaturalness(
  entries: FaqEntry[],
  keyphrase: string,
): FaqKeyphraseRepairResult {
  const kpLower = keyphrase.toLowerCase().trim();
  if (!kpLower || entries.length === 0) return { repaired: entries, changedIndexes: [] };
  const measure = measureFaqEntriesKeyphraseNaturalness(entries, keyphrase);
  if (measure.natural) return { repaired: entries, changedIndexes: [] };
  const successor = naturalKeyphraseSuccessor(keyphrase);
  const anchorIndex = measure.items.find(
    (item) => item.questionOccurrences + item.answerOccurrences > 0,
  )?.index;

  const repaired: FaqEntry[] = entries.map((entry, index) => {
    const item = measure.items[index];
    if (!item.mechanicallyRepeated) return entry;
    const isAnchor = anchorIndex === index;
    // The anchor keeps exactly ONE exact-keyphrase occurrence across the whole
    // item, preferring the question when it carries the keyphrase. Later items
    // keep none.
    const keepQuestion = isAnchor && item.questionOccurrences > 0 ? 1 : 0;
    const keepAnswer = isAnchor && item.questionOccurrences === 0 ? 1 : 0;
    const newQuestion = replaceRedundantKeyphraseOccurrences(entry.question, keyphrase, successor, keepQuestion);
    const newAnswer = replaceRedundantKeyphraseOccurrences(entry.answerText, keyphrase, successor, keepAnswer);
    if (newQuestion === entry.question && newAnswer === entry.answerText) return entry;
    if (!itemRepairIsValid(newQuestion, newAnswer, keyphrase)) return entry;
    return {
      ...entry,
      question: newQuestion,
      answerText: newAnswer,
      answerHtml: `<p>${escapeHtml(newAnswer)}</p>`,
    };
  });

  const changedIndexes = repaired
    .map((entry, index) => (entry !== entries[index] ? index : -1))
    .filter((index) => index >= 0);
  return { repaired, changedIndexes };
}
