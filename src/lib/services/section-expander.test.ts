import { describe, expect, it, vi } from "vitest";
import { expandToMinimum, trimToMaximum } from "@/lib/services/section-expander";

const paragraph = (text: string): string =>
  `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

describe("section expansion safety", () => {
  it("uses the pipeline canonical word counter after every accepted expansion", async () => {
    const sections = [{
      index: 0,
      heading: "Plan",
      body: paragraph("Start with a clear plan."),
    }];
    const measureCanonicalVisibleWords = vi
      .fn()
      .mockReturnValueOnce(2200);
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({
        body: paragraph(
          "Add one useful example that helps the reader apply the plan in a real business situation.",
        ),
      }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    const result = await expandToMinimum(
      { chatWithRetry, research: [], measureCanonicalVisibleWords },
      sections,
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      2100,
      2125,
      300,
      1,
    );

    expect(measureCanonicalVisibleWords).toHaveBeenCalledTimes(1);
    expect(result.finalWordCount).toBe(2200);
    expect(result.expansionResults[0].accepted).toBe(true);
  });

  it("rejects an AI expansion that invents a link", async () => {
    const sections = [{
      index: 0,
      heading: "Plan",
      body: paragraph("Start with a clear plan."),
    }];
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({
        body: paragraph(
          'Read <a href="https://invented.example">this invented source</a> before acting.',
        ),
      }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    const result = await expandToMinimum(
      { chatWithRetry, research: [] },
      sections,
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      100,
      200,
      300,
      1,
    );

    expect(result.sections[0].body).toBe(sections[0].body);
    expect(result.expansionResults[0]).toMatchObject({
      accepted: false,
      reason: "expansion-introduced-link-or-cta",
    });
  });

  it("rejects a partially parseable expansion containing an unsupported WordPress block", async () => {
    const sections = [{ index: 0, heading: "Plan", body: paragraph("Start with a clear plan.") }];
    const unsupported = `${paragraph("Keep this supported paragraph.")}\n\n` +
      '<!-- wp:image --><figure><img src="https://example.com/a.jpg"></figure><!-- /wp:image -->';
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ body: unsupported }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));
    const result = await expandToMinimum(
      { chatWithRetry, research: [] },
      sections,
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      100,
      200,
      300,
      1,
    );
    expect(result.sections[0].body).toBe(sections[0].body);
    expect(result.expansionResults[0]).toMatchObject({
      accepted: false,
      reason: "unsupported-editorial-block:image",
    });
  });

  it("rejects an expansion containing an explicit H2 instead of silently stripping it", async () => {
    const sections = [{ index: 0, heading: "Plan", body: paragraph("Start with a clear plan.") }];
    const candidate = '<!-- wp:heading {"level":2} --><h2>Model Override</h2><!-- /wp:heading -->\n\n'
      + paragraph("Keep this additional paragraph.");
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ body: candidate }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    const result = await expandToMinimum(
      { chatWithRetry, research: [] },
      sections,
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      100,
      200,
      300,
      1,
    );

    expect(result.sections[0].body).toBe(sections[0].body);
    expect(result.expansionResults[0]).toMatchObject({
      accepted: false,
      reason: "fragment-introduced-h2",
    });
  });

  it("rejects malformed quotation prose at the expansion producer boundary", async () => {
    const sections = [{ index: 0, heading: "Plan", body: paragraph("Start with a clear plan.") }];
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ body: paragraph('Add an unfinished "example to the section.') }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));
    const result = await expandToMinimum(
      { chatWithRetry, research: [] },
      sections,
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      100,
      200,
      300,
      1,
    );
    expect(result.sections[0].body).toBe(sections[0].body);
    expect(result.expansionResults[0].reason).toContain("malformed-editorial-fragment");
  });

  it("keeps the exact original section when an AI trim returns malformed prose", async () => {
    const originalBody = paragraph(
      "This complete section contains enough useful planning detail to require a shorter candidate for the test.",
    );
    const sections = [{ index: 0, heading: "Plan", body: originalBody }];
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ body: paragraph('Short unfinished "trim.') }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));
    const result = await trimToMaximum(
      { chatWithRetry, research: [] },
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      500,
      100,
      1,
    );
    expect(result.sections[0].body).toBe(originalBody);
  });

  it("keeps the exact original section when an AI trim returns an explicit H2", async () => {
    const originalBody = paragraph(
      "This complete section contains enough useful planning detail to require a shorter candidate for the test.",
    );
    const sections = [{ index: 0, heading: "Plan", body: originalBody }];
    const candidate = '<!-- wp:heading {"level":2} --><h2>Model Override</h2><!-- /wp:heading -->\n\n'
      + paragraph("Shorter content.");
    const chatWithRetry = vi.fn(async () => ({
      content: JSON.stringify({ body: candidate }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test",
      attemptsUsed: 0,
    }));

    const result = await trimToMaximum(
      { chatWithRetry, research: [] },
      sections,
      paragraph("Introduction."),
      paragraph("Conclusion."),
      500,
      100,
      1,
    );

    expect(result.sections[0].body).toBe(originalBody);
  });
});
