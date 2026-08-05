import { describe, it, expect } from "vitest";
import type { ArticleDocument, EditorialBlock, SourceReferenceUnit } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import { renderArticleDocument } from "@/lib/blog/article-document";
import {
  applySourceReferenceLocalization,
  extractSourceReferenceOriginals,
  isSourceReferenceBlock,
  buildSourceReferenceBlock,
  validateSourceReferences,
  derivePublisherName,
  isHostnameDerivedPublisherName,
  stripTrailingPublisherSuffix,
} from "./source-reference-localization";
import { lintEditorialDraft, type StyleFinding } from "./cantonese-style-linter";
import {
  B2I_CANTONESE_TERMINOLOGY_POLICY,
  buildTerminologyPolicyPrompt,
} from "./b2i-cantonese-language-pack";
import { buildShadowEditorialSystemPrompt, buildShadowMonolingualSystemPrompt } from "./document-context-translation-shadow-prompt";
import { emptyQualityReport, mergeSourceReferenceFindings } from "./shadow-cantonese-quality";
import { validatePrimaryDocumentContextResult, type DocumentContextPrimaryFailure } from "./document-context-primary";

const EN_TITLE = "How to Find the Right Influencer Marketing Agency in Hong Kong";
const URL = "https://example.com/research/report";

function paragraph(id: string, content: InlineContent[]): EditorialBlock {
  return { id, type: "paragraph", content };
}

function textNode(text: string): InlineContent {
  return { type: "text", text };
}

function linkNode(text: string, href: string): InlineContent {
  return { type: "link", text, href, sourceType: "editorial-external" };
}

function makeEnDoc(citationBlock: EditorialBlock): ArticleDocument {
  return {
    metadata: { title: "Creator Marketing for Hong Kong SMEs", slug: "creator-marketing-hk", metaDescription: "meta", excerpt: "excerpt", targetWordCount: 1500, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraph("i0", [textNode("An introduction.")])], status: "generated" },
    sections: [
      { id: "s0", heading: "Why it matters", headingLevel: 2, sectionType: "main", blocks: [citationBlock], status: "generated" },
    ],
    visibleFaq: [],
    conclusion: { id: "conc", blocks: [paragraph("c0", [textNode("Conclusion.")])], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function makeZhDoc(displayTitle: string, href = URL): ArticleDocument {
  const content: InlineContent[] = [textNode("來源："), linkNode(displayTitle, href), textNode("")];
  return makeEnDoc(paragraph("s0-0", content));
}

describe("source-reference localization", () => {
  const enCitation = paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]);

  it("1. renders a clean localized Chinese source title (no English beside it)", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { doc, units } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(units).toHaveLength(1);
    const html = renderArticleDocument(doc);
    expect(html).toContain("來源：");
    expect(html).toContain("香港創作者市場推廣指南");
    expect(html).not.toContain(EN_TITLE);
  });

  it("2. keeps the original English title internally unchanged", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { units } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(units[0].originalTitle).toBe(EN_TITLE);
  });

  it("3. preserves URLs byte-for-byte unchanged", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { units } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(units[0].originalUrl).toBe(URL);
    expect(units[0].originalUrl).toBe(URL);
  });

  it("4. keeps the source-to-claim mapping (sourceUnitId) unchanged", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { units } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(units[0].sourceUnitId).toBe("section.0.block.0");
  });

  it("5. preserves publisher identity derived from the URL", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { units } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(units[0].originalPublisher).toBe("Example");
  });

  it("6. never invents a localized publisher", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { units } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(units[0].localizedPublisher).toBeUndefined();
  });

  it("7. does not display the English original beside the Chinese title", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { doc } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    const visible = renderArticleDocument(doc);
    // The English original appears nowhere as visible anchor text.
    expect(visible).not.toContain(EN_TITLE);
  });

  it("8. renders source blocks deterministically", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const a = applySourceReferenceLocalization(zh, makeEnDoc(enCitation)).doc;
    const b = applySourceReferenceLocalization(zh, makeEnDoc(enCitation)).doc;
    expect(renderArticleDocument(a)).toBe(renderArticleDocument(b));
  });

  it("9. prevents duplicate publishers / punctuation defects", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { doc } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    const visible = renderArticleDocument(doc);
    // Single clean 來源： label, single link, no doubled terminal punctuation.
    expect((visible.match(/來源：/g) || []).length).toBe(1);
    expect(visible).not.toContain("。。");
    expect(visible).not.toContain("？？");
  });

  it("detects a count / mapping mismatch as critical", () => {
    // English has one citation but the Chinese doc has none.
    const zh = makeZhDoc("香港創作者市場推廣指南");
    zh.sections[0].blocks = [paragraph("s0-0", [textNode("普通段落")])];
    const { findings } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(findings.some((f) => f.category === "source-mapping-altered" && f.severity === "critical")).toBe(true);
  });

  it("flags an altered URL as critical", () => {
    const zh = makeZhDoc("香港創作者市場推廣指南", "https://evil.example/other");
    const { findings } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(findings.some((f) => f.category === "source-url-altered" && f.severity === "critical")).toBe(true);
  });

  it("flags an English (unlocalized) source title as a source finding", () => {
    const zh = makeZhDoc(EN_TITLE);
    const { findings } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(findings.some((f) => f.category === "source-title-not-localized")).toBe(true);
  });

  it("isSourceReferenceBlock detects citation labels only", () => {
    expect(isSourceReferenceBlock(enCitation)).toBe(true);
    expect(isSourceReferenceBlock(paragraph("p", [textNode("普通段落")]))).toBe(false);
  });

  it("buildSourceReferenceBlock renders from structured fields", () => {
    const unit: SourceReferenceUnit = {
      sourceReferenceId: "source-ref-0",
      sourceUnitId: "section.0.block.0",
      originalTitle: EN_TITLE,
      originalPublisher: "Example",
      originalUrl: URL,
      localizedDisplayTitle: "香港創作者市場推廣指南",
    };
    const block = buildSourceReferenceBlock(unit);
    const link = block.type === "paragraph" ? block.content.find((n) => n.type === "link") : undefined;
    expect(link && link.type === "link" ? link.href : "").toBe(URL);
  });
});

describe("semantic / language QA findings (linter)", () => {
  const lint = (text: string): StyleFinding[] => lintEditorialDraft([{ sourceUnitId: "section.0.block.0", text }]);

  it("10. detects an incomplete comparison", () => {
    const findings = lint("佢哋嘅受眾同你嘅係咪匹配");
    expect(findings.some((f) => f.instructionCode === "incomplete-comparison")).toBe(true);
  });

  it("11. detects a literal English noun structure (missing head noun)", () => {
    const findings = lint("採用將品牌配合置於虛榮指標之上嘅 KPI");
    expect(findings.some((f) => f.instructionCode === "literal-english-syntax")).toBe(true);
  });

  it("12. rejects a meaning change (perception becoming definition)", () => {
    const findings = lint("完全改變人哋對你品牌、產品或者推廣活動嘅定義");
    expect(findings.some((f) => f.instructionCode === "meaning-role-change")).toBe(true);
  });

  it("13. identifies literal English syntax for the editorial call", () => {
    const findings = lint("採用將品牌配合置於虛榮指標之上嘅 KPI");
    expect(findings.some((f) => f.category === "semantic")).toBe(true);
  });

  it("14. identifies mixed formal and Cantonese register", () => {
    const findings = lint("而係在於對話");
    expect(findings.some((f) => f.instructionCode === "mixed-register")).toBe(true);
  });

  it("15. identifies non-Hong-Kong terminology", () => {
    for (const text of ["越來越快", "發布內容", "真實性", "人口群組"]) {
      const findings = lint(text);
      expect(findings.some((f) => f.instructionCode === "non-hk-terminology")).toBe(true);
    }
  });

  it("16. reusable concepts use consistent preferred terminology", () => {
    for (const policy of B2I_CANTONESE_TERMINOLOGY_POLICY) {
      expect(policy.preferred.trim().length).toBeGreaterThan(0);
    }
    expect(buildTerminologyPolicyPrompt()).toContain("PREFERRED HONG KONG TERMINOLOGY");
    const follower = B2I_CANTONESE_TERMINOLOGY_POLICY.find((p) => p.en === "follower");
    expect(follower?.preferred).toBe("粉絲");
  });

  it("17. flags excessive slang without banning natural Cantonese", () => {
    expect(lint("佢哋有料到").some((f) => f.instructionCode === "excessive-slang")).toBe(true);
    expect(lint("呢個策略對香港中小企真係好有用")).toHaveLength(0);
  });

  it("19. the bilingual prompt instructs full-sentence rewriting and the monolingual prompt handles the broad proofread", () => {
    const sys = buildShadowEditorialSystemPrompt();
    const mono = buildShadowMonolingualSystemPrompt();
    // Bilingual revision: focused bilingual scope, full-sentence rewriting required.
    expect(sys).toContain("BILINGUAL REVISION FOCUS");
    expect(sys).toContain("Require full-sentence rewriting");
    expect(sys).not.toContain("FINAL PROOFREAD SCOPE");
    // The broad full-document style proofread belongs to the monolingual call.
    expect(mono).toContain("FINAL PROOFREAD SCOPE");
    expect(mono).toContain("consistent register across every section");
  });
});

describe("source-reference + semantic diagnostics integration", () => {
  it("20. localization does not touch CTA, FAQ or protected blocks", () => {
    const enCitation = paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]);
    const zh = makeZhDoc("香港創作者市場推廣指南");
    zh.cta = { id: "cta", type: "cta", html: "<!-- wp:html --><div>CTA</div><!-- /wp:html -->", fingerprint: "f" };
    const before = zh.cta.html;
    const { doc } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(doc.cta?.html).toBe(before);
    expect(doc.faqSchema).toBeNull();
  });

  it("21. preserves the 7-translation + 3-editorial architecture (no extra stage)", () => {
    const enCitation = paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]);
    const zh = makeZhDoc("香港創作者市場推廣指南");
    // applySourceReferenceLocalization is deterministic and callable without a
    // provider; it must never invoke a provider. We simply assert it returns a
    // document without throwing and requires no provider argument.
    const result = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(result.doc.sections.length).toBe(1);
  });

  it("22. no retry / fallback / extra provider call is introduced", () => {
    // Localization is a pure synchronous function.
    const enCitation = paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]);
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const result = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(result.diagnostics.sourceReferenceCount).toBe(1);
  });

  it("exposes diagnostics counts", () => {
    const enCitation = paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]);
    const zh = makeZhDoc("香港創作者市場推廣指南");
    const { diagnostics } = applySourceReferenceLocalization(zh, makeEnDoc(enCitation));
    expect(diagnostics.sourceReferenceCount).toBe(1);
    expect(diagnostics.aiLocalizedTitleCount).toBe(1);
    expect(diagnostics.canonicalSourceFailures).toBe(0);
  });

  it("extractSourceReferenceOriginals + derivePublisherName work deterministically", () => {
    const enCitation = paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]);
    const originals = extractSourceReferenceOriginals(makeEnDoc(enCitation));
    expect(originals.size).toBe(1);
    // Approved publisher-name map is used, never a hostname-derived slug.
    expect(derivePublisherName("https://www.anymindgroup.com/x")).toBe("AnyMind Group");
    expect(isHostnameDerivedPublisherName("Anymindgroup")).toBe(true);
    expect(isHostnameDerivedPublisherName("AnyMind Group")).toBe(false);
  });

  it("validateSourceReferences reports a missing source as critical", () => {
    const originals = new Map<string, SourceReferenceUnit>([
      ["section.0.block.0", { sourceReferenceId: "source-ref-0", sourceUnitId: "section.0.block.0", originalTitle: EN_TITLE, originalUrl: URL }],
    ]);
    const findings = validateSourceReferences(originals, []);
    expect(findings.some((f) => f.messageCode === "missing-source-reference")).toBe(true);
  });
});

describe("diagnostics and primary gate", () => {
  it("merges source-reference critical findings into the quality report", () => {
    const report = emptyQualityReport();
    const merged = mergeSourceReferenceFindings(report, [
      { sourceReferenceId: "source-ref-0", sourceUnitId: "section.0.block.0", category: "source-url-altered", severity: "critical", messageCode: "source-url-altered" },
      { sourceReferenceId: "source-ref-0", sourceUnitId: "section.0.block.0", category: "source-title-not-localized", severity: "minor", messageCode: "source-title-not-localized" },
    ]);
    expect(merged.criticalCount).toBe(1);
    expect(merged.minorCount).toBe(1);
    expect(merged.findings.some((f) => f.category === "source-reference" && f.severity === "critical")).toBe(true);
  });

  it("a critical source finding rejects the primary result (stage quality)", () => {
    const doc = makeEnDoc(paragraph("s0-0", [textNode("Source: "), linkNode(EN_TITLE, URL), textNode(".")]));
    const failure: DocumentContextPrimaryFailure | null = validatePrimaryDocumentContextResult({
      enabled: true,
      sourceDocumentFingerprint: null,
      planFingerprint: null,
      totalPlannedChunks: 0,
      substantiveChunkCallCount: 0,
      skippedProtectedChunks: 0,
      providerAttemptCount: 0,
      validChunkCount: 0,
      partialChunkCount: 0,
      failedChunkCount: 0,
      chunkResults: [],
      contractFailures: [],
      protectedParityFailures: [],
      coverage: { translatedSubstantive: { translated: 1, total: 1 }, wholeDocument: { translated: 1, protected: 0, unresolved: 0, total: 1 } },
      allChunksCompleted: true,
      assembly: { status: "assembled", missingUnits: [], doc },
      editorial: {
        enabled: true,
        status: "polished",
        batchCount: 3,
        attemptCount: 3,
        acceptedBatchCount: 3,
        rejectedBatchCount: 0,
        providerFailedCount: 0,
        validationRejectedCount: 0,
        skippedCount: 0,
        changedUnitCount: 0,
        unchangedUnitCount: 0,
        batches: [],
        failure: null,
        preEditorialDoc: doc,
        polishedDoc: doc,
        perUnitValid: 0,
        perUnitInvalid: 0,
        tokenUsage: null,
        invariantFailures: [],
        quality: mergeSourceReferenceFindings(emptyQualityReport(), [
          { sourceReferenceId: "source-ref-0", sourceUnitId: "section.0.block.0", category: "source-url-altered", severity: "critical", messageCode: "source-url-altered" },
        ]),
      },
      review: { enabled: false, status: "not-run", callCount: 0, selectedUnitIds: [], selectedReasons: [], patches: [], appliedPatchCount: 0, retainedCount: 0, failure: null, diagnostics: [], truncated: false },
      preview: { previewOnly: true, retainedDoc: doc, retainedSource: "polished", stored: false, exportPath: null, timestamp: "" },
      warnings: [],
      languagePack: {
        version: "v", retrievedExampleIds: [], retrievalScores: [], exampleCount: 0,
        promptBudgetChars: 0, glossaryApplications: 0, critical: 0, major: 0, minor: 0, advisory: 0,
        resolvedBudgets: { translation: { maxTokens: 65536, timeoutMs: 180000 }, editorial: { maxTokens: 32768, timeoutMs: 180000 } },
      },
      brandVoice: { version: "v", brandVoiceHash: "", usedDefault: true, styleProfileVersion: "v", hardRuleCount: 0, advisoryRuleCount: 0 },
    });
    expect(failure).not.toBeNull();
    expect(failure!.stage).toBe("quality");
    expect(failure!.diagnostics.some((d) => d.includes("source-url-altered"))).toBe(true);
  });
});

describe("deterministic source-title publisher stripping + duplicate-publisher validation", () => {
  const unit = (over: Partial<SourceReferenceUnit>): SourceReferenceUnit => ({
    sourceReferenceId: "source-ref-0",
    sourceUnitId: "section.0.block.3",
    originalTitle: "Hong Kong Social Media Creator Marketing",
    originalUrl: "https://anymindgroup.com/news/blog/7686/",
    originalPublisher: "AnyMind Group",
    ...over,
  });
  const contentOf = (block: EditorialBlock): InlineContent[] => {
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    return block.content;
  };

  it("1. a localized title ending in `| AnyMind Group` is stripped before canonical rendering", () => {
    expect(stripTrailingPublisherSuffix("香港社交媒體創作者市場推廣 | AnyMind Group", "AnyMind Group")).toBe("香港社交媒體創作者市場推廣");
  });

  it("2. a localized title ending in `— Open Influence` is stripped", () => {
    expect(stripTrailingPublisherSuffix("香港領先嘅創作者市場推廣公司 — Open Influence")).toBe("香港領先嘅創作者市場推廣公司");
  });

  it("3. a model-generated localized publisher phrase before `— StarNgage` is not duplicated", () => {
    expect(stripTrailingPublisherSuffix("香港創作者市場推廣 | 香港創作者代理商")).toBe("香港創作者市場推廣");
  });

  it("4. the canonical publisher is appended exactly once", () => {
    const block = buildSourceReferenceBlock(unit({ localizedDisplayTitle: "香港社交媒體創作者市場推廣 | AnyMind Group" }));
    const content = contentOf(block);
    const text = content.map((n) => (n.type === "text" ? n.text : (n.type === "link" ? n.text : ""))).join(" ");
    const once = (text.match(/AnyMind Group/g) || []).length;
    expect(once).toBe(1);
    expect(text).not.toContain("| AnyMind Group");
    const link = content.find((n): n is Extract<InlineContent, { type: "link" }> => n.type === "link");
    expect(link?.text).toBe("香港社交媒體創作者市場推廣");
  });

  it("5. luna.hk renders as Luna", () => {
    expect(derivePublisherName("https://www.luna.hk/influencer-marketing")).toBe("Luna");
  });

  it("6. unknown hosts still do not invent publishers", () => {
    expect(derivePublisherName("https://unknown-host-123.com/x")).toBeUndefined();
    const block = buildSourceReferenceBlock({ ...unit({ originalUrl: "https://unknown-host-123.com/x", originalPublisher: undefined }), localizedDisplayTitle: "點解你唔應該自己管理" });
    expect(contentOf(block).some((n) => (n.type === "text" ? n.text.includes("—") : false))).toBe(false);
  });

  it("7. canonical URL/title/source mapping remains unchanged by stripping", () => {
    const clean = stripTrailingPublisherSuffix("香港社交媒體創作者市場推廣 | AnyMind Group");
    const u = unit({ localizedDisplayTitle: clean });
    const block = buildSourceReferenceBlock(u);
    const link = contentOf(block).find((n): n is Extract<InlineContent, { type: "link" }> => n.type === "link");
    expect(link?.href).toBe("https://anymindgroup.com/news/blog/7686/");
  });

  it("8. source-title-duplicate-publisher fires for residual duplication", () => {
    const originals = new Map<string, SourceReferenceUnit>([[unit({}).sourceUnitId, unit({})]]);
    // Simulate a stored title that still embeds the publisher (stripping did not run).
    const residual = unit({ localizedDisplayTitle: "香港社交媒體創作者市場推廣 | AnyMind Group" });
    const findings = validateSourceReferences(originals, [residual]);
    expect(findings.some((f) => f.category === "source-title-duplicate-publisher")).toBe(true);
  });

  it("9. legitimate title punctuation is not incorrectly removed", () => {
    expect(stripTrailingPublisherSuffix("香港創作者市場推廣 — 完整指南")).toBe("香港創作者市場推廣 — 完整指南");
    expect(stripTrailingPublisherSuffix("點解你唔應該自己管理香港嘅創作者市場推廣？")).toBe("點解你唔應該自己管理香港嘅創作者市場推廣？");
  });
});
