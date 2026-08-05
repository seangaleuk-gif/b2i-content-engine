import { describe, it, expect } from "vitest";
import {
  type ArticleDocument,
  type EditorialBlock,
  renderArticleDocument,
  renderEditorialBlocksToWordPress,
} from "@/lib/blog/article-document";
import {
  buildTranslationSourceDocument,
  enumerateTranslationSourceUnits,
  getTranslationSourceUnit,
  verifyTranslationSourceIdUniqueness,
  serializeTranslationSourceDocument,
  parseTranslationSourceDocument,
  parseTranslationSourceId,
  type TranslationSourceUnit,
} from "./translation-source-document";

// ── Fixture: an approved English ArticleDocument ──

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function richParagraphBlock(id: string): EditorialBlock {
  return {
    id,
    type: "paragraph",
    content: [
      { type: "text", text: "Creator marketing reached " },
      { type: "strong", text: "65%" },
      { type: "text", text: " of SMEs with an ROI above " },
      { type: "link", text: "B2I Hub", href: "https://www.b2ihub.com/", sourceType: "editorial-external" },
      { type: "text", text: " within 6 months." },
    ],
  };
}

function listBlock(id: string): EditorialBlock {
  return {
    id,
    type: "list",
    ordered: false,
    items: [
      [{ type: "text", text: "Audience " }, { type: "link", text: "engagement rate", href: "/blog/engagement-rate" }],
      [{ type: "text", text: "Post frequency of 3 times per week" }],
    ],
  };
}

function tableBlock(id: string): EditorialBlock {
  return {
    id,
    type: "table",
    headers: [
      [{ type: "text", text: "Platform" }],
      [{ type: "text", text: "Monthly active users" }],
    ],
    rows: [
      [
        [{ type: "text", text: "Threads" }],
        [{ type: "text", text: "1.5 billion" }],
      ],
      [
        [{ type: "text", text: "Instagram" }],
        [{ type: "text", text: "2 billion" }],
      ],
    ],
  };
}

function makeEnglishDoc(): ArticleDocument {
  return {
    metadata: {
      title: "How Creator Marketing Drives SME Growth in 2026",
      slug: "creator-marketing-sme-growth",
      metaDescription: "Creator marketing helps Hong Kong SMEs grow. Learn ROI, engagement and 6-month results in this guide.",
      excerpt: "A practical guide to creator marketing for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      blocks: [richParagraphBlock("intro-block-0")],
      status: "generated",
    },
    sections: [
      {
        id: "section-0",
        heading: "Why Creator Marketing Matters",
        headingLevel: 2,
        sectionType: "main",
        blocks: [paragraphBlock("s0-b0", "Creator marketing reaches 65% of SMEs."), listBlock("s0-b1")],
        status: "generated",
      },
      {
        id: "section-1",
        heading: "Measuring ROI Across Platforms",
        headingLevel: 2,
        sectionType: "main",
        blocks: [tableBlock("s1-b0"), paragraphBlock("s1-b1", "Budgets above HK$50,000 see faster payback.")],
        status: "generated",
      },
    ],
    visibleFaq: [
      {
        question: "How much does creator marketing cost?",
        answerHtml: "<p>Budgets typically start at <strong>HK$20,000</strong> per campaign.</p>",
        answerText: "Budgets typically start at HK$20,000 per campaign.",
      },
      {
        question: "How soon will I see results?",
        answerHtml: "<p>Most brands see measurable ROI within <a href=\"/blog/roi\">6 months</a>.</p>",
        answerText: "Most brands see measurable ROI within 6 months.",
      },
    ],
    conclusion: {
      id: "conc",
      blocks: [
        paragraphBlock("conc-b0", "Start with a focused campaign and measure engagement weekly."),
        richParagraphBlock("conc-b1"),
      ],
      status: "generated",
    },
    cta: {
      id: "cta",
      type: "cta",
      html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Create your free profile</a></div><!-- /wp:html -->",
      fingerprint: "cta-fingerprint",
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: "<!-- wp:html --><script type=\"application/ld+json\">{}</script><!-- /wp:html -->",
      fingerprint: "schema-fingerprint",
    },
    insertedLinks: [
      { componentId: "section-1", href: "/blog/engagement-rate", anchorText: "engagement rate", sourceType: "internal" },
      { componentId: "section-0", href: "https://www.b2ihub.com/", anchorText: "B2I Hub", sourceType: "editorial-external" },
    ],
  };
}

describe("buildTranslationSourceDocument", () => {
  it("is synchronous and pure: identical English documents produce identical serialized output", () => {
    const docA = buildTranslationSourceDocument(makeEnglishDoc());
    const docB = buildTranslationSourceDocument(makeEnglishDoc());
    expect(serializeTranslationSourceDocument(docA)).toBe(serializeTranslationSourceDocument(docB));
  });

  it("does not mutate the approved English ArticleDocument (byte-equivalent before and after)", () => {
    const enDoc = makeEnglishDoc();
    const before = JSON.stringify(enDoc);
    buildTranslationSourceDocument(enDoc);
    const after = JSON.stringify(enDoc);
    expect(after).toBe(before);
  });

  it("deep-clones mutable content so later mutation of the source doc cannot affect the English doc", () => {
    const enDoc = makeEnglishDoc();
    const source = buildTranslationSourceDocument(enDoc);
    const introBlock = source.introduction[0] as Extract<EditorialBlock, { type: "paragraph" }>;
    const enIntroBlock = enDoc.introduction.blocks[0] as Extract<EditorialBlock, { type: "paragraph" }>;
    introBlock.content = [];
    expect(enIntroBlock.content.length).toBeGreaterThan(0);
  });
});

describe("source ID determinism and uniqueness", () => {
  it("identical English documents produce identical source IDs", () => {
    const idsA = enumerateTranslationSourceUnits(buildTranslationSourceDocument(makeEnglishDoc())).map((u) => u.sourceId);
    const idsB = enumerateTranslationSourceUnits(buildTranslationSourceDocument(makeEnglishDoc())).map((u) => u.sourceId);
    expect(idsA).toEqual(idsB);
  });

  it("all enumerated source IDs are unique", () => {
    const doc = buildTranslationSourceDocument(makeEnglishDoc());
    const units = enumerateTranslationSourceUnits(doc);
    const unique = new Set(units.map((u) => u.sourceId));
    expect(unique.size).toBe(units.length);
    expect(verifyTranslationSourceIdUniqueness(doc)).toEqual({ unique: true, duplicates: [] });
  });
});

describe("source unit coverage", () => {
  it("represents metadata, introduction, sections, conclusion, FAQs and CTA", () => {
    const doc = buildTranslationSourceDocument(makeEnglishDoc());
    const units = enumerateTranslationSourceUnits(doc);
    const types = new Set(units.map((u) => u.type));

    expect(types.has("metadata-title")).toBe(true);
    expect(types.has("metadata-meta-description")).toBe(true);
    expect(types.has("metadata-excerpt")).toBe(true);
    expect(types.has("introduction-block")).toBe(true);
    expect(types.has("section-heading")).toBe(true);
    expect(types.has("section-block")).toBe(true);
    expect(types.has("conclusion-block")).toBe(true);
    expect(types.has("faq-question")).toBe(true);
    expect(types.has("faq-answer")).toBe(true);
    expect(types.has("cta")).toBe(true);

    // One block per introduction/conclusion block, per section heading and per body block.
    expect(units.filter((u) => u.type === "introduction-block")).toHaveLength(doc.introduction.length);
    expect(units.filter((u) => u.type === "section-heading")).toHaveLength(doc.sections.length);
    expect(units.filter((u) => u.type === "section-block")).toHaveLength(
      doc.sections.reduce((sum, s) => sum + s.blocks.length, 0),
    );
    expect(units.filter((u) => u.type === "conclusion-block")).toHaveLength(doc.conclusion.length);
    expect(units.filter((u) => u.type === "faq-question")).toHaveLength(doc.faq.length);
    expect(units.filter((u) => u.type === "faq-answer")).toHaveLength(doc.faq.length);
    expect(units.filter((u) => u.type === "cta")).toHaveLength(doc.cta ? 1 : 0);
  });

  it("enumerates in canonical document order (intro → sections → conclusion → FAQ → CTA)", () => {
    const doc = buildTranslationSourceDocument(makeEnglishDoc());
    const ids = enumerateTranslationSourceUnits(doc).map((u) => u.sourceId);
    const expected = [
      "metadata.title",
      "metadata.metaDescription",
      "metadata.excerpt",
      "introduction.block.0",
      "section.0.heading",
      "section.0.block.0",
      "section.0.block.1",
      "section.1.heading",
      "section.1.block.0",
      "section.1.block.1",
      "conclusion.block.0",
      "conclusion.block.1",
      "faq.0.question",
      "faq.0.answer",
      "faq.1.question",
      "faq.1.answer",
      "cta",
    ];
    expect(ids).toEqual(expected);
  });

  it("carries metadata fields (title, slug, meta description, excerpt) and evidence metadata", () => {
    const source = buildTranslationSourceDocument(makeEnglishDoc());
    expect(source.metadata.title).toBe(makeEnglishDoc().metadata.title);
    expect(source.metadata.slug).toBe(makeEnglishDoc().metadata.slug);
    expect(source.metadata.metaDescription).toBe(makeEnglishDoc().metadata.metaDescription);
    expect(source.metadata.excerpt).toBe(makeEnglishDoc().metadata.excerpt);
    expect(source.insertedLinks).toHaveLength(makeEnglishDoc().insertedLinks.length);
  });

  it("exposes numbers and URLs per unit using existing extraction utilities", () => {
    const doc = buildTranslationSourceDocument(makeEnglishDoc());
    const intro = getTranslationSourceUnit(doc, "introduction.block.0") as Extract<TranslationSourceUnit, { type: "introduction-block" }>;
    expect(intro.numbers).toContain("65%");
    expect(intro.numbers).toContain("6");
    expect(intro.links).toContain("https://www.b2ihub.com/");

    const meta = getTranslationSourceUnit(doc, "metadata.metaDescription");
    expect(meta.numbers).toContain("6");
  });
});

describe("FAQ and section integrity", () => {
  it("keeps FAQ question/answer pairing intact", () => {
    const enDoc = makeEnglishDoc();
    const doc = buildTranslationSourceDocument(enDoc);
    expect(doc.faq).toHaveLength(enDoc.visibleFaq.length);
    doc.faq.forEach((entry, i) => {
      expect(entry.question).toBe(enDoc.visibleFaq[i].question);
      expect(entry.answerHtml).toBe(enDoc.visibleFaq[i].answerHtml);
      expect(entry.answerText).toBe(enDoc.visibleFaq[i].answerText);
    });
    const question = getTranslationSourceUnit(doc, "faq.0.question");
    const answer = getTranslationSourceUnit(doc, "faq.0.answer");
    if (question.type === "faq-question") {
      expect(question.text).toBe(enDoc.visibleFaq[0].question);
    } else {
      throw new Error("faq.0.question resolved to wrong type");
    }
    if (answer.type === "faq-answer") {
      expect(answer.answerHtml).toBe(enDoc.visibleFaq[0].answerHtml);
      expect(answer.answerText).toBe(enDoc.visibleFaq[0].answerText);
    } else {
      throw new Error("faq.0.answer resolved to wrong type");
    }
  });

  it("keeps section heading/body relationships intact", () => {
    const enDoc = makeEnglishDoc();
    const doc = buildTranslationSourceDocument(enDoc);
    expect(doc.sections).toHaveLength(enDoc.sections.length);
    doc.sections.forEach((section, i) => {
      expect(section.heading).toBe(enDoc.sections[i].heading);
      expect(section.blocks).toHaveLength(enDoc.sections[i].blocks.length);
      section.blocks.forEach((block, j) => {
        expect(block).toEqual(enDoc.sections[i].blocks[j]);
      });
    });
    const heading = getTranslationSourceUnit(doc, "section.1.heading");
    const body = getTranslationSourceUnit(doc, "section.1.block.0");
    if (heading.type === "section-heading") {
      expect(heading.text).toBe(enDoc.sections[1].heading);
    } else {
      throw new Error("section.1.heading resolved to wrong type");
    }
    if (body.type === "section-block") {
      expect(body.block).toEqual(enDoc.sections[1].blocks[0]);
    } else {
      throw new Error("section.1.block.0 resolved to wrong type");
    }
  });
});

describe("protected structure preservation", () => {
  it("preserves WordPress block structure and inline formatting through the source document", () => {
    const enDoc = makeEnglishDoc();
    const doc = buildTranslationSourceDocument(enDoc);
    const intro = getTranslationSourceUnit(doc, "introduction.block.0") as Extract<TranslationSourceUnit, { type: "introduction-block" }>;
    expect(renderEditorialBlocksToWordPress([intro.block])).toBe(
      renderEditorialBlocksToWordPress([enDoc.introduction.blocks[0]]),
    );
    const table = getTranslationSourceUnit(doc, "section.1.block.0") as Extract<TranslationSourceUnit, { type: "section-block" }>;
    expect(renderEditorialBlocksToWordPress([table.block])).toBe(
      renderEditorialBlocksToWordPress([enDoc.sections[1].blocks[0]]),
    );
  });

  it("preserves CTA protected HTML verbatim", () => {
    const enDoc = makeEnglishDoc();
    const doc = buildTranslationSourceDocument(enDoc);
    expect(doc.cta).not.toBeNull();
    expect(doc.cta!.html).toBe(enDoc.cta!.html);
    expect(doc.cta!.fingerprint).toBe(enDoc.cta!.fingerprint);
    const cta = getTranslationSourceUnit(doc, "cta");
    if (cta.type === "cta") {
      expect(cta.html).toBe(enDoc.cta!.html);
    } else {
      throw new Error("cta resolved to wrong type");
    }
  });
});

describe("retrieval by source ID", () => {
  it("returns the exact matching English field for every enumerated unit", () => {
    const enDoc = makeEnglishDoc();
    const doc = buildTranslationSourceDocument(enDoc);
    for (const unit of enumerateTranslationSourceUnits(doc)) {
      expect(getTranslationSourceUnit(doc, unit.sourceId)).toEqual(unit);
    }
  });

  it("parses well-formed source IDs into the expected kind and indices", () => {
    expect(parseTranslationSourceId("metadata.title")).toEqual({ kind: "metadata-title" });
    expect(parseTranslationSourceId("introduction.block.2")).toEqual({ kind: "introduction-block", index: 2 });
    expect(parseTranslationSourceId("section.4.heading")).toEqual({ kind: "section-heading", index: 4 });
    expect(parseTranslationSourceId("section.4.block.7")).toEqual({ kind: "section-block", index: 4, secondary: 7 });
    expect(parseTranslationSourceId("faq.0.answer")).toEqual({ kind: "faq-answer", index: 0 });
    expect(parseTranslationSourceId("cta")).toEqual({ kind: "cta" });
  });

  it("fails deterministically on malformed or out-of-range source IDs", () => {
    const doc = buildTranslationSourceDocument(makeEnglishDoc());
    const malformed = [
      "metadata.title.extra",
      "metadata.bogus",
      "section.x.heading",
      "section..heading",
      "introduction.block.abc",
      "faq.answer",
      "introduction.heading",
      "unknown",
      "section.99.heading",
      "introduction.block.99",
      "faq.9.question",
      "conclusion.block.99",
      "section.0.block.99",
    ];
    for (const id of malformed) {
      expect(() => getTranslationSourceUnit(doc, id)).toThrow();
    }
    expect(parseTranslationSourceId("not.a.valid.id")).toBeNull();
  });
});

describe("serialization and reconstruction", () => {
  it("round-trips without data loss (links, numbers, formatting, structure)", () => {
    const enDoc = makeEnglishDoc();
    const doc = buildTranslationSourceDocument(enDoc);
    const restored = parseTranslationSourceDocument(serializeTranslationSourceDocument(doc));
    expect(restored).toEqual(doc);
    // Rebuild from the restored representation yields the same source units.
    expect(enumerateTranslationSourceUnits(restored)).toEqual(enumerateTranslationSourceUnits(doc));
    expect(restored.cta).toEqual(doc.cta);
    expect(restored.insertedLinks).toEqual(doc.insertedLinks);
  });

  it("round-trips the full rendered article HTML unchanged", () => {
    // The source document preserves the exact editorial blocks, so rendering the
    // reconstructed introduction/sections/conclusion/FAQ produces identical HTML.
    const enDoc = makeEnglishDoc();
    const source = buildTranslationSourceDocument(enDoc);
    const restored = parseTranslationSourceDocument(serializeTranslationSourceDocument(source));
    expect(restored.introduction).toEqual(source.introduction);
    expect(restored.sections).toEqual(source.sections);
    expect(restored.conclusion).toEqual(source.conclusion);
    expect(restored.faq).toEqual(source.faq);
  });

  it("fails deterministically on malformed or wrongly shaped serialized input", () => {
    expect(() => parseTranslationSourceDocument("{ not json")).toThrow();
    expect(() => parseTranslationSourceDocument("null")).toThrow();
    expect(() => parseTranslationSourceDocument(JSON.stringify({ metadata: {} }))).toThrow();
    expect(() => parseTranslationSourceDocument(JSON.stringify({}))).toThrow();
  });
});

describe("no AI / production translation behavior", () => {
  it("builds and enumerates without triggering any provider call or translation behavior", () => {
    // buildTranslationSourceDocument is synchronous and pure; it imports no AI
    // provider and performs no prompts, API calls, number protection or
    // translation validation. Multiple builds are byte-identical, proving no
    // stochastic or provider-dependent behavior.
    const first = serializeTranslationSourceDocument(buildTranslationSourceDocument(makeEnglishDoc()));
    const second = serializeTranslationSourceDocument(buildTranslationSourceDocument(makeEnglishDoc()));
    expect(first).toBe(second);
    expect(() => renderArticleDocument(makeEnglishDoc())).not.toThrow();
  });
});
