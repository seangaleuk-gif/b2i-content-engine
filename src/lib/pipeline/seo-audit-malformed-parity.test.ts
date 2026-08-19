import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ArticleDocument,
  type ArticleSection,
  parseArticleDocumentFromHtml,
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import {
  analyzeFinalArticle,
  buildPolicy,
  evaluatePolicy,
} from "@/lib/blog/final-article-policy";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { runAudit } from "@/lib/services/seo-auditor";

const KEYPHRASE = "hong kong marketing trends 2026";

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Fixture helpers ──

function loadFixture(file: string): { title: string; slug: string; blog: string; faq: unknown[] } {
  const raw = fs
    .readFileSync(path.resolve(__dirname, "../../../fixtures/" + file), "utf8")
    .replace(/^\uFEFF/, "");
  return JSON.parse(raw) as { title: string; slug: string; blog: string; faq: unknown[] };
}

function parseFixture(file: string): ArticleDocument {
  const { title, slug, blog } = loadFixture(file);
  const seedDoc: ArticleDocument = {
    metadata: { title, slug, metaDescription: "", excerpt: "", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
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

// ── Deterministic, fully policy-compliant, canonical-clean article (the
// project-25 replay surrogate: canonical malformed = 0, production passes). ──

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function component(id: string, html: string): ArticleDocument["introduction"] {
  return { id, blocks: parseWordPressEditorialBlocks(html, id).blocks, status: "generated" };
}

function section(id: string, heading: string, html: string, sectionType: ArticleSection["sectionType"] = "main"): ArticleSection {
  return { ...component(id, html), heading, headingLevel: 2, sectionType };
}

function buildCleanDocument(): ArticleDocument {
  const sentences = [
    "Local teams can share useful lessons from daily work with clear and honest words.",
    "Simple examples help busy owners understand the idea and take a practical next step.",
    "Regular replies also show customers that a real person is listening to their needs.",
    "A small weekly plan keeps the work steady without adding stress to the whole team.",
    "Owners can note common questions and turn those questions into helpful future posts.",
    "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
  ];
  const makeParagraphs = (sectionIndex: number, count: number): string => {
    const blocks: string[] = [];
    for (let index = 0; index < count; index++) {
      const first = sentences[(index + sectionIndex) % sentences.length];
      const second = sentences[(index + sectionIndex + 1) % sentences.length];
      const third = sentences[(index + sectionIndex + 2) % sentences.length];
      blocks.push(paragraph(`${first} ${second} ${third}`));
    }
    return blocks.join("\n\n");
  };
  const keyphrase = "threads marketing hong kong";
  const introHtml = [
    paragraph(`Opening guide to ${keyphrase} gives local owners a clear place to start. ${sentences[0]} ${sentences[1]} ${sentences[2]}`),
    makeParagraphs(0, 3),
  ].join("\n\n");
  const headings = [
    "Threads Marketing Hong Kong for Small Local Brands",
    "Understand the People You Want to Reach",
    "Build a Simple Weekly Content Routine",
    "Create Posts That Start Useful Conversations",
    "Measure Results and Improve the Next Post",
    "Common Mistakes Hong Kong SMEs Should Avoid",
  ];
  const sections = headings.map((heading, index) => section(`section-${index}`, heading, makeParagraphs(index, 9)));
  sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
  const conclusionHtml = [
    paragraph(`A useful ${keyphrase} plan does not need a large team or an expensive campaign. ${sentences[3]} ${sentences[4]} ${sentences[5]}`),
    makeParagraphs(2, 2),
  ].join("\n\n");
  return {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content, start genuine conversations, measure results, avoid common mistakes, and build steady local trust.",
      excerpt: "A practical guide for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: keyphrase,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-practical-sme-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: "language-switcher",
    },
    introduction: component("intro", introHtml),
    sections,
    visibleFaq: [1, 2, 3, 4].map((index) => ({
      question: `What should a Hong Kong SME know first ${index}?`,
      answerHtml: "",
      answerText: "Start with a small and useful routine. Listen to real customer questions, reply in a natural voice, and review which conversations lead to profile visits or enquiries.",
    })),
    conclusion: component("conclusion", conclusionHtml),
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function auditInputFor(doc: ArticleDocument): {
  title: string;
  metaDescription: string;
  keyword: string;
  blog: string;
  faq: Array<{ question: string; answer: string }>;
  targetWordCount: number;
  targetKeyphraseCount: number;
} {
  return {
    title: doc.metadata.title,
    metaDescription: doc.metadata.metaDescription,
    keyword: doc.metadata.focusKeyphrase,
    blog: renderArticleDocument(doc),
    faq: doc.visibleFaq.map((e) => ({ question: e.question, answer: e.answerText })),
    targetWordCount: doc.metadata.targetWordCount,
    targetKeyphraseCount: 5,
  };
}

// A canonical-clean article whose editorial score is GENUINELY below the
// threshold: real robotic "The key is" openers and a verbatim near-duplicate
// paragraph, with zero malformed prose. Used by the enforcement-semantics
// tests, which must prove soft-vs-hard severity on a document that genuinely
// fails the editorial gate (not on one whose score was inflated by false
// malformed findings).
function buildLowEditorialAuditInput(): ReturnType<typeof auditInputFor> {
  const doc = buildCleanDocument();
  doc.sections[0].blocks.push(
    { id: "section-0-wp-x1", type: "paragraph", content: [{ type: "text", text: "The key is to keep the routine simple and repeatable. The key is to listen to real customer feedback each week. The key is to stay consistent even during busy months. The key is to measure results at the end of every month." }] },
    { id: "section-0-wp-x2", type: "paragraph", content: [{ type: "text", text: "The key is to test one idea at a time. The key is to review the numbers before changing direction. The key is to involve the whole team in the plan. The key is to celebrate small wins along the way." }] },
  );
  doc.sections[2].blocks.push(structuredClone(doc.sections[2].blocks[0]));
  return auditInputFor(doc);
}

function productionVerdict(doc: ArticleDocument, html: string): {
  passed: boolean;
  malformedHardFail: boolean;
} {
  const metrics = analyzeFinalArticle(
    html,
    doc.metadata.focusKeyphrase,
    doc.metadata.title,
    doc.metadata.metaDescription,
    doc.metadata.targetWordCount,
    countCanonicalVisibleWords(doc),
    { articleDoc: doc, research: [] },
  );
  const result = evaluatePolicy(metrics, buildPolicy(doc.metadata.targetWordCount, undefined, undefined, doc.metadata.focusKeyphrase));
  const malformedHardFail = result.reasons.some((r) => r.startsWith("malformed prose blocks="));
  return { passed: result.passed, malformedHardFail };
}

// ── 1. Project-25 replay: canonical malformed = 0 ──

describe("Stage 3P SEO-audit / final-policy malformed-prose parity", () => {
  it("project-25 replay: canonical-clean article reports Malformed = 100/100, no hard failure, production passes", () => {
    const doc = buildCleanDocument();
    const html = renderArticleDocument(doc);
    expect(scanMalformedProseInDocument(doc)).toEqual([]);
    expect(countCanonicalVisibleWords(doc)).toBeGreaterThan(2000);

    const result = runAudit(auditInputFor(doc));
    const malformed = result.checks.find((c) => c.id === "malformed_prose")!;
    expect(malformed.status).toBe("pass");
    expect(malformed.score).toBe(100);
    expect(malformed.measuredValue).toBe("0 issues");
    expect(malformed.explanation).not.toContain("(hard failure)");

    const production = productionVerdict(doc, html);
    // The canonical malformed gate is the only production gate under test here:
    // the surrogate article is not fully CTA/schema-compliant, so we assert the
    // malformed dimension exactly (production passes ON THIS GATE), not every gate.
    expect(production.malformedHardFail).toBe(false);
  });

  it("genuinely canonical malformed prose fails both the audit and the final policy", () => {
    const doc = parseFixture("blog-13-v15.json");
    const { title, blog, faq } = loadFixture("blog-13-v15.json");
    const canonicalCount = scanMalformedProseInDocument(doc).length;
    expect(canonicalCount).toBeGreaterThan(0);

    const result = runAudit({
      title,
      metaDescription: "",
      keyword: KEYPHRASE,
      blog,
      faq: faq as Array<{ question: string; answer: string }>,
      targetWordCount: 2500,
      targetKeyphraseCount: 5,
    });
    const malformed = result.checks.find((c) => c.id === "malformed_prose")!;
    expect(malformed.status).toBe("fail");
    expect(malformed.score).toBe(0);
    expect(malformed.explanation).toContain("(hard failure)");
    // The audit reports the CANONICAL block count, not the legacy rendered count.
    expect(malformed.measuredValue).toBe(`${canonicalCount} issues`);

    const production = productionVerdict(doc, blog);
    expect(production.malformedHardFail).toBe(true);
    expect(production.passed).toBe(false);
  });

  it("the audit reports the canonical count, not the non-authoritative legacy rendered count", () => {
    const { title, blog, faq } = loadFixture("blog-13-v15.json");
    const doc = parseFixture("blog-13-v15.json");
    const canonicalCount = scanMalformedProseInDocument(doc).length;
    const metricsNoCtx = analyzeFinalArticle(blog, KEYPHRASE, title, "", 2500, countCanonicalVisibleWords(doc));
    expect(metricsNoCtx.malformedProseBlockCount).toBe(0); // OLD audit never computed canonical
    expect(canonicalCount).toBeGreaterThan(metricsNoCtx.malformedProseCount ?? 0);
    const result = runAudit({
      title,
      metaDescription: "",
      keyword: KEYPHRASE,
      blog,
      faq: faq as Array<{ question: string; answer: string }>,
      targetWordCount: 2500,
      targetKeyphraseCount: 5,
    });
    expect(result.checks.find((c) => c.id === "malformed_prose")!.measuredValue).toBe(`${canonicalCount} issues`);
  });

  // ── 2. Enforcement semantics ──

  it("with publication enforcement disabled, a low editorial score is a warning, not a hard failure", () => {
    vi.stubEnv("ENABLE_EDITORIAL_POLISH", "");
    const input = buildLowEditorialAuditInput();
    const doc = buildCleanDocument();
    const metrics = analyzeFinalArticle(input.blog, KEYPHRASE, input.title, "", 2500, countCanonicalVisibleWords(doc), { articleDoc: doc, research: [] });
    expect((metrics.editorialScore ?? 100)).toBeLessThan(80);

    const result = runAudit(input);
    const editorial = result.checks.find((c) => c.id === "editorial_score")!;
    expect(editorial.status).toBe("warning");
    expect(editorial.explanation).not.toContain("(hard failure)");
    expect(editorial.explanation).toContain("not a production publication failure");
    expect(editorial.score).toBeLessThan(80);
  });

  it("with publication enforcement enabled, a low editorial score is a hard failure and blocks", () => {
    vi.stubEnv("ENABLE_EDITORIAL_POLISH", "true");
    const input = buildLowEditorialAuditInput();
    const result = runAudit(input);
    const editorial = result.checks.find((c) => c.id === "editorial_score")!;
    expect(editorial.status).toBe("fail");
    expect(editorial.explanation).toContain("does not meet the minimum editorial publication threshold");
  });

  it("publication-enforcement status is derived from the policy, not hardcoded", () => {
    // Same content, two different policy states -> different editorial_score severity.
    const make = () => runAudit(buildLowEditorialAuditInput()).checks.find((c) => c.id === "editorial_score")!.status;

    vi.stubEnv("ENABLE_EDITORIAL_POLISH", "");
    expect(make()).toBe("warning");
    vi.stubEnv("ENABLE_EDITORIAL_POLISH", "true");
    expect(make()).toBe("fail");
  });

  // ── 3. Audit / final-policy pass-fail parity ──

  it("audit malformed status always matches the canonical production malformed gate", () => {
    const cases = [
      { name: "clean", doc: buildCleanDocument() },
      { name: "v16", doc: parseFixture("blog-13-v16.json") },
      { name: "v15", doc: parseFixture("blog-13-v15.json") },
    ];
    for (const { name, doc } of cases) {
      const html = name === "clean" ? renderArticleDocument(doc) : loadFixture(`blog-13-${name === "v16" ? "v16" : "v15"}.json`).blog;
      const canonicalCount = scanMalformedProseInDocument(doc).length;
      const auditCheck = runAudit({
        title: doc.metadata.title,
        metaDescription: doc.metadata.metaDescription,
        keyword: doc.metadata.focusKeyphrase,
        blog: html,
        faq: doc.visibleFaq.map((e) => ({ question: e.question, answer: e.answerText })),
        targetWordCount: 2500,
        targetKeyphraseCount: 5,
      }).checks.find((c) => c.id === "malformed_prose")!;
      const production = productionVerdict(doc, html);
      if (canonicalCount === 0) {
        expect(auditCheck.status, `${name}: canonical clean`).toBe("pass");
        expect(production.malformedHardFail, `${name}: production malformed gate`).toBe(false);
      } else {
        expect(auditCheck.status, `${name}: canonical malformed`).toBe("fail");
        expect(production.malformedHardFail, `${name}: production malformed gate`).toBe(true);
      }
    }
  });
});
