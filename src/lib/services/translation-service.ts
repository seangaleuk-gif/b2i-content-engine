import { AiService, type ChatMessage } from "@/lib/services/deepseek";
import { rebalanceWpBlocks, ensureKeyphraseInTitle } from "@/lib/services/text-utils";
import { translationFaqCount } from "@/lib/content-standards";
import {
  type ArticleDocument, type ArticleSection, type FaqEntry,
  type ProtectedArticleBlock, type ArticleComponent,
  renderArticleDocument, parseArticleDocumentFromHtml, fingerprintHtml,
  renderComponentHtml,
} from "@/lib/blog/article-document";
import { translateEditorialBlocks, type StructuredTranslationShadowOptions, type StructuredTranslationShadowResult, runConclusionStructuredShadow } from "./editorial-block-translation";
import type { TranslationMetrics, TranslationResult, ResearchItem } from "./translation-types";
import { RetryBudget } from "./translation-types";
import { TITLE_META_SYSTEM, TRANSLATION_SYSTEM, INTRO_RETRY_STRICT, STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM, chatWithBudget, translateText, translateSection, translateCtaBlock, translateFaqEntries, buildStructuredConclusionTranslationPrompt, buildStructuredConclusionRepairPrompt, createProductionConclusionStructuredShadowOptions } from "./translation-ai";
import { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNumbersPreserved, extractVisibleNumbers, hasExcessiveEnglish, chineseLengthMetrics } from "./translation-validator";
import { protectNumbersInEditorialBlocks } from "./editorial-block-protection";
import { renderEditorialBlocksToWordPress } from "@/lib/blog/article-content";
import { isConclusionShadowEvidenceEnabled, recordConclusionShadowEvidence } from "./conclusion-shadow-evidence";
import { buildFaqSchemaJson, extractFaqFromDoc, localiseSources, localiseInternalLinks, applyLocalisations } from "./translation-assembler";

export type { TranslationMetrics, TranslationResult, SourceDecision, InternalLinkDecision, ResearchItem } from "./translation-types";
export { RetryBudget } from "./translation-types";
export { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNoNewUrls, checkNumbersPreserved, extractVisibleNumbers, normalizeNumber, extractScaledNumbers, visibleChars, extractLinks, hasExcessiveEnglish, countCjkChars, countLatinWords, countParagraphs, estimatedReadingTime, chineseLengthMetrics } from "./translation-validator";
export { localiseSources, applySourceDecisions, localiseInternalLinks } from "./translation-assembler";
export { chatWithBudget, translateText, translateSection } from "./translation-ai";

const MAX_RETRIES = 0;
const MAX_RETRY_BUDGET = 12;

async function translateWithRetry(
  translateFn: () => Promise<string>,
  source: string,
  component: string,
  sourceForNumbers?: string,
): Promise<{ translated: string; passed: boolean; metrics: TranslationMetrics }> {
  let translated = "";
  const metrics: TranslationMetrics = {
    component, sourceChars: 0, translatedChars: 0, ratio: 0, passed: false,
    sourceNumbers: 0, translatedNumbers: 0, numbersMatch: true,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    translated = await translateFn();
    const check = checkCompleteness(source, translated, component);
    Object.assign(metrics, check);
    if (!check.passed) {
      if (attempt < MAX_RETRIES) continue;
      return { translated: translated || source, passed: false, metrics };
    }
    const lostLinks = checkLinksPreserved(source, translated);
    if (lostLinks.length > 0) {
      if (attempt < MAX_RETRIES) {
        const lostMsg = lostLinks.map((l) => `  ${l}`).join("\n");
        translated = await translateText(source, `RETRY: You did not preserve all links. These links were lost:\n${lostMsg}`, TRANSLATION_SYSTEM);
        continue;
      }
      return { translated, passed: false, metrics };
    }
    const numSrc = sourceForNumbers || source;
    const numCheck = checkNumbersPreserved(numSrc, translated);
    metrics.sourceNumbers = extractVisibleNumbers(numSrc).length;
    metrics.translatedNumbers = extractVisibleNumbers(translated).length;
    metrics.numbersMatch = numCheck.lost.length === 0;
    if (!metrics.numbersMatch && attempt < MAX_RETRIES) {
      const lostMsg = numCheck.lost.length > 0 ? `Missing numbers: ${numCheck.lost.join(", ")}` : `Unexpected numbers: ${numCheck.extras.join(", ")}`;
      translated = await translateText(numSrc, `RETRY: Number mismatch. ${lostMsg}. Preserve ALL numbers, percentages, dates, and prices exactly.`, TRANSLATION_SYSTEM);
      continue;
    }
    if (!metrics.numbersMatch) { metrics.passed = false; return { translated, passed: false, metrics }; }
    return { translated, passed: true, metrics };
  }
  return { translated: translated || source, passed: false, metrics };
}

type InternalLinkDecision = import("./translation-types").InternalLinkDecision;
type SourceDecision = import("./translation-types").SourceDecision;

export async function translateArticle(
  enHtml: string,
  sourceDoc: ArticleDocument,
  research: any[],
  zhSlugs: Set<string>,
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
  const failedComponents: string[] = [];
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

  const zhDoc: ArticleDocument = {
    metadata: { ...enDoc.metadata, title: "", metaDescription: "" },
    languageSwitcher: null,
    introduction: { id: "zh-intro", blocks: [], status: "generated" },
    sections: [], visibleFaq: [],
    conclusion: { id: "zh-conc", blocks: [], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: enDoc.insertedLinks,
  };

  // ── Metadata ──
  let zhKeyphrase = "";
  if (enDoc.metadata.metaDescription) {
    const sourceKeyword = enDoc.metadata.focusKeyphrase || "";
      const introPadding = renderComponentHtml(enDoc.introduction) || "";
    const combinedUserMsg = introPadding
      ? `Meta description: ${enDoc.metadata.metaDescription}\nFocus keyphrase: ${sourceKeyword}\n\n(Additional content to translate for context — do NOT include in returned JSON):\n\n${introPadding}`
      : `Meta description: ${enDoc.metadata.metaDescription}\nFocus keyphrase: ${sourceKeyword}`;

    let combinedResult: { metaDescription: string; zhKeyphrase: string } | null = null;
    const messages: ChatMessage[] = [
      { role: "system", content: `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK). Translate the provided text and focus keyphrase to Traditional Chinese. Return ONLY a JSON object with these exact keys: { "metaDescription": "translated meta description (80-120 Chinese characters, includes CTA)", "zhKeyphrase": "the English focus keyphrase translated into Hong Kong Traditional Chinese (2-12 Chinese characters only — NO English words, NO Latin characters)" }. Rules: Hong Kong Traditional Chinese only, full-width punctuation, natural phrasing. zhKeyphrase must contain ONLY Chinese characters. Return ONLY valid JSON, no explanation, no markdown.` },
      { role: "user", content: combinedUserMsg },
    ];

    try {
      const res = await chatWithBudget(messages, { maxTokens: 2048, temperature: 0.3, responseFormat: { type: "json_object" } }, "metadata-json", budget);
      const parsed = JSON.parse(res.content);
      const zhKp = (parsed.zhKeyphrase || "").trim();
      const cjkKp = zhKp.replace(/[a-zA-Z\s]+/g, "").trim();
      if (parsed.metaDescription && cjkKp && /[\u4e00-\u9fff]/.test(cjkKp)) {
        combinedResult = { metaDescription: parsed.metaDescription, zhKeyphrase: cjkKp };
      }
    } catch { /* fall through */ }

    if (!combinedResult) {
      console.log("[metadata] Structured JSON mode failed — retrying without response_format");
      try {
        const res = await chatWithBudget(
          [...messages, { role: "user", content: "Return ONLY valid JSON. No markdown, no code fences, no explanation." }],
          { maxTokens: 2048, temperature: 0.3 }, "metadata-plain", budget
        );
        const jsonStr = res.content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(jsonStr);
        const zhKp = (parsed.zhKeyphrase || "").trim();
        const cjkKp = zhKp.replace(/[a-zA-Z\s]+/g, "").trim();
        if (parsed.metaDescription && cjkKp && /[\u4e00-\u9fff]/.test(cjkKp)) {
          combinedResult = { metaDescription: parsed.metaDescription, zhKeyphrase: cjkKp };
        }
      } catch { /* fall through */ }
    }

    if (combinedResult) {
      zhDoc.metadata.metaDescription = combinedResult.metaDescription;
      zhKeyphrase = combinedResult.zhKeyphrase;
    } else {
      const { protectedHtml: protectedMeta, placeholders: metaPhs, originalValues: metaVals } = protectNumbersInHtml(enDoc.metadata.metaDescription);
      const metaTr = await translateWithRetry(
        () => translateText(protectedMeta, "Translate this meta description to Traditional Chinese:", TITLE_META_SYSTEM, undefined, "meta-fallback", budget),
        protectedMeta, "meta-description", protectedMeta,
      );
      let metaPassed = metaTr.passed;
      let metaTranslated = metaTr.translated;
      if (metaPassed && metaPhs.length > 0) {
        const restored = tryRestoreNumbersInHtml(metaTranslated, metaPhs, metaVals);
        if (!restored.ok) { console.warn(`[translate] Meta-description number loss: lost=${restored.lost.join(",")}`); metaPassed = false; }
        else { metaTranslated = restored.html; }
      }
      zhDoc.metadata.metaDescription = metaPassed ? metaTranslated : enDoc.metadata.metaDescription;
      metrics.push({ ...metaTr.metrics, passed: metaPassed, numbersMatch: metaPassed });
      if (!metaPassed) failedComponents.push("meta-description");
      // Metadata range compliance: do NOT pad with filler. Retry once with exact range, then hard-fail.
      const { chineseMetaRange, chineseTitleRange } = await import("@/lib/content-standards");
      const { min: metaMin, max: metaMax } = chineseMetaRange();
      let m = zhDoc.metadata.metaDescription;
      const cjkMetaCount = (m.match(/[\u4e00-\u9fff]/g) || []).length;
      if (metaPassed && (cjkMetaCount < metaMin || cjkMetaCount > metaMax)) {
        console.log(`[metadata] Meta ${cjkMetaCount} CJK chars outside ${metaMin}-${metaMax} — retry with range`);
        const rangeMeta = await translateText(
          enDoc.metadata.metaDescription,
          `Translate this meta description to Traditional Chinese. Length must be ${metaMin}-${metaMax} CJK characters (characters in the Chinese CJK range, not total length). Return ONLY the translated text.`,
          TITLE_META_SYSTEM, undefined, "meta-range-retry", budget,
        );
        const rangeCjk = (rangeMeta || "").match(/[\u4e00-\u9fff]/g) || [];
        if (rangeCjk.length >= metaMin && rangeCjk.length <= metaMax) {
          zhDoc.metadata.metaDescription = rangeMeta!.trim();
          console.log(`[metadata] Meta range retry succeeded: ${rangeCjk.length} CJK chars`);
        } else {
          // Allow one cleanup pass: trim trailing whitespace/punctuation only
          const cleaned = zhDoc.metadata.metaDescription.replace(/[。，、！？\s]+$/g, "");
          const cleanedCjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
          if (cleanedCjk >= metaMin && cleanedCjk <= metaMax) {
            zhDoc.metadata.metaDescription = cleaned;
          } else {
            console.error(`[metadata] Meta still ${cleanedCjk} CJK chars after retry — hard failure`);
            failedComponents.push("meta-description");
          }
        }
      }

      if (sourceKeyword && !/[\u4e00-\u9fff]/.test(sourceKeyword)) {
        try {
          const kpResult = await translateText(sourceKeyword, "Translate this English SEO keyphrase into natural Hong Kong Traditional Chinese:", TITLE_META_SYSTEM, undefined, "keyphrase-fallback", budget);
          const cleaned = (kpResult || "").replace(/[a-zA-Z\s]+/g, "").trim();
          if (cleaned.length >= 2 && /[\u4e00-\u9fff]/.test(cleaned)) { zhKeyphrase = cleaned; console.log(`[metadata] Fallback keyphrase: "${sourceKeyword}" → "${zhKeyphrase}"`); }
        } catch { console.warn(`[metadata] Fallback keyphrase translation failed for "${sourceKeyword}"`); }
      } else if (sourceKeyword) { zhKeyphrase = sourceKeyword; }
    }
  } else {
    zhDoc.metadata.metaDescription = enDoc.metadata.metaDescription;
  }

  if (enDoc.metadata.title) {
    const tr = await translateWithRetry(
      () => translateText(enDoc.metadata.title, "Translate this blog title to Traditional Chinese:", TITLE_META_SYSTEM, zhKeyphrase, "title", budget),
      enDoc.metadata.title, "title",
    );
    let zhTitle = tr.passed ? tr.translated : enDoc.metadata.title;
    metrics.push(tr.metrics);
    if (!tr.passed) failedComponents.push("title");
    if (zhKeyphrase && /[\u4e00-\u9fff]/.test(zhKeyphrase) && !zhTitle.includes(zhKeyphrase)) {
      zhTitle = ensureKeyphraseInTitle(zhTitle, zhKeyphrase);
      console.log(`[metadata] Keyphrase "${zhKeyphrase}" inserted into title: "${zhTitle}"`);
    }
    // Title range compliance: retry once with exact range, then hard-fail. No filler padding.
    const { chineseTitleRange } = await import("@/lib/content-standards");
    const { min: tMin, max: tMax } = chineseTitleRange();
    const zhTitleCjk = (zhTitle.match(/[\u4e00-\u9fff]/g) || []).length;
    if (tr.passed && (zhTitleCjk < tMin || zhTitleCjk > tMax)) {
      console.log(`[metadata] Title ${zhTitleCjk} CJK chars outside ${tMin}-${tMax} — retry with range`);
      const rangeTitle = await translateText(
        enDoc.metadata.title,
        `Translate this blog title to Traditional Chinese. Length must be ${tMin}-${tMax} CJK characters. The SEO focus keyphrase is "${zhKeyphrase}". Include it naturally. Return ONLY the translated title.`,
        TITLE_META_SYSTEM, zhKeyphrase, "title-range-retry", budget,
      );
      const rangeCjk = (rangeTitle || "").match(/[\u4e00-\u9fff]/g) || [];
      if (rangeCjk.length >= tMin && rangeCjk.length <= tMax) {
        zhTitle = rangeTitle!.trim();
        console.log(`[metadata] Title range retry succeeded: ${rangeCjk.length} CJK chars`);
      } else {
        // Cleanup pass: trim only trailing whitespace/punctuation
        const cleaned = zhTitle.replace(/[。，、！？\s]+$/g, "");
        const cleanedCjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
        if (cleanedCjk >= tMin && cleanedCjk <= tMax) {
          zhTitle = cleaned;
        } else {
          console.error(`[metadata] Title still ${cleanedCjk} CJK chars after retry — hard failure`);
          failedComponents.push("title");
        }
      }
    }
    if (!failedComponents.includes("title")) {
      // Truncate if overlength (cleanup only, no padding)
      const finalTitleCjk = (zhTitle.match(/[\u4e00-\u9fff]/g) || []).length;
      if (finalTitleCjk > tMax) zhTitle = [...zhTitle].slice(0, tMax).join("");
    }
    zhDoc.metadata.title = zhTitle;
    zhDoc.metadata.focusKeyphrase = zhKeyphrase || enDoc.metadata.focusKeyphrase || "";
  }
  zhKeyphrase = zhDoc.metadata.focusKeyphrase;

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
      repairProtectedHtml: async (protectedHtml, error) => {
        if (error.includes("number")) {
          return await translateText(
            protectedHtml,
            `RETRY: ${error}. Preserve EXACTLY every number, percentage, date, and __NUM_0__ token. Every original value must appear verbatim.`,
            TITLE_META_SYSTEM, zhKeyphrase, "intro-numbers-retry", budget,
          );
        }
        return null;
      },
      onStatus: (status) => {
        if (!status.passed) failedComponents.push("introduction");
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
  for (let i = 0; i < enDoc.sections.length; i++) {
    const section = enDoc.sections[i];
    const prev = i > 0 ? enDoc.sections[i - 1].heading : "Introduction";
    const next = i < enDoc.sections.length - 1 ? enDoc.sections[i + 1].heading : "Conclusion";
    let translatedHeading = section.heading;
    let secResult: Awaited<ReturnType<typeof translateEditorialBlocks>> | null = null;
    const sectionHtml = renderComponentHtml(section);
    if (sectionHtml) {
      secResult = await translateEditorialBlocksFn({
        blocks: section.blocks,
        componentId: `zh-section-${i}`,
        componentKind: "section",
        context: { keyphrase: zhKeyphrase, heading: section.heading, prev, next },
        translateProtectedHtml: async (protectedHtml) => {
          const context = `Heading: "${section.heading}". Previous: "${prev}". Next: "${next}"`;
          const kpMsg = zhKeyphrase ? `\n\nThe SEO focus keyphrase for this article is "${zhKeyphrase}". Use this exact keyphrase naturally.` : "";
          const messages: ChatMessage[] = [
            { role: "system", content: `${TRANSLATION_SYSTEM}${kpMsg}\n\nReturn a JSON object with two keys:\n{\n  "heading": "translated H2 heading",\n  "body": "full translated section HTML"\n}\nRules: Translate both heading and body completely. Preserve ALL WordPress block comments, HTML structure, links, URLs.` },
            { role: "user", content: `Translate this section to Traditional Chinese (Hong Kong):\n\nSection context: ${context}\n\n## Heading ##\n${section.heading}\n\n## Body ##\n${protectedHtml}` },
          ];
          const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, `section-${i}`, budget);
          try { const parsed = JSON.parse(result.content); if (parsed.heading) translatedHeading = parsed.heading; return parsed.body || result.content; }
          catch { return result.content; }
        },
        repairProtectedHtml: async (protectedHtml, error) => {
          if (error.includes("number")) {
            return await translateText(
              protectedHtml,
              `RETRY: ${error}. Preserve EXACTLY every number, percentage, date, and token like __NUM_0__. Every original value must appear verbatim.`,
              TRANSLATION_SYSTEM, zhKeyphrase, `section-${i}-numbers`, budget,
            );
          }
          return null;
        },
        onStatus: (status) => {
          if (!status.passed) failedComponents.push(`section-${i}`);
          metrics.push({ component: `section-${i}`, ...status.metrics, passed: status.passed ? 1 : 0 } as any);
        },
      });
      if (!secResult.passed && section.blocks.length > 0) {
        secResult.blocks = section.blocks;
      }
      const headingEngRatio = translatedHeading ? (translatedHeading.replace(/[\u4e00-\u9fff]+/g, "").length / translatedHeading.length) : 1;
      if (!translatedHeading || headingEngRatio > 0.5) {
        console.log(`[translate] Section ${i} heading "${translatedHeading}" has ratio ${headingEngRatio.toFixed(2)} — fallback call`);
        const hFallback = await translateText(section.heading, "Translate this H2 heading to Traditional Chinese:", TITLE_META_SYSTEM, zhKeyphrase, `heading-${i}-fallback`, budget);
        if (hFallback && hFallback.replace(/[a-zA-Z\s]+/g, "").length >= 2) { translatedHeading = hFallback; }
        else { console.warn(`[translate] Section ${i} heading fallback also failed`); failedComponents.push(`section-${i}-heading`); }
      }
    }
    zhDoc.sections.push({
      id: `zh-section-${i}`, heading: translatedHeading, headingLevel: 2, sectionType: section.sectionType,
      blocks: secResult?.passed ? secResult.blocks : section.blocks,
      status: secResult?.passed ? "generated" : section.blocks.length > 0 ? "regenerated" : "missing",
    });
  }

  // ── FAQ ──
  const enFaq = extractFaqFromDoc(enDoc);
  const zhFaq: FaqEntry[] = [];
  if (enFaq.length > 0) {
    try {
      const faqResult = await translateFaqEntries(enFaq, budget);
      const check = checkCompleteness(enFaq.map((f) => f.question + f.answerText).join(" "), faqResult.map((f) => f.question + f.answerText).join(" "), "faq");
      if (check.passed) { zhFaq.push(...faqResult); }
      else { warnings.push("FAQ translation below completeness threshold"); zhFaq.push(...enFaq); failedComponents.push("faq"); }
    } catch { warnings.push("FAQ translation failed"); zhFaq.push(...enFaq); failedComponents.push("faq"); }
  }
  zhDoc.visibleFaq = zhFaq;

  // ── Conclusion ──
  const enConcHtml = renderComponentHtml(enDoc.conclusion);
  if (enConcHtml) {
    const prevHeading = enDoc.sections.length > 0 ? enDoc.sections[enDoc.sections.length - 1].heading : "FAQ";
    // Protect conclusion blocks once — shared between HTML and shadow paths
    const { blocks: concProtectedBlocks, state: concProtectionState } = protectNumbersInEditorialBlocks(enDoc.conclusion.blocks);
    const concProtectedHtml = renderEditorialBlocksToWordPress(concProtectedBlocks);

    const concResult = await translateEditorialBlocksFn({
      blocks: enDoc.conclusion.blocks,
      componentId: "zh-conc",
      componentKind: "conclusion",
      translateProtectedHtml: async (protectedHtml) => {
        return await translateSection(protectedHtml, "Conclusion", prevHeading, "(end)", undefined, "conclusion", budget);
      },
      repairProtectedHtml: async (protectedHtml, error) => {
        if (error.includes("number")) {
          return await translateText(
            protectedHtml,
            `RETRY: ${error}. Preserve EXACTLY every number, percentage, date, and __NUM_0__ token. This is a number-preservation retry — do not change ANY number.`,
            TITLE_META_SYSTEM, undefined, "conc-numbers-retry", budget,
          );
        }
        return null;
      },
      onStatus: (status) => {
        if (!status.passed) failedComponents.push("conclusion");
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

  // ── CTA ──
  zhDoc.languageSwitcher = enDoc.languageSwitcher;
  if (enDoc.cta) {
    zhDoc.cta = await translateCtaBlock(enDoc.cta, budget);
    const ctaText = zhDoc.cta?.html?.replace(/<[^>]+>/g, "").trim() || "";
    if (!ctaText || !/[\u4e00-\u9fff]/.test(ctaText)) { console.warn("[translate] CTA remained substantially English"); failedComponents.push("cta"); }
  }

  // ── FAQ schema ──
  const targetFaqCount = translationFaqCount(enFaq.length);
  if (zhFaq.length !== targetFaqCount) { console.warn(`[translate] FAQ count ${zhFaq.length} !== source ${targetFaqCount}`); failedComponents.push("faq-count"); }
  if (zhFaq.length === targetFaqCount) {
    const schemaJson = buildFaqSchemaJson(zhFaq);
    const schemaHtml = `<!-- wp:html -->\n<script type="application/ld+json">\n${schemaJson}\n</script>\n<!-- /wp:html -->`;
    zhDoc.faqSchema = { id: "zh-faq-schema", type: "faq-schema", html: schemaHtml, fingerprint: fingerprintHtml(schemaHtml) };
    zhDoc.visibleFaq = zhFaq;
  }

  // ── Strip English FAQPage from sections (legacy compat) ──
  for (const section of zhDoc.sections) {
    if (section.blocks.length > 0 && section.blocks.some((b) => b.type === "quote" || b.type === "paragraph")) {
      // New structured format: FAQPage is never in blocks, no action needed
      break;
    }
  }

  // ── Render and localise ──
  const html = renderArticleDocument(zhDoc);
  const balanced = rebalanceWpBlocks(html);
  const sourceDecisions = localiseSources(balanced, research || []);
  const linkDecisions = localiseInternalLinks(balanced, zhSlugs);
  const lengthMetrics = chineseLengthMetrics(balanced);

  console.log(`[translate] API calls=${budget.apiCallCount} retries=${MAX_RETRY_BUDGET - budget.remaining}/${MAX_RETRY_BUDGET} exhausted=${budget.exhausted}`);

  return {
    doc: zhDoc,
    html: applyLocalisations(balanced, sourceDecisions, linkDecisions),
    title: zhDoc.metadata.title,
    metaDescription: zhDoc.metadata.metaDescription,
    metrics, failedComponents, warnings, sourceDecisions,
    internalLinkDecisions: linkDecisions.map((d) => ({
      originalUrl: d.originalUrl, finalUrl: d.finalUrl,
      decision: d.hasChineseVersion ? "localised" as const : "preserved" as const,
      reason: d.reason, matchScore: d.hasChineseVersion ? 10 : 0,
    })),
    structuredShadowResult: shadowResults.length > 0 ? shadowResults[shadowResults.length - 1] : undefined,
    ...lengthMetrics,
  };
}
