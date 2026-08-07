import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog/final-seo-normalizer", () => ({
  ensureKeyphraseInFirst100Words: vi.fn((html: string) => html),
  normalizeFinalSeo: vi.fn(async (input: { html: string }) => {
    const extraParagraphs = Array.from(
      { length: 9 },
      () => `<!-- wp:paragraph --><p>This added paragraph gives practical details for local business owners. It explains a simple action, keeps the advice clear, and helps the reader apply the plan without extra tools or a large team.</p><!-- /wp:paragraph -->`,
    ).join("\n\n");

    return {
      html: input.html
        .replace("Opening guide", "UPDATED Opening guide")
        .replace(
          "<!-- b2i-conclusion-start -->",
          `${extraParagraphs}\n\n<!-- b2i-conclusion-start -->`,
        ),
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
    };
  }),
}));

vi.mock("@/lib/services/component-regenerator", () => ({
  runComponentRegeneration: vi.fn(async (_ctx: unknown, article: { blog: string; title: string; metaDescription: string }) => ({
    blog: article.blog,
    title: article.title,
    meta: article.metaDescription,
    regenerations: 0,
  })),
  regenerateSection: vi.fn(async () => {
    throw new Error("Unexpected section regeneration in deterministic end-to-end test");
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
  renderArticleDocument,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import {
  assertRenderedCacheMatchesDocument,
  createPipelineState,
  finalReadableWordCount,
  runFinalValidation,
  runPostAssemblyPipeline,
} from "@/lib/pipeline/blog-generation-pipeline";
import { analyzeFinalArticle, buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function component(id: string, html: string): ArticleDocument["introduction"] {
  return {
    id,
    blocks: parseWordPressEditorialBlocks(html, id).blocks,
    status: "generated",
  };
}

function section(
  id: string,
  heading: string,
  html: string,
  sectionType: ArticleSection["sectionType"] = "main",
): ArticleSection {
  return {
    ...component(id, html),
    heading,
    headingLevel: 2,
    sectionType,
  };
}

function buildDeterministic2500WordDocument(): {
  doc: ArticleDocument;
  introHtml: string;
  conclusionHtml: string;
} {
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

  const sections = headings.map((heading, index) =>
    section(`section-${index}`, heading, makeParagraphs(index, 9)),
  );
  sections.push(section(
    "faq-section",
    "Frequently Asked Questions About Threads Marketing",
    "",
    "faq-heading",
  ));

  const conclusionHtml = [
    paragraph(`A useful ${keyphrase} plan does not need a large team or an expensive campaign. ${sentences[3]} ${sentences[4]} ${sentences[5]}`),
    makeParagraphs(2, 2),
  ].join("\n\n");

  const doc: ArticleDocument = {
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

  return { doc, introHtml, conclusionHtml };
}

describe("2500-word post-assembly generation pipeline", () => {
  it("completes every real stage with stable structure and final validation", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    const initialHtml = renderArticleDocument(doc);
    const initialMetrics = analyzeFinalArticle(
      initialHtml,
      keyphrase,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
    );

    expect(initialMetrics.readableWordCount).toBeGreaterThanOrEqual(range.min);
    expect(initialMetrics.readableWordCount).toBeLessThanOrEqual(range.max);
    expect(initialMetrics.h2Count).toBe(6);
    expect(initialMetrics.faqEntryCount).toBe(4);

    const state = createPipelineState({
      userId: "test-user",
      projectId: "2500-test",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((item) => item.heading),
      intro: introHtml,
      conclusion: conclusionHtml,
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
        throw new Error("Unexpected AI call in deterministic end-to-end test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic end-to-end test");
      },
      telemetry: {},
      context: { research: [] },
    });

    assertRenderedCacheMatchesDocument(result);
    const validation = runFinalValidation(result);
    const finalMetrics = analyzeFinalArticle(
      result.blog,
      keyphrase,
      result.title,
      result.metaDescription,
      2500,
    );
    const finalTrim = result.stageOutputs.find((output) => output.stage === "final-trim");

    expect(validation.passed).toBe(true);
    expect(finalReadableWordCount(result)).toBeGreaterThanOrEqual(range.min);
    expect(finalReadableWordCount(result)).toBeLessThanOrEqual(range.max);
    expect(finalMetrics.h2Count).toBe(6);
    expect(finalMetrics.faqEntryCount).toBe(4);
    expect(finalMetrics.longParagraphCount).toBe(0);
    expect(result.blog).toContain("UPDATED Opening guide");
    expect((result.blog.match(/app\.b2ihub\.com\/signup/gi) ?? []).length).toBe(1);
    expect((result.blog.match(/\"@type\": \"FAQPage\"/g) ?? []).length).toBe(1);
    expect((result.blog.match(/b2i-conclusion-start/g) ?? []).length).toBe(1);
    expect(finalTrim).toBeDefined();
    expect(finalTrim!.inputFingerprint).not.toBe(finalTrim!.outputFingerprint);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
  });
});

describe("external-link pipeline diagnostics", () => {
  function runWithContext(context: { research: Array<{ url: string; title: string; snippet?: string; category?: string; position?: number }> }) {
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const keyphrase = "threads marketing hong kong";
    const { min: wordMin, max: wordMax } = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "links-test",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((item) => item.heading),
      intro: introHtml,
      conclusion: conclusionHtml,
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, wordMin, wordMax, keyphrase),
      ctx: { research: context.research },
      wordMin,
      wordMax,
      systemPrompt: "test",
      userMessage: "test",
    });
    return runPostAssemblyPipeline(state, {
      chatWithRetry: async () => {
        throw new Error("Unexpected AI call in deterministic end-to-end test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic end-to-end test");
      },
      telemetry: {},
      context,
    });
  }

  it("injects eligible research sources and keeps them in the final article", async () => {
    const sources = [
      { url: "https://example.com/threads-local-brands", title: "Threads Marketing for Small Local Brands in Hong Kong", snippet: "Local teams share useful lessons from daily work with clear and honest words." },
      { url: "https://example.com/understand-audience", title: "Understand the People You Want to Reach", snippet: "Simple examples help busy owners understand the idea and take a practical next step." },
    ];
    let result: Awaited<ReturnType<typeof runPostAssemblyPipeline>> | undefined;
    try {
      result = await runWithContext({ research: sources });
    } catch {
      // final validation may fail for unrelated editorial reasons; inspect state
    }
    const finalBlog = result ? result.blog : "";
    if (finalBlog) {
      for (const url of sources.map((s) => s.url)) {
        const idx = finalBlog.indexOf(url);
        if (idx >= 0) {
          const start = Math.max(0, idx - 400);
          console.log(`[DEBUG-PLACE] ${url.split("/").pop()} near: ` + JSON.stringify(finalBlog.slice(start, idx + 120).replace(/\s+/g, " ")));
        }
      }
    }
    const present = sources.filter((source) => finalBlog.includes(source.url));
    expect(present.length).toBeGreaterThan(0);
    if (result) {
      expect(result.warnings.some((w: string) => w.includes("no research sources"))).toBe(false);
    }
  });

  it("warns clearly when no research sources are available", async () => {
    let result: Awaited<ReturnType<typeof runPostAssemblyPipeline>> | undefined;
    try {
      result = await runWithContext({ research: [] });
    } catch {
      // final validation may fail for unrelated editorial reasons; inspect state
    }
    expect(result).toBeDefined();
    expect(result!.warnings.some((w: string) => w.includes("no research sources available"))).toBe(true);
  });
});
