/**
 * Canonical terminology for professional Hong Kong Traditional Chinese blog copy.
 *
 * The glossary is intentionally conservative. It standardises concepts that
 * commonly drift between sections without rejecting legitimate Hong Kong usage.
 */
export const HK_TRANSLATION_GLOSSARY = [
  ["creator / content creator", "創作者"],
  ["influencer", "創作者（按語境可用 KOL，但 B2I Hub 內容優先用創作者）"],
  ["influencer marketing", "創作者市場推廣"],
  ["nano-influencer", "超小型創作者"],
  ["micro-influencer", "微型創作者"],
  ["follower", "粉絲"],
  ["agency", "市場推廣公司"],
  ["brand awareness", "品牌知名度"],
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
export const NON_HK_TERMS: Array<[RegExp, string]> = [
  [/視頻/gu, "影片"],
  [/信息/gu, "資料／資訊"],
  [/博主/gu, "創作者"],
  [/資料來源/gu, "來源"],
];

/**
 * Marketing terminology that must be standardised to the canonical
 * 「創作者市場推廣」. These are inconsistent with the B2I Hub Hong Kong voice
 * and are treated as deterministically repairable, not just prompt guidance.
 */
export const FORBIDDEN_MARKETING_TERMS: Array<[RegExp, string]> = [
  [/影響力行銷/gu, "創作者市場推廣"],
  [/網紅營銷/gu, "創作者市場推廣"],
  [/KOL市場推廣/gu, "創作者市場推廣"],
  [/(?<![A-Za-z])KOL(?![A-Za-z])/gu, "創作者"],
];

/**
 * Mask bare KOL when it is part of an 或/或者 enumeration so the bare-KOL
 * replacement cannot corrupt 「創作者或 KOL」 into 「創作者或創作者」. The mask
 * is restored after the forbidden-marketing-term pass. Only the standalone label
 * is masked; 「KOL市場推廣」 compounds are left for their own higher-priority rule.
 */
export function maskKOLEnumerations(text: string): string {
  // Deduplicate a redundant KOL that directly follows a creator-family term in an
  // 或/或者 enumeration (e.g. 「創作者或者 KOL」→「創作者」, 「意見領袖或 KOL」→「意見領袖」).
  // Creator and KOL are synonyms in this glossary, so the duplicated label carries
  // no meaning and must not survive. Removing it both prevents the
  // 「創作者或者創作者」 corruption and clears the forbidden bare-KOL finding
  // deterministically. The creator-family term is sentinel-masked (KOL dropped) so
  // the forbidden-term pass cannot re-add it; unmask restores the creator term only.
  return text.replace(/(創作者|意見領袖|網紅)(?:或者|或)(\s*)KOL\s*/gu, "\u0000$1\u0000");
}

export function unmaskKOLEnumerations(text: string): string {
  return text.replace(/\u0000(創作者|意見領袖|網紅)\u0000/gu, "$1");
}

export function findForbiddenTermIssues(text: string): string[] {
  const issues: string[] = [];
  for (const [pattern, preferred] of FORBIDDEN_MARKETING_TERMS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      issues.push(`non-canonical marketing term; prefer ${preferred}`);
    }
  }
  return [...new Set(issues)];
}

/**
 * Formal written-Chinese markers that break the conversational Cantonese
 * register expected in B2I Hub Hong Kong copy. Each entry pairs a formal
 * surface form with its natural zh-HK equivalent. The deterministic
 * normalizer rewrites them; the validator reports any that remain so the
 * AI repair pass is told the exact problem.
 */
export const FORMAL_REGISTER_MARKERS: Array<[RegExp, string]> = [
  [/我們/gu, "我哋"],
  [/他們/gu, "佢哋"],
  [/你們/gu, "你哋"],
  [/為什麼/gu, "點解"],
  [/為何/gu, "點解"],
  [/什麼/gu, "咩"],
  [/如何/gu, "點樣"],
  [/是否/gu, "係咪"],
  [/這個/gu, "呢個"],
  [/這些/gu, "呢啲"],
  [/這裡/gu, "呢度"],
  [/這樣/gu, "咁樣"],
  [/那些/gu, "嗰啲"],
  [/那裡/gu, "嗰度"],
  [/因此/gu, "所以"],
  [/然而/gu, "不過"],
  [/此外/gu, "另外"],
  [/但是/gu, "但係"],
  [/(?<!參)(?<=[\u3400-\u9fff])與(?=[\u3400-\u9fff])/gu, "同"],
];

/**
 * Unambiguous formal-register compounds that the deterministic normalizer
 * preserves verbatim (they are valid written-Chinese or idiomatic constructions)
 * and that the validator must therefore never flag. The validator derives its
 * exclusion from this single source so it can never contradict the normalizer.
 */
export const PROTECTED_REGISTER_COMPOUNDS = new Set(["與其", "參與", "與否", "與眾不同", "與別不同"]);

/** Mask 與…不同 register compounds (e.g. 與眾不同) so the broad 與 → 同 rule never corrupts them. */
export function maskWithDifferentCompounds(text: string): string {
  return text.replace(/(與)([\u3400-\u9fff]{1,4})(不同)/gu, "\u0001$1$2$3\u0001");
}

export function unmaskWithDifferentCompounds(text: string): string {
  return text.replace(/\u0001(與[\u3400-\u9fff]{1,4}不同)\u0001/gu, "$1");
}

/** Mask protected register compounds with sentinel characters before the register pass. */
export function maskProtectedRegisterCompounds(text: string): string {
  let result = text;
  for (const compound of PROTECTED_REGISTER_COMPOUNDS) {
    result = result.replace(new RegExp(compound, "gu"), `\u0000${compound}\u0000`);
  }
  return result;
}

/** Restore sentinel-masked protected register compounds to their original form. */
export function unmaskProtectedRegisterCompounds(text: string): string {
  let result = text;
  for (const compound of PROTECTED_REGISTER_COMPOUNDS) {
    result = result.replace(new RegExp(`\u0000${compound}\u0000`, "gu"), compound);
  }
  return result;
}

export function findFormalRegisterIssues(text: string): string[] {
  const issues: string[] = [];
  // Mask the protected compounds (與其/與否/參與) before scanning so a standalone
  // formal 與 is still detected while the 與 inside a protected compound is not.
  const masked = maskProtectedRegisterCompounds(text);
  for (const [pattern, replacement] of FORMAL_REGISTER_MARKERS) {
    pattern.lastIndex = 0;
    if (pattern.test(masked)) {
      issues.push(`formal written Chinese; use "${replacement}"`);
    }
  }
  return [...new Set(issues)];
}

/**
 * Proven literal/unnatural phrases produced by the translation model.
 * Each is replaced with a natural Hong Kong Cantonese equivalent.
 */
export const LITERAL_PHRASE_REPAIRS: Array<[RegExp, string]> = [
  [/靚仔廣告/gu, "精美廣告"],
  [/搵到咁肥沃嘅土壤/gu, "發展得咁好"],
  [/([A-Za-z]+)-focused嘅/gu, "專注$1嘅"],
];

/**
 * Narrow final Cantonese editorial-polish repairs proven from live output:
 * duplicate-word repair, typo repair, heading register/word-order repair,
 * literal-phrase repair, and softening an unsupported absolute comparison.
 * These run before the broader terminology/register pass so their source
 * strings match verbatim (e.g. a sentence still containing 網紅營銷).
 */
export const CANTONESE_EDITORIAL_REPAIRS: Array<[RegExp, string]> = [
  // duplicate-word repair (tolerant of accidental whitespace between 或者 and 創作者)
  [/透過同啱嘅香港創作者或者\s*創作者合作/gu, "透過同啱嘅香港創作者合作"],
  // typo repair
  [/脗合/gu, "配合"],
  // heading register / word-order repair — tolerate 公司/代理 variants
  [/點解要喺香港同創作者市場推廣(公司|代理|合作夥伴)合作？/gu, "點解要同香港嘅創作者市場推廣$1合作？"],
  // heading normalisation into natural Hong Kong Cantonese — tolerate 同/在…中 variants
  [/品牌(?:在創作者市場推廣中|同創作者市場推廣)常犯的錯誤/gu, "品牌做創作者市場推廣時常犯嘅錯誤"],
  [/點樣選擇合適的創作者市場推廣合作夥伴/gu, "點樣揀啱創作者市場推廣合作夥伴"],
  [/衡量成功：從推廣活動到長期增長/gu, "點樣衡量成效：由推廣活動到長期增長"],
  [/關於香港創作者市場推廣的常見問題/gu, "香港創作者市場推廣常見問題"],
  // literal-phrase repairs
  [/活動廣告板/gu, "人肉廣告板"],
  [/創作者市場推廣嘅貨幣/gu, "創作者市場推廣最重要嘅基礎"],
  // tolerate the optional 都 in 可以令所有人(都)保持誠實
  [/可以令所有人(?:都)?保持誠實/gu, "可以令雙方更清楚成效"],
  // "human" phrase: 佢會 variant first (more specific), then the standalone variant
  [/佢會感覺好人性化/gu, "成個訊息會自然同有人情味好多"],
  [/感覺好人性化/gu, "感覺自然又有人情味"],
  [/被見到/gu, "令人留意到"],
  // broken possessive: "揀啱你創作者市場推廣嘅代理商" -> "the right influencer-marketing agency for you"
  [/揀啱你創作者市場推廣嘅代理商/gu, "揀啱你嘅創作者市場推廣代理商"],
  // Open Influence sentence rewritten naturally, factual meaning preserved.
  // Anchor on the agency name and the closing clause; tolerate verb variants
  // (進入/帶入/引入/將…). The 網紅營銷 → 創作者市場推廣 conversion is left to
  // the forbidden-term pass which runs next.
  [/香港嘅代理商，好似Open Influence，[^。]+(?:進入|帶入|引入|將全球)[^。]*為本地品牌帶嚟新嘅做法。/gu,
    "香港嘅代理商，好似Open Influence，會將全球創作者市場推廣嘅意念引入香港，為本地品牌帶嚟新嘅做法。"],
  // soften the unsupported absolute comparison (10,000-follower vs
  // million-follower celebrity) — tolerate optional 忠實/活躍 and adverbs.
  [/有\s*10,?000\s*(?:個|位)?\s*(?:忠實|活躍)?\s*追蹤者[^。]{0,20}可以比[^。]{0,20}更快賣出產品/gu,
    "一個有 10,000 個忠實粉絲嘅創作者，有時反而可以帶嚟更實際嘅互動同銷售成果"],
];

/**
 * Collapse accidental whitespace between adjacent CJK Han characters (e.g.
 * `創作者 市場推廣` -> `創作者市場推廣`). Only Han-Han spaces are removed, so
 * spaces around English words, numbers, URLs, HTML attributes and mixed-language
 * brand names (e.g. `Instagram 行得通`, `10,000 位`, `B2C 企業`) are preserved.
 * Idempotent: once removed no Han-Han space remains.
 */
export function normalizeChineseWhitespace(text: string): string {
  return text.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/gu, "$1$2");
}

export function normalizeChineseEditorialText(text: string): string {
  let result = normalizeChineseWhitespace(text);
  // Narrow final Cantonese editorial-polish repairs run first so their source
  // strings match verbatim before broader terminology/register rewriting.
  for (const [pattern, replacement] of CANTONESE_EDITORIAL_REPAIRS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  // Context-protect KOL inside 或/或者 enumerations before the bare-KOL rewrite,
  // then restore, so 「創作者或 KOL」 never becomes 「創作者或創作者」.
  result = maskKOLEnumerations(result);
  for (const [pattern, replacement] of FORBIDDEN_MARKETING_TERMS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  result = unmaskKOLEnumerations(result);
  for (const [pattern, replacement] of LITERAL_PHRASE_REPAIRS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of NON_HK_TERMS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  // Protect unambiguous compounds before the register pass touches 與.
  result = maskProtectedRegisterCompounds(result);
  result = maskWithDifferentCompounds(result);
  for (const [pattern, replacement] of FORMAL_REGISTER_MARKERS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  result = unmaskWithDifferentCompounds(result);
  result = unmaskProtectedRegisterCompounds(result);
  return result;
}

/**
 * Unambiguous Simplified-only characters. Ambiguous characters such as 後/后
 * or 裏/里 are deliberately excluded because they have legitimate Traditional
 * Chinese uses and must not create false hard failures.
 */
const SIMPLIFIED_ONLY_RE = /[这为与发进过还会个们从时业网营销数体现达应开关门广东万亿户号视频软]/gu;
export { SIMPLIFIED_ONLY_RE };

export function buildTranslationGlossaryPrompt(): string {
  return [
    "CANONICAL HONG KONG TERMINOLOGY:",
    ...HK_TRANSLATION_GLOSSARY.map(([source, target]) => `- ${source} → ${target}`),
    "MAIN MARKETING TERM: the standard term is 「創作者市場推廣」. Use natural variations such as 「創作者合作」 where appropriate.",
    "FORBIDDEN TERMS — never use any of these: 影響力行銷, 網紅營銷, KOL市場推廣.",
    "Use natural conversational Hong Kong Traditional Chinese (嘅、喺、係、咗、啲) consistently across the whole article. Never switch sections into formal written Chinese.",
    "Source label paragraphs: 「來源：」 + source title, with no trailing punctuation.",
    "Avoid Mainland Simplified Chinese, Taiwan-specific wording and excessive spoken particles.",
    "Preserve brand and platform names such as B2I Hub, Threads, Instagram, Facebook and Meta in English.",
  ].join("\n");
}

/**
 * Sentence-ending punctuation for Chinese prose. Returns the terminator to
 * append, or "" when none is needed.
 *
 * - Paragraphs, list items and FAQ answers: append 。 when the text ends on a
 *   CJK character or a closing bracket and has no terminal punctuation.
 * - Headings and FAQ questions: append ？ only when the text is an explicit
 *   question (interrogative particle / 點解 / 咩 / 幾多…) and lacks a question
 *   mark. Statement headings are left without a trailing full stop.
 *
 * The whole string must be checked so that a question mark is not added to a
 * long statement that merely contains a particle word.
 */
const CJK_CHAR_RE = /[\u3400-\u9fff]/u;
const TERMINAL_PUNCT_RE = /[。！？…]$/u;
const OPENING_OR_CONTINUATION_RE = /[，、；：,;:]$/u;
const CLOSING_BRACKET_RE = /[」』」】〉》）】\]\)]$/u;
const QUESTION_WORD_RE = /(?:點解|咩|乜嘢|幾多|幾耐|係咪|定係|點樣|會唔會|邊度|邊個|邊啲|係咩|做咩|有咩|應該點|點先|係唔係|會唔會)/u;

export function chineseEndingPunctuation(
  text: string,
  kind: "paragraph" | "heading" | "question",
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (TERMINAL_PUNCT_RE.test(trimmed)) return "";
  if (OPENING_OR_CONTINUATION_RE.test(trimmed)) return "";
  const last = trimmed[trimmed.length - 1];
  const endsOnCjk = CJK_CHAR_RE.test(last) || CLOSING_BRACKET_RE.test(last);
  if (!endsOnCjk) return "";
  if (kind === "heading") {
    return QUESTION_WORD_RE.test(trimmed) ? "？" : "";
  }
  if (kind === "question") {
    return QUESTION_WORD_RE.test(trimmed) ? "？" : "";
  }
  return "。";
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
  return [...new Set([...issues, ...findForbiddenTermIssues(text)])];
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
