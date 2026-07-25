import { describe, it, expect } from "vitest";
import {
  normalizeFinalSeo,
  tokenizeProtectedBlocks,
  detokenizeProtectedBlocks,
  type ProtectedBlockToken,
} from "@/lib/blog/final-seo-normalizer";

function articleWithFaqAndLinks() {
  return `<!-- wp:html --><div class="b2i-language-switcher"><span>English</span></div><!-- /wp:html -->

<!-- wp:paragraph --><p>This introductory paragraph discusses hong kong digital marketing trends for 2026. The landscape continues to evolve rapidly with new platforms.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Understanding the Market</h2>
<!-- /wp:heading -->

<!-- wp:paragraph --><p>The hong kong digital marketing space is unique. <a href="https://example.com/reference">Learn more about the market</a> for additional context.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Platform Strategy</h2>
<!-- /wp:heading -->

<!-- wp:paragraph --><p>Social media platforms in Hong Kong follow distinct patterns. <a href="/blog/instagram-hk">Instagram marketing</a> remains dominant while <a href="/blog/wechat-hk">WeChat</a> serves different needs.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Frequently Asked Questions</h2>
<!-- /wp:heading -->

<!-- wp:paragraph --><p><strong>What is hong kong digital marketing?</strong><br>It is the practice of promoting brands through digital channels in the Hong Kong market.</p><!-- /wp:paragraph -->

<!-- wp:html --><div class="cta-block"><h2>Ready to Grow?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->

<!-- wp:html --><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is hong kong digital marketing?","acceptedAnswer":{"@type":"Answer","text":"It is the practice of promoting brands through digital channels."}}]}</script><!-- /wp:html -->

<!-- wp:paragraph --><p>In conclusion, hong kong digital marketing requires a sophisticated understanding of local consumer behavior.</p><!-- /wp:paragraph -->`;
}

describe("SEO normalizer: tokenization round-trip", () => {
  it("tokenize → detokenize produces byte-identical output", () => {
    const html = articleWithFaqAndLinks();
    const { content, tokens } = tokenizeProtectedBlocks(html);
    const restored = detokenizeProtectedBlocks(content, tokens);
    expect(restored).toBe(html);
    expect(restored.length).toBe(html.length);
  });

  it("FAQ JSON-LD is tokenized as a script block", () => {
    const html = articleWithFaqAndLinks();
    const { tokens } = tokenizeProtectedBlocks(html);
    const faqToken = tokens.find((t) => t.type === "script");
    expect(faqToken).toBeDefined();
    expect(faqToken!.original).toContain("FAQPage");
  });

  it("CTA block is tokenized as wp-html", () => {
    const html = articleWithFaqAndLinks();
    const { tokens } = tokenizeProtectedBlocks(html);
    const ctaToken = tokens.find(
      (t) => t.type === "wp-html" && t.original.includes("signup"),
    );
    expect(ctaToken).toBeDefined();
  });

  it("language switcher is tokenized as wp-html", () => {
    const html = articleWithFaqAndLinks();
    const { tokens } = tokenizeProtectedBlocks(html);
    const lsToken = tokens.find(
      (t) => t.type === "wp-html" && t.original.includes("b2i-language-switcher"),
    );
    expect(lsToken).toBeDefined();
  });

  it("links in paragraph text are tokenized", () => {
    const html = articleWithFaqAndLinks();
    const { tokens } = tokenizeProtectedBlocks(html);
    const linkTokens = tokens.filter((t) => t.type === "link");
    // 3 links: reference link + Instagram + WeChat
    expect(linkTokens.length).toBe(3);
  });

  it("paragraph blocks outside protected blocks survive tokenization", () => {
    const html = articleWithFaqAndLinks();
    const { content } = tokenizeProtectedBlocks(html);
    const paraCount = (content.match(/<!--\s*wp:paragraph\s*-->/gi) ?? []).length;
    // After tokenization, wp:paragraph markers for non-protected paragraphs remain
    expect(paraCount).toBeGreaterThanOrEqual(4);
  });

  it("no link placeholders appear inside other protected tokens", () => {
    const html = articleWithFaqAndLinks();
    const { content } = tokenizeProtectedBlocks(html);
    // All %%PROTECTED_ placeholders should be independent (not nested)
    const placeholders = content.match(/%%PROTECTED_\d+_\S+_BLOCK%%/g) ?? [];
    for (const ph of placeholders) {
      // Each placeholder should appear exactly once (not nested inside another)
      const count = content.split(ph).length - 1;
      expect(count).toBe(1);
    }
  });
});

describe("SEO normalizer: link preservation through normalization", () => {
  it("link hrefs survive full normalization unchanged", async () => {
    const html = articleWithFaqAndLinks();
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: "hong kong digital marketing",
      targetWordCount: 200,
      targetKeyphraseCount: 3,
      minReadingEase: 50,
      maxReadingEase: 80,
    });

    expect(result.html).toContain('href="/blog/instagram-hk"');
    expect(result.html).toContain('href="/blog/wechat-hk"');
    expect(result.html).toContain('href="https://example.com/reference"');
    expect(result.safety.linkDestinationsUnchanged).toBe(true);
  });
});

describe("SEO normalizer: FAQ and CTA preservation through normalization", () => {
  it("FAQ schema JSON-LD survives normalization byte-for-byte", async () => {
    const html = articleWithFaqAndLinks();
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: "hong kong digital marketing",
      targetWordCount: 200,
      targetKeyphraseCount: 3,
      minReadingEase: 50,
      maxReadingEase: 80,
    });

    expect(result.html).toContain("FAQPage");
    expect(result.html).toContain("application/ld+json");
    expect(result.safety.faqSchemaPreserved).toBe(true);
  });

  it("CTA signup block survives normalization unchanged", async () => {
    const html = articleWithFaqAndLinks();
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: "hong kong digital marketing",
      targetWordCount: 200,
      targetKeyphraseCount: 3,
      minReadingEase: 50,
      maxReadingEase: 80,
    });

    expect(result.html).toContain("app.b2ihub.com/signup");
    expect(result.html).toContain("Create Free Account");
    expect(result.safety.ctaPreserved).toBe(true);
  });

  it("language switcher survives normalization unchanged", async () => {
    const html = articleWithFaqAndLinks();
    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: "hong kong digital marketing",
      targetWordCount: 200,
      targetKeyphraseCount: 3,
      minReadingEase: 50,
      maxReadingEase: 80,
    });

    expect(result.html).toContain("b2i-language-switcher");
    expect(result.safety.languageSwitcherPreserved).toBe(true);
  });
});

describe("SEO normalizer: intro keyphrase preservation", () => {
  it("first paragraph keyphrase survives normalization", async () => {
    const html = `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->

<!-- wp:paragraph --><p>The hong kong digital marketing industry is evolving rapidly in 2026. New platforms and strategies emerge continuously.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Market Analysis</h2>
<!-- /wp:heading -->

<!-- wp:paragraph --><p>The hong kong market presents unique opportunities for digital marketing professionals.</p><!-- /wp:paragraph -->`;

    const result = await normalizeFinalSeo({
      html,
      focusKeyphrase: "hong kong digital marketing",
      targetWordCount: 50,
      targetKeyphraseCount: 2,
      minReadingEase: 50,
      maxReadingEase: 80,
    });

    const firstPara = result.html.match(
      /<!--\s*wp:paragraph\s*-->\s*<p>([\s\S]*?)<\/p>\s*<!--\s*\/wp:paragraph\s*-->/i,
    );
    expect(firstPara).toBeDefined();
    if (firstPara) {
      expect(firstPara[1].toLowerCase()).toContain("hong kong digital marketing");
    }
  });
});
