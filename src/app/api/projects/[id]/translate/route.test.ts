import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderArticleDocument,
  type ArticleDocument,
} from "@/lib/blog/article-document";

const mocks = vi.hoisted(() => ({
  findByProject: vi.fn(),
  getNextVersionNumber: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  delete: vi.fn(),
  translateArticle: vi.fn(),
  acceptance: vi.fn(),
}));

vi.mock("@/lib/services/auth", () => ({ getCurrentUserId: vi.fn(async () => "user-1") }));
vi.mock("@/lib/services/project-authorization", () => ({
  requireProjectAccess: vi.fn(async () => ({ id: 1, name: "Test", keyword: "test topic" })),
}));
vi.mock("@/lib/repositories", () => ({
  blogVersionRepository: {
    findByProject: mocks.findByProject,
    getNextVersionNumber: mocks.getNextVersionNumber,
    create: mocks.create,
    update: mocks.update,
    findById: mocks.findById,
    delete: mocks.delete,
  },
  researchRepository: { findByProject: vi.fn(async () => []) },
}));
vi.mock("@/lib/services/translation-service", () => ({ translateArticle: mocks.translateArticle }));
vi.mock("@/lib/services/translation-acceptance", () => ({
  evaluateTranslationDocumentAcceptance: mocks.acceptance,
}));
vi.mock("@/lib/services/seo-auditor", () => ({
  runChineseAudit: vi.fn(() => ({ overallScore: 95, checks: [] })),
}));

import { POST } from "@/app/api/projects/[id]/translate/route";

function doc(language: "en" | "zh"): ArticleDocument {
  const zh = language === "zh";
  return {
    metadata: {
      title: zh ? "測試標題" : "Test title",
      slug: zh ? "test-title-zh" : "test-title",
      metaDescription: zh ? "測試文章摘要" : "Test article summary",
      excerpt: zh ? "測試關鍵詞" : "test topic",
      targetWordCount: 500,
      focusKeyphrase: zh ? "測試關鍵詞" : "test topic",
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      blocks: [{ id: "intro-p", type: "paragraph", content: [{ type: "text", text: zh ? "呢篇文章提供實用介紹。" : "This article provides a practical introduction." }] }],
      status: "generated",
    },
    sections: [{
      id: "section-1",
      heading: zh ? "實用做法" : "Practical approach",
      headingLevel: 2,
      sectionType: "main",
      blocks: [{ id: "section-p", type: "paragraph", content: [{ type: "text", text: zh ? "團隊可以按目標逐步執行。" : "Teams can work step by step toward the goal." }] }],
      status: "generated",
    }],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      blocks: [{ id: "conclusion-p", type: "paragraph", content: [{ type: "text", text: zh ? "最後，按實際結果調整做法。" : "Finally, adjust the approach using actual results." }] }],
      status: "generated",
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("translation route pre-save acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const enDoc = doc("en");
    const zhDoc = doc("zh");
    mocks.findByProject.mockResolvedValue([{
      id: 10,
      projectId: 1,
      userId: "user-1",
      title: enDoc.metadata.title,
      slug: enDoc.metadata.slug,
      metaDescription: enDoc.metadata.metaDescription,
      excerpt: enDoc.metadata.excerpt,
      blog: renderArticleDocument(enDoc),
      faq: [],
      wordCount: 500,
      categories: [],
      tags: [],
    }]);
    mocks.translateArticle.mockResolvedValue({
      doc: zhDoc,
      html: renderArticleDocument(zhDoc),
      title: zhDoc.metadata.title,
      metaDescription: zhDoc.metadata.metaDescription,
      failedComponents: [],
      review: { status: "run", selectedUnitIds: [], selectedReasons: [], decisions: [], appliedEditCount: 0, retainedCount: 0, failure: null, documentAccepted: true, unresolvedUnitIds: [] },
      estimatedReadingMinutes: 1,
      zhCharCount: 100,
    });
    mocks.acceptance.mockReturnValue({ accepted: false, errors: ["literal-out-of-touch"] });
  });

  it("performs zero persistence writes when the exact bilingual candidate fails acceptance", async () => {
    const response = await POST(new Request("http://localhost/api/projects/1/translate", { method: "POST" }), {
      params: Promise.resolve({ id: "1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.acceptance).toHaveBeenCalledTimes(1);
    expect(mocks.getNextVersionNumber).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
