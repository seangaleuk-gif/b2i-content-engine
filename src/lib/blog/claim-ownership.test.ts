import { describe, expect, it } from "vitest";
import {
  type ArticleDocument,
  type EditorialBlock,
  renderComponentHtml,
} from "@/lib/blog/article-document";
import {
  buildClaimOwnershipLedger,
  enforceClaimOwnership,
  evidenceForSection,
  validateClaimOwnership,
} from "./claim-ownership";

const KEYPHRASE = "threads marketing hong kong";
const RESEARCH = [
  {
    title: "Hong Kong Threads audience",
    snippet: "Threads has 2.4 million monthly active users in Hong Kong.",
    url: "https://example.com/audience",
  },
  {
    title: "Threads market awareness growth",
    snippet: "Awareness rose from 36% in 2023 to 66% in 2025 among surveyed Hong Kong respondents.",
    url: "https://example.com/awareness",
  },
];

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function sourceParagraph(id: string): EditorialBlock {
  return {
    id,
    type: "paragraph",
    content: [
      { type: "text", text: "According to the audience study, Threads has 2.4 million monthly active users in Hong Kong (" },
      { type: "link", text: "source", href: RESEARCH[0].url, sourceType: "editorial-external" },
      { type: "text", text: ")." },
    ],
  };
}

function makeDocument(): ArticleDocument {
  return {
    metadata: {
      title: "Threads Marketing Hong Kong Guide",
      slug: "threads-marketing-hong-kong",
      metaDescription: "A practical guide.",
      excerpt: "A practical guide.",
      targetWordCount: 900,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      status: "generated",
      blocks: [
        paragraph(
          "intro-claim",
          "Threads has 2.4 million monthly active users in Hong Kong. This guide explains how a small team can join useful conversations.",
        ),
      ],
    },
    sections: [
      {
        id: "section-audience",
        heading: "Who Uses Threads in Hong Kong",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          sourceParagraph("audience-owned"),
          paragraph(
            "audience-duplicate",
            "Threads has 2.4 million monthly active users in Hong Kong. That audience gives local teams room to test focused conversations.",
          ),
        ],
      },
      {
        id: "section-growth",
        heading: "Market Growth and Awareness",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph(
            "growth-owned",
            "Among surveyed Hong Kong respondents, awareness rose from 36% in 2023 to 66% in 2025.",
          ),
        ],
      },
      {
        id: "faq",
        heading: "Frequently Asked Questions",
        headingLevel: 2,
        sectionType: "faq-heading",
        status: "generated",
        blocks: [],
      },
    ],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: [paragraph("conclusion-copy", "Start with one useful topic and improve it from real replies.")],
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("Claim Ownership Ledger", () => {
  it("assigns each approved research sentence to exactly one main section", () => {
    const doc = makeDocument();
    const ledger = buildClaimOwnershipLedger(doc.sections, RESEARCH);

    expect(ledger.entries).toHaveLength(2);
    expect(new Set(ledger.entries.map((entry) => entry.evidenceId)).size).toBe(2);
    expect(evidenceForSection(ledger, "section-audience").map((entry) => entry.evidenceId))
      .toContain("SOURCE-1-CLAIM-1");
    expect(evidenceForSection(ledger, "section-growth").map((entry) => entry.evidenceId))
      .toContain("SOURCE-2-CLAIM-1");
    expect(evidenceForSection(ledger, "intro")).toEqual([]);
  });

  it("removes out-of-owner and duplicate occurrences while keeping the strongest owned sentence", () => {
    const doc = makeDocument();
    const ledger = buildClaimOwnershipLedger(doc.sections, RESEARCH);
    const result = enforceClaimOwnership(doc, ledger, KEYPHRASE, RESEARCH);

    expect(result.unresolved).toEqual([]);
    expect(result.removedOutOfOwnerOccurrences).toBeGreaterThanOrEqual(1);
    expect(result.removedDuplicateOccurrences).toBeGreaterThanOrEqual(1);
    expect(result.changedComponentIds).toEqual(expect.arrayContaining(["intro", "section-audience"]));
    expect(renderComponentHtml(doc.introduction)).not.toContain("2.4 million");
    expect(renderComponentHtml(doc.introduction)).toContain("This guide explains");
    expect(renderComponentHtml(doc.sections[0])).toContain(RESEARCH[0].url);
    expect(renderComponentHtml(doc.sections[0]).match(/2\.4 million/g)).toHaveLength(1);
    expect(validateClaimOwnership(doc, ledger, KEYPHRASE, RESEARCH)).toEqual([]);
  });

  it("reports ownership violations without silently repairing the final candidate", () => {
    const doc = makeDocument();
    const ledger = buildClaimOwnershipLedger(doc.sections, RESEARCH);
    const violations = validateClaimOwnership(doc, ledger, KEYPHRASE, RESEARCH);

    expect(violations.some((violation) => violation.reason === "outside-owner")).toBe(true);
    expect(violations.some((violation) => violation.reason === "duplicate-owned-occurrence")).toBe(true);
  });
});
