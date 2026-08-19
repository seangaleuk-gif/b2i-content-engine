// ── Stage 3M: factual-surface ownership regressions ──
// Proves the structured factual scanner: every legitimate claim owns a precise
// canonical surface (editorial block or editorial H2 heading, never "-/-"),
// temporal year framing in headings is exempt, genuine heading assertions stay
// subject to normal factual rules, and body cleanup + heading framing produces
// zero unresolved claims.

import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  scanUnsupportedClaimsInDocument,
  removeUnsupportedSentences,
  type LocatedUnsupportedClaim,
} from "@/lib/blog/factual-risk-scanner";
import { renderEditorialBlocksToWordPress } from "@/lib/blog/article-document";
import type { ArticleDocument, ArticleComponent, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";

const KEYPHRASE = "beauty salon marketing";

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(opts: {
  introText?: string;
  heading?: string;
  sectionText?: string;
  secondHeading?: string;
  secondSectionText?: string;
  conclusionText?: string;
} = {}): ArticleDocument {
  const intro: ArticleComponent = {
    id: "intro",
    status: "normalized",
    blocks: [paragraphBlock("intro-p0", opts.introText ?? "Introduction one. Introduction two.")],
  };
  const sections: ArticleSection[] = [
    {
      id: "section-0",
      heading: opts.heading ?? "Hong Kong Beauty Salon Marketing",
      headingLevel: 2,
      sectionType: "main",
      status: "normalized",
      blocks: [paragraphBlock("section-0-wp-0", opts.sectionText ?? "Section one. Section two.")],
    },
  ];
  if (opts.secondHeading) {
    sections.push({
      id: "section-1",
      heading: opts.secondHeading,
      headingLevel: 2,
      sectionType: "main",
      status: "normalized",
      blocks: [paragraphBlock("section-1-wp-0", opts.secondSectionText ?? "Second section one.")],
    });
  }
  const conclusion: ArticleComponent = {
    id: "conclusion",
    status: "normalized",
    blocks: [paragraphBlock("conclusion-p0", opts.conclusionText ?? "Conclusion one. Conclusion two.")],
  };
  return {
    metadata: { title: "Title", slug: "t", metaDescription: "Meta.", excerpt: "Excerpt.", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: null,
    introduction: intro,
    sections,
    visibleFaq: [],
    conclusion,
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function claimsOf(doc: ArticleDocument): LocatedUnsupportedClaim[] {
  return scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
}

describe("Stage 3M: temporal year framing in headings is not an unsupported claim", () => {
  it("exempts framing headings with a bare year", () => {
    for (const heading of [
      "Hong Kong Beauty Salon Marketing in 2026",
      "Beauty Marketing Strategies for 2026",
      "Planning Your 2026 Marketing Strategy",
    ]) {
      const doc = makeDoc({ heading, sectionText: "Section one. Section two. Section three." });
      const claims = claimsOf(doc);
      expect(claims, heading).toEqual([]);
    }
  });

  it("same year in factual prose remains unsupported without evidence", () => {
    const doc = makeDoc({ introText: "The market grew in 2026, according to local reports." });
    const claims = claimsOf(doc);
    expect(claims.some((c) => c.category === "date_claim" && c.text === "2026")).toBe(true);
    expect(claims.some((c) => c.componentId === "intro" && c.blockId === "intro-p0")).toBe(true);
  });
});

describe("Stage 3M: genuine heading assertions stay subject to factual rules", () => {
  it("quantitative factual H2 is located to the exact heading/component", () => {
    const doc = makeDoc({ heading: "2026 sales reached HK$10 million" });
    const claims = claimsOf(doc);
    const headingClaims = claims.filter((c) => c.surfaceType === "editorial-heading");
    expect(headingClaims.length).toBeGreaterThan(0);
    expect(headingClaims.some((c) => c.category === "currency_amount")).toBe(true);
    for (const claim of headingClaims) {
      expect(claim.componentId).toBe("section-0");
      expect(claim.blockId).toBe("section-0-heading");
    }
    expect(headingClaims.some((c) => c.componentId === "-" || c.blockId === "-")).toBe(false);
  });

  it("unsupported market-wide H2 remains rejected (assertive signal, not framing)", () => {
    const doc = makeDoc({ heading: "The market grew in 2026" });
    const claims = claimsOf(doc);
    const headingClaims = claims.filter((c) => c.surfaceType === "editorial-heading");
    expect(headingClaims.length).toBeGreaterThan(0);
    expect(headingClaims[0].blockId).toBe("section-0-heading");
  });

  it("percentage assertion inside a heading keeps its normal factual rule", () => {
    const doc = makeDoc({ heading: "Customers spent 20% more in 2026" });
    const claims = claimsOf(doc);
    const headingClaims = claims.filter((c) => c.surfaceType === "editorial-heading");
    expect(headingClaims.some((c) => c.category === "percentage")).toBe(true);
    expect(headingClaims.some((c) => c.category === "date_claim")).toBe(true);
  });
});

describe("Stage 3M: body cleanup + heading framing parity", () => {
  it("removing body claims leaves zero unresolved claims when the only heading content is year framing", () => {
    const doc = makeDoc({
      introText: "Beauty salon marketing evolves quickly in 2026.",
      heading: "Hong Kong Beauty Salon Marketing in 2026",
      sectionText: "Interruptive ads no longer work on their own in 2026.",
    });
    expect(claimsOf(doc).length).toBeGreaterThan(0);

    // Cleanup producer pass over the same component surfaces.
    const introHtml = renderEditorialBlocksToWordPress(doc.introduction.blocks);
    const sectionHtml = renderEditorialBlocksToWordPress(doc.sections[0].blocks);
    const introUnsupported = scanFactualRisks(introHtml, KEYPHRASE, []).claims.filter((c) => !c.supported);
    const sectionUnsupported = scanFactualRisks(sectionHtml, KEYPHRASE, []).claims.filter((c) => !c.supported);
    const introClean = removeUnsupportedSentences(introHtml, introUnsupported).html;
    const sectionClean = removeUnsupportedSentences(sectionHtml, sectionUnsupported).html;

    const cleanedDoc = structuredClone(doc);
    cleanedDoc.introduction.blocks = [paragraphBlock("intro-p0", visibleText(introClean))];
    cleanedDoc.sections[0].blocks = [paragraphBlock("section-0-wp-0", visibleText(sectionClean))];
    expect(claimsOf(cleanedDoc)).toEqual([]);
  });

  it("no legitimate claim can return component/block '-' after structured scanning", () => {
    const doc = makeDoc({
      introText: "Local salons saw 85% more bookings in 2026.",
      heading: "The market grew in 2026",
      sectionText: "Prices rose to HK$600 for a premium treatment in 2026.",
      conclusionText: "Teams report 42% higher retention in 2026.",
    });
    const claims = claimsOf(doc);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.componentId, claim.text).not.toBe("-");
      expect(claim.blockId, claim.text).not.toBe("-");
      expect(["editorial-block", "editorial-heading"]).toContain(claim.surfaceType);
    }
    // The market-wide heading claim is located at the heading, not the body.
    expect(claims.some((c) => c.surfaceType === "editorial-heading" && c.category === "date_claim")).toBe(true);
  });
});

describe("Stage 3M: exact beauty-salon structural shape", () => {
  it("intro 2026 + section 2026 + market claim + framing heading → zero unresolved after body cleanup", () => {
    const doc = makeDoc({
      introText: "2026 is a decisive year for Hong Kong beauty salons.",
      heading: "Hong Kong Beauty Salon Marketing in 2026",
      sectionText: "Interruptive ads no longer work on their own in 2026.",
    });
    const before = claimsOf(doc);
    expect(before.some((c) => c.componentId === "intro" && c.category === "date_claim")).toBe(true);
    expect(before.some((c) => c.componentId === "section-0" && c.category === "market_wide_claim")).toBe(true);
    expect(before.some((c) => c.componentId === "-" || c.blockId === "-")).toBe(false);

    const introHtml = renderEditorialBlocksToWordPress(doc.introduction.blocks);
    const sectionHtml = renderEditorialBlocksToWordPress(doc.sections[0].blocks);
    const introClean = removeUnsupportedSentences(
      introHtml,
      scanFactualRisks(introHtml, KEYPHRASE, []).claims.filter((c) => !c.supported),
    ).html;
    const sectionClean = removeUnsupportedSentences(
      sectionHtml,
      scanFactualRisks(sectionHtml, KEYPHRASE, []).claims.filter((c) => !c.supported),
    ).html;

    const cleanedDoc = structuredClone(doc);
    cleanedDoc.introduction.blocks = [paragraphBlock("intro-p0", visibleText(introClean))];
    cleanedDoc.sections[0].blocks = [paragraphBlock("section-0-wp-0", visibleText(sectionClean))];

    // The body claims are gone and the framing heading is exempt: no
    // unresolved claims survive cleanup (the original failure shape).
    expect(visibleText(introClean)).not.toContain("2026");
    expect(visibleText(sectionClean)).not.toContain("2026");
    expect(visibleText(sectionClean)).not.toContain("no longer");
    expect(claimsOf(cleanedDoc)).toEqual([]);
  });
});

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
