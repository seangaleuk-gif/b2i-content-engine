// ── zh-HK style contract (Traditional Chinese register) ──
//
// Compiles the canonical B2I Hub Brand Voice into the structured style guidance
// consumed by the Traditional Chinese translation + editorial pipeline:
//   - a compact profile for the 7 coherent translation calls;
//   - compact brand principles + source-fidelity/terminology rules for the
//     bilingual editorial A/B calls;
//   - the full approved Traditional Chinese register guidance for the monolingual
//     proofreader (through ZhHkStyleContract).
//
// English-only rules (contractions, the English forbidden-word list) are kept out
// of the Cantonese grammar guidance. Optional Cantonese sayings never override
// clarity, factual accuracy or professional register.

import {
  BRAND_VOICE_DEFAULT,
  BRAND_VOICE_VERSION,
  hashBrandVoice,
  isBlankBrandVoice,
  isCanonicalBrandVoice,
  resolveBrandVoice,
} from "./brand-voice";

/** Compact profile injected into the 7 coherent translation calls. */
export const TRANSLATION_BRAND_PROFILE = `B2I Hub Brand Voice (compact):
- Warm and honest; confident but humble.
- Simple, practical everyday language — prefer familiar words over jargon.
- Write in professional conversational Hong Kong Cantonese for a business blog.
- No Mandarin-style formal written Chinese.
- No literal English sentence structures.
- No excessive slang or group-chat language.
- Avoid unnecessary English code-switching when a natural Cantonese term exists.`;

/** Compact brand principles + source-fidelity/terminology rules for bilingual editorial A/B. */
export const BILINGUAL_BRAND_PRINCIPLES = `B2I Hub Brand Voice principles:
- Warm and honest; confident but humble; conversational.
- Clarity and professionalism come first; local flavour second.
- Use natural Hong Kong Cantonese with one consistent professional conversational register.
- Prefer familiar everyday words; explain any necessary marketing terms clearly.
- Keep source fidelity: never change facts, numbers, URLs, brands, claims, comparison or structure.
- Keep approved terminology consistent (see the terminology policy).
- Avoid unnecessary English code-switching when a natural Cantonese term exists.`;

/** Full approved Traditional Chinese (zh-HK) register guidance for the monolingual proofreader. */
export const MONOLINGUAL_REGISTER_GUIDANCE = `## Chinese Content — Traditional Chinese for Hong Kong

Write in professional conversational Hong Kong Cantonese suitable for creators, SMEs and business readers.

The writing should sound like a knowledgeable Hong Kong business owner explaining something clearly over coffee. It should feel natural and friendly, but still polished enough for a professional blog.

### Required style

- Use natural Hong Kong Cantonese grammar, phrasing and rhythm.
- Address the reader naturally with 「你」.
- Use common Cantonese wording such as 「嘅」、「喺」、「唔」、「冇」、「佢哋」 and 「咁」 where appropriate.
- Prefer clear, familiar Hong Kong vocabulary.
- Keep the tone warm, practical and grounded.
- Maintain one consistent professional conversational register throughout the article.

### Avoid

- Mandarin-style formal written Chinese.
- Literal English sentence structures.
- Mainland corporate wording.
- Excessive slang or group-chat language.
- Forced Cantonese expressions added only to sound local.
- Unnecessary English code-switching when a natural Cantonese term exists.
- Mixing highly formal written Chinese with casual Cantonese in the same passage.

### Register standard

Aim for natural professional Cantonese—not a legal document, not Mainland corporate copy and not a casual WhatsApp conversation.

Clarity and professionalism come first. Local flavour comes second.

Cantonese sayings may be used occasionally when they genuinely strengthen the point. Do not force them into the writing or repeat them excessively.

Examples:

- 「合作最緊要夾。」
- 「慢慢嚟，比較快。」
- 「有麝自然香。」`;

/**
 * The structured Traditional Chinese style contract compiled from the Brand Voice.
 * Same structure is consumed by the translation calls, bilingual editorial A/B and
 * the monolingual proofreader, each reading the stage-appropriate field.
 */
export interface ZhHkStyleRule {
  id: string;
  severity: "hard" | "advisory";
  category: string;
  instruction: string;
}

export interface ZhHkStyleExample {
  label: string;
  text: string;
}

export interface ZhHkStyleContract {
  /** Style-contract version. */
  version: string;
  brandVoiceVersion: string;
  brandVoiceHash: string;
  register: "professional-conversational-hk-cantonese";
  hardRules: readonly ZhHkStyleRule[];
  advisoryRules: readonly ZhHkStyleRule[];
  preferredTerms: ReadonlyMap<string, string>;
  avoidedTerms: ReadonlyMap<string, string>;
  allowedEnglishTerms: ReadonlySet<string>;
  avoidableEnglishTerms: ReadonlyMap<string, string>;
  sourceDisplayRules: readonly ZhHkStyleRule[];
  positiveExamples: readonly ZhHkStyleExample[];
  negativeExamples: readonly ZhHkStyleExample[];
  /** True when the effective Brand Voice is the canonical default. */
  usedDefault: boolean;
  /** Compact profile for the 7 coherent translation calls. */
  translationProfile: string;
  /** Compact brand principles + source-fidelity/terminology for bilingual editorial A/B. */
  bilingualPrinciples: string;
  /** Full approved zh-HK register guidance for the monolingual proofreader. */
  monolingualRegister: string;
}

export const ZH_HK_STYLE_CONTRACT_VERSION = "b2i-zh-hk-style-contract-v1";

// ── Canonical rule data (reusable rule IDs, never full-sentence replacements) ──

export const ZH_HK_HARD_RULES: readonly ZhHkStyleRule[] = [
  { id: "mainland-register", severity: "hard", category: "formal-register", instruction: "Replace the Mainland/formal term with its natural Hong Kong Cantonese form (e.g. 越來越 → 越嚟越, 正在 → 而家正, 儘管 → 雖然, 在於 → 重點係, 人口群組 → 目標客群)." },
  { id: "mixed-register", severity: "hard", category: "language", instruction: "Do not mix formal written Chinese with conversational Cantonese in the same sentence." },
  { id: "avoidable-code-switching", severity: "hard", category: "unnecessary-code-switching", instruction: "Replace the avoidable English word with its natural Cantonese term (post → 貼文, followers → 粉絲, engagement → 互動, campaign → 推廣活動, agency → 代理公司／市場推廣公司)." },
  { id: "unnatural-terminology", severity: "hard", category: "terminology-inconsistency", instruction: "Replace the unnatural term with the approved preferred wording (see terminology)." },
  { id: "excessive-slang", severity: "hard", category: "language", instruction: "Replace slang that weakens the professional business tone with a natural, credible Cantonese equivalent." },
  { id: "literal-english-syntax", severity: "hard", category: "literal-structure", instruction: "Rewrite the English-derived sentence structure into natural Cantonese sentence order." },
  { id: "malformed-cantonese", severity: "hard", category: "language", instruction: "Complete or fix the malformed/incomplete Cantonese sentence." },
  { id: "source-publisher-slug", severity: "hard", category: "source", instruction: "Use the approved publisher name; never display a hostname-derived slug." },
  { id: "unlocalized-source-title", severity: "hard", category: "source", instruction: "Localize the source title into natural Traditional Chinese; keep the href unchanged." },
];

export const ZH_HK_ADVISORY_RULES: readonly ZhHkStyleRule[] = [
  { id: "formal-transition", severity: "advisory", category: "formal-register", instruction: "Prefer a conversational Cantonese transition over a formal written-Chinese one." },
  { id: "robotic-connective", severity: "advisory", category: "language", instruction: "Vary repeated connectives (e.g. 同時) to avoid robotic repetition." },
  { id: "mild-slang", severity: "advisory", category: "language", instruction: "Keep mild conversational Cantonese in moderation; do not overuse it." },
  { id: "minor-rhythm", severity: "advisory", category: "language", instruction: "Improve minor rhythm and pacing issues for a natural flow." },
  { id: "occasional-formal-word", severity: "advisory", category: "formal-register", instruction: "Use the natural conversational word where a formal word is unnecessary." },
];

// ── Canonical terminology policy (deterministic preferred/avoided terms) ──

export const ZH_HK_PREFERRED_TERMS: ReadonlyMap<string, string> = new Map([
  ["engaged followers", "互動活躍嘅粉絲"],
  ["follower base", "粉絲群"],
  ["large creator", "大型創作者"],
  ["well-known creator", "知名創作者"],
  ["creator marketing agency", "創作者市場推廣公司"],
  ["agency", "代理公司"],
  ["sponsored post", "贊助貼文"],
  ["scale what works", "將有效嘅做法逐步擴大"],
  ["data-driven targeting", "用數據搵出最合適嘅目標客群"],
  ["over-controlling content", "對內容控制得太嚴"],
]);

/** Unnatural term markers (reusable signals, not replacements). */
export const ZH_HK_AVOIDED_TERM_MARKERS: readonly string[] = [
  "投入互動粉絲",
  "追蹤群",
  "大名字",
  "活動廣告板",
  "追住最大嘅名氣",
  "擴大做得好嘅嘢",
  "針對啱嘅人口群組",
  "太控制慾強",
  "同一個真實嘅聲音合作",
];

/**
 * Deterministic mapping from every avoided-term marker to its approved preferred
 * wording, where ONE safe replacement exists. Context-dependent phrases (大名字,
 * 活動廣告板, 同一個真實嘅聲音合作) have no universal single replacement and are
 * intentionally omitted: they are delivered with only a rewrite instruction so the
 * proofreader can judge the intended meaning. Never perform blind replacements.
 */
export const ZH_HK_AVOIDED_TO_PREFERRED: ReadonlyMap<string, string> = new Map([
  ["投入互動粉絲", "互動活躍嘅粉絲"],
  ["追蹤群", "粉絲群"],
  ["追住最大嘅名氣", "只追求知名度"],
  ["擴大做得好嘅嘢", "將有效嘅做法逐步擴大"],
  ["針對啱嘅人口群組", "搵出最合適嘅目標客群"],
  ["太控制慾強", "對內容控制得太嚴"],
]);

/** Approved preferred replacement for a matched avoided phrase, when a single safe one exists. */
export function preferredReplacementFor(matchedPhrase: string | undefined): string | undefined {
  if (!matchedPhrase) return undefined;
  return ZH_HK_AVOIDED_TO_PREFERRED.get(matchedPhrase);
}

/**
 * Build a compact avoided→preferred terminology section for a given set of unit
 * texts. When `includeAll` is set (or no texts are supplied) every marker with a
 * safe replacement is included; otherwise only markers actually present in the
 * texts. Returns "" when there is no preferred wording to show, so the instruction
 * "Use the approved preferred wording." can never appear without a real mapping.
 */
export function buildAvoidedTerminologyGuidance(
  texts: readonly string[],
  opts: { includeAll?: boolean } = {},
): string {
  const joined = texts.join("\n");
  const lines: string[] = [];
  for (const marker of ZH_HK_AVOIDED_TERM_MARKERS) {
    if (!opts.includeAll && !joined.includes(marker)) continue;
    const preferred = ZH_HK_AVOIDED_TO_PREFERRED.get(marker);
    if (preferred) lines.push(`- ${marker} → ${preferred}`);
  }
  if (lines.length === 0) return "";
  return [
    "PREFERRED HONG KONG TERMINOLOGY (avoid the left form; use the approved right form):",
    ...lines,
    "Use the approved preferred wording.",
  ].join("\n");
}

// ── Code-switching policy ──

export const ZH_HK_ALLOWED_ENGLISH_TERMS: ReadonlySet<string> = new Set([
  "B2I Hub", "Instagram", "YouTube", "TikTok", "Threads", "WeChat", "Reel", "KPI", "B2C", "KOL",
]);

export const ZH_HK_AVOIDABLE_ENGLISH_TERMS: ReadonlyMap<string, string> = new Map([
  ["post", "貼文"],
  ["followers", "粉絲"],
  ["engagement", "互動"],
  ["campaign", "推廣活動"],
  ["agency", "代理公司／市場推廣公司"],
]);

// ── Source display rules ──

export const ZH_HK_SOURCE_DISPLAY_RULES: readonly ZhHkStyleRule[] = [
  { id: "source-publisher-slug", severity: "hard", category: "source", instruction: "Use the approved publisher name; never display a hostname-derived slug." },
  { id: "source-consistent-separator", severity: "hard", category: "source", instruction: "Use one consistent separator (來源：本地化標題 — Publisher)." },
  { id: "source-no-duplicate-publisher", severity: "hard", category: "source", instruction: "Never repeat the publisher name." },
];

export const ZH_HK_POSITIVE_EXAMPLES: readonly ZhHkStyleExample[] = [
  { label: "natural Hong Kong Cantonese", text: "合作最緊要夾。" },
  { label: "calm, grounded", text: "慢慢嚟，比較快。" },
  { label: "quality speaks", text: "有麝自然香。" },
  { label: "clear and warm", text: "AI 幫品牌更加個人噉同客戶傾偈，創作者建立信任嘅方式係傳統廣告好難做到嘅。" },
];

export const ZH_HK_NEGATIVE_EXAMPLES: readonly ZhHkStyleExample[] = [
  { label: "Mainland/formal register", text: "香港市場行銷格局嘅迅速演變，需要轉向以 AI 驅動嘅個人化。" },
  { label: "avoidable code-switching", text: "出 post 同追蹤 followers。" },
  { label: "literal English structure", text: "觀眾會獎勵嗰啲創作者。" },
];

/** Compile a Brand Voice (or null/blank → canonical default) into a ZhHkStyleContract. */
export function buildZhHkStyleContract(brandVoice: string | null | undefined): ZhHkStyleContract {
  const effective = resolveBrandVoice(brandVoice);
  return {
    version: ZH_HK_STYLE_CONTRACT_VERSION,
    brandVoiceVersion: BRAND_VOICE_VERSION,
    brandVoiceHash: hashBrandVoice(effective),
    register: "professional-conversational-hk-cantonese",
    hardRules: ZH_HK_HARD_RULES,
    advisoryRules: ZH_HK_ADVISORY_RULES,
    preferredTerms: ZH_HK_PREFERRED_TERMS,
    avoidedTerms: new Map(ZH_HK_AVOIDED_TERM_MARKERS.map((t) => [t, preferredReplacementFor(t) ?? t])),
    allowedEnglishTerms: ZH_HK_ALLOWED_ENGLISH_TERMS,
    avoidableEnglishTerms: ZH_HK_AVOIDABLE_ENGLISH_TERMS,
    sourceDisplayRules: ZH_HK_SOURCE_DISPLAY_RULES,
    positiveExamples: ZH_HK_POSITIVE_EXAMPLES,
    negativeExamples: ZH_HK_NEGATIVE_EXAMPLES,
    usedDefault: isCanonicalBrandVoice(effective),
    translationProfile: TRANSLATION_BRAND_PROFILE,
    bilingualPrinciples: BILINGUAL_BRAND_PRINCIPLES,
    monolingualRegister: MONOLINGUAL_REGISTER_GUIDANCE,
  };
}

export { isBlankBrandVoice, isCanonicalBrandVoice, resolveBrandVoice, BRAND_VOICE_DEFAULT, BRAND_VOICE_VERSION };

