import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { renderArticleDocument, parseArticleDocumentFromHtml } from "@/lib/blog/article-document";
import { insertExternalResearchLinksIntoDocument } from "@/lib/services/article-postprocessors";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";

const KEYPHRASE = "threads marketing hong kong";

function paragraph(id: string, content: Array<{ type: "text" | "link" | "strong" | "emphasis"; text: string; href?: string }>): Extract<EditorialBlock, { type: "paragraph" }> {
  return { id, type: "paragraph", content: content as Extract<EditorialBlock, { type: "paragraph" }>["content"] };
}

function buildDoc(): ArticleDocument {
  const visibleFaq = [
    { question: "What is the first step?", answerHtml: "", answerText: "Start with a small and useful routine for the whole team." },
    { question: "How often should teams post?", answerHtml: "", answerText: "A steady weekly plan keeps the work manageable for everyone." },
  ];
  return {
    metadata: { title: "Threads Marketing Hong Kong Guide", slug: "threads-guide", metaDescription: "A practical guide.", excerpt: "Guide", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: "ls",
    },
    introduction: { id: "intro", status: "generated", blocks: [paragraph("intro-0", [{ type: "text", text: "This guide explains how local brands can use the platform." }])] },
    sections: [
      {
        id: "section-0",
        heading: "Common Questions for Local Teams",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph("section-0-wp-0", [{ type: "text", text: "Local teams can share useful lessons from daily work with clear and honest words." }]),
          paragraph("section-0-wp-1", [
            { type: "text", text: "Owners can note common questions and turn those questions into helpful future posts. Read the " },
            { type: "strong", text: "full" },
            { type: "text", text: " " },
            { type: "emphasis", text: "guide" },
            { type: "text", text: " " },
            { type: "link", text: "here", href: "/blog/threads-guide" },
            { type: "text", text: " before you start." },
          ]),
          paragraph("section-0-wp-2", [{ type: "text", text: "Regular replies also show customers that a real person is listening to their needs." }]),
        ],
      },
      {
        id: "section-1",
        heading: "Build a Simple Weekly Content Routine",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph("section-1-wp-0", [{ type: "text", text: "A small weekly plan keeps the work steady without adding stress to the whole team." }]),
          paragraph("section-1-wp-1", [{ type: "text", text: "Simple examples help busy owners understand the idea and take a practical next step." }]),
        ],
      },
      { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", status: "generated", blocks: [] },
    ],
    visibleFaq,
    conclusion: { id: "conclusion", status: "generated", blocks: [paragraph("c-0", [{ type: "text", text: `A useful ${KEYPHRASE} plan does not need a large team.` }])] },
    cta: {
      id: "cta",
      type: "cta",
      html: `<!-- wp:html --><div class="cta-block"><h2>Ready to Start?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->`,
      fingerprint: "cta",
    },
    faqSchema: null,
    insertedLinks: [],
  };
}

const SOURCES = [
  { url: "https://example.com/common-questions", title: "Common Questions Guide", snippet: "Owners can note common questions and turn those questions into helpful future posts." },
  { url: "https://example.org/routines", title: "Weekly Routine Insights", snippet: "A small weekly plan keeps the work steady without adding stress to the whole team." },
];

function collectBlocks(doc: ArticleDocument): Array<{ componentId: string; block: EditorialBlock }> {
  const all: Array<{ componentId: string; block: EditorialBlock }> = [];
  for (const block of doc.introduction.blocks) all.push({ componentId: "intro", block });
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;
    for (const block of section.blocks) all.push({ componentId: section.id, block });
  }
  for (const block of doc.conclusion.blocks) all.push({ componentId: "conclusion", block });
  return all;
}

function editorialText(block: EditorialBlock): string {
  if ("content" in block) return block.content.map((node) => node.text).join("");
  if (block.type === "list") return block.items.map((item) => item.map((node) => node.text).join("")).join(" ");
  if (block.type === "table") return [block.headers, ...block.rows].flat(2).map((node) => node.text).join(" ");
  return "";
}

describe("canonical external-link producer: text-preserving by invariant", () => {
  it("adds citation blocks only; every pre-existing editorial character is unchanged", () => {
    const doc = buildDoc();
    const beforeBlocks = collectBlocks(doc).map(({ componentId, block }) => ({
      componentId,
      id: block.id,
      text: editorialText(block),
    }));
    const beforeRender = renderArticleDocument(doc);

    const result = insertExternalResearchLinksIntoDocument(doc, SOURCES, 6);
    expect(result.insertedLinks).toBe(2);

    // Exact round-trip: every pre-existing block is present, in the same
    // relative order, with byte-identical text and unchanged ids.
    const afterBlocks = collectBlocks(doc);
    const existingBeforeIds = beforeBlocks.map((b) => b.id);
    expect(afterBlocks.map(({ block }) => block.id).filter((id) => !String(id).includes("external-citation"))).toEqual(
      existingBeforeIds,
    );
    for (const { componentId, id, text } of beforeBlocks) {
      const match = afterBlocks.find((entry) => entry.block.id === id);
      expect(match).toBeDefined();
      expect(match!.componentId).toBe(componentId);
      expect(editorialText(match!.block)).toBe(text);
    }

    // The only additions are the citation blocks.
    const citations = afterBlocks.filter(({ block }) => String(block.id).includes("external-citation"));
    expect(citations.length).toBe(2);
    for (const { block } of citations) {
      const text = editorialText(block);
      expect(text.startsWith("Source: ")).toBe(true);
      expect(text.endsWith(".")).toBe(true);
    }

    // The inline link/strong/emphasis nodes in section-0-wp-1 are byte-identical.
    const wp1 = afterBlocks.find(({ block }) => block.id === "section-0-wp-1")!.block;
    expect(editorialText(wp1)).toBe(beforeBlocks.find((b) => b.id === "section-0-wp-1")!.text);
    expect(renderArticleDocument(doc)).toContain("<strong>full</strong>");
    expect(renderArticleDocument(doc)).toContain("<em>guide</em>");
    expect(renderArticleDocument(doc)).toContain("/blog/threads-guide");
    // Rendering the updated doc only grew the article (citations added).
    expect(renderArticleDocument(doc).length).toBeGreaterThan(beforeRender.length);
  });

  it("one citation per section and per URL, no consecutive citations", () => {
    const doc = buildDoc();
    const result = insertExternalResearchLinksIntoDocument(doc, SOURCES, 6);
    expect(result.insertedLinks).toBe(2);
    const citationCountBySection: Record<string, number> = {};
    for (const section of doc.sections) {
      citationCountBySection[section.id] = section.blocks.filter((b) => String(b.id).includes("external-citation")).length;
    }
    expect(citationCountBySection["section-0"]).toBe(1);
    expect(citationCountBySection["section-1"]).toBe(1);
    // No two citations are consecutive in any component.
    for (const section of doc.sections) {
      for (let i = 1; i < section.blocks.length; i++) {
        const prev = String(section.blocks[i - 1].id).includes("external-citation");
        const curr = String(section.blocks[i].id).includes("external-citation");
        expect(prev && curr).toBe(false);
      }
    }
  });

  it("never touches a block whose text contains a legacy inline WordPress comment (the production shape)", () => {
    const doc = buildDoc();
    doc.sections[0].blocks.push(
      paragraph("section-0-wp-9", [
        { type: "text", text: "Owners can note common questions and turn those questions into helpful future posts <!-- /wp:paragraph --> before planning the next routine." },
      ]),
    );
    const beforeText = editorialText(doc.sections[0].blocks.find((b) => b.id === "section-0-wp-9")!);
    const malformedBefore = JSON.stringify(scanMalformedProseInDocument(doc));
    const sqBefore = JSON.stringify(scanSentenceQualityInDocument(doc));

    const result = insertExternalResearchLinksIntoDocument(doc, SOURCES, 6);
    expect(result.insertedLinks).toBeGreaterThan(0);

    // The legacy-comment block is byte-identical (never split, never altered).
    const after = doc.sections[0].blocks.find((b) => b.id === "section-0-wp-9");
    expect(after).toBeDefined();
    expect(editorialText(after!)).toBe(beforeText);
    // The insertion introduces NO new quality findings — the finding set is
    // identical before and after (the pre-existing comment text is not the
    // producer's doing and is untouched).
    expect(JSON.stringify(scanMalformedProseInDocument(doc))).toBe(malformedBefore);
    expect(JSON.stringify(scanSentenceQualityInDocument(doc))).toBe(sqBefore);
    // The rendered article escapes the comment and the citation blocks parse.
    const render = renderArticleDocument(doc);
    expect(render).toContain("&lt;!-- /wp:paragraph --&gt;");
    expect(render).toContain("Source:");
  });

  it("multiple citations with offset shifts preserve existing block order and ids in every section", () => {
    const doc = buildDoc();
    // Two paragraphs in section-0 with similar text so the anchor selection is
    // not trivially unique; a source also matches section-1.
    const beforeOrder0 = doc.sections[0].blocks.map((b) => b.id);
    const beforeOrder1 = doc.sections[1].blocks.map((b) => b.id);

    const result = insertExternalResearchLinksIntoDocument(doc, [
      { url: "https://example.com/q1", title: "Questions One", snippet: "Owners can note common questions and turn those questions into helpful future posts." },
      { url: "https://example.com/q2", title: "Questions Two", snippet: "Regular replies also show customers that a real person is listening to their needs." },
      { url: "https://example.org/plan", title: "Weekly Plan", snippet: "A small weekly plan keeps the work steady without adding stress to the whole team." },
    ], 6);
    expect(result.insertedLinks).toBeGreaterThanOrEqual(2);

    const order0 = doc.sections[0].blocks.map((b) => b.id);
    const order1 = doc.sections[1].blocks.map((b) => b.id);
    // Existing blocks keep their relative order (citations interleaved).
    expect(order0.filter((id) => !String(id).includes("external-citation"))).toEqual(beforeOrder0);
    expect(order1.filter((id) => !String(id).includes("external-citation"))).toEqual(beforeOrder1);
    // The canonical model mutation kept the original ids of every existing block.
    for (const id of beforeOrder0) expect(order0).toContain(id);
    for (const id of beforeOrder1) expect(order1).toContain(id);
  });

  it("the pipeline stage round-trips the model insertion through parse-back without corruption", () => {
    const doc = buildDoc();
    const result = insertExternalResearchLinksIntoDocument(doc, SOURCES, 6);
    expect(result.insertedLinks).toBe(2);
    const blog = renderArticleDocument(doc);
    // The round-trip back to the canonical model keeps every existing block
    // and produces no malformed prose or residue.
    const parsed = parseArticleDocumentFromHtml(blog, doc);
    expect(parsed.doc).not.toBeNull();
    expect(scanMalformedProseInDocument(parsed.doc!)).toEqual([]);
    expect(scanSentenceQualityInDocument(parsed.doc!)).toEqual([]);
    const citations = parsed.doc!.sections.flatMap((s) => s.blocks).filter((b) => editorialText(b).startsWith("Source: "));
    expect(citations.length).toBe(2);
  });
});
