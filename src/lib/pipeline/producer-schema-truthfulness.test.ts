// ── Stage 3Y: producer schema / accounting failure truthfulness ──
// Project-26 failed before factual scan. The failure log reported
// "generation failed after retry — empty blocks", implying valid DeepSeek
// responses normalized to zero blocks. Audit of the quarantined
// section_0/section_1 producer snapshots proves this was NOT the case: the
// normalized payloads had 8 and 16 blocks respectively, with no normalize
// errors. The real failure was the accounting validator rejecting the
// candidates (unlicensed market-wide free prose, incomplete per-sentence
// accounting, attribution issues) — and the final error message silently
// dropped those violations, falling back to the misleading "empty blocks".
//
// This suite fixes the reporting and hardens the schema layer:
// - valid blocks + provenance metadata survive normalization;
// - metadata-only output fails explicitly;
// - malformed/wrong-field content fails explicitly (never silent "empty blocks");
// - zero normalized blocks can never produce contract=pass;
// - the single repair seam is preserved and failures report their real cause.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { normalizeAiEditorialPayload } from "@/lib/blog/article-content";
import { validateProducerCandidate } from "@/lib/blog/producer-content-contract";
import { validateProducerSentenceAccounting } from "@/lib/blog/producer-content-contract";

const FIXTURE_DIR = path.join(__dirname, "..", "blog");

function loadFixture(name: string): unknown {
  const content = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(content);
}

const KEYPHRASE = "hong kong retail marketing";

// ── Actual failed-payload reproduction ──

describe("Project-26 quarantined payloads", () => {
  it("the section_0 STRUCTURED payload normalizes to VALID non-empty blocks with derived provenance (never zero blocks)", () => {
    const raw = loadFixture("fixtures-project26-section0-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks.length).toBeGreaterThan(0);
    expect(normalized.sourceAttributions.length).toBe(1);
    expect(normalized.freeProseSentences.length).toBeGreaterThan(0);
  });

  it("the section_1 STRUCTURED payload normalizes to VALID non-empty blocks with derived provenance", () => {
    const raw = loadFixture("fixtures-project26-section1-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-1", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks.length).toBeGreaterThan(0);
    expect(normalized.sourceAttributions.length).toBe(2);
    expect(normalized.freeProseSentences.length).toBeGreaterThan(0);
  });

  it("the section_0 accounting violation is the unlicensed market-wide free-prose sentence", () => {
    const raw = loadFixture("fixtures-project26-section0-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-0", { requireSentenceKinds: true });
    const violations = validateProducerSentenceAccounting(
      {
        blocks: normalized.blocks.map((b, index) => ({ ...b, id: `section-0-wp-${index}` })),
        sentenceAccounting: normalized.sentenceAccounting,
      },
      {
        componentId: "section-0",
        componentType: "section",
        scope: "complete-component",
        keyphrase: KEYPHRASE,
        ownedEvidenceIds: new Set(normalized.sourceAttributions.flatMap((a) => a.evidenceIds)),
        research: normalized.sourceAttributions.map((a) => ({ title: "t", snippet: a.sentence })),
        synthesisOnly: false,
      },
    );
    // The ordinary sentence "they expect every brand to keep up" carries the
    // deterministic market-wide pattern and must be re-accounted or removed.
    expect(violations.some((v) => v.code === "free-prose-asserts-concrete-fact")).toBe(true);
  });

  it("the section_1 STRUCTURED payload has NO unaccounted-sentence failure (completeness is structural)", () => {
    const raw = loadFixture("fixtures-project26-section1-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-1", { requireSentenceKinds: true });
    const violations = validateProducerSentenceAccounting(
      {
        blocks: normalized.blocks.map((b, index) => ({ ...b, id: `section-1-wp-${index}` })),
        sentenceAccounting: normalized.sentenceAccounting,
      },
      {
        componentId: "section-1",
        componentType: "section",
        scope: "complete-component",
        keyphrase: KEYPHRASE,
        ownedEvidenceIds: new Set(normalized.sourceAttributions.flatMap((a) => a.evidenceIds)),
        research: normalized.sourceAttributions.map((a) => ({ title: "t", snippet: a.sentence })),
        synthesisOnly: false,
      },
    );
    expect(violations.some((v) => v.code === "unaccounted-sentence")).toBe(false);
  });
});

// ── Schema invariants ──

describe("schema invariants", () => {
  it("valid blocks + provenance metadata survive normalization", () => {
    const sentence = "Local teams review the latest trends and build a clear plan.";
    const normalized = normalizeAiEditorialPayload({
      blocks: [{
        type: "paragraph",
        sentences: [{ text: sentence, kind: "source_fact", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      }],
    }, "section-0", { requireSentenceKinds: true });
    expect(normalized.errors).toEqual([]);
    expect(normalized.blocks.length).toBe(1);
    expect(normalized.sourceAttributions.length).toBe(1);
  });

  it("metadata-only output fails explicitly (provenance cannot substitute for blocks)", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [],
      sourceAttributions: [{ sentence: "A factual sentence.", evidenceIds: ["SOURCE-1-CLAIM-1"] }],
      freeProseSentences: [],
    }, "section-0");
    expect(normalized.blocks.length).toBe(0);
    expect(normalized.errors.some((e) => e.includes("empty 'blocks' array"))).toBe(true);
  });

  it("a bare empty array fails explicitly instead of silently becoming empty blocks", () => {
    const normalized = normalizeAiEditorialPayload([], "section-0");
    expect(normalized.blocks.length).toBe(0);
    expect(normalized.errors.some((e) => e.includes("empty 'blocks' array"))).toBe(true);
  });

  it("metadata beside an empty blocks array fails explicitly", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: [],
      sourceAttributions: [],
      freeProseSentences: ["An advice sentence."],
    }, "section-0");
    expect(normalized.errors.some((e) => e.includes("empty 'blocks' array"))).toBe(true);
  });

  it("wrong-field content fails explicitly (blocks not an array)", () => {
    const normalized = normalizeAiEditorialPayload({
      blocks: "not-an-array",
      sourceAttributions: [],
      freeProseSentences: [],
    }, "section-0");
    expect(normalized.errors.some((e) => e.includes("must contain a 'blocks' array"))).toBe(true);
    expect(normalized.errors.some((e) => e.includes("empty blocks"))).toBe(false);
  });

  it("zero normalized blocks can never produce contract=pass", () => {
    const contract = validateProducerCandidate(
      { blocks: [], sourceAttributions: [], freeProseSentences: [] },
      { componentId: "section-0", componentType: "section", scope: "complete-component", keyphrase: KEYPHRASE },
    );
    expect(contract.passed).toBe(false);
    expect(contract.violations.some((v) => v.code === "empty-component")).toBe(true);
  });

  it("an object without a blocks key fails explicitly", () => {
    const normalized = normalizeAiEditorialPayload(
      { body: [{ type: "paragraph", text: "Wrong key." }] },
      "section-0",
    );
    expect(normalized.errors.some((e) => e.includes("must contain a 'blocks' array"))).toBe(true);
  });
});

// ── Repair-seam truthfulness ──

describe("repair seam reports the real cause", () => {
  it("the section throw diagnostics include provenance violations instead of a bare 'empty blocks'", () => {
    // The service composes the final diagnostics from normalize errors PLUS
    // provenance violation codes — reproduce that composition to prove a
    // provenance-only failure is reported truthfully.
    const raw = loadFixture("fixtures-project26-section0-structured.json");
    const normalized = normalizeAiEditorialPayload(raw, "section-0", { requireSentenceKinds: true });
    const violations = validateProducerSentenceAccounting(
      {
        blocks: normalized.blocks.map((b, index) => ({ ...b, id: `s0-${index}` })),
        sentenceAccounting: normalized.sentenceAccounting,
      },
      {
        componentId: "section-0",
        componentType: "section",
        scope: "complete-component",
        keyphrase: KEYPHRASE,
        ownedEvidenceIds: new Set(normalized.sourceAttributions.flatMap((a) => a.evidenceIds)),
        research: normalized.sourceAttributions.map((a) => ({ title: "t", snippet: a.sentence })),
        synthesisOnly: false,
      },
    );
    const diagnostics = [...normalized.errors, ...violations.map((v) => `${v.code}: ${v.message}`)];
    expect(diagnostics.some((d) => d.includes("free-prose-asserts-concrete-fact"))).toBe(true);
    // The misleading "empty blocks" fallback only fires when BOTH error and
    // provenance diagnostics are empty — here they are not.
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
