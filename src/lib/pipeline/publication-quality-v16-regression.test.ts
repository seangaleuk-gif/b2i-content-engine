import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  parseArticleDocumentFromHtml,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import { scanSentenceQualityText, scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { validateCoherence } from "@/lib/blog/coherence";
import { removeUnsupportedSentences, scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { normalizeFinalSeo } from "@/lib/blog/final-seo-normalizer";
import { runAudit } from "@/lib/services/seo-auditor";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { analyzeCanonicalEnglishCta } from "@/lib/blog/canonical-cta";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { validateFaqParity, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong marketing trends 2026";

function loadFixture(): { title: string; slug: string; blog: string; faq: unknown[] } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, "../../../fixtures/blog-13-v16.json"), "utf8")
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

function paragraphHtml(text: string): string {
  return `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
}

const emptyChat = async () => {
  throw new Error("no chat in deterministic test");
};

// ── The v16 corruption class is detected ──

describe("publication-quality v16 regression (blog 13, version 16)", () => {
  it("detects every keyphrase-substitution corruption in the saved article", () => {
    const corruptions: Array<{ phrase: string; codes: string[] }> = [
      { phrase: "the broader these market changes picture", codes: ["malformed-noun-phrase"] },
      { phrase: "the this shift landscape", codes: ["duplicated-determiner"] },
      { phrase: "these these 2026 trends", codes: ["duplicated-determiner"] },
      { phrase: "the the city's evolving marketing landscape", codes: ["duplicated-determiner"] },
      { phrase: "the the changing Hong Kong market", codes: ["duplicated-determiner"] },
    ];
    for (const { phrase, codes } of corruptions) {
      const issues = scanSentenceQualityText(`This is part of ${phrase} and it keeps growing.`);
      expect(issues.length, phrase).toBeGreaterThan(0);
      for (const code of codes) {
        expect(issues.map((issue) => issue.code), phrase).toContain(code);
      }
    }
  });

  it("the saved article carries dangling references and unsupported quantitative claims", () => {
    const { blog } = loadFixture();
    expect(blog).toContain("That\u2019s a striking number");
    expect(blog).toContain("bombarded with thousands of messages daily");

    const scan = scanFactualRisks(blog, KEYPHRASE, []);
    expect(scan.claims.some((c) => c.category === "market_wide_claim" && c.text.includes("thousands of messages"))).toBe(true);
  });

  // ── Sentence-aware keyphrase removal ──

  it("keyphrase removal cannot produce doubled determiners or malformed phrases", async () => {
    const paras = [
      "The broader hong kong marketing trends 2026 picture is becoming clear for local teams. Teams that watch this space closely will adapt faster.",
      "The hong kong marketing trends 2026 landscape rewards early adopters. Early adopters test, measure and adjust their plans.",
      "Hong kong marketing trends 2026 shape the city's campaigns. Campaigns that feel local win more trust.",
      "Keep an eye on hong kong marketing trends 2026. The year ahead will reward consistent teams.",
    ];
    const html = paras.map(paragraphHtml).join("\n\n");
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: KEYPHRASE,
      targetWordCount: 200,
      targetKeyphraseCount: 0,
      minReadingEase: 60,
      maxReadingEase: 70,
    }, emptyChat);
    for (const corruption of ["the this", "the the", "these these", "broader these", "this this"]) {
      expect(result.html.toLowerCase()).not.toContain(corruption);
    }
    // Every sentence in the output is an intact original sentence — removal is
    // whole-sentence only, never a mid-phrase substitution.
    const outputSentences = result.html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const sentence of outputSentences) {
      const intact = paras.some((p) => p.split(/(?<=[.!?])\s+/).map((s) => s.trim()).includes(sentence));
      expect(intact, sentence).toBe(true);
    }
  });

  it("sentence casing remains valid after keyphrase removal", async () => {
    const paras = [
      "Hong kong marketing trends 2026 are evolving quickly. Teams that adapt early will keep their edge.",
      "The hong kong marketing trends 2026 landscape is shifting. Local brands that listen will win.",
    ];
    const html = paras.map(paragraphHtml).join("\n\n");
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: KEYPHRASE,
      targetWordCount: 200,
      targetKeyphraseCount: 0,
      minReadingEase: 60,
      maxReadingEase: 70,
    }, emptyChat);
    const readable = result.html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    for (const issue of scanSentenceQualityText(readable)) {
      expect(issue.code, issue.sentence).not.toBe("lowercase-sentence-start");
    }
  });

  it("unsafe SEO removal leaves the paragraph untouched (full prior snapshot preserved)", async () => {
    // The keyphrase sentence is the paragraph's ONLY sentence — no safe
    // removal exists, so the exact text must survive byte-for-byte.
    const only = "The broader hong kong marketing trends 2026 picture is becoming clear for local teams.";
    const html = paragraphHtml(only);
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: KEYPHRASE,
      targetWordCount: 200,
      targetKeyphraseCount: 0,
      minReadingEase: 60,
      maxReadingEase: 70,
    }, emptyChat);
    expect(result.html).toContain(only);
  });

  // ── Dependency-aware claim removal ──

  it("removing the 78% claim cannot leave \u201cThat\u2019s a striking number\u201d dangling", () => {
    const sectionHtml = [
      paragraphHtml("According to the survey, 78% of consumers now expect personalised ads. The shift is real and measurable."),
      paragraphHtml("Source: <a href=\"https://example.com/survey\">Consumer survey</a>."),
      paragraphHtml("That\u2019s a striking number, and it makes sense. In a city where customers are used to speed and choice, a generic message just doesn\u2019t cut it anymore."),
    ].join("\n\n");
    const claim = scanFactualRisks(sectionHtml, KEYPHRASE, []).claims.find((c) => c.text.includes("78%"))!;
    const result = removeUnsupportedSentences(sectionHtml, [claim]);
    expect(result.html).not.toContain("78%");
    expect(result.html).not.toContain("striking number");
    // The remaining sentences of the dependent paragraph survive.
    expect(result.html).toContain("In a city where customers are used to speed and choice");
  });

  it("dependency removal preserves the canonical owner occurrence", () => {
    // An unsupported claim sentence (9.9 million) plus a dependent reference
    // in the next paragraph. The canonical owned occurrence (2.4 million) is
    // preserved verbatim via preserveSentenceTexts.
    const sectionHtml = [
      paragraphHtml("Threads has 9.9 million monthly active users in Hong Kong. This audience gives teams room to grow."),
      paragraphHtml("That number keeps rising, and the trend is clear."),
      paragraphHtml("Threads has 2.4 million monthly active users in Hong Kong according to the official figures."),
    ].join("\n\n");
    const claims = scanFactualRisks(sectionHtml, "threads marketing hong kong", []).claims.filter((c) => !c.supported);
    const result = removeUnsupportedSentences(sectionHtml, claims, {
      preserveSentenceTexts: ["Threads has 2.4 million monthly active users in Hong Kong according to the official figures."],
    });
    expect(result.html).not.toContain("9.9 million");
    expect(result.html).not.toContain("That number keeps rising");
    expect(result.html).toContain("Threads has 2.4 million monthly active users in Hong Kong according to the official figures.");
  });

  // ── Final canonical QC scan ──

  it("the final canonical coherence and malformed scans run after all mutating stages", () => {
    const doc = parseFixture();
    // The authoritative scan triples run on the final canonical document.
    expect(validateCoherence(doc)).toBeDefined();
    expect(scanMalformedProseInDocument(doc)).toBeDefined();
    expect(scanSentenceQualityInDocument(doc)).toBeDefined();
    // The saved v16 article is itself corrupted, so the final scan must find
    // unresolved sentence-quality violations in it.
    const sentenceQuality = scanSentenceQualityInDocument(doc);
    expect(sentenceQuality.length).toBeGreaterThan(0);
    expect(
      sentenceQuality.flatMap((block) => block.issues.map((issue) => issue.code)),
    ).toContain("duplicated-determiner");
  });

  // ── Absolute claims require equally strong evidence ──

  it("absolute claims such as \u201csimply don\u2019t work anymore\u201d require equally strong evidence", () => {
    const claim = "Banner ads and interruptive promotions simply don\u2019t work anymore for Hong Kong consumers.";
    const html = paragraphHtml(claim);
    // Ad-fatigue evidence alone is NOT enough.
    const weak = scanFactualRisks(html, KEYPHRASE, [
      { title: "Ad fatigue study", snippet: "Hong Kong consumers are tired of banner ads and often skip them.", url: "https://example.com/fatigue" },
    ]);
    expect(weak.claims.some((c) => c.category === "market_wide_claim" && !c.supported)).toBe(true);
    // Evidence asserting the same absolute strength IS enough.
    const strong = scanFactualRisks(html, KEYPHRASE, [
      { title: "Format study", snippet: "Banner ads and interruptive promotions simply don\u2019t work anymore for Hong Kong consumers, the study found.", url: "https://example.com/format" },
    ]);
    expect(strong.claims.some((c) => c.category === "market_wide_claim" && c.supported)).toBe(true);
  });

  it("\u201cthousands of messages daily\u201d is detected as a quantitative market claim", () => {
    const html = paragraphHtml("In a city where consumers are bombarded with thousands of messages daily, the brands that win feel genuinely local.");
    const scan = scanFactualRisks(html, KEYPHRASE, []);
    expect(scan.claims.some((c) => c.category === "market_wide_claim" && !c.supported)).toBe(true);
  });

  // ── Word-count unification ──

  it("the canonical counter measures the saved v16 document at 2,851 words", () => {
    const doc = parseFixture();
    const canonical = countCanonicalVisibleWords(doc);
    expect(canonical).toBe(2851);
    // The audit's own check uses the same canonical counter.
    const { title, blog, faq } = loadFixture();
    const result = runAudit({
      title,
      metaDescription: "Hong Kong Marketing Trends 2026.",
      keyword: KEYPHRASE,
      blog,
      faq: faq as Array<{ question: string; answer: string }>,
      targetWordCount: 2500,
      targetKeyphraseCount: 5,
    });
    const wordCheck = result.checks.find((c) => c.id === "word_count")!;
    expect(wordCheck.measuredValue).toContain("2,851");
  });

  // ── Version-16 improvements are preserved ──

  it("version 16 improvements are preserved: editorial H2, title casing, FAQs, CTA, no boilerplate", () => {
    const { title, blog } = loadFixture();
    expect(title).toBe("Hong Kong Marketing Trends 2026: Top Insights");
    expect(blog).toContain("Hong Kong Marketing Trends 2026");
    expect(blog).not.toContain("views, information");
    expect((blog.match(/faq-item/g) ?? []).length).toBe(6);
    expect((blog.match(/app\.b2ihub\.com\/signup/g) ?? []).length).toBe(1);
    expect(validateWordpressBlockPairs(blog).valid).toBe(true);
    const cta = analyzeCanonicalEnglishCta(blog);
    expect(cta.valid, cta.issues.join("; ")).toBe(true);
    const doc = parseFixture();
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
    // The keyphrase sits in a normal editorial H2 (not the FAQ heading).
    const editorialHeadings = doc.sections
      .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
      .map((s) => s.heading);
    expect(editorialHeadings.some((h) => h.toLowerCase().includes(KEYPHRASE))).toBe(true);
  });
});
