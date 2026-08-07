import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { EditorialBlock, InlineContent } from "@/lib/blog/article-content";
import type { TranslateEditorialBlocksOptions } from "./editorial-block-translation";

/** Shared event log proving the shadow runs only after production provider work. */
const order: string[] = [];

// This integration suite verifies orchestration order, not the live provider.
// Keep metadata fallbacks deterministic and prevent fixture content from ever
// leaving the test process even though individual cases install a fake key.
vi.mock("@/lib/services/deepseek", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/deepseek")>();
  return {
    ...actual,
    AiService: class OfflineAiService {
      get chatWithRetry() {
        return async () => {
          throw new Error("document-context shadow integration offline provider guard");
        };
      }
    },
  };
});

vi.mock("./document-context-translation-shadow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./document-context-translation-shadow")>();
  return {
    ...actual,
    isDocumentContextTranslationShadowEnabled: vi.fn(() => true),
    runDocumentContextTranslationShadow: vi.fn(async () => {
      order.push("shadow");
      return ({
        enabled: true,
        sourceDocumentFingerprint: "shadow-fp",
        planFingerprint: "plan-fp",
        totalPlannedChunks: 5,
        substantiveChunkCallCount: 4,
        skippedProtectedChunks: 1,
        providerAttemptCount: 4,
        validChunkCount: 1,
        partialChunkCount: 1,
        failedChunkCount: 3,
        chunkResults: [],
        contractFailures: ["shadow contract failure"],
        protectedParityFailures: ["shadow parity failure"],
        coverage: {
          translatedSubstantive: { translated: 5, total: 105 },
          wholeDocument: { translated: 5, protected: 1, unresolved: 100, total: 106 },
        },
        allChunksCompleted: false,
        assembly: { status: "assembled", missingUnits: [], doc: null },
        editorial: { enabled: false, status: "not-run", attemptCount: 0, valid: false, failure: null, preEditorialDoc: null, polishedDoc: null, perUnitValid: 0, perUnitInvalid: 0, tokenUsage: null },
        preview: { previewOnly: true, retainedDoc: null, retainedSource: "pre-editorial", stored: false, exportPath: null, timestamp: "" },
        warnings: ["shadow warning"],
      });
    }),
  };
});

import { translateArticle } from "./translation-service";
import {
  runDocumentContextTranslationShadow,
  isDocumentContextTranslationShadowEnabled,
} from "./document-context-translation-shadow";

const mockedRun = vi.mocked(runDocumentContextTranslationShadow);
const mockedEnabled = vi.mocked(isDocumentContextTranslationShadowEnabled);

const TEST_EN_KEY = "sk-test-shadow-integration";

function makeSourceDoc(): ArticleDocument {
  return {
    metadata: { title: "", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function makeMinimalEnHtml(): string {
  return `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span></div><!-- /wp:html -->

<!-- wp:paragraph --><p>Introduction text.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} --><h2>測試一節</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>Section body.</p><!-- /wp:paragraph -->

<!-- b2i-conclusion-start -->
<!-- wp:paragraph --><p>Conclusion.</p><!-- /wp:paragraph -->
<!-- b2i-conclusion-end -->`;
}

function makeMockHelper(calls: Array<{ componentId: string; componentKind: string }>) {
  return async (opts: TranslateEditorialBlocksOptions) => {
    calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
    order.push("production");
    const translateBlock = (block: EditorialBlock): EditorialBlock => {
      if (block.type === "list") {
        return { ...block, items: block.items.map((item: InlineContent[]) => item.map((n: InlineContent) => ({ ...n, text: "香港內容。" }))) };
      }
      if (block.type === "table") {
        return {
          ...block,
          headers: block.headers.map((h: InlineContent[]) => h.map((n: InlineContent) => ({ ...n, text: "香港內容。" }))),
          rows: block.rows.map((row: InlineContent[][]) => row.map((cell: InlineContent[]) => cell.map((n: InlineContent) => ({ ...n, text: "香港內容。" })))),
        };
      }
      return { ...block, content: block.content.map((n: InlineContent) => ({ ...n, text: "香港內容。" })) };
    };
    return {
      blocks: opts.blocks.map(translateBlock),
      translatedHtml: "",
      passed: true,
      metrics: { sourceChars: 10, translatedChars: 10, ratio: 1, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
    };
  };
}

describe("document-context shadow production integration boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    mockedEnabled.mockReturnValue(true);
    process.env.DEEPSEEK_API_KEY = TEST_EN_KEY;
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("flag true invokes the shadow after the English document is available", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });
    expect(mockedEnabled).toHaveBeenCalled();
    expect(mockedRun).toHaveBeenCalledTimes(1);
    const enDoc = mockedRun.mock.calls[0][0];
    expect(enDoc).toBeDefined();
  });

  it("the shadow starts only after all production provider work has completed", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });
    const lastProduction = order.lastIndexOf("production");
    const shadowIndex = order.indexOf("shadow");
    expect(shadowIndex).toBeGreaterThanOrEqual(0);
    expect(shadowIndex).toBe(order.length - 1);
    expect(lastProduction).toBeLessThan(shadowIndex);
  });

  it("shadow failures do not change production failedComponents", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });
    // The shadow returned 3 failed chunks + contract/parity failures, but the
    // production translation must not surface any of them as component failures.
    expect(result.failedComponents.some((c) => /shadow/.test(c))).toBe(false);
    expect(result.failedComponents.some((c) => /validation:shadow/.test(c))).toBe(false);
  });

  it("shadow failures do not change the canonical zhDoc", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });
    expect(result.doc.metadata.slug).toBe("test-zh");
    expect(result.doc).toBeDefined();
    expect(result.doc).not.toHaveProperty("shadow");
  });

  it("shadow results are never passed to the assembler or save path", async () => {
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });
    expect(result).not.toHaveProperty("shadow");
    expect(result).not.toHaveProperty("documentContextShadow");
    // The production result is exactly the canonical zhDoc render.
    expect(result.html).toBe(result.doc ? (await import("@/lib/blog/article-document")).renderArticleDocument(result.doc) : "");
  });

  it("flag false causes zero shadow calls and leaves production output unchanged", async () => {
    mockedEnabled.mockReturnValue(false);
    const calls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(makeMinimalEnHtml(), makeSourceDoc(), [], { translateEditorialBlocks: makeMockHelper(calls) });
    expect(mockedRun).not.toHaveBeenCalled();
    expect(result.doc.metadata.slug).toBe("test-zh");
    // Any production failures present are metadata-only (fake key), never shadow-related.
    expect(result.failedComponents.some((c) => /shadow/.test(c))).toBe(false);
  });
});
