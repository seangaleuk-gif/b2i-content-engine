import { describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument, parseArticleDocumentFromHtml } from "@/lib/blog/article-document";
import { scanSentenceQualityText, scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { validateCoherence, compressDocumentStructureAware, MIN_SECTION_WORDS } from "@/lib/blog/coherence";
import { splitLongParagraphs } from "@/lib/services/text-utils";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import { repairDeterministicMalformedProse } from "@/lib/pipeline/editorial-polish";

const FAILING_SENTENCE = "— that's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things.";

function paragraph(html: string): string {
  return `<!-- wp:paragraph --><p>${html}</p><!-- /wp:paragraph -->`;
}

function makeSectionDoc(blocks: string[]): ArticleDocument {
  const headingHtml = `<!-- wp:heading {"level":2} -->\n<h2>Budgeting and Strategy: Where to Focus Your Efforts</h2>\n<!-- /wp:heading -->`;
  const sectionHtml = [headingHtml, ...blocks.map(paragraph)].join("\n\n");
  const seed: ArticleDocument = {
    metadata: { title: "T", slug: "t", metaDescription: "m", excerpt: "", targetWordCount: 2500, focusKeyphrase: "hong kong marketing trends 2026" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{
      id: "section-5",
      heading: "Budgeting and Strategy: Where to Focus Your Efforts",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [],
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  const parsed = parseArticleDocumentFromHtml(sectionHtml, seed);
  if (!parsed.doc) throw new Error(parsed.errors.join("; "));
  return parsed.doc;
}

const RESEARCH: Array<{ title: string; snippet: string; url: string }> = [];

describe("production em-dash sentence-start defect", () => {
  it("reproduces the exact final-QC flag on the production sentence", () => {
    // Mid-block continuation after a complete sentence (period + em-dash + lowercase).
    const text = `Start with a clear budget. ${FAILING_SENTENCE}`;
    const issues = scanSentenceQualityText(text);
    expect(issues.some((issue) => issue.code === "lowercase-sentence-start"
      && issue.sentence === FAILING_SENTENCE)).toBe(true);

    // Standalone continuation block (block start).
    const blockStart = scanSentenceQualityText(FAILING_SENTENCE);
    expect(blockStart.some((issue) => issue.code === "lowercase-sentence-start")).toBe(true);

    // The valid mid-sentence appositive form (no period before the dash) is NOT flagged.
    const valid = scanSentenceQualityText("Start with a clear budget — that's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things.");
    expect(valid.some((issue) => issue.code === "lowercase-sentence-start")).toBe(false);
  });

  it("no deterministic stage can CREATE the flagged form from the valid appositive form", () => {
    const validText = "Start with a clear budget — that's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things.";
    const html = paragraph(validText);

    // Paragraph normalization splits only at real sentence boundaries ([.!?]
    // followed by an uppercase continuation) — the em-dash is never a split point.
    const split = splitLongParagraphs(html, 1);
    expect(split.splitCount).toBe(0);
    expect(split.html).toBe(html);

    // Factual sentence removal is whole-sentence granularity; the appositive is
    // one sentence and cannot be split at the dash. Either the paragraph is
    // removed whole or left intact — never a partial em-dash remainder.
    const claim: ScannedClaim = {
      text: "Start with a clear budget",
      category: "unattributed_source",
      supported: false,
      htmlPosition: 0,
      sentenceText: validText,
      sectionIndex: 0,
    };
    const removed = removeUnsupportedSentences(html, [claim]);
    expect(removed.html === html || !removed.html.includes("— that's")).toBe(true);

    // Final trim removes whole paragraphs only; a single-sentence paragraph
    // containing the valid appositive form is either removed whole or kept.
    const doc = makeSectionDoc([validText, validText]);
    const before = renderArticleDocument(doc);
    const { removedParagraphs, shortenedSentences } = compressDocumentStructureAware(
      doc, 100000, 1, "hong kong marketing trends 2026", RESEARCH,
    );
    const after = renderArticleDocument(doc);
    expect(shortenedSentences).toBe(0);
    if (removedParagraphs > 0) {
      // Whole paragraphs removed — never a partial em-dash remainder.
      expect(after.includes("— that's the spirit")).toBe(false);
      expect(after.includes(validText)).toBe(false);
    } else {
      expect(after).toBe(before);
    }
  });

  it("final trim removes the antecedent paragraph while leaving the dependent continuation untouched — the block defect predates trim", () => {
    const antecedent = "Smart teams plan their content calendar around real customer questions.";
    const doc = makeSectionDoc([antecedent, FAILING_SENTENCE, antecedent, antecedent, antecedent, antecedent]);
    const wordMax = countWords(doc) - countWordsOf(antecedent);
    const { removedParagraphs } = compressDocumentStructureAware(doc, wordMax, 1, "hong kong marketing trends 2026", RESEARCH);
    expect(removedParagraphs).toBeGreaterThan(0);
    // The continuation block is byte-identical after trim (trim never rewrote it).
    const remaining = renderArticleDocument(doc);
    expect(remaining).toContain(FAILING_SENTENCE.replace(/'/g, "&#39;"));
    // And it was already in the flagged form BEFORE trim.
    expect(scanSentenceQualityText(FAILING_SENTENCE).some((i) => i.code === "lowercase-sentence-start")).toBe(true);
  });

  it("validateCoherence reports zero violations for a dangling em-dash continuation", () => {
    // The em-dash continuation opens the section but is not a demonstrative
    // ("this/that/these..."), a transition, or an unfinished example — the
    // coherence validator never inspects within-block sentence starts.
    const filler = "Smart teams plan their content calendar around real customer questions and keep the work steady.";
    const doc = makeSectionDoc([FAILING_SENTENCE, filler, filler, filler]);
    expect(countWords(doc)).toBeGreaterThanOrEqual(MIN_SECTION_WORDS);
    const violations = validateCoherence(doc);
    expect(violations).toEqual([]);
  });
});

describe("deterministic em-dash continuation repair (responsible stage)", () => {
  it("repairs the exact production sentence in both flagged positions", () => {
    const midBlock = `Start with a clear budget. ${FAILING_SENTENCE}`;
    const doc = makeSectionDoc([midBlock, FAILING_SENTENCE]);
    expect(scanSentenceQualityInDocument(doc).length).toBeGreaterThan(0);

    const result = repairDeterministicMalformedProse(doc, 1);
    expect(result.repairedBlockIds).toContain(doc.sections[0].blocks[0].id);
    expect(result.repairedBlockIds).toContain(doc.sections[0].blocks[1].id);

    const firstBlock = doc.sections[0].blocks[0];
    const secondBlock = doc.sections[0].blocks[1];
    if (firstBlock.type !== "paragraph" || secondBlock.type !== "paragraph") {
      throw new Error("expected paragraph blocks");
    }
    expect(firstBlock.content).toEqual([
      { type: "text", text: "Start with a clear budget. — That's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things." },
    ]);
    expect(secondBlock.content).toEqual([
      { type: "text", text: "— That's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things." },
    ]);
    // The exact production sentence is no longer flagged anywhere.
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
  });

  it("leaves valid appositive forms, correct capitals and mid-sentence dashes untouched", () => {
    const untouched = [
      "Start with a clear budget — that's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things.",
      "— That's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things.",
      "Budget realistically — that's the spirit of Hong Kong marketing: flexible, adaptive, and ready to try new things — and track the results weekly.",
    ];
    const doc = makeSectionDoc([...untouched, "Final paragraph with plenty of words to keep the section well above the minimum word floor for coherence validation."]);
    const before = renderArticleDocument(doc);
    const result = repairDeterministicMalformedProse(doc, 1);
    expect(result.repairedBlockIds).toEqual([]);
    expect(renderArticleDocument(doc)).toBe(before);
    expect(scanSentenceQualityInDocument(doc)).toEqual([]);
  });

  it("is idempotent and never changes word count or structure", () => {
    const doc = makeSectionDoc([`Plan the content calendar. ${FAILING_SENTENCE}`]);
    const wcBefore = countWords(doc);
    repairDeterministicMalformedProse(doc, 1);
    const afterFirst = renderArticleDocument(doc);
    expect(countWords(doc)).toBe(wcBefore);
    repairDeterministicMalformedProse(doc, 1);
    expect(renderArticleDocument(doc)).toBe(afterFirst);
  });
});

function countWords(doc: ArticleDocument): number {
  return renderArticleDocument(doc).replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}
function countWordsOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
