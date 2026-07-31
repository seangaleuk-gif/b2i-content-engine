import { describe, expect, it } from "vitest";
import {
  buildEvidenceLedger,
  removeUnsupportedSentences,
  repairOrphanedTransitions,
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

  it("does not generalize a survey result from respondents to all Hong Kong users", () => {
    const research = [{
      title: "Hong Kong Threads usage survey",
      snippet: "Our survey found that 97.9% of respondents have used the platform.",
      url: "https://example.com/survey",
    }];
    const result = scanFactualRisks(
      articleWith("Based on Hong Kong user behaviour, 97.9% have tried the platform."),
      "threads marketing hong kong",
      research,
    );
    const claim = result.claims.find((item) => item.text.includes("97.9%"));
    expect(claim?.supported).toBe(false);
    expect(claim?.supportReason).toContain("survey respondents");
  });

  it("accepts the same survey statistic when the sample qualifier is preserved", () => {
    const research = [{
      title: "Hong Kong Threads usage survey",
      snippet: "Our survey found that 97.9% of respondents have used the platform.",
      url: "https://example.com/survey",
    }];
    const result = scanFactualRisks(
      articleWith("A Hong Kong survey found that 97.9% of respondents had used Threads."),
      "threads marketing hong kong",
      research,
    );
    const claim = result.claims.find((item) => item.text.includes("97.9%"));
    expect(claim?.supported).toBe(true);
    expect(claim?.evidenceId).toBe("SOURCE-1-CLAIM-1");
    expect(claim?.evidenceUrl).toBe("https://example.com/survey");
  });

  it("does not change preference for personal accounts into following no brands", () => {
    const result = scanFactualRisks(
      articleWith("68.4% of Hong Kong Threads users don't follow any brand accounts."),
      "threads marketing hong kong",
      [{
        title: "Hong Kong audience preferences",
        snippet: "68.4% would rather follow personal accounts than brand accounts.",
        url: "https://example.com/preferences",
      }],
    );
    const claim = result.claims.find((item) => item.text.includes("68.4%"));
    expect(claim?.supported).toBe(false);
    expect(claim?.supportReason).toContain("brand-follow-none");
  });

  it("does not treat advertising reach as monthly active users", () => {
    const result = scanFactualRisks(
      articleWith("Threads has 1.55 million monthly active users in Hong Kong."),
      "threads marketing hong kong",
      [{
        title: "Digital 2026 Hong Kong",
        snippet: "Threads advertising reach in Hong Kong was 1.55 million people in late 2025.",
        url: "https://example.com/ad-reach",
      }],
    );
    const claim = result.claims.find((item) => item.text.includes("1.55 million"));
    expect(claim?.supported).toBe(false);
    expect(claim?.supportReason).toContain("monthly-active-users");
  });

  it("flags unsupported algorithm and comparative-performance claims without numbers", () => {
    const result = scanFactualRisks(
      articleWith(
        "The algorithm pushes content that gets replies. This approach builds trust faster than any ad.",
      ),
      "threads marketing hong kong",
      [],
    );
    expect(result.claims.some((item) => item.category === "platform_behavior")).toBe(true);
    expect(result.claims.some((item) => item.category === "comparative_performance")).toBe(true);
    expect(result.hasHighRisk).toBe(true);
  });

  it("builds stable approved evidence claims from research sentences", () => {
    const ledger = buildEvidenceLedger([{
      title: "Usage survey",
      snippet: "97.9% of respondents used Threads. Usage remained steady for many participants.",
      url: "https://example.com/source",
    }]);
    expect(ledger.map((entry) => entry.evidenceId)).toEqual([
      "SOURCE-1-CLAIM-1",
      "SOURCE-1-CLAIM-2",
    ]);
    expect(ledger[0].approvedText).toBe("97.9% of respondents used Threads.");
  });

  it("does not scan a deterministic Source citation as editorial prose", () => {
    const html = `${articleWith("Use the research to understand the audience.")}
<!-- wp:paragraph --><p>Source: <a href="https://example.com/source">Digital 2026: Hong Kong</a>.</p><!-- /wp:paragraph -->`;
    const result = scanFactualRisks(html, "threads marketing hong kong", []);
    expect(result.claims.some((item) => item.text === "2026")).toBe(false);
  });

  it("requires a named research URL beside a supported quotation", () => {
    const research = [{
      title: "Local SME interview",
      snippet: 'The owner said, "Customer questions helped us plan clearer content."',
      url: "https://example.com/interview",
    }];
    const quote = articleWith(
      'The owner said, "Customer questions helped us plan clearer content."',
    );
    const withoutCitation = scanFactualRisks(
      quote,
      "threads marketing hong kong",
      research,
    );
    expect(withoutCitation.claims.some(
      (item) => item.category === "testimonial_quote" && !item.supported,
    )).toBe(true);

    const withCitation = scanFactualRisks(
      `${quote}
<!-- wp:paragraph --><p>Source: <a href="https://example.com/interview">Local SME interview</a>.</p><!-- /wp:paragraph -->`,
      "threads marketing hong kong",
      research,
    );
    expect(withCitation.claims.some(
      (item) => item.category === "testimonial_quote" && item.supported,
    )).toBe(true);
  });

  it.each([
    'Try asking, “Do you agree?”',
    'Use a prompt such as “What’s your biggest frustration with [topic] right now?”',
    'A useful conversation starter is "What is a challenge you are tackling at work today?"',
    'Invite readers to respond with “Agree or disagree?”',
  ])("does not treat illustrative quoted prompts as testimonials: %s", (sentence) => {
    const result = scanFactualRisks(
      articleWith(sentence),
      "threads marketing hong kong",
      [],
    );
    expect(result.claims.some((item) => item.category === "testimonial_quote")).toBe(false);
  });

  it("still scans an explicitly attributed quotation", () => {
    const result = scanFactualRisks(
      articleWith('A customer said, “The replies helped us understand what people needed.”'),
      "threads marketing hong kong",
      [],
    );
    expect(result.claims.some(
      (item) => item.category === "testimonial_quote" && !item.supported,
    )).toBe(true);
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

  it("removes an orphaned evidence transition left by factual cleanup", () => {
    const html = `${articleWith("The numbers speak for themselves.")}
<!-- wp:paragraph --><p>Use a conversational tone and answer useful questions.</p><!-- /wp:paragraph -->`;
    const repaired = repairOrphanedTransitions(html);
    expect(repaired.removed).toBe(1);
    expect(repaired.html).not.toContain("numbers speak");
    expect(repaired.html).toContain("Use a conversational tone");
  });

  it("removes a complete unsupported list item without corrupting the list", () => {
    const html = `${articleWith("Start with a practical plan.")}
<!-- wp:list {"ordered":false} --><ul>
  <li>Reply within the first hour of a trending post.</li>
  <li>Ask a useful question.</li>
</ul><!-- /wp:list -->`;
    const scan = scanFactualRisks(html, "threads marketing hong kong", []);
    const result = removeUnsupportedSentences(
      html,
      scan.claims.filter((item) => !item.supported),
    );
    expect(result.html).not.toContain("first hour");
    expect(result.html).toContain("Ask a useful question.");
    expect(result.html).toContain("<!-- /wp:list -->");
  });
});
