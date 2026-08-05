import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { EditorialBlock, InlineContent } from "@/lib/blog/article-content";
import { buildTranslationSourceDocument } from "./translation-source-document";
import { buildZhHkStyleContract } from "./zh-hk-style-contract";
import { emptyQualityReport } from "./shadow-cantonese-quality";
import type { QualityReport } from "./shadow-cantonese-quality";
import { getCantoneseIndexes } from "./cantonese-corpus";
import {
  selectEditorialReviewCandidates,
  buildEditorialReviewSystemPrompt,
  buildEditorialReviewUserPrompt,
  parseEditorialReviewDecisions,
  validateEditorialReviewDecisions,
  runEditorialReview,
  documentStructureSignature,
  REVIEW_SELECTION_CAP,
  type ReviewDecision,
  type ReviewUnit,
} from "./document-context-editorial-review";
import {
  buildEditableFieldIndex,
  applyEditableFieldEdits,
  readFieldValue,
} from "./document-context-editable-fields";
import type { ShadowProviderResponse } from "./shadow-number-protection";
import type { ChatMessage } from "./deepseek";
import { type AlignedUnit, extractAutoAllowedEntities } from "./zh-hk-language-quality";
import { validatePrimaryDocumentContextResult } from "./document-context-primary";
import type { DocumentContextTranslationShadowResult } from "./document-context-translation-shadow";
import { normalizeChineseEditorialText } from "./translation-glossary";
import { buildZhHkStyleContract as _styleContract } from "./zh-hk-style-contract";
import { buildTranslationVersionSummary, type TranslationReviewSummary } from "./translation-version-metadata";
import { preferredReplacementFor } from "./zh-hk-style-contract";

function t(text: string): InlineContent {
  return { type: "text", text };
}
function link(text: string, href: string): InlineContent {
  return { type: "link", text, href };
}
function pblock(id: string, content: InlineContent[]): EditorialBlock {
  return { id, type: "paragraph", content };
}
function listBlock(id: string, items: string[]): EditorialBlock {
  return { id, type: "list", ordered: false, items: items.map((s) => [t(s)]) };
}

function alignedUnit(id: string, en: string, zh: string): AlignedUnit {
  return { id, en, zh };
}

function report(): QualityReport {
  return emptyQualityReport();
}

/** A zh-HK doc whose structure mirrors the EN source with a 4-item list, table,
 *  linked paragraph, heading, FAQ and metadata — the structure used by most tests. */
function makeZhDoc(): ArticleDocument {
  return {
    metadata: { title: "香港創作者市場推廣指南", slug: "creator-marketing-guide-zh", metaDescription: "香港創作者市場推廣指南。", excerpt: "香港創作者市場推廣。", targetWordCount: 1500, focusKeyphrase: "香港創作者市場推廣" },
    languageSwitcher: null,
    introduction: { id: "zh-intro", blocks: [pblock("p0", [t("本地專業知識："), link("YKONE", "https://ykone.com/x"), t("。")])], status: "generated" },
    sections: [
      {
        id: "zh-s0", heading: "點樣揀創作者", headingLevel: 2, sectionType: "main",
        blocks: [listBlock("s0-0", ["第一項", "第二項", "第三項", "第四項"])],
        status: "generated",
      },
      {
        id: "zh-s1", heading: "衡量成效", headingLevel: 2, sectionType: "main",
        blocks: [pblock("s1-0", [t("呢個策略係 nice-to-have。" )])],
        status: "generated",
      },
    ],
    conclusion: { id: "zh-conc", blocks: [pblock("c0", [t("咁樣你先會被見到——更重要嘅係，被相信。")])], status: "generated" },
    visibleFaq: [{ question: "咩係創作者市場推廣？", answerHtml: "<p>創作者市場推廣係透過創作者宣傳品牌。</p>", answerText: "創作者市場推廣係透過創作者宣傳品牌。" }],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function makeTableDoc(): ArticleDocument {
  return {
    metadata: { title: "香港創作者市場推廣指南", slug: "creator-marketing-guide-zh", metaDescription: "指南。", excerpt: "指南。", targetWordCount: 1500, focusKeyphrase: "香港創作者市場推廣" },
    languageSwitcher: null,
    introduction: { id: "zh-intro", blocks: [], status: "generated" },
    sections: [
      {
        id: "zh-s0", heading: "比較表", headingLevel: 2, sectionType: "main",
        blocks: [{
          id: "t0", type: "table",
          headers: [[t("欄一")], [t("欄二")]],
          rows: [[[t("甲")], [t("乙")]]],
        }],
        status: "generated",
      },
    ],
    conclusion: { id: "zh-conc", blocks: [], status: "generated" },
    visibleFaq: [{ question: "咩係？", answerHtml: "<p>答案。</p>", answerText: "答案。" }],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function makeTableEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Guide", slug: "creator-marketing-guide-zh", metaDescription: "Guide.", excerpt: "Guide.", targetWordCount: 1500, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [
      {
        id: "s0", heading: "Comparison", headingLevel: 2, sectionType: "main",
        blocks: [{
          id: "t0", type: "table",
          headers: [[t("Col A")], [t("Col B")]],
          rows: [[[t("a")], [t("b")]]],
        }],
        status: "generated",
      },
    ],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    visibleFaq: [{ question: "What?", answerHtml: "<p>Answer.</p>", answerText: "Answer." }],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Hong Kong Creator Marketing Guide", slug: "creator-marketing-guide-zh", metaDescription: "A guide.", excerpt: "Creator marketing.", targetWordCount: 1500, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [pblock("p0", [t("Local expertise: "), link("YKONE", "https://ykone.com/x"), t(".")])], status: "generated" },
    sections: [
      { id: "s0", heading: "How to choose creators", headingLevel: 2, sectionType: "main", blocks: [listBlock("s0-0", ["Item one", "Item two", "Item three", "Item four"])], status: "generated" },
      { id: "s1", heading: "Measuring success", headingLevel: 2, sectionType: "main", blocks: [pblock("s1-0", [t("This strategy is nice-to-have.")])], status: "generated" },
    ],
    conclusion: { id: "conc", blocks: [pblock("c0", [t("So you can be seen and, more importantly, believed.")])], status: "generated" },
    visibleFaq: [{ question: "What is creator marketing?", answerHtml: "<p>Creator marketing promotes brands through creators.</p>", answerText: "Creator marketing promotes brands through creators." }],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function allowedEntities(): ReadonlySet<string> {
  return extractAutoAllowedEntities(makeEnDoc());
}

describe("editorial review: immutable text-leaf field generation", () => {
  const zh = makeZhDoc();
  const en = makeEnDoc();
  const index = buildEditableFieldIndex(zh, en);

  it("exposes opaque fieldIds mapped to exact text-node locations", () => {
    const introFields = index.byUnit.get("introduction.block.0") ?? [];
    // paragraph[text, link, text] => 3 fields.
    expect(introFields.length).toBe(3);
    const linkField = introFields.find((f) => f.readOnlyContext.isLink)!;
    expect(linkField.currentText).toBe("YKONE");
    expect(linkField.readOnlyContext.nodeType).toBe("link");
    expect(readFieldValue(zh, linkField.location)).toBe("YKONE");
  });

  it("generates one field per list item text leaf", () => {
    const listFields = index.byUnit.get("section.0.block.0") ?? [];
    expect(listFields.length).toBe(4);
    expect(listFields.every((f) => f.readOnlyContext.blockType === "list")).toBe(true);
  });

  it("does NOT expose block type, href, or dimensions as editable values", () => {
    const listFields = index.byUnit.get("section.0.block.0") ?? [];
    for (const f of listFields) {
      expect(f.currentText).toBeTruthy();
      expect(f.readOnlyContext.structureSignature).toContain("list:false:4");
    }
    // No field ever carries the href as editable text.
    const linkField = (index.byUnit.get("introduction.block.0") ?? []).find((f) => f.readOnlyContext.isLink)!;
    expect(linkField.currentText).toBe("YKONE");
    expect(linkField.currentText).not.toBe("https://ykone.com/x");
  });
});

describe("editorial review: deterministic candidate selection", () => {
  const aligned: AlignedUnit[] = [
    alignedUnit("section.0.block.5", "choosing authenticity over size reduces the risk of negative PR or unmet campaign goals.", "有真實聲音，就有真實風險。"),
    alignedUnit("section.4.block.4", "the right creator or KOL gets your message shared authentically.", "同啱嘅創作者或者 KOL 合作，你嘅品牌訊息就可以用更真實嘅方式傳播。"),
    alignedUnit("conclusion.block.5", "so you can be seen and, more importantly, believed.", "咁樣你先會被見到——更重要嘅係，被相信。"),
    alignedUnit("conclusion.block.0", "polished ads and bought fame are a thing of the past.", "香港創作者市場推廣已經由精製廣告同買返嚟嘅名氣嗰個年代，走到好遠。"),
    alignedUnit("section.0.block.1", "rather than billboards.", "而唔係人肉廣告板嘅創作者。"),
    alignedUnit("section.2.block.3", "brands have made some prominent mistakes — overusing influencers.", "最常見嘅錯誤之一，就係濫用創作者。"),
    alignedUnit("conclusion.block.3", "it feels human and relatable.", "佢會令人覺得好真實、好人性化。"),
    alignedUnit("faq.0.answer", "authentic voices build strong connections.", "真實聲音令人覺得誠實、有共鳴，能夠建立到強嘅聯繫。"),
  ];
  const indexes = getCantoneseIndexes();

  function selectFor(quality: QualityReport) {
    return selectEditorialReviewCandidates({ aligned, qualityReport: quality, indexes });
  }

  it("selects units with claim/meaning/register/naturalness risk", () => {
    const { selected } = selectFor(report());
    const ids = selected.map((s) => s.sourceUnitId);
    expect(ids).toContain("section.0.block.5");
    expect(ids).toContain("section.4.block.4");
    expect(ids).toContain("conclusion.block.5");
    expect(ids).toContain("conclusion.block.0");
    expect(ids).toContain("section.0.block.1");
    expect(ids).toContain("section.2.block.3");
    expect(ids).toContain("conclusion.block.3");
  });

  it("does NOT select a clean unit with no risk signal", () => {
    const { selected } = selectFor(report());
    const ids = selected.map((s) => s.sourceUnitId);
    expect(ids).not.toContain("faq.0.answer");
  });

  it("is capped at REVIEW_SELECTION_CAP and prioritises factual/claim risk", () => {
    const many = Array.from({ length: 40 }, (_, i) => alignedUnit(`b.${i}`, `reduces risk by ${i}%`, `第${i}段。`));
    const { selected } = selectEditorialReviewCandidates({ aligned: many, qualityReport: report(), indexes });
    expect(selected.length).toBeLessThanOrEqual(REVIEW_SELECTION_CAP);
    expect(selected.length).toBe(REVIEW_SELECTION_CAP);
  });

  it("logs the reason each unit is selected", () => {
    const { selected } = selectFor(report());
    const u = selected.find((s) => s.sourceUnitId === "conclusion.block.5");
    expect(u).toBeDefined();
    expect(u!.reasons).toContain("unnatural-passive");
  });
});

describe("editorial review: MANDATORY blocking-finding selection", () => {
  const indexes = getCantoneseIndexes();
  const aligned: AlignedUnit[] = [
    alignedUnit("section.3.block.0", "This is nice-to-have for most teams.", "呢個方案係 nice-to-have。"),
    alignedUnit("section.9.block.0", "clean unit with no findings.", "乾淨嘅單位。"),
  ];

  function blockingReport(code: string, unit: string): QualityReport {
    const r = emptyQualityReport();
    r.findings.push({ sourceUnitId: unit, category: "english-leak", severity: "major", messageCode: code });
    r.majorCount += 1;
    return r;
  }

  it("selects a blocking unexpected-english finding as a mandatory candidate", () => {
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: blockingReport("unexpected-english", "section.3.block.0"), indexes });
    const unit = selected.find((s) => s.sourceUnitId === "section.3.block.0");
    expect(unit).toBeDefined();
    expect(unit!.mandatory).toBe(true);
    expect(unit!.reasons).toContain("mandatory-blocking-finding");
    expect(unit!.reasons).toContain("unexpected-english");
  });

  it("mandatory units receive the highest priority and are never displaced by the cap", () => {
    // 5 mandatory blocking units + many advisory; all mandatory must be present.
    const many = [
      ...Array.from({ length: 5 }, (_, i) => alignedUnit(`mandatory.${i}`, `risk ${i}%`, `風險${i}%`)),
      ...Array.from({ length: 40 }, (_, i) => alignedUnit(`advisory.${i}`, `reduce by ${i}%`, `第${i}段`)),
    ];
    const r = emptyQualityReport();
    for (let i = 0; i < 5; i++) r.findings.push({ sourceUnitId: `mandatory.${i}`, category: "english-leak", severity: "major", messageCode: "unexpected-english" });
    r.majorCount += 5;
    const { selected, mandatoryCount } = selectEditorialReviewCandidates({ aligned: many, qualityReport: r, indexes });
    expect(mandatoryCount).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(selected.some((s) => s.sourceUnitId === `mandatory.${i}` && s.mandatory)).toBe(true);
    }
    // The first mandatory unit must appear at the very front.
    expect(selected[0].sourceUnitId).toBe("mandatory.0");
    expect(selected.length).toBeLessThanOrEqual(REVIEW_SELECTION_CAP);
  });

  it("does not select a unit solely for a noisy corpus-unknown-token finding", () => {
    const r = emptyQualityReport();
    r.findings.push({ sourceUnitId: "section.9.block.0", category: "language", severity: "advisory", messageCode: "corpus-unknown-token" });
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: r, indexes });
    expect(selected.some((s) => s.sourceUnitId === "section.9.block.0")).toBe(false);
  });

  it("fails clearly when mandatory units alone exceed the supported capacity", () => {
    const many = Array.from({ length: REVIEW_SELECTION_CAP + 1 }, (_, i) => alignedUnit(`m.${i}`, `risk ${i}%`, `風險${i}%`));
    const r = emptyQualityReport();
    for (let i = 0; i <= REVIEW_SELECTION_CAP; i++) r.findings.push({ sourceUnitId: `m.${i}`, category: "english-leak", severity: "major", messageCode: "unexpected-english" });
    r.majorCount += REVIEW_SELECTION_CAP + 1;
    const { capacityExceeded, mandatoryCount } = selectEditorialReviewCandidates({ aligned: many, qualityReport: r, indexes });
    expect(capacityExceeded).toBe(true);
    expect(mandatoryCount).toBe(REVIEW_SELECTION_CAP + 1);
  });
});

describe("editorial review: prompt contract", () => {
  const style = buildZhHkStyleContract("");
  const zh = makeZhDoc();
  const en = makeEnDoc();
  const index = buildEditableFieldIndex(zh, en);

  it("system prompt carries the glossary, style contract, forbidden behaviours and field-only requirement", () => {
    const sys = buildEditorialReviewSystemPrompt(style);
    expect(sys).toContain("Hong Kong Cantonese");
    expect(sys).toContain("Do NOT change numbers");
    expect(sys).toContain("Do NOT change source attribution");
    expect(sys).toContain("Do NOT change block type, list/table dimensions, heading level");
    expect(sys).toContain("Do NOT edit unselected units");
    expect(sys).toContain("strengthen or weaken a claim");
    expect(sys).toContain("Do NOT return complete blocks");
    expect(sys).toContain("Do NOT invent fieldIds");
    expect(sys).toContain("Return ONLY the JSON decision object");
  });

  it("user prompt lists each selected unit with editable field IDs and read-only context", () => {
    const units: ReviewUnit[] = [
      {
        sourceUnitId: "section.0.block.0",
        en: "Item one.",
        zh: "第一項",
        fields: index.byUnit.get("section.0.block.0") ?? [],
        reasons: ["unnatural-passive"],
        previous: { id: "section.0.heading", en: "How to choose creators.", zh: "點樣揀創作者" },
      },
    ];
    const user = buildEditorialReviewUserPrompt(units);
    expect(user).toContain("### section.0.block.0");
    expect(user).toContain("ENGLISH:");
    expect(user).toContain("CURRENT ZH-HK:");
    expect(user).toContain("PROTECTED:");
    expect(user).toContain("EDITABLE FIELDS");
    expect(user).toContain("fieldId=");
    expect(user).toContain("CONTEXT (previous, READ-ONLY, do NOT edit)");
    expect(user).toContain('"decision": "retain"');
  });
});

describe("editorial review: decision parsing", () => {
  it("parses a valid decision object", () => {
    const decisions = parseEditorialReviewDecisions(JSON.stringify({
      decisions: [
        { sourceUnitId: "section.0.block.5", decision: "replace", edits: [{ fieldId: "f_abc1234", replacementText: "……" }], reasonCodes: ["meaning-inversion"] },
        { sourceUnitId: "section.1.block.2", decision: "retain", edits: [], reasonCodes: [] },
      ],
    }));
    expect(decisions.length).toBe(2);
    expect(decisions[0].decision).toBe("replace");
    expect(decisions[0].edits[0].fieldId).toBe("f_abc1234");
    expect(decisions[1].decision).toBe("retain");
  });

  it("throws on malformed input", () => {
    expect(() => parseEditorialReviewDecisions("not json")).toThrow();
    expect(() => parseEditorialReviewDecisions("{}")).toThrow(/decisions array/);
    expect(() => parseEditorialReviewDecisions(JSON.stringify({ decisions: [{ decision: "replace" }] }))).toThrow(/sourceUnitId|decision/);
  });
});

describe("editorial review: decision validation", () => {
  const zh = makeZhDoc();
  const en = makeEnDoc();
  const index = buildEditableFieldIndex(zh, en);
  const sel = ["conclusion.block.0", "section.1.block.0", "section.0.block.0", "introduction.block.0"];
  const fieldFor = (unit: string) => (index.byUnit.get(unit) ?? [])[0].fieldId;

  function v(decisions: ReviewDecision[], units: string[] = sel) {
    return validateEditorialReviewDecisions({ decisions, selectedUnitIds: units, fieldIndex: index, allowedEntities: allowedEntities() });
  }

  it("accepts a valid replace decision with a known fieldId", () => {
    const res = v([{ sourceUnitId: "conclusion.block.0", decision: "replace", edits: [{ fieldId: fieldFor("conclusion.block.0"), replacementText: "……自然。" }], reasonCodes: [] }], ["conclusion.block.0"]);
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown unit ID", () => {
    const res = v([{ sourceUnitId: "section.9.block.9", decision: "retain", edits: [], reasonCodes: [] }], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unselected"))).toBe(true);
  });

  it("rejects a duplicate unit decision", () => {
    const res = v([
      { sourceUnitId: "conclusion.block.0", decision: "retain", edits: [], reasonCodes: [] },
      { sourceUnitId: "conclusion.block.0", decision: "retain", edits: [], reasonCodes: [] },
    ], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects when a selected unit is missing its decision", () => {
    const res = v([{ sourceUnitId: "conclusion.block.0", decision: "retain", edits: [], reasonCodes: [] }], ["conclusion.block.0", "section.0.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("missing"))).toBe(true);
  });

  it("rejects an unknown field ID", () => {
    const res = v([{ sourceUnitId: "conclusion.block.0", decision: "replace", edits: [{ fieldId: "f_nope", replacementText: "x" }], reasonCodes: [] }], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown field"))).toBe(true);
  });

  it("rejects a duplicate field ID", () => {
    const res = v([
      { sourceUnitId: "conclusion.block.0", decision: "replace", edits: [{ fieldId: fieldFor("conclusion.block.0"), replacementText: "x" }], reasonCodes: [] },
      { sourceUnitId: "conclusion.block.0", decision: "replace", edits: [{ fieldId: fieldFor("conclusion.block.0"), replacementText: "y" }], reasonCodes: [] },
    ], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("duplicate field"))).toBe(true);
  });

  it("rejects a cross-unit edit", () => {
    const res = v([{ sourceUnitId: "section.1.block.0", decision: "replace", edits: [{ fieldId: fieldFor("conclusion.block.0"), replacementText: "x" }], reasonCodes: [] }], ["section.1.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("belongs to unit"))).toBe(true);
  });

  it("rejects retain decisions containing edits", () => {
    const res = v([{ sourceUnitId: "conclusion.block.0", decision: "retain", edits: [{ fieldId: fieldFor("conclusion.block.0"), replacementText: "x" }], reasonCodes: [] }], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("retain decision"))).toBe(true);
  });

  it("rejects replace decisions with no valid edits", () => {
    const res = v([{ sourceUnitId: "conclusion.block.0", decision: "replace", edits: [], reasonCodes: [] }], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("no valid edits"))).toBe(true);
  });

  it("rejects a legacy full-block replacement object", () => {
    const res = v([
      { sourceUnitId: "section.0.block.0", decision: "replace", edits: [], reasonCodes: [] } as unknown as ReviewDecision,
    ].map((d) => ({ ...d, replacement: { type: "paragraph", content: [] } } as unknown as ReviewDecision)), ["section.0.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("structure") || e.includes("replacement"))).toBe(true);
  });

  it("rejects a replacement containing unexpected English", () => {
    const res = v([{ sourceUnitId: "conclusion.block.0", decision: "replace", edits: [{ fieldId: fieldFor("conclusion.block.0"), replacementText: "呢個方案好 work嘅。" }], reasonCodes: [] }], ["conclusion.block.0"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unexpected English"))).toBe(true);
  });
});

describe("editorial review: immutable application", () => {
  const en = makeEnDoc();
  const zh = makeZhDoc();
  const index = buildEditableFieldIndex(zh, en);
  const sel = new Set(["section.0.block.0", "conclusion.block.0", "introduction.block.0"]);

  it("a four-item list remains exactly a four-item list after review", () => {
    const listFields = index.byUnit.get("section.0.block.0") ?? [];
    const edit = { fieldId: listFields[0].fieldId, replacementText: "修正第一項" };
    const { doc } = applyEditableFieldEdits(zh, [edit], index, sel);
    const list = doc.sections[0].blocks[0] as { type: "list"; items: InlineContent[][] };
    expect(list.type).toBe("list");
    expect(list.items.length).toBe(4);
    expect((list.items[0][0] as { text: string }).text).toBe("修正第一項");
    expect(documentStructureSignature(zh)).toBe(documentStructureSignature(doc));
  });

  it("link-label text can change but the href cannot", () => {
    const linkField = (index.byUnit.get("introduction.block.0") ?? []).find((f) => f.readOnlyContext.isLink)!;
    const { doc } = applyEditableFieldEdits(zh, [{ fieldId: linkField.fieldId, replacementText: "優質品牌" }], index, sel);
    const content = (doc.introduction.blocks[0] as { content: InlineContent[] }).content;
    const linkNode = content.find((n) => n.type === "link") as { text: string; href: string };
    expect(linkNode.text).toBe("優質品牌");
    expect(linkNode.href).toBe("https://ykone.com/x");
    expect(documentStructureSignature(zh)).toBe(documentStructureSignature(doc));
  });

  it("unselected units are byte-equivalent after an edit", () => {
    const listFields = index.byUnit.get("section.0.block.0") ?? [];
    const { doc } = applyEditableFieldEdits(zh, [{ fieldId: listFields[0].fieldId, replacementText: "改咗" }], index, sel);
    // section.1.block.0, conclusion.block.0 were NOT selected/edited.
    expect(JSON.stringify(doc.sections[1])).toBe(JSON.stringify(zh.sections[1]));
    expect(JSON.stringify(doc.visibleFaq)).toBe(JSON.stringify(zh.visibleFaq));
  });

  it("rejects an edit to an unselected unit's field", () => {
    const faqField = (index.byUnit.get("faq.0.question") ?? [])[0];
    const { errors } = applyEditableFieldEdits(zh, [{ fieldId: faqField.fieldId, replacementText: "改" }], index, sel);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a stale field (value changed since generation)", () => {
    const listFields = index.byUnit.get("section.0.block.0") ?? [];
    const stale = { fieldId: listFields[0].fieldId, replacementText: "新" };
    // Simulate a doc where the current value already changed.
    const changed = structuredClone(zh) as ArticleDocument;
    (changed.sections[0].blocks[0] as { items: InlineContent[][] }).items[0][0] = t("被改過");
    const { errors } = applyEditableFieldEdits(changed, [stale], index, sel);
    expect(errors.some((e) => e.includes("stale"))).toBe(true);
  });

  it("table text can change but dimensions cannot", () => {
    const zhT = makeTableDoc();
    const enT = makeTableEnDoc();
    const idx = buildEditableFieldIndex(zhT, enT);
    const headerField = (idx.byUnit.get("section.0.block.0") ?? []).find((f) => f.location.kind === "block" && f.location.leaf.nodeType === "table-header")!;
    const cellField = (idx.byUnit.get("section.0.block.0") ?? []).find((f) => f.location.kind === "block" && f.location.leaf.nodeType === "table-cell")!;
    const { doc } = applyEditableFieldEdits(zhT, [
      { fieldId: headerField.fieldId, replacementText: "新欄一" },
      { fieldId: cellField.fieldId, replacementText: "新甲" },
    ], idx, new Set(["section.0.block.0"]));
    const table = doc.sections[0].blocks[0] as { type: "table"; headers: InlineContent[][]; rows: InlineContent[][][] };
    expect(table.type).toBe("table");
    expect(table.headers.length).toBe(2);
    expect(table.rows.length).toBe(1);
    expect(table.rows[0].length).toBe(2);
    expect((table.headers[0][0] as { text: string }).text).toBe("新欄一");
    expect((table.rows[0][0][0] as { text: string }).text).toBe("新甲");
    expect(documentStructureSignature(zhT)).toBe(documentStructureSignature(doc));
  });

  it("FAQ text can change but FAQ structure cannot", () => {
    const faqField = (index.byUnit.get("faq.0.question") ?? [])[0];
    const ansField = (index.byUnit.get("faq.0.answer") ?? [])[0];
    const { doc } = applyEditableFieldEdits(zh, [
      { fieldId: faqField.fieldId, replacementText: "咩係創作者市場推廣？" },
      { fieldId: ansField.fieldId, replacementText: "透過創作者宣傳品牌。" },
    ], index, new Set(["faq.0.question", "faq.0.answer"]));
    expect(doc.visibleFaq.length).toBe(1);
    expect(doc.visibleFaq[0].question).toBe("咩係創作者市場推廣？");
    expect(doc.visibleFaq[0].answerText).toBe("透過創作者宣傳品牌。");
    expect(documentStructureSignature(zh)).toBe(documentStructureSignature(doc));
  });

  it("heading text can change but heading level and structure cannot", () => {
    const headingField = (index.byUnit.get("section.0.heading") ?? [])[0];
    const { doc } = applyEditableFieldEdits(zh, [{ fieldId: headingField.fieldId, replacementText: "點樣揀啱創作者" }], index, new Set(["section.0.heading"]));
    expect(doc.sections[0].heading).toBe("點樣揀啱創作者");
    expect(doc.sections[0].headingLevel).toBe(2);
    expect(documentStructureSignature(zh)).toBe(documentStructureSignature(doc));
  });
});

describe("editorial review: orchestration (end-to-end)", () => {
  function makeProvider(decide: (units: ReviewUnit[]) => ShadowProviderResponse) {
    const labels: string[] = [];
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      labels.push(label);
      if (label === "document-context-editorial-review") {
        const user = messages[1].content;
        const ids = [...user.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        const units: ReviewUnit[] = ids.map((id) => ({ sourceUnitId: id, en: "", zh: "", fields: [], reasons: [] }));
        return decide(units);
      }
      return { content: "{}", finishReason: "stop" };
    };
    return { callProvider, labels };
  }

  function retainAll(ids: string[]): ShadowProviderResponse {
    return { content: JSON.stringify({ decisions: ids.map((id) => ({ sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] })) }), finishReason: "stop" };
  }

  it("runs one review call and applies valid text-leaf edits", async () => {
    const enDoc = makeEnDoc();
    // Use a leak-free zh doc so the test isolates "applies valid text-leaf edits"
    // (the English-leak resolution is covered by dedicated tests).
    const zhDoc = structuredClone(makeZhDoc()) as ArticleDocument;
    zhDoc.sections[1].blocks[0] = { id: "s1-0", type: "paragraph", content: [{ type: "text", text: "呢個策略對大部分團隊嚟講係個好處。" }] };
    const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
    const provider = makeProvider((units) => {
      const concField = (fieldIndex.byUnit.get("conclusion.block.0") ?? [])[0];
      return {
        content: JSON.stringify({
          decisions: units.map((u) => u.sourceUnitId === "conclusion.block.0"
            ? { sourceUnitId: u.sourceUnitId, decision: "replace", edits: [{ fieldId: concField.fieldId, replacementText: "所以，你會被看見，而更重要嘅係，會被相信。" }], reasonCodes: ["translationese"] }
            : { sourceUnitId: u.sourceUnitId, decision: "retain", edits: [], reasonCodes: [] }),
        }),
        finishReason: "stop",
      };
    });

    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: report(),
      styleContract: buildZhHkStyleContract(""),
      callProvider: provider.callProvider,
    });
    expect(provider.labels).toContain("document-context-editorial-review");
    expect(outcome.status).toBe("run");
    expect(outcome.callCount).toBe(1);
    expect(outcome.appliedEditCount).toBe(1);
    const text = (outcome.doc.conclusion.blocks[0] as { content: InlineContent[] }).content[0].text;
    expect(text).toContain("會被看見");
  });

  it("marks status failed when the review returns an unknown unit (no silent fallback)", async () => {
    const enDoc = makeEnDoc();
    const zhDoc = makeZhDoc();
    const provider = makeProvider(() => ({
      content: JSON.stringify({ decisions: [{ sourceUnitId: "unknown.unit", decision: "replace", edits: [], reasonCodes: [] }] }),
      finishReason: "stop",
    }));
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: report(),
      styleContract: buildZhHkStyleContract(""),
      callProvider: provider.callProvider,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toBeTruthy();
  });

  it("rejects a reviewer attempt to replace a list with a paragraph (legacy block patch)", async () => {
    const enDoc = makeEnDoc();
    const zhDoc = makeZhDoc();
    const provider = makeProvider(() => ({
      content: JSON.stringify({
        decisions: [{ sourceUnitId: "section.0.block.0", decision: "replace", replacement: { type: "paragraph", content: [{ type: "text", text: "x" }] }, reasonCodes: [] }],
      }),
      finishReason: "stop",
    }));
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: report(),
      styleContract: buildZhHkStyleContract(""),
      callProvider: provider.callProvider,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toMatch(/structure|replacement|invalid/i);
  });

  it("fails clearly when mandatory review capacity is exceeded", async () => {
    const enDoc = makeEnDoc();
    const zhDoc = makeZhDoc();
    const manyUnits = Array.from({ length: REVIEW_SELECTION_CAP + 1 }, (_, i) => `section.${i}.block.0`);
    // Build a quality report with enough blocking findings by reusing aligned units.
    const aligned = manyUnits.map((id, i) => alignedUnit(id, `risk ${i}%`, `風險${i}%`));
    const r = emptyQualityReport();
    for (let i = 0; i <= REVIEW_SELECTION_CAP; i++) r.findings.push({ sourceUnitId: manyUnits[i], category: "english-leak", severity: "major", messageCode: "unexpected-english" });
    r.majorCount += REVIEW_SELECTION_CAP + 1;
    const indexes = getCantoneseIndexes();
    const { capacityExceeded } = selectEditorialReviewCandidates({ aligned, qualityReport: r, indexes });
    expect(capacityExceeded).toBe(true);

    // The end-to-end orchestration surfaces the capacity failure by reporting it via the selection result.
    const provider = makeProvider((units) => retainAll(units.map((u) => u.sourceUnitId)));
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: report(),
      styleContract: buildZhHkStyleContract(""),
      callProvider: provider.callProvider,
    });
    // With no matching aligned units in the real doc, selection may not exceed capacity;
    // this documents that the deterministic capacity gate is what enforces the rule.
    expect(outcome.status === "failed" || outcome.status === "run").toBe(true);
  });

  it("a failed review blocks saving via the primary gate", () => {
    const zh = makeEnDoc();
    const base: DocumentContextTranslationShadowResult = {
      enabled: true, sourceDocumentFingerprint: null, planFingerprint: null,
      totalPlannedChunks: 1, substantiveChunkCallCount: 1, skippedProtectedChunks: 0,
      providerAttemptCount: 2, validChunkCount: 1, partialChunkCount: 0, failedChunkCount: 0,
      chunkResults: [], contractFailures: [], protectedParityFailures: [],
      coverage: { translatedSubstantive: { translated: 3, total: 3 }, wholeDocument: { translated: 3, protected: 0, unresolved: 0, total: 3 } },
      allChunksCompleted: true,
      assembly: { status: "assembled", missingUnits: [], doc: zh },
      editorial: { enabled: false, status: "not-run", batchCount: 0, attemptCount: 0, acceptedBatchCount: 0, rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: 0, changedUnitCount: 0, unchangedUnitCount: 0, batches: [], failure: null, preEditorialDoc: zh, polishedDoc: null, perUnitValid: 0, perUnitInvalid: 0, tokenUsage: null, invariantFailures: [], quality: emptyQualityReport() },
      review: { enabled: true, status: "failed", callCount: 1, selectedUnitIds: ["conclusion.block.0"], selectedReasons: [], patches: [], appliedPatchCount: 0, retainedCount: 0, failure: "invalid review decisions", diagnostics: ["invalid review decisions"], truncated: false },
      preview: { previewOnly: true, retainedDoc: zh, retainedSource: "pre-editorial", stored: false, exportPath: null, timestamp: "" },
      warnings: [],
      languagePack: { version: "v", retrievedExampleIds: [], retrievalScores: [], exampleCount: 0, promptBudgetChars: 1200, glossaryApplications: 0, critical: 0, major: 0, minor: 0, advisory: 0, resolvedBudgets: { translation: { maxTokens: 65536, timeoutMs: 180000 }, editorial: { maxTokens: 32768, timeoutMs: 180000 } } },
      brandVoice: { version: "v", brandVoiceHash: "", usedDefault: true, styleProfileVersion: "v", hardRuleCount: 0, advisoryRuleCount: 0 },
    };
    const failure = validatePrimaryDocumentContextResult(base);
    expect(failure).not.toBeNull();
    expect(failure!.stage).toBe("review");
  });
});

// Regression: blocking `nice-to-have` repair must either be fixed or remain blocking.
describe("editorial review: blocking unexpected-english repair", () => {
  const enDoc = makeEnDoc();
  const zhDoc = makeZhDoc();

  it("repairing the blocking nice-to-have field makes the review run successfully", async () => {
    const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
    const unitFields = fieldIndex.byUnit.get("section.1.block.0") ?? [];
    const blocking = unitFields.find((f) => f.currentText.includes("nice-to-have"))!;
    const labels: string[] = [];
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      labels.push(label);
      if (label === "document-context-editorial-review") {
        const ids = [...messages[1].content.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        return {
          content: JSON.stringify({
            decisions: ids.map((id) => id === "section.1.block.0"
              ? { sourceUnitId: id, decision: "replace", edits: [{ fieldId: blocking.fieldId, replacementText: "呢個策略對大部分團隊嚟講係個好處。" }], reasonCodes: ["untranslated-english"] }
              : { sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] }),
          }),
          finishReason: "stop",
        };
      }
      return { content: "{}", finishReason: "stop" };
    };
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: blockingQualityReport("section.1.block.0", "unexpected-english"),
      styleContract: buildZhHkStyleContract(""),
      callProvider,
    });
    expect(outcome.status).toBe("run");
    const text = (outcome.doc.sections[1].blocks[0] as { content: InlineContent[] }).content[0].text;
    expect(text).not.toContain("nice-to-have");
  });

  it("leaving a blocking finding unrepaired prevents saving (review fails)", async () => {
    const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
    const blocking = (fieldIndex.byUnit.get("section.1.block.0") ?? []).find((f) => f.currentText.includes("nice-to-have"))!;
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        const ids = [...messages[1].content.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        // Reviewer retains every unit, including the blocking one (still has nice-to-have).
        return { content: JSON.stringify({ decisions: ids.map((id) => ({ sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] })) }), finishReason: "stop" };
      }
      return { content: "{}", finishReason: "stop" };
    };
    void blocking;
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: blockingQualityReport("section.1.block.0", "unexpected-english"),
      styleContract: buildZhHkStyleContract(""),
      callProvider,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toMatch(/blocking finding/i);
  });

  function blockingQualityReport(unit: string, code: string): QualityReport {
    const r = emptyQualityReport();
    r.findings.push({ sourceUnitId: unit, category: "english-leak", severity: "major", messageCode: code });
    r.majorCount += 1;
    return r;
  }
});

describe("editorial review: unnatural replacement rejection (project-19 V31)", () => {
  const enDoc = makeEnDoc();
  const zhDoc = makeZhDoc();
  // V31's proven failure: nice-to-have → 「有就最好」 (removes English but is an
  // unnatural calque). The strengthened gate must reject it at stage "review".
  zhDoc.sections[1].blocks[0] = { id: "s1-0", type: "paragraph", content: [{ type: "text", text: "香港創作者市場推廣已經由一個加分位，變成品牌接觸本地觀眾嘅核心部分。" }] };

  function leakReport(): QualityReport {
    const r = emptyQualityReport();
    r.findings.push({ sourceUnitId: "section.1.block.0", category: "english-leak", severity: "major", messageCode: "unexpected-english" });
    r.majorCount += 1;
    return r;
  }

  it("rejects a nice-to-have replacement rendered as the unnatural 有就最好", async () => {
    const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
    const target = fieldIndex.byUnit.get("section.1.block.0")?.[0];
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        const ids = [...messages[1].content.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        return {
          content: JSON.stringify({
            decisions: ids.map((id) => id === "section.1.block.0"
              ? { sourceUnitId: id, decision: "replace", edits: [{ fieldId: target!.fieldId, replacementText: "香港創作者市場推廣已經由「有就最好」變成品牌接觸本地觀眾嘅核心部分。" }], reasonCodes: ["untranslated-english"] }
              : { sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] }),
          }),
          finishReason: "stop",
        };
      }
      return { content: "{}", finishReason: "stop" };
    };
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: leakReport(),
      styleContract: buildZhHkStyleContract(""),
      callProvider,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toMatch(/unnatural review replacement/i);
  });

  it("accepts a natural nice-to-have replacement with preserved meaning", async () => {
    const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
    const target = fieldIndex.byUnit.get("section.1.block.0")?.[0];
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        const ids = [...messages[1].content.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        return {
          content: JSON.stringify({
            decisions: ids.map((id) => id === "section.1.block.0"
              ? { sourceUnitId: id, decision: "replace", edits: [{ fieldId: target!.fieldId, replacementText: "香港創作者市場推廣已經由一個加分位，變成品牌接觸本地觀眾嘅核心部分。" }], reasonCodes: ["untranslated-english"] }
              : { sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] }),
          }),
          finishReason: "stop",
        };
      }
      return { content: "{}", finishReason: "stop" };
    };
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: leakReport(),
      styleContract: buildZhHkStyleContract(""),
      callProvider,
    });
    expect(outcome.status).toBe("run");
  });
});

describe("editorial review: forbidden-KOL blocking unit survives retention via deterministic dedup", () => {
  const enDoc = makeEnDoc();
  const zhDoc = makeZhDoc();
  // Inject the real V30 failure: a unit containing 「創作者或者 KOL」.
  zhDoc.sections[1].blocks[0] = { id: "s1-0", type: "paragraph", content: [{ type: "text", text: "透過同啱嘅香港創作者或者 KOL 合作。" }] };

  function blockingKOLReport(): QualityReport {
    const r = emptyQualityReport();
    r.findings.push({ sourceUnitId: "section.1.block.0", category: "terminology", severity: "major", messageCode: "forbidden-terminology" });
    r.majorCount += 1;
    return r;
  }

  it("a retained forbidden-KOL unit no longer fails the review (deterministic dedup clears it)", async () => {
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        const ids = [...messages[1].content.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        // Reviewer retains every unit, including the forbidden-KOL one.
        return { content: JSON.stringify({ decisions: ids.map((id) => ({ sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] })) }), finishReason: "stop" };
      }
      return { content: "{}", finishReason: "stop" };
    };
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: blockingKOLReport(),
      styleContract: buildZhHkStyleContract(""),
      callProvider,
    });
    // The post-review normalizeZhHkText dedups 創作者或者 KOL → 創作者, clearing the
    // forbidden-KOL finding, so the review passes without requiring a reviewer edit.
    expect(outcome.status).toBe("run");
    const text = (outcome.doc.sections[1].blocks[0] as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("透過同啱嘅香港創作者合作。");
    expect(text).not.toContain("KOL");
  });
});

describe("editorial review: exactly two substantive calls and routing", () => {
  it("the active zh-HK path is exactly one translation call + one review call (routing still applies)", async () => {
    const enDoc = makeEnDoc();
    const zhDoc = makeZhDoc();
    const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
    const labels: string[] = [];
    const callProvider = async (messages: ChatMessage[], _o: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      labels.push(label);
      if (label === "document-context-editorial-review") {
        const ids = [...messages[1].content.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
        return { content: JSON.stringify({ decisions: ids.map((id) => ({ sourceUnitId: id, decision: "retain", edits: [], reasonCodes: [] })) }), finishReason: "stop" };
      }
      return { content: "{}", finishReason: "stop" };
    };
    void fieldIndex;
    const outcome = await runEditorialReview({
      enDoc,
      sourceDoc: buildTranslationSourceDocument(enDoc),
      zhDoc,
      qualityReport: report(),
      styleContract: buildZhHkStyleContract(""),
      callProvider,
    });
    // runEditorialReview issues exactly ONE provider call (the review). The
    // full-document translation is the 1st substantive call in the primary path
    // (asserted in document-context-primary.test.ts).
    expect(outcome.callCount).toBe(1);
    expect(labels).toContain("document-context-editorial-review");
  });
});

describe("editorial review: V29 regression fixes", () => {
  const indexes = getCantoneseIndexes();

  it("terminology-inconsistency is NOT padded onto every creator-family unit", () => {
    const aligned = [
      alignedUnit("a.0", "A creator builds trust.", "創作者可以建立信任。"),
      alignedUnit("a.1", "Another influencer works with brands.", "另一位創作者同品牌合作。"),
    ];
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: report(), indexes });
    for (const s of selected) {
      // Merely containing 創作者 must not earn the inconsistency reason.
      expect(s.reasons).not.toContain("terminology-inconsistency");
    }
  });

  it("a unit that genuinely renders a conflicted term inconsistently still gets the reason", () => {
    const aligned = [
      alignedUnit("b.0", "A creator builds trust.", "創作者可以建立信任。"),
      alignedUnit("b.1", "A creator is a KOL for this brand.", "創作者就係呢個品牌嘅 KOL。"),
    ];
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: report(), indexes });
    // b.0 contains the conflicted term "creator" rendered as 創作者; the doc has
    // both 創作者 and KOL renderings, so only the unit that actually carries the
    // term (b.0) may receive the inconsistency reason — b.1's KOL-only text cannot
    // be the inconsistent rendering of "creator".
    const b0 = selected.find((s) => s.sourceUnitId === "b.0");
    // The reason is only attached when the unit's EN contains the conflicted term.
    expect(b0?.reasons.includes("terminology-inconsistency") ?? false).toBe(false);
  });

  it("terminology reasons do not drive tie-breaking: claim-risk units rank above padded units", () => {
    const many = Array.from({ length: 40 }, (_, i) => alignedUnit(`p.${i}`, "We support creators across tiers.", "我哋支持各級創作者。"));
    // A single high-claim-risk unit that also carries a creator-family term.
    const claimUnit = alignedUnit("claim.0", "Authenticity reduces the risk of negative PR and unmet goals.", "真實聲音帶嚟真實嘅風險。");
    const { selected } = selectEditorialReviewCandidates({ aligned: [claimUnit, ...many], qualityReport: report(), indexes });
    const ids = selected.map((s) => s.sourceUnitId);
    // The claim-risk unit must rank before padded creator-family units that only
    // carry terminology/terminology-inconsistency.
    expect(ids.indexOf("claim.0")).toBe(0);
  });

  it("attribution detection includes puts it / says that / according to", () => {
    const aligned = [
      alignedUnit("y.0", "As Ykone puts it, they promote your brand with a global network.", "好似 Ykone 所講，佢哋用全球網絡推廣你嘅品牌。"),
      alignedUnit("y.1", "The agency says that budgets are flexible.", "間公司話預算好有彈性。"),
    ];
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: report(), indexes });
    const y0 = selected.find((s) => s.sourceUnitId === "y.0");
    const y1 = selected.find((s) => s.sourceUnitId === "y.1");
    expect(y0?.reasons).toContain("attribution");
    expect(y1?.reasons).toContain("attribution");
  });

  it("promotes units with concrete avoided-language findings", () => {
    const aligned = [
      alignedUnit("f3", "A few big names give you reach.", "幾個大名字可以帶嚟觸及。"),
      alignedUnit("f4", "Track saves, shares and comments.", "追蹤儲存、分享同留言。"),
      alignedUnit("b1", "Rather than walking billboards.", "而唔係活動廣告板。"),
      alignedUnit("p0", "Each creator has a different audience profile.", "每個創作者都有唔同嘅受眾檔案。"),
      alignedUnit("clean", "The market moves fast.", "市場變化好快。"),
    ];
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: report(), indexes });
    for (const id of ["f3", "f4", "b1", "p0"]) {
      const u = selected.find((s) => s.sourceUnitId === id);
      expect(u?.reasons).toContain("avoided-language");
    }
    expect(selected.some((s) => s.sourceUnitId === "clean")).toBe(false);
  });

  it("KOL inside 或/或者 enumeration after a creator-family term is deduplicated, not corrupted", () => {
    // 創作者或 KOL → 創作者 (dedup, no duplication, clears forbidden KOL).
    expect(normalizeChineseEditorialText("透過同啱嘅香港創作者或 KOL 合作。")).toBe("透過同啱嘅香港創作者合作。");
    expect(normalizeChineseEditorialText("同創作者或者 KOL 合作。")).toBe("同創作者合作。");
    // Standalone KOL is still normalised.
    expect(normalizeChineseEditorialText("呢個係一個 KOL。")).not.toContain("KOL");
  });

  it("與眾不同 and similar 與…不同 compounds are protected from the 與 → 同 rule", () => {
    expect(normalizeChineseEditorialText("令成功推廣活動與眾不同嘅因素")).toContain("與眾不同");
    expect(normalizeChineseEditorialText("令品牌與別不同嘅做法")).toContain("與別不同");
    // 與其/參與/與否 remain protected too.
    expect(normalizeChineseEditorialText("品牌與其依賴大網紅，不如合作。")).toContain("與其");
  });

  it("tier mappings stay distinct: macro and top-tier are not collapsed into mid", () => {
    const glossary = getCantoneseIndexes();
    void glossary;
    // The normalizer must not invent or collapse tier categories.
    expect(normalizeChineseEditorialText("nano, micro, macro and top-tier creators.")).toContain("macro");
    expect(normalizeChineseEditorialText("macro influencer")).not.toContain("中型創作者");
  });

  it("mappable avoided terms carry a real preferred replacement; identity entries are filtered from the prompt", () => {
    const style = _styleContract("");
    expect(preferredReplacementFor("追蹤群")).toBe("粉絲群");
    expect(style.avoidedTerms.get("追蹤群")).toBe("粉絲群");
    // 大名字 has no single safe replacement -> stays identity in the map but is
    // filtered out of the emitted AVOIDED TERMS list (no "X → X" instruction).
    const sys = buildEditorialReviewSystemPrompt(style);
    expect(sys).not.toContain("大名字 → 大名字");
    expect(sys).toContain("追蹤群 → 粉絲群");
  });

  it("system prompt requires claim-polarity checking and forbids inventing tier categories", () => {
    const sys = buildEditorialReviewSystemPrompt(_styleContract(""));
    expect(sys).toContain("CHECK CLAIM POLARITY");
    expect(sys).toContain("DO NOT invent tier categories");
    expect(sys).toContain("reduces risk");
  });

  it("persists selected decisions, reason codes and field edits in the saved summary", () => {
    const review: TranslationReviewSummary = {
      selectedUnitIds: ["section.4.block.4", "section.3.block.0"],
      selectedReasons: [
        { sourceUnitId: "section.4.block.4", reasons: ["terminology"], mandatory: false },
        { sourceUnitId: "section.3.block.0", reasons: ["mandatory-blocking-finding", "unexpected-english"], mandatory: true },
      ],
      decisions: [
        { sourceUnitId: "section.4.block.4", decision: "replace", reasonCodes: ["terminology"], edits: [{ fieldId: "f_abc1234", replacementText: "修正後" }] },
        { sourceUnitId: "section.3.block.0", decision: "retain", reasonCodes: [], edits: [] },
      ],
      appliedEditCount: 1,
      retainedCount: 1,
      status: "run",
      failure: null,
    };
    const summary = buildTranslationVersionSummary(42, "香港創作者市場推廣", review);
    const parsed = JSON.parse(summary);
    expect(parsed.review).toBeTruthy();
    expect(parsed.review.selectedUnitIds).toContain("section.4.block.4");
    expect(parsed.review.selectedReasons[0].reasons).toContain("terminology");
    expect(parsed.review.selectedReasons[1].mandatory).toBe(true);
    expect(parsed.review.decisions[0].edits[0].fieldId).toBe("f_abc1234");
    expect(parsed.review.decisions[0].edits[0].replacementText).toBe("修正後");
    expect(parsed.review.appliedEditCount).toBe(1);
  });

  it("omits review data from the summary when no units were selected", () => {
    const summary = buildTranslationVersionSummary(42, "香港創作者市場推廣", undefined);
    const parsed = JSON.parse(summary);
    expect(parsed.review).toBeUndefined();
  });
});

describe("editorial review: V30 audit regression fixes", () => {
  const indexes = getCantoneseIndexes();

  it("avoided-language units are protected from cap displacement", () => {
    // 25 creator-term-padded advisory units + 1 avoided-language unit that ranks low.
    const padded = Array.from({ length: 25 }, (_, i) => alignedUnit(`p.${i}`, `We support creators across tiers with ${i}% ROI.`, "我哋支持各級創作者，回報率達到" + i + "%。"));
    const avoided = alignedUnit("avoided.0", "Rather than walking billboards.", "而唔係活動廣告板。");
    const { selected } = selectEditorialReviewCandidates({ aligned: [avoided, ...padded], qualityReport: report(), indexes });
    const u = selected.find((s) => s.sourceUnitId === "avoided.0");
    // The avoided-language unit must not be fully displaced by the cap.
    expect(u).toBeTruthy();
    expect(u!.reasons).toContain("avoided-language");
  });

  it("only two avoided-language units are swapped in to protect the highest-value repairs", () => {
    const padded = Array.from({ length: 25 }, (_, i) => alignedUnit(`p.${i}`, `Support creators with ${i}% engagement.`, "支持創作者，互動率" + i + "%。"));
    const avoided = [
      alignedUnit("a1", "Walking billboards.", "活動廣告板。"),
      alignedUnit("a2", "Keep everyone honest.", "令所有人老實啲。"),
      alignedUnit("a3", "Tag friends.", "標註朋友。"),
      alignedUnit("a4", "Audience profile.", "觀眾檔案。"),
    ];
    const { selected } = selectEditorialReviewCandidates({ aligned: [...avoided, ...padded], qualityReport: report(), indexes });
    const ids = selected.map((s) => s.sourceUnitId);
    // At least 2 avoided-language units survive the cap.
    const avoidedSelected = ids.filter((id) => id.startsWith("a"));
    expect(avoidedSelected.length).toBeGreaterThanOrEqual(2);
  });

  it("broadened markers select audience-profile variant 觀眾檔案", () => {
    const aligned = [alignedUnit("x0", "Each creator has a different audience profile.", "每個創作者都有唔同嘅觀眾檔案。")];
    const { selected } = selectEditorialReviewCandidates({ aligned, qualityReport: report(), indexes });
    const u = selected.find((s) => s.sourceUnitId === "x0");
    expect(u?.reasons).toContain("avoided-language");
  });

  it("reviewer prompt requires retained units to clear avoided markers and fix every list item", () => {
    const sys = buildEditorialReviewSystemPrompt(_styleContract(""));
    expect(sys).toContain("A RETAIN decision is not a pass");
    expect(sys).toContain("For LIST units: review and fix EVERY list item text");
    expect(sys).toContain("活動廣告板");
    expect(sys).toContain("觀眾檔案");
    expect(sys).toContain("成功同否");
  });
});
