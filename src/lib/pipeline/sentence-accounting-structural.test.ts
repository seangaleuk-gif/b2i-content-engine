// ── Stage 3Z: structurally-coupled sentence provenance ──
// The sidecar accounting duplicated every sentence (sourceAttributions +
// freeProseSentences) and cost ~101% output overhead. The new representation
// attaches provenance TO each sentence inside the block: a paragraph is
// {"type":"paragraph","sentences":[{"text":"...","kind":"free_prose|source_fact","evidenceIds":[...]}]}
// and a list item is {"text":"...","kind":...}. Each sentence exists EXACTLY
// ONCE — completeness is structural (no sentence-matching/repetition step) —
// and the canonical sidecars are derived at normalization. The factual rules
// are unchanged: source_fact fidelity, the free_prose boundary, deterministic
// pattern backstops, the repair seam and shadow-only discovery.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { normalizeAiEditorialPayload, renderEditorialBlocksToWordPress } from "@/lib/blog/article-content";
import { validateProducerSentenceAccounting } from "@/lib/blog/producer-content-contract";
import {
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
} from "@/lib/blog/article-document";

const FIXTURE_DIR = path.join(__dirname, "..", "blog");
const KEYPHRASE = "hong kong retail marketing";

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8").replace(/^\uFEFF/, ""));
}

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(opts: {
  sectionText?: string;
  sectionAttributions?: ArticleSection["sourceAttributions"];
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

const WRONG_ROLE_50 =
  "Some retailers in Hong Kong reward staff with a 50% discount for new members when they hit service targets.";
const SUPPORTED_6_5 = "Hong Kong retail sales rose 6.5% in 2026.";
const DASHBOARD_ADVICE = "You don't need a complex dashboard to start.";

const HK_RETAIL_EVIDENCE = [{
  title: "HK Retail Management Association",
  snippet: "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
}];
const SUPPORTING_EVIDENCE = [{
  title: "HK retail sales benchmark",
  snippet: "Hong Kong retail sales rose 6.5% in 2026, according to the local statistics office.",
}];

function sectionContext(ownedEvidenceIds: ReadonlySet<string>, research: unknown[]) {
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

// ── 1. Structural completeness on the actual Project-26 fixtures ──

describe("actual Project-26 fixtures in the structural representation", () => {
  it("section_0 structured sentences normalize into blocks with provenance derived (no sidecars in the payload)", () => {
    const raw = loadFixture("fixtures-project26-section0-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks.length).toBeGreaterThan(0);
    expect(normalized.sentenceAccounting.length).toBeGreaterThan(0);
    expect(normalized.sourceAttributions.length).toBe(1);
    expect(normalized.freeProseSentences.length).toBeGreaterThan(0);
    // The payload itself never duplicates sentences in sidecars.
    expect(JSON.stringify(raw)).not.toContain("sourceAttributions");
    expect(JSON.stringify(raw)).not.toContain("freeProseSentences");
  });

  it("section_1 structured sentences produce NO unaccounted-sentence failure (completeness is structural)", () => {
    const raw = loadFixture("fixtures-project26-section1-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-1", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    const violations = validateProducerSentenceAccounting(
      {
        blocks: normalized.blocks.map((b, index) => ({ ...b, id: `s1-${index}` })),
        sentenceAccounting: normalized.sentenceAccounting,
      },
      sectionContext(
        new Set(normalized.sentenceAccounting.filter((e) => e.kind === "source_fact").flatMap((e) => e.evidenceIds)),
        normalized.sentenceAccounting
          .filter((e) => e.kind === "source_fact")
          .map((e) => ({ title: "t", snippet: e.sentence })),
      ),
    );
    // Every structured sentence is classified; only genuine fidelity/pattern
    // issues can surface — never a missing-accounting failure.
    expect(violations.some((v) => v.code === "unaccounted-sentence")).toBe(false);
  });

  it("section_0's free-prose boundary is NOT weakened — the market-wide sentence still fails", () => {
    const raw = loadFixture("fixtures-project26-section0-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-0", { requireSentenceKinds: true });
    const violations = validateProducerSentenceAccounting(
      {
        blocks: normalized.blocks.map((b, index) => ({ ...b, id: `s0-${index}` })),
        sentenceAccounting: normalized.sentenceAccounting,
      },
      sectionContext(
        new Set(normalized.sentenceAccounting.filter((e) => e.kind === "source_fact").flatMap((e) => e.evidenceIds)),
        normalized.sentenceAccounting
          .filter((e) => e.kind === "source_fact")
          .map((e) => ({ title: "t", snippet: e.sentence })),
      ),
    );
    expect(violations.some((v) => v.code === "free-prose-asserts-concrete-fact")).toBe(true);
  });
});

// ── 2/3. Fidelity unchanged ──

describe("source_fact fidelity in the structural representation", () => {
  const owned = new Set(["SOURCE-1-CLAIM-1", "SOURCE-2-CLAIM-1"]);
  const research = [...HK_RETAIL_EVIDENCE, ...SUPPORTING_EVIDENCE];

  it("the wrong-role 50% sentence structured as source_fact still fails", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", WRONG_ROLE_50)],
        sentenceAccounting: [{ sentence: WRONG_ROLE_50, kind: "source_fact", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      sectionContext(owned, research),
    );
    expect(violations.some((v) => v.code === "attribution-fidelity")).toBe(true);
  });

  it("the supported 6.5% sentence structured as source_fact passes", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", SUPPORTED_6_5)],
        sentenceAccounting: [{ sentence: SUPPORTED_6_5, kind: "source_fact", evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      },
      sectionContext(owned, research),
    );
    expect(violations).toEqual([]);
  });
});

// ── 4. Free prose ──

describe("free_prose in the structural representation", () => {
  it("ordinary guidance structured as free_prose passes", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", DASHBOARD_ADVICE)],
        sentenceAccounting: [{ sentence: DASHBOARD_ADVICE, kind: "free_prose", evidenceIds: [] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), SUPPORTING_EVIDENCE),
    );
    expect(violations).toEqual([]);
  });

  it("a free_prose sentence declaring evidenceIds is rejected", () => {
    const violations = validateProducerSentenceAccounting(
      {
        blocks: [paragraphBlock("b0", DASHBOARD_ADVICE)],
        sentenceAccounting: [{ sentence: DASHBOARD_ADVICE, kind: "free_prose", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      },
      sectionContext(new Set(["SOURCE-1-CLAIM-1"]), SUPPORTING_EVIDENCE),
    );
    expect(violations.some((v) => v.code === "free-prose-has-evidence")).toBe(true);
  });
});

// ── 5. Structural schema validation ──

describe("structural sentence schema", () => {
  it("a sentence missing its kind is rejected explicitly", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", sentences: [{ text: "A sentence without a kind." }] }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors.some((e) => e.includes("kind must be"))).toBe(true);
  });

  it("a source_fact sentence without evidenceIds is rejected explicitly", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", sentences: [{ text: "A factual sentence.", kind: "source_fact" }] }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors.some((e) => e.includes("requires owned SOURCE-N-CLAIM-M evidenceIds"))).toBe(true);
  });

  it("a free_prose sentence with evidenceIds is rejected explicitly", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{
        type: "paragraph",
        sentences: [{ text: "Advice.", kind: "free_prose", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors.some((e) => e.includes("must not declare evidenceIds"))).toBe(true);
  });

  it("a legacy text-only paragraph is rejected for factual-capable producers (requireSentenceKinds)", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: "Legacy prose with no sentence structure." }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors.some((e) => e.includes("must return structural sentences with kind"))).toBe(true);
  });

  it("synthesis-only producers keep the legacy text shape (no sentence kinds required)", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: "Synthesis-only prose." }],
    }, "intro");
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks.length).toBe(1);
    expect(normalized.sentenceAccounting).toEqual([]);
  });
});

// ── 6. Rendering is unchanged ──

describe("rendering is unchanged", () => {
  it("structural sentences render to the exact same WordPress HTML as the joined text", () => {
    const structured = normalizeAiEditorialPayload({
      blocks: [{
        type: "paragraph",
        sentences: [
          { text: DASHBOARD_ADVICE, kind: "free_prose" },
          { text: SUPPORTED_6_5, kind: "source_fact", evidenceIds: ["SOURCE-2-CLAIM-1"] },
        ],
      }],
    }, "section-0", { requireSentenceKinds: true });
    const legacy = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: `${DASHBOARD_ADVICE} ${SUPPORTED_6_5}` }],
    }, "section-0");
    expect(renderEditorialBlocksToWordPress(structured.blocks))
      .toBe(renderEditorialBlocksToWordPress(legacy.blocks));
  });
});

// ── 7. Provenance survives canonical round-trips ──

describe("provenance survives canonical round-trips", () => {
  it("derived sidecars survive render → parse and never reach WordPress HTML", () => {
    const doc = makeDoc({
      sectionText: SUPPORTED_6_5,
      sectionAttributions: [{ sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] }],
      freeProseSentences: [],
    });
    const rendered = renderArticleDocument(doc);
    expect(rendered).not.toContain("sentenceAccounting");
    expect(rendered).not.toContain("SOURCE-2-CLAIM-1");
    const reparsed = parseArticleDocumentFromHtml(rendered, doc);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.doc!.sections[0].sourceAttributions).toEqual([
      { sentence: SUPPORTED_6_5, evidenceIds: ["SOURCE-2-CLAIM-1"] },
    ]);
  });
});

// ── 8. Output-token overhead is materially lower than the sidecar approach ──

describe("output-token overhead", () => {
  it("reports the structural overhead vs the ~101% sidecar approach", () => {
    const structured = loadFixture("fixtures-project26-section0-structured.json") as {
      blocks: Array<{ type: string; sentences?: Array<{ text: string; kind: string }> }>;
    };
    const sidecar = loadFixture("fixtures-project26-section0.json") as {
      blocks: Array<{ type: string; text?: string }>;
      sourceAttributions: unknown[];
      freeProseSentences: unknown[];
    };

    // Pure-prose baseline: the same sentences WITHOUT any provenance metadata.
    const pureProseBlocks = structured.blocks.map((block) => ({
      type: block.type,
      sentences: block.sentences?.map((s) => ({ text: s.text })),
    }));
    const pureProse = JSON.stringify({ blocks: pureProseBlocks });

    // New contract payload (sentence objects carry kind — no duplication).
    const structuralJson = JSON.stringify(structured);
    // Old contract payload (sidecars duplicate every sentence).
    const sidecarJson = JSON.stringify(sidecar);

    const newOverheadPct = Math.round(((structuralJson.length - pureProse.length) / pureProse.length) * 1000) / 10;
    const oldOverheadPct = Math.round(((sidecarJson.length - pureProse.length) / pureProse.length) * 1000) / 10;

    console.log(
      `[cost] Project-26 section_0 provenance metadata: structural +${newOverheadPct}% of prose JSON ` +
      `vs sidecar +${oldOverheadPct}% (old ~101%)`,
    );
    expect(oldOverheadPct).toBeGreaterThan(80); // the ~101% baseline
    expect(newOverheadPct).toBeLessThan(oldOverheadPct / 2); // materially lower
  });
});
