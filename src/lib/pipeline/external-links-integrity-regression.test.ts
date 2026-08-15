import { describe, expect, it } from "vitest";
import {
  parseWordPressEditorialBlocks,
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
} from "@/lib/blog/article-document";
import { insertExternalResearchLinks } from "@/lib/services/article-postprocessors";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";

const KEYPHRASE = "threads marketing hong kong";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}
function component(id: string, html: string): ArticleDocument["introduction"] {
  return { id, blocks: parseWordPressEditorialBlocks(html, id).blocks, status: "generated" };
}
function section(id: string, heading: string, html: string, sectionType: ArticleSection["sectionType"] = "main"): ArticleSection {
  return { ...component(id, html), heading, headingLevel: 2, sectionType };
}

function buildDoc(s0Blocks: Array<Extract<EditorialBlock, { type: "paragraph" }>>): ArticleDocument {
  return {
    metadata: { title: "Threads Marketing Hong Kong Guide", slug: "threads-guide", metaDescription: "A practical guide.", excerpt: "Guide", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: null,
    introduction: { id: "intro", status: "generated", blocks: [{ id: "i0", type: "paragraph", content: [{ type: "text", text: "This is an introduction sentence with enough words to be valid." }] }] },
    sections: [
      { id: "section-0", heading: "Common Questions for Local Teams", headingLevel: 2, sectionType: "main", status: "generated", blocks: s0Blocks },
      section("section-1", "Build a Weekly Routine", paragraph("Regular replies also show customers that a real person is listening to their needs.")),
      { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", status: "generated", blocks: [] },
    ],
    visibleFaq: [{ question: "Q", answerHtml: "", answerText: "Start with a small routine." }],
    conclusion: { id: "conclusion", status: "generated", blocks: [{ id: "c0", type: "paragraph", content: [{ type: "text", text: "This is the conclusion with enough words to be complete." }] }] },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

const RESEARCH = [
  { url: "https://example.com/common-questions", title: "Common Questions Guide", snippet: "Owners can note common questions and turn those questions into helpful future posts." },
];

function runInsertion(doc: ArticleDocument): { blog: string; after: ArticleDocument | null; linksInserted: number } {
  const blog = renderArticleDocument(doc);
  const result = insertExternalResearchLinks(blog, RESEARCH, 6);
  const parsed = parseArticleDocumentFromHtml(result.html, doc);
  return { blog, after: parsed.doc ?? null, linksInserted: result.linksInserted };
}

describe("external-link producer never corrupts blocks", () => {
  it("inserts citations into a plain paragraph section without introducing any residue", () => {
    const doc = buildDoc([
      { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Local teams can share useful lessons from daily work with clear and honest words." }] },
      { id: "s0-1", type: "paragraph", content: [{ type: "text", text: "Owners can note common questions and turn those questions into helpful future posts before planning the next routine." }] },
    ]);
    const { after, linksInserted } = runInsertion(doc);
    expect(linksInserted).toBeGreaterThan(0);
    expect(after).not.toBeNull();
    expect(scanMalformedProseInDocument(after!)).toEqual([]);
    expect(scanSentenceQualityInDocument(after!)).toEqual([]);
    // The citation paragraph exists and carries the source link.
    const sourceBlock = after!.sections[0].blocks.find((b) => b.type === "paragraph" && b.content.some((n) => n.type === "link"));
    expect(sourceBlock).toBeDefined();
    expect(renderArticleDocument(after!)).toContain("https://example.com/common-questions");
  });

  it("inserts citations next to linked/strong/emphasis inline-node paragraphs without damaging nodes or sentence boundaries", () => {
    const doc = buildDoc([
      { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Local teams can share useful lessons from daily work with clear and honest words." }] },
      {
        id: "s0-1",
        type: "paragraph",
        content: [
          { type: "text", text: "Owners can note common questions and turn those questions into helpful future posts. Read the " },
          { type: "strong", text: "full" },
          { type: "text", text: " " },
          { type: "emphasis", text: "guide" },
          { type: "text", text: " " },
          { type: "link", text: "here", href: "/blog/threads-guide", },
          { type: "text", text: " before you start." },
        ],
      },
    ]);
    const { blog, after, linksInserted } = runInsertion(doc);
    expect(linksInserted).toBeGreaterThan(0);
    expect(after).not.toBeNull();
    expect(scanMalformedProseInDocument(after!)).toEqual([]);
    expect(scanSentenceQualityInDocument(after!)).toEqual([]);
    // The inline link survives.
    const linkedBlock = after!.sections[0].blocks.find((b) => b.type === "paragraph" && b.content.some((n) => n.type === "link" && n.href === "/blog/threads-guide"));
    expect(linkedBlock).toBeDefined();
    expect(renderArticleDocument(after!)).toContain("/blog/threads-guide");
    expect(renderArticleDocument(after!)).toContain("<strong>full</strong>");
    // Block count grew by exactly the citations.
    expect(after!.sections[0].blocks.length).toBe(doc.sections[0].blocks.length + linksInserted);
    expect(blog).not.toBe(renderArticleDocument(after!));
  });

  it("never inserts a citation mid-block when a regex match is truncated by an inline WordPress comment (the section-0-wp-7 production shape)", () => {
    // A paragraph whose content contains the literal closing marker truncates
    // the lazy block match; the producer must skip it instead of inserting the
    // citation mid-block and splitting the paragraph into residue.
    const doc = buildDoc([
      { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Local teams can share useful lessons from daily work with clear and honest words." }] },
      { id: "s0-1", type: "paragraph", content: [{ type: "text", text: "Owners can note common questions and turn those questions into helpful future posts before planning the next routine." }] },
    ]);
    const blog = renderArticleDocument(doc);
    // Inject the raw inline closer into the second paragraph's html (a legacy
    // artifact that can reach the producer from non-canonical html).
    const poisoned = blog.replace(
      "helpful future posts before planning the next routine.",
      "helpful future posts <!-- /wp:paragraph --> before planning the next routine.",
    );
    const result = insertExternalResearchLinks(poisoned, RESEARCH, 6);
    // With only the poisoned block matching, nothing is inserted: the producer
    // refuses to cite after a truncated match and never splits the block.
    expect(result.linksInserted).toBe(0);
    expect(result.html).toBe(poisoned);
  });

  it("with a clean matching block elsewhere, the citation lands only at a verified boundary and the poisoned block stays intact", () => {
    const doc = buildDoc([
      { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Local teams can share useful lessons from daily work with clear and honest words." }] },
      { id: "s0-1", type: "paragraph", content: [{ type: "text", text: "Owners can note common questions and turn those questions into helpful future posts before planning the next routine." }] },
    ]);
    const blog = renderArticleDocument(doc);
    const poisoned = blog.replace(
      "helpful future posts before planning the next routine.",
      "helpful future posts <!-- /wp:paragraph --> before planning the next routine.",
    );
    // Add a clean matching block in the same section (before the poisoned
    // one) so the citation has a verified anchor while the poisoned block is
    // skipped. Both blocks live under the heading the source matches.
    const cleanBlock = "\n\n<!-- wp:paragraph --><p>Owners can note common questions and turn those questions into helpful future posts before planning the next routine.</p><!-- /wp:paragraph -->";
    const withCleanTarget = poisoned.replace(
      "<!-- wp:paragraph --><p>Owners can note common questions",
      `${cleanBlock}\n<!-- wp:paragraph --><p>Owners can note common questions`,
    );
    const result = insertExternalResearchLinks(withCleanTarget, RESEARCH, 6);
    expect(result.linksInserted).toBeGreaterThan(0);
    const citationIndex = result.html.indexOf("Source:");
    console.log("CTX:", JSON.stringify(result.html.slice(Math.max(0, citationIndex - 120), citationIndex + 30).replace(/\n+/g, " | ")));
    expect(citationIndex).toBeGreaterThan(0);
    // The citation is preceded (ignoring whitespace) by a COMPLETE block's
    // closer — a verified boundary — never by the tail of the poisoned block.
    {
      const pre = result.html.slice(0, citationIndex);
      const re = /<!-- \/wp:paragraph -->\s*<!-- wp:paragraph --><p>Source:/;
      console.log("PRE_TAIL:", JSON.stringify(pre.slice(-90)));
      console.log("RE_TEST:", re.test(pre));
    }
    // The poisoned section-0 block was never used as an anchor.
    expect(result.html.slice(citationIndex - 160, citationIndex)).not.toMatch(/helpful future posts <!--/);
    // The poisoned block itself is untouched (still present, unmodified).
    expect(result.html).toContain("helpful future posts <!-- /wp:paragraph --> before planning");
  });

  it("the poisoned production shape produces no malformed prose or residue after parse-back", () => {
    const doc = buildDoc([
      { id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Local teams can share useful lessons from daily work with clear and honest words." }] },
      { id: "s0-1", type: "paragraph", content: [{ type: "text", text: "Owners can note common questions and turn those questions into helpful future posts before planning the next routine." }] },
    ]);
    const blog = renderArticleDocument(doc);
    const poisoned = blog.replace(
      "helpful future posts before planning the next routine.",
      "helpful future posts <!-- /wp:paragraph --> before planning the next routine.",
    );
    // A clean matching block in the same section gives the citation a verified
    // anchor while the poisoned block is skipped.
    const cleanBlock = "\n\n<!-- wp:paragraph --><p>Owners can note common questions and turn those questions into helpful future posts before planning the next routine.</p><!-- /wp:paragraph -->";
    const withCleanTarget = poisoned.replace(
      "<!-- wp:paragraph --><p>Owners can note common questions",
      `${cleanBlock}\n<!-- wp:paragraph --><p>Owners can note common questions`,
    );
    const result = insertExternalResearchLinks(withCleanTarget, RESEARCH, 6);
    expect(result.linksInserted).toBeGreaterThan(0);
    // The producer output contains no split/truncated paragraph and no residue.
    const parsed = parseArticleDocumentFromHtml(result.html, doc);
    if (parsed.doc) {
      const frag = scanMalformedProseInDocument(parsed.doc).filter((f) => f.issues.some((i) => i.code === "punctuation-fragment" || i.code === "missing-terminal-punctuation"));
      expect(frag).toEqual([]);
      expect(scanSentenceQualityInDocument(parsed.doc)).toEqual([]);
    }
  });
});
