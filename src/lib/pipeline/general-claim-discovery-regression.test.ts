// ── Stage 3U: factual coverage completeness hardening ──
// General verifiable-claim discovery is REQUIRED coverage, not an
// enhancement: every sentence of a factual surface is submitted with a stable
// deterministic ID and the response must account for EVERY submitted ID.
// Missing/duplicate/unknown IDs, truncation, invalid JSON and provider
// failure are retried (that batch only) and then FAIL CLOSED with the
// distinct factual-coverage diagnostic — an article is never saved on
// pattern-only fallback. CLAIM_PATTERNS remain merged high-risk backstops.
//
// These tests prove the completeness contract and replay the Project-26
// platform/payment claims through the new sentence-accounted discovery.

import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  scanUnsupportedClaimsInDocument,
  removeUnsupportedSentences,
  warmGeneralClaimDiscovery,
  warmGeneralClaimDiscoveryForDocument,
  verifySubmittedSentenceCompleteness,
  type GeneralClaimDiscovery,
  type GeneralDiscoveryBatchRequest,
  type GeneralDiscoveryBatchResult,
  type GeneralDiscoveryCoverageEntry,
} from "@/lib/blog/factual-risk-scanner";
import {
  makeGeneralClaimDiscovery,
  parseGeneralDiscoveryResponse,
  verifyGeneralDiscoveryCompleteness,
  GeneralClaimDiscoveryUnavailableError,
  GENERAL_CLAIM_DISCOVERY_STAGE,
} from "@/lib/blog/general-claim-discovery";
import {
  renderEditorialBlocksToWordPress,
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
} from "@/lib/blog/article-document";
import { analyzeFinalArticle } from "@/lib/blog/final-article-policy";

const KEYPHRASE = "hong kong retail marketing";

const articleWith = (sentence: string) =>
  `<!-- wp:paragraph -->\n<p>${sentence}</p>\n<!-- /wp:paragraph -->`;

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(opts: {
  introText?: string;
  heading?: string;
  sectionText?: string;
} = {}): ArticleDocument {
  const intro: ArticleComponent = {
    id: "intro",
    status: "normalized",
    blocks: [paragraphBlock("intro-p0", opts.introText ?? "Introduction one. Introduction two.")],
  };
  const sections: ArticleSection[] = [
    {
      id: "section-0",
      heading: opts.heading ?? "Reaching Local Customers",
      headingLevel: 2,
      sectionType: "main",
      status: "normalized",
      blocks: [paragraphBlock("section-0-wp-0", opts.sectionText ?? "Section one. Section two.")],
    },
  ];
  const conclusion: ArticleComponent = {
    id: "conclusion",
    status: "normalized",
    blocks: [paragraphBlock("conclusion-p0", "Conclusion one. Conclusion two.")],
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

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLowerCase();
}

/** Deterministic fixture discovery: classifies every submitted sentence,
 *  returning the canned claims for known factual sentences and [] otherwise —
 *  ALWAYS accounting for every submitted ID. */
function fixtureDiscovery(claimMap: Record<string, string[]>): GeneralClaimDiscovery {
  return async (request: GeneralDiscoveryBatchRequest): Promise<GeneralDiscoveryBatchResult> => ({
    sentences: request.sentences.map(({ sentenceId, sentence }) => {
      const claims = Object.entries(claimMap)
        .filter(([source]) => normalizeForMatch(sentence).includes(normalizeForMatch(source)))
        .flatMap(([, claims]) => claims);
      return { sentenceId, verifiableClaims: claims };
    }),
  });
}

const WALKED_PAST_CLAIM =
  "You can show a short, friendly ad to anyone who has walked past your street in the last week.";
const TAPS_OR_CALLS_CLAIM =
  "The beauty is that you only pay when someone actually taps or calls, so the risk stays low.";

async function scanWithDiscovery(
  html: string,
  discovered: GeneralClaimDiscovery,
  research: Array<{ title: string; snippet: string }> = [],
) {
  const map = new Map<string, GeneralDiscoveryCoverageEntry>();
  await warmGeneralClaimDiscovery(html, discovered, map);
  return scanFactualRisks(html, KEYPHRASE, research, { generalDiscoveredClaims: map });
}

// ── 1/2/3. Every sentence is accounted for ──

describe("sentence-ID accounting: every submitted sentence is classified", () => {
  it("every submitted sentence ID is returned exactly once and claims are merged", async () => {
    const factual = "You can show a short, friendly ad to anyone who has walked past your street in the last week.";
    const advice = "Start small and test what works before scaling up your marketing budget.";
    const html = articleWith(`${factual} ${advice}`);
    const result = await scanWithDiscovery(html, fixtureDiscovery({
      [factual]: [factual],
    }));
    expect(result.claims.length).toBe(1);
    expect(result.claims[0].category).toBe("general_claim");
    expect(result.claims[0].text).toBe(factual);
    expect(result.claims[0].sourceSpan!.end).toBeGreaterThan(result.claims[0].sourceSpan!.start);
  });

  it("advice/hypotheticals with an empty claim list count as successfully classified", async () => {
    const advice = "Start small and test what works before scaling up your marketing budget.";
    const html = articleWith(advice);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, fixtureDiscovery({}), map);
    expect(map.get(visibleKey(html))).toEqual({ status: "complete", claims: [] });
    const result = scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(result.claims).toEqual([]);
    expect(result.hasHighRisk).toBe(false);
  });

  it("a sentence with multiple factual propositions returns all propositions", async () => {
    const sentence =
      "The platform shows ads to people who recently visited the store and only charges when someone taps.";
    const html = articleWith(sentence);
    const result = await scanWithDiscovery(html, fixtureDiscovery({
      [sentence]: [
        "The platform shows ads to people who recently visited the store",
        "only charges when someone taps",
      ],
    }));
    const claims = result.claims.filter((c) => c.category === "general_claim");
    expect(claims.length).toBe(2);
  });

  it("the deterministic completeness verifier rejects missing, duplicate and unknown IDs", () => {
    const request = {
      sentences: [
        { sentenceId: "s0", sentence: "A." },
        { sentenceId: "s1", sentence: "B." },
        { sentenceId: "s2", sentence: "C." },
      ],
    };
    const submitted = request.sentences;
    expect(verifySubmittedSentenceCompleteness(submitted, {
      sentences: [{ sentenceId: "s1", verifiableClaims: [] }],
    })).toEqual(expect.arrayContaining([expect.stringContaining("missing")]));
    expect(verifySubmittedSentenceCompleteness(submitted, {
      sentences: [
        { sentenceId: "s0", verifiableClaims: [] },
        { sentenceId: "s0", verifiableClaims: [] },
        { sentenceId: "s1", verifiableClaims: [] },
        { sentenceId: "s2", verifiableClaims: [] },
      ],
    })).toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
    expect(verifySubmittedSentenceCompleteness(submitted, {
      sentences: [
        { sentenceId: "s0", verifiableClaims: [] },
        { sentenceId: "s1", verifiableClaims: [] },
        { sentenceId: "s2", verifiableClaims: [] },
        { sentenceId: "s9", verifiableClaims: [] },
      ],
    })).toEqual(expect.arrayContaining([expect.stringContaining("unknown")]));
    expect(verifySubmittedSentenceCompleteness(submitted, {
      sentences: [
        { sentenceId: "s0", verifiableClaims: [] },
        { sentenceId: "s1", verifiableClaims: [] },
        { sentenceId: "s2", verifiableClaims: [] },
      ],
    })).toEqual([]);
  });
});

function visibleKey(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 4/5/6/7. Shadow mode: discovery can never block or mutate ──

describe("shadow mode: general discovery is diagnostic-only", () => {
  it("a missing sentence classification is detected but can never block processing", async () => {
    const seam = makeGeneralClaimDiscovery(async () => ({
      content: '{"sentences":[{"sentenceId":"s0","verifiableClaims":[]}]}',
    }));
    const html = articleWith(`${WALKED_PAST_CLAIM} Keep building on what works.`);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, seam, map);
    expect(map.get(visibleKey(html))?.status).toBe("unavailable");
    // No throw: the scan proceeds with deterministic patterns only.
    const result = scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(result.claims.some((c) => c.shadow)).toBe(false);
  });

  it("truncated output is retried once and then degrades to diagnostics only", async () => {
    let calls = 0;
    const seam = makeGeneralClaimDiscovery(async () => {
      calls++;
      return {
        content: '{"sentences":[{"sentenceId":"s0","verifiableClaims":["You can show a short, friendly ad',
        finishReason: "length" as const,
      };
    });
    const html = articleWith(`${WALKED_PAST_CLAIM} Keep building on what works.`);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, seam, map);
    expect(calls).toBe(2); // one retry of the same batch
    expect(map.get(visibleKey(html))?.status).toBe("unavailable");
    expect(() => scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map })).not.toThrow();
  });

  it("invalid JSON is retried but can never delete prose or block publication", async () => {
    let calls = 0;
    const seam = makeGeneralClaimDiscovery(async () => {
      calls++;
      return { content: "NOT JSON {{{" };
    });
    const html = articleWith(
      `${WALKED_PAST_CLAIM} Sales rose by 6.5% in 2026. Keep building on what works.`,
    );
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, seam, map);
    expect(calls).toBe(2);
    const result = scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map });
    // Deterministic pattern claims remain hard; the article is never deleted
    // wholesale by the discovery layer.
    expect(result.claims.some((c) => c.category === "percentage" && !c.shadow)).toBe(true);
  });

  it("provider failure after retries degrades to diagnostics only", async () => {
    let calls = 0;
    const seam = makeGeneralClaimDiscovery(async () => {
      calls++;
      throw new Error("provider down");
    });
    const html = articleWith(`${WALKED_PAST_CLAIM} Keep building on what works.`);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, seam, map);
    expect(calls).toBe(2);
    expect(map.get(visibleKey(html))?.status).toBe("unavailable");
    expect(() => scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map })).not.toThrow();
  });

  it("the seam still throws a distinct unavailable error after bounded retries", async () => {
    const seam = makeGeneralClaimDiscovery(async () => ({ content: "broken" }));
    await expect(seam({
      sentences: [{ sentenceId: "s0", sentence: "You can show a short, friendly ad." }],
    })).rejects.toBeInstanceOf(GeneralClaimDiscoveryUnavailableError);
  });

  it("an unlocatable discovered claim is skipped with a diagnostic, never a block", async () => {
    const html = articleWith(WALKED_PAST_CLAIM);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, fixtureDiscovery({
      [WALKED_PAST_CLAIM]: ["The platform shows ads to people who visited the store."],
    }), map);
    const result = scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(result.claims.some((c) => c.category === "general_claim")).toBe(false);
    expect(result.hasHighRisk).toBe(false);
  });

  it("shadow claims never count toward hasHighRisk, removal or the final gate", async () => {
    // The mass-deletion scenario: discovery classifies EVERY sentence as a
    // verifiable claim. Shadow mode must leave the article untouched.
    const guidance = [
      "Local teams often start with a simple content calendar.",
      "You do not need a complex dashboard to start.",
      "Keep posting consistently and review what works.",
      "Ask customers what they want to see next.",
    ].join(" ");
    const html = articleWith(guidance);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, fixtureDiscovery({
      "Local teams often start with a simple content calendar.": ["Local teams often start with a simple content calendar."],
      "You do not need a complex dashboard to start.": ["You do not need a complex dashboard to start."],
      "Keep posting consistently and review what works.": ["Keep posting consistently and review what works."],
      "Ask customers what they want to see next.": ["Ask customers what they want to see next."],
    }), map);
    const result = scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(result.claims.length).toBe(4);
    expect(result.claims.every((c) => c.shadow)).toBe(true);
    expect(result.hasHighRisk).toBe(false);
    const cleanup = removeUnsupportedSentences(
      html,
      result.claims.filter((c) => !c.supported && !c.shadow),
    );
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain("You do not need a complex dashboard to start.");
    const doc = makeDoc({ sectionText: guidance });
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(located).toEqual([]);
  });
});

// ── 8. CLAIM_PATTERNS remain backstops and dedupe exactly as before ──

describe("CLAIM_PATTERNS backstops and dedupe with general claims", () => {
  it("pattern claims merge with complete general coverage and duplicates collapse", async () => {
    const sentence = "Sales rose by 6.5% in 2026.";
    const result = await scanWithDiscovery(articleWith(sentence), fixtureDiscovery({
      [sentence]: [sentence],
    }));
    expect(result.claims.some((c) => c.category === "percentage")).toBe(true);
    expect(result.claims.some((c) => c.category === "date_claim")).toBe(true);
    expect(result.claims.some((c) => c.category === "numerical_growth")).toBe(true);
    expect(result.claims.some((c) => c.category === "general_claim")).toBe(false);
  });

  it("an identical discovered wording duplicates an existing pattern claim exactly", async () => {
    const sentence = "The algorithm pushes content that gets replies.";
    const result = await scanWithDiscovery(articleWith(sentence), fixtureDiscovery({
      [sentence]: [sentence],
    }));
    const matching = result.claims.filter((c) =>
      normalizeForMatch(c.text) === normalizeForMatch(sentence),
    );
    expect(matching.length).toBe(1);
  });
});

// ── 9. Project-26 replay: discovered as shadow diagnostics, never removed ──

describe("Project-26 replay through sentence-accounted discovery", () => {
  it("platform/payment claims are discovered as shadow diagnostics and never removed", async () => {
    const html = articleWith(`${WALKED_PAST_CLAIM} ${TAPS_OR_CALLS_CLAIM}`);
    const result = await scanWithDiscovery(html, fixtureDiscovery({
      [WALKED_PAST_CLAIM]: [WALKED_PAST_CLAIM],
      [TAPS_OR_CALLS_CLAIM]: [TAPS_OR_CALLS_CLAIM],
    }));
    const discovered = result.claims.filter((c) => c.category === "general_claim");
    expect(discovered.length).toBe(2);
    expect(discovered.every((c) => c.shadow)).toBe(true);
    expect(result.hasHighRisk).toBe(false);
    // The hard unsupported set is empty — ordinary prose is never deleted.
    const unsupported = result.claims.filter((c) => !c.supported && !c.shadow);
    expect(unsupported).toEqual([]);
    const cleanup = removeUnsupportedSentences(html, unsupported);
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain("walked past your street");
    expect(cleanup.html).toContain("taps or calls");
  });

  it("shadow claims still report entailment when project evidence matches", async () => {
    const result = await scanWithDiscovery(articleWith(WALKED_PAST_CLAIM), fixtureDiscovery({
      [WALKED_PAST_CLAIM]: [WALKED_PAST_CLAIM],
    }), [{ title: "Local reach platform", snippet: WALKED_PAST_CLAIM }]);
    const claim = result.claims.find((c) => c.category === "general_claim");
    expect(claim?.supported).toBe(true);
    expect(claim?.evidenceId).toBe("SOURCE-1-CLAIM-1");
    expect(claim?.shadow).toBe(true);
  });

  it("the final gate reports zero unsupported claims from shadow findings", async () => {
    const doc = makeDoc({ sectionText: `${WALKED_PAST_CLAIM} Keep building on what works.` });
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscoveryForDocument(doc, fixtureDiscovery({
      [WALKED_PAST_CLAIM]: [WALKED_PAST_CLAIM],
    }), map);
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(located.some((c) => c.category === "general_claim")).toBe(false);

    const metrics = analyzeFinalArticle(
      renderEditorialBlocksToWordPress(doc.introduction.blocks)
        + renderEditorialBlocksToWordPress(doc.sections[0].blocks)
        + renderEditorialBlocksToWordPress(doc.conclusion.blocks),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      doc.metadata.targetWordCount,
      undefined,
      { articleDoc: doc, research: [], generalDiscoveredClaims: map },
    );
    expect(metrics.unsupportedFactualClaimCount).toBe(0);
  });
});

// ── 10. Prior regressions remain green with discovery active ──

describe("prior regressions with discovery active", () => {
  const HK_RETAIL_EVIDENCE = [{
    title: "Hong Kong Retail Management Association service guidance",
    snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
  }];

  it("wrong-role 50% still fails entailment", async () => {
    const sentence =
      "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.";
    const result = await scanWithDiscovery(articleWith(sentence), fixtureDiscovery({
      [sentence]: [sentence],
    }), HK_RETAIL_EVIDENCE);
    const claim = result.claims.find((c) => c.category === "percentage");
    expect(claim?.supported).toBe(false);
    expect(claim?.supportVerdict).toBe("insufficient");
  });

  it("contextual-year and qualifier-preservation regressions still pass", async () => {
    const result = await scanWithDiscovery(
      articleWith("Our 2026 guide to Hong Kong retail marketing covers local shops. DON DON DONKI is widely seen as the best retail channel in Hong Kong."),
      fixtureDiscovery({
        "DON DON DONKI is widely seen as the best retail channel in Hong Kong.":
          ["DON DON DONKI is widely seen as the best retail channel in Hong Kong."],
      }),
    );
    expect(result.claims.some((c) => c.category === "date_claim")).toBe(false);
    expect(result.claims.some((c) => c.category === "market_wide_claim")).toBe(false);
    expect(result.claims.some((c) => c.category === "comparative_performance")).toBe(true);
    expect(result.claims.some((c) => c.category === "general_claim")).toBe(false);
  });
});

// ── 11. Supported factual claims pass normally ──

describe("supported claims pass normally", () => {
  it("an ordinary entailed capability claim is supported", async () => {
    const sentence = "Businesses can accept contactless card payments through the service.";
    const result = await scanWithDiscovery(articleWith(sentence), fixtureDiscovery({
      [sentence]: [sentence],
    }), [{ title: "Platform documentation", snippet: sentence }]);
    const claim = result.claims.find((c) => c.category === "general_claim");
    expect(claim?.supported).toBe(true);
    expect(claim?.supportVerdict).toBe("supported");
  });

  it("non-entailing evidence leaves the claim insufficient", async () => {
    const result = await scanWithDiscovery(articleWith(WALKED_PAST_CLAIM), fixtureDiscovery({
      [WALKED_PAST_CLAIM]: [WALKED_PAST_CLAIM],
    }), [{ title: "General tips", snippet: "Advertising helps local brands reach nearby customers." }]);
    const claim = result.claims.find((c) => c.category === "general_claim");
    expect(claim?.supported).toBe(false);
  });
});

// ── 12. No new stage or mutation ──

describe("architecture stability", () => {
  it("the scanner adds no mutation API to the discovery path", () => {
    const source = scanFactualRisks.toString();
    expect(source).not.toContain("removeUnsupportedSentences(");
  });

  it("discovery never fabricates claims — empty classification yields zero claims", async () => {
    const html = articleWith("Local teams share useful lessons every week.");
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, fixtureDiscovery({}), map);
    const result = scanFactualRisks(html, KEYPHRASE, [], { generalDiscoveredClaims: map });
    expect(result.claims).toEqual([]);
    expect(result.hasHighRisk).toBe(false);
  });
});

// ── Discovery call contract + batching ──

describe("bounded batch contract", () => {
  it("parses the sentence-accounted response shape", () => {
    const parsed = parseGeneralDiscoveryResponse(
      '{"sentences":[{"sentenceId":"s0","verifiableClaims":["You can show ads to nearby people."]},{"sentenceId":"s1","verifiableClaims":[]}]}',
    );
    expect(parsed).toEqual({
      sentences: [
        { sentenceId: "s0", verifiableClaims: ["You can show ads to nearby people."] },
        { sentenceId: "s1", verifiableClaims: [] },
      ],
    });
    expect(parseGeneralDiscoveryResponse("not json")).toBeNull();
    expect(parseGeneralDiscoveryResponse('{"other":[]}')).toBeNull();
  });

  it("verification rejects duplicates, unknowns, missing IDs and malformed entries", () => {
    const request = {
      sentences: [
        { sentenceId: "s0", sentence: "A." },
        { sentenceId: "s1", sentence: "B." },
      ],
    };
    expect(verifyGeneralDiscoveryCompleteness(request, null)).toHaveLength(1);
    expect(verifyGeneralDiscoveryCompleteness(request, {
      sentences: [
        { sentenceId: "s0", verifiableClaims: [] },
        { sentenceId: "s1", verifiableClaims: [] },
      ],
    })).toEqual([]);
    expect(verifyGeneralDiscoveryCompleteness(request, {
      sentences: [
        { sentenceId: "s0", verifiableClaims: ["ok"] },
        { sentenceId: "s1", verifiableClaims: [] },
        { sentenceId: "s1", verifiableClaims: [] },
      ],
    })).toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
  });

  it("the seam issues one call per batch with the correct stage and options", async () => {
    const calls: Array<{ messages: unknown[]; options?: Record<string, unknown>; stage?: string }> = [];
    const seam = makeGeneralClaimDiscovery(async (messages, options, stage) => {
      calls.push({ messages, options, stage });
      return { content: '{"sentences":[{"sentenceId":"s0","verifiableClaims":["ok claim"]}]}' };
    });
    const result = await seam({ sentences: [{ sentenceId: "s0", sentence: "The claim sentence." }] });
    expect(result.sentences[0].verifiableClaims).toEqual(["ok claim"]);
    expect(calls.length).toBe(1);
    expect(calls[0].stage).toBe(GENERAL_CLAIM_DISCOVERY_STAGE);
    expect(calls[0].options?.temperature).toBe(0);
  });

  it("warming is memoised and short texts never trigger a call", async () => {
    let calls = 0;
    const discovery: GeneralClaimDiscovery = async (request) => {
      calls++;
      return { sentences: request.sentences.map((s) => ({ sentenceId: s.sentenceId, verifiableClaims: [] })) };
    };
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    const html = articleWith(`${WALKED_PAST_CLAIM} Keep building on what works.`);
    await warmGeneralClaimDiscovery(html, discovery, map);
    await warmGeneralClaimDiscovery(html, discovery, map);
    expect(calls).toBe(1);
    await warmGeneralClaimDiscovery(
      `<!-- wp:heading {"level":2} --><h2>Reaching Local Customers</h2><!-- /wp:heading -->`,
      discovery,
      map,
    );
    expect(calls).toBe(1);
  });

  it("multi-sentence surfaces are submitted in bounded batches with surface-stable IDs", async () => {
    const batches: GeneralDiscoveryBatchRequest[] = [];
    const discovery: GeneralClaimDiscovery = async (request) => {
      batches.push(request);
      return {
        sentences: request.sentences.map((s) => ({ sentenceId: s.sentenceId, verifiableClaims: [] })),
      };
    };
    const sentences = Array.from({ length: 14 }, (_, i) => `Sentence number ${i} about retail marketing here.`);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(articleWith(sentences.join(" ")), discovery, map);
    expect(batches.length).toBe(3); // 14 sentences → 6/6/2
    expect(batches[0].sentences[0].sentenceId).toBe("s0");
    expect(batches[2].sentences[1].sentenceId).toBe("s13");
    const entry = map.get(visibleKey(articleWith(sentences.join(" "))));
    expect(entry?.status).toBe("complete");
  });
});

// ── Cost measurement for the Project-26 replay ──

describe("Project-26 replay discovery cost", () => {
  it("reports batch call count and estimated tokens for the replay surface", async () => {
    const section0 = [
      "Our 2026 guide to Hong Kong retail marketing covers local shops.",
      "The Shape of the Market in 2026 shows why customer trust matters.",
      WALKED_PAST_CLAIM,
      TAPS_OR_CALLS_CLAIM,
      "Hong Kong retail sales rose 6.5% in 2026.",
      "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.",
      "Start small and test what works before scaling up your marketing budget.",
      "DON DON DONKI is widely seen as the best retail channel in Hong Kong.",
      "Keep building on what works.",
      "A loyal customer is worth more than a hundred one-time visitors.",
    ].join(" ");
    const calls: Array<{ request: GeneralDiscoveryBatchRequest; responseChars: number }> = [];
    const discovery: GeneralClaimDiscovery = async (request) => {
      calls.push({
        request,
        responseChars: request.sentences.reduce((sum, s) => sum + s.sentence.length, 0),
      });
      return {
        sentences: request.sentences.map((s) => ({
          sentenceId: s.sentenceId,
          verifiableClaims: /walked past|taps or calls/.test(s.sentence) ? [s.sentence] : [],
        })),
      };
    };
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    const html = articleWith(section0);
    await warmGeneralClaimDiscovery(html, discovery, map);
    const entry = map.get(visibleKey(html));
    expect(entry?.status).toBe("complete");

    const inputChars = calls.reduce((sum, c) =>
      sum + JSON.stringify(c.request).length, 0);
    const outputChars = calls.reduce((sum, c) => sum + c.responseChars, 0);
    console.log(
      `[cost] Project-26 section-0 replay: batches=${calls.length} calls, ` +
      `input≈${inputChars} chars (~${Math.round(inputChars / 4)} tokens), ` +
      `output≈${outputChars} chars (~${Math.round(outputChars / 4)} tokens)`,
    );
    expect(calls.length).toBe(2); // 10 sentences → 6/4
  });
});
