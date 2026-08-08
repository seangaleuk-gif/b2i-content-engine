import { describe, it, expect } from "vitest";
import type { ArticleDocument, ArticleSection } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  renderFaqSchema,
  parseArticleDocumentFromHtml,
  countCanonicalVisibleWords,
  extractVisibleFaqFromArticle,
  validateFaqParity,
  fingerprintHtml,
} from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { assertFinalEditorialBoundary } from "@/lib/pipeline/blog-generation-pipeline";
import {
  analyzeCanonicalEnglishCta,
  CANONICAL_ENGLISH_CTA_FINGERPRINT,
  CANONICAL_ENGLISH_CTA_HTML,
} from "@/lib/blog/canonical-cta";
import { englishWordTolerance, dynamicFaqRange } from "@/lib/content-standards";
import { pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

const PROSE_SENTENCES = [
  "A simple marketing plan helps a small business stay consistent and clear.",
  "Local owners can list the questions customers actually ask every week.",
  "Turning those questions into short posts builds trust over time.",
  "A weekly routine keeps the work steady without adding extra stress.",
  "Reviews and replies show that a real person is listening to needs.",
  "Measuring profile visits and messages shows which ideas are working.",
  "Consistency matters more than a single perfect post or large budget.",
  "A clear voice helps a local business stand out in a busy market.",
  "Small steps, repeated regularly, create steady and honest growth.",
  "Focus on the people you serve and the results will follow naturally.",
];

function proseBlock(count: number): string {
  const sentences = [];
  for (let i = 0; i < count; i++) {
    sentences.push(PROSE_SENTENCES[(i + count) % PROSE_SENTENCES.length]);
  }
  return paragraph(sentences.join(" "));
}

function buildCompleteArticle(): ArticleDocument {
  const keyphrase = "hong kong sme marketing";
  const slug = "hong-kong-sme-marketing-practical-local-guide";
  const slugs = pairedSlugs(slug);
  const languageSwitcher = renderLanguageSwitcher({
    currentLanguage: "en",
    englishSlug: slugs.englishSlug,
    chineseSlug: slugs.chineseSlug,
  });

  const sections: ArticleSection[] = [
    { id: "s0", heading: "Why Hong Kong SMEs Need a Plan", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s1", heading: "Steps to a Simple Marketing Routine", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s2", heading: "Measuring What Matters", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s3", heading: "Common Mistakes to Avoid", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s4", heading: "Building a Consistent Local Voice", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s5", heading: "Improving the Plan Over Time", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", blocks: [], status: "generated" },
  ];

  const faqCount = dynamicFaqRange(2500).min;
  const faqs = Array.from({ length: Math.max(4, faqCount) }, (_, index) => ({
    question: `What is practical ${keyphrase} step ${index + 1} for local businesses?`,
    answerHtml: "",
    answerText: `Start with useful routine ${index + 1} and review real customer questions each week.`,
  }));

  const doc: ArticleDocument = {
    metadata: {
      title: `Hong Kong SME Marketing: A Practical Local Guide`,
      slug,
      metaDescription: "A practical guide to marketing for Hong Kong SMEs.",
      excerpt: "A practical local guide.",
      targetWordCount: 2500,
      focusKeyphrase: keyphrase,
    },
    languageSwitcher: {
      id: "sw",
      type: "language-switcher",
      html: languageSwitcher,
      fingerprint: fingerprintHtml(languageSwitcher),
    },
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections,
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    visibleFaq: faqs,
    cta: {
      id: "cta",
      type: "cta",
      html: CANONICAL_ENGLISH_CTA_HTML,
      fingerprint: CANONICAL_ENGLISH_CTA_FINGERPRINT,
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema(faqs),
      fingerprint: "schema",
    },
    insertedLinks: [],
  };

  // Populate sections/intro/conclusion with blocks (each ~3-5 sentences).
  doc.introduction.blocks = parseIntroBlocks(Array.from({ length: 6 }, () => proseBlock(3)).join("\n\n"));
  doc.sections.forEach((section, index) => {
    if (section.sectionType === "faq-heading") return;
    section.blocks = parseIntroBlocks(Array.from({ length: 10 + (index % 2) }, () => proseBlock(3)).join("\n\n"));
  });
  doc.conclusion.blocks = parseIntroBlocks(Array.from({ length: 4 }, () => proseBlock(3)).join("\n\n"));
  return doc;
}

function parseIntroBlocks(html: string): ArticleDocument["introduction"]["blocks"] {
  const blocks: ArticleDocument["introduction"]["blocks"] = [];
  const re = /<!--\s*wp:paragraph\s*-->\s*<p>([\s\S]*?)<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push({ id: `b-${blocks.length}`, type: "paragraph", content: [{ type: "text", text: m[1] }] });
  }
  return blocks;
}

describe("representative complete article regression (final-QC)", () => {
  it("escapes canonical H2 text and decodes it on render-parse-render", () => {
    const doc = buildCompleteArticle();
    doc.sections[0].heading = 'Planning <script>alert("x")</script> & Measurement';
    doc.sections.find((section) => section.sectionType === "faq-heading")!.heading = "Questions & Answers";

    const html = renderArticleDocument(doc);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Planning &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Measurement");
    expect(html).toContain("Questions &amp; Answers");

    const parsed = parseArticleDocumentFromHtml(html, doc);
    expect(parsed.doc?.sections[0].heading).toBe(doc.sections[0].heading);
    expect(parsed.doc?.sections.find((section) => section.sectionType === "faq-heading")?.heading)
      .toBe("Questions & Answers");
    expect(renderArticleDocument(parsed.doc!)).toBe(html);
  });

  it("9+10+11. full document round-trips: switcher, sections, conclusion, 4-6 FAQs, schema, single CTA", () => {
    const doc = buildCompleteArticle();
    const html = renderArticleDocument(doc);
    expect(validateWordpressBlockPairs(html).valid).toBe(true);

    // Exactly one CTA block, one CTA heading, one signup URL.
    const cta = analyzeCanonicalEnglishCta(html);
    expect(cta.valid, cta.issues.join("; ")).toBe(true);
    expect((html.match(/app\.b2ihub\.com\/signup/g) ?? []).length).toBe(1);
    expect(cta.ctaHeadingCount).toBe(1);

    // render → parse → render preserves balanced WP structure.
    const parsed = parseArticleDocumentFromHtml(html, doc);
    expect(parsed.doc).toBeTruthy();
    const reRendered = renderArticleDocument(parsed.doc!);
    expect(validateWordpressBlockPairs(reRendered).valid).toBe(true);

    // FAQ and schema one-to-one and ordered.
    expect(doc.visibleFaq.length).toBeGreaterThanOrEqual(4);
    expect(doc.visibleFaq.length).toBeLessThanOrEqual(6);
    const canonical = extractVisibleFaqFromArticle(html, doc);
    const schemaHtml = extractFaqBlock(html);
    const parity = validateFaqParity(
      canonical.map((e) => ({ question: e.question, answerHtml: "", answerText: e.answerText })),
      schemaHtml,
    );
    expect(parity.valid).toBe(true);
    expect(canonical.length).toBe(doc.visibleFaq.length);
  });

  it("18. a representative complete article passes every hard final gate", () => {
    const doc = buildCompleteArticle();
    const keyphrase = doc.metadata.focusKeyphrase;
    const html = renderArticleDocument(doc);
    const range = englishWordTolerance(2500);
    const metrics = analyzeFinalArticle(
      html,
      keyphrase,
      doc.metadata.title,
      doc.metadata.metaDescription,
      2500,
      countCanonicalVisibleWords(doc),
    );
    const policy = buildPolicy(2500, range.min, range.max, keyphrase);
    const result = evaluatePolicy(metrics, policy);
    // Word count in range.
    expect(countCanonicalVisibleWords(doc)).toBeGreaterThanOrEqual(range.min);
    expect(countCanonicalVisibleWords(doc)).toBeLessThanOrEqual(range.max);
    expect(result.passed, result.reasons.join("; ")).toBe(true);
    expect(metrics.canonicalCtaValid).toBe(true);
    expect(metrics.wpBlockCountMismatch).toBe(false);
    expect(metrics.faqParityValid).toBe(true);
    expect(metrics.longParagraphCount).toBe(0);
  });

  it("rejects a fake CTA satisfied by an unrelated heading or signup-like URL", () => {
    const fake = '<!-- wp:heading {"level":2} --><h2>Ready to grow your brand with B2I Hub?</h2><!-- /wp:heading -->'
      + '<!-- wp:html --><a href="https://app.b2ihub.com/signup-evil">Create Your Free Profile</a><!-- /wp:html -->';
    const analysis = analyzeCanonicalEnglishCta(fake);
    expect(analysis.valid).toBe(false);
    expect(analysis.canonicalBlockCount).toBe(0);
    expect(analysis.exactSignupHrefCount).toBe(0);
  });

  it("rejects signup destinations outside the single canonical CTA", () => {
    const html = CANONICAL_ENGLISH_CTA_HTML
      + '\n<!-- wp:paragraph --><p><a href="https://app.b2ihub.com/signup">Duplicate signup</a></p><!-- /wp:paragraph -->';
    const analysis = analyzeCanonicalEnglishCta(html);
    expect(analysis.valid).toBe(false);
    expect(analysis.signupHrefOutsideCanonicalBlockCount).toBe(1);
  });

  it("blocks invalid protected state before final-document diagnosis", () => {
    const doc = buildCompleteArticle();
    doc.cta = {
      id: "cta",
      type: "cta",
      html: '<!-- wp:html --><div><h2>Ready to grow your brand with Hong Kong creators?</h2><a href="https://app.b2ihub.com/signup">Go</a></div><!-- /wp:html -->',
      fingerprint: "wrong",
    };
    const blog = renderArticleDocument(doc);
    expect(() =>
      assertFinalEditorialBoundary(
        { blog, articleDoc: doc } as unknown as Parameters<typeof assertFinalEditorialBoundary>[0],
      ),
    ).toThrow(/CTA integrity failed/);
  });

  it("blocks an out-of-range canonical FAQ count before final-document diagnosis", () => {
    const doc = buildCompleteArticle();
    doc.visibleFaq = doc.visibleFaq.slice(0, 3);
    doc.faqSchema = {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema(doc.visibleFaq),
      fingerprint: "schema",
    };
    const blog = renderArticleDocument(doc);
    expect(() =>
      assertFinalEditorialBoundary(
        { blog, articleDoc: doc } as unknown as Parameters<typeof assertFinalEditorialBoundary>[0],
      ),
    ).toThrow(/visible FAQ count=3 outside 4-6/);
  });

  it("blocks a noncanonical English language switcher before diagnosis", () => {
    const doc = buildCompleteArticle();
    doc.languageSwitcher = {
      id: "sw",
      type: "language-switcher",
      html: '<!-- wp:html --><div class="b2i-language-switcher"><a href="/blog/wrong-zh">中文</a></div><!-- /wp:html -->',
      fingerprint: "wrong",
    };
    const blog = renderArticleDocument(doc);
    expect(() =>
      assertFinalEditorialBoundary(
        { blog, articleDoc: doc } as unknown as Parameters<typeof assertFinalEditorialBoundary>[0],
      ),
    ).toThrow(/language switcher is not canonical/);
  });
});
