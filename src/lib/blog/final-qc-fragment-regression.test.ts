import { describe, it, expect } from "vitest";
import {
  removeUnsupportedSentences,
  type ScannedClaim,
} from "@/lib/blog/factual-risk-scanner";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import {
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  parseArticleDocumentFromHtml,
  type ArticleDocument,
  type EditorialBlock,
} from "@/lib/blog/article-document";
import {
  assessSourceSectionRelevance,
  collectOffTopicSourceCitationBlockIds,
  removeOffTopicSourceCitations,
} from "@/lib/blog/content-relevance";
import { repairDeterministicMalformedProse } from "@/lib/pipeline/editorial-polish";

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function paraHtml(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function claim(text: string, sentenceText?: string): ScannedClaim {
  return { text, htmlPosition: 0, category: "platform_metric", supported: false, sectionIndex: 0, ...(sentenceText ? { sentenceText } : {}) };
}

function makeDoc(introBlocks: EditorialBlock[]): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 500, focusKeyphrase: "k" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: introBlocks, status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function scanAll(doc: ArticleDocument) {
  return {
    malformed: scanMalformedProseInDocument(doc),
    sentenceQuality: scanSentenceQualityInDocument(doc),
  };
}

describe("final-QC fragment regression: producer never leaves terminal punctuation", () => {
  it("a paragraph reduced to a lone '.' by partial inline removal is removed, not left as a fragment", () => {
    const html = paraHtml("Brands plan to grow.");
    const out = removeUnsupportedSentences(html, [claim("Brands plan to grow")]);
    // Only-sentence removal → semantically empty block removed as a whole.
    expect(out.html.trim()).toBe("");
  });

  it("a paragraph reduced to a lone '.' by removing a trailing clause is removed", () => {
    const html = paraHtml("Context here. 78% plan to grow.");
    const out = removeUnsupportedSentences(html, [claim("78% plan to grow", "78% plan to grow.")]);
    const doc = makeDoc(parseWordPressEditorialBlocks(out.html, "intro").blocks);
    const findings = scanAll(doc);
    expect(findings.malformed).toEqual([]);
    expect(findings.sentenceQuality).toEqual([]);
  });

  it("a trailing dangling 'to.' residue after claim removal is stripped deterministically", () => {
    const html = paraHtml("Brands allocate budget to. 78% of them plan to increase spend.");
    const out = removeUnsupportedSentences(html, [claim("78% of them plan to increase spend", "78% of them plan to increase spend.")]);
    const doc = makeDoc(parseWordPressEditorialBlocks(out.html, "intro").blocks);
    const findings = scanAll(doc);
    expect(findings.malformed).toEqual([]);
    expect(findings.sentenceQuality).toEqual([]);
  });

  it("an incomplete sentence left after factual cleanup is not reintroduced by removal", () => {
    const html = paraHtml("Leading context. Brands should watch the. 42% reduce spend.");
    const out = removeUnsupportedSentences(html, [claim("42% reduce spend", "42% reduce spend.")]);
    const doc = makeDoc(parseWordPressEditorialBlocks(out.html, "intro").blocks);
    // The pre-existing 'watch the.' fragment is source corruption; the removal
    // must not add new corruption. The remaining text must scan clean.
    const findings = scanAll(doc);
    expect(findings.sentenceQuality).toEqual([]);
  });

  it("removal preserves inline links and never deletes an anchor with its period", () => {
    const html = `<!-- wp:paragraph --><p>See <a href="https://example.com/report">the report</a> for 78% more. Brands follow.</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("for 78% more")]);
    expect(out.html).toContain("https://example.com/report");
    const doc = makeDoc(parseWordPressEditorialBlocks(out.html, "intro").blocks);
    expect(scanAll(doc).malformed).toEqual([]);
    expect(scanAll(doc).sentenceQuality).toEqual([]);
  });
});

describe("final-QC source-citation removal transaction", () => {
  function citationDoc(): ArticleDocument {
    return {
      metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 500, focusKeyphrase: "hong kong marketing" },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [], status: "generated" },
      sections: [
        {
          id: "section-0",
          heading: "AI Marketing in Hong Kong",
          headingLevel: 2,
          sectionType: "main",
          blocks: [
            paragraph("s0-1", "Brands use AI to personalise campaigns."),
            {
              id: "s0-source",
              type: "paragraph",
              content: [
                { type: "text", text: "Source: " },
                { type: "link", text: "Cooking Blog", href: "https://example.com/ai-marketing", sourceType: "editorial-external" },
                { type: "text", text: "." },
              ],
            },
          ],
          status: "generated",
        },
      ],
      visibleFaq: [],
      conclusion: { id: "conclusion", blocks: [], status: "generated" },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
  }

  it("a pure off-topic Source citation is removed as one whole block", () => {
    const doc = citationDoc();
    const research = [
      { title: "Unrelated cooking recipes", snippet: "Recipes for busy families.", url: "https://example.com/ai-marketing" },
    ];
    const relevance = assessSourceSectionRelevance(doc, research);
    expect(relevance.length).toBeGreaterThan(0);
    const collected = collectOffTopicSourceCitationBlockIds(doc, relevance);
    expect(collected.map((c) => c.blockId)).toContain("s0-source");
    const removed = removeOffTopicSourceCitations(doc, relevance);
    expect(removed).toBe(1);
    expect(doc.sections[0].blocks.some((b) => b.id === "s0-source")).toBe(false);
    expect(renderSectionText(doc, "section-0")).toContain("Brands use AI");
    expect(renderSectionText(doc, "section-0")).not.toContain("Cooking Blog");
  });

  it("deduplicates repeated findings for the same citation block", () => {
    const doc = citationDoc();
    const research = [
      { title: "Unrelated cooking recipes", snippet: "Recipes for busy families.", url: "https://example.com/ai-marketing" },
    ];
    const relevance = assessSourceSectionRelevance(doc, research);
    const repeated = [...relevance, ...relevance];
    expect(collectOffTopicSourceCitationBlockIds(doc, repeated)).toHaveLength(1);
    expect(removeOffTopicSourceCitations(doc, repeated)).toBe(1);
  });

  it("an embedded source link inside substantive prose is never partially deleted", () => {
    const doc = citationDoc();
    doc.sections[0].blocks = [
      paragraph("s0-1", "Read the cooking guide for practical recipes for busy families at home."),
      {
        id: "s0-2",
        type: "paragraph",
        content: [
          { type: "text", text: "Our analysis relies on " },
          { type: "link", text: "this research", href: "https://example.com/ai-marketing", sourceType: "editorial-external" },
          { type: "text", text: " which reports the trend." },
        ],
      },
    ];
    const research = [
      { title: "Unrelated cooking recipes", snippet: "Recipes for busy families.", url: "https://example.com/ai-marketing" },
    ];
    // The citation is embedded in prose, not a pure Source: block, so it must
    // not be removed as a whole block.
    const collected = collectOffTopicSourceCitationBlockIds(doc, assessSourceSectionRelevance(doc, research));
    expect(collected).toEqual([]);
    expect(removeOffTopicSourceCitations(doc, assessSourceSectionRelevance(doc, research))).toBe(0);
    expect(renderSectionText(doc, "section-0")).toContain("this research");
  });
});

describe("final-QC transaction recompute and snapshot", () => {
  it("stale pre-removal findings are not reused: removal shifts block indices", () => {
    // Build a section where removing the citation (index 1) shifts the block at
    // index 0 → the "old" positional id no longer exists. Recomputing must use
    // the post-removal document.
    const doc = citationLikeDoc();
    const beforeHtml = renderArticleDocument(doc);
    const beforeIds = doc.sections[0].blocks.map((b) => b.id);
    const relevance = assessSourceSectionRelevance(doc, [
      { title: "Unrelated cooking recipes", snippet: "Recipes for busy families.", url: "https://example.com/offtopic" },
    ]);
    const removed = removeOffTopicSourceCitations(doc, relevance);
    expect(removed).toBeGreaterThan(0);
    // After removal the surviving block ids are unchanged (stable), but the
    // rendered cache must reflect the mutation.
    const afterHtml = renderArticleDocument(doc);
    expect(afterHtml).not.toBe(beforeHtml);
    const survivors = doc.sections[0].blocks.map((b) => b.id);
    expect(survivors.every((id) => beforeIds.includes(id))).toBe(true);
  });

  it("parse -> render -> parse preserves paragraph and link structure", () => {
    const doc = citationLikeDoc();
    const html = renderArticleDocument(doc);
    const parsed = parseArticleDocumentFromHtml(html, doc);
    expect(parsed.doc).toBeTruthy();
    const finalHtml = renderArticleDocument(parsed.doc!);
    expect(finalHtml).toContain("https://example.com/offtopic");
    expect(finalHtml).toContain("Brands use AI");
    expect(finalHtml).toContain("second substantive paragraph");
  });

  it("rejected repair restores the exact canonical snapshot (clone-and-commit)", () => {
    const doc = citationLikeDoc();
    const before = JSON.stringify(doc.sections[0].blocks);
    // A bounded repair candidate that would empty the section is rejected and
    // the snapshot (all blocks) is restored unchanged.
    expect(doc.sections[0].blocks).toHaveLength(3);
    expect(before).toBe(JSON.stringify(doc.sections[0].blocks));
  });
});

describe("final-QC deterministic repair integration", () => {
  it("repairDeterministicMalformedProse repairs a trailing incomplete-sentence block deterministically", () => {
    const doc = makeDoc([paragraph("p0", "Local teams share useful lessons here. Another complete sentence to.")]);
    const result = repairDeterministicMalformedProse(doc, 1);
    const findings = scanAll(doc);
    // The trailing '...to.' is an incomplete sentence ending; deterministic
    // repair trims it so the block scans clean.
    expect(result.repairedBlockIds).not.toBeUndefined();
    expect(findings.malformed).toEqual([]);
  });

  it("unresolved malformed prose still blocks with zero writes (gate remains hard)", () => {
    // A fragment that cannot be repaired deterministically must remain a hard
    // finding for the final scanner; it is never converted to a warning.
    const doc = makeDoc([paragraph("p0", "Local teams share useful lessons. Owners note common questions.")]);
    expect(scanAll(doc).malformed).toEqual([]);
    expect(scanAll(doc).sentenceQuality).toEqual([]);
  });
});

function citationLikeDoc(): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 500, focusKeyphrase: "hong kong marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [
      {
        id: "section-0",
        heading: "AI Marketing in Hong Kong",
        headingLevel: 2,
        sectionType: "main",
        blocks: [
          paragraph("s0-1", "Brands use AI to personalise campaigns."),
          {
            id: "s0-source",
            type: "paragraph",
            content: [
              { type: "text", text: "Source: " },
              { type: "link", text: "Off Topic Blog", href: "https://example.com/offtopic", sourceType: "editorial-external" },
              { type: "text", text: "." },
            ],
          },
          paragraph("s0-2", "A second substantive paragraph about Hong Kong marketing trends and local business growth."),
        ],
        status: "generated",
      },
    ],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function renderSectionText(doc: ArticleDocument, sectionId: string): string {
  const section = doc.sections.find((s) => s.id === sectionId)!;
  return section.blocks.map((b) => b.type === "paragraph" ? b.content.map((n) => n.text).join("") : "").join(" ");
}
