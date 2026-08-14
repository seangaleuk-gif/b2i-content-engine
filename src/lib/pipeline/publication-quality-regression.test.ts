import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";
import {
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  renderComponentHtml,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import { validateCoherence, compressDocumentStructureAware, MIN_SECTION_WORDS } from "@/lib/blog/coherence";
import { countBoilerplateInDocument, isSourceBoilerplate, stripSourceBoilerplate } from "@/lib/blog/source-boilerplate";
import { buildEvidenceLedger, scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { normalizeEnglishTitleCasing } from "@/lib/services/text-utils";
import { runAudit } from "@/lib/services/seo-auditor";
import { reconcilePostOwnershipKeyphrase } from "@/lib/blog/post-ownership-seo-reconcile";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { analyzeCanonicalEnglishCta } from "@/lib/blog/canonical-cta";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { validateFaqParity, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong marketing trends 2026";

function loadFixture(): { title: string; slug: string; blog: string; faq: unknown[] } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, "../../../fixtures/blog-13-v15.json"), "utf8")
    .replace(/^\uFEFF/, "");
  const version = JSON.parse(raw) as { title: string; slug: string; blog: string; faq: unknown[] };
  return version;
}

function parseFixture(): ArticleDocument {
  const { title, slug, blog } = loadFixture();
  const seedDoc: ArticleDocument = {
    metadata: {
      title,
      slug,
      metaDescription: "",
      excerpt: "",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  const parsed = parseArticleDocumentFromHtml(blog, seedDoc);
  if (!parsed.doc) throw new Error(parsed.errors.join("; "));
  return parsed.doc;
}

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

// ── The saved article proves the damage; the gate now catches every class ──

describe("publication-quality regression (blog 13, version 15 fixture)", () => {
  it("the saved article's damage classes are detected by coherence and boilerplate validation", () => {
    const doc = parseFixture();
    const coherence = validateCoherence(doc);
    expect(coherence.some((v) => v.type === "unfinished-example")).toBe(true);
    const example = coherence.find((v) => v.type === "unfinished-example")!;
    expect(example.snippet).toContain("imagine a local skincare brand");
    expect(coherence.some((v) => v.type === "orphan-transition")).toBe(true);
    const orphan = coherence.find((v) => v.type === "orphan-transition")!;
    expect(orphan.snippet).toMatch(/^Instead,/);

    const boilerplate = countBoilerplateInDocument(doc);
    expect(boilerplate.some((b) => b.snippet.includes("views, information, or opinions expressed"))).toBe(true);
  });

  it("the saved article would now fail the final hard gate on coherence and boilerplate", () => {
    const doc = parseFixture();
    const { blog } = loadFixture();
    const metrics = analyzeFinalArticle(
      blog,
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
      countCanonicalVisibleWords(doc),
      { articleDoc: doc, research: [] },
    );
    const policy = buildPolicy(2500, 2125, 2875, KEYPHRASE);
    const result = evaluatePolicy(metrics, policy);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("coherence violations"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("source boilerplate blocks"))).toBe(true);
  });

  // ── Structure-aware compression ──

  it("final trimming cannot leave an unfinished example and preserves complete arguments", () => {
    const doc = parseFixture();
    // The fixture is already damaged (that is the regression). Rebuild the
    // damaged section the way the trim would see it pre-damage: example setup
    // + its continuation + low-value detail paragraphs.
    const section = doc.sections.find((s) => s.heading.startsWith("AI and Automation"))!;
    section.blocks = [
      paragraph("ex-setup", "A good example: imagine a local skincare brand that wants to launch a new serum."),
      paragraph("ex-cont", "It could use AI to analyse which ingredients customers ask about most, then tailor posts and ads around those questions."),
      paragraph("low-1", "Simple examples help busy owners understand the idea and take a practical next step."),
      paragraph("low-2", "Regular replies also show customers that a real person is listening to their needs."),
      paragraph("low-3", "A small weekly plan keeps the work steady without adding stress to the whole team."),
    ];

    const wordsBeforeCompression = countCanonicalVisibleWords(doc);
    const compression = compressDocumentStructureAware(
      doc,
      wordsBeforeCompression - 150,
      wordsBeforeCompression - 400,
      KEYPHRASE,
      [],
    );
    expect(compression.removedWords).toBeGreaterThanOrEqual(100);
    expect(compression.removedWords).toBe(
      wordsBeforeCompression - countCanonicalVisibleWords(doc),
    );

    // The rebuilt section is coherent after compression (other fixture
    // sections retain their original pre-existing damage classes).
    const coherence = validateCoherence(doc).filter((v) => v.componentId === section.id);
    expect(coherence).toEqual([]);
    // The example setup AND its continuation both survive.
    const sectionText = renderComponentHtml(section);
    expect(sectionText).toContain("A good example: imagine a local skincare brand");
    expect(sectionText).toContain("tailor posts and ads around those questions");
    // The low-value detail was removed instead.
    expect(sectionText).not.toContain("Simple examples help busy owners");
  });

  it("sentence-level deterministic compression never splits a multi-sentence quotation", () => {
    const quoted =
      "The owner said “Start with one complete customer question before planning the campaign. " +
      "Keep the follow-up explanation inside the same quotation so its meaning remains clear.” " +
      "The team then reviews the complete response before deciding what to publish next.";
    const doc: ArticleDocument = {
      metadata: {
        title: "Complete Test Article",
        slug: "complete-test-article",
        metaDescription: "A complete description.",
        excerpt: "",
        targetWordCount: 100,
        focusKeyphrase: KEYPHRASE,
      },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [], status: "generated" },
      sections: [{
        id: "quoted-section",
        heading: "Quoted guidance",
        headingLevel: 2,
        sectionType: "main",
        blocks: [paragraph("quoted-paragraph", quoted)],
        status: "generated",
      }],
      visibleFaq: [],
      conclusion: { id: "conclusion", blocks: [], status: "generated" },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
    const before = renderArticleDocument(doc);
    const words = countCanonicalVisibleWords(doc);
    const result = compressDocumentStructureAware(doc, words - 10, 1, KEYPHRASE, []);
    expect(result.shortenedSentences).toBe(0);
    expect(renderArticleDocument(doc)).toBe(before);
  });

  it("an orphan \u201cInstead\u201d opening a section is rejected by coherence validation", () => {
    const doc = parseFixture();
    const section = doc.sections.find((s) => s.sectionType === "main")!;
    section.blocks.unshift(
      paragraph("orphan-instead", "Instead, the brands winning attention in 2026 are the ones that feel human."),
    );
    const coherence = validateCoherence(doc);
    expect(coherence.some((v) => v.type === "orphan-transition" && v.blockId === "orphan-instead")).toBe(true);
  });

  it("accepts a contextual So transition after a Source citation", () => {
    const doc = parseFixture();
    const section = doc.sections.find((s) => s.sectionType === "main")!;
    section.blocks = [
      paragraph(
        "antecedent",
        "Short-form video now gives local brands a practical way to demonstrate products and answer customer questions.",
      ),
      {
        id: "source",
        type: "paragraph",
        content: [
          { type: "text", text: "Source: " },
          { type: "link", text: "Hong Kong video research", href: "https://example.com/video" },
          { type: "text", text: "." },
        ],
      },
      paragraph(
        "contextual-so",
        "So, what does this mean for your business? If you haven't started experimenting with short-form video, begin with one useful customer question.",
      ),
      paragraph(
        "close",
        "A small test gives the team enough information to improve the next campaign without making an oversized commitment.",
      ),
    ];

    expect(
      validateCoherence(doc).filter((violation) => violation.blockId === "contextual-so"),
    ).toEqual([]);
  });

  it("still rejects Instead when nearby prose contains no contrasting proposition", () => {
    const doc = parseFixture();
    const section = doc.sections.find((s) => s.sectionType === "main")!;
    section.blocks = [
      paragraph("unrelated", "Creator-led content can help a local team explain its work in a familiar voice."),
      paragraph("orphan-instead-context", "Instead, use creator-led content for the next campaign."),
      paragraph("close", "Review the response and use the result to plan the following campaign."),
    ];

    expect(
      validateCoherence(doc).some((violation) =>
        violation.type === "orphan-transition" && violation.blockId === "orphan-instead-context"),
    ).toBe(true);
  });

  it("accepts Instead when the preceding substantive paragraph establishes the rejected alternative", () => {
    const doc = parseFixture();
    const section = doc.sections.find((s) => s.sectionType === "main")!;
    section.blocks = [
      paragraph("contrast", "Generic display ads no longer earn the same attention, and teams should avoid interruptive messages."),
      paragraph("valid-instead", "Instead, use creator-led content that answers a specific customer question."),
      paragraph("close", "The clearer context makes the recommendation useful rather than disruptive."),
    ];

    expect(
      validateCoherence(doc).filter((violation) => violation.blockId === "valid-instead"),
    ).toEqual([]);
  });

  it("compression never removes evidence, links or protected content, and keeps sections above the floor", () => {
    const doc = parseFixture();
    const ctaHtml = doc.cta!.html;
    const switcherHtml = doc.languageSwitcher!.html;
    const schemaHtml = doc.faqSchema!.html;
    const faqAnswers = doc.visibleFaq.map((entry) => entry.answerText);
    const linksBefore = [...doc.sections.flatMap((s) => s.blocks)].filter((b) =>
      b.type === "paragraph" && b.content.some((node) => node.type === "link"),
    ).length;

    const compression = compressDocumentStructureAware(
      doc,
      countCanonicalVisibleWords(doc) - 250,
      countCanonicalVisibleWords(doc) - 500,
      KEYPHRASE,
      [],
    );
    expect(compression.removedWords).toBeGreaterThan(0);

    // Protected content byte-for-byte unchanged.
    expect(doc.cta!.html).toBe(ctaHtml);
    expect(doc.languageSwitcher!.html).toBe(switcherHtml);
    expect(doc.faqSchema!.html).toBe(schemaHtml);
    expect(doc.visibleFaq.map((entry) => entry.answerText)).toEqual(faqAnswers);
    // Every link-bearing paragraph survives.
    const linksAfter = [...doc.sections.flatMap((s) => s.blocks)].filter((b) =>
      b.type === "paragraph" && b.content.some((node) => node.type === "link"),
    ).length;
    expect(linksAfter).toBe(linksBefore);
    // No section is thinned below the floor.
    for (const section of doc.sections.filter((s) => s.sectionType === "main")) {
      const words = countCanonicalVisibleWords({
        ...doc,
        introduction: { id: "intro", blocks: [], status: "generated" },
        sections: [section],
        conclusion: { id: "conclusion", blocks: [], status: "generated" },
        visibleFaq: [],
        faqSchema: null,
        cta: null,
        languageSwitcher: null,
      } as ArticleDocument);
      expect(words).toBeGreaterThanOrEqual(MIN_SECTION_WORDS);
    }
  });

  it("the trimmed fixture keeps CTA, FAQ/schema, links and WordPress structure valid", () => {
    const doc = parseFixture();
    compressDocumentStructureAware(
      doc,
      countCanonicalVisibleWords(doc) - 200,
      countCanonicalVisibleWords(doc) - 500,
      KEYPHRASE,
      [],
    );
    const rendered = renderArticleDocument(doc);
    expect(validateWordpressBlockPairs(rendered).valid).toBe(true);
    const cta = analyzeCanonicalEnglishCta(rendered);
    expect(cta.valid, cta.issues.join("; ")).toBe(true);
    const schemaHtml = extractFaqBlock(rendered);
    const parity = validateFaqParity(
      extractVisibleFaqFromArticle(rendered, doc).map((e) => ({
        question: e.question,
        answerHtml: "",
        answerText: e.answerText,
      })),
      schemaHtml,
    );
    expect(parity.valid, parity.issues.map((i) => i.type).join("; ")).toBe(true);
  });

  // ── Boilerplate ──

  it("legal/source boilerplate is excluded from evidence and flagged in the final document", () => {
    const hsbcDisclaimer =
      "\u201cThe views, information, or opinions expressed in content posted on HSBC Business Go, are solely those of the author and/or the organisation they represent; they do not necessarily reflect the views of HSBC or HSBC Business Go.\u201d";
    expect(isSourceBoilerplate(hsbcDisclaimer)).toBe(true);
    expect(isSourceBoilerplate("Teams posting three times per week saw higher engagement rates.")).toBe(false);

    // Boilerplate never becomes evidence.
    const ledger = buildEvidenceLedger([
      { title: "2026 Social Marketing Trends", snippet: hsbcDisclaimer, url: "https://example.com/hsbc" },
      { title: "Posting cadence study", snippet: "Teams posting three times per week saw higher engagement rates.", url: "https://example.com/cadence" },
    ]);
    expect(ledger.some((entry) => entry.approvedText.includes("views, information"))).toBe(false);
    expect(ledger.some((entry) => entry.approvedText.includes("three times per week"))).toBe(true);

    // stripSourceBoilerplate removes the disclaimer sentence, keeps the rest.
    const stripped = stripSourceBoilerplate(`Useful trend data. ${hsbcDisclaimer} More useful trend data.`);
    expect(stripped).not.toContain("views, information");
    expect(stripped).toContain("Useful trend data");

    // Never alter attributed speech by deleting only an interior boilerplate
    // sentence while retaining the rest of the quotation.
    const quoted = stripSourceBoilerplate(
      'The footer says “Useful context. Subscribe to our newsletter. More quoted context.” Independent evidence remains.',
    );
    expect(quoted).toBe("Independent evidence remains.");
  });

  // ── Market-wide claims ──

  it("unsupported market-wide assertions and superlatives are detected", () => {
    const claims = [
      "Hong Kong users\u2019 tolerance for ads has hit rock bottom, so brands must rethink their approach.",
      "Everyone is seeing ads everywhere they look these days.",
      "Brands across the city are moving to social commerce.",
      "Video is the most effective way to reach new customers.",
      "A glossy poster no longer guarantees attention.",
    ];
    for (const sentence of claims) {
      const scan = scanFactualRisks(
        `<!-- wp:paragraph --><p>${sentence}</p><!-- /wp:paragraph -->`,
        KEYPHRASE,
        [],
      );
      expect(
        scan.claims.some((c) => c.category === "market_wide_claim" && !c.supported),
        sentence,
      ).toBe(true);
    }
    // Matching evidence supports the same market-wide assertion.
    const supported = scanFactualRisks(
      `<!-- wp:paragraph --><p>Hong Kong users\u2019 tolerance for ads has hit rock bottom, so brands must rethink their approach.</p><!-- /wp:paragraph -->`,
      KEYPHRASE,
      [
        {
          title: "Ad tolerance study",
          snippet: "Hong Kong users\u2019 tolerance for ads has hit rock bottom according to the study.",
          url: "https://example.com/ad-tolerance",
        },
      ],
    );
    expect(supported.claims.some((c) => c.category === "market_wide_claim" && c.supported)).toBe(true);
  });

  // ── Editorial H2 keyphrase placement ──

  it("places the exact keyphrase in one normal editorial H2, never the FAQ heading", () => {
    // Synthetic production-like article: ~1,000 words at healthy density, FAQ
    // heading containing the exact keyphrase, editorial headings without it.
    const prose = [
      "Local teams can share useful lessons from daily work with clear and honest words.",
      "Simple examples help busy owners understand the idea and take a practical next step.",
      "Regular replies also show customers that a real person is listening to their needs.",
      "A small weekly plan keeps the work steady without adding stress to the whole team.",
      "Owners can note common questions and turn those questions into helpful future posts.",
      "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
      "Measuring profile visits and messages shows which ideas are working.",
      "Consistency matters more than a single perfect post or large budget.",
    ];
    const paragraphs: EditorialBlock[] = [];
    for (let i = 0; i < 40; i++) {
      const mention = i === 10 || i === 20
        ? ` The ${KEYPHRASE} landscape rewards teams that keep testing.`
        : "";
      paragraphs.push(paragraph(`p-${i}`, `${prose[i % prose.length]} ${prose[(i + 3) % prose.length]} ${prose[(i + 5) % prose.length]}${mention}`));
    }
    const sections: ArticleDocument["sections"] = [
      { id: "s0", heading: "The Shifting Landscape of Local Marketing", headingLevel: 2, sectionType: "main", blocks: paragraphs.slice(0, 8), status: "generated" },
      { id: "s1", heading: "AI and Automation Reshape Campaigns", headingLevel: 2, sectionType: "main", blocks: paragraphs.slice(8, 16), status: "generated" },
      { id: "s2", heading: "Data Privacy and First-Party Data", headingLevel: 2, sectionType: "main", blocks: paragraphs.slice(16, 24), status: "generated" },
      { id: "s3", heading: "Budgeting and Strategy for the Year", headingLevel: 2, sectionType: "main", blocks: paragraphs.slice(24, 32), status: "generated" },
      { id: "faq", heading: "Frequently Asked Questions About Hong Kong Marketing Trends 2026", headingLevel: 2, sectionType: "faq-heading", blocks: [], status: "generated" },
    ];
    const doc: ArticleDocument = {
      metadata: {
        title: "Hong Kong Marketing Trends 2026: What You Need to Know",
        slug: "hong-kong-marketing-trends-2026",
        metaDescription: "The Hong Kong marketing trends 2026 landscape and what it means for local teams.",
        excerpt: "A practical guide.",
        targetWordCount: 2500,
        focusKeyphrase: KEYPHRASE,
      },
      languageSwitcher: null,
      introduction: {
        id: "intro",
        status: "generated",
        blocks: [
          paragraph("intro-1", `This guide covers the ${KEYPHRASE} landscape and how local teams can adapt their plans.`),
          ...paragraphs.slice(32, 36),
        ],
      },
      sections,
      visibleFaq: [
        { question: "What is driving the Hong Kong marketing trends 2026?", answerHtml: "", answerText: "Consumer behaviour shifts and the growing role of digital platforms are the main drivers." },
      ],
      conclusion: {
        id: "conclusion",
        status: "generated",
        blocks: paragraphs.slice(36, 40),
      },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
    const faqHeading = sections.find((s) => s.sectionType === "faq-heading")!.heading;
    expect(faqHeading.toLowerCase()).toContain(KEYPHRASE);

    const research = [
      {
        title: "Digital and social media trends in Hong Kong in 2026",
        snippet: "Hong Kong marketing trends 2026 are shaped by social commerce and community engagement.",
        url: "https://example.com/2026-trends",
      },
    ];
    const result = reconcilePostOwnershipKeyphrase(doc, KEYPHRASE, research, undefined);
    expect(result.h2KeyphraseRestored).toBe(true);
    const editorialHeadings = doc.sections
      .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
      .map((s) => s.heading);
    expect(editorialHeadings.some((h) => h.toLowerCase().includes(KEYPHRASE))).toBe(true);
    expect(doc.sections.find((s) => s.sectionType === "faq-heading")!.heading).toBe(faqHeading);
    expect(result.densityAfter).toBeLessThanOrEqual(3);
    expect(result.densityAfter).toBeGreaterThanOrEqual(0.5);
  });

  // ── Title casing ──

  it("deterministic title casing preserves configured proper nouns exactly", () => {
    expect(normalizeEnglishTitleCasing("Hong kong marketing trends 2026: What You Need to Know", KEYPHRASE))
      .toBe("Hong Kong Marketing Trends 2026: What You Need to Know");
    expect(normalizeEnglishTitleCasing("hong kong marketing trends 2026", KEYPHRASE))
      .toBe("Hong Kong Marketing Trends 2026");
    expect(normalizeEnglishTitleCasing("Why HSBC and AI Matter in Hong Kong", KEYPHRASE))
      .toBe("Why HSBC and AI Matter in Hong Kong");
  });

  // ── SEO audit measurements ──

  it("SEO audit measurements match the saved canonical document (2872 words, six FAQs)", () => {
    const { title, blog, faq } = loadFixture();
    const result = runAudit({
      title,
      metaDescription: "The Hong Kong marketing trends 2026 landscape.",
      keyword: KEYPHRASE,
      blog,
      faq: faq as Array<{ question: string; answer: string }>,
      targetWordCount: 2500,
      targetKeyphraseCount: 5,
    });
    const wordCheck = result.checks.find((c) => c.id === "word_count")!;
    expect(wordCheck.measuredValue).toContain("2,872");
    const faqCheck = result.checks.find((c) => c.id === "faq_count")!;
    expect(faqCheck.measuredValue).toContain("6");
    // The FAQ heading never satisfies the editorial-H2 placement.
    const h2Check = result.checks.find((c) => c.id === "keyphrase_h2")!;
    expect(h2Check.status).toBe("warning");
    expect(h2Check.measuredValue).toBe("Not found");
  });

  // ── Unsafe compaction restores the complete prior snapshot ──

  it("unsafe compaction candidates are rejected and the complete prior snapshot is restored", async () => {
    vi.resetModules();
    const { runPostAssemblyPipeline, createPipelineState } = await import("@/lib/pipeline/blog-generation-pipeline");
    const { englishWordTolerance } = await import("@/lib/content-standards");
    const { buildPolicy } = await import("@/lib/blog/final-article-policy");
    const { parseWordPressEditorialBlocks } = await import("@/lib/blog/article-document");

    function paragraphHtml(text: string): string {
      return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
    }
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
        blocks.push(paragraphHtml(`${sentences[(index + sectionIndex) % 6]} ${sentences[(index + sectionIndex + 1) % 6]} ${sentences[(index + sectionIndex + 2) % 6]}`));
      }
      return blocks.join("\n\n");
    };
    const component = (id: string, html: string): ArticleDocument["introduction"] => ({
      id,
      blocks: parseWordPressEditorialBlocks(html, id).blocks,
      status: "generated",
    });
    const keyphrase = "threads marketing hong kong";
    const headings = [
      "Threads Marketing Hong Kong for Small Local Brands",
      "Understand the People You Want to Reach",
      "Build a Simple Weekly Content Routine",
      "Create Posts That Start Useful Conversations",
      "Measure Results and Improve the Next Post",
      "Common Mistakes Hong Kong SMEs Should Avoid",
    ];
    const sections: ArticleSection[] = headings.map((heading, index) => ({
      ...component(`section-${index}`, makeParagraphs(index, 10)),
      heading,
      headingLevel: 2,
      sectionType: "main" as const,
    }));
    sections.push({
      ...component("faq-section", ""),
      heading: "Frequently Asked Questions About Threads Marketing",
      headingLevel: 2,
      sectionType: "faq-heading" as const,
    });
    const doc: ArticleDocument = {
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

    const range = englishWordTolerance(2500);
    // Force the compaction path: max below the deterministic reach.
    const forcedMax = 2600;
    const state = createPipelineState({
      userId: "test-user",
      projectId: "compaction-test",
      keyphrase,
      requestedWordCount: 2500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, forcedMax, keyphrase),
      ctx: { research: [] },
      wordMin: range.min,
      wordMax: forcedMax,
      systemPrompt: "test",
      userMessage: "test",
    });

    const unsafePayload = JSON.stringify({
      blocks: [{ type: "paragraph", text: "UNSAFE COMPACTION CONTENT THAT DROPS ALL EVIDENCE AND MEANING." }],
    });
    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async (_messages: unknown, _options: unknown, stage?: string) => {
        if (stage === "final-trim-compaction") {
          return { content: unsafePayload, finishReason: "stop", attemptsUsed: 0 };
        }
        throw new Error("Unexpected AI call in deterministic compaction test");
      },
      makeTrackedChatForStage: () => async () => {
        throw new Error("Unexpected tracked AI call in deterministic compaction test");
      },
      telemetry: {},
      context: { research: [] },
    });

    // The unsafe candidate was rejected; the complete prior snapshot stands.
    expect(result.blog).not.toContain("UNSAFE COMPACTION CONTENT");
    expect(result.blog).toContain("Opening guide to threads marketing hong kong");
    expect(validateCoherence(result.articleDoc)).toEqual([]);
  });
});
