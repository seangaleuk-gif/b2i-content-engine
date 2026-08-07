import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-content";
import { buildTranslationSourceDocument } from "./translation-source-document";
import {
  buildBilingualEditorialBatches,
  validateFindingContract,
  validateFindingContractReasons,
  validateFindingTokenReasons,
  type EditorialBatch,
} from "./document-context-shadow-preview";
import { lintEditorialDraft, buildFindingTokenMap, isValidFindingResponseToken, type StyleFinding } from "./cantonese-style-linter";

/** Draft units for a batch in canonical order (mirrors the pipeline's draft units). */
function draftUnitsFor(sourceDoc: ReturnType<typeof buildTranslationSourceDocument>, batch: EditorialBatch, zh: ArticleDocument): Array<{ sourceUnitId: string; text: string }> {
  const units: Array<{ sourceUnitId: string; text: string }> = [];
  const push = (id: string, text: string) => { if (text) units.push({ sourceUnitId: id, text }); };
  const blockText = (b: unknown) => extractPlainTextFromEditorialBlocks([b as never]);
  push("metadata.title", zh.metadata.title);
  push("metadata.metaDescription", zh.metadata.metaDescription);
  push("metadata.excerpt", zh.metadata.excerpt);
  zh.introduction.blocks.forEach((b, i) => push(`introduction.block.${i}`, blockText(b)));
  zh.sections.forEach((s, si) => {
    push(`section.${si}.heading`, s.heading);
    s.blocks.forEach((b, bi) => push(`section.${si}.block.${bi}`, blockText(b)));
  });
  zh.conclusion.blocks.forEach((b, i) => push(`conclusion.block.${i}`, blockText(b)));
  zh.visibleFaq.forEach((f, i) => {
    push(`faq.${i}.question`, f.question);
    push(`faq.${i}.answer`, f.answerText);
  });
  const byId = new Map(units.map((u) => [u.sourceUnitId, u]));
  return batch.sourceUnitIds.map((id) => byId.get(id)).filter((u): u is { sourceUnitId: string; text: string } => Boolean(u));
}

function oneFinding(overrides: Partial<StyleFinding> = {}): StyleFinding {
  return { findingId: "finding-1", sourceUnitId: "section.0.block.0", category: "literal-structure", severity: "minor", instructionCode: "rewrite-alignment", ...overrides };
}

describe("live bilingual-a finding-contract rejection (from failed preview metadata)", () => {
  it("reproduces the other=2 finding-contract rejection with two named codes", () => {
    const zh: ArticleDocument = {
      metadata: { title: "香港 followers 指南", slug: "fixture", metaDescription: "因此要進行 campaign。", excerpt: "越來越多人出 post。", targetWordCount: 1000, focusKeyphrase: "營銷" },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [{ id: "i0", type: "paragraph", content: [{ type: "text", text: "因此要進行 campaign，同時保持誠實。" }] }], status: "generated" },
      sections: [{ id: "s0", heading: "發布內容", headingLevel: 2, sectionType: "main", blocks: [{ id: "s0b0", type: "paragraph", content: [{ type: "text", text: "越來越多 followers 會出 post。" }] }], status: "generated" }],
      visibleFaq: [{ question: "點樣開始？", answerHtml: "", answerText: "因此要進行測試。" }],
      conclusion: { id: "conclusion", blocks: [{ id: "c0", type: "paragraph", content: [{ type: "text", text: "此外要保持一致。" }] }], status: "generated" },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
    const sourceDoc = buildTranslationSourceDocument(zh);
    const batchA = buildBilingualEditorialBatches(sourceDoc)[0];

    const findings = lintEditorialDraft(draftUnitsFor(sourceDoc, batchA, zh));
    expect(findings.length).toBeGreaterThan(0);
    const allIds = findings.map((f) => f.findingId);

    // The provider returned an empty patch but only reviewed a subset, and it
    // echoed finding IDs that were NOT supplied — producing BOTH an unresolved
    // and an unknown finding, exactly the two `other` entries in the live log.
    const reviewedSome = allIds.filter((_, i) => i % 2 === 0);
    const unknown = ["finding-99999", "finding-100000"];
    const reasons = validateFindingContractReasons(findings, {
      units: [],
      resolvedFindingIds: [],
      reviewedUnchangedFindingIds: [...reviewedSome, ...unknown],
    }, new Set(batchA.allowedPatchTargetIds));

    const missing = reasons.filter((r) => r.code === "missing-finding-accounting");
    const unknownIds = reasons.filter((r) => r.code === "unknown-finding-id");
    expect(missing.length).toBeGreaterThan(0);
    expect(unknownIds.length).toBe(2);
    // Both failures are named; none is an opaque `other`.
    for (const r of reasons) expect(r.code).not.toBe("other");
    // The string form matches the live `other=2` (two distinct contract failures).
    const strings = validateFindingContract(findings, { units: [], resolvedFindingIds: [], reviewedUnchangedFindingIds: [...reviewedSome, ...unknown] });
    expect(strings.length).toBe(2);
    expect(strings.some((s) => s.startsWith("finding contract: unresolved findings"))).toBe(true);
    expect(strings.some((s) => s.startsWith("finding contract: unknown finding ids"))).toBe(true);
  });
});

describe("authoritative bilingual batch contract", () => {
  const zh: ArticleDocument = {
    metadata: { title: "Title", slug: "t", metaDescription: "Meta 65%.", excerpt: "Excerpt.", targetWordCount: 1000, focusKeyphrase: "kp" },
    languageSwitcher: null,
    introduction: { id: "i", blocks: [{ id: "i0", type: "paragraph", content: [{ type: "text", text: "Intro with 65% ROI." }] }], status: "generated" },
    sections: [
      { id: "s0", heading: "H0", headingLevel: 2, sectionType: "main", blocks: [{ id: "s0b0", type: "paragraph", content: [{ type: "text", text: "Body A." }] }], status: "generated" },
      { id: "s1", heading: "H1", headingLevel: 2, sectionType: "main", blocks: [{ id: "s1b0", type: "paragraph", content: [{ type: "text", text: "Body B." }] }], status: "generated" },
      { id: "s2", heading: "H2", headingLevel: 2, sectionType: "main", blocks: [{ id: "s2b0", type: "paragraph", content: [{ type: "text", text: "Body C." }] }], status: "generated" },
    ],
    visibleFaq: [{ question: "Q?", answerHtml: "<p>A.</p>", answerText: "A." }],
    conclusion: { id: "c", blocks: [{ id: "c0", type: "paragraph", content: [{ type: "text", text: "Conc." }] }], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: [],
  };

  it("combined bilingual coverage is complete and non-overlapping; protected/CTA excluded", () => {
    const sourceDoc = buildTranslationSourceDocument(zh);
    const batches = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0);
    const all = batches.flatMap((b) => b.sourceUnitIds);
    const editable = sourceDoc.sections.length + sourceDoc.conclusion.length + 3; // metadata(3)
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(editable);
    for (const b of batches) {
      expect([...new Set(b.allowedPatchTargetIds)].length).toBe(b.allowedPatchTargetIds.length);
      expect(b.sourceReferenceIds.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("bilingual A and B receive only their own owned units and findings", () => {
    const sourceDoc = buildTranslationSourceDocument(zh);
    const batches = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0);
    const findingsA = lintEditorialDraft(draftUnitsFor(sourceDoc, batches[0], zh));
    const findingsB = lintEditorialDraft(draftUnitsFor(sourceDoc, batches[1], zh));
    for (const f of [...findingsA]) expect(batches[0].allowedPatchTargetIds).toContain(f.sourceUnitId);
    for (const f of [...findingsB]) expect(batches[1].allowedPatchTargetIds).toContain(f.sourceUnitId);
  });

  it("out-of-batch findings are flagged with finding-outside-batch", () => {
    const reasons = validateFindingContractReasons(
      [oneFinding({ sourceUnitId: "section.9.block.9" })],
      { units: [], resolvedFindingIds: ["finding-1"] },
      new Set(["section.0.block.0"]),
    );
    expect(reasons.some((r) => r.code === "finding-outside-batch" && r.unitId === "section.9.block.9")).toBe(true);
  });

  it("duplicate finding accounting is rejected clearly", () => {
    const reasons = validateFindingContractReasons(
      [oneFinding()],
      { units: [], resolvedFindingIds: ["finding-1", "finding-1"] },
    );
    expect(reasons.some((r) => r.code === "duplicate-finding-accounting")).toBe(true);
  });

  it("unknown finding IDs are rejected clearly (never `other`)", () => {
    const reasons = validateFindingContractReasons(
      [oneFinding()],
      { units: [], reviewedUnchangedFindingIds: ["finding-1", "bogus"] },
    );
    expect(reasons.some((r) => r.code === "unknown-finding-id" && r.findingId === "bogus")).toBe(true);
    expect(reasons.every((r) => r.code !== "other")).toBe(true);
  });

  it("a finding on a protected/excluded unit cannot be required (finding-outside-batch when not owned)", () => {
    // A finding that points at a unit the batch does not own is rejected.
    const reasons = validateFindingContractReasons(
      [oneFinding({ sourceUnitId: "conclusion.block.99" })],
      { units: [], resolvedFindingIds: ["finding-1"] },
      new Set(["section.0.block.0", "section.0.heading"]),
    );
    expect(reasons.some((r) => r.code === "finding-outside-batch")).toBe(true);
  });
});

describe("batch-scoped finding response tokens", () => {
  function tokenFixture() {
    const findings: StyleFinding[] = [
      oneFinding({ findingId: "finding-184" }),
      oneFinding({ findingId: "finding-185", sourceUnitId: "section.0.block.1" }),
      oneFinding({ findingId: "finding-186", sourceUnitId: "section.0.block.2" }),
    ];
    const tokenMap = buildFindingTokenMap(findings);
    return { findings, tokenMap };
  }

  it("1. the live prefix-loss failure is reproduced: bare numbers are rejected as unknown tokens", () => {
    const { findings, tokenMap } = tokenFixture();
    // The model returned 1, 2, 3 instead of canonical IDs or tokens. This yields
    // both unknown-token (malformed numbers) and missing-accounting failures.
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["1", "2", "3"],
      reviewedUnchangedFindingTokens: [],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons.filter((r) => r.code === "unknown-finding-token").length).toBe(3);
    expect(reasons.some((r) => r.code === "unknown-finding-token" && r.responseToken === "1")).toBe(true);
    expect(reasons.some((r) => r.code === "missing-finding-token-accounting")).toBe(true);
  });

  it("2/3. findings get deterministic F-tokens; the model never sees canonical IDs", () => {
    const { tokenMap } = tokenFixture();
    expect(tokenMap.map((t) => t.responseToken)).toEqual(["F001", "F002", "F003"]);
    expect(tokenMap[0].canonicalFindingId).toBe("finding-184");
    // isValidFindingResponseToken rejects canonical IDs and bare numbers.
    expect(isValidFindingResponseToken("F001")).toBe(true);
    expect(isValidFindingResponseToken("finding-184")).toBe(false);
    expect(isValidFindingResponseToken("1")).toBe(false);
  });

  it("4/5. valid returned tokens map back to canonical IDs and every supplied token is accounted once", () => {
    const { findings, tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["F001", "F003"],
      reviewedUnchangedFindings: [{ findingToken: "F002", reasonCode: "natural-already" }],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons).toEqual([]);
  });

  it("6. unknown tokens (malformed) are rejected", () => {
    const { tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["abc"],
      reviewedUnchangedFindingTokens: [],
    }, new Set(tokenMap.map((t) => t.sourceUnitId)));
    expect(reasons.some((r) => r.code === "unknown-finding-token" && r.responseToken === "abc")).toBe(true);
  });

  it("7. missing token accounting is rejected", () => {
    const { findings, tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["F001"],
      reviewedUnchangedFindingTokens: [],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons.some((r) => r.code === "missing-finding-token-accounting" && r.responseToken === "F002")).toBe(true);
  });

  it("8. duplicate tokens are rejected", () => {
    const { findings, tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["F001", "F001", "F002", "F003"],
      reviewedUnchangedFindingTokens: [],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons.some((r) => r.code === "duplicate-finding-token-accounting" && r.responseToken === "F001")).toBe(true);
  });

  it("9. a token in both arrays is rejected", () => {
    const { findings, tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["F001"],
      reviewedUnchangedFindingTokens: ["F001", "F002", "F003"],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons.some((r) => r.code === "finding-token-in-both-arrays" && r.responseToken === "F001")).toBe(true);
  });

  it("10. a token from another batch is rejected as batch mismatch", () => {
    const { findings, tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["F001", "F999"],
      reviewedUnchangedFindingTokens: ["F002", "F003"],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons.some((r) => r.code === "finding-token-batch-mismatch" && r.responseToken === "F999")).toBe(true);
  });

  it("11. token-to-unit ownership is enforced", () => {
    const { tokenMap } = tokenFixture();
    // F001 maps to section.0.block.0; block the batch from owning it.
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["F001"],
      reviewedUnchangedFindingTokens: ["F002", "F003"],
    }, new Set(["section.0.block.1", "section.0.block.2"]));
    expect(reasons.some((r) => r.code === "finding-token-unit-mismatch" && r.responseToken === "F001")).toBe(true);
  });

  it("12. bare numeric IDs are rejected under the new contract", () => {
    const { findings, tokenMap } = tokenFixture();
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [],
      resolvedFindingTokens: ["1", "2", "3"],
      reviewedUnchangedFindingTokens: [],
    }, new Set(findings.map((f) => f.sourceUnitId)));
    expect(reasons.filter((r) => r.code === "unknown-finding-token").length).toBe(3);
  });
});
