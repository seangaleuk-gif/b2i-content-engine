import { describe, it, expect } from "vitest";
import { lintEditorialDraft, buildEditorialFindingsPrompt, buildFindingTokenMap } from "./cantonese-style-linter";
import { validateFindingContract } from "./document-context-shadow-preview";

describe("pre-editorial Cantonese style linter", () => {
  it("identifies literal-structure classes", () => {
    const findings = lintEditorialDraft([{ sourceUnitId: "section.0.block.0", text: "品牌要對齊目標先得。" }]);
    expect(findings.some((f) => f.sourceUnitId === "section.0.block.0" && f.category === "literal-structure")).toBe(true);
  });

  it("identifies formal-register drift", () => {
    const findings = lintEditorialDraft([{ sourceUnitId: "section.0.block.0", text: "然而，呢個方法未必有效。" }]);
    expect(findings.some((f) => f.category === "formal-register")).toBe(true);
  });

  it("identifies unnecessary ordinary English but exempts brands and acronyms", () => {
    const withEnglish = lintEditorialDraft([{ sourceUnitId: "a", text: "呢個 lifestyle 係好重要。" }]);
    expect(withEnglish.some((f) => f.category === "unnecessary-code-switching" && f.safeToken === "lifestyle")).toBe(true);
    // Brands/platforms/acronyms are not flagged as ordinary code-switching.
    const withBrands = lintEditorialDraft([{ sourceUnitId: "b", text: "用 Instagram、YouTube、KPI 衡量成效。" }]);
    expect(withBrands.some((f) => f.category === "unnecessary-code-switching")).toBe(false);
  });

  it("identifies repetitive connective templates across units", () => {
    const findings = lintEditorialDraft([
      { sourceUnitId: "a", text: "所以就係點解品牌要重視呢一點。" },
      { sourceUnitId: "b", text: "所以就係點解佢哋應該持續投入。" },
    ]);
    expect(findings.filter((f) => f.category === "repetitive-template").length).toBeGreaterThanOrEqual(2);
  });

  it("identifies terminology inconsistency within a batch", () => {
    const findings = lintEditorialDraft([
      { sourceUnitId: "a", text: "代理公司幫品牌做推廣。" },
      { sourceUnitId: "b", text: "市場推廣公司可以提供更多服務。" },
    ]);
    expect(findings.some((f) => f.category === "terminology-inconsistency")).toBe(true);
  });

  it("does not produce arbitrary sentence replacements, only typed findings", () => {
    const findings = lintEditorialDraft([{ sourceUnitId: "a", text: "品牌可以睇互動率同讚好。" }]);
    expect(findings.length).toBe(0);
  });

  it("builds a compact findings prompt with the batch-scoped token contract (no canonical IDs)", () => {
    const findings = lintEditorialDraft([{ sourceUnitId: "a", text: "呢個 lifestyle 好重要。" }]);
    const tokenMap = buildFindingTokenMap(findings);
    const prompt = buildEditorialFindingsPrompt(findings, tokenMap);
    expect(prompt).toContain("EDITORIAL FINDINGS");
    // The model sees response tokens, never canonical finding IDs.
    expect(prompt).toContain('"findingToken":"F001"');
    expect(prompt).not.toContain("finding-");
    expect(prompt).toContain("resolvedFindingTokens");
    expect(prompt).toContain("reviewedUnchangedFindings");
    expect(prompt).toContain("reasonCode");
    // Tokens are deterministic and unique.
    expect(new Set(tokenMap.map((t) => t.responseToken)).size).toBe(tokenMap.length);
    expect(tokenMap[0].responseToken).toBe("F001");
    expect(tokenMap[0].canonicalFindingId).toBe(findings[0].findingId);
  });
});

describe("editorial finding contract", () => {
  const oneFinding: Parameters<typeof validateFindingContract>[0] = [
    { findingId: "finding-1", sourceUnitId: "a", category: "literal-structure", severity: "minor", instructionCode: "rewrite-alignment" },
  ];

  it("every supplied finding must be resolved or reviewed", () => {
    expect(validateFindingContract(oneFinding, { units: [] })).toEqual(["finding contract: unresolved findings finding-1"]);
    expect(validateFindingContract(oneFinding, { units: [], resolvedFindingIds: ["finding-1"] })).toEqual([]);
    expect(validateFindingContract(oneFinding, { units: [], reviewedUnchangedFindingIds: ["finding-1"] })).toEqual([]);
  });

  it("unknown finding IDs are rejected", () => {
    const failures = validateFindingContract(oneFinding, { units: [], resolvedFindingIds: ["finding-1", "bogus"] });
    expect(failures.some((f) => f.includes("unknown finding ids bogus"))).toBe(true);
  });

  it("no finding means no contract requirement", () => {
    expect(validateFindingContract([], { units: [] })).toEqual([]);
  });
});
