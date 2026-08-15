import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import {
  renderFaqSchema,
  validateFaqParity,
  normalizeFaqSemanticText,
} from "@/lib/blog/article-document";
import { validateArticleIntegrityContract, type ContractCategory } from "@/lib/blog/article-integrity-contract";
import { cleanFaqOwnershipViolations } from "@/lib/blog/claim-ownership";
import { sanitizeFaqFactualClaims } from "@/lib/pipeline/blog-generation-pipeline";

const KEYPHRASE = "threads marketing hong kong";

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

const FILLER = [
  "Local teams can share useful lessons from daily work with clear and honest words.",
  "Simple examples help busy owners understand the idea and take a practical next step.",
  "Regular replies also show customers that a real person is listening to their needs.",
  "A small weekly plan keeps the work steady without adding stress to the whole team.",
  "Owners can note common questions and turn those questions into helpful future posts.",
  "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
];

function makeDoc(): ArticleDocument {
  const visibleFaq = [
    { question: "What is the first step?", answerHtml: "", answerText: "Start with a small and useful routine for the whole team." },
    { question: "How often should teams post?", answerHtml: "", answerText: "A steady weekly plan keeps the work manageable for everyone." },
  ];
  const fillerParagraphs = Array.from({ length: 10 }, (_, index) =>
    paragraph(`fill-${index}`, `${FILLER[index % FILLER.length]} ${FILLER[(index + 1) % FILLER.length]} ${FILLER[(index + 2) % FILLER.length]}`),
  );
  return {
    metadata: { title: "Threads Marketing Hong Kong Guide", slug: "threads-guide", metaDescription: "A practical guide.", excerpt: "Guide", targetWordCount: 1500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: "ls",
    },
    introduction: { id: "intro", status: "generated", blocks: [paragraph("intro-0", "This guide explains how local brands can use the platform."), ...fillerParagraphs.slice(0, 3)] },
    sections: [
      {
        id: "section-0",
        heading: "Understand the People You Want to Reach",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph("s0-0", `Local teams use ${KEYPHRASE} to stay visible. Simple examples help busy owners understand the idea.`),
          paragraph("s0-1", "Regular replies also show customers that a real person is listening to their needs."),
          ...fillerParagraphs.slice(3, 6),
        ],
      },
      {
        id: "section-1",
        heading: "Build a Simple Weekly Content Routine",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [...fillerParagraphs.slice(6, 10)],
      },
      { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", status: "generated", blocks: [] },
    ],
    visibleFaq,
    conclusion: { id: "conclusion", status: "generated", blocks: [paragraph("c-0", `A useful ${KEYPHRASE} plan does not need a large team.`)] },
    cta: {
      id: "cta",
      type: "cta",
      html: `<!-- wp:html --><div class="cta-block"><h2>Ready to Start?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->`,
      fingerprint: "cta",
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema(visibleFaq),
      fingerprint: "schema",
    },
    insertedLinks: [],
  };
}

function contractFor(doc: ArticleDocument, previous: ArticleDocument, ownedCategories: ReadonlySet<ContractCategory> = new Set()) {
  return validateArticleIntegrityContract(doc, {
    keyphrase: KEYPHRASE,
    research: [],
    wordMin: 1,
    wordMax: 100000,
    previous,
    ownedCategories,
  });
}

describe("article integrity contract: stage-aware fail-closed attribution", () => {
  it("a clean candidate over a clean snapshot is valid", () => {
    const doc = makeDoc();
    const result = contractFor(doc, structuredClone(doc));
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("a NEW orphan-transition in a different block is not masked by a pre-existing one in the same component", () => {
    // The snapshot already has one orphan-transition in section-1 (wp-1).
    // The candidate ADDS a second orphan-transition in a DIFFERENT block of
    // the same section. The coherence delta message carries the block id, so
    // the introduced violation is attributed to the mutating stage instead of
    // being masked as "pre-existing" damage.
    const previous = makeDoc();
    previous.sections[1].blocks[0] = paragraph("s1-0", "Instead, brands pivot to owned channels for the year ahead.");
    const doc = makeDoc();
    doc.sections[1].blocks[0] = paragraph("s1-0", "Instead, brands pivot to owned channels for the year ahead.");
    doc.sections[1].blocks[1] = paragraph(
      "s1-1",
      "Local teams share useful lessons from daily work with clear and honest words.",
    );
    doc.sections[1].blocks[2] = paragraph("s1-2", "Instead, teams should review weekly to keep momentum.");

    const result = contractFor(doc, previous);
    expect(result.valid).toBe(false);
    const coherenceViolations = result.violations.filter((v) => v.category === "coherence");
    expect(coherenceViolations.some((v) => v.message.includes("orphan-transition"))).toBe(true);
    // The introduced orphan is attributed with its block id.
    expect(coherenceViolations.some((v) => v.message.includes("s1-2"))).toBe(true);
  });

  it("a link change outside link-owning stages is rejected", () => {
    const previous = makeDoc();
    const doc = makeDoc();
    doc.sections[0].blocks[0] = {
      id: "s0-0",
      type: "paragraph",
      content: [
        { type: "text", text: "Local teams use threads marketing hong kong to stay visible. Read the " },
        { type: "link", text: "guide", href: "/blog/other-guide", sourceType: "internal" },
        { type: "text", text: " before planning." },
      ],
    };
    const result = contractFor(doc, previous);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === "links")).toBe(true);
    // The link-owning stage may change links.
    const ownedResult = contractFor(doc, previous, new Set<ContractCategory>(["links"]));
    expect(ownedResult.valid).toBe(true);
  });

  it("a factual change outside factual-owning stages is rejected", () => {
    const previous = makeDoc();
    const doc = makeDoc();
    doc.sections[0].blocks[0] = paragraph("s0-0", `Local teams use ${KEYPHRASE} to stay visible. About 45% of them plan weekly.`);
    const result = contractFor(doc, previous);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === "factual")).toBe(true);
    const ownedResult = contractFor(doc, previous, new Set<ContractCategory>(["factual"]));
    expect(ownedResult.valid).toBe(true);
  });

  it("a keyphrase occurrence change outside SEO-owning stages is rejected", () => {
    const previous = makeDoc();
    const doc = makeDoc();
    doc.sections[0].blocks[0] = paragraph("s0-0", `Local teams use ${KEYPHRASE} and ${KEYPHRASE} to stay visible. Simple examples help busy owners.`);
    const result = contractFor(doc, previous);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === "seo")).toBe(true);
    const ownedResult = contractFor(doc, previous, new Set<ContractCategory>(["seo"]));
    expect(ownedResult.valid).toBe(true);
  });

  it("a visible-FAQ change outside protected-content ownership is rejected; a canonical-vs-schema divergence is a faq-parity violation", () => {
    const previous = makeDoc();
    // Self-consistent canonical change (schema regenerated, as every
    // FAQ-mutating stage does): attributed to protected-content.
    const doc = makeDoc();
    doc.visibleFaq[1] = { ...doc.visibleFaq[1], answerText: "A completely different weekly answer." };
    doc.faqSchema = {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema(doc.visibleFaq),
      fingerprint: "schema",
    };
    const result = contractFor(doc, previous);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === "protected-content")).toBe(true);
    const ownedResult = contractFor(doc, previous, new Set<ContractCategory>(["protected-content"]));
    expect(ownedResult.valid).toBe(true);
    // Inconsistent representations: the rendered visible FAQ block diverges
    // from the canonical answerText (a producer changed one representation
    // only) — a faq-parity violation.
    const divergent = makeDoc();
    divergent.visibleFaq[0] = {
      ...divergent.visibleFaq[0],
      answerHtml: "<p>The rendered block shows different text than the canonical answer.</p>",
    };
    const divergentResult = contractFor(divergent, previous);
    expect(divergentResult.valid).toBe(false);
    expect(divergentResult.violations.some((v) => v.category === "faq-parity")).toBe(true);
    // A stale faqSchema field is a cta-switcher-schema violation (the schema
    // must match the canonical entries).
    const stale = makeDoc();
    stale.faqSchema = {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema([
        { question: "What is the first step?", answerHtml: "", answerText: "An old answer that was later rewritten." },
        { question: "How often should teams post?", answerHtml: "", answerText: "A steady weekly plan keeps the work manageable for everyone." },
      ]),
      fingerprint: "stale",
    };
    const staleResult = contractFor(stale, previous);
    expect(staleResult.valid).toBe(false);
    expect(staleResult.violations.some((v) => v.category === "cta-switcher-schema")).toBe(true);
  });

  it("a broken WordPress structure is rejected absolutely", () => {
    const previous = makeDoc();
    const doc = makeDoc();
    doc.sections[0].blocks[1] = {
      id: "s0-1",
      type: "paragraph",
      content: [{ type: "text", text: "Regular replies also show customers that a real person is listening to their needs." }],
    };
    // Simulate an unbalanced render by injecting raw markup through a block.
    (doc.sections[0].blocks[1] as Extract<EditorialBlock, { type: "paragraph" }>).content = [
      { type: "text", text: "<p>unbalanced" },
    ];
    const result = contractFor(doc, previous);
    expect(result.violations.some((v) => v.category === "wordpress-structure" || v.category === "malformed")).toBe(true);
  });

  it("malformed/sentence-quality violations introduced by a stage are attributed to that stage", () => {
    const previous = makeDoc();
    const doc = makeDoc();
    doc.sections[0].blocks[0] = paragraph("s0-0", "Local teams use threads marketing hong kong to stay visible. plan a small weekly routine.");
    const result = contractFor(doc, previous);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === "malformed" || v.category === "sentence-quality")).toBe(true);
    const ownedResult = contractFor(doc, previous, new Set<ContractCategory>(["malformed", "sentence-quality"]));
    expect(ownedResult.valid).toBe(true);
  });
});

describe("FAQ answer-mismatch@1: first corrupting producers and parity normalization", () => {
  it("cleanFaqOwnershipViolations keeps quotes and ampersands, and parity holds (the production scenario)", () => {
    const entries = [
      { question: "Q1", answerHtml: "", answerText: "Start with a small routine for the whole team." },
      { question: "Q2", answerHtml: "", answerText: 'The owner said "plan ahead" & kept the routine going. About 35% of teams do this weekly.' },
      { question: "Q3", answerHtml: "", answerText: "A useful closing answer for the third question." },
    ];
    const research = [{ title: "Team Routines", snippet: "About 35% of teams do this weekly.", url: "https://example.com/routines" }];
    const cleanup = cleanFaqOwnershipViolations(entries, KEYPHRASE, research, { keyphrase: KEYPHRASE });
    expect(cleanup.entries[1].answerText).toContain('"plan ahead"');
    expect(cleanup.entries[1].answerText).toContain("&");
    expect(cleanup.entries[1].answerText).not.toContain("35%");
    const parity = validateFaqParity(cleanup.entries, renderFaqSchema(cleanup.entries));
    expect(parity.valid).toBe(true);
    expect(parity.issues).toEqual([]);
  });

  it("sanitizeFaqFactualClaims no longer loses characters through the escape/extract round-trip", () => {
    const sanitized = sanitizeFaqFactualClaims(
      [{ question: "Q1", answerHtml: "", answerText: 'Start with a small & "useful" routine for the whole team.' }],
      KEYPHRASE,
      [],
    );
    expect(sanitized.entries[0].answerText).toBe('Start with a small & "useful" routine for the whole team.');
    const parity = validateFaqParity(sanitized.entries, renderFaqSchema(sanitized.entries));
    expect(parity.valid).toBe(true);
  });

  it("parity normalization treats entity/JSON-escape representations as equal but real wording differences as failures", () => {
    const withEntities = [{ question: "Q1", answerHtml: "", answerText: 'It&apos;s a "simple" tool &amp; the team likes it.' }];
    expect(validateFaqParity(withEntities, renderFaqSchema(withEntities)).valid).toBe(true);
    // Backslash and newline survive the JSON round-trip identically.
    const withBackslash = [{ question: "Q1", answerHtml: "", answerText: "Windows \\ macOS and\n a new line." }];
    expect(validateFaqParity(withBackslash, renderFaqSchema(withBackslash)).valid).toBe(true);
    // A genuine wording difference still fails.
    const realDiff = validateFaqParity(
      [{ question: "Q1", answerHtml: "", answerText: "Real different wording here." }],
      renderFaqSchema([{ question: "Q1", answerHtml: "", answerText: "Other wording entirely here." }]),
    );
    expect(realDiff.valid).toBe(false);
    expect(realDiff.issues.some((issue) => issue.type === "answer-mismatch")).toBe(true);
  });

  it("normalizeFaqSemanticText is the single normalization for every side", () => {
    expect(normalizeFaqSemanticText("  It&apos;s  a   tool.  ")).toBe(normalizeFaqSemanticText("It&#39;s a tool."));
    expect(normalizeFaqSemanticText('She said \\"hi\\"')).toBe(normalizeFaqSemanticText('She said "hi"'));
  });
});
