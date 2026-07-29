import { describe, expect, it } from "vitest";
import {
  removeUnsupportedSentences,
  scanFactualRisks,
  type ScannedClaim,
} from "./factual-risk-scanner";

function articleWith(text: string): string {
  return `<!-- wp:heading {"level":2} --><h2>Strategy</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function claim(text: string): ScannedClaim {
  return {
    text,
    htmlPosition: 0,
    category: "platform_metric",
    supported: false,
    sectionIndex: 0,
  };
}

describe("factual risk coverage", () => {
  it.each([
    ["Teams see 2x higher reply rates.", "2x higher"],
    ["Publish 3-5 posts per day.", "3-5 posts per day"],
    ["Insights become available at 100 followers.", "100 followers"],
    ["The peak window is 8 am-10 am.", "8 am-10 am"],
    ["Aim for 5-10% engagement.", "Aim for 5-10%"],
    ["Threads now allows one link per post.", "Threads now allows one link per post"],
    ["As of 2026, Threads has launched advertising in Hong Kong.", "As of 2026, Threads has launched advertising in Hong Kong"],
  ])("flags unsupported platform guidance: %s", (sentence, fragment) => {
    const result = scanFactualRisks(articleWith(sentence), "strategy", []);
    expect(result.hasHighRisk).toBe(true);
    expect(result.claims.some((item) => item.text.toLowerCase() === fragment.toLowerCase())).toBe(
      true,
    );
  });

  it("does not treat ordinary marketing language as a platform feature claim", () => {
    const result = scanFactualRisks(
      articleWith(
        "Threads marketing Hong Kong offers a chance to join useful customer conversations without a large media budget.",
      ),
      "threads marketing hong kong",
      [],
    );
    expect(result.claims.filter((item) => item.category === "platform_feature")).toHaveLength(0);
  });

  it("does not skip a risky claim when inline markup splits its visible text", () => {
    const result = scanFactualRisks(
      articleWith(
        `Threads ads aren't fully <a href="https://example.com">rolled out</a> here yet.`,
      ),
      "threads marketing hong kong",
      [],
    );
    expect(result.hasHighRisk).toBe(true);
    expect(result.claims.some((item) => item.category === "platform_feature")).toBe(true);
  });

  it("does not crash on an invalid numeric HTML entity", () => {
    const html = articleWith("Threads ads aren&#999999999; currently unavailable.");
    expect(() => scanFactualRisks(html, "threads marketing hong kong", [])).not.toThrow();
  });

  it("does not treat 4 billion in research as support for a 4 million claim", () => {
    const result = scanFactualRisks(
      articleWith("Threads has 4 million monthly active users."),
      "threads marketing hong kong",
      [{ title: "Threads reaches 4 billion monthly active users", snippet: "" }],
    );
    const audienceClaim = result.claims.find((item) => item.category === "platform_metric");
    expect(audienceClaim?.supported).toBe(false);
  });

  it("does not present a global median as a Hong Kong average", () => {
    const result = scanFactualRisks(
      articleWith(
        "The average engagement rate on Threads in Hong Kong is 6.25%.",
      ),
      "threads marketing hong kong",
      [{
        title: "Global Threads engagement benchmark",
        snippet: "The worldwide median engagement rate is 6.25%.",
        url: "https://example.com/global-benchmark",
      }],
    );
    const engagementClaim = result.claims.find(
      (item) => item.category === "platform_metric" && item.text.includes("6.25%"),
    );
    expect(engagementClaim?.supported).toBe(false);
  });

  it("accepts a statistic only when one evidence entry matches number, scope and qualifier", () => {
    const result = scanFactualRisks(
      articleWith(
        "The average engagement rate on Threads in Hong Kong is 6.25%.",
      ),
      "threads marketing hong kong",
      [{
        title: "Hong Kong Threads benchmark",
        snippet: "The average engagement rate on Threads in Hong Kong is 6.25%.",
        url: "https://example.com/hong-kong-benchmark",
      }],
    );
    const engagementClaim = result.claims.find(
      (item) => item.category === "platform_metric" && item.text.includes("6.25%"),
    );
    expect(engagementClaim?.supported).toBe(true);
  });
});

describe("safe unsupported-sentence removal", () => {
  it("removes only the complete offending sentence and keeps both neighbours", () => {
    const html = articleWith(
      "Keep this useful sentence. Aim for 10% engagement before changing plans. Keep the final advice.",
    );
    const result = removeUnsupportedSentences(html, [claim("Aim for 10%")]);
    expect(result.sentencesRemoved).toBe(1);
    expect(result.html).toContain("Keep this useful sentence.");
    expect(result.html).toContain("Keep the final advice.");
    expect(result.html).not.toContain("10%");
    expect(result.html).toContain("<!-- wp:paragraph -->");
    expect(result.html).toContain("<!-- /wp:paragraph -->");
  });

  it("does not leave the broken fragments seen in the supplied production article", () => {
    const html = articleWith(
      'Teams see 2x higher reply rates. Instead of listing products, ask a useful question. For example, invite readers to share a familiar local habit.',
    );
    const result = removeUnsupportedSentences(html, [claim("2x higher")]);
    expect(result.html).not.toContain('." instead');
    expect(result.html).toContain("Instead of listing products");
    expect(result.html).toContain("For example, invite readers");
  });

  it("matches decoded paragraph text to an HTML-encoded claim", () => {
    const html = articleWith(
      "Threads ads aren&#39;t fully rolled out here yet, organic content is your best bet for now. Keep testing useful audience questions.",
    );
    const scan = scanFactualRisks(html, "threads marketing hong kong", []);
    expect(scan.claims.some((item) => item.category === "platform_feature")).toBe(true);
    const result = removeUnsupportedSentences(
      html,
      scan.claims.filter((item) => !item.supported),
    );
    expect(result.sentencesRemoved).toBe(1);
    expect(result.html).not.toContain("rolled out");
    expect(result.html).toContain("Keep testing useful audience questions.");
  });

  it("removes an empty paragraph as one complete WordPress block", () => {
    const html = articleWith("Aim for 10% engagement.");
    const result = removeUnsupportedSentences(html, [claim("Aim for 10%")]);
    expect(result.sentencesRemoved).toBe(1);
    expect(result.html).not.toContain("wp:paragraph");
  });

  it("never removes a sentence containing a protected inline link", () => {
    const html = articleWith(
      'The source recommends <a href="https://example.com/source">10% engagement</a> for this example.',
    );
    const result = removeUnsupportedSentences(html, [claim("10% engagement")]);
    expect(result.sentencesRemoved).toBe(0);
    expect(result.html).toContain('href="https://example.com/source"');
  });
});
