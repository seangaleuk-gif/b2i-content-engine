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
  countCanonicalVisibleWords,
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
import { canonicalKeyphraseMetrics } from "@/lib/blog/final-seo-reconcile";
import { analyzeFinalArticle, buildPolicy } from "@/lib/blog/final-article-policy";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { englishWordTolerance } from "@/lib/content-standards";
import { extractH2Texts } from "@/lib/seo/seo-text-utils";
import { runAudit } from "@/lib/services/seo-auditor";

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
      finalReadableWordCount(result),
    );
    const finalTrim = result.stageOutputs.find((output) => output.stage === "final-trim");
    const finalReconcile = result.stageOutputs.find((output) => output.stage === "final-seo-reconcile");

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
    // The deterministic post-final-trim reconciliation stage must run and be
    // accepted, and the canonical density at the final gate must never cross
    // the hard 3% limit.
    expect(finalReconcile).toBeDefined();
    expect(finalReconcile!.accepted).toBe(true);
    expect(canonicalKeyphraseMetrics(result.articleDoc, keyphrase).density).toBeLessThanOrEqual(3);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
  });

  it("the punctuation-only fragment cannot recur through the exact stage sequence (malformed-prose-repair → links → post-ownership → CTA → final-trim → final-seo-reconcile → faq-recovery → final-preflight)", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    // section-3-wp-2: inject the production-shaped punctuation-only residue —
    // a "." residue sentence inside a plain paragraph that loses the removal
    // competition AND inside a linked paragraph whose link must survive.
    const section3 = doc.sections[3];
    section3.blocks[2] = {
      id: "section-3-wp-2",
      type: "paragraph",
      content: [{ type: "text", text: "Local teams share useful lessons every week. . Plan a small weekly routine that keeps the work steady and the team consistent." }],
    };
    section3.blocks[3] = {
      id: "section-3-wp-3",
      type: "paragraph",
      content: [
        { type: "text", text: ". Consistency matters more than a single perfect post. Read the " },
        { type: "link", text: "full guide", href: "/blog/threads-hk-guide", sourceType: "internal" },
        { type: "text", text: " before you start." },
      ],
    };

    const state = createPipelineState({
      userId: "test-user",
      projectId: "fragment-stage-sequence",
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
      chatWithRetry: async () => { throw new Error("Unexpected AI call"); },
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [] },
    });

    assertRenderedCacheMatchesDocument(result);
    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);
    // The mid-pipeline repair and the final-trim producer both clean residue;
    // final-preflight and final validation must agree the document is clean.
    expect(scanMalformedProseInDocument(result.articleDoc)).toEqual([]);
    expect(scanSentenceQualityInDocument(result.articleDoc)).toEqual([]);
    // The protected internal link injected before final-trim survives.
    expect(result.blog).toContain("/blog/threads-hk-guide");
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
  });

  it("FAQ answers with quotes and ampersands survive the factual/ownership cleanup with canonical/rendered/schema parity intact", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    // Production-shaped FAQ answer: contains a double quote and an ampersand,
    // plus a precise claim that factual/ownership cleanup will target.
    doc.visibleFaq[1] = {
      question: doc.visibleFaq[1].question,
      answerHtml: "",
      answerText: 'Start with a "small" routine & keep the plan weekly. About 35% of teams do this weekly.',
    };
    doc.faqSchema = null;

    const state = createPipelineState({
      userId: "test-user",
      projectId: "faq-parity-e2e",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((item) => item.heading),
      intro: introHtml,
      conclusion: conclusionHtml,
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, keyphrase),
      ctx: { research: [{ title: "Team Routines", snippet: "About 35% of teams do this weekly.", url: "https://example.com/routines" }] },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });

    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => { throw new Error("Unexpected AI call"); },
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [{ title: "Team Routines", snippet: "About 35% of teams do this weekly.", url: "https://example.com/routines" }] },
    });

    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);
    // The quote and ampersand survive every FAQ-touching stage.
    expect(result.articleDoc.visibleFaq[1].answerText).toContain('"small"');
    expect(result.articleDoc.visibleFaq[1].answerText).toContain("&");
    // The precise claim was removed from the synthesis-only FAQ.
    expect(result.articleDoc.visibleFaq[1].answerText).not.toContain("35%");
    // The final-preflight parity gate ran and passed.
    const preflight = result.stageOutputs.find((output) => output.stage === "final-preflight");
    expect(preflight).toBeDefined();
    expect(preflight!.accepted).toBe(true);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
  });

  it("factual removal of a keyphrase-bearing sentence commits at its owner and is restored by post-ownership reconciliation", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    // Production shape: an unsupported precise claim whose sentence ALSO
    // contains the focus keyphrase. factual-scan removes the sentence, which
    // drops the keyphrase occurrence count as a DERIVED side effect — this
    // must commit at the factual-scan boundary and be restored downstream by
    // post-ownership-seo-reconcile, never rejected as a direct SEO mutation.
    doc.sections[0].blocks[0] = {
      id: "section-0-wp-0",
      type: "paragraph",
      content: [
        { type: "text", text: "Local teams share useful lessons every week. " },
        { type: "text", text: "About 35% of teams doing threads marketing hong kong report better engagement." },
      ],
    };

    const state = createPipelineState({
      userId: "test-user",
      projectId: "kp-drift-e2e",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((item) => item.heading),
      intro: introHtml,
      conclusion: conclusionHtml,
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, keyphrase),
      ctx: { research: [{ title: "Team Routines", snippet: "Teams report steady engagement over time.", url: "https://example.com/routines" }] },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });

    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => { throw new Error("Unexpected AI call"); },
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [{ title: "Team Routines", snippet: "Teams report steady engagement over time.", url: "https://example.com/routines" }] },
    });

    assertRenderedCacheMatchesDocument(result);
    // The derived keyphrase drift was accepted at factual-scan (not rejected
    // as direct SEO mutation), and the ownership stage completed.
    const factualStage = result.stageOutputs.find((output) => output.stage === "factual-scan");
    expect(factualStage).toBeDefined();
    expect(factualStage!.accepted).toBe(true);
    const ownershipStage = result.stageOutputs.find((output) => output.stage === "claim-ownership");
    expect(ownershipStage).toBeDefined();
    expect(ownershipStage!.accepted).toBe(true);
    // post-ownership-seo-reconcile ran and was accepted — it owns the SEO
    // restoration the removal stage deferred to it.
    const reconcile = result.stageOutputs.find((output) => output.stage === "post-ownership-seo-reconcile");
    expect(reconcile).toBeDefined();
    expect(reconcile!.accepted).toBe(true);
    // The unsupported claim was removed.
    expect(scanFactualRisks(result.blog, keyphrase, [{ title: "Team Routines", snippet: "Teams report steady engagement over time.", url: "https://example.com/routines" }]).claims
      .some((claim) => claim.text.includes("35%"))).toBe(false);
    // Final validation unchanged and fail-closed: still passes on valid
    // content, still rejects stuffing (checked in the unit regression).
    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
  });

  it("factual removal cannot silently unground a grounded section through the full pipeline", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const range = englishWordTolerance(2500);
    // Production shape: section-0's ONLY heading-word carrier is an unsupported
    // claim sentence ("threads marketing" inside the claim). All other body
    // sentences use generic words only. The factual producer must preserve the
    // essential grounding carrier so the section never becomes ungrounded at
    // final QC — and the stage-aware contract must reject any stage that would
    // have turned it ungrounded.
    doc.sections[0].blocks[0] = {
      id: "section-0-wp-0",
      type: "paragraph",
      content: [
        { type: "text", text: "Local teams share useful lessons from daily work with clear and honest words. " },
        { type: "text", text: "About 35% of teams doing threads marketing hong kong report better engagement." },
      ],
    };
    for (let index = 1; index < doc.sections[0].blocks.length; index++) {
      doc.sections[0].blocks[index] = {
        id: `section-0-wp-${index}`,
        type: "paragraph",
        content: [{ type: "text", text: "Local teams share useful lessons from daily work with clear and honest words. Simple examples help busy owners understand the idea and take a practical next step." }],
      };
    }
    // Give section-0 a NON-claim grounding paragraph: the claim ("…threads
    // marketing…") may be removed, but this sentence keeps the section
    // grounded with the heading's content word.
    doc.sections[0].blocks[1] = {
      id: "section-0-wp-1",
      type: "paragraph",
      content: [{ type: "text", text: "Threads marketing for small local brands starts with a clear weekly routine." }],
    };

    const state = createPipelineState({
      userId: "test-user",
      projectId: "grounding-e2e",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((item) => item.heading),
      intro: introHtml,
      conclusion: conclusionHtml,
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, keyphrase),
      ctx: { research: [{ title: "Team Routines", snippet: "Teams report steady engagement over time.", url: "https://example.com/routines" }] },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });

    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => { throw new Error("Unexpected AI call"); },
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [{ title: "Team Routines", snippet: "Teams report steady engagement over time.", url: "https://example.com/routines" }] },
    });

    assertRenderedCacheMatchesDocument(result);
    // Every stage accepted — no mutating stage turned section-0 ungrounded.
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
    const factualStage = result.stageOutputs.find((output) => output.stage === "factual-scan");
    expect(factualStage).toBeDefined();
    expect(factualStage!.accepted).toBe(true);
    const qc = result.stageOutputs.find((output) => output.stage === "final-qc-scan");
    expect(qc).toBeDefined();
    expect(qc!.accepted).toBe(true);
    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);
    // section-0 stays grounded: its body still shares a content word with its
    // own H2 ("Threads Marketing Hong Kong for Small Local Brands").
    expect(result.articleDoc.sections[0].blocks.some((b) =>
      b.type === "paragraph"
      && /threads|marketing|brands|local/.test(b.content.map((n) => n.text).join("").toLowerCase())
    )).toBe(true);
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
    const logSpy = vi.spyOn(console, "log");
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
    const injectionLog = logSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .find((line) => line.includes("[external-links:inject]"));
    logSpy.mockRestore();
    expect(injectionLog).toMatch(/externalBefore=0 externalAfter=[1-9]\d*/);
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

describe("authoritative editorial-H2 keyphrase enforcement at the save boundary", () => {
  async function runWithHeading0(heading: string) {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    doc.sections[0].heading = heading;
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "h2-enforce-test",
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
    return runPostAssemblyPipeline(state, {
      chatWithRetry: async () => {
        throw new Error("Unexpected AI call in deterministic end-to-end test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic end-to-end test");
      },
      telemetry: {},
      context: { research: [] },
    });
  }

  it("guarantees the exact keyphrase in a normal editorial H2 before save", async () => {
    const keyphrase = "threads marketing hong kong";
    // Heading 0 no longer carries the keyphrase, and the FAQ heading does not
    // contain it either — the article would otherwise save with h2:false.
    const result = await runWithHeading0("A Practical Guide for Local Business Owners");

    assertRenderedCacheMatchesDocument(result);
    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);

    const faqHeadingBefore = "Frequently Asked Questions About Threads Marketing";
    const finalDocHeadings = result.articleDoc.sections
      .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
      .map((s) => s.heading);
    expect(finalDocHeadings.some((h) => h.toLowerCase().includes(keyphrase))).toBe(true);
    expect(
      result.articleDoc.sections.find((s) => s.sectionType === "faq-heading")!.heading,
    ).toBe(faqHeadingBefore);

    // Final validation metrics see the qualifying editorial H2.
    const metrics = analyzeFinalArticle(
      result.blog,
      keyphrase,
      result.title,
      result.metaDescription,
      2500,
      countCanonicalVisibleWords(result.articleDoc),
    );
    expect(metrics.exactKeyphraseInH2).toBe(true);

    // CTA and FAQ schema are preserved.
    expect((result.blog.match(/app\.b2ihub\.com\/signup/gi) ?? []).length).toBe(1);
    expect((result.blog.match(/"@type": "FAQPage"/g) ?? []).length).toBe(1);
    // Word count stays in the accepted range after the heading repair.
    const finalWc = countCanonicalVisibleWords(result.articleDoc);
    const range = englishWordTolerance(2500);
    expect(finalWc).toBeGreaterThanOrEqual(range.min);
    expect(finalWc).toBeLessThanOrEqual(range.max);
  });

  it("runs the mutating enforcement before final QC and a non-mutating assertion at the save boundary", async () => {
    const result = await runWithHeading0("A Practical Guide for Local Business Owners");
    const stages = result.stageOutputs.map((output) => output.stage);
    const enforceIndex = stages.indexOf("editorial-h2-enforce");
    const qcIndex = stages.indexOf("final-qc-scan");
    const saveAssertIndex = stages.indexOf("editorial-h2-save-assert");
    const validationIndex = stages.indexOf("final-validation");
    expect(enforceIndex).toBeGreaterThanOrEqual(0);
    // The mutating enforcement runs before the mutation-free final QC, so the
    // backstop measures the enforced document.
    expect(enforceIndex).toBeLessThan(qcIndex);
    // The non-mutating assertion runs immediately before final validation and
    // is the last content stage.
    expect(saveAssertIndex).toBeGreaterThan(qcIndex);
    expect(validationIndex).toBe(saveAssertIndex + 1);
    expect(stages.slice(saveAssertIndex + 1)).toEqual(["final-validation"]);
    // Both stages are accepted, and the save-boundary assertion is non-mutating.
    expect(result.stageOutputs[enforceIndex].accepted).toBe(true);
    const saveAssert = result.stageOutputs[saveAssertIndex];
    expect(saveAssert.accepted).toBe(true);
    expect(saveAssert.inputFingerprint).toBe(saveAssert.outputFingerprint);
  });

  it("leaves a compliant article unchanged", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const headingBefore = doc.sections[0].heading;
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "h2-enforce-compliant",
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
    expect(runFinalValidation(result).passed).toBe(true);
    // The compliant heading survives all stages byte-for-byte.
    expect(result.articleDoc.sections[0].heading).toBe(headingBefore);
    const finalHeadings = extractH2Texts(result.blog).map((h) => h.toLowerCase());
    expect(finalHeadings.some((h) => h.includes(keyphrase))).toBe(true);
    expect(result.stageOutputs.find((o) => o.stage === "editorial-h2-enforce")!.accepted).toBe(true);
  });
});

describe("production em-dash continuation end-to-end", () => {
  it("repairs the exact production sentence before final QC so the article saves", async () => {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    // Inject the exact production defect into section-5's last paragraph:
    // "Start with a clear budget. — that's the spirit of Hong Kong marketing:
    // flexible, adaptive, and ready to try new things."
    const section5 = doc.sections[5];
    const lastBlock = section5.blocks[section5.blocks.length - 1];
    if (lastBlock.type !== "paragraph") throw new Error("expected paragraph block");
    lastBlock.content = [{
      type: "text",
      text: `${lastBlock.content.map((node) => node.text).join("")} Start with a clear budget. — that's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things.`,
    }];
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "em-dash-e2e",
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
    expect(runFinalValidation(result).passed).toBe(true);
    // The deterministic repair capitalized the continuation; the article now
    // contains the grammatical "— That's the spirit ..." form (the apostrophe
    // is entity-escaped in rendered HTML).
    expect(result.blog).toContain("— That&#39;s the spirit of Hong Kong marketing");
    expect(result.blog).not.toContain("— that's the spirit of Hong Kong marketing");
  });
});

describe("editorial-H2 keyphrase is a soft SEO requirement", () => {
  // Natural, section-grounding-compatible, but too long for the keyphrase to be
  // appended naturally (>90 chars) — so no safe natural repair exists. This is
  // the production-shaped satisfied=false case.
  const UNREPAIRABLE_HEADING = "A practical guide for local business owners who want to grow and connect with customers";
  async function runWithSection0Heading(heading: string, opts?: { keyphraseOnlyInFaq?: boolean; allEditorialUnrepairable?: boolean }) {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    doc.sections[0].heading = heading;
    if (opts?.allEditorialUnrepairable) {
      const words = ["measure", "plan", "test", "review", "share", "adjust"];
      doc.sections
        .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
        .forEach((s, i) => {
          s.heading = i === 0
            ? UNREPAIRABLE_HEADING
            : `${UNREPAIRABLE_HEADING} and ${words[i % words.length]} the results`;
        });
    }
    if (opts?.keyphraseOnlyInFaq) {
      doc.sections.find((s) => s.sectionType === "faq-heading")!.heading =
        "Frequently Asked Questions About Threads Marketing Hong Kong";
    }
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "h2-soft-test",
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
    return runPostAssemblyPipeline(state, {
      chatWithRetry: async () => {
        throw new Error("Unexpected AI call in deterministic end-to-end test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic end-to-end test");
      },
      telemetry: {},
      context: { research: [] },
    });
  }

  it("no safe natural repair → the article still reaches final validation and saves", async () => {
    // Every editorial heading is natural and section-grounding-compatible, but
    // each is too long for the keyphrase to be appended naturally (>90 chars),
    // so no safe natural repair exists — the production-shaped satisfied=false
    // case where the exact keyphrase stays absent from all editorial H2s.
    const result = await runWithSection0Heading(UNREPAIRABLE_HEADING, { allEditorialUnrepairable: true });
    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);
    // The enforce stage ran and was accepted (it is soft now, not a throw).
    const enforce = result.stageOutputs.find((o) => o.stage === "editorial-h2-enforce")!;
    expect(enforce.accepted).toBe(true);
    // No forced/awkward heading: the original is preserved.
    expect(result.articleDoc.sections[0].heading).toBe(UNREPAIRABLE_HEADING);
    // The final SEO/validation layer still reports the H2 miss as soft.
    expect(validation.reasons.some((r) => r.includes("[SOFT] no H2 keyphrase"))).toBe(true);
  });

  it("natural safe H2 repair is still committed when available", async () => {
    const result = await runWithSection0Heading("A Practical Guide for Local Business Owners");
    expect(runFinalValidation(result).passed).toBe(true);
    const finalHeadings = extractH2Texts(result.blog).map((h) => h.toLowerCase());
    expect(finalHeadings.some((h) => h.includes("threads marketing hong kong"))).toBe(true);
    const enforce = result.stageOutputs.find((o) => o.stage === "editorial-h2-enforce")!;
    expect(enforce.accepted).toBe(true);
  });

  it("FAQ H2 still does not count as an editorial H2 and does not block save", async () => {
    // Keyphrase appears ONLY in the FAQ heading; the editorial heading is
    // natural but unrepairable — the FAQ must not satisfy the requirement and
    // the save must still proceed (soft).
    const faqHeading = "Frequently Asked Questions About Threads Marketing Hong Kong";
    const result = await runWithSection0Heading(UNREPAIRABLE_HEADING, { keyphraseOnlyInFaq: true, allEditorialUnrepairable: true });
    expect(runFinalValidation(result).passed).toBe(true);
    const faq = result.articleDoc.sections.find((s) => s.sectionType === "faq-heading")!;
    expect(faq.heading).toBe(faqHeading);
    // The editorial H2s still lack the exact keyphrase (FAQ excluded).
    const editorialHeadings = result.articleDoc.sections
      .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
      .map((s) => s.heading);
    expect(editorialHeadings.some((h) => h.toLowerCase().includes("threads marketing hong kong"))).toBe(false);
  });

  it("genuine heading-naturalness corruption remains a hard gate", async () => {
    // A repeated-location heading is a real naturalness defect and must still
    // fail the final QC gate (zero-write), independent of the soft H2 rule.
    await expect(
      runWithSection0Heading("Local Teams in Hong Kong Need a Plan in Hong Kong"),
    ).rejects.toThrow();
  });

  it("the final SEO audit reports the missing H2 keyphrase as a soft point deduction", async () => {
    const result = await runWithSection0Heading(UNREPAIRABLE_HEADING, { allEditorialUnrepairable: true });
    const audit = runAudit({
      title: result.title,
      metaDescription: result.metaDescription,
      keyword: "threads marketing hong kong",
      blog: result.blog,
      faq: [],
      targetWordCount: 2500,
      targetKeyphraseCount: 9,
    });
    const h2Check = audit.checks.find((c) => c.id === "keyphrase_h2");
    expect(h2Check).toBeDefined();
    expect(h2Check!.status).toBe("warning");
    expect(h2Check!.score).toBe(60);
  });
});

describe("malformed-prose repair boundary (production prose defects)", () => {
  async function runWithInjectedProse(inject: (doc: ReturnType<typeof buildDeterministic2500WordDocument>["doc"]) => void) {
    const keyphrase = "threads marketing hong kong";
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    inject(doc);
    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "prose-boundary-test",
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
    return runPostAssemblyPipeline(state, {
      chatWithRetry: async () => {
        throw new Error("Unexpected AI call in deterministic end-to-end test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic end-to-end test");
      },
      telemetry: {},
      context: { research: [] },
    });
  }

  it("scanner false positives do not block publication", async () => {
    const result = await runWithInjectedProse((doc) => {
      const section = doc.sections[2];
      const last = section.blocks[section.blocks.length - 1];
      if (last.type !== "paragraph") throw new Error("expected paragraph");
      last.content = [{
        type: "text",
        text: `${last.content.map((n) => n.text).join("")} AI and AR are simply the means to get there. A 13" screen example helps local teams.`,
      }];
    });
    expect(runFinalValidation(result).passed).toBe(true);
    // The valid prose survives untouched.
    expect(result.blog).toContain("AI and AR are simply the means to get there.");
  });

  it("a stray punctuation-only '.' sentence is cleaned before final QC", async () => {
    const result = await runWithInjectedProse((doc) => {
      const section = doc.sections[2];
      const last = section.blocks[section.blocks.length - 1];
      if (last.type !== "paragraph") throw new Error("expected paragraph");
      last.content = [{
        type: "text",
        text: `${last.content.map((n) => n.text).join("")} Local teams share useful lessons. . Plan a small weekly routine.`,
      }];
    });
    expect(runFinalValidation(result).passed).toBe(true);
    // The lone "." residue is gone; both intact sentences remain.
    expect(result.blog).toContain("useful lessons. Plan a small weekly routine.");
    expect(result.blog).not.toContain("lessons. . Plan");
  });

  it("genuine unresolvable corruption fails at the repair boundary (zero writes)", async () => {
    await expect(
      runWithInjectedProse((doc) => {
        doc.sections[2].blocks.push({
          id: "section-2-wp-99",
          type: "quote",
          content: [{ type: "text", text: "Smart owners plan for." }],
        });
      }),
    ).rejects.toThrow(/Unresolved malformed prose at repair boundary/);
  });
});

describe("opt-in pipeline debug tracing: observational only", () => {
  async function runOnce(enabled: boolean, traceConsumer?: (trace: unknown) => void) {
    if (enabled) process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    else delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const { doc, introHtml, conclusionHtml } = buildDeterministic2500WordDocument();
    const keyphrase = "threads marketing hong kong";
    const { min: wordMin, max: wordMax } = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "trace-equivalence",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((item) => item.heading),
      intro: introHtml,
      conclusion: conclusionHtml,
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, wordMin, wordMax, keyphrase),
      ctx: { research: [] },
      wordMin,
      wordMax,
      systemPrompt: "test",
      userMessage: "test",
    });
    if (enabled) expect(state.debugTrace).toBeDefined();
    if (!enabled) expect(state.debugTrace).toBeUndefined();
    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => { throw new Error("Unexpected AI call"); },
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [] },
    });
    traceConsumer?.(state.debugTrace);
    return result;
  }

  it("enabled tracing produces no pipeline/output differences vs disabled", async () => {
    const disabled = await runOnce(false);    const enabled = await runOnce(true, (trace) => {
      expect(trace).toBeDefined();
      // Every mutating stage recorded a stage line with a contract record.
      const stages = (trace as { recordsFor(): Array<{ stage: string; contract?: unknown }> }).recordsFor();
      expect(stages.length).toBeGreaterThan(10);
      expect(stages.some((s) => s.stage === "factual-scan")).toBe(true);
      expect(stages.some((s) => s.stage === "claim-ownership")).toBe(true);
      expect(stages.some((s) => s.stage === "final-trim")).toBe(true);
      // Contract-guarded stages carry their integrity-contract result when
      // their guard actually ran (stages that skip early — e.g. no research,
      // no ledger — never reach the contract, which is correct).
      for (const guarded of ["malformed-prose-repair", "final-trim", "final-preflight"]) {
        const record = stages.find((s) => s.stage === guarded);
        expect(record, `trace record for ${guarded}`).toBeDefined();
        expect(record!.contract, `contract for ${guarded}`).toBeDefined();
      }
      // Stages that ran the guard record a contract result (valid or not).
      expect(stages.filter((s) => s.contract).length).toBeGreaterThanOrEqual(3);
    });

    // Stage outputs identical (accepted/fingerprints/metadata).
    expect(JSON.stringify(enabled.stageOutputs)).toBe(JSON.stringify(disabled.stageOutputs));
    // Canonical document byte-identical.
    expect(JSON.stringify(enabled.articleDoc)).toBe(JSON.stringify(disabled.articleDoc));
    // Rendered cache identical.
    expect(enabled.blog).toBe(disabled.blog);
    // Final validation identical.
    expect(JSON.stringify(runFinalValidation(enabled))).toBe(JSON.stringify(runFinalValidation(disabled)));
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
  }, 60_000);
});
