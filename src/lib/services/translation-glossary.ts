/**
 * Canonical terminology for professional Hong Kong Traditional Chinese blog copy.
 *
 * The glossary is intentionally conservative. It standardises concepts that
 * commonly drift between sections without rejecting legitimate Hong Kong usage.
 */
export const HK_TRANSLATION_GLOSSARY = [
  ["creator / content creator", "創作者"],
  ["influencer", "創作者（按語境可用 KOL，但 B2I Hub 內容優先用創作者）"],
  ["micro-influencer", "微型創作者"],
  ["small and medium-sized business / SME", "中小企"],
  ["brand", "品牌"],
  ["marketing", "市場推廣"],
  ["content marketing", "內容營銷"],
  ["campaign", "推廣活動"],
  ["engagement", "互動"],
  ["engagement rate", "互動率"],
  ["organic reach", "自然觸及"],
  ["paid advertising / paid ads", "付費廣告"],
  ["profile", "個人檔案／商業檔案（按語境）"],
  ["account", "帳戶"],
  ["user", "用戶"],
  ["data", "數據／資料（按語境）"],
  ["insight", "洞察"],
  ["conversion", "轉換"],
  ["call to action / CTA", "行動呼籲"],
  ["user-generated content / UGC", "用戶原創內容"],
  ["word of mouth", "口碑"],
  ["social media", "社交媒體"],
  ["search engine optimisation / SEO", "搜尋引擎優化"],
] as const;

/** Clear Mainland-oriented terms that should be repaired in zh-HK copy. */
const NON_HK_TERMS: Array<[RegExp, string]> = [
  [/視頻/gu, "影片"],
  [/信息/gu, "資料／資訊"],
  [/博主/gu, "創作者"],
];

/**
 * Unambiguous Simplified-only characters. Ambiguous characters such as 後/后
 * or 裏/里 are deliberately excluded because they have legitimate Traditional
 * Chinese uses and must not create false hard failures.
 */
const SIMPLIFIED_ONLY_RE = /[这为与发进过还会个们从时业网营销数体现达应开关门广东万亿户号视频软]/gu;

export function buildTranslationGlossaryPrompt(): string {
  return [
    "CANONICAL HONG KONG TERMINOLOGY:",
    ...HK_TRANSLATION_GLOSSARY.map(([source, target]) => `- ${source} → ${target}`),
    "Use professional written Hong Kong Traditional Chinese. Keep the tone warm, direct and natural. Avoid Mainland Simplified Chinese, Taiwan-specific wording and excessive spoken particles.",
    "Preserve brand and platform names such as B2I Hub, Threads, Instagram, Facebook and Meta in English.",
  ].join("\n");
}

export function findTerminologyIssues(text: string): string[] {
  const issues: string[] = [];
  const simplified = [...new Set(text.match(SIMPLIFIED_ONLY_RE) || [])];
  if (simplified.length > 0) {
    issues.push(`Simplified Chinese characters: ${simplified.join("、")}`);
  }
  for (const [pattern, preferred] of NON_HK_TERMS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      issues.push(`non-canonical Hong Kong term; prefer ${preferred}`);
    }
  }
  return [...new Set(issues)];
}

const KEYPHRASE_RULES: Array<[RegExp, string]> = [
  [/threads/iu, "香港Threads市場推廣"],
  [/micro[-\s]?influencer/iu, "香港微型創作者市場推廣"],
  [/(?:creator|influencer).*(?:marketing|campaign)|(?:marketing|campaign).*(?:creator|influencer)/iu, "香港創作者市場推廣"],
  [/content\s+marketing/iu, "香港內容營銷"],
  [/instagram/iu, "香港Instagram市場推廣"],
  [/facebook/iu, "香港Facebook市場推廣"],
  [/tiktok/iu, "香港TikTok市場推廣"],
  [/youtube/iu, "香港YouTube市場推廣"],
  [/social\s+media/iu, "香港社交媒體市場推廣"],
  [/email\s+marketing/iu, "香港電郵市場推廣"],
  [/search\s+engine|\bseo\b/iu, "香港搜尋引擎優化"],
  [/small\s+business|\bsme\b/iu, "香港中小企市場推廣"],
  [/brand/iu, "香港品牌市場推廣"],
  [/marketing/iu, "香港市場推廣"],
];

/**
 * Deterministic last-resort Chinese keyphrase. Mixed brand/CJK phrases are
 * supported because they are natural and more faithful for searches such as
 * "Threads marketing Hong Kong" than a generic social-media substitute.
 */
export function deriveChineseKeyphrase(sourceKeyphrase: string, translatedTitle = ""): string {
  for (const [pattern, value] of KEYPHRASE_RULES) {
    if (pattern.test(sourceKeyphrase)) return [...value].slice(0, 20).join("");
  }

  const titleRuns = translatedTitle.match(/[A-Za-z0-9\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff\s-]{1,19}/gu) || [];
  const generic = /^(?:香港|指南|實用指南|完整指南|市場推廣|中小企)$/u;
  const fromTitle = titleRuns
    .map((run) => run.trim())
    .find((run) => /[\u3400-\u9fff]{2}/u.test(run) && !generic.test(run));
  if (fromTitle) return [...fromTitle].slice(0, 20).join("");

  return "香港市場推廣";
}
