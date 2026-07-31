import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildOutlineBrief,
  formatStageResearchEvidence,
  STAGE_SYSTEM_PROMPTS,
} from "./prompt-builder";

const minimalContext = {
  project: { name: "Test", keyword: "test", audience: "test", country: "HK", wordCount: 2500, content: "", status: "draft" },
  research: [],
  knowledge: [],
  promptSections: [
    { key: "brand_voice", label: "brand_voice", content: "Test brand voice." },
    { key: "seo_rules", label: "seo_rules", content: "Test SEO rules." },
    { key: "formatting_rules", label: "formatting_rules", content: "Test formatting rules." },
    { key: "hong_kong_context", label: "hong_kong_context", content: "Test HK context." },
    { key: "blog_structure", label: "blog_structure", content: "Test blog structure." },
    { key: "cta", label: "cta", content: "Test CTA." },
  ],
};

describe("prompt-builder stage format scoping", () => {
  it("outline stage has a JSON-only contract and no WordPress-block demand", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.outline);
    expect(prompt).toContain("title, slug, metaDescription and h2Headings");
    expect(prompt).not.toContain("Every heading must be <!-- wp:heading");
  });

  it("FAQ stage has the same structured JSON contract as its caller", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.faq);
    expect(prompt).toContain('"entries"');
    expect(prompt).not.toContain("Every heading must be <!-- wp:heading");
  });

  it("introduction stage asks for structured editorial blocks", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.introduction);
    expect(prompt).toContain("structured editorial blocks");
    expect(prompt).toContain("application renders canonical WordPress blocks");
  });

  it("section stage asks for structured editorial blocks", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.section);
    expect(prompt).toContain("structured editorial blocks");
    expect(prompt).not.toContain("Every heading must be <!-- wp:heading");
  });

  it("conclusion generation does NOT contain the application CTA HTML or signup URL", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.conclusion);
    expect(prompt).not.toContain("app.b2ihub.com/signup");
    expect(prompt).not.toContain("Create Your Free Profile");
    expect(prompt).not.toContain("免費建立檔案");
  });

  it("conclusion generation does NOT include the ## CTA Block section", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.conclusion);
    expect(prompt).not.toContain("## CTA Block");
  });

  it("conclusion generation has the structured JSON output contract", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.conclusion);
    expect(prompt).toContain("CRITICAL OUTPUT CONTRACT");
    expect(prompt).toContain("structured editorial blocks");
  });

  it("conclusion generation includes brand voice without conflicting full-article formatting rules", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.conclusion);
    expect(prompt).toContain("Brand Voice");
    expect(prompt).not.toContain("## Formatting Rules");
  });
});

describe("stage research evidence", () => {
  it("includes exact snippets, stable source IDs and URLs", () => {
    const evidence = formatStageResearchEvidence([{
      category: "statistics",
      title: "Hong Kong survey",
      snippet: "97.9% of respondents had used Threads.",
      url: "https://example.com/survey",
    }]);
    expect(evidence).toContain("SOURCE-1: Hong Kong survey");
    expect(evidence).toContain("97.9% of respondents had used Threads.");
    expect(evidence).toContain("https://example.com/survey");
  });

  it("forbids precise claims when no research exists", () => {
    expect(formatStageResearchEvidence([])).toContain(
      "Do not use precise numbers",
    );
  });
});

describe("outline brief evidence boundary", () => {
  it("includes safe research topics but withholds prior article prose, snippets, numbers and URLs", () => {
    const brief = buildOutlineBrief({
      ...minimalContext,
      project: {
        ...minimalContext.project,
        content: "Old article: Threads has 2.4 million users. Add a CTA and full FAQ.",
      },
      research: [{
        category: "statistics",
        title: "Hong Kong Threads audience survey: 2.4 million users in 2025",
        snippet: "Threads has 2.4 million monthly active users.",
        url: "https://example.com/audience",
      }],
    });
    expect(brief).toContain("Hong Kong Threads audience survey");
    expect(brief).not.toContain("Old article");
    expect(brief).not.toContain("2.4 million");
    expect(brief).not.toContain("2025");
    expect(brief).not.toContain("https://example.com/audience");
    expect(brief).toContain("Do not infer or include statistics");
  });
});
