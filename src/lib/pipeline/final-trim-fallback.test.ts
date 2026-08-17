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
    throw new Error("Unexpected section regeneration in deterministic test");
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
  createPipelineState,
  parseCompactionBlocksJson,
  runPostAssemblyPipeline,
  runFinalValidation,
} from "@/lib/pipeline/blog-generation-pipeline";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { validateFaqParity, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";

function paragraphHtml(text: string): string {
  return `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
}

function quoteHtml(text: string): string {
  return `<!-- wp:quote -->\n<blockquote><p>${text}</p></blockquote>\n<!-- /wp:quote -->`;
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
    title: "Marketing Teams and Budgeting for Hong Kong",
    snippet: "Everyone is watching the marketing teams, and the budgeting picture in 2026 is clearer than before.",
    url: "https://example.com/strategy-2026",
  },
];

// The corrupted paragraph: an unfinished example — a single sentence that
// introduces a pending action ("plans to") with no resolution. It is complete
// prose (terminal punctuation present), so the malformed-prose scanner and
// the shared sentence-completeness validator do NOT flag it; only the
// coherence gate sees the unfinished-example violation. It survives the
// deterministic trim as the first block of its section.
const INCOMPLETE_QUOTE_PARAGRAPH =
  "Consider a local boutique that plans to test weekly video posts to grow its audience.";
const QUOTE_TEXT =
  "Influencer content is the fuel for engagement, storytelling, and B2C growth, and it is a top priority for Hong Kong marketers.";
const ORPHAN_PARAGRAPH =
  "Instead, stay true to your core identity while making sure it still connects with today\u2019s customers.";

function buildOverTargetDocument(): ArticleDocument {
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
      blocks.push(paragraphHtml(`${first} ${second} ${third}`));
    }
    return blocks.join("\n\n");
  };
  const keyphrase = "threads marketing hong kong";
  const headings = [
    "Threads Marketing Hong Kong for Small Local Brands",
    "Understand the People You Want to Reach",
    "Build a Simple Weekly Content Routine",
    "AI and Personalisation: Smarter Marketing",
    "Data Privacy and Trust: The New Marketing Currency",
    "Budgeting for 2026: Where to Invest",
  ];
  const sections = headings.map((heading, index) => {
    const body = makeParagraphs(index, 10);
    // Each main section must be topic-grounded (the earliest post-assembly
    // boundary now fails closed on ungrounded sections). The grounding
    // paragraph is APPENDED so the targeted paragraphs keep their original
    // stable block indices and the pre-existing coherence findings remain
    // attributable to the same block ids across stage snapshots. Years are
    // stripped so the grounding paragraph introduces no date claim.
    const topicPhrase = heading.replace(/\b20\d{2}\b/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    const grounding = paragraphHtml(`${topicPhrase} shapes how the team plans the work covered below.`);
    if (index === 3) {
      // Affected section 1: latent incomplete-sentence quotation paragraph plus
      // a complete wp:quote block. The paragraph survives the deterministic
      // trim (it contains the topic year and would be flagged by the gate).
      return section(`section-${index}`, heading, `${paragraphHtml(INCOMPLETE_QUOTE_PARAGRAPH)}\n\n${quoteHtml(QUOTE_TEXT)}\n\n${body}\n\n${grounding}`);
    }
    if (index === 5) {
      // Affected section 2: a Source: citation directly followed by an
      // "Instead," paragraph → latent orphan-transition violation.
      return section(
        `section-${index}`,
        heading,
        `${body}\n\n${paragraphHtml(`Source: <a href="${RESEARCH[0].url}" target="_blank" rel="noopener noreferrer">${RESEARCH[0].title}</a>.`)}\n\n${paragraphHtml(ORPHAN_PARAGRAPH)}\n\n${grounding}`,
      );
    }
    return section(`section-${index}`, heading, `${body}\n\n${grounding}`);
  });
  sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
  return {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content and build steady local trust.",
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
    introduction: component("intro", `${paragraphHtml(`Opening guide to ${keyphrase} gives local owners a clear place to start.`)}\n\n${makeParagraphs(0, 4)}`),
    sections,
    visibleFaq: [1, 2, 3, 4].map((index) => ({
      question: `What should a Hong Kong SME know first ${index}?`,
      answerHtml: "",
      answerText: "Start with a small and useful routine. Listen to real customer questions, reply in a natural voice, and review which conversations lead to profile visits or enquiries.",
    })),
    conclusion: component("conclusion", makeParagraphs(2, 3)),
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

/** Valid compacted candidates: section-3 keeps the quote verbatim and fixes
 *  the incomplete paragraph; section-5 rewrites the orphan "Instead"
 *  paragraph while keeping the source citation link. */
function validCandidateForHeading(heading: string): string | null {
  if (heading.includes("AI and Personalisation")) {
    return JSON.stringify({
      blocks: [
        { type: "paragraph", text: `AI makes marketing more personal and more effective for small businesses and creators. Start small, keep the routine honest, and measure the replies that come back to you.` },
        { type: "quote", text: QUOTE_TEXT },
        { type: "paragraph", text: "Teams that combine AI-driven insights with a human touch win more trust and better results. The same lesson applies across the whole strategy." },
      ],
    });
  }
  if (heading.includes("Budgeting")) {
    return JSON.stringify({
      blocks: [
        { type: "paragraph", text: "Budgeting for the year ahead means investing in the channels that work and cutting what does not earn its keep. Stay true to your core identity while making sure it still connects with today\u2019s customers, and keep the routine honest." },
        { type: "paragraph", text: `Source: <a href="${RESEARCH[0].url}" target="_blank" rel="noopener noreferrer">${RESEARCH[0].title}</a>.` },
      ],
    });
  }
  return null;
}

/** Truncated quotation candidate: the wp:quote block is cut mid-way. */
function truncatedQuoteCandidate(heading: string): string | null {
  if (heading.includes("AI and Personalisation")) {
    return JSON.stringify({
      blocks: [
        { type: "quote", text: "Influencer content is the fuel" },
        { type: "paragraph", text: "AI makes marketing more personal and effective for small businesses." },
      ],
    });
  }
  return null;
}

async function runPipeline(
  candidateForHeading: (heading: string) => string | null,
): Promise<{ result?: Awaited<ReturnType<typeof runPostAssemblyPipeline>>; compactedHeadings: string[]; thrown?: Error }> {
  const keyphrase = "threads marketing hong kong";
  const doc = buildOverTargetDocument();
  const range = englishWordTolerance(2500);
  const state = createPipelineState({
    userId: "test-user",
    projectId: "final-trim-fallback",
    keyphrase,
    requestedWordCount: 2500,
    articleDoc: doc,
    h2Headings: doc.sections.map((s) => s.heading),
    intro: "",
    conclusion: "",
    wordsPerSection: 350,
    exactKeyphraseTarget: 9,
    policy: buildPolicy(2500, range.min, range.max, keyphrase),
    ctx: { research: RESEARCH },
    wordMin: range.min,
    wordMax: range.max,
    systemPrompt: "test",
    userMessage: "test",
  });

  const compactedHeadings: string[] = [];
  let thrown: Error | undefined;
  try {
    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async (messages: unknown, _options: unknown, stage?: string) => {
        if (stage === "final-trim-compaction") {
          const prompt = (messages as Array<{ content?: string }>)[1]?.content ?? "";
          const headingMatch = /Section heading: ([^\n]+)/.exec(prompt);
          const heading = headingMatch ? headingMatch[1].trim() : "unknown";
          compactedHeadings.push(heading);
          const candidate = candidateForHeading(heading);
          if (candidate) return { content: candidate, finishReason: "stop", attemptsUsed: 0 };
          throw new Error(`No candidate for ${heading}`);
        }
        throw new Error("Unexpected AI call in deterministic fallback test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic fallback test");
      },
      telemetry: {},
      context: { research: RESEARCH },
    });
    return { result, compactedHeadings };
  } catch (error) {
    thrown = error as Error;
    return { compactedHeadings, thrown };
  }
}

describe("final-trim bounded fallback (incomplete quotation + orphan transition)", () => {
  it("distinguishes pre-existing coherence findings and compacts only affected sections", async () => {
    const { result, compactedHeadings, thrown } = await runPipeline(validCandidateForHeading);
    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    // Bounded compaction ran ONLY for the affected sections.
    expect(compactedHeadings.some((h) => h.includes("AI and Personalisation"))).toBe(true);
    expect(compactedHeadings.some((h) => h.includes("Budgeting"))).toBe(true);
    expect(compactedHeadings.every((h) => h.includes("AI and Personalisation") || h.includes("Budgeting"))).toBe(true);
    const finalTrim = result!.stageOutputs.find((stage) => stage.stage === "final-trim");
    expect(finalTrim?.metadata?.preTrimCoherenceViolations).toHaveLength(2);
    expect(finalTrim?.metadata?.postTrimCoherenceViolations).toHaveLength(2);
    expect(finalTrim?.metadata?.newTrimIntroducedViolations).toEqual([]);
    // The quotation is preserved completely (verbatim), not truncated.
    expect(result!.blog).toContain(QUOTE_TEXT);
    // The orphan "Instead" did not survive without its antecedent.
    expect(result!.blog).not.toContain("Instead, stay true to your core identity");
    // Protected content is intact.
    expect(validateWordpressBlockPairs(result!.blog).valid).toBe(true);
    expect((result!.blog.match(/faq-item/g) ?? []).length).toBe(4);
    const schemaHtml = extractFaqBlock(result!.blog);
    const parity = validateFaqParity(
      extractVisibleFaqFromArticle(result!.blog, result!.articleDoc).map((e) => ({
        question: e.question,
        answerHtml: "",
        answerText: e.answerText,
      })),
      schemaHtml,
    );
    expect(parity.valid, parity.issues.map((i) => i.type).join("; ")).toBe(true);
    // Final canonical validation passes.
    const validation = runFinalValidation(result!);
    expect(validation.passed, validation.reasons.join("; ")).toBe(true);
  });

  it("an invalid candidate (truncated quotation) still blocks with the hard failure", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const { result, compactedHeadings, thrown } = await runPipeline(truncatedQuoteCandidate);
    errorSpy.mockRestore();
    expect(result).toBeUndefined();
    // The compaction fallback was attempted for the affected sections.
    expect(compactedHeadings.some((h) => h.includes("AI and Personalisation"))).toBe(true);
    // The truncated quotation candidate was rejected (it is malformed —
    // missing terminal punctuation — and incoherent), the complete prior
    // snapshot was restored, and the coherence failure remains a hard
    // failure. The rejection never leaks a damaged candidate into the article.
    expect(thrown).toBeDefined();
    expect(String(thrown!.message)).toMatch(/Coherence violations after final trim/);
    expect(errors.join("\n")).toContain("malformed-prose");
    expect(errors.join("\n")).toContain("coherence:incomplete-sentence");
  });
});

describe("bounded compaction response classification", () => {
  it("accepts a complete JSON code fence as a bounded recoverable wrapper", () => {
    const result = parseCompactionBlocksJson(
      '```json\n{"blocks":[{"type":"paragraph","text":"Complete professional sentence."}]}\n```',
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.normalizedWrapper).toBe(true);
  });

  it("reports invalid-json separately from schema-invalid", () => {
    const invalidJson = parseCompactionBlocksJson('{"blocks": [');
    const invalidSchema = parseCompactionBlocksJson(
      '{"blocks":[{"type":"unknown","text":"Unsafe"}]}',
    );
    expect(invalidJson).toMatchObject({ accepted: false, reason: "invalid-json" });
    expect(invalidSchema).toMatchObject({ accepted: false, reason: "schema-invalid" });
  });
});
