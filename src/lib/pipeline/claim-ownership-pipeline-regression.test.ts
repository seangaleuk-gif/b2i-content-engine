import { describe, expect, it, vi } from "vitest";

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
    throw new Error("Unexpected section regeneration in deterministic pipeline test");
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
  renderComponentHtml,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
} from "@/lib/blog/article-document";
import {
  assertRenderedCacheMatchesDocument,
  createPipelineState,
  runFinalValidation,
  runPostAssemblyPipeline,
} from "@/lib/pipeline/blog-generation-pipeline";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";
import { buildClaimOwnershipLedger, validateClaimOwnership } from "@/lib/blog/claim-ownership";
import { countExactPhrase, extractReadableText } from "@/lib/seo/seo-text-utils";

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

const RESEARCH = [
  {
    title: "Hong Kong Threads audience",
    snippet: "Threads has 2.4 million monthly active users in Hong Kong.",
    url: "https://example.com/audience",
  },
];

function buildDocumentWithOwnershipWork(): { doc: ArticleDocument; introHtml: string; conclusionHtml: string } {
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
  // The introduction repeats the owner-section evidence (an out-of-owner claim)
  // and the FAQ repeats it too (a synthesis-only violation).
  const introHtml = [
    paragraph(`Opening guide to ${keyphrase} gives local owners a clear place to start. Threads has 2.4 million monthly active users in Hong Kong. ${sentences[0]} ${sentences[1]}`),
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
  // The owner section carries the canonical occurrence.
  const ownerBlock: EditorialBlock = {
    id: "owner-claim",
    type: "paragraph",
    content: [
      { type: "text", text: "According to the audience study, Threads has 2.4 million monthly active users in Hong Kong (" },
      { type: "link", text: "source", href: RESEARCH[0].url, sourceType: "editorial-external" },
      { type: "text", text: ")." },
    ],
  };
  sections[0].blocks.unshift(ownerBlock);
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
    visibleFaq: [
      {
        question: "How many users does Threads have in Hong Kong?",
        answerHtml: "",
        answerText: "Threads has 2.4 million monthly active users in Hong Kong as of the latest figures.",
      },
      ...[1, 2, 3].map((index) => ({
        question: `What should a Hong Kong SME know first ${index}?`,
        answerHtml: "",
        answerText: "Start with a small and useful routine. Listen to real customer questions, reply in a natural voice, and review which conversations lead to profile visits or enquiries.",
      })),
    ],
    conclusion: component("conclusion", conclusionHtml),
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  return { doc, introHtml, conclusionHtml };
}

describe("claim-ownership pipeline stage agrees with the final gate", () => {
  it("enforces, verifies from the rendered canonical state, and reaches zero violations at the final gate", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc } = buildDocumentWithOwnershipWork();
    const range = englishWordTolerance(2500);
    const ownershipSections = doc.sections
      .filter((s) => s.sectionType !== "faq-heading")
      .map((s) => ({ id: s.id, heading: s.heading, sectionType: s.sectionType }));
    const claimOwnership = buildClaimOwnershipLedger(ownershipSections, RESEARCH);

    // Sanity: the input carries out-of-owner + FAQ violations.
    expect(validateClaimOwnership(doc, claimOwnership, keyphrase, RESEARCH).length).toBeGreaterThan(0);

    const state = createPipelineState({
      userId: "test-user",
      projectId: "ownership-e2e",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, keyphrase),
      ctx: { research: RESEARCH, claimOwnership },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });

    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => {
        throw new Error("Unexpected AI call in deterministic ownership pipeline test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic ownership pipeline test");
      },
      telemetry: {},
      context: { research: RESEARCH, claimOwnership },
    });

    assertRenderedCacheMatchesDocument(result);
    // The enforcement stage ran and mutated the document.
    const ownershipStage = result.stageOutputs.find((output) => output.stage === "claim-ownership");
    expect(ownershipStage).toBeTruthy();
    expect(ownershipStage!.inputFingerprint).not.toBe(ownershipStage!.outputFingerprint);

    // The enforcement stage and the final gate agree: zero violations from the
    // same canonical document.
    expect(validateClaimOwnership(result.articleDoc, claimOwnership, keyphrase, RESEARCH)).toEqual([]);
    const finalValidation = runFinalValidation(result);
    expect(finalValidation.passed, finalValidation.reasons.join("; ")).toBe(true);

    // The out-of-owner claim was removed from the introduction, the FAQ answer
    // was corrected, and the canonical owner occurrence is preserved.
    const finalHtml = result.blog;
    const readable = extractReadableText(finalHtml);
    expect(countExactPhrase(readable, "2.4 million monthly active users in Hong Kong")).toBe(1);
    expect(result.articleDoc.visibleFaq.some((entry) => entry.answerText.includes("2.4 million"))).toBe(false);
    expect(renderComponentHtml(result.articleDoc.sections[0]).includes("2.4 million monthly active users in Hong Kong")).toBe(true);
  });
});
