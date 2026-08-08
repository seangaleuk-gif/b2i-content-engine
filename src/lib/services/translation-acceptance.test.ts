import { describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { evaluateTranslationDocumentAcceptance } from "@/lib/services/translation-acceptance";

function alignedDocs(english: string, chinese: string): { enDoc: ArticleDocument; zhDoc: ArticleDocument } {
  const make = (language: "en" | "zh", text: string): ArticleDocument => ({
    metadata: {
      title: language === "zh" ? "專業內容策略" : "Professional content strategy",
      slug: language === "zh" ? "content-strategy-zh" : "content-strategy",
      metaDescription: language === "zh" ? "為香港團隊而設嘅實用內容策略。" : "A practical content strategy for Hong Kong teams.",
      excerpt: language === "zh" ? "內容策略" : "content strategy",
      targetWordCount: 500,
      focusKeyphrase: language === "zh" ? "內容策略" : "content strategy",
    },
    languageSwitcher: null,
    introduction: {
      id: "introduction",
      blocks: [{ id: "introduction-block", type: "paragraph", content: [{ type: "text", text }] }],
      status: "generated",
    },
    sections: [{
      id: "section-1",
      heading: language === "zh" ? "實際做法" : "Practical approach",
      headingLevel: 2,
      sectionType: "main",
      blocks: [{ id: "section-block", type: "paragraph", content: [{ type: "text", text: language === "zh" ? "團隊應該定期檢視受眾反應。" : "Teams should review audience response regularly." }] }],
      status: "generated",
    }],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      blocks: [{ id: "conclusion-block", type: "paragraph", content: [{ type: "text", text: language === "zh" ? "按結果持續改善。" : "Keep improving based on results." }] }],
      status: "generated",
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  });
  return { enDoc: make("en", english), zhDoc: make("zh", chinese) };
}

describe("unified translation document acceptance", () => {
  it("rejects source-aware out-of-touch → 失焦 even though the English token was removed", () => {
    const docs = alignedDocs("The brand can look out of touch with its audience.", "品牌可能會同受眾失焦。");
    const result = evaluateTranslationDocumentAcceptance({ ...docs, research: [] });
    expect(result.sourceAwareLiteralTranslations).toEqual([
      { sourceUnitId: "introduction.block.0", reason: "literal-out-of-touch" },
    ]);
    expect(result.accepted).toBe(false);
  });

  it("does not flag a natural professional Hong Kong Cantonese replacement", () => {
    const docs = alignedDocs("The brand can look out of touch with its audience.", "品牌可能會同受眾脫節。");
    const result = evaluateTranslationDocumentAcceptance({ ...docs, research: [] });
    expect(result.sourceAwareLiteralTranslations).toEqual([]);
  });
});
