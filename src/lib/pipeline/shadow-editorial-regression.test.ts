import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog/final-seo-normalizer", () => ({
  ensureKeyphraseInFirst100Words: vi.fn((html: string) => html),
  normalizeFinalSeo: vi.fn(async (input: { html: string }) => ({
    html: input.html,
    passed: true,
    safety: {
      protectedBlocksUnchanged: true,
      linkDestinationsUnchanged: true,
      wordpressBlocksValid: true,
      faqSchemaPreserved: true,
      languageSwitcherPreserved: true,
      ctaPreserved: false,
    },
    before: {},
    after: {},
    changes: [],
    warnings: [],
    reasons: [],
  })),
}));

vi.mock("@/lib/services/component-regenerator", () => ({
  runComponentRegeneration: vi.fn(async (_ctx: unknown, article: { blog: string; title: string; metaDescription: string }) => ({
    blog: article.blog,
    title: article.title,
    meta: article.metaDescription,
    regenerations: 0,
  })),
  regenerateSection: vi.fn(async () => {
    throw new Error("Unexpected section regeneration in shadow test");
  }),
}));

vi.mock("@/lib/services/default-links", () => ({
  seedDefaultLinks: vi.fn(async () => undefined),
}));

vi.mock("@/lib/services/link-injector", () => ({
  injectLinks: vi.fn(async (html: string) => ({ modifiedContent: html, linksInjected: 0 })),
}));

import {
  parseWordPressEditorialBlocks,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import {
  assertRenderedCacheMatchesDocument,
  createPipelineState,
  runFinalValidation,
  runPostAssemblyPipeline,
} from "@/lib/pipeline/blog-generation-pipeline";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function component(id: string, html: string): ArticleDocument["introduction"] {
  return { id, blocks: parseWordPressEditorialBlocks(html, id).blocks, status: "generated" };
}

function section(
  id: string,
  heading: string,
  html: string,
  sectionType: ArticleSection["sectionType"] = "main",
): ArticleSection {
  return { ...component(id, html), heading, headingLevel: 2, sectionType };
}

function buildDeterministic2500WordDocument(): ArticleDocument {
  const sentences = [
    "Local teams can share useful lessons from daily work with clear and honest words.",
    "Simple examples help busy owners understand the idea and take a practical next step.",
    "Regular replies also show customers that a real person is listening to their needs.",
    "A small weekly plan keeps the work steady without adding stress to the whole team.",
    "Owners can note common questions and turn those questions into helpful future posts.",
    "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
  ];
  const makeParagraphs = (sectionIndex: number, count: number): string => {
    const blocks: string[] = [];
    for (let index = 0; index < count; index++) {
      const first = sentences[(index + sectionIndex) % sentences.length];
      const second = sentences[(index + sectionIndex + 1) % sentences.length];
      const third = sentences[(index + sectionIndex + 2) % sentences.length];
      blocks.push(paragraph(`${first} ${second} ${third}`));
    }
    return blocks.join("\n\n");
  };
  const keyphrase = "threads marketing hong kong";
  const introHtml = [
    paragraph(`Opening guide to ${keyphrase} gives local owners a clear place to start. ${sentences[0]} ${sentences[1]} ${sentences[2]}`),
    makeParagraphs(0, 3),
  ].join("\n\n");
  const headings = [
    "Threads Marketing Hong Kong for Small Local Brands",
    "Understand the People You Want to Reach",
    "Build a Simple Weekly Content Routine",
    "Create Posts That Start Useful Conversations",
    "Measure Results and Improve the Next Post",
    "Common Mistakes Hong Kong SMEs Should Avoid",
  ];
  const sections = headings.map((heading, index) => section(`section-${index}`, heading, makeParagraphs(index, 9)));
  sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
  const conclusionHtml = [
    paragraph(`A useful ${keyphrase} plan does not need a large team or an expensive campaign. ${sentences[3]} ${sentences[4]} ${sentences[5]}`),
    makeParagraphs(2, 2),
  ].join("\n\n");
  return {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content, start genuine conversations, measure results, avoid common mistakes, and build steady local trust.",
      excerpt: "A practical guide for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: keyphrase,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-practical-sme-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: "language-switcher",
    },
    introduction: component("intro", introHtml),
    sections,
    visibleFaq: [1, 2, 3, 4].map((index) => ({
      question: `What should a Hong Kong SME know first ${index}?`,
      answerHtml: "",
      answerText: "Start with a small and useful routine. Listen to real customer questions, reply in a natural voice, and review which conversations lead to profile visits or enquiries.",
    })),
    conclusion: component("conclusion", conclusionHtml),
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

afterEach(() => {
  delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
  delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
});

describe("shadow editorial mode stays diagnosis-only in the pipeline", () => {
  it("commits the baseline unchanged and still passes final validation", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    const keyphrase = "threads marketing hong kong";
    const doc = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "shadow-test",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, keyphrase),
      ctx: { research: [] },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });

    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => {
        throw new Error("Unexpected AI call in deterministic shadow-mode test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic shadow-mode test");
      },
      telemetry: {},
      context: { research: [] },
    });

    expect(result.fullDocumentEditorial).toBeTruthy();
    expect(result.fullDocumentEditorial!.mode).toBe("shadow");
    expect(result.fullDocumentEditorial!.status).toBe("shadow");
    // Diagnosis-only: the full-document stage must not change the document.
    expect(result.fullDocumentEditorial!.outputFingerprint).toBe(result.fullDocumentEditorial!.baselineFingerprint);

    assertRenderedCacheMatchesDocument(result);
    const validation = runFinalValidation(result);
    expect(validation.passed, validation.reasons.join("; ")).toBe(true);
  });
});

describe("final-document editorial enforce mode fails closed on coherence-damaging patches", () => {
  it("a patch that introduces a deletion-created discourse opening is rejected before commit", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const keyphrase = "threads marketing hong kong";
    const doc = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "fde-enforce-coherence",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, keyphrase),
      ctx: { research: [] },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });

    let thrown: Error | undefined;
    try {
      await runPostAssemblyPipeline(state, {
        chatWithRetry: async (_messages: unknown, _options: unknown, label?: string) => {
          if (label === "final-document-diagnosis") {
            return {
              content: JSON.stringify({ findings: [{
                findingId: "f-aw", category: "awkward-english", severity: "medium",
                blockIds: ["section:section-0:section-0-block-0"],
                message: "Awkward phrasing in this opening paragraph.",
                evidenceIds: [], brandRuleIds: [], confidence: 0.8,
              }] }),
              finishReason: "stop", attemptsUsed: 0,
            };
          }
          if (label === "final-document-patch") {
            // The patch replaces the section's opening paragraph with a
            // deletion-created discourse opening ("That's why ..."), which is a
            // hard validateCoherence violation. The committed-candidate gate
            // must reject it before commit.
            return {
              content: JSON.stringify({ edits: [{
                blockId: "section:section-0:section-0-block-0",
                replacementHtml: "<!-- wp:paragraph --><p>That's why customer community marketing has become such a powerful way for brands to grow.</p><!-- /wp:paragraph -->",
                reason: "rewrite opening",
              }] }),
              finishReason: "stop", attemptsUsed: 0,
            };
          }
          throw new Error(`Unexpected AI call in enforce test: ${label ?? "unknown"}`);
        },
        makeTrackedChatForStage: () => async () => {
          throw new Error("Unexpected tracked AI call in enforce test");
        },
        telemetry: {},
        context: { research: [] },
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown!.message).toContain("Final-document editorial acceptance failed");
  });
});
