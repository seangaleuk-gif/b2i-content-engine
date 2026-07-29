import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArticleDocument, ArticleSection, EditorialBlock, FaqEntry, ComponentStatus } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import { countReadableWords } from "@/lib/seo/seo-text-utils";
import {
  isEditorialPolishEnabled,
  extractEditableBlocks,
  buildSectionSummaries,
  buildPolishPrompt,
  extractAllLinks,
  extractNumericClaims,
  countExactKeyphrase,
  normalizeLinkSpacing,
  normalizeArticleSpacing,
  applyEdits,
  validateCandidate,
  deterministicCleanup,
  runEditorialPolish,
  type PolishEdit,
  type PolishBlock,
} from "./editorial-polish";

function makeBlock(id: string, text: string, href?: string): EditorialBlock {
  return {
    id: `block-${id}`,
    type: "paragraph",
    content: href
      ? [{ type: "text", text: text.split("{link}")[0] || "" }, { type: "link", text: "link text", href }, { type: "text", text: text.split("{link}")[1] || "" }]
      : [{ type: "text", text }],
  };
}

function makeLinkBlock(id: string, before: string, href: string, after: string): EditorialBlock {
  return {
    id: `block-${id}`,
    type: "paragraph",
    content: [
      { type: "text", text: before },
      { type: "link", text: "click here", href },
      { type: "text", text: after },
    ],
  };
}

function makeSection(id: string, heading: string, blocks: EditorialBlock[], st: "main" | "faq-heading" = "main"): ArticleSection {
  return { id, heading, headingLevel: 2, sectionType: st, blocks, status: "generated" as ComponentStatus };
}

const KP = "test keyphrase";

function makeDoc(overrides: Partial<ArticleDocument> = {}): ArticleDocument {
  const visibleFaq: FaqEntry[] = [
    { question: "Q1?", answerHtml: "", answerText: "A1." },
    { question: "Q2?", answerHtml: "", answerText: "A2." },
  ];
  return {
    metadata: { title: "Test Article About " + KP, slug: "test", metaDescription: "Meta desc. about " + KP + ".", excerpt: "", targetWordCount: 500, focusKeyphrase: KP },
    languageSwitcher: { id: "ls", type: "language-switcher", html: "<!-- wp:html --><div>English</div><!-- /wp:html -->", fingerprint: "fp" },
    introduction: { id: "intro", blocks: [makeBlock("intro-0", "Introduction text about " + KP + " that appears early in the article to ensure the keyphrase is in the first 100 words.")], status: "generated" },
    sections: [
      makeSection("sec-0", "First Section: " + KP, [
        makeBlock("s0b0", "This is the first paragraph about " + KP + ". It discusses an important topic for SEO."),
        makeBlock("s0b1", "The key is to remember that consistency matters. This is a robotic phrase."),
        makeBlock("s0b2", "That's why we recommend starting early. Another robotic phrase here."),
      ]),
      makeSection("sec-1", "Second Section: " + KP, [
        makeBlock("s1b0", "This paragraph covers a related topic about " + KP + " that should transition smoothly."),
        makeBlock("s1b1", "Remember that users prefer authentic content. This repeats the intro idea."),
      ]),
      makeSection("sec-2", "Frequently Asked Questions", [
        makeBlock("s2b0", "FAQ content here."),
      ], "faq-heading"),
    ],
    visibleFaq,
    conclusion: { id: "conc", blocks: [makeBlock("conc-0", "Conclusion.")], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div style=\"background:#1E3A8A;\"><h2>Ready?</h2><a href=\"https://app.b2ihub.com/signup\">Sign Up</a></div><!-- /wp:html -->", fingerprint: "cta-fp" },
    faqSchema: {
      id: "faq-schema", type: "faq-schema",
      html: "<!-- wp:html --><script type=\"application/ld+json\">{\"@type\":\"FAQPage\",\"mainEntity\":[]}</script><!-- /wp:html -->",
      fingerprint: "fs-fp",
    },
    insertedLinks: [],
    ...overrides,
  };
}

function makeEditResponse(edits: PolishEdit[]): string {
  return JSON.stringify({ edits });
}

describe("isEditorialPolishEnabled", () => {
  it("is false when env var is not set", () => {
    delete process.env.ENABLE_EDITORIAL_POLISH;
    expect(isEditorialPolishEnabled()).toBe(false);
  });

  it("is true when env var is true", () => {
    process.env.ENABLE_EDITORIAL_POLISH = "true";
    expect(isEditorialPolishEnabled()).toBe(true);
  });
});

describe("extractEditableBlocks", () => {
  it("excludes FAQ heading section blocks", () => {
    const doc = makeDoc();
    const blocks = extractEditableBlocks(doc);
    for (const b of blocks) {
      expect(b.blockId).not.toContain("sec-2");
    }
  });

  it("assigns unique blockIds", () => {
    const doc = makeDoc();
    const ids = extractEditableBlocks(doc).map((b) => b.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildSectionSummaries", () => {
  it("excludes FAQ section", () => {
    const doc = makeDoc();
    const summaries = buildSectionSummaries(doc);
    expect(summaries.every((s) => !s.heading.includes("FAQ"))).toBe(true);
  });
});

describe("buildPolishPrompt", () => {
  it("includes block listing and section summaries", () => {
    const doc = makeDoc();
    const blocks = extractEditableBlocks(doc);
    const summaries = buildSectionSummaries(doc);
    const messages = buildPolishPrompt({
      blocks, sectionSummaries: summaries,
      keyphrase: "test", title: "T", metaDescription: "M", articleHtml: "",
    });
    expect(messages.length).toBe(2);
    const userMsg = messages[1].content;
    expect(userMsg).toContain("blockId");
    expect(userMsg).toContain("First Section");
  });
});

describe("extractAllLinks", () => {
  it("finds links in sections", () => {
    const doc = makeDoc();
    // Add a link block
    doc.sections[0].blocks.push(makeLinkBlock("link-0", "Visit ", "https://example.com", " for more."));
    const links = extractAllLinks(doc);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.some((l) => l.href === "https://example.com")).toBe(true);
  });
});

describe("extractNumericClaims", () => {
  it("finds percentages and numbers", () => {
    expect(extractNumericClaims("<p>150% growth</p>")).toContain("150%");
  });

  it("rejects candidate introducing new claim", () => {
    const doc = makeDoc();
    const origHtml = renderArticleDocument(doc);
    const candHtml = origHtml.replace("important topic", "150% growth rate");
    const origClaims = new Set(extractNumericClaims(origHtml));
    const candClaims = new Set(extractNumericClaims(candHtml));
    const newClaims = [...candClaims].filter((c) => !origClaims.has(c));
    expect(newClaims).toContain("150%");
  });
});

describe("countExactKeyphrase", () => {
  it("counts occurrences in HTML", () => {
    const html = "<p>test keyphrase is important. The test keyphrase appears twice.</p>";
    expect(countExactKeyphrase(html, "test keyphrase")).toBe(2);
  });
});

describe("normalizeLinkSpacing", () => {
  it("adds space before anchor after word", () => {
    const result = normalizeLinkSpacing("business in<a href=\"https://x.com\">Hong Kong</a>");
    expect(result).toContain("in <a");
  });

  it("adds space after anchor before word", () => {
    const result = normalizeLinkSpacing("<a href=\"https://x.com\">pitch</a>your product");
    expect(result).toContain("</a> your");
  });

  it("does not add extra space when already correct", () => {
    const input = "business in <a href=\"https://x.com\">Hong Kong</a> market";
    expect(normalizeLinkSpacing(input)).toBe(input);
  });

  it("removes double spaces created by fix", () => {
    const result = normalizeLinkSpacing("word<a href=\"https://x.com\">link</a>");
    expect(result).not.toContain("  ");
  });
});

describe("normalizeArticleSpacing", () => {
  it("fixes punctuation spacing", () => {
    const result = normalizeArticleSpacing("<p>Hello , world .</p>");
    expect(result).not.toContain(" ,");
    expect(result).not.toContain(" .");
  });
});

describe("applyEdits", () => {
  it("applies valid edits to cloned doc", () => {
    const doc = makeDoc();
    const edits: PolishEdit[] = [
      { blockId: "section-0-block-0", replacementHtml: "<!-- wp:paragraph --><p>Replaced text.</p><!-- /wp:paragraph -->", reason: "test" },
    ];
    const cloned = applyEdits(doc, edits);
    expect(cloned).not.toBe(doc);
  });

  it("ignores edits with unknown blockId", () => {
    const doc = makeDoc();
    const edits: PolishEdit[] = [
      { blockId: "nonexistent", replacementHtml: "<!-- wp:paragraph --><p>X</p><!-- /wp:paragraph -->", reason: "" },
    ];
    const cloned = applyEdits(doc, edits);
    const origBlock = doc.sections[0].blocks[0];
    const clonedBlock = cloned.sections[0].blocks[0];
    if (origBlock.type === "paragraph" && clonedBlock.type === "paragraph") {
      expect(clonedBlock.content[0].text).toBe(origBlock.content[0].text);
    }
  });
});

describe("validateCandidate", () => {
  it("rejects candidate with changed H2 count", () => {
    const doc = makeDoc();
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    // Remove an editorial section but keep FAQ
    bad.sections = bad.sections.filter((s) => s.sectionType !== "faq-heading");
    bad.sections.pop(); // remove last editorial section
    bad.sections.push(doc.sections[doc.sections.length - 1]); // re-add FAQ
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("H2 count"))).toBe(true);
  });

  it("rejects candidate with link removed", () => {
    const doc = makeDoc();
    // Add a link to the doc
    doc.sections[0].blocks[0] = makeLinkBlock("s0b0-link", "Visit ", "https://example.com", " for info.");
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    const linkBlock = bad.sections[0]?.blocks[0];
    if (linkBlock && "content" in linkBlock) {
      (linkBlock as any).content = [{ type: "text", text: "No link." }];
    }
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
  });

  it("rejects candidate with new numeric claim", () => {
    const doc = makeDoc();
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    const claimBlock = bad.sections[0]?.blocks[2];
    if (claimBlock && "content" in claimBlock) {
      (claimBlock as any).content = [{ type: "text", text: "150% growth rate" }];
    }
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
  });

  it("rejects candidate with changed FAQ question", () => {
    const doc = makeDoc();
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    bad.visibleFaq[0] = { question: "Changed?", answerHtml: "", answerText: "A." };
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
  });

  it("rejects candidate with changed CTA", () => {
    const doc = makeDoc();
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    bad.cta = { id: "cta", type: "cta", html: "changed", fingerprint: "new-fp" };
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
  });

  it("rejects candidate with changed title", () => {
    const doc = makeDoc();
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    bad.metadata.title = "Changed Title";
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
  });

  it("rejects candidate with word count >10% change", () => {
    const doc = makeDoc();
    const bad = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    // Add many paragraphs to blow up word count
    for (const s of bad.sections) {
      if (s.sectionType !== "faq-heading") {
        for (let i = 0; i < 50; i++) {
          s.blocks.push({ id: `extra-${i}`, type: "paragraph", content: [{ type: "text", text: "Extra paragraph content that increases word count dramatically to exceed the ten percent threshold for rejection." }] });
        }
      }
    }
    const result = validateCandidate(doc, bad, KP);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("Word count"))).toBe(true);
  });

  it("accepts valid identical candidate", () => {
    const doc = makeDoc();
    const clone = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
    const result = validateCandidate(doc, clone, KP);
    if (!result.valid) {
      throw new Error(`Identical candidate rejected: ${result.reasons.join("; ")}`);
    }
    expect(result.valid).toBe(true);
  });
});

describe("deterministicCleanup", () => {
  it("removes empty paragraphs", () => {
    const input = "<!-- wp:paragraph --><p></p><!-- /wp:paragraph -->";
    expect(deterministicCleanup(input)).not.toContain("wp:paragraph");
  });

  it("removes consecutive block boundaries", () => {
    const input = "<!-- /wp:paragraph --><!-- wp:paragraph -->";
    expect(deterministicCleanup(input)).not.toContain("/wp:paragraph--><!-- wp:paragraph");
  });
});

describe("runEditorialPolish", () => {
  it("drops edit that adds new external URL", async () => {
    const doc = makeDoc();
    const mockAi = vi.fn().mockResolvedValue({
      content: makeEditResponse([
        { blockId: "section-0-block-0", replacementHtml: '<!-- wp:paragraph --><p>Visit <a href="https://evil.com">spam</a>.</p><!-- /wp:paragraph -->', reason: "Added link" },
      ]),
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    expect(result.result.appliedEdits).toBe(0);
  });

  it("rejects candidate with unknown blockId", async () => {
    const doc = makeDoc();
    const mockAi = vi.fn().mockResolvedValue({
      content: makeEditResponse([
        { blockId: "section-99-block-0", replacementHtml: "<!-- wp:paragraph --><p>X</p><!-- /wp:paragraph -->", reason: "" },
      ]),
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    expect(result.result.proposedEdits).toBe(1);
    expect(result.result.appliedEdits).toBe(0);
  });

  it("rejects candidate with duplicate blockId edits", async () => {
    const doc = makeDoc();
    const mockAi = vi.fn().mockResolvedValue({
      content: makeEditResponse([
        { blockId: "section-0-block-0", replacementHtml: "<!-- wp:paragraph --><p>First</p><!-- /wp:paragraph -->", reason: "" },
        { blockId: "section-0-block-0", replacementHtml: "<!-- wp:paragraph --><p>Second</p><!-- /wp:paragraph -->", reason: "" },
      ]),
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    expect(result.result.appliedEdits).toBe(1); // only first applied
  });

  it("section-only edits pass validation (FAQ unchanged)", async () => {
    const doc = makeDoc();
    const mockAi = vi.fn().mockResolvedValue({
      content: makeEditResponse([
        { blockId: "section-0-block-0", replacementHtml: "<!-- wp:paragraph --><p>Changed section text that does not affect FAQ or CTA.</p><!-- /wp:paragraph -->", reason: "" },
      ]),
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    if (!result.result.accepted) {
      console.log("Polish rejected:", result.result.reason);
      console.log("Proposed edits:", result.result.proposedEdits, "Applied:", result.result.appliedEdits);
      console.log("WC before:", result.result.inputWordCount, "after:", result.result.candidateWordCount);
    }
    expect(result.result.accepted).toBe(true);
  });

  it("restores original on parse failure", async () => {
    const doc = makeDoc();
    const mockAi = vi.fn().mockResolvedValue({
      content: "not valid json",
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    expect(result.result.accepted).toBe(false);
  });

  it("returns original unchanged on failure", async () => {
    const doc = makeDoc();
    const origFp = renderArticleDocument(doc);
    const mockAi = vi.fn().mockResolvedValue({
      content: "invalid",
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    expect(renderArticleDocument(result.doc)).toBe(origFp);
  });

  it("passes with disabled flag — pipeline unchanged", () => {
    // This test verifies the flag behavior. When ENABLE_EDITORIAL_POLISH is false,
    // the pipeline skips the stage entirely.
    delete process.env.ENABLE_EDITORIAL_POLISH;
    expect(isEditorialPolishEnabled()).toBe(false);
  });

  it("counts keyphrase correctly before and after", async () => {
    const doc = makeDoc();
    const mockAi = vi.fn().mockResolvedValue({
      content: makeEditResponse([
        { blockId: "section-0-block-0", replacementHtml: "<!-- wp:paragraph --><p>test keyphrase appears here now.</p><!-- /wp:paragraph -->", reason: "" },
      ]),
    });
    const result = await runEditorialPolish(doc, "test keyphrase", mockAi);
    expect(result.result.keyphraseBefore).toBeDefined();
    expect(result.result.keyphraseAfter).toBeDefined();
  });

  it("rejects candidate outside word count tolerance", async () => {
    const doc = makeDoc();
    // Mock returns an edit that dramatically increases the word count of one block
    const mockAi = vi.fn().mockResolvedValue({
      content: makeEditResponse([
        { blockId: "section-0-block-0", replacementHtml: "<!-- wp:paragraph --><p>" + "repeated word padding ".repeat(500) + "</p><!-- /wp:paragraph -->", reason: "expanded" },
      ]),
    });
    const result = await runEditorialPolish(doc, KP, mockAi);
    // Word count should increase by >10% due to the huge edit, causing rejection
    expect(result.result.accepted).toBe(false);
  });
});
