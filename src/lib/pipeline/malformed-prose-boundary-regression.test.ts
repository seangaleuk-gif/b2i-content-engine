import { describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument, parseArticleDocumentFromHtml } from "@/lib/blog/article-document";
import { scanSentenceQualityText } from "@/lib/blog/sentence-quality";
import {
  findMalformedProseTextIssues,
  hasDanglingSentenceEnding,
  classifyMalformedIssue,
} from "@/lib/blog/publication-quality";
import { repairDeterministicMalformedProse } from "@/lib/pipeline/editorial-polish";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";

const KP = "threads marketing hong kong";

function paragraphHtml(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function docWithBlocks(blockTexts: string[]): ArticleDocument {
  const heading = `<!-- wp:heading {"level":2} -->\n<h2>Section One</h2>\n<!-- /wp:heading -->`;
  const paragraphs = blockTexts.map(paragraphHtml).join("\n\n");
  const seed: ArticleDocument = {
    metadata: { title: "T", slug: "t", metaDescription: "m", excerpt: "", targetWordCount: 2500, focusKeyphrase: KP },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{
      id: "section-1",
      heading: "Section One",
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
  const parsed = parseArticleDocumentFromHtml(`${heading}\n\n${paragraphs}`, seed);
  if (!parsed.doc) throw new Error(parsed.errors.join("; "));
  return parsed.doc;
}

describe("malformed-prose repair boundary policy", () => {
  it("resolves a removable incomplete-ending block via bounded removal", () => {
    const doc = docWithBlocks([
      "Local teams share useful lessons from daily work with clear and honest words.",
      "Smart owners plan for.",
      "A small weekly plan keeps the work steady without adding stress to the whole team.",
      "Regular replies show customers that a real person is listening to their needs.",
    ]);
    const result = repairDeterministicMalformedProse(doc, 1, {}, true);
    expect(result.removedBlockIds.length).toBeGreaterThan(0);
    expect(result.unresolved).toEqual([]);
    const remainingTexts = doc.sections[0].blocks.flatMap((block) =>
      block.type === "paragraph"
        ? [block.content.map((n) => n.text).join("")]
        : block.type === "list"
          ? block.items.map((item) => item.map((n) => n.text).join(""))
          : block.type === "quote" || block.type === "subheading"
            ? [block.content.map((n) => n.text).join("")]
            : block.rows.flat().map((row) => row.map((n) => n.text).join(" ")),
    );
    expect(remainingTexts).not.toContain("Smart owners plan for.");
  });

  it("an unremovable incomplete-ending block stays unresolved and is classified hard", () => {
    // The block ENDS with the dangling "for." and contains an extractable
    // number ("50%"), so the bounded removal refuses it — the finding must
    // remain and be classified as genuine publication-breaking corruption.
    const doc = docWithBlocks([
      "50% of budgets follow the same pattern, so smart owners plan for.",
      "Local teams share useful lessons from daily work with clear and honest words.",
    ]);
    const result = repairDeterministicMalformedProse(doc, 1, {}, true);
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(result.unresolved.every((f) =>
      f.issueCodes.some((code) => classifyMalformedIssue(code) === "hard"),
    )).toBe(true);
  });

  it("a rejected repair restores the exact canonical snapshot", () => {
    const doc = docWithBlocks([
      "Smart owners plan for.",
      "Local teams share useful lessons from daily work with clear and honest words.",
    ]);
    // wordMin above the article count: every removal is rejected.
    const before = renderArticleDocument(doc);
    const result = repairDeterministicMalformedProse(doc, 100000, {}, true);
    expect(result.removedBlockIds).toEqual([]);
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(renderArticleDocument(doc)).toBe(before);
  });

  it("classifies every emitted malformed code as hard (no soft false positives)", () => {
    for (const code of [
      "corrupt-token",
      "serialized-program-value",
      "instruction-placeholder",
      "replacement-character",
      "punctuation-fragment",
      "incomplete-sentence-ending",
      "unmatched-parentheses",
      "unmatched-quotation",
      "broken-quoted-fragment",
    ] as const) {
      expect(classifyMalformedIssue(code), code).toBe("hard");
    }
  });
});

describe("sentence-quality and malformed-scanner false positives", () => {
  it("accepts the production sentence as valid prose", () => {
    expect(scanSentenceQualityText("AI and AR are simply the means to get there.")).toEqual([]);
  });

  it("still catches genuine malformed noun phrases", () => {
    expect(
      scanSentenceQualityText("This is part of the broader these market changes picture and it keeps growing.")
        .some((i) => i.code === "malformed-noun-phrase"),
    ).toBe(true);
    expect(
      scanSentenceQualityText("The higher the stakes the smaller the room for error.")
        .some((i) => i.code === "malformed-noun-phrase"),
    ).toBe(true);
  });

  it("accepts stranded-preposition sentence endings", () => {
    for (const sentence of [
      "What are you waiting for?",
      "This is what we plan for.",
      "We have a lot to deal with.",
      "It's something to build on.",
      "That's what it comes down to.",
    ]) {
      expect(hasDanglingSentenceEnding(sentence), sentence).toBe(false);
      expect(findMalformedProseTextIssues([sentence]), sentence).toEqual([]);
    }
  });

  it("still catches genuine dangling sentence endings", () => {
    for (const sentence of ["Smart owners plan for.", "The budget is for.", "Marketing teams invest in."]) {
      expect(hasDanglingSentenceEnding(sentence), sentence).toBe(true);
      expect(
        findMalformedProseTextIssues([sentence]).some((i) => i.code === "incomplete-sentence-ending"),
        sentence,
      ).toBe(true);
    }
  });

  it("does not treat inch marks as quotation marks", () => {
    const text = 'The new 13-inch laptop is light, but a 13" screen still feels small.';
    expect(findMalformedProseTextIssues([text])).toEqual([]);
  });

  it("accepts a closed quote continuing with a conjunction", () => {
    for (const text of [
      'He said "stop." and walked away calmly.',
      'The report says "growth will continue." But budgets are tight.',
    ]) {
      expect(findMalformedProseTextIssues([text]), text).toEqual([]);
    }
  });

  it("still catches an unclosed quoted fragment", () => {
    const text = 'He said "stop. and walked away';
    expect(
      findMalformedProseTextIssues([text]).some((i) => i.code === "unmatched-quotation"),
    ).toBe(true);
  });
});

describe("punctuation-only sentences and deletion residues", () => {
  it("strips a stray '.' sentence inside prose deterministically", () => {
    const doc = docWithBlocks([
      "Local teams share useful lessons. . Plan a small weekly routine.",
      "Regular replies show customers that a real person is listening to their needs.",
    ]);
    const result = repairDeterministicMalformedProse(doc, 1, {}, true);
    expect(result.repairedBlockIds).toContain(doc.sections[0].blocks[0].id);
    const firstBlock = doc.sections[0].blocks[0];
    if (firstBlock.type !== "paragraph") throw new Error("expected paragraph");
    expect(firstBlock.content).toEqual([
      { type: "text", text: "Local teams share useful lessons. Plan a small weekly routine." },
    ]);
    // The punctuation-only '.' sentence can no longer reach the final gate.
    expect(scanSentenceQualityText("Local teams share useful lessons. Plan a small weekly routine.")).toEqual([]);
  });

  it("sentence removal cannot leave a dangling ending or stray period", () => {
    const claim: ScannedClaim = {
      text: "2026 budgets",
      category: "date_claim",
      supported: false,
      htmlPosition: 0,
      sentenceText: "Smart owners plan for 2026 budgets.",
      sectionIndex: 0,
    };
    const result = removeUnsupportedSentences(
      paragraphHtml("Smart owners plan for 2026 budgets. Teams stay flexible."),
      [claim],
    );
    expect(result.html).not.toContain("for.");
    expect(result.html).not.toMatch(/\.\s*\./);
    expect(result.html).toContain("Teams stay flexible.");
  });

  it("removal never strips a legitimate stranded-preposition remainder", () => {
    const claim: ScannedClaim = {
      text: "Teams stay flexible",
      category: "unattributed_source",
      supported: false,
      htmlPosition: 0,
      sentenceText: "Teams stay flexible.",
      sectionIndex: 0,
    };
    const result = removeUnsupportedSentences(
      paragraphHtml("What are you waiting for. Teams stay flexible."),
      [claim],
    );
    expect(result.html).toContain("What are you waiting for.");
  });
});
