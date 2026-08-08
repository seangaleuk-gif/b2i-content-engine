import { describe, expect, it } from "vitest";
import {
  countCanonicalVisibleWords,
  parseWordPressEditorialBlocks,
  type ArticleDocument,
} from "@/lib/blog/article-document";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import {
  createPipelineState,
  runSourceRelevanceRepairStage,
} from "@/lib/pipeline/blog-generation-pipeline";

const SOURCE_URL = "https://example.com/unrelated-conference";
const RESEARCH = [{
  title: "Regional Advertising Conference Schedule",
  snippet: "Speakers discuss advertising events and venue planning.",
  url: SOURCE_URL,
}];

function paragraph(text: string): string {
  return `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
}

function makeState(sourceText: string) {
  const doc: ArticleDocument = {
    metadata: {
      title: "Privacy and Customer Trust in Hong Kong",
      slug: "privacy-customer-trust-hong-kong",
      metaDescription: "A practical guide to privacy and customer trust for professional teams in Hong Kong.",
      excerpt: "Privacy planning for professional teams.",
      targetWordCount: 1000,
      focusKeyphrase: "privacy customer trust hong kong",
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      status: "generated",
      blocks: parseWordPressEditorialBlocks(paragraph("Clear privacy choices help customers understand how a business handles their information."), "intro").blocks,
    },
    sections: [{
      id: "section-0",
      heading: "Consent and Data Retention Controls",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: parseWordPressEditorialBlocks(
        `${paragraph("A documented consent process gives the team a consistent way to answer customer questions.")}\n${paragraph(sourceText)}`,
        "section-0",
      ).blocks,
    }],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: parseWordPressEditorialBlocks(paragraph("Review the policy regularly and explain every change in plain language."), "conclusion").blocks,
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  return createPipelineState({
    userId: "u",
    projectId: "1",
    keyphrase: doc.metadata.focusKeyphrase,
    requestedWordCount: 1000,
    articleDoc: doc,
    h2Headings: [doc.sections[0].heading],
    intro: "",
    conclusion: "",
    wordsPerSection: 200,
    exactKeyphraseTarget: 2,
    policy: buildPolicy(1000, 900, 1100, doc.metadata.focusKeyphrase),
    ctx: { research: RESEARCH },
    wordMin: 900,
    wordMax: 1100,
    systemPrompt: "",
    userMessage: "",
  });
}

describe("source relevance repair stage", () => {
  it("removes a pure off-topic citation before expansion and records exact targets", () => {
    const state = makeState(`Source: <a href="${SOURCE_URL}">Conference guide</a>.`);
    const beforeWords = countCanonicalVisibleWords(state.articleDoc);

    runSourceRelevanceRepairStage(state, RESEARCH);

    expect(state.blog).not.toContain(SOURCE_URL);
    expect(countCanonicalVisibleWords(state.articleDoc)).toBeLessThan(beforeWords);
    expect(state.stageOutputs).toHaveLength(1);
    expect(state.stageOutputs[0]).toMatchObject({
      stage: "source-relevance-repair",
      accepted: true,
      metadata: {
        detected: 1,
        unresolved: 0,
        removedUrls: [SOURCE_URL],
      },
    });
  });

  it("fails closed and restores the document when the citation block also contains prose", () => {
    const state = makeState(
      `Source: <a href="${SOURCE_URL}">Conference guide</a>. This paragraph also contains editorial prose.`,
    );
    const before = state.blog;

    expect(() => runSourceRelevanceRepairStage(state, RESEARCH)).toThrow(
      "unresolved citation",
    );
    expect(state.blog).toBe(before);
    expect(state.stageOutputs.at(-1)).toMatchObject({
      stage: "source-relevance-repair",
      accepted: false,
      fallbackSource: "pre-stage-restore",
    });
  });
});
