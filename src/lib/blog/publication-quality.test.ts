import { afterEach, describe, expect, it } from "vitest";
import {
  analyzePublicationQuality,
  countRepeatedIdeaPairs,
  keyphraseExclusionSet,
  scanMalformedProseInDocument,
  trimConclusionToBudget,
} from "./publication-quality";
import {
  parseWordPressEditorialBlocks,
  type ArticleDocument,
} from "./article-document";
import {
  analyzeFinalArticle,
  buildPolicy,
  evaluatePolicy,
  type FinalArticleMetrics,
} from "./final-article-policy";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function article(paragraphs: string[], conclusion: string[] = []): string {
  return [
    ...paragraphs.map(paragraph),
    "<!-- b2i-conclusion-start -->",
    ...conclusion.map(paragraph),
    "<!-- b2i-conclusion-end -->",
  ].join("\n");
}

function component(id: string, texts: string[]) {
  return {
    id,
    blocks: parseWordPressEditorialBlocks(
      texts.map(paragraph).join("\n"),
      id,
    ).blocks,
    status: "generated" as const,
  };
}

function docWithConclusion(texts: string[]): ArticleDocument {
  return {
    metadata: {
      title: "Threads Marketing Hong Kong Guide for Local SMEs",
      slug: "threads-guide",
      metaDescription: "A sufficiently descriptive test meta description for the article.",
      excerpt: "",
      targetWordCount: 2500,
      focusKeyphrase: "threads marketing hong kong",
    },
    languageSwitcher: null,
    introduction: component("intro", ["This introduction explains the practical strategy for local businesses."]),
    sections: [{
      ...component("section-1", [
        "A local bakery can share behind-the-scenes work and answer useful customer questions.",
        "Businesses should focus on useful conversations and practical advice for customers.",
      ]),
      heading: "Practical strategy",
      headingLevel: 2,
      sectionType: "main",
    }],
    visibleFaq: [],
    conclusion: component("conclusion", texts),
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("publication-quality analysis", () => {
  it("scans metadata, section headings and canonical FAQ text at the save boundary", () => {
    const doc = docWithConclusion(["A complete conclusion closes the practical guide."]);
    doc.metadata.title = "An unfinished “title";
    doc.sections[0].heading = 'An unfinished "heading';
    doc.visibleFaq = [{
      question: "Why does the “plan work?",
      answerHtml: "",
      answerText: 'It starts with an unfinished "example.',
    }];
    const findings = scanMalformedProseInDocument(doc);
    expect(findings.map((finding) => finding.blockId)).toEqual(expect.arrayContaining([
      "metadata-title",
      "section-1-heading",
      "faq-0-question",
      "faq-0-answer",
    ]));
  });

  it("scans table cells independently instead of balancing quotes across cells", () => {
    const doc = docWithConclusion(["A complete conclusion closes the practical guide."]);
    doc.sections[0].blocks = [{
      id: "table-1",
      type: "table",
      headers: [
        [{ type: "text", text: 'Opening "label' }],
        [{ type: "text", text: 'Closing label"' }],
      ],
      rows: [[
        [{ type: "text", text: "A complete first cell." }],
        [{ type: "text", text: "A complete second cell." }],
      ]],
    }];

    const findings = scanMalformedProseInDocument(doc);
    const tableFinding = findings.find((finding) => finding.blockId === "table-1");
    expect(tableFinding?.issues.filter((issue) => issue.code === "unmatched-quotation")).toHaveLength(2);
  });

  it("detects incompatible Hong Kong Threads audience figures", () => {
    const metrics = analyzePublicationQuality(article([
      "Threads has grown quickly in Hong Kong, with 4 million monthly active users.",
      "Threads now has over 400,000 users in Hong Kong.",
    ]));
    expect(metrics.claimConflictCount).toBeGreaterThan(0);
    expect(metrics.factualScore).toBeLessThan(100);
  });

  it("detects incompatible daily and weekly publishing advice", () => {
    const metrics = analyzePublicationQuality(article([
      "For Threads, post 2–3 times daily to remain visible.",
      "On this platform, schedule three Threads per week for consistency.",
    ]));
    expect(metrics.claimConflictCount).toBeGreaterThan(0);
  });

  it("detects available-versus-coming-soon feature claims", () => {
    const metrics = analyzePublicationQuality(article([
      "As Threads develops, adjust your strategy when polls become available.",
      "Use the platform's native polls to ask customers a useful question.",
    ]));
    expect(metrics.claimConflictCount).toBeGreaterThan(0);
  });

  it("detects the corrupt production token", () => {
    const metrics = analyzePublicationQuality(article([
      "Show this post at the counter 🌿 manyf when you visit this weekend.",
    ]));
    expect(metrics.malformedProseCount).toBe(1);
    expect(metrics.editorialScore).toBeLessThan(80);
  });

  it("penalizes an overgrown conclusion that introduces new numbers", () => {
    const body = Array.from({ length: 5 }, (_, index) =>
      `Main article paragraph ${index} provides useful practical guidance for a local business owner.`,
    );
    const conclusion = Array.from({ length: 8 }, (_, index) =>
      `Conclusion paragraph ${index} adds another detailed recommendation with several unnecessary explanatory words.`,
    );
    conclusion.push("Post 17 times every week for the best result.");
    const metrics = analyzePublicationQuality(article(body, conclusion));
    expect(metrics.conclusionWordRatio).toBeGreaterThan(0.18);
    expect(metrics.conclusionNewNumericClaimCount).toBeGreaterThan(0);
  });

  it("does not invent failures for a concise, consistent article", () => {
    const metrics = analyzePublicationQuality(article([
      "Threads lets a neighbourhood business answer customer questions in a conversational way.",
      "A useful post can explain one practical decision without making unsupported promises.",
    ], [
      "Start with a clear purpose, listen to customer replies and refine the approach over time.",
    ]));
    expect(metrics.claimConflictCount).toBe(0);
    expect(metrics.malformedProseCount).toBe(0);
    expect(metrics.conclusionNewNumericClaimCount).toBe(0);
  });

  describe("robotic phrase detection", () => {
    it("does not count non-imperative uses of the word remember", () => {
      const metrics = analyzePublicationQuality(article([
        "Customers who enjoy a post will remember your brand the next time they shop.",
        "People will remember a helpful answer long after they read it.",
      ]));
      expect(metrics.roboticPhraseCount).toBe(0);
    });

    it("counts the imperative remember form used as a robotic phrase", () => {
      const metrics = analyzePublicationQuality(article([
        "Remember, consistency matters more than frequency for a growing account.",
        "Plain guidance helps. Remember to reply within a day.",
      ]));
      expect(metrics.roboticPhraseCount).toBe(2);
    });

    it("does not penalize a clean article for legitimate remember usage", () => {
      // Regression: a real article containing "people will remember" scored
      // a false robotic deduction and lost editorial points.
      const metrics = analyzePublicationQuality(article([
        "The posts that show up with real personality, not just promotions, are the ones people will remember.",
      ]));
      expect(metrics.roboticPhraseCount).toBe(0);
      expect(metrics.editorialScore).toBe(100);
    });
  });
});

describe("deterministic conclusion discipline", () => {
  it("removes complete interior prose blocks while preserving boundary and protected blocks", () => {
    const doc = docWithConclusion([
      "The opening conclusion summarises the practical approach for local businesses.",
      "A local bakery can share behind-the-scenes work and answer useful customer questions.",
      "Businesses should focus on useful conversations and practical advice for customers.",
      `Keep the source <a href="https://example.com/source">available here</a> for readers.`,
      "Review the plan after 30 days.",
      "Finish with one clear next step for the reader.",
    ]);
    const result = trimConclusionToBudget(doc, 45);
    const rendered = doc.conclusion.blocks
      .map((block) => "content" in block ? block.content.map((node) => node.text).join("") : "")
      .join(" ");

    expect(result.removedBlocks).toBeGreaterThan(0);
    expect(rendered).toContain("opening conclusion");
    expect(rendered).toContain("Finish with one clear next step");
    expect(rendered).toContain("available here");
    expect(rendered).toContain("30 days");
  });
});

describe("publication-quality feature gate", () => {
  afterEach(() => {
    delete process.env.ENABLE_EDITORIAL_POLISH;
  });

  function otherwiseValidMetrics(): FinalArticleMetrics {
    return {
      readableWordCount: 2500,
      h2Count: 6,
      faqEntryCount: 5,
      exactKeyphraseCount: 9,
      keyphraseDensity: 1,
      exactKeyphraseInH2: true,
      longParagraphCount: 0,
      keyphraseInFirst100Words: true,
      uniqueInternalLinkCount: 1,
      externalSourceLinkCount: 1,
      ctaHeadingCount: 1,
      signupUrlCount: 1,
      faqBlockCount: 1,
      faqJsonLdCount: 1,
      hasLanguageSwitcher: true,
      nestedParagraphCount: 0,
      malformedHeadingCount: 0,
      wpBlockCountMismatch: false,
      faqParityValid: true,
      titleLength: 60,
      metaDescriptionLength: 170,
      fleschReadingEase: 65,
      hasPlaceholderContent: false,
      hasRawProseOutsideBlocks: false,
      duplicateFaqSchemaCount: 0,
      duplicateCtaBlockCount: 0,
      hasConclusionContent: true,
      claimConflictCount: 1,
      malformedProseCount: 0,
      repeatedIdeaPairCount: 0,
      conclusionWordRatio: 0.1,
      conclusionNewNumericClaimCount: 0,
      factualScore: 65,
      editorialScore: 100,
    };
  }

  it("preserves the previous final-gate behaviour while the feature is disabled", () => {
    const policy = buildPolicy(2500, 2125, 2875, "threads marketing hong kong");
    expect(policy.enforcePublicationQuality).toBe(false);
    expect(evaluatePolicy(otherwiseValidMetrics(), policy).passed).toBe(true);
  });

  it("blocks the same factual contradiction when editorial polish is enabled", () => {
    process.env.ENABLE_EDITORIAL_POLISH = "true";
    const policy = buildPolicy(2500, 2125, 2875, "threads marketing hong kong");
    const result = evaluatePolicy(otherwiseValidMetrics(), policy);
    expect(policy.enforcePublicationQuality).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("factual contradictions"))).toBe(true);
  });
});

describe("keyphrase exclusion in repeated-idea detection", () => {
  const KP = "hong kong influencer marketing";

  it("counts zero pairs when paragraphs share only the focus keyphrase", () => {
    const paragraphs = [
      "Hong Kong influencer marketing helps brands build authentic connections with local audiences every day.",
      "Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations.",
      "Hong Kong influencer marketing is growing fast with more local brands choosing authentic voices over celebrity endorsements for better engagement.",
      "The Hong Kong influencer marketing landscape rewards genuine content and authentic partnerships between brands and creators.",
    ];
    // Without exclusion these trigger false positives (short keyphrase-heavy
    // paragraphs reach the 0.55 overlap threshold).
    expect(countRepeatedIdeaPairs(paragraphs)).toBeGreaterThan(0);
    expect(countRepeatedIdeaPairs(paragraphs, keyphraseExclusionSet(KP))).toBe(0);
  });

  it("still detects genuine near-duplicate paragraphs after keyphrase exclusion", () => {
    const original = "Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations.";
    const echo = "Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations. This is the same idea repeated with an extra sentence appended.";
    const filler = "A local bakery can share behind-the-scenes work and answer useful customer questions every single day without fail.";
    expect(countRepeatedIdeaPairs([original, echo, filler], keyphraseExclusionSet(KP))).toBe(1);
  });

  it("final article analysis does not count keyphrase-only overlap as repeated pairs", () => {
    const html = [
      "<!-- wp:paragraph --><p>Hong Kong influencer marketing helps brands build authentic connections with local audiences every day.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>The Hong Kong influencer marketing landscape rewards genuine content and authentic partnerships between brands and creators.</p><!-- /wp:paragraph -->",
    ].join("\n");
    const metrics = analyzeFinalArticle(html, KP, "Title", "Meta description", 500, 60);
    expect(metrics.repeatedIdeaPairCount).toBe(0);
  });

  it("final article analysis still counts genuine duplicate ideas", () => {
    const html = [
      "<!-- wp:paragraph --><p>Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations. This repeats the identical sentence again for the test.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>A local bakery can share behind-the-scenes work and answer useful customer questions every single day without fail.</p><!-- /wp:paragraph -->",
    ].join("\n");
    const metrics = analyzeFinalArticle(html, KP, "Title", "Meta description", 500, 70);
    expect(metrics.repeatedIdeaPairCount).toBe(1);
  });

  it("editorial score is not deflated by keyphrase-only overlap", () => {
    const html = [
      "<!-- wp:paragraph --><p>Hong Kong influencer marketing helps brands build authentic connections with local audiences every day.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>Effective influencer marketing helps Hong Kong brands reach local consumers authentically and build lasting customer loyalty through genuine recommendations.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>The Hong Kong influencer marketing landscape rewards genuine content and authentic partnerships between brands and creators.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>For Hong Kong influencer marketing success brands must focus on authentic storytelling rather than audience size.</p><!-- /wp:paragraph -->",
    ].join("\n");
    const metrics = analyzeFinalArticle(html, KP, "Title", "Meta description", 500, 80);
    expect(metrics.editorialScore ?? 0).toBeGreaterThan(90);
  });
});
