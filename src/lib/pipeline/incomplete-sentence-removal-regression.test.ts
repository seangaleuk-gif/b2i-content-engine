import { describe, expect, it } from "vitest";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";
import {
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  type ArticleDocument,
} from "@/lib/blog/article-document";

function claim(text: string, sentenceText?: string): ScannedClaim {
  return {
    text,
    htmlPosition: 0,
    category: "platform_metric",
    supported: false,
    sectionIndex: 0,
    ...(sentenceText ? { sentenceText } : {}),
  };
}

function makeDoc(blockHtml: string): ArticleDocument {
  const parsed = parseWordPressEditorialBlocks(blockHtml, "section-2");
  return {
    metadata: {
      title: "T",
      slug: "t",
      metaDescription: "D",
      excerpt: "",
      targetWordCount: 2500,
      focusKeyphrase: "creator marketing hong kong",
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [
      {
        id: "section-2",
        heading: "H2",
        headingLevel: 2,
        sectionType: "main",
        blocks: parsed.blocks,
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

describe("section-2-wp-4[incomplete-sentence-ending] production regression", () => {
  it("factual removal from a linked paragraph never leaves a dangling sentence ending", () => {
    // Production shape: an unsupported claim sentence follows a sentence that
    // ends with a dangling stop-word, and the paragraph carries an inline link.
    const html =
      `<!-- wp:paragraph --><p>Brands <a href="https://example.com/report">allocate budget</a> to. ` +
      `This unsupported statistic is fabricated.</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [
      claim("This unsupported statistic is fabricated", "This unsupported statistic is fabricated."),
    ]);
    const doc = makeDoc(out.html);

    // The removal must not commit a block that ends in an incomplete sentence.
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
    // The inline link is preserved.
    expect(out.html).toContain("https://example.com/report");
    // The rendered paragraph never ends with a dangling stop-word.
    const block = doc.sections[0].blocks[0];
    const text = block.type === "paragraph"
      ? block.content.map((node) => node.text).join("").trim()
      : "";
    expect(text.endsWith("to.")).toBe(false);
  });

  it("the integrity contract rejects the dangling remainder at the factual-scan boundary", () => {
    // Without the producer guard, the removal would leave "…to." and the
    // stage-aware contract (malformed prose is NOT owned by factual-scan) must
    // classify it as an unowned violation so the stage rolls back immediately.
    const previous = makeDoc(
      `<!-- wp:paragraph --><p>Brands <a href="https://example.com/report">allocate budget</a> to. ` +
      `This unsupported statistic is fabricated.</p><!-- /wp:paragraph -->`,
    );
    const corrupted = makeDoc(
      `<!-- wp:paragraph --><p>Brands <a href="https://example.com/report">allocate budget</a> to.</p><!-- /wp:paragraph -->`,
    );
    const result = validateArticleIntegrityContract(corrupted, {
      keyphrase: "creator marketing hong kong",
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === "malformed")).toBe(true);
    expect(result.ownedViolations.some((v) => v.category === "malformed")).toBe(false);
  });

  it("the producer keeps the unsupported claim rather than corrupting prose", () => {
    // When removal cannot happen safely (the dangling sentence carries the
    // only link), the removal is aborted: the paragraph stays byte-identical
    // and the unsupported claim is preserved for the final gates.
    const html =
      `<!-- wp:paragraph --><p>Brands <a href="https://example.com/report">allocate budget</a> to. ` +
      `This unsupported statistic is fabricated.</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [
      claim("This unsupported statistic is fabricated", "This unsupported statistic is fabricated."),
    ]);
    expect(out.sentencesRemoved).toBe(0);
    expect(out.html).toBe(html);
    expect(renderArticleDocument(makeDoc(out.html))).toContain("This unsupported statistic is fabricated");
  });

  it("a linked paragraph that can be trimmed cleanly keeps its link and drops only the dangling sentence", () => {
    // Prefix is a complete sentence carrying the link; only the trailing
    // dangling sentence is removed node-preservingly.
    const html =
      `<!-- wp:paragraph --><p>Complete sentence with a <a href="https://example.com/report">report link</a>. ` +
      `Brands allocate budget to.</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [
      claim("Brands allocate budget to", "Brands allocate budget to."),
    ]);
    expect(out.html).toContain("https://example.com/report");
    const doc = makeDoc(out.html);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
    const block = doc.sections[0].blocks[0];
    const keptText = block.type === "paragraph"
      ? block.content.map((n) => n.text).join("").trim()
      : "";
    expect(keptText).toBe("Complete sentence with a report link.");
  });

  it("claim-ownership removal uses the same hardened producer and cannot commit the dangling remainder", () => {
    const html =
      `<!-- wp:paragraph --><p>Brands <a href="https://example.com/report">allocate budget</a> to. ` +
      `This unsupported statistic is fabricated.</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [
      claim("This unsupported statistic is fabricated", "This unsupported statistic is fabricated."),
    ], { preserveSentenceTexts: [] });
    expect(scanMalformedProseInDocument(makeDoc(out.html))).toEqual([]);
    expect(out.html).toContain("https://example.com/report");
  });
});
