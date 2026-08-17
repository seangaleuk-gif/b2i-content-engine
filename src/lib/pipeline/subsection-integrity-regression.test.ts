import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { compressDocumentStructureAware, validateCoherence } from "@/lib/blog/coherence";
import { renderArticleDocument } from "@/lib/blog/article-document";

const KP = "hong kong marketing trends 2026";
const RESEARCH: Array<{ title?: string; snippet?: string; url?: string }> = [];

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}
function subheading(id: string, text: string): EditorialBlock {
  return { id, type: "subheading", level: 3, content: [{ type: "text", text }] };
}
function list(id: string, items: string[]): EditorialBlock {
  return { id, type: "list", ordered: false, items: items.map((text) => [{ type: "text", text }]) };
}
function tableBlock(id: string): EditorialBlock {
  return { id, type: "table", headers: [[{ type: "text", text: "Metric" }]], rows: [[[{ type: "text", text: "Engagement" }]]] };
}
function quote(id: string, text: string): EditorialBlock {
  return { id, type: "quote", content: [{ type: "text", text }] };
}

function makeDoc(blocks: EditorialBlock[]): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: KP },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{
      id: "section-1",
      heading: "Picking the Right Community Platform",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks,
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function emptySubsectionIds(doc: ArticleDocument): string[] {
  return validateCoherence(doc)
    .filter((v) => v.type === "empty-subsection")
    .map((v) => v.blockId ?? "");
}

describe("subsection integrity: final trim never orphans an H3", () => {
  it("removing the only paragraph beneath an H3 is rejected/skipped", () => {
    const OPEN = "Local community managers start by choosing a platform that matches their audience size and goals.";
    const doc = makeDoc([
      paragraph("opener", OPEN),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "Your community can live on WhatsApp without a formal page."),
      subheading("h3-b", "Tailor Content to Local Culture"),
      paragraph("p-b", "If they prefer Facebook, a private group usually feels more personal."),
    ]);
    const total = countWords(doc);
    // Force enough removal that the only candidates are the H3 body paragraphs.
    compressDocumentStructureAware(doc, total - 10, 1, KP, RESEARCH);
    expect(emptySubsectionIds(doc)).toEqual([]);
    // Neither H3 body paragraph was removed (each is the last substantive body).
    const texts = doc.sections[0].blocks.map((b) => (b.type === "paragraph" ? plain(b) : "")).join(" ");
    expect(texts).toContain("Your community can live on WhatsApp");
    expect(texts).toContain("If they prefer Facebook");
  });

  it("removing one of multiple body paragraphs is allowed when substantive content remains", () => {
    const doc = makeDoc([
      paragraph("opener", "A long opener paragraph with enough words to keep the section above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a1", "Your community can live on WhatsApp without a formal page."),
      paragraph("p-a2", "A smaller group often keeps conversations closer and more genuine."),
      paragraph("p-a3", "Members feel more comfortable sharing when the room feels safe."),
    ]);
    const total = countWords(doc);
    compressDocumentStructureAware(doc, total - 10, 1, KP, RESEARCH);
    expect(emptySubsectionIds(doc)).toEqual([]);
    const pCount = doc.sections[0].blocks.filter((b) => b.id && /^p-a/.test(b.id)).length;
    expect(pCount).toBeGreaterThanOrEqual(2);
  });

  it("a list beneath an H3 counts as body", () => {
    const doc = makeDoc([
      paragraph("opener", "A long opener paragraph with enough words to keep the section above the minimum threshold for trimming."),
      subheading("h3-a", "Choose the Right Space"),
      list("list-a", ["WhatsApp", "Facebook groups", "Discord servers"]),
    ]);
    expect(emptySubsectionIds(doc)).toEqual([]);
  });

  it("a table and a quote beneath an H3 count as body", () => {
    const doc = makeDoc([
      paragraph("opener", "A long opener paragraph with enough words to keep the section above the minimum threshold for trimming."),
      subheading("h3-a", "Measure What Matters"),
      tableBlock("table-a"),
      quote("quote-a", "Consistent replies build genuine trust with your community."),
    ]);
    expect(emptySubsectionIds(doc)).toEqual([]);
  });

  it("a Source attribution paragraph alone does not make an H3 valid", () => {
    const doc = makeDoc([
      subheading("h3-a", "Choose the Right Space"),
      paragraph("src-a", "Source: Research from the community management guide."),
    ]);
    expect(emptySubsectionIds(doc)).toContain("h3-a");
  });

  it("consecutive H3 headings with no body are detected", () => {
    const doc = makeDoc([
      subheading("h3-a", "Choose the Right Space"),
      subheading("h3-b", "Tailor Content to Local Culture"),
      subheading("h3-c", "Start with a Small, Engaged Group"),
    ]);
    const empty = emptySubsectionIds(doc);
    expect(empty).toContain("h3-a");
    expect(empty).toContain("h3-b");
    expect(empty).toContain("h3-c");
  });

  it("removing an entire subsection structurally removes heading and owned content (no empty H3 remains)", () => {
    const doc = makeDoc([
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "Your community can live on WhatsApp without a formal page."),
      subheading("h3-b", "Tailor Content to Local Culture"),
      paragraph("p-b", "If they prefer Facebook, a private group usually feels more personal."),
    ]);
    // Intentionally remove the whole first subsection: H3 + its body together.
    doc.sections[0].blocks = doc.sections[0].blocks.filter((b) => b.id !== "h3-a" && b.id !== "p-a");
    // h3-b still owns its body (p-b), so no empty subsection remains.
    expect(emptySubsectionIds(doc)).toEqual([]);
  });

  it("the exact production-shaped section cannot exit final-trim with empty H3s", () => {
    const OPEN = "A long opening paragraph that introduces the community platform decision with enough words for trimming.";
    const doc = makeDoc([
      paragraph("opener", OPEN),
      subheading("h3-a", "Choose the Right Space"),
      paragraph("p-a", "Your community can live on WhatsApp without a formal page."),
      subheading("h3-b", "Tailor Content to Local Culture"),
      paragraph("p-b", "If they prefer Facebook, a private group usually feels more personal."),
      subheading("h3-c", "Start with a Small, Engaged Group"),
      paragraph("p-c", "A smaller room keeps the conversations closer and more genuine."),
      subheading("h3-d", "Use Smart Tools to Keep Momentum"),
      paragraph("p-d", "A simple schedule reminds owners to reply and post at a steady pace."),
    ]);
    const total = countWords(doc);
    compressDocumentStructureAware(doc, Math.max(1, total - 15), 1, KP, RESEARCH);
    // No H3 is left empty; the four subsections still own their body.
    expect(emptySubsectionIds(doc)).toEqual([]);
    const headings = doc.sections[0].blocks.filter((b) => b.type === "subheading");
    expect(headings).toHaveLength(4);
  });
});

describe("subsection integrity: absolute validation catches empty H3s", () => {
  it("final QC (validateCoherence) reports an empty H3 that reaches it", () => {
    const doc = makeDoc([
      subheading("h3-a", "Choose the Right Space"),
      subheading("h3-b", "Tailor Content to Local Culture"),
    ]);
    expect(validateCoherence(doc).some((v) => v.type === "empty-subsection")).toBe(true);
  });

  it("a rendered document with empty H3s is still balanced (only semantic violation)", () => {
    const doc = makeDoc([
      subheading("h3-a", "Choose the Right Space"),
    ]);
    expect(emptySubsectionIds(doc)).toContain("h3-a");
    expect(renderArticleDocument(doc)).toContain("Choose the Right Space");
  });
});

function plain(block: EditorialBlock): string {
  return (block.type === "paragraph" ? block.content.map((n) => n.text).join("") : "").trim();
}
function countWords(doc: ArticleDocument): number {
  return renderArticleDocument(doc).replace(/<[^>]+>/g, " ").replace(/<!--[\s\S]*?-->/g, " ").split(/\s+/).filter(Boolean).length;
}
