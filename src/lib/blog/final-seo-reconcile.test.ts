import { describe, expect, it } from "vitest";
import type { ArticleDocument, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import { reconcileFinalKeyphraseDensity, canonicalKeyphraseMetrics } from "./final-seo-reconcile";
import { analyzeFinalArticle } from "@/lib/blog/final-article-policy";
import { computeKeyphraseDensity, englishWordTolerance } from "@/lib/content-standards";
import { shouldAcceptSeoNormalization } from "@/lib/pipeline/blog-generation-pipeline";
import {
  normalizeFinalSeo,
  tokenizeProtectedBlocks,
} from "@/lib/blog/final-seo-normalizer";
import { fingerprintHtml, renderFaqSchema } from "@/lib/blog/article-document";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { countExactPhrase, extractReadableText } from "@/lib/seo/seo-text-utils";

const KEYPHRASE = "threads marketing hong kong";
const WORD_MIN = 2125;
const WORD_MAX = 2875;

const KP_SENTENCES = [
  "Threads marketing hong kong gives local teams a clear place to start.",
  "Many brands use threads marketing hong kong to build steady routines.",
  "Threads marketing hong kong works best when the routine stays small.",
  "Owners can apply threads marketing hong kong without a large budget.",
  "Threads marketing hong kong works well with a steady weekly schedule.",
  "A small team can practice threads marketing hong kong every single week.",
  "Threads marketing hong kong helps a business stay visible and honest.",
  "Readers trust brands that explain threads marketing hong kong with simple words.",
  "Threads marketing hong kong turns common questions into useful daily posts.",
  "Starting threads marketing hong kong takes less time than most owners expect.",
  "Threads marketing hong kong pairs well with a short weekly review routine.",
  "Every local owner can make threads marketing hong kong part of the week.",
  "Threads marketing hong kong keeps the brand voice natural and consistent.",
  "Teams that try threads marketing hong kong usually see steady replies.",
  "Threads marketing hong kong makes the daily plan easier to keep.",
  "Threads marketing hong kong is easiest to learn with one small topic.",
  "Most owners notice threads marketing hong kong working within a few weeks.",
  "Threads marketing hong kong stays useful when the advice is practical.",
];

const FILLER_SENTENCES = [
  "Local teams can share useful lessons from daily work with clear and honest words.",
  "Simple examples help busy owners understand the idea and take a practical next step.",
  "Regular replies also show customers that a real person is listening to their needs.",
  "A small weekly plan keeps the work steady without adding stress to the whole team.",
  "Owners can note common questions and turn those questions into helpful future posts.",
  "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
];

function makeParagraph(id: string, sentences: string[]): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text: sentences.join(" ") }] };
}

function makeSection(
  id: string,
  heading: string,
  blocks: EditorialBlock[],
  sectionType: ArticleSection["sectionType"] = "main",
): ArticleSection {
  return { id, heading, headingLevel: 2, sectionType, status: "generated", blocks };
}

function makeDocument(options?: {
  kpSentenceCount?: number;
  singleSentenceParagraphs?: boolean;
}): ArticleDocument {
  const kpCount = options?.kpSentenceCount ?? 18;
  const single = options?.singleSentenceParagraphs ?? false;

  const kpParagraphs: EditorialBlock[] = [];
  for (let index = 0; index < kpCount; index++) {
    const sentence = KP_SENTENCES[index % KP_SENTENCES.length];
    kpParagraphs.push(
      single
        ? makeParagraph(`kp-${index}`, [sentence])
        : makeParagraph(`kp-${index}`, [
            sentence,
            FILLER_SENTENCES[index % FILLER_SENTENCES.length],
            FILLER_SENTENCES[(index + 1) % FILLER_SENTENCES.length],
          ]),
    );
  }

  const fillerParagraphs: EditorialBlock[] = [];
  for (let index = 0; index < 30; index++) {
    fillerParagraphs.push(
      makeParagraph(`fill-${index}`, [
        FILLER_SENTENCES[index % FILLER_SENTENCES.length],
        FILLER_SENTENCES[(index + 1) % FILLER_SENTENCES.length],
        FILLER_SENTENCES[(index + 2) % FILLER_SENTENCES.length],
      ]),
    );
  }

  const introduction: ArticleDocument["introduction"] = {
    id: "intro",
    status: "generated",
    blocks: [
      makeParagraph("intro-open", ["This guide gives local owners a clear and honest starting point."]),
      ...kpParagraphs.slice(0, 2),
      ...fillerParagraphs.slice(0, 3),
    ],
  };

  const sections: ArticleSection[] = [
    makeSection("section-0", "Understand the People You Want to Reach", [
      ...kpParagraphs.slice(2, 7),
      ...fillerParagraphs.slice(3, 10),
    ]),
    makeSection("section-1", "Build a Simple Weekly Content Routine", [
      ...kpParagraphs.slice(7, 12),
      ...fillerParagraphs.slice(10, 17),
    ]),
    makeSection("section-2", "Measure Results and Improve the Next Post", [
      ...kpParagraphs.slice(12, 17),
      ...fillerParagraphs.slice(17, 24),
    ]),
    makeSection("section-3", "Common Mistakes Hong Kong SMEs Should Avoid", [
      ...kpParagraphs.slice(17, 18),
      ...fillerParagraphs.slice(24, 30),
    ]),
    makeSection("faq-section", "Frequently Asked Questions", [], "faq-heading"),
  ];

  const conclusion: ArticleDocument["conclusion"] = {
    id: "conclusion",
    status: "generated",
    blocks: [
      makeParagraph("conc-1", [
        "A useful plan does not need a large team or an expensive campaign.",
        FILLER_SENTENCES[3],
        FILLER_SENTENCES[4],
      ]),
    ],
  };

  const visibleFaq = [1, 2, 3, 4].map((index) => ({
    question: `What should a Hong Kong SME know first ${index}?`,
    answerHtml: "",
    answerText: "Start with a small and useful routine. Listen to real customer questions and reply in a natural voice.",
  }));

  return {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "A practical guide for Hong Kong SMEs.",
      excerpt: "A practical guide for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: fingerprintHtml(`<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-guide-zh">繁體中文</a></div><!-- /wp:html -->`),
    },
    introduction,
    sections,
    visibleFaq,
    conclusion,
    cta: {
      id: "cta",
      type: "cta",
      html: `<!-- wp:html --><div class="cta-block"><h2>Ready to Start?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->`,
      fingerprint: fingerprintHtml(`<!-- wp:html --><div class="cta-block"><h2>Ready to Start?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->`),
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema(visibleFaq),
      fingerprint: fingerprintHtml(renderFaqSchema(visibleFaq)),
    },
    insertedLinks: [],
  };
}

describe("final-seo-reconcile: canonical density math", () => {
  it("the reported 2.91% → 3.16% trim crossing is a real density trajectory", () => {
    // Observed production sequence: 18 occurrences, keyphrase with 5 content
    // words; final trim removes 254 non-keyphrase words without removing an
    // occurrence, raising density from 2.91% to 3.16%.
    const keyphrase = "hong kong marketing trends 2026";
    const beforeTrim = computeKeyphraseDensity(18, keyphrase, 3093);
    const afterTrim = computeKeyphraseDensity(18, keyphrase, 2849);
    expect(beforeTrim).toBeCloseTo(2.91, 1);
    expect(afterTrim).toBeCloseTo(3.16, 2);
    expect(beforeTrim).toBeLessThanOrEqual(3);
    expect(afterTrim).toBeGreaterThan(3);
  });

  it("the reconciliation and the final gate use the identical density calculation", () => {
    const doc = makeDocument();
    const metrics = canonicalKeyphraseMetrics(doc, KEYPHRASE);
    const gate = analyzeFinalArticle(
      renderArticleDocument(doc),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
      countCanonicalVisibleWords(doc),
    );
    expect(metrics.wordCount).toBe(gate.readableWordCount);
    expect(metrics.occurrences).toBe(gate.exactKeyphraseCount);
    expect(metrics.density).toBe(gate.keyphraseDensity);

    // The identity must hold on the reconciled document as well.
    const result = reconcileFinalKeyphraseDensity(doc, KEYPHRASE, [], undefined, WORD_MIN, WORD_MAX);
    expect(result.accepted).toBe(true);
    const afterMetrics = canonicalKeyphraseMetrics(doc, KEYPHRASE);
    const afterGate = analyzeFinalArticle(
      renderArticleDocument(doc),
      KEYPHRASE,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
      countCanonicalVisibleWords(doc),
    );
    expect(afterMetrics.density).toBe(afterGate.keyphraseDensity);
    expect(afterGate.keyphraseDensity).toBeLessThanOrEqual(3);
  });
});

describe("final-seo-reconcile: deterministic density reduction", () => {
  it("detects trim-raised stuffing (density above 3%) and reduces occurrences safely", () => {
    const doc = makeDocument();
    const before = canonicalKeyphraseMetrics(doc, KEYPHRASE);
    expect(before.density).toBeGreaterThan(3);
    expect(before.occurrences).toBeGreaterThan(10);

    const result = reconcileFinalKeyphraseDensity(doc, KEYPHRASE, [], undefined, WORD_MIN, WORD_MAX);

    expect(result.accepted).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.removedSentences).toBeGreaterThan(0);
    expect(result.selectedBlocks.length).toBeGreaterThan(0);
    expect(result.rejectionReasons).toEqual([]);

    const after = canonicalKeyphraseMetrics(doc, KEYPHRASE);
    expect(after.density).toBeLessThanOrEqual(3);
    expect(after.occurrences).toBeLessThan(before.occurrences);
    expect(after.wordCount).toBeGreaterThanOrEqual(WORD_MIN);
    expect(after.wordCount).toBeLessThanOrEqual(WORD_MAX);
    expect(after.wordCount).toBeLessThan(before.wordCount);
  });

  it("stops exactly at the hard limit and never removes more than needed", () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = makeDocument();
      reconcileFinalKeyphraseDensity(doc, KEYPHRASE, [], undefined, WORD_MIN, WORD_MAX);
      const after = canonicalKeyphraseMetrics(doc, KEYPHRASE);
      expect(after.density).toBeLessThanOrEqual(3);
      // One more removal must never be needed once density is inside the limit.
      const finalRender = renderArticleDocument(doc);
      const editable = (() => {
        const { content } = tokenizeProtectedBlocks(finalRender);
        return countExactPhrase(extractReadableText(content), KEYPHRASE);
      })();
      expect(editable).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves a document already inside the hard limit untouched", () => {
    const doc = makeDocument({ kpSentenceCount: 5 });
    const beforeMetrics = canonicalKeyphraseMetrics(doc, KEYPHRASE);
    expect(beforeMetrics.density).toBeLessThanOrEqual(3);
    const beforeRender = renderArticleDocument(doc);

    const result = reconcileFinalKeyphraseDensity(doc, KEYPHRASE, [], undefined, WORD_MIN, WORD_MAX);

    expect(result.accepted).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.removedSentences).toBe(0);
    expect(renderArticleDocument(doc)).toBe(beforeRender);
  });

  it("keeps protected links, quotations, CTA, FAQ/schema, switcher and WordPress structure unchanged", () => {
    const doc = makeDocument();
    const linkedParagraph: Extract<EditorialBlock, { type: "paragraph" }> = {
      id: "linked-1",
      type: "paragraph",
      content: [
        { type: "text", text: "Brands that plan ahead usually see better results with a steady routine. Read the " },
        { type: "link", text: "full guide", href: "/blog/threads-guide", sourceType: "internal" },
        { type: "text", text: " before you start. Simple examples help busy owners understand the idea and take a practical next step." },
      ],
    };
    doc.sections[0].blocks.push(linkedParagraph);
    const quotedParagraph: Extract<EditorialBlock, { type: "quote" }> = {
      id: "quote-1",
      type: "quote",
      content: [{ type: "text", text: "Consistency matters more than a single perfect post." }],
    };
    doc.sections[1].blocks.push(quotedParagraph);

    const protectedBefore = JSON.stringify({
      languageSwitcher: doc.languageSwitcher,
      cta: doc.cta,
      visibleFaq: doc.visibleFaq,
      faqSchema: doc.faqSchema,
      metadata: doc.metadata,
    });
    const collectLinkHrefs = (source: ArticleDocument): string[] =>
      source.sections.flatMap((section) =>
        section.blocks.flatMap((block) => {
          if (!("content" in block)) return [];
          return block.content
            .filter((node) => node.type === "link")
            .map((node) => (node as { href?: string }).href ?? "");
        }),
      ).sort();
    const linksBefore = collectLinkHrefs(doc);
    const quoteTextBefore = "Consistency matters more than a single perfect post.";
    const renderBefore = renderArticleDocument(doc);

    const result = reconcileFinalKeyphraseDensity(doc, KEYPHRASE, [], undefined, WORD_MIN, WORD_MAX);
    expect(result.accepted).toBe(true);
    expect(result.applied).toBe(true);

    expect(JSON.stringify({
      languageSwitcher: doc.languageSwitcher,
      cta: doc.cta,
      visibleFaq: doc.visibleFaq,
      faqSchema: doc.faqSchema,
      metadata: doc.metadata,
    })).toBe(protectedBefore);
    expect(collectLinkHrefs(doc)).toEqual(linksBefore);
    const quoteAfter = doc.sections
      .flatMap((section) => section.blocks)
      .find((block) => block.type === "quote" && block.content.map((node) => node.text).join("").trim() === quoteTextBefore);
    expect(quoteAfter).toBeDefined();
    expect(validateWordpressBlockPairs(renderArticleDocument(doc)).valid).toBe(true);
    expect(renderArticleDocument(doc)).not.toBe(renderBefore);
  });

  it("fails closed with the document unchanged when no safe correction exists", () => {
    const doc = makeDocument({ singleSentenceParagraphs: true });
    const before = canonicalKeyphraseMetrics(doc, KEYPHRASE);
    expect(before.density).toBeGreaterThan(3);
    const renderBefore = renderArticleDocument(doc);

    const result = reconcileFinalKeyphraseDensity(doc, KEYPHRASE, [], undefined, WORD_MIN, WORD_MAX);

    expect(result.accepted).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.rejectionReasons.length).toBeGreaterThan(0);
    expect(result.rejectionReasons.some((reason) => reason.includes("no safely removable"))).toBe(true);
    expect(renderArticleDocument(doc)).toBe(renderBefore);
  });
});

describe("final-seo-reconcile: stage ownership", () => {
  it("a safe density reduction is not rejected because the word count is still above the maximum (final trim owns it) or the H2 signal is soft", async () => {
    const paragraphs = Array.from({ length: 25 }, (_, index) =>
      `${KP_SENTENCES[index % KP_SENTENCES.length]} ${FILLER_SENTENCES[index % FILLER_SENTENCES.length]} ${FILLER_SENTENCES[(index + 1) % FILLER_SENTENCES.length]}`,
    );
    const body = paragraphs
      .map((text) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`)
      .join("\n\n");
    const html = `<!-- wp:html -->
<div class="b2i-language-switcher" data-language="en">
  <span>English</span> | <a href="/blog/test-post-zh">繁體中文</a>
</div>
<!-- /wp:html -->

<!-- wp:html -->
<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>
<!-- /wp:html -->

<!-- wp:heading {"level":2} -->
<h2>Practical Content Plans for Local Teams</h2>
<!-- /wp:heading -->

${body}`;

    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: KEYPHRASE,
      targetWordCount: 500,
      targetKeyphraseCount: 2,
      minReadingEase: 60,
      maxReadingEase: 70,
    });

    // Word count is still far above the 500-word maximum (the later
    // deterministic final trim owns that resolution) and no H2 carries the
    // exact keyphrase (soft). The safe density reduction must still commit.
    const tolerance = englishWordTolerance(500);
    expect(result.after.readableWordCount).toBeGreaterThan(tolerance.max);
    expect(result.after.exactKeyphraseInH2).toBe(false);
    expect(result.after.exactKeyphraseCount).toBeLessThan(result.before.exactKeyphraseCount);
    expect(result.passed).toBe(true);
    expect(shouldAcceptSeoNormalization(result)).toBe(true);
  });
});
