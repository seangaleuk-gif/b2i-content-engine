import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  buildEditorialCallContract,
  validateEditorialCallContract,
  validateBilingualCoverage,
  editorialSourceUnitId,
  type EditorialCallContract,
} from "./document-context-shadow-preview";
import { buildFindingTokenMap, type StyleFinding } from "./cantonese-style-linter";
import { buildTranslationSourceDocument, enumerateTranslationSourceUnits, type TranslationSourceUnit } from "./translation-source-document";
import { buildBilingualEditorialBatches } from "./document-context-shadow-preview";

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(): ArticleDocument {
  return {
    metadata: { title: "Title", slug: "t", metaDescription: "Meta.", excerpt: "Ex.", targetWordCount: 1000, focusKeyphrase: "kp" },
    languageSwitcher: null,
    introduction: { id: "i", blocks: [paragraphBlock("i0", "Intro.")], status: "generated" },
    sections: [
      { id: "s0", heading: "H0", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Body.")], status: "generated" },
      { id: "s1", heading: "H1", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "Body B.")], status: "generated" },
    ],
    visibleFaq: [{ question: "Q?", answerHtml: "<p>A.</p>", answerText: "A." }],
    conclusion: { id: "c", blocks: [paragraphBlock("c0", "Conc.")], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function oneFinding(sourceUnitId: string, id: string): StyleFinding {
  return { findingId: id, sourceUnitId, category: "language", severity: "minor", instructionCode: "mixed-register" };
}

function makeContract(overrides: Partial<EditorialCallContract> = {}, opts: { ids?: string[] } = {}): EditorialCallContract {
  const ids = opts.ids ?? ["metadata.title", "section.0.heading", "section.0.block.0"];
  const sourceUnits: TranslationSourceUnit[] = ids.map((id) => ({
    sourceId: id, type: "metadata-title", text: "x", links: [] as string[], numbers: [] as string[],
  }));
  const findings = [oneFinding("section.0.block.0", "finding-1")];
  const tokenMap = buildFindingTokenMap(findings);
  const contract = buildEditorialCallContract({
    purpose: "editorial-monolingual-proofread",
    orderedSourceUnitIds: ids,
    sourceUnits,
    candidateUnits: sourceUnits,
    findings,
    tokenMap,
    sourceReferenceIds: [],
    protectedUnitIds: new Set(["cta"]),
  });
  return { ...contract, ...overrides };
}

describe("EditorialCallContract invariants", () => {
  it("a well-formed contract passes all invariants", () => {
    const contract = makeContract();
    expect(validateEditorialCallContract(contract)).toEqual([]);
    expect(contract.patchUnitKey).toBe("sourceUnitId");
    expect(contract.allowedPatchTargetIds.size).toBe(contract.orderedUnitIds.length);
  });

  it("detects duplicate ordered unit IDs", () => {
    const contract = makeContract({}, { ids: ["section.0.block.0", "section.0.block.0"] });
    expect(validateEditorialCallContract(contract).some((r) => r.code === "contract-ordered-unit-ids-not-unique")).toBe(true);
  });

  it("detects a protected unit inside the allowed scope", () => {
    const contract = makeContract({}, { ids: ["metadata.title", "cta"] });
    expect(validateEditorialCallContract(contract).some((r) => r.code === "contract-protected-unit-in-scope")).toBe(true);
  });

  it("detects a finding token owned by a unit outside the allowed scope", () => {
    const base = makeContract();
    const bad = {
      ...base,
      findingTokens: ["F001"],
      findingTokenToSourceUnitId: new Map([["F001", editorialSourceUnitId("section.9.block.9")]]),
    };
    expect(validateEditorialCallContract(bad).some((r) => r.code === "contract-token-owner-outside-scope")).toBe(true);
  });

  it("detects a source-reference unit outside the intended scope", () => {
    const base = makeContract();
    const bad = { ...base, sourceReferenceIds: [editorialSourceUnitId("section.9.block.9")] };
    expect(validateEditorialCallContract(bad).some((r) => r.code === "contract-source-ref-outside-scope")).toBe(true);
  });

  it("detects an allowed scope that does not equal ordered unit IDs", () => {
    const base = makeContract();
    const bad = { ...base, allowedPatchTargetIds: new Set([...base.allowedPatchTargetIds, editorialSourceUnitId("section.9.block.9")]) };
    expect(validateEditorialCallContract(bad).some((r) => r.code === "contract-allowed-scope-mismatch")).toBe(true);
  });
});

describe("bilingual coverage", () => {
  it("A and B are unique, non-overlapping and cover the complete editable set", () => {
    const sourceDoc = buildTranslationSourceDocument(makeDoc());
    const batches = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0);
    const completeEditable = enumerateTranslationSourceUnits(sourceDoc).filter((u) => u.type !== "cta").map((u) => u.sourceId);
    const contractA = { orderedUnitIds: batches[0].sourceUnitIds.map(editorialSourceUnitId) } as unknown as EditorialCallContract;
    const contractB = { orderedUnitIds: batches[1].sourceUnitIds.map(editorialSourceUnitId) } as unknown as EditorialCallContract;
    expect(validateBilingualCoverage(contractA, contractB, completeEditable)).toHaveLength(0);
    // Overlap detection: an overlap contract shares an id owned by B.
    const overlap = { orderedUnitIds: [batches[1].sourceUnitIds[0]].map(editorialSourceUnitId) } as unknown as EditorialCallContract;
    expect(validateBilingualCoverage(overlap, contractB, []).some((r) => r.code === "bilingual-batch-overlap")).toBe(true);
  });
});

describe("canonical identity brand", () => {
  it("editorialSourceUnitId preserves the value and brands it", () => {
    const id = editorialSourceUnitId("section.3.block.2");
    expect(String(id)).toBe("section.3.block.2");
    expect(id.length).toBe("section.3.block.2".length);
  });
});
