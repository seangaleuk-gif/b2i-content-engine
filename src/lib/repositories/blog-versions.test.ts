import { describe, expect, it } from "vitest";
import { normalizeBlogVersionRow } from "./blog-versions";

describe("normalizeBlogVersionRow", () => {
  it("normalizes raw Supabase snake_case rows to the BlogVersion contract", () => {
    const row = normalizeBlogVersionRow({
      id: 7,
      project_id: 14,
      user_id: "11111111-1111-1111-1111-111111111111",
      version_number: 3,
      title: "Title",
      slug: "title",
      meta_description: "Meta",
      excerpt: "Excerpt",
      blog: "<p>Blog</p>",
      faq: [],
      internal_links: ["/blog/example"],
      external_links: ["https://example.com"],
      categories: ["Resources"],
      tags: ["threads"],
      reading_time: "10 min",
      word_count: 2500,
      summary: "Summary",
      model: "deepseek-v4-flash",
      prompt_version: "translation-v6",
      generation_time_ms: 1234,
      token_usage: { totalTokens: 100 },
      status: "draft",
      created_at: "2026-07-31T00:00:00.000Z",
    });

    expect(row.projectId).toBe(14);
    expect(row.versionNumber).toBe(3);
    expect(row.metaDescription).toBe("Meta");
    expect(row.faq).toEqual([]);
    expect(row.internalLinks).toEqual(["/blog/example"]);
    expect(row.wordCount).toBe(2500);
    expect(row.promptVersion).toBe("translation-v6");
    expect(row.createdAt).toEqual(new Date("2026-07-31T00:00:00.000Z"));
  });

  it("preserves already-normalized camelCase rows", () => {
    const createdAt = new Date("2026-07-31T00:00:00.000Z");
    const row = normalizeBlogVersionRow({
      id: 8,
      projectId: 14,
      userId: "11111111-1111-1111-1111-111111111111",
      versionNumber: 4,
      title: "Title",
      slug: "title-zh",
      metaDescription: "描述",
      excerpt: "摘要",
      blog: "<p>文章</p>",
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "8 min",
      wordCount: 2200,
      summary: null,
      model: null,
      promptVersion: null,
      generationTimeMs: null,
      tokenUsage: null,
      status: "draft",
      createdAt,
    });

    expect(row.versionNumber).toBe(4);
    expect(row.metaDescription).toBe("描述");
    expect(row.createdAt).toBe(createdAt);
  });

  it("normalizes FAQ variants and removes malformed JSON entries", () => {
    const row = normalizeBlogVersionRow({
      id: 9,
      project_id: 14,
      user_id: "11111111-1111-1111-1111-111111111111",
      version_number: 5,
      faq: [
        { question: "Saved question", answer: "Saved answer" },
        { question: "Canonical question", answerText: "Canonical answer" },
        { question: "HTML question", answerHtml: "<p>HTML answer</p>" },
        { question: "", answer: "Missing question" },
        null,
      ],
      internal_links: [" /blog/example ", 123, ""],
      external_links: ["https://example.com"],
      categories: [" Resources "],
      tags: ["threads"],
      status: "draft",
      created_at: "2026-07-31T00:00:00.000Z",
    });

    expect(row.faq).toEqual([
      { question: "Saved question", answer: "Saved answer" },
      { question: "Canonical question", answer: "Canonical answer" },
      { question: "HTML question", answer: "<p>HTML answer</p>" },
    ]);
    expect(row.internalLinks).toEqual(["/blog/example"]);
    expect(row.categories).toEqual(["Resources"]);
  });

});
