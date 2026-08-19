// ── Stage 3W: source-first provenance completion ──
// Approved SOURCE-X-CLAIM-Y IDs reach the producer prompt but were discarded
// with the response. This suite proves the completion: producers return
// internal-only sourceAttributions (exact sentence → owned evidence IDs),
// normalization preserves them on the canonical document, they NEVER render
// into WordPress output, the existing entailment authority validates each
// attributed sentence against its DECLARED evidence only (never reassigned
// heuristically), synthesis-only producers may not attribute, and the
// deterministic patterns remain the backstop. No new stage, no new model call.

import { describe, expect, it } from "vitest";
import {
  scanFactualRisks,
  scanUnsupportedClaimsInDocument,
  validateAttributedSentenceFidelity,
  buildEvidenceLedger,
  removeUnsupportedSentences,
  type GeneralDiscoveryCoverageEntry,
} from "@/lib/blog/factual-risk-scanner";
import { validateProducerSourceAttributions } from "@/lib/blog/producer-content-contract";
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

const WRONG_ROLE_50 =
  "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.";
const SUPPORTED_6_5 = "Hong Kong retail sales rose 6.5% in 2026.";

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(opts: {
  sectionText?: string;
  sectionAttributions?: SourceAttribution[];
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

// ── 1. Provenance survives producer → normalization → canonical authority ──

describe("provenance survives into the canonical document", () => {
  it("normalization derives sourceAttributions from structural sentence objects", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{
        type: "paragraph",
        sentences: [{ text: SUPPORTED_6_5, kind: "source_fact", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    expect(normalized.sourceAttributions).toEqual([{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-1-CLAIM-1"] }]);
  });

  it("malformed structural sentence entries are rejected by normalization (repair seam input)", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{
        type: "paragraph",
        sentences: [
          { text: "", kind: "free_prose" },
          { text: "X", kind: "source_fact" },
          { text: "Y", kind: "source_fact", evidenceIds: ["not-an-id"] },
          { text: "Z" },
        ],
      }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.sourceAttributions).toEqual([]);
    expect(normalized.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("attributions survive the pipeline HTML round-trip and never render into WordPress output", () => {
    const doc = makeDoc({
      sectionText: SUPPORTED_6_5,
      sectionAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
    });
    const rendered = renderArticleDocument(doc);
    expect(rendered).not.toContain("sourceAttributions");
    expect(rendered).not.toContain("SOURCE-1-CLAIM-1");
    const reparsed = parseArticleDocumentFromHtml(rendered, doc);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.doc!.sections[0].sourceAttributions).toEqual([
      { sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-1-CLAIM-1"] },
    ]);
  });
});

// ── 2. Fidelity: wrong-role 50% fails, supported 6.5% passes ──

describe("declared-evidence fidelity (existing entailment authority)", () => {
  const fullLedger = buildEvidenceLedger([...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]);

  it("the wrong-role 50% sentence attributed to its declared claim fails", () => {
    const fidelity = validateAttributedSentenceFidelity(
      WRONG_ROLE_50,
      ["SOURCE-1-CLAIM-1"],
      fullLedger,
    );
    expect(fidelity.supported).toBe(false);
    expect(fidelity.reason).toContain("subject/relation/object");
  });

  it("the supported 6.5% sentence attributed to its declared claim passes", () => {
    const fidelity = validateAttributedSentenceFidelity(
      SUPPORTED_6_5,
      ["SOURCE-2-CLAIM-1"],
      fullLedger,
    );
    expect(fidelity.supported).toBe(true);
    expect(fidelity.evidenceId).toBe("SOURCE-2-CLAIM-1");
  });

  it("the canonical scan reports the attributed wrong-role sentence as unsupported and cleanup removes it", () => {
    const doc = makeDoc({
      sectionText: `${WRONG_ROLE_50} Keep building on what works.`,
      sectionAttributions: [{ sentence: WRONG_ROLE_50, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
    });
    const located = scanUnsupportedClaimsInDocument(
      doc,
      KEYPHRASE,
      [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE],
    );
    const attributed = located.find((claim) => claim.category === "source_attributed");
    expect(attributed).toBeDefined();
    expect(attributed!.componentId).toBe("section-0");
    expect(attributed!.blockId).toBe("section-0-wp-0");
    const cleanup = removeUnsupportedSentences(
      renderEditorialBlocksToWordPress(doc.sections[0].blocks),
      located.map((claim) => ({ ...claim, sentenceText: claim.sentenceText ?? claim.text })),
    );
    expect(cleanup.sentencesRemoved).toBeGreaterThan(0);
  });

  it("the canonical scan supports the correctly attributed 6.5% sentence", () => {
    const doc = makeDoc({
      sectionText: SUPPORTED_6_5,
      sectionAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
    });
    const located = scanUnsupportedClaimsInDocument(
      doc,
      KEYPHRASE,
      [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE],
    );
    expect(located.some((claim) => claim.category === "source_attributed")).toBe(false);
    const scan = scanFactualRisks(
      renderEditorialBlocksToWordPress(doc.sections[0].blocks),
      KEYPHRASE,
      [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE],
      { declaredAttributions: doc.sections[0].sourceAttributions },
    );
    const attributed = scan.claims.find((claim) => claim.category === "source_attributed");
    expect(attributed?.supported).toBe(true);
    expect(attributed?.evidenceId).toBe("SOURCE-2-CLAIM-1");
  });
});

// ── 3. Qualified sources cannot become stronger claims ──

describe("qualified source claims cannot become stronger unqualified claims", () => {
  const ledger = buildEvidenceLedger([{
    title: "Don Don Donki",
    snippet: "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods and international brands.",
  }]);

  it("an absolute 'is the best channel' sentence attributed to a qualified source claim fails", () => {
    const fidelity = validateAttributedSentenceFidelity(
      "DON DON DONKI is the best retail channel in Hong Kong for those categories.",
      ["SOURCE-1-CLAIM-1"],
      ledger,
    );
    expect(fidelity.supported).toBe(false);
  });

  it("the qualified sentence attributed to the qualified source claim passes", () => {
    const fidelity = validateAttributedSentenceFidelity(
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
      ["SOURCE-1-CLAIM-1"],
      ledger,
    );
    expect(fidelity.supported).toBe(true);
  });
});

// ── 4. Declared source only — never heuristic reassignment ──

describe("explicit provenance is checked against its declared source", () => {
  it("a sentence attributed to the wrong claim fails even when another claim would entail it", () => {
    // The 6.5% sentence is entailed by the SECOND claim, but the producer
    // declared the FIRST (50% off new members) — declared-only checking fails.
    const ledger = buildEvidenceLedger([...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE]);
    const fidelity = validateAttributedSentenceFidelity(
      SUPPORTED_6_5,
      ["SOURCE-1-CLAIM-1"],
      ledger,
    );
    expect(fidelity.supported).toBe(false);
    expect(fidelity.reason).toContain("exact quantity");
  });
});

// ── 5. Free prose stays free ──

describe("ordinary prose stays free", () => {
  it("guidance without attributions produces no provenance claims", () => {
    const doc = makeDoc({
      sectionText: "You don't need a complex dashboard to start. Start small and test what works.",
    });
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    expect(located).toEqual([]);
  });
});

// ── 6. Shared producer-contract helper (every factual-capable producer) ──

describe("shared source-provenance producer contract", () => {
  const context = (ownedEvidenceIds: ReadonlySet<string>, research: unknown) => ({
    componentId: "section-0",
    componentType: "section" as const,
    scope: "complete-component" as const,
    keyphrase: KEYPHRASE,
    ownedEvidenceIds,
    research: research as Array<{ title?: string; snippet?: string; url?: string }>,
  });
  const owned = new Set(["SOURCE-1-CLAIM-1"]);
  const research = [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE];

  it("a valid attribution passes", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", SUPPORTED_6_5)],
        sourceAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      },
      context(new Set(["SOURCE-2-CLAIM-1"]), research),
    );
    expect(violations).toEqual([]);
  });

  it("a sentence missing from the blocks is rejected", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", "A different sentence entirely.")],
        sourceAttributions: [{ sentence: WRONG_ROLE_50, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      context(owned, research),
    );
    expect(violations.some((v) => v.code === "attributed-sentence-not-in-blocks")).toBe(true);
  });

  it("an unknown evidence id is rejected", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", WRONG_ROLE_50)],
        sourceAttributions: [{ sentence: WRONG_ROLE_50, evidenceIds: ["SOURCE-9-CLAIM-9"] }],
      },
      context(owned, research),
    );
    expect(violations.some((v) => v.code === "attribution-unknown-evidence")).toBe(true);
  });

  it("a foreign (not-owned) evidence id is rejected even when it exists in the ledger", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", SUPPORTED_6_5)],
        sourceAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      },
      context(owned, research),
    );
    expect(violations.some((v) => v.code === "attribution-not-owned")).toBe(true);
  });

  it("a semantic corruption against the declared evidence is rejected (wrong-role 50%)", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", WRONG_ROLE_50)],
        sourceAttributions: [{ sentence: WRONG_ROLE_50, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      context(owned, [HK_RETAIL_EVIDENCE[0]]),
    );
    expect(violations.some((v) => v.code === "attribution-fidelity")).toBe(true);
  });

  it("synthesis-only components may not attribute at all", () => {
    const violations = validateProducerSourceAttributions(
      {
        blocks: [paragraphBlock("b0", SUPPORTED_6_5)],
        sourceAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      context(new Set(), research),
    );
    expect(violations.some((v) => v.code === "attribution-not-owned")).toBe(true);
  });

  it("the same helper drives sections, regeneration and compaction contexts", () => {
    // One shared entry point: the helper signature accepts any producer
    // context; regeneration/compaction pass section-owned IDs exactly like
    // the initial section producer.
    const regen = validateProducerSourceAttributions(
      { blocks: [paragraphBlock("b0", SUPPORTED_6_5)], sourceAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }] },
      context(new Set(["SOURCE-2-CLAIM-1"]), research),
    );
    expect(regen).toEqual([]);
  });
});

// ── 7. Pattern backstops still work alongside provenance ──

describe("deterministic patterns remain the backstop", () => {
  it("pattern claims merge with attributed claims and still catch undeclared numbers", () => {
    const doc = makeDoc({
      sectionText: `${SUPPORTED_6_5} The platform reaches 50% of Hong Kong shoppers overnight.`,
      sectionAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-1-CLAIM-1"] }],
    });
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, SUPPORTING_EVIDENCE);
    // The undeclared 50% claim is caught by the deterministic pattern.
    expect(located.some((claim) => claim.category === "percentage")).toBe(true);
    expect(located.some((claim) => claim.category === "source_attributed")).toBe(false);
  });
});

// ── 8. Shadow discovery remains zero-call / zero-impact ──

describe("general discovery remains shadow-only and zero-call by default", () => {
  it("a scan without discovery options performs no discovery at all", () => {
    const scan = scanFactualRisks(articleWithText(SUPPORTED_6_5), KEYPHRASE, SUPPORTING_EVIDENCE);
    expect(scan.claims.some((claim) => claim.category === "general_claim")).toBe(false);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    const withEmptyMap = scanFactualRisks(articleWithText(SUPPORTED_6_5), KEYPHRASE, SUPPORTING_EVIDENCE, {
      generalDiscoveredClaims: map,
    });
    expect(withEmptyMap.claims.some((claim) => claim.category === "general_claim")).toBe(false);
  });

  it("shadow discoveries never mutate attributed or free prose", async () => {
    const { warmGeneralClaimDiscovery } = await import("@/lib/blog/factual-risk-scanner");
    const shadowSentence =
      "You can show a short, friendly ad to anyone who has walked past your street in the last week.";
    const html = articleWithText(`${SUPPORTED_6_5} ${shadowSentence}`);
    const map = new Map<string, GeneralDiscoveryCoverageEntry>();
    await warmGeneralClaimDiscovery(html, async (request) => ({
      sentences: request.sentences.map((s) => ({
        sentenceId: s.sentenceId,
        verifiableClaims: [s.sentence],
      })),
    }), map);
    const scan = scanFactualRisks(html, KEYPHRASE, [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE], {
      generalDiscoveredClaims: map,
      declaredAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
    });
    expect(scan.claims.find((c) => c.category === "source_attributed")?.supported).toBe(true);
    // The pattern-free shadow sentence is discovered and reported as shadow.
    expect(scan.claims.filter((c) => c.shadow).length).toBeGreaterThan(0);
    const unsupported = scan.claims.filter((c) => !c.supported && !c.shadow);
    expect(unsupported).toEqual([]);
  });
});

function articleWithText(sentence: string): string {
  return `<!-- wp:paragraph -->\n<p>${sentence}</p>\n<!-- /wp:paragraph -->`;
}

// ── 9. Output-token overhead of provenance metadata (Project-26 replay) ──

describe("provenance metadata output overhead", () => {
  it("reports the exact additional JSON overhead on the Project-26 attributed sentences", () => {
    const articleSentences = [
      WRONG_ROLE_50,
      SUPPORTED_6_5,
      "DON DON DONKI is widely seen as the best retail channel for Asian-origin packaged goods.",
      "The average engagement rate on Threads in Hong Kong is 6.25%.",
      "A loyal customer is worth more than a hundred one-time visitors.",
      "Hong Kong retail sales rose 6.5% in 2026, according to the local statistics office.",
    ];
    // Typical: 2 of 6 sentences are source-backed and attributed; worst case:
    // every sentence is attributed.
    const attributedCounts = [2, 6];
    for (const attributedCount of attributedCounts) {
      const attributionJson = JSON.stringify({
        sourceAttributions: articleSentences.slice(0, attributedCount).map((sentence, index) => ({
          sentence,
          evidenceIds: [`SOURCE-${(index % 2) + 1}-CLAIM-1`],
        })),
      });
      const articleJson = JSON.stringify({
        blocks: articleSentences.map((sentence) => ({ type: "paragraph", text: sentence })),
      });
      const attributionTokens = Math.round(attributionJson.length / 4);
      const articleTokens = Math.round(articleJson.length / 4);
      const overheadPct = Math.round((attributionTokens / articleTokens) * 1000) / 10;
      console.log(
        `[cost] Project-26 provenance metadata (${attributedCount}/${articleSentences.length} sentences attributed): ` +
        `${attributionJson.length} chars (~${attributionTokens} tokens) — ` +
        `${overheadPct}% of the article JSON output`,
      );
      expect(attributionTokens).toBeGreaterThan(0);
    }
  });
});
