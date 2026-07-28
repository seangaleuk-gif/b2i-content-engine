import { AiService, type ChatMessage } from "@/lib/services/deepseek";
import type { FaqEntry, ProtectedArticleBlock } from "@/lib/blog/article-document";
import type { RetryBudget } from "./translation-types";
import type { StructuredTranslationShadowOptions } from "./editorial-block-translation";

// ── Prompt constants ──

export const CTA_TRANSLATION_SYSTEM = `You are a professional translator. Translate ONLY the visible display text of this CTA button/section to Hong Kong Traditional Chinese.

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

export const TRANSLATION_SYSTEM = `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK).

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

export const TITLE_META_SYSTEM = `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK). Translate the following text to Traditional Chinese. Return ONLY the translated text, no JSON, no explanation.`;

export const INTRO_RETRY_STRICT = `This is a quality-gate retry. The previous translation contained too much English.

You MUST translate 100% of this text to Hong Kong Traditional Chinese (zh-HK).

RULES (strict):
- EVERY sentence must be in Traditional Chinese
- NO English prose, NO English phrases, NO English explanations
- NO mixing English and Chinese within a sentence
- Brand names (B2I Hub, Threads, Instagram, Facebook, Meta, Google, YouTube) may remain in English
- URLs, proper nouns, and technical terms (SEO, ROI, CTR, API) may remain in English
- Numbers, percentages, dates and tokens like __NUM_0__, __NUM_1__ must be preserved exactly
- Hong Kong Cantonese phrasing preferred
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

export const FAQ_QA_SYSTEM = `You are a professional translator. Translate each FAQ Q&A pair to Hong Kong Traditional Chinese. Return as JSON array:
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

// ── AI instance ──

const ai = new AiService();

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
  (options as any).maxRetries = maxRetries;

  try {
    const result = await ai.chatWithRetry(messages, options as any);
    const actualRetries = result.attemptsUsed ?? 0;
    const budgetCutOff = maxRetries < requestedRetries;
    if (budget) budget.record(component, actualRetries, budgetCutOff);
    return { content: result.content, finishReason: result.finishReason };
  } catch (error) {
    if (budget) budget.record(component, requestedRetries, true);
    throw error;
  }
}

// ── Translate helpers ──

export async function translateText(text: string, instruction: string, systemPrompt: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
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

export async function translateSection(html: string, heading: string, prevHeading: string, nextHeading: string, keyphrase?: string, component?: string, budget?: RetryBudget): Promise<string> {
  return translateHtml(html, `Heading: "${heading}". Previous: "${prevHeading}". Next: "${nextHeading}"`, keyphrase, component, budget);
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
    if (!translated.includes("app.b2ihub.com/signup")) return cta;
    return { ...cta, html: translated, fingerprint: fingerprintHtml(translated) };
  } catch {
    return cta;
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

export async function translateFaqEntries(entries: FaqEntry[], budget?: RetryBudget): Promise<FaqEntry[]> {
  if (entries.length === 0) return [];
  const input = entries.map((e) => ({ question: e.question, answer: e.answerText }));
  const inputStr = JSON.stringify(input, null, 2);
  const inputTokens = Math.ceil(inputStr.length / 4);
  const outputBudget = Math.min(8192, Math.max(4096, inputTokens * 2));

  const result = await chatWithBudget(
    [
      { role: "system", content: FAQ_QA_SYSTEM },
      { role: "user", content: inputStr },
    ],
    { responseFormat: { type: "json_object" }, maxTokens: outputBudget, temperature: 0.3 },
    "faq",
    budget,
  );

  if (result.finishReason === "length") {
    // Never parse or save a truncated FAQ response. A truncated FAQ means
    // some entries were cut off — the output is unusable.
    throw new Error(`FAQ truncated at ${result.content.length} chars (max_tokens=${outputBudget}). Marking hard failure.`);
  }

  const parsed = JSON.parse(result.content);
  const translated = Array.isArray(parsed) ? parsed : parsed.entries || parsed.faq || [];

  // Validate exact source count before any processing
  if (translated.length !== entries.length) {
    throw new Error(`FAQ count mismatch: ${translated.length} translated vs ${entries.length} source`);
  }

  // Validate FAQ boundaries: reject output containing conclusion, CTA, signup, or a second FAQ schema
  const signupRe = /app\.b2ihub\.com\/signup/i;
  const ctaHeadRe = /ready to grow|create your free|sign up now/i;
  const conclHeadRe = /^conclusion|in conclusion|to sum up|let'?s wrap|final thought/i;
  const faqSchemaRe = /"@type"\s*:\s*"faqpage"/i;
  const headingRe = /<h2\b|<\/h2>/i;
  const strongRe = /<strong\b[^>]*>/i;

  for (let i = 0; i < translated.length; i++) {
    const entry = translated[i];
    const q = (entry.question || "").trim();
    const a = (entry.answer || "").trim();

    if (!q.endsWith("?") && !q.endsWith("？")) throw new Error(`FAQ #${i+1} question "${q.substring(0, 30)}..." does not end with ?`);

    // Answer boundary checks
    const aLower = a.toLowerCase();
    if (signupRe.test(aLower)) throw new Error(`FAQ #${i+1} answer contains signup URL`);
    if (ctaHeadRe.test(aLower)) throw new Error(`FAQ #${i+1} answer contains CTA button/heading text`);
    if (conclHeadRe.test(aLower)) throw new Error(`FAQ #${i+1} answer contains conclusion text`);
    if (faqSchemaRe.test(aLower)) throw new Error(`FAQ #${i+1} answer contains FAQPage schema`);
    if (headingRe.test(a)) throw new Error(`FAQ #${i+1} answer contains HTML heading markup`);
    if (strongRe.test(a)) throw new Error(`FAQ #${i+1} answer contains duplicated visible FAQ markup`);

    // Reject answer disproportionately longer than source (>3x source length)
    const sourceLen = entries[i]?.answerText?.length || 1;
    if (a.length > sourceLen * 3) throw new Error(`FAQ #${i+1} answer ${a.length} chars is >3x source ${sourceLen} chars`);
  }

  return translated.map((t: any, i: number) => ({
    question: t.question || entries[i]?.question || "",
    answerHtml: t.answer || entries[i]?.answerText || "",
    answerText: (t.answer || entries[i]?.answerText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
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
