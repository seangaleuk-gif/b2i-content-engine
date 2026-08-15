import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import {
  scanMalformedProseInDocument,
  classifyMalformedIssue,
} from "@/lib/blog/publication-quality";
import {
  scanSentenceQualityInDocument,
  scanSentenceQualityText,
  isAuthoritativeLowercaseSentenceStart,
  isAuthoritativePunctuationOnlyResidue,
  lowercaseStartValidTokensFromKeyphrase,
} from "@/lib/blog/sentence-quality";
import { repairDeterministicMalformedProse } from "@/lib/pipeline/editorial-polish";
import { compressDocumentStructureAware } from "@/lib/blog/coherence";
import { reduceProtectedKeyphraseOccurrences } from "@/lib/blog/final-seo-normalizer";
import { reconcilePostOwnershipKeyphrase } from "@/lib/blog/post-ownership-seo-reconcile";

const KEYPHRASE = "hong kong marketing trends 2026";

function countWords(doc: ArticleDocument): number {
  return doc.sections.flatMap((section) => section.blocks)
    .map((block) => {
      if (block.type === "paragraph" || block.type === "subheading" || block.type === "quote") {
        return block.content.map((node) => node.text).join("");
      }
      return "";
    })
    .join(" ").split(/\s+/).filter(Boolean).length;
}

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function linkedParagraph(id: string, nodes: InlineContent[]): EditorialBlock {
  return { id, type: "paragraph", content: nodes };
}

function makeDoc(blocks: EditorialBlock[], keyphrase = KEYPHRASE): ArticleDocument {
  return {
    metadata: {
      title: "Hong Kong Marketing Trends 2026",
      slug: "hong-kong-marketing-trends-2026",
      metaDescription: "A practical guide.",
      excerpt: "Guide",
      targetWordCount: 1500,
      focusKeyphrase: keyphrase,
    },
    languageSwitcher: null,
    introduction: { id: "intro", status: "generated", blocks },
    sections: [
      {
        id: "section-0",
        heading: "Understand the People You Want to Reach",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph("s0-0", "A clear audience profile helps a small team choose the right conversations."),
          paragraph("s0-1", "Simple examples help busy owners understand the idea and take a practical next step."),
        ],
      },
      { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", status: "generated", blocks: [] },
    ],
    visibleFaq: [{ question: "Q", answerHtml: "", answerText: "Start with a small and useful routine." }],
    conclusion: { id: "conclusion", status: "generated", blocks: [paragraph("c-0", "This is a complete conclusion sentence for the article.")] },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("preflight and final sentence-quality QC share the same authoritative rules", () => {
  it("both scanners agree on the production lowercase-start block (keyphrase is a valid lowercase token)", () => {
    const doc = makeDoc([
      paragraph("wp-0", "Local teams share useful lessons every week."),
      paragraph("wp-1", "hong kong marketing trends 2026 are not about following a formula."),
    ]);
    // The keyphrase is a valid lowercase token sequence: NEITHER gate flags it.
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
    expect(
      isAuthoritativeLowercaseSentenceStart("hong kong marketing trends 2026 are not about following a formula.", {
        validLowercaseTokens: lowercaseStartValidTokensFromKeyphrase(KEYPHRASE),
      }),
    ).toBe(false);
    // Without the keyphrase context the same sentence IS a lowercase start.
    expect(isAuthoritativeLowercaseSentenceStart("hong kong marketing trends 2026 are not about following a formula.")).toBe(true);
  });

  it("both scanners flag the exact same genuine lowercase-start and punctuation-only-residue sentences", () => {
    const doc = makeDoc([
      paragraph("wp-0", "Local teams share useful lessons every week."),
      paragraph("wp-1", "planning a weekly routine keeps the work steady. Simple examples help busy owners understand the idea."),
      paragraph("wp-2", "Consistency matters more than a single perfect post. . Plan the next step."),
    ]);
    const malformed = scanMalformedProseInDocument(doc);
    const sentenceQuality = scanSentenceQualityInDocument(doc);

    const malformedBlocks = new Map(malformed.map((finding) => [finding.blockId, finding.issues.map((issue) => issue.code)]));
    const sqBlocks = new Map(sentenceQuality.map((finding) => [finding.blockId, finding.issues.map((issue) => issue.code)]));
    expect(malformedBlocks.get("wp-1")).toContain("lowercase-sentence-start");
    expect(sqBlocks.get("wp-1")).toContain("lowercase-sentence-start");
    expect(malformedBlocks.get("wp-2")).toContain("punctuation-fragment");
    expect(sqBlocks.get("wp-2")).toContain("fragment");
  });

  it("both scanners agree that valid abbreviations are never sentences", () => {
    const text = "Dr. Smith and Mr. Lee run the store, which opens at 9 a.m. and closes at 6 p.m.";
    expect(scanSentenceQualityText(text)).toEqual([]);
    const doc = makeDoc([paragraph("wp-0", text)]);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
  });

  it("the preflight deterministic repair makes both gates agree clean on the production blocks", () => {
    const doc = makeDoc([
      paragraph("wp-0", "Local teams share useful lessons every week."),
      paragraph("wp-1", "planning a weekly routine keeps the work steady. Simple examples help busy owners understand the idea."),
      linkedParagraph("wp-2", [
        { type: "text", text: ". Consistency matters more than a single perfect post. Read the " },
        { type: "link", text: "full guide", href: "/blog/hk-guide", sourceType: "internal" },
        { type: "text", text: " before you start." },
      ]),
      paragraph("wp-3", "hong kong marketing trends 2026 are not about following a formula."),
    ]);

    const repair = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);

    // Genuine lowercase start capitalized; keyphrase-start untouched; "." in
    // the linked paragraph stripped while the link survives.
    const wp1 = doc.introduction.blocks.find((block) => block.id === "wp-1");
    expect((wp1 as Extract<EditorialBlock, { type: "paragraph" }>).content.map((node) => node.text).join("")).toMatch(/^Planning a weekly routine/);
    const wp3 = doc.introduction.blocks.find((block) => block.id === "wp-3");
    expect((wp3 as Extract<EditorialBlock, { type: "paragraph" }>).content.map((node) => node.text).join("")).toBe(KEYPHRASE + " are not about following a formula.");
    const wp2 = doc.introduction.blocks.find((block) => block.id === "wp-2") as Extract<EditorialBlock, { type: "paragraph" }>;
    expect(wp2.content).toContainEqual({ type: "link", text: "full guide", href: "/blog/hk-guide", sourceType: "internal" });
    expect(wp2.content.map((node) => node.text).join("")).not.toMatch(/^\s*\./);

    // After the owning-stage repair, both gates see zero violations.
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
    expect(repair.repairedBlockIds).toContain("wp-1");
    expect(repair.repairedBlockIds).toContain("wp-2");
  });

  it("an unrepairable punctuation-only whole block stays a hard failure and fails closed", () => {
    // A single-block component with a "."-only paragraph: the deterministic
    // repair cannot remove it (would empty the component) and cannot rewrite it.
    const doc = makeDoc([]);
    doc.sections = [{
      id: "section-0",
      heading: "Measure Results",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [paragraph("s0-0", ".")],
    }];
    expect(scanMalformedProseInDocument(doc).flatMap((f) => f.issues.map((i) => i.code))).toContain("punctuation-fragment");
    expect(classifyMalformedIssue("punctuation-fragment")).toBe("hard");

    const repair = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    expect(repair.unresolved.length).toBeGreaterThan(0);
    // The repair boundary's hard gate must still see it (the pipeline restores
    // the exact snapshot and throws here).
    const remaining = scanMalformedProseInDocument(doc);
    expect(remaining.some((finding) => finding.issues.some((issue) => classifyMalformedIssue(issue.code) === "hard"))).toBe(true);
  });

  it("sentence removal producers never leave standalone punctuation behind", () => {
    // Coherence compression: the only eligible paragraph carries a "." residue
    // sentence; removing its first sentence must drop the residue from the
    // remainder instead of leaving standalone punctuation.
    const doc = makeDoc([]);
    doc.sections = [{
      id: "section-0",
      heading: "Measure Results",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [
        paragraph("s0-0", "Local teams share useful lessons every week. . Plan a small weekly routine that keeps the work steady and the team consistent."),
        // Links make these ineligible for sentence-level compression, so
        // section s0-0 is the only candidate and its remainder is deterministic.
        linkedParagraph("s0-1", [
          { type: "text", text: "Simple examples help busy owners understand the idea. Read the " },
          { type: "link", text: "full guide", href: "/blog/full-guide", sourceType: "internal" },
          { type: "text", text: " before you start." },
        ]),
        linkedParagraph("s0-2", [
          { type: "text", text: "Regular replies also show customers that a real person is listening. Read the " },
          { type: "link", text: "reply guide", href: "/blog/reply-guide", sourceType: "internal" },
          { type: "text", text: " before you start." },
        ]),
        linkedParagraph("s0-3", [
          { type: "text", text: "Owners can note common questions and turn those questions into helpful future posts. Read the " },
          { type: "link", text: "planning guide", href: "/blog/planning-guide", sourceType: "internal" },
          { type: "text", text: " before you start." },
        ]),
      ],
    }];
    const before = countWords(doc);
    compressDocumentStructureAware(doc, before - 10, 1, KEYPHRASE, []);
    for (const block of doc.sections[0].blocks) {
      const text = block.type === "paragraph" ? block.content.map((node) => node.text).join("") : "";
      expect(scanSentenceQualityText(text)).toEqual([]);
    }

    // Keyphrase sentence reduction: remaining sentences never include residue.
    // The first paragraph is the first-100 region (protected from reduction);
    // the second paragraph carries the keyphrase and a "." residue sentence.
    const html =
      `<!-- wp:paragraph --><p>Simple examples help busy owners understand the idea and take a practical next step. Regular replies also show customers that a real person is listening to their needs.</p><!-- /wp:paragraph -->\n` +
      `<!-- wp:paragraph --><p>${KEYPHRASE} helps local teams plan ahead. . Consistency matters more than a single perfect post.</p><!-- /wp:paragraph -->`;
    const reduced = reduceProtectedKeyphraseOccurrences(html, KEYPHRASE, 0);
    expect(reduced.html).not.toMatch(/\s\.\s/);

    // The authoritative residue rule is the single definition everywhere.
    expect(isAuthoritativePunctuationOnlyResidue(".")).toBe(true);
    expect(isAuthoritativePunctuationOnlyResidue("...")).toBe(true);
    expect(isAuthoritativePunctuationOnlyResidue("Good sentence.")).toBe(false);
  });

  it("final-trim producer never commits punctuation-only residue, even in a paragraph that loses the removal competition", () => {
    // Section-3-wp-2 style: the residue-bearing paragraph is SHORT, so the
    // pass-2 removal competition would prefer other paragraphs. The producer
    // must still clean its residue (pass 0) and preserve every inline link.
    const doc = makeDoc([]);
    doc.sections = [{
      id: "section-3",
      heading: "Measure Results and Improve the Next Post",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [
        paragraph("section-3-wp-1", "A useful routine starts with clear goals and honest measurements for the whole team."),
        paragraph("section-3-wp-2", "Local teams share useful lessons every week. . Plan a small weekly routine that keeps the work steady and the team consistent."),
        linkedParagraph("section-3-wp-3", [
          { type: "text", text: ". Consistency matters more than a single perfect post. Read the " },
          { type: "link", text: "full guide", href: "/blog/hk-guide", sourceType: "internal" },
          { type: "text", text: " before you start." },
        ]),
        paragraph("section-3-wp-4", "Simple examples help busy owners understand the idea and take a practical next step."),
        paragraph("section-3-wp-5", "Regular replies also show customers that a real person is listening to their needs."),
        paragraph("section-3-wp-6", "Owners can note common questions and turn those questions into helpful future posts."),
      ],
    }];
    // wordMax = current word count: no removal is needed, so only the pass-0
    // residue purge runs and the residue paragraphs must still be cleaned
    // (proving the purge is unconditional, not coupled to removal selection).
    const wordMax = countWords(doc);
    compressDocumentStructureAware(doc, wordMax, 1, KEYPHRASE, []);

    // The producer output contains no punctuation-only residue anywhere.
    const malformed = scanMalformedProseInDocument(doc);
    expect(malformed.filter((f) => f.issues.some((i) => i.code === "punctuation-fragment"))).toEqual([]);
    // And the final sentence-quality gate agrees.
    expect(scanSentenceQualityInDocument(doc).flatMap((f) => f.issues.map((i) => i.code))).not.toContain("fragment");

    const wp2 = doc.sections[0].blocks.find((block) => block.id === "section-3-wp-2") as Extract<EditorialBlock, { type: "paragraph" }>;
    expect(wp2.content.map((node) => node.text).join("")).not.toMatch(/\s\.\s/);
    const wp3 = doc.sections[0].blocks.find((block) => block.id === "section-3-wp-3") as Extract<EditorialBlock, { type: "paragraph" }>;
    expect(wp3.content).toContainEqual({ type: "link", text: "full guide", href: "/blog/hk-guide", sourceType: "internal" });
    expect(wp3.content.map((node) => node.text).join("")).not.toMatch(/^\s*\./);
  });
});

describe("post-ownership SEO reconciliation preserves protected internal links", () => {
  it("inserting the keyphrase into the first-100 paragraph never deletes an inline link", () => {
    const keyphrase = "threads marketing hong kong";
    const doc = makeDoc(
      [
        linkedParagraph("intro-0", [
          { type: "text", text: "Local teams can share useful lessons every week. Read the " },
          { type: "link", text: "full guide", href: "/blog/threads-guide", sourceType: "internal" },
          { type: "text", text: " before planning the next routine. Regular replies also show customers that a real person is listening to their needs." },
        ]),
        ...Array.from({ length: 24 }, (_, index) =>
          paragraph(`intro-${index + 1}`, "Simple examples help busy owners understand the idea and take a practical next step. Owners can note common questions and turn those questions into helpful future posts. Regular replies also show customers that a real person is listening to their needs."),
        ),
      ],
      keyphrase,
    );
    doc.sections = [
      {
        id: "section-0",
        heading: "Understand the People You Want to Reach",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [paragraph("s0-0", "A clear audience profile helps a small team choose the right conversations. Simple examples help busy owners understand the idea.")],
      },
      {
        id: "section-1",
        heading: "Build a Simple Weekly Content Routine",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [paragraph("s1-0", `Tracking ${keyphrase} helps teams improve. Owners can note common questions and turn those questions into helpful future posts.`)],
      },
      { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", status: "generated", blocks: [] },
    ];
    doc.visibleFaq = [
      { question: "Q1", answerHtml: "", answerText: "Start with a small and useful routine. Listen to real customer questions." },
      { question: "Q2", answerHtml: "", answerText: "Start with a small and useful routine. Listen to real customer questions." },
    ];
    doc.conclusion.blocks = [paragraph("c-0", `A useful ${keyphrase} plan does not need a large team. This approach builds trust slowly.`)];
    doc.metadata.focusKeyphrase = keyphrase;

    const result = reconcilePostOwnershipKeyphrase(doc, keyphrase, [], undefined);

    expect(result.first100KeyphraseRestored).toBe(true);
    const firstBlock = doc.introduction.blocks[0] as Extract<EditorialBlock, { type: "paragraph" }>;
    expect(firstBlock.content).toContainEqual({ type: "link", text: "full guide", href: "/blog/threads-guide", sourceType: "internal" });
    expect(firstBlock.content.map((node) => node.text).join("")).toContain("When it comes to " + keyphrase);
  });
});
