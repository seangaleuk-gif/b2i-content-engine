import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeOutlineHeadings,
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
  pairedSlugs: vi.fn((slug: string) => ({ englishSlug: slug.replace(/-zh$/, ""), chineseSlug: `${slug.replace(/-zh$/, "")}-zh` })),
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
    if (stage.startsWith("section_")) return Promise.resolve({ content: para("Valid section content.") });
    if (stage === "intro" || stage === "intro_retry" || stage === "intro_repair") return Promise.resolve({ content: para("Default intro.") });
    if (stage === "conclusion" || stage === "conclusion_retry" || stage === "conclusion_repair") return Promise.resolve({ content: para("Default conclusion.") });
    return Promise.resolve({ content: JSON.stringify({}) });
  };
}

describe("normalizeOutlineHeadings", () => {
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
});

// ── Introduction failure ──

describe("runBlogGeneration — introduction failure", () => {
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
      { stage: "intro_retry", content: para("Valid intro after retry.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("WP comment first then clean retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "intro", content: para("<!-- wp:paragraph -->bad") },
      { stage: "intro_repair", content: para("Clean intro after repair.") },
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
  it("invalid first then valid retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "section_0", content: para("<!-- wp:paragraph -->bad") },
      { stage: "section_0_repair", content: para("Valid section after repair.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("repair response with generic heading block type is normalized and succeeds", async () => {
    vi.mocked(createPipelineState).mockClear();
    const mock = buildRequestMock([
      { stage: "section_0", content: para("<!-- wp:paragraph -->bad") },
      { stage: "section_0_repair", content: blocksResponse([
        { type: "heading", text: "Key Benefits" },
        { type: "paragraph", text: "Valid section body after repair." },
      ]) },
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
      { stage: "conclusion_retry", content: para("Valid conclusion after retry.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });

  it("CTA content first then clean retry succeeds", async () => {
    const mock = buildRequestMock([
      { stage: "conclusion", content: para("Create your free profile today!") },
      { stage: "conclusion_repair", content: para("Clean conclusion after retry.") },
    ]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
  });
});

// ─── Successful flow ──

describe("runBlogGeneration — successful flow", () => {
  it("completes without errors", async () => {
    const mock = buildRequestMock([]);
    await expect(runBlogGeneration("u", 1, { requestDeepSeek: mock })).resolves.toBeDefined();
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
