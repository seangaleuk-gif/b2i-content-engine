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
import { TITLE_META_SYSTEM, TRANSLATION_SYSTEM, INTRO_RETRY_STRICT, chatWithBudget, translateText, translateSection, translateCtaBlock, translateFaqEntry, createProductionConclusionStructuredShadowOptions, translationDateInstruction } from "./translation-ai";
import { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNumbersPreserved, extractVisibleNumbers, extractLinks, hasExcessiveEnglish, chineseLengthMetrics } from "./translation-validator";
import { protectNumbersInEditorialBlocks } from "./editorial-block-protection";
import { isConclusionShadowEvidenceEnabled, recordConclusionShadowEvidence } from "./conclusion-shadow-evidence";
import { buildFaqSchemaJson, extractFaqFromDoc } from "./translation-assembler";
import { pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { buildTranslationGlossaryPrompt, deriveChineseKeyphrase, findTerminologyIssues } from "./translation-glossary";
import { scanTemporalFreshness } from "@/lib/blog/temporal-freshness";

export type { TranslationMetrics, TranslationResult, SourceDecision, InternalLinkDecision, ResearchItem } from "./translation-types";
export { RetryBudget } from "./translation-types";
export { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNoNewUrls, checkNumbersPreserved, extractVisibleNumbers, normalizeNumber, extractScaledNumbers, visibleChars, extractLinks, hasExcessiveEnglish, countCjkChars, countLatinWords, countParagraphs, estimatedReadingTime, chineseLengthMetrics } from "./translation-validator";
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

function protectedNamedEntities(
  sourceHtml: string,
  research: Array<Pick<ResearchItem, "url" | "title">>,
): string[] {
  const sourceText = sourceHtml.replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  const candidates = new Set(ALWAYS_PRESERVED_NAMES);
  const genericTitleNames = new Set(["Hong Kong", "The", "How", "Why", "What", "Guide", "Report", "Study"]);
  for (const item of research) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./i, "");
      const base = host.split(".")[0] || "";
      const words = base.split(/[-_]+/).filter(Boolean);
      if (words.length > 0) {
        candidates.add(words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "));
        candidates.add(words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("-"));
        candidates.add(words.join(""));
      }
    } catch {
      // Invalid research URLs are ignored here and handled by source validation.
    }
    for (const match of item.title.matchAll(/\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3}\b/g)) {
      const name = match[0].trim();
      if (name.length >= 3 && !genericTitleNames.has(name)) candidates.add(name);
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
  const text = html.replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  if (hasExcessiveEnglish(text)) issues.push("excessive English prose");
  if (/[A-Za-z]{3}/u.test(text) && !/[\u3400-\u9fff]/u.test(text)) issues.push("insufficient Chinese");

  const proseBlocks = [...html.matchAll(/<(?:p|li|h3|td|th)\b[^>]*>([\s\S]*?)<\/(?:p|li|h3|td|th)>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (proseBlocks.some((block) => hasExcessiveEnglish(block))) {
    issues.push("English-heavy prose block");
  }
  if (/[\u3400-\u9fff][,;!?][\u3400-\u9fff]/u.test(text)) {
    issues.push("half-width punctuation inside Chinese prose");
  }
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
  const numbers = checkNumbersPreserved(sourceHtml, translatedHtml);
  if (numbers.lost.length > 0 || numbers.extras.length > 0) issues.push("numbers changed");
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

  const componentPairs: Array<[string, string, string]> = [
    ["introduction", renderComponentHtml(enDoc.introduction), renderComponentHtml(zhDoc.introduction)],
    ...enDoc.sections.slice(0, zhDoc.sections.length).map((section, index) => [
      `section-${index}`,
      renderComponentHtml(section),
      renderComponentHtml(zhDoc.sections[index]),
    ] as [string, string, string]),
    ["conclusion", renderComponentHtml(enDoc.conclusion), renderComponentHtml(zhDoc.conclusion)],
  ];
  for (const [label, sourceHtml, translatedHtml] of componentPairs) {
    if (visibleChineseDraft(sourceHtml) && !/[\u3400-\u9fff]/u.test(visibleChineseDraft(translatedHtml))) {
      errors.push(`${label} contains insufficient Chinese`);
    }
    const numbers = checkNumbersPreserved(sourceHtml, translatedHtml);
    if (numbers.lost.length > 0 || numbers.extras.length > 0) errors.push(`${label} numbers changed`);
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

type InternalLinkDecision = import("./translation-types").InternalLinkDecision;
type SourceDecision = import("./translation-types").SourceDecision;

export async function translateArticle(
  enHtml: string,
  sourceDoc: ArticleDocument,
  research: ResearchItem[],
  deps?: {
    translateEditorialBlocks?: typeof translateEditorialBlocks;
    structuredTranslationShadow?: StructuredTranslationShadowOptions;
  },
): Promise<TranslationResult> {
  const translateEditorialBlocksFn = deps?.translateEditorialBlocks ?? translateEditorialBlocks;
  const shadowEnabled = deps?.structuredTranslationShadow?.enabled ?? (process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION === "true");
  const budget = new RetryBudget(MAX_RETRY_BUDGET);
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
    const currentHtml = renderComponentHtml(current);
    const issues = [
      ...chineseEditorialIssues(currentHtml),
      ...chineseComponentParityIssues(source, current, research),
    ];
    if (issues.length === 0 && !failedComponents.has(failureId)) return current;
    const repairIssues = issues.length > 0 ? issues : ["previous structure, completeness, number or URL validation failed"];
    console.log(`[translation-editorial:${componentId}] targeted issues=${repairIssues.join(", ")}`);
    const repaired = await translateEditorialBlocksFn({
      blocks: source.blocks,
      componentId,
      componentKind,
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
      return current;
    }
    const candidate: ArticleComponent = {
      ...current,
      blocks: repaired.blocks,
      status: "regenerated",
    };
    const remaining = [
      ...chineseEditorialIssues(renderComponentHtml(candidate)),
      ...chineseComponentParityIssues(source, candidate, research),
    ];
    if (remaining.length > 0) {
      warnings.push(`${componentId} editorial repair left: ${remaining.join(", ")}`);
      markFailure(`${componentId}-editorial`);
      return current;
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
      context: { keyphrase: zhKeyphrase },
      translateProtectedHtml: async (protectedHtml) => {
        let html = await translateSection(
          protectedHtml, "Introduction", "(start)",
          enDoc.sections[0]?.heading || "first section", zhKeyphrase, "introduction", budget,
        );
        if (hasExcessiveEnglish(html)) {
          console.log("[translate] Introduction excessive English — targeted retry");
          const retryHtml = await translateText(protectedHtml, INTRO_RETRY_STRICT, TITLE_META_SYSTEM, zhKeyphrase, "introduction-retry", budget);
          if (retryHtml && !hasExcessiveEnglish(retryHtml)) { html = retryHtml; }
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
        `heading-${i}`,
        zhKeyphrase || undefined,
      );
      let restoredHeading = protectedHeading.placeholders.length > 0
        ? tryRestoreNumbersInHtml(firstHeading, protectedHeading.placeholders, protectedHeading.originalValues)
        : { ok: Boolean(firstHeading), html: firstHeading };

      const headingIsValid = (candidate: string): boolean => {
        if (!candidate.trim() || !/[\u3400-\u9fff]/u.test(candidate) || hasExcessiveEnglish(candidate)) return false;
        const numbers = checkNumbersPreserved(section.heading, candidate);
        if (numbers.lost.length > 0 || numbers.extras.length > 0) return false;
        if (missingProtectedNames(section.heading, candidate, research).length > 0) return false;
        return findTerminologyIssues(candidate).length === 0;
      };

      if (restoredHeading.ok && headingIsValid(restoredHeading.html)) {
        translatedHeading = restoredHeading.html.trim();
        headingPassed = true;
        clearFailure(`section-${i}-heading`);
      } else {
        const retryHeading = await safeText(
          protectedHeading.protectedHtml,
          `Quality-gate retry. Translate this heading completely to professional Hong Kong Traditional Chinese. Preserve every __NUM_N__ token and proper noun exactly. Avoid literal English word order. Return only the heading.\n\n${buildTranslationGlossaryPrompt()}`,
          TITLE_META_SYSTEM,
          `heading-${i}-repair`,
          zhKeyphrase || undefined,
        );
        restoredHeading = protectedHeading.placeholders.length > 0
          ? tryRestoreNumbersInHtml(retryHeading, protectedHeading.placeholders, protectedHeading.originalValues)
          : { ok: Boolean(retryHeading), html: retryHeading };
        if (restoredHeading.ok && headingIsValid(restoredHeading.html)) {
          translatedHeading = restoredHeading.html.trim();
          headingPassed = true;
          clearFailure(`section-${i}-heading`);
        } else {
          warnings.push(`section-${i} heading translation failed parity or language checks`);
          markFailure(`section-${i}-heading`);
          translatedHeading = section.heading;
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
  if (zhDoc.metadata.metaDescription.length < 80 || zhDoc.metadata.metaDescription.length > 120) {
    warnings.push(`Chinese meta description ${zhDoc.metadata.metaDescription.length} characters outside preferred 80-120 range`);
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
