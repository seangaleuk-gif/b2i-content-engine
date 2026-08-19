// ── Stage 3N: domain/TLD segmentation + single factual authority regressions ──
// Proves: a domain/TLD internal dot is never a sentence boundary, malformed
// repair never mutates a domain or introduces a long paragraph, trace
// attribution points at the true mutator, final-QC and final validation share
// ONE structured factual scanner (including FAQ question/answer ownership),
// and FAQ topic-year framing matches the sanitizer while genuine claims fail.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import {
  splitSentences,
  countSentences,
} from "@/lib/seo/seo-text-utils";
import {
  sentenceTextRanges,
  isAuthoritativeLowercaseSentenceStart,
} from "@/lib/blog/sentence-quality";
import { repairDeterministicMalformedProse } from "@/lib/pipeline/editorial-polish";
import {
  scanUnsupportedClaimsInDocument,
} from "@/lib/blog/factual-risk-scanner";
import { analyzeFinalArticle } from "@/lib/blog/final-article-policy";
import { renderArticleDocument } from "@/lib/blog/article-document";
import type { ArticleDocument, ArticleComponent, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";
import { paragraphSentenceLimit } from "@/lib/content-standards";
import {
  recordParagraphLengthStage,
  paragraphLengthStageTrace,
  resetParagraphLengthTrace,
} from "@/lib/pipeline/paragraph-length-trace";

const KEYPHRASE = "beauty salon marketing";
const DEBUG_FLAG = "ENABLE_PIPELINE_DEBUG_TRACE";
const SNAPSHOT = "src/lib/__live-fixtures__/2026-08-18T05-26-11-217Z_final-validation_project-23.json";

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function paragraphText(block: EditorialBlock): string {
  if (block.type !== "paragraph") throw new Error(`expected paragraph block, got ${block.type}`);
  return block.content.map((n) => n.text).join("");
}

function makeDoc(opts: {
  sectionText?: string;
  faq?: Array<{ q: string; a: string }>;
  heading?: string;
} = {}): ArticleDocument {
  const intro: ArticleComponent = { id: "intro", status: "normalized", blocks: [paragraphBlock("intro-p0", "Intro one. Intro two.")] };
  const section: ArticleSection = {
    id: "section-0",
    heading: opts.heading ?? "Beauty Salon Marketing 2026",
    headingLevel: 2,
    sectionType: "main",
    status: "normalized",
    blocks: [paragraphBlock("section-0-wp-0", opts.sectionText ?? "Section one. Section two.")],
  };
  const conclusion: ArticleComponent = { id: "conclusion", status: "normalized", blocks: [paragraphBlock("conclusion-p0", "Conclusion one. Conclusion two.")] };
  return {
    metadata: { title: "Beauty Salon Marketing 2026 Guide", slug: "t", metaDescription: "2026 guide.", excerpt: "E.", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: null,
    introduction: intro,
    sections: [section],
    visibleFaq: (opts.faq ?? []).map((f) => ({ question: f.q, answerHtml: `<p>${f.a}</p>`, answerText: f.a })),
    conclusion,
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

afterEach(() => {
  delete process.env[DEBUG_FLAG];
  resetParagraphLengthTrace();
  vi.restoreAllMocks();
});

describe("Stage 3N: domain/TLD internal dot is not a sentence boundary", () => {
  it("example.com. Next sentence. segments as two sentences, not three", () => {
    const text = "MarketResearch.com. That's useful.";
    expect(splitSentences(text)).toEqual(["MarketResearch.com.", "That's useful."]);
    expect(countSentences(text)).toBe(2);
    // The lowercase-start splitter agrees: no "com" sentence fragment.
    const ranges = sentenceTextRanges(text);
    expect(ranges.map((r) => r.text)).toEqual(["MarketResearch.com.", "That's useful."]);
    expect(ranges.some((r) => r.text.toLowerCase().startsWith("com"))).toBe(false);
  });

  it("generic domains and multi-level TLDs segment correctly", () => {
    const cases: Array<[string, number]> = [
      ["Visit example.org. It is great.", 2],
      ["See example.net for details. And more.", 2],
      ["example.com.hk works. Try it.", 2],
      ["example.co.uk works. Try it.", 2],
      ["sub.example.com works. Try it.", 2],
      ["Visit example.com today and check example.org later.", 1],
    ];
    for (const [text, expected] of cases) {
      expect(countSentences(text), text).toBe(expected);
      const ranges = sentenceTextRanges(text);
      expect(ranges.some((r) => /^com\.?$/i.test(r.text.trim())), text).toBe(false);
      expect(ranges.some((r) => /^org\.?$/i.test(r.text.trim())), text).toBe(false);
    }
  });

  it("real sentence endings immediately after a domain still work", () => {
    const text = "Visit example.com. That's a great resource.";
    expect(splitSentences(text)).toEqual(["Visit example.com.", "That's a great resource."]);
  });

  it("a domain label is never a lowercase sentence start", () => {
    const ranges = sentenceTextRanges("MarketResearch.com. That's useful.");
    for (const range of ranges) {
      expect(isAuthoritativeLowercaseSentenceStart(range.text)).toBe(false);
    }
  });
});

describe("Stage 3N: malformed repair safety", () => {
  it("repair does not mutate a domain/TLD (.com stays .com) and the live paragraph stays <= 3 sentences", () => {
    const liveParagraph =
      "Health and beauty specialists in Hong Kong delivered consistent value growth in 2025, with value sales reaching HKD2518 million, according to MarketResearch.com. That's a clear sign that people are still spending on looking and feeling good. The question is: how do you make sure they spend with you?";
    const doc = makeDoc({ sectionText: liveParagraph });
    const result = repairDeterministicMalformedProse(doc, 200, {}, false, KEYPHRASE);
    const text = paragraphText(doc.sections[0].blocks[0]);
    expect(text).toContain("MarketResearch.com");
    expect(text).not.toContain("MarketResearch.Com");
    expect(result.repairedBlockIds).toEqual([]);
    expect(countSentences(text)).toBeLessThanOrEqual(paragraphSentenceLimit());
  });

  it("repair cannot introduce a long paragraph (comparative guard rolls back)", () => {
    // Capitalizing the lowercase starts would re-segment the paragraph into 4
    // sentences under the authoritative sentence counter → the guard rolls back.
    const doc = makeDoc({ sectionText: "Something works. next we plan. then we execute. finally we measure." });
    const result = repairDeterministicMalformedProse(doc, 200, {}, false, KEYPHRASE);
    expect(result.repairedBlockIds).toEqual([]);
    const text = paragraphText(doc.sections[0].blocks[0]);
    expect(text).toContain("next we plan"); // unchanged
    const html = renderArticleDocument(doc);
    const longCount = html.match(/<p[^>]*>[\s\S]*?<\/p>/g)
      ?.map((t) => countSentences(t.replace(/<[^>]+>/g, "").trim()))
      .filter((c) => c > paragraphSentenceLimit()).length ?? 0;
    expect(longCount).toBe(0);
  });

  it("the exact live paragraph remains <=3 sentences after the snapshot's repair scenario", () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      documents: { articleDoc: ArticleDocument };
    };
    const doc = structuredClone(snapshot.documents.articleDoc);
    const result = repairDeterministicMalformedProse(doc, 1, {}, false, KEYPHRASE);
    const block = doc.sections[0].blocks.find((b) => b.id === "section-0-wp-7");
    expect(block).toBeDefined();
    const text = paragraphText(block!);
    expect(countSentences(text)).toBeLessThanOrEqual(paragraphSentenceLimit());
    expect(result.repairedBlockIds).not.toContain("section-0-wp-7");
  });
});

describe("Stage 3N: trace attribution", () => {
  it("first 0→1 is attributed to malformed-prose-repair, not the next no-op stage", () => {
    process.env[DEBUG_FLAG] = "true";
    const cleanDoc = makeDoc({ sectionText: "One. Two. Three." });
    const longDoc = makeDoc({ sectionText: "One. Two. Three. Four." });
    longDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three. Four.");

    const recordFor = (stage: string, doc: ArticleDocument) =>
      recordParagraphLengthStage({ stage, html: renderArticleDocument(doc), doc, keyphrase: KEYPHRASE });
    recordFor("baseline", cleanDoc);
    recordFor("malformed-prose-repair", longDoc);
    recordFor("claim-ownership-final", longDoc); // no-op

    const trace = paragraphLengthStageTrace();
    expect(trace[1]).toMatchObject({ stage: "malformed-prose-repair", count: 1, changed: true });
    expect(trace[1].firstIntroduction).toBeDefined();
    expect(trace[2]).toMatchObject({ stage: "claim-ownership-final", count: 1, changed: false });
    expect(trace[2].firstIntroduction).toBeUndefined();
  });
});

describe("Stage 3N: single authoritative factual scanner", () => {
  it("final-QC and final validation derive the SAME unsupported-claim count", () => {
    const doc = makeDoc({ sectionText: "Salons saw 85% more bookings last year." });
    const structured = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []).length;
    const metrics = analyzeFinalArticle(
      renderArticleDocument(doc),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      doc.metadata.targetWordCount,
      undefined,
      { articleDoc: doc, research: [] },
    );
    expect(metrics.unsupportedFactualClaimCount).toBe(structured);
    expect(structured).toBeGreaterThan(0);
  });

  it("final-QC unsupported=0 implies final-validation unsupported=0 on the saved snapshot with supporting research", () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      documents: { articleDoc: ArticleDocument };
    };
    const doc = snapshot.documents.articleDoc;
    const research = [
      { url: "https://example.com/a", title: "A", snippet: "Health and beauty specialists in Hong Kong delivered consistent value growth in 2025, with value sales reaching HKD2518 million." },
      { url: "https://example.com/b", title: "B", snippet: "According to Time Out Hong Kong, a haircut goes for around $300 for ladies and $250 for men." },
    ];
    const structured = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, research);
    const metrics = analyzeFinalArticle(
      renderArticleDocument(doc),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      doc.metadata.targetWordCount,
      undefined,
      { articleDoc: doc, research },
    );
    expect(metrics.unsupportedFactualClaimCount).toBe(structured.length);
  });

  it("no duplicate final factual scanner remains in final-article-policy", () => {
    const source = fs.readFileSync("src/lib/blog/final-article-policy.ts", "utf8");
    expect(source).not.toContain("countUnsupportedFactualClaims(");
    expect(source).not.toContain("unique.add");
  });
});

describe("Stage 3N: structured FAQ ownership", () => {
  it("FAQ topic-year framing is treated identically by sanitizer, final-QC and final validation", () => {
    const faq = [{ q: "What is the best marketing plan in 2026?", a: "Start with a clear strategy for 2026." }];
    const doc = makeDoc({ faq });
    // Topic context includes the year via title/meta/heading.
    const structured = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    // The interrogative question and the bare topic-context year in the answer
    // are exempt; no FAQ claim survives.
    expect(structured.some((c) => c.surfaceType === "faq-question")).toBe(false);
    expect(structured.some((c) => c.surfaceType === "faq-answer")).toBe(false);
    const metrics = analyzeFinalArticle(
      renderArticleDocument(doc),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      doc.metadata.targetWordCount,
      undefined,
      { articleDoc: doc, research: [] },
    );
    expect(metrics.unsupportedFactualClaimCount).toBe(0);
  });

  it("genuine unsupported FAQ factual claims still fail", () => {
    const faq = [{ q: "How much should I invest?", a: "Salons that invest 85% more see huge returns." }];
    const doc = makeDoc({ faq });
    const structured = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    expect(structured.some((c) => c.surfaceType === "faq-answer" && c.category === "percentage")).toBe(true);
    const faqClaim = structured.find((c) => c.surfaceType === "faq-answer");
    expect(faqClaim?.faqIndex).toBe(0);
    expect(faqClaim?.blockId).toBe("faq-0-answer");
    const metrics = analyzeFinalArticle(
      renderArticleDocument(doc),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      doc.metadata.targetWordCount,
      undefined,
      { articleDoc: doc, research: [] },
    );
    expect(metrics.unsupportedFactualClaimCount).toBeGreaterThan(0);
  });
});
