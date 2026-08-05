import { describe, it, expect } from "vitest";
import {
  CANTONESE_STYLE_EXAMPLES,
  CANTONESE_STYLE_PRINCIPLES,
  CANTONESE_EXAMPLE_CATEGORIES,
  CANTONESE_CATEGORY_LABELS,
  CANTONESE_STYLE_EXAMPLES_VERSION,
  buildCantoneseStyleExamplePrompt,
} from "./translation-style-examples";
import { buildShadowEditorialSystemPrompt } from "./document-context-translation-shadow-prompt";

describe("Cantonese style-example module (versioned, categorical, editorial guidance)", () => {
  it("is versioned and contains 10–15 approved examples", () => {
    expect(CANTONESE_STYLE_EXAMPLES_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}\.v\d+$/);
    expect(CANTONESE_STYLE_EXAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(CANTONESE_STYLE_EXAMPLES.length).toBeLessThanOrEqual(15);
  });

  it("covers every general mistake category", () => {
    expect(CANTONESE_EXAMPLE_CATEGORIES.length).toBeGreaterThanOrEqual(7);
    const covered = new Set(CANTONESE_STYLE_EXAMPLES.map((e) => e.category));
    for (const category of CANTONESE_EXAMPLE_CATEGORIES) expect(covered.has(category)).toBe(true);
    // Each example is uniquely sourced.
    expect(new Set(CANTONESE_STYLE_EXAMPLES.map((e) => e.english)).size).toBe(CANTONESE_STYLE_EXAMPLES.length);
  });

  it("teaches agency and creator terminology consistently", () => {
    const agency = CANTONESE_STYLE_EXAMPLES.find((e) => e.english === "an influencer-marketing agency");
    expect(agency?.chinese).toBe("一間創作者市場推廣公司");
    const micro = CANTONESE_STYLE_EXAMPLES.find((e) => e.english === "work with micro-creators");
    expect(micro?.chinese).toBe("同微型創作者合作");
  });

  it("teaches categories, not exact article sentences", () => {
    const prompt = buildCantoneseStyleExamplePrompt();
    for (const category of CANTONESE_EXAMPLE_CATEGORIES) {
      expect(prompt).toContain(CANTONESE_CATEGORY_LABELS[category]);
    }
    expect(prompt).toContain("English idioms");
    expect(prompt).toContain("one-size-fits-all");
    // Example translations are natural Cantonese, not English.
    expect(prompt).not.toContain("(creator marketing matters)");
  });

  it("is included in the editorial system prompt and covers 'that is why' alternatives", () => {
    const prompt = buildCantoneseStyleExamplePrompt();
    expect(prompt).toContain("STYLE EXAMPLES");
    expect(prompt).toContain("正因為咁");
    const sys = buildShadowEditorialSystemPrompt();
    expect(sys).toContain("STYLE EXAMPLES");
    expect(sys).toContain("一間創作者市場推廣公司");
    const thatIsWhy = CANTONESE_STYLE_PRINCIPLES.find((p) => p.english === "that is why");
    expect(thatIsWhy).toBeDefined();
    expect(thatIsWhy!.guidance).toContain("所以就係點解");
  });
});
