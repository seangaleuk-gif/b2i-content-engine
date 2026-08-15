// ── Canonical publication-quality analysis ──
// Deterministic editorial and factual signals shared by the atomic editor,
// final policy and SEO audit. This module never mutates rendered HTML.

import {
  type ArticleComponent,
  type ArticleDocument,
  type EditorialBlock,
  detectClaimConflicts,
  extractPlainTextFromEditorialBlocks,
  isNonEmptyStructuredContinuation,
} from "@/lib/blog/article-document";
import {
  CONCLUSION_END_MARKER,
  CONCLUSION_START_MARKER,
} from "@/lib/blog/article-document";
import {
  extractParagraphTexts,
  extractReadableText,
} from "@/lib/seo/seo-text-utils";
import { createNumberExpressionRegex } from "@/lib/services/translation-number-grammar";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import {
  analyzeSentenceCompleteness,
  type SentenceCompletenessOptions,
  type SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";
import {
  isAuthoritativeLowercaseSentenceStart,
  isAuthoritativePunctuationOnlyResidue,
  findAuthoritativePunctuationOnlySentences,
  lowercaseStartValidTokensFromKeyphrase,
  sentenceTextRanges,
} from "@/lib/blog/sentence-quality";

export interface PublicationQualityMetrics {
  claimConflictCount: number;
  malformedProseCount: number;
  repeatedIdeaPairCount: number;
  roboticPhraseCount: number;
  conclusionWordCount: number;
  conclusionWordRatio: number;
  conclusionNewNumericClaimCount: number;
  factualScore: number;
  editorialScore: number;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for",
  "is", "are", "it", "this", "that", "with", "your", "you", "from", "as",
  "at", "be", "by", "can", "will", "not", "more", "than", "into", "their",
  "they", "its", "if", "so", "what", "when", "how", "about", "also",
]);

const ROBOTIC_PHRASES = [
  /\bthe key is\b/gi,
  // Imperative "Remember, ..." / "Remember to ..." only. A bare
  // \bremember\b also matches legitimate prose such as "people will
  // remember your brand", which would deflate the editorial score.
  /(?:^|[.!?;:]\s+)remember\b,?/gi,
  /\bthat(?:'|’)s why\b/gi,
  /\bthat(?:'|’)s the beauty of\b/gi,
  /\bthink of it as\b/gi,
  /\bin today(?:'|’)s (?:fast-paced|digital) world\b/gi,
  /\bgame[- ]changer\b/gi,
  /\bit(?:'|’)s not just .{0,80};? it(?:'|’)s\b/gi,
];

export type MalformedProseIssueCode =
  | "unmatched-parentheses"
  | "unmatched-quotation"
  | "broken-quoted-fragment"
  | "incomplete-sentence-ending"
  | "missing-terminal-punctuation"
  | "trailing-fragment"
  | "corrupt-token"
  | "serialized-program-value"
  | "instruction-placeholder"
  | "replacement-character"
  | "punctuation-fragment"
  | "lowercase-sentence-start";

export interface MalformedProseTextIssue {
  textIndex: number;
  code: MalformedProseIssueCode;
  message: string;
  text: string;
}

const CORRUPT_TEXT_PATTERNS: Array<{
  regex: RegExp;
  code: MalformedProseIssueCode;
  label: string;
}> = [
  {
    regex: /\b(?:manyf|asdf|qwerty|lorem ipsum)\b/i,
    code: "corrupt-token",
    label: "corrupt or placeholder token",
  },
  {
    regex: /\b(?:undefined|null|nan)\b/i,
    code: "serialized-program-value",
    label: "serialized program value",
  },
  {
    regex: /\[(?:insert|add|replace|example|citation)[^\]]*\]/i,
    code: "instruction-placeholder",
    label: "unresolved instruction placeholder",
  },
  {
    regex: /�/,
    code: "replacement-character",
    label: "replacement character",
  },
];

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

export function normalizedWordSet(text: string, excludeWords?: ReadonlySet<string>): Set<string> {
  const all = words(text);
  if (!excludeWords || excludeWords.size === 0) return new Set(all);
  return new Set(all.filter((word) => !excludeWords.has(word)));
}

/**
 * Focus-keyphrase tokens that must never count toward repeated-idea overlap.
 * The keyphrase is intentionally repeated across the article for SEO, so two
 * paragraphs that share only keyphrase words are not a duplicated idea.
 */
export function keyphraseExclusionSet(keyphrase: string): ReadonlySet<string> {
  if (!keyphrase) return new Set<string>();
  return new Set(words(keyphrase));
}

/** Pair-detection constants shared by the detector and the repetition repair. */
export const REPEATED_IDEA_MIN_PARAGRAPH_WORDS = 12;
export const REPEATED_IDEA_MIN_SHARED_WORDS = 5;
export const REPEATED_IDEA_OVERLAP_THRESHOLD = 0.55;

/** Canonical overlap between two normalized word sets. */
export function paragraphOverlap(
  left: Set<string>,
  right: Set<string>,
  excludeWords?: ReadonlySet<string>,
): { shared: number; smaller: number; ratio: number } {
  let leftF = left;
  let rightF = right;
  if (excludeWords && excludeWords.size > 0) {
    leftF = new Set([...left].filter((w) => !excludeWords.has(w)));
    rightF = new Set([...right].filter((w) => !excludeWords.has(w)));
  }
  const smaller = Math.min(leftF.size, rightF.size);
  if (smaller === 0) return { shared: 0, smaller: 0, ratio: 0 };
  let shared = 0;
  for (const word of leftF) if (rightF.has(word)) shared++;
  return { shared, smaller, ratio: shared / smaller };
}

export interface RepeatedIdeaPair {
  leftIndex: number;
  rightIndex: number;
}

/** Returns original text indexes for the canonical near-duplicate rule. */
export function findRepeatedIdeaPairs(texts: string[], excludeWords?: ReadonlySet<string>): RepeatedIdeaPair[] {
  const eligible = texts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => text.trim().split(/\s+/).length >= REPEATED_IDEA_MIN_PARAGRAPH_WORDS);
  const sets = eligible.map(({ text }) => normalizedWordSet(text, excludeWords));
  const pairs: RepeatedIdeaPair[] = [];
  for (let left = 0; left < sets.length; left++) {
    for (let right = left + 1; right < sets.length; right++) {
      const smaller = Math.min(sets[left].size, sets[right].size);
      if (smaller < REPEATED_IDEA_MIN_SHARED_WORDS) continue;
      let intersection = 0;
      for (const word of sets[left]) if (sets[right].has(word)) intersection++;
      if (
        intersection >= REPEATED_IDEA_MIN_SHARED_WORDS
        && intersection / smaller >= REPEATED_IDEA_OVERLAP_THRESHOLD
      ) {
        pairs.push({ leftIndex: eligible[left].index, rightIndex: eligible[right].index });
      }
    }
  }
  return pairs;
}

export function countRepeatedIdeaPairs(texts: string[], excludeWords?: ReadonlySet<string>): number {
  return findRepeatedIdeaPairs(texts, excludeWords).length;
}

/**
 * A sentence ending with a dangling stop-word immediately before terminal
 * punctuation ("Smart owners plan for.", "The budget is for.") is the residue
 * of a deleted object and is malformed. Stranded-preposition constructions are
 * legitimate English ("What are you waiting for?", "This is what we plan for.",
 * "We have a lot to deal with."): the ending word has an implicit or fronted
 * object, signalled by an interrogative/relative pronoun earlier in the
 * sentence or by a preceding infinitive ("to deal with."). Those are never
 * flagged, so valid prose cannot block publication.
 */
export function hasDanglingSentenceEnding(text: string): boolean {
  if (!/\b(?:a|an|the|to|for|with|and|or|but|because|of|in|on|at|from)\s*[.!?]\s*$/i.test(text)) {
    return false;
  }
  if (/\b(?:what|which|who|whom|whose|where|how|why|when)\b/i.test(text)) return false;
  if (/\bto\s+[a-z]{3,}\b/i.test(text)) return false;
  return true;
}

export function findMalformedProseTextIssues(
  texts: string[],
  kinds?: SentenceCompletenessKind[],
  completenessOptions?: SentenceCompletenessOptions[],
  validLowercaseTokens?: ReadonlySet<string>,
): MalformedProseTextIssue[] {
  const issues: MalformedProseTextIssue[] = [];
  const seen = new Set<string>();
  const addIssue = (
    textIndex: number,
    code: MalformedProseIssueCode,
    message: string,
    text: string,
  ) => {
    const key = `${textIndex}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ textIndex, code, message, text });
  };

  texts.forEach((text, index) => {
    const kind: SentenceCompletenessKind = kinds?.[index] ?? "paragraph";
    const trimmed = text.trim();
    const openParens = (trimmed.match(/\(/g) ?? []).length;
    const closeParens = (trimmed.match(/\)/g) ?? []).length;
    const quotation = analyzeQuotationIntegrity(trimmed);
    if (openParens !== closeParens) {
      addIssue(index, "unmatched-parentheses", "unmatched parentheses", trimmed);
    }
    if (!quotation.balanced) {
      addIssue(index, "unmatched-quotation", "unmatched quotation mark", trimmed);
    }
    // A period followed by a quote then a conjunction ("stop." and walked) is
    // a legitimately CLOSED quote continuing the sentence. Only an unclosed
    // quote (odd quote count) following the period is a broken fragment.
    if (
      !quotation.balanced
      && /[.!?]\s*["”]\s+(?:instead|and|but|or|because)\b/i.test(trimmed)
    ) {
      addIssue(index, "broken-quoted-fragment", "broken quoted fragment", trimmed);
    }
    if (hasDanglingSentenceEnding(trimmed)) {
      addIssue(index, "incomplete-sentence-ending", "incomplete sentence ending", trimmed);
    }
    // A block reduced to punctuation only (".", "...", "—") is a leftover
    // fragment from a deterministic sentence removal and is always malformed.
    // The same authoritative rule also flags a punctuation-only SENTENCE
    // inside an otherwise readable paragraph (". Plan a weekly routine."), so
    // the malformed-prose scanner and the final sentence-quality QC agree on
    // punctuation-only residue wherever it appears.
    if (isAuthoritativePunctuationOnlyResidue(trimmed)) {
      addIssue(index, "punctuation-fragment", "block contains only punctuation", trimmed);
    } else {
      for (const residue of findAuthoritativePunctuationOnlySentences(trimmed)) {
        addIssue(index, "punctuation-fragment", "block contains punctuation-only residue", residue);
      }
    }
    // Lowercase sentence starts are checked only when the caller supplies the
    // valid-lowercase-token context (the focus keyphrase): sentences beginning
    // with the exact keyphrase are valid lowercase tokens, not defects. This
    // is the SAME authoritative rule the final sentence-quality QC uses, so
    // the final-preflight repair boundary and final QC can never disagree.
    if (validLowercaseTokens !== undefined) {
      for (const range of sentenceTextRanges(trimmed)) {
        if (isAuthoritativeLowercaseSentenceStart(range.text, { validLowercaseTokens })) {
          addIssue(index, "lowercase-sentence-start", "sentence starts with a lowercase letter", range.text);
        }
      }
    }
    // Shared block-type-aware sentence-completeness contract: prose kinds
    // (paragraph/quote/FAQ answer) must end with complete sentences; heading,
    // list-item, table-cell, title, meta and excerpt kinds are structural and
    // reject only unmistakable fragments. This is the same validator used by
    // AI acceptance, coherence, trim/compaction validation and the final QC
    // and pre-save gates, so scanners can never disagree.
    const completeness = analyzeSentenceCompleteness(trimmed, kind, completenessOptions?.[index]);
    for (const issue of completeness.issues) {
      if (issue.code === "missing-terminal-punctuation") {
        addIssue(index, "missing-terminal-punctuation", issue.message, trimmed);
      } else if (issue.code === "trailing-fragment") {
        addIssue(index, "trailing-fragment", issue.message, trimmed);
      }
    }
    for (const pattern of CORRUPT_TEXT_PATTERNS) {
      if (pattern.regex.test(trimmed)) {
        addIssue(index, pattern.code, pattern.label, trimmed);
      }
    }
  });
  return issues;
}

export type MalformedProseSeverity = "hard" | "soft";

/**
 * Severity classification for malformed-prose findings, used by the repair
 * boundary policy. Every code emitted by the scanner is genuine
 * publication-breaking corruption once the false-positive-prone patterns are
 * narrowed at the scanner level (inches are not quotes, closed quotes are not
 * broken fragments, stranded prepositions are not dangling endings, pure
 * adverbs before determiners are not malformed noun phrases). The "soft"
 * bucket is intentionally empty so an unresolved finding can never block
 * publication on a scanner false positive.
 */
const HARD_MALFORMED_CODES: ReadonlySet<MalformedProseIssueCode> = new Set([
  "corrupt-token",
  "serialized-program-value",
  "instruction-placeholder",
  "replacement-character",
  "punctuation-fragment",
  "lowercase-sentence-start",
  "incomplete-sentence-ending",
  "missing-terminal-punctuation",
  "trailing-fragment",
  "unmatched-parentheses",
  "unmatched-quotation",
  "broken-quoted-fragment",
]);

export function classifyMalformedIssue(code: MalformedProseIssueCode): MalformedProseSeverity {
  return HARD_MALFORMED_CODES.has(code) ? "hard" : "soft";
}

export function detectMalformedProseTexts(texts: string[]): string[] {
  return findMalformedProseTextIssues(texts).map(
    (issue) => `text ${issue.textIndex + 1}: ${issue.message}`,
  );
}

function malformedTextsForBlock(block: EditorialBlock): {
  texts: string[];
  kinds: SentenceCompletenessKind[];
} {
  if (block.type === "list") {
    const texts = block.items.map((item) => item.map((inline) => inline.text).join(""));
    // List items are structural labels: punctuation is not required, but
    // unmistakable fragments are still rejected.
    return { texts, kinds: texts.map(() => "list-item" as const) };
  }
  if (block.type === "table") {
    // Table cells are independent language units. Flattening a whole table can
    // let an opening quote in one cell falsely balance a closing quote in an
    // unrelated cell, hiding two malformed cells from the publication gate.
    const texts = [...block.headers, ...block.rows.flat()]
      .map((cell) => cell.map((inline) => inline.text).join(""));
    return { texts, kinds: texts.map(() => "table-cell" as const) };
  }
  if (block.type === "quote") {
    return { texts: [extractPlainTextFromEditorialBlocks([block])], kinds: ["quote"] };
  }
  if (block.type === "subheading") {
    return { texts: [extractPlainTextFromEditorialBlocks([block])], kinds: ["subheading"] };
  }
  return { texts: [extractPlainTextFromEditorialBlocks([block])], kinds: ["paragraph"] };
}

/** Authoritative malformed-prose scan for a normalized editorial block set.
 *  `validLowercaseTokens` (the focus keyphrase) enables the authoritative
 *  lowercase-sentence-start rule for prose blocks; without it only the rules
 *  that need no keyphrase context apply. */
export function scanMalformedProseInBlocks(
  blocks: EditorialBlock[],
  validLowercaseTokens?: ReadonlySet<string>,
): Array<{
  blockId: string;
  issues: MalformedProseTextIssue[];
}> {
  const findings: Array<{ blockId: string; issues: MalformedProseTextIssue[] }> = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const { texts, kinds } = malformedTextsForBlock(block);
    const next = blocks[blockIndex + 1];
    const hasStructuredContinuation = isNonEmptyStructuredContinuation(next);
    const completenessOptions = texts.map(() => ({
      allowColonBeforeStructuredContinuation:
        block.type === "paragraph" && hasStructuredContinuation,
    }));
    const issues = findMalformedProseTextIssues(texts, kinds, completenessOptions, validLowercaseTokens);
    if (issues.length > 0) findings.push({ blockId: block.id, issues });
  }
  return findings;
}

/**
 * Authoritative malformed-prose scan over the final canonical ArticleDocument
 * (intro, editorial sections and conclusion). Blocks with any malformed-prose
 * issue are unresolved deterministic corruption and must be a hard failure at
 * the final gate and in the pre-save gate.
 */
export function scanMalformedProseInDocument(doc: ArticleDocument): Array<{
  componentId: string;
  blockId: string;
  issues: MalformedProseTextIssue[];
}> {
  const findings: Array<{ componentId: string; blockId: string; issues: MalformedProseTextIssue[] }> = [];
  const validLowercaseTokens = lowercaseStartValidTokensFromKeyphrase(doc.metadata.focusKeyphrase);
  const checkTextUnit = (componentId: string, blockId: string, texts: string[], kinds?: SentenceCompletenessKind[]) => {
    const issues = findMalformedProseTextIssues(texts, kinds);
    if (issues.length > 0) findings.push({ componentId, blockId, issues });
  };
  const checkComponent = (componentId: string, blocks: EditorialBlock[]) => {
    for (const finding of scanMalformedProseInBlocks(blocks, validLowercaseTokens)) {
      findings.push({ componentId, ...finding });
    }
  };
  checkTextUnit("metadata", "metadata-title", [doc.metadata.title], ["title"]);
  checkTextUnit("metadata", "metadata-description", [doc.metadata.metaDescription], ["meta-description"]);
  if (doc.metadata.excerpt) checkTextUnit("metadata", "metadata-excerpt", [doc.metadata.excerpt], ["excerpt"]);
  checkComponent(doc.introduction.id, doc.introduction.blocks);
  for (const section of doc.sections) {
    checkTextUnit(section.id, `${section.id}-heading`, [section.heading], ["heading"]);
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;
    checkComponent(section.id, section.blocks);
  }
  doc.visibleFaq.forEach((entry, index) => {
    // FAQ questions are structural short labels; FAQ answers are full prose
    // and must be complete sentences.
    checkTextUnit(`faq-${index}`, `faq-${index}-question`, [entry.question], ["heading"]);
    checkTextUnit(`faq-${index}`, `faq-${index}-answer`, [entry.answerText], ["faq-answer"]);
  });
  checkComponent(doc.conclusion.id, doc.conclusion.blocks);
  return findings;
}

function countRoboticPhrases(text: string): number {
  return ROBOTIC_PHRASES.reduce((total, regex) => total + (text.match(regex)?.length ?? 0), 0);
}

/** Exact robotic-phrase matches for diagnostics. Never includes credentials. */
export function extractRoboticPhraseMatches(text: string): string[] {
  const matches: string[] = [];
  for (const regex of ROBOTIC_PHRASES) {
    const found = text.match(regex);
    if (found) matches.push(...found);
  }
  return matches;
}

function numberClaims(text: string): string[] {
  const regex = createNumberExpressionRegex("gi");
  return [...text.matchAll(regex)].map((match) =>
    match[0].toLowerCase().replace(/[,\s]+/g, ""),
  );
}

function conclusionTextFromHtml(html: string): string {
  const start = html.indexOf(CONCLUSION_START_MARKER);
  const end = html.indexOf(CONCLUSION_END_MARKER);
  if (start < 0 || end <= start) return "";
  return extractReadableText(
    html.substring(start + CONCLUSION_START_MARKER.length, end),
  );
}

export function analyzePublicationQuality(html: string, excludeWords?: ReadonlySet<string>): PublicationQualityMetrics {
  const paragraphTexts = extractParagraphTexts(html);
  const readableText = extractReadableText(html);
  const claimConflicts = detectClaimConflicts(
    paragraphTexts.map((body, index) => ({ index, body })),
    { claims: [] },
  );
  const malformed = detectMalformedProseTexts(paragraphTexts);
  const repeatedIdeaPairCount = countRepeatedIdeaPairs(paragraphTexts, excludeWords);
  const roboticPhraseCount = countRoboticPhrases(readableText);
  const conclusionText = conclusionTextFromHtml(html);
  const conclusionWordCount = conclusionText
    ? conclusionText.split(/\s+/).filter(Boolean).length
    : 0;
  const articleWordCount = readableText
    ? readableText.split(/\s+/).filter(Boolean).length
    : 0;
  const conclusionWordRatio = articleWordCount > 0
    ? conclusionWordCount / articleWordCount
    : 0;
  const beforeConclusion = html.includes(CONCLUSION_START_MARKER)
    ? extractReadableText(html.substring(0, html.indexOf(CONCLUSION_START_MARKER)))
    : readableText;
  const priorNumbers = new Set(numberClaims(beforeConclusion));
  const conclusionNewNumericClaimCount = numberClaims(conclusionText)
    .filter((claim) => !priorNumbers.has(claim))
    .length;

  const factualScore = Math.max(
    0,
    100 - claimConflicts.length * 35 - conclusionNewNumericClaimCount * 15,
  );
  const conclusionPenalty = conclusionWordRatio > 0.18
    ? 35
    : conclusionWordRatio > 0.15
      ? 15
      : 0;
  const editorialScore = Math.max(
    0,
    100
      - malformed.length * 40
      - repeatedIdeaPairCount * 8
      - roboticPhraseCount * 3
      - conclusionPenalty,
  );

  return {
    claimConflictCount: claimConflicts.length,
    malformedProseCount: malformed.length,
    repeatedIdeaPairCount,
    roboticPhraseCount,
    conclusionWordCount,
    conclusionWordRatio,
    conclusionNewNumericClaimCount,
    factualScore,
    editorialScore,
  };
}

function componentText(component: ArticleComponent): string {
  return extractPlainTextFromEditorialBlocks(component.blocks);
}

function blockText(block: EditorialBlock): string {
  if (block.type === "list") {
    return block.items.flat().map((node) => node.text).join(" ");
  }
  if ("content" in block) return block.content.map((node) => node.text).join("");
  return "";
}

function blockHasProtectedFactOrLink(block: EditorialBlock): boolean {
  const text = blockText(block);
  const hasNumber = numberClaims(text).length > 0;
  const hasLink = block.type === "list"
    ? block.items.flat().some((node) => node.type === "link")
    : "content" in block && block.content.some((node) => node.type === "link");
  return hasNumber || hasLink;
}

/**
 * Deterministically reduces an overgrown conclusion by removing complete,
 * unlinked, non-numeric interior blocks. First and final blocks are retained.
 */
export function trimConclusionToBudget(
  doc: ArticleDocument,
  maxConclusionWords: number,
): { removedBlocks: number; beforeWords: number; afterWords: number } {
  const beforeWords = componentText(doc.conclusion).split(/\s+/).filter(Boolean).length;
  if (beforeWords <= maxConclusionWords || doc.conclusion.blocks.length <= 2) {
    return { removedBlocks: 0, beforeWords, afterWords: beforeWords };
  }

  const bodyTexts = [
    componentText(doc.introduction),
    ...doc.sections.map(componentText),
  ];
  const bodySets = bodyTexts.map((t) => normalizedWordSet(t));
  const candidates = doc.conclusion.blocks
    .map((block, index) => {
      const set = normalizedWordSet(blockText(block));
      let overlap = 0;
      for (const bodySet of bodySets) {
        let shared = 0;
        for (const word of set) if (bodySet.has(word)) shared++;
        overlap = Math.max(overlap, set.size > 0 ? shared / set.size : 0);
      }
      return { block, index, overlap };
    })
    .filter(({ block, index }) =>
      index > 0
      && index < doc.conclusion.blocks.length - 1
      && block.type === "paragraph"
      && !blockHasProtectedFactOrLink(block),
    )
    .sort((left, right) => right.overlap - left.overlap || right.index - left.index);

  const removeIndexes = new Set<number>();
  let currentWords = beforeWords;
  for (const candidate of candidates) {
    if (currentWords <= maxConclusionWords) break;
    removeIndexes.add(candidate.index);
    currentWords -= blockText(candidate.block).split(/\s+/).filter(Boolean).length;
  }
  if (removeIndexes.size > 0) {
    doc.conclusion.blocks = doc.conclusion.blocks.filter((_, index) => !removeIndexes.has(index));
    doc.conclusion.status = "trimmed";
  }
  const afterWords = componentText(doc.conclusion).split(/\s+/).filter(Boolean).length;
  return { removedBlocks: removeIndexes.size, beforeWords, afterWords };
}

export function editableTextsFromDocument(doc: ArticleDocument): string[] {
  return [
    ...doc.introduction.blocks,
    ...doc.sections.flatMap((section) => section.blocks),
    ...doc.conclusion.blocks,
  ].flatMap((block) => {
    if (block.type === "list") {
      return block.items.map((item) => item.map((node) => node.text).join(""));
    }
    return "content" in block ? [block.content.map((node) => node.text).join("")] : [];
  });
}
