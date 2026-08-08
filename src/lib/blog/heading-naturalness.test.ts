import { describe, expect, it } from "vitest";
import {
  assessHeadingTextNaturalness,
  repairHeadingNaturalness,
} from "@/lib/blog/content-relevance";

const KEYPHRASE = "hong kong marketing trends 2026";

describe("shared heading naturalness boundary", () => {
  it("repairs the exact production duplicated-topic heading before drafting", () => {
    const heading = "Hong Kong Marketing Trends 2026: What's Shaping Hong Kong Marketing";
    const result = repairHeadingNaturalness(heading, KEYPHRASE, "outline-0");

    expect(result.resolved).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.heading).toBe("Hong Kong Marketing Trends 2026");
    expect(result.initialViolations.map((issue) => issue.code)).toContain("duplicated-keyphrase-heading");
    expect(assessHeadingTextNaturalness(result.heading, KEYPHRASE)).toEqual([]);
    expect(result.heading.match(/Hong Kong/gi)).toHaveLength(1);
    expect(result.heading.match(/2026/g)).toHaveLength(1);
  });

  it("removes a duplicated trailing Hong Kong from the outline fallback form", () => {
    const result = repairHeadingNaturalness(
      "Why Hong Kong Marketing Matters in Hong Kong",
      "hong kong marketing",
    );
    expect(result).toMatchObject({
      resolved: true,
      changed: true,
      heading: "Why Hong Kong Marketing Matters",
    });
  });

  it("keeps one year when the same year appears in both colon parts", () => {
    const result = repairHeadingNaturalness(
      "Marketing Trends 2026 for 2026",
      KEYPHRASE,
    );
    expect(result.resolved).toBe(true);
    expect(result.heading).toBe("Marketing Trends 2026");
    expect(result.heading.match(/2026/g)).toHaveLength(1);
  });

  it("leaves a natural heading byte-identical", () => {
    const heading = "Privacy-First Campaign Planning for Hong Kong Brands";
    expect(repairHeadingNaturalness(heading, KEYPHRASE)).toMatchObject({
      heading,
      changed: false,
      resolved: true,
    });
  });

  it("does not reject a legitimate comparison that mentions Hong Kong twice", () => {
    const heading = "Hong Kong vs Singapore: What Hong Kong Brands Need to Know";
    expect(assessHeadingTextNaturalness(heading, KEYPHRASE)).toEqual([]);
    expect(repairHeadingNaturalness(heading, KEYPHRASE)).toMatchObject({
      heading,
      changed: false,
      resolved: true,
    });
  });

  it("refuses to discard distinct numeric meaning to make a heading pass", () => {
    const heading = "Hong Kong 5G Marketing: Hong Kong Marketing for 10 Teams";
    const result = repairHeadingNaturalness(heading, "hong kong marketing");
    expect(result.resolved).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.heading).toBe(heading);
    expect(result.remainingViolations.map((issue) => issue.code)).toContain("duplicated-keyphrase-heading");
  });

  it("refuses to discard a distinct colon topic merely to remove a repeated location", () => {
    const heading = "Hong Kong Regulations: Hong Kong Marketing";
    const result = repairHeadingNaturalness(heading, "hong kong marketing");
    expect(result).toMatchObject({
      resolved: false,
      changed: false,
      heading,
    });
  });
});
