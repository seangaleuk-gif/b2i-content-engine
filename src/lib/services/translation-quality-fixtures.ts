// ── Golden translation-quality regression corpus ──
//
// A versioned, article-independent fixture set of representative B2I examples
// used by translation-quality tests. These are data fixtures (not test files),
// so they can be imported by any test without importing from another *.test.ts.
//
// It covers: natural Cantonese; acceptable Hong Kong code-switching; approved
// brands/platforms; isolated mixed-language expressions; genuine untranslated
// English sentences; English-heavy paragraphs; literal machine-translated
// Cantonese; terminology-consistency cases; URLs/figures/citations/HTML/FAQ.

export const QUALITY_FIXTURES_VERSION = "2026.08.02.v1";

export type BlockEnglishClass =
  | "major"
  | "minor"
  | "advisory"
  | "none";

export interface EnglishClassificationFixture {
  name: string;
  text: string;
  expected: BlockEnglishClass;
}

export interface GlossaryFixture {
  name: string;
  source: string;
  expected: string;
}

/** Block-level English classification fixtures. */
export const ENGLISH_CLASSIFICATION_FIXTURES: EnglishClassificationFixture[] = [
  { name: "natural-cantonese", text: "正正因為咁，創作者市場推廣先會喺香港發展得咁快。", expected: "none" },
  { name: "hk-code-switching", text: "品牌可以睇 KPI、ROI 同 Reel 內容，衡量成效。", expected: "advisory" },
  { name: "approved-brands", text: "用 Instagram、YouTube、TikTok 同 WeChat 衡量成效。", expected: "advisory" },
  { name: "isolated-tiktok-focused", text: "品牌同 TikTok-focused 合作夥伴合作，成效好好。", expected: "minor" },
  { name: "unknown-future-platform", text: "呢個 HyperLoop-driven 策略好新，值得一試。", expected: "minor" },
  { name: "isolated-brand-friendly", text: "呢個 brand-friendly 方案好受歡迎。", expected: "minor" },
  { name: "untranslated-sentence", text: "The goal is to spark a reply, not just a like across the platform.", expected: "major" },
  { name: "english-paragraph", text: "Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell marketing content.", expected: "major" },
  { name: "english-heavy-block", text: "Brands should measure performance across social platforms over a full six month window before scaling their whole strategy.", expected: "major" },
  { name: "literal-machine-cantonese", text: "搵到咁好嘅土壤係好重要，但都要做好配合。", expected: "none" },
  { name: "url-and-figure", text: "根據 https://example.com/report 嘅數據，65% 嘅品牌提升咗成效。", expected: "none" },
  { name: "proper-company-names", text: "YKONE、Open Influence 同 Assembly 都係出名嘅代理公司。", expected: "advisory" },
];

/** Stable-glossary normalization fixtures (approved terminology base). */
export const GLOSSARY_FIXTURES: GlossaryFixture[] = [
  { name: "influencer-marketing", source: "influencer marketing", expected: "創作者市場推廣" },
  { name: "influencer", source: "influencer", expected: "創作者" },
  { name: "campaign", source: "campaign", expected: "推廣活動" },
  { name: "follower", source: "follower", expected: "粉絲" },
  { name: "engagement-rate", source: "engagement rate", expected: "互動率" },
  { name: "engagement", source: "engagement", expected: "互動" },
  { name: "saves", source: "saves", expected: "儲存" },
  { name: "shares", source: "shares", expected: "分享" },
  { name: "comments", source: "comments", expected: "留言" },
  { name: "rate-card", source: "rate card", expected: "收費表" },
  { name: "brief", source: "brief", expected: "合作簡報" },
  { name: "likes", source: "likes", expected: "讚好" },
  { name: "typographic-typo", source: "脗合", expected: "吻合" },
];

/** Approved brand/platform/acronym tokens that must remain unchanged. */
export const APPROVED_NAMES_FIXTURES: string[] = [
  "Instagram", "YouTube", "TikTok", "WeChat", "KPI", "B2C", "Reel", "YKONE",
  "Open Influence", "Assembly", "StarNgage", "Luna", "B2I Hub",
];
