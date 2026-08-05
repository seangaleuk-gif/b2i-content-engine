import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  applyShadowCantoneseQuality,
  classifyBlockEnglish,
  normalizeCantoneseTypographyText,
  normalizeShadowTerminologyText,
  SHADOW_CTA_COPY,
} from "./shadow-cantonese-quality";
import {
  ENGLISH_CLASSIFICATION_FIXTURES,
  GLOSSARY_FIXTURES,
  APPROVED_NAMES_FIXTURES,
} from "./translation-quality-fixtures";
import { buildFaqSchemaBlock } from "./document-context-shadow-preview";

type ParagraphBlock = { id: string; type: "paragraph"; content: Array<{ type: "text"; text: string }> };

function paragraph(id: string, text: string): ParagraphBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function paragraphText(doc: ArticleDocument, si: number, bi: number): string {
  return (doc.sections[si].blocks[bi] as ParagraphBlock).content[0].text;
}

function setParagraphText(doc: ArticleDocument, si: number, bi: number, text: string): void {
  (doc.sections[si].blocks[bi] as ParagraphBlock).content[0].text = text;
}

function makeDoc(): ArticleDocument {
  return {
    metadata: { title: "Influencer marketing guide", slug: "guide-zh", metaDescription: "A campaign for followers.", excerpt: "Rate card and brief.", targetWordCount: 0, focusKeyphrase: "香港" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraph("p0", "An influencer marketing campaign with 65% engagement and 6-month results.")], status: "generated" },
    sections: [
      {
        id: "s0", heading: "Campaign strategy for influencer marketing", headingLevel: 2, sectionType: "main",
        blocks: [
          paragraph("s0-0", "Track followers, saves, shares and comments, plus the rate card and brief."),
          paragraph("s0-1", "來源：AnyMind influencer marketing report."),
        ],
        status: "generated",
      },
    ],
    conclusion: { id: "conc", blocks: [paragraph("c0", "Run one campaign and measure engagement.")], status: "generated" },
    visibleFaq: [
      { question: "What is influencer marketing?", answerHtml: "<p>A campaign with 65% engagement.</p>", answerText: "A campaign with 65% engagement." },
    ],
    cta: {
      id: "cta", type: "cta",
      html: "<!-- wp:html --><div style=\"background:#1E3A8A;\"><h2 style=\"color:#fff;\">Ready to grow your brand?</h2><p style=\"font-size:16px;\">B2I Hub connects businesses with verified creators. Create your free profile today.</p><a href=\"https://app.b2ihub.com/signup\" style=\"background:#F97316;\" target=\"_blank\" rel=\"noopener\">Create your free profile \u2192</a></div><!-- /wp:html -->",
      fingerprint: "fp",
    },
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("shadow Cantonese quality — terminology cleanup", () => {
  it("normalizes influencer marketing to 創作者市場推廣", () => {
    expect(normalizeShadowTerminologyText("influencer marketing influencer marketing")).toBe("創作者市場推廣 創作者市場推廣");
    expect(normalizeShadowTerminologyText("Influencer Marketing strategy")).toBe("創作者市場推廣 strategy");
  });

  it("normalizes campaign to 推廣活動", () => {
    expect(normalizeShadowTerminologyText("one campaign, many campaigns")).toBe("one 推廣活動, many 推廣活動");
  });

  it("normalizes followers to 粉絲", () => {
    expect(normalizeShadowTerminologyText("your follower and followers")).toBe("your 粉絲 and 粉絲");
  });

  it("normalizes engagement, saves, shares, comments, rate card and brief", () => {
    const text = "engagement engagement rate saves shares comments rate card brief";
    expect(normalizeShadowTerminologyText(text)).toBe("互動 互動率 儲存 分享 留言 收費表 合作簡報");
  });

  it("normalizes Like metric to 讚好", () => {
    expect(normalizeShadowTerminologyText("likes and Like")).toBe("讚好 and 讚好");
  });

  it("fixes the 脗合 typo to 吻合", () => {
    expect(normalizeShadowTerminologyText("雙方要脗合")).toBe("雙方要吻合");
  });

  it("leaves approved brands, platforms, acronyms and URLs unchanged", () => {
    const text = "Instagram YouTube TikTok WeChat YKONE Open Influence Assembly StarNgage Luna B2I Hub B2C KPI Reel https://app.b2ihub.com/signup";
    expect(normalizeShadowTerminologyText(text)).toBe(text);
  });
});

describe("shadow Cantonese quality — deterministic doc cleanup", () => {
  it("applies terminology cleanup across editable units and preserves numbers", () => {
    const { doc } = applyShadowCantoneseQuality(makeDoc());
    expect(doc.metadata.title).toContain("創作者市場推廣");
    expect(doc.sections[0].heading).toContain("推廣活動");
    expect(paragraphText(doc, 0, 0)).toContain("粉絲");
    expect(paragraphText(doc, 0, 0)).toContain("儲存");
    expect(paragraphText(doc, 0, 0)).toContain("收費表");
    expect((doc.introduction.blocks[0] as ParagraphBlock).content[0].text).toContain("65%");
    expect((doc.introduction.blocks[0] as ParagraphBlock).content[0].text).toContain("6-month");
  });

  it("does not clean citation/source-title blocks", () => {
    const { doc } = applyShadowCantoneseQuality(makeDoc());
    expect(paragraphText(doc, 0, 1)).toBe("來源：AnyMind influencer marketing report.");
  });

  it("keeps FAQ visible text and rebuilt schema identical after cleanup", () => {
    const { doc } = applyShadowCantoneseQuality(makeDoc());
    doc.faqSchema = buildFaqSchemaBlock(doc.visibleFaq);
    const schema = JSON.parse(doc.faqSchema!.html.replace(/<[^>]+>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim());
    expect(doc.visibleFaq[0].answerText).toContain("推廣活動");
    expect(schema.mainEntity[0].acceptedAnswer.text).toBe(doc.visibleFaq[0].answerText);
    expect(schema.mainEntity[0].acceptedAnswer.text).toContain("推廣活動");
  });

  it("localizes the CTA copy while preserving URL and attributes", () => {
    const { doc } = applyShadowCantoneseQuality(makeDoc());
    const cta = doc.cta!.html;
    expect(cta).toContain(SHADOW_CTA_COPY.heading);
    expect(cta).toContain(SHADOW_CTA_COPY.body);
    expect(cta).toContain(SHADOW_CTA_COPY.button);
    expect(cta).toContain("href=\"https://app.b2ihub.com/signup\"");
    expect(cta).toContain("target=\"_blank\"");
    expect(cta).toContain("rel=\"noopener\"");
    expect(cta).toContain("background:#1E3A8A;");
  });
});

describe("shadow Cantonese quality — severity-based findings", () => {
  it("one TikTok-focused occurrence is minor and never fatal", () => {
    const doc = makeDoc();
    setParagraphText(doc, 0, 0, "品牌同 TikTok-focused 合作夥伴合作，成效好好。");
    const { report } = applyShadowCantoneseQuality(doc);
    const unit = report.findings.find((f) => f.sourceUnitId === "section.0.block.0");
    expect(unit?.severity).toBe("minor");
    expect(report.majorCount).toBe(0);
    expect(report.criticalCount).toBe(0);
  });

  it("a complete untranslated English paragraph is major", () => {
    const doc = makeDoc();
    setParagraphText(doc, 0, 0, "Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell marketing content.");
    const { report } = applyShadowCantoneseQuality(doc);
    expect(report.majorCount).toBe(1);
    expect(report.findings.some((f) => f.sourceUnitId === "section.0.block.0" && f.severity === "major")).toBe(true);
  });

  it("approved brands and proper names are advisory or exempt, not fatal", () => {
    const doc = makeDoc();
    setParagraphText(doc, 0, 0, "用 Instagram、YouTube、TikTok 同 WeChat 衡量成效。");
    const { report } = applyShadowCantoneseQuality(doc);
    expect(report.majorCount).toBe(0);
    expect(report.criticalCount).toBe(0);
    const unit = report.findings.find((f) => f.sourceUnitId === "section.0.block.0");
    expect(unit?.severity).toBe("advisory");
  });

  it("does not produce findings for citation/source-title blocks", () => {
    const doc = makeDoc();
    setParagraphText(doc, 0, 1, "來源：TikTok-focused report.");
    const { report } = applyShadowCantoneseQuality(doc);
    expect(report.findings.some((f) => f.sourceUnitId === "section.0.block.1")).toBe(false);
  });

  it("a natural Hong Kong code-switching phrase does not reject", () => {
    const doc = makeDoc();
    setParagraphText(doc, 0, 0, "品牌可以睇 KPI、ROI 同 Reel 內容，衡量成效。");
    const { report } = applyShadowCantoneseQuality(doc);
    expect(report.majorCount).toBe(0);
    expect(report.criticalCount).toBe(0);
  });
});

describe("shadow Cantonese quality — stable approved glossary", () => {
  it("does not normalize TikTok-focused (it becomes a minor finding, not a rewrite)", () => {
    expect(normalizeShadowTerminologyText("TikTok-focused")).toBe("TikTok-focused");
    expect(normalizeShadowTerminologyText("用 TikTok 做推廣")).toBe("用 TikTok 做推廣");
  });

  it("preserves URLs, hrefs and citation/source titles during cleanup", () => {
    // Link href containing the phrase is preserved; anchor text is untouched by the glossary.
    const doc: ArticleDocument = {
      ...makeDoc(),
      sections: [{
        id: "s0", heading: "標題", headingLevel: 2, sectionType: "main",
        blocks: [{
          id: "s0-0", type: "paragraph",
          content: [
            { type: "text", text: "品牌同 TikTok-focused 合作夥伴合作。" },
            { type: "link", text: "TikTok-focused 連結", href: "https://www.tiktok-focused.example.com" },
          ],
        }],
        status: "generated",
      }],
    };
    const cleaned = applyShadowCantoneseQuality(doc).doc;
    const block = cleaned.sections[0].blocks[0] as { content: Array<{ type: string; text: string; href?: string }> };
    expect(block.content[1].href).toBe("https://www.tiktok-focused.example.com");
  });

  it("canonicalizes glossary-created spacing in editable prose", () => {
    expect(normalizeCantoneseTypographyText("好多 粉絲")).toBe("好多粉絲");
    expect(normalizeCantoneseTypographyText("同 粉絲 建立")).toBe("同粉絲建立");
    expect(normalizeCantoneseTypographyText("粉絲 數量")).toBe("粉絲數量");
    expect(normalizeCantoneseTypographyText("10,000 個 粉絲")).toBe("10,000 個粉絲");
    expect(normalizeCantoneseTypographyText("個 收費表")).toBe("個收費表");
    expect(normalizeCantoneseTypographyText("除咗 讚好 之外")).toBe("除咗讚好之外");
    expect(normalizeCantoneseTypographyText("幾多個 讚好")).toBe("幾多個讚好");
  });

  it("preserves spaces inside Latin proper names and numbers", () => {
    expect(normalizeCantoneseTypographyText("B2I Hub")).toBe("B2I Hub");
    expect(normalizeCantoneseTypographyText("Open Influence")).toBe("Open Influence");
    expect(normalizeCantoneseTypographyText("StarNgage KPI B2C")).toBe("StarNgage KPI B2C");
    expect(normalizeCantoneseTypographyText("50,000 個")).toBe("50,000 個");
  });

  it("normalizes Chinese punctuation spacing and repeated punctuation", () => {
    expect(normalizeCantoneseTypographyText("你好 ，世界")).toBe("你好，世界");
    expect(normalizeCantoneseTypographyText("真係好重要 ！")).toBe("真係好重要！");
    expect(normalizeCantoneseTypographyText("做得好。。」")).toBe("做得好。」");
  });
});

describe("shadow Cantonese quality — citation punctuation protection", () => {
  it("never duplicates terminal punctuation on linked source titles", () => {
    const doc: ArticleDocument = {
      ...makeDoc(),
      sections: [{
        id: "s0", heading: "標題", headingLevel: 2, sectionType: "main",
        blocks: [{
          id: "s0-0", type: "paragraph",
          content: [
            { type: "text", text: "來源：" },
            { type: "link", text: "Open Influence Inc.", href: "https://openinfluence.com" },
            { type: "text", text: "。" },
          ],
        }],
        status: "generated",
      }],
    };
    const cleaned = applyShadowCantoneseQuality(doc).doc;
    const block = cleaned.sections[0].blocks[0] as { content: Array<{ type: string; text: string; href?: string }> };
    expect(block.content[1].text).toBe("Open Influence Inc.");
    expect(block.content[2].text).not.toContain("。");
  });

  it("never turns a question-mark source title into ?. or ？。", () => {
    const doc: ArticleDocument = {
      ...makeDoc(),
      sections: [{
        id: "s0", heading: "標題", headingLevel: 2, sectionType: "main",
        blocks: [{
          id: "s0-0", type: "paragraph",
          content: [
            { type: "text", text: "來源：" },
            { type: "link", text: "Hong Kong?", href: "https://example.com" },
            { type: "text", text: "。" },
          ],
        }],
        status: "generated",
      }],
    };
    const cleaned = applyShadowCantoneseQuality(doc).doc;
    const block = cleaned.sections[0].blocks[0] as { content: Array<{ type: string; text: string; href?: string }> };
    expect(block.content[1].text).toBe("Hong Kong?");
    expect(block.content[2].text).not.toMatch(/[。！？]/);
  });

  it("keeps a plain-text source title with its own terminal punctuation intact", () => {
    const doc = makeDoc();
    setParagraphText(doc, 0, 1, "來源：AnyMind Group。");
    const { doc: cleaned } = applyShadowCantoneseQuality(doc);
    expect(paragraphText(cleaned, 0, 1)).toBe("來源：AnyMind Group。");
  });
});

describe("version-14 live-output regression fixture", () => {
  it("removes spaced glossary terms, duplicated citation punctuation and altered source titles", () => {
    const doc: ArticleDocument = {
      ...makeDoc(),
      metadata: { title: "好多 粉絲 數量", slug: "guide-zh", metaDescription: "個 收費表", excerpt: "除咗 讚好 之外", targetWordCount: 0, focusKeyphrase: "香港" },
      sections: [{
        id: "s0", heading: "同 粉絲 建立", headingLevel: 2, sectionType: "main",
        blocks: [{
          id: "s0-0", type: "paragraph",
          content: [
            { type: "text", text: "來源：" },
            { type: "link", text: "Open Influence Inc.", href: "https://openinfluence.com" },
            { type: "text", text: "。" },
          ],
        }],
        status: "generated",
      }],
    };
    const { doc: cleaned } = applyShadowCantoneseQuality(doc);
    expect(cleaned.metadata.title).toBe("好多粉絲數量");
    expect(cleaned.metadata.metaDescription).toBe("個收費表");
    expect(cleaned.metadata.excerpt).toBe("除咗讚好之外");
    expect(cleaned.sections[0].heading).toBe("同粉絲建立");
    const block = cleaned.sections[0].blocks[0] as { content: Array<{ type: string; text: string; href?: string }> };
    expect(block.content[1].text).toBe("Open Influence Inc.");
    expect(block.content[1].href).toBe("https://openinfluence.com");
    expect(block.content[2].text).toBe("");
  });
});

describe("golden translation-quality regression corpus", () => {
  it("classifies every English block fixture with the expected severity", () => {
    for (const fixture of ENGLISH_CLASSIFICATION_FIXTURES) {
      expect(classifyBlockEnglish(fixture.text), fixture.name).toBe(fixture.expected);
    }
  });

  it("normalizes every glossary fixture to its approved term", () => {
    for (const fixture of GLOSSARY_FIXTURES) {
      expect(normalizeShadowTerminologyText(fixture.source), fixture.name).toBe(fixture.expected);
    }
  });

  it("leaves approved brand/platform names unchanged", () => {
    for (const name of APPROVED_NAMES_FIXTURES) {
      expect(normalizeShadowTerminologyText(name), name).toBe(name);
    }
  });
});
