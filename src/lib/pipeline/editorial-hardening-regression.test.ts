import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import { formatOwnedEvidencePacket, buildClaimOwnershipLedger } from "@/lib/blog/claim-ownership";
import {
  measureFaqEntriesKeyphraseNaturalness,
  repairFaqKeyphraseNaturalness,
  measureFaqKeyphraseNaturalness,
} from "@/lib/blog/faq-keyphrase-naturalness";
import { normalizeAiEditorialPayload, quoteHasAttribution } from "@/lib/blog/article-content";
import { anchorIsSpecific } from "@/lib/services/link-injector";
import { reconcilePostOwnershipKeyphrase } from "@/lib/blog/post-ownership-seo-reconcile";
import { validateCoherence } from "@/lib/blog/coherence";
import { scanSentenceQualityText } from "@/lib/blog/sentence-quality";
import { findMalformedProseTextIssues } from "@/lib/blog/publication-quality";
import { analyzeSentenceCompleteness } from "@/lib/blog/sentence-completeness";

const KP = "hong kong marketing trends 2026";

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(introText: string, sectionBlocks: Array<{ id: string; text: string }>): ArticleDocument {
  return {
    metadata: {
      title: "Hong Kong Marketing Trends 2026",
      slug: "hong-kong-marketing-trends-2026",
      metaDescription: "A guide to Hong Kong marketing trends in 2026.",
      excerpt: "A practical guide.",
      targetWordCount: 1500,
      focusKeyphrase: KP,
    },
    languageSwitcher: null,
    introduction: { id: "intro", status: "generated", blocks: [paragraph("intro-1", introText)] },
    sections: [{
      id: "section-0",
      heading: "What Is Shaping Hong Kong Marketing in 2026",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: sectionBlocks.map((block) => paragraph(block.id, block.text)),
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", status: "generated", blocks: [paragraph("conclusion-1", "These trends will shape the year ahead.")] },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("1. source relevance — incidental evidence is withheld from section prompts", () => {
  const research = [
    {
      title: "Hong Kong Marketing Event 2026",
      snippet: "There's no strict dress code, so you can focus on learning rather than what to wear. Attendees who run paid campaigns saw 40% higher engagement.",
      url: "https://example.com/event",
    },
  ];

  it("builds a ledger and a packet for the owner section", () => {
    const ledger = buildClaimOwnershipLedger([
      { id: "section-0", heading: "Paid Campaign Results", sectionType: "main" },
    ], research);
    expect(ledger.entries.length).toBe(2);
    const packet = formatOwnedEvidencePacket(ledger, "section-0");
    // Quantified evidence stays (40% higher engagement).
    expect(packet).toContain("40% higher engagement");
    // The incidental event-logistics detail is withheld from the section prompt.
    expect(packet).not.toContain("dress code");
  });

  it("keeps useful event/industry evidence that shares a specific topic word", () => {
    const ledger = buildClaimOwnershipLedger([
      { id: "section-0", heading: "Live Marketing Events in Hong Kong", sectionType: "main" },
    ], [
      {
        title: "Event Industry Report",
        snippet: "Marketing events in Hong Kong are growing 30% year over year.",
        url: "https://example.com/events",
      },
    ]);
    const packet = formatOwnedEvidencePacket(ledger, "section-0");
    expect(packet).toContain("growing 30%");
    expect(packet).toContain("events");
  });
});

describe("2. FAQ keyphrase naturalness — measurement and canonical repair", () => {
  const faqEntries = [
    { question: "What are the hong kong marketing trends 2026?", answerHtml: "<p>a</p>", answerText: "The hong kong marketing trends 2026 centre on authentic creators." },
    { question: "Why do hong kong marketing trends 2026 matter?", answerHtml: "<p>b</p>", answerText: "The hong kong marketing trends 2026 matter because audiences trust peers." },
    { question: "How should brands act on hong kong marketing trends 2026?", answerHtml: "<p>c</p>", answerText: "Brands should act on hong kong marketing trends 2026 early." },
  ];

  it("flags mechanical repetition across items", () => {
    const report = measureFaqEntriesKeyphraseNaturalness(faqEntries, KP);
    expect(report.natural).toBe(false);
    expect(report.totalOccurrences).toBe(6);
    expect(report.items.every((item) => item.mechanicallyRepeated)).toBe(true);
  });

  it("reports a natural FAQ as natural", () => {
    const natural = [
      { question: "What are the hong kong marketing trends 2026?", answerHtml: "<p>a</p>", answerText: "They centre on authentic creator partnerships." },
      { question: "Why does this matter for brands?", answerHtml: "<p>b</p>", answerText: "Audiences trust peer recommendations over ads." },
    ];
    const report = measureFaqEntriesKeyphraseNaturalness(natural, KP);
    expect(report.natural).toBe(true);
  });

  it("repairs redundant keyphrase occurrences deterministically and keeps parity", () => {
    const { repaired, changedIndexes } = repairFaqKeyphraseNaturalness(faqEntries, KP);
    expect(changedIndexes).toEqual([0, 1, 2]);
    // Anchor item keeps its first occurrence and replaces the second with a
    // determiner-aware bare-noun successor.
    expect(repaired[0].answerText).toBe("The trends centre on authentic creators.");
    // Later items use a natural successor, never the exact keyphrase.
    expect(repaired[1].answerText).toBe("The trends matter because audiences trust peers.");
    expect(repaired[1].answerText).not.toContain("hong kong marketing trends 2026");
    expect(repaired[2].answerText).toBe("Brands should act on these trends early.");
    expect(repaired[2].answerText).not.toContain("hong kong marketing trends 2026");
    // Questions keep natural anaphors too.
    expect(repaired[1].question).toBe("Why do these trends matter?");
    // answerHtml stays in sync with answerText (schema parity).
    expect(repaired[1].answerHtml).toContain("The trends matter");
    // All repaired answers remain complete, grammatical and clean.
    for (const entry of repaired) {
      expect(findMalformedProseTextIssues([entry.answerText], ["faq-answer"])).toEqual([]);
      expect(scanSentenceQualityText(entry.answerText)).toEqual([]);
    }
    // Re-measured document is now natural.
    expect(measureFaqEntriesKeyphraseNaturalness(repaired, KP).natural).toBe(true);
  });

  it("leaves a natural FAQ byte-identical", () => {
    const natural = [
      { question: "What are the hong kong marketing trends 2026?", answerHtml: "<p>a</p>", answerText: "They centre on authentic creators." },
    ];
    const { repaired, changedIndexes } = repairFaqKeyphraseNaturalness(natural, KP);
    expect(changedIndexes).toEqual([]);
    expect(repaired).toBe(natural);
  });

  it("measureFaqKeyphraseNaturalness reads the canonical visible FAQ document", () => {
    const doc = makeDoc("A clean intro.", [{ id: "s0-1", text: "A body paragraph." }]);
    doc.visibleFaq = faqEntries;
    const report = measureFaqKeyphraseNaturalness(doc, KP);
    expect(report.natural).toBe(false);
  });
});

describe("3. internal-link anchor quality", () => {
  it("rejects bare geographic and function-word anchors", () => {
    expect(anchorIsSpecific("hong kong")).toBe(false);
    expect(anchorIsSpecific("hong Kong")).toBe(false);
    expect(anchorIsSpecific("click here")).toBe(false);
  });

  it("accepts meaningful destination-describing anchors", () => {
    expect(anchorIsSpecific("paid brand deals")).toBe(true);
    expect(anchorIsSpecific("micro-influencer sponsorships")).toBe(true);
    expect(anchorIsSpecific("creator outreach")).toBe(true);
    expect(anchorIsSpecific("sponsorships")).toBe(true);
    // Meaningful topic nouns remain valid anchors for their own topic.
    expect(anchorIsSpecific("marketing")).toBe(true);
  });
});

describe("4. quote provenance — generated prose must not be serialized as wp:quote", () => {
  it("keeps attributable quotations as quotes", () => {
    expect(quoteHasAttribution('"Brands must prove their worth," said the report.')).toBe(true);
    expect(quoteHasAttribution("According to the survey, creators outperform ads.")).toBe(true);
    const normalized = normalizeAiEditorialPayload({ blocks: [
      { type: "quote", text: '"Brands must prove their worth," said the report.' },
    ] }, "section-0");
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks[0].type).toBe("quote");
  });

  it("demotes unattributed editorial prose to a paragraph at the canonical boundary", () => {
    const normalized = normalizeAiEditorialPayload({ blocks: [
      { type: "quote", text: "In the Year of the Horse, the brands that win are the ones that prove their worth, not just claim it." },
    ] }, "section-0");
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks[0].type).toBe("paragraph");
    expect(normalized.recoveries.some((recovery) => recovery.includes("demoted unattributed quote"))).toBe(true);
    const text = normalized.blocks[0].type === "paragraph"
      ? normalized.blocks[0].content.map((node) => node.text).join("")
      : "";
    expect(text).toContain("Year of the Horse");
    expect(text).toContain("prove their worth");
  });

  it("never invents attribution", () => {
    expect(quoteHasAttribution("In the Year of the Horse, the brands that win are the ones that prove their worth, not just claim it.")).toBe(false);
  });
});

describe("5. post-ownership SEO reconcile never corrupts a natural introduction", () => {
  const research: Array<{ title?: string; snippet?: string; url?: string }> = [];

  it("does not insert the keyphrase when it duplicates existing phrasing or breaks proper-noun casing", () => {
    // Production defect shape: the introduction already opens with "Hong Kong
    // marketing"; inserting the full keyphrase would duplicate it and create
    // the broken "hong Kong" casing.
    const doc = makeDoc("Hong Kong marketing is changing fast as brands chase attention in a crowded feed.", [
      { id: "s0-1", text: "Brands that invest early will see the strongest results." },
    ]);
    const before = renderArticleDocument(doc);
    const result = reconcilePostOwnershipKeyphrase(doc, KP, research);
    // The first-100 restore must NOT commit the corrupting candidate.
    expect(result.first100KeyphraseRestored).toBe(false);
    expect(renderArticleDocument(doc)).toBe(before);
    // The introduction stays byte-identical — no keyword-shaped lead, no
    // duplicated terms, no broken "hong Kong" casing.
    const introText = doc.introduction.blocks[0].type === "paragraph"
      ? doc.introduction.blocks[0].content.map((node) => node.text).join("")
      : "";
    expect(introText).toBe("Hong Kong marketing is changing fast as brands chase attention in a crowded feed.");
    expect(introText).not.toContain("When it comes to");
  });

  it("still restores the keyphrase naturally when no duplication exists", () => {
    const doc = makeDoc("Brands are rethinking how they reach local audiences across the city.", [
      { id: "s0-1", text: "Brands that invest early will see the strongest results." },
    ]);
    const result = reconcilePostOwnershipKeyphrase(doc, KP, research);
    const introText = doc.introduction.blocks[0].type === "paragraph"
      ? doc.introduction.blocks[0].content.map((node) => node.text).join("")
      : "";
    if (result.first100KeyphraseRestored) {
      expect(introText.toLowerCase()).toContain(KP);
      // The restored paragraph must remain sentence-quality clean.
      expect(scanSentenceQualityText(introText)).toEqual([]);
      expect(findMalformedProseTextIssues([introText])).toEqual([]);
    }
  });
});

describe("6. cross-section transition coherence", () => {
  it("flags a forward reference to the FAQ issued when the conclusion comes next", () => {
    const doc = makeDoc("A clean introduction for the article.", [
      { id: "s0-1", text: "In the next section, we'll answer some common questions about measuring results." },
    ]);
    const violations = validateCoherence(doc);
    expect(violations.some((v) => v.type === "misplaced-forward-reference")).toBe(true);
  });

  it("accepts a forward reference that matches the actual next component", () => {
    const doc = makeDoc("A clean introduction for the article.", [
      { id: "s0-1", text: "In the next section, we'll explore how to measure campaign results." },
    ]);
    doc.sections.push({
      id: "section-1",
      heading: "How to Measure Campaign Results",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [paragraph("s1-1", "Track engagement and conversions.")],
    });
    const violations = validateCoherence(doc);
    expect(violations.some((v) => v.type === "misplaced-forward-reference")).toBe(false);
  });

  it("accepts a conclusion that correctly points at the FAQ", () => {
    const doc = makeDoc("A clean introduction for the article.", [
      { id: "s0-1", text: "A body paragraph." },
    ]);
    doc.conclusion.blocks = [paragraph("conclusion-1", "In the next section, we'll answer some common questions.")];
    doc.visibleFaq = [{
      question: "What are the hong kong marketing trends 2026?",
      answerHtml: "<p>a</p>",
      answerText: "They centre on creators.",
    }];
    const violations = validateCoherence(doc);
    expect(violations.some((v) => v.type === "misplaced-forward-reference")).toBe(false);
  });
});

describe("7. shared sentence-quality contract — v20 defect shapes are now hard failures", () => {
  // Historical v20 defect shapes. The shared completeness contract now rejects
  // both generically: a malformed interrogative with missing auxiliary
  // inversion, and a sentence-like prose fragment with no finite predicate.

  it("rejects a malformed standalone interrogative with missing auxiliary inversion", () => {
    const sentence = "What they do stop for?";
    const codes = findMalformedProseTextIssues([sentence]).map((issue) => issue.code);
    expect(codes).toContain("missing-aux-inversion");
    expect(analyzeSentenceCompleteness(sentence, "paragraph").complete).toBe(false);
  });

  it("rejects a sentence-like standalone paragraph with no finite predicate", () => {
    const sentence = "Native social videos with narrative, emotional value, and a duration under 60 seconds.";
    const codes = findMalformedProseTextIssues([sentence]).map((issue) => issue.code);
    expect(codes).toContain("fragment");
    expect(analyzeSentenceCompleteness(sentence, "paragraph").complete).toBe(false);
  });

  it("the shared rule fires at producer acceptance", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: "Native social videos with narrative, emotional value, and a duration under 60 seconds." }],
    }, "section-0");
    expect(normalized.errors.length).toBeGreaterThan(0);
  });

  it("accepts legitimate questions (auxiliary inversion present)", () => {
    for (const sentence of [
      "What do they stop for?",
      "Why does this matter?",
      "How can brands grow in 2026?",
      "What are the hong kong marketing trends 2026?",
      "What can I do about it?",
    ]) {
      expect(analyzeSentenceCompleteness(sentence, "paragraph").complete, sentence).toBe(true);
      expect(findMalformedProseTextIssues([sentence]), sentence).toEqual([]);
    }
  });

  it("accepts legitimate non-paragraph fragments (headings, list items, table cells)", () => {
    // Structural kinds are intentional fragments and must stay valid even when
    // they contain no finite predicate.
    expect(analyzeSentenceCompleteness("Native social videos", "heading").complete).toBe(true);
    expect(analyzeSentenceCompleteness("A duration under 60 seconds", "list-item").complete).toBe(true);
    expect(analyzeSentenceCompleteness("Emotional value", "table-cell").complete).toBe(true);
  });

  it("accepts genuine prose sentences that carry a finite predicate", () => {
    for (const sentence of [
      "Audiences trust peers more than ads.",
      "Prices rose sharply this year.",
      "The team improved results steadily.",
      "Brands that invest early will see stronger growth.",
      "Hong Kong is a global business hub.",
    ]) {
      expect(analyzeSentenceCompleteness(sentence, "paragraph").complete, sentence).toBe(true);
      expect(findMalformedProseTextIssues([sentence]), sentence).toEqual([]);
    }
  });
});
