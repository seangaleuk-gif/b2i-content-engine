import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { InlineContent, EditorialBlock } from "@/lib/blog/article-content";
import { buildTranslationSourceDocument } from "./translation-source-document";
import { buildFullDocumentChunk } from "./document-context-translation-shadow";
import { validateStructuredChunkResponse, type TranslationChunk, type TranslatedUnitResult } from "./translation-chunk-planner";

function t(text: string): InlineContent {
  return { type: "text", text };
}
function link(text: string, href: string): InlineContent {
  return { type: "link", text, href };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Guide Title", slug: "guide", metaDescription: "Meta description.", excerpt: "Excerpt.", targetWordCount: 100, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      blocks: [
        { id: "b0", type: "paragraph", content: [t("Intro body.")] },
        { id: "b1", type: "paragraph", content: [t("來源："), link("Source Name", "https://example.com/ref"), t("。")] },
      ],
      status: "generated",
    },
    sections: [
      {
        id: "s0", heading: "Section One", headingLevel: 2, sectionType: "main",
        blocks: [{ id: "s0-0", type: "list", ordered: false, items: [[t("Item A")], [t("Item B")]] }],
        status: "generated",
      },
      {
        id: "s1", heading: "Section Two", headingLevel: 2, sectionType: "main",
        blocks: [{ id: "s1-0", type: "table", headers: [[t("H1")], [t("H2")]], rows: [[[t("a")], [t("b")]]] }],
        status: "generated",
      },
    ],
    conclusion: { id: "conc", blocks: [{ id: "c0", type: "paragraph", content: [t("Conclusion.")] }], status: "generated" },
    visibleFaq: [{ question: "A question?", answerHtml: '<p>Answer with <a href="https://example.com/x">link</a>.</p>', answerText: "Answer with link." }],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function mirrorResponse(chunk: TranslationChunk): TranslatedUnitResult[] {
  return chunk.units.map((raw) => {
    const u = raw as unknown as { sourceId: string; text?: string; block?: EditorialBlock; answerHtml?: string; answerText?: string };
    if (u.block) return { sourceUnitId: u.sourceId, block: structuredClone(u.block) };
    if (u.answerHtml !== undefined) return { sourceUnitId: u.sourceId, answerHtml: u.answerHtml, answerText: u.answerText ?? "" };
    return { sourceUnitId: u.sourceId, text: u.text ?? "" };
  });
}

function unitResult(validation: ReturnType<typeof validateStructuredChunkResponse>, id: string) {
  const unit = validation.units.find((u) => u.sourceUnitId === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit;
}

const chunk = buildFullDocumentChunk(buildTranslationSourceDocument(makeEnDoc()));

describe("structure parity: paragraph, list, table, heading, FAQ", () => {
  it("an exact structural mirror passes for every unit type", () => {
    const validation = validateStructuredChunkResponse(chunk, { units: mirrorResponse(chunk) });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("paragraph: dropping an inline link node fails structure parity with expected/returned diagnostics", () => {
    const units = mirrorResponse(chunk);
    const target = units.find((u) => u.sourceUnitId === "introduction.block.1")!;
    target.block = { id: "b1", type: "paragraph", content: [t("來源：Source Name。")] };
    const validation = validateStructuredChunkResponse(chunk, { units });
    const result = unitResult(validation, "introduction.block.1");
    expect(result.valid).toBe(false);
    expect(result.structureParity.changed).toBe(true);
    expect(result.structureParity.expected).toContain("link:https://example.com/ref");
    expect(result.categories).toContain("structure parity");
    const warning = result.warnings.find((w) => w.includes("block structure changed"));
    expect(warning).toBeDefined();
    expect(warning).toContain("expected=");
    expect(warning).toContain("returned=");
  });

  it("paragraph must not become a list (retype fails structure parity)", () => {
    const units = mirrorResponse(chunk);
    const target = units.find((u) => u.sourceUnitId === "introduction.block.0")!;
    target.block = { id: "b0", type: "list", ordered: false, items: [[t("Intro body.")]] };
    const validation = validateStructuredChunkResponse(chunk, { units });
    const result = unitResult(validation, "introduction.block.0");
    expect(result.valid).toBe(false);
    expect(result.structureParity.changed).toBe(true);
    expect(result.structureParity.expected).toContain("paragraph[");
    expect(result.structureParity.returned).toContain("list:");
  });

  it("list: item count change fails structure parity", () => {
    const units = mirrorResponse(chunk);
    const target = units.find((u) => u.sourceUnitId === "section.0.block.0")!;
    const src = chunk.units.find((u) => u.sourceId === "section.0.block.0") as unknown as { block: { items: InlineContent[][] } };
    target.block = { id: "s0-0", type: "list", ordered: false, items: [structuredClone(src.block.items[0])] };
    const validation = validateStructuredChunkResponse(chunk, { units });
    const result = unitResult(validation, "section.0.block.0");
    expect(result.valid).toBe(false);
    expect(result.structureParity.changed).toBe(true);
    expect(result.structureParity.expected).toContain("list:false:2");
    expect(result.structureParity.returned).toContain("list:false:1");
  });

  it("table: header dimension change fails structure parity", () => {
    const units = mirrorResponse(chunk);
    const target = units.find((u) => u.sourceUnitId === "section.1.block.0")!;
    target.block = { id: "s1-0", type: "table", headers: [[t("H1")]], rows: [[[t("a")], [t("b")]]] };
    const validation = validateStructuredChunkResponse(chunk, { units });
    const result = unitResult(validation, "section.1.block.0");
    expect(result.valid).toBe(false);
    expect(result.structureParity.changed).toBe(true);
    expect(result.structureParity.expected).toContain("table:2:1");
    expect(result.structureParity.returned).toContain("table:1:1");
  });

  it("heading: changing heading text is valid (no block structure signature)", () => {
    const units = mirrorResponse(chunk);
    const target = units.find((u) => u.sourceUnitId === "section.0.heading")!;
    target.text = "第一節";
    const validation = validateStructuredChunkResponse(chunk, { units });
    expect(unitResult(validation, "section.0.heading").valid).toBe(true);
    expect(validation.valid).toBe(true);
  });

  it("FAQ: an answer that loses its link fails URL parity", () => {
    const units = mirrorResponse(chunk);
    const target = units.find((u) => u.sourceUnitId === "faq.0.answer")!;
    target.answerHtml = "<p>Answer without link.</p>";
    const validation = validateStructuredChunkResponse(chunk, { units });
    const result = unitResult(validation, "faq.0.answer");
    expect(result.valid).toBe(false);
    expect(result.categories).toContain("URL parity");
  });
});
