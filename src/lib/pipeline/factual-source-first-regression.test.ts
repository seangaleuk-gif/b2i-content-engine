// ── Stage 3V: source-first factual architecture (no exhaustive post-hoc
//    fact checking) ──
// B2I is not an open-domain fact-checking system: approved research claims
// (SOURCE-X-CLAIM-Y) → section ownership → source-grounded generation →
// entailment → cleanup → final QC. The factual authority protects the meaning
// of SOURCE-DERIVED prose; ordinary editorial guidance, advice and
// hypotheticals are free prose unless they carry a concrete factual assertion
// that deterministic patterns detect. General claim discovery is shadow-only.
//
// These tests replay the latest Project-26 factual-scan input and prove:
// guidance is never deleted for lacking a citation, the wrong-role 50%
// semantic corruption still fails, supported 6.5% prose passes, superlatives
// preserve source meaning, unlicensed concrete assertions are repaired, and
// the 2944-word snapshot no longer collapses (no mass deletion, no orphan
// transition, word-count floor respected).

import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  removeUnsupportedSentences,
  type GeneralDiscoveryCoverageEntry,
} from "@/lib/blog/factual-risk-scanner";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";

const KEYPHRASE = "hong kong retail marketing";

const articleWith = (sentence: string) =>
  `<!-- wp:paragraph -->\n<p>${sentence}</p>\n<!-- /wp:paragraph -->`;

const articleWithParagraphs = (sentences: string[]) =>
  sentences.map((sentence) => articleWith(sentence)).join("\n");

const HK_RETAIL_EVIDENCE = [{
  title: "Hong Kong Retail Management Association service guidance",
  snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
}];

const SUPPORTING_EVIDENCE = [{
  title: "HK retail sales benchmark",
  snippet: "Hong Kong retail sales rose 6.5% in 2026, according to the local statistics office.",
}];

const WRONG_ROLE_50 =
  "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.";
const SUPPORTED_6_5 = "Hong Kong retail sales rose 6.5% in 2026.";

const GUIDANCE = [
  "You don't need a complex dashboard to start.",
  "Start small and test what works before scaling up your marketing budget.",
  "Keep posting consistently and review what works.",
  "Ask customers what they want to see next.",
  "Local teams often begin with a simple content calendar.",
  "A clear plan beats a clever tool every time.",
  "Talk to your regulars and listen to their feedback.",
  "Imagine a local bakery that follows this approach and draws nearby customers.",
];

function visibleWords(html: string): number {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/).length;
}

// ── 1/2. Ordinary guidance is free prose ──

describe("source-first: guidance and hypotheticals are free prose", () => {
  it("'You don't need a complex dashboard to start' is never deleted for lacking a citation", () => {
    const html = articleWith("You don't need a complex dashboard to start. A clear plan beats a clever tool.");
    const scan = scanFactualRisks(html, KEYPHRASE, []);
    expect(scan.claims).toEqual([]);
    const cleanup = removeUnsupportedSentences(html, scan.claims.filter((c) => !c.supported));
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain("complex dashboard");
  });

  it("generic advice and hypothetical examples remain intact through the cleanup path", () => {
    const html = articleWithParagraphs(GUIDANCE);
    const scan = scanFactualRisks(html, KEYPHRASE, []);
    expect(scan.claims).toEqual([]);
    const cleanup = removeUnsupportedSentences(html, []);
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain("Start small and test what works");
    expect(cleanup.html).toContain("local bakery");
  });
});

// ── 3. Wrong-role semantic corruption still fails ──

describe("source-first: source→prose semantic fidelity", () => {
  it("the wrong-role 50% corruption is insufficient and removed by the existing cleanup", () => {
    const html = articleWith(WRONG_ROLE_50);
    const scan = scanFactualRisks(html, KEYPHRASE, HK_RETAIL_EVIDENCE);
    const claim = scan.claims.find((c) => c.category === "percentage");
    expect(claim?.supported).toBe(false);
    expect(claim?.supportVerdict).toBe("insufficient");
    expect(claim?.supportReason).toContain("subject/relation/object");
    const cleanup = removeUnsupportedSentences(
      html,
      scan.claims.filter((c) => !c.supported && !c.shadow),
    );
    expect(cleanup.sentencesRemoved).toBe(1);
    expect(cleanup.html).not.toContain("reward staff with a 50% discount");
  });
});

// ── 4. Supported source-derived prose passes ──

describe("source-first: supported prose passes", () => {
  it("the supported 6.5% source-derived sentence passes entailment", () => {
    const scan = scanFactualRisks(articleWith(SUPPORTED_6_5), KEYPHRASE, SUPPORTING_EVIDENCE);
    const claim = scan.claims.find((c) => c.category === "percentage");
    expect(claim?.supported).toBe(true);
    expect(claim?.evidenceId).toBe("SOURCE-1-CLAIM-1");
    const cleanup = removeUnsupportedSentences(
      articleWith(SUPPORTED_6_5),
      scan.claims.filter((c) => !c.supported && !c.shadow),
    );
    expect(cleanup.sentencesRemoved).toBe(0);
  });
});

// ── 5. Source-derived superlatives and qualifiers preserve meaning ──

describe("source-first: superlative and qualifier fidelity", () => {
  it("a qualified superlative matching source strength passes", () => {
    const scan = scanFactualRisks(
      articleWith("DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods."),
      KEYPHRASE,
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods and international brands." }],
    );
    const claim = scan.claims.find((c) => c.category === "comparative_performance");
    expect(claim?.supported).toBe(true);
  });

  it("a stronger superlative than the source asserts fails", () => {
    const scan = scanFactualRisks(
      articleWith("DON DON DONKI is the best retail channel in Hong Kong for those categories."),
      KEYPHRASE,
      [{ title: "Don Don Donki", snippet: "DON DON DONKI is a relevant and strong channel in Hong Kong for those categories." }],
    );
    const claim = scan.claims.find((c) => c.category === "market_wide_claim");
    expect(claim?.supported).toBe(false);
    expect(claim?.supportReason).toContain("comparison/superlative");
  });

  it("qualifiers are preserved — the qualified proposition never emits a stronger fragment", () => {
    const scan = scanFactualRisks(
      articleWith("DON DON DONKI is widely seen as the best retail channel in Hong Kong."),
      KEYPHRASE,
      [],
    );
    expect(scan.claims.some((c) => c.category === "market_wide_claim")).toBe(false);
    expect(scan.claims.some((c) => c.category === "comparative_performance")).toBe(true);
  });
});

// ── 6. Unlicensed concrete assertions are caught and repaired ──

describe("source-first: unlicensed concrete assertions fail closed", () => {
  it("a concrete numeric assertion with no permitted provenance is removed before persistence", () => {
    const html = articleWith(
      "The platform reaches 50% of Hong Kong shoppers overnight. Keep building on what works.",
    );
    const scan = scanFactualRisks(html, KEYPHRASE, []);
    const unsupported = scan.claims.filter((c) => !c.supported && !c.shadow);
    expect(unsupported.some((c) => c.category === "percentage")).toBe(true);
    const cleanup = removeUnsupportedSentences(html, unsupported);
    expect(cleanup.sentencesRemoved).toBe(1);
    expect(cleanup.html).not.toContain("50% of Hong Kong shoppers");
    expect(cleanup.html).toContain("Keep building on what works.");
  });

  it("an absolute market-wide claim with no evidence is removed", () => {
    const html = articleWith("Threads is the best channel for local brands in Hong Kong.");
    const scan = scanFactualRisks(html, KEYPHRASE, []);
    const unsupported = scan.claims.filter((c) => !c.supported && !c.shadow);
    expect(unsupported.some((c) => c.category === "market_wide_claim")).toBe(true);
    const cleanup = removeUnsupportedSentences(html, unsupported);
    expect(cleanup.sentencesRemoved).toBe(1);
  });
});

// ── 7/8/9. No mass deletion: the 2944-word replay ──

describe("source-first: the 2944-word Project-26 replay does not collapse", () => {
  // Deterministic guidance templates — deliberately free of numbers, years,
  // percentages, currencies, comparatives, superlatives and market-wide
  // keywords so the deterministic patterns never touch them.
  const TEMPLATES = [
    "Local teams often start with a simple content calendar and keep it updated.",
    "You do not need a complex dashboard to begin your planning routine.",
    "Keep posting consistently and review what works every few weeks.",
    "Ask customers what they want to see next and adapt the plan.",
    "A clear plan beats a clever tool every single time.",
    "Talk to your regulars and listen to their feedback carefully.",
    "Small shops win by staying close to their neighbourhood.",
    "A steady routine helps the team stay focused on the basics.",
    "Write down your goals and check them against your results.",
    "Simple formats often perform best with local audiences.",
  ];

  it("cleanup removes only genuine unsupported claims — the article stays above the word floor with valid structure", () => {
    // Build a ~2944-word replay: guidance prose plus the Project-26 claims.
    const paragraphs: string[] = [];
    let words = 0;
    let templateIndex = 0;
    let variation = 0;
    while (words < 2944) {
      const template = TEMPLATES[templateIndex % TEMPLATES.length];
      variation = Math.floor(templateIndex / TEMPLATES.length);
      const sentence = `${template} Variation ${variation} keeps the text distinct.`.replace(
        /Variation 0 keeps the text distinct\./,
        "This keeps the text distinct.",
      );
      paragraphs.push(sentence);
      words += sentence.split(/\s+/).length;
      templateIndex++;
    }
    // Inject the genuine Project-26 claims as their own paragraphs.
    paragraphs.push(WRONG_ROLE_50);
    paragraphs.push(SUPPORTED_6_5);
    const html = articleWithParagraphs(paragraphs);
    const beforeWords = visibleWords(html);
    expect(beforeWords).toBeGreaterThanOrEqual(2944);

    // Factual-scan with the approved research: only the wrong-role claim is
    // unsupported; the supported 6.5% passes; guidance is untouched.
    const scan = scanFactualRisks(html, KEYPHRASE, [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]);
    const unsupported = scan.claims.filter((c) => !c.supported && !c.shadow);
    expect(unsupported.length).toBe(1);
    expect(unsupported[0].category).toBe("percentage");

    const cleanup = removeUnsupportedSentences(html, unsupported);
    const afterWords = visibleWords(cleanup.html);
    expect(cleanup.sentencesRemoved).toBe(1);
    expect(afterWords).toBeGreaterThanOrEqual(2944 * 0.9); // word-count floor
    expect(1 - afterWords / beforeWords).toBeLessThan(0.05); // no collapse
    expect(cleanup.html).not.toContain("reward staff with a 50% discount");
    expect(cleanup.html).toContain("complex dashboard");
    expect(cleanup.html).toContain("Small shops win by staying close to their neighbourhood.");
    // No orphan transition and no broken WordPress block structure.
    const structure = validateWordpressBlockPairs(cleanup.html);
    expect(structure.valid).toBe(true);
    expect(cleanup.html).not.toMatch(/<p>[^<]*(?:However|Meanwhile|Therefore|For example)\b[^<]*<\/p>/i);
  });

  it("shadow discovery cannot collapse the replay even when every sentence is flagged", async () => {
    const { warmGeneralClaimDiscovery } = await import("@/lib/blog/factual-risk-scanner");
    const html = articleWithParagraphs([
      ...GUIDANCE,
      WRONG_ROLE_50,
      SUPPORTED_6_5,
    ]);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    const everySentenceIsAClaim = async () => ({
      sentences: [],
    });
    // Shadow mode with a complete-but-claim-dense classification:
    await warmGeneralClaimDiscovery(html, async (request) => ({
      sentences: request.sentences.map((s) => ({
        sentenceId: s.sentenceId,
        verifiableClaims: [s.sentence],
      })),
    }), map);
    void everySentenceIsAClaim;
    const scan = scanFactualRisks(html, KEYPHRASE, [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE], {
      generalDiscoveredClaims: map,
    });
    expect(scan.claims.every((c) => c.shadow)).toBe(false); // pattern claims stay hard
    const unsupported = scan.claims.filter((c) => !c.supported && !c.shadow);
    const cleanup = removeUnsupportedSentences(html, unsupported);
    // Only the genuine wrong-role claim sentence is removed — never the
    // shadow-flagged guidance.
    expect(cleanup.sentencesRemoved).toBe(1);
    expect(cleanup.html).toContain("You don't need a complex dashboard to start.");
  });
});

// ── 10. Shadow mode cannot hard-block or mutate ──

describe("shadow mode boundaries", () => {
  it("an unavailable discovery result never blocks the scan", async () => {
    const { warmGeneralClaimDiscovery } = await import("@/lib/blog/factual-risk-scanner");
    const html = articleWith(`${GUIDANCE[1]} ${WRONG_ROLE_50}`);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, async () => {
      throw new Error("provider down");
    }, map);
    expect(map.get(visibleKey(html))?.status).toBe("unavailable");
    expect(() => scanFactualRisks(html, KEYPHRASE, HK_RETAIL_EVIDENCE, { generalDiscoveredClaims: map }))
      .not.toThrow();
  });
});

function visibleKey(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
