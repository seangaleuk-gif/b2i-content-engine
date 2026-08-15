import { describe, expect, it } from "vitest";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import {
  parseWordPressEditorialBlocks,
  renderComponentHtml,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import {
  assessSectionTopicGrounding,
  countSectionGroundingCarriers,
  essentialGroundingCarrierSentenceTexts,
  isSectionTopicGrounded,
} from "@/lib/blog/content-relevance";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";
import { compressDocumentStructureAware } from "@/lib/blog/coherence";
import { reconcilePostOwnershipKeyphrase } from "@/lib/blog/post-ownership-seo-reconcile";
import { canonicalKeyphraseMetrics } from "@/lib/blog/final-seo-reconcile";

const KP = "hong kong consumer behaviour";
const HEADING = "The Shifting Landscape of Hong Kong Consumer Behaviour";

function claim(text: string, sentenceText?: string): ScannedClaim {
  return {
    text,
    htmlPosition: 0,
    category: "platform_metric",
    supported: false,
    sectionIndex: 0,
    ...(sentenceText ? { sentenceText } : {}),
  };
}

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

const GENERIC_SENTENCES = [
  "Local teams share useful lessons from daily work with clear and honest words.",
  "Simple examples help busy owners understand the idea and take a practical next step.",
  "Regular replies also show customers that a real person is listening to their needs.",
  "A small weekly plan keeps the work steady without adding stress to the whole team.",
  "Owners can note common questions and turn those questions into helpful future posts.",
  "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
];

function makeDoc(sectionHtml: string, extraSections?: string[]): ArticleDocument {
  const sections: ArticleSection[] = [
    {
      id: "section-0",
      heading: HEADING,
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(sectionHtml, "section-0").blocks,
      status: "generated",
    },
  ];
  for (let index = 0; index < (extraSections?.length ?? 0); index++) {
    sections.push({
      id: `section-extra-${index}`,
      heading: `Supporting topic area number ${index + 1} for the guide`,
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(extraSections![index], `section-extra-${index}`).blocks,
      status: "generated",
    });
  }
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 2500, focusKeyphrase: KP },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections,
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function realisticSectionHtml(withUnsupported: boolean): string {
  const filler = (n: number) => GENERIC_SENTENCES.map((s) => paragraph(`${s}${n % 2 === 0 ? " More detail follows for the reader." : ""}`)).join("\n\n");
  const blocks = [
    paragraph(`${GENERIC_SENTENCES[0]} ${GENERIC_SENTENCES[1]}`),
    paragraph(`About 35% of shoppers now show shifting consumer behaviour in Hong Kong.`),
    paragraph(`${GENERIC_SENTENCES[2]} ${GENERIC_SENTENCES[3]}`),
    paragraph(`${GENERIC_SENTENCES[4]} ${GENERIC_SENTENCES[5]}`),
  ];
  if (withUnsupported) {
    blocks.push(
      paragraph("Claims that consumer behaviour in Hong Kong collapsed by 80% are not supported by the supplied research."),
    );
  }
  return [blocks.join("\n\n"), filler(1), filler(2)].join("\n\n");
}

function extraSectionHtml(): string {
  return [
    paragraph("Supporting topic number one for the guide explains the core supporting ideas in plain words."),
    paragraph("A second supporting paragraph expands the topic number one area with more practical guidance."),
    paragraph("A third supporting paragraph keeps the topic number one section complete and grounded."),
  ].join("\n\n");
}

function extraSectionHtmlTwo(): string {
  return [
    paragraph("Supporting topic number two for the guide explains a different supporting idea in plain words."),
    paragraph("A second supporting paragraph expands the topic number two area with more practical guidance."),
    paragraph("A third supporting paragraph keeps the topic number two section complete and grounded."),
  ].join("\n\n");
}

describe("section topic grounding: no mutating stage may unground a grounded section", () => {
  it("the grounding invariant detects the exact production shape: only the claim sentence carries the heading word", () => {
    const sectionHtml = [
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("Simple examples help busy owners understand the idea and take a practical next step."),
      paragraph("About 35% of shoppers now show shifting consumer behaviour in Hong Kong."),
      paragraph("Regular replies also show customers that a real person is listening to their needs."),
    ].join("\n\n");
    const previous = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtml()]);
    expect(assessSectionTopicGrounding(previous)).toEqual([]);
    expect(countSectionGroundingCarriers(previous.sections[0])).toBe(1);

    // Removing the only carrier (the unsupported claim) WITHOUT protection
    // leaves the section ungrounded — and the stage-aware contract now
    // reports it as an introduced grounding violation (fail-closed).
    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of shoppers now show shifting consumer behaviour", "About 35% of shoppers now show shifting consumer behaviour in Hong Kong."),
    ]);
    const candidate = makeDoc(out.html, [extraSectionHtml(), extraSectionHtml()]);
    expect(assessSectionTopicGrounding(candidate)).not.toEqual([]);
    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
    });
    expect(result.violations.some((v) => v.category === "grounding")).toBe(true);
  });

  it("the producer preserves the essential grounding carrier when it is the only carrier", () => {
    // The section's ONLY grounding paragraph carries the unsupported claim.
    // Removing it without protection ungrounds the section; with the essential
    // carrier preserved, the claim stays, the section stays grounded, and the
    // stage-aware contract accepts the candidate.
    const sectionHtml = [
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("About 35% of shoppers now show shifting consumer behaviour in Hong Kong."),
      paragraph("Regular replies also show customers that a real person is listening to their needs."),
    ].join("\n\n");
    const previous = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtmlTwo()]);
    expect(assessSectionTopicGrounding(previous)).toEqual([]);
    expect(countSectionGroundingCarriers(previous.sections[0])).toBe(1);

    const carriers = essentialGroundingCarrierSentenceTexts(previous.sections[0]);
    expect(carriers.length).toBeGreaterThan(0);

    const out = removeUnsupportedSentences(
      sectionHtml,
      [claim("35% of shoppers now show shifting consumer behaviour", "About 35% of shoppers now show shifting consumer behaviour in Hong Kong.")],
      carriers.length > 0 ? { preserveSentenceTexts: carriers } : undefined,
    );
    const candidate = makeDoc(out.html, [extraSectionHtml(), extraSectionHtmlTwo()]);
    // The section stays grounded.
    expect(assessSectionTopicGrounding(candidate)).toEqual([]);
    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
    });
    expect(result.violations.some((v) => v.category === "grounding")).toBe(false);
  });

  it("essential carriers are only those of the section's single grounding paragraph", () => {
    // Two paragraphs carry a heading word → nothing is essential.
    const twoCarriers = [
      paragraph("Consumer behaviour in Hong Kong is shifting as buyers change routines."),
      paragraph("About 35% of shoppers now show shifting consumer behaviour in Hong Kong."),
    ].join("\n\n");
    const doc = makeDoc(twoCarriers, [extraSectionHtml()]);
    expect(countSectionGroundingCarriers(doc.sections[0])).toBe(2);
    expect(essentialGroundingCarrierSentenceTexts(doc.sections[0])).toEqual([]);

    // One carrier paragraph → its sentences are essential.
    const oneCarrier = [
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("About 35% of shoppers now show shifting consumer behaviour in Hong Kong."),
    ].join("\n\n");
    const doc2 = makeDoc(oneCarrier, [extraSectionHtml()]);
    expect(countSectionGroundingCarriers(doc2.sections[0])).toBe(1);
    expect(essentialGroundingCarrierSentenceTexts(doc2.sections[0]).length).toBeGreaterThan(0);
  });

  it("final-trim whole-paragraph removal never removes the last grounding paragraph", () => {
    const sectionHtml = [
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("Consumer behaviour in Hong Kong is shifting as buyers change routines."),
      paragraph("Regular replies also show customers that a real person is listening to their needs."),
    ].join("\n\n");
    const doc = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtml()]);
    const initialWords = countSectionGroundingCarriers(doc.sections[0]);

    compressDocumentStructureAware(doc, 60, 30, KP, []);
    // The only grounding paragraph must survive the trim.
    expect(assessSectionTopicGrounding(doc)).toEqual([]);
    expect(countSectionGroundingCarriers(doc.sections[0])).toBeGreaterThanOrEqual(1);
    expect(countSectionGroundingCarriers(doc.sections[0])).toBeLessThanOrEqual(initialWords);
  });

  it("final trim sentence shortening keeps a heading content word in the only grounding paragraph", () => {
    const sectionHtml = [
      paragraph("Consumer behaviour in Hong Kong is shifting as buyers change routines. Extra detail that can be removed without losing the topic word."),
    ].join("\n\n");
    const doc = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtml()]);
    compressDocumentStructureAware(doc, 60, 30, KP, []);
    expect(assessSectionTopicGrounding(doc)).toEqual([]);
    expect(isSectionTopicGrounded(doc.sections[0])).toBe(true);
  });

  it("post-ownership reconciliation preserves section grounding", () => {
    const sectionHtml = realisticSectionHtml(false);
    const doc = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtmlTwo(), extraSectionHtml()]);
    const reconcile = reconcilePostOwnershipKeyphrase(doc, KP, [], undefined);
    expect(reconcile.keyphraseCountAfter).toBeGreaterThanOrEqual(canonicalKeyphraseMetrics(doc, KP).occurrences);
    // The reconciliation restores keyphrase targets without ungrounding the
    // section — a heading/introduction edit must never destroy the section's
    // minimum grounded substance.
    expect(assessSectionTopicGrounding(doc)).toEqual([]);
    expect(renderComponentHtml(doc.sections[0])).toContain("consumer");
  });
});
