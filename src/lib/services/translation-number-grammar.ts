// ── Centralized number-expression grammar for editorial translation ──
// Single source of truth used by both block-level and HTML-level
// protection, extraction, and validation.

const ALTERNATIVES: string[] = [
  // Currencies with optional thousands/decimal: HK$1,200, USD 500.50
  '(?:HK?\\$|US?\\$|USD|HKD|EUR|GBP|JPY|CNY)\\s*\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?',

  // Numbers with CJK currency suffix: 500港元, 1,200港幣
  '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?\\s*(?:港元|港幣|美元|歐元|英鎊|日圓|人民幣)',

  // Percentages: 50%, 12.5%
  '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?[%％]',

  // Scaled English words: 1,000 thousand, 5 million, 3.5 billion
  '\\d+(?:\\.\\d+)?\\s*(?:thousand|million|billion|trillion)',

  // Long-form dates: January 15, 2026, 15 January 2026
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},?\\s+\\d{4}',
  '\\d{1,2}\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{4}',

  // ISO dates: 2026-01-15
  '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',

  // Slash dates: 01/15/2026
  '\\b\\d{1,2}/\\d{1,2}/\\d{4}\\b',

  // Letter-suffix percentages/multipliers: 3x, 2.5x, 3×
  '\\b\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?[xX×](?!\\w)',

  // Thousands/millions/billions suffixes: 10K, 1.2M, 2B
  '\\b\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?[KkMmBb](?!\\w)',

  // Plain numbers with comma grouping or decimal: 1,000, 3.5, 100
  '\\b\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?\\b',
];

/** The shared numeric-expression source string.  Consumers create their
 *  own RegExp instances to avoid stateful `lastIndex` issues. */
export const NUMBER_EXPRESSION_SOURCE = ALTERNATIVES.join("|");

/** Create a fresh RegExp for the shared number grammar.
 *  @param flags - RegExp flags (default `"gi"`). */
export function createNumberExpressionRegex(flags = "gi"): RegExp {
  return new RegExp(NUMBER_EXPRESSION_SOURCE, flags);
}
