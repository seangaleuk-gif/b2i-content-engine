// ── Reusable zh-HK language-quality pack (deterministic, no AI) ──
//
// A comprehensive, reusable Traditional Chinese (Hong Kong) language pack that
// normalises and validates every future blog's Chinese output with the same
// rules, so quality is consistent across articles without manual correction.
//
// This module is pure data + pure text transforms. It makes ZERO provider calls
// and adds no AI stage. It is wired into the existing deterministic
// post-processing (applyFaithfulDocumentPostProcessing) so it runs once per
// translation inside the existing one-call pipeline.
//
// Lookups are optimised with Set / Map / precompiled regular expressions so the
// whole pack can be scanned in negligible time compared with the DeepSeek call.
//
// Save behaviour:
//   - Safe deterministic corrections are applied automatically.
//   - Unexpected untranslated English, forbidden terminology and mandatory
//     glossary violations BLOCK saving (critical/major findings).
//   - Subjective style preferences are diagnostics only (minor/advisory) and
//     never block.
//   - No sentence-level rewriting and no article-specific replacements.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import {
  FORBIDDEN_MARKETING_TERMS,
  FORMAL_REGISTER_MARKERS,
  NON_HK_TERMS,
  SIMPLIFIED_ONLY_RE,
  maskKOLEnumerations,
  unmaskKOLEnumerations,
  maskProtectedRegisterCompounds,
  unmaskProtectedRegisterCompounds,
  maskWithDifferentCompounds,
  unmaskWithDifferentCompounds,
} from "./translation-glossary";
import {
  type QualityReport,
  type QualityFinding,
  type QualityCategory,
  emptyQualityReport,
} from "./shadow-cantonese-quality";
import { validateCantoneseCorpus } from "./cantonese-corpus";

// ─────────────────────────────────────────────────────────────────────────────
// Category 1 — safe character and spelling normalisation
// Only replacements that cannot change meaning. Run automatically.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_CHAR_RULES: Array<[RegExp, string]> = [
  // 噉 → 咁 (unambiguous spoken particle)
  [/噉/gu, "咁"],
  // 瞭解 → 了解 (HK preferred, same meaning)
  [/瞭解/gu, "了解"],
  // 脗合 → 吻合 (mis-spelling)
  [/脗合/gu, "吻合"],
  // 奈米 → 納米 (Taiwanese 奈米 → HK 納米 for nano)
  [/奈米/gu, "納米"],
  // 質素 vs 素質: HK prefers 質素
  [/素質/gu, "質素"],
  // 關鍵詞 → 關鍵字 (HK preferred, same meaning)
  [/關鍵詞/gu, "關鍵字"],
];

// ─────────────────────────────────────────────────────────────────────────────
// Category 2 — preferred Hong Kong terminology (Mainland/formal → zh-HK)
// Reuses the canonical glossary-derived rules where they are unambiguous.
// ─────────────────────────────────────────────────────────────────────────────

// Reused from the canonical glossary: formal written-Chinese markers and
// Mainland-oriented terms. Meaning-preserving, safe to auto-correct.
const HK_TERMINOLOGY_RULES: Array<[RegExp, string]> = [
  ...FORMAL_REGISTER_MARKERS,
  ...NON_HK_TERMS,
  // Additional unambiguous HK preferences.
  [/郵件/gu, "電郵"],
  [/質量/gu, "質素"],
  [/營銷活動/gu, "市場推廣活動"],
  [/推銷/gu, "市場推廣"],
  [/數據分析/gu, "數據分析"],
];

// ─────────────────────────────────────────────────────────────────────────────
// Category 4 — forbidden terminology (reused from the canonical glossary)
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_TERM_RULES: Array<[RegExp, string]> = [
  ...FORBIDDEN_MARKETING_TERMS,
  // Bare 營銷 outside a glossary-preferred compound is never used by B2I Hub.
  [/(?<![創作者市場推廣])營銷(?!市場推廣|人才|策略)/gu, "市場推廣"],
  [/網紅營銷/gu, "創作者市場推廣"],
  [/影響力行銷/gu, "創作者市場推廣"],
];

// ─────────────────────────────────────────────────────────────────────────────
// Category 3 — mandatory marketing glossary (source-aware enforcement)
// Each entry maps an English source term to its canonical Chinese and lists the
// renderings that must never appear for that source term. Nano and micro are
// distinct entries so they are never conflated.
// ─────────────────────────────────────────────────────────────────────────────

export interface MandatoryGlossaryEntry {
  name: string;
  /** Word-boundary English source term. */
  sourceRe: RegExp;
  /** Canonical required Chinese term. */
  required: string;
  /** Renderings that are wrong/forbidden for this source term. */
  forbidden: string[];
}

export const MANDATORY_GLOSSARY: MandatoryGlossaryEntry[] = [
  { name: "influencer-marketing", sourceRe: /\binfluencer\s+marketing\b/iu, required: "創作者市場推廣", forbidden: ["網紅營銷", "影響力行銷", "KOL市場推廣", "influencer marketing", "influencer", "influencers"] },
  { name: "agency", sourceRe: /\bagency\b/iu, required: "市場推廣公司", forbidden: ["agency", "agencies"] },
  { name: "brand-awareness", sourceRe: /\bbrand\s+awareness\b/iu, required: "品牌知名度", forbidden: ["品牌意識", "品牌認知度", "brand awareness"] },
  { name: "nano-influencer", sourceRe: /\bnano[- ]?influencer\b/iu, required: "超小型創作者", forbidden: ["奈米創作者", "納米網紅", "微型創作者", "中型創作者", "大型創作者", "nano influencer", "nano-influencer"] },
  { name: "micro-influencer", sourceRe: /\bmicro[- ]?influencer\b/iu, required: "微型創作者", forbidden: ["超小型創作者", "中型創作者", "大型創作者", "nano influencer", "micro influencer", "micro-influencer"] },
  { name: "macro-influencer", sourceRe: /\bmacro[- ]?influencer\b/iu, required: "大型創作者", forbidden: ["中型創作者", "中層創作者", "超大型創作者", "nano influencer", "micro influencer", "macro influencer", "macro-influencer"] },
  { name: "top-tier-influencer", sourceRe: /\btop[- ]?(?:tier|tiered)?[- ]?(?:creator|influencer)s?\b/iu, required: "頂級創作者", forbidden: ["頂層創作者", "頂級網紅", "一線創作者", "top tier", "top-tier creator", "top tier influencer"] },
  { name: "follower", sourceRe: /\bfollower(s)?\b/iu, required: "粉絲", forbidden: ["follower", "followers", "追隨者"] },
  { name: "engagement", sourceRe: /\bengagement\b/iu, required: "互動", forbidden: ["engagement", "參與度"] },
  { name: "campaign", sourceRe: /\bcampaign(s)?\b/iu, required: "推廣活動", forbidden: ["campaign", "campaigns"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Category 6 — reusable literal-translation patterns (general error categories)
// ─────────────────────────────────────────────────────────────────────────────

export interface LiteralPatternRule {
  name: string;
  re: RegExp;
  severity: "block" | "advisory";
  replacement?: string;
}

// Duplicated/mixed Cantonese particles (objective, auto-repairable where safe).
const DUPLICATED_PARTICLE_RULES: Array<[RegExp, string]> = [
  [/嘅嘅/gu, "嘅"],
  [/咗咗/gu, "咗"],
  [/喺喺/gu, "喺"],
  [/啲啲/gu, "啲"],
  [/咁咁/gu, "咁"],
  [/嘅嘅/gu, "嘅"],
];

// Objective block patterns: an untranslated English verb/word inside a
// Cantonese clause (also caught by English detection), and malformed mixed-script
// particle constructions that cannot be safely auto-repaired. The first capture
// group extracts the offending English token for diagnostics.
const LITERAL_PATTERN_RULES: LiteralPatternRule[] = [
  { name: "mixed-particle", re: /(?:的嘅|咗嘅|嘅咗|嘅到|咗左|嘅嘅|嘅呀嘅)/gu, severity: "block" },
  { name: "untranslated-verb", re: /(?<=[\u3400-\u9fff])\s*([A-Za-z]{3,})\s*(?:嘅|咗|喺|係|咁)/gu, severity: "block" },
  { name: "english-cn-auxiliary", re: /(?:我哋|佢哋|可以|會|要|已經|都)\s+([A-Za-z]{3,})\s+(?:一|個|呢)/gu, severity: "block" },
  // Ambiguous stylistic patterns (diagnostics only).
  { name: "awkward-adverb", re: /(?:非常之|好之好|幾之幾)/gu, severity: "advisory" },
  { name: "repeated-object", re: /(?:這個問題這個|呢個問題呢個)/gu, severity: "advisory" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Category 5 — permanent English allowlist (common natural retention)
// ─────────────────────────────────────────────────────────────────────────────

const PERMANENT_EN_TERMS: string[] = [
  // Social platforms
  "instagram", "youtube", "tiktok", "wechat", "xiaohongshu", "facebook", "threads",
  "linkedin", "twitter", "pinterest", "snapchat", "reddit", "whatsapp", "telegram",
  "discord", "twitch", "spotify", "clubhouse", "tumblr", "mastodon", "bluesky",
  "signal", "line", "kakaotalk", "behance", "dribbble", "medium", "substack",
  "bing", "google", "meta", "apple", "amazon", "shopify", "wix", "squarespace",
  "wordpress", "netflix", "slack", "zoom", "teams", "gmail", "outlook", "icloud",
  "dropbox", "notion", "airtable", "canva", "figma", "adobe", "photoshop",
  "illustrator", "lightroom", "premiere", "webflow", "reel", "reels", "stories",
  "shorts", "lives", "hashtag", "hashtags",
  // Marketing acronyms and metrics
  "kpi", "roi", "roas", "ctr", "cpc", "cpm", "cpa", "cpl", "cps", "cvr", "cr",
  "aov", "atv", "aru", "cac", "clv", "ltv", "mql", "sql", "nps", "seo", "sem",
  "ppc", "ugc", "pgc", "ooh", "koc", "kol", "imc", "orm", "sop", "sla", "csat",
  "cei", "b2b", "b2c", "b2g", "c2c", "dtc", "d2c", "o2o", "b2i", "sme", "smb",
  "mvp", "poc", "ip", "pr", "hr", "r&d", "p&l", "yoy", "mom", "qoq", "cagr",
  "kyc", "aml", "crm", "erp", "saas", "paas", "iaas", "aso", "cv", "rsvp", "npv",
  "ep", "eod", "eom", "wip", "tbd", "tbc", "ceo", "cfo", "cto", "cmo", "coo", "vp",
  "gm", "nps", "m&a", "klout",
  // Technology
  "ai", "ar", "vr", "mr", "xr", "nft", "web3", "iot", "ml", "dl", "llm", "gpt",
  "api", "sdk", "cms", "cdn", "url", "uri", "html", "css", "js", "json", "xml",
  "http", "https", "ssl", "tls", "dns", "ui", "ux", "vpn", "oauth", "jwt", "sso",
  "mfa", "otp", "qr", "ocr", "nlp", "tts", "stt", "fintech", "martech", "adtech",
  "programmatic", "attribution", "bidding", "dashboard", "app", "apps", "software",
  "hardware", "cloud", "analytics", "plugin", "plugins", "extension", "widget",
  "chatbot", "algorithm", "blockchain", "crypto", "cryptocurrency", "wallet",
  "platform", "interface", "server", "database", "backend", "frontend", "mobile",
  "desktop", "browser", "cookie", "pixel", "tracking", "edge",
  // Content formats
  "blog", "blogs", "vlog", "vlogs", "podcast", "podcasts", "webinar", "webinars",
  "infographic", "infographics", "whitepaper", "whitepapers", "ebook", "ebooks",
  "tutorial", "tutorials", "unboxing", "haul", "grwm", "asmr", "highlight",
  "highlights", "carousel", "caption", "captions", "tag", "tags", "mention",
  "mentions", "dm", "dms", "link", "links", "bio", "bios", "post", "posts", "feed",
  "profile", "profiles", "avatar", "banners", "thumbnail", "thumbnails", "headline",
  "headlines", "keyword", "keywords", "backlink", "backlinks", "anchor", "anchors",
  "story", "live", "landing page",
  // Business abbreviations and common Hong Kong code-switching
  "ok", "okay", "yeah", "actually", "basically", "definitely", "exactly",
  "probably", "honestly", "absolutely", "totally", "really", "quite", "pretty",
  "super", "fine", "good", "great", "cool", "nice", "sure", "thanks", "please",
  "sorry", "hmm", "well", "anyway", "perhaps", "maybe", "right", "deal", "done",
  "lunch", "dinner", "coffee", "meeting", "meetings", "call", "calls", "email",
  "emails", "budget", "budgets", "deadline", "deadlines", "feedback", "briefing",
  "briefings", "project", "projects", "schedule", "schedules", "agenda", "agendas",
  "memo", "memos", "invoice", "invoices", "payment", "payments", "transfer",
  "transfers", "deposit", "deposits", "card", "credit", "cash", "account",
  "accounts", "bank", "banks", "insurance", "policy", "policies", "plan", "plans",
  "contract", "contracts", "agreement", "agreements", "document", "documents",
  "file", "files", "folder", "folders", "draft", "drafts", "version", "versions",
  "update", "updates", "login", "password", "username", "signup", "checkout",
  "cart", "order", "orders", "shipping", "delivery", "deliveries", "refund",
  "refunds", "discount", "discounts", "coupon", "coupons", "voucher", "vouchers",
  "promo", "promos", "sale", "sales", "offer", "offers", "client", "clients",
  "partner", "partners", "vendor", "vendors", "supplier", "suppliers", "team",
  "teams", "manager", "managers", "director", "directors", "office", "offices",
  "store", "stores", "shop", "shops", "appointment", "appointments", "event",
  "events", "ticket", "tickets", "membership", "subscription", "subscriptions",
  "notification", "notifications", "payout", "payouts", "dashboard", "workspace",
  // B2I Hub product terminology
  "b2i", "hub", "marketplace", "creator", "creators", "creator hub", "brandkit",
  "proposal", "proposals", "onboarding", "reporting", "reports", "rate",
];

/** Permanent English allowlist (lowercased) for naturally retained Hong Kong English. */
export const PERMANENT_EN_ALLOWLIST: ReadonlySet<string> = new Set(PERMANENT_EN_TERMS.map((t) => t.toLowerCase()));

/** Number of permanent English allowlist entries. */
export const PERMANENT_EN_ALLOWLIST_COUNT = PERMANENT_EN_ALLOWLIST.size;

// Common English words that must NEVER be auto-allowed from the source (they are
// content words that must be translated if they appear untranslated).
const AUTO_EXCLUDE = new Set([
  ...MANDATORY_GLOSSARY.map((e) => e.name),
  "the", "a", "an", "and", "or", "but", "for", "with", "from", "of", "to", "in",
  "on", "at", "by", "this", "that", "these", "those", "your", "our", "their",
  "its", "is", "are", "was", "were", "be", "have", "has", "had", "do", "does",
  "did", "will", "would", "can", "could", "should", "may", "might", "how", "why",
  "what", "when", "where", "who", "which", "all", "any", "every", "some", "no",
  "not", "as", "if", "then", "than", "so", "very", "more", "most", "into", "about",
  "over", "under", "between", "through", "during", "after", "before", "without",
]);

const GLOSSARY_SOURCE_TERMS = new Set(MANDATORY_GLOSSARY.map((e) => e.name.toLowerCase()));

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity extraction (automatic allowlist additions per article)
// ─────────────────────────────────────────────────────────────────────────────

const ACRONYM_RE = /\b[A-Z]{2,8}\b/g;
const PROPER_NAME_RE = /(?<![\u3400-\u9fff])(?<![A-Za-z])\b[A-Z][a-zA-Z]{1,}(?:[\s'-][A-Z][a-zA-Z]{1,})*/g;
const DOMAIN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/g;

function tokenizeLatin(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)) tokens.push(m[0]);
  return tokens;
}

/**
 * Extract a set of article-specific English entities that may be naturally
 * retained in the translation: acronyms, capitalized proper-name constituents,
 * and URL/domain labels. Common English content words and mandatory-glossary
 * source terms are excluded so they are never auto-allowed.
 */
export function extractAutoAllowedEntities(enDoc: ArticleDocument): ReadonlySet<string> {
  const allowed = new Set<string>();
  const add = (token: string): void => {
    const t = token.toLowerCase();
    if (AUTO_EXCLUDE.has(t) || GLOSSARY_SOURCE_TERMS.has(t)) return;
    allowed.add(t);
  };
  const textParts: string[] = [
    enDoc.metadata.title,
    enDoc.metadata.metaDescription,
    enDoc.metadata.excerpt,
    ...enDoc.sections.map((s) => s.heading),
    ...enDoc.sections.flatMap((s) => s.blocks.map((b) => blockVisibleText(b))),
    ...enDoc.introduction.blocks.map((b) => blockVisibleText(b)),
    ...enDoc.conclusion.blocks.map((b) => blockVisibleText(b)),
    ...enDoc.visibleFaq.map((f) => `${f.question} ${f.answerText}`),
    ...enDoc.insertedLinks.map((l) => l.href),
    enDoc.metadata.slug,
  ];
  const allText = textParts.join("\n");
  for (const m of allText.matchAll(ACRONYM_RE)) add(m[0]);
  for (const m of allText.matchAll(PROPER_NAME_RE)) {
    for (const token of tokenizeLatin(m[0])) add(token);
  }
  for (const m of allText.matchAll(DOMAIN_RE)) {
    for (const label of m[0].split(".")) add(label);
  }
  return allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

function blockVisibleText(block: EditorialBlock): string {
  const collect = (nodes: InlineContent[]): string => nodes.map((n) => n.text ?? "").join("");
  switch (block.type) {
    case "list":
      return block.items.map(collect).join(" ");
    case "table":
      return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
    default:
      return collect(block.content);
  }
}

const CITATION_RE = /^\s*(?:來源|資料來源|Source)\s*[：:]/iu;
function isCitationBlock(block: EditorialBlock): boolean {
  return CITATION_RE.test(blockVisibleText(block).trimStart());
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, " ");
}
function stripCurrency(text: string): string {
  return text.replace(/[A-Za-z]+\$/g, "");
}

/** Normalise safe characters, HK terminology, forbidden terms and duplicated particles. */
export function normalizeZhHkText(text: string): string {
  let out = text;
  for (const [re, replacement] of SAFE_CHAR_RULES) { re.lastIndex = 0; out = out.replace(re, replacement); }
  // Non-register terminology rules first (FORMAL_REGISTER_MARKERS are applied
  // separately below with compound guards so the broad 與 → 同 rule cannot corrupt
  // 與其/參與/與否/與眾不同/與別不同).
  const formalSet = new Set<[RegExp, string]>(FORMAL_REGISTER_MARKERS);
  const nonRegister = HK_TERMINOLOGY_RULES.filter((rule) => !formalSet.has(rule));
  for (const [re, replacement] of nonRegister) { re.lastIndex = 0; out = out.replace(re, replacement); }
  // Register pass with compound guards (mirrors normalizeChineseEditorialText).
  out = maskProtectedRegisterCompounds(out);
  out = maskWithDifferentCompounds(out);
  for (const [re, replacement] of FORMAL_REGISTER_MARKERS) { re.lastIndex = 0; out = out.replace(re, replacement); }
  out = unmaskWithDifferentCompounds(out);
  out = unmaskProtectedRegisterCompounds(out);
  // Forbidden-term pass with KOL enumeration guard so 「創作者或 KOL」never becomes
  // 「創作者或創作者」.
  out = maskKOLEnumerations(out);
  for (const [re, replacement] of FORBIDDEN_TERM_RULES) { re.lastIndex = 0; out = out.replace(re, replacement); }
  out = unmaskKOLEnumerations(out);
  for (const [re, replacement] of DUPLICATED_PARTICLE_RULES) { re.lastIndex = 0; out = out.replace(re, replacement); }
  out = out.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/gu, "$1$2");
  return out;
}

function normalizeZhHkHtml(html: string): string {
  const masks: string[] = [];
  const masked = html.replace(/<[^>]*>/g, (tag) => { masks.push(tag); return `\u0000${masks.length - 1}\u0000`; });
  const cleaned = normalizeZhHkText(masked);
  return cleaned.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

// ─────────────────────────────────────────────────────────────────────────────
// English detection (category 5)
// ─────────────────────────────────────────────────────────────────────────────

const ENGLISH_TOKEN_RE = /[A-Za-z][A-Za-z0-9-]*/g;

/**
 * Shared English-token exemption, used by EVERY English-leak detector so their
 * allowlist/entity logic stays consistent. A token is exempt (not an untranslated
 * leak) when it is in the permanent allowlist or it is an auto-extracted entity
 * (protected platform name, brand, organisation, source, acronym or domain).
 */
export function isAllowedEnglishToken(
  token: string,
  allowedEntities: ReadonlySet<string>,
): boolean {
  const lower = token.toLowerCase();
  return PERMANENT_EN_ALLOWLIST.has(lower) || allowedEntities.has(lower);
}

/**
 * Find the first unexpected English token in a Chinese unit, given the permanent
 * allowlist and the article's auto-extracted entities. Returns null when the unit
 * contains no English, or only approved/auto-extracted tokens.
 */
export function findUnexpectedEnglishToken(
  text: string,
  allowedEntities: ReadonlySet<string>,
): { token: string; tokens: number; unexpected: number } | null {
  const cleaned = stripCurrency(stripUrls(text));
  const tokens: string[] = [];
  for (const m of cleaned.matchAll(ENGLISH_TOKEN_RE)) tokens.push(m[0]);
  if (tokens.length === 0) return null;
  const unexpected: string[] = [];
  for (const token of tokens) {
    if (isAllowedEnglishToken(token, allowedEntities)) continue;
    // Pure numbers and acronym-like short tokens with digits are handled by
    // number/URL protection upstream; treat digit-heavy tokens as non-English.
    if (/^[0-9][A-Za-z0-9-]*$/.test(token)) continue;
    unexpected.push(token);
  }
  if (unexpected.length === 0) return null;
  return { token: unexpected[0], tokens: tokens.length, unexpected: unexpected.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aligned unit collection (Chinese doc + English source per unit)
// ─────────────────────────────────────────────────────────────────────────────

export interface AlignedUnit {
  id: string;
  en: string;
  zh: string;
}

export function collectAlignedUnits(enDoc: ArticleDocument, zhDoc: ArticleDocument): AlignedUnit[] {
  const out: AlignedUnit[] = [];
  const push = (id: string, en: string, zh: string): void => {
    if (!zh) return;
    out.push({ id, en: en ?? "", zh });
  };
  push("metadata.title", enDoc.metadata.title, zhDoc.metadata.title);
  push("metadata.metaDescription", enDoc.metadata.metaDescription, zhDoc.metadata.metaDescription);
  push("metadata.excerpt", enDoc.metadata.excerpt, zhDoc.metadata.excerpt);
  const introCount = Math.min(enDoc.introduction.blocks.length, zhDoc.introduction.blocks.length);
  for (let i = 0; i < introCount; i++) {
    if (isCitationBlock(zhDoc.introduction.blocks[i])) continue;
    push(`introduction.block.${i}`, blockVisibleText(enDoc.introduction.blocks[i]), blockVisibleText(zhDoc.introduction.blocks[i]));
  }
  zhDoc.sections.forEach((s, si) => {
    push(`section.${si}.heading`, enDoc.sections[si]?.heading ?? "", s.heading);
    s.blocks.forEach((b, bi) => {
      if (isCitationBlock(b)) return;
      const enBlock = enDoc.sections[si]?.blocks[bi];
      const enText = enBlock ? blockVisibleText(enBlock) : "";
      push(`section.${si}.block.${bi}`, enText, blockVisibleText(b));
    });
  });
  const concCount = Math.min(enDoc.conclusion.blocks.length, zhDoc.conclusion.blocks.length);
  for (let i = 0; i < concCount; i++) {
    if (isCitationBlock(zhDoc.conclusion.blocks[i])) continue;
    push(`conclusion.block.${i}`, blockVisibleText(enDoc.conclusion.blocks[i]), blockVisibleText(zhDoc.conclusion.blocks[i]));
  }
  zhDoc.visibleFaq.forEach((f, i) => {
    push(`faq.${i}.question`, enDoc.visibleFaq[i]?.question ?? "", f.question);
    push(`faq.${i}.answer`, enDoc.visibleFaq[i]?.answerText ?? "", f.answerText);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis (category 7 diagnostics)
// ─────────────────────────────────────────────────────────────────────────────

function addFinding(
  report: QualityReport,
  finding: QualityFinding,
): void {
  report.findings.push(finding);
  if (finding.severity === "critical") report.criticalCount += 1;
  else if (finding.severity === "major") report.majorCount += 1;
  else if (finding.severity === "minor") report.minorCount += 1;
  else report.advisoryCount += 1;
}

/** Short bounded window of translated text surrounding an offending token. */
function surroundingContext(text: string, token: string, radius = 30): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(token.toLowerCase());
  if (idx < 0) return text.slice(0, 60);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + token.length + radius);
  return text.slice(start, end);
}

function isEnglishToken(token: string): boolean {
  return /[A-Za-z]/.test(token);
}

function tokenInSource(en: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(en);
}

/**
 * Build a blocked (critical/major) quality finding enriched with the exact
 * offending token, bounded surrounding context, and the source/allowlist/
 * auto-entity provenance of the token. English-specific provenance fields are
 * only populated when the offending token is actually English.
 */
function blockedFinding(args: {
  sourceUnitId: string;
  category: QualityCategory;
  messageCode: string;
  replacement?: string;
  token?: string;
  en?: string;
  zh?: string;
  allowedEntities?: ReadonlySet<string>;
  detectorRule: string;
}): QualityFinding {
  const token = args.token;
  const isEn = token !== undefined && isEnglishToken(token);
  const lower = isEn ? token.toLowerCase() : undefined;
  return {
    sourceUnitId: args.sourceUnitId,
    category: args.category,
    severity: "major",
    matchedToken: token ?? args.replacement ?? args.messageCode,
    offendingToken: token,
    context: args.zh ? surroundingContext(args.zh, token ?? args.zh) : undefined,
    tokenInSource: isEn && token !== undefined ? tokenInSource(args.en ?? "", token) : undefined,
    tokenInAllowlist: isEn && lower !== undefined ? PERMANENT_EN_ALLOWLIST.has(lower) : undefined,
    tokenInAutoEntities: isEn && lower !== undefined && args.allowedEntities ? args.allowedEntities.has(lower) : undefined,
    detectorRule: args.detectorRule,
    messageCode: args.messageCode,
    replacement: args.replacement,
    action: "blocked",
  };
}

/** Concise terminal summary for every blocked (critical/major) quality finding. */
export function logBlockedQualityFindings(report: QualityReport): void {
  for (const f of report.findings) {
    if (f.severity !== "critical" && f.severity !== "major") continue;
    const token = f.offendingToken ?? f.matchedToken ?? "?";
    console.log(`quality BLOCKED | unit=${f.sourceUnitId} | category=${f.messageCode} | token=${token}`);
  }
}

/**
 * Analyse a Chinese document against the language pack. Source-aware (pairs each
 * Chinese unit with its English source). Produces severity-based findings:
 *   - major (blocks): unexpected untranslated English, forbidden terminology,
 *     mandatory-glossary violations, objective literal-translation patterns.
 *   - minor/advisory (diagnostic only): subjective style, safe corrections.
 */
export function analyzeZhHkLanguageQuality(
  zhDoc: ArticleDocument,
  enDoc: ArticleDocument,
): QualityReport {
  const report = emptyQualityReport();
  const allowedEntities = extractAutoAllowedEntities(enDoc);
  const units = collectAlignedUnits(enDoc, zhDoc);

  for (const { id, en, zh } of units) {
    // Category 5 — unexpected English (block).
    const english = findUnexpectedEnglishToken(zh, allowedEntities);
    if (english) {
      addFinding(report, blockedFinding({
        sourceUnitId: id,
        category: "english-leak",
        messageCode: "unexpected-english",
        replacement: "translate into Hong Kong Cantonese",
        token: english.token,
        en,
        zh,
        allowedEntities,
        detectorRule: "english-leak",
      }));
    }

    // Category 4 — forbidden terminology (block, after auto-repair).
    for (const [re, replacement] of FORBIDDEN_TERM_RULES) {
      re.lastIndex = 0;
      const m = re.exec(zh);
      if (m) {
        addFinding(report, blockedFinding({
          sourceUnitId: id,
          category: "terminology",
          messageCode: "forbidden-terminology",
          replacement,
          token: m[0],
          en,
          zh,
          allowedEntities,
          detectorRule: "forbidden-terminology",
        }));
      }
    }

    // Category 3 — mandatory glossary (source-aware, block on wrong rendering).
    for (const entry of MANDATORY_GLOSSARY) {
      entry.sourceRe.lastIndex = 0;
      if (!entry.sourceRe.test(en)) continue;
      // Only block when the required rendering is ABSENT and a wrong rendering is
      // present (i.e. the concept was mis-translated). When both the required and a
      // forbidden rendering appear (e.g. nano AND micro are both mentioned), the
      // required presence means the concepts were not conflated, so it is allowed.
      const hasRequired = new RegExp(escapeRegex(entry.required), "u").test(zh);
      for (const bad of entry.forbidden) {
        const badRe = new RegExp(escapeRegex(bad), "iu");
        if (!hasRequired && badRe.test(zh)) {
          addFinding(report, blockedFinding({
            sourceUnitId: id,
            category: "terminology",
            messageCode: `glossary-${entry.name}`,
            replacement: entry.required,
            token: bad,
            en,
            zh,
            allowedEntities,
            detectorRule: `glossary-${entry.name}`,
          }));
        }
      }
    }

    // Category 6 — literal patterns (objective block / advisory diagnostic).
    for (const rule of LITERAL_PATTERN_RULES) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(zh);
      if (!m) continue;
      const capturedEnglish = m[1];
      const token = capturedEnglish || m[0];
      // Exemptions for English-capturing literal detectors (e.g.
      // literal-untranslated-verb): an English token that is allowlisted or an
      // auto-extracted entity (platform name, brand, organisation, source,
      // acronym, URL/domain) must never be treated as an untranslated-verb leak.
      // Genuine untranslated verbs such as `work` are neither and still block.
      if (capturedEnglish && isAllowedEnglishToken(capturedEnglish, allowedEntities)) continue;
      if (rule.severity === "block") {
        addFinding(report, blockedFinding({
          sourceUnitId: id,
          category: "language",
          messageCode: `literal-${rule.name}`,
          replacement: rule.replacement,
          token,
          en,
          zh,
          allowedEntities,
          detectorRule: `literal-${rule.name}`,
        }));
      } else {
        addFinding(report, {
          sourceUnitId: id,
          category: "language",
          severity: "advisory",
          matchedToken: token,
          offendingToken: token,
          context: surroundingContext(zh, token),
          detectorRule: `literal-${rule.name}`,
          messageCode: `literal-${rule.name}`,
          replacement: rule.replacement,
          action: "diagnostic",
        });
      }
    }

    // Category 1/2 — safe corrections already applied (diagnostic record).
    const normalized = normalizeZhHkText(zh);
    if (normalized !== zh) {
      addFinding(report, {
        sourceUnitId: id,
        category: "language",
        severity: "advisory",
        matchedToken: zh.slice(0, 24),
        messageCode: "safe-normalization",
        replacement: normalized,
        action: "corrected",
      });
    }
  }

  // Simplified-only characters are objective (block).
  for (const { id, zh } of units) {
    const simplified = [...new Set(zh.match(SIMPLIFIED_ONLY_RE) || [])];
    if (simplified.length > 0) {
      addFinding(report, blockedFinding({
        sourceUnitId: id,
        category: "language",
        messageCode: "simplified-chinese",
        replacement: "use Traditional Chinese",
        token: simplified.join("、"),
        en: "",
        zh,
        allowedEntities,
        detectorRule: "simplified-chinese",
      }));
    }
  }

  // Local Cantonese corpus validation: token / naturalness diagnostics
  // (diagnostic-only, never block). Variant normalisation is applied by the
  // deterministic normaliser above; the corpus variant audit is diagnostic.
  const corpus = validateCantoneseCorpus(units.map((u) => ({ id: u.id, text: u.zh })));
  for (const finding of corpus.findings) {
    addFinding(report, finding);
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply safe deterministic corrections (categories 1, 2, 4, duplicated particles)
// ─────────────────────────────────────────────────────────────────────────────

function cleanInline(nodes: InlineContent[]): InlineContent[] {
  return nodes.map((node) => ({
    ...node,
    text: typeof node.text === "string" ? normalizeZhHkText(node.text) : node.text,
  }));
}

function cleanBlock(block: EditorialBlock): EditorialBlock {
  if (isCitationBlock(block)) return block;
  switch (block.type) {
    case "list":
      return { ...block, items: block.items.map((nodes) => cleanInline(nodes)) };
    case "table":
      return { ...block, headers: block.headers.map((nodes) => cleanInline(nodes)), rows: block.rows.map((row) => row.map((nodes) => cleanInline(nodes))) };
    default:
      return { ...block, content: cleanInline(block.content) };
  }
}

/**
 * Apply the language pack's safe deterministic normalisations to a Chinese
 * document (returns a new document; the input is never mutated) and compute the
 * severity-based report for the save gate.
 */
export function applyZhHkLanguageQuality(
  zhDoc: ArticleDocument,
  enDoc: ArticleDocument,
): { doc: ArticleDocument; report: QualityReport } {
  const out = structuredClone(zhDoc) as ArticleDocument;
  out.metadata.title = normalizeZhHkText(out.metadata.title);
  out.metadata.metaDescription = normalizeZhHkText(out.metadata.metaDescription);
  out.metadata.excerpt = normalizeZhHkText(out.metadata.excerpt);
  out.introduction.blocks = out.introduction.blocks.map(cleanBlock);
  out.sections = out.sections.map((s) => ({ ...s, heading: normalizeZhHkText(s.heading), blocks: s.blocks.map(cleanBlock) }));
  out.conclusion.blocks = out.conclusion.blocks.map(cleanBlock);
  out.visibleFaq = out.visibleFaq.map((f) => ({
    ...f,
    question: normalizeZhHkText(f.question),
    answerHtml: normalizeZhHkHtml(f.answerHtml),
    answerText: normalizeZhHkText(f.answerText),
  }));
  const report = analyzeZhHkLanguageQuality(out, enDoc);
  return { doc: out, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// Language-pack inventory (for diagnostics and tests)
// ─────────────────────────────────────────────────────────────────────────────

export const LANGUAGE_PACK_INVENTORY = {
  safeCharacterRules: SAFE_CHAR_RULES.length,
  hkTerminologyRules: HK_TERMINOLOGY_RULES.length,
  mandatoryGlossary: MANDATORY_GLOSSARY.length,
  forbiddenTermRules: FORBIDDEN_TERM_RULES.length,
  permanentEnglishAllowlist: PERMANENT_EN_ALLOWLIST_COUNT,
  literalPatternRules: LITERAL_PATTERN_RULES.length,
  total: SAFE_CHAR_RULES.length + HK_TERMINOLOGY_RULES.length + MANDATORY_GLOSSARY.length + FORBIDDEN_TERM_RULES.length + PERMANENT_EN_ALLOWLIST_COUNT + LITERAL_PATTERN_RULES.length,
};
