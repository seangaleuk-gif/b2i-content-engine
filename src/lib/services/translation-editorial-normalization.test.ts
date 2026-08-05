import { describe, expect, it } from "vitest";
import { normalizeZhDocumentEditorialQuality } from "./translation-service";
import { normalizeChineseEditorialText, findForbiddenTermIssues, findFormalRegisterIssues, buildTranslationGlossaryPrompt, chineseEndingPunctuation } from "./translation-glossary";
import { stripRedundantCtaTriple } from "./translation-ai";
import { checkCompleteness, hasExcessiveEnglish, hasEnglishHeavyProseBlock } from "./translation-validator";
import type { ArticleDocument, FaqEntry } from "@/lib/blog/article-document";
import { renderArticleDocument, parseWordPressEditorialBlocks } from "@/lib/blog/article-document";

function paragraph(text: string) {
  return { id: `p-${Math.random().toString(36).slice(2)}`, type: "paragraph" as const, content: [{ type: "text" as const, text }] };
}

function blockText(blocks: import("@/lib/blog/article-content").EditorialBlock[], index: number): string {
  const block = blocks[index];
  if (block.type === "paragraph") return block.content[0].text;
  return "";
}

function docWith(overrides?: Partial<ArticleDocument>): ArticleDocument {
  return {
    metadata: {
      title: "香港創作者市場推廣：為何真實聲音更勝一籌 | B2I Hub",
      slug: "hong-kong-influencer-marketing-zh",
      metaDescription: "了解為何香港品牌選擇真實創作者而非大粉絲數。學習真實聲音如何在創作者市場推廣中建立信任並推動成果。",
      excerpt: "香港創作者市場推廣正由追逐追蹤人數轉向重視真實聲音。",
      targetWordCount: 2500,
      focusKeyphrase: "香港創作者市場推廣",
    },
    languageSwitcher: null,
    introduction: { id: "zh-intro", blocks: [
      paragraph("創作者市場推廣喺香港係一個靠口碑運作嘅城市。由人人皆知邊度奶茶最好飲嘅茶餐廳，去到朋友之間交換購物貼士嘅群組，信任傳播得特別快。正正因為咁，創作者市場推廣喺呢度搵到咁肥沃嘅土壤。"),
      paragraph("但係香港嘅創作者市場推廣，並唔係淨係搵個追蹤人數多嘅人，畀錢佢出post咁簡單。"),
    ], status: "generated" },
    sections: [{
      id: "zh-section-0",
      blocks: [
        paragraph("為何要與香港的網紅營銷代理合作？呢個問題係好多品牌都會問。影響力行銷同網紅營銷喺香港市場推廣入面好常見。"),
      ],
      heading: "為何要與香港的網紅營銷代理合作？",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
    }],
    visibleFaq: [
      { question: "香港創作者市場推廣需要幾多預算？", answerText: "預算因品牌而異，通常由數千港元起。", answerHtml: "<p>預算因品牌而異，通常由數千港元起。</p>" },
    ],
    conclusion: { id: "zh-conc", blocks: [
      paragraph("總結嚟講，香港創作者市場推廣係品牌建立信任嘅好方法。"),
      paragraph("來源：點解你唔應該自己管理香港嘅影響力行銷？。"),
    ], status: "generated" },
    cta: {
      id: "zh-cta",
      type: "cta",
      html: "<!-- wp:html -->\n<div class=\"cta\">準備好與香港創作者拓展你的品牌？ B2I Hub 直接連結企業與已認證創作者——無中介、無佣金、無中間人。立即免費建立你的檔案。 <a href=\"https://app.b2ihub.com/signup\">建立免費檔案</a></div>\n<!-- /wp:html -->",
      fingerprint: "x",
    },
    faqSchema: null,
    insertedLinks: [],
    ...overrides,
  };
}

describe("normalizeChineseEditorialText — terminology and register", () => {
  it("standardizes forbidden marketing terms to 創作者市場推廣", () => {
    const text = "影響力行銷同網紅營銷係常見嘅KOL市場推廣策略，KOL可以幫品牌。";
    const result = normalizeChineseEditorialText(text);
    expect(result).not.toContain("影響力行銷");
    expect(result).not.toContain("網紅營銷");
    expect(result).not.toContain("KOL市場推廣");
    expect(result).not.toContain("KOL");
    expect(result).toContain("創作者市場推廣");
  });

  it("converts formal written Chinese markers to conversational Cantonese", () => {
    const result = normalizeChineseEditorialText("我們為何如何是否應該使用這個方法？這不是他們想要的。");
    expect(result).toContain("我哋");
    expect(result).toContain("點解");
    expect(result).toContain("點樣");
    expect(result).toContain("係咪");
    expect(result).toContain("呢個");
    expect(result).toContain("佢哋");
    expect(result).not.toContain("我們");
    expect(result).not.toContain("他們");
  });

  it("does not corrupt protected compounds containing 與", () => {
    const result = normalizeChineseEditorialText("品牌與其依賴大網紅，不如與創作者合作。參與度同互動率都好重要。");
    expect(result).toContain("與其");
    expect(result).toContain("參與");
  });

  it("repairs literal or unnatural phrases", () => {
    const result = normalizeChineseEditorialText("你會信一幅靚仔廣告定係朋友推薦？TikTok-focused嘅合作夥伴先啱。");
    expect(result).toContain("精美廣告");
    expect(result).toContain("專注TikTok嘅");
  });

  it("normalizes 資料來源 to 來源", () => {
    const result = normalizeChineseEditorialText("資料來源：AnyMind Group");
    expect(result).toContain("來源：");
    expect(result).not.toContain("資料來源");
  });

  it("findForbiddenTermIssues flags non-canonical marketing terms", () => {
    expect(findForbiddenTermIssues("用網紅營銷推廣品牌")).toHaveLength(1);
    expect(findForbiddenTermIssues("創作者市場推廣係正路")).toHaveLength(0);
  });

  it("findFormalRegisterIssues flags formal written Chinese", () => {
    expect(findFormalRegisterIssues("我們應該如何處理？")).toHaveLength(2);
    expect(findFormalRegisterIssues("我哋應該點樣處理？")).toHaveLength(0);
  });

  it("does not flag protected register compounds containing 與", () => {
    expect(findFormalRegisterIssues("品牌與其依賴大網紅，不如依靠創作者。")).not.toContain("formal written Chinese; use \"同\"");
    expect(findFormalRegisterIssues("呢個唔係與否嘅問題，而係點樣做。")).toHaveLength(0);
    expect(findFormalRegisterIssues("參與度同互動率都好重要。")).toHaveLength(0);
  });

  it("still flags and normalizes a standalone formal 與 to 同", () => {
    expect(findFormalRegisterIssues("品牌與創作者合作。")).toContain("formal written Chinese; use \"同\"");
    const result = normalizeChineseEditorialText("品牌與創作者合作。");
    expect(result).toContain("品牌同創作者合作。");
    expect(result).not.toContain("品牌與創作者");
  });

  it("preserves 與其…不如…, 與否 and 參與 verbatim through normalization", () => {
    const result = normalizeChineseEditorialText("品牌與其依賴大網紅，不如與創作者合作。呢個唔係與否嘅問題。參與度好重要。");
    expect(result).toContain("與其");
    expect(result).toContain("不如");
    expect(result).toContain("與否");
    expect(result).toContain("參與");
  });

  it("glossary prompt contains the canonical term and forbidden list", () => {
    const prompt = buildTranslationGlossaryPrompt();
    expect(prompt).toContain("創作者市場推廣");
    expect(prompt).toContain("影響力行銷");
    expect(prompt).toContain("網紅營銷");
    expect(prompt).toContain("KOL市場推廣");
  });
});

describe("stripRedundantCtaTriple", () => {
  it("removes the redundant triple formulation", () => {
    expect(stripRedundantCtaTriple("直接連結企業與已認證創作者——無中介、無佣金、無中間人。立即免費建立你的檔案。"))
      .not.toContain("無中介");
    expect(stripRedundantCtaTriple("直接連結企業與已認證創作者——無中介、無佣金、無中間人。立即免費建立你的檔案。"))
      .toContain("直接連結企業與已認證創作者");
  });
});

describe("normalizeZhDocumentEditorialQuality — document-level", () => {
  const paragraphText = (blocks: import("@/lib/blog/article-content").EditorialBlock[], index: number): string => {
    const block = blocks[index];
    if (block.type === "paragraph") return block.content[0].text;
    return "";
  };

  it("normalizes terminology, register and literal phrases across prose, headings and FAQ", () => {
    const doc = docWith();
    const { changes } = normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(changes).toBeGreaterThan(0);

    const introText = paragraphText(doc.introduction.blocks, 0);
    expect(introText).toContain("發展得咁好");
    expect(introText).not.toContain("肥沃嘅土壤");

    const sectionHeading = doc.sections[0].heading;
    expect(sectionHeading).toContain("點解");
    expect(sectionHeading).toContain("創作者市場推廣代理");
    expect(sectionHeading).not.toContain("網紅營銷");

    const sectionBody = paragraphText(doc.sections[0].blocks, 0);
    expect(sectionBody).toContain("創作者市場推廣");
    expect(sectionBody).not.toContain("影響力行銷");
    expect(sectionBody).not.toContain("網紅營銷");
  });

  it("normalizes source labels and strips trailing ？。", () => {
    const doc = docWith();
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const sourceText = paragraphText(doc.conclusion.blocks, 1);
    expect(sourceText.startsWith("來源：")).toBe(true);
    expect(sourceText).not.toMatch(/[。！？]+$/u);
  });

  it("removes CTA redundancy while preserving structure", () => {
    const doc = docWith();
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(doc.cta!.html).not.toContain("無中介、無佣金、無中間人");
    expect(doc.cta!.html).toContain("app.b2ihub.com/signup");
    expect(doc.cta!.html).toContain("wp:html");
    expect(doc.cta!.html).toContain("<div");
  });

  it("preserves numbers, URLs and block structure", () => {
    const doc = docWith();
    doc.sections[0].blocks.push(
      paragraph("香港有 750 萬人口，市場推廣成本由 HK$50,000 起，詳見 https://example.com/guide 。"),
    );
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const htmlAfter = renderArticleDocument(doc);
    expect(htmlAfter).toContain("750");
    expect(htmlAfter).toContain("HK$50,000");
    expect(htmlAfter).toContain("https://example.com/guide");
    // Block count unchanged
    expect(doc.sections[0].blocks).toHaveLength(2);
    expect(htmlAfter).toContain("<!-- wp:paragraph -->");
  });

  it("places the exact keyphrase within the first 200 characters", () => {
    const doc = docWith();
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const readable = renderArticleDocument(doc)
      .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const first200 = readable.substring(0, 200);
    expect(first200).toContain("香港創作者市場推廣");
  });

  it("caps exact-keyphrase density at 1.5% using natural variations", () => {
    const doc = docWith();
    // Introduce a heavily repeated exact keyphrase alongside realistic-length prose.
    const filler = paragraph(
      "香港品牌近年越來越重視真實聲音，因為消費者對硬銷內容已經麻木。創作者市場推廣嘅成功，建基於真誠嘅內容、穩定嘅發佈節奏，同埋品牌同創作者之間嘅互信關係。呢種做法唔單止提升互動率，仲可以建立長期嘅品牌忠誠度。"
        .repeat(8),
    );
    const repeats = Array.from({ length: 10 }, () => paragraph("香港創作者市場推廣係品牌建立信任嘅方法，需要長期經營同真誠內容。"));
    doc.sections[0].blocks = [...doc.sections[0].blocks, filler, ...repeats];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");

    const html = renderArticleDocument(doc);
    const readable = html
      .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const zhChars = (html
      .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/[a-zA-Z0-9]/g, "")
      .match(/[\u3400-\u9fff]/gu) || []).length;
    const exact = (readable.match(/香港創作者市場推廣/g) || []).length;
    const density = (exact * 8 / zhChars) * 100;
    expect(zhChars).toBeGreaterThan(1000);
    expect(density).toBeLessThanOrEqual(1.5);
    expect(exact).toBeGreaterThan(0);
  });

  it("expands a short meta description to the 80–120 range", () => {
    const doc = docWith();
    doc.metadata.metaDescription = "了解香港品牌點樣揀創作者。";
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const len = [...doc.metadata.metaDescription].length;
    expect(len).toBeGreaterThanOrEqual(80);
    expect(len).toBeLessThanOrEqual(120);
  });

  it("preserves FAQ parity surface after normalization", () => {
    const doc = docWith();
    const faq: FaqEntry[] = [
      { question: "香港創作者市場推廣需要幾多預算？", answerText: "預算因品牌而異，通常由數千港元起。", answerHtml: "<p>預算因品牌而異，通常由數千港元起。</p>" },
    ];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣", faq);
    expect(faq[0].question).toContain("？");
    expect(faq[0].answerText).toContain("數千港元");
  });
});

describe("CTA editorial normalization (register before redundancy)", () => {
  it("converts CTA 與香港創作者 to 同香港創作者 while preserving HTML and URL", () => {
    const doc = docWith();
    doc.cta = {
      id: "zh-cta",
      type: "cta",
      html: "<!-- wp:html -->\n<div class=\"cta\">準備好與香港創作者拓展你的品牌？立即免費建立你的檔案。 <a href=\"https://app.b2ihub.com/signup\">建立免費檔案</a></div>\n<!-- /wp:html -->",
      fingerprint: "x",
    };
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(doc.cta!.html).toContain("同香港創作者");
    expect(doc.cta!.html).not.toContain("與香港創作者");
    expect(doc.cta!.html).toContain("app.b2ihub.com/signup");
    expect(doc.cta!.html).toContain("wp:html");
    expect(doc.cta!.html).toContain("<div");
  });

  it("applies register before stripping redundant CTA triple", () => {
    const html = "準備好與香港創作者拓展你的品牌？直接連結企業與已認證創作者——無中介、無佣金、無中間人。";
    const result = stripRedundantCtaTriple(html);
    expect(result).not.toContain("無中介、無佣金、無中間人");
  });
});

describe("citation-label exemption from English-leakage detection", () => {
  const sourceHtml =
    "<!-- wp:paragraph --><p>English source paragraph content that must be translated completely into Chinese for the article.</p><!-- /wp:paragraph -->" +
    '<!-- wp:paragraph --><p>Source: <a href="https://example.com/research">How do influencer marketing strategies differ across platforms in Hong Kong?</a>.</p><!-- /wp:paragraph -->' +
    "<!-- wp:paragraph --><p>Another English source sentence here for the article body.</p><!-- /wp:paragraph -->";

  it("passes completeness when Chinese prose carries an English linked source title", () => {
    const citation =
      "<!-- wp:paragraph --><p>香港品牌近年越來越重視真實聲音，因為消費者對硬銷內容已經麻木。創作者市場推廣嘅成功，建基於真誠嘅內容同穩定嘅發佈節奏。</p><!-- /wp:paragraph -->" +
      '<!-- wp:paragraph --><p>來源：<a href="https://example.com/research">How do influencer marketing strategies differ across platforms in Hong Kong?</a>。</p><!-- /wp:paragraph -->' +
      "<!-- wp:paragraph --><p>呢個數據顯示，超過七成受訪者更加信賴真實嘅用家評論，所以品牌需要長期經營。</p><!-- /wp:paragraph -->";
    expect(hasExcessiveEnglish(citation)).toBe(false);
    expect(hasEnglishHeavyProseBlock(citation)).toBe(false);
    expect(checkCompleteness(sourceHtml, citation, "section-1").passed).toBe(true);
  });

  it("recognizes 資料來源 and Source: citation labels", () => {
    const citeZh = "<!-- wp:paragraph --><p>資料來源：<a href=\"https://x.com/a\">The Leading Influencer Marketing Company in Hong Kong</a>。</p><!-- /wp:paragraph -->";
    expect(hasEnglishHeavyProseBlock(citeZh)).toBe(false);
    const citeEn = '<!-- wp:paragraph --><p>Source: <a href="https://x.com/b">How to Find the Right Influencer Marketing Agency in Hong Kong</a>.</p><!-- /wp:paragraph -->';
    expect(hasEnglishHeavyProseBlock(citeEn)).toBe(false);
  });

  it("exempts 來源： plus a plain-text English source title from both validators", () => {
    const cite = "<!-- wp:paragraph --><p>來源：Hong Kong Social Media Creator Marketing | AnyMind Group。</p><!-- /wp:paragraph -->";
    expect(hasExcessiveEnglish(cite)).toBe(false);
    expect(hasEnglishHeavyProseBlock(cite)).toBe(false);
  });

  it("exempts Source: plus a plain-text English source title from both validators", () => {
    const cite = "<!-- wp:paragraph --><p>Source: Why you should not manage your own influencer marketing.</p><!-- /wp:paragraph -->";
    expect(hasExcessiveEnglish(cite)).toBe(false);
    expect(hasEnglishHeavyProseBlock(cite)).toBe(false);
  });

  it("exempts a plain-text citation inside a longer Chinese component from both validators", () => {
    const zh = "<!-- wp:paragraph --><p>香港品牌近年越來越重視真實聲音，因為消費者對硬銷內容已經麻木。創作者市場推廣嘅成功，建基於真誠嘅內容。</p><!-- /wp:paragraph -->" +
      "<!-- wp:paragraph --><p>來源：How to Find the Right Influencer Marketing Agency in Hong Kong。</p><!-- /wp:paragraph -->" +
      "<!-- wp:paragraph --><p>呢個數據顯示，超過七成受訪者更加信賴真實嘅用家評論，所以品牌需要長期經營。</p><!-- /wp:paragraph -->";
    expect(hasExcessiveEnglish(zh)).toBe(false);
    expect(hasEnglishHeavyProseBlock(zh)).toBe(false);
  });

  it("keeps isolated platform names, brands, acronyms, URLs and four-word runs allowed", () => {
    const allowed = "<!-- wp:paragraph --><p>品牌可以用 Instagram、YouTube、TikTok 同 KPI 衡量成效，亦可以參考 B2C 企業嘅做法。</p><!-- /wp:paragraph -->" +
      "<!-- wp:paragraph --><p>Open Influence 同 Assembly 呢啲代理商都好出名，StarNgage 亦提供數據。</p><!-- /wp:paragraph -->" +
      '<!-- wp:paragraph --><p>更多資料可參考 <a href="https://example.com/research">研究報告</a>。</p><!-- /wp:paragraph -->';
    expect(hasExcessiveEnglish(allowed)).toBe(false);
    expect(hasEnglishHeavyProseBlock(allowed)).toBe(false);
  });

  it("still triggers both validators on a genuinely untranslated English paragraph", () => {
    const untranslated = "<!-- wp:paragraph --><p>Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell marketing content.</p><!-- /wp:paragraph -->";
    expect(hasExcessiveEnglish(untranslated)).toBe(true);
    expect(hasEnglishHeavyProseBlock(untranslated)).toBe(true);
  });

  it("still rejects genuine untranslated English prose", () => {
    const englishProse = "<!-- wp:paragraph --><p>Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell content.</p><!-- /wp:paragraph -->";
    expect(hasExcessiveEnglish(englishProse)).toBe(true);
    expect(hasEnglishHeavyProseBlock(englishProse)).toBe(true);
    expect(checkCompleteness(sourceHtml, englishProse, "section-1").passed).toBe(false);
  });
});

describe("final Cantonese editorial-polish repairs", () => {
  it("repairs duplicate words", () => {
    expect(normalizeChineseEditorialText("透過同啱嘅香港創作者或者創作者合作")).toBe("透過同啱嘅香港創作者合作");
  });

  it("repairs the 脗合 typo to 配合", () => {
    expect(normalizeChineseEditorialText("雙方要脗合先至得")).toBe("雙方要配合先至得");
  });

  it("repairs heading register/word order", () => {
    expect(normalizeChineseEditorialText("點解要喺香港同創作者市場推廣公司合作？")).toBe("點解要同香港嘅創作者市場推廣公司合作？");
  });

  it("normalizes formal headings into natural Hong Kong Cantonese", () => {
    expect(normalizeChineseEditorialText("品牌在創作者市場推廣中常犯的錯誤")).toBe("品牌做創作者市場推廣時常犯嘅錯誤");
    expect(normalizeChineseEditorialText("點樣選擇合適的創作者市場推廣合作夥伴")).toBe("點樣揀啱創作者市場推廣合作夥伴");
    expect(normalizeChineseEditorialText("衡量成功：從推廣活動到長期增長")).toBe("點樣衡量成效：由推廣活動到長期增長");
  });

  it("repairs literal phrases into natural Cantonese", () => {
    expect(normalizeChineseEditorialText("佢哋唔想做活動廣告板")).toContain("人肉廣告板");
    expect(normalizeChineseEditorialText("信任就係創作者市場推廣嘅貨幣")).toContain("創作者市場推廣最重要嘅基礎");
    expect(normalizeChineseEditorialText("可以令所有人保持誠實")).toContain("可以令雙方更清楚成效");
    expect(normalizeChineseEditorialText("佢會感覺好人性化")).toContain("成個訊息會自然同有人情味好多");
    expect(normalizeChineseEditorialText("創作者想被見到")).toContain("令人留意到");
  });

  it("rewrites the Open Influence sentence naturally without changing its factual meaning", () => {
    const result = normalizeChineseEditorialText("香港嘅代理商，好似Open Influence，會推動佢哋嘅團隊同全球網紅營銷意念進入新領域，為本地品牌帶嚟新嘅做法。");
    expect(result).toContain("Open Influence");
    expect(result).toContain("引入香港");
    expect(result).toContain("為本地品牌帶嚟新嘅做法");
    expect(result).not.toContain("進入新領域");
  });

  it("softens the unsupported absolute comparison", () => {
    const result = normalizeChineseEditorialText("一個有10,000位活躍追蹤者嘅創作者，可以比一個有過百萬但零互動嘅名人更快賣出產品。");
    expect(result).toContain("有時反而可以帶嚟更實際嘅互動同銷售成果");
    expect(result).not.toContain("更快賣出產品");
  });

  it("collapses accidental whitespace between CJK words", () => {
    expect(normalizeChineseEditorialText("創作者 市場推廣")).toBe("創作者市場推廣");
    expect(normalizeChineseEditorialText("要揀啱 創作者、優化預算")).toBe("要揀啱創作者、優化預算");
    expect(normalizeChineseEditorialText("或者 創作者 合作")).toBe("或者創作者合作");
  });

  it("preserves legitimate spaces around English, numbers, URLs and brand names", () => {
    const input = "Instagram 行得通，10,000 位，B2C 企業，同 Open Influence 合作 <a href=\"https://b2ihub.com\">連結</a>";
    expect(normalizeChineseEditorialText(input)).toBe(input);
  });

  it("repairs the duplicated creator phrase with accidental whitespace", () => {
    expect(normalizeChineseEditorialText("透過同啱嘅香港創作者或者 創作者 合作")).toBe("透過同啱嘅香港創作者合作");
  });

  it("repairs the broken possessive phrase", () => {
    expect(normalizeChineseEditorialText("最終，喺香港揀啱你創作者市場推廣嘅代理商，係一間明白你目標嘅代理商。"))
      .toBe("最終，喺香港揀啱你嘅創作者市場推廣代理商，係一間明白你目標嘅代理商。");
  });

  it("repairs literal 'human' phrase variants", () => {
    expect(normalizeChineseEditorialText("感覺好人性化。")).toContain("有人情味");
    expect(normalizeChineseEditorialText("佢會感覺好人性化")).toContain("成個訊息會自然同有人情味好多");
  });

  it("normalization is idempotent", () => {
    const input = "透過同啱嘅香港創作者或者 創作者 合作。揀啱你創作者市場推廣嘅代理商。感覺好人性化。";
    const once = normalizeChineseEditorialText(input);
    const twice = normalizeChineseEditorialText(once);
    expect(twice).toBe(once);
  });

  it("adds sentence-ending punctuation to paragraphs", () => {
    expect(chineseEndingPunctuation("品牌要揀啱創作者", "paragraph")).toBe("。");
    expect(chineseEndingPunctuation("品牌要揀啱創作者。", "paragraph")).toBe("");
    expect(chineseEndingPunctuation("品牌要揀啱創作者，", "paragraph")).toBe("");
    expect(chineseEndingPunctuation("品牌 2026 年", "paragraph")).toBe("。");
  });

  it("adds question marks to interrogative headings only", () => {
    expect(chineseEndingPunctuation("點解要同香港嘅創作者合作", "heading")).toBe("？");
    expect(chineseEndingPunctuation("品牌做創作者市場推廣時常犯嘅錯誤", "heading")).toBe("");
  });

  it("adds question marks to FAQ questions and full stops to answers", () => {
    expect(chineseEndingPunctuation("創作者市場推廣需要幾多預算", "question")).toBe("？");
    expect(chineseEndingPunctuation("預算因品牌而異", "paragraph")).toBe("。");
  });

  it("punctuates the whole document consistently (paragraphs, headings, FAQ)", () => {
    const doc = docWith();
    doc.sections[0].heading = "點解要同香港嘅創作者市場推廣公司合作？";
    doc.sections[0].blocks = [paragraph("品牌要揀啱創作者市場推廣合作夥伴")];
    const faq: FaqEntry[] = [
      { question: "創作者市場推廣需要幾多預算", answerText: "預算因品牌而異", answerHtml: "<p>預算因品牌而異</p>" },
    ];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣", faq);
    const sectionText = blockText(doc.sections[0].blocks, 0);
    expect(sectionText).toMatch(/。$/u);
    expect(faq[0].question).toMatch(/？$/u);
    expect(faq[0].answerText).toMatch(/。$/u);
    expect(faq[0].answerHtml).toContain("預算因品牌而異。");
  });

  it("applies the repairs to visible FAQ content and FAQ schema consistently", () => {
    const doc = docWith();
    const faq: FaqEntry[] = [
      { question: "點解要喺香港同創作者市場推廣公司合作？", answerText: "透過同啱嘅香港創作者或者創作者合作可以令雙方更清楚成效。", answerHtml: "<p>透過同啱嘅香港創作者或者創作者合作可以令雙方更清楚成效。</p>" },
    ];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣", faq);
    expect(faq[0].question).toBe("點解要同香港嘅創作者市場推廣公司合作？");
    expect(faq[0].answerText).toContain("透過同啱嘅香港創作者合作");
    expect(faq[0].answerText).toContain("可以令雙方更清楚成效");
    expect(faq[0].answerHtml).toContain("透過同啱嘅香港創作者合作");
  });

  it("preserves HTML, links, numbers, CTA, switcher and WordPress blocks while punctuating", () => {
    const doc = docWith();
    doc.sections[0].blocks = [
      paragraph("品牌有 750 萬個客戶"),
      { id: "link-block", type: "paragraph" as const, content: [
        { type: "text" as const, text: "詳情請睇 " },
        { type: "link" as const, text: "呢個指南", href: "https://example.com/guide" },
      ] },
    ];
    doc.cta = {
      id: "zh-cta",
      type: "cta",
      html: "<!-- wp:html -->\n<div class=\"cta\">立即免費建立你的檔案。 <a href=\"https://app.b2ihub.com/signup\">建立免費檔案</a></div>\n<!-- /wp:html -->",
      fingerprint: "x",
    };
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const sectionText = blockText(doc.sections[0].blocks, 0);
    expect(sectionText).toBe("品牌有 750 萬個客戶。");
    const linkBlock = doc.sections[0].blocks[1];
    if (linkBlock.type === "paragraph") {
      const href = linkBlock.content.find((n) => n.type === "link");
      expect(href && href.type === "link" ? href.href : "").toBe("https://example.com/guide");
    }
    expect(doc.cta!.html).toContain("app.b2ihub.com/signup");
    expect(doc.cta!.html).toContain("wp:html");
    expect(doc.cta!.html).toContain("<div");
  });
});

describe("punctuation persistence regression", () => {
  it("keeps paragraph punctuation through the full normalizeZhDocumentEditorialQuality pipeline", () => {
    const doc = docWith();
    doc.sections[0].blocks = [paragraph("呢個係一個測試段落")];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(blockText(doc.sections[0].blocks, 0)).toBe("呢個係一個測試段落。");
  });

  it("source labels lose trailing punctuation while ordinary paragraphs keep it", () => {
    const doc = docWith();
    doc.sections[0].blocks = [
      paragraph("來源：AnyMind Group。"),
      paragraph("呢個係一個測試段落。"),
    ];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(blockText(doc.sections[0].blocks, 0)).toBe("來源：AnyMind Group");
    expect(blockText(doc.sections[0].blocks, 1)).toBe("呢個係一個測試段落。");
  });

  it("keeps heading and FAQ punctuation through the full pipeline", () => {
    const doc = docWith();
    doc.sections[0].heading = "點解要同香港嘅創作者合作";
    doc.sections[0].blocks = [paragraph("品牌要揀啱創作者市場推廣合作夥伴")];
    const faq: FaqEntry[] = [
      { question: "創作者市場推廣需要幾多預算", answerText: "預算因品牌而異", answerHtml: "<p>預算因品牌而異</p>" },
    ];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣", faq);
    expect(doc.sections[0].heading).toBe("點解要同香港嘅創作者合作？");
    expect(faq[0].question).toBe("創作者市場推廣需要幾多預算？");
    expect(faq[0].answerText).toBe("預算因品牌而異。");
    expect(faq[0].answerHtml).toContain("預算因品牌而異。");
  });

  it("reported changes count includes punctuation additions", () => {
    const doc = docWith();
    doc.sections[0].blocks = [paragraph("呢個係一個測試段落")];
    const result = normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(result.changes).toBeGreaterThanOrEqual(1);
    expect(blockText(doc.sections[0].blocks, 0)).toBe("呢個係一個測試段落。");
  });
});

describe("block-level source-label cleanup", () => {
  type ParaContent = { type: "text" | "link" | "strong" | "emphasis"; text: string; href?: string }[];

  function paragraphContent(block: import("@/lib/blog/article-content").EditorialBlock): ParaContent {
    if (block.type === "paragraph") return block.content as ParaContent;
    throw new Error("expected paragraph block");
  }

  function linkedLabelParagraph(html: string) {
    const parsed = parseWordPressEditorialBlocks(html, "label-block");
    return parsed.blocks[0];
  }

  function docWithLabel(block: import("@/lib/blog/article-content").EditorialBlock) {
    const doc = docWith();
    doc.sections[0].blocks = [block];
    return doc;
  }

  function linkIn(content: ParaContent): { text: string; href: string } {
    const link = content.find((n) => n.type === "link");
    if (!link || link.type !== "link") throw new Error("expected link node");
    return { text: link.text, href: link.href ?? "" };
  }

  it("split-node linked source labels lose trailing punctuation without changing the link", () => {
    const doc = docWithLabel(linkedLabelParagraph('<!-- wp:paragraph --><p>來源：<a href="https://x.com/a">標題</a>。</p><!-- /wp:paragraph -->'));
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const content = paragraphContent(doc.sections[0].blocks[0]);
    const texts = content.map((n) => n.text);
    expect(texts).toEqual(["來源：", "標題", ""]);
    expect(linkIn(content)).toEqual({ text: "標題", href: "https://x.com/a" });
  });

  it("資料來源 prefix normalizes to 來源 and trailing ？。 is stripped", () => {
    const doc = docWithLabel(linkedLabelParagraph('<!-- wp:paragraph --><p>資料來源：<a href="https://x.com/b">標題</a>？。</p><!-- /wp:paragraph -->'));
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const texts = paragraphContent(doc.sections[0].blocks[0]).map((n) => n.text);
    expect(texts[0]).toBe("來源：");
    expect(texts[texts.length - 1]).toBe("");
  });

  it("source labels without punctuation do not receive punctuation inside the link", () => {
    const doc = docWithLabel(linkedLabelParagraph('<!-- wp:paragraph --><p>來源：<a href="https://x.com/c">標題</a></p><!-- /wp:paragraph -->'));
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    const content = paragraphContent(doc.sections[0].blocks[0]);
    expect(linkIn(content)).toEqual({ text: "標題", href: "https://x.com/c" });
    expect(content.map((n) => n.text)).toEqual(["來源：", "標題"]);
  });

  it("ordinary paragraphs still get punctuation while source labels do not", () => {
    const doc = docWith();
    doc.sections[0].blocks = [
      paragraph("呢個係一個測試段落"),
      linkedLabelParagraph('<!-- wp:paragraph --><p>來源：AnyMind Group。</p><!-- /wp:paragraph -->'),
    ];
    normalizeZhDocumentEditorialQuality(doc, "香港創作者市場推廣");
    expect(blockText(doc.sections[0].blocks, 0)).toBe("呢個係一個測試段落。");
    expect(blockText(doc.sections[0].blocks, 1)).toBe("來源：AnyMind Group");
  });
});

describe("narrow regex editorial repairs", () => {
  it("softens the 10,000-vs-one-million claim despite wording variants", () => {
    const variants = [
      "一個有10,000位活躍追蹤者嘅創作者，可以比一個有過百萬但零互動嘅名人更快賣出產品。",
      "一個有 10,000 位活躍追蹤者嘅創作者，竟然可以比一個有過百萬但零互動嘅名人更快賣出產品。",
      "有10,000位忠實追蹤者嘅創作者可以比一個有過百萬但零互動嘅名人更快賣出產品。",
    ];
    for (const v of variants) {
      const out = normalizeChineseEditorialText(v);
      expect(out).toContain("有時反而可以帶嚟更實際嘅互動同銷售成果");
      expect(out).not.toContain("更快賣出產品");
    }
  });

  it("repairs 可以令所有人(都)保持誠實", () => {
    expect(normalizeChineseEditorialText("可以令所有人保持誠實。")).toContain("可以令雙方更清楚成效");
    expect(normalizeChineseEditorialText("可以令所有人都保持誠實。")).toContain("可以令雙方更清楚成效");
  });

  it("repairs the Open Influence sentence across verb variants", () => {
    const variants = [
      "香港嘅代理商，好似Open Influence，會推動佢哋嘅團隊同全球網紅營銷意念進入新領域，為本地品牌帶嚟新嘅做法。",
      "香港嘅代理商，好似Open Influence，會將全球網紅營銷意念帶入香港，為本地品牌帶嚟新嘅做法。",
    ];
    for (const v of variants) {
      const out = normalizeChineseEditorialText(v);
      expect(out).toContain("Open Influence");
      expect(out).toContain("為本地品牌帶嚟新嘅做法");
      expect(out).toContain("引入香港");
    }
  });

  it("normalizes heading variants", () => {
    expect(normalizeChineseEditorialText("品牌同創作者市場推廣常犯的錯誤")).toBe("品牌做創作者市場推廣時常犯嘅錯誤");
    expect(normalizeChineseEditorialText("品牌在創作者市場推廣中常犯的錯誤")).toBe("品牌做創作者市場推廣時常犯嘅錯誤");
    expect(normalizeChineseEditorialText("點解要喺香港同創作者市場推廣公司合作？")).toBe("點解要同香港嘅創作者市場推廣公司合作？");
    expect(normalizeChineseEditorialText("點解要喺香港同創作者市場推廣代理合作？")).toBe("點解要同香港嘅創作者市場推廣代理合作？");
    expect(normalizeChineseEditorialText("關於香港創作者市場推廣的常見問題")).toBe("香港創作者市場推廣常見問題");
  });

  it("does not rewrite already-correct headings", () => {
    expect(normalizeChineseEditorialText("品牌做創作者市場推廣時常犯嘅錯誤")).toBe("品牌做創作者市場推廣時常犯嘅錯誤");
    expect(normalizeChineseEditorialText("點樣揀啱創作者市場推廣合作夥伴")).toBe("點樣揀啱創作者市場推廣合作夥伴");
  });
});

describe("code-switching is preserved while full English fails", () => {
  const source = "<p>English source paragraph that must be translated completely into Chinese for the article.</p>";

  it("allows natural Hong Kong code-switching", () => {
    const mixed = "<p>好多品牌都會用 followers 去衡量成效，但係 post 出嚟之後唔 work 嘅情況都好常見。KPI 同 Reel 都要睇，仲要留意平台表現。</p>";
    expect(hasExcessiveEnglish(mixed)).toBe(false);
    expect(hasEnglishHeavyProseBlock(mixed)).toBe(false);
    expect(checkCompleteness(source, mixed, "section-1").passed).toBe(true);
  });

  it("allows platform, agency and company names", () => {
    const mixed = "<p>品牌同 creators 合作，仲要睇 TikTok、Instagram 同 Meta 嘅數據，亦可以參考 AnyMind 嘅做法。</p>";
    expect(hasExcessiveEnglish(mixed)).toBe(false);
  });

  it("rejects genuine untranslated English sentences", () => {
    const english = "<p>Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell content.</p>";
    expect(hasExcessiveEnglish(english)).toBe(true);
    expect(hasEnglishHeavyProseBlock(english)).toBe(true);
    expect(checkCompleteness(source, english, "section-1").passed).toBe(false);
  });
});
