import { afterEach, describe, expect, it } from "vitest";
import {
  analyzePublicationQuality,
  trimConclusionToBudget,
} from "./publication-quality";
import {
  parseWordPressEditorialBlocks,
  type ArticleDocument,
} from "./article-document";
import {
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
