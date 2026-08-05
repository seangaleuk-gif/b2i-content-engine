// ── Versioned Cantonese style examples for the translation prompt ──
//
// A small, version-controlled set of approved English-to-Hong-Kong-Traditional-Chinese
// style examples. They teach general translation CATEGORIES (how to render an idiom,
// a literal English structure, a professional vs slangy register, spoken Cantonese
// mixed with formal Chinese, a one-size-fits-all expression, and agency/creator or
// marketing/analytics terminology), not exact article sentences. They are STYLE
// GUIDANCE, not mandatory replacements — the model translates surrounding grammar
// according to context while keeping genuine brand and platform names.

export const CANTONESE_STYLE_EXAMPLES_VERSION = "2026.08.03.v1";

export type CantoneseExampleCategory =
  | "english-idiom"
  | "literal-structure"
  | "professional-vs-slang"
  | "spoken-vs-formal"
  | "one-size-fits-all"
  | "agency-creator-term"
  | "marketing-analytics";

export interface CantoneseStyleExample {
  category: CantoneseExampleCategory;
  english: string;
  chinese: string;
}

/** All approved example categories, in display order. */
export const CANTONESE_EXAMPLE_CATEGORIES: CantoneseExampleCategory[] = [
  "english-idiom",
  "literal-structure",
  "professional-vs-slang",
  "spoken-vs-formal",
  "one-size-fits-all",
  "agency-creator-term",
  "marketing-analytics",
];

/** Category label shown in the prompt (teaches the general mistake class). */
export const CANTONESE_CATEGORY_LABELS: Record<CantoneseExampleCategory, string> = {
  "english-idiom": "English idioms — translate by intended meaning, not word-for-word",
  "literal-structure": "Literal English sentence structures — rewrite as natural Cantonese",
  "professional-vs-slang": "Professional versus slang-heavy wording — stay professional",
  "spoken-vs-formal": "Spoken Cantonese mixed with formal written Chinese — keep it conversational",
  "one-size-fits-all": "One-size-fits-all expressions — express the idea naturally",
  "agency-creator-term": "Agency and creator terminology — use the canonical terms",
  "marketing-analytics": "Marketing and analytics language — use the canonical terms",
};

export const CANTONESE_STYLE_EXAMPLES: CantoneseStyleExample[] = [
  // ── English idioms ──
  { category: "english-idiom", english: "word of mouth", chinese: "口碑" },
  { category: "english-idiom", english: "the tip of the iceberg", chinese: "冰山一角" },
  // ── Literal sentence structures ──
  { category: "literal-structure", english: "That is why creator marketing matters.", chinese: "正因為咁，創作者市場推廣先至咁重要。" },
  { category: "literal-structure", english: "If you are ready to start now, you can begin with a small group of creators who already love your brand.", chinese: "如果你想而家開始，可以由一小群已經鍾意你品牌嘅創作者入手。" },
  // ── Professional versus slang ──
  { category: "professional-vs-slang", english: "the post went viral across Hong Kong", chinese: "呢個貼文喺香港引起廣泛關注" },
  { category: "professional-vs-slang", english: "a huge following", chinese: "大量忠實粉絲" },
  // ── Spoken Cantonese mixed with formal Chinese ──
  { category: "spoken-vs-formal", english: "The key is choosing the right partner.", chinese: "最緊要係揀啱合作夥伴。" },
  { category: "spoken-vs-formal", english: "However, these numbers show…", chinese: "不過，呢啲數字顯示…" },
  // ── One-size-fits-all expressions ──
  { category: "one-size-fits-all", english: "scale what works", chinese: "將有效嘅做法逐步擴大" },
  { category: "one-size-fits-all", english: "there is no one-size-fits-all approach", chinese: "冇一套方法適合所有情況" },
  // ── Agency and creator terminology ──
  { category: "agency-creator-term", english: "an influencer-marketing agency", chinese: "一間創作者市場推廣公司" },
  { category: "agency-creator-term", english: "work with micro-creators", chinese: "同微型創作者合作" },
  // ── Marketing and analytics language ──
  { category: "marketing-analytics", english: "track engagement over six months", chinese: "衡量六個月內嘅互動率" },
  { category: "marketing-analytics", english: "raise brand awareness", chinese: "提升品牌知名度" },
  { category: "marketing-analytics", english: "data-driven audience targeting", chinese: "用數據搵出最合適嘅目標客群" },
];

/** Reusable translation principles with no single literal target (rewrite per context). */
export const CANTONESE_STYLE_PRINCIPLES: Array<{ english: string; guidance: string }> = [
  { english: "owned brand power", guidance: "rewrite according to context rather than producing 自有品牌力量 (e.g. 品牌本身嘅影響力 or a natural equivalent)." },
  { english: "voices that feel like home", guidance: "rewrite as natural ideas such as familiar, trustworthy or relatable voices, not literal family/home imagery." },
  { english: "that is why", guidance: "use varied natural Cantonese connectives (e.g. 正因為咁 / 所以先會 / 正係呢個原因) according to context, rather than repeatedly generating 所以就係點解." },
];

/** Mixed forms to avoid (guidance, not a fatal blacklist). */
export const CANTONESE_STYLE_AVOID = [
  "喺美容品牌度 work",
  "nice-to-have",
  "對齊目標",
  "令所有人老實啲",
  "從你嘅努力中學習",
  "沿途優化表現",
  "最終帶嚟忠誠度",
  "自有品牌力量",
  "擴大做得好嘅嘢",
  "活動廣告板",
];

/** Render the example set as prompt guidance text, grouped by general category. */
export function buildCantoneseStyleExamplePrompt(): string {
  const lines: string[] = [];
  for (const category of CANTONESE_EXAMPLE_CATEGORIES) {
    const examples = CANTONESE_STYLE_EXAMPLES.filter((e) => e.category === category);
    if (examples.length === 0) continue;
    lines.push(`- [${CANTONESE_CATEGORY_LABELS[category]}]`);
    for (const e of examples) lines.push(`    - ${e.english} → ${e.chinese}`);
  }
  const principleLines = CANTONESE_STYLE_PRINCIPLES.map((p) => `- ${p.english}: ${p.guidance}`);
  const avoidLines = CANTONESE_STYLE_AVOID.map((a) => `- ${a}`);
  return [
    `STYLE EXAMPLES (v${CANTONESE_STYLE_EXAMPLES_VERSION}; general guidance, not mandatory replacements):`,
    "These teach how to translate common English constructions as natural Hong Kong Cantonese while keeping brand and platform names:",
    ...lines,
    "",
    "Reusable translation principles (rewrite according to context):",
    ...principleLines,
    "",
    "Avoid mixed or literal forms such as (rewrite the whole sentence naturally):",
    ...avoidLines,
    "Translate the surrounding grammar naturally; keep genuine brand and platform names. Do not treat these as exact string replacements when the meaning differs.",
  ].join("\n");
}
