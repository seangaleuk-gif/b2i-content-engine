import { describe, it, expect } from "vitest";
import {
  parseWordpressBlockStructure,
  tokenizeWordpressBlockComments,
  validateWordpressBlockPairs,
} from "@/lib/blog/article-integrity";
import {
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  renderFaqSchema,
  type ArticleDocument,
} from "@/lib/blog/article-document";
import {
  CANONICAL_ENGLISH_CTA_FINGERPRINT,
  CANONICAL_ENGLISH_CTA_HTML,
} from "@/lib/blog/canonical-cta";

describe("wordpress block pair validation", () => {
  it("1. detects the exact malformed sequence: wp:html opener, incorrect wp:heading closer, later wp:html closer", () => {
    // Opener wp:html, then a wp:heading that is closed after the wp:html is closed
    // (crossed), plus an extra wp:html closer => imbalance + crossing.
    const html =
      "<!-- wp:html --><div class=\"cta\">" +
      "<!-- wp:heading {\"level\":2} --><h2>Heading</h2>" +
      "</div><!-- /wp:html -->" +
      "<!-- /wp:heading -->" +
      "<!-- /wp:html -->";
    const result = validateWordpressBlockPairs(html);
    expect(result.valid).toBe(false);
    // Diagnostic names must be wp:html / wp:heading, never wp:wp:html.
    for (const issue of result.issues) {
      expect(issue).not.toContain("wp:wp:");
    }
    // Crossed types: opened wp:html closed by wp:heading (or the reverse).
    expect(result.issues.some((i) => i.includes("type mismatch"))).toBe(true);
  });

  it("2. reports one extra closing heading marker", () => {
    const html =
      "<!-- wp:heading {\"level\":2} --><h2>A</h2><!-- /wp:heading -->" +
      "<!-- /wp:heading -->";
    const result = validateWordpressBlockPairs(html);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Unexpected closing block wp:heading"))).toBe(true);
  });

  it("3. detects crossed WordPress block types", () => {
    const html =
      "<!-- wp:paragraph --><p>a</p>" +
      "<!-- wp:heading {\"level\":2} --><h2>b</h2>" +
      "<!-- /wp:paragraph -->" +
      "<!-- /wp:heading -->";
    const result = validateWordpressBlockPairs(html);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("type mismatch"))).toBe(true);
  });

  it("4. accepts valid whitespace variations in WordPress comments", () => {
    const html =
      "<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph -->" +
      "<!--  wp:heading {\"level\":2}  --><h2>b</h2><!--  /wp:heading  -->" +
      "<!--\nwp:paragraph\n--><p>c</p><!--\n/wp:paragraph\n-->";
    expect(validateWordpressBlockPairs(html).valid).toBe(true);
  });

  it("5. diagnostic names show wp:html, never wp:wp:html", () => {
    const html = "<!-- wp:html --><div>a</div><!-- /wp:html --><!-- /wp:html -->";
    const result = validateWordpressBlockPairs(html);
    for (const issue of result.issues) {
      expect(issue).not.toContain("wp:wp:");
      expect(issue).toMatch(/wp:html/);
    }
  });

  it("8. render → parse → render preserves balanced WordPress structure", () => {
    const faqs = [{ question: "What is the first step?", answerHtml: "", answerText: "Start with a clear plan." }];
    const doc: ArticleDocument = {
      metadata: { title: "Title", slug: "round-trip", metaDescription: "Meta", excerpt: "", targetWordCount: 500, focusKeyphrase: "plan" },
      languageSwitcher: { id: "switcher", type: "language-switcher", html: '<!-- wp:html --><div class="b2i-language-switcher"><a href="/blog/round-trip-zh">中文</a></div><!-- /wp:html -->', fingerprint: "switcher" },
      introduction: { id: "intro", blocks: [{ id: "intro-p", type: "paragraph", content: [{ type: "text", text: "Opening text." }] }], status: "generated" },
      sections: [
        { id: "section", heading: "A useful plan", headingLevel: 2, sectionType: "main", blocks: [{ id: "section-p", type: "paragraph", content: [{ type: "text", text: "Body text." }] }], status: "generated" },
        { id: "faq", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", blocks: [], status: "generated" },
      ],
      conclusion: { id: "conclusion", blocks: [{ id: "conclusion-p", type: "paragraph", content: [{ type: "text", text: "Closing text." }] }], status: "generated" },
      visibleFaq: faqs,
      cta: { id: "cta", type: "cta", html: CANONICAL_ENGLISH_CTA_HTML, fingerprint: CANONICAL_ENGLISH_CTA_FINGERPRINT },
      faqSchema: { id: "faq-schema", type: "faq-schema", html: renderFaqSchema(faqs), fingerprint: "schema" },
      insertedLinks: [],
    };
    const first = renderArticleDocument(doc);
    const parsed = parseArticleDocumentFromHtml(first, doc);
    expect(parsed.errors).toEqual([]);
    expect(parsed.doc).not.toBeNull();
    const second = renderArticleDocument(parsed.doc!);
    expect(validateWordpressBlockPairs(first)).toEqual({ valid: true, issues: [] });
    expect(validateWordpressBlockPairs(second)).toEqual({ valid: true, issues: [] });
    expect(second).toBe(first);
  });

  it("does not accept crossed nested block markers", () => {
    const html =
      "<!-- wp:html --><div>" +
      "<!-- wp:heading {\"level\":2} --><h2>x</h2>" +
      "<!-- /wp:html -->" +
      "<!-- /wp:heading -->";
    expect(validateWordpressBlockPairs(html).valid).toBe(false);
  });

  it("parses JSON attributes containing > without losing the opener", () => {
    const html = '<!-- wp:paragraph {"className":"value > threshold"} --><p>Text.</p><!-- /wp:paragraph -->';
    const parsed = parseWordpressBlockStructure(html);
    expect(parsed.valid).toBe(true);
    expect(parsed.openingCount).toBe(1);
    expect(parsed.closingCount).toBe(1);
  });

  it("rejects closing markers with attributes and malformed WordPress-looking comments", () => {
    expect(validateWordpressBlockPairs('<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph {"bad":true} -->').valid).toBe(false);
    expect(validateWordpressBlockPairs('<!-- wp:paragraph {"broken": -->').valid).toBe(false);
    expect(validateWordpressBlockPairs('<!-- wp:paragraph ').valid).toBe(false);
  });

  it("accepts a valid self-closing block without adding pair tokens", () => {
    const html = '<!-- wp:separator {"opacity":"css"} /-->';
    const parsed = parseWordpressBlockStructure(html);
    expect(parsed.valid).toBe(true);
    expect(parsed.selfClosingCount).toBe(1);
    expect(tokenizeWordpressBlockComments(html)).toEqual([]);
  });

  it("rejects nested WordPress blocks inside a leaf paragraph block", () => {
    const html = '<!-- wp:paragraph --><p>before<!-- wp:heading {"level":2} --><h2>x</h2><!-- /wp:heading -->after</p><!-- /wp:paragraph -->';
    const parsed = parseWordpressBlockStructure(html);
    expect(parsed.valid).toBe(false);
    expect(parsed.issues.some((issue) => issue.includes("cannot be nested inside leaf block wp:paragraph"))).toBe(true);
  });
});
