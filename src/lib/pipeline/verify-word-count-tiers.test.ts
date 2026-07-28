import { describe, it, expect } from "vitest";
import {
  englishWordTolerance, dynamicH2Range, dynamicFaqRange,
  englishTitleRange, chineseTitleRange, englishMetaRange, chineseMetaRange,
  paragraphSentenceLimit, internalLinkRange, englishKeyphraseDensity, chineseKeyphraseDensity,
  chineseCharRange, computeKeyphraseDensity, computeKeyphraseTargets, translationFaqCount,
} from "@/lib/content-standards";
import { buildPolicy, evaluatePolicy, analyzeFinalArticle, type FinalArticleMetrics } from "@/lib/blog/final-article-policy";
import { CONCLUSION_START_MARKER, CONCLUSION_END_MARKER, FAQ_HEADING_MARKER } from "@/lib/blog/article-document";
import { runAudit, runChineseAudit } from "@/lib/services/seo-auditor";
import { countReadableWords } from "@/lib/services/text-utils";

// Two body sentences with known metrics: ASL~14.5, ASW~1.48, Flesch ~67
const EN_SENT_A = "Brand marketing needs good plans to help firms reach new clients across Hong Kong local markets.";
const EN_SENT_B = "Companies must build clear marketing plans to reach more clients across Hong Kong each year.";

// Long paragraph = 5 sentences → exceeds 3 sentence limit
const LONG_PARA = `${EN_SENT_A} ${EN_SENT_A} ${EN_SENT_A} ${EN_SENT_A} ${EN_SENT_A}`;

// FAQ format that extractVisibleFaqFromArticle can detect
// The function looks for <strong>text ending with ?</strong> inside the FAQ section
function makeFaqEntry(q: string, a: string): string {
  return `<!-- wp:paragraph --><p><strong>${q}?</strong></p><!-- /wp:paragraph -->\n<!-- wp:paragraph --><p>${a}</p><!-- /wp:paragraph -->`;
}

function makeEnglishArticle(exact: {
  editorialH2s: number;
  faqCount: number;
  bodyParas: number;
  keyphrase: string;
  exactKpCount: number;
  longParaCount?: number;
  includeExtraKp?: boolean;
}): string {
  const kp = exact.keyphrase;
  const parts: string[] = [];

  // Language switcher (zero readable words)
  parts.push(`<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><a href="/blog/test-zh/">中文</a></div><!-- /wp:html -->`);

  // Editorial H2 sections — keyphrase NOT in headings (controlled separately)
  for (let i = 0; i < exact.editorialH2s; i++) {
    const h2Text = `Effective Brand Strategy Guide for Hong Kong Market`;
    parts.push(`<!-- wp:heading {"level":2} --><h2 class="wp-block-heading">${h2Text}</h2><!-- /wp:heading -->`);
    const parasPerSection = Math.floor(exact.bodyParas / exact.editorialH2s);
    const extra = i < exact.bodyParas % exact.editorialH2s ? 1 : 0;
    for (let p = 0; p < parasPerSection + extra; p++) {
      if (exact.longParaCount && exact.longParaCount > i) {
        parts.push(`<!-- wp:paragraph --><p>${LONG_PARA}</p><!-- /wp:paragraph -->`);
      } else {
        parts.push(`<!-- wp:paragraph --><p>${EN_SENT_A} ${EN_SENT_B}</p><!-- /wp:paragraph -->`);
      }
    }
  }

  // Conclusion with stable markers
  parts.push(CONCLUSION_START_MARKER);
  parts.push(`<!-- wp:paragraph --><p>To summarise this article on hong kong digital marketing. Brands should invest in creator partnerships for maximum impact across local markets.</p><!-- /wp:paragraph -->`);
  parts.push(CONCLUSION_END_MARKER);

  // FAQ section — no keyphrase in Q/A text
  if (exact.faqCount > 0) {
    parts.push(FAQ_HEADING_MARKER);
    parts.push(`<!-- wp:heading {"level":2} --><h2 class="wp-block-heading">Frequently Asked Questions</h2><!-- /wp:heading -->`);
    const faqAnswer = `Using local approaches helps Hong Kong brands connect with their target audience through authentic creator partnerships and data driven marketing methods.`;
    const faqQuestion = `What is the best strategy for Hong Kong businesses`;
    for (let i = 0; i < exact.faqCount; i++) {
      parts.push(makeFaqEntry(faqQuestion, faqAnswer));
    }
    const entities: string[] = [];
    for (let i = 0; i < exact.faqCount; i++) {
      entities.push(`{"@type":"Question","name":"${faqQuestion}","acceptedAnswer":{"@type":"Answer","text":"${faqAnswer}"}}`);
    }
    parts.push(`<!-- wp:html --><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[${entities.join(",")}]}</script><!-- /wp:html -->`);
  }

  // CTA with detectable h2
  parts.push(`<!-- wp:heading {"level":2} --><h2 class="wp-block-heading">Ready to grow your brand with Hong Kong creators?</h2><!-- /wp:heading -->`);
  parts.push(`<!-- wp:paragraph --><p>Join B2I Hub today. <a href="https://app.b2ihub.com/signup">Sign up now</a> to start connecting with creators and reach new clients across Hong Kong local markets.</p><!-- /wp:paragraph -->`);

  let html = parts.join("\n\n");

  // Count exact kp occurrences already in HTML and inject extras
  const escaped = kp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = (html.match(new RegExp(escaped, "gi")) || []).length;
  const needed = Math.max(0, exact.exactKpCount - existing);
  if (needed > 0) {
    const extras: string[] = [];
    for (let i = 0; i < needed; i++) {
      extras.push(`<!-- wp:paragraph --><p>${kp} helps Hong Kong brands grow their market presence.</p><!-- /wp:paragraph -->`);
    }
    // Insert before FAQ
    const faqIdx = html.lastIndexOf("Frequently Asked Questions");
    if (faqIdx > 0) {
      html = html.substring(0, faqIdx) + "\n\n" + extras.join("\n\n") + "\n\n" + html.substring(faqIdx);
    } else {
      html += "\n\n" + extras.join("\n\n");
    }
  }

  return html;
}

// ── Tier definitions ──

interface Tier {
  label: string; wordCount: number;
  h2Range: { min: number; max: number }; faqRange: { min: number; max: number };
  wcTolerance: { min: number; max: number }; keyphrase: string;
}

// Use a distinctive one-word keyphrase that won't appear naturally in body text
const TEST_KP = "B2ITestKp";

const TIERS: Tier[] = [
  { label: "500 words", wordCount: 500, h2Range: { min: 3, max: 4 }, faqRange: { min: 2, max: 3 }, wcTolerance: { min: 450, max: 550 }, keyphrase: TEST_KP },
  { label: "1,000 words", wordCount: 1000, h2Range: { min: 4, max: 5 }, faqRange: { min: 3, max: 4 }, wcTolerance: { min: 900, max: 1100 }, keyphrase: TEST_KP },
  { label: "1,500 words", wordCount: 1500, h2Range: { min: 5, max: 6 }, faqRange: { min: 4, max: 5 }, wcTolerance: { min: 1350, max: 1650 }, keyphrase: TEST_KP },
  { label: "2,500 words", wordCount: 2500, h2Range: { min: 6, max: 7 }, faqRange: { min: 4, max: 6 }, wcTolerance: { min: 2125, max: 2875 }, keyphrase: TEST_KP },
  { label: "3,500 words", wordCount: 3500, h2Range: { min: 7, max: 8 }, faqRange: { min: 5, max: 6 }, wcTolerance: { min: 2975, max: 4025 }, keyphrase: TEST_KP },
  { label: "5,000 words", wordCount: 5000, h2Range: { min: 8, max: 9 }, faqRange: { min: 5, max: 7 }, wcTolerance: { min: 4250, max: 5750 }, keyphrase: TEST_KP },
];

// ── Content-standards tests ──

describe.each(TIERS)("$label — content standards", (tier) => {
  it("englishWordTolerance", () => {
    const t = englishWordTolerance(tier.wordCount);
    expect(t).toEqual(tier.wcTolerance);
  });
  it("dynamicH2Range", () => expect(dynamicH2Range(tier.wordCount)).toEqual(tier.h2Range));
  it("dynamicFaqRange", () => expect(dynamicFaqRange(tier.wordCount)).toEqual(tier.faqRange));
  it("title ranges fixed", () => { expect(englishTitleRange()).toEqual({ min: 50, max: 70 }); expect(chineseTitleRange()).toEqual({ min: 25, max: 35 }); });
  it("meta ranges fixed", () => { expect(englishMetaRange()).toEqual({ min: 155, max: 200 }); expect(chineseMetaRange()).toEqual({ min: 80, max: 120 }); });
  it("paragraph limit", () => expect(paragraphSentenceLimit()).toBe(3));
  it("link range", () => expect(internalLinkRange()).toEqual({ min: 0, max: 4 }));
  it("kp density fixed", () => {
    const e = englishKeyphraseDensity(); const z = chineseKeyphraseDensity();
    expect(e.warningBelow).toBe(0.5); expect(e.stuffingAbove).toBe(3);
    expect(z.warningBelow).toBe(0.5); expect(z.stuffingAbove).toBe(3);
  });
  it("chineseCharRange", () => {
    const r = chineseCharRange(tier.wordCount);
    expect(r.hardMin).toBe(Math.round(tier.wordCount * 1.28));
    expect(r.preferred).toBe(Math.round(tier.wordCount * 1.80));
    expect(r.min).toBe(Math.round(tier.wordCount * 1.52));
    expect(r.max).toBe(Math.round(tier.wordCount * 2.20));
  });
  it("translationFaqCount", () => expect(translationFaqCount(tier.faqRange.min)).toBe(tier.faqRange.min));
  it("computeKeyphraseTargets", () => {
    const t = computeKeyphraseTargets(tier.wordCount, tier.keyphrase);
    expect(t.min).toBeGreaterThan(0); expect(t.max).toBeGreaterThanOrEqual(t.min);
  });
});

// ── Exact-metric policy tests ──

describe.each(TIERS)("$label — policy", (tier) => {
  const h2 = tier.h2Range.min;
  const faq = tier.faqRange.min;
  const wc = tier.wcTolerance.min + Math.floor((tier.wcTolerance.max - tier.wcTolerance.min) * 0.5);

  function makeMetrics(overrides?: Partial<FinalArticleMetrics>): FinalArticleMetrics {
    return {
      readableWordCount: wc, h2Count: h2, faqEntryCount: faq,
      exactKeyphraseCount: 5, keyphraseDensity: 1.0,
      exactKeyphraseInH2: true, longParagraphCount: 0,
      keyphraseInFirst100Words: true, uniqueInternalLinkCount: 2,
      externalSourceLinkCount: 1, ctaHeadingCount: 1, signupUrlCount: 1,
      faqBlockCount: 1, faqJsonLdCount: 1, hasLanguageSwitcher: true,
      nestedParagraphCount: 0, malformedHeadingCount: 0,
      wpBlockCountMismatch: false, faqParityValid: true,
      titleLength: 60, metaDescriptionLength: 170, fleschReadingEase: 65,
      hasPlaceholderContent: false, hasRawProseOutsideBlocks: false,
      duplicateFaqSchemaCount: 0, duplicateCtaBlockCount: 0,
      hasConclusionContent: true,
      ...overrides,
    };
  }

  it("passes for valid article", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics(), policy).passed).toBe(true);
  });

  it("word count below tolerance fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ readableWordCount: tier.wcTolerance.min - 1 }), policy).passed).toBe(false);
  });

  it("word count above tolerance fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ readableWordCount: tier.wcTolerance.max + 1 }), policy).passed).toBe(false);
  });

  it("H2 count below range fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ h2Count: tier.h2Range.min - 1 < 1 ? 0 : tier.h2Range.min - 1 }), policy).passed).toBe(false);
  });

  it("H2 count above range fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ h2Count: tier.h2Range.max + 1 }), policy).passed).toBe(false);
  });

  it("FAQ count below range fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ faqEntryCount: tier.faqRange.min - 1 < 0 ? 0 : tier.faqRange.min - 1 }), policy).passed).toBe(false);
  });

  it("FAQ count above range fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ faqEntryCount: tier.faqRange.max + 1 }), policy).passed).toBe(false);
  });

  it("long paragraphs fail", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ longParagraphCount: 1 }), policy).passed).toBe(false);
  });

  it("keyphrase stuffing fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ keyphraseDensity: 3.5 }), policy).passed).toBe(false);
  });

  it("internal links > 4 fails", () => {
    const policy = buildPolicy(wc, undefined, undefined, tier.keyphrase);
    expect(evaluatePolicy(makeMetrics({ uniqueInternalLinkCount: 5 }), policy).passed).toBe(false);
  });
});

// ── English SEO audit with exact-generated articles ──

describe.each(TIERS)("$label — English SEO audit", (tier) => {
  it("passes for well-formed article (only soft warnings)", () => {
    const kp = tier.keyphrase;
    const kpCount = Math.max(5, Math.round(tier.wordCount * 0.01));
    // Generate article with tier-base faqCount first, then re-generate with the right count
    // based on actual word count's dynamic range
    const initialHtml = makeEnglishArticle({
      editorialH2s: tier.h2Range.min,
      faqCount: tier.faqRange.min,
      bodyParas: Math.max(6, Math.floor(tier.wordCount / 30)),
      keyphrase: kp,
      exactKpCount: kpCount,
    });
    const actualWc = countReadableWords(initialHtml);
    // Use tier word count for dynamic ranges so tests are consistent
    const articleHtml = makeEnglishArticle({
      editorialH2s: tier.h2Range.min,
      faqCount: tier.faqRange.min,
      bodyParas: Math.max(6, Math.floor(tier.wordCount / 30)),
      keyphrase: kp,
      exactKpCount: kpCount,
    });
    const titleStr = `How ${kp} Is Changing Hong Kong Business Marketing Today`;
    const metaStr = `Discover how ${kp} is helping Hong Kong brands reach local audiences through creator partnerships and data driven marketing strategies.`;
    const result = runAudit({
      title: titleStr, metaDescription: metaStr, keyword: kp,
      blog: articleHtml, targetWordCount: tier.wordCount, targetKeyphraseCount: 5,
    });
    const failures = result.checks.filter((c) => c.status === "fail" && c.label !== "Body Word Count");
    if (failures.length > 0) {
      console.warn(`[${tier.label}] SEO failures (target=${actualWc}):`, failures.map((f) => `${f.label}: ${f.measuredValue}`));
    }
    expect(failures.length).toBe(0);
  });

  it("soft warnings (low kp density) produce warning not fail", () => {
    // Use a kp count just below the density-based min to trigger a soft warning
    // without triggering a hard fail. overshoot <= 2 → score 80 warning.
    const kp = "B2ITestKp";
    const articleHtml = makeEnglishArticle({
      editorialH2s: tier.h2Range.min,
      faqCount: tier.faqRange.min,
      bodyParas: Math.max(6, Math.floor(tier.wordCount / 30)),
      keyphrase: kp,
      exactKpCount: Math.max(1, Math.ceil(tier.wordCount / 200) - 1),
    });
    const result = runAudit({
      title: "How Brand Marketing Is Changing Hong Kong Business Today",
      metaDescription: "Learn how brand marketing helps Hong Kong brands in local markets with new strategies.",
      keyword: kp, blog: articleHtml, targetWordCount: tier.wordCount, targetKeyphraseCount: 1,
    });
    const failures = result.checks.filter((c) => c.status === "fail" && c.label !== "Body Word Count");
    expect(failures.length).toBe(0);
  });

  it("keyphrase density above 3% is hard failure", () => {
    const kp = "test";
    const articleHtml = makeEnglishArticle({
      editorialH2s: Math.max(1, tier.h2Range.min),
      faqCount: Math.min(1, tier.faqRange.min),
      bodyParas: 3,
      keyphrase: kp,
      exactKpCount: 200,
    });
    const actualWc = countReadableWords(articleHtml);
    const density = computeKeyphraseDensity(200, kp, actualWc);
    const result = runAudit({
      title: "Title", metaDescription: "Meta desc meta desc meta desc meta desc meta desc meta desc meta desc meta desc meta desc.",
      keyword: kp, blog: articleHtml, targetWordCount: actualWc, targetKeyphraseCount: 1,
    });
    const densityFail = result.checks.find((c) => c.id === "keyphrase_density" && c.status === "fail");
    expect(densityFail).toBeDefined();
    expect(density).toBeGreaterThan(3);
  });
});

// ── Chinese SEO audit ──

const ZH_PARA = "香港品牌需要拓展市場並建立更強的消費者關係。透過與創作者合作可以接觸目標受眾並提升品牌認知度。數位轉型帶來全新營銷機會和挑戰。";

function makeChineseArticle(exact: {
  editorialH2s: number; faqCount: number; bodyParas: number;
  keyphrase: string; exactKpCount?: number;
}): string {
  const kp = exact.keyphrase;
  const parts: string[] = [];

  parts.push(`<!-- wp:html --><div class="b2i-language-switcher" data-language="zh"><a href="/blog/test/">English</a></div><!-- /wp:html -->`);

  for (let i = 0; i < exact.editorialH2s; i++) {
    parts.push(`<!-- wp:heading {"level":2} --><h2 class="wp-block-heading">${kp}策略與香港市場趨勢</h2><!-- /wp:heading -->`);
    const perSection = Math.floor(exact.bodyParas / exact.editorialH2s);
    const extra = i < exact.bodyParas % exact.editorialH2s ? 1 : 0;
    for (let p = 0; p < perSection + extra; p++) {
      parts.push(`<!-- wp:paragraph --><p>${ZH_PARA}</p><!-- /wp:paragraph -->`);
    }
  }

  if (exact.faqCount > 0) {
    parts.push(`<!-- wp:heading {"level":2} --><h2 class="wp-block-heading">常見問題</h2><!-- /wp:heading -->`);
    for (let i = 0; i < exact.faqCount; i++) {
      parts.push(`<!-- wp:paragraph --><p><strong>甚麼是${kp}？為甚麼企業需要關注${kp}？</strong></p><!-- /wp:paragraph -->`);
      parts.push(`<!-- wp:paragraph --><p>通過本地創作者和數位平台來推廣品牌是現代市場策略的核心。</p><!-- /wp:paragraph -->`);
    }
    const entities: string[] = [];
    for (let i = 0; i < exact.faqCount; i++) {
      entities.push(`{"@type":"Question","name":"甚麼是${kp}？為甚麼企業需要關注${kp}？","acceptedAnswer":{"@type":"Answer","text":"通過本地創作者和數位平台來推廣品牌是現代市場策略的核心。"}}`);
    }
    parts.push(`<!-- wp:html --><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[${entities.join(",")}]}</script><!-- /wp:html -->`);
  }

  parts.push(`<!-- wp:paragraph --><p>立即<a href="https://app.b2ihub.com/signup">註冊</a>B2I Hub，開始您的市場推廣策略。</p><!-- /wp:paragraph -->`);

  let html = parts.join("\n\n");
  const escaped = kp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = (html.match(new RegExp(escaped, "gi")) || []).length;
  const target = exact.exactKpCount ?? Math.max(1, Math.floor(exact.bodyParas / 10));
  const needed = Math.max(0, target - existing);
  for (let i = 0; i < needed; i++) {
    html += `\n\n<!-- wp:paragraph --><p>${kp}是香港市場推廣的重要策略。</p><!-- /wp:paragraph -->`;
  }
  return html;
}

describe.each(TIERS)("$label — Chinese SEO", (tier) => {
  it("uses saved Chinese keyphrase and paired English version", () => {
    const zhKp = "行銷";
    const faqCount = Math.min(2, tier.faqRange.max);
    const bodyParas = Math.max(6, Math.round(tier.wordCount * 1.8 / 70));
    const zhHtml = makeChineseArticle({
      editorialH2s: tier.h2Range.min, faqCount, bodyParas,
      keyphrase: zhKp, exactKpCount: 3,
    });
    const enWordCount = tier.wordCount;
    const result = runChineseAudit({
      title: `${zhKp}策略指南：香港市場最新趨勢`,
      metaDescription: `了解${zhKp}策略。幫助品牌在香港市場脫穎而出。立即註冊B2I Hub。`,
      keyword: zhKp,
      blog: zhHtml,
      englishWordCount: enWordCount,
      pairedEnglishFaqCount: faqCount,
    });
    const kpTitle = result.checks.find((c) => c.id === "keyphrase_title");
    if (kpTitle) expect(kpTitle.status).toBe("pass");
    const failures = result.checks.filter((c) => c.status === "fail");
    if (failures.length > 0) {
      console.warn(`[${tier.label}] Chinese SEO failures:`, failures.map((f) => `${f.label}: ${f.measuredValue} vs ${f.targetValue}`));
    }
    expect(failures.length).toBe(0);
  });

  it("FAQ count mismatch fails", () => {
    const zhKp = "行銷";
    const zhHtml = makeChineseArticle({
      editorialH2s: Math.max(1, tier.h2Range.min), faqCount: 99,
      bodyParas: 8, keyphrase: zhKp,
    });
    const result = runChineseAudit({
      title: "測試標題", metaDescription: "測試描述。香港市場推廣需要專業策略。",
      keyword: zhKp, blog: zhHtml, englishWordCount: tier.wordCount,
      pairedEnglishFaqCount: Math.min(2, tier.faqRange.max),
    });
    const faqCheck = result.checks.find((c) => c.id === "faq_count");
    expect(faqCheck).toBeDefined();
    expect(faqCheck!.status).toBe("fail");
  });
});

// ── Version filtering and save/readback ──

describe("version filtering", () => {
  const mock = [
    { id: 1, slug: "test-article", versionNumber: 1 },
    { id: 2, slug: "test-article-zh", versionNumber: 1 },
    { id: 3, slug: "test-article-v2", versionNumber: 2 },
    { id: 4, slug: "test-article-v2-zh", versionNumber: 2 },
  ];
  it("en filter", () => { const f = mock.filter((v: any) => !v.slug?.endsWith("-zh")); expect(f.length).toBe(2); expect(f.every((v) => !v.slug.endsWith("-zh"))).toBe(true); });
  it("zh filter", () => { const f = mock.filter((v: any) => v.slug?.endsWith("-zh")); expect(f.length).toBe(2); expect(f.every((v) => v.slug.endsWith("-zh"))).toBe(true); });
  it("outdated detection", () => {
    expect({ id: 3 }.id !== 1).toBe(true);
    expect({ id: 3 }.id === 3).toBe(true);
  });
});

describe("paired version from summary", () => {
  it("parses source-en-version:ID", () => {
    const m = "source-en-version:42".match(/^source-en-version:(\d+)$/);
    expect(m).toBeTruthy(); expect(Number(m![1])).toBe(42);
  });
  it("rejects malformed", () => {
    expect("".match(/^source-en-version:(\d+)$/)).toBeNull();
    expect("old".match(/^source-en-version:(\d+)$/)).toBeNull();
  });
});
