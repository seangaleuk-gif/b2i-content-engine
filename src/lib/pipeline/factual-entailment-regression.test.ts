import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  removeUnsupportedSentences,
  type ScannedClaim,
} from "@/lib/blog/factual-risk-scanner";

const KEYPHRASE = "hong kong retail marketing";

const articleWith = (sentence: string) => `<!-- wp:paragraph -->\n<p>${sentence}</p>\n<!-- /wp:paragraph -->`;

function claimFor(sentence: string, research: Array<{ title: string; snippet: string }>): ScannedClaim | undefined {
  const scan = scanFactualRisks(articleWith(sentence), KEYPHRASE, research);
  return scan.claims.find((claim) => claim.sentenceText?.includes(sentence.slice(0, 30)));
}

// Evidence mirroring the live Project-26 run: the source contains the SAME
// number (50%) but a DIFFERENT beneficiary/relationship than the claim.
const HK_RETAIL_EVIDENCE = [{
  title: "Hong Kong Retail Management Association service guidance",
  snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
}];

const PROJECT26_CLAIM =
  "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.";

// ── 1-7. Entailment verdicts ──

describe("factual claim entailment", () => {
  it("project-26 wrong-role 50% claim fails entailment (beneficiary/relationship differ)", () => {
    const claim = claimFor(PROJECT26_CLAIM, HK_RETAIL_EVIDENCE);
    expect(claim).toBeDefined();
    expect(claim!.supported).toBe(false);
    expect(claim!.supportVerdict).toBe("insufficient");
    expect(claim!.supportReason).toContain("subject/relation/object");
  });

  it("a correctly attributed 50% claim with the same subject/relation/beneficiary passes", () => {
    const claim = claimFor(
      "Retailers in Hong Kong recognise service performance and offer new members a 50% discount for strong service.",
      HK_RETAIL_EVIDENCE,
    );
    expect(claim).toBeDefined();
    expect(claim!.supported).toBe(true);
    expect(claim!.supportVerdict).toBe("supported");
    expect(claim!.evidenceId).toBe("SOURCE-1-CLAIM-1");
  });

  it("an unsupported 'more than a hundred' comparison is detected and fails entailment", () => {
    const claim = claimFor(
      "A loyal customer is worth more than a hundred one-time visitors.",
      [{ title: "Loyalty economics", snippet: "Loyal customers provide steady repeat revenue over time for local shops." }],
    );
    expect(claim).toBeDefined();
    expect(claim!.category).toBe("comparative_performance");
    expect(claim!.supported).toBe(false);
    expect(claim!.supportVerdict).toBe("insufficient");
    expect(claim!.supportReason).toContain("comparison/superlative");
  });

  it("an unsupported 'widely regarded as the best' amplification fails", () => {
    const claim = claimFor(
      "DON DON DONKI is widely regarded as the best Hong Kong retail channel for those categories.",
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is a relevant and strong channel in Hong Kong for Asian-origin packaged goods and international brands." }],
    );
    expect(claim).toBeDefined();
    expect(claim!.supported).toBe(false);
    expect(claim!.supportVerdict).toBe("insufficient");
    expect(claim!.supportReason).toContain("comparison/superlative");
  });

  it("an evidence-supported superlative still passes", () => {
    const claim = claimFor(
      "DON DON DONKI is known as the leading retail channel for Asian-origin packaged goods.",
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is known as the leading retail channel for Asian-origin packaged goods and international brands." }],
    );
    expect(claim).toBeDefined();
    expect(claim!.supported).toBe(true);
    expect(claim!.supportVerdict).toBe("supported");
  });

  it("ordinary paraphrases with equivalent meaning still pass", () => {
    const exact = claimFor(
      "The average engagement rate on Threads in Hong Kong is 6.25%.",
      [{ title: "HK benchmark", snippet: "The average engagement rate on Threads in Hong Kong is 6.25%." }],
    );
    expect(exact!.supported).toBe(true);
    const survey = claimFor(
      "A Hong Kong survey found that 97.9% of respondents had used Threads.",
      [{ title: "HK Threads usage survey", snippet: "Our survey found that 97.9% of respondents have used the platform." }],
    );
    expect(survey!.supported).toBe(true);
  });

  it("number-only or entity-only overlap can never establish support", () => {
    const numberOnly = claimFor(
      "Retailers reward staff with a 50% discount when they hit service targets.",
      [{ title: "New member offer", snippet: "New members receive a 50% discount on their first order." }],
    );
    expect(numberOnly!.supported).toBe(false);
    expect(numberOnly!.supportVerdict).toBe("insufficient");
  });
});

// ── 8. Adversarial: same number/entity, different material part ──

describe("adversarial entailment (same number, different material part)", () => {
  const cases: Array<[string, string, string]> = [
    [
      "subject",
      "Baristas receive a 50% discount when they hit service targets.",
      "New members receive a 50% discount on their first order.",
    ],
    [
      "beneficiary",
      "Retailers reward staff with a 50% discount for hitting sales targets.",
      "Retailers offer new members a 50% discount for signing up.",
    ],
    [
      "relationship",
      "Stores sell imported goods at a 50% discount during the sale.",
      "New members receive a 50% discount on their first order.",
    ],
  ];
  for (const [dimension, claim, evidence] of cases) {
    it(`differing ${dimension} with the same number fails entailment`, () => {
      const found = claimFor(claim, [{ title: "Offer terms", snippet: evidence }]);
      expect(found, dimension).toBeDefined();
      expect(found!.supported, dimension).toBe(false);
      expect(found!.supportVerdict, dimension).toBe("insufficient");
    });
  }

  it("differing comparison strength with the same entity fails", () => {
    const found = claimFor(
      "DON DON DONKI is the best Hong Kong retail channel for those categories.",
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is a relevant and strong channel in Hong Kong for those categories." }],
    );
    expect(found!.supported).toBe(false);
    expect(found!.supportReason).toContain("comparison/superlative");
  });

  it("differing temporal scope with the same number fails", () => {
    const found = claimFor(
      "In 2025, new members received a 50% discount on their first order.",
      [{ title: "Offer terms", snippet: "In 2026, new members receive a 50% discount on their first order." }],
    );
    expect(found!.supported).toBe(false);
    expect(found!.supportReason).toContain("temporal scope");
  });
});

// ── 9. Existing repair/removal path ──

describe("unsupported entailment findings use the existing repair path", () => {
  it("the wrong-role 50% claim is removed by the existing factual cleanup", () => {
    const html = articleWith(PROJECT26_CLAIM);
    const scan = scanFactualRisks(html, KEYPHRASE, HK_RETAIL_EVIDENCE);
    const unsupported = scan.claims.filter((claim) => !claim.supported);
    expect(unsupported.length).toBeGreaterThan(0);
    const cleanup = removeUnsupportedSentences(html, unsupported);
    expect(cleanup.sentencesRemoved).toBeGreaterThan(0);
    expect(cleanup.html).not.toContain("reward staff with a 50% discount");
  });

  it("supported claims are never touched by the cleanup path", () => {
    const sentence = "Retailers in Hong Kong recognise service performance and offer new members a 50% discount for strong service.";
    const html = articleWith(sentence);
    const scan = scanFactualRisks(html, KEYPHRASE, HK_RETAIL_EVIDENCE);
    const unsupported = scan.claims.filter((claim) => !claim.supported);
    const cleanup = removeUnsupportedSentences(html, unsupported);
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain(sentence);
  });
});
