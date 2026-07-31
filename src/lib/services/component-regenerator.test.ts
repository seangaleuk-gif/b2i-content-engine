import { describe, expect, it, vi } from "vitest";
import {
  CONCLUSION_END_MARKER,
  CONCLUSION_START_MARKER,
  FAQ_HEADING_MARKER,
} from "@/lib/blog/article-document";
import {
  regenerateSection,
  runComponentRegeneration,
} from "@/lib/services/component-regenerator";

const heading = (text: string): string =>
  `<!-- wp:heading {"level":2} --><h2>${text}</h2><!-- /wp:heading -->`;

const paragraph = (text: string): string =>
  `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

describe("component regeneration boundaries", () => {
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
    const replacement = paragraph(
      "Use a short plan. Test one idea. Improve it with feedback.",
    );
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ body: replacement }),
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
    expect(result.blog).toContain(replacement);
    expect(result.blog).toContain(CONCLUSION_START_MARKER);
    expect(result.blog).toContain(conclusion);
    expect(result.blog).toContain(CONCLUSION_END_MARKER);
    expect(result.blog).toContain(FAQ_HEADING_MARKER);
    expect(result.blog).toContain("Protected answer.");
  });

  it("strips regenerated links that are not present in research", async () => {
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({
        body: paragraph(
          'Use <a href="https://invented.example">this advice</a> and review https://another-invented.example before acting.',
        ),
      }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    const body = await regenerateSection(
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
    );

    expect(body).toContain("this advice");
    expect(body).not.toContain("<a ");
    expect(body).not.toContain("invented.example");
  });
});
