import { describe, expect, it } from "vitest";
import { scanSentenceQualityText } from "@/lib/blog/sentence-quality";
import { findMalformedProseTextIssues } from "@/lib/blog/publication-quality";
import {
  assessSourceSectionRelevance,
  assessSectionTopicGrounding,
  removeOffTopicSourceCitations,
} from "@/lib/blog/content-relevance";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { parseArticleDocumentFromHtml, renderArticleDocument } from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong marketing trends 2026";

function renderSectionText(doc: ArticleDocument, sectionId: string): string {
  const section = doc.sections.find((s) => s.id === sectionId)!;
  return section.blocks
    .map((block) => (block.type === "paragraph" ? block.content.map((node) => node.text).join("") : ""))
    .join(" ");
}

function paragraph(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function buildDoc(): ArticleDocument {
  return {
    metadata: {
      title: "Hong Kong Marketing Trends 2026",
      slug: "hong-kong-marketing-trends-2026",
      metaDescription: "A practical guide.",
      excerpt: "A practical guide.",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraph("i-1", "This guide covers the Hong Kong marketing trends 2026 landscape.")], status: "generated" },
    sections: [
      {
        id: "section-0",
        heading: "AI and Personalisation: Smarter Marketing",
        headingLevel: 2,
        sectionType: "main",
        blocks: [
          paragraph("s0-1", "The brands that win are those that combine AI-driven insights with a human touch."),
          paragraph("s0-2", "As the digital marketing trends in Hong Kong evolve, personalisation matters more."),
          {
            id: "s0-source",
            type: "paragraph",
            content: [
              { type: "text", text: "Source: " },
              { type: "link", text: "Hong Kong AI Marketing", href: "https://example.com/ai-marketing", sourceType: "editorial-external" },
              { type: "text", text: "." },
            ],
          },
        ],
        status: "generated",
      },
      {
        id: "section-1",
        heading: "Immersive Experiences: AR and Interactive Content",
        headingLevel: 2,
        sectionType: "main",
        blocks: [
          paragraph("s1-1", "AR lets customers try products before they buy, which builds genuine engagement."),
          {
            id: "s1-source",
            type: "paragraph",
            content: [
              { type: "text", text: "Source: " },
              { type: "link", text: "AR Marketing", href: "https://stateglobe.example/ar-in-marketing", sourceType: "editorial-external" },
              { type: "text", text: "." },
            ],
          },
        ],
        status: "generated",
      },
    ],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [paragraph("c-1", "Start small and stay consistent.")], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("final-QC calibration (live-generation false positives)", () => {
  it("does not flag the legitimate relative construction \u201cthose that\u201d as a duplicated determiner", () => {
    const issues = scanSentenceQualityText("The brands that win are those that combine AI-driven insights with a human touch.");
    expect(issues.some((i) => i.code === "duplicated-determiner")).toBe(false);
    expect(issues).toEqual([]);
    // Genuine corruptions are still caught.
    expect(scanSentenceQualityText("This is part of the this shift landscape.").some((i) => i.code === "duplicated-determiner")).toBe(true);
    expect(scanSentenceQualityText("These these 2026 trends matter.").some((i) => i.code === "duplicated-determiner")).toBe(true);
    expect(scanSentenceQualityText("Those those brands win.").some((i) => i.code === "duplicated-determiner")).toBe(true);
  });

  it("a punctuation-only leftover block is detected as malformed prose", () => {
    const issues = findMalformedProseTextIssues(["."]);
    expect(issues.some((i) => i.code === "punctuation-fragment")).toBe(true);
    expect(findMalformedProseTextIssues(["A complete sentence here."]).some((i) => i.code === "punctuation-fragment")).toBe(false);
  });

  it("a source URL with multiple topic rows is judged by its best-matching title", () => {
    const doc = buildDoc();
    const research = [
      { title: "Top 10 Digital Marketing Trends in Hong Kong (2026)", snippet: "Top digital marketing trends for Hong Kong in 2026.", url: "https://stateglobe.example/ar-in-marketing" },
      { title: "How is AR changing digital marketing in Hong Kong?", snippet: "AR and interactive content change how customers engage.", url: "https://stateglobe.example/ar-in-marketing" },
      { title: "How important is data privacy in Hong Kong's digital marketing?", snippet: "Data privacy matters for Hong Kong marketing.", url: "https://stateglobe.example/ar-in-marketing" },
    ];
    // The AR section citation matches the AR-focused variant, not the privacy
    // sibling row, so it is NOT off-topic.
    const violations = assessSourceSectionRelevance(doc, research);
    expect(violations.find((v) => v.url.includes("stateglobe"))).toBeUndefined();
  });

  it("an off-topic pure Source citation is deterministically removed rather than hard-blocking", () => {
    const doc = buildDoc();
    const research = [
      { title: "A completely unrelated cooking blog", snippet: "Recipes for busy families in the city.", url: "https://example.com/ai-marketing" },
    ];
    const violations = assessSourceSectionRelevance(doc, research);
    expect(violations.length).toBeGreaterThan(0);
    const removed = removeOffTopicSourceCitations(doc, violations);
    expect(removed).toBe(1);
    expect(renderSectionText(doc, "section-0")).not.toContain("https://example.com/ai-marketing");
    expect(doc.sections[0].blocks.some((b) => b.id === "s0-source")).toBe(false);
    // The rest of the section is untouched.
    expect(renderSectionText(doc, "section-0")).toContain("The brands that win");
  });

  it("a relevance violation that cannot be removed still blocks (ungrounded section)", () => {
    const doc = buildDoc();
    // Replace section-1's content with prose that shares no topic words with
    // its AR heading, and remove its citation so no removal target exists.
    doc.sections[1].blocks = [
      paragraph("s1-offtopic", "Families enjoy cooking together at the weekend and share recipes with friends."),
      paragraph("s1-offtopic-2", "A kitchen timer and a good playlist make meal prep more pleasant for everyone."),
    ];
    const research = [
      { title: "How is AR changing digital marketing in Hong Kong?", snippet: "AR and interactive content change how customers engage.", url: "https://stateglobe.example/ar-in-marketing" },
    ];
    // No Source: citations in section-1 → no removable target.
    const relevance = assessSourceSectionRelevance(doc, research);
    expect(relevance.filter((v) => v.sectionId === "section-1")).toEqual([]);
    expect(removeOffTopicSourceCitations(doc, relevance)).toBe(0);
    // The section topic-grounding check still flags it: an ungrounded section
    // cannot be repaired by citation removal and must block.
    expect(assessSectionTopicGrounding(doc).some((s) => s.includes("section-1"))).toBe(true);
  });

  it("parse-back integration: relevance uses the canonical document", () => {
    const doc = buildDoc();
    const html = renderArticleDocument(doc);
    const parsed = parseArticleDocumentFromHtml(html, doc);
    expect(parsed.doc).toBeTruthy();
    const research = [
      { title: "How is AR changing digital marketing in Hong Kong?", snippet: "AR and interactive content change how customers engage.", url: "https://stateglobe.example/ar-in-marketing" },
    ];
    const violations = assessSourceSectionRelevance(parsed.doc!, research);
    expect(violations.filter((v) => v.url.includes("stateglobe"))).toEqual([]);
  });
});
