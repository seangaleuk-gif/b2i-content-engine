// ── Stage 3J: shared FAQ locator/parsing hardening regression suite ──
// Proves the FAQ locator is structurally anchored: arbitrary body text, URLs,
// hrefs, source labels or earlier headings containing "faq" can no longer
// spoof the rendered FAQ section, while all valid rendered forms, the legacy
// structural fallback, boundary safety, and strict faq-parity all hold.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  renderVisibleFaq,
  renderFaqSchema,
  extractVisibleFaqFromArticle,
  FAQ_HEADING_MARKER,
  CONCLUSION_START_MARKER,
  renderArticleDocument,
  type FaqEntry,
} from "@/lib/blog/article-document";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";

const LIVE_URL = "https://www.entertainingasia.com/faq/599-hong-kong-restaurant-marketing";

function entries(count: number, prefix = "Q"): FaqEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    question: `${prefix}${i + 1}?`,
    answerText: `Answer ${i + 1}`,
    answerHtml: `<p>Answer ${i + 1}</p>`,
  }));
}

function faqHtml(opts: {
  headingText?: string;
  entries: FaqEntry[];
  marker?: boolean;
  spoofBefore?: string;
  afterItems?: string;
  conclusionAfter?: boolean;
  plainH2?: boolean;
}): string {
  const marker = opts.marker === false ? "" : `${FAQ_HEADING_MARKER}\n\n`;
  const headingBlock = opts.plainH2
    ? `<h2>${opts.headingText ?? "Frequently Asked Questions"}</h2>`
    : `<!-- wp:heading {"level":2} -->\n<h2>${opts.headingText ?? "Frequently Asked Questions"}</h2>\n<!-- /wp:heading -->`;
  const heading = opts.headingText ? `${marker}${headingBlock}\n\n` : "";
  const schema = renderFaqSchema(opts.entries);
  const conclusion = opts.conclusionAfter ? `\n\n${CONCLUSION_START_MARKER}\n\n<!-- wp:paragraph --><p>Conclusion.</p><!-- /wp:paragraph -->` : "";
  return `${opts.spoofBefore ?? ""}${heading}${renderVisibleFaq(opts.entries)}\n\n${schema}${conclusion}${opts.afterItems ?? ""}`;
}

const FAQ_HEADINGS = {
  "Frequently Asked Questions": "Frequently Asked Questions About Restaurant Retention",
  FAQ: "FAQ About Hong Kong Restaurants",
  FAQs: "FAQs About Our Menu",
  chinese: "常見問題 - 香港餐廳顧客忠誠度",
};

describe("Stage 3J: valid FAQ parsing preserved", () => {
  it("canonical marker + 6 entries extracts 6", () => {
    const html = faqHtml({ headingText: FAQ_HEADINGS["Frequently Asked Questions"], entries: entries(6) });
    expect((html.match(/class="faq-item"/g) || []).length).toBe(6);
    expect(extractVisibleFaqFromArticle(html)).toHaveLength(6);
  });

  it("all supported heading labels extract correctly (English + Chinese)", () => {
    for (const headingText of Object.values(FAQ_HEADINGS)) {
      const html = faqHtml({ headingText, entries: entries(4) });
      expect(extractVisibleFaqFromArticle(html), headingText).toHaveLength(4);
    }
  });

  it("legacy structural H2 fallback (no marker) still works for English + Chinese headings", () => {
    for (const headingText of Object.values(FAQ_HEADINGS)) {
      const html = faqHtml({ headingText, marker: false, entries: entries(3) });
      expect(extractVisibleFaqFromArticle(html), headingText).toHaveLength(3);
    }
  });

  it("FAQ followed by conclusion still extracts correctly", () => {
    const html = faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(5), conclusionAfter: true });
    expect(extractVisibleFaqFromArticle(html)).toHaveLength(5);
  });

  it("FAQ followed by another valid boundary (later H2) is not over-extended", () => {
    const afterItems = "\n\n<!-- wp:heading {\"level\":2} -->\n<h2>Next Section</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Body.</p><!-- /wp:paragraph -->";
    const html = faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(4), afterItems });
    const result = extractVisibleFaqFromArticle(html);
    expect(result).toHaveLength(4);
    expect(result.some((r) => r.answerText.includes("Body"))).toBe(false);
  });
});

describe("Stage 3J: spoofing / adversarial content before FAQ", () => {
  const spoofs: Array<{ name: string; spoofBefore: string }> = [
    { name: "URL containing /faq/", spoofBefore: `<!-- wp:paragraph --><p>Source: <a href="${LIVE_URL}">HK Magazine</a></p><!-- /wp:paragraph -->` },
    { name: "URL containing faq?", spoofBefore: `<!-- wp:paragraph --><p>See <a href="https://example.com/faq?page=2">notes</a>.</p><!-- /wp:paragraph -->` },
    { name: "href attribute containing FAQ", spoofBefore: `<!-- wp:paragraph --><p><a href="https://example.com/FAQ-section">link</a></p><!-- /wp:paragraph -->` },
    { name: "paragraph text containing faq", spoofBefore: `<!-- wp:paragraph --><p>This paragraph mentions the word faq in passing.</p><!-- /wp:paragraph -->` },
    { name: "source title containing FAQ", spoofBefore: `<!-- wp:paragraph --><p>Source: FAQ About Marketing | Example Co.</p><!-- /wp:paragraph -->` },
    { name: "H3 containing FAQ", spoofBefore: `<!-- wp:heading {"level":3} -->\n<h3>FAQ details</h3>\n<!-- /wp:heading -->` },
    { name: "attribute class/id containing faq", spoofBefore: `<!-- wp:html --><div class="faq-wrapper-fragment"><p>not the FAQ</p></div><!-- /wp:html -->` },
    { name: "earlier ordinary H2 whose body contains the word FAQ", spoofBefore: `<!-- wp:heading {"level":2} -->\n<h2>How FAQ Analytics Improve Support</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Body.</p><!-- /wp:paragraph -->` },
    { name: "external Source block with the exact live URL", spoofBefore: `<!-- wp:paragraph --><p>Source: <a href="${LIVE_URL}">Entertaining Asia FAQ</a></p><!-- /wp:paragraph -->` },
  ];

  it("rendered FAQ count stays equal to canonical for every spoof", () => {
    for (const spoof of spoofs) {
      const html = faqHtml({ headingText: FAQ_HEADINGS["Frequently Asked Questions"], entries: entries(6), spoofBefore: spoof.spoofBefore });
      expect(extractVisibleFaqFromArticle(html), spoof.name).toHaveLength(6);
    }
  });

  it("spoofs do not poison the legacy fallback either", () => {
    for (const spoof of spoofs) {
      const html = faqHtml({ headingText: FAQ_HEADINGS["Frequently Asked Questions"], marker: false, entries: entries(3), spoofBefore: spoof.spoofBefore });
      expect(extractVisibleFaqFromArticle(html), spoof.name).toHaveLength(3);
    }
  });
});

describe("Stage 3J: boundary safety", () => {
  it("locator cannot span across unrelated H2s (earlier sections with FAQ word)", () => {
    const html =
      "<!-- wp:heading {\"level\":2} -->\n<h2>Why Retention Matters FAQ Overview</h2>\n<!-- /wp:heading -->\n\n"
      + "<!-- wp:paragraph --><p>Body text with faq inside it.</p><!-- /wp:paragraph -->\n\n"
      + faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(4) });
    const result = extractVisibleFaqFromArticle(html);
    expect(result).toHaveLength(4);
    expect(result.some((r) => r.answerText.includes("Body text"))).toBe(false);
  });

  it("no FAQ item after the FAQ region is accidentally included", () => {
    const afterItems = "\n\n<!-- wp:html --><div class=\"faq-item\"><h3>Imposter?</h3><p>outside region</p></div><!-- /wp:html -->";
    const html = faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(3), afterItems });
    const result = extractVisibleFaqFromArticle(html);
    expect(result).toHaveLength(3);
    expect(result.some((r) => r.question.includes("Imposter"))).toBe(false);
  });

  it("no earlier body content is included", () => {
    const html = faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(3) });
    const result = extractVisibleFaqFromArticle(html);
    expect(result.every((r) => r.answerText.startsWith("Answer"))).toBe(true);
  });
});

describe("Stage 3J: exact live /faq/ failure fixture", () => {
  const SNAPSHOT = path.resolve("debug", "pipeline-failures", "2026-08-17T13-44-08-570Z_external-links_project-22.json");

  it("the live rejected candidate now extracts 6 FAQ entries (canonical = 6, divs = 6)", () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      documents: { rejectedCandidate: Parameters<typeof renderArticleDocument>[0] };
      keyphrase: { pre: { occurrences: number } };
    };
    const doc = snapshot.documents.rejectedCandidate;
    const html = renderArticleDocument(doc);
    expect(doc.visibleFaq).toHaveLength(6);
    expect((html.match(/class="faq-item"/g) || []).length).toBe(6);
    expect(extractVisibleFaqFromArticle(html)).toHaveLength(6);
  });

  it("the live /faq/ URL no longer triggers an faq-parity rejection", () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      documents: { preStage: Parameters<typeof renderArticleDocument>[0]; rejectedCandidate: Parameters<typeof renderArticleDocument>[0] };
      wordCount: { pre: number; post: number };
    };
    const { preStage, rejectedCandidate } = snapshot.documents;
    const result = validateArticleIntegrityContract(rejectedCandidate, {
      keyphrase: "hong kong restaurant customer retention",
      wordMin: 2125,
      wordMax: 2875,
      previous: preStage,
      ownedCategories: new Set(["links", "word-count"]),
    });
    const faqParity = result.violations.filter((v) => v.category === "faq-parity");
    expect(faqParity).toEqual([]);
  });
});

describe("Stage 3J: integrity contract stays fail-closed", () => {
  const SNAPSHOT = path.resolve("debug", "pipeline-failures", "2026-08-17T13-44-08-570Z_external-links_project-22.json");

  function docFromSnapshot(): Parameters<typeof renderArticleDocument>[0] {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      documents: { preStage: Parameters<typeof renderArticleDocument>[0] };
    };
    return structuredClone(snapshot.documents.preStage);
  }

  it("a genuinely removed FAQ item still fails parity", () => {
    const doc = docFromSnapshot();
    expect(doc.visibleFaq).toHaveLength(6);
    // A producer that empties one FAQ entry's answer (rendered representation
    // loses the item) while canonical keeps 6 must fail closed.
    doc.visibleFaq[3].answerText = "";
    doc.visibleFaq[3].answerHtml = "";
    const result = validateArticleIntegrityContract(doc, {
      keyphrase: "hong kong restaurant customer retention",
    });
    expect(result.violations.some((v) => v.category === "faq-parity")).toBe(true);
  });

  it("a truly truncated rendered FAQ region is detected (fail closed)", () => {
    const html = faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(6) }).replace("</div>", "");
    expect(extractVisibleFaqFromArticle(html).length).toBeLessThan(6);
  });

  it("malformed FAQ structure still fails parity", () => {
    const html = faqHtml({ headingText: FAQ_HEADINGS.FAQ, entries: entries(2) }).replace("</div>", "");
    expect(extractVisibleFaqFromArticle(html).length).toBeLessThan(2);
  });
});
