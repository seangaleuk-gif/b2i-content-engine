import { describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { validateCoherence } from "@/lib/blog/coherence";
import { splitLongParagraphs } from "@/lib/services/text-utils";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";

function paragraph(id: string, text: string): ArticleDocument["sections"][number]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(blocks: Array<{ id: string; type: "paragraph"; text: string }>): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: "marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{
      id: "section-2",
      heading: "Choosing the Right Channel",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: blocks.map((block) => paragraph(block.id, block.text)),
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

const PRODUCTION =
  "For example, if you want to have deeper, more personal conversations, a private Facebook group or a Discord server might work better than a public page.";

function unfinishedCodes(text: string): string[] {
  return validateCoherence(makeDoc([{ id: "b0", type: "paragraph", text }]))
    .filter((v) => v.type === "unfinished-example")
    .map((v) => v.type);
}

describe("unfinished-example rule is completeness-gated", () => {
  it("the production sentence beginning 'For example, if...' is NOT unfinished", () => {
    expect(unfinishedCodes(PRODUCTION)).toEqual([]);
  });

  it("a complete 'For example, a local bakery...' example is valid", () => {
    expect(unfinishedCodes("For example, a local bakery might share a short video each week to grow its audience.")).toEqual([]);
  });

  it("a complete 'For example, you can...' example is valid", () => {
    expect(unfinishedCodes("For example, you can start with one small post and review the replies each week.")).toEqual([]);
  });

  it("a complete 'For example, a small team can...' example is valid", () => {
    expect(unfinishedCodes("For example, a small team can post three times per week with steady results.")).toEqual([]);
  });

  it("a pending non-conditional example lead-in is still detected", () => {
    // "plans to" in a non-conditional frame is an unfinished example setup
    // (no substantive completed example / outcome).
    expect(unfinishedCodes("Consider a local boutique that plans to test weekly video posts to grow its audience.")).not.toEqual([]);
  });

  it("a genuinely unfinished example lead-in is still detected", () => {
    // A fragment with no substantive completed example / no terminal predicate
    // is a hard coherence failure (incomplete-sentence and/or unfinished-example).
    for (const text of [
      "For example, a local bakery that wants to grow its following",
      "For example, consider how a brand could",
    ]) {
      const violations = validateCoherence(makeDoc([{ id: "b0", type: "paragraph", text }]));
      expect(violations.length, text).toBeGreaterThan(0);
      expect(violations.some((v) => v.type === "incomplete-sentence" || v.type === "unfinished-example"), text).toBe(true);
    }
  });

  it("the production sentence survives paragraph splitting cleanly", () => {
    const long = [
      PRODUCTION,
      "Teams that post every day see steady replies from their audience.",
      "Owners can review which conversations lead to profile visits or enquiries.",
      "A small weekly plan keeps the work steady without adding stress.",
    ].join(" ");
    const html = `<!-- wp:paragraph --><p>${long}</p><!-- /wp:paragraph -->`;
    const { html: split, splitCount } = splitLongParagraphs(html, 3);
    expect(splitCount).toBeGreaterThan(0);
    expect(validateWordpressBlockPairs(split).valid).toBe(true);
    const blocks = [...split.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m, i) => ({ id: `b${i}`, type: "paragraph" as const, text: m[1].trim() }));
    expect(validateCoherence(makeDoc(blocks))).toEqual([]);
  });

  it("valid example prose in a full article is not flagged", () => {
    const doc = makeDoc([
      { id: "section-2-wp-3", type: "paragraph", text: PRODUCTION },
      { id: "section-2-wp-4", type: "paragraph", text: "For example, you can start with one small post and review the replies each week." },
      { id: "section-2-wp-5", type: "paragraph", text: "This helps owners learn what their audience actually wants." },
    ]);
    expect(validateCoherence(doc).some((v) => v.type === "unfinished-example")).toBe(false);
  });

  it("other coherence rules (orphan-transition) are unchanged", () => {
    const doc = makeDoc([
      { id: "b0", type: "paragraph", text: "So, teams should review their results every single week." },
      { id: "b1", type: "paragraph", text: "A useful filler paragraph with enough content to keep the section substantive." },
    ]);
    expect(validateCoherence(doc).some((v) => v.type === "orphan-transition")).toBe(true);
  });
});
