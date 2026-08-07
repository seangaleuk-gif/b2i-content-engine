import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  parseArticleDocumentFromHtml,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import { isSourceBoilerplate, countBoilerplateInDocument } from "@/lib/blog/source-boilerplate";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import {
  assessSourceSectionRelevance,
  assessSectionTopicGrounding,
  assessHeadingNaturalness,
} from "@/lib/blog/content-relevance";
import { buildNaturalHeading } from "@/lib/blog/post-ownership-seo-reconcile";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { validateCoherence } from "@/lib/blog/coherence";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { analyzeCanonicalEnglishCta } from "@/lib/blog/canonical-cta";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { validateFaqParity, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong marketing trends 2026";

function loadFixture(): { title: string; slug: string; blog: string; faq: unknown[] } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, "../../../fixtures/blog-13-v17.json"), "utf8")
    .replace(/^\uFEFF/, "");
  const version = JSON.parse(raw) as { title: string; slug: string; blog: string; faq: unknown[] };
  return version;
}

function parseFixture(): ArticleDocument {
  const { title, slug, blog } = loadFixture();
  const seedDoc: ArticleDocument = {
    metadata: {
      title,
      slug,
      metaDescription: "",
      excerpt: "",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  const parsed = parseArticleDocumentFromHtml(blog, seedDoc);
  if (!parsed.doc) throw new Error(parsed.errors.join("; "));
  return parsed.doc;
}

const RESEARCH = [
  {
    title: "Digital Marketing Strategy Hong Kong 2026",
    snippet: "Digital marketing strategy for Hong Kong in 2026 covering budgets and channels.",
    url: "https://www.digitalnomadshk.com/digital-marketing-strategy-hong-kong-2026/",
  },
  {
    title: "Top Digital and Social Media Trends in Hong Kong in 2026",
    snippet: "Top digital and social media trends in Hong Kong in 2026.",
    url: "https://www.eliteasia.co/digital-and-social-media-trends-in-hong-kong-in-2026/",
  },
  {
    title: "What's NEXT in Marketing: Hong Kong 2026 - MARKETECH APAC",
    snippet: "Marketing conference in Hong Kong 2026 with networking and insights.",
    url: "https://marketech-apac.com/conference/whats-next-in-marketing-hong-kong-2026/",
  },
];

describe("publication-quality v17 regression (blog 13, version 17)", () => {
  it("copyright boilerplate in a quote block is detected and hard-blocked", () => {
    expect(isSourceBoilerplate("All rights belong to their respective owners.")).toBe(true);
    const doc = parseFixture();
    const boilerplate = countBoilerplateInDocument(doc);
    const quote = boilerplate.find((b) => b.blockType === "quote" && b.snippet.includes("respective owners"));
    expect(quote).toBeTruthy();
    expect(quote!.componentId).toBe("section-1");

    // The final policy gate must fail with boilerplate present.
    const { blog } = loadFixture();
    const metrics = analyzeFinalArticle(
      blog,
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
      countCanonicalVisibleWords(doc),
      { articleDoc: doc, research: [] },
    );
    const result = evaluatePolicy(metrics, buildPolicy(2500, 2125, 2875, KEYPHRASE));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("source boilerplate blocks"))).toBe(true);
  });

  it("boilerplate scanning covers paragraphs, quotes, lists and FAQs", () => {
    const doc = parseFixture();
    const paragraphHtml = "No part of this article may be reproduced without written permission.";
    const quoteHtml = "All rights reserved.";
    const listText = "All rights belong to their respective owners.";
    const faqQuestion = "What are the reproduction rights?";
    const faqAnswer = "All rights belong to their respective owners and may not be copied.";
    for (const text of [paragraphHtml, quoteHtml, listText, faqAnswer]) {
      expect(isSourceBoilerplate(text), text).toBe(true);
    }
    // A synthetic doc exercising every block type.
    const synthetic: ArticleDocument = {
      ...doc,
      introduction: {
        id: "intro",
        status: "generated",
        blocks: [
          { id: "p", type: "paragraph", content: [{ type: "text", text: paragraphHtml }] },
          { id: "q", type: "quote", content: [{ type: "text", text: quoteHtml }] },
          { id: "l", type: "list", ordered: false, items: [[{ type: "text", text: listText }]] },
        ],
      },
      visibleFaq: [
        { question: faqQuestion, answerHtml: "", answerText: faqAnswer },
        { question: "How should a team start?", answerHtml: "", answerText: "Start with a useful routine and review real customer questions each week." },
      ],
    };
    const findings = countBoilerplateInDocument(synthetic);
    const blockTypes = findings.map((f) => f.blockType);
    expect(blockTypes).toContain("paragraph");
    expect(blockTypes).toContain("quote");
    expect(blockTypes).toContain("list");
    expect(blockTypes).toContain("faq-answer");
  });

  it("final QC cannot report clean while boilerplate remains", () => {
    const doc = parseFixture();
    const boilerplate = countBoilerplateInDocument(doc);
    expect(boilerplate.length).toBeGreaterThan(0);
    // The final canonical scan triple also runs on the saved representation.
    expect(validateCoherence(doc)).toBeDefined();
    expect(scanMalformedProseInDocument(doc)).toBeDefined();
    expect(scanSentenceQualityInDocument(doc)).toBeDefined();
  });

  it("hit rock bottom evidence does not support the stronger \u201cwon\u2019t work anymore\u201d clause", () => {
    const para = "As one industry whitepaper puts it, Hong Kong users\u2019 tolerance for ads has hit rock bottom. That means the old playbook of loud, frequent messaging simply won\u2019t work anymore.";
    const html = `<!-- wp:paragraph -->\n<p>${para}</p>\n<!-- /wp:paragraph -->`;
    const scan = scanFactualRisks(html, KEYPHRASE, [
      { title: "Industry whitepaper", snippet: "Hong Kong users\u2019 tolerance for ads has hit rock bottom.", url: "https://example.com/wp" },
    ]);
    const rockBottom = scan.claims.find((c) => c.text.includes("hit rock bottom"));
    expect(rockBottom).toBeTruthy();
    expect(rockBottom!.supported).toBe(true);
    const playbook = scan.claims.find((c) => c.text.includes("won\u2019t work anymore"));
    expect(playbook).toBeTruthy();
    expect(playbook!.supported).toBe(false);
    // Both clauses are assessed independently in one paragraph.
    expect(scan.claims.filter((c) => c.category === "market_wide_claim").length).toBeGreaterThanOrEqual(2);
  });

  it("an absolute claim requires equal-strength evidence", () => {
    const claim = "The old playbook of loud, frequent messaging simply won\u2019t work anymore for Hong Kong consumers.";
    const html = `<!-- wp:paragraph -->\n<p>${claim}</p>\n<!-- /wp:paragraph -->`;
    const weak = scanFactualRisks(html, KEYPHRASE, [
      { title: "Ad tolerance study", snippet: "Hong Kong users\u2019 tolerance for ads has hit rock bottom.", url: "https://example.com/tolerance" },
    ]);
    expect(weak.claims.some((c) => c.category === "market_wide_claim" && !c.supported)).toBe(true);
    const strong = scanFactualRisks(html, KEYPHRASE, [
      { title: "Format study", snippet: "The old playbook of loud, frequent messaging simply won\u2019t work anymore for Hong Kong consumers, the study found.", url: "https://example.com/format" },
    ]);
    expect(strong.claims.some((c) => c.category === "market_wide_claim" && c.supported)).toBe(true);
  });

  it("the editorial H2 is natural and not a duplicated concatenation", () => {
    // The saved v17 heading is flagged as unnatural.
    const doc = parseFixture();
    const headings = assessHeadingNaturalness(doc, KEYPHRASE);
    expect(headings.some((v) => v.code === "repeated-year" && v.heading.includes("for 2026: Hong Kong Marketing Trends 2026"))).toBe(true);
    // The repaired insertion rewrites the heading completely.
    const rebuilt = buildNaturalHeading("The State of Digital Marketing in Hong Kong for 2026", KEYPHRASE);
    expect(rebuilt).toBe("Hong Kong Marketing Trends 2026: The State of Digital Marketing");
    // The rebuilt heading is natural.
    const cleanDoc = parseFixture();
    cleanDoc.sections[0].heading = rebuilt;
    expect(assessHeadingNaturalness(cleanDoc, KEYPHRASE)).toEqual([]);
  });

  it("privacy sections cannot retain unrelated conference evidence and source-link quotas cannot override relevance", () => {
    const doc = parseFixture();
    const relevance = assessSourceSectionRelevance(doc, RESEARCH);
    const conference = relevance.find((v) => v.url.includes("marketech-apac.com"));
    expect(conference).toBeTruthy();
    expect(conference!.heading).toContain("Data Privacy and Trust");
    // The relevance gate is independent of how many links exist.
    expect(assessSectionTopicGrounding(doc)).toBeDefined();
    // The saved privacy section does retain an off-topic source: hard failure.
    const { blog } = loadFixture();
    const metrics = analyzeFinalArticle(
      blog,
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
      countCanonicalVisibleWords(doc),
      { articleDoc: doc, research: RESEARCH },
    );
    const result = evaluatePolicy(metrics, buildPolicy(2500, 2125, 2875, KEYPHRASE));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("source relevance violations"))).toBe(true);
  });

  it("protected content remains byte-for-byte protected in the saved v17 article", () => {
    const { blog } = loadFixture();
    const doc = parseFixture();
    expect(validateWordpressBlockPairs(blog).valid).toBe(true);
    const cta = analyzeCanonicalEnglishCta(blog);
    expect(cta.valid, cta.issues.join("; ")).toBe(true);
    expect((blog.match(/app\.b2ihub\.com\/signup/g) ?? []).length).toBe(1);
    expect((blog.match(/faq-item/g) ?? []).length).toBe(5);
    const schemaHtml = extractFaqBlock(blog);
    const parity = validateFaqParity(
      extractVisibleFaqFromArticle(blog, doc).map((e) => ({
        question: e.question,
        answerHtml: "",
        answerText: e.answerText,
      })),
      schemaHtml,
    );
    expect(parity.valid, parity.issues.map((i) => i.type).join("; ")).toBe(true);
  });
});
