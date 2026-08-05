import { describe, it, expect } from "vitest";
import {
  lintMonolingualDocument,
  lintEditorialDraft,
  isHardRuleFinding,
  compareProofreadFindings,
  classifyHardFindings,
  evaluateHardFindingResolution,
  isValidHardFindingWaiver,
  buildFindingTokenMap,
  buildEditorialFindingsPrompt,
  buildMonolingualFindingsPrompt,
  dedupeStyleFindings,
  type StyleFinding,
  type ActionableHardFinding,
} from "./cantonese-style-linter";import {
  approvedPublisherName,
  isHostnameDerivedPublisherName,
  derivePublisherName,
} from "./source-reference-localization";
import {
  ZH_HK_PREFERRED_TERMS,
  ZH_HK_ALLOWED_ENGLISH_TERMS,
  ZH_HK_AVOIDABLE_ENGLISH_TERMS,
  ZH_HK_HARD_RULES,
  ZH_HK_ADVISORY_RULES,
  ZH_HK_AVOIDED_TO_PREFERRED,
  buildAvoidedTerminologyGuidance,
  preferredReplacementFor,
} from "./zh-hk-style-contract";
import { validateMonolingualReviewedFindings, resolveMonolingualFindingDispositions } from "./document-context-shadow-preview";
import { buildShadowMonolingualSystemPrompt } from "./document-context-translation-shadow-prompt";

const lintOne = (text: string): StyleFinding[] => lintMonolingualDocument([{ sourceUnitId: "section.0.block.0", text }]);

const hard = (id: string, unit = "a", rule = "mainland-register"): StyleFinding => ({ findingId: id, sourceUnitId: unit, category: "formal-register", severity: "minor", instructionCode: rule });
const advisory = (id: string): StyleFinding => ({ findingId: id, sourceUnitId: "a", category: "language", severity: "advisory", instructionCode: "minor-rhythm" });
const actionable = (unit: string, rule: string): { sourceUnitId: string; ruleId: string } => ({ sourceUnitId: unit, ruleId: rule });


describe("register drift detection", () => {
  it.each(["越來越快", "正在了解", "儘管如此", "針對呢個人口群組"])("%s → mainland-register", (text) => {
    expect(lintOne(text).some((f) => f.instructionCode === "mainland-register")).toBe(true);
  });
  it("在於 → mixed-register", () => {
    expect(lintOne("在於對話").some((f) => f.instructionCode === "mixed-register")).toBe(true);
  });
});

describe("avoidable code-switching detection", () => {
  it("出 post is flagged", () => {
    expect(lintOne("出 post 同追蹤 followers").some((f) => f.instructionCode === "avoidable-code-switching")).toBe(true);
  });
  it("approved English terms are allowed", () => {
    expect(ZH_HK_ALLOWED_ENGLISH_TERMS.has("KPI")).toBe(true);
    expect(ZH_HK_ALLOWED_ENGLISH_TERMS.has("B2I Hub")).toBe(true);
    // A unit with only approved terms is not flagged for code-switching.
    const f = lintOne("用 KPI 衡量 Instagram 嘅表現");
    expect(f.some((x) => x.instructionCode === "avoidable-code-switching")).toBe(false);
  });
});

describe("unnatural terminology detection", () => {
  it.each(["投入互動粉絲", "追蹤群", "大名字", "活動廣告板", "針對啱嘅人口群組", "太控制慾強"])("%s → unnatural-terminology", (text) => {
    expect(lintOne(text).some((f) => f.instructionCode === "unnatural-terminology")).toBe(true);
  });
  it("preferred terminology map is populated", () => {
    expect(ZH_HK_PREFERRED_TERMS.get("follower base")).toBe("粉絲群");
    expect(ZH_HK_PREFERRED_TERMS.get("creator marketing agency")).toBe("創作者市場推廣公司");
    expect(ZH_HK_AVOIDABLE_ENGLISH_TERMS.get("post")).toBe("貼文");
  });
});

describe("literal-English structure detection", () => {
  it.each(["追住最大嘅名氣", "擴大做得好嘅嘢", "觀眾會獎勵嗰啲創作者"])("%s → literal-english", (text) => {
    expect(lintOne(text).some((f) => f.instructionCode === "literal-english-syntax" || f.instructionCode === "literal-metaphor")).toBe(true);
  });
});

describe("slang policy", () => {
  it("excessive slang is flagged", () => {
    expect(lintOne("呢個方案靚到爆").some((f) => f.instructionCode === "excessive-slang")).toBe(true);
    expect(lintOne("佢哋有料到").some((f) => f.instructionCode === "excessive-slang")).toBe(true);
  });
  it("mild conversational Cantonese in moderation is allowed", () => {
    expect(lintOne("合作最緊要夾，貼地啲講").some((f) => f.instructionCode === "excessive-slang")).toBe(false);
  });
});

describe("hard vs advisory rules", () => {
  it("hard and advisory rule sets are non-empty and use stable IDs", () => {
    expect(ZH_HK_HARD_RULES.length).toBeGreaterThan(0);
    expect(ZH_HK_ADVISORY_RULES.length).toBeGreaterThan(0);
    for (const r of ZH_HK_HARD_RULES) expect(r.severity).toBe("hard");
    for (const r of ZH_HK_ADVISORY_RULES) expect(r.severity).toBe("advisory");
  });
  it("isHardRuleFinding classifies by rule ID", () => {
    expect(isHardRuleFinding({ findingId: "f1", sourceUnitId: "x", category: "formal-register", severity: "minor", instructionCode: "mainland-register" })).toBe(true);
    expect(isHardRuleFinding({ findingId: "f1", sourceUnitId: "x", category: "language", severity: "advisory", instructionCode: "minor-rhythm" })).toBe(false);
  });
});

describe("before/after quality gate comparison", () => {
  const hard = (id: string): StyleFinding => ({ findingId: id, sourceUnitId: "a", category: "formal-register", severity: "minor", instructionCode: "mainland-register" });
  const advisory = (id: string): StyleFinding => ({ findingId: id, sourceUnitId: "a", category: "language", severity: "advisory", instructionCode: "minor-rhythm" });

  it("resolving a hard finding while leaving advisory findings is accepted", () => {
    const before = [hard("f1")];
    const after = [advisory("f2")];
    const comp = compareProofreadFindings(before, after, ["a"])[0];
    expect(comp.resolvedRuleIds).toEqual(["mainland-register"]);
    expect(comp.introducedRuleIds).toEqual([]);
    expect(comp.remainingRuleIds).toEqual([]);
  });

  it("introducing a hard finding is rejected", () => {
    const before: StyleFinding[] = [];
    const after = [hard("f1")];
    const comp = compareProofreadFindings(before, after, ["a"])[0];
    expect(comp.introducedRuleIds).toEqual(["mainland-register"]);
  });

  it("a remaining hard finding is neither resolved nor introduced", () => {
    const before = [hard("f1")];
    const after = [hard("f1")];
    const comp = compareProofreadFindings(before, after, ["a"])[0];
    expect(comp.resolvedRuleIds).toEqual([]);
    expect(comp.introducedRuleIds).toEqual([]);
    expect(comp.remainingRuleIds).toEqual(["mainland-register"]);
  });
});

describe("actionable hard-finding classification + final resolution gate", () => {
  const noWaiver = (): undefined => undefined;

  it("1. a pre-existing hard finding in an unchanged unit rejects", () => {
    const before = [actionable("section.2.block.4", "mainland-register")];
    // After proofread the unchanged unit still contains the same hard rule.
    const after = [hard("f1", "section.2.block.4")];
    const { remaining } = evaluateHardFindingResolution(before, after);
    expect(remaining.map((r) => r.ruleId)).toEqual(["mainland-register"]);
  });

  it("2. a changed unit retaining the same hard finding is rejected", () => {
    const before = [actionable("a", "mainland-register")];
    const after = [hard("f2", "a")]; // changed but same rule remains
    const { remaining } = evaluateHardFindingResolution(before, after);
    expect(remaining.length).toBe(1);
  });

  it("3. resolving all hard findings while leaving advisory findings is accepted", () => {
    const before = [actionable("a", "mainland-register")];
    const after = [advisory("f2")];
    const { remaining, introduced } = evaluateHardFindingResolution(before, after);
    expect(remaining).toEqual([]);
    expect(introduced).toEqual([]);
  });

  it("4. introducing a different hard finding is rejected", () => {
    const before = [actionable("a", "mainland-register")];
    // The original is resolved but a DIFFERENT hard rule is introduced in its place.
    const after = [hard("f2", "a", "avoidable-code-switching")];
    const { remaining, introduced } = evaluateHardFindingResolution(before, after);
    expect(remaining).toEqual([]);
    expect(introduced.map((i) => i.ruleId)).toEqual(["avoidable-code-switching"]);
  });

  it("5. every actionable hard finding is supplied with exactly one token", () => {
    const before = [hard("f1", "a", "mainland-register"), hard("f2", "b", "avoidable-code-switching")];
    const classification = classifyHardFindings(before, { isProtectedUnit: () => false, waiverFor: noWaiver });
    expect(classification.actionable.length).toBe(2);
    const tokenMap = buildFindingTokenMap(before);
    const ids = new Set(tokenMap.map((t) => t.canonicalFindingId));
    for (const a of classification.actionable) expect(ids.has(a.findingId ?? "")).toBe(true);
  });

  it("6. a missing hard-finding token would fail before the provider call", () => {
    // Simulate a hard finding whose token is NOT in the supplied map.
    const findings = [hard("f1", "a")];
    const partialTokenMap = buildFindingTokenMap(findings.filter((f) => f.findingId !== "f1"));
    expect(partialTokenMap.some((t) => t.canonicalFindingId === "f1")).toBe(false);
  });

  it("7. protected units and approved brands are deterministically waived", () => {
    const findings = [
      hard("f1", "cta", "avoidable-code-switching"),
      hard("f2", "section.0.block.0", "avoidable-code-switching"),
    ];
    const classification = classifyHardFindings(findings, {
      isProtectedUnit: (id) => id === "cta",
      waiverFor: (f) => (f.safeToken && ZH_HK_ALLOWED_ENGLISH_TERMS.has(f.safeToken) ? "approved-brand" : undefined),
    });
    expect(classification.waived.some((w) => w.sourceUnitId === "cta" && w.waiverCode === "protected-unit")).toBe(true);
    expect(classification.actionable.length).toBe(1);
  });

  it("8. arbitrary waivers are rejected; only deterministic codes are valid", () => {
    expect(isValidHardFindingWaiver("protected-unit")).toBe(true);
    expect(isValidHardFindingWaiver("approved-brand")).toBe(true);
    expect(isValidHardFindingWaiver("url-part")).toBe(true);
    expect(isValidHardFindingWaiver("make-it-ok")).toBe(false);
    expect(isValidHardFindingWaiver("model-says-fine")).toBe(false);
  });

  it("9. full-document linting runs after patch application", () => {
    // evaluateHardFindingResolution compares the complete after-findings set, not
    // only changed units: an unchanged unit (b) with a hard finding is still remaining.
    const before = [actionable("a", "mainland-register"), actionable("b", "mainland-register")];
    const after = [hard("f2", "b")]; // only a was resolved; b unchanged and remains
    const { remaining } = evaluateHardFindingResolution(before, after);
    expect(remaining.map((r) => r.sourceUnitId)).toEqual(["b"]);
  });
});

describe("source display quality", () => {
  it("approved publisher names are used, never hostname-derived slugs", () => {
    expect(derivePublisherName("https://www.anymindgroup.com/x")).toBe("AnyMind Group");
    expect(derivePublisherName("https://www.openinfluence.com/")).toBe("Open Influence");
    expect(approvedPublisherName("https://influencermarketinghub.com/")).toBe("Influencer Marketing Hub");
    expect(derivePublisherName("https://www.starngage.com/")).toBe("StarNgage");
  });
  it("hostname-derived slugs are rejected", () => {
    expect(isHostnameDerivedPublisherName("Anymindgroup")).toBe(true);
    expect(isHostnameDerivedPublisherName("Openinfluence")).toBe(true);
    expect(isHostnameDerivedPublisherName("Influencermarketinghub")).toBe(true);
    expect(isHostnameDerivedPublisherName("Starngage")).toBe(true);
    expect(isHostnameDerivedPublisherName("AnyMind Group")).toBe(false);
    expect(isHostnameDerivedPublisherName("")).toBe(false);
  });
  it("an unknown host never invents a publisher", () => {
    expect(derivePublisherName("https://unknown-host-123.com/x")).toBeUndefined();
  });
});

describe("recalibrated hard/advisory severity (post-audit)", () => {
  const find = (code: string) => (text: string): boolean => lintOne(text).some((f) => f.instructionCode === code);
  const anyHard = (text: string): boolean => lintOne(text).some((f) => isHardRuleFinding(f));

  it("1. mixed-register is advisory", () => {
    expect(isHardRuleFinding(hard("f", "a", "mixed-register"))).toBe(false);
    expect(find("mixed-register")("關鍵在於揀啲同觀眾有真實連結嘅創作者。")).toBe(true);
    expect(anyHard("關鍵在於揀啲同觀眾有真實連結嘅創作者。")).toBe(false);
  });

  it("2. excessive-slang is advisory", () => {
    expect(isHardRuleFinding(hard("f", "a", "excessive-slang"))).toBe(false);
    expect(find("excessive-slang")("呢個貼文爆紅咗。")).toBe(true);
    expect(anyHard("呢個貼文爆紅咗。")).toBe(false);
  });

  it("3. unnatural-terminology is advisory", () => {
    expect(isHardRuleFinding(hard("f", "a", "unnatural-terminology"))).toBe(false);
    expect(find("unnatural-terminology")("互動率高嘅追蹤群好重要。")).toBe(true);
    expect(anyHard("互動率高嘅追蹤群好重要。")).toBe(false);
  });

  it("4. literal-english-syntax is advisory", () => {
    expect(isHardRuleFinding(hard("f", "a", "literal-english-syntax"))).toBe(false);
    expect(find("literal-english-syntax")("測試、學習，然後擴大做得好嘅嘢。")).toBe(true);
    expect(anyHard("測試、學習，然後擴大做得好嘅嘢。")).toBe(false);
  });

  it("5. mainland-register remains hard", () => {
    expect(isHardRuleFinding(hard("f", "a", "mainland-register"))).toBe(true);
    expect(find("mainland-register")("如果你正在了解香港嘅創作者市場推廣。")).toBe(true);
    expect(anyHard("如果你正在了解香港嘅創作者市場推廣。")).toBe(true);
  });

  it("6. avoidable-code-switching remains hard", () => {
    expect(isHardRuleFinding(hard("f", "a", "avoidable-code-switching"))).toBe(true);
    expect(find("avoidable-code-switching")("出 post 好簡單。")).toBe(true);
    expect(anyHard("出 post 好簡單。")).toBe(true);
  });

  it("7. remaining advisory findings do not reject the monolingual stage", () => {
    const before = classifyHardFindings(
      [hard("f1", "a", "mixed-register"), hard("f2", "b", "excessive-slang")],
      { isProtectedUnit: () => false, waiverFor: () => undefined },
    );
    expect(before.actionable.length).toBe(0); // both advisory → not actionable
    const after = [hard("f1", "a", "mixed-register")];
    const { remaining, introduced } = evaluateHardFindingResolution(before.actionable, after);
    expect(remaining.length).toBe(0);
    expect(introduced.length).toBe(0);
  });

  it("8. remaining hard findings still reject", () => {
    const before = [actionable("a", "mainland-register")];
    const after = [hard("f1", "a", "mainland-register")];
    const { remaining } = evaluateHardFindingResolution(before, after);
    expect(remaining.map((r) => r.ruleId)).toEqual(["mainland-register"]);
  });

  it("9. newly introduced hard findings still reject", () => {
    const before: ActionableHardFinding[] = [];
    const after = [hard("f1", "a", "mainland-register")];
    const { introduced } = evaluateHardFindingResolution(before, after);
    expect(introduced.map((i) => i.ruleId)).toEqual(["mainland-register"]);
  });

  it("10. safeToken appears as matchedPhrase in bilingual findings prompts", () => {
    const f: StyleFinding = { findingId: "finding-1", sourceUnitId: "faq.2.answer", category: "terminology-inconsistency", severity: "minor", instructionCode: "unnatural-terminology", safeToken: "追蹤群" };
    const prompt = buildEditorialFindingsPrompt([f], buildFindingTokenMap([f]));
    expect(prompt).toContain('"matchedPhrase":"追蹤群"');
    expect(prompt).toContain('"preferredReplacement":"粉絲群"');
  });

  it("11. safeToken appears as matchedPhrase in the monolingual findings prompt", () => {
    const f: StyleFinding = { findingId: "finding-1", sourceUnitId: "faq.3.answer", category: "terminology-inconsistency", severity: "minor", instructionCode: "unnatural-terminology", safeToken: "大名字" };
    const prompt = buildMonolingualFindingsPrompt([f], buildFindingTokenMap([f]));
    expect(prompt).toContain('"matchedPhrase":"大名字"');
  });

  it("12. preferred replacements appear for avoided terms where available", () => {
    expect(preferredReplacementFor("追蹤群")).toBe("粉絲群");
    expect(preferredReplacementFor("擴大做得好嘅嘢")).toBe("將有效嘅做法逐步擴大");
    expect(preferredReplacementFor("針對啱嘅人口群組")).toBe("搵出最合適嘅目標客群");
    // No single safe replacement → no replacement, just matched phrase + instruction.
    expect(preferredReplacementFor("活動廣告板")).toBeUndefined();
    expect(preferredReplacementFor("大名字")).toBeUndefined();
  });

  it("13. the preferred terminology map actually reaches the model prompts", () => {
    expect(ZH_HK_AVOIDED_TO_PREFERRED.size).toBeGreaterThan(0);
    const guidance = buildAvoidedTerminologyGuidance([], { includeAll: true });
    expect(guidance).toContain("追蹤群 → 粉絲群");
    expect(guidance).toContain("Use the approved preferred wording.");
    // Relevance: only markers present in the given texts are emitted.
    expect(buildAvoidedTerminologyGuidance(["呢個追蹤群好細"], {})).toContain("追蹤群 → 粉絲群");
    expect(buildAvoidedTerminologyGuidance(["純正自然嘅廣東話"], {})).toBe("");
    // The instruction never appears without preferred wording.
    expect(buildAvoidedTerminologyGuidance(["純正自然嘅廣東話"], {})).not.toContain("Use the approved preferred wording.");
  });

  it("14. 關鍵在於 does not block publication", () => {
    const f = lintOne("關鍵在於揀啲同觀眾有真實連結嘅創作者。");
    expect(f.some((x) => x.instructionCode === "mixed-register")).toBe(true);
    expect(f.some((x) => isHardRuleFinding(x))).toBe(false);
  });

  it("15. a single use of 爆紅 / 冇癮 / 一千個心心 does not block publication", () => {
    for (const t of ["呢個貼文爆紅咗。", "邊句會俾人覺得冇癮。", "比起一千個心心仲有說服力。"]) {
      expect(lintOne(t).some((x) => isHardRuleFinding(x))).toBe(false);
    }
  });

  it("16. 出 post remains hard", () => {
    expect(anyHard("畀錢佢出個 post 咁簡單。")).toBe(true);
  });

  it("17. 越來越 / 正在 / 儘管 remain hard under the current policy", () => {
    for (const t of ["呢度嘅受眾越來越精明。", "如果你正在了解呢件事。", "儘管有潛力，都可能失敗。"]) {
      expect(anyHard(t)).toBe(true);
    }
  });

  it("18. the same phrase is not emitted twice under overlapping style categories", () => {
    const overlap: StyleFinding[] = [
      { findingId: "f1", sourceUnitId: "section.1.block.12", category: "literal-structure", severity: "minor", instructionCode: "literal-english-syntax", safeToken: "擴大做得好嘅嘢" },
      { findingId: "f2", sourceUnitId: "section.1.block.12", category: "terminology-inconsistency", severity: "minor", instructionCode: "unnatural-terminology", safeToken: "擴大做得好嘅嘢" },
    ];
    const deduped = dedupeStyleFindings(overlap);
    expect(deduped.length).toBe(1);
    expect(deduped[0].instructionCode).toBe("literal-english-syntax");
    // The linter itself emits it once for the real phrase.
    const findings = lintEditorialDraft([{ sourceUnitId: "section.1.block.12", text: "測試、學習，然後擴大做得好嘅嘢。" }]);
    expect(findings.filter((f) => f.instructionCode === "literal-english-syntax").length).toBe(1);
    expect(findings.filter((f) => f.instructionCode === "unnatural-terminology").length).toBe(0);
    expect(new Set(findings.map((f) => `${f.sourceUnitId}\u0000${f.safeToken}`)).size).toBe(findings.length);
  });

  it("19. dedupeStyleFindings preserves unrelated findings in the same unit", () => {
    const findings = lintEditorialDraft([
      { sourceUnitId: "a", text: "所以就係點解品牌要重視呢一點。" },
      { sourceUnitId: "b", text: "所以就係點解佢哋應該持續投入。" },
    ]);
    // rewrite-tautology (literal-structure) and vary-connective (repetitive-template)
    // share a span but are unrelated rules; both must survive.
    expect(findings.filter((f) => f.category === "repetitive-template").length).toBe(2);
    expect(findings.filter((f) => f.category === "literal-structure").length).toBe(2);
    expect(findings.filter((f) => f.instructionCode === "vary-connective").length).toBe(2);
  });

  it("21. the latest 11-finding fixture passes the gate when only those advisory findings remain", () => {
    const elevenUnits = [
      { sourceUnitId: "section.0.block.1", text: "而唔係活動廣告板嘅創作者。" },
      { sourceUnitId: "section.1.block.2", text: "關鍵在於揀啲同觀眾有真實連結嘅創作者。" },
      { sourceUnitId: "section.1.block.12", text: "測試、學習，然後擴大做得好嘅嘢。" },
      { sourceUnitId: "section.3.block.3", text: "邊句會俾人覺得冇癮。" },
      { sourceUnitId: "section.3.block.4", text: "避開一啲靜靜雞搞垮推廣活動嘅錯誤。" },
      { sourceUnitId: "section.5.block.4", text: "比起一千個心心仲有說服力。" },
      { sourceUnitId: "section.5.block.12", text: "同某個爆紅貼文比較。" },
      { sourceUnitId: "conclusion.block.4", text: "唔係在於更大聲嘅廣告。" },
      { sourceUnitId: "faq.2.answer", text: "互動率高嘅追蹤群。" },
      { sourceUnitId: "faq.3.answer", text: "幾個大名字可以帶嚟觸及率。" },
    ];
    const findings = lintMonolingualDocument(elevenUnits);
    // Every one of the 11 is now advisory — none is actionable (hard).
    const classification = classifyHardFindings(findings, { isProtectedUnit: () => false, waiverFor: () => undefined });
    expect(classification.actionable.length).toBe(0);
    const { remaining, introduced } = evaluateHardFindingResolution(classification.actionable, findings);
    expect(remaining.length).toBe(0);
    expect(introduced.length).toBe(0);
  });

  it("22. a document with one unresolved genuine hard finding still fails", () => {
    const doc = [{ sourceUnitId: "section.0.block.0", text: "如果你正在了解香港嘅創作者市場推廣。" }];
    const before = lintMonolingualDocument(doc);
    const classification = classifyHardFindings(before, { isProtectedUnit: () => false, waiverFor: () => undefined });
    expect(classification.actionable.length).toBe(1);
    expect(classification.actionable[0].ruleId).toBe("mainland-register");
    const { remaining } = evaluateHardFindingResolution(classification.actionable, before);
    expect(remaining.length).toBe(1);
    expect(remaining[0].ruleId).toBe("mainland-register");
  });

  it("23. deterministic source validation remains unchanged and source rules are not linter-hard", () => {
    expect(derivePublisherName("https://www.anymindgroup.com/x")).toBe("AnyMind Group");
    expect(approvedPublisherName("https://starngage.com/")).toBe("StarNgage");
    for (const code of ["source-publisher-slug", "unlocalized-source-title", "malformed-cantonese"]) {
      expect(isHardRuleFinding(hard("f", "a", code))).toBe(false);
    }
  });
});

describe("monolingual deterministic local resolution (post-v21)", () => {
  const f: StyleFinding = { findingId: "finding-1", sourceUnitId: "section.0.block.1", category: "language", severity: "minor", instructionCode: "mixed-register", safeToken: "在於" };
  const tokenBy = new Map([["finding-1", "F001"]]);

  it("4. a real patch that removes a finding is locally classified resolved", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [], new Map());
    expect(res.dispositions.get("F001")).toBe("resolved");
    expect(res.locallyResolvedFindingCount).toBe(1);
    expect(res.reasons.length).toBe(0);
  });

  it("5. the model does not need to report a resolved token", () => {
    // Resolution is derived locally; the reviewed map is empty and the finding is gone.
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [], new Map());
    expect(res.reasons.length).toBe(0);
    expect(res.dispositions.get("F001")).toBe("resolved");
  });

  it("7. a no-op patch does not resolve a finding (still present => not resolved)", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [f], new Map([["F001", "natural-already"]]));
    expect(res.dispositions.get("F001")).toBe("reviewed-unchanged");
    expect(res.locallyResolvedFindingCount).toBe(0);
  });

  it("8. a remaining advisory finding with a valid reviewed-unchanged reason passes", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [f], new Map([["F001", "natural-already"]]));
    expect(res.reasons.length).toBe(0);
    expect(res.reviewedUnchangedFindingCount).toBe(1);
  });

  it("9. a remaining advisory finding without reviewed-unchanged accounting is missing-disposition (diagnostic, non-blocking)", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [f], new Map());
    expect(res.reasons.some((r) => r.code === "missing-finding-disposition")).toBe(true);
    expect(res.missingFindingDispositionCount).toBe(1);
  });

  it("9b. missing-disposition is computed as a diagnostic and is never a hard-rule rejection", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [f], new Map());
    expect(res.reasons.every((r) => r.code === "missing-finding-disposition")).toBe(true);
    expect(isHardRuleFinding(f)).toBe(false);
  });

  it("11. a newly introduced avoidable-code-switching finding still rejects through the hard gate", () => {
    const { introduced } = evaluateHardFindingResolution([], [hard("f2", "a", "avoidable-code-switching")]);
    expect(introduced.map((i) => i.ruleId)).toEqual(["avoidable-code-switching"]);
  });

  it("15. a locally resolved finding also listed reviewed unchanged does not reject and counts as stale", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [], new Map([["F001", "natural-already"]]));
    expect(res.reasons.length).toBe(0);
    expect(res.dispositions.get("F001")).toBe("resolved");
    expect(res.locallyResolvedFindingCount).toBe(1);
    expect(res.staleReviewedUnchangedCount).toBe(1);
    expect(res.staleReviewedEntries[0]).toEqual({ findingToken: "F001", sourceUnitId: "section.0.block.1", ruleId: "mixed-register" });
  });

  it("3. stale reviewed-unchanged entries are non-blocking (never reject)", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [], new Map([["F001", "natural-already"]]));
    expect(res.staleReviewedUnchangedCount).toBe(1);
    expect(res.reasons.some((r) => r.code === "reviewed-finding-was-resolved")).toBe(false);
  });

  it("4. a cross-section terminology edit resolves findings assigned to several units", () => {
    // consistent-agency-term findings on three units, all resolved when the only
    // remaining agency term becomes consistent after the edit (all absent post-lint).
    const supplied: StyleFinding[] = ["section.0.block.4", "section.1.block.11", "section.3.block.6"].map((sourceUnitId, i) => ({
      findingId: `finding-${i + 1}`,
      sourceUnitId,
      category: "terminology-inconsistency",
      severity: "minor",
      instructionCode: "consistent-agency-term",
      safeToken: "代理公司/市場推廣公司",
    }));
    const tokenByX = new Map(supplied.map((s, i) => [s.findingId, `F00${i + 1}`]));
    // All three findings are absent from the post-proofread lint.
    const res = resolveMonolingualFindingDispositions(supplied, tokenByX, [], new Map());
    expect(res.locallyResolvedFindingCount).toBe(3);
    expect(res.reasons.length).toBe(0);
  });

  it("5. exact live fixture — 10 consistent-agency-term findings reviewed unchanged but absent after 4 real edits — passes", () => {
    const supplied: StyleFinding[] = Array.from({ length: 10 }, (_, i) => ({
      findingId: `finding-${i + 1}`,
      sourceUnitId: `section.${i}.block.0`,
      category: "terminology-inconsistency",
      severity: "minor",
      instructionCode: "consistent-agency-term",
      safeToken: "代理公司/市場推廣公司",
    }));
    const tokenByX = new Map(supplied.map((s, i) => [s.findingId, `F00${i + 1}`]));
    // The model listed every one reviewed-unchanged, but the four genuine edits made
    // all ten disappear from the final lint → locally resolved, stale metadata, passes.
    const reviewed = new Map(supplied.map((_, i) => [`F00${i + 1}`, "natural-already"]));
    const res = resolveMonolingualFindingDispositions(supplied, tokenByX, [], reviewed);
    expect(res.reasons.length).toBe(0);
    expect(res.locallyResolvedFindingCount).toBe(10);
    expect(res.staleReviewedUnchangedCount).toBe(10);
    expect(res.reviewedUnchangedFindingCount).toBe(0);
  });

  it("6. a finding that remains with a valid reviewed reason is reviewed unchanged", () => {
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [f], new Map([["F001", "context-conflict"]]));
    expect(res.reasons.length).toBe(0);
    expect(res.dispositions.get("F001")).toBe("reviewed-unchanged");
    expect(res.reviewedUnchangedFindingCount).toBe(1);
  });

  it("11. no-op patches still do not resolve findings", () => {
    // No-op = no effective change → the finding remains → needs reviewed accounting.
    const res = resolveMonolingualFindingDispositions([f], tokenBy, [f], new Map());
    expect(res.locallyResolvedFindingCount).toBe(0);
    expect(res.reasons.some((r) => r.code === "missing-finding-disposition")).toBe(true);
  });

  it("12. a reviewed-unchanged token cannot be repeated", () => {
    const { reasons } = validateMonolingualReviewedFindings(buildFindingTokenMap([f]), {
      reviewedUnchangedFindings: [
        { findingToken: "F001", reasonCode: "natural-already" },
        { findingToken: "F001", reasonCode: "source-fidelity" },
      ],
    });
    expect(reasons.some((r) => r.code === "duplicate-reviewed-finding")).toBe(true);
  });

  it("13. an unknown reviewed token rejects", () => {
    const { reasons } = validateMonolingualReviewedFindings(buildFindingTokenMap([f]), {
      reviewedUnchangedFindings: [{ findingToken: "F999", reasonCode: "natural-already" }],
    });
    expect(reasons.some((r) => r.code === "unknown-reviewed-finding-token")).toBe(true);
  });

  it("14. an invalid reason code rejects", () => {
    const { reasons } = validateMonolingualReviewedFindings(buildFindingTokenMap([f]), {
      reviewedUnchangedFindings: [{ findingToken: "F001", reasonCode: "my-arbitrary-reason" }],
    });
    expect(reasons.some((r) => r.code === "invalid-reviewed-unchanged-reason")).toBe(true);
  });

  it("13b. a valid reviewed-unchanged finding passes the shape validator", () => {
    const { reasons, reasonByToken } = validateMonolingualReviewedFindings(buildFindingTokenMap([f]), {
      reviewedUnchangedFindings: [{ findingToken: "F001", reasonCode: "natural-already" }],
    });
    expect(reasons.length).toBe(0);
    expect(reasonByToken.get("F001")).toBe("natural-already");
  });

  it("17. all-advisory reviewed-unchanged findings may pass without blocking", () => {
    const { remaining, introduced } = evaluateHardFindingResolution([], [advisory("f1")]);
    expect(remaining.length).toBe(0);
    expect(introduced.length).toBe(0);
  });

  it("18. remaining advisory findings still do not block saving", () => {
    const before: ActionableHardFinding[] = [];
    const after = lintMonolingualDocument([{ sourceUnitId: "a", text: "關鍵在於揀啲同觀眾有真實連結嘅創作者。" }]);
    const { remaining, introduced } = evaluateHardFindingResolution(before, after);
    expect(remaining.length).toBe(0);
    expect(introduced.length).toBe(0);
  });

  it("19. remaining hard findings still reject through the existing quality gate", () => {
    const { remaining } = evaluateHardFindingResolution([actionable("a", "mainland-register")], [hard("f2", "a", "mainland-register")]);
    expect(remaining.map((r) => r.ruleId)).toEqual(["mainland-register"]);
  });

  it("20. no minimum number of edits is required", () => {
    const { remaining } = evaluateHardFindingResolution([], [advisory("f1")]);
    expect(remaining.length).toBe(0);
  });

  it("1/2. the live monolingual schema contains no resolvedFindingTokens or legacy reviewedUnchangedFindingTokens", () => {
    const system = buildShadowMonolingualSystemPrompt();
    const findings = buildMonolingualFindingsPrompt([f], buildFindingTokenMap([f]));
    expect(system).not.toContain("resolvedFindingTokens");
    expect(system).not.toContain("reviewedUnchangedFindingTokens");
    expect(findings).not.toContain("resolvedFindingTokens");
    expect(findings).not.toContain("reviewedUnchangedFindingTokens");
  });

  it("3. the live schema includes units and structured reviewedUnchangedFindings", () => {
    const system = buildShadowMonolingualSystemPrompt();
    expect(system).toContain('"units"');
    expect(system).toContain("reviewedUnchangedFindings");
    expect(system).toContain("reasonCode");
  });

  it("21. the monolingual prompt no longer includes 'fast proofread'", () => {
    expect(buildShadowMonolingualSystemPrompt()).not.toContain("fast proofread");
  });

  it("22. the monolingual prompt explicitly forbids unchanged units in the patch array", () => {
    const system = buildShadowMonolingualSystemPrompt();
    expect(system).toContain("Unchanged units must not appear in units");
    expect(system).toContain("Never return a unit in `units` unless its reader-facing content has actually changed");
  });
});

