import { describe, expect, it } from "vitest";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import { repairMetaDescription, splitLongParagraphs } from "@/lib/services/text-utils";

const CTA = '<!-- wp:html --><div class="cta"><p class="outer">before <p>inner</p> after</p><a href="https://app.b2ihub.com/signup">Go</a></div><!-- /wp:html -->';
const SWITCHER = '<!-- wp:html --><div class="b2i-language-switcher"><a href="/blog/example-zh">中文</a></div><!-- /wp:html -->';

describe("splitLongParagraphs structural safety", () => {
  it("isolates protected wp:html ranges before any transformation and preserves exact bytes", () => {
    const paragraph = "<!-- wp:paragraph --><p>One useful sentence. A second sentence follows. The third is clear. A fourth needs a new block.</p><!-- /wp:paragraph -->";
    const html = `${SWITCHER}\n${paragraph}\n${CTA}`;
    const result = splitLongParagraphs(html, 3);
    expect(result.splitCount).toBe(1);
    expect(result.html).toContain(SWITCHER);
    expect(result.html).toContain(CTA);
    expect(result.html.slice(result.html.indexOf(SWITCHER), result.html.indexOf(SWITCHER) + SWITCHER.length)).toBe(SWITCHER);
    expect(result.html.slice(result.html.indexOf(CTA), result.html.indexOf(CTA) + CTA.length)).toBe(CTA);
    expect(validateWordpressBlockPairs(result.html)).toEqual({ valid: true, issues: [] });
  });

  it("preserves multiple adjacent protected blocks byte-for-byte", () => {
    const paragraph = "<!-- wp:paragraph --><p>First sentence. Second sentence. Third sentence. Fourth sentence.</p><!-- /wp:paragraph -->";
    const adjacentProtected = `${SWITCHER}\n${CTA}`;
    const html = `${adjacentProtected}\n${paragraph}`;
    const result = splitLongParagraphs(html, 3);
    expect(result.splitCount).toBe(1);
    expect(result.html.startsWith(adjacentProtected)).toBe(true);
    expect(result.html.slice(0, adjacentProtected.length)).toBe(adjacentProtected);
    expect(validateWordpressBlockPairs(result.html)).toEqual({ valid: true, issues: [] });
  });

  it.each(["heading", "list", "quote", "buttons", "html"])(
    "rejects an unclosed paragraph that crosses a wp:%s boundary",
    (type) => {
      const nested = `<!-- wp:paragraph --><p>One. Two. Three. Four.<!-- wp:${type} -->inside<!-- /wp:${type} --></p><!-- /wp:paragraph -->`;
      expect(() => splitLongParagraphs(nested, 3)).toThrow(/Invalid WordPress block structure/);
    },
  );

  it("rejects incomplete protected blocks instead of silently processing them", () => {
    const html = '<!-- wp:paragraph --><p>One. Two. Three. Four.</p><!-- /wp:paragraph --><!-- wp:html --><div>broken';
    expect(() => splitLongParagraphs(html, 3)).toThrow(/Unclosed WordPress block/);
  });

  it("does not use collision-prone sentinels", () => {
    const collisionText = "\u0000WPHTML0\u0000";
    const html = `<!-- wp:paragraph --><p>One sentence ${collisionText}. Second sentence. Third sentence. Fourth sentence.</p><!-- /wp:paragraph -->${CTA}`;
    const result = splitLongParagraphs(html, 3);
    expect(result.html).toContain(collisionText);
    expect((result.html.match(/class="cta"/g) ?? []).length).toBe(1);
    expect(result.html).toContain(CTA);
  });

  it("declines a split when an inline link spans the required sentence boundary", () => {
    const html = '<!-- wp:paragraph --><p><a href="/blog/example">First linked sentence. Second linked sentence. Third linked sentence. Fourth linked sentence.</a> Fifth sentence.</p><!-- /wp:paragraph -->';
    const result = splitLongParagraphs(html, 3);
    expect(result).toEqual({ html, splitCount: 0 });
  });

  it("does not duplicate paragraph identities when an ID attribute is present", () => {
    const html = '<!-- wp:paragraph --><p ID="stable-paragraph">First sentence. Second sentence. Third sentence. Fourth sentence.</p><!-- /wp:paragraph -->';
    expect(splitLongParagraphs(html, 3)).toEqual({ html, splitCount: 0 });
  });

  it("splits at safe boundaries while preserving balanced inline markup and hrefs", () => {
    const html = '<!-- wp:paragraph --><p class="lead">First sentence. <strong>Second emphasized sentence.</strong> Third sentence. <a href="/blog/example" data-label="a > b">Fourth linked sentence.</a></p><!-- /wp:paragraph -->';
    const result = splitLongParagraphs(html, 3);
    expect(result.splitCount).toBe(1);
    expect((result.html.match(/<p class="lead">/g) ?? []).length).toBe(2);
    expect((result.html.match(/href="\/blog\/example"/g) ?? []).length).toBe(1);
    expect((result.html.match(/<strong>/g) ?? []).length).toBe(1);
    expect((result.html.match(/<\/strong>/g) ?? []).length).toBe(1);
    expect(validateWordpressBlockPairs(result.html).valid).toBe(true);
  });

  it("is idempotent after the first safe split", () => {
    const html = '<!-- wp:paragraph --><p>First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.</p><!-- /wp:paragraph -->';
    const first = splitLongParagraphs(html, 3);
    const second = splitLongParagraphs(first.html, 3);

    expect(first.splitCount).toBe(1);
    expect(second).toEqual({ html: first.html, splitCount: 0 });
    expect(validateWordpressBlockPairs(second.html).valid).toBe(true);
  });

  it.each([
    ['"First quoted sentence. Second quoted sentence. Third quoted sentence. Fourth quoted sentence." A final sentence follows.'],
    ['“First quoted sentence. Second quoted sentence. Third quoted sentence. Fourth quoted sentence.” A final sentence follows.'],
  ])("never splits a paired multi-sentence quotation across paragraph blocks", (text) => {
    const html = `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
    const result = splitLongParagraphs(html, 3);
    const paragraphTexts = [...result.html.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((match) => match[1]);

    expect(paragraphTexts.length).toBeGreaterThan(0);
    expect(paragraphTexts.every((paragraph) => analyzeQuotationIntegrity(paragraph).balanced)).toBe(true);
    expect(paragraphTexts.join(" ").replace(/\s+/g, " ")).toBe(text);
    expect(validateWordpressBlockPairs(result.html).valid).toBe(true);
  });

  it("preserves an unmatched source paragraph byte-for-byte for the repair owner", () => {
    const html = '<!-- wp:paragraph --><p>He said "First sentence. Second sentence. Third sentence. Fourth sentence.</p><!-- /wp:paragraph -->';
    expect(splitLongParagraphs(html, 3)).toEqual({ html, splitCount: 0 });
  });

  it("rejects nested paragraphs and malformed inline HTML", () => {
    const nested = '<!-- wp:paragraph --><p>Outer <p>inner</p></p><!-- /wp:paragraph -->';
    const malformedLink = '<!-- wp:paragraph --><p>One. <a href="/x">Two. Three. Four.</p><!-- /wp:paragraph -->';
    expect(() => splitLongParagraphs(nested, 3)).toThrow(/block-level <p>/);
    expect(() => splitLongParagraphs(malformedLink, 3)).toThrow(/unclosed inline HTML tag <a>/);
  });
});

describe("metadata truncation safety", () => {
  it("never cuts a paired quotation in half", () => {
    const meta = 'A practical guide explains "a deliberately long quoted recommendation that must remain a complete semantic unit" before adding several useful details for Hong Kong business teams and their publishing workflow.';
    const repaired = repairMetaDescription(meta, 80, 150);

    expect(analyzeQuotationIntegrity(repaired).balanced).toBe(true);
    expect(repaired.length === meta.length || repaired.length <= 150).toBe(true);
  });
});
