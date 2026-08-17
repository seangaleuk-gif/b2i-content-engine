import { describe, expect, it } from "vitest";
import { removeUnsupportedSentences, scanFactualRisks, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";

const KP = "hong kong marketing trends 2026";
const RESEARCH = [
  { title: "Marketing Report", snippet: "Small creators offer strong engagement for local brands.", url: "https://example.com/report" },
];

function claim(text: string): ScannedClaim {
  return {
    text,
    htmlPosition: 0,
    category: "platform_metric",
    supported: false,
    sectionIndex: 0,
  };
}

const FOLLOWING = "Small creators still offer strong value for local brands.";
const SUPPORTED = "Brands should compare actual engagement instead of raw follower counts.";

describe("factual removal keeps WordPress structure balanced", () => {
  it("removes an unsupported numeric claim inside a paragraph without corrupting wp:paragraph boundaries", () => {
    const html = `<!-- wp:paragraph --><p>Creators with over 100,000 followers tend to charge more. ${SUPPORTED}</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("100,000 followers")]);
    expect(out.sentencesRemoved).toBe(1);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
    expect(out.html).toContain(SUPPORTED);
    expect(out.html).not.toContain("100,000");
  });

  it("removes an unsupported comparative claim safely", () => {
    const html = `<!-- wp:paragraph --><p>Brands that work with them sometimes see far more value than expected. ${SUPPORTED}</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("far more value")]);
    expect(out.sentencesRemoved).toBe(1);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
    expect(out.html).not.toContain("far more value");
  });

  it("two removals from the same section remain structurally valid", () => {
    const html = `<!-- wp:paragraph --><p>Creators with over 100,000 followers tend to charge more.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Brands that work with them sometimes see far more value than expected. ${SUPPORTED}</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("100,000 followers"), claim("far more value")]);
    expect(out.sentencesRemoved).toBe(2);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
  });

  it("removing a complete sentence leaves no stray closing WordPress comment", () => {
    const html = `<!-- wp:paragraph --><p>Creators with over 100,000 followers tend to charge more. ${SUPPORTED}. ${FOLLOWING}</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("100,000 followers")]);
    expect(out.sentencesRemoved).toBe(1);
    const openers = (out.html.match(/<!--\s*wp:paragraph\s*-->/gi) ?? []).length;
    const closers = (out.html.match(/<!--\s*\/wp:paragraph\s*-->/gi) ?? []).length;
    expect(openers).toBe(closers);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
  });

  it("removing a claimed list item preserves valid list markup", () => {
    const html = `<!-- wp:list --><ul>\n  <li>Creators with over 100,000 followers tend to charge more.</li>\n  <li>${SUPPORTED}</li>\n</ul><!-- /wp:list -->`;
    const out = removeUnsupportedSentences(html, [claim("100,000 followers")]);
    expect(out.sentencesRemoved).toBe(1);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
    expect(out.html).not.toContain("100,000");
    expect(out.html).toContain(SUPPORTED);
  });

  it("supported neighbouring prose survives unchanged", () => {
    const html = `<!-- wp:paragraph --><p>Creators with over 100,000 followers tend to charge more.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>${SUPPORTED}</p><!-- /wp:paragraph -->`;
    const out = removeUnsupportedSentences(html, [claim("100,000 followers")]);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
    expect(out.html).toContain(SUPPORTED);
    expect(out.html).not.toContain("100,000");
  });

  it("the factual scanner still rejects/removes the unsupported claims", () => {
    const html = `<!-- wp:paragraph --><p>Creators with over 100,000 followers tend to charge more. Brands that work with them sometimes see far more value than expected. ${SUPPORTED}</p><!-- /wp:paragraph -->`;
    const before = scanFactualRisks(html, KP, RESEARCH).claims.filter((c) => !c.supported);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const unsupportedTexts = before.map((c) => c.text);
    expect(unsupportedTexts.some((t) => t.includes("100,000"))).toBe(true);
    expect(unsupportedTexts.some((t) => t.toLowerCase().includes("far more value"))).toBe(true);
    const out = removeUnsupportedSentences(html, before);
    expect(validateWordpressBlockPairs(out.html).valid).toBe(true);
    const after = scanFactualRisks(out.html, KP, RESEARCH).claims.filter((c) => !c.supported);
    expect(after.some((c) => c.text.includes("100,000"))).toBe(false);
    expect(out.html).toContain(SUPPORTED);
  });

  it("an already-invalid component fails closed with a precise diagnostic", () => {
    // An orphan "<!-- /wp:paragraph -->" with no opener must be rejected by the
    // structural guard rather than silently mutating malformed HTML.
    const invalid = `<!-- wp:paragraph --><p>Creators with over 100,000 followers tend to charge more.</p><!-- /wp:paragraph -->\n\n<!-- /wp:paragraph -->`;
    expect(validateWordpressBlockPairs(invalid).valid).toBe(false);
    let err: Error | null = null;
    try {
      removeUnsupportedSentences(invalid, [claim("100,000 followers")]);
    } catch (error) {
      err = error as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain("invalid WordPress structure");
  });
});
