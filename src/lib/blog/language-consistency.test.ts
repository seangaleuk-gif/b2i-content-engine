import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { renderArticleDocument, renderFaqSchema, countCanonicalVisibleWords } from "@/lib/blog/article-document";
import { scanEnglishLanguageConsistency, isMateriallyChinese } from "./language-consistency";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { createPipelineState, runFinalValidation } from "@/lib/pipeline/blog-generation-pipeline";
import { englishWordTolerance } from "@/lib/content-standards";

const KEYPHRASE = "threads marketing hong kong";

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDocument(overrides?: {
  introText?: string;
  slug?: string;
  faqAnswer?: string;
  sectionHeading?: string;
  sectionText?: string;
  title?: string;
  metaDescription?: string;
  conclusionText?: string;
}): ArticleDocument {
  return {
    metadata: {
      title: overrides?.title ?? "Threads Marketing Hong Kong Guide",
      slug: overrides?.slug ?? "threads-marketing-hong-kong",
      metaDescription: overrides?.metaDescription ?? "A practical guide for local teams.",
      excerpt: "A practical guide.",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: {
      id: "ls",
      type: "language-switcher",
      html: '<!-- wp:html --><div class="b2i-language-switcher"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-zh">繁體中文</a></div><!-- /wp:html -->',
      fingerprint: "ls",
    },
    introduction: {
      id: "intro",
      status: "generated",
      blocks: [
        paragraph(
          "intro-1",
          overrides?.introText ??
            "This guide explains how a small team can join useful conversations on Threads in Hong Kong.",
        ),
      ],
    },
    sections: [
      {
        id: "section-0",
        heading: overrides?.sectionHeading ?? "Who Uses Threads in Hong Kong",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph(
            "s0-1",
            overrides?.sectionText ??
              "The audience gives local teams room to test focused conversations.",
          ),
        ],
      },
      {
        id: "faq",
        heading: "Frequently Asked Questions",
        headingLevel: 2,
        sectionType: "faq-heading",
        status: "generated",
        blocks: [],
      },
    ],
    visibleFaq: [
      {
        question: "How should a local team start?",
        answerHtml: "",
        answerText: overrides?.faqAnswer ?? "Start with one useful topic and improve it from real replies.",
      },
    ],
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: [
        paragraph(
          "conc-1",
          overrides?.conclusionText ?? "Start with one useful topic and improve it from real replies.",
        ),
      ],
    },
    cta: null,
    faqSchema: overrides?.faqAnswer
      ? {
          id: "faq-schema",
          type: "faq-schema",
          html: renderFaqSchema([
            { question: "How should a local team start?", answerHtml: "", answerText: overrides.faqAnswer },
          ]),
          fingerprint: "schema",
        }
      : null,
    insertedLinks: [],
  };
}

describe("English language-consistency scanner", () => {
  it("does not flag a pure-English article", () => {
    const violations = scanEnglishLanguageConsistency(makeDocument());
    expect(violations).toEqual([]);
  });

  it("flags a materially Chinese introduction", () => {
    const doc = makeDocument({
      introText:
        "本指南介紹本地小團隊如何在 Threads 上加入有用的對話。了解受眾、訂立簡單的內容計劃，並持續量度回應，是穩步增長的關鍵。",
    });
    const violations = scanEnglishLanguageConsistency(doc);
    const intro = violations.find((v) => v.componentKind === "introduction");
    expect(intro).toBeTruthy();
    expect(intro!.reason).toBe("cjk-prose");
    expect(intro!.componentId).toBe("intro");
  });

  it("flags a Chinese FAQ answer", () => {
    const doc = makeDocument({ faqAnswer: "從一個有用主題開始，並根據真實回覆持續改善。這就是最實際的起步方法。" });
    const violations = scanEnglishLanguageConsistency(doc);
    expect(violations.some((v) => v.componentKind === "faq")).toBe(true);
  });

  it("flags a Chinese section, conclusion, title and meta description", () => {
    const doc = makeDocument({
      sectionText: "本地團隊應先了解受眾，再訂立簡單的內容計劃。持續量度回應有助調整策略。",
      sectionHeading: "本地團隊的實用內容策略",
      conclusionText: "從一個有用主題開始，並根據真實回覆持續改善。",
      title: "香港行銷實用指南",
      metaDescription: "這是一篇為香港中小企而設的實用行銷指南，涵蓋內容計劃、量度與改善。",
    });
    const violations = scanEnglishLanguageConsistency(doc);
    expect(violations.some((v) => v.componentKind === "section")).toBe(true);
    expect(violations.some((v) => v.componentKind === "conclusion")).toBe(true);
    expect(violations.some((v) => v.componentKind === "title")).toBe(true);
    expect(violations.some((v) => v.componentKind === "meta-description")).toBe(true);
  });

  it("flags a -zh slug and a CJK slug", () => {
    const zhSlug = scanEnglishLanguageConsistency(makeDocument({ slug: "threads-marketing-hong-kong-zh" }));
    expect(zhSlug.some((v) => v.reason === "zh-slug")).toBe(true);
    const cjkSlug = scanEnglishLanguageConsistency(makeDocument({ slug: "threads-香港-行銷" }));
    expect(cjkSlug.some((v) => v.reason === "cjk-slug")).toBe(true);
  });

  it("does not flag a short CJK brand-name mention inside an English sentence", () => {
    expect(isMateriallyChinese("B2I Hub works with creators in 香港 to grow local brands.")).toBe(false);
  });

  it("English generation rejects a Chinese introduction or -zh slug at the final hard gate", () => {
    const range = englishWordTolerance(2500);
    for (const bad of [
      {
        introText:
          "本指南介紹本地小團隊如何在 Threads 上加入有用的對話。了解受眾、訂立簡單的內容計劃，並持續量度回應，是穩步增長的關鍵。",
      },
      { slug: "threads-marketing-hong-kong-zh" },
    ]) {
      const doc = makeDocument(bad);
      const state = createPipelineState({
        userId: "u",
        projectId: "p",
        keyphrase: KEYPHRASE,
        requestedWordCount: 2500,
        articleDoc: doc,
        h2Headings: doc.sections.map((s) => s.heading),
        intro: "",
        conclusion: "",
        wordsPerSection: 350,
        exactKeyphraseTarget: 9,
        policy: buildPolicy(2500, range.min, range.max, KEYPHRASE),
        ctx: { research: [] },
        wordMin: range.min,
        wordMax: range.max,
        systemPrompt: "test",
        userMessage: "test",
      });
      state.blog = renderArticleDocument(doc);
      const validation = runFinalValidation(state);
      expect(validation.passed).toBe(false);
      expect(validation.reasons.some((r) => r.includes("language consistency violations"))).toBe(true);
      const evaluated = evaluatePolicy(
        analyzeFinalArticle(
          state.blog,
          KEYPHRASE,
          state.title,
          state.metaDescription,
          2500,
          countCanonicalVisibleWords(doc),
          { articleDoc: doc, research: [] },
        ),
        state.policy,
      );
      expect(evaluated.passed).toBe(false);
      expect(evaluated.reasons.some((r) => r.includes("language consistency violations"))).toBe(true);
    }
  });
});
