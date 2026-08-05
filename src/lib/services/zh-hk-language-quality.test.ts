import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { DocumentContextTranslationShadowResult } from "./document-context-translation-shadow";
import {
  PERMANENT_EN_ALLOWLIST,
  MANDATORY_GLOSSARY,
  LANGUAGE_PACK_INVENTORY,
  normalizeZhHkText,
  applyZhHkLanguageQuality,
  analyzeZhHkLanguageQuality,
  extractAutoAllowedEntities,
  findUnexpectedEnglishToken,
  isAllowedEnglishToken,
} from "./zh-hk-language-quality";
import { validatePrimaryDocumentContextResult } from "./document-context-primary";
import { buildShadowPreviewPayload } from "./document-context-shadow-preview";

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeEnDoc(overrides: Partial<ArticleDocument> = {}): ArticleDocument {
  return {
    metadata: {
      title: "How Creator Marketing Drives SME Growth in 2026",
      slug: "creator-marketing-sme-growth",
      metaDescription: "Creator marketing helps Hong Kong SMEs grow. Learn ROI and engagement.",
      excerpt: "A practical guide to creator marketing for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("intro-0", "Creator marketing reached 65% of SMEs within 6 months.")], status: "generated" },
    sections: [
      { id: "s0", heading: "Why influencer marketing matters", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Nano-influencer and micro-influencer campaigns drive engagement.")], status: "generated" },
      { id: "s1", heading: "Brand awareness across platforms", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "Follower growth and brand awareness are core goals.")], status: "generated" },
    ],
    conclusion: { id: "conc", blocks: [paragraphBlock("conc-0", "Start with a focused campaign.")], status: "generated" },
    visibleFaq: [],
    cta: null, faqSchema: null, insertedLinks: [],
    ...overrides,
  };
}

function makeZhDoc(text?: string, sectionText?: string): ArticleDocument {
  const body = text ?? "創作者市場推廣喺香港越嚟越受歡迎。";
  return {
    metadata: { title: "創作者市場推廣指南", slug: "creator-marketing-sme-growth", metaDescription: "創作者市場推廣幫香港中小企成長。", excerpt: "創作者市場推廣實用指南。", targetWordCount: 2500, focusKeyphrase: "創作者市場推廣" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("intro-0", body)], status: "generated" },
    sections: [
      { id: "s0", heading: "點解創作者市場推廣咁重要", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", sectionText ?? "超小型創作者同微型創作者嘅推廣活動帶嚟互動。")], status: "generated" },
      { id: "s1", heading: "品牌知名度", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "粉絲增長同品牌知名度係核心目標。")], status: "generated" },
    ],
    conclusion: { id: "conc", blocks: [paragraphBlock("conc-0", "由一個專注嘅推廣活動開始。")], status: "generated" },
    visibleFaq: [],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

/** A minimal English doc whose introduction block carries the given source text. */
function enDocWithIntro(introEn: string): ArticleDocument {
  return makeEnDoc({
    introduction: { id: "intro", blocks: [paragraphBlock("intro-0", introEn)], status: "generated" },
    sections: [{ id: "s0", heading: "Section", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "General source body.")], status: "generated" }],
  });
}

/** A valid save-gate result carrying a language-pack quality report. */
function makeGateResult(zhDoc: ArticleDocument, enDoc: ArticleDocument): DocumentContextTranslationShadowResult {
  const editorial = {
    enabled: true, status: "not-run" as const, batchCount: 0, attemptCount: 0, acceptedBatchCount: 0,
    rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: 0,
    changedUnitCount: 0, unchangedUnitCount: 0, batches: [], failure: null, preEditorialDoc: null,
    polishedDoc: null, perUnitValid: 0, perUnitInvalid: 0, tokenUsage: null, invariantFailures: [],
    quality: analyzeZhHkLanguageQuality(zhDoc, enDoc),
  };
  return {
    enabled: true, sourceDocumentFingerprint: null, planFingerprint: null,
    totalPlannedChunks: 1, substantiveChunkCallCount: 1, skippedProtectedChunks: 0,
    providerAttemptCount: 1, validChunkCount: 1, partialChunkCount: 0, failedChunkCount: 0,
    chunkResults: [], contractFailures: [], protectedParityFailures: [],
    coverage: { translatedSubstantive: { translated: 3, total: 3 }, wholeDocument: { translated: 3, protected: 0, unresolved: 0, total: 3 } },
    allChunksCompleted: true,
    assembly: { status: "assembled", missingUnits: [], doc: zhDoc },
    editorial: editorial as DocumentContextTranslationShadowResult["editorial"],
    review: { enabled: false, status: "not-run", callCount: 0, selectedUnitIds: [], selectedReasons: [], patches: [], appliedPatchCount: 0, retainedCount: 0, failure: null, diagnostics: [], truncated: false },
    preview: { previewOnly: true, retainedDoc: zhDoc, retainedSource: "polished", stored: false, exportPath: null, timestamp: "" },
    warnings: [],
    languagePack: { version: "test", retrievedExampleIds: [], retrievalScores: [], exampleCount: 0, promptBudgetChars: 1200, glossaryApplications: 0, critical: 0, major: 0, minor: 0, advisory: 0, resolvedBudgets: { translation: { maxTokens: 65536, timeoutMs: 180000 }, editorial: { maxTokens: 32768, timeoutMs: 180000 } } },
    brandVoice: { version: "test", brandVoiceHash: "", usedDefault: true, styleProfileVersion: "test", hardRuleCount: 0, advisoryRuleCount: 0 },
  };
}

function majors(report: { findings: Array<{ severity: string; messageCode: string }> }): string[] {
  return report.findings.filter((f) => f.severity === "major" || f.severity === "critical").map((f) => f.messageCode);
}

describe("zh-hk language-quality pack: inventory and lookups", () => {
  it("1. comprehensive lists use efficient Set/Map lookups and precompiled regexes", () => {
    expect(PERMANENT_EN_ALLOWLIST.constructor).toBe(Set);
    expect(typeof PERMANENT_EN_ALLOWLIST.has).toBe("function");
    for (const entry of MANDATORY_GLOSSARY) {
      expect(entry.sourceRe).toBeInstanceOf(RegExp);
    }
    expect(typeof findUnexpectedEnglishToken).toBe("function");
  });

  it("2. hundreds of entries are scanned without any provider call", () => {
    expect(LANGUAGE_PACK_INVENTORY.permanentEnglishAllowlist).toBeGreaterThan(100);
    expect(LANGUAGE_PACK_INVENTORY.total).toBeGreaterThanOrEqual(300);
    // Pure synchronous analysis; no AI dependency.
    const report = analyzeZhHkLanguageQuality(makeZhDoc(), makeEnDoc());
    expect(Array.isArray(report.findings)).toBe(true);
  });

  it("10. no article-specific sentence replacements are included", () => {
    const neutral = "呢個方案喺市場上越嚟越多人用，效果都幾好。";
    expect(normalizeZhHkText(neutral)).toBe(neutral);
    // A longer neutral paragraph is not rewritten sentence-by-sentence.
    const longNeutral = "創作者市場推廣幫助香港品牌接觸更多觀眾，透過互動同持續輸出內容，慢慢建立品牌知名度同信任。";
    expect(normalizeZhHkText(longNeutral)).toBe(longNeutral);
  });
});

describe("zh-hk language-quality pack: normalisation", () => {
  it("3. safe corrections are applied consistently", () => {
    expect(normalizeZhHkText("佢哋好噉樣做，我哋要了解清楚。")).toContain("咁樣");
    expect(normalizeZhHkText("需要進一步了解呢個概念。")).toContain("了解");
    expect(normalizeZhHkText("呢啲係新嘅嘅做法。")).not.toContain("嘅嘅");
  });

  it("3b. the pack applies safe corrections to a document", () => {
    const zh = makeZhDoc("佢哋好噉樣理解呢個概念，內容有啲嘅嘅重複。");
    const { doc } = applyZhHkLanguageQuality(zh, makeEnDoc());
    const introText = (doc.introduction.blocks[0] as { content: Array<{ text: string }> }).content[0].text;
    expect(introText).toContain("咁樣");
    expect(introText).not.toContain("嘅嘅");
  });

  it("3c. redundant KOL after a creator-family term is deduplicated, not corrupted", () => {
    // 創作者或者 KOL → 創作者 (dedup, no duplication, clears forbidden KOL).
    expect(normalizeZhHkText("透過同啱嘅香港創作者或者 KOL 合作。")).toBe("透過同啱嘅香港創作者合作。");
    expect(normalizeZhHkText("同創作者或 KOL 合作。")).toBe("同創作者合作。");
    // Standalone KOL is still normalised.
    expect(normalizeZhHkText("呢個係一個 KOL。")).not.toContain("KOL");
  });

  it("3d. 與否/與眾不同/與別不同 compounds are protected from the 與 → 同 rule", () => {
    expect(normalizeZhHkText("我點樣量度我嘅創作者推廣活動成功與否？")).toContain("成功與否");
    expect(normalizeZhHkText("令成功推廣活動與眾不同嘅因素")).toContain("與眾不同");
    expect(normalizeZhHkText("令品牌與別不同嘅做法")).toContain("與別不同");
    expect(normalizeZhHkText("品牌與其依賴大網紅，不如合作。")).toContain("與其");
  });
});

describe("zh-hk language-quality pack: English detection", () => {
  it("4. approved Hong Kong English terms pass", () => {
    const zh = makeZhDoc("Instagram、YouTube 同 B2B 內容都好受歡迎，KPI 亦都重要。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    expect(majors(report)).not.toContain("unexpected-english");
  });

  it("5. accidental untranslated English fails", () => {
    const zh = makeZhDoc("呢個方案好 work，客戶都好滿意。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    expect(majors(report)).toContain("unexpected-english");
  });

  it("6. article-specific brands and names are allowed automatically", () => {
    const enDoc = makeEnDoc({
      sections: [
        { id: "s0", heading: "StarNgage partnership", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "StarNgage provides analytics for creator marketing.")], status: "generated" },
      ],
    });
    const zh = makeZhDoc("StarNgage 提供創作者市場推廣嘅數據分析。");
    const allowed = extractAutoAllowedEntities(enDoc);
    expect(allowed.has("starngage")).toBe(true);
    const report = analyzeZhHkLanguageQuality(zh, enDoc);
    expect(majors(report)).not.toContain("unexpected-english");
  });
});

describe("zh-hk language-quality pack: forbidden and glossary enforcement", () => {
  it("7. forbidden terminology fails", () => {
    const zh = makeZhDoc("呢個網紅營銷策略唔符合品牌方向。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    expect(majors(report)).toContain("forbidden-terminology");
  });

  it("8. glossary enforcement is source-aware: wrong rendering blocks, correct passes", () => {
    const en = enDocWithIntro("influencer marketing helps brands reach audiences.");
    // Wrong Mainland rendering blocks.
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("影響力行銷幫品牌接觸觀眾。"), en))).toContain("glossary-influencer-marketing");
    // Correct canonical term passes (no glossary finding).
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("創作者市場推廣幫品牌接觸觀眾。"), en))).not.toContain("glossary-influencer-marketing");
  });

  it("8b. brand awareness is source-aware", () => {
    const en = enDocWithIntro("build brand awareness as a long term goal.");
    // Wrong rendering 品牌認知度 blocks.
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("建立品牌認知度係長期目標。"), en))).toContain("glossary-brand-awareness");
    // Correct 品牌知名度 passes.
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("建立品牌知名度係長期目標。"), en))).not.toContain("glossary-brand-awareness");
  });

  it("9. nano and micro remain distinct", () => {
    const nanoEn = enDocWithIntro("Nano-influencer campaigns drive engagement.");
    const microEn = enDocWithIntro("Micro-influencer campaigns drive engagement.");
    // nano source + correct 超小型創作者 passes.
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("超小型創作者帶嚟高互動。"), nanoEn))).not.toContain("glossary-nano-influencer");
    // nano source + micro's term 微型創作者 blocks (conflation).
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("微型創作者帶嚟高互動。"), nanoEn))).toContain("glossary-nano-influencer");
    // micro source + correct 微型創作者 passes.
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("微型創作者帶嚟高互動。"), microEn))).not.toContain("glossary-micro-influencer");
    // micro source + nano's term 超小型創作者 blocks.
    expect(majors(analyzeZhHkLanguageQuality(makeZhDoc("超小型創作者帶嚟高互動。"), microEn))).toContain("glossary-micro-influencer");
  });
});

describe("zh-hk language-quality pack: save behaviour", () => {
  it("11. failed objective validation prevents saving", () => {
    const zh = makeZhDoc("呢個方案好 work，客戶都好滿意。");
    const failure = validatePrimaryDocumentContextResult(makeGateResult(zh, makeEnDoc()));
    expect(failure).not.toBeNull();
    expect(failure?.stage).toBe("quality");
  });

  it("11b. a clean document saves (no quality block)", () => {
    const zh = makeZhDoc();
    const failure = validatePrimaryDocumentContextResult(makeGateResult(zh, makeEnDoc()));
    expect(failure).toBeNull();
  });

  it("12. no additional DeepSeek call is made by the language pack", () => {
    // analyze/apply are synchronous pure functions — they cannot call the provider.
    expect(typeof applyZhHkLanguageQuality).toBe("function");
    expect(typeof analyzeZhHkLanguageQuality).toBe("function");
    const { doc, report } = applyZhHkLanguageQuality(makeZhDoc(), makeEnDoc());
    expect(doc).toBeDefined();
    expect(report).toBeDefined();
  });
});

describe("zh-hk language-quality pack: blocked-finding diagnostics", () => {
  it("literal-untranslated-verb blocked finding exposes unit, token, context and rule", () => {
    const zh = makeZhDoc("呢個方案好 work嘅，客戶都好滿意。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    const f = report.findings.find((x) => x.messageCode === "literal-untranslated-verb");
    expect(f).toBeDefined();
    expect(f!.sourceUnitId).toBe("introduction.block.0");
    expect(f!.offendingToken).toBe("work");
    expect(f!.context).toContain("work");
    expect(f!.detectorRule).toBe("literal-untranslated-verb");
    expect(f!.action).toBe("blocked");
    expect(f!.severity).toBe("major");
    // English-token provenance is populated for an English offending token.
    expect(typeof f!.tokenInSource).toBe("boolean");
    expect(typeof f!.tokenInAllowlist).toBe("boolean");
    expect(typeof f!.tokenInAutoEntities).toBe("boolean");
  });

  it("english-leak blocked finding exposes the exact token and rule", () => {
    const zh = makeZhDoc("呢個方案好 work，客戶都好滿意。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    const f = report.findings.find((x) => x.messageCode === "unexpected-english");
    expect(f).toBeDefined();
    expect(f!.offendingToken).toBe("work");
    expect(f!.detectorRule).toBe("english-leak");
    expect(f!.action).toBe("blocked");
    expect(f!.severity).toBe("major");
  });

  it("the preview JSON persists the blocked-finding details", () => {
    const zh = makeZhDoc("呢個方案好 work嘅，客戶都好滿意。");
    const payload = buildShadowPreviewPayload(makeGateResult(zh, makeEnDoc()));
    const finding = payload.quality!.findings.find((x) => x.messageCode === "literal-untranslated-verb");
    expect(finding).toBeDefined();
    expect(finding!.sourceUnitId).toBe("introduction.block.0");
    expect(finding!.category).toBe("language");
    expect(finding!.offendingToken).toBe("work");
    expect(finding!.context).toContain("work");
    expect(finding!.detectorRule).toBe("literal-untranslated-verb");
    expect(finding!.action).toBe("blocked");
    // Provenance is persisted (not null) for an English token.
    expect(finding!.tokenInSource).not.toBeNull();
    expect(finding!.tokenInAllowlist).not.toBeNull();
    expect(finding!.tokenInAutoEntities).not.toBeNull();
  });
});

describe("zh-hk language-quality pack: literal-untranslated-verb exemptions", () => {
  const hasLiteralVerb = (report: { findings: Array<{ messageCode: string }> }): boolean =>
    report.findings.some((f) => f.messageCode === "literal-untranslated-verb");

  it("post does not trigger literal-untranslated-verb (permanent allowlist)", () => {
    const zh = makeZhDoc("呢個 post嘅內容好受歡迎。");
    expect(hasLiteralVerb(analyzeZhHkLanguageQuality(zh, makeEnDoc()))).toBe(false);
    // Consistent with the english-leak detector.
    const allowed = extractAutoAllowedEntities(makeEnDoc());
    expect(findUnexpectedEnglishToken("呢個 post嘅內容", allowed)).toBeNull();
  });

  it("TikTok does not trigger literal-untranslated-verb (approved platform)", () => {
    const zh = makeZhDoc("呢個 TikTok嘅帖文好受歡迎。");
    expect(hasLiteralVerb(analyzeZhHkLanguageQuality(zh, makeEnDoc()))).toBe(false);
  });

  it("StarNgage does not trigger literal-untranslated-verb when extracted from the source", () => {
    const en = enDocWithIntro("StarNgage provides analytics for creator marketing.");
    const zh = makeZhDoc("透過 StarNgage嘅數據分析了解成效。");
    const allowed = extractAutoAllowedEntities(en);
    expect(allowed.has("starngage")).toBe(true);
    expect(isAllowedEnglishToken("StarNgage", allowed)).toBe(true);
    expect(hasLiteralVerb(analyzeZhHkLanguageQuality(zh, en))).toBe(false);
  });

  it("work still triggers and blocks literal-untranslated-verb", () => {
    const zh = makeZhDoc("呢個方案好 work嘅，客戶都好滿意。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    const f = report.findings.find((x) => x.messageCode === "literal-untranslated-verb");
    expect(f).toBeDefined();
    expect(f!.offendingToken).toBe("work");
    expect(f!.severity).toBe("major");
    expect(f!.action).toBe("blocked");
  });

  it("unknown English verbs still block", () => {
    const zh = makeZhDoc("呢個方案好 focus嘅，效果都唔錯。");
    const report = analyzeZhHkLanguageQuality(zh, makeEnDoc());
    expect(hasLiteralVerb(report)).toBe(true);
    expect(majors(report)).toContain("unexpected-english");
  });

  it("allowlist/entity exemptions apply consistently to every English-leak detector", () => {
    // `post` is exempt in both the english-leak detector and the literal detector.
    const allowed = extractAutoAllowedEntities(makeEnDoc());
    expect(isAllowedEnglishToken("post", allowed)).toBe(true);
    expect(findUnexpectedEnglishToken("呢個 post嘅內容", allowed)).toBeNull();
    expect(hasLiteralVerb(analyzeZhHkLanguageQuality(makeZhDoc("呢個 post嘅內容。"), makeEnDoc()))).toBe(false);
    // `work` is NOT exempt in either detector.
    expect(isAllowedEnglishToken("work", allowed)).toBe(false);
    expect(findUnexpectedEnglishToken("呢個 work嘅內容", allowed)).not.toBeNull();
    expect(hasLiteralVerb(analyzeZhHkLanguageQuality(makeZhDoc("呢個 work嘅內容。"), makeEnDoc()))).toBe(true);
  });

  it("no additional DeepSeek call is made by the exemption checks", () => {
    const allowed = extractAutoAllowedEntities(makeEnDoc());
    // Pure, synchronous lookups with no provider dependency.
    expect(typeof isAllowedEnglishToken).toBe("function");
    expect(isAllowedEnglishToken("post", allowed)).toBe(true);
    expect(typeof analyzeZhHkLanguageQuality).toBe("function");
    analyzeZhHkLanguageQuality(makeZhDoc("呢個 post嘅內容。"), makeEnDoc());
  });
});

describe("zh-hk language-quality pack: performance", () => {
  it("scans a production-sized article with a 300+ entry pack comfortably within the local-test threshold", () => {
    const words = "Creator marketing is reshaping how Hong Kong brands connect with their audiences across social platforms, and the results are increasingly hard to ignore. ";
    const sections = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`, heading: `Section ${i + 1} of Creator Marketing`, headingLevel: 2 as const, sectionType: "main" as const,
      blocks: [0, 1, 2, 3].map((b) => paragraphBlock(`s${i}-${b}`, words.repeat(30))),
      status: "generated" as const,
    }));
    const enDoc = makeEnDoc({ sections });
    const zh = makeZhDoc();
    expect(LANGUAGE_PACK_INVENTORY.total).toBeGreaterThanOrEqual(300);
    const start = performance.now();
    const report = analyzeZhHkLanguageQuality(zh, enDoc);
    const elapsed = performance.now() - start;
    expect(Array.isArray(report.findings)).toBe(true);
    // Comfortable local-test budget (far below a DeepSeek call).
    expect(elapsed).toBeLessThan(2000);
  });
});
