import type { ChatMessage } from "@/lib/services/deepseek";
import { ensureKeyphraseInTitle } from "@/lib/services/text-utils";
import { translationFaqCount } from "@/lib/content-standards";
import {
  type ArticleDocument, type FaqEntry,
  type ArticleComponent,
  renderArticleDocument, parseArticleDocumentFromHtml, fingerprintHtml,
  renderComponentHtml, validateFaqParity,
} from "@/lib/blog/article-document";
import { translateEditorialBlocks, editorialStructureSignature, type StructuredTranslationShadowOptions, type StructuredTranslationShadowResult, runConclusionStructuredShadow } from "./editorial-block-translation";
import type { TranslationMetrics, TranslationResult, ResearchItem } from "./translation-types";
import { RetryBudget } from "./translation-types";
import { TITLE_META_SYSTEM, TRANSLATION_SYSTEM, INTRO_RETRY_STRICT, chatWithBudget, translateText, translateSection, translateCtaBlock, translateFaqEntry, createProductionConclusionStructuredShadowOptions, translateStructuredEditorialPayload, repairStructuredEditorialPayload, translationDateInstruction, stripRedundantCtaTriple } from "./translation-ai";
import { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNumbersPreserved, extractVisibleNumbers, extractLinks, hasExcessiveEnglish, hasEnglishHeavyProseBlock, stripCitationSourceTitles, chineseLengthMetrics } from "./translation-validator";
import { protectNumbersInEditorialBlocks, checkBlockNumbersPreserved } from "./editorial-block-protection";
import { isConclusionShadowEvidenceEnabled, recordConclusionShadowEvidence } from "./conclusion-shadow-evidence";
import { isDocumentContextTranslationShadowEnabled, runDocumentContextTranslationShadow } from "./document-context-translation-shadow";
import type { ShadowProviderResponse } from "./shadow-number-protection";
import { isDocumentContextTranslationPrimaryEnabled, runPrimaryDocumentContextTranslation } from "./document-context-primary";
import { buildFaqSchemaJson, extractFaqFromDoc } from "./translation-assembler";
import { pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { buildTranslationGlossaryPrompt, deriveChineseKeyphrase, findTerminologyIssues, normalizeChineseEditorialText, chineseEndingPunctuation } from "./translation-glossary";
import { scanTemporalFreshness } from "@/lib/blog/temporal-freshness";
import type { EditorialBlock, InlineContent } from "@/lib/blog/article-content";
import { cloneEditorialBlocks } from "@/lib/blog/article-content";

export type { TranslationMetrics, TranslationResult, SourceDecision, InternalLinkDecision, ResearchItem } from "./translation-types";
export { RetryBudget } from "./translation-types";
export { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNoNewUrls, checkNumbersPreserved, extractVisibleNumbers, normalizeNumber, extractScaledNumbers, visibleChars, extractLinks, hasExcessiveEnglish, hasEnglishHeavyProseBlock, countCjkChars, countLatinWords, countParagraphs, estimatedReadingTime, chineseLengthMetrics } from "./translation-validator";
export { localiseSources, applySourceDecisions, localiseInternalLinks } from "./translation-assembler";
export { chatWithBudget, translateText, translateSection } from "./translation-ai";

const MAX_RETRY_BUDGET = 12;

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blockShape(component: ArticleComponent): string[] {
  return component.blocks.map((block) => {
    if (block.type === "list") return `${block.type}:${block.ordered}:${block.items.length}`;
    if (block.type === "table") return `${block.type}:${block.headers.length}:${block.rows.length}`;
    return block.type;
  });
}

const ALWAYS_PRESERVED_NAMES = [
  "Threads",
  "Meta",
  "Meta Ads Manager",
  "Facebook",
  "Instagram",
  "WordPress",
  "B2I Hub",
  "TikTok",
  "YouTube",
  "Google",
  "DeepSeek",
];

function compactEntityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Return only application-owned brands and publisher names that can be tied to
 * a research URL. Previous code protected every capitalised word from research
 * titles, which misclassified ordinary words such as “Need”, “Audience” and
 * “Which” as immutable named entities and caused valid Chinese translations to
 * fail closed.
 */
function protectedNamedEntities(
  sourceHtml: string,
  research: Array<Pick<ResearchItem, "url" | "title">>,
): string[] {
  const sourceText = sourceHtml.replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  const candidates = new Set(ALWAYS_PRESERVED_NAMES);

  for (const item of research) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./i, "");
      const base = host.split(".")[0] || "";
      const words = base.split(/[-_]+/).filter(Boolean);
      const baseKey = compactEntityKey(base);
      if (words.length > 0 && baseKey.length >= 3) {
        const spaced = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
        candidates.add(spaced);
        candidates.add(words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("-"));
        candidates.add(words.join(""));

        // A publisher may be written naturally in the title (for example,
        // “Ctrl the Click”) even when its hostname is compacted. Only retain a
        // title phrase when its compact form exactly matches the hostname base.
        for (const match of item.title.matchAll(/\b[A-Z][A-Za-z0-9&.-]*(?:\s+(?:[A-Za-z][A-Za-z0-9&.-]*)){0,4}\b/g)) {
          const phrase = match[0].trim();
          if (compactEntityKey(phrase) === baseKey) candidates.add(phrase);
        }
      }
    } catch {
      // Invalid research URLs are ignored here and handled by source validation.
    }
  }

  return [...candidates]
    .filter((name) => name.length >= 2)
    .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sourceText));
}

function missingProtectedNames(
  sourceHtml: string,
  translatedHtml: string,
  research: Array<Pick<ResearchItem, "url" | "title">>,
): string[] {
  const translatedText = translatedHtml.replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  return protectedNamedEntities(sourceHtml, research).filter(
    (name) => !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(translatedText),
  );
}


function isChineseMetadataCandidate(
  source: string,
  translated: string,
  research: Array<Pick<ResearchItem, "url" | "title">>,
): boolean {
  const sourceValue = source.trim();
  const translatedValue = translated.trim();
  if (!sourceValue) {
    if (!translatedValue) return true;
    return /[\u3400-\u9fff]{2}/u.test(translatedValue)
      && !hasExcessiveEnglish(translatedValue)
      && findTerminologyIssues(translatedValue).length === 0;
  }
  if (!translatedValue) return false;
  const cjkCount = (translatedValue.match(/[\u3400-\u9fff]/gu) || []).length;
  if (cjkCount < 2 || hasExcessiveEnglish(translatedValue)) return false;
  const numbers = checkNumbersPreserved(sourceValue, translatedValue);
  if (numbers.lost.length > 0 || numbers.extras.length > 0) return false;
  return missingProtectedNames(sourceValue, translatedValue, research).length === 0;
}

function isChineseKeyphrase(value: string): boolean {
  const normalized = value.trim();
  const chars = [...normalized];
  return chars.length >= 2
    && chars.length <= 20
    && /[\u3400-\u9fff]{2}/u.test(normalized)
    && /^[A-Za-z0-9\u3400-\u9fff\s-]+$/u.test(normalized);
}

function chineseEditorialIssues(html: string): string[] {
  const issues: string[] = [];
  // Exempt citation-label source titles before deriving the text surface so the
  // whole-component English check does not count preserved research titles.
  const text = stripCitationSourceTitles(html).replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  if (hasExcessiveEnglish(text)) issues.push("excessive English prose");
  if (/[A-Za-z]{3}/u.test(text) && !/[\u3400-\u9fff]/u.test(text)) issues.push("insufficient Chinese");

  if (hasEnglishHeavyProseBlock(html)) {
    issues.push("English-heavy prose block");
  }
  if (/[\u3400-\u9fff][,;!?][\u3400-\u9fff]/u.test(text)) {
    issues.push("half-width punctuation inside Chinese prose");
  }
  const proseBlocks = [...html.matchAll(/<(?:p|li|h3|td|th)\b[^>]*>([\s\S]*?)<\/(?:p|li|h3|td|th)>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const paragraphs = proseBlocks.filter((value) => value.length >= 20);
  if (new Set(paragraphs).size !== paragraphs.length) issues.push("duplicate Chinese paragraph");
  issues.push(...findTerminologyIssues(text));
  if (/__NUM_\d+__/u.test(text)) issues.push("unresolved number placeholder");
  return [...new Set(issues)];
}


function faqEditorialSurface(entry: Pick<FaqEntry, "question" | "answerHtml" | "answerText">): string {
  const answer = entry.answerHtml?.trim() || `<p>${entry.answerText}</p>`;
  return `<p>${entry.question}</p>${answer}`;
}

function chineseComponentParityIssues(
  source: ArticleComponent,
  translated: ArticleComponent,
  research: Array<Pick<ResearchItem, "url" | "title">>,
): string[] {
  const issues: string[] = [];
  const sourceHtml = renderComponentHtml(source);
  const translatedHtml = renderComponentHtml(translated);
  if (!sameStrings(editorialStructureSignature(source.blocks), editorialStructureSignature(translated.blocks))) {
    issues.push("editorial block or inline structure changed");
  }
  const completeness = checkCompleteness(sourceHtml, translatedHtml, source.id);
  if (!completeness.passed) issues.push(`translation completeness failed (ratio=${completeness.ratio.toFixed(2)})`);
  const numbers = checkBlockNumbersPreserved(source.blocks, translated.blocks);
  if (numbers.lost.length > 0 || numbers.extras.length > 0) {
    const detail = [
      numbers.lost.length > 0 ? `lost=${numbers.lost.join(",")}` : "",
      numbers.extras.length > 0 ? `extra=${numbers.extras.join(",")}` : "",
    ].filter(Boolean).join("; ");
    issues.push(`numbers changed${detail ? ` (${detail})` : ""}`);
  }
  if (!sameStrings(extractLinks(sourceHtml), extractLinks(translatedHtml))) issues.push("URLs changed");
  const names = missingProtectedNames(sourceHtml, translatedHtml, research);
  if (names.length > 0) issues.push(`named entities changed: ${names.join(", ")}`);
  return issues;
}

function htmlStructureSignature(html: string): string[] {
  return [...html.matchAll(/<(div|h[1-6]|p|a|ul|ol|li|span|strong)\b/gi)]
    .map((match) => match[1].toLowerCase());
}

function visibleChineseDraft(html: string): string {
  return html
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<script[^]*?<\/script>/gi, " ")
    .replace(/<style[^]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stripNumericExpressions(text: string): string {
  return text
    .replace(/(?:HK?\$|US?\$|[$£€¥])?\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:%|％|million|billion|thousand|萬|億|千))?/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function appendMetadataTokens(
  source: string,
  candidate: string,
  research: Array<Pick<ResearchItem, "url" | "title">>,
  label: "title" | "meta-description" | "excerpt",
): string {
  const sourceNumbers = extractVisibleNumbers(source);
  const requiredNames = protectedNamedEntities(source, research);
  const tokens = [...requiredNames, ...sourceNumbers].filter(Boolean);
  if (tokens.length === 0) return candidate.trim();
  const missing = tokens.filter((token) => !candidate.toLowerCase().includes(token.toLowerCase()));
  if (missing.length === 0) return candidate.trim();
  if (label === "title") return `${candidate.replace(/[｜|：:\s]+$/u, "")}｜${missing.join("、")}`.trim();
  return `${candidate.replace(/[。！？\s]+$/u, "")}。重點包括${missing.join("、")}。`.trim();
}

export function deterministicMetadataFallback(
  source: string,
  translatedContext: string,
  research: Array<Pick<ResearchItem, "url" | "title">>,
  label: "title" | "meta-description" | "excerpt",
  keyphrase = "",
): string {
  const cleanContext = stripNumericExpressions(visibleChineseDraft(translatedContext));
  const sentences = cleanContext
    .split(/(?<=[。！？])/u)
    .map((part) => part.trim())
    .filter((part) => /[\u3400-\u9fff]/u.test(part));
  const takeChars = (value: string, max: number): string => [...value].slice(0, max).join("").replace(/[，、：；\s]+$/u, "");
  const topic = takeChars((sentences[0] || cleanContext || "香港中小企實用策略").replace(/[。！？]+$/u, ""), 22);

  let base: string;
  if (label === "title") {
    const suffix = topic && !topic.includes(keyphrase) ? topic : "香港中小企實用策略與完整指南";
    base = keyphrase ? `${keyphrase}：${suffix}` : `${suffix}｜香港實用指南`;
    if ([...base].length < 20) base = `${base}｜香港中小企實用指南`;
    base = takeChars(base, 40);
  } else {
    const summary = sentences.slice(0, 3).join("")
      || `${keyphrase || "香港市場推廣"}實用指南，整理重點策略、執行方法及常見問題，協助香港中小企更有信心地制定下一步。`;
    const prefix = keyphrase && !summary.includes(keyphrase) ? `${keyphrase}：` : "";
    base = takeChars(`${prefix}${summary}`, label === "meta-description" ? 125 : 100);
    if (!/[。！？]$/u.test(base)) base += "。";
  }
  return appendMetadataTokens(source, base, research, label);
}

/** Deterministic fail-closed parity gate; exported for regression tests. */
export function validateTranslatedDocument(
  enDoc: ArticleDocument,
  zhDoc: ArticleDocument,
  research: Array<Pick<ResearchItem, "url" | "title">>,
): string[] {
  const errors: string[] = [];
  for (const [label, source, translated] of [
    ["title", enDoc.metadata.title, zhDoc.metadata.title],
    ["meta description", enDoc.metadata.metaDescription, zhDoc.metadata.metaDescription],
    ["excerpt", enDoc.metadata.excerpt, zhDoc.metadata.excerpt],
  ] as Array<[string, string, string]>) {
    const numbers = checkNumbersPreserved(source, translated);
    if (numbers.lost.length > 0 || numbers.extras.length > 0) errors.push(`${label} numbers changed`);
    const missingNames = missingProtectedNames(source, translated, research);
    if (missingNames.length > 0) errors.push(`${label} named entities changed: ${missingNames.join(", ")}`);
    if (!isChineseMetadataCandidate(source, translated, research)) {
      const cjkCount = (translated.match(/[\u3400-\u9fff]/gu) || []).length;
      if (cjkCount < 2) errors.push(`${label} contains insufficient Chinese`);
      if (hasExcessiveEnglish(translated)) errors.push(`${label} contains excessive English`);
    }
    for (const issue of findTerminologyIssues(translated)) errors.push(`${label}: ${issue}`);
  }
  if (zhDoc.sections.length !== enDoc.sections.length) errors.push("section count changed");
  if (!sameStrings(blockShape(enDoc.introduction), blockShape(zhDoc.introduction))) {
    errors.push("introduction block structure changed");
  }
  if (!sameStrings(blockShape(enDoc.conclusion), blockShape(zhDoc.conclusion))) {
    errors.push("conclusion block structure changed");
  }
  for (let index = 0; index < Math.min(enDoc.sections.length, zhDoc.sections.length); index++) {
    const source = enDoc.sections[index];
    const translated = zhDoc.sections[index];
    if (source.sectionType !== translated.sectionType) errors.push(`section ${index} type changed`);
    if (source.heading.trim() && !/[\u3400-\u9fff]/u.test(translated.heading)) {
      errors.push(`section ${index} heading contains insufficient Chinese`);
    }
    if (hasExcessiveEnglish(translated.heading)) errors.push(`section ${index} heading contains excessive English`);
    for (const issue of findTerminologyIssues(translated.heading)) errors.push(`section ${index} heading: ${issue}`);
    if (!sameStrings(blockShape(source), blockShape(translated))) {
      errors.push(`section ${index} block structure changed`);
    }
    const headingNumbers = checkNumbersPreserved(source.heading, translated.heading);
    if (headingNumbers.lost.length > 0 || headingNumbers.extras.length > 0) {
      errors.push(`section ${index} heading numbers changed`);
    }
    const missingHeadingNames = missingProtectedNames(source.heading, translated.heading, research);
    if (missingHeadingNames.length > 0) {
      errors.push(`section ${index} heading named entities changed: ${missingHeadingNames.join(", ")}`);
    }
  }

  const componentPairs: Array<[string, ArticleComponent, ArticleComponent]> = [
    ["introduction", enDoc.introduction, zhDoc.introduction],
    ...enDoc.sections.slice(0, zhDoc.sections.length).map((section, index) => [
      `section-${index}`,
      section,
      zhDoc.sections[index],
    ] as [string, ArticleComponent, ArticleComponent]),
    ["conclusion", enDoc.conclusion, zhDoc.conclusion],
  ];
  for (const [label, sourceComponent, translatedComponent] of componentPairs) {
    const sourceHtml = renderComponentHtml(sourceComponent);
    const translatedHtml = renderComponentHtml(translatedComponent);
    if (visibleChineseDraft(sourceHtml) && !/[\u3400-\u9fff]/u.test(visibleChineseDraft(translatedHtml))) {
      errors.push(`${label} contains insufficient Chinese`);
    }
    // EditorialBlock[] is canonical. The HTML checker remains useful for
    // metadata/FAQ/CTA, but component number parity must use the same
    // authoritative structured representation used during translation.
    const numbers = checkBlockNumbersPreserved(sourceComponent.blocks, translatedComponent.blocks);
    if (numbers.lost.length > 0 || numbers.extras.length > 0) {
      const detail = [
        numbers.lost.length > 0 ? `lost=${numbers.lost.join(",")}` : "",
        numbers.extras.length > 0 ? `extra=${numbers.extras.join(",")}` : "",
      ].filter(Boolean).join("; ");
      errors.push(`${label} numbers changed${detail ? ` (${detail})` : ""}`);
    }
    if (!sameStrings(extractLinks(sourceHtml), extractLinks(translatedHtml))) errors.push(`${label} URLs changed`);
    const missingNames = missingProtectedNames(sourceHtml, translatedHtml, research);
    if (missingNames.length > 0) errors.push(`${label} named entities changed: ${missingNames.join(", ")}`);
    for (const issue of chineseEditorialIssues(translatedHtml)) errors.push(`${label}: ${issue}`);
  }

  if (enDoc.visibleFaq.length !== zhDoc.visibleFaq.length) errors.push("FAQ count changed");
  for (let index = 0; index < Math.min(enDoc.visibleFaq.length, zhDoc.visibleFaq.length); index++) {
    const source = `${enDoc.visibleFaq[index].question}\n${enDoc.visibleFaq[index].answerHtml || enDoc.visibleFaq[index].answerText}`;
    const translated = `${zhDoc.visibleFaq[index].question}\n${zhDoc.visibleFaq[index].answerHtml || zhDoc.visibleFaq[index].answerText}`;
    if (!/[\u3400-\u9fff]/u.test(zhDoc.visibleFaq[index].question)) errors.push(`FAQ ${index + 1} question contains insufficient Chinese`);
    if (!zhDoc.visibleFaq[index].question.trim().endsWith("？")) errors.push(`FAQ ${index + 1} question lacks full-width question punctuation`);
    if (!/[\u3400-\u9fff]/u.test(zhDoc.visibleFaq[index].answerHtml || zhDoc.visibleFaq[index].answerText)) errors.push(`FAQ ${index + 1} answer contains insufficient Chinese`);
    const numbers = checkNumbersPreserved(source, translated);
    if (numbers.lost.length > 0 || numbers.extras.length > 0) errors.push(`FAQ ${index + 1} numbers changed`);
    if (!sameStrings(extractLinks(source), extractLinks(translated))) errors.push(`FAQ ${index + 1} URLs changed`);
    const missingNames = missingProtectedNames(source, translated, research);
    if (missingNames.length > 0) errors.push(`FAQ ${index + 1} named entities changed: ${missingNames.join(", ")}`);
    for (const issue of chineseEditorialIssues(faqEditorialSurface(zhDoc.visibleFaq[index]))) {
      errors.push(`FAQ ${index + 1}: ${issue}`);
    }
  }

  if (Boolean(enDoc.cta) !== Boolean(zhDoc.cta)) errors.push("CTA presence changed");
  if (enDoc.cta && zhDoc.cta) {
    const numbers = checkNumbersPreserved(enDoc.cta.html, zhDoc.cta.html);
    if (numbers.lost.length > 0 || numbers.extras.length > 0) errors.push("CTA numbers changed");
    if (!sameStrings(extractLinks(enDoc.cta.html), extractLinks(zhDoc.cta.html))) errors.push("CTA URLs changed");
    const missingNames = missingProtectedNames(enDoc.cta.html, zhDoc.cta.html, research);
    if (missingNames.length > 0) errors.push(`CTA named entities changed: ${missingNames.join(", ")}`);
    if (!sameStrings(htmlStructureSignature(enDoc.cta.html), htmlStructureSignature(zhDoc.cta.html))) {
      errors.push("CTA HTML structure changed");
    }
    if (!/app\.b2ihub\.com\/signup/i.test(zhDoc.cta.html)) errors.push("CTA signup URL missing");
    if (!/[\u3400-\u9fff]/u.test(visibleChineseDraft(zhDoc.cta.html))) errors.push("CTA contains insufficient Chinese");
    for (const issue of chineseEditorialIssues(zhDoc.cta.html)) errors.push(`CTA: ${issue}`);
  }
  if (enDoc.metadata.focusKeyphrase && !/[\u3400-\u9fff]/u.test(zhDoc.metadata.focusKeyphrase)) {
    errors.push("Chinese focus keyphrase missing");
  }
  if (zhDoc.metadata.focusKeyphrase && !zhDoc.metadata.title.includes(zhDoc.metadata.focusKeyphrase)) {
    errors.push("Chinese focus keyphrase missing from SEO title");
  }
  if (!zhDoc.languageSwitcher) {
    errors.push("Chinese language switcher missing");
  } else {
    const slugs = pairedSlugs(enDoc.metadata.slug || "blog-post");
    const expectedSwitcher = renderLanguageSwitcher({
      currentLanguage: "zh",
      englishSlug: slugs.englishSlug,
      chineseSlug: slugs.chineseSlug,
    });
    if (zhDoc.languageSwitcher.html !== expectedSwitcher) {
      errors.push("Chinese language switcher is not canonical");
    }
  }
  if (zhDoc.visibleFaq.length > 0) {
    const rendered = renderArticleDocument(zhDoc);
    const schema = extractFaqBlock(rendered);
    if (!schema) errors.push("FAQ schema missing");
    else {
      const parity = validateFaqParity(zhDoc.visibleFaq, schema);
      if (!parity.valid) errors.push(`FAQ schema parity failed: ${parity.issues.map((issue) => issue.detail).join("; ")}`);
    }
  }

  const temporalSurface = [
    zhDoc.metadata.title,
    zhDoc.metadata.metaDescription,
    zhDoc.metadata.excerpt,
    renderArticleDocument(zhDoc),
  ].join("\n");
  for (const issue of scanTemporalFreshness(temporalSurface, new Date())) {
    errors.push(`stale temporal wording: ${issue.sentence}`);
  }
  return [...new Set(errors)];
}

// ── Deterministic Chinese editorial-quality normalization ──
// Runs after AI translation/repair, before final validation. It applies the
// same deterministic repairs the final gate checks (terminology, register,
// literal phrases, source labels, CTA redundancy) so AI inconsistency cannot
// fail the article or ship mixed-register copy. It preserves block structure,
// URLs, numbers, headings, FAQ schema and CTA structure — text-only edits.

function normalizeInlineContent(nodes: InlineContent[], fn: (text: string) => string): void {
  for (const node of nodes) node.text = fn(node.text);
}

function normalizeEditorialBlocks(blocks: EditorialBlock[], fn: (text: string) => string): void {
  for (const block of blocks) {
    if (block.type === "list") {
      for (const item of block.items) normalizeInlineContent(item, fn);
    } else if (block.type === "table") {
      for (const header of block.headers) normalizeInlineContent(header, fn);
      for (const row of block.rows) for (const cell of row) normalizeInlineContent(cell, fn);
    } else {
      normalizeInlineContent(block.content, fn);
    }
  }
}

/** Joined visible text of an inline node list (links contribute their text). */
function inlineVisibleText(nodes: InlineContent[]): string {
  return nodes.map((node) => node.text).join("");
}

/** True when a paragraph's joined visible text starts with a source label. */
function isSourceLabelInline(nodes: InlineContent[]): boolean {
  return /^\s*(資料)?來源[：:]/.test(inlineVisibleText(nodes).trimStart());
}

/** Normalize a source-label paragraph block at the block level. */
function normalizeSourceLabelBlock(blocks: EditorialBlock[], kind: "paragraph" | "quote"): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type !== kind) continue;
    const content = block.content;
    if (!isSourceLabelInline(content)) continue;
    // Normalize the prefix in the first text node: 資料來源： → 來源：.
    const first = content[0];
    if (first && first.type !== "link") {
      const normalized = first.text.replace(/^(資料)?來源[：:]/u, "來源：");
      if (normalized !== first.text) { first.text = normalized; count++; }
    }
    // Strip trailing 。！？ from the final text node only; never touch links.
    const last = content[content.length - 1];
    if (last && last.type !== "link") {
      const stripped = last.text.replace(/[。！？]+$/u, "");
      if (stripped !== last.text) { last.text = stripped; count++; }
    }
  }
  return count;
}

/** Tag-aware normalization for FAQ/CTA HTML strings: only text outside tags changes. */
function normalizeHtmlTextContent(html: string, fn: (text: string) => string): string {
  return html.replace(/(<[^>]*>)|([^<>]+)/gu, (match, tag: string | undefined, text: string | undefined) => {
    if (tag !== undefined) return tag;
    return fn(text ?? "");
  });
}

/** Append sentence-ending punctuation to the last text-bearing inline node. */
function appendPunctuationToInline(nodes: InlineContent[], kind: "paragraph" | "heading" | "question"): boolean {
  // Never add punctuation to a source-label paragraph.
  if (isSourceLabelInline(nodes)) return false;
  const combined = inlineVisibleText(nodes);
  const punct = chineseEndingPunctuation(combined, kind);
  if (!punct || nodes.length === 0) return false;
  const last = nodes[nodes.length - 1];
  // Append to a text node; never into a link.
  if (last.type === "link") return false;
  last.text = last.text + punct;
  return true;
}

/** Append sentence-ending punctuation to the visible text at the end of HTML. */
function appendPunctuationToHtmlEnd(html: string, kind: "paragraph" | "heading" | "question"): string {
  const matches = [...html.matchAll(/([^<>]+)(?=<|$)/g)];
  if (matches.length === 0) return html;
  const lastMatch = matches[matches.length - 1];
  const punct = chineseEndingPunctuation(lastMatch[1], kind);
  if (!punct) return html;
  return html.slice(0, lastMatch.index!) + lastMatch[1] + punct + html.slice(lastMatch.index! + lastMatch[1].length);
}

/** Apply sentence-ending punctuation to paragraph/quote blocks (not tables/lists). */
function punctuateParagraphBlocks(blocks: EditorialBlock[], kind: "paragraph" | "heading" | "question"): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "quote") {
      if (appendPunctuationToInline(block.content, kind)) count++;
    } else if (block.type === "list") {
      for (const item of block.items) if (appendPunctuationToInline(item, kind)) count++;
    }
  }
  return count;
}

/**
 * Deterministically normalize the translated Chinese document:
 *  - terminology (影響力行銷 / 網紅營銷 / KOL市場推廣 → 創作者市場推廣)
 *  - conversational Cantonese register (formal markers → 嘅/點解/咩/我哋…)
 *  - literal/unnatural phrases (靚仔廣告, 搵到咁肥沃嘅土壤, X-focused嘅)
 *  - source labels (資料來源： → 來源：, strip trailing ？。)
 *  - CTA redundancy (無中介、無佣金、無中間人)
 *  - meta description length (80–120)
 *  - exact keyphrase placement within the first 200 characters
 *  - exact keyphrase density ≤ 1.5% using natural variations
 */
export function normalizeZhDocumentEditorialQuality(
  doc: ArticleDocument,
  keyphrase: string,
  faqEntries: FaqEntry[] = [],
  metaDescriptionMin = 80,
  metaDescriptionMax = 120,
): { changes: number } {
  let changes = 0;
  const applyText = (text: string): string => {
    const normalized = normalizeChineseEditorialText(text);
    if (normalized !== text) changes++;
    return normalized;
  };

  // 1. Intro, sections (heading + blocks), conclusion.
  normalizeEditorialBlocks(doc.introduction.blocks, applyText);
  changes += punctuateParagraphBlocks(doc.introduction.blocks, "paragraph");
  for (const section of doc.sections) {
    const heading = applyText(section.heading);
    const headingPunct = chineseEndingPunctuation(heading, "heading");
    if (headingPunct) {
      const punctuatedHeading = heading + headingPunct;
      if (punctuatedHeading !== section.heading) changes++;
      section.heading = punctuatedHeading;
    } else if (heading !== section.heading) {
      changes++;
      section.heading = heading;
    }
    normalizeEditorialBlocks(section.blocks, applyText);
    changes += punctuateParagraphBlocks(section.blocks, "paragraph");
  }
  normalizeEditorialBlocks(doc.conclusion.blocks, applyText);
  changes += punctuateParagraphBlocks(doc.conclusion.blocks, "paragraph");

  // 2. FAQ entries (question + answerText) — structure and schema preserved.
  const faqToNormalize = faqEntries.length > 0 ? faqEntries : doc.visibleFaq;
  for (const entry of faqToNormalize) {
    const question = applyText(entry.question);
    const questionPunct = chineseEndingPunctuation(question, "question");
    const punctuatedQuestion = questionPunct ? question + questionPunct : question;
    if (punctuatedQuestion !== entry.question) changes++;
    entry.question = punctuatedQuestion;
    const answerText = applyText(entry.answerText);
    const answerPunct = chineseEndingPunctuation(answerText, "paragraph");
    const punctuatedAnswerText = answerPunct ? answerText + answerPunct : answerText;
    if (punctuatedAnswerText !== entry.answerText) changes++;
    entry.answerText = punctuatedAnswerText;
    const answerHtml = normalizeHtmlTextContent(entry.answerHtml, applyText);
    const punctuatedAnswerHtml = appendPunctuationToHtmlEnd(answerHtml, "paragraph");
    if (punctuatedAnswerHtml !== entry.answerHtml) changes++;
    entry.answerHtml = punctuatedAnswerHtml;
  }

  // 3. Metadata (title, meta description, excerpt).
  doc.metadata.title = applyText(doc.metadata.title);
  doc.metadata.excerpt = applyText(doc.metadata.excerpt);
  doc.metadata.metaDescription = applyText(doc.metadata.metaDescription);

  // 4. Source labels in block text: normalize prefix and strip trailing ？。
  // Operate at the block level so a source label split across inline nodes
  // (text + link + trailing punctuation node) is handled as one unit.
  changes += normalizeSourceLabelBlock(doc.introduction.blocks, "paragraph");
  for (const section of doc.sections) changes += normalizeSourceLabelBlock(section.blocks, "paragraph");
  changes += normalizeSourceLabelBlock(doc.conclusion.blocks, "paragraph");

  // 5. CTA editorial normalization (text-only, structure preserved). Apply the
  // full editorial normalization (terminology, register, literal phrases) to
  // the CTA visible text first, then remove redundant triple formulations.
  if (doc.cta?.html) {
    const ctaHtml = normalizeHtmlTextContent(doc.cta.html, (text) => {
      const normalized = normalizeChineseEditorialText(text);
      const stripped = stripRedundantCtaTriple(normalized);
      if (stripped !== text) changes++;
      return stripped;
    });
    if (ctaHtml !== doc.cta.html) changes++;
    doc.cta.html = ctaHtml;
  }

  // 6. Meta description length: expand deterministically when outside range.
  if (doc.metadata.metaDescription) {
    const metaLen = [...doc.metadata.metaDescription].length;
    if (metaLen < metaDescriptionMin) {
      const expanded = expandZhMetaDescription(doc.metadata.metaDescription, doc, metaDescriptionMin, metaDescriptionMax);
      if (expanded !== doc.metadata.metaDescription) {
        doc.metadata.metaDescription = expanded;
        changes++;
      }
    } else if (metaLen > metaDescriptionMax) {
      const truncated = [...doc.metadata.metaDescription].slice(0, metaDescriptionMax).join("").replace(/[，、：；\s]+$/u, "");
      if (truncated !== doc.metadata.metaDescription) {
        doc.metadata.metaDescription = truncated;
        changes++;
      }
    }
  }

  // 7. Exact keyphrase placement + density (audit semantics: readable body text).
  const placement = ensureKeyphrasePlacementAndDensity(doc, keyphrase);
  changes += placement.changes;

  return { changes };
}

/** Deterministic meta-description expansion using the translated article's own prose. */
function expandZhMetaDescription(current: string, doc: ArticleDocument, min: number, max: number): string {
  const proseParts: string[] = [];
  for (const block of doc.introduction.blocks) {
    if (block.type === "paragraph") {
      for (const node of block.content) if (node.type === "text") proseParts.push(node.text);
    }
  }
  const base = current.replace(/[。！？]+$/u, "");
  const pool = proseParts.filter((part) => /[\u3400-\u9fff]/u.test(part));
  const joined = `${base}。${pool.slice(0, 3).join("")}`;
  const budget = max - 1;
  const truncated = [...joined].slice(0, budget).join("").replace(/[，、：；\s]+$/u, "");
  if ([...truncated].length < min) return current;
  return `${truncated}。`;
}

/** Count visible CJK characters in rendered blog HTML (mirrors the Chinese SEO audit). */
function countRenderedCjk(html: string): number {
  return (html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[a-zA-Z0-9]/g, "")
    .match(/[\u3400-\u9fff]/gu) || []).length;
}

/**
 * Ensure the exact keyphrase appears within the first 200 readable characters
 * and that exact-keyphrase density stays ≤ 1.5%. Over-represented exact
 * occurrences are converted to the natural variation 「創作者市場推廣」.
 */
function ensureKeyphrasePlacementAndDensity(
  doc: ArticleDocument,
  keyphrase: string,
): { changes: number } {
  if (!keyphrase) return { changes: 0 };
  let changes = 0;
  const kp = keyphrase.trim();

  const readableTextOf = (html: string): string =>
    html
      .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const countExact = (text: string): number => {
    let count = 0, pos = 0;
    while ((pos = text.indexOf(kp, pos)) !== -1) { count++; pos += kp.length; }
    return count;
  };

  // Convert one exact occurrence after the first 200 chars into a variation
  // until density ≤ 1.5% (preferredMax from chineseKeyphraseDensity).
  const kpCjkLen = [...kp].filter((c) => c.charCodeAt(0) >= 0x4E00).length || 1;

  // Collect text nodes in document order for deterministic rewrites.
  interface TextSlot { get: () => string; set: (v: string) => void; }
  const slots: TextSlot[] = [];
  const collect = (blocks: EditorialBlock[]) => {
    const visitInline = (nodes: InlineContent[]) => {
      for (const node of nodes) {
        if (node.type !== "link") {
          slots.push({ get: () => node.text, set: (v) => { node.text = v; } });
        }
      }
    };
    for (const block of blocks) {
      if (block.type === "list") for (const item of block.items) visitInline(item);
      else if (block.type === "table") { for (const h of block.headers) visitInline(h); for (const row of block.rows) for (const cell of row) visitInline(cell); }
      else visitInline(block.content);
    }
  };
  collect(doc.introduction.blocks);
  for (const section of doc.sections) collect(section.blocks);
  collect(doc.conclusion.blocks);

  const render = (): string => readableTextOf(renderArticleDocument(doc));
  let readable = render();

  // 7a. Placement: exact keyphrase within the first 200 chars.
  let placedSlotIndex = -1;
  if (!readable.substring(0, 200).includes(kp)) {
    const first200 = readable.substring(0, 200);
    const variation = "創作者市場推廣";
    const variationIndex = first200.indexOf(variation);
    if (variationIndex !== -1 && variationIndex + variation.length <= 200) {
      // Find the slot containing that occurrence and upgrade it.
      let consumed = 0;
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const slot = slots[slotIndex];
        const text = slot.get();
        const local = text.indexOf(variation);
        if (local !== -1 && consumed + local + variation.length <= 200) {
          slot.set(text.slice(0, local) + kp + text.slice(local + variation.length));
          placedSlotIndex = slotIndex;
          changes++;
          break;
        }
        consumed += text.length;
      }
    }
  }
  readable = render();
  const html = renderArticleDocument(doc);
  const zhCharCount = countRenderedCjk(html);
  const exactCount = countExact(readable);
  // Always keep at least the placed/first exact occurrence so the keyphrase
  // remains present, and cap density at 1.5% (preferredMax).
  const maxExact = zhCharCount > 0
    ? Math.max(1, Math.floor((1.5 * zhCharCount) / (100 * kpCjkLen)))
    : 1;

  // 7b. Density: convert trailing exact occurrences to the natural variation,
  // never the slot that guarantees the first-200 placement.
  let over = exactCount - maxExact;
  if (over > 0) {
    const variation = "創作者市場推廣";
    for (let i = slots.length - 1; i >= 0 && over > 0; i--) {
      if (i === placedSlotIndex) continue;
      const slot = slots[i];
      const text = slot.get();
      if (text.includes(kp)) {
        slot.set(text.split(kp).join(variation));
        over -= countExact(text);
        changes++;
      }
    }
  }

  return { changes };
}

type InternalLinkDecision = import("./translation-types").InternalLinkDecision;
type SourceDecision = import("./translation-types").SourceDecision;

export async function translateArticle(
  enHtml: string,
  sourceDoc: ArticleDocument,
  research: ResearchItem[],
  deps?: {
    translateEditorialBlocks?: typeof translateEditorialBlocks;
    structuredTranslationShadow?: StructuredTranslationShadowOptions;
    /** Project id used only for the diagnostic shadow-preview export filename. */
    projectId?: number;
    /** Override the diagnostic shadow-preview export directory (used by tests). */
    shadowPreviewDir?: string;
    /** Primary document-context path overrides (used by tests to inject a provider). */
    documentContextPrimary?: {
      callProvider?: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>;
    };
    /** Brand Voice text for the document-context path. Blank/missing uses the canonical default. */
    brandVoice?: string;
  },
): Promise<TranslationResult> {
  const translateEditorialBlocksFn = deps?.translateEditorialBlocks ?? translateEditorialBlocks;
  const shadowEnabled = deps?.structuredTranslationShadow?.enabled ?? (process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION === "true");
  const budget = new RetryBudget(MAX_RETRY_BUDGET);
  const structuredFallbackCallbacks = {
    translateProtectedPayload: (
      payloadJson: string,
      context: { componentKind: "introduction" | "section" | "conclusion"; componentId: string },
    ) => translateStructuredEditorialPayload(payloadJson, context, budget),
    repairProtectedPayload: (
      sourcePayloadJson: string,
      invalidResponse: string,
      errors: string[],
      context: { componentKind: "introduction" | "section" | "conclusion"; componentId: string },
    ) => repairStructuredEditorialPayload(
      sourcePayloadJson,
      invalidResponse,
      errors,
      context,
      budget,
    ),
  };
  const shadowOptions: StructuredTranslationShadowOptions = shadowEnabled
    ? deps?.structuredTranslationShadow ?? createProductionConclusionStructuredShadowOptions(budget)
    : { enabled: false, translatePayload: async () => "" };
  const warnings: string[] = [];
  const metrics: TranslationMetrics[] = [];
  const failedComponents = new Set<string>();
  const markFailure = (componentId: string): void => { failedComponents.add(componentId); };
  const clearFailure = (...componentIds: string[]): void => {
    for (const componentId of componentIds) failedComponents.delete(componentId);
  };
  const shadowResults: StructuredTranslationShadowResult[] = [];

  let enDoc: ArticleDocument;
  if (sourceDoc) {
    const parsed = parseArticleDocumentFromHtml(enHtml, sourceDoc);
    if (!parsed.doc) throw new Error(`Failed to parse English article: ${parsed.errors.join("; ")}`);
    enDoc = parsed.doc;
  } else {
    const fallbackDoc: ArticleDocument = {
      metadata: { title: "", slug: "", metaDescription: "", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
      languageSwitcher: null, introduction: { id: "intro", blocks: [], status: "generated" },
      sections: [], visibleFaq: [],
      conclusion: { id: "conc", blocks: [], status: "generated" },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const parsed = parseArticleDocumentFromHtml(enHtml, fallbackDoc);
    if (!parsed.doc) throw new Error(`Failed to parse English article: ${parsed.errors.join("; ")}`);
    enDoc = parsed.doc;
  }

  // ── Controlled primary-path trial ──
  // When ENABLE_DOCUMENT_CONTEXT_TRANSLATION_PRIMARY=true, the verified
  // document-context path is the SOLE Traditional Chinese translation path and
  // the old 38-45-call pipeline is bypassed entirely. A failure throws a clear
  // error (never saving, never falling back to the old pipeline).
  if (isDocumentContextTranslationPrimaryEnabled()) {
    return runPrimaryDocumentContextTranslation(enDoc, {
      projectId: deps?.projectId,
      outputDir: deps?.shadowPreviewDir,
      callProvider: deps?.documentContextPrimary?.callProvider,
      brandVoice: deps?.brandVoice,
    });
  }

  const slugs = pairedSlugs(enDoc.metadata.slug || "blog-post");
  const zhDoc: ArticleDocument = {
    metadata: { ...enDoc.metadata, title: "", slug: slugs.chineseSlug, metaDescription: "" },
    languageSwitcher: null,
    introduction: { id: "zh-intro", blocks: [], status: "generated" },
    sections: [], visibleFaq: [],
    conclusion: { id: "zh-conc", blocks: [], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: enDoc.insertedLinks,
  };

  async function repairMetadataParity(
    source: string,
    current: string,
    label: "title" | "meta-description" | "excerpt",
    keyphraseHint = "",
  ): Promise<{ text: string; passed: boolean }> {
    if (isChineseMetadataCandidate(source, current, research)) {
      return { text: current, passed: true };
    }
    const { protectedHtml, placeholders, originalValues } = protectNumbersInHtml(source);
    const names = protectedNamedEntities(source, research);
    try {
      let candidate = await translateText(
        protectedHtml,
        `Targeted metadata repair for ${label}. Translate to natural Hong Kong Traditional Chinese. Preserve every __NUM_n__ token exactly and preserve these names exactly: ${names.join(", ") || "none"}. ${keyphraseHint ? `Include the Chinese keyphrase "${keyphraseHint}" naturally.` : ""} Return only the translated text.`,
        TITLE_META_SYSTEM,
        keyphraseHint || undefined,
        `${label}-parity-repair`,
        budget,
      );
      if (placeholders.length > 0) {
        const restored = tryRestoreNumbersInHtml(candidate, placeholders, originalValues);
        if (!restored.ok) return { text: current, passed: false };
        candidate = restored.html;
      }
      candidate = candidate.trim();
      if (isChineseMetadataCandidate(source, candidate, research)) {
        return { text: candidate, passed: true };
      }
    } catch (error) {
      console.warn(`[translate] ${label} parity repair failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { text: current, passed: false };
  }

  // ── Provisional metadata ──
  // Metadata is intentionally non-fatal and is finalized after the article
  // body exists. This prevents a short or empty title response from stopping
  // the translation before the first content block is processed.
  async function safeText(
    source: string,
    instruction: string,
    systemPrompt: string,
    component: string,
    keyphrase?: string,
  ): Promise<string> {
    try {
      return (await translateText(source, instruction, systemPrompt, keyphrase, component, budget)).trim();
    } catch (error) {
      warnings.push(`${component} provider response unavailable; deferred deterministic fallback will be used`);
      console.warn(`[translate] ${component} failed: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  // Start translation with a deterministic, valid Chinese keyphrase. SEO
  // metadata is generated only after the complete Chinese draft exists, so an
  // empty metadata response can never prevent article translation from starting.
  const sourceKeyword = enDoc.metadata.focusKeyphrase || "";
  let zhKeyphrase = deriveChineseKeyphrase(sourceKeyword);
  zhDoc.metadata.focusKeyphrase = zhKeyphrase;

  async function strictComponentRepair(
    protectedHtml: string,
    failureReason: string,
    componentId: string,
    keyphrase?: string,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${TRANSLATION_SYSTEM}

${translationDateInstruction()}

${buildTranslationGlossaryPrompt()}

This is a targeted recovery pass. The previous candidate failed validation. Return the COMPLETE component, not a summary or fragment. Preserve the exact WordPress block count and order, every paragraph/list/table cell, inline emphasis/link position, href URL, __NUM_N__ token, proper noun and factual meaning.`,
      },
      {
        role: "user",
        content: `Validation failure: ${failureReason}
${keyphrase ? `Chinese SEO keyphrase: ${keyphrase}
` : ""}
AUTHORITATIVE PROTECTED ENGLISH COMPONENT:
${protectedHtml}

Return only complete Hong Kong Traditional Chinese WordPress HTML.`,
      },
    ];
    const response = await chatWithBudget(
      messages,
      { maxTokens: 8192, temperature: 0.2, maxRetries: 1 },
      `${componentId}-strict-repair`,
      budget,
    );
    if (response.finishReason === "length") throw new Error(`${componentId} strict repair was truncated`);
    return response.content.trim();
  }

  async function repairChineseComponent(
    source: ArticleComponent,
    current: ArticleComponent,
    componentId: string,
    componentKind: "introduction" | "section" | "conclusion",
    contextLabel: string,
    failureId: string,
  ): Promise<ArticleComponent> {
    // Compute issues from the deterministically normalized current draft so
    // fixable terminology/register is never sent back for AI repair.
    const normalizedCurrentBlocks = cloneEditorialBlocks(current.blocks);
    normalizeEditorialBlocks(normalizedCurrentBlocks, (text) => normalizeChineseEditorialText(text));
    const normalizedCurrent: ArticleComponent = { ...current, blocks: normalizedCurrentBlocks };
    const currentHtml = renderComponentHtml(normalizedCurrent);
    const issues = [
      ...chineseEditorialIssues(currentHtml),
      ...chineseComponentParityIssues(source, normalizedCurrent, research),
    ];
    if (issues.length === 0 && !failedComponents.has(failureId)) return normalizedCurrent;
    const repairIssues = issues.length > 0 ? issues : ["previous structure, completeness, number or URL validation failed"];
    console.log(`[translation-editorial:${componentId}] targeted issues=${repairIssues.join(", ")}`);
    const repaired = await translateEditorialBlocksFn({
      blocks: source.blocks,
      componentId,
      componentKind,
      ...structuredFallbackCallbacks,
      translateProtectedHtml: async (protectedSourceHtml) => {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: `You are the dedicated Hong Kong Traditional Chinese editorial repair pass. Return only the complete corrected WordPress HTML for the supplied component. Use the English source as the authority and the current Chinese version as an editable draft. Preserve every WordPress block, block type, URL, number token, named source, proper noun and factual meaning exactly. Do not add or remove ideas. Repair literal English sentence structure, English leakage, half-width punctuation, robotic transitions, repetition, grammar and unnatural Hong Kong wording.

${translationDateInstruction()}

${buildTranslationGlossaryPrompt()}`,
          },
          {
            role: "user",
            content: `Component: ${contextLabel}\nDetected issues: ${repairIssues.join("; ")}\n\nAUTHORITATIVE ENGLISH SOURCE:\n${protectedSourceHtml}\n\nCURRENT CHINESE DRAFT:\n${currentHtml}\n\nReturn only the repaired Chinese WordPress HTML.`,
          },
        ];
        const response = await chatWithBudget(
          messages,
          { maxTokens: 8192, temperature: 0.2 },
          `${componentId}-editorial-repair`,
          budget,
        );
        return response.content.trim();
      },
      repairProtectedHtml: async (protectedSourceHtml, error) =>
        strictComponentRepair(protectedSourceHtml, error, `${componentId}-editorial`, zhKeyphrase),
    });
    if (!repaired.passed) {
      markFailure(`${componentId}-editorial`);
      return normalizedCurrent;
    }
    // Normalize the repaired candidate before validation and persistence so a
    // fixable Chinese candidate is accepted instead of being rejected.
    const candidateBlocks = cloneEditorialBlocks(repaired.blocks);
    normalizeEditorialBlocks(candidateBlocks, (text) => normalizeChineseEditorialText(text));
    const candidate: ArticleComponent = {
      ...current,
      blocks: candidateBlocks,
      status: "regenerated",
    };
    const remaining = [
      ...chineseEditorialIssues(renderComponentHtml(candidate)),
      ...chineseComponentParityIssues(source, candidate, research),
    ];
    if (remaining.length > 0) {
      warnings.push(`${componentId} editorial repair left: ${remaining.join(", ")}`);
      markFailure(`${componentId}-editorial`);
      return normalizedCurrent;
    }
    clearFailure(failureId, `${componentId}-editorial`);
    return candidate;
  }

  // ── Introduction ──
  const enIntroHtml = renderComponentHtml(enDoc.introduction);
  if (enIntroHtml) {
    const introResult = await translateEditorialBlocksFn({
      blocks: enDoc.introduction.blocks,
      componentId: "zh-intro",
      componentKind: "introduction",
      ...structuredFallbackCallbacks,
      context: { keyphrase: zhKeyphrase },
      translateProtectedHtml: async (protectedHtml) => {
        let html = await translateSection(
          protectedHtml, "Introduction", "(start)",
          enDoc.sections[0]?.heading || "first section", zhKeyphrase, "introduction", budget,
        );
        if (hasExcessiveEnglish(html) || hasEnglishHeavyProseBlock(html)) {
          console.log("[translate] Introduction excessive English — targeted retry");
          const retryHtml = await translateText(protectedHtml, INTRO_RETRY_STRICT, TITLE_META_SYSTEM, zhKeyphrase, "introduction-retry", budget);
          if (retryHtml && !hasExcessiveEnglish(retryHtml) && !hasEnglishHeavyProseBlock(retryHtml)) { html = retryHtml; }
        }
        return html;
      },
      repairProtectedHtml: async (protectedHtml, error) =>
        strictComponentRepair(protectedHtml, error, "introduction", zhKeyphrase),
      onStatus: (status) => {
        if (status.passed) clearFailure("introduction"); else markFailure("introduction");
        metrics.push({ component: "introduction", ...status.metrics, passed: status.passed ? 1 : 0 } as any);
      },
    });
    zhDoc.introduction = {
      id: "zh-intro",
      blocks: introResult.blocks,
      status: introResult.passed ? "generated" : "regenerated",
    };
  }

  // ── Sections ──
  // Body and heading translation are deliberately independent. A malformed
  // JSON wrapper must never destroy a valid body translation or leave an FAQ
  // heading untranslated simply because that section has no body blocks.
  for (let i = 0; i < enDoc.sections.length; i++) {
    const section = enDoc.sections[i];
    const prev = i > 0 ? enDoc.sections[i - 1].heading : "Introduction";
    const next = i < enDoc.sections.length - 1 ? enDoc.sections[i + 1].heading : "Conclusion";
    let translatedHeading = "";
    let headingPassed = !section.heading.trim();
    let secResult: Awaited<ReturnType<typeof translateEditorialBlocks>> | null = null;
    const sectionHtml = renderComponentHtml(section);

    if (sectionHtml) {
      secResult = await translateEditorialBlocksFn({
        blocks: section.blocks,
        componentId: `zh-section-${i}`,
        componentKind: "section",
        ...structuredFallbackCallbacks,
        context: { keyphrase: zhKeyphrase, heading: section.heading, prev, next },
        translateProtectedHtml: async (protectedHtml) => translateSection(
          protectedHtml,
          section.heading,
          prev,
          next,
          zhKeyphrase || undefined,
          `section-${i}`,
          budget,
        ),
        repairProtectedHtml: async (protectedHtml, error) =>
          strictComponentRepair(protectedHtml, error, `section-${i}`, zhKeyphrase || undefined),
        onStatus: (status) => {
          if (status.passed) clearFailure(`section-${i}`); else markFailure(`section-${i}`);
          metrics.push({ component: `section-${i}`, ...status.metrics, passed: status.passed ? 1 : 0 } as any);
        },
      });
      if (!secResult.passed && section.blocks.length > 0) {
        // Keep the source shape for diagnostics only. Final validation remains
        // fail-closed and the route will never persist this English fallback.
        secResult.blocks = section.blocks;
      }
    }

    if (section.heading.trim() && /[\u3400-\u9fff]/u.test(section.heading) && !hasExcessiveEnglish(section.heading)) {
      translatedHeading = section.heading;
      headingPassed = true;
      clearFailure(`section-${i}-heading`);
    } else if (section.heading.trim()) {
      const protectedHeading = protectNumbersInHtml(section.heading);
      const firstHeading = await safeText(
        protectedHeading.protectedHtml,
        "Translate this H2 heading faithfully to concise, natural Hong Kong Traditional Chinese. Preserve every number, date and brand exactly. Return only the heading.",
        TITLE_META_SYSTEM,
        `translate-heading-${i}`,
        zhKeyphrase || undefined,
      );
      let restoredHeading = protectedHeading.placeholders.length > 0
        ? tryRestoreNumbersInHtml(firstHeading, protectedHeading.placeholders, protectedHeading.originalValues)
        : { ok: Boolean(firstHeading), html: firstHeading };

      const headingIsValid = (candidate: string): string | null => {
        if (!candidate.trim()) return null;
        // Normalize first so deterministically-fixable terminology/register is
        // never rejected by the terminology gate, then validate the normalized
        // heading and return it for storage.
        const normalized = normalizeChineseEditorialText(candidate.trim());
        if (!/[\u3400-\u9fff]/u.test(normalized) || hasExcessiveEnglish(normalized)) return null;
        const numbers = checkNumbersPreserved(section.heading, normalized);
        if (numbers.lost.length > 0 || numbers.extras.length > 0) return null;
        if (missingProtectedNames(section.heading, normalized, research).length > 0) return null;
        if (findTerminologyIssues(normalized).length > 0) return null;
        return normalized;
      };

      const acceptHeading = (candidate: string): boolean => {
        const normalized = headingIsValid(candidate);
        if (normalized === null) return false;
        translatedHeading = normalized;
        headingPassed = true;
        clearFailure(`section-${i}-heading`);
        return true;
      };

      if (restoredHeading.ok && acceptHeading(restoredHeading.html)) {
        // accepted
      } else {
        const retryHeading = await safeText(
          protectedHeading.protectedHtml,
          `Quality-gate retry. Translate this heading completely to professional Hong Kong Traditional Chinese. Preserve every __NUM_N__ token and proper noun exactly. Avoid literal English word order. Return only the heading.\n\n${buildTranslationGlossaryPrompt()}`,
          TITLE_META_SYSTEM,
          `translate-heading-${i}-repair`,
          zhKeyphrase || undefined,
        );
        restoredHeading = protectedHeading.placeholders.length > 0
          ? tryRestoreNumbersInHtml(retryHeading, protectedHeading.placeholders, protectedHeading.originalValues)
          : { ok: Boolean(retryHeading), html: retryHeading };
        if (restoredHeading.ok && acceptHeading(restoredHeading.html)) {
          // accepted
        } else {
          warnings.push(`section-${i} heading translation failed parity or language checks`);
          markFailure(`section-${i}-heading`);
          // Keep a usable normalized Chinese heading when the translated source
          // heading is already Chinese; never fall back to the English source.
          translatedHeading = headingIsValid(section.heading) ?? translatedHeading;
        }
      }
    }

    const bodyPassed = section.blocks.length === 0 || secResult?.passed === true;
    zhDoc.sections.push({
      id: `zh-section-${i}`,
      heading: translatedHeading,
      headingLevel: 2,
      sectionType: section.sectionType,
      blocks: section.blocks.length === 0 ? [] : secResult?.passed ? secResult.blocks : section.blocks,
      status: bodyPassed && headingPassed ? "generated" : section.blocks.length > 0 ? "regenerated" : "missing",
    });
  }

  // ── FAQ ──
  // Translate and validate each entry independently. A provider failure in one
  // entry no longer discards the other valid entries or aborts the article.
  const enFaq = extractFaqFromDoc(enDoc);
  const zhFaq: FaqEntry[] = [];
  for (let index = 0; index < enFaq.length; index++) {
    const sourceEntry = enFaq[index];
    try {
      let translatedEntry = await translateFaqEntry(sourceEntry, index, budget);
      let issues = chineseEditorialIssues(faqEditorialSurface(translatedEntry));
      const sourceText = `${sourceEntry.question} ${sourceEntry.answerText}`;
      let completeness = checkCompleteness(
        sourceText,
        `${translatedEntry.question} ${translatedEntry.answerText}`,
        `faq-${index + 1}`,
      );

      if (!completeness.passed || issues.length > 0) {
        try {
          const retryEntry = await translateFaqEntry(sourceEntry, index, budget);
          const retryIssues = chineseEditorialIssues(faqEditorialSurface(retryEntry));
          const retryCompleteness = checkCompleteness(
            sourceText,
            `${retryEntry.question} ${retryEntry.answerText}`,
            `faq-${index + 1}-editorial-retry`,
          );
          if (retryCompleteness.passed && retryIssues.length === 0) {
            translatedEntry = retryEntry;
            issues = [];
            completeness = retryCompleteness;
          }
        } catch {
          // Keep the first candidate for final fail-closed diagnostics.
        }
      }

      if (completeness.passed && issues.length === 0) {
        clearFailure(`faq-${index + 1}`);
        zhFaq.push(translatedEntry);
      } else {
        warnings.push(`FAQ ${index + 1} failed completeness or Chinese editorial checks: ${issues.join(", ") || "incomplete"}`);
        markFailure(`faq-${index + 1}`);
        zhFaq.push(sourceEntry);
      }
    } catch (error) {
      warnings.push(`FAQ ${index + 1} translation failed: ${error instanceof Error ? error.message : String(error)}`);
      markFailure(`faq-${index + 1}`);
      // Source content is retained only to preserve canonical count and order
      // for diagnostics. Final validation prevents it from being persisted.
      zhFaq.push(sourceEntry);
    }
  }
  zhDoc.visibleFaq = zhFaq;

  // ── Conclusion ──
  const enConcHtml = renderComponentHtml(enDoc.conclusion);
  if (enConcHtml) {
    const prevHeading = enDoc.sections.length > 0 ? enDoc.sections[enDoc.sections.length - 1].heading : "FAQ";
    // Protect conclusion blocks once — shared between HTML and shadow paths
    const { blocks: concProtectedBlocks, state: concProtectionState } = protectNumbersInEditorialBlocks(enDoc.conclusion.blocks);
    const concResult = await translateEditorialBlocksFn({
      blocks: enDoc.conclusion.blocks,
      componentId: "zh-conc",
      componentKind: "conclusion",
      ...structuredFallbackCallbacks,
      translateProtectedHtml: async (protectedHtml) => {
        return await translateSection(protectedHtml, "Conclusion", prevHeading, "(end)", undefined, "conclusion", budget);
      },
      repairProtectedHtml: async (protectedHtml, error) =>
        strictComponentRepair(protectedHtml, error, "conclusion"),
      onStatus: (status) => {
        if (status.passed) clearFailure("conclusion"); else markFailure("conclusion");
        metrics.push({ component: "conclusion", ...status.metrics, passed: status.passed ? 1 : 0 } as any);
      },
    });
    zhDoc.conclusion = {
      id: "zh-conc",
      blocks: concResult.blocks,
      status: concResult.passed ? "generated" : "regenerated",
    };

    // Structured translation shadow (conclusion only, diagnostic)
    const shadowResult: StructuredTranslationShadowResult = await runConclusionStructuredShadow(
      concProtectedBlocks,
      concProtectionState,
      "zh-conc",
      shadowOptions,
    );
    shadowResults.push(shadowResult);

    // Evidence recording (privacy-safe, local only)
    if (shadowResult.attempted && isConclusionShadowEvidenceEnabled()) {
      recordConclusionShadowEvidence(shadowResult, concProtectedBlocks, concProtectionState).catch(() => {
        // Evidence-recording failure must never fail article translation
      });
    }
  }

  // ── zhDoc.visibleFaq is the sole canonical FAQ representation.
  // FAQ section heading and section-type were already assigned during section translation.
  // FAQ section body blocks must not duplicate visibleFaq — renderArticleDocument
  // renders FAQ content exclusively from visibleFaq, not from section blocks. ──

  // ── Dedicated Chinese editorial repair ──
  // Only components with deterministic quality signals are resent. The
  // structured translator validates block shape, URLs and protected numbers
  // before any repaired block can replace the current candidate.
  zhDoc.introduction = await repairChineseComponent(
    enDoc.introduction,
    zhDoc.introduction,
    "zh-intro",
    "introduction",
    "Introduction",
    "introduction",
  );
  for (let index = 0; index < Math.min(enDoc.sections.length, zhDoc.sections.length); index++) {
    const repaired = await repairChineseComponent(
      enDoc.sections[index],
      zhDoc.sections[index],
      `zh-section-${index}`,
      "section",
      enDoc.sections[index].heading,
      `section-${index}`,
    );
    zhDoc.sections[index] = { ...zhDoc.sections[index], blocks: repaired.blocks, status: repaired.status };
  }
  zhDoc.conclusion = await repairChineseComponent(
    enDoc.conclusion,
    zhDoc.conclusion,
    "zh-conc",
    "conclusion",
    "Conclusion",
    "conclusion",
  );

  // ── Final metadata generation ──
  // Metadata is optimized from the completed Chinese draft. Provider failure
  // is non-fatal: each field has one targeted repair and a deterministic,
  // parity-safe fallback. Preferred character ranges remain soft SEO signals.
  const translatedContext = visibleChineseDraft([
    renderComponentHtml(zhDoc.introduction),
    ...zhDoc.sections.flatMap((section) => [section.heading, renderComponentHtml(section)]),
    renderComponentHtml(zhDoc.conclusion),
    ...zhDoc.visibleFaq.flatMap((entry) => [entry.question, entry.answerHtml || entry.answerText]),
  ].join("\n")).slice(0, 12000);

  zhKeyphrase = isChineseKeyphrase(zhKeyphrase)
    ? zhKeyphrase
    : deriveChineseKeyphrase(sourceKeyword, zhDoc.sections[0]?.heading || "");
  zhDoc.metadata.focusKeyphrase = zhKeyphrase;

  let metadataProviderUnavailable = false;
  try {
    const metadataMessages: ChatMessage[] = [
      {
        role: "system",
        content: `You are a senior Hong Kong Traditional Chinese SEO editor. Using the completed Chinese article draft, return ONLY valid JSON with exactly these keys: {"title":"...","metaDescription":"...","excerpt":"..."}. Translate the English metadata faithfully; do not add facts. Preserve every number, date, brand and proper noun exactly. Include the exact Chinese focus keyphrase "${zhKeyphrase}" naturally in the title. Target 25-35 characters for the title and 80-120 characters for the meta description, but never distort meaning to hit a range.\n\n${translationDateInstruction()}\n\n${buildTranslationGlossaryPrompt()}`,
      },
      {
        role: "user",
        content: `ENGLISH TITLE:\n${enDoc.metadata.title}\n\nENGLISH META DESCRIPTION:\n${enDoc.metadata.metaDescription}\n\nENGLISH EXCERPT:\n${enDoc.metadata.excerpt}\n\nCOMPLETED CHINESE ARTICLE DRAFT:\n${translatedContext}`,
      },
    ];
    const response = await chatWithBudget(
      metadataMessages,
      { responseFormat: { type: "json_object" }, maxTokens: 2048, temperature: 0.2, maxRetries: 1 },
      "metadata-final",
      budget,
    );
    const parsed = JSON.parse(response.content.replace(/```json\s*/gi, "").replace(/```/g, "").trim());
    const candidates = {
      title: String(parsed.title || "").trim(),
      metaDescription: String(parsed.metaDescription || "").trim(),
      excerpt: String(parsed.excerpt || "").trim(),
    };
    if (isChineseMetadataCandidate(enDoc.metadata.title, candidates.title, research)) {
      zhDoc.metadata.title = candidates.title;
    }
    if (isChineseMetadataCandidate(enDoc.metadata.metaDescription, candidates.metaDescription, research)) {
      zhDoc.metadata.metaDescription = candidates.metaDescription;
    }
    if ((!enDoc.metadata.excerpt || isChineseMetadataCandidate(enDoc.metadata.excerpt, candidates.excerpt, research))
        && /[\u3400-\u9fff]/u.test(candidates.excerpt)
        && !hasExcessiveEnglish(candidates.excerpt)) {
      zhDoc.metadata.excerpt = candidates.excerpt;
    }
  } catch (error) {
    metadataProviderUnavailable = true;
    warnings.push("Final metadata provider response unavailable; deterministic metadata fallback used");
    console.warn(`[translate] final metadata generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  async function finaliseMetadataField(
    source: string,
    current: string,
    label: "title" | "meta-description" | "excerpt",
  ): Promise<{ text: string; passed: boolean }> {
    let candidate = current.trim();
    if (!source.trim() && !candidate) return { text: "", passed: true };
    if (label === "title" && candidate) candidate = ensureKeyphraseInTitle(candidate, zhKeyphrase);
    if (isChineseMetadataCandidate(source, candidate, research)) return { text: candidate, passed: true };

    if (source.trim() && !metadataProviderUnavailable) {
      const repaired = await repairMetadataParity(source, candidate, label, label === "title" ? zhKeyphrase : "");
      candidate = repaired.text.trim();
      if (label === "title" && candidate) candidate = ensureKeyphraseInTitle(candidate, zhKeyphrase);
      if (isChineseMetadataCandidate(source, candidate, research)) return { text: candidate, passed: true };
    }

    candidate = deterministicMetadataFallback(source, translatedContext, research, label, zhKeyphrase);
    if (label === "title") candidate = ensureKeyphraseInTitle(candidate, zhKeyphrase);
    return { text: candidate, passed: isChineseMetadataCandidate(source, candidate, research) };
  }

  const finalTitle = await finaliseMetadataField(enDoc.metadata.title, zhDoc.metadata.title, "title");
  const finalMeta = await finaliseMetadataField(enDoc.metadata.metaDescription, zhDoc.metadata.metaDescription, "meta-description");
  const finalExcerpt = await finaliseMetadataField(enDoc.metadata.excerpt, zhDoc.metadata.excerpt, "excerpt");
  zhDoc.metadata.title = finalTitle.text;
  zhDoc.metadata.metaDescription = finalMeta.text;
  zhDoc.metadata.excerpt = finalExcerpt.text;

  for (const [label, result] of [
    ["title", finalTitle],
    ["meta-description", finalMeta],
    ["excerpt", finalExcerpt],
  ] as const) {
    if (!result.passed) markFailure(`metadata-${label}`); else clearFailure(`metadata-${label}`);
  }
  if (!zhDoc.metadata.title.includes(zhKeyphrase)) markFailure("metadata-keyphrase-title"); else clearFailure("metadata-keyphrase-title");
  if (zhDoc.metadata.title.length < 25 || zhDoc.metadata.title.length > 35) {
    warnings.push(`Chinese title ${zhDoc.metadata.title.length} characters outside preferred 25-35 range`);
  }

  // ── CTA ──
  const switcherHtml = renderLanguageSwitcher({
    currentLanguage: "zh",
    englishSlug: slugs.englishSlug,
    chineseSlug: slugs.chineseSlug,
  });
  zhDoc.languageSwitcher = {
    id: "zh-language-switcher",
    type: "language-switcher",
    html: switcherHtml,
    fingerprint: fingerprintHtml(switcherHtml),
  };
  if (enDoc.cta) {
    zhDoc.cta = await translateCtaBlock(enDoc.cta, budget);
    const ctaText = zhDoc.cta?.html?.replace(/<[^>]+>/g, "").trim() || "";
    if (!ctaText || !/[\u4e00-\u9fff]/.test(ctaText)) { console.warn("[translate] CTA remained substantially English"); markFailure("cta"); } else { clearFailure("cta"); }
  }

  // ── Deterministic Chinese editorial-quality normalization ──
  // Runs before the FAQ schema is built so the schema reflects normalized text.
  const normalization = normalizeZhDocumentEditorialQuality(zhDoc, zhKeyphrase, zhFaq);
  if (normalization.changes > 0) {
    console.log(`[translate] deterministic zh editorial normalization applied ${normalization.changes} changes`);
  }
  if ([...zhDoc.metadata.metaDescription].length < 80 || [...zhDoc.metadata.metaDescription].length > 120) {
    warnings.push(`Chinese meta description ${[...zhDoc.metadata.metaDescription].length} characters outside preferred 80-120 range`);
  }

  // ── FAQ schema ──
  const targetFaqCount = translationFaqCount(enFaq.length);
  if (zhFaq.length !== targetFaqCount) { console.warn(`[translate] FAQ count ${zhFaq.length} !== source ${targetFaqCount}`); markFailure("faq-count"); } else { clearFailure("faq-count"); }
  if (zhFaq.length === targetFaqCount) {
    const schemaJson = buildFaqSchemaJson(zhFaq);
    const schemaHtml = `<!-- wp:html -->\n<script type="application/ld+json">\n${schemaJson}\n</script>\n<!-- /wp:html -->`;
    zhDoc.faqSchema = { id: "zh-faq-schema", type: "faq-schema", html: schemaHtml, fingerprint: fingerprintHtml(schemaHtml) };
    zhDoc.visibleFaq = zhFaq;
  }

  // ── Final canonical translation validation ──
  // Editorial URLs are immutable. Only the application-owned language
  // switcher points to the paired English slug. The returned HTML is always a
  // fresh render of the returned ArticleDocument — never a regex-mutated copy.
  const validationErrors = validateTranslatedDocument(enDoc, zhDoc, research);
  for (const error of validationErrors) {
    warnings.push(error);
    markFailure(`validation:${error}`);
  }
  const html = renderArticleDocument(zhDoc);
  const sourceEditorialHtml = [
    renderComponentHtml(enDoc.introduction),
    ...enDoc.sections.map((section) => renderComponentHtml(section)),
    renderComponentHtml(enDoc.conclusion),
    ...enDoc.visibleFaq.map((entry) => entry.answerHtml || entry.answerText),
  ].join("\n");
  const sourceDecisions = extractLinks(sourceEditorialHtml)
    .filter((url) => /^https?:\/\//i.test(url) && !/b2ihub\.com/i.test(url))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .map((url) => ({
      originalUrl: url,
      finalUrl: url,
      decision: "preserved" as const,
      reason: "Translation preserves source URLs exactly",
      matchScore: 10,
    }));
  const internalLinkDecisions = extractLinks(sourceEditorialHtml)
    .filter((url) => url.startsWith("/blog/"))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .map((url) => ({
      originalUrl: url,
      finalUrl: url,
      decision: "preserved" as const,
      reason: "Editorial internal URLs are preserved exactly",
      matchScore: 10,
    }));
  const lengthMetrics = chineseLengthMetrics(html);

  console.log(`[translate] API calls=${budget.apiCallCount} retries=${MAX_RETRY_BUDGET - budget.remaining}/${MAX_RETRY_BUDGET} exhausted=${budget.exhausted}`);

  // Disabled-by-default coherent-chunk translation shadow (diagnostic only).
  // Runs sequentially AFTER production translation, validation and assembly have
  // completed, so it never adds concurrent provider load. It never mutates enDoc
  // or zhDoc, never affects production values, and never contributes to
  // failedComponents or the save path. A shadow failure is caught and logged,
  // never failing the production translation.
  if (isDocumentContextTranslationShadowEnabled()) {
    try {
      await runDocumentContextTranslationShadow(enDoc, {
        projectId: deps?.projectId,
        outputDir: deps?.shadowPreviewDir,
        brandVoice: deps?.brandVoice,
      });
    } catch (error) {
      console.warn(`[document-context-shadow] shadow failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    doc: zhDoc,
    html,
    title: zhDoc.metadata.title,
    metaDescription: zhDoc.metadata.metaDescription,
    metrics, failedComponents: [...failedComponents], warnings: [...new Set(warnings)], sourceDecisions,
    internalLinkDecisions,
    structuredShadowResult: shadowResults.length > 0 ? shadowResults[shadowResults.length - 1] : undefined,
    ...lengthMetrics,
  };
}
