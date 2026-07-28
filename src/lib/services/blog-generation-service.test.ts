import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBlogGeneration } from "@/lib/services/blog-generation-service";
import { projectRepository } from "@/lib/repositories";

vi.mock("@/lib/repositories", () => ({
  projectRepository: { findById: vi.fn() },
  researchRepository: { findByProject: vi.fn().mockResolvedValue([]) },
  knowledgeRepository: { findByUser: vi.fn().mockResolvedValue([]) },
  promptSectionRepository: { seedDefaults: vi.fn().mockResolvedValue(undefined), findByUser: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/services/prompt-compiler", () => ({
  getCompiledBundle: vi.fn().mockReturnValue({ bundle: { outlineSystem: "", introSystem: "", sectionSystem: "", conclusionSystem: "", faqSystem: "" } }),
}));

vi.mock("@/lib/services/prompt-builder", () => ({
  buildBlogPrompt: vi.fn().mockReturnValue({ systemPrompt: "", userMessage: "" }),
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

vi.mock("@/lib/services/article-postprocessors", () => ({ sanitizeSectionUrls: vi.fn((h: string) => h) }));

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
      h2Headings: ["S1", "S2", "S3", "S4", "S5", "Frequently Asked Questions About Test"],
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
    if (stage.startsWith("section_5")) return Promise.resolve({ content: JSON.stringify({ body: "<!-- wp:paragraph --><p><strong>Q?</strong> A.</p><!-- /wp:paragraph -->" }) });
    if (stage.startsWith("section_")) return Promise.resolve({ content: para("Valid section content.") });
    if (stage === "intro" || stage === "intro_retry" || stage === "intro_repair") return Promise.resolve({ content: para("Default intro.") });
    if (stage === "conclusion" || stage === "conclusion_retry" || stage === "conclusion_repair") return Promise.resolve({ content: para("Default conclusion.") });
    return Promise.resolve({ content: JSON.stringify({}) });
  };
}

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
