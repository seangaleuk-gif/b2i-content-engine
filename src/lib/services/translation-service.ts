import { AiService, type ChatMessage } from "@/lib/services/deepseek";
import { countReadableWords, rebalanceWpBlocks, ensureKeyphraseInTitle } from "@/lib/services/text-utils";
import { translationFaqCount } from "@/lib/content-standards";
import {
  type ArticleDocument, type ArticleSection, type FaqEntry,
  type ProtectedArticleBlock, type ArticleComponent,
  renderArticleDocument, parseArticleDocumentFromHtml, fingerprintHtml,
} from "@/lib/blog/article-document";
import type { TranslationMetrics, TranslationResult, ResearchItem } from "./translation-types";
import { RetryBudget } from "./translation-types";
import { TITLE_META_SYSTEM, TRANSLATION_SYSTEM, INTRO_RETRY_STRICT, chatWithBudget, translateText, translateSection, translateCtaBlock, translateFaqEntries } from "./translation-ai";
import { protectNumbersInHtml, tryRestoreNumbersInHtml, checkCompleteness, checkLinksPreserved, checkNumbersPreserved, extractVisibleNumbers, hasExcessiveEnglish, chineseLengthMetrics } from "./translation-validator";
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
): Promise<TranslationResult> {
  const budget = new RetryBudget(MAX_RETRY_BUDGET);
  const warnings: string[] = [];
  const metrics: TranslationMetrics[] = [];
  const failedComponents: string[] = [];

  let enDoc: ArticleDocument;
  if (sourceDoc) {
    const parsed = parseArticleDocumentFromHtml(enHtml, sourceDoc);
    if (!parsed.doc) throw new Error(`Failed to parse English article: ${parsed.errors.join("; ")}`);
    enDoc = parsed.doc;
  } else {
    const fallbackDoc: ArticleDocument = {
      metadata: { title: "", slug: "", metaDescription: "", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
      languageSwitcher: null, introduction: { id: "intro", html: "", wordCount: 0, status: "generated" },
      sections: [], visibleFaq: [],
      conclusion: { id: "conc", html: "", wordCount: 0, status: "generated" },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const parsed = parseArticleDocumentFromHtml(enHtml, fallbackDoc);
    if (!parsed.doc) throw new Error(`Failed to parse English article: ${parsed.errors.join("; ")}`);
    enDoc = parsed.doc;
  }

  const zhDoc: ArticleDocument = {
    metadata: { ...enDoc.metadata, title: "", metaDescription: "" },
    languageSwitcher: null,
    introduction: { id: "zh-intro", html: "", wordCount: 0, status: "generated" },
    sections: [], visibleFaq: [],
    conclusion: { id: "zh-conc", html: "", wordCount: 0, status: "generated" },
    cta: null, faqSchema: null, insertedLinks: enDoc.insertedLinks,
  };

  // ── Metadata ──
  let zhKeyphrase = "";
  if (enDoc.metadata.metaDescription) {
    const sourceKeyword = enDoc.metadata.focusKeyphrase || "";
    const introPadding = enDoc.introduction.html || "";
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
    zhDoc.metadata.title = zhTitle;
    zhDoc.metadata.focusKeyphrase = zhKeyphrase || enDoc.metadata.focusKeyphrase || "";
  }
  zhKeyphrase = zhDoc.metadata.focusKeyphrase;

  // ── Introduction ──
  if (enDoc.introduction.html) {
    const { protectedHtml: protectedIntro, placeholders: introPhs, originalValues: introVals } = protectNumbersInHtml(enDoc.introduction.html);
    const tr = await translateWithRetry(
      () => translateSection(protectedIntro, "Introduction", "(start)", enDoc.sections[0]?.heading || "first section", zhKeyphrase, "introduction", budget),
      protectedIntro, "introduction", protectedIntro,
    );
    metrics.push(tr.metrics);
    let finalIntro = tr.translated;
    let introPassed = tr.passed;
    if (hasExcessiveEnglish(finalIntro)) {
      console.log("[translate] Introduction excessive English — targeted retry");
      const retryText = await translateText(protectedIntro, INTRO_RETRY_STRICT, TITLE_META_SYSTEM, zhKeyphrase, "introduction-retry", budget);
      if (retryText && !hasExcessiveEnglish(retryText)) { finalIntro = retryText; introPassed = true; console.log("[translate] Introduction retry succeeded"); }
      else { console.warn("[translate] Introduction retry still has excessive English"); introPassed = false; }
    }
    if (introPassed && introPhs.length > 0) {
      const restored = tryRestoreNumbersInHtml(finalIntro, introPhs, introVals);
      if (!restored.ok) { console.warn(`[translate] Introduction number loss: lost=${restored.lost.join(",")}`); introPassed = false; }
      else { finalIntro = restored.html; }
    }
    zhDoc.introduction.html = introPassed ? finalIntro : enDoc.introduction.html;
    zhDoc.introduction.wordCount = countReadableWords(zhDoc.introduction.html);
    if (!introPassed) failedComponents.push("introduction");
  }

  // ── Sections ──
  for (let i = 0; i < enDoc.sections.length; i++) {
    const section = enDoc.sections[i];
    const prev = i > 0 ? enDoc.sections[i - 1].heading : "Introduction";
    const next = i < enDoc.sections.length - 1 ? enDoc.sections[i + 1].heading : "Conclusion";
    let translatedHeading = section.heading;
    let translatedBody = "";
    let bodyPassed = false;
    if (section.html) {
      const { protectedHtml: protectedBody, placeholders: secPhs, originalValues: secVals } = protectNumbersInHtml(section.html);
      const combinedFn = async (): Promise<string> => {
        const context = `Heading: "${section.heading}". Previous: "${prev}". Next: "${next}"`;
        const kpMsg = zhKeyphrase ? `\n\nThe SEO focus keyphrase for this article is "${zhKeyphrase}". Use this exact keyphrase naturally.` : "";
        const messages: ChatMessage[] = [
          { role: "system", content: `${TRANSLATION_SYSTEM}${kpMsg}\n\nReturn a JSON object with two keys:\n{\n  "heading": "translated H2 heading",\n  "body": "full translated section HTML"\n}\nRules: Translate both heading and body completely. Preserve ALL WordPress block comments, HTML structure, links, URLs.` },
          { role: "user", content: `Translate this section to Traditional Chinese (Hong Kong):\n\nSection context: ${context}\n\n## Heading ##\n${section.heading}\n\n## Body ##\n${protectedBody}` },
        ];
        const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, `section-${i}`, budget);
        try { const parsed = JSON.parse(result.content); if (parsed.heading) translatedHeading = parsed.heading; return parsed.body || result.content; }
        catch { return result.content; }
      };
      const tr = await translateWithRetry(combinedFn, protectedBody, `section-${i}`, protectedBody);
      translatedBody = tr.translated;
      bodyPassed = tr.passed;
      metrics.push(tr.metrics);
      if (bodyPassed && secPhs.length > 0) {
        const restored = tryRestoreNumbersInHtml(translatedBody, secPhs, secVals);
        if (!restored.ok) { console.warn(`[translate] Section ${i} number loss: lost=${restored.lost.join(",")}`); bodyPassed = false; }
        else { translatedBody = restored.html; }
      }
      if (!bodyPassed) failedComponents.push(`section-${i}`);
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
      html: translatedBody, wordCount: countReadableWords(translatedBody),
      status: bodyPassed ? "generated" : section.html ? "regenerated" : "missing",
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
  if (enDoc.conclusion.html) {
    const { protectedHtml: protectedConc, placeholders: concPhs, originalValues: concVals } = protectNumbersInHtml(enDoc.conclusion.html);
    const prevHeading = enDoc.sections.length > 0 ? enDoc.sections[enDoc.sections.length - 1].heading : "FAQ";
    const tr = await translateWithRetry(() => translateSection(protectedConc, "Conclusion", prevHeading, "(end)", undefined, "conclusion", budget), protectedConc, "conclusion", protectedConc);
    metrics.push(tr.metrics);
    let finalConc = tr.translated;
    let concPassed = tr.passed;
    if (concPassed && concPhs.length > 0) {
      const restored = tryRestoreNumbersInHtml(finalConc, concPhs, concVals);
      if (!restored.ok) { console.warn(`[translate] Conclusion number loss: lost=${restored.lost.join(",")}`); concPassed = false; }
      else { finalConc = restored.html; }
    }
    zhDoc.conclusion.html = concPassed ? finalConc : enDoc.conclusion.html;
    zhDoc.conclusion.wordCount = countReadableWords(zhDoc.conclusion.html);
    if (!concPassed) failedComponents.push("conclusion");
  }

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

  // ── Strip English FAQPage from sections ──
  for (const section of zhDoc.sections) {
    section.html = section.html.replace(/<!--\s*wp:html\s*-->[\s\S]*?"@type"\s*:\s*"FAQPage"[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
    section.html = section.html.replace(/<script[\s\S]*?"@type"\s*:\s*"FAQPage"[\s\S]*?<\/script>/gi, "");
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
    ...lengthMetrics,
  };
}
