// ── Stage 3X: complete per-sentence provenance accounting ──
// A concrete external-world factual sentence must not escape source fidelity
// simply by being returned with no sourceAttributions entry. Every prose
// sentence of a factual-capable producer response is accounted for EXACTLY
// ONCE as source_fact (sourceAttributions: owned evidence IDs, declared-only
// fidelity) or free_prose (freeProseSentences: advice/opinion/rhetoric/
// hypothetical only, never a concrete fact). Completeness is verified
// deterministically at the producer boundary (existing repair/retry seam);
// nothing is deleted post-hoc. General discovery stays shadow-only/off.

import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  scanUnsupportedClaimsInDocument,
  removeUnsupportedSentences,
  type GeneralDiscoveryCoverageEntry,
} from "@/lib/blog/factual-risk-scanner";
import { validateProducerSentenceAccounting, validateProducerSourceAttributions } from "@/lib/blog/producer-content-contract";
import { normalizeAiEditorialPayload } from "@/lib/blog/article-content";
import {
  renderArticleDocument,
  parseArticleDocumentFromHtml,
  renderEditorialBlocksToWordPress,
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
  type SourceAttribution,
} from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong retail marketing";

const HK_RETAIL_EVIDENCE = [{
  title: "Hong Kong Retail Management Association service guidance",
  snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
}];

const SUPPORTING_EVIDENCE = [{
  title: "HK retail sales benchmark",
  snippet: "Hong Kong retail sales rose 6.5% in 2026, according to the local statistics office.",
}];

const GAP_SENTENCE =
  "Platforms like Google and Meta let retailers target anyone who walked past their shop last week.";
const WRONG_ROLE_50 =
  "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.";
const SUPPORTED_6_5 = "Hong Kong retail sales rose 6.5% in 2026.";
const DASHBOARD_ADVICE = "You don't need a complex dashboard to start.";
const START_SMALL = "Start small and test what works before scaling up your marketing budget.";
const HYPOTHETICAL =
  "Imagine a local bakery that follows this approach and draws nearby customers without spending on ads.";

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function sectionContext(ownedEvidenceIds: ReadonlySet<string>, research: unknown) {
  return {
    componentId: "section-0",
    componentType: "section" as const,
    scope: "complete-component" as const,
    keyphrase: KEYPHRASE,
    ownedEvidenceIds,
    research: research as Array<{ title?: string; snippet?: string; url?: string }>,
    synthesisOnly: false,
  };
}

function makeDoc(opts: {
  sectionText?: string;
  sectionAttributions?: SourceAttribution[];
  freeProseSentences?: string[];
} = {}): ArticleDocument {
  const intro: ArticleComponent = {
    id: "intro",
    status: "normalized",
    blocks: [paragraphBlock("intro-p0", "Introduction one. Introduction two.")],
  };
  const sections: ArticleSection[] = [
    {
      id: "section-0",
      heading: "Reaching Local Customers",
      headingLevel: 2,
      sectionType: "main",
      status: "normalized",
      blocks: [paragraphBlock("section-0-wp-0", opts.sectionText ?? "Section one. Section two.")],
      sourceAttributions: opts.sectionAttributions,
      freeProseSentences: opts.freeProseSentences,
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

// ── 1. The omission gap is closed structurally ──

describe("unaccounted concrete facts cannot silently pass", () => {
  it("a factual-capable producer returning prose without structural sentence kinds is rejected at normalization", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: GAP_SENTENCE }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors.some((e) => e.includes("must return structural sentences with kind"))).toBe(true);
  });

  it("the gap sentence is invisible to deterministic patterns (the assertion is not pattern-guaranteed)", () => {
    const scan = scanFactualRisks(
      `<!-- wp:paragraph -->\n<p>${GAP_SENTENCE}</p>\n<!-- /wp:paragraph -->`,
      KEYPHRASE,
      [],
    );
    expect(scan.claims.length).toBe(0);
  });

  it("a pattern-DETECTABLE fact accounted as free_prose is rejected", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", "The platform reaches 50% of Hong Kong shoppers overnight.")],
        sentenceAccounting: [{ sentence: "The platform reaches 50% of Hong Kong shoppers overnight.", kind: "free_prose", evidenceIds: [] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]),
    );
    expect(violations.some((v) => v.code === "free-prose-asserts-concrete-fact")).toBe(true);
  });

  it("a pattern-free concrete fact misclassified as free_prose is the model's declared boundary (no deterministic signal exists)", () => {
    // The gap sentence carries NO deterministic pattern (proved above). The
    // deterministic contract closes the NO-ENTRY escape structurally (every
    // sentence object carries a kind) and rejects pattern-detectable facts in
    // free_prose; a pattern-free fact the model declares as free_prose is
    // beyond deterministic reach — the boundary is the prompt-defined
    // classification, with shadow discovery as the diagnostic layer.
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", GAP_SENTENCE)],
        sentenceAccounting: [{ sentence: GAP_SENTENCE, kind: "free_prose", evidenceIds: [] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]),
    );
    expect(violations).toEqual([]);
  });

  it("accounting the fact as source_fact with a non-entailing owned claim is rejected", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", GAP_SENTENCE)],
        sentenceAccounting: [{ sentence: GAP_SENTENCE, kind: "source_fact", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]),
    );
    expect(violations.some((v) => v.code === "attribution-fidelity")).toBe(true);
  });
});

// ── 2/3/4/5. source_fact fidelity through the accounting contract ──

describe("source_fact fidelity (existing declared-only authority)", () => {
  const owned = new Set(["SOURCE-1-CLAIM-1", "SOURCE-2-CLAIM-1"]);
  const research = [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE];

  it("a supported external fact with its correct declared source passes", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", SUPPORTED_6_5)],
        sentenceAccounting: [{ sentence: SUPPORTED_6_5, kind: "source_fact", evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      },
      sectionContext(owned, research),
    );
    expect(violations).toEqual([]);
  });

  it("the wrong-role 50% corruption still fails", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", WRONG_ROLE_50)],
        sentenceAccounting: [{ sentence: WRONG_ROLE_50, kind: "source_fact", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      sectionContext(owned, research),
    );
    expect(violations.some((v) => v.code === "attribution-fidelity")).toBe(true);
  });

  it("the supported 6.5% sentence passes the canonical scan with accounting attached", () => {
    const doc = makeDoc({
      sectionText: SUPPORTED_6_5,
      sectionAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      freeProseSentences: [],
    });
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, research);
    expect(located.some((claim) => claim.category === "source_attributed")).toBe(false);
    const scan = scanFactualRisks(
      renderEditorialBlocksToWordPress(doc.sections[0].blocks),
      KEYPHRASE,
      research,
      {
        declaredAttributions: doc.sections[0].sourceAttributions,
        freeProseSentences: doc.sections[0].freeProseSentences,
      },
    );
    expect(scan.claims.find((c) => c.category === "source_attributed")?.supported).toBe(true);
  });

  it("a qualified source claim cannot become an absolute stronger claim", () => {
    const qualifiedResearch = [{
      title: "Don Don Donki",
      snippet: "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods and international brands.",
    }];
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", "DON DON DONKI is the best retail channel in Hong Kong for those categories.")],
        sentenceAccounting: [{
          sentence: "DON DON DONKI is the best retail channel in Hong Kong for those categories.",
          kind: "source_fact",
          evidenceIds: ["SOURCE-1-CLAIM-1"],
        }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), qualifiedResearch),
    );
    expect(violations.some((v) => v.code === "attribution-fidelity")).toBe(true);
  });
});

// ── 6/7/8. Free prose stays free ──

describe("free_prose is valid and untouched", () => {
  const research = [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE];
  const owned = new Set(["SOURCE-1-CLAIM-1", "SOURCE-2-CLAIM-1"]);

  it.each([
    [DASHBOARD_ADVICE],
    [START_SMALL],
    [HYPOTHETICAL],
  ])("free prose sentence passes the accounting contract: %s", (sentence) => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", sentence)],
        sentenceAccounting: [{ sentence, kind: "free_prose", evidenceIds: [] }],
      },
      sectionContext(owned, research),
    );
    expect(violations).toEqual([]);
  });

  it("free prose produces no factual claims and is never deleted", () => {
    const doc = makeDoc({
      sectionText: DASHBOARD_ADVICE,
      freeProseSentences: [DASHBOARD_ADVICE],
    });
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, research);
    expect(located).toEqual([]);
    const cleanup = removeUnsupportedSentences(
      renderEditorialBlocksToWordPress(doc.sections[0].blocks),
      [],
    );
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain("complex dashboard");
  });
});

// ── 9. Every generated sentence accounted for exactly once ──

describe("deterministic completeness", () => {
  const owned = new Set(["SOURCE-1-CLAIM-1", "SOURCE-2-CLAIM-1"]);
  const research = [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE];

  it("completeness is structural: every structured sentence is classified — an accounted sentence not in the blocks is still detected", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", DASHBOARD_ADVICE)],
        sentenceAccounting: [
          { sentence: DASHBOARD_ADVICE, kind: "free_prose", evidenceIds: [] },
          { sentence: "This sentence was never generated.", kind: "free_prose", evidenceIds: [] },
        ],
      },
      sectionContext(owned, research),
    );
    expect(violations.some((v) => v.code === "accounted-sentence-not-in-blocks")).toBe(true);
  });

  it("a fully accounted mixed section passes exactly once", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", `${DASHBOARD_ADVICE} ${SUPPORTED_6_5} ${START_SMALL}`)],
        sentenceAccounting: [
          { sentence: DASHBOARD_ADVICE, kind: "free_prose", evidenceIds: [] },
          { sentence: SUPPORTED_6_5, kind: "source_fact", evidenceIds: ["SOURCE-2-CLAIM-1"] },
          { sentence: START_SMALL, kind: "free_prose", evidenceIds: [] },
        ],
      },
      sectionContext(owned, research),
    );
    expect(violations).toEqual([]);
  });

  it("normalization derives canonical sidecars from structural sentence objects (no payload duplication)", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{
        type: "paragraph",
        sentences: [
          { text: DASHBOARD_ADVICE, kind: "free_prose" },
          { text: SUPPORTED_6_5, kind: "source_fact", evidenceIds: ["SOURCE-2-CLAIM-1"] },
        ],
      }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    expect(normalized.freeProseSentences).toEqual([DASHBOARD_ADVICE]);
    expect(normalized.sourceAttributions).toEqual([{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }]);
  });

  it("accounting survives the HTML round-trip and never renders into WP output", () => {
    const doc = makeDoc({
      sectionText: DASHBOARD_ADVICE,
      freeProseSentences: [DASHBOARD_ADVICE],
    });
    const rendered = renderArticleDocument(doc);
    expect(rendered).not.toContain("freeProseSentences");
    const reparsed = parseArticleDocumentFromHtml(rendered, doc);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.doc!.sections[0].freeProseSentences).toEqual([DASHBOARD_ADVICE]);
  });
});

// ── 10. Repair seam, not post-hoc deletion ──

describe("invalid accounting drives the producer repair seam, never deletion", () => {
  it("a factual-capable response without structural sentence kinds is rejected at normalization (repair input), never deleted post-hoc", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: GAP_SENTENCE }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors.length).toBeGreaterThan(0);
    // The gap sentence itself is untouched by the factual authority (no
    // pattern claims, no attribution claims) — nothing is deleted.
    const scan = scanFactualRisks(
      `<!-- wp:paragraph -->\n<p>${GAP_SENTENCE}</p>\n<!-- /wp:paragraph -->`,
      KEYPHRASE,
      [],
    );
    const cleanup = removeUnsupportedSentences(
      `<!-- wp:paragraph -->\n<p>${GAP_SENTENCE}</p>\n<!-- /wp:paragraph -->`,
      scan.claims.filter((c) => !c.supported && !c.shadow),
    );
    expect(cleanup.sentencesRemoved).toBe(0);
    expect(cleanup.html).toContain("Platforms like Google and Meta");
  });
});

// ── 11. Deterministic patterns remain backstops ──

describe("deterministic patterns remain the backstop", () => {
  it("a free_prose sentence carrying a pattern fact is rejected at the boundary", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", "The platform reaches 50% of Hong Kong shoppers overnight.")],
        sentenceAccounting: [{ sentence: "The platform reaches 50% of Hong Kong shoppers overnight.", kind: "free_prose", evidenceIds: [] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]),
    );
    expect(violations.some((v) => v.code === "free-prose-asserts-concrete-fact")).toBe(true);
  });

  it("an undeclared numeric fact in the canonical scan is still caught and removed", () => {
    const doc = makeDoc({
      sectionText: `${SUPPORTED_6_5} The platform reaches 50% of Hong Kong shoppers overnight.`,
      sectionAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      freeProseSentences: [],
    });
    const located = scanUnsupportedClaimsInDocument(
      doc,
      KEYPHRASE,
      [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE],
    );
    expect(located.some((claim) => claim.category === "percentage")).toBe(true);
  });
});

// ── 12. General discovery stays shadow-only/off and never sees free prose ──

describe("general discovery remains shadow-only and free-prose is excluded", () => {
  it("free-prose sentences are never merged from general discovery", async () => {
    const { warmGeneralClaimDiscovery } = await import("@/lib/blog/factual-risk-scanner");
    const html =
      `<!-- wp:paragraph -->\n<p>${DASHBOARD_ADVICE} ${GAP_SENTENCE}</p>\n<!-- /wp:paragraph -->`;
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, async (request) => ({
      sentences: request.sentences.map((s) => ({
        sentenceId: s.sentenceId,
        verifiableClaims: [s.sentence],
      })),
    }), map);
    const scan = scanFactualRisks(html, KEYPHRASE, [], {
      generalDiscoveredClaims: map,
      freeProseSentences: [DASHBOARD_ADVICE],
    });
    // The free-prose sentence is excluded; only the unaccounted gap sentence
    // would surface (as shadow) — and even shadow claims never mutate.
    const shadowClaims = scan.claims.filter((c) => c.shadow);
    expect(shadowClaims.every((c) => !c.sentenceText?.includes("complex dashboard"))).toBe(true);
    expect(scan.hasHighRisk).toBe(false);
  });

  it("a scan without discovery options performs no discovery at all", () => {
    const scan = scanFactualRisks(
      `<!-- wp:paragraph -->\n<p>${DASHBOARD_ADVICE}</p>\n<!-- /wp:paragraph -->`,
      KEYPHRASE,
      [],
    );
    expect(scan.claims.length).toBe(0);
  });
});

// ── 13. No new API calls or stages; synthesis-only unchanged ──

describe("architecture stability", () => {
  it("the accounting validator is pure and deterministic (no AI calls, no I/O)", () => {
    // The helper only composes the existing deterministic scanners.
    const source = validateProducerSentenceAccounting.toString();
    expect(source).not.toContain("chatWithRetry");
    expect(source).not.toContain("fetch(");
  });

  it("synthesis-only components keep the existing stricter contract (sourceAttributions must be empty)", () => {
    // The strict synthesis-only rule is unchanged: NO research provenance may
    // be declared. freeProseSentences is inert without completeness and is
    // tolerated (the contract is not broadened).
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", "Some introduction prose here.")],
        sourceAttributions: [{ sentence: "Some introduction prose here.", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
        freeProseSentences: [],
      },
      {
        componentId: "intro",
        componentType: "introduction",
        scope: "complete-component",
        keyphrase: KEYPHRASE,
        ownedEvidenceIds: new Set(),
        research: [],
        synthesisOnly: true,
      },
    );
    expect(violations.some((v) => v.code === "synthesis-only-attribution")).toBe(true);
    const clean = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", "Some introduction prose here.")],
        sourceAttributions: [],
        freeProseSentences: ["Some introduction prose here."],
      },
      {
        componentId: "intro",
        componentType: "introduction",
        scope: "complete-component",
        keyphrase: KEYPHRASE,
        ownedEvidenceIds: new Set(),
        research: [],
        synthesisOnly: true,
      },
    );
    expect(clean).toEqual([]);
  });

  it("validateProducerSourceAttributions remains the source_fact-side validator", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", WRONG_ROLE_50)],
        sourceAttributions: [{ sentence: WRONG_ROLE_50, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), [HK_RETAIL_EVIDENCE[0]]),
    );
    expect(violations.some((v) => v.code === "attribution-fidelity")).toBe(true);
  });
});

// ── Output-token overhead of complete per-sentence accounting ──

describe("accounting output-token overhead", () => {
  it("reports the exact JSON overhead for the Project-26 replay section", () => {
    const sentences = [
      WRONG_ROLE_50,
      SUPPORTED_6_5,
      DASHBOARD_ADVICE,
      START_SMALL,
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
      "A loyal customer is worth more than a hundred one-time visitors.",
    ];
    const articleJson = JSON.stringify({
      blocks: sentences.map((sentence) => ({ type: "paragraph", text: sentence })),
    });
    const articleTokens = Math.round(articleJson.length / 4);
    // Typical: 2 source_fact + 4 free_prose.
    const accountingJson = JSON.stringify({
      sourceAttributions: [
        { sentence: sentences[0], evidenceIds: ["SOURCE-1-CLAIM-1"] },
        { sentence: sentences[1], evidenceIds: ["SOURCE-2-CLAIM-1"] },
      ],
      freeProseSentences: [sentences[2], sentences[3], sentences[4], sentences[5]],
    });
    const accountingTokens = Math.round(accountingJson.length / 4);
    const overheadPct = Math.round((accountingTokens / articleTokens) * 1000) / 10;
    console.log(
      `[cost] Project-26 accounting metadata: ${accountingJson.length} chars (~${accountingTokens} tokens) ` +
      `for a ${sentences.length}-sentence section — ${overheadPct}% of the article JSON output`,
    );
    expect(accountingTokens).toBeGreaterThan(0);
  });
});


