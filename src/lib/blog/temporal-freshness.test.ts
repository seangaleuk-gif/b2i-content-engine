import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "./article-document";
import { renderComponentHtml } from "./article-document";
import { repairTemporalFreshnessDocument, scanTemporalFreshness } from "./temporal-freshness";

const REFERENCE_DATE = new Date("2026-07-30T00:00:00Z");

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(text: string): ArticleDocument {
  return {
    metadata: {
      title: "Threads Marketing Hong Kong Guide",
      slug: "threads-marketing-hong-kong",
      metaDescription: "A practical guide.",
      excerpt: "A practical guide.",
      targetWordCount: 1000,
      focusKeyphrase: "threads marketing hong kong",
    },
    languageSwitcher: null,
    introduction: { id: "intro", status: "generated", blocks: [paragraph("intro-1", text)] },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", status: "generated", blocks: [] },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("temporal freshness gate", () => {
  it("allows dated historical facts", () => {
    const issues = scanTemporalFreshness(
      "Awareness increased from 36% in 2023 to 66% by Q1 2025.",
      REFERENCE_DATE,
    );
    expect(issues).toHaveLength(0);
  });

  it("allows explicitly historical reporting of an old forecast", () => {
    const issues = scanTemporalFreshness(
      "At the time, advertising features were expected to expand later in 2025.",
      REFERENCE_DATE,
    );
    expect(issues).toHaveLength(0);
  });

  it("rejects an expired prediction presented as current guidance", () => {
    const issues = scanTemporalFreshness(
      "Advertising features are expected to expand later in 2025.",
      REFERENCE_DATE,
    );
    expect(issues.some((issue) => issue.type === "expired_prediction" || issue.type === "ambiguous_relative_future")).toBe(true);
  });

  it("rejects unanchored relative future language", () => {
    const issues = scanTemporalFreshness(
      "More advertising tools are coming later this year.",
      REFERENCE_DATE,
    );
    expect(issues.some((issue) => issue.type === "ambiguous_relative_future")).toBe(true);
  });


  it("rejects an expired Traditional Chinese prediction", () => {
    const issues = scanTemporalFreshness(
      "廣告功能預計於2025年稍後擴展。",
      REFERENCE_DATE,
    );
    expect(issues.some((issue) => issue.type === "expired_prediction" || issue.type === "ambiguous_relative_future")).toBe(true);
  });

  it("allows a valid current status with a historical launch date", () => {
    const issues = scanTemporalFreshness(
      "Threads廣告於2025年推出，目前已可透過Meta Ads Manager購買。",
      REFERENCE_DATE,
    );
    expect(issues).toHaveLength(0);
  });

  it("allows explicitly historical Traditional Chinese forecasts", () => {
    const issues = scanTemporalFreshness(
      "當時市場曾預計廣告功能會在2025年稍後擴展。",
      REFERENCE_DATE,
    );
    expect(issues).toHaveLength(0);
  });

  it("repairs stale metadata without removing valid historical facts", () => {
    const doc = makeDoc("A current body paragraph without stale language.");
    doc.metadata.metaDescription = "A practical guide for SMEs. Advertising tools are expected to expand later in 2025.";
    const result = repairTemporalFreshnessDocument(doc, REFERENCE_DATE);

    expect(result.removedSentences).toBe(1);
    expect(doc.metadata.metaDescription).toBe("A practical guide for SMEs.");
    expect(result.unresolved).toHaveLength(0);
  });


  it("removes only the stale predictive clause from the supplied 2025 sentence", () => {
    const doc = makeDoc(
      "With the platform's user base still growing and advertising features expected to expand later in 2025, getting your profile ready now positions you ahead of the curve.",
    );
    const result = repairTemporalFreshnessDocument(doc, REFERENCE_DATE);
    const html = renderComponentHtml(doc.introduction);

    expect(result.rewrittenSentences).toBe(1);
    expect(result.removedSentences).toBe(0);
    expect(result.unresolved).toHaveLength(0);
    expect(html).toContain(
      "With the platform&#39;s user base still growing, getting your profile ready now positions you ahead of the curve.",
    );
    expect(html).not.toContain("expected to expand later in 2025");
  });

  it("leaves linked stale wording unresolved instead of flattening or deleting the link", () => {
    const doc = makeDoc("Temporary text");
    doc.introduction.blocks = [{
      id: "intro-linked",
      type: "paragraph",
      content: [
        { type: "link", text: "Advertising features are expected to expand later in 2025", href: "https://example.com" },
        { type: "text", text: "." },
      ],
    }];

    const result = repairTemporalFreshnessDocument(doc, REFERENCE_DATE);
    const html = renderComponentHtml(doc.introduction);

    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("expected to expand later in 2025");
  });

  it("removes the expired sentence before editorial polish", () => {
    const doc = makeDoc(
      "Threads gives SMEs another place to build relationships. Advertising features are expected to expand later in 2025. Start by testing useful conversations.",
    );
    const result = repairTemporalFreshnessDocument(doc, REFERENCE_DATE);
    const html = renderComponentHtml(doc.introduction);

    expect(result.removedSentences).toBe(1);
    expect(result.unresolved).toHaveLength(0);
    expect(html).not.toContain("expected to expand later in 2025");
    expect(html).toContain("Threads gives SMEs another place");
    expect(html).toContain("Start by testing useful conversations");
  });
});
