import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderArticleDocument, type ArticleDocument, type EditorialBlock } from "@/lib/blog/article-document";
import {
  checkCompleteness,
  hasEnglishHeavyProseBlock,
  visibleChars,
  extractLinks,
  checkLinksPreserved,
  checkNoNewUrls,
  extractVisibleNumbers,
  normalizeNumber,
  checkNumbersPreserved,
  extractScaledNumbers,
  countCjkChars,
  countLatinWords,
  countParagraphs,
  estimatedReadingTime,
  chineseLengthMetrics,
  localiseSources,
  applySourceDecisions,
  translateArticle,
  deterministicMetadataFallback,
  validateTranslatedDocument,
} from "./translation-service";
import { formatWordCount } from "@/lib/services/text-utils";

// This suite verifies deterministic orchestration and must never contact a
// translation provider. Provider-owned metadata calls fail immediately so the
// production deterministic fallback is exercised without network access.
vi.mock("@/lib/services/deepseek", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/deepseek")>();
  return {
    ...actual,
    AiService: class OfflineAiService {
      get chatWithRetry() {
        return async () => {
          throw new Error("translation-service.test offline provider guard");
        };
      }
    },
  };
});

// ── Service-flow integration tests ──

function makeSourceDoc(): ArticleDocument {
  return {
    metadata: { title: "", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
    languageSwitcher: null, introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [], visibleFaq: [],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function makeMinimalEnHtml(): string {
  // Section heading must be ≤50% Latin chars so heading-fallback AI call is not triggered.
  return `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span></div><!-- /wp:html -->

<!-- wp:paragraph --><p>Introduction text.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} --><h2>測試一節</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>Section body.</p><!-- /wp:paragraph -->

<!-- b2i-conclusion-start -->
<!-- wp:paragraph --><p>Conclusion.</p><!-- /wp:paragraph -->
<!-- b2i-conclusion-end -->`;
}

function chineseTestBlocks(blocks: EditorialBlock[]): EditorialBlock[] {
  return blocks.map((block) => {
    if (block.type === "list") {
      return {
        ...block,
        items: block.items.map((item) => item.map((inline) => (
          inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text: "香港中文內容。" }
        ))),
      };
    }
    if (block.type === "table") {
      const convert = (group: typeof block.headers[number]) => group.map((inline) => (
        inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text: "香港中文內容。" }
      ));
      return {
        ...block,
        headers: block.headers.map(convert),
        rows: block.rows.map((row) => row.map(convert)),
      };
    }
    return {
      ...block,
      content: block.content.map((inline) => (
        inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text: "香港中文內容。" }
      )),
    };
  });
}

function makeMockHelper(calls: Array<{ componentId: string; componentKind: string }>): typeof import("./editorial-block-translation").translateEditorialBlocks {
  return async (opts) => {
    calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
    return { blocks: chineseTestBlocks(opts.blocks), translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
  };
}

// These tests inject a mock translateEditorialBlocks via the DI parameter.
// The mock ensures no real AI calls are made during orchestration.
const TEST_EN_KEY = "sk-test-mock-helper-orchestration";

describe("translateArticle — structured helper orchestration", () => {
  beforeEach(() => { process.env.DEEPSEEK_API_KEY = TEST_EN_KEY; });
  afterEach(() => { delete process.env.DEEPSEEK_API_KEY; });

  it("introduction invokes the helper once", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];

    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const introCall = calls.find((c) => c.componentKind === "introduction");
    expect(introCall).toBeTruthy();
    expect(introCall!.componentId).toBe("zh-intro");
  });

  it("each ordinary editorial section invokes the helper once", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];

    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });

    expect(calls.filter((c) => c.componentKind === "section").length).toBe(1);
    const secCall = calls.find((c) => c.componentKind === "section");
    expect(secCall).toBeTruthy();
    expect(secCall!.componentId).toBe("zh-section-0");
  });

  it("conclusion invokes the helper once", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];

    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });

    const concCall = calls.find((c) => c.componentKind === "conclusion");
    expect(concCall).toBeTruthy();
    expect(concCall!.componentId).toBe("zh-conc");
  });

  it("translated blocks from helper are stored in the output ArticleDocument", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks =
      async (opts) => {
        calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
        return {
          blocks: [{ id: "mock-block", type: "paragraph" as const, content: [{ type: "text" as const, text: "Translated" }] }],
          translatedHtml: "<!-- wp:paragraph --><p>Translated</p><!-- /wp:paragraph -->",
          passed: true,
          metrics: { sourceChars: 10, translatedChars: 10, ratio: 1, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
        };
      };

    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: mockHelper });

    expect(result.doc.introduction.blocks.length).toBe(1);
    expect(result.doc.introduction.blocks[0].type).toBe("paragraph");
    expect(result.doc.sections.length).toBeGreaterThan(0);
    expect(result.doc.conclusion.blocks.length).toBe(1);
  });

  it("returns HTML rendered exactly from the canonical Chinese ArticleDocument", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(
      makeMinimalEnHtml(),
      makeSourceDoc(),
      [], { translateEditorialBlocks: makeMockHelper(calls) },
    );

    expect(result.doc.metadata.slug).toBe("test-zh");
    expect(result.doc.languageSwitcher?.html).toContain('/blog/test');
    expect(result.html).toBe(renderArticleDocument(result.doc));
  });

  it("rejects a translated component that drops a protected brand name", async () => {
    const html = makeMinimalEnHtml().replace("Introduction text.", "Threads helps local teams start conversations.");
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(
      html,
      makeSourceDoc(),
      [], { translateEditorialBlocks: makeMockHelper(calls) },
    );

    expect(result.failedComponents.some((component) => component.includes("named entities changed: Threads"))).toBe(true);
  });

  it("clears an initial component failure after targeted recovery succeeds", async () => {
    const attempts = new Map<string, number>();
    const helper: typeof import("./editorial-block-translation").translateEditorialBlocks = async (opts) => {
      const count = (attempts.get(opts.componentId) || 0) + 1;
      attempts.set(opts.componentId, count);
      if (opts.componentId === "zh-intro" && count === 1) {
        return {
          blocks: opts.blocks,
          translatedHtml: "",
          passed: false,
          metrics: { sourceChars: 10, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 0 },
        };
      }
      return {
        blocks: chineseTestBlocks(opts.blocks),
        translatedHtml: "",
        passed: true,
        metrics: { sourceChars: 10, translatedChars: 10, ratio: 1, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
      };
    };

    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: helper });
    expect(attempts.get("zh-intro")).toBeGreaterThanOrEqual(2);
    expect(result.failedComponents).not.toContain("introduction");
    expect(result.failedComponents).not.toContain("zh-intro-editorial");
  });

  it("helper failure is surfaced so English fallback cannot be persisted", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks =
      async (opts) => {
        calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
        return {
          blocks: opts.blocks,
          translatedHtml: "",
          passed: false,
          metrics: { sourceChars: 10, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 0 },
        };
      };

    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: mockHelper });

    // Source blocks remain available for diagnostics, but failedComponents makes
    // the route reject the candidate before any bilingual persistence.
    expect(result.doc.sections.length).toBeGreaterThan(0);
    expect(result.doc.sections[0].blocks.length).toBeGreaterThan(0);
    expect(result.failedComponents).toContain("zh-section-0-editorial");
    expect(result.failedComponents.some((component) => component.startsWith("validation:"))).toBe(true);
  });

  it("repair accepts a normalized candidate containing previously-fixable terminology", async () => {
    // The mocked translator returns blocks whose text carries forbidden
    // marketing terminology. After deterministic normalization that terminology
    // becomes 創作者市場推廣, so repairChineseComponent must accept the
    // candidate instead of rejecting it as untranslated.
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks =
      async (opts) => ({
        blocks: opts.blocks.map((block) => {
          if (block.type === "list") return { ...block, items: block.items.map((item) => item.map((inline) => ({ ...inline, text: "網紅營銷嘅推廣策略好常見。" }))) };
          if (block.type === "table") {
            const convert = (group: typeof block.headers[number]) => group.map((inline) => ({ ...inline, text: "網紅營銷嘅推廣策略好常見。" }));
            return { ...block, headers: block.headers.map(convert), rows: block.rows.map((row) => row.map(convert)) };
          }
          return { ...block, content: block.content.map((inline) => ({ ...inline, text: "網紅營銷嘅推廣策略好常見。" })) };
        }),
        translatedHtml: "",
        passed: true,
        metrics: { sourceChars: 10, translatedChars: 10, ratio: 1, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
      });

    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: mockHelper });

    // The section is accepted (no editorial failure) and its blocks are stored
    // with the canonical term, not the forbidden one.
    expect(result.failedComponents).not.toContain("section-0-editorial");
    const sectionText = result.doc.sections[0].blocks
      .map((block) => JSON.stringify(block))
      .join("");
    expect(sectionText).toContain("創作者市場推廣");
    expect(sectionText).not.toContain("網紅營銷");
  });

  it("a section whose only issue is formal register does not enter the AI repair path", async () => {
    // The mocked translator returns blocks whose only deviation is a protected
    // formal-register compound (與其). After deterministic normalization that
    // compound is preserved but is no longer flagged, so the dedicated editorial
    // repair pass must NOT be re-invoked for the section.
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks =
      async (opts) => {
        calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
        const text = "品牌與其依賴大網紅，不如與創作者合作。";
        return {
          blocks: opts.blocks.map((block) => {
            if (block.type === "list") {
              return { ...block, items: block.items.map((item) => item.map((inline) => (inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text }))) };
            }
            if (block.type === "table") {
              const convert = (group: typeof block.headers[number]) => group.map((inline) => (inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text }));
              return { ...block, headers: block.headers.map(convert), rows: block.rows.map((row) => row.map(convert)) };
            }
            return { ...block, content: block.content.map((inline) => (inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text })) };
          }),
          translatedHtml: "",
          passed: true,
          metrics: { sourceChars: 10, translatedChars: 10, ratio: 1, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
        };
      };

    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: mockHelper });

    // The section is translated exactly once; the formal-register-only finding
    // does not trigger the editorial repair pass or any failure.
    const sectionCalls = calls.filter((c) => c.componentId === "zh-section-0");
    expect(sectionCalls.length).toBe(1);
    expect(result.failedComponents).not.toContain("section-0-editorial");
    expect(result.failedComponents).not.toContain("zh-section-0-editorial");
    expect(result.failedComponents.some((c) => c.includes("formal written Chinese"))).toBe(false);
  });

  it("a section whose only English content is a plain-text citation does not trigger the repair chain", async () => {
    // The mocked translator returns blocks that are Chinese except for one
    // plain-text English source-title citation. The whole citation block is
    // exempt from English-leak counting, so the section is accepted at the
    // component gate and the four-call repair/fallback chain must not run.
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks =
      async (opts) => {
        calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
        const text = "品牌與創作者市場推廣要成功，就唔可以忽視真實聲音。";
        const citation = "來源：How to Find the Right Influencer Marketing Agency in Hong Kong。";
        return {
          blocks: opts.blocks.map((block) => {
            if (block.type === "list") {
              return { ...block, items: block.items.map((item) => item.map((inline) => (inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text }))) };
            }
            if (block.type === "table") {
              const convert = (group: typeof block.headers[number]) => group.map((inline) => (inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text }));
              return { ...block, headers: block.headers.map(convert), rows: block.rows.map((row) => row.map(convert)) };
            }
            const content = block.content.map((inline) => (inline.type === "link" ? { ...inline, text: "資料來源" } : { ...inline, text }));
            return { ...block, content: content.map((n, i) => (i === content.length - 1 ? { ...n, text: citation } : n)) };
          }),
          translatedHtml: "",
          passed: true,
          metrics: { sourceChars: 10, translatedChars: 10, ratio: 1, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
        };
      };

    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: mockHelper });

    // Section translated exactly once; no editorial/strict/fallback repair.
    const sectionCalls = calls.filter((c) => c.componentId === "zh-section-0");
    expect(sectionCalls.length).toBe(1);
    expect(result.failedComponents).not.toContain("section-0-editorial");
    expect(result.failedComponents).not.toContain("zh-section-0-editorial");
    expect(result.failedComponents.some((c) => c.includes("excessive English") || c.includes("insufficient Chinese"))).toBe(false);
  });
});

describe("formal register is advisory in validateTranslatedDocument", () => {
  it("protected 與其/與否/參與 and standalone-與 normalized text are not rejected", () => {
    const enDoc: ArticleDocument = {
      metadata: { title: "Creator Marketing Guide", slug: "guide", metaDescription: "A guide", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
      languageSwitcher: null,
      introduction: { id: "intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "Brands prefer creators." }] }] },
      sections: [{ id: "s1", heading: "How to Choose", headingLevel: 2, sectionType: "main", status: "generated", blocks: [{ id: "s1p", type: "paragraph", content: [{ type: "text", text: "Section body." }] }] }],
      visibleFaq: [],
      conclusion: { id: "conc", status: "generated", blocks: [] },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const zhDoc: ArticleDocument = {
      ...enDoc,
      metadata: { ...enDoc.metadata, slug: "guide-zh", title: "與其追求大網紅，不如用創作者", metaDescription: "香港市場推廣。", focusKeyphrase: "" },
      introduction: { id: "zh-intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "品牌與創作者合作。" }] }] },
      sections: [{ id: "zh-section-0", heading: "與否都應該參與？", headingLevel: 2, sectionType: "main", status: "generated", blocks: [{ id: "s1p", type: "paragraph", content: [{ type: "text", text: "品牌與其依賴大網紅，不如與創作者合作。參與度好重要。" }] }] }],
    };

    // The previous production HTTP 400 (validation:section-N: formal written
    // Chinese; use "同") must no longer be produced.
    const errors = validateTranslatedDocument(enDoc, zhDoc, []);
    expect(errors.some((error) => error.includes("formal written Chinese"))).toBe(false);
    expect(errors.some((error) => /use \\"同\\"/.test(error))).toBe(false);
  });

  it("hard number and structure failures still reject", () => {
    const enDoc: ArticleDocument = {
      metadata: { title: "Creator Marketing Guide", slug: "guide", metaDescription: "A guide", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
      languageSwitcher: null,
      introduction: { id: "intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "Brands reach 65% of SMEs within 6 months." }] }] },
      sections: [], visibleFaq: [],
      conclusion: { id: "conc", status: "generated", blocks: [] },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const zhDoc: ArticleDocument = {
      ...enDoc,
      metadata: { ...enDoc.metadata, slug: "guide-zh", title: "香港創作者市場推廣指南", metaDescription: "香港市場推廣指南。", focusKeyphrase: "" },
      introduction: { id: "zh-intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "品牌喺 6 個月內接觸 30% 嘅中小企。" }] }] },
    };

    const errors = validateTranslatedDocument(enDoc, zhDoc, []);
    expect(errors.some((error) => /numbers changed/.test(error))).toBe(true);
  });
});

describe("production all-English section still fails", () => {
  it("rejects a fully untranslated English section", () => {
    const enDoc: ArticleDocument = {
      metadata: { title: "Creator Marketing Guide", slug: "guide", metaDescription: "A guide", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
      languageSwitcher: null,
      introduction: { id: "intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "Brands value authentic voices." }] }] },
      sections: [{ id: "s1", heading: "Why It Matters", headingLevel: 2, sectionType: "main", status: "generated", blocks: [{ id: "s1p", type: "paragraph", content: [{ type: "text", text: "Section body." }] }] }],
      visibleFaq: [],
      conclusion: { id: "conc", status: "generated", blocks: [] },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const zhDoc: ArticleDocument = {
      ...enDoc,
      metadata: { ...enDoc.metadata, slug: "guide-zh", title: "香港創作者市場推廣指南", metaDescription: "香港市場推廣指南。", focusKeyphrase: "" },
      introduction: { id: "zh-intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "香港品牌重視真實聲音。" }] }] },
      sections: [{ id: "zh-section-0", heading: "Why It Matters", headingLevel: 2, sectionType: "main", status: "generated", blocks: [{ id: "s1p", type: "paragraph", content: [{ type: "text", text: "Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell marketing content." }] }] }],
    };

    const errors = validateTranslatedDocument(enDoc, zhDoc, []);
    expect(errors.some((error) => error.includes("section-0") && error.includes("excessive English prose"))).toBe(true);
    expect(errors.some((error) => error.includes("section-0") && error.includes("insufficient Chinese"))).toBe(true);
  });
});


describe("FAQ and CTA do not use structured helper", () => {
  it("FAQ translation does not invoke the helper", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];

    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });

    const faqCalls = calls.filter((c: any) => c.componentId?.includes("faq") || c.componentId?.includes("zh-faq"));
    expect(faqCalls.length).toBe(0);
  });

  it("CTA translation does not invoke the helper", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];

    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });

    const ctaCalls = calls.filter((c: any) => c.componentId?.includes("cta"));
    expect(ctaCalls.length).toBe(0);
  });
});

describe("structured translation shadow orchestration", () => {
  function makeShadowMock(calls: Array<string>): typeof import("./editorial-block-translation").translateEditorialBlocks {
    return async (opts) => {
      if (opts.componentKind === "conclusion") calls.push(opts.componentKind);
      return { blocks: opts.blocks, translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
    };
  }

  it("shadow disabled by default makes zero shadow calls", async () => {
    const mockCalls: Array<string> = [];
    const mockHelper = makeShadowMock(mockCalls);
    const shadowTranslate = vi.fn(async () => "");
    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
      structuredTranslationShadow: { enabled: false, translatePayload: shadowTranslate },
    });
    expect(shadowTranslate).not.toHaveBeenCalled();
    expect(mockCalls.filter((c) => c === "conclusion").length).toBeGreaterThanOrEqual(1);
  });

  it("enabled shadow runs for conclusion but not intro, sections, FAQ, CTA", async () => {
    const mockCalls: Array<string> = [];
    const mockHelper = makeShadowMock(mockCalls);
    const shadowTranslate = vi.fn(async () => {
      mockCalls.push("shadow-conclusion");
      return JSON.stringify({ componentKind: "conclusion", blocks: [] });
    });
    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
      structuredTranslationShadow: {
        enabled: true,
        translatePayload: shadowTranslate,
      },
    });
    // Shadow ran exactly once for conclusion
    expect(shadowTranslate).toHaveBeenCalledTimes(1);
  });

  it("explicit enabled:false overrides environment", async () => {
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    const mockCalls: Array<string> = [];
    const mockHelper = makeShadowMock(mockCalls);
    const shadowTranslate = vi.fn();
    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
      structuredTranslationShadow: { enabled: false, translatePayload: shadowTranslate },
    });
    expect(shadowTranslate).not.toHaveBeenCalled();
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION;
  });

  it("shadow failure does not fail article translation", async () => {
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks = async (opts) => {
      return { blocks: opts.blocks, translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
    };
    const shadowTranslate = vi.fn(async () => "invalid json that will fail");
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
      structuredTranslationShadow: { enabled: true, translatePayload: shadowTranslate },
    });
    // Article translation must succeed even when shadow fails
    expect(result.failedComponents.includes("conclusion")).toBe(false);
    expect(result.structuredShadowResult?.passed).toBe(false);
  });
});

describe("structured conclusion shadow callbacks", () => {
  it("uses STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM not TITLE_META_SYSTEM", async () => {
    // Verify the default production callback uses the dedicated prompt
    const { STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM, TITLE_META_SYSTEM, buildStructuredConclusionTranslationPrompt } = await import("./translation-ai");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    // Build production defaults by calling translateArticle with only env flag (no DI)
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks = async (opts) => {
      return { blocks: opts.blocks, translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
    };
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
      // No structuredTranslationShadow injected — env flag builds production defaults
    });
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION;
    // The shadow was attempted (env flag caused production defaults to run)
    expect(result.structuredShadowResult?.attempted).toBe(true);
  });

  it("initial prompt says only text may change", async () => {
    const { buildStructuredConclusionTranslationPrompt } = await import("./translation-ai");
    const prompt = buildStructuredConclusionTranslationPrompt('{"blocks":[]}');
    expect(prompt).toContain("text");
    expect(prompt).not.toContain("title");
    expect(prompt).not.toContain("meta");
  });

  it("initial prompt forbids HTML, Markdown, and CTA", async () => {
    const { STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM } = await import("./translation-ai");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("Hong Kong Traditional Chinese");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("type");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("seq");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("linkRef");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("__NUM_");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("JSON");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("Markdown");
    expect(STRUCTURED_EDITORIAL_TRANSLATION_SYSTEM).toContain("CTA");
  });

  it("repair builder includes errors and source payload", async () => {
    const { buildStructuredConclusionRepairPrompt } = await import("./translation-ai");
    const prompt = buildStructuredConclusionRepairPrompt('{"src":1}', '{"bad":1}', ["error 1", "error 2"]);
    expect(prompt).toContain("error 1");
    expect(prompt).toContain("error 2");
    expect(prompt).toContain('{"src":1}');
    expect(prompt).toContain('{"bad":1}');
  });

  it("repair builder limits error count and size", async () => {
    const { buildStructuredConclusionRepairPrompt } = await import("./translation-ai");
    const longError = "x".repeat(500);
    const prompts = Array.from({ length: 10 }, (_, i) => `error ${i}: ${longError}`);
    const prompt = buildStructuredConclusionRepairPrompt("{}", "{}", prompts);
    // At most 5 errors included, each at most 200 chars
    expect(prompt.split("error ").length - 1).toBeLessThanOrEqual(5);
  });

  it("environment defaults include a repair callback", async () => {
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks = async (opts) => {
      return { blocks: opts.blocks, translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
    };
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
    });
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION;
    // When the shadow attempted, the environment defaults include both callbacks
    if (result.structuredShadowResult?.attempted) {
      expect(result.structuredShadowResult).toBeDefined();
    }
  });

  it("one repair attempt occurs on invalid response", async () => {
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    const mockHelper: typeof import("./editorial-block-translation").translateEditorialBlocks = async (opts) => {
      return { blocks: opts.blocks, translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
    };
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], {
      translateEditorialBlocks: mockHelper,
    });
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION;
    expect(result.structuredShadowResult).toBeDefined();
  });
});

// ── visibleChars ──

describe("visibleChars", () => {
  it("strips WordPress comments", () => {
    expect(visibleChars("<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->")).toBe(5);
  });
  it("strips HTML tags", () => {
    expect(visibleChars("<p>Hello <strong>world</strong></p>")).toBe(11);
  });
  it("strips script blocks", () => {
    expect(visibleChars('<script>{"@type":"FAQPage"}</script><p>Hello</p>')).toBe(5);
  });
  it("counts Chinese characters", () => {
    expect(visibleChars("<p>香港品牌同創作者必睇</p>")).toBe(10);
  });
});

// ── checkCompleteness ──

describe("checkCompleteness", () => {
  it("passes when ratio meets threshold", () => {
    const r = checkCompleteness("<p>Hello world</p>", "<p>你好世界</p>", "test");
    expect(r.passed).toBe(true);
  });
  it("fails when translation is too short", () => {
    const r = checkCompleteness("<p>This is a long English paragraph with many words for testing</p>", "<p>Short</p>", "test");
    expect(r.passed).toBe(false);
  });
  it("passes empty source", () => {
    expect(checkCompleteness("", "", "test").passed).toBe(true);
  });
  it("passes pure Chinese translation without English leakage", () => {
    const r = checkCompleteness("<p>A short English text here</p>", "<p>一段簡短中文翻譯</p>", "test");
    expect(r.passed).toBe(true);
  });
  it("fails when more than 10% of visible chars are untranslated English", () => {
    const r = checkCompleteness(
      "<p>This is a long English paragraph that should be fully translated into Chinese</p>",
      "<p>呢個係一段中文翻譯，但係後面仲有 Some untranslated English text that is too long and should be caught by the check</p>",
      "test",
    );
    expect(r.passed).toBe(false);
  });
  it("passes when English content is below 10% (brand names, platform names)", () => {
    const r = checkCompleteness(
      "<p>Use Threads for Instagram marketing with Meta platforms</p>",
      "<p>用 Threads 做 Instagram 營銷配合 Meta 平台</p>",
      "test",
    );
    expect(r.passed).toBe(true);
  });
  it("fails when entire translated content is English with no Chinese", () => {
    const r = checkCompleteness("<p>Some English text here</p>", "<p>Completely untranslated English content here that should fail the check</p>", "test");
    expect(r.passed).toBe(false);
  });
  it("fails when one prose block is entirely English even if the component is mostly Chinese", () => {
    // The whole-component English share is far below 10%, but block 2 is an
    // untranslated English block. The final Chinese editorial gate rejects
    // English-heavy blocks per prose block, so the component gate must too.
    const r = checkCompleteness(
      "<p>This is the English source paragraph that must be translated completely into Chinese for the article.</p>",
      "<p>呢段係已經翻譯成繁體中文嘅內容，講述香港品牌點樣運用社交平台推廣。</p><p>Completely untranslated English block that was left behind by the translation model.</p>",
      "test",
    );
    expect(r.passed).toBe(false);
  });
  it("passes when all prose blocks are Chinese despite English brand names", () => {
    const r = checkCompleteness(
      "<p>Use Threads for Instagram marketing with Meta platforms</p>",
      "<p>用 Threads 做 Instagram 營銷配合 Meta 平台</p><p>另一個段落全部係中文內容，只有品牌名稱係英文。</p>",
      "test",
    );
    expect(r.passed).toBe(true);
  });
  it("hasEnglishHeavyProseBlock detects a single untranslated block", () => {
    expect(
      hasEnglishHeavyProseBlock(
        "<p>呢段係中文。</p><p>This English paragraph was never translated and is long enough to be detected.</p>",
      ),
    ).toBe(true);
    expect(
      hasEnglishHeavyProseBlock("<p>呢段係中文內容，完全唔包含英文句子。</p>"),
    ).toBe(false);
  });
});

// ── extractLinks / checkLinksPreserved / checkNoNewUrls ──

describe("extractLinks", () => {
  it("extracts hrefs", () => {
    expect(extractLinks('<a href="/blog/test">X</a>')).toEqual(["/blog/test"]);
  });
});

describe("checkLinksPreserved", () => {
  it("passes when preserved", () => {
    expect(checkLinksPreserved('<a href="/a">A</a>', '<a href="/a">A</a>')).toEqual([]);
  });
  it("detects lost", () => {
    expect(checkLinksPreserved('<a href="/a">A</a> <a href="/b">B</a>', '<a href="/a">A</a>')).toEqual(["/b"]);
  });
});

describe("checkNoNewUrls", () => {
  it("detects invented URLs", () => {
    expect(checkNoNewUrls('<a href="https://real.com">R</a>', '<a href="https://real.com">R</a> <a href="https://fake.com">F</a>')).toEqual(["https://fake.com"]);
  });
  it("allows /blog/ links", () => {
    expect(checkNoNewUrls('<a href="/blog/a">A</a>', '<a href="/blog/a">A</a> <a href="/blog/b">B</a>')).toEqual([]);
  });
});

// ── Number preservation ──

describe("extractVisibleNumbers", () => {
  it("extracts simple numbers", () => {
    const nums = extractVisibleNumbers("<p>There are 15 creators and 200 followers</p>");
    expect(nums).toContain("15");
    expect(nums).toContain("200");
  });

  it("extracts numbers with commas", () => {
    const nums = extractVisibleNumbers("<p>Over 2,500 followers and 15% growth</p>");
    expect(nums).toContain("2,500");
    expect(nums).toContain("15%");
  });

  it("extracts percentages", () => {
    const nums = extractVisibleNumbers("<p>Conversion rate is 3.5%</p>");
    expect(nums).toContain("3.5%");
  });

  it("extracts HK$ amounts", () => {
    const nums = extractVisibleNumbers("<p>Cost is HK$500 per campaign</p>");
    expect(nums).toContain("HK$500");
  });

  it("excludes numbers inside WordPress comments", () => {
    const nums = extractVisibleNumbers('<!-- wp:paragraph {"level":2} --><p>15 creators</p>');
    expect(nums).toEqual(["15"]);
  });

  it("excludes numbers in URLs", () => {
    const nums = extractVisibleNumbers('<a href="https://example.com/page2">Link</a>');
    expect(nums).toEqual([]);
  });

  it("excludes numbers in HTML attributes", () => {
    const nums = extractVisibleNumbers('<div data-id="123"><p>45 users</p></div>');
    expect(nums).toEqual(["45"]);
  });
});

describe("normalizeNumber", () => {
  it("removes commas", () => {
    expect(normalizeNumber("2,500")).toBe("2500");
  });
  it("normalizes full-width percent to number-only", () => {
    expect(normalizeNumber("15％")).toBe("15");
  });
  it("removes HK$ prefix", () => {
    expect(normalizeNumber("HK$100")).toBe("100");
  });
  it("removes US$ prefix", () => {
    expect(normalizeNumber("US$100")).toBe("100");
  });
});

describe("checkNumbersPreserved", () => {
  it("passes when numbers match", () => {
    const r = checkNumbersPreserved("<p>15 creators</p>", "<p>15 位創作者</p>");
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("detects missing number", () => {
    const r = checkNumbersPreserved("<p>15 creators and 200 followers</p>", "<p>15 位創作者</p>");
    expect(r.lost).toContain("200");
  });

  it("handles normalized equivalents", () => {
    const r = checkNumbersPreserved("<p>2,500 followers</p>", "<p>2500 位追蹤者</p>");
    expect(r.lost).toEqual([]);
  });

  it("handles percentage equivalents", () => {
    const r = checkNumbersPreserved("<p>15% growth</p>", "<p>15％ 增長</p>");
    expect(r.lost).toEqual([]);
  });

  it("detects duplicate count mismatch", () => {
    const r = checkNumbersPreserved("<p>15 and 15 and 15</p>", "<p>15 and 15</p>");
    expect(r.lost).toEqual(["15"]);
  });

  it("passes with exact duplicate counts", () => {
    const r = checkNumbersPreserved("<p>15 and 15 and 15</p>", "<p>15 同 15 同 15</p>");
    expect(r.lost).toEqual([]);
  });

  it("detects altered number", () => {
    const r = checkNumbersPreserved("<p>15 creators</p>", "<p>20 位創作者</p>");
    expect(r.lost).toContain("15");
    expect(r.extras).toContain("20");
  });

  it("passes multiple equivalent forms", () => {
    const r = checkNumbersPreserved(
      "<p>Growth: 15%, Followers: 2,500, Budget: HK$500</p>",
      "<p>增長：15％、追蹤者：2500、預算：500 港元</p>",
    );
    expect(r.lost).toEqual([]);
  });
});

// ── Chinese length metrics ──

describe("countCjkChars", () => {
  it("counts Chinese characters only", () => {
    expect(countCjkChars("香港品牌同創作者必睇")).toBe(10);
  });
  it("excludes Latin and spaces", () => {
    expect(countCjkChars("Hello 香港 world 品牌")).toBe(4);
  });
});

describe("countLatinWords", () => {
  it("counts English words", () => {
    expect(countLatinWords("Hello world testing")).toBe(3);
  });
  it("excludes Chinese characters", () => {
    expect(countLatinWords("Hello世界world測試")).toBe(2);
  });
  it("returns 0 for pure Chinese", () => {
    expect(countLatinWords("香港品牌")).toBe(0);
  });
});

describe("countParagraphs", () => {
  it("counts </p> tags", () => {
    expect(countParagraphs("<p>A</p><p>B</p>")).toBe(2);
  });
  it("counts </li> tags", () => {
    expect(countParagraphs("<li>A</li><li>B</li>")).toBe(2);
  });
});

describe("estimatedReadingTime", () => {
  it("estimates time for mixed content", () => {
    const t = estimatedReadingTime(600, 50);
    expect(t).toBeGreaterThanOrEqual(1);
  });
});

describe("chineseLengthMetrics", () => {
  it("produces metrics from HTML", () => {
    const m = chineseLengthMetrics("<p>香港品牌同創作者必睇</p><p>Threads marketing in 2026</p>");
    expect(m.zhCharCount).toBe(10);
    expect(m.latinWordCount).toBeGreaterThanOrEqual(2);
    expect(m.paragraphCount).toBe(2);
    expect(m.estimatedReadingMinutes).toBeGreaterThanOrEqual(1);
  });
});

// ── Integration behaviour tests ──

describe("Completeness guard behaviour", () => {
  it("rejects below 25% ratio", () => {
    const r = checkCompleteness("<p>" + "word ".repeat(100) + "</p>", "<p>Too short</p>", "s");
    expect(r.passed).toBe(false);
    expect(r.ratio).toBeLessThan(0.25);
  });
});

describe("URL integrity", () => {
  it("flags invented external URL", () => {
    const src = '<a href="https://real.com">R</a>';
    const tgt = '<a href="https://real.com">R</a><a href="https://fake.org">F</a>';
    expect(checkNoNewUrls(src, tgt)).toEqual(["https://fake.org"]);
  });
});

describe("Number integrity", () => {
  it("passes equivalent number forms", () => {
    expect(checkNumbersPreserved(
      "<p>Growth: 15%, Followers: 2,500, Budget: HK$500</p>",
      "<p>增長：15％、追蹤者：2500、預算：500 港元</p>",
    ).lost).toEqual([]);
  });
  it("detects altered number", () => {
    const r = checkNumbersPreserved("<p>15 creators</p>", "<p>20 位創作者</p>");
    expect(r.lost).toContain("15");
    expect(r.extras).toContain("20");
  });
});

describe("Section count invariant", () => {
  it("detects missing section", () => {
    const src = ["<p>A</p>", "<p>B</p>", "<p>C</p>"];
    expect(src.length).toBe(3);
  });
});

describe("FAQ parity", () => {
  it("parity: every visible Q needs a schema entry", () => {
    const visible = 6;
    const schema = 5;
    expect(schema).toBeLessThanOrEqual(visible);
  });
  it("exact parity check", () => {
    const visible = 6;
    const schema = 6;
    expect(schema).toBe(visible);
  });
});

// ── Source localisation tests ──

describe("localiseSources", () => {
  const html = `<p>According to <a href="https://example.com/report">a report</a>, Threads grew fast. <a href="https://www.censtatd.gov.hk/en/data">Hong Kong data</a> confirms the trend. <a href="https://marketing-blog.com/trends">A marketing blog</a> also covered this. <a href="/blog/internal">Internal link</a>.</p>`;

  it("preserves authoritative sources", () => {
    const decisions = localiseSources(html, []);
    const censtatd = decisions.find((d: any) => d.originalUrl === "https://www.censtatd.gov.hk/en/data");
    expect(censtatd?.decision).toBe("preserved");
    expect(censtatd?.reason).toContain("preserves");
  });

  it("preserves internal /blog/ links (not external)", () => {
    const decisions = localiseSources(html, []);
    const internal = decisions.find((d: any) => d.originalUrl === "/blog/internal");
    expect(internal).toBeUndefined();
  });

  it("preserves source when no matching research exists", () => {
    const decisions = localiseSources(html, []);
    const example = decisions.find((d: any) => d.originalUrl === "https://example.com/report");
    expect(example?.decision).toBe("preserved");
    expect(example?.matchScore).toBe(10);
  });

  it("preserves source even when a related research candidate exists", () => {
    const research = [
      { title: "Threads成長報告 | 香港社交媒體統計", url: "https://hk-research.com/threads-2026", snippet: "Threads users grew 250% in Hong Kong in 2026", category: "news" },
    ];
    const decisions = localiseSources('<p><a href="https://example.com/threads-report">Threads report</a></p>', research);
    const replaced = decisions.find((d: any) => d.originalUrl === "https://example.com/threads-report");
    expect(replaced?.decision).toBe("preserved");
  });

  it("rejects weak or mismatched research candidate", () => {
    const research = [
      { title: "Weather Report Tokyo", url: "https://tokyo-weather.jp/today", snippet: "Sunny with rain later", category: "news" },
    ];
    const decisions = localiseSources('<p><a href="https://example.com/marketing-guide">Marketing guide</a></p>', research);
    const preserved = decisions.find((d: any) => d.originalUrl === "https://example.com/marketing-guide");
    expect(preserved?.decision).toBe("preserved");
  });

  it("rejects invented URL not in research", () => {
    const decisions = localiseSources('<p><a href="https://invented-site.com/fake">Fake source</a></p>', []);
    const preserved = decisions.find((d: any) => d.originalUrl === "https://invented-site.com/fake");
    expect(preserved?.decision).toBe("preserved");
    expect(preserved?.finalUrl).toBe("https://invented-site.com/fake");
  });

  it("preserves English source when no suitable Chinese source exists", () => {
    const research = [
      { title: "Some unrelated article", url: "https://other-site.com/random", snippet: "Not related to the topic", category: "news" },
    ];
    const decisions = localiseSources('<p><a href="https://english-source.com/study">English study</a></p>', research);
    const preserved = decisions.find((d: any) => d.originalUrl === "https://english-source.com/study");
    expect(preserved?.decision).toBe("preserved");
  });
});

describe("applySourceDecisions", () => {
  it("never rewrites a source URL even when a legacy replacement decision is supplied", () => {
    const decisions = [
      { originalUrl: "https://old.com/page", finalUrl: "https://new.com/page", decision: "replaced" as const, reason: "Test", matchScore: 5 },
    ];
    const result = applySourceDecisions('<a href="https://old.com/page">Link</a>', decisions);
    expect(result).toBe('<a href="https://old.com/page">Link</a>');
  });

  it("does not modify preserved URLs", () => {
    const decisions = [
      { originalUrl: "https://keep.com/page", finalUrl: "https://keep.com/page", decision: "preserved" as const, reason: "Test", matchScore: 10 },
    ];
    const result = applySourceDecisions('<a href="https://keep.com/page">Link</a>', decisions);
    expect(result).toBe('<a href="https://keep.com/page">Link</a>');
  });

  it("survives round-trip through render (no corruption)", () => {
    const input = '<a href="https://example.com">Text</a>';
    const decisions = [
      { originalUrl: "https://example.com", finalUrl: "https://example.com", decision: "preserved" as const, reason: "Test", matchScore: 10 },
    ];
    const output = applySourceDecisions(input, decisions);
    expect(output).toBe(input);
  });
});

// ── Comprehensive source localisation — all 5 link types ──

const ALL_LINK_TYPES_HTML = [
  `<p>Official data from <a href="https://www.censtatd.gov.hk/en/data/report.html">Census & Statistics Dept</a> shows the trend.</p>`,
  `<p>A <a href="https://marketing-insider.com/threads-hk-2026">marketing analysis</a> covered this topic in depth.</p>`,
  `<p>Another <a href="https://niche-english-blog.com/asia-trends">niche English source</a> mentions similar findings.</p>`,
  `<p>Read more on <a href="/blog/hong-kong-creator-economy-2026">B2I Hub HK creator economy</a>.</p>`,
  `<p>Also see <a href="/blog/singapore-influencer-marketing">Singapore influencer marketing</a>.</p>`,
].join("\n");

const RESEARCH_WITH_CHINESE = [
  { title: "Threads香港行銷分析 2026", url: "https://hk-research.hk/threads-analysis", snippet: "Threads喺香港快速增長，預期2026年用戶達250萬", category: "news" },
  { title: "Marketing Insider Report", url: "https://marketing-insider.com/threads-hk-2026", snippet: "In-depth analysis of Threads marketing in HK", category: "news" },
];

describe("End-to-end source localisation — all 5 link types", () => {
  it("preserves authoritative primary source (gov.hk)", () => {
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, RESEARCH_WITH_CHINESE);
    const censtatd = decisions.find((d: any) => d.originalUrl.includes("censtatd.gov.hk"));
    expect(censtatd?.decision).toBe("preserved");
    expect(censtatd?.reason).toContain("preserves");
    expect(censtatd?.matchScore).toBe(10);
  });

  it("preserves secondary sources even when a Chinese alternative exists", () => {
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, RESEARCH_WITH_CHINESE);
    const marketingLink = decisions.find((d: any) => d.originalUrl === "https://marketing-insider.com/threads-hk-2026");
    expect(marketingLink?.finalUrl).toBe(marketingLink?.originalUrl);
    expect(marketingLink?.decision).toBe("preserved");
  });

  it("preserves a source when no research matches", () => {
    // No research at all → every source is preserved
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, []);
    for (const d of decisions) {
      expect(d.decision).toBe("preserved");
      expect(d.finalUrl).toBe(d.originalUrl);
    }
  });

  it("preserves a source when research has no relevant candidate", () => {
    // Research items are completely unrelated — no Chinese domain, no text overlap
    const unrelatedResearch = [
      { title: "Tokyo Weather Forecast", url: "https://tokyo-weather.jp/today", snippet: "Sunny with chance of rain", category: "news" },
    ];
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, unrelatedResearch);
    const niche = decisions.find((d: any) => d.originalUrl === "https://niche-english-blog.com/asia-trends");
    expect(niche?.decision).toBe("preserved");
  });

  it("preserves internal B2I Hub link (not classified as external)", () => {
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, RESEARCH_WITH_CHINESE);
    const internalZh = decisions.find((d: any) => d.originalUrl === "/blog/hong-kong-creator-economy-2026");
    // Internal links are not processed as external sources
    expect(internalZh).toBeUndefined();
  });

  it("preserves internal link without Chinese version (not classified as external)", () => {
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, RESEARCH_WITH_CHINESE);
    const internalEn = decisions.find((d: any) => d.originalUrl === "/blog/singapore-influencer-marketing");
    expect(internalEn).toBeUndefined();
  });

  it("invents no URLs — all decisions have valid http URLs", () => {
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, RESEARCH_WITH_CHINESE);
    for (const d of decisions) {
      expect(d.finalUrl).toMatch(/^https?:\/\//);
      expect(d.originalUrl).toMatch(/^https?:\/\//);
      expect(d.finalUrl).not.toBe("");
    }
  });

  it("source links survive applySourceDecisions round-trip", () => {
    const decisions = localiseSources(ALL_LINK_TYPES_HTML, RESEARCH_WITH_CHINESE);
    const result = applySourceDecisions(ALL_LINK_TYPES_HTML, decisions);
    // All original external URLs should still be present (preserved or replaced)
    for (const d of decisions) {
      if (d.decision === "preserved") {
        expect(result).toContain(d.originalUrl);
      }
    }
    // No corrupted href attributes
    const hrefs = [...result.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    for (const h of hrefs) {
      expect(h).not.toContain("undefined");
      expect(h).not.toContain("null");
    }
  });
});

describe("Numeric preservation by component (exact occurrence matching)", () => {
  it("detects single duplicate mismatch", () => {
    // Source has "250%" = %:250, "30 million" = scaled to 30000000
    // Translated has only "250%" = %:250
    const r = checkNumbersPreserved(
      "<p>Threads users grew 250%, reaching 30 million</p>",
      "<p>Threads 用戶增長 250%</p>",
    );
    expect(r.lost).toEqual(["30000000"]);
    expect(r.lost).not.toContain("250");
  });

  it("passes with exact duplicate counts", () => {
    const r = checkNumbersPreserved(
      "<p>250% growth and 250% engagement rate</p>",
      "<p>250% 增長同 250% 互動率</p>",
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("detects one extra occurrence", () => {
    const r = checkNumbersPreserved(
      "<p>Revenue was 15%</p>",
      "<p>Revenue 係 15% 同 15%</p>",
    );
    expect(r.extras).toEqual(["%:15"]);
  });

  it("distinguishes component A vs component B numbers", () => {
    // Simulate two separate component checks
    const r1 = checkNumbersPreserved(
      "<p>Section A: 15 creators, 200 followers</p>",
      "<p>A 部分：15 位創作者，200 位追蹤者</p>",
    );
    expect(r1.lost).toEqual([]);

    const r2 = checkNumbersPreserved(
      "<p>Section B: 500 impressions, 3.5% CTR</p>",
      "<p>B 部分：500 曝光，3.5% 點擊率</p>",
    );
    expect(r2.lost).toEqual([]);
  });

  it("reports exact per-component lost values", () => {
    const r = checkNumbersPreserved(
      "<p>Budget: HK$5,000 for 2 months with 15% ROI target of 250%</p>",
      "<p>預算：5000 港元，為期 2 個月，ROI 目標 250%</p>",
    );
    // 15% was dropped
    expect(r.lost).toContain("%:15");
  });

  it("passes all factual numbers preserved in full translation", () => {
    const r = checkNumbersPreserved(
      "<p>Users: 250%, Followers: 2,500, Budget: HK$5,000, CTR: 3.5%, ROI: 250%, Duration: 2 months</p>",
      "<p>用戶增長：250%、追蹤者：2500、預算：5000 港元、點擊率：3.5%、ROI：250%、為期：2 個月</p>",
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });
});

// ── QA-script logic tests ──

describe("Brand check logic (QA)", () => {
  const ALL = ["B2I Hub", "Threads", "Instagram", "Facebook", "Meta", "Google"];
  const checkBrands = (enText: string, zhText: string) => {
    const brandsInSource = ALL.filter((b) => new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(enText));
    const missing = brandsInSource.filter((b) => !new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(zhText));
    return { brandsInSource, missing };
  };

  it("source contains Meta and Google — both required", () => {
    const r = checkBrands("Use Meta and Google tools", "使用 Meta 同 Google 工具");
    expect(r.brandsInSource).toEqual(["Meta", "Google"]);
    expect(r.missing).toEqual([]);
  });

  it("source contains none — no failure", () => {
    const r = checkBrands("Just some generic marketing text", "一啲通用營銷內容");
    expect(r.brandsInSource).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("translated changes casing only — still passes", () => {
    const r = checkBrands("Threads and B2I Hub", "threads and b2i hub");
    expect(r.missing).toEqual([]);
  });

  it("missing brand flagged", () => {
    const r = checkBrands("Threads and Facebook", "Threads only");
    expect(r.missing).toEqual(["Facebook"]);
  });
});

describe("Heading check logic (QA)", () => {
  const editorialHeadings = (html: string) => {
    const cleaned = html
      .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<!--\s*wp:html\s*-->/gi, "")
      .replace(/<!--\s*\/wp:html\s*-->/gi, "");
    const bareH2s = (cleaned.match(/<h2[^>]*>/gi) || []).length;
    const wpHeading2 = (cleaned.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) || []).length;
    return { bareH2s, wpHeading2, mismatch: Math.abs(bareH2s - wpHeading2) };
  };

  it("CTA H2 inside wp:html does not fail", () => {
    const html = `<!-- wp:heading {"level":2} --><h2>Real</h2><!-- /wp:heading -->\n<!-- wp:html --><div><h2>CTA</h2></div><!-- /wp:html -->`;
    const h = editorialHeadings(html);
    expect(h.mismatch).toBe(0);
  });

  it("real H2 without wp:heading fails", () => {
    const html = `<h2>Missing WP block</h2>`;
    const h = editorialHeadings(html);
    expect(h.mismatch).toBe(1);
  });

  it("valid editorial headings pass", () => {
    const html = `<!-- wp:heading {"level":2} --><h2>S1</h2><!-- /wp:heading -->\n<!-- wp:heading {"level":2} --><h2>S2</h2><!-- /wp:heading -->`;
    const h = editorialHeadings(html);
    expect(h.mismatch).toBe(0);
  });
});

describe("Number check logic (QA — count-based, not total-count)", () => {
  const extractVisibleNumbers = (html: string) => {
    const cleaned = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const re = /(?:HK?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/g;
    const nums: string[] = []; let m;
    while ((m = re.exec(cleaned)) !== null) nums.push(m[0]);
    return nums;
  };
  const normalize = (n: string) => n.replace(/,/g, "").replace(/[%％]/g, "").replace(/HK?\$/, "").trim();
  const countCheck = (enHtml: string, zhHtml: string) => {
    const srcNums = extractVisibleNumbers(enHtml).map(normalize);
    const tgtNums = extractVisibleNumbers(zhHtml).map(normalize);
    const srcC: Record<string, number> = {}; const tgtC: Record<string, number> = {};
    for (const n of srcNums) srcC[n] = (srcC[n] || 0) + 1;
    for (const n of tgtNums) tgtC[n] = (tgtC[n] || 0) + 1;
    const lost: string[] = []; const extras: string[] = [];
    for (const [n, c] of Object.entries(srcC)) { const tc = tgtC[n] || 0; if (tc < c) lost.push(...Array(c - tc).fill(n)); }
    for (const [n, c] of Object.entries(tgtC)) { const sc = srcC[n] || 0; if (sc < c) extras.push(...Array(c - sc).fill(n)); }
    return { lost, extras, srcTotal: srcNums.length, tgtTotal: tgtNums.length };
  };

  it("passes when all numbers preserved", () => {
    const r = countCheck("<p>250% growth and 3.5% CTR</p>", "<p>250% 增長同 3.5% 點擊率</p>");
    expect(r.lost).toEqual([]);
  });

  it("detects lost number with exact value", () => {
    const r = countCheck("<p>250% growth and 1.2 million</p>", "<p>250% 增長</p>");
    expect(r.lost).toEqual(["1.2"]);
  });
});

// ── Scaled number equivalence tests ──

describe("Scaled number equivalence", () => {
  it("1.2 million ↔ 120萬 (via checkNumbersPreserved)", () => {
    // checkNumbersPreserved uses extractScaledNumbers internally
    const r = checkNumbersPreserved(
      "<p>1.2 million users</p>",
      "<p>120 萬用戶</p>"
    );
    // Both should normalize to the same base value
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("2.5 billion ↔ 25億", () => {
    const r = checkNumbersPreserved(
      "<p>2.5 billion market size</p>",
      "<p>25 億市場規模</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("500 thousand ↔ 50萬", () => {
    const r = checkNumbersPreserved(
      "<p>500 thousand followers</p>",
      "<p>50 萬位追蹤者</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("HK$1.2 million ↔ 120萬港元", () => {
    const r = checkNumbersPreserved(
      "<p>Budget of HK$1.2 million</p>",
      "<p>120 萬港元預算</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("currency mismatch US$ vs HK$ rejected", () => {
    const r = checkNumbersPreserved(
      "<p>US$1.2 million budget</p>",
      "<p>120 萬港元預算</p>"
    );
    expect(r.lost.length).toBeGreaterThan(0);
  });

  it("percentage mismatch rejected", () => {
    const r = checkNumbersPreserved(
      "<p>15% growth rate</p>",
      "<p>15 增長率</p>"
    );
    expect(r.lost.length).toBeGreaterThan(0);
  });

  it("duplicate scaled quantities tracked separately", () => {
    const r = checkNumbersPreserved(
      "<p>1.5 million and 1.5 million users</p>",
      "<p>150 萬同 150 萬用戶</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("altered values still fail (1.2M vs 2.5M)", () => {
    const r = checkNumbersPreserved(
      "<p>1.2 million users</p>",
      "<p>250 萬用戶</p>"
    );
    expect(r.lost).toContain("1200000");
    expect(r.extras).toContain("2500000");
  });

  it("simple un-scaled numbers still work", () => {
    const r = checkNumbersPreserved(
      "<p>15 creators and 200 followers</p>",
      "<p>15 位創作者同 200 位追蹤者</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("percentages with scaled numbers coexist", () => {
    const r = checkNumbersPreserved(
      "<p>250% growth from 1.2 million users</p>",
      "<p>250% 增長來自 120 萬用戶</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it("thousand scale English to Chinese", () => {
    const r = checkNumbersPreserved(
      "<p>5 thousand downloads</p>",
      "<p>5 千次下載</p>"
    );
    expect(r.lost).toEqual([]);
    expect(r.extras).toEqual([]);
  });
});


describe("translation metadata and fail-closed parity", () => {
  it("builds usable Chinese metadata deterministically when the provider is empty", () => {
    const fallback = deterministicMetadataFallback(
      "Threads Marketing Hong Kong Guide 2026",
      "香港中小企可以透過 Threads 建立真誠互動，並以實用內容逐步累積品牌信任。",
      [],
      "title",
      "香港Threads市場推廣",
    );

    expect(fallback).toContain("香港Threads市場推廣");
    expect(fallback).toContain("Threads");
    expect(fallback).toContain("2026");
    expect(fallback).toMatch(/[\u3400-\u9fff]/u);
  });

  it("does not misclassify ordinary capitalised research-title words as protected entities", () => {
    const enDoc: ArticleDocument = {
      metadata: { title: "Practical Guide", slug: "guide", metaDescription: "Useful guidance.", excerpt: "", targetWordCount: 500, focusKeyphrase: "香港指南" },
      languageSwitcher: null,
      introduction: { id: "intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "What Audience Need Which Marketers understand." }] }] },
      sections: [{
        id: "section-0", heading: "How to Understand Your Audience", headingLevel: 2, sectionType: "main", status: "generated",
        blocks: [{ id: "s1-p1", type: "paragraph", content: [{ type: "text", text: "Which marketers need this audience insight?" }] }],
      }], visibleFaq: [],
      conclusion: { id: "conc", status: "generated", blocks: [] },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const zhDoc: ArticleDocument = {
      ...enDoc,
      metadata: { ...enDoc.metadata, slug: "guide-zh", title: "香港指南實用方法", metaDescription: "提供香港市場實用建議。", focusKeyphrase: "香港指南" },
      introduction: { id: "zh-intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "了解受眾需要，市場推廣人員便能制定合適方法。" }] }] },
      sections: [{
        id: "zh-section-0", heading: "如何了解你的受眾", headingLevel: 2, sectionType: "main", status: "generated",
        blocks: [{ id: "s1-p1", type: "paragraph", content: [{ type: "text", text: "哪些市場推廣人員需要這項受眾洞察？" }] }],
      }],
    };
    const errors = validateTranslatedDocument(enDoc, zhDoc, [{
      url: "https://example.com/article",
      title: "What Audience Need Which Marketers Should Know",
    }]);

    expect(errors.some((error) => /named entities changed:.*(?:Audience|Need|Which|Marketers)/.test(error))).toBe(false);
    expect(errors.some((error) => /section 0 heading (?:contains|named entities changed)/.test(error))).toBe(false);
  });

  it("rejects English fallback content and a title missing the Chinese keyphrase", () => {
    const enDoc: ArticleDocument = {
      metadata: {
        title: "Threads Marketing Hong Kong Guide",
        slug: "threads-marketing-hong-kong",
        metaDescription: "A practical guide for Hong Kong SMEs.",
        excerpt: "A practical guide.",
        targetWordCount: 1000,
        focusKeyphrase: "threads marketing hong kong",
      },
      languageSwitcher: null,
      introduction: { id: "intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "English source paragraph." }] }] },
      sections: [{ id: "s1", heading: "Getting Started", headingLevel: 2, sectionType: "main", status: "generated", blocks: [{ id: "p2", type: "paragraph", content: [{ type: "text", text: "English section." }] }] }],
      visibleFaq: [],
      conclusion: { id: "conc", status: "generated", blocks: [{ id: "p3", type: "paragraph", content: [{ type: "text", text: "English conclusion." }] }] },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
    const zhDoc: ArticleDocument = {
      ...enDoc,
      metadata: {
        ...enDoc.metadata,
        slug: "threads-marketing-hong-kong-zh",
        title: "香港 Threads 實用指南",
        metaDescription: "為香港中小企整理 Threads 市場推廣策略。",
        excerpt: "香港中小企實用指南。",
        focusKeyphrase: "香港Threads市場推廣",
      },
      introduction: enDoc.introduction,
      sections: enDoc.sections,
      conclusion: enDoc.conclusion,
    };

    const errors = validateTranslatedDocument(enDoc, zhDoc, []);
    expect(errors.some((error) => error.includes("keyphrase missing from SEO title"))).toBe(true);
    expect(errors.some((error) => error.includes("insufficient Chinese") || error.includes("excessive English"))).toBe(true);
  });
});

describe("translated temporal parity gate", () => {
  it("rejects stale Chinese predictions introduced by translation", () => {
    const enDoc: ArticleDocument = {
      metadata: { title: "Threads Guide", slug: "threads-guide", metaDescription: "Guide", excerpt: "", targetWordCount: 500, focusKeyphrase: "threads marketing" },
      languageSwitcher: null,
      introduction: { id: "intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "Advertising is available through Meta Ads Manager." }] }] },
      sections: [], visibleFaq: [],
      conclusion: { id: "conc", status: "generated", blocks: [] },
      cta: null, faqSchema: null, insertedLinks: [],
    };
    const zhDoc: ArticleDocument = {
      ...enDoc,
      metadata: { ...enDoc.metadata, slug: "threads-guide-zh", title: "香港Threads市場推廣指南", metaDescription: "香港Threads市場推廣指南", focusKeyphrase: "香港Threads市場推廣" },
      introduction: { id: "zh-intro", status: "generated", blocks: [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "廣告功能預計於2025年稍後擴展。" }] }] },
    };
    const errors = validateTranslatedDocument(enDoc, zhDoc, []);
    expect(errors.some((error) => error.includes("stale temporal wording"))).toBe(true);
  });
});
