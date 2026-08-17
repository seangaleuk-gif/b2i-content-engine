import { describe, expect, it } from "vitest";
import type { ArticleDocument, ArticleSection } from "@/lib/blog/article-document";
import {
  isSectionTopicGrounded,
  assessHeadingSourceTextRelevance,
  assessSectionTopicGrounding,
} from "@/lib/blog/content-relevance";
import { normalizeTopicToken } from "@/lib/blog/topic-token-normalizer";
import { buildClaimOwnershipLedger, formatOwnedEvidencePacket } from "@/lib/blog/claim-ownership";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";
import { createPipelineState, runSourceRelevanceRepairStage } from "@/lib/pipeline/blog-generation-pipeline";

const HEADING = "Budgeting for 2026: Where to Invest";

function section(blocks: Array<{ id: string; type: "paragraph"; text: string }>): ArticleSection {
  return {
    id: "section-0",
    heading: HEADING,
    headingLevel: 2,
    sectionType: "main",
    status: "generated",
    blocks: blocks.map((block) => ({ id: block.id, type: "paragraph", content: [{ type: "text", text: block.text }] })),
  };
}

function docWith(sectionHtml: string): ArticleDocument {
  const paragraphs = sectionHtml.split("\n\n");
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: "budgeting for 2026" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [section(paragraphs.map((text, index) => ({ id: `b${index}`, type: "paragraph", text })))],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("shared topic-token normalization", () => {
  it("canonicalizes the proven morphological families deterministically", () => {
    expect(normalizeTopicToken("budget")).toBe("budget");
    expect(normalizeTopicToken("budgets")).toBe("budget");
    expect(normalizeTopicToken("budgeting")).toBe("budget");
    expect(normalizeTopicToken("budgeted")).toBe("budget");
    expect(normalizeTopicToken("budgetary")).toBe("budget");
    expect(normalizeTopicToken("invest")).toBe("invest");
    expect(normalizeTopicToken("invests")).toBe("invest");
    expect(normalizeTopicToken("investing")).toBe("invest");
    expect(normalizeTopicToken("invested")).toBe("invest");
    expect(normalizeTopicToken("investment")).toBe("invest");
    expect(normalizeTopicToken("investments")).toBe("invest");
    expect(normalizeTopicToken("spend")).toBe("spend");
    expect(normalizeTopicToken("spends")).toBe("spend");
    expect(normalizeTopicToken("spending")).toBe("spend");
    expect(normalizeTopicToken("spent")).toBe("spend");
    expect(normalizeTopicToken("build")).toBe("build");
    expect(normalizeTopicToken("building")).toBe("build");
    expect(normalizeTopicToken("built")).toBe("build");
    expect(normalizeTopicToken("plan")).toBe("plan");
    expect(normalizeTopicToken("planning")).toBe("plan");
    expect(normalizeTopicToken("planned")).toBe("plan");
    expect(normalizeTopicToken("measure")).toBe("measure");
    expect(normalizeTopicToken("measuring")).toBe("measure");
    expect(normalizeTopicToken("measurement")).toBe("measure");
    expect(normalizeTopicToken("grow")).toBe("grow");
    expect(normalizeTopicToken("growth")).toBe("grow");
    expect(normalizeTopicToken("reach")).toBe("reach");
    expect(normalizeTopicToken("reaching")).toBe("reach");
    expect(normalizeTopicToken("understand")).toBe("understand");
    expect(normalizeTopicToken("understood")).toBe("understand");
  });

  it("never corrupts proper nouns or platform names", () => {
    expect(normalizeTopicToken("Threads")).toBe("threads");
    expect(normalizeTopicToken("Insights")).toBe("insights");
    expect(normalizeTopicToken("Analytics")).toBe("analytics");
    expect(normalizeTopicToken("Instagram")).toBe("instagram");
    expect(normalizeTopicToken("2026")).toBe("2026");
  });

  it("keeps exact-token behaviour for non-family words", () => {
    expect(normalizeTopicToken("monetize")).toBe("monetize");
    expect(normalizeTopicToken("creator")).toBe("creator");
    expect(normalizeTopicToken("audience")).toBe("audience");
  });
});

describe("topic-grounding is morphology-aware", () => {
  it("grounds budget/budgets/budgeting bodies", () => {
    for (const body of [
      "Budgets and costs drive every decision this year.",
      "Smart budgeting keeps the plan focused.",
      "A clear budget avoids waste across every channel.",
    ]) {
      expect(isSectionTopicGrounded(section([{ id: "b0", type: "paragraph", text: body }])), body).toBe(true);
    }
  });

  it("grounds invest/investing/investment/investments bodies", () => {
    for (const body of [
      "Investment in content grows with clear results.",
      "Investing in creators pays off over time.",
      "Companies that invest early see stronger returns.",
    ]) {
      expect(isSectionTopicGrounded(section([{ id: "b0", type: "paragraph", text: body }])), body).toBe(true);
    }
  });

  it("grounds spend/spending/spent bodies", () => {
    const spendSection = (body: string): ArticleSection => ({
      id: "s",
      heading: "Where to Spend Your Budget in 2026",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [{ id: "b", type: "paragraph", content: [{ type: "text", text: body }] }],
    });
    for (const body of [
      "Spending on creators needs a clear plan before launch.",
      "Teams that spend wisely keep the budget healthy.",
      "The amount spent last year guides this year's plan.",
    ]) {
      expect(isSectionTopicGrounded(spendSection(body)), body).toBe(true);
    }
  });

  it("grounds the other safe morphological families for their own headings", () => {
    const headingBodies: Array<[string, string]> = [
      ["Build a Simple Weekly Content Routine", "Building a routine starts with one small habit."],
      ["Plan Your Content Calendar", "Planning the calendar keeps the team steady."],
      ["Measure Campaign Results", "Measuring results shows what actually works."],
      ["Grow Your Local Audience", "Growing an audience takes consistent effort."],
      ["Reach More Customers", "Reaching more customers needs the right channels."],
      ["Understand the People You Want to Reach", "Understanding your audience changes the plan."],
    ];
    for (const [heading, body] of headingBodies) {
      const sec: ArticleSection = {
        id: "s",
        heading,
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [{ id: "b", type: "paragraph", content: [{ type: "text", text: body }] }],
      };
      expect(isSectionTopicGrounded(sec), `${heading} / ${body}`).toBe(true);
    }
  });

  it("a bare 2026 date claim remains ungrounded", () => {
    const body = "The 2026 outlook shapes what teams do next.";
    expect(isSectionTopicGrounded(section([{ id: "b0", type: "paragraph", text: body }]))).toBe(false);
    expect(assessSectionTopicGrounding(docWith(body))).not.toEqual([]);
  });

  it("stop words alone never ground a section", () => {
    const body = "Hong Kong marketing teams guide local brands this year.";
    expect(isSectionTopicGrounded(section([{ id: "b0", type: "paragraph", text: body }]))).toBe(false);
  });

  it("non-family exact-token behaviour is unchanged", () => {
    const body = "Monetization depends on the channel mix chosen by each creator.";
    expect(isSectionTopicGrounded(section([{ id: "b0", type: "paragraph", text: body }]))).toBe(false);
  });
});

describe("source relevance uses the same normalization", () => {
  it("matches budget/budgeting between heading and source", () => {
    const assessment = assessHeadingSourceTextRelevance(
      "Budgeting for 2026: Where to Invest",
      "A guide to budgeting for marketing spend.",
    );
    expect(assessment.relevant).toBe(true);
    expect(assessment.hasSpecificWord).toBe(true);
    expect(assessment.sharedWords).toContain("budget");
  });

  it("keeps generic-only sources irrelevant", () => {
    const assessment = assessHeadingSourceTextRelevance(
      "Budgeting for 2026: Where to Invest",
      "Hong Kong marketing trends for local brands.",
    );
    expect(assessment.relevant).toBe(false);
  });
});

describe("evidence ownership and incidental filtering use shared normalization", () => {
  it("assigns genuine budget evidence to the Budgeting section", () => {
    const ledger = buildClaimOwnershipLedger([
      { id: "section-0", heading: "Budgeting for 2026: Where to Invest", sectionType: "main" },
      { id: "section-1", heading: "Data Privacy and Trust", sectionType: "main" },
    ], [
      {
        title: "Budgeting Guide",
        snippet: "Brands should budget 10% of revenue for creator campaigns.",
        url: "https://example.com/budgeting",
      },
    ]);
    const budgetSection = ledger.entries.find((entry) => entry.ownerSectionId === "section-0");
    expect(budgetSection).toBeDefined();
    expect(budgetSection?.approvedText).toContain("budget");
  });

  it("retains non-quantified budget evidence via shared normalization (no budget wordlist needed)", () => {
    const ledger = buildClaimOwnershipLedger([
      { id: "section-0", heading: "Budgeting for 2026: Where to Invest", sectionType: "main" },
    ], [
      {
        title: "Budgeting Guide",
        snippet: "A clear budgeting process keeps campaigns on track.",
        url: "https://example.com/budgeting",
      },
    ]);
    const packet = formatOwnedEvidencePacket(ledger, "section-0");
    expect(packet).toContain("budgeting process");
  });

  it("still withholds irrelevant event-logistics detail", () => {
    const ledger = buildClaimOwnershipLedger([
      { id: "section-0", heading: "Budgeting for 2026: Where to Invest", sectionType: "main" },
    ], [
      {
        title: "Event Page",
        snippet: "There's no strict dress code, so you can focus on learning rather than what to wear.",
        url: "https://example.com/event",
      },
    ]);
    const packet = formatOwnedEvidencePacket(ledger, "section-0");
    expect(packet).not.toContain("dress code");
  });
});

describe("earliest post-assembly absolute grounding gate", () => {
  function ungroundedDoc(): ArticleDocument {
    return {
      metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: "budgeting for 2026" },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [], status: "generated" },
      sections: [section([{ id: "b0", type: "paragraph", text: "The 2026 outlook shapes what teams do next." }])],
      visibleFaq: [],
      conclusion: { id: "conclusion", blocks: [], status: "generated" },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
  }

  it("fails closed at source-relevance-repair for an ungrounded assembled section (not deferred to final QC)", () => {
    const doc = ungroundedDoc();
    const range = englishWordTolerance(1500);
    const state = createPipelineState({
      userId: "test-user",
      projectId: "grounding-gate",
      keyphrase: "budgeting for 2026",
      requestedWordCount: 1500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 5,
      policy: buildPolicy(1500, range.min, range.max, "budgeting for 2026"),
      ctx: { research: [] },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });
    expect(assessSectionTopicGrounding(doc).length).toBeGreaterThan(0);
    let thrown: Error | null = null;
    try { runSourceRelevanceRepairStage(state, []); } catch (error) { thrown = error as Error; }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("Section topic grounding");
    expect(thrown?.message).toContain("Budgeting for 2026: Where to Invest");
  });
});
