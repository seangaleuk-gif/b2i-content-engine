import { AiService, type ChatMessage } from "@/lib/services/deepseek";
import { countReadableWords, rebalanceWpBlocks } from "@/lib/services/text-utils";
import {
  type ArticleDocument,
  type ArticleSection,
  type FaqEntry,
  type ProtectedArticleBlock,
  type ArticleComponent,
  renderArticleDocument,
  parseArticleDocumentFromHtml,
  fingerprintHtml,
} from "@/lib/blog/article-document";

// ── Types ──

export interface TranslationMetrics {
  component: string;
  sourceChars: number;
  translatedChars: number;
  ratio: number;
  passed: boolean;
  sourceNumbers: number;
  translatedNumbers: number;
  numbersMatch: boolean;
}

export interface SourceDecision {
  originalUrl: string;
  finalUrl: string;
  decision: "preserved" | "replaced" | "removed" | "localised";
  reason: string;
  matchScore: number;
}

export interface TranslationResult {
  doc: ArticleDocument;
  html: string;
  title: string;
  metaDescription: string;
  metrics: TranslationMetrics[];
  failedComponents: string[];
  warnings: string[];
  zhCharCount: number;
  latinWordCount: number;
  paragraphCount: number;
  estimatedReadingMinutes: number;
  sourceDecisions: SourceDecision[];
  internalLinkDecisions: SourceDecision[];
}

// ── Constants ──

const COMPLETENESS_RATIO = 0.25;
const MAX_RETRIES = 0; // Outer retries removed — inner chatWithRetry (3 tries) is sufficient
const MAX_RETRY_BUDGET = 12; // Shared retry budget for the entire translation operation

// ── Request-scoped retry budget ──

class RetryBudget {
  remaining: number;
  total: number;
  exhausted: boolean;
  apiCallCount: number;
  componentLog: string[];

  constructor(budget: number) {
    this.remaining = budget;
    this.total = budget;
    this.exhausted = false;
    this.apiCallCount = 0;
    this.componentLog = [];
  }

  /** Always allow the first attempt. Cap retries (attempts 2 and 3) to remaining budget.
   *  Returns the effective maxRetries for chatWithRetry. */
  capRetries(requestedRetries: number): number {
    this.apiCallCount++;
    if (this.exhausted || this.remaining <= 0) {
      return 0; // first attempt only, no retries
    }
    const allowed = Math.min(requestedRetries, this.remaining);
    return allowed;
  }

  /** After the AI call, record how many retries were actually consumed. */
  record(component: string, usedRetries: number, budgetExhausted: boolean): void {
    this.remaining = Math.max(0, this.remaining - usedRetries);
    if (budgetExhausted || this.remaining <= 0) {
      this.exhausted = true;
    }
    if (usedRetries > 0 || budgetExhausted) {
      this.componentLog.push(`${component}(retries=${usedRetries}/${this.total})`);
    }
  }
}

/** Always make the first API attempt; cap only retries against the shared budget. */
async function chatWithBudget(
  messages: ChatMessage[],
  options: Record<string, unknown>,
  component: string,
  budget?: RetryBudget,
): Promise<{ content: string; finishReason?: string }> {
  const requestedRetries = (options as any).maxRetries ?? 2;
  const maxRetries = budget ? budget.capRetries(requestedRetries) : requestedRetries;
  (options as any).maxRetries = maxRetries;

  try {
    const result = await ai.chatWithRetry(messages, options as any);
    const usedRetries = requestedRetries - maxRetries;
    if (budget) budget.record(component, usedRetries, maxRetries < requestedRetries);
    return { content: result.content, finishReason: result.finishReason };
  } catch (error) {
    if (budget) budget.record(component, requestedRetries, true);
    throw error;
  }
}

/** Module-level currentKeyphrase has been removed — keyphrase is passed explicitly through function arguments. */

const CTA_TRANSLATION_SYSTEM = `You are a professional translator. Translate ONLY the visible display text of this CTA button/section to Hong Kong Traditional Chinese.

Rules:
- Translate ONLY visible text — do NOT change any HTML tags, attributes, URLs, CSS, or WordPress comments
- Preserve the <a href="..."> signup URL exactly — do not change it
- Preserve all style attributes and class names
- Do NOT add, remove, or restructure any HTML elements
- Return the COMPLETE HTML with only the text content translated
- Hong Kong Traditional Chinese only
- Example: "Ready to grow your brand" → "準備好壯大你嘅品牌"
- Example: "Get started" → "立即開始" or "馬上開始"
- Example: "Create your free profile" → "建立免費檔案"`;

// ── Chinese-aware length metrics ──

export function countCjkChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
}

export function countLatinWords(text: string): number {
  const cleaned = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\s]+/g, " ").trim();
  return cleaned ? cleaned.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length : 0;
}

export function countParagraphs(html: string): number {
  return (html.match(/<\/p>/gi) || []).length + (html.match(/<\/li>/gi) || []).length;
}

export function estimatedReadingTime(cjkChars: number, latinWords: number): number {
  const cjkMinutes = cjkChars / 300;
  const latinMinutes = latinWords / 200;
  return Math.max(1, Math.ceil(cjkMinutes + latinMinutes));
}

export function chineseLengthMetrics(html: string): {
  zhCharCount: number;
  latinWordCount: number;
  paragraphCount: number;
  estimatedReadingMinutes: number;
} {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const zhCharCount = countCjkChars(body);
  const latinWordCount = countLatinWords(body);
  const paragraphCount = countParagraphs(html);
  return {
    zhCharCount,
    latinWordCount,
    paragraphCount,
    estimatedReadingMinutes: estimatedReadingTime(zhCharCount, latinWordCount),
  };
}

// ── Completeness check ──

export function visibleChars(html: string): number {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .length;
}

export function checkCompleteness(source: string, translated: string, component: string): { passed: boolean; sourceChars: number; translatedChars: number; ratio: number } {
  const sourceChars = visibleChars(source);
  const translatedChars = visibleChars(translated);
  const ratio = sourceChars > 0 ? translatedChars / sourceChars : 1;
  const passed = ratio >= COMPLETENESS_RATIO && !hasExcessiveEnglish(translated);
  return { passed, sourceChars, translatedChars, ratio };
}

/** Detect if translated content has excessive untranslated English — runs of 5+ English words exceeding 15% of visible characters */
function hasExcessiveEnglish(text: string): boolean {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const engRuns = cleaned.match(/\b([A-Za-z]{2,}\s+){4,}[A-Za-z]{2,}\b/g) || [];
  if (engRuns.length === 0) return false;
  const totalEng = engRuns.join(" ").length;
  return totalEng > cleaned.length * 0.10;
}

export function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
}

export function checkLinksPreserved(source: string, translated: string): string[] {
  const srcLinks = extractLinks(source);
  const tgtLinks = extractLinks(translated);
  const lost = srcLinks.filter((l) => !tgtLinks.includes(l) && !l.startsWith("#"));
  return lost;
}

export function checkNoNewUrls(source: string, translated: string): string[] {
  const srcLinks = extractLinks(source);
  const tgtLinks = extractLinks(translated);
  const newUrls = tgtLinks.filter((l) => !srcLinks.includes(l) && !l.startsWith("#") && !l.startsWith("/blog/") && !l.includes("b2ihub.com"));
  return newUrls;
}

// ── Number preservation ──

export function extractVisibleNumbers(html: string): string[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const numbers: string[] = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) numbers.push(m[0]);
  return numbers;
}

export function normalizeNumber(n: string): string {
  return n.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "").trim();
}

/** Unit-aware scaled quantity extraction. Converts "1.2 million" and "120萬" to "1200000". */
export function extractScaledNumbers(html: string): { raw: string; scaled: string }[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const results: { raw: string; scaled: string }[] = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    const match = m[0];
    const isPercent = /[%％]/.test(match);
    const cleanMatch = match.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "");
    const numPart = parseFloat(cleanMatch);
    const after = body.substring(m.index + match.length, m.index + match.length + 12).toLowerCase();

    let scale = 1;
    let hasScale = false;
    let hasChineseUnit = false;

    const engWord = after.match(/^\s*(thousand|million|billion|trillion)\b/);
    if (engWord) {
      const w = engWord[1];
      if (w === "thousand") { scale = 1_000; hasScale = true; }
      else if (w === "million") { scale = 1_000_000; hasScale = true; }
      else if (w === "billion") { scale = 1_000_000_000; hasScale = true; }
    }

    const zhChar = after.match(/^\s*(千|萬|億)\s*/);
    if (zhChar) {
      const ch = zhChar[1];
      if (ch === "千") { scale = 1_000; hasScale = true; hasChineseUnit = true; }
      else if (ch === "萬") { scale = 10_000; hasScale = true; hasChineseUnit = true; }
      else if (ch === "億") { scale = 100_000_000; hasScale = true; hasChineseUnit = true; }
    }

    const hasHkdSuffix = !!after.match(/^\s*(?:[千萬億]\s*)?港元的?/);
    const hasHkdPrefix = /^HK?\$/.test(match);
    const hasUsdPrefix = /^US?\$/.test(match) && !hasHkdPrefix;

    const scaledValue = isPercent
      ? `%:${numPart}`
      : hasScale
        ? `${hasHkdPrefix || hasHkdSuffix ? "HKD:" : hasUsdPrefix ? "USD:" : ""}${Math.round(numPart * scale)}`
        : hasHkdPrefix || hasHkdSuffix
          ? `HKD:${numPart}`
          : /^\d+$/.test(String(numPart)) ? String(numPart) : String(numPart).replace(/\.0$/, "");

    results.push({ raw: match, scaled: scaledValue });
  }

  return results;
}

export function checkNumbersPreserved(source: string, translated: string): { lost: string[]; extras: string[] } {
  const srcNums = extractScaledNumbers(source).map((n) => n.scaled);
  const tgtNums = extractScaledNumbers(translated).map((n) => n.scaled);
  const srcCounts: Record<string, number> = {};
  const tgtCounts: Record<string, number> = {};
  for (const n of srcNums) srcCounts[n] = (srcCounts[n] || 0) + 1;
  for (const n of tgtNums) tgtCounts[n] = (tgtCounts[n] || 0) + 1;
  const lost: string[] = [];
  const extras: string[] = [];
  for (const [n, c] of Object.entries(srcCounts)) {
    const tgtC = tgtCounts[n] || 0;
    if (tgtC < c) lost.push(...Array(c - tgtC).fill(n));
  }
  for (const [n, c] of Object.entries(tgtCounts)) {
    const srcC = srcCounts[n] || 0;
    if (srcC < c) extras.push(...Array(c - srcC).fill(n));
  }
  return { lost, extras };
}

// ── AI helpers ──

const ai = new AiService();

async function translateText(text: string, instruction: string, systemPrompt: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  if (!text || text.trim().length === 0) return text;
  const kpMsg = keyphrase ? ` The SEO focus keyphrase is "${keyphrase}". You MUST include this exact keyphrase in the translation.` : "";
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt + kpMsg },
    { role: "user", content: `${instruction}\n\n${text}` },
  ];
    const result = await chatWithBudget(messages, { maxTokens: 1024, temperature: 0.3 }, component || "translate-text", budget);
  return result.content.trim();
}

async function translateHtml(html: string, context: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  if (!html || html.trim().length === 0) return html;
  const kpMsg = keyphrase ? `\n\nThe SEO focus keyphrase for this article is "${keyphrase}". Use this exact keyphrase naturally in headings and body where it fits organically.` : "";
  const messages: ChatMessage[] = [
    { role: "system", content: TRANSLATION_SYSTEM + kpMsg },
    { role: "user", content: `Translate this section to Traditional Chinese (Hong Kong):\n\nSection context: ${context}\n\n${html}` },
  ];
  const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, component || "translate-html", budget);
  try {
    const parsed = JSON.parse(result.content);
    if (parsed.translatedHtml) return parsed.translatedHtml;
  } catch { /* plain text */ }
  return result.content.trim();
}

async function translateSection(html: string, heading: string, prevHeading: string, nextHeading: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  return translateHtml(html, `Heading: "${heading}". Previous: "${prevHeading}". Next: "${nextHeading}"`, keyphrase, component, budget);
}

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
        translated = await translateHtml(source, `RETRY: You did not preserve all links. These links were lost:\n${lostMsg}`);
        continue;
      }
      return { translated, passed: false, metrics };
    }
    // Number preservation check
    const numSrc = sourceForNumbers || source;
    const numCheck = checkNumbersPreserved(numSrc, translated);
    metrics.sourceNumbers = extractVisibleNumbers(numSrc).length;
    metrics.translatedNumbers = extractVisibleNumbers(translated).length;
    metrics.numbersMatch = numCheck.lost.length === 0;
    if (!metrics.numbersMatch && attempt < MAX_RETRIES) {
      const lostMsg = numCheck.lost.length > 0
        ? `Missing numbers: ${numCheck.lost.join(", ")}`
        : `Unexpected numbers: ${numCheck.extras.join(", ")}`;
      translated = await translateHtml(numSrc, `RETRY: Number mismatch. ${lostMsg}. Preserve ALL numbers, percentages, dates, and prices exactly.`);
      continue;
    }
    if (!metrics.numbersMatch) {
      return { translated, passed: false, metrics };
    }
    return { translated, passed: true, metrics };
  }
  return { translated: translated || source, passed: false, metrics };
}

// ── Main translation function ──

export interface ResearchItem {
  title: string;
  url: string;
  snippet: string;
  category: string;
}

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
      languageSwitcher: null,
      introduction: { id: "intro", html: "", wordCount: 0, status: "generated" },
      sections: [],
      visibleFaq: [],
      conclusion: { id: "conc", html: "", wordCount: 0, status: "generated" },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
    const parsed = parseArticleDocumentFromHtml(enHtml, fallbackDoc);
    if (!parsed.doc) throw new Error(`Failed to parse English article: ${parsed.errors.join("; ")}`);
    enDoc = parsed.doc;
  }

  const zhDoc: ArticleDocument = {
    metadata: { ...enDoc.metadata, title: "", metaDescription: "" },
    languageSwitcher: null,
    introduction: { id: "zh-intro", html: "", wordCount: 0, status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "zh-conc", html: "", wordCount: 0, status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: enDoc.insertedLinks,
  };

  // ── Metadata ──
  // Order: 1) combined meta+keyphrase translation (with intro padding), 2) title with known keyphrase

  // Step 1: Translate meta description AND keyphrase together (padded with introduction to avoid empty_response)
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

    // Attempt 1: structured mode with response_format
    try {
      const res = await chatWithBudget(messages, { maxTokens: 2048, temperature: 0.3, responseFormat: { type: "json_object" } }, "metadata-json", budget);
      const parsed = JSON.parse(res.content);
      const zhKp = (parsed.zhKeyphrase || "").trim();
      const cjkKp = zhKp.replace(/[a-zA-Z\s]+/g, "").trim();
      if (parsed.metaDescription && cjkKp && /[\u4e00-\u9fff]/.test(cjkKp)) {
        combinedResult = { metaDescription: parsed.metaDescription, zhKeyphrase: cjkKp };
      }
    } catch { /* fall through */ }

    // Attempt 2: if structured mode returned empty, retry once without response_format
    if (!combinedResult) {
      console.log("[metadata] Structured JSON mode failed — retrying without response_format");
      try {
        const res = await chatWithBudget(
          [...messages, { role: "user", content: "Return ONLY valid JSON. No markdown, no code fences, no explanation." }],
          { maxTokens: 2048, temperature: 0.3 },
          "metadata-plain",
          budget
        );
        // Try to extract JSON from plain-text response
        const jsonStr = res.content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(jsonStr);
        const zhKp = (parsed.zhKeyphrase || "").trim();
        const cjkKp = zhKp.replace(/[a-zA-Z\s]+/g, "").trim();
        if (parsed.metaDescription && cjkKp && /[\u4e00-\u9fff]/.test(cjkKp)) {
          combinedResult = { metaDescription: parsed.metaDescription, zhKeyphrase: cjkKp };
        }
      } catch { /* fall through to fallback */ }
    }

    if (combinedResult) {
      zhDoc.metadata.metaDescription = combinedResult.metaDescription;
      zhKeyphrase = combinedResult.zhKeyphrase;
    } else {
      const metaTr = await translateWithRetry(
        () => translateText(enDoc.metadata.metaDescription, "Translate this meta description to Traditional Chinese:", TITLE_META_SYSTEM, undefined, "meta-fallback", budget),
        enDoc.metadata.metaDescription, "meta-description",
      );
      zhDoc.metadata.metaDescription = metaTr.passed ? metaTr.translated : enDoc.metadata.metaDescription;
      metrics.push(metaTr.metrics);
      if (!metaTr.passed) failedComponents.push("meta-description");

      // Fallback keyphrase translation: one plain-text call, no separate retry cycle
      if (sourceKeyword && !/[\u4e00-\u9fff]/.test(sourceKeyword)) {
        try {
          const kpResult = await translateText(
            sourceKeyword,
            "Translate this English SEO keyphrase into natural Hong Kong Traditional Chinese (繁體中文):",
            TITLE_META_SYSTEM, undefined, "keyphrase-fallback", budget,
          );
          const cleaned = (kpResult || "").replace(/[a-zA-Z\s]+/g, "").trim();
          if (cleaned.length >= 2 && /[\u4e00-\u9fff]/.test(cleaned)) {
            zhKeyphrase = cleaned;
            console.log(`[metadata] Fallback keyphrase: "${sourceKeyword}" → "${zhKeyphrase}"`);
          }
        } catch {
          console.warn(`[metadata] Fallback keyphrase translation failed for "${sourceKeyword}"`);
        }
      } else if (sourceKeyword) {
        zhKeyphrase = sourceKeyword;
      }
    }
  } else {
    zhDoc.metadata.metaDescription = enDoc.metadata.metaDescription;
  }

  // Step 2: Translate title once, then insert keyphrase deterministically if missing
  if (enDoc.metadata.title) {
    const tr = await translateWithRetry(
      () => translateText(enDoc.metadata.title, "Translate this blog title to Traditional Chinese:", TITLE_META_SYSTEM, zhKeyphrase, "title", budget),
      enDoc.metadata.title, "title",
    );
    let zhTitle = tr.passed ? tr.translated : enDoc.metadata.title;
    metrics.push(tr.metrics);
    if (!tr.passed) failedComponents.push("title");

    // Deterministic keyphrase insertion: if keyphrase is CJK and missing from title, prepend it
    if (zhKeyphrase && /[\u4e00-\u9fff]/.test(zhKeyphrase) && !zhTitle.includes(zhKeyphrase)) {
      const { ensureKeyphraseInTitle } = await import("@/lib/services/text-utils");
      zhTitle = ensureKeyphraseInTitle(zhTitle, zhKeyphrase);
      console.log(`[metadata] Keyphrase "${zhKeyphrase}" inserted into title: "${zhTitle}"`);
    }

    zhDoc.metadata.title = zhTitle;
    zhDoc.metadata.focusKeyphrase = zhKeyphrase || enDoc.metadata.focusKeyphrase || "";
  } else {
  }
  zhKeyphrase = zhDoc.metadata.focusKeyphrase;

  // ── Introduction ──
  if (enDoc.introduction.html) {
    const tr = await translateWithRetry(
      () => translateSection(enDoc.introduction.html, "Introduction", "(start)", enDoc.sections[0]?.heading || "first section", zhKeyphrase, "introduction", budget),
      enDoc.introduction.html, "introduction", enDoc.introduction.html,
    );
    zhDoc.introduction.html = tr.passed ? tr.translated : enDoc.introduction.html;
    zhDoc.introduction.wordCount = countReadableWords(zhDoc.introduction.html);
    metrics.push(tr.metrics);
    if (!tr.passed) failedComponents.push("introduction");
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
      // Combine heading + body in one AI call: prompt asks for JSON {heading, body}.
      // The body is validated through translateWithRetry for links/numbers/completeness.
      const combinedFn = async (): Promise<string> => {
        const context = `Heading: "${section.heading}". Previous: "${prev}". Next: "${next}"`;
        const kpMsg = zhKeyphrase ? `\n\nThe SEO focus keyphrase for this article is "${zhKeyphrase}". Use this exact keyphrase naturally in headings and body where it fits organically.` : "";
        const messages: ChatMessage[] = [
          { role: "system", content: `${TRANSLATION_SYSTEM}${kpMsg}

Return a JSON object with two keys:
{
  "heading": "translated H2 heading",
  "body": "full translated section HTML with WordPress blocks preserved"
}
Rules: Translate both heading and body completely. Preserve ALL WordPress block comments, HTML structure, links, and URLs. Traditional Chinese only.` },
          { role: "user", content: `Translate this section to Traditional Chinese (Hong Kong):\n\nSection context: ${context}\n\n## Heading ##\n${section.heading}\n\n## Body ##\n${section.html}` },
        ];
        const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, `section-${i}`, budget);
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.heading) translatedHeading = parsed.heading;
          return parsed.body || result.content;
        } catch {
          return result.content;
        }
      };
      const tr = await translateWithRetry(combinedFn, section.html, `section-${i}`, section.html);
      translatedBody = tr.translated;
      bodyPassed = tr.passed;
      metrics.push(tr.metrics);
      if (!tr.passed) failedComponents.push(`section-${i}`);

      // Check heading quality: if empty or mostly English, make one heading-only fallback call
      const headingEngRatio = translatedHeading ? (translatedHeading.replace(/[\u4e00-\u9fff]+/g, "").length / translatedHeading.length) : 1;
      if (!translatedHeading || headingEngRatio > 0.5) {
        console.log(`[translate] Section ${i} heading "${translatedHeading}" has ratio ${headingEngRatio.toFixed(2)} — fallback call`);
        const hFallback = await translateText(
          section.heading,
          "Translate this H2 heading to Traditional Chinese:",
          TITLE_META_SYSTEM, zhKeyphrase, `heading-${i}-fallback`, budget,
        );
        if (hFallback && hFallback.replace(/[a-zA-Z\s]+/g, "").length >= 2) {
          translatedHeading = hFallback;
          console.log(`[translate] Section ${i} heading fallback succeeded: "${translatedHeading}"`);
        } else {
          console.warn(`[translate] Section ${i} heading fallback also failed — marking hard failure`);
          failedComponents.push(`section-${i}-heading`);
        }
      }
    }

    zhDoc.sections.push({
      id: `zh-section-${i}`,
      heading: translatedHeading,
      headingLevel: 2,
      sectionType: section.sectionType,
      html: translatedBody,
      wordCount: countReadableWords(translatedBody),
      status: bodyPassed ? "generated" : section.html ? "regenerated" : "missing",
    });
  }

  // ── FAQ ──
  const enFaq = extractFaqFromDoc(enDoc);
  const zhFaq: FaqEntry[] = [];
  if (enFaq.length > 0) {
    try {
      const faqResult = await translateFaqEntries(enFaq, budget);
      const check = checkCompleteness(
        enFaq.map((f) => f.question + f.answerText).join(" "),
        faqResult.map((f) => f.question + f.answerText).join(" "),
        "faq",
      );
      if (check.passed) {
        zhFaq.push(...faqResult);
      } else {
        warnings.push("FAQ translation below completeness threshold, retaining originals");
        zhFaq.push(...enFaq);
        failedComponents.push("faq");
      }
    } catch {
      warnings.push("FAQ translation failed, retaining originals");
      zhFaq.push(...enFaq);
      failedComponents.push("faq");
    }
  }
  zhDoc.visibleFaq = zhFaq;

  // ── Conclusion ──
  if (enDoc.conclusion.html) {
    const prevHeading = enDoc.sections.length > 0 ? enDoc.sections[enDoc.sections.length - 1].heading : "FAQ";
    const tr = await translateWithRetry(
      () => translateSection(enDoc.conclusion.html, "Conclusion", prevHeading, "(end)", undefined, "conclusion", budget),
      enDoc.conclusion.html, "conclusion", enDoc.conclusion.html,
    );
    zhDoc.conclusion.html = tr.passed ? tr.translated : enDoc.conclusion.html;
    zhDoc.conclusion.wordCount = countReadableWords(zhDoc.conclusion.html);
    metrics.push(tr.metrics);
    if (!tr.passed) failedComponents.push("conclusion");
  }

  // ── Translate CTA display text ──
  zhDoc.languageSwitcher = enDoc.languageSwitcher;
  if (enDoc.cta) {
    zhDoc.cta = await translateCtaBlock(enDoc.cta, budget);
    // Check CTA is actually translated — signup URL alone is not enough
    const ctaText = zhDoc.cta?.html?.replace(/<[^>]+>/g, "").trim() || "";
    if (!ctaText || !/[\u4e00-\u9fff]/.test(ctaText)) {
      console.warn("[translate] CTA remained substantially English — marking hard failure");
      failedComponents.push("cta");
    }
  }

  // ── Rebuild FAQPage JSON-LD ──
  if (zhFaq.length >= 4 && zhFaq.length <= 6) {
    // Build schema from the same zhFaq array used for visible FAQ — exact match guaranteed
    const schemaJson = buildFaqSchemaJson(zhFaq);
    const schemaHtml = `<!-- wp:html -->\n<script type="application/ld+json">\n${schemaJson}\n</script>\n<!-- /wp:html -->`;
    zhDoc.faqSchema = {
      id: "zh-faq-schema",
      type: "faq-schema",
      html: schemaHtml,
      fingerprint: fingerprintHtml(schemaHtml),
    };
    zhDoc.visibleFaq = zhFaq;
  } else {
    console.warn(`[translate] FAQ count ${zhFaq.length} outside required 4-6 — marking hard failure`);
    failedComponents.push("faq-count");
  }

  // ── Strip any English FAQPage schemas from section bodies before assembly ──
  for (const section of zhDoc.sections) {
    section.html = section.html.replace(/<!--\s*wp:html\s*-->[\s\S]*?"@type"\s*:\s*"FAQPage"[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
    section.html = section.html.replace(/<script[\s\S]*?"@type"\s*:\s*"FAQPage"[\s\S]*?<\/script>/gi, "");
  }

  // ── Render ──
  const html = renderArticleDocument(zhDoc);
  const balanced = rebalanceWpBlocks(html);

  // ── Source localisation ──
  const sourceDecisions = localiseSources(balanced, research || []);

  // ── Internal-link localisation ──
  const internalLinkDecisions = localiseInternalLinks(balanced, zhSlugs);

  // ── Chinese length metrics ──
  const lengthMetrics = chineseLengthMetrics(balanced);

  console.log(`[translate] API calls=${budget.apiCallCount} retries=${MAX_RETRY_BUDGET - budget.remaining}/${MAX_RETRY_BUDGET} budgetExhausted=${budget.exhausted} components="${budget.componentLog.join("; ")}"`);

  return {
    doc: zhDoc,
    html: applyLocalisations(balanced, sourceDecisions, internalLinkDecisions),
    title: zhDoc.metadata.title,
    metaDescription: zhDoc.metadata.metaDescription,
    metrics,
    failedComponents,
    warnings,
    sourceDecisions,
    internalLinkDecisions: internalLinkDecisions.map((d) => ({
      originalUrl: d.originalUrl,
      finalUrl: d.finalUrl,
      decision: d.hasChineseVersion ? "localised" : "preserved",
      reason: d.reason,
      matchScore: d.hasChineseVersion ? 10 : 0,
    })),
    ...lengthMetrics,
  };
}

// ── Source localisation ──

const AUTHORITATIVE_DOMAINS = [
  "facebook.com", "instagram.com", "threads.net", "about.meta.com",
  "developers.facebook.com", "help.instagram.com",
  "support.google.com", "developers.google.com",
  "gov.hk", "hongkong.gov.hk", "censtatd.gov.hk",
  "who.int", "un.org", "oecd.org",
  "investopedia.com", "statista.com",
  "acm.org", "ieee.org", "scholar.google.com",
  "nature.com", "science.org", "springer.com",
];
const AUTHORITATIVE_PREFIXES = AUTHORITATIVE_DOMAINS.map((d) => `https://${d}`);

function isAuthoritative(url: string): boolean {
  const cleanUrl = url.replace(/^https?:\/\/(www\.)?/, "https://");
  return AUTHORITATIVE_PREFIXES.some((p) => cleanUrl.startsWith(p));
}

function urlDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function domainName(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function textMatchSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function hasNumbers(text: string): boolean {
  return /\d/.test(text);
}

function extractNumbers(text: string): Set<string> {
  const nums = text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
  return new Set(nums.map((n) => n.replace(/,/g, "")));
}

function isChineseDomain(url: string): boolean {
  const domain = urlDomain(url);
  return /\.hk$|\.cn$|\.tw$|\.mo$|^zh\.|chinese/i.test(domain);
}

function isB2iDomain(url: string): boolean {
  return /b2ihub\.com/i.test(url);
}

export function localiseSources(
  html: string,
  research: ResearchItem[],
): SourceDecision[] {
  const decisions: SourceDecision[] = [];
  const seen = new Set<string>();

  // Extract external links from HTML
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (!href.startsWith("http")) continue;
    if (isB2iDomain(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    // Authoritative sources: preserve
    if (isAuthoritative(href)) {
      decisions.push({
        originalUrl: href,
        finalUrl: href,
        decision: "preserved",
        reason: "Authoritative primary source",
        matchScore: 10,
      });
      continue;
    }

    // Check research for matching Chinese-language alternatives
    const domain = domainName(href);
    const researchCandidates = research.filter(
      (r) => !isB2iDomain(r.url) && !seen.has(r.url),
    );

    let bestCandidate: ResearchItem | null = null;
    let bestScore = 0;
    let bestContentScore = 0;

    for (const candidate of researchCandidates) {
      let score = 0;
      let contentScore = 0;

      // Chinese domain bonus
      if (isChineseDomain(candidate.url)) score += 3;

      // Title/snippet similarity
      const titleSim = textMatchSimilarity(
        candidate.title || "",
        m[0] || domain,
      );
      score += titleSim * 5;
      if (titleSim > 0.1) contentScore += titleSim * 5;

      // Number match bonus (same numbers = same claim)
      let sharedNumsCount = 0;
      if (hasNumbers(candidate.snippet)) {
        const srcNums = extractNumbers(html.substring(Math.max(0, m.index - 200), m.index + 200));
        const candNums = extractNumbers(candidate.snippet + " " + candidate.title);
        const shared = [...srcNums].filter((n) => candNums.has(n));
        sharedNumsCount = shared.length;
        if (shared.length > 0) score += 2;
        if (shared.length > 0) contentScore += 2;
      }

      // Snippet relevance
      if (candidate.snippet && candidate.snippet.length > 20) { score += 1; contentScore += 0.5; }

      // Same domain bonus
      const candDomain = urlDomain(candidate.url);
      if (candDomain === domain) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
        bestContentScore = contentScore;
      }
    }

    // Threshold: at least 4 total points AND at least 1 point from content similarity or number match
    if (bestCandidate && bestScore >= 4 && bestContentScore >= 1) {
      decisions.push({
        originalUrl: href,
        finalUrl: bestCandidate.url,
        decision: "replaced",
        reason: `Matched research candidate: "${bestCandidate.title}" (score ${bestScore.toFixed(1)})`,
        matchScore: Math.round(bestScore),
      });
    } else {
      decisions.push({
        originalUrl: href,
        finalUrl: href,
        decision: "preserved",
        reason: bestScore > 0
          ? `No suitable Chinese source (best score ${bestScore.toFixed(1)}, threshold 4)`
          : "No matching research candidate found",
        matchScore: Math.round(bestScore),
      });
    }
  }

  return decisions;
}

export function applySourceDecisions(html: string, decisions: SourceDecision[]): string {
  let result = html;
  for (const d of decisions) {
    if (d.originalUrl !== d.finalUrl) {
      // Replace href in anchor tags, preserving all other attributes
      const re = new RegExp(
        `(<a\\b[^>]*href\\s*=\\s*")${escapeRegex(d.originalUrl)}(")`,
        "gi",
      );
      result = result.replace(re, `$1${d.finalUrl}$2`);
    }
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Internal-link localisation ──

export interface InternalLinkDecision {
  originalUrl: string;
  finalUrl: string;
  hasChineseVersion: boolean;
  reason: string;
}

export function localiseInternalLinks(html: string, zhSlugs?: Set<string>): InternalLinkDecision[] {
  if (!zhSlugs || zhSlugs.size === 0) return [];
  const decisions: InternalLinkDecision[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*href="(\/blog\/[^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    // Extract the base slug (strip any -zh suffix if present)
    const path = href.replace(/\/$/, "");
    const baseSlug = path.replace(/^\/(?:blog\/)?/, "");
    const zhHref = `/blog/${baseSlug}-zh`;
    if (zhSlugs.has(baseSlug)) {
      decisions.push({
        originalUrl: href,
        finalUrl: zhHref,
        hasChineseVersion: true,
        reason: `Chinese version exists for "${baseSlug}"`,
      });
    } else {
      decisions.push({
        originalUrl: href,
        finalUrl: href,
        hasChineseVersion: false,
        reason: `No Chinese version for "${baseSlug}"`,
      });
    }
  }
  return decisions;
}

function applyInternalLinkDecisions(html: string, decisions: InternalLinkDecision[]): string {
  let result = html;
  for (const d of decisions) {
    if (d.originalUrl !== d.finalUrl) {
      const re = new RegExp(
        `(<a\\b[^>]*href\\s*=\\s*")${escapeRegex(d.originalUrl)}(")`,
        "gi",
      );
      result = result.replace(re, `$1${d.finalUrl}$2`);
    }
  }
  return result;
}

function applyLocalisations(
  html: string,
  sourceDecisions: SourceDecision[],
  internalLinkDecisions: InternalLinkDecision[],
): string {
  let result = html;
  for (const d of sourceDecisions) {
    if (d.originalUrl !== d.finalUrl) {
      const re = new RegExp(
        `(<a\\b[^>]*href\\s*=\\s*")${escapeRegex(d.originalUrl)}(")`,
        "gi",
      );
      result = result.replace(re, `$1${d.finalUrl}$2`);
    }
  }
  for (const d of internalLinkDecisions) {
    if (d.originalUrl !== d.finalUrl) {
      const re = new RegExp(
        `(<a\\b[^>]*href\\s*=\\s*")${escapeRegex(d.originalUrl)}(")`,
        "gi",
      );
      result = result.replace(re, `$1${d.finalUrl}$2`);
    }
  }
  return result;
}

// ── CTA translation ──

async function translateCtaBlock(cta: ProtectedArticleBlock, budget?: RetryBudget): Promise<ProtectedArticleBlock> {
  const messages: ChatMessage[] = [
    { role: "system", content: CTA_TRANSLATION_SYSTEM },
    { role: "user", content: cta.html },
  ];
  try {
  const result = await chatWithBudget(messages, { maxTokens: 512, temperature: 0.3 }, "cta", budget);
    let translated = result.content.trim();
    // Remove JSON wrapping if present
    try {
      const parsed = JSON.parse(translated);
      if (parsed.translatedHtml) translated = parsed.translatedHtml;
    } catch { /* plain text */ }
    // Verify signup URL preserved
    if (!translated.includes("app.b2ihub.com/signup")) {
      return cta;
    }
    return {
      ...cta,
      html: translated,
      fingerprint: fingerprintHtml(translated),
    };
  } catch {
    return cta;
  }
}

// ── FAQ extraction helpers ──

function extractFaqFromDoc(doc: ArticleDocument): FaqEntry[] {
  if (doc.visibleFaq.length > 0) return doc.visibleFaq;
  const faqSection = doc.sections.find((s) =>
    s.sectionType === "faq-heading" || /faq|frequently|常見|問題|問答|常見問題集/i.test(s.heading)
  );
  if (!faqSection || !faqSection.html) return [];
  return extractFaqFromHtml(faqSection.html);
}

function extractFaqFromHtml(html: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const qaRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>\s*(?:<\/p>\s*<!--\s*\/wp:paragraph\s*-->\s*<!--\s*wp:paragraph\s*-->\s*<p>)?\s*([\s\S]*?)(?=<strong\b|<h2\b|<!--\s*wp:heading|<!--\s*wp:html|$)/gi;
  let m;
  while ((m = qaRe.exec(html)) !== null) {
    const question = m[1].replace(/<[^>]+>/g, "").trim();
    const answerRaw = m[2].replace(/<\/p>\s*<!--\s*\/wp:paragraph\s*-->/i, "");
    const answerHtml = m[2].trim();
    const answerText = answerRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if ((question.endsWith("?") || question.endsWith("？")) && answerText.length > 10) {
      entries.push({ question, answerHtml, answerText });
    }
  }
  return entries;
}

async function translateFaqEntries(entries: FaqEntry[], budget?: RetryBudget): Promise<FaqEntry[]> {
  if (entries.length === 0) return [];
  const input = entries.map((e) => ({ question: e.question, answer: e.answerText }));
  let result = await chatWithBudget(
    [
      { role: "system", content: FAQ_QA_SYSTEM },
      { role: "user", content: JSON.stringify(input, null, 2) },
    ],
    { responseFormat: { type: "json_object" }, maxTokens: 4096, temperature: 0.3 },
    "faq",
    budget,
  );

  // Retry once with higher max_tokens if truncated
  if (result.finishReason === "length") {
    console.log("[faq] Response truncated (finish_reason=length) — retrying with max_tokens 2048");
    result = await chatWithBudget(
      [
        { role: "system", content: FAQ_QA_SYSTEM },
        { role: "user", content: JSON.stringify(input, null, 2) },
      ],
      { responseFormat: { type: "json_object" }, maxTokens: 2048, temperature: 0.3 },
      "faq-retry",
      budget,
    );
  }

  // Hard failure if still truncated — do not save partial FAQ
  if (result.finishReason === "length") {
    console.error("[faq] FAQ still truncated after retry — marking hard failure");
    throw new Error("FAQ truncated after retry");
  }

  const parsed = JSON.parse(result.content);
  const translated = Array.isArray(parsed) ? parsed : parsed.entries || parsed.faq || [];
  return translated.map((t: any, i: number) => ({
    question: t.question || entries[i]?.question || "",
    answerHtml: t.answer || entries[i]?.answerText || "",
    answerText: (t.answer || entries[i]?.answerText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
}

function buildFaqSchemaJson(entries: FaqEntry[]): string {
  const mainEntity = entries.map((e) => ({
    "@type": "Question",
    name: e.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: e.answerText,
    },
  }));
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity,
  };
  return JSON.stringify(schema, null, 2);
}

// ── System prompts ──

const TRANSLATION_SYSTEM = `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK).

Rules:
- Use Hong Kong Traditional Chinese characters (繁體中文)
- Use colloquial Hong Kong Cantonese phrasing where appropriate
- Use full-width punctuation （，。「」）
- Adapt idioms naturally for a Hong Kong audience
- Do NOT translate: brand names (B2I Hub, Threads, Instagram, Facebook, Meta, Google), URLs, code, statistics, proper nouns, numbers, dates
- Preserve ALL WordPress block comments and HTML structure exactly as-is
- Preserve all <a href="..."> links exactly — do not change any URL
- Do NOT add or remove content
- Translate the ENTIRE section completely — do NOT summarize or abbreviate`;

const TITLE_META_SYSTEM = `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK). Translate the following text to Traditional Chinese. Return ONLY the translated text, no JSON, no explanation.`;

const FAQ_QA_SYSTEM = `You are a professional translator. Translate each FAQ Q&A pair to Hong Kong Traditional Chinese. Return as JSON array:
[
  {"question": "translated question", "answer": "translated answer"}
]

Rules:
- Hong Kong Traditional Chinese only
- Use full-width punctuation
- Adapt idioms naturally for Hong Kong
- Do NOT translate brand names, URLs, statistics, proper nouns
- Keep question mark (？) at end of each question
- Do NOT add or remove Q&A pairs
- Translate every question and answer completely`;
