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
import { normalizeAiEditorialPayload } from "@/lib/blog/article-content";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { validateCoherence } from "@/lib/blog/coherence";
import { analyzeSentenceCompleteness } from "@/lib/blog/sentence-completeness";
import {
  createPipelineState,
  runFinalValidation,
  runPostAssemblyPipeline,
  trimResidualSafeProseToMaximum,
} from "@/lib/pipeline/blog-generation-pipeline";
import {
  findMalformedEditableBlocks,
  repairDeterministicMalformedProse,
} from "@/lib/pipeline/editorial-polish";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import { findMalformedProseTextIssues } from "@/lib/blog/publication-quality";
import { splitLongParagraphs } from "@/lib/services/text-utils";
import { compressDocumentStructureAware } from "@/lib/blog/coherence";

// ── The exact production fragment (2026-08 production failure) ──
// "Trust isn't built overnight. It comes from being transparent about what you
// collect, why you collect it, and how you protect it. A few practical habits
// can go a" — reported as section-1-wp-8 after the early boundary reported
// unresolvedEditable=0 unresolvedDocument=0.
const PRODUCTION_PARAGRAPH =
  "Trust isn't built overnight. It comes from being transparent about what you collect, why you collect it, and how you protect it. A few practical habits can go a";
const COMPLETE_PREFIX =
  "Trust isn't built overnight. It comes from being transparent about what you collect, why you collect it, and how you protect it.";
const FRAGMENT_TEXT = "A few practical habits can go a";

function paragraph(id: string, text: string): Extract<ArticleDocument["introduction"]["blocks"][number], { type: "paragraph" }> {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(blocks: Extract<ArticleDocument["introduction"]["blocks"][number], { type: "paragraph" }>[]): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 500, focusKeyphrase: "k" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks, status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function paragraphHtml(text: string): string {
  return `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
}

const SENTENCES = [
  "Local teams can share useful lessons from daily work with clear and honest words.",
  "Simple examples help busy owners understand the idea and take a practical next step.",
  "Regular replies also show customers that a real person is listening to their needs.",
  "A small weekly plan keeps the work steady without adding stress to the whole team.",
  "Owners can note common questions and turn those questions into helpful future posts.",
  "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
];

function component(id: string, html: string): ArticleDocument["introduction"] {
  return { id, blocks: parseWordPressEditorialBlocks(html, id).blocks, status: "generated" };
}

function section(id: string, heading: string, html: string, sectionType: ArticleSection["sectionType"] = "main"): ArticleSection {
  return { ...component(id, html), heading, headingLevel: 2, sectionType };
}

function makeParagraphs(sectionIndex: number, count: number): string {
  const blocks: string[] = [];
  for (let index = 0; index < count; index++) {
    blocks.push(paragraphHtml(`${SENTENCES[(index + sectionIndex) % 6]} ${SENTENCES[(index + sectionIndex + 1) % 6]} ${SENTENCES[(index + sectionIndex + 2) % 6]}`));
  }
  return blocks.join("\n\n");
}

const KEYPHRASE = "threads marketing hong kong";
const HEADINGS = [
  "Threads Marketing Hong Kong for Small Local Brands",
  "Understand the People You Want to Reach",
  "Build a Simple Weekly Content Routine",
  "Create Posts That Start Useful Conversations",
  "Measure Results and Improve the Next Post",
  "Common Mistakes Hong Kong SMEs Should Avoid",
];

function buildPipelineDoc(options?: { fragmentParagraph?: string; affectedSectionIndex?: number }): ArticleDocument {
  const sections = HEADINGS.map((heading, index) => {
    const body = makeParagraphs(index, 8);
    if (options?.affectedSectionIndex === index) {
      const parts: string[] = [];
      if (options.fragmentParagraph) parts.push(paragraphHtml(options.fragmentParagraph));
      parts.push(body);
      return section(`section-${index}`, heading, parts.join("\n\n"));
    }
    return section(`section-${index}`, heading, body);
  });
  sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
  return {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content and build steady local trust.",
      excerpt: "A practical guide for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-practical-sme-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: "language-switcher",
    },
    introduction: component("intro", paragraphHtml(`Opening guide to ${KEYPHRASE} gives local owners a clear place to start.`)),
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

function runPipeline(doc: ArticleDocument, chatForCompaction: (messages: unknown[]) => { content: string }): Promise<{ result?: Awaited<ReturnType<typeof runPostAssemblyPipeline>>; thrown?: Error }> {
  const range = englishWordTolerance(2500);
  const state = createPipelineState({
    userId: "test-user",
    projectId: "trailing-fragment-regression",
    keyphrase: KEYPHRASE,
    requestedWordCount: 2500,
    articleDoc: doc,
    h2Headings: doc.sections.map((s) => s.heading),
    intro: "",
    conclusion: "",
    wordsPerSection: 350,
    exactKeyphraseTarget: 9,
    policy: buildPolicy(2500, range.min, range.max, KEYPHRASE),
    ctx: { research: [] },
    wordMin: range.min,
    wordMax: range.max,
    systemPrompt: "test",
    userMessage: "test",
  });
  return runPostAssemblyPipeline(state, {
    chatWithRetry: async (messages: unknown, _options: unknown, stage?: string) => {
      if (stage === "final-trim-compaction") {
        return { content: chatForCompaction(messages as Array<{ content?: string }>).content, finishReason: "stop", attemptsUsed: 0 };
      }
      throw new Error("Unexpected AI call in deterministic trailing-fragment test");
    },
    makeTrackedChatForStage: () => async () => {
      throw new Error("Unexpected tracked AI call in deterministic trailing-fragment test");
    },
    telemetry: {},
    context: { research: [] },
  }).then(
    (result) => ({ result }),
    (thrown: Error) => ({ thrown }),
  );
}

describe("trailing-fragment regression: the exact production paragraph", () => {
  it("is rejected at AI block acceptance (model-output normalization)", () => {
    const result = normalizeAiEditorialPayload({ blocks: [{ type: "paragraph", text: PRODUCTION_PARAGRAPH }] }, "section-1");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).toMatch(/incomplete|terminal|fragment/i);
  });

  it("is detected by BOTH the malformed scanner and the coherence validator", () => {
    const doc = makeDoc([paragraph("p0", PRODUCTION_PARAGRAPH)]);
    const malformed = scanMalformedProseInDocument(doc);
    expect(malformed.length).toBeGreaterThan(0);
    expect(malformed[0].issues.some((issue) => issue.code === "missing-terminal-punctuation")).toBe(true);
    const coherence = validateCoherence(doc);
    expect(coherence.some((violation) => violation.type === "incomplete-sentence")).toBe(true);
  });

  it("reports the exact trailing fragment boundaries", () => {
    const analysis = analyzeSentenceCompleteness(PRODUCTION_PARAGRAPH, "paragraph");
    expect(analysis.complete).toBe(false);
    expect(analysis.trailingFragment?.text).toBe(FRAGMENT_TEXT);
  });

  it("is repaired deterministically: only the fragment is removed", () => {
    const doc = makeDoc([paragraph("p0", PRODUCTION_PARAGRAPH)]);
    const result = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    expect(result.repairedBlockIds.length).toBeGreaterThan(0);
    const block = doc.introduction.blocks[0] as Extract<ArticleDocument["introduction"]["blocks"][number], { type: "paragraph" }>;
    expect(block.content.map((node) => node.text).join("")).toBe(COMPLETE_PREFIX);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(validateCoherence(doc)).toEqual([]);
  });

  it("leaves the preceding complete sentences byte-for-byte unchanged", () => {
    const doc = makeDoc([paragraph("p0", PRODUCTION_PARAGRAPH)]);
    repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    const block = doc.introduction.blocks[0] as Extract<ArticleDocument["introduction"]["blocks"][number], { type: "paragraph" }>;
    expect(block.content.map((node) => node.text).join("")).toBe(COMPLETE_PREFIX);
    expect(block.content.map((node) => node.text).join("")).not.toContain(FRAGMENT_TEXT);
  });

  it("repair is idempotent", () => {
    const doc = makeDoc([paragraph("p0", PRODUCTION_PARAGRAPH)]);
    const first = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    expect(first.repairedBlockIds.length).toBeGreaterThan(0);
    const before = JSON.stringify(doc);
    const second = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    expect(second.repairedBlockIds.length).toBe(0);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("block-type-aware completeness: no false positives on structural surfaces", () => {
  it("accepts a colon-led paragraph followed immediately by its non-empty list", () => {
    const doc = makeDoc([]);
    doc.sections = [{
      id: "section-0",
      heading: "Privacy Safeguards",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Use these safeguards:" }] },
        { id: "s0-1", type: "list", ordered: false, items: [[{ type: "text", text: "Collect only necessary data" }], [{ type: "text", text: "Document consent" }]] },
      ],
      status: "generated",
    }];

    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(findMalformedEditableBlocks(doc)).toEqual([]);
    expect(validateCoherence(doc).some((issue) => issue.type === "incomplete-sentence")).toBe(false);
  });

  it("rejects the same colon-led paragraph if its structured continuation is removed", () => {
    const doc = makeDoc([]);
    doc.sections = [{
      id: "section-0",
      heading: "Privacy Safeguards",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Use these safeguards:" }] },
      ],
      status: "generated",
    }];

    expect(scanMalformedProseInDocument(doc).length).toBeGreaterThan(0);
    expect(findMalformedEditableBlocks(doc).length).toBeGreaterThan(0);
    expect(validateCoherence(doc).some((issue) => issue.type === "incomplete-sentence")).toBe(true);
  });

  it("headings, list items and table cells without punctuation are valid", () => {
    const doc = makeDoc([]);
    doc.metadata.title = "Threads Marketing Hong Kong 2026";
    doc.metadata.metaDescription = "A practical guide for Hong Kong small businesses";
    doc.sections = [{
      id: "section-0",
      heading: "Common Mistakes Hong Kong SMEs Should Avoid",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Posting without a plan wastes time, and ignoring comments misses the conversations that build trust with local customers. A steady weekly routine keeps the work manageable and gives the whole team a clear voice in Hong Kong." }] },
        { id: "s0-1", type: "list", ordered: false, items: [[{ type: "text", text: "Posting without a plan" }], [{ type: "text", text: "Ignoring comments" }]] },
        { id: "s0-2", type: "table", headers: [[{ type: "text", text: "Channel" }], [{ type: "text", text: "Best use" }]], rows: [[[{ type: "text", text: "Threads" }], [{ type: "text", text: "Conversations" }]]] },
        { id: "s0-3", type: "subheading", level: 3, content: [{ type: "text", text: "Start Small" }] },
      ],
      status: "generated",
    }];
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(validateCoherence(doc)).toEqual([]);
  });

  it("unmistakable fragments in structural blocks are still rejected", () => {
    const doc = makeDoc([]);
    doc.sections = [{
      id: "section-0",
      heading: "How to connect with",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        { id: "s0-1", type: "list", ordered: false, items: [[{ type: "text", text: "go a" }]] },
        { id: "s0-2", type: "table", headers: [[{ type: "text", text: "Built to" }]], rows: [[[{ type: "text", text: "works because" }]]] },
      ],
      status: "generated",
    }];
    const malformed = scanMalformedProseInDocument(doc);
    expect(malformed.length).toBeGreaterThan(0);
    const codes = malformed.flatMap((finding) => finding.issues.map((issue) => issue.code));
    expect(codes).toContain("trailing-fragment");
  });

  it("preserves valid abbreviations, measurements, quotations, apostrophes and stranded prepositions", () => {
    const valid = [
      "Dr. Smith and Mr. Lee run the store, which opens at 9 a.m. and closes at 6 p.m.",
      "The laptop has a 13-inch screen and an M3 chip.",
      "He said, \"the numbers are in,\" and shared the full report.",
      "Customers' feedback shapes every decision we make.",
      "What are you waiting for?",
      "This is exactly what we plan for.",
      "The store sold 24 units in 2026.",
      "Source: B2I Hub Research",
    ];
    const doc = makeDoc(valid.map((text, index) => paragraph(`p${index}`, text)));
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
  });
});

describe("deterministic mutations cannot create incomplete prose", () => {
  it("factual removal never leaves a trailing fragment (the dangling 'to.' residue case)", () => {
    const claim = (text: string, sentenceText?: string): ScannedClaim =>
      ({ text, htmlPosition: 0, category: "platform_metric", supported: false, sectionIndex: 0, ...(sentenceText ? { sentenceText } : {}) });
    const html = `<!-- wp:paragraph --><p>Brands allocate budget to. 78% of them plan to increase spend.</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("78% of them plan to increase spend", "78% of them plan to increase spend.")]);
    if (out.html.trim()) {
      const doc = makeDoc(parseWordPressEditorialBlocks(out.html, "intro").blocks as Extract<ArticleDocument["introduction"]["blocks"][number], { type: "paragraph" }>[]);
      const malformed = scanMalformedProseInDocument(doc);
      expect(malformed.flatMap((f) => f.issues.map((issue) => issue.code))).not.toContain("missing-terminal-punctuation");
    }
  });

  it("paragraph normalization splits only at complete sentence boundaries", () => {
    const html = `<!-- wp:paragraph --><p>${SENTENCES[0]} ${SENTENCES[1]} ${SENTENCES[2]} ${SENTENCES[3]}</p><!-- /wp:paragraph -->`;
    const out = splitLongParagraphs(html, 3);
    const doc = makeDoc(parseWordPressEditorialBlocks(out.html, "intro").blocks as Extract<ArticleDocument["introduction"]["blocks"][number], { type: "paragraph" }>[]);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
  });

  it("SEO readability rewrites ending in a trailing fragment are rejected by the shared scanner", () => {
    // The final-seo-normalizer's readability/keyphrase rewrite acceptance uses
    // findMalformedProseTextIssues; a rewritten paragraph that ends mid-phrase
    // ("...and measure the replies that come back to you and") must be
    // rejected exactly like the production fragment.
    const rewritten = "A simpler sentence. Another clear point about the strategy and";
    const issues = findMalformedProseTextIssues([rewritten]);
    expect(issues.some((issue) => issue.code === "missing-terminal-punctuation")).toBe(true);
  });

  it("structure-aware compression and residual trim keep every paragraph complete", () => {
    const doc = buildPipelineDoc();
    const range = englishWordTolerance(2500);
    compressDocumentStructureAware(doc, range.max, range.min, KEYPHRASE, []);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    trimResidualSafeProseToMaximum(doc, range.max, range.min, KEYPHRASE, []);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(validateCoherence(doc)).toEqual([]);
  });
});

describe("the fragment is caught BEFORE link injection", () => {
  it("the production fragment is resolved at the early repair boundary and never reaches links", async () => {
    const doc = buildPipelineDoc({ fragmentParagraph: PRODUCTION_PARAGRAPH, affectedSectionIndex: 0 });
    const { result, thrown } = await runPipeline(doc, () => ({ content: JSON.stringify({ blocks: [{ type: "paragraph", text: SENTENCES[0] }] }) }));
    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    const blog = result!.blog;
    expect(blog).not.toContain(FRAGMENT_TEXT);
    // The rendered HTML escapes the apostrophe ("isn&apos;t"), so assert on an
    // unescaped prefix and the readable text.
    expect(blog).toContain("Trust isn");
    expect(blog.replace(/&apos;|&#39;/g, "'")).toContain("Trust isn't built overnight.");
    // The repair boundary ran before the link stage.
    const stages = result!.stageOutputs.map((output) => output.stage);
    const repairIndex = stages.indexOf("malformed-prose-repair");
    const linksIndex = stages.indexOf("internal-links");
    expect(repairIndex).toBeGreaterThanOrEqual(0);
    expect(linksIndex).toBeGreaterThan(repairIndex);
    const validation = runFinalValidation(result!);
    expect(validation.passed, validation.reasons.join("; ")).toBe(true);
  });

  it("an unrepairable incomplete paragraph fails closed AT the repair boundary (zero writes, before links)", async () => {
    const linkHtml = `See the <a href="https://example.com/strategy">strategy guide</a> for details and you will a`;
    const doc = buildPipelineDoc({ fragmentParagraph: linkHtml, affectedSectionIndex: 0 });
    const { result, thrown } = await runPipeline(doc, () => ({ content: JSON.stringify({ blocks: [{ type: "paragraph", text: SENTENCES[0] }] }) }));
    expect(result).toBeUndefined();
    expect(thrown).toBeDefined();
    expect(String(thrown!.message)).toMatch(/Unresolved malformed prose at repair boundary/);
  });
});

describe("a link-losing compaction is still rejected and rolled back", () => {
  it("rejects a compaction candidate that drops the section's source link (link-equivalence stays strict)", async () => {
    // Over-target document (10 paragraphs per section) so final trim needs the
    // bounded compaction fallback. Affected sections:
    //   - section-3 (AI and Personalisation): unfinished-example violation,
    //   - section-5 (Budgeting for 2026): orphan "Instead" transition AFTER a
    //     topic-relevant Source: citation that carries the section's link.
    // The valid candidate fixes section-3; the section-5 candidate drops the
    // link, which must be rejected by the strict link-equivalence gate.
    const unfinishedExample =
      "Consider a local boutique that plans to test weekly video posts to grow its audience.";
    const orphan =
      "Instead, stay true to your core identity while making sure it still connects with today's customers.";
    const research = [
      { title: "Marketing Teams and Budgeting for Hong Kong", snippet: "The budgeting picture in 2026 is clearer than before.", url: "https://example.com/strategy-2026" },
    ];
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
      if (index === 3) {
        return section(`section-${index}`, heading, `${paragraphHtml(unfinishedExample)}\n\n${body}`);
      }
      if (index === 5) {
        return section(
          `section-${index}`,
          heading,
          `${body}\n\n${paragraphHtml(`Source: <a href="https://example.com/strategy-2026" target="_blank" rel="noopener noreferrer">Marketing Teams and Budgeting for Hong Kong</a>.`)}\n\n${paragraphHtml(orphan)}`,
        );
      }
      return section(`section-${index}`, heading, body);
    });
    sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
    const doc: ArticleDocument = {
      metadata: {
        title: "Threads Marketing Hong Kong: A Practical SME Guide",
        slug: "threads-marketing-hong-kong-practical-sme-guide",
        metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content and build steady local trust.",
        excerpt: "A practical guide for Hong Kong SMEs.",
        targetWordCount: 2500,
        focusKeyphrase: KEYPHRASE,
      },
      languageSwitcher: {
        id: "language-switcher",
        type: "language-switcher",
        html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-practical-sme-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
        fingerprint: "language-switcher",
      },
      introduction: component("intro", paragraphHtml(`Opening guide to ${KEYPHRASE} gives local owners a clear place to start.`)),
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

    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "link-losing-compaction",
      keyphrase: KEYPHRASE,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, KEYPHRASE),
      ctx: { research },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });
    const { result, thrown } = await runPostAssemblyPipeline(state, {
      chatWithRetry: async (messages: unknown, _options: unknown, stage?: string) => {
        if (stage === "final-trim-compaction") {
          const prompt = (messages as Array<{ content?: string }>)[1]?.content ?? "";
          const headingMatch = /Section heading: ([^\n]+)/.exec(prompt);
          const heading = headingMatch ? headingMatch[1].trim() : "unknown";
          if (heading.includes("AI and Personalisation")) {
            // Topic-relevant, coherent candidate for the unfinished-example
            // section: it mentions the budget/strategy research so the
            // source-relevance check passes and the compaction is accepted.
            return { content: JSON.stringify({ blocks: [{ type: "paragraph", text: "AI tools help marketing teams plan their strategy and budget for the year ahead. Start small, keep the routine honest, and measure the replies that come back to you. Simple examples help busy owners understand the idea and take a practical next step in their daily work." }] }), finishReason: "stop", attemptsUsed: 0 };
          }
          if (heading.includes("Budgeting")) {
            // Link-losing candidate: the Source: citation (and its anchor) is
            // dropped entirely.
            return { content: JSON.stringify({ blocks: [{ type: "paragraph", text: "Budgeting for the year ahead means investing in the channels that work and cutting what does not earn its keep. Stay true to your core identity and keep the routine honest." }] }), finishReason: "stop", attemptsUsed: 0 };
          }
          throw new Error(`No candidate for ${heading}`);
        }
        throw new Error("Unexpected AI call in link-losing compaction test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in link-losing compaction test");
      },
      telemetry: {},
      context: { research },
    }).then(
      (r) => ({ result: r, thrown: undefined as Error | undefined }),
      (err: Error) => ({ result: undefined, thrown: err }),
    );
    errorSpy.mockRestore();

    // The link-losing candidate was rejected with the strict link-equivalence
    // gate and the compaction was rolled back: the hard failure still blocks
    // saving (no damaged article can be produced).
    expect(result).toBeUndefined();
    expect(thrown).toBeDefined();
    expect(String(thrown!.message)).toMatch(/Coherence violations after final trim|word-count range/);
    expect(errors.join("\n")).toContain("link-equivalence");
    expect(errors.join("\n")).toContain("rejected section=section-5");
  });
});
