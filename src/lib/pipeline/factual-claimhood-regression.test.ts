// ── Stage 3S: factual claim decomposition / claimhood regressions ──
// The strengthened entailment verifier proved the decomposition layer feeds it
// invalid or meaning-altered claim units. A bare "2026" in topic/heading scope
// was emitted as an atomic date claim (cleanup rollback in section-0), and
// "widely seen as the best retail channel" ALSO produced the stronger absolute
// "the best retail channel". These tests prove claimhood lives at EXTRACTION:
// non-claims and qualifier-dropped decompositions never enter the unsupported
// set, while genuine year assertions, absolutely-asserted superlatives and
// every material-part entailment rule keep their fail-closed behaviour.

import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  scanUnsupportedClaimsInDocument,
  removeUnsupportedSentences,
  type ScannedClaim,
} from "@/lib/blog/factual-risk-scanner";
import {
  renderEditorialBlocksToWordPress,
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
} from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong retail marketing";

const articleWith = (sentence: string) =>
  `<!-- wp:paragraph -->\n<p>${sentence}</p>\n<!-- /wp:paragraph -->`;

function claimsFor(sentence: string, research: Array<{ title: string; snippet: string }> = []) {
  return scanFactualRisks(articleWith(sentence), KEYPHRASE, research).claims;
}

function dateClaims(sentence: string): ScannedClaim[] {
  return claimsFor(sentence).filter((claim) => claim.category === "date_claim");
}

function marketWideClaims(sentence: string): ScannedClaim[] {
  return claimsFor(sentence).filter((claim) => claim.category === "market_wide_claim");
}

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(opts: {
  introText?: string;
  heading?: string;
  sectionText?: string;
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
      heading: opts.heading ?? "The Shape of the Market in 2026",
      headingLevel: 2,
      sectionType: "main",
      status: "normalized",
      blocks: [paragraphBlock("section-0-wp-0", opts.sectionText ?? "Section one. Section two.")],
    },
  ];
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

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 1. Bare year in topic/heading/document scope is not a claim ──

describe("claimhood: bare year is temporal scope, not an atomic claim", () => {
  it.each([
    "The Shape of the Market in 2026",
    "Our 2026 guide to Hong Kong retail marketing",
    "Hong Kong Marketing Trends 2026",
    "Hong Kong Retail in 2026: What to Expect",
    "Marketing Strategies for 2026",
    "Planning Your 2026 Marketing Strategy",
    "2026 Hong Kong Retail Forecast",
    "2026: The Year of Retail",
  ])("does not emit a date claim from topic/document scope: %s", (sentence) => {
    expect(dateClaims(sentence), sentence).toEqual([]);
  });

  it("does not emit a date claim from a heading that merely names the topic", () => {
    const doc = makeDoc({
      heading: "The Shape of the Market in 2026",
      sectionText: "Section one. Section two. Section three.",
    });
    const claims = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    expect(claims.some((claim) => claim.category === "date_claim")).toBe(false);
  });

  it("does not emit a date claim from an imperative or a question", () => {
    expect(dateClaims("Plan ahead for 2026 and start testing early.")).toEqual([]);
    expect(dateClaims("Expect more from your retail marketing in 2026.")).toEqual([]);
    expect(dateClaims("What does 2026 hold for Hong Kong retailers?")).toEqual([]);
    expect(dateClaims("Why 2026 matters for local shops.")).toEqual([]);
  });

  it("does not emit a date claim when the year modifies a noun even with a finite verb", () => {
    expect(dateClaims("The 2026 guide covers Hong Kong retail marketing basics.")).toEqual([]);
    expect(dateClaims("Our 2026 guide shows local shops how to adapt.")).toEqual([]);
  });

  it("does not emit a date claim from an in-report reference", () => {
    expect(dateClaims("We covered this in the 2026 report on Hong Kong retail.")).toEqual([]);
  });
});

// ── 2. A genuine proposition containing a year is still extracted ──

describe("claimhood: genuine year assertions are still claims", () => {
  it("extracts the year from a full assertion (subject + predicate + quantity + temporal)", () => {
    const claims = dateClaims("Hong Kong retail sales rose 6.5% in 2026.");
    expect(claims.some((claim) => claim.text === "2026")).toBe(true);
  });

  it("extracts the year from a dated monthly/quarterly assertion", () => {
    expect(dateClaims("Sales rose 6.5% in March 2026.").some((c) => c.text === "2026")).toBe(true);
    expect(dateClaims("Sales rose 6.5% during Q1 2026.").some((c) => c.text === "2026")).toBe(true);
    expect(dateClaims("Sales rose 6.5% by early 2026.").some((c) => c.text === "2026")).toBe(true);
  });

  it("extracts a clause-subject year followed by a predicate", () => {
    expect(dateClaims("2026 marks the launch of Threads ads in Hong Kong.").some((c) => c.text === "2026")).toBe(true);
    expect(dateClaims("So 2026 will see record retail sales.").some((c) => c.text === "2026")).toBe(true);
  });

  it("extracts a year in a modalised assertion", () => {
    expect(dateClaims("By 2026, most brands will use AI for planning.").some((c) => c.text === "2026")).toBe(true);
  });
});

// ── 3. Evidence with the wrong year fails the real proposition ──

describe("claimhood: wrong-year evidence fails a genuine year assertion", () => {
  const rightYear = [{ title: "HK retail report", snippet: "In 2026, Hong Kong retail sales rose 6.5%." }];
  const wrongYear = [{ title: "HK retail report", snippet: "In 2025, Hong Kong retail sales rose 6.5%." }];

  it("same year supports; different year is rejected", () => {
    const supported = claimsFor("Hong Kong retail sales rose 6.5% in 2026.", rightYear)
      .find((claim) => claim.category === "date_claim");
    expect(supported?.supported).toBe(true);

    const rejected = claimsFor("Hong Kong retail sales rose 6.5% in 2026.", wrongYear)
      .find((claim) => claim.category === "date_claim");
    expect(rejected?.supported).toBe(false);
    expect(rejected?.supportVerdict).toBe("insufficient");
  });

  it("a genuine year claim with no year in research still fails closed", () => {
    const claims = claimsFor("Hong Kong retail sales rose 6.5% in 2026.", [
      { title: "HK retail report", snippet: "Hong Kong retail sales rose 6.5%." },
    ]);
    expect(claims.some((claim) => claim.category === "date_claim" && !claim.supported)).toBe(true);
  });
});

// ── 4. Qualified superlative stays one proposition; no stronger claim ──

describe("claimhood: qualifier preservation for superlatives", () => {
  it("'widely seen as the best channel' emits ONE qualified claim and never 'the best'", () => {
    const claims = claimsFor(
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
    );
    const marketWide = marketWideClaims(
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
    );
    expect(marketWide).toEqual([]);
    const superlatives = claims.filter((claim) => claim.category === "comparative_performance");
    expect(superlatives.length).toBe(1);
    expect(superlatives[0].text.toLowerCase()).toContain("widely seen as the best");
  });

  it("the qualified proposition is still verified against the evidence", () => {
    const weak = claimsFor(
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is a relevant and strong channel in Hong Kong." }],
    ).find((claim) => claim.category === "comparative_performance");
    expect(weak?.supported).toBe(false);
    expect(weak?.supportReason).toContain("comparison/superlative");

    const strong = claimsFor(
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods and international brands." }],
    ).find((claim) => claim.category === "comparative_performance");
    expect(strong?.supported).toBe(true);
  });

  it("other qualifier forms are preserved: modal, attributed, estimation", () => {
    expect(marketWideClaims("DON DON DONKI may be the best retail channel in Hong Kong.")).toEqual([]);
    expect(marketWideClaims("DON DON DONKI is considered the leading retail channel in Hong Kong.")).toEqual([]);
    expect(marketWideClaims("According to experts, the best retail channel in Hong Kong is social commerce.")).toEqual([]);
    expect(marketWideClaims("DON DON DONKI is believed to be the best retail channel in Hong Kong.")).toEqual([]);
  });
});

// ── 5. An actually asserted absolute superlative is still extracted ──

describe("claimhood: absolute superlatives stay claims", () => {
  it("'X is the best channel' is extracted as a market-wide claim and requires evidence", () => {
    const claims = claimsFor("DON DON DONKI is the best retail channel in Hong Kong.");
    const absolute = claims.find((claim) => claim.category === "market_wide_claim");
    expect(absolute).toBeDefined();
    expect(absolute!.text.toLowerCase()).toContain("the best retail channel");
    expect(absolute!.supported).toBe(false);
  });
});

// ── 6/7. Previous entailment guarantees are unchanged ──

describe("claimhood: prior entailment guarantees hold", () => {
  const HK_RETAIL_EVIDENCE = [{
    title: "Hong Kong Retail Management Association service guidance",
    snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
  }];

  it("wrong-role 50% claim still fails entailment and is removed by existing cleanup", () => {
    const html = articleWith(
      "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.",
    );
    const scan = scanFactualRisks(html, KEYPHRASE, HK_RETAIL_EVIDENCE);
    const claim = scan.claims.find((item) => item.category === "percentage");
    expect(claim?.supported).toBe(false);
    expect(claim?.supportVerdict).toBe("insufficient");
    const cleanup = removeUnsupportedSentences(html, scan.claims.filter((item) => !item.supported));
    expect(cleanup.sentencesRemoved).toBeGreaterThan(0);
    expect(cleanup.html).not.toContain("reward staff with a 50% discount");
  });

  it("valid supported percentages/comparatives/superlatives still pass", () => {
    const supported = claimsFor(
      "The average engagement rate on Threads in Hong Kong is 6.25%.",
      [{ title: "HK benchmark", snippet: "The average engagement rate on Threads in Hong Kong is 6.25%." }],
    );
    expect(supported.find((c) => c.category === "platform_metric")?.supported).toBe(true);
    const comparative = claimsFor(
      "A loyal customer is worth more than a hundred one-time visitors.",
      [{ title: "Loyalty economics", snippet: "A loyal customer is worth more than a hundred one-time visitors for local shops." }],
    );
    expect(comparative.find((c) => c.category === "comparative_performance")?.supported).toBe(true);
    const qualified = claimsFor(
      "DON DON DONKI is known as the leading retail channel for Asian-origin packaged goods.",
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is known as the leading retail channel for Asian-origin packaged goods and international brands." }],
    );
    expect(qualified.find((c) => c.category === "comparative_performance")?.supported).toBe(true);
  });
});

// ── 8/9. Fail-closed and cleanup commit on the Project-26 shape ──

describe("claimhood: fail-closed stays, cleanup commits valid removals", () => {
  it("genuine unsupported claims surviving cleanup still fail closed", () => {
    const doc = makeDoc({
      introText: "Hong Kong retail sales rose 6.5% in 2026.",
      sectionText: "Interruptive ads no longer work on their own.",
    });
    const before = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    expect(before.some((c) => c.category === "date_claim" && c.text === "2026")).toBe(true);
    expect(before.some((c) => c.category === "market_wide_claim")).toBe(true);

    const introHtml = renderEditorialBlocksToWordPress(doc.introduction.blocks);
    const introClean = removeUnsupportedSentences(
      introHtml,
      scanFactualRisks(introHtml, KEYPHRASE, []).claims.filter((c) => !c.supported),
    ).html;
    expect(visibleText(introClean)).not.toContain("2026");
  });

  it("Project-26 cleanup commits valid removals instead of rolling back on a non-claim", () => {
    // section-0 shape from the live failure: topic-scope 2026 material that is
    // NOT a claim, plus a genuinely unsupported wrong-role 50% claim.
    const doc = makeDoc({
      introText: "Our 2026 guide to Hong Kong retail marketing covers local shops. The Shape of the Market in 2026 shows why customer trust matters.",
      sectionText:
        "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets. Keep building on what works.",
    });
    const sectionHtml = renderEditorialBlocksToWordPress(doc.sections[0].blocks);
    const unsupported = scanFactualRisks(sectionHtml, KEYPHRASE, [{
      title: "Hong Kong Retail Management Association service guidance",
      snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
    }]).claims.filter((claim) => !claim.supported);

    // The topic-year material is not a claim at all — it never enters the
    // unsupported set, so the removal producer only sees the real finding.
    expect(unsupported.some((c) => c.category === "date_claim")).toBe(false);
    expect(unsupported.some((c) => c.category === "percentage" && c.text.includes("50%"))).toBe(true);

    const cleanup = removeUnsupportedSentences(sectionHtml, unsupported);
    expect(cleanup.sentencesRemoved).toBeGreaterThan(0);
    expect(cleanup.html).not.toContain("reward staff with a 50% discount");
    expect(cleanup.html).toContain("Keep building on what works.");
  });
});

// ── Adversarial: same words, materially different qualifiers ──

describe("claimhood: adversarial same-words/different-qualifier pairs", () => {
  it("bare year vs factual sentence containing year", () => {
    expect(dateClaims("Hong Kong Marketing Trends 2026")).toEqual([]);
    expect(dateClaims("Hong Kong marketing trends are driving sales growth in 2026.").some((c) => c.text === "2026")).toBe(true);
  });

  it("heading year vs assertion year", () => {
    expect(dateClaims("The Shape of the Market in 2026")).toEqual([]);
    expect(dateClaims("The shape of the market changed in 2026.").some((c) => c.text === "2026")).toBe(true);
  });

  it("qualified vs absolute superlative", () => {
    const qualified = "DON DON DONKI is widely seen as the best retail channel in Hong Kong.";
    const absolute = "DON DON DONKI is the best retail channel in Hong Kong.";
    expect(marketWideClaims(qualified)).toEqual([]);
    expect(marketWideClaims(absolute).some((c) => c.text.toLowerCase().includes("the best retail channel"))).toBe(true);
  });

  it("modal vs absolute claim", () => {
    const modal = "Social commerce may be the most effective strategy for local brands.";
    const absolute = "Social commerce is the most effective strategy for local brands.";
    expect(marketWideClaims(modal)).toEqual([]);
    expect(marketWideClaims(absolute)).toHaveLength(1);
  });

  it("attributed vs direct assertion", () => {
    const attributed = "According to the report, the best retail channel in Hong Kong is social commerce.";
    const direct = "The best retail channel in Hong Kong is social commerce.";
    expect(marketWideClaims(attributed)).toEqual([]);
    expect(marketWideClaims(direct)).toHaveLength(1);
  });

  it("same words with materially different qualifiers", () => {
    const hedged = "DON DON DONKI is estimated to be the best retail channel in Hong Kong.";
    const asserted = "DON DON DONKI is the best retail channel in Hong Kong.";
    expect(marketWideClaims(hedged)).toEqual([]);
    expect(marketWideClaims(asserted)).toHaveLength(1);
  });
});
