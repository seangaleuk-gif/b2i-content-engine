import { describe, expect, it, vi } from "vitest";
import {
  CONCLUSION_END_MARKER,
  CONCLUSION_START_MARKER,
  FAQ_HEADING_MARKER,
} from "@/lib/blog/article-document";
import {
  regenerateMeta,
  regenerateSection,
  regenerateTitle,
  runComponentRegeneration,
  type GenContext,
} from "@/lib/services/component-regenerator";

const heading = (text: string): string =>
  `<!-- wp:heading {"level":2} --><h2>${text}</h2><!-- /wp:heading -->`;

const paragraph = (text: string): string =>
  `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

describe("component regeneration boundaries", () => {
  const regenerationContext = (chatWithRetry: GenContext["chatWithRetry"]): GenContext => ({
    chatWithRetry,
    promptContext: {
      project: {
        name: "Test",
        keyword: "content quality",
        audience: "SMEs",
        country: "Hong Kong",
        wordCount: 2500,
        content: "",
        status: "draft" as const,
      },
      research: [],
      knowledge: [],
      promptSections: [],
    },
  });

  it("keeps current metadata when regenerated alternatives contain unmatched quotations", async () => {
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ alternatives: ['An unfinished "metadata alternative that cannot be accepted safely'] }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));
    const currentTitle = "Content Quality Guidance for Hong Kong Business Teams";
    const currentMeta = "Practical content quality guidance for Hong Kong teams that need clearer writing and dependable publishing workflows.";

    await expect(regenerateTitle(regenerationContext(chatWithRetry), currentTitle, "content quality"))
      .resolves.toBe(currentTitle);
    await expect(regenerateMeta(regenerationContext(chatWithRetry), currentMeta, "content quality"))
      .resolves.toBe(currentMeta);
  });

  it("strips markup from regenerated metadata before accepting it", async () => {
    const safeTitle = "Content Quality Guidance for Hong Kong Business Teams";
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ alternatives: [`<script>private()</script>${safeTitle}`] }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    await expect(regenerateTitle(regenerationContext(chatWithRetry), "Original title", "content quality"))
      .resolves.toBe(safeTitle);
  });

  it("never replaces the conclusion or FAQ while regenerating the final editorial section", async () => {
    const difficult =
      "Interdisciplinary commercialization methodologies necessitate extraordinarily sophisticated organizational interoperability. "
      + "Institutionalization consequently accelerates incomprehensible administrative fragmentation.";
    const conclusion = paragraph(
      "The protected conclusion remains exactly where the application placed it.",
    );
    const faq = [
      FAQ_HEADING_MARKER,
      heading("Frequently Asked Questions"),
      "<!-- wp:html --><div class=\"faq-item\"><h3>Question?</h3><p>Protected answer.</p></div><!-- /wp:html -->",
    ].join("\n");
    const blog = [
      paragraph("Start here. Keep it clear."),
      heading("Simple opening section"),
      paragraph("People plan. Teams act. Results follow."),
      heading("Complex final section"),
      paragraph(difficult),
      CONCLUSION_START_MARKER,
      conclusion,
      CONCLUSION_END_MARKER,
      faq,
    ].join("\n\n");
    const replacementText = "Use a short plan. Test one idea. Improve it with feedback.";
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ blocks: [{ type: "paragraph", sentences: replacementText.match(/[^.!?]+[.!?]+/g)!.map((s) => ({ text: s.trim(), kind: "free_prose" })) }] }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    const result = await runComponentRegeneration(
      {
        chatWithRetry,
        promptContext: {
          project: {
            name: "Test",
            keyword: "content quality",
            audience: "SMEs",
            country: "Hong Kong",
            wordCount: 2500,
            content: "",
            status: "draft",
          },
          research: [],
          knowledge: [],
          promptSections: [],
        },
      },
      {
        title: "Content Quality Guidance for Hong Kong Business Teams",
        metaDescription:
          "Practical content quality guidance for Hong Kong teams that need clearer writing, safer evidence, stronger editing, and a dependable publishing workflow for every article.",
        blog,
      },
      ["Simple opening section", "Complex final section"],
      "content quality",
      { intro: 200, conclusion: 200, perSection: 300, keyphraseTarget: 8 },
    );

    expect(chatWithRetry).toHaveBeenCalled();
    expect(result.blog).toContain(replacementText);
    expect(result.blog).toContain(CONCLUSION_START_MARKER);
    expect(result.blog).toContain(conclusion);
    expect(result.blog).toContain(CONCLUSION_END_MARKER);
    expect(result.blog).toContain(FAQ_HEADING_MARKER);
    expect(result.blog).toContain("Protected answer.");
  });

  it("rejects raw HTML links returned outside the structured block contract", async () => {
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ blocks: [{
        type: "paragraph",
        sentences: [{
          text: 'Use <a href="https://invented.example">this advice</a> before acting.',
          kind: "free_prose",
        }],
      }] }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    await expect(regenerateSection(
      {
        chatWithRetry,
        promptContext: {
          project: {
            name: "Test",
            keyword: "content quality",
            audience: "SMEs",
            country: "Hong Kong",
            wordCount: 2500,
            content: "",
            status: "draft",
          },
          research: [],
          knowledge: [],
          promptSections: [],
        },
      },
      "Title",
      "Heading",
      "Previous",
      "Next",
      300,
      8,
      "content quality",
    )).rejects.toThrow(/contains raw HTML tags/);
  });
});

