import { beforeEach, describe, expect, it, vi } from "vitest";
import { blogVersionRepository, normalizeBlogVersionRow } from "./blog-versions";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
  getDb: () => ({ rpc }),
}));

beforeEach(() => {
  rpc.mockReset();
});

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

describe("createEnglishVersionAtomically", () => {
  it("delegates allocation, insertion, and project promotion to one database transaction", async () => {
    rpc.mockResolvedValue({
      data: {
        id: 17,
        project_id: 9,
        user_id: "11111111-1111-1111-1111-111111111111",
        version_number: 4,
        title: "Title",
        slug: "title",
        blog: "<p>Saved</p>",
        faq: [],
        internal_links: [],
        external_links: [],
        categories: [],
        tags: [],
        status: "draft",
        created_at: "2026-08-14T00:00:00.000Z",
      },
      error: null,
    });

    const input = {
      projectId: 9,
      userId: "11111111-1111-1111-1111-111111111111",
      title: "Title",
      slug: "title",
      blog: "<p>Saved</p>",
      status: "draft",
    };
    await expect(blogVersionRepository.createEnglishVersionAtomically(input)).resolves.toMatchObject({
      id: 17,
      projectId: 9,
      versionNumber: 4,
      blog: "<p>Saved</p>",
    });
    expect(rpc).toHaveBeenCalledWith("save_generated_english_blog_version", {
      p_project_id: 9,
      p_user_id: "11111111-1111-1111-1111-111111111111",
      p_payload: input,
    });
  });

  it("fails closed when the atomic save returns no created row", async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await expect(blogVersionRepository.createEnglishVersionAtomically({
      projectId: 9,
      userId: "11111111-1111-1111-1111-111111111111",
      slug: "title",
      blog: "<p>Saved</p>",
    })).rejects.toThrow("invalid result");
  });
});

describe("synchronizeProjectContentToLatestEnglish", () => {
  it("calls the atomic database boundary and normalizes its result", async () => {
    rpc.mockResolvedValue({
      data: [{ version_id: 17, version_number: 4, blog: "<p>Latest</p>" }],
      error: null,
    });

    await expect(
      blogVersionRepository.synchronizeProjectContentToLatestEnglish(9, "user-1", "<p>Fallback</p>"),
    ).resolves.toEqual({
      versionId: 17,
      versionNumber: 4,
      blog: "<p>Latest</p>",
    });
    expect(rpc).toHaveBeenCalledWith("sync_project_content_to_latest_english_blog_version", {
      p_project_id: 9,
      p_user_id: "user-1",
      p_fallback_content: "<p>Fallback</p>",
    });
  });

  it("fails closed when the database boundary returns no validated row", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await expect(
      blogVersionRepository.synchronizeProjectContentToLatestEnglish(9, "user-1", ""),
    ).rejects.toThrow("invalid result");
  });
});
