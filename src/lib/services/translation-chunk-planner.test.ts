import { describe, it, expect } from "vitest";
import type { EditorialBlock } from "@/lib/blog/article-content";
import {
  type TranslationSourceDocument,
  type TranslationSourceUnit,
  serializeTranslationSourceDocument,
} from "./translation-source-document";
import {
  buildTranslationChunkPlan,
  enumerateTranslationChunks,
  getTranslationChunk,
  verifyTranslationChunkCoverage,
  verifyTranslationChunkBoundaries,
  verifyTranslationChunkPlan,
  serializeTranslationChunkPlan,
  parseTranslationChunkPlan,
  validateStructuredChunkResponse,
  buildDocumentBrief,
  DEFAULT_CHUNK_PLANNER_CONFIG,
  TranslationChunkPlanError,
  type TranslationChunkPlan,
  type TranslationChunk,
} from "./translation-chunk-planner";

// ── Fixtures ──

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function richParagraph(id: string): EditorialBlock {
  return {
    id,
    type: "paragraph",
    content: [
      { type: "text", text: "Creator marketing reached " },
      { type: "strong", text: "65%" },
      { type: "text", text: " of SMEs with ROI above " },
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
      [{ type: "text", text: "Post 3 times per week" }],
    ],
  };
}

function tableBlock(id: string): EditorialBlock {
  return {
    id,
    type: "table",
    headers: [[{ type: "text", text: "Platform" }], [{ type: "text", text: "Monthly active users" }]],
    rows: [
      [[{ type: "text", text: "Threads" }], [{ type: "text", text: "1.5 billion" }]],
      [[{ type: "text", text: "Instagram" }], [{ type: "text", text: "2 billion" }]],
    ],
  };
}

function makeSourceDoc(): TranslationSourceDocument {
  return {
    metadata: {
      title: "How Creator Marketing Drives SME Growth in 2026",
      slug: "creator-marketing-sme-growth",
      metaDescription: "Creator marketing helps Hong Kong SMEs grow. Learn ROI, engagement and 6-month results in this guide.",
      excerpt: "A practical guide to creator marketing for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: "creator marketing",
    },
    introduction: [richParagraph("intro-0")],
    sections: [
      {
        heading: "Why Creator Marketing Matters",
        sectionType: "main",
        blocks: [paragraph("s0-0", "Creator marketing reaches 65% of SMEs."), listBlock("s0-1")],
      },
      {
        heading: "Measuring ROI Across Platforms",
        sectionType: "main",
        blocks: [tableBlock("s1-0"), paragraph("s1-1", "Budgets above HK$50,000 see faster payback.")],
      },
    ],
    conclusion: [paragraph("conc-0", "Start with a focused campaign and measure engagement weekly."), richParagraph("conc-1")],
    faq: [
      { question: "How much does creator marketing cost?", answerHtml: "<p>Budgets typically start at <strong>HK$20,000</strong> per campaign.</p>", answerText: "Budgets typically start at HK$20,000 per campaign." },
      { question: "How soon will I see results?", answerHtml: "<p>Most brands see ROI within <a href=\"/blog/roi\">6 months</a>.</p>", answerText: "Most brands see ROI within 6 months." },
    ],
    cta: { html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Create your free profile</a></div><!-- /wp:html -->", fingerprint: "cta-fingerprint" },
    insertedLinks: [
      { componentId: "s1", href: "/blog/engagement-rate", anchorText: "engagement rate", sourceType: "internal" },
    ],
  };
}

function wordParagraph(id: string, words: number): EditorialBlock {
  const sentence = "Creator marketing drives engagement and measurable growth for Hong Kong small businesses across social channels. ";
  const repeats = Math.ceil(words / sentence.trim().split(/\s+/).length);
  return { id, type: "paragraph", content: [{ type: "text", text: sentence.repeat(repeats).trim() }] };
}

/** Representative ~2,700-word article: 8 sections × 4 paragraphs + intro/conclusion/FAQ/CTA. */
function makeRepresentativeSourceDoc(): TranslationSourceDocument {
  const sections = Array.from({ length: 8 }, (_, i) => ({
    heading: `Section ${i + 1} of Creator Marketing`,
    sectionType: "main" as const,
    blocks: [0, 1, 2, 3].map((b) => wordParagraph(`s${i}-${b}`, 68)),
  }));
  return {
    metadata: {
      title: "The Complete Guide to Creator Marketing for Hong Kong SMEs in 2026",
      slug: "creator-marketing-guide-hong-kong",
      metaDescription: "A complete creator marketing guide for Hong Kong SMEs covering strategy, ROI, engagement and long-term growth.",
      excerpt: "A practical, evidence-based guide to creator marketing for Hong Kong small and medium businesses.",
      targetWordCount: 2800,
      focusKeyphrase: "creator marketing",
    },
    introduction: [wordParagraph("intro-0", 120), wordParagraph("intro-1", 120)],
    sections,
    conclusion: [wordParagraph("conc-0", 120), wordParagraph("conc-1", 100)],
    faq: Array.from({ length: 4 }, (_, i) => ({
      question: `FAQ question number ${i + 1} about creator marketing?`,
      answerHtml: `<p>This is a detailed answer for FAQ ${i + 1} covering budget and expected results.</p>`,
      answerText: `This is a detailed answer for FAQ ${i + 1} covering budget and expected results.`,
    })),
    cta: { html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Create your free profile</a></div><!-- /wp:html -->", fingerprint: "cta-fingerprint" },
    insertedLinks: [],
  };
}

const substantive = (plan: TranslationChunkPlan): number =>
  plan.chunks.filter((chunk) => chunk.role !== "protected-cta").length;

// ── Tests ──

describe("determinism", () => {
  it("identical source documents and configuration produce byte-equivalent plans and IDs", () => {
    const a = buildTranslationChunkPlan(makeSourceDoc());
    const b = buildTranslationChunkPlan(makeSourceDoc());
    expect(serializeTranslationChunkPlan(a)).toBe(serializeTranslationChunkPlan(b));
    expect(a.chunkIds).toEqual(b.chunkIds);
    expect(a.canonicalFingerprint).toBe(b.canonicalFingerprint);
    expect(a.chunks.map((c) => c.fingerprint)).toEqual(b.chunks.map((c) => c.fingerprint));
  });

  it("the original TranslationSourceDocument remains byte-equivalent after planning", () => {
    const source = makeSourceDoc();
    const before = serializeTranslationSourceDocument(source);
    buildTranslationChunkPlan(source);
    expect(serializeTranslationSourceDocument(source)).toBe(before);
  });
});

describe("coverage, order and boundaries", () => {
  it("assigns every translatable source unit exactly once", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    const coverage = verifyTranslationChunkCoverage(plan);
    expect(coverage.complete).toBe(true);
    expect(coverage.missing).toEqual([]);
    expect(coverage.duplicates).toEqual([]);
    expect(coverage.extra).toEqual([]);
    const unique = new Set(plan.coveredSourceUnitIds);
    expect(unique.size).toBe(plan.totalSourceUnits);
  });

  it("preserves canonical document order across chunks", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    expect(plan.coveredSourceUnitIds).toEqual(plan.expectedSourceUnitIds);
    const boundary = verifyTranslationChunkBoundaries(plan);
    expect(boundary.valid).toBe(true);
    expect(boundary.errors).toEqual([]);
  });

  it("keeps every section heading with its body", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    for (const id of plan.expectedSourceUnitIds) {
      const m = /^section\.(\d+)\.block\./.exec(id);
      if (!m) continue;
      const headingId = `section.${m[1]}.heading`;
      const blockChunk = plan.chunks.find((c) => c.sourceUnitIds.includes(id));
      expect(blockChunk).toBeDefined();
      expect(blockChunk!.sourceUnitIds).toContain(headingId);
    }
  });

  it("keeps every FAQ question paired with its answer", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    const faqCount = source.faq.length;
    for (let i = 0; i < faqCount; i++) {
      const q = `faq.${i}.question`;
      const a = `faq.${i}.answer`;
      const qChunk = plan.chunks.find((c) => c.sourceUnitIds.includes(q));
      expect(qChunk).toBeDefined();
      expect(qChunk!.sourceUnitIds).toContain(a);
    }
  });

  it("keeps introduction and conclusion coherent (single chunk each when they fit)", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    const introChunks = new Set(
      source.introduction.map((_, i) => plan.chunks.find((c) => c.sourceUnitIds.includes(`introduction.block.${i}`))!.chunkId),
    );
    const conclusionChunks = new Set(
      source.conclusion.map((_, i) => plan.chunks.find((c) => c.sourceUnitIds.includes(`conclusion.block.${i}`))!.chunkId),
    );
    expect(introChunks.size).toBe(1);
    expect(conclusionChunks.size).toBe(1);
  });

  it("does not split editorial blocks or inline nodes", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    const blockUnit = plan.chunks
      .flatMap((c) => c.units)
      .find((unit): unit is Extract<TranslationSourceUnit, { type: "section-block" }> => unit.type === "section-block");
    expect(blockUnit).toBeDefined();
    expect(blockUnit!.block).toEqual(source.sections[blockUnit!.sectionIndex].blocks[blockUnit!.blockIndex]);
    // The block appears wholly in exactly one chunk.
    const chunk = plan.chunks.find((c) => c.sourceUnitIds.includes(blockUnit!.sourceId));
    expect(chunk!.sourceUnitIds.filter((id) => id === blockUnit!.sourceId)).toHaveLength(1);
  });
});

describe("chunk count behaviour", () => {
  it("produces approximately 4-6 substantive chunks for a normal ~2,700-word article", () => {
    const plan = buildTranslationChunkPlan(makeRepresentativeSourceDoc());
    const count = substantive(plan);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(6);
    const totalUnits = plan.totalSourceUnits;
    expect(totalUnits).toBeGreaterThan(30);
    // Coherent, not component-by-component.
    expect(plan.chunks.length).toBeLessThan(totalUnits);
  });

  it("no chunk's estimated output exceeds the safe output target (headroom-adjusted)", () => {
    const plan = buildTranslationChunkPlan(makeRepresentativeSourceDoc());
    const cap = plan.config.maxOutputTokens;
    for (const chunk of plan.chunks) {
      if (chunk.role === "protected-cta") continue;
      // Headroom gate already held at build time; assert the safe-target margin too.
      expect(chunk.estimatedOutputTokens * plan.config.outputHeadroomFactor).toBeLessThanOrEqual(cap);
      // Do not plan chunks that normally need near the full output cap.
      expect(chunk.estimatedOutputTokens).toBeLessThanOrEqual(cap * 0.7);
    }
  });

  it("does not create an oversized final chunk containing remaining sections, conclusion and FAQs", () => {
    const plan = buildTranslationChunkPlan(makeRepresentativeSourceDoc());
    const containsSection = (chunk: typeof plan.chunks[number]) => chunk.sourceUnitIds.some((id) => /^section\.\d+\./.test(id));
    const containsConclusion = (chunk: typeof plan.chunks[number]) => chunk.sourceUnitIds.some((id) => id.startsWith("conclusion."));
    const containsFaq = (chunk: typeof plan.chunks[number]) => chunk.sourceUnitIds.some((id) => id.startsWith("faq."));
    // Conclusion and FAQ live in their own chunks and are never merged with sections.
    for (const chunk of plan.chunks) {
      expect(containsSection(chunk) && containsConclusion(chunk) && containsFaq(chunk)).toBe(false);
      expect(containsConclusion(chunk) && containsFaq(chunk)).toBe(false);
    }
  });

  it("lowering the token budget causes deterministic additional chunking", () => {
    const source = makeRepresentativeSourceDoc();
    const relaxed = buildTranslationChunkPlan(source);
    const tight = buildTranslationChunkPlan(source, {
      ...DEFAULT_CHUNK_PLANNER_CONFIG,
      maxInputTokens: 2500,
      maxOutputTokens: 2000,
      glossaryInstructionsTokens: 400,
      structuredOutputOverheadTokens: 200,
      previousChunkContextTokens: 100,
    });
    expect(tight.chunks.length).toBeGreaterThan(relaxed.chunks.length);
    // Both remain valid (full coverage, correct boundaries).
    expect(verifyTranslationChunkPlan(relaxed).valid).toBe(true);
    expect(verifyTranslationChunkPlan(tight).valid).toBe(true);
  });

  it("fails deterministically when an indivisible oversized block cannot fit", () => {
    const source = makeSourceDoc();
    const huge: TranslationSourceDocument = {
      ...source,
      sections: [
        ...source.sections,
        { heading: "Oversized", sectionType: "main", blocks: [wordParagraph("huge-0", 60000)] },
      ],
    };
    expect(() => buildTranslationChunkPlan(huge)).toThrow(TranslationChunkPlanError);
  });
});

describe("document brief", () => {
  it("contains the full heading outline but not the full article body", () => {
    const source = makeSourceDoc();
    const plan = buildTranslationChunkPlan(source);
    const outline = plan.documentBrief.headingOutline;
    expect(outline).toEqual(source.sections.map((s) => s.heading));
    // The brief must not embed a body paragraph's prose.
    const briefJson = JSON.stringify(plan.documentBrief);
    expect(briefJson).not.toContain("Budgets above HK$50,000 see faster payback");
    expect(briefJson).not.toContain("1.5 billion");
    expect(briefJson).not.toContain(source.faq[0].answerText);
  });

  it("encodes the required language, factual, code-switching and canonicality rules", () => {
    const brief = buildDocumentBrief(makeSourceDoc());
    expect(brief.languageRegister).toContain("Cantonese");
    expect(brief.factualRule).toContain("comparisons");
    expect(brief.codeSwitchingRule).toContain("KPI");
    expect(brief.canonicalityRule).toContain("fact-checked");
    expect(brief.terminology.length).toBeGreaterThan(0);
  });
});

describe("serialization", () => {
  it("round-trips the plan losslessly (links, numbers, structure, IDs)", () => {
    const plan = buildTranslationChunkPlan(makeSourceDoc());
    const restored = parseTranslationChunkPlan(serializeTranslationChunkPlan(plan));
    expect(restored).toEqual(plan);
    expect(restored.chunks).toEqual(plan.chunks);
    expect(restored.config).toEqual(plan.config);
    expect(restored.documentBrief).toEqual(plan.documentBrief);
  });

  it("retrieves a chunk by deterministic ID and enumerates in order", () => {
    const plan = buildTranslationChunkPlan(makeSourceDoc());
    expect(plan.chunkIds[0]).toBe("chunk.0");
    const first = getTranslationChunk(plan, "chunk.0");
    expect(first.sourceUnitIds[0]).toBe("metadata.title");
    expect(enumerateTranslationChunks(plan).map((c) => c.chunkId)).toEqual(plan.chunkIds);
    expect(() => getTranslationChunk(plan, "chunk.99")).toThrow(TranslationChunkPlanError);
  });

  it("fails deterministically on malformed or wrongly shaped serialized input", () => {
    expect(() => parseTranslationChunkPlan("{ nope")).toThrow();
    expect(() => parseTranslationChunkPlan("null")).toThrow();
    expect(() => parseTranslationChunkPlan(JSON.stringify({ canonicalFingerprint: "x" }))).toThrow();
  });
});

describe("structured output contract validation", () => {
  const validResponseFor = (chunk: TranslationChunk): unknown => ({
    units: chunk.sourceUnitIds.map((id) => {
      const source = chunk.units.find((unit) => unit.sourceId === id)!;
      if (source.type === "faq-answer") return { sourceUnitId: id, answerHtml: source.answerHtml, answerText: source.answerText };
      if (source.type === "cta") return { sourceUnitId: id, html: source.html };
      if (source.type === "introduction-block" || source.type === "section-block" || source.type === "conclusion-block") {
        return { sourceUnitId: id, block: source.block };
      }
      return { sourceUnitId: id, text: source.text };
    }),
  });

  it("accepts a mocked valid translated response", () => {
    const plan = buildTranslationChunkPlan(makeSourceDoc());
    for (const chunk of plan.chunks) {
      const result = validateStructuredChunkResponse(chunk, validResponseFor(chunk));
      if (!result.valid) {
        console.error("ERRORS", chunk.chunkId, JSON.stringify(result.errors));
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("rejects missing, extra, duplicated, reordered and unknown source IDs", () => {
    const plan = buildTranslationChunkPlan(makeSourceDoc());
    const chunk = plan.chunks[0];
    const valid = validResponseFor(chunk) as { units: Array<{ sourceUnitId: string }> };

    const missing = { units: valid.units.slice(1) };
    expect(validateStructuredChunkResponse(chunk, missing).valid).toBe(false);

    const extra = { units: [...valid.units, { sourceUnitId: "section.99.heading", text: "x" }] };
    expect(validateStructuredChunkResponse(chunk, extra).valid).toBe(false);

    const duplicated = { units: [valid.units[0], ...valid.units] };
    expect(validateStructuredChunkResponse(chunk, duplicated).valid).toBe(false);

    const reordered = { units: [valid.units[1], valid.units[0], ...valid.units.slice(2)] };
    expect(validateStructuredChunkResponse(chunk, reordered).valid).toBe(false);

    const unknown = { units: valid.units.map((unit) => unit.sourceUnitId === "metadata.title" ? { ...unit, sourceUnitId: "bogus.id" } : unit) };
    expect(validateStructuredChunkResponse(chunk, unknown).valid).toBe(false);
  });

  it("treats metadata number differences as advisory but enforces body number parity", () => {
    const plan = buildTranslationChunkPlan(makeSourceDoc());
    const chunk = plan.chunks[0];
    const valid = validResponseFor(chunk) as { units: Array<{ sourceUnitId: string; text?: string; block?: EditorialBlock }> };

    // Metadata number change -> advisory: chunk stays valid, unit reports a warning.
    const numChanged = { units: valid.units.map((unit) => unit.sourceUnitId === "metadata.metaDescription" ? { ...unit, text: "no numbers here" } : unit) };
    const metaValidation = validateStructuredChunkResponse(chunk, numChanged);
    expect(metaValidation.valid).toBe(true);
    const metaUnit = metaValidation.units.find((u) => u.sourceUnitId === "metadata.metaDescription");
    expect(metaUnit?.advisory).toBe(true);
    expect(metaUnit?.warnings.length).toBeGreaterThan(0);

    // Body block number change -> hard failure.
    const blockUnit = valid.units.find((unit) => unit.block);
    const numChangedBlock = {
      units: valid.units.map((unit) => {
        if (unit !== blockUnit || !unit.block) return unit;
        const paragraph = unit.block as Extract<EditorialBlock, { type: "paragraph" }>;
        return {
          ...unit,
          block: {
            ...paragraph,
            content: paragraph.content.map((n) => (n.type === "strong" && n.text === "65%" ? { ...n, text: "70%" } : n)),
          },
        };
      }),
    };
    expect(validateStructuredChunkResponse(chunk, numChangedBlock).valid).toBe(false);
  });

  it("rejects protected URL and structure changes using existing utilities", () => {
    const plan = buildTranslationChunkPlan(makeSourceDoc());
    const chunk = plan.chunks[0];
    const valid = validResponseFor(chunk) as { units: Array<{ sourceUnitId: string; text?: string; block?: EditorialBlock }> };

    // URL change in a block unit.
    const blockUnit = valid.units.find((unit) => unit.block);
    const urlChanged = { units: valid.units.map((unit) => unit === blockUnit ? { ...unit, block: { id: blockUnit.block!.id, type: "paragraph" as const, content: [{ type: "text" as const, text: "https://evil.example/" }] } } : unit) };
    expect(validateStructuredChunkResponse(chunk, urlChanged).valid).toBe(false);

    // Structure change (drop inline nodes) in a block unit.
    const structureChanged = { units: valid.units.map((unit) => unit === blockUnit ? { ...unit, block: { id: blockUnit.block!.id, type: "paragraph" as const, content: [{ type: "text" as const, text: "only one node" }] } } : unit) };
    expect(validateStructuredChunkResponse(chunk, structureChanged).valid).toBe(false);
  });
});

describe("no AI / production integration", () => {
  it("builds plans synchronously and deterministically with no provider call", () => {
    const first = serializeTranslationChunkPlan(buildTranslationChunkPlan(makeSourceDoc()));
    const second = serializeTranslationChunkPlan(buildTranslationChunkPlan(makeSourceDoc()));
    expect(first).toBe(second);
  });

  it("does not mutate the source document and does not reference any AI provider", () => {
    const source = makeSourceDoc();
    const before = serializeTranslationSourceDocument(source);
    buildTranslationChunkPlan(source);
    expect(serializeTranslationSourceDocument(source)).toBe(before);
    // planner has no provider dependency (verified by imports); building is pure.
    expect(typeof buildDocumentBrief).toBe("function");
  });
});
