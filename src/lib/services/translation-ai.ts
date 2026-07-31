import { AiService, type ChatMessage } from "@/lib/services/deepseek";
import type { FaqEntry, ProtectedArticleBlock } from "@/lib/blog/article-document";
import type { RetryBudget } from "./translation-types";
import type { StructuredTranslationShadowOptions } from "./editorial-block-translation";
import { protectNumbersInHtml, tryRestoreNumbersInHtml, checkLinksPreserved, checkNoNewUrls, checkNumbersPreserved, extractLinks } from "./translation-validator";
import { buildTranslationGlossaryPrompt } from "./translation-glossary";

// ── Prompt constants ──

export const CTA_TRANSLATION_SYSTEM = `You are a professional translator. Translate ONLY the visible display text of this CTA button/section to Hong Kong Traditional Chinese.

Rules:
- Translate ONLY visible text — do NOT change any HTML tags, attributes, URLs, CSS, or WordPress comments
- Preserve the <a href="..."> signup URL exactly — do not change it
- Preserve all style attributes and class names
- Do NOT add, remove, or restructure any HTML elements
- Return the COMPLETE HTML with only the text content translated
- Hong Kong Traditional Chinese only
- Example: "Ready to grow your brand" → "準備好拓展你的品牌？"
- Example: "Get started" → "立即開始" or "馬上開始"
- Example: "Create your free profile" → "免費建立商業檔案"`;

export const TRANSLATION_SYSTEM = `You are a senior bilingual editor translating an English business blog into professional Hong Kong Traditional Chinese (zh-HK).

QUALITY STANDARD:
- Translate meaning, intent and emphasis faithfully; do not summarize, embellish or add facts.
- Write natural professional Hong Kong Traditional Chinese, not literal English sentence order.
- Keep the voice warm, direct and easy to read. Use spoken Cantonese particles only when they are genuinely natural for the brand voice; avoid slang-heavy copy.
- Use Traditional Chinese characters and full-width Chinese punctuation （，。「」！？）.
- Follow the canonical terminology glossary supplied in the prompt consistently across the whole article.
- Preserve temporal meaning exactly: historical facts stay historical, current status stays current, and predictions stay predictions. Never turn an old forecast into present guidance or introduce relative wording such as 「今年稍後」、「即將」 or 「未來幾個月」 unless the English source contains the same valid, date-anchored meaning.
- Prefer idiomatic written zh-HK: combine short English clauses naturally, avoid repeated pronouns and literal subject-first sentence patterns, and keep each paragraph's original purpose and tone.

IMMUTABLE CONTENT:
- Do NOT translate brand names (B2I Hub, Threads, Instagram, Facebook, Meta, Google), URLs, code, statistics, proper nouns, numbers or dates.
- Preserve every __NUM_N__ token exactly.
- Preserve ALL WordPress block comments and HTML structure exactly.
- Preserve all <a href="..."> URLs exactly.
- Do not add or remove paragraphs, list items, table cells, facts, examples, links or calls to action.
- Translate the complete supplied component.`;

export const TITLE_META_SYSTEM = `You are a senior Hong Kong Traditional Chinese editor. Translate faithfully into natural professional zh-HK. Preserve every number, date, proper noun, brand name and __NUM_N__ token exactly. Use Traditional Chinese and full-width punctuation. Return ONLY the translated text, with no JSON, markdown or explanation.`;

export const INTRO_RETRY_STRICT = `This is a quality-gate retry. The previous translation contained too much English.

You MUST translate 100% of this text to Hong Kong Traditional Chinese (zh-HK).

RULES (strict):
- EVERY sentence must be in Traditional Chinese
- NO English prose, NO English phrases, NO English explanations
- NO mixing English and Chinese within a sentence
- Brand names (B2I Hub, Threads, Instagram, Facebook, Meta, Google, YouTube) may remain in English
- URLs, proper nouns, and technical terms (SEO, ROI, CTR, API) may remain in English
- Numbers, percentages, dates and tokens like __NUM_0__, __NUM_1__ must be preserved exactly
- Use natural professional written Hong Kong Traditional Chinese; avoid literal English word order and excessive spoken particles
- Full-width punctuation （，。「」）
- Return ONLY the translated text — no JSON, no markdown, no explanation`;

export const STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM = `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK).

You are given a JSON object representing editorial content. Your task is to translate only the text values from English to natural Traditional Chinese for Hong Kong readers.

RULES:
- Translate ONLY values belonging to fields named "text".
- Preserve ALL JSON keys exactly — do not rename, add, or remove any key.
- Preserve "componentKind" exactly.
- Preserve every "type" value exactly.
- Preserve every "seq" value exactly.
- Preserve every "ordered" value exactly.
- Preserve every "linkRef" value exactly.
- Preserve every "__NUM_0__", "__NUM_1__", etc. token exactly — do not change, split, or remove them.
- Do NOT write any literal number alongside a __NUM_N__ placeholder. Every number in the output must be represented exclusively by its __NUM_N__ placeholder — no exceptions.
- Preserve the exact number of blocks, items, rows, cells, and inline nodes.
- Preserve block, item, row, cell, and inline-node order exactly.

OUTPUT REQUIREMENTS:
- Return exactly one valid JSON object.
- No prose before or after the JSON.
- No code fences.
- No Markdown formatting.
- No WordPress HTML.
- No HTML tags.

FURTHER RESTRICTIONS:
- Do not add CTA language, signup prompts, or call-to-action text.
- Do not add FAQ sections, question-answer pairs, or FAQ-related content.
- Do not change the structure of the JSON.
- Hong Kong Traditional Chinese only — use full-width punctuation （，。「」）.

Return ONLY the translated JSON object.`;

export const FAQ_QA_SYSTEM = `You are a professional Hong Kong Traditional Chinese translator. Translate exactly one FAQ question and answer.

Return exactly one valid JSON object in this shape:
{"question":"translated question？","answer":"translated answer"}

Rules:
- Hong Kong Traditional Chinese only; use full-width punctuation.
- Translate meaning faithfully and naturally. Do not summarize or add information.
- Preserve brand names, URLs, statistics, dates, proper nouns and every __NUM_N__ token exactly.
- Preserve historical/current/future tense and time framing exactly; do not introduce stale relative-time wording.
- Preserve any HTML tags and every href URL in the answer exactly.
- End the question with ？.
- Do not add CTA, conclusion, headings, FAQ schema or another Q&A pair.
- Return only the JSON object, with no markdown or explanation.`;

// ── AI instance ──

const ai = new AiService();

export function translationDateInstruction(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `PUBLICATION DATE: ${date}. Do not introduce expired predictions or unanchored relative-time wording. Preserve the source's historical/current/future meaning exactly.`;
}

// ── Budgeted AI call ──

/** Always make the first API attempt; cap only retries against the shared budget. */
export async function chatWithBudget(
  messages: ChatMessage[],
  options: Record<string, unknown>,
  component: string,
  budget?: RetryBudget,
): Promise<{ content: string; finishReason?: string }> {
  const requestedRetries = (options as any).maxRetries ?? 2;
  const maxRetries = budget ? budget.capRetries(requestedRetries) : requestedRetries;
  const requestOptions = { ...options, maxRetries };

  try {
    const result = await ai.chatWithRetry(messages, requestOptions as any, component);
    const actualRetries = result.attemptsUsed ?? 0;
    const budgetCutOff = maxRetries < requestedRetries;
    if (budget) budget.record(component, actualRetries, budgetCutOff);
    return { content: result.content, finishReason: result.finishReason };
  } catch (error) {
    if (budget) budget.record(component, maxRetries, true);
    throw error;
  }
}

// ── Translate helpers ──

export async function translateText(text: string, instruction: string, systemPrompt: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  if (!text || text.trim().length === 0) return text;
  const kpMsg = keyphrase ? ` The SEO focus keyphrase is "${keyphrase}". Include it naturally when the source context supports it; do not force or repeat it.` : "";
  const messages: ChatMessage[] = [
    { role: "system", content: `${systemPrompt}${kpMsg}

${translationDateInstruction()}

${buildTranslationGlossaryPrompt()}` },
    { role: "user", content: `${instruction}\n\n${text}` },
  ];
  const result = await chatWithBudget(messages, { maxTokens: 1024, temperature: 0.3 }, component || "translate-text", budget);
  if (result.finishReason === "length") throw new Error(`${component || "translate-text"} response was truncated`);
  const content = result.content.trim();
  if (!content) throw new Error(`${component || "translate-text"} returned empty content`);
  return content;
}

async function translateHtml(html: string, context: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  if (!html || html.trim().length === 0) return html;
  const kpMsg = keyphrase ? `

The SEO focus keyphrase is "${keyphrase}". Use it naturally only where the source context supports it.` : "";
  const messages: ChatMessage[] = [
    { role: "system", content: `${TRANSLATION_SYSTEM}${kpMsg}

${translationDateInstruction()}

${buildTranslationGlossaryPrompt()}` },
    { role: "user", content: `Translate this section to Traditional Chinese (Hong Kong):\n\nSection context: ${context}\n\n${html}` },
  ];
  const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, component || "translate-html", budget);
  if (result.finishReason === "length") throw new Error(`${component || "translate-html"} response was truncated`);
  const content = result.content.trim();
  if (!content) throw new Error(`${component || "translate-html"} returned empty content`);
  try {
    const parsed = JSON.parse(content);
    if (parsed.translatedHtml) return String(parsed.translatedHtml).trim();
  } catch { /* plain text */ }
  return content;
}

export async function translateSection(html: string, heading: string, prevHeading: string, nextHeading: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  return translateHtml(html, `Heading: "${heading}". Previous: "${prevHeading}". Next: "${nextHeading}"`, keyphrase, component, budget);
}

function protectedMarkupSignature(html: string): string[] {
  return [...html.matchAll(/<!--[^]*?-->|<[^>]+>/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim());
}

function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateProtectedHtmlTranslation(source: string, translated: string, label: string): void {
  if (!translated.trim()) throw new Error(`${label} returned empty content`);
  if (!sameSequence(protectedMarkupSignature(source), protectedMarkupSignature(translated))) {
    throw new Error(`${label} HTML structure or attributes changed`);
  }
  if (!sameSequence(extractLinks(source), extractLinks(translated))) {
    throw new Error(`${label} URLs changed`);
  }
  const numbers = checkNumbersPreserved(source, translated);
  if (numbers.lost.length > 0 || numbers.extras.length > 0) {
    throw new Error(`${label} numbers changed`);
  }
}

function deterministicCtaFallback(html: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/Ready to grow your brand with Hong Kong creators\?/gi, "準備好與香港創作者一同拓展品牌？"],
    [/B2I Hub connects businesses directly with verified creators — no agencies, no commissions, no middlemen\./gi, "B2I Hub 讓企業直接連繫已驗證創作者，毋須經代理、毋須支付佣金，亦沒有中間人。"],
    [/Create your free profile and start collaborating today\./gi, "立即建立免費檔案，開始尋找合作機會。"],
    [/Create Your Free Profile/gi, "建立免費檔案"],
    [/Get started/gi, "立即開始"],
    [/Sign up now/gi, "立即註冊"],
  ];
  let result = html;
  for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
  return result;
}

export async function translateCtaBlock(cta: ProtectedArticleBlock, budget?: RetryBudget): Promise<ProtectedArticleBlock> {
  const messages: ChatMessage[] = [
    { role: "system", content: CTA_TRANSLATION_SYSTEM },
    { role: "user", content: cta.html },
  ];
  try {
    const result = await chatWithBudget(messages, { maxTokens: 4096, temperature: 0.3 }, "cta", budget);
    let translated = result.content.trim();
    try {
      const parsed = JSON.parse(translated);
      if (parsed.translatedHtml) translated = parsed.translatedHtml;
    } catch { /* plain text */ }
    validateProtectedHtmlTranslation(cta.html, translated, "CTA");
    if (!translated.includes("app.b2ihub.com/signup")) throw new Error("CTA signup URL changed");
    if (!/[\u3400-\u9fff]/u.test(translated.replace(/<[^>]+>/g, " "))) throw new Error("CTA contains insufficient Chinese");
    return { ...cta, html: translated, fingerprint: fingerprintHtml(translated) };
  } catch {
    const translated = deterministicCtaFallback(cta.html);
    return { ...cta, html: translated, fingerprint: fingerprintHtml(translated) };
  }
}

function fingerprintHtml(html: string): string {
  let hash = 0;
  for (let i = 0; i < html.length; i++) { const c = html.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
  return hash.toString(16);
}

// ── Structured conclusion translation prompt builders ──

export function buildStructuredConclusionTranslationPrompt(payloadJson: string): string {
  return [
    `Translate this structured editorial JSON to Traditional Chinese for Hong Kong.`,
    `Only values inside fields named "text" may change.  All other fields must remain identical.`,
    `\n${payloadJson}\n`,
    `Return ONLY the translated JSON object. No prose, no code fences, no markdown, no HTML.`,
  ].join("\n");
}

const MAX_REPAIR_ERRORS = 5;
const MAX_ERROR_LENGTH = 200;

export function buildStructuredConclusionRepairPrompt(
  sourcePayloadJson: string,
  invalidResponse: string,
  errors: string[],
): string {
  const boundedErrors = errors.slice(0, MAX_REPAIR_ERRORS).map((e) => e.substring(0, MAX_ERROR_LENGTH));
  const hasNumberMismatch = errors.some((e) => e.includes("number mismatch"));
  const numberFix = hasNumberMismatch
    ? `\nNUMBER ERROR: The translation introduced or removed a number that is not represented by a __NUM_N__ placeholder. Every number in the output must come from a __NUM_N__ placeholder. Do NOT write any literal digits, years, percentages, currencies, or numeric words that are not already marked by a __NUM_N__ token. Translate the surrounding text but leave every __NUM_N__ token exactly as-is.`
    : "";
  return [
    `The previous structured editorial JSON response was invalid.`,
    `\nValidation errors:\n${boundedErrors.map((e) => `- ${e}`).join("\n")}`,
    numberFix,
    `\nOriginal protected source DTO:\n${sourcePayloadJson}`,
    `\nInvalid response received:\n${invalidResponse.substring(0, 2000)}`,
    `\nCorrect the response. Return ONLY the corrected JSON object.`,
    `Translate only "text" values. Preserve every other field, key, and structural element exactly.`,
    `No prose, no code fences, no markdown, no HTML.`,
  ].join("\n");
}

function validateFaqBoundary(
  source: FaqEntry,
  translatedQuestion: string,
  translatedAnswer: string,
  index: number,
): void {
  const q = translatedQuestion.trim();
  const a = translatedAnswer.trim();
  if (!q.endsWith("?") && !q.endsWith("？")) {
    throw new Error(`FAQ #${index + 1} question does not end with a question mark`);
  }
  if (/app\.b2ihub\.com\/signup/i.test(a)) throw new Error(`FAQ #${index + 1} answer contains signup URL`);
  if (/ready to grow|create your free|sign up now/i.test(a)) throw new Error(`FAQ #${index + 1} answer contains CTA text`);
  if (/^conclusion|in conclusion|to sum up|final thought/i.test(a)) throw new Error(`FAQ #${index + 1} answer contains conclusion text`);
  if (/"@type"\s*:\s*"faqpage"/i.test(a)) throw new Error(`FAQ #${index + 1} answer contains FAQPage schema`);
  if (/<h2\b|<\/h2>/i.test(a)) throw new Error(`FAQ #${index + 1} answer contains disallowed heading markup`);
  const sourceLen = (source.answerHtml || source.answerText || "").length || 1;
  if (a.length > sourceLen * 3) throw new Error(`FAQ #${index + 1} answer is more than 3x source length`);
}

export async function translateFaqEntry(
  entry: FaqEntry,
  index: number,
  budget?: RetryBudget,
): Promise<FaqEntry> {
  const protectedQuestion = protectNumbersInHtml(entry.question);
  const protectedAnswer = protectNumbersInHtml(entry.answerHtml || entry.answerText);
  const payload = JSON.stringify({
    question: protectedQuestion.protectedHtml,
    answer: protectedAnswer.protectedHtml,
  });
  const messages: ChatMessage[] = [
    { role: "system", content: `${FAQ_QA_SYSTEM}\n\n${buildTranslationGlossaryPrompt()}\nReturn exactly one JSON object with keys question and answer.` },
    { role: "user", content: payload },
  ];

  let translatedQuestion = "";
  let translatedAnswer = "";
  let structuredFailure: unknown = null;

  for (const [component, options, extra] of [
    [`faq-${index + 1}`, { responseFormat: { type: "json_object" }, maxTokens: 3072, temperature: 0.25 }, ""],
    [`faq-${index + 1}-plain`, { maxTokens: 3072, temperature: 0.2, maxRetries: 1 }, "Return only valid JSON. No markdown or explanation."],
  ] as const) {
    try {
      const result = await chatWithBudget(
        extra ? [...messages, { role: "user", content: extra }] : messages,
        options,
        component,
        budget,
      );
      if (result.finishReason === "length") throw new Error(`FAQ #${index + 1} response was truncated`);
      const cleaned = result.content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      translatedQuestion = String(parsed.question || parsed.entries?.[0]?.question || "").trim();
      translatedAnswer = String(parsed.answer || parsed.entries?.[0]?.answer || "").trim();
      if (!translatedQuestion || !translatedAnswer) throw new Error(`FAQ #${index + 1} returned empty content`);
      validateFaqBoundary(entry, translatedQuestion, translatedAnswer, index);
      break;
    } catch (error) {
      structuredFailure = error;
      translatedQuestion = "";
      translatedAnswer = "";
    }
  }

  // Last-resort component recovery: translate the question and answer
  // independently. An intermittent empty JSON response must not discard the
  // whole FAQ set or prevent the remaining article components from running.
  if (!translatedQuestion || !translatedAnswer) {
    try {
      translatedQuestion = await translateText(
        protectedQuestion.protectedHtml,
        "Translate this FAQ question completely to natural Hong Kong Traditional Chinese. End with ？ and return only the question.",
        TITLE_META_SYSTEM,
        undefined,
        `faq-${index + 1}-question-fallback`,
        budget,
      );
      translatedAnswer = await translateText(
        protectedAnswer.protectedHtml,
        "Translate this FAQ answer completely to natural Hong Kong Traditional Chinese. Preserve all HTML tags and href URLs exactly. Return only the answer.",
        TRANSLATION_SYSTEM,
        undefined,
        `faq-${index + 1}-answer-fallback`,
        budget,
      );
    } catch (error) {
      throw new Error(
        `FAQ #${index + 1} translation failed after structured and component fallbacks: ${error instanceof Error ? error.message : String(error)}; initial=${structuredFailure instanceof Error ? structuredFailure.message : String(structuredFailure)}`,
      );
    }
  }

  const questionRestore = tryRestoreNumbersInHtml(
    translatedQuestion,
    protectedQuestion.placeholders,
    protectedQuestion.originalValues,
  );
  const answerRestore = tryRestoreNumbersInHtml(
    translatedAnswer,
    protectedAnswer.placeholders,
    protectedAnswer.originalValues,
  );
  if (!questionRestore.ok || !answerRestore.ok) {
    throw new Error(`FAQ #${index + 1} failed deterministic number restoration`);
  }

  const question = questionRestore.html.trim().replace(/\?$/u, "？");
  const answerHtml = answerRestore.html;
  validateFaqBoundary(entry, question, answerHtml, index);

  const sourceAnswerHtml = entry.answerHtml || entry.answerText;
  const sourceHtml = `${entry.question}
${sourceAnswerHtml}`;
  const translatedHtml = `${question}
${answerHtml}`;
  const lostLinks = checkLinksPreserved(sourceHtml, translatedHtml);
  const newLinks = checkNoNewUrls(sourceHtml, translatedHtml);
  if (lostLinks.length > 0 || newLinks.length > 0 || !sameSequence(extractLinks(sourceHtml), extractLinks(translatedHtml))) {
    throw new Error(`FAQ #${index + 1} changed URLs`);
  }
  if (!sameSequence(protectedMarkupSignature(sourceAnswerHtml), protectedMarkupSignature(answerHtml))) {
    throw new Error(`FAQ #${index + 1} answer HTML structure changed`);
  }
  const faqNumbers = checkNumbersPreserved(sourceHtml, translatedHtml);
  if (faqNumbers.lost.length > 0 || faqNumbers.extras.length > 0) {
    throw new Error(`FAQ #${index + 1} changed numbers`);
  }

  return {
    question,
    answerHtml,
    answerText: answerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

/**
 * Translate FAQ entries independently. One malformed or empty model response no
 * longer discards already valid entries or allows the model to change FAQ count
 * and order in one large all-or-nothing response.
 */
export async function translateFaqEntries(entries: FaqEntry[], budget?: RetryBudget): Promise<FaqEntry[]> {
  const translated: FaqEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    translated.push(await translateFaqEntry(entries[index], index, budget));
  }
  return translated;
}

// ── Shared production callback factory ──

export function createProductionConclusionStructuredShadowOptions(
  budget?: RetryBudget,
): StructuredTranslationShadowOptions {
  return {
    enabled: true,
    translatePayload: async (payloadJson) => {
      const messages: ChatMessage[] = [
        { role: "system", content: STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM },
        { role: "user", content: buildStructuredConclusionTranslationPrompt(payloadJson) },
      ];
      const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, "conc-shadow", budget);
      return result.content;
    },
    repairPayload: async (sourcePayloadJson, invalidResponse, errors) => {
      const repairPrompt = buildStructuredConclusionRepairPrompt(sourcePayloadJson, invalidResponse, errors);
      const messages: ChatMessage[] = [
        { role: "system", content: STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM },
        { role: "user", content: repairPrompt },
      ];
      try {
        const result = await chatWithBudget(messages, { maxTokens: 8192, temperature: 0.3 }, "conc-shadow-repair", budget);
        return result.content;
      } catch {
        return null;
      }
    },
  };
}
