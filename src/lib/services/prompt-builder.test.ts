import { describe, it, expect } from "vitest";
import { buildSystemPrompt, STAGE_SYSTEM_PROMPTS } from "./prompt-builder";

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
  it("outline stage uses WordPress block format (not structured JSON blocks)", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.outline);
    expect(prompt).toContain("WordPress block format");
  });

  it("FAQ stage uses WordPress block format (not structured JSON blocks)", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.faq);
    expect(prompt).toContain("WordPress block format");
  });

  it("introduction stage system prompt uses WordPress block format", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.introduction);
    expect(prompt).toContain("WordPress block format");
  });

  it("section stage system prompt uses WordPress block format", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.section);
    expect(prompt).toContain("WordPress block format");
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

  it("conclusion generation still has CRITICAL FORMAT requirement", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.conclusion);
    expect(prompt).toContain("CRITICAL FORMAT REQUIREMENT");
  });

  it("conclusion generation includes brand voice and formatting rules", () => {
    const prompt = buildSystemPrompt(minimalContext, STAGE_SYSTEM_PROMPTS.conclusion);
    expect(prompt).toContain("Brand Voice");
    expect(prompt).toContain("Formatting Rules");
  });
});
