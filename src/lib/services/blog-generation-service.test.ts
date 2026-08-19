import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeOutlineHeadings,
  OutlineHeadingValidationError,
  runBlogGeneration,
  runGenerationTasksWithConcurrency,
} from "@/lib/services/blog-generation-service";
import { resolveResearchDispatch } from "@/lib/services/blog-generation-service";
import { runPostAssemblyPipeline, createPipelineState } from "@/lib/pipeline/blog-generation-pipeline";
import { runBraveResearchWithRetry } from "@/lib/services/brave";
import { projectRepository, researchRepository } from "@/lib/repositories";

vi.mock("@/lib/repositories", () => ({
projectRepository: { findById: vi.fn() },
researchRepository: { findByProject: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue([]) },
knowledgeRepository: { findByUser: vi.fn().mockResolvedValue([]) },
promptSectionRepository: { seedDefaults: vi.fn().mockResolvedValue(undefined), findByUser: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/services/brave", () => ({
runBraveResearchWithRetry: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/services/prompt-compiler", () => ({
  getCompiledBundle: vi.fn().mockReturnValue({ bundle: { outlineSystem: "", introSystem: "", sectionSystem: "", conclusionSystem: "", faqSystem: "" } }),
}));

vi.mock("@/lib/services/prompt-builder", () => ({
  buildBlogPrompt: vi.fn().mockReturnValue({ systemPrompt: "", userMessage: "" }),
  buildOutlineBrief: vi.fn().mockReturnValue("Outline topic brief."),
  formatStageResearchEvidence: vi.fn().mockReturnValue("No approved research evidence."),
  STAGE_SYSTEM_PROMPTS: { outline: [], introduction: [], section: [], faq: [], conclusion: [] },
}));

vi.mock("@/lib/services/component-regenerator", () => ({
  runComponentRegeneration: vi.fn(), regenerateIntroduction: vi.fn(), regenerateSection: vi.fn(), regenerateConclusion: vi.fn(),
}));

vi.mock("@/lib/services/quality-scorer", () => ({ buildGenerationReport: vi.fn().mockReturnValue({}) }));

vi.mock("@/lib/services/generation-telemetry", () => ({
  GenerationTelemetry: vi.fn().mockImplementation(function () { return { startTimer: vi.fn(), endTimer: vi.fn(), getReport: vi.fn() }; }),
}));

vi.mock("@/lib/pipeline/blog-generation-pipeline", () => ({
  createPipelineState: vi.fn().mockReturnValue({ blog: "", faq: [], retryCount: 0, componentRegenerations: 0, warnings: [] }),
  runPostAssemblyPipeline: vi.fn().mockResolvedValue(undefined),
  validatePipelineOrder: vi.fn(),
}));

vi.mock("@/lib/services/article-postprocessors", () => ({
  sanitizeSectionUrls: vi.fn((h: string) => h),
  pairedSlugs: vi.fn((slug: string) => {
    const clean = String(slug || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/-zh$/, "") || "blog-post";
    return { englishSlug: clean, chineseSlug: `${clean}-zh` };
  }),
  renderLanguageSwitcher: vi.fn(({ chineseSlug }: { chineseSlug: string }) =>
    `<!-- wp:html --><div class="b2i-language-switcher"><span>English</span> | <a href="/blog/${chineseSlug}">繁體中文</a></div><!-- /wp:html -->`,
  ),
  isEligibleExternalSourceUrl: vi.fn((url: string) => {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return !["b2ihub.com", "app.b2ihub.com"].some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  }),
}));

// ── Test setup ──

beforeEach(() => {
  vi.mocked(projectRepository.findById).mockReset();
  vi.mocked(projectRepository.findById).mockResolvedValue({ id: 1, name: "T", keyword: "t", audience: "t", country: "HK", wordCount: 2500, content: "", status: "draft" } as any);
});

// ── Helpers for constructing mock DeepSeek responses ──

type StageResponse = { stage: string; content: string };

function outlineValid(): StageResponse {
  return {
    stage: "outline",
    content: JSON.stringify({
      title: "Test", slug: "test", metaDescription: "Meta desc with enough chars for validation testing purposes.",
      h2Headings: ["S1", "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions About Test"],
      excerpt: "Excerpt.",
    }),
  };
}

function blocksResponse(blocks: unknown[]): string {
  return JSON.stringify({ blocks });
}
function para(text: string): string {
  return blocksResponse([{ type: "paragraph", text }]);
}
/** Section-stage payload with STRUCTURAL sentence provenance: every
 *  generated sentence carries its own kind (free_prose here). */
function paraSection(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [text.trim()];
  return JSON.stringify({
    blocks: [{ type: "paragraph", sentences: sentences.map((s) => ({ text: s, kind: "free_prose" })) }],
  });
}

/** Build a deterministic mock DeepSeek request function.
 *  Overrides: specific stage + content pairs that deviate from defaults.
 *  Uses a per-stage queue so successive calls to the same stage consume
 *  overrides in order, then fall through to default responses. */
function buildRequestMock(overrides: StageResponse[]) {
  const queue = new Map<string, string[]>();
  for (const o of overrides) {
    if (!queue.has(o.stage)) queue.set(o.stage, []);
    queue.get(o.stage)!.push(o.content);
  }
  return (stage: string) => {
    const q = queue.get(stage);
    if (q && q.length > 0) return Promise.resolve({ content: q.shift()! });
    if (stage === "outline") return Promise.resolve({ content: outlineValid().content });
    if (stage === "faq") return Promise.resolve({ content: JSON.stringify({ heading: "Frequently Asked Questions", entries: [{ question: "What is this?", answer: "This is the first FAQ entry." }, { question: "How does it work?", answer: "It works through a simple process." }, { question: "Who should use this?", answer: "Anyone can use this effectively." }, { question: "When should I start?", answer: "Starting now is recommended for best results." }] }) });
    if (stage.startsWith("section_")) return Promise.resolve({ content: paraSection("Teams review the latest trends and build a clear plan for the year ahead.") });
    if (stage === "intro" || stage === "intro_retry" || stage === "intro_repair") return Promise.resolve({ content: para("Default intro.") });
    if (stage === "conclusion" || stage === "conclusion_retry" || stage === "conclusion_repair") return Promise.resolve({ content: para("Default conclusion.") });
    return Promise.resolve({ content: JSON.stringify({}) });
  };
}

describe("normalizeOutlineHeadings", () => {
  it("rejects an unmatched quotation in an editorial or FAQ heading", () => {
    expect(() => normalizeOutlineHeadings(
      ['An unfinished "heading', "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions"],
      2500,
      "Test",
      "test keyphrase",
    )).toThrow(OutlineHeadingValidationError);
    expect(() => normalizeOutlineHeadings(
      ["S1", "S2", "S3", "S4", "S5", "S6", "Frequently Asked “Questions"],
      2500,
      "Test",
      "test keyphrase",
    )).toThrow(OutlineHeadingValidationError);
  });

  it("adds the missing editorial H2 before the final FAQ heading for a 2500-word article", () => {
    const headings = normalizeOutlineHeadings(
      ["S1", "S2", "S3", "S4", "S5", "Frequently Asked Questions About Test"],
      2500,
      "Test",
      "test keyphrase",
    );
    expect(headings).toHaveLength(7);
    expect(headings.slice(0, -1)).toHaveLength(6);
    expect(headings.at(-1)).toMatch(/frequently asked questions/i);
  });

  it("removes conclusion headings and keeps one FAQ heading last", () => {
    const headings = normalizeOutlineHeadings(
      ["S1", "S2", "S3", "S4", "S5", "Conclusion", "FAQ About Test", "FAQ About Test"],
      2500,
      "Test",
      "test keyphrase",
    );
    expect(headings.some((heading) => /^conclusion$/i.test(heading))).toBe(false);
    expect(headings.filter((heading) => /faq|frequently asked/i.test(heading))).toHaveLength(1);
    expect(headings.at(-1)).toMatch(/faq|frequently asked/i);
  });

  it("repairs duplicated editorial topic wording without changing count, order or FAQ copy", () => {
    const faq = "Frequently Asked Questions About Hong Kong Marketing";
    const headings = normalizeOutlineHeadings(
      [
        "Hong Kong Marketing Trends 2026: What's Shaping Hong Kong Marketing",
        "Audience Behaviour",
        "Channel Planning",
        "Creative Execution",
        "Measurement Strategy",
        "Practical Next Steps",
        faq,
      ],
      2500,
      "Hong Kong Marketing Trends 2026",
      "hong kong marketing trends 2026",
    );
    expect(headings).toHaveLength(7);
    expect(headings[0]).toBe("Hong Kong Marketing Trends 2026");
    expect(headings.slice(1, -1)).toEqual([
      "Audience Behaviour",
      "Channel Planning",
      "Creative Execution",
      "Measurement Strategy",
      "Practical Next Steps",
    ]);
    expect(headings.at(-1)).toBe(faq);
  });

  it("normalizes the location-aware fallback instead of creating a duplicated Hong Kong", () => {
    const headings = normalizeOutlineHeadings(
      ["S1", "S2", "S3", "S4", "S5", "Frequently Asked Questions"],
      2500,
      "Hong Kong Marketing",
      "hong kong marketing",
    );
    expect(headings).toContain("Why Hong Kong Marketing Matters");
    expect(headings).not.toContain("Why Hong Kong Marketing Matters in Hong Kong");
  });

  it("fails early when a duplicated heading cannot be repaired without losing numbers", () => {
    expect(() => normalizeOutlineHeadings(
      [
        "Hong Kong 5G Marketing: Hong Kong Marketing for 10 Teams",
        "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions",
      ],
      2500,
      "Hong Kong Marketing",
      "hong kong marketing",
    )).toThrow(OutlineHeadingValidationError);
  });
});

// ── Introduction failure ──

describe("runBlogGeneration — introduction failure", () => {
  it("rejects a non-object outline without logging its model content", async () => {
    const privateMarker = "PRIVATE-OUTLINE-MARKER";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const mock = buildRequestMock([{ stage: "outline", content: JSON.stringify(privateMarker) }]);
      await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).rejects.toThrow();
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(privateMarker);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("invalid intro after retry throws", async () => {
    const mock = buildRequestMock([
      { stage: "intro", content: "NOT JSON {{{" },
      { stage: "intro_retry", content: "STILL NOT JSON {{{" },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).rejects.toThrow();
  });

  it("intro with HTML tag after retry throws", async () => {
    const mock = buildRequestMock([
      { stage: "intro", content: para("Has <div>HTML</div> in text") },
      { stage: "intro_repair", content: para("Has <div>HTML</div> in text") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).rejects.toThrow();
  });

  it("intro with WP comment after retry throws", async () => {
    const mock = buildRequestMock([
      { stage: "intro", content: para("<!-- wp:paragraph -->bad") },
      { stage: "intro_repair", content: para("<!-- wp:paragraph -->still bad") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).rejects.toThrow();
  });
});

// ── Introduction successful retry ──

describe("runBlogGeneration — introduction successful retry", () => {
  it("invalid first then valid retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "intro", content: "INVALID JSON" },
      { stage: "intro_retry", content: para("This valid intro reads clearly after the retry.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("WP comment first then clean retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "intro", content: para("<!-- wp:paragraph -->bad") },
      { stage: "intro_repair", content: para("This clean intro reads clearly after the repair.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });
});

// ── Section failure ──

describe("runBlogGeneration — section failure", () => {
  it("invalid section after retry throws with index and heading", async () => {
    const mock = buildRequestMock([
      { stage: "section_0", content: para("<!-- wp:paragraph -->bad") },
      { stage: "section_0_repair", content: para("<!-- wp:paragraph -->still bad") },
    ]);
    let err: unknown = null;
    try { await runBlogGeneration("u", 1, { requestDeepSeek: mock }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    const msg = (err as any)?.cause?.message || "";
    expect(msg).toContain("Section 0");
    expect(msg).toContain("S1");
  });
});

// ── Section successful retry ──

describe("runBlogGeneration — section successful retry", () => {
  it("routes an unmatched quotation through the existing targeted section repair", async () => {
    const stages: string[] = [];
    const base = buildRequestMock([
      { stage: "section_0", content: para('The model emitted an unfinished "quotation.') },
      { stage: "section_0_repair", content: paraSection("The repaired section contains complete professional prose.") },
    ]);
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: request })).resolves.toBeDefined();
    expect(stages.filter((stage) => stage === "section_0_repair")).toHaveLength(1);
  });

  it("invalid first then valid retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "section_0", content: para("<!-- wp:paragraph -->bad") },
      { stage: "section_0_repair", content: paraSection("This valid section reads clearly after the repair.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("repair response with generic heading block type is normalized and succeeds", async () => {
    vi.mocked(createPipelineState).mockClear();
    const mock = buildRequestMock([
      { stage: "section_0", content: para("<!-- wp:paragraph -->bad") },
      { stage: "section_0_repair", content: JSON.stringify({
        blocks: [
          { type: "heading", text: "Key Benefits" },
          { type: "paragraph", sentences: [{ text: "This valid section body reads clearly after the repair.", kind: "free_prose" }] },
        ],
      }) },
    ]);
    const result = await runBlogGeneration("u", 1, { requestDeepSeek: mock });
    expect(result).toBeDefined();
    const articleDoc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
    expect(articleDoc.sections[0].blocks[0]).toMatchObject({ type: "subheading", level: 3 });
    const subheadingBlock = articleDoc.sections[0].blocks.find((b) => b.type === "subheading");
    if (!subheadingBlock || subheadingBlock.type !== "subheading") throw new Error("expected subheading");
    expect(subheadingBlock.content).toEqual([{ type: "text", text: "Key Benefits" }]);
  });

  it("repair response with heading requesting level 2 still throws", async () => {
    const mock = buildRequestMock([
      { stage: "section_0", content: para("<!-- wp:paragraph -->bad") },
      { stage: "section_0_repair", content: blocksResponse([{ type: "heading", text: "Wrong", level: 2 }]) },
    ]);
    let err: unknown = null;
    try { await runBlogGeneration("u", 1, { requestDeepSeek: mock }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    const msg = err instanceof Error && "cause" in err && err.cause instanceof Error ? err.cause.message : "";
    expect(msg).toContain("Section 0");
    expect(msg).toContain("disallowed level 2");
  });
});

// ── Conclusion failure ──

describe("runBlogGeneration — conclusion failure", () => {
  it("invalid conclusion after retry throws", async () => {
    const mock = buildRequestMock([
      { stage: "conclusion", content: "NOT JSON {{{" },
      { stage: "conclusion_retry", content: "STILL NOT JSON {{{" },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).rejects.toThrow();
  });

  it("CTA content in conclusion after retry throws", async () => {
    const mock = buildRequestMock([
      { stage: "conclusion", content: para("Create your free profile today!") },
      { stage: "conclusion_repair", content: para("Sign up now and create your free profile!") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).rejects.toThrow();
  });
});

// ── Conclusion successful retry ──

describe("runBlogGeneration — conclusion successful retry", () => {
  it("invalid first then valid retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "conclusion", content: "NOT JSON" },
      { stage: "conclusion_retry", content: para("This valid conclusion reads clearly after the retry.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("CTA content first then clean retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "conclusion", content: para("Create your free profile today!") },
      { stage: "conclusion_repair", content: para("This clean conclusion reads clearly after the retry.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });
});

// ─── Successful flow ──

describe("runBlogGeneration — successful flow", () => {
  it("repairs unmatched outline metadata before drafting", async () => {
    vi.mocked(createPipelineState).mockClear();
    const stages: string[] = [];
    const base = buildRequestMock([
      {
        stage: "outline",
        content: JSON.stringify({
          title: 'An unfinished "title',
          slug: "test",
          metaDescription: "A complete practical description for professional teams.",
          excerpt: "A complete excerpt.",
          h2Headings: ["S1", "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions About Test"],
        }),
      },
      {
        stage: "outline_metadata_repair",
        content: JSON.stringify({
          title: "A Complete Test Title",
          slug: "complete-test-title",
          metaDescription: "A complete practical description for professional teams.",
          excerpt: "A complete excerpt.",
        }),
      },
    ]);
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };
    await runBlogGeneration("u", 1, { requestDeepSeek: request });
    expect(stages.filter((stage) => stage === "outline_metadata_repair")).toHaveLength(1);
    const doc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
    expect(doc.metadata.title).toBe("A Complete Test Title");
  });

  it("repairs an unmatched quotation in canonical FAQ copy before assembly", async () => {
    const stages: string[] = [];
    const validEntries = [
      { question: "What is this?", answer: "This is a practical planning approach." },
      { question: "How does it work?", answer: "It follows a clear process." },
      { question: "Who is it for?", answer: "It is for professional teams." },
      { question: "When should I begin?", answer: "Begin when the plan is ready." },
    ];
    const base = buildRequestMock([
      {
        stage: "faq",
        content: JSON.stringify({ entries: [
          { question: "What is this?", answer: 'It starts with an unfinished "example.' },
          ...validEntries.slice(1),
        ] }),
      },
      { stage: "faq_repair", content: JSON.stringify({ entries: validEntries }) },
    ]);
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: request })).resolves.toBeDefined();
    expect(stages.filter((stage) => stage === "faq_repair")).toHaveLength(1);
  });

  it("completes without errors", async () => {
    const mock = buildRequestMock([]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("keeps the accepted outline FAQ heading when the FAQ model returns a markup override", async () => {
    vi.mocked(createPipelineState).mockClear();
    const mock = buildRequestMock([{
      stage: "faq",
      content: JSON.stringify({
        heading: '<script>alert("faq")</script>',
        entries: [
          { question: "What is this?", answer: "This is the first FAQ entry." },
          { question: "How does it work?", answer: "It works through a simple process." },
          { question: "Who should use this?", answer: "Anyone can use this effectively." },
          { question: "When should I start?", answer: "Starting now is recommended for best results." },
        ],
      }),
    }]);

    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    const articleDoc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
    const faqHeading = articleDoc.sections.find((section) => section.sectionType === "faq-heading");
    expect(faqHeading?.heading).toBe("Frequently Asked Questions About Test");
    expect(faqHeading?.heading).not.toContain("<script>");
  });

  it("runs one targeted FAQ repair for invalid shape before assembly", async () => {
    vi.mocked(createPipelineState).mockClear();
    const validEntries = [
      { question: "What is this?", answer: "This is the first FAQ entry." },
      { question: "How does it work?", answer: "It works through a simple process." },
      { question: "Who should use this?", answer: "Professional teams can use it." },
      { question: "When should I start?", answer: "Start when the plan is ready." },
    ];
    const mock = buildRequestMock([
      { stage: "faq", content: JSON.stringify({ entries: [{ question: "Only one?", answer: "Too few." }] }) },
      { stage: "faq_repair", content: JSON.stringify({ entries: validEntries }) },
    ]);

    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    const doc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
    expect(doc.visibleFaq).toHaveLength(4);
    expect(doc.visibleFaq[0].question).toBe("What is this?");
  });

  it("repairs CTA/signup copy found in either an FAQ question or answer", async () => {
    const stages: string[] = [];
    const base = buildRequestMock([
      {
        stage: "faq",
        content: JSON.stringify({ entries: [
          { question: "How do I sign up?", answer: "Create your free profile today." },
          { question: "How does it work?", answer: "It follows a clear process." },
          { question: "Who is it for?", answer: "It is for professional teams." },
          { question: "When should I begin?", answer: "Begin when the plan is ready." },
        ] }),
      },
      {
        stage: "faq_repair",
        content: JSON.stringify({ entries: [
          { question: "What is this?", answer: "This is a practical planning approach." },
          { question: "How does it work?", answer: "It follows a clear process." },
          { question: "Who is it for?", answer: "It is for professional teams." },
          { question: "When should I begin?", answer: "Begin when the plan is ready." },
        ] }),
      },
    ]);
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };

    await runBlogGeneration("u", 1, { requestDeepSeek: request });

    expect(stages.filter((stage) => stage === "faq_repair")).toHaveLength(1);
  });

  it("fails before assembly when the targeted FAQ repair is still invalid", async () => {
    const mock = buildRequestMock([
      { stage: "faq", content: JSON.stringify({ entries: [] }) },
      { stage: "faq_repair", content: JSON.stringify({ entries: [{ question: "Still one?", answer: "Still too few." }] }) },
    ]);

    let failure: unknown;
    try {
      await runBlogGeneration("u", 1, { requestDeepSeek: mock });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeTruthy();
    const cause = failure instanceof Error && "cause" in failure && failure.cause instanceof Error
      ? failure.cause.message
      : "";
    expect(cause).toContain("FAQ generation failed deterministic acceptance");
  });

  it("normalizes outline metadata and slug before they enter prompts or protected markup", async () => {
    vi.mocked(createPipelineState).mockClear();
    const mock = buildRequestMock([{
      stage: "outline",
      content: JSON.stringify({
        title: '<b>Safe Planning</b> <script>alert("x")</script>',
        slug: 'Safe Planning"><img src=x onerror=alert(1)>',
        metaDescription: "<em>Practical guidance</em> for professional teams that need a clear, safe and measurable planning process.",
        excerpt: "<!-- wp:html -->A <strong>plain</strong> summary<!-- /wp:html -->",
        h2Headings: ["S1", "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions"],
      }),
    }]);

    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    const doc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
    expect(doc.metadata.title).toBe("Safe Planning");
    expect(doc.metadata.metaDescription).not.toMatch(/[<>]/);
    expect(doc.metadata.excerpt).toBe("A plain summary");
    expect(doc.metadata.slug).toBe("safe-planning-img-src-x-onerror-alert-1");
    expect(doc.languageSwitcher?.html).not.toMatch(/onclick|<img/i);
  });

  it("uses the corrected H2 in the section prompt and canonical document", async () => {
    vi.mocked(projectRepository.findById).mockResolvedValue({
      id: 1,
      name: "T",
      keyword: "hong kong marketing trends 2026",
      audience: "t",
      country: "HK",
      wordCount: 2500,
      content: "",
      status: "draft",
    } as unknown as Awaited<ReturnType<typeof projectRepository.findById>>);
    vi.mocked(createPipelineState).mockClear();
    const base = buildRequestMock([{
      stage: "outline",
      content: JSON.stringify({
        title: "Hong Kong Marketing Trends 2026",
        slug: "hong-kong-marketing-trends-2026",
        metaDescription: "A practical guide to current marketing planning and execution for professional teams in Hong Kong.",
        h2Headings: [
          "Hong Kong Marketing Trends 2026: What's Shaping Hong Kong Marketing",
          "Audience Behaviour", "Channel Planning", "Creative Execution",
          "Measurement Strategy", "Practical Next Steps", "Frequently Asked Questions",
        ],
      }),
    }, {
      stage: "section_0",
      content: paraSection("The latest trends shape how Hong Kong marketing works for local teams."),
    }, {
      stage: "section_1",
      content: paraSection("Audience behaviour changes how local teams plan their outreach."),
    }, {
      stage: "section_2",
      content: paraSection("Channel planning keeps the whole plan on track."),
    }, {
      stage: "section_3",
      content: paraSection("Creative execution drives the campaign forward."),
    }, {
      stage: "section_4",
      content: paraSection("Measurement strategy shows what actually works."),
    }, {
      stage: "section_5",
      content: paraSection("Practical next steps follow the plan."),
    }]);
    const calls: Array<{ stage: string; user: string }> = [];
    const request = async (stage: string, messages: Array<{ role: string; content: string }>) => {
      calls.push({ stage, user: messages.find((message) => message.role === "user")?.content ?? "" });
      return base(stage);
    };

    await runBlogGeneration("u", 1, { requestDeepSeek: request });

    const sectionCall = calls.find((call) => call.stage === "section_0");
    expect(sectionCall?.user).toContain('Section heading: "Hong Kong Marketing Trends 2026"');
    expect(sectionCall?.user).not.toContain("What's Shaping Hong Kong Marketing");
    const articleDoc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
    expect(articleDoc.sections[0].heading).toBe("Hong Kong Marketing Trends 2026");
  });

  it("runs one targeted outline-quality retry before any section when repair is unsafe", async () => {
    vi.mocked(projectRepository.findById).mockResolvedValue({
      id: 1, name: "T", keyword: "hong kong marketing", audience: "t", country: "HK",
      wordCount: 2500, content: "", status: "draft",
    } as unknown as Awaited<ReturnType<typeof projectRepository.findById>>);
    const base = buildRequestMock([
      {
        stage: "outline",
        content: JSON.stringify({
          title: "Hong Kong Marketing",
          slug: "hong-kong-marketing",
          metaDescription: "A practical guide to marketing planning and execution for professional teams working in Hong Kong.",
          h2Headings: [
            "Hong Kong 5G Marketing: Hong Kong Marketing for 10 Teams",
            "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions",
          ],
        }),
      },
      {
        stage: "outline_quality_retry",
        content: JSON.stringify({
          h2Headings: [
            "5G Marketing for 10 Hong Kong Teams",
            "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions",
          ],
        }),
      },
    ]);
    const stages: string[] = [];
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };

    await runBlogGeneration("u", 1, { requestDeepSeek: request });

    expect(stages).toContain("outline_quality_retry");
    expect(stages.indexOf("outline_quality_retry")).toBeLessThan(stages.indexOf("section_0"));
    expect(stages.filter((stage) => stage === "outline_quality_retry")).toHaveLength(1);
  });
});

describe("generation concurrency failure boundary", () => {
  it("awaits in-flight siblings and starts no new work after the first fatal failure", async () => {
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
    let siblingSettled = false;
    let pipelineRejected = false;
    const neverStarted = vi.fn(async () => "third");

    const running = runGenerationTasksWithConcurrency([
      async () => { throw new Error("section failed"); },
      async () => {
        await siblingGate;
        siblingSettled = true;
        return "late sibling";
      },
      neverStarted,
    ], 2).catch((error) => {
      pipelineRejected = true;
      throw error;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(pipelineRejected).toBe(false);
    expect(siblingSettled).toBe(false);
    expect(neverStarted).not.toHaveBeenCalled();

    releaseSibling();
    await expect(running).rejects.toThrow("section failed");
    expect(siblingSettled).toBe(true);
    expect(neverStarted).not.toHaveBeenCalled();
  });

  it("treats an undefined rejection reason as a real failure", async () => {
    let secondStarted = false;
    const running = runGenerationTasksWithConcurrency([
      () => Promise.reject(undefined),
      async () => {
        secondStarted = true;
        return "late";
      },
    ], 1);

    await expect(running).rejects.toBeUndefined();
    expect(secondStarted).toBe(false);
  });
});

// ── Research dispatch ──

describe("resolveResearchDispatch", () => {
  it("runs automatic research when no sources exist and a topic is present", () => {
    const decision = resolveResearchDispatch(0, "hong kong influencer marketing");
    expect(decision.mode).toBe("auto");
    expect(decision.willRun).toBe(true);
  });

  it("uses manual research as-is when sources already exist", () => {
    const decision = resolveResearchDispatch(4, "hong kong influencer marketing");
    expect(decision.mode).toBe("manual");
    expect(decision.willRun).toBe(false);
  });

  it("never auto-runs without a topic", () => {
    const decision = resolveResearchDispatch(0, "  ");
    expect(decision.willRun).toBe(false);
    expect(decision.reason).toContain("no keyword or topic");
  });
});

describe("runBlogGeneration — automatic research dispatch", () => {
  beforeEach(() => {
    vi.mocked(projectRepository.findById).mockReset();
    vi.mocked(projectRepository.findById).mockResolvedValue({
      id: 1, name: "T", keyword: "hong kong influencer marketing", audience: "t", country: "HK",
      wordCount: 2500, content: "", status: "draft",
    } as unknown as Awaited<ReturnType<typeof projectRepository.findById>>);
    vi.mocked(researchRepository.findByProject).mockReset();
    vi.mocked(researchRepository.findByProject).mockResolvedValue([]);
    vi.mocked(researchRepository.createMany).mockReset();
    vi.mocked(researchRepository.createMany).mockResolvedValue([]);
    vi.mocked(runBraveResearchWithRetry).mockReset();
    vi.mocked(runPostAssemblyPipeline).mockClear();
    vi.mocked(createPipelineState).mockClear();
  });

  it("calls the research provider and hands the approved sources to the pipeline when no manual research exists", async () => {
    const source = {
      title: "Influencer Marketing Report", url: "https://example.com/report",
      snippet: "Hong Kong brands trust micro creators.", category: "google" as const, position: 0,
    };
    vi.mocked(runBraveResearchWithRetry).mockResolvedValue([source]);
    vi.mocked(researchRepository.findByProject)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1, projectId: 1, ...source, createdAt: new Date() }]);

    const mock = buildRequestMock([]);
    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    expect(runBraveResearchWithRetry).toHaveBeenCalledWith("hong kong influencer marketing");
    expect(researchRepository.createMany).toHaveBeenCalledWith([expect.objectContaining({ url: "https://example.com/report" })]);
    const context = vi.mocked(runPostAssemblyPipeline).mock.calls[0][1].context as { research: Array<{ url: string; title: string }> };
    expect(context.research.length).toBe(1);
    expect(context.research[0].url).toBe("https://example.com/report");
  });

  it("skips automatic research and preserves manually selected sources", async () => {
    const manual = { id: 7, projectId: 1, title: "Manual Source", url: "https://manual.example.com/a", snippet: "s", category: "google" as const, position: 0, createdAt: "2026-01-01T00:00:00Z" };
    vi.mocked(researchRepository.findByProject).mockResolvedValue([manual as unknown as Awaited<ReturnType<typeof researchRepository.findByProject>>[number]]);

    const mock = buildRequestMock([]);
    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    expect(runBraveResearchWithRetry).not.toHaveBeenCalled();
    expect(researchRepository.createMany).not.toHaveBeenCalled();
    const context = vi.mocked(runPostAssemblyPipeline).mock.calls[0][1].context as unknown as { research: Array<{ url: string; title: string }> };
    expect(context.research).toHaveLength(1);
    expect(context.research[0].url).toBe("https://manual.example.com/a");
  });

  it("does not fabricate sources when the research provider fails", async () => {
    vi.mocked(runBraveResearchWithRetry).mockRejectedValue(new Error("Brave Search API authentication failed (401)"));

    const mock = buildRequestMock([]);
    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    expect(researchRepository.createMany).not.toHaveBeenCalled();
    const context = vi.mocked(runPostAssemblyPipeline).mock.calls[0][1].context as unknown as { research: Array<{ url: string; title: string }> };
    expect(context.research).toEqual([]);
    const warnings = vi.mocked(createPipelineState).mock.results[0]?.value?.warnings ?? [];
    expect(warnings.some((w: string) => w.includes("Automatic research failed"))).toBe(true);
  });

  it("does not fabricate sources when the provider returns zero results", async () => {
    vi.mocked(runBraveResearchWithRetry).mockResolvedValue([]);

    const mock = buildRequestMock([]);
    await runBlogGeneration("u", 1, { requestDeepSeek: mock });

    expect(researchRepository.createMany).not.toHaveBeenCalled();
    const warnings = vi.mocked(createPipelineState).mock.results[0]?.value?.warnings ?? [];
    expect(warnings.some((w: string) => w.includes("returned no sources"))).toBe(true);
  });

  it("reports the real external-link count in the saved metadata", async () => {
    const htmlWithLink = `<!-- wp:paragraph --><p>See <a href="https://example.com/report">the report</a> for details.</p><!-- /wp:paragraph -->`;
    vi.mocked(createPipelineState).mockReturnValue({
      blog: htmlWithLink, faq: [], retryCount: 0, componentRegenerations: 0, warnings: [],
    } as unknown as Awaited<ReturnType<typeof createPipelineState>>);
    const mock = buildRequestMock([]);
    const result = await runBlogGeneration("u", 1, { requestDeepSeek: mock });
    expect(result.generated.externalLinks).toEqual(["https://example.com/report"]);
  });
});

describe("section producer topic-grounding gate", () => {
  const groundedOutline = JSON.stringify({
    title: "Test", slug: "test", metaDescription: "Meta desc with enough chars for validation testing purposes.",
    h2Headings: ["Budgeting for 2026: Where to Invest", "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions About Test"],
    excerpt: "Excerpt.",
  });
  const UNGROUNDED = "The 2026 outlook shapes what teams do next.";
  const GROUNDED = "Smart budgets keep the plan focused on what matters most this year.";

  it("an ungrounded section body triggers exactly one bounded grounding regeneration and the repaired candidate is accepted", async () => {
    const stages: string[] = [];
    const base = buildRequestMock([
      { stage: "outline", content: groundedOutline },
      { stage: "section_0", content: paraSection(UNGROUNDED) },
      { stage: "section_0_grounding", content: paraSection(GROUNDED) },
    ]);
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: request })).resolves.toBeDefined();
    expect(stages.filter((stage) => stage === "section_0_grounding")).toHaveLength(1);
  });

  it("a second ungrounded candidate fails safely at the producer (never assembled)", async () => {
    const base = buildRequestMock([
      { stage: "outline", content: groundedOutline },
      { stage: "section_0", content: paraSection(UNGROUNDED) },
      { stage: "section_0_grounding", content: paraSection("The 2026 outlook shapes what teams do next.") },
    ]);
    let err: unknown = null;
    try { await runBlogGeneration("u", 1, { requestDeepSeek: base }); } catch (error) { err = error; }
    expect(err).not.toBeNull();
    const msg = err instanceof Error && "cause" in err && err.cause instanceof Error
      ? (err.cause as Error).message
      : err instanceof Error ? err.message : String(err);
    expect(msg).toContain("still does not address its topic");
  });

  it("an already-grounded section body does not trigger the grounding regeneration", async () => {
    const stages: string[] = [];
    const base = buildRequestMock([
      { stage: "outline", content: groundedOutline },
      { stage: "section_0", content: paraSection(GROUNDED) },
    ]);
    const request = async (stage: string) => {
      stages.push(stage);
      return base(stage);
    };
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: request })).resolves.toBeDefined();
    expect(stages.some((stage) => stage.includes("grounding"))).toBe(false);
  });
});

// ── Producer-content-contract shadow integration (Stage 3B) ──
// The shared contract observes pre-assembly candidates WITHOUT authority:
// existing validation still decides accept/reject/repair; disagreements are
// recorded as debug events under ENABLE_PIPELINE_DEBUG_TRACE.

describe("producer contract shadow integration", () => {
  function shadowEvents(warnSpy: ReturnType<typeof vi.spyOn>): string[] {
    return (warnSpy.mock.calls as Array<Array<unknown>>)
      .map((args: unknown[]) => args.map(String).join(" "))
      .filter((line: string) => line.includes("[producer-contract-shadow]"));
  }

  it("D: the intro repair candidate is shadow-evaluated and production authority is unchanged", async () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(createPipelineState).mockClear();
      const mock = buildRequestMock([
        // Generation fails EXISTING validation (fragment) → repair runs.
        { stage: "intro", content: para("Free delivery for members.") },
        // Repair passes existing validation (accepted) but the shared contract
        // rejects the duplicated determiner → disagreement recorded.
        { stage: "intro_repair", content: para("The a menu changes daily.") },
      ]);
      await runBlogGeneration("u", 1, { requestDeepSeek: mock });

      // Production unchanged: the repair candidate is accepted as today.
      const doc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
      const introBlock = doc.introduction.blocks[0];
      if (introBlock.type !== "paragraph") throw new Error("expected paragraph block");
      expect(introBlock.content[0].text).toBe("The a menu changes daily.");

      // Shadow: the REPAIRED candidate was evaluated and the disagreement logged.
      const events = shadowEvents(warnSpy);
      expect(events.some((line) =>
        line.includes("label=intro repair")
        && line.includes("existing=pass contract=fail")
        && line.includes("duplicated-determiner"),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
      delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    }
  });

  it("E: FAQ existing validation remains authoritative while the FAQ repair candidate is shadow-evaluated", async () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(createPipelineState).mockClear();
      const validEntries = [
        { question: "What is this?", answer: "This is a practical planning approach." },
        { question: "How does it work?", answer: "It follows a clear process." },
        { question: "Who is it for?", answer: "It is for professional teams." },
        { question: "When should I begin?", answer: "Begin when the plan is ready." },
      ];
      const mock = buildRequestMock([
        // Generation fails existing validation (fragment answer + count) → repair.
        { stage: "faq", content: JSON.stringify({ entries: [{ question: "Only one?", answer: "Free delivery for members." }] }) },
        // Repair passes validateFaqPayload (authoritative) but the shared
        // contract rejects the duplicated determiner → disagreement recorded.
        { stage: "faq_repair", content: JSON.stringify({ entries: [{ question: "What is this?", answer: "The a menu changes daily." }, ...validEntries.slice(1)] }) },
      ]);
      await runBlogGeneration("u", 1, { requestDeepSeek: mock });

      // Production authoritative: the repaired answer enters canonical visibleFaq.
      const doc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
      expect(doc.visibleFaq[0].answerText).toBe("The a menu changes daily.");
      expect(doc.visibleFaq).toHaveLength(4);

      // Shadow: disagreement recorded for the FAQ repair candidate.
      const events = shadowEvents(warnSpy);
      expect(events.some((line) =>
        line.includes("label=faq repair")
        && line.includes("existing=pass contract=fail")
        && line.includes("duplicated-determiner"),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
      delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    }
  });

  it("shadow-evaluates the section grounding regeneration candidate", async () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(createPipelineState).mockClear();
      const groundedOutline = JSON.stringify({
        title: "Test", slug: "test", metaDescription: "Meta desc with enough chars for validation testing purposes.",
        h2Headings: ["Budgeting for 2026: Where to Invest", "S2", "S3", "S4", "S5", "S6", "Frequently Asked Questions About Test"],
        excerpt: "Excerpt.",
      });
      const mock = buildRequestMock([
        { stage: "outline", content: groundedOutline },
        { stage: "section_0", content: paraSection("The 2026 outlook shapes what teams do next.") },
        // Grounded (shares "budget" token) and accepted by existing validation,
        // but the shared contract rejects the duplicated determiner.
        { stage: "section_0_grounding", content: paraSection("Smart budgets keep the plan focused on the a menu changes daily.") },
      ]);
      await runBlogGeneration("u", 1, { requestDeepSeek: mock });

      // Production unchanged: the grounding candidate is accepted.
      const doc = vi.mocked(createPipelineState).mock.calls[0][0].articleDoc;
      const sectionBlock = doc.sections[0].blocks[0];
      if (sectionBlock.type !== "paragraph") throw new Error("expected paragraph block");
      expect(sectionBlock.content[0].text).toContain("the a menu changes daily");

      const events = shadowEvents(warnSpy);
      expect(events.some((line) =>
        line.includes("label=section-0 grounding")
        && line.includes("existing=pass contract=fail")
        && line.includes("duplicated-determiner"),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
      delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    }
  });
});





