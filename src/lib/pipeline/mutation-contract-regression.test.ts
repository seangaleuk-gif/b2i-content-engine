import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import {
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import {
  compressDocumentStructureAware,
  isLastSubstantiveBodyOfSubsection,
  validateCoherence,
} from "@/lib/blog/coherence";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";
import { validateCandidate } from "@/lib/pipeline/editorial-polish";
import { trimResidualSafeProseToMaximum } from "@/lib/pipeline/blog-generation-pipeline";
import {
  analyzeFinalArticle,
  buildPolicy,
  evaluatePolicy,
  type FinalArticleMetrics,
} from "@/lib/blog/final-article-policy";

const KP = "hong kong marketing trends 2026";
const RESEARCH: Array<{ title?: string; snippet?: string; url?: string }> = [];

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}
function subheading(id: string, text: string): EditorialBlock {
  return { id, type: "subheading", level: 3, content: [{ type: "text", text }] };
}

function baseDocument(): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: KP },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function makeIntroDoc(blocks: EditorialBlock[]): ArticleDocument {
  const doc = baseDocument();
  doc.introduction.blocks = blocks;
  doc.sections.push({
    id: "section-1",
    heading: "Picking the Right Community Platform",
    headingLevel: 2,
    sectionType: "main",
    status: "generated",
    blocks: [
      paragraph("grounding", "Community platform planning shapes how the team approaches the work covered below."),
    ],
  });
  return doc;
}

function makeSectionDoc(blocks: EditorialBlock[]): ArticleDocument {
  const doc = baseDocument();
  doc.sections.push({
    id: "section-1",
    heading: "Picking the Right Community Platform",
    headingLevel: 2,
    sectionType: "main",
    status: "generated",
    blocks,
  });
  return doc;
}

function danglingReferenceTypes(doc: ArticleDocument): string[] {
  return validateCoherence(doc)
    .filter((violation) => violation.type === "dangling-reference")
    .map((violation) => `${violation.componentId}/${violation.blockId ?? "-"}`);
}

function emptySubsectionIds(doc: ArticleDocument): string[] {
  return validateCoherence(doc)
    .filter((violation) => violation.type === "empty-subsection")
    .map((violation) => violation.blockId ?? "");
}

// ── Gap B/C: deletion-created discourse openings ──

describe("mutation contract: deletion-created discourse openings are hard coherence violations", () => {
  it("the exact production opening ('That's why ...') dangles after its premise was deleted", () => {
    // Before factual removal the introduction opened with an unsupported
    // comparative claim; the scanner removed it and this became the new first
    // paragraph. The strict discourse-dependency rule must flag it.
    const doc = makeIntroDoc([
      paragraph("opener", "That's why customer community marketing has become such a powerful way for brands to grow."),
    ]);
    expect(danglingReferenceTypes(doc)).toContain("intro/opener");
  });

  it("'This means ...' as a component opening is a dangling reference", () => {
    const doc = makeIntroDoc([
      paragraph("opener", "This means teams need a clear content calendar to stay consistent."),
    ]);
    expect(danglingReferenceTypes(doc)).toContain("intro/opener");
  });

  it("'As a result, ...' as a component opening is an orphan transition", () => {
    const doc = makeIntroDoc([
      paragraph("opener", "As a result, brands gain more consistent reach over time."),
    ]);
    const violations = validateCoherence(doc);
    expect(violations.some((v) => v.type === "orphan-transition")).toBe(true);
    expect(danglingReferenceTypes(doc)).toEqual([]);
  });

  it("prepositional anaphora ('Given this ...') is a dangling reference", () => {
    const doc = makeIntroDoc([
      paragraph("opener", "Given this, teams can plan content around real customer questions."),
    ]);
    expect(danglingReferenceTypes(doc)).toContain("intro/opener");
  });

  it("a legitimate section opener ('This approach ...') is NOT blocked (strict precision)", () => {
    const doc = makeSectionDoc([
      paragraph("opener", "This approach builds trust slowly and gives the business a clear voice in Hong Kong."),
    ]);
    expect(danglingReferenceTypes(doc)).toEqual([]);
  });

  it("a discourse opener with a complete substantive antecedent is valid", () => {
    const doc = makeSectionDoc([
      paragraph("setup", "Automated scheduling tools create uniform posts that feel generic to many readers over time."),
      paragraph("result", "That's why successful brands plan content around real customer questions instead."),
    ]);
    expect(danglingReferenceTypes(doc)).toEqual([]);
  });

  it("a discourse opener with only a Source citation before it dangles (deletion signal)", () => {
    const doc = makeSectionDoc([
      paragraph("src", "Source: Research from the community management guide."),
      paragraph("result", "That's why brands should plan content around real customer questions."),
    ]);
    expect(danglingReferenceTypes(doc)).toContain("section-1/result");
  });
});

// ── Gap B producer: factual removal ──

describe("mutation contract: factual removal never leaves a discourse-dependent opener", () => {
  function claim(text: string, sentenceText: string): ScannedClaim {
    return { text, htmlPosition: 0, category: "platform_metric", supported: false, sectionIndex: 0, sentenceText };
  }

  it("cross-paragraph: removing the claim also removes a following 'That's why ...' opener", () => {
    const sectionHtml = [
      "<!-- wp:paragraph --><p>About 35% of teams now rely on automated scheduling tools for their campaigns.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>That's why successful brands plan content around real customer questions. Regular reviews keep the routine honest.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>Local teams share useful lessons from daily work with clear and honest words.</p><!-- /wp:paragraph -->",
    ].join("\n\n");
    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of teams now rely on automated scheduling tools", "About 35% of teams now rely on automated scheduling tools for their campaigns."),
    ]);
    expect(out.sentencesRemoved).toBeGreaterThanOrEqual(2);
    const candidate = makeSectionDoc(parseWordPressEditorialBlocks(out.html, "section-1").blocks);
    expect(danglingReferenceTypes(candidate)).toEqual([]);
  });

  it("same-paragraph: a dependent 'That's why ...' sentence is removed with the claim", () => {
    const sectionHtml = [
      "<!-- wp:paragraph --><p>About 35% of teams now rely on automated scheduling tools. That's why brands plan content around real customer questions.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>Local teams share useful lessons from daily work with clear and honest words.</p><!-- /wp:paragraph -->",
    ].join("\n\n");
    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of teams now rely on automated scheduling tools", "About 35% of teams now rely on automated scheduling tools."),
    ]);
    const candidate = makeSectionDoc(parseWordPressEditorialBlocks(out.html, "section-1").blocks);
    expect(danglingReferenceTypes(candidate)).toEqual([]);
    expect(out.html).not.toMatch(/That['\u2019]?s why/i);
  });

  it("structural fail-closed: factual removal never emits unbalanced WordPress markup", () => {
    const sectionHtml = [
      "<!-- wp:paragraph --><p>About 35% of teams now rely on automated scheduling tools for their campaigns.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>That's why successful brands plan content around real customer questions.</p><!-- /wp:paragraph -->",
      "<!-- wp:paragraph --><p>Local teams share useful lessons from daily work with clear and honest words.</p><!-- /wp:paragraph -->",
    ].join("\n\n");
    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of teams now rely on automated scheduling tools", "About 35% of teams now rely on automated scheduling tools for their campaigns."),
    ]);
    const candidate = makeSectionDoc(parseWordPressEditorialBlocks(out.html, "section-1").blocks);
    expect(danglingReferenceTypes(candidate)).toEqual([]);
    expect(out.html.replace(/\n{2,}/g, "\n").trim().length).toBeGreaterThan(0);
  });
});

// ── Gap B producer: paragraph removal / trim ──

describe("mutation contract: trim producers never sever a discourse-dependent neighbour", () => {
  it("structure-aware compression never removes the antecedent of a 'That's why ...' paragraph", () => {
    const doc = makeSectionDoc([
      paragraph("antecedent", "Automated scheduling tools tend to create uniform posts that can feel generic to many readers over time, so thoughtful brands look for a more personal alternative."),
      paragraph("why", "That's why successful brands plan content around real customer questions instead."),
      paragraph("closer", "A small weekly plan keeps the work steady without adding stress to the whole team."),
    ]);
    const total = countCanonicalVisibleWords(doc);
    compressDocumentStructureAware(doc, Math.max(1, total - 8), 1, KP, RESEARCH);
    const whySurvives = doc.sections[0].blocks.some((block) => block.id === "why");
    const antecedentSurvives = doc.sections[0].blocks.some((block) => block.id === "antecedent");
    if (whySurvives) expect(antecedentSurvives).toBe(true);
    expect(danglingReferenceTypes(doc)).toEqual([]);
  });

  it("residual safe trim never removes the antecedent of a 'That's why ...' paragraph", () => {
    const doc = makeSectionDoc([
      paragraph("antecedent", "Automated scheduling tools tend to create uniform posts that can feel generic to many readers over time, so thoughtful brands look for a more personal alternative."),
      paragraph("why", "That's why successful brands plan content around real customer questions instead."),
      paragraph("closer", "A small weekly plan keeps the work steady without adding stress to the whole team, and honest replies build lasting trust."),
      paragraph("filler", "Owners can note common questions and turn those questions into helpful future posts while keeping the routine simple for everyone involved."),
    ]);
    trimResidualSafeProseToMaximum(doc, 1, 1, KP, RESEARCH);
    const whySurvives = doc.sections[0].blocks.some((block) => block.id === "why");
    const antecedentSurvives = doc.sections[0].blocks.some((block) => block.id === "antecedent");
    if (whySurvives) expect(antecedentSurvives).toBe(true);
    expect(danglingReferenceTypes(doc)).toEqual([]);
  });
});

// ── Gap A: residual safe trim and H3 subsections ──

describe("mutation contract: residual safe trim never orphans an H3 subsection", () => {
  it("the only substantive body paragraph under an H3 is never removed", () => {
    const doc = makeSectionDoc([
      paragraph(
        "opener",
        "About 35% of local marketing teams now rely on automated scheduling tools for their campaigns and report steady results from the practice over time. Owners can note common questions and turn those questions into helpful future posts while keeping the routine simple for everyone involved.",
      ),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "Your community can live on WhatsApp without a formal page or public feed."),
    ]);
    trimResidualSafeProseToMaximum(doc, 1, 1, KP, RESEARCH);
    expect(doc.sections[0].blocks.some((block) => block.id === "p-a")).toBe(true);
    expect(emptySubsectionIds(doc)).toEqual([]);
  });

  it("one of multiple H3 body paragraphs may be removed while substantive content remains", () => {
    const doc = makeSectionDoc([
      paragraph(
        "opener",
        "About 35% of local marketing teams now rely on automated scheduling tools for their campaigns and report steady results from the practice over time. Owners can note common questions and turn those questions into helpful future posts while keeping the routine simple for everyone involved.",
      ),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a1", "Your community can live on WhatsApp without a formal page or public feed."),
      paragraph("p-a2", "A smaller group often keeps conversations closer and more genuine for members."),
    ]);
    trimResidualSafeProseToMaximum(doc, 1, 1, KP, RESEARCH);
    expect(emptySubsectionIds(doc)).toEqual([]);
    const pCount = doc.sections[0].blocks.filter((block) => block.id === "p-a1" || block.id === "p-a2").length;
    expect(pCount).toBeGreaterThanOrEqual(1);
  });

  it("the shared subsection-body rule treats lists/tables/quotes as body but not Source lines", () => {
    const withList = makeSectionDoc([
      paragraph("opener", "A long opener paragraph with enough words to keep the section above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      { id: "list-a", type: "list", ordered: false, items: [[{ type: "text", text: "WhatsApp" }], [{ type: "text", text: "Facebook groups" }]] },
    ]);
    expect(emptySubsectionIds(withList)).toEqual([]);

    const withSourceOnly = makeSectionDoc([
      subheading("h3-a", "Choose the Right Space"),
      paragraph("src-a", "Source: Research from the community management guide."),
    ]);
    expect(emptySubsectionIds(withSourceOnly)).toContain("h3-a");
  });

  it("isLastSubstantiveBodyOfSubsection distinguishes single vs multiple body blocks", () => {
    const single = [
      paragraph("opener", "A long opener paragraph with enough words to keep the section above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "Your community can live on WhatsApp without a formal page."),
    ];
    // The only substantive body of its H3 subsection — removing it orphans the H3.
    expect(isLastSubstantiveBodyOfSubsection(single, 2)).toBe(true);
    const multiple = [
      paragraph("opener", "A long opener paragraph with enough words to keep the section above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a1", "Your community can live on WhatsApp without a formal page."),
      paragraph("p-a2", "A smaller group often keeps conversations closer and more genuine."),
    ];
    // With two substantive bodies, neither removal orphans the H3.
    expect(isLastSubstantiveBodyOfSubsection(multiple, 2)).toBe(false);
    expect(isLastSubstantiveBodyOfSubsection(multiple, 3)).toBe(false);
  });
});

// ── Gap C: final QC and the policy gate ──

describe("mutation contract: final QC and the policy gate detect damage entered before the final stage", () => {
  function otherwiseValidMetrics(): FinalArticleMetrics {
    return {
      readableWordCount: 1500,
      h2Count: 5,
      faqEntryCount: 4,
      exactKeyphraseCount: 5,
      keyphraseDensity: 1.0,
      exactKeyphraseInH2: true,
      longParagraphCount: 0,
      keyphraseInFirst100Words: true,
      uniqueInternalLinkCount: 2,
      externalSourceLinkCount: 2,
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
    };
  }

  it("an empty H3 subsection that enters the document is a coherence metric and hard-fails the gate", () => {
    const doc = makeSectionDoc([
      subheading("h3-a", "Choose the Right Space"),
      subheading("h3-b", "Tailor Content to Local Culture"),
    ]);
    expect(validateCoherence(doc).some((v) => v.type === "empty-subsection")).toBe(true);
    const metrics = analyzeFinalArticle(
      renderArticleDocument(doc),
      KP,
      "Title",
      "Meta description",
      1500,
      countCanonicalVisibleWords(doc),
      { articleDoc: doc, research: RESEARCH },
    );
    expect(metrics.coherenceViolationCount ?? 0).toBeGreaterThan(0);
    const policy = buildPolicy(1500, 1350, 1650, KP);
    const result = evaluatePolicy(metrics, policy);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("coherence"))).toBe(true);
  });

  it("a deletion-created discourse opening is a coherence metric and hard-fails the gate", () => {
    const doc = makeIntroDoc([
      paragraph("opener", "That's why customer community marketing has become such a powerful way for brands to grow."),
    ]);
    expect(danglingReferenceTypes(doc)).toContain("intro/opener");
    const metrics = analyzeFinalArticle(
      renderArticleDocument(doc),
      KP,
      "Title",
      "Meta description",
      1500,
      countCanonicalVisibleWords(doc),
      { articleDoc: doc, research: RESEARCH },
    );
    expect(metrics.coherenceViolationCount ?? 0).toBeGreaterThan(0);
  });

  it("the policy gate treats any coherence violation as a hard failure", () => {
    const policy = buildPolicy(1500, 1350, 1650, KP);
    expect(evaluatePolicy(otherwiseValidMetrics(), policy).passed).toBe(true);
    const failing = evaluatePolicy({ ...otherwiseValidMetrics(), coherenceViolationCount: 1 }, policy);
    expect(failing.passed).toBe(false);
    expect(failing.reasons.some((reason) => reason.includes("coherence"))).toBe(true);
  });
});

// ── Stable delta identity ──

describe("mutation contract: stable delta identity for the discourse-dependency rule", () => {
  it("a dangling-reference relocated by an inserted source citation is not a newly introduced violation", () => {
    const why = paragraph("why", "That's why successful brands plan content around real customer questions instead of relying on rigid automation calendars every single week.");
    const closer1 = paragraph("closer1", "A small weekly plan keeps the work steady without adding stress to the whole team or the owner.");
    const closer2 = paragraph("closer2", "Regular replies also show customers that a real person is listening to their needs throughout the month.");
    const previous = makeSectionDoc([why, closer1, closer2]);
    expect(danglingReferenceTypes(previous)).toContain("section-1/why");

    // Inserting a source citation before the same opening reindexes every
    // positional block id but the semantic violation is unchanged.
    const candidate = makeSectionDoc([
      paragraph("src", "Source: Research from the community management guide published for Hong Kong teams explains the full picture in detail."),
      why,
      closer1,
      closer2,
    ]);
    expect(danglingReferenceTypes(candidate)).toContain("section-1/why");

    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      research: RESEARCH,
      previous,
      ownedCategories: new Set(["word-count"]),
    });
    expect(result.violations.filter((v) => v.category === "coherence")).toEqual([]);
  });

  it("a genuinely new dangling-reference in a different block is still reported", () => {
    const setup = paragraph("setup", "Automated scheduling tools create uniform posts that feel generic to many readers over time.");
    const closer1 = paragraph("closer1", "A small weekly plan keeps the work steady without adding stress to the whole team or the owner.");
    const closer2 = paragraph("closer2", "Regular replies also show customers that a real person is listening to their needs throughout the month.");
    const previous = makeSectionDoc([setup, closer1, closer2]);
    expect(danglingReferenceTypes(previous)).toEqual([]);
    // A NEW discourse-dependent opening appears as the component's first
    // paragraph — genuinely introduced, so the contract must report it.
    const candidate = makeSectionDoc([
      paragraph("why", "That's why successful brands plan content around real customer questions instead of relying on rigid automation calendars every single week."),
      setup,
      closer1,
      closer2,
    ]);
    expect(danglingReferenceTypes(candidate)).toContain("section-1/why");
    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      research: RESEARCH,
      previous,
      ownedCategories: new Set(["word-count"]),
    });
    expect(result.violations.some((v) => v.category === "coherence")).toBe(true);
  });
});

// ── Gap C: final-document-editorial committed-candidate gate ──

describe("mutation contract: final-document-editorial committed-candidate gate rejects coherence damage", () => {
  function coherenceAwareProductionValidator(candidate: ArticleDocument): { passed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    for (const violation of validateCoherence(candidate)) {
      reasons.push(`coherence ${violation.type} in ${violation.componentId}`);
    }
    return { passed: reasons.length === 0, reasons };
  }

  it("the deterministic committed-candidate gate rejects a patch that introduces a dangling discourse opening", () => {
    // baseline: a coherence-clean section (as guaranteed by final-qc-scan before
    // the final-document-editorial stage).
    const baseline = makeSectionDoc([
      paragraph("p0", "Local teams can share useful lessons from daily work with clear and honest words, and a small weekly plan keeps the work steady without adding stress to the whole team or the owner."),
      paragraph("p1", "Regular replies also show customers that a real person is listening to their needs throughout the month, so the routine stays honest and consistent over time."),
    ]);
    expect(danglingReferenceTypes(baseline)).toEqual([]);

    // The patch replaces the opening paragraph with a deletion-created
    // discourse opening.
    const damaged = makeSectionDoc([
      paragraph("p0", "That's why customer community marketing has become such a powerful way for brands to grow."),
      paragraph("p1", "Regular replies also show customers that a real person is listening to their needs throughout the month, so the routine stays honest and consistent over time."),
    ]);
    expect(danglingReferenceTypes(damaged)).toContain("section-1/p0");

    const validation = validateCandidate(baseline, damaged, KP, coherenceAwareProductionValidator);
    expect(validation.passed).toBe(false);
    expect(validation.reasons.some((reason) => reason.includes("coherence dangling-reference"))).toBe(true);
  });

  it("the deterministic committed-candidate gate rejects a patch that orphans an H3 subsection", () => {
    const baseline = makeSectionDoc([
      paragraph("opener", "A long opener paragraph that introduces the community platform decision with enough words to keep the section well above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "Your community can live on WhatsApp without a formal page or public feed, and a smaller group often keeps conversations closer and more genuine for members."),
    ]);
    expect(emptySubsectionIds(baseline)).toEqual([]);

    // The patch empties the only substantive body of the H3 (leaving an empty
    // paragraph block in its place).
    const damaged = makeSectionDoc([
      paragraph("opener", "A long opener paragraph that introduces the community platform decision with enough words to keep the section well above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "  "),
    ]);
    expect(emptySubsectionIds(damaged)).toContain("h3-a");

    const validation = validateCandidate(baseline, damaged, KP, coherenceAwareProductionValidator);
    expect(validation.passed).toBe(false);
    expect(validation.reasons.some((reason) => reason.includes("coherence empty-subsection"))).toBe(true);
  });
});
