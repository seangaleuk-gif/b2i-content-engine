import { describe, it, expect } from "vitest";
import {
  type ArticleDocument,
  renderArticleDocument,
  fingerprintHtml,
  parseArticleDocumentFromHtml,
  detectNestedParagraphs,
  renderFaqSchema,
} from "@/lib/blog/article-document";
import {
  createArticleIntegrityBaseline,
  validateFinalArticleIntegrity,
  validateWordpressBlockPairs,
  type ArticleIntegrityBaseline,
} from "@/lib/blog/article-integrity";
import { normalizeParagraphs } from "@/lib/services/section-expander";
import { countReadableWords } from "@/lib/services/text-utils";
import {
  guardStageOutput,
  validatePipelineOrder,
} from "@/lib/pipeline/blog-generation-pipeline";

// ── Test helpers ──

function makeArticleDoc(overrides?: Partial<ArticleDocument>): ArticleDocument {
  const languageSwitcher = {
    id: "language-switcher",
    type: "language-switcher" as const,
    html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/test-post-zh">繁體中文</a></div><!-- /wp:html -->`,
    fingerprint: "abc",
  };

  const cta = {
    id: "cta",
    type: "cta" as const,
    html: `<!-- wp:html --><div class="cta-block"><h2>Ready to Start?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->`,
    fingerprint: "def",
  };

  const faqSchema = {
    id: "faq-schema",
    type: "faq-schema" as const,
    html: `<!-- wp:html --><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is it?","acceptedAnswer":{"@type":"Answer","text":"It works."}}]}</script><!-- /wp:html -->`,
    fingerprint: "ghi",
  };

  const intro: ArticleDocument["introduction"] = {
    id: "intro",
    html: `<!-- wp:paragraph --><p>This is the introduction paragraph that explains the topic in detail. It has multiple sentences to provide context. This is the third sentence for good measure.</p><!-- /wp:paragraph -->`,
    wordCount: 40,
    status: "generated",
  };

  const sections: ArticleDocument["sections"] = [
    {
      id: "section-0", heading: "First Main Heading", headingLevel: 2 as const, sectionType: "main" as const,
      html: `<!-- wp:paragraph --><p>First section content with several sentences. This covers the first main topic in detail. It has enough content to be useful for readers.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Additional paragraph in the first section. This provides more depth on the first topic. Readers will find this informative and well-structured.</p><!-- /wp:paragraph -->`,
      wordCount: 60, status: "generated",
    },
    {
      id: "section-1", heading: "Second Topic Explored", headingLevel: 2 as const, sectionType: "main" as const,
      html: `<!-- wp:paragraph --><p>Second section body text with quality content. This section explores a different angle of the main topic. Readers benefit from the varied perspective provided here.</p><!-- /wp:paragraph -->`,
      wordCount: 35, status: "generated",
    },
  ];

  const faqSection: ArticleSection = {
    id: "section-2", heading: "Frequently Asked Questions", headingLevel: 2 as const, sectionType: "faq-heading" as const,
    html: `<!-- wp:paragraph --><p><strong>What is the main benefit?</strong><br>It helps you save time and money. The solution is proven to work effectively in real-world scenarios.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p><strong>How do I get started?</strong><br>Simply sign up and follow the guided setup. The onboarding process takes less than five minutes to complete.</p><!-- /wp:paragraph -->`,
    wordCount: 50, status: "generated",
  };

  const conclusion: ArticleDocument["conclusion"] = {
    id: "conclusion",
    html: `<!-- wp:paragraph --><p>In conclusion, this approach provides significant value. Readers should take action on the key points discussed above. The benefits are clear and well-documented.</p><!-- /wp:paragraph -->`,
    wordCount: 30, status: "generated",
  };

  return {
    metadata: {
      title: "Test Article Title",
      slug: "test-article",
      metaDescription: "A test article for pipeline validation",
      excerpt: "Test excerpt",
      targetWordCount: 2500,
      focusKeyphrase: "test keyphrase",
    },
    languageSwitcher,
    introduction: intro,
    sections: [...sections, faqSection],
    visibleFaq: [
      { question: "What is the main benefit?", answerHtml: "", answerText: "It helps you save time and money." },
      { question: "How do I get started?", answerHtml: "", answerText: "Simply sign up and follow the setup." },
    ],
    conclusion,
    cta,
    faqSchema,
    insertedLinks: [],
    ...overrides,
  };
}

function createBaseline(doc: ArticleDocument): ArticleIntegrityBaseline {
  const html = renderArticleDocument(doc);
  return createArticleIntegrityBaseline(html);
}

// ── Tests ──

describe("pipeline: guardStageOutput", () => {
  const validDoc = makeArticleDoc();
  const validHtml = renderArticleDocument(validDoc);
  const baseline = createArticleIntegrityBaseline(validHtml);

  it("A. candidate invalid, fallback valid — returns previous HTML, accepted=false", () => {
    const badHtml = validHtml + "<!-- wp:unmatched -->";
    const result = guardStageOutput(badHtml, validHtml, baseline, "test-stage");
    expect(result.html).toBe(validHtml);
    expect(result.accepted).toBe(false);
  });

  it("B. candidate and fallback both invalid — throws with diagnostic summary", () => {
    const badHtml = validHtml + "<!-- wp:unmatched -->";
    const worseHtml = validHtml.replace(/<!--\s*\/wp:paragraph\s*-->/g, "");
    expect(() => guardStageOutput(badHtml, worseHtml, baseline, "diag-stage")).toThrow();
    try {
      guardStageOutput(badHtml, worseHtml, baseline, "diag-stage");
    } catch (e: any) {
      expect(e.message).toContain("diag-stage");
      expect(e.message).toContain("candidate");
      expect(e.message).toContain("fallback");
      expect(e.message).toContain("issue");
    }
  });

  it("does not throw when fallback is valid", () => {
    const badHtml = validHtml + "<!-- wp:unmatched -->";
    // candidate invalid, fallback valid — returns fallback without throwing
    const result = guardStageOutput(badHtml, validHtml, baseline, "recover-stage");
    expect(result.html).toBe(validHtml);
    expect(result.accepted).toBe(false);
  });

  it("returns accepted=true for valid HTML", () => {
    const result = guardStageOutput(validHtml, null, baseline, "valid-stage");
    expect(result.html).toBe(validHtml);
    expect(result.accepted).toBe(true);
  });
});

describe("pipeline: paragraph normalization", () => {
  it("D. normalizes long paragraphs without breaking WordPress block balance", () => {
    const longPara = `<!-- wp:paragraph --><p>First sentence here. Second sentence follows. Third sentence comes next. Fourth sentence goes here. Fifth sentence to finish. Sixth sentence adds more. Seventh sentence extends further. Eighth sentence continues on.</p><!-- /wp:paragraph -->`;
    const result = normalizeParagraphs(longPara, 3);
    expect(result.splitCount).toBeGreaterThan(0);
    const wpResult = validateWordpressBlockPairs(result.html);
    expect(wpResult.valid).toBe(true);
    expect(wpResult.issues).toHaveLength(0);
  });

  it("D. normalizing valid article preserves structural integrity", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    const result = normalizeParagraphs(html, 3);
    const wpResult = validateWordpressBlockPairs(result.html);
    expect(wpResult.valid).toBe(true);
  });
});

describe("pipeline: rendered article integrity", () => {
  it("E. rendered ArticleDocument passes final article integrity validation", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    const baseline = createArticleIntegrityBaseline(html);
    const integrity = validateFinalArticleIntegrity(html, baseline);
    if (!integrity.valid) {
      console.error("Integrity errors:", integrity.errors);
    }
    expect(integrity.valid).toBe(true);
    expect(integrity.errors).toHaveLength(0);
  });

  it("E. rendered ArticleDocument has balanced WordPress block pairs", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    const wpResult = validateWordpressBlockPairs(html);
    if (!wpResult.valid) {
      console.error("WP block issues:", wpResult.issues);
    }
    expect(wpResult.valid).toBe(true);
    expect(wpResult.issues).toHaveLength(0);
  });

  it("E. FAQ schema is present and valid in rendered output", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    expect(html).toContain("FAQPage");
    expect(html).toContain("application/ld+json");
  });

  it("E. CTA block is present in rendered output", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    expect(html).toContain("app.b2ihub.com/signup");
  });

  it("E. language switcher is present in rendered output", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    expect(html).toContain("b2i-language-switcher");
  });

  it("E. FAQ section with <strong> and <br> tags passes validation", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    expect(html).toContain("<strong>What is");
    expect(html).toContain("<br>");
    const wpResult = validateWordpressBlockPairs(html);
    expect(wpResult.valid).toBe(true);
  });

  it("E. round-trip parse→render preserves structural validity", () => {
    const doc = makeArticleDoc();
    const html1 = renderArticleDocument(doc);
    const parseResult = parseArticleDocumentFromHtml(html1, doc);
    expect(parseResult.doc).not.toBeNull();
    if (!parseResult.doc) return;
    const html2 = renderArticleDocument(parseResult.doc);
    const wpResult = validateWordpressBlockPairs(html2);
    expect(wpResult.valid).toBe(true);
  });

  it("E. round-trip parse→render preserves introduction content", () => {
    const doc = makeArticleDoc();
    const html1 = renderArticleDocument(doc);
    const parseResult = parseArticleDocumentFromHtml(html1, doc);
    expect(parseResult.doc).not.toBeNull();
    if (!parseResult.doc) return;
    expect(parseResult.doc.introduction.html).toContain("This is the introduction");
  });

  it("E. round-trip parse→render preserves conclusion content", () => {
    const doc = makeArticleDoc();
    const html1 = renderArticleDocument(doc);
    const parseResult = parseArticleDocumentFromHtml(html1, doc);
    expect(parseResult.doc).not.toBeNull();
    if (!parseResult.doc) return;
    expect(parseResult.doc.conclusion.html).toContain("In conclusion");
  });

  it("E. round-trip parse→render preserves all sections", () => {
    const doc = makeArticleDoc();
    const html1 = renderArticleDocument(doc);
    const parseResult = parseArticleDocumentFromHtml(html1, doc);
    expect(parseResult.doc).not.toBeNull();
    if (!parseResult.doc) return;
    expect(parseResult.doc.sections.length).toBe(doc.sections.length);
  });

  it("E. no nested paragraphs in rendered output", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    const nested = detectNestedParagraphs(html);
    expect(nested).toBe(0);
  });
});

describe("E2: regression — 6-section article with H3 subheadings", () => {
  function makeSixSectionDoc(): ArticleDocument {
    const ls = `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/test-zh">繁體中文</a></div><!-- /wp:html -->`;
    const intro = `<!-- wp:paragraph --><p>This article explores the latest trends in Hong Kong digital marketing for 2026. Understanding these shifts can help businesses adapt their strategies for better engagement.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>The landscape continues to evolve rapidly with new platforms and consumer behaviors emerging across the Asia-Pacific region.</p><!-- /wp:paragraph -->`;

    const bodies = [
      `<!-- wp:paragraph --><p>The Hong Kong market is unique in its blend of Eastern and Western influences. This creates opportunities for brands that can navigate both cultural contexts effectively.</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":3} -->\n<h3>Market Demographics</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Hong Kong has a highly connected population with smartphone penetration exceeding 90%. This makes mobile-first strategies essential for any campaign targeting this market.</p><!-- /wp:paragraph -->`,
      `<!-- wp:paragraph --><p>Social media platforms in Hong Kong follow distinct usage patterns compared to mainland China. While WeChat dominates in the mainland, Hong Kong users prefer WhatsApp, Facebook, and Instagram for daily communication.</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":3} -->\n<h3>Platform Preferences</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Understanding these platform differences is crucial for any digital marketing strategy in Hong Kong.</p><!-- /wp:paragraph -->`,
      `<!-- wp:paragraph --><p>Content marketing in Hong Kong requires a bilingual approach. Most consumers expect content in both Traditional Chinese and English, reflecting the city's unique cultural position.</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":3} -->\n<h3>Bilingual Strategy</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Quality translation and localization are not optional but essential components of any successful campaign.</p><!-- /wp:paragraph -->`,
      `<!-- wp:paragraph --><p>Influencer marketing has grown significantly in Hong Kong over the past two years. Local KOLs with authentic connections to their audience deliver stronger engagement than celebrity endorsements.</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":3} -->\n<h3>KOL Selection Criteria</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Brands should prioritize micro-influencers with high engagement rates over macro-influencers with large but less engaged followings.</p><!-- /wp:paragraph -->`,
      `<!-- wp:paragraph --><p>SEO in Hong Kong presents unique challenges due to the mixed language environment. Google remains the dominant search engine, unlike mainland China where Baidu leads.</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":3} -->\n<h3>SEO Best Practices</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Optimizing for both English and Chinese keywords while maintaining natural readability is the key challenge that marketers face in this market.</p><!-- /wp:paragraph -->`,
      `<!-- wp:paragraph --><p>Data privacy regulations in Hong Kong are aligned with international standards. The Personal Data (Privacy) Ordinance provides a framework that businesses must follow when collecting and processing consumer data.</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":3} -->\n<h3>Compliance Requirements</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>Marketers must ensure their data collection practices comply with both local regulations and international standards like GDPR when targeting cross-border audiences.</p><!-- /wp:paragraph -->`,
    ];

    const sections = bodies.map((body, i) => ({
      id: `section-${i}`,
      heading: `Section ${i + 1}: Topic ${i + 1}`,
      headingLevel: 2 as const,
      sectionType: "main" as const,
      html: body,
      wordCount: countReadableWords(body),
      status: "generated" as const,
    }));

    const cta = `<!-- wp:html --><div class="cta-block"><h2>Ready to Grow Your Brand?</h2><p>Join B2I Hub today at <a href="https://app.b2ihub.com/signup">app.b2ihub.com/signup</a> and start creating content that converts.</p></div><!-- /wp:html -->`;

    const conclusion = `<!-- wp:paragraph --><p>Hong Kong digital marketing in 2026 requires a sophisticated understanding of local consumer behavior, bilingual content strategies, and platform-specific approaches.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Brands that invest in these areas will be well-positioned to capture growth in one of Asia's most dynamic markets.</p><!-- /wp:paragraph -->`;

    const faqSchema = renderFaqSchema([
      { question: "What is the best platform for Hong Kong?", answerHtml: "", answerText: "WhatsApp, Facebook, and Instagram." },
      { question: "Is bilingual content necessary?", answerHtml: "", answerText: "Yes, both Chinese and English." },
    ]);

    return {
      metadata: { title: "Hong Kong Digital Marketing 2026", slug: "hk-digital-2026", metaDescription: "HK digital marketing", excerpt: "", targetWordCount: 2500, focusKeyphrase: "hong kong digital marketing" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: ls, fingerprint: "ls-fp" },
      introduction: { id: "intro", html: intro, wordCount: 50, status: "generated" },
      sections,
      visibleFaq: [],
      conclusion: { id: "conc", html: conclusion, wordCount: 50, status: "generated" },
      cta: { id: "cta", type: "cta", html: cta, fingerprint: "cta-fp" },
      faqSchema: { id: "faq", type: "faq-schema", html: faqSchema, fingerprint: "faq-fp" },
      insertedLinks: [],
    };
  }

  it("renders with balanced wp:heading blocks", () => {
    const doc = makeSixSectionDoc();
    const html = renderArticleDocument(doc);
    const wpResult = validateWordpressBlockPairs(html);
    if (!wpResult.valid) console.error("WP block issues:", JSON.stringify(wpResult.issues, null, 2));
    expect(wpResult.valid).toBe(true);
  });

  it("opening and closing wp:heading counts match", () => {
    const doc = makeSixSectionDoc();
    const html = renderArticleDocument(doc);
    const openers = (html.match(/<!--\s*wp:heading/gi) ?? []).length;
    const closers = (html.match(/<!--\s*\/wp:heading/gi) ?? []).length;
    expect(openers).toBe(closers);
  });

  it("round-trip parse→render preserves valid block pairs", () => {
    const doc = makeSixSectionDoc();
    const html1 = renderArticleDocument(doc);
    const parseResult = parseArticleDocumentFromHtml(html1, doc);
    expect(parseResult.doc).not.toBeNull();
    if (!parseResult.doc) return;
    const html2 = renderArticleDocument(parseResult.doc);
    const wpResult = validateWordpressBlockPairs(html2);
    if (!wpResult.valid) console.error("Round-trip WP issues:", JSON.stringify(wpResult.issues, null, 2));
    expect(wpResult.valid).toBe(true);
  });
});

describe("E3: regression — section cleanup strips H2 but keeps H3", () => {
  const cleanupH2 = (raw: string): string => {
    let clean = raw.replace(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi, "");
    clean = clean.replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, "");
    return clean;
  };

  it("renders with balanced blocks after H2 cleanup of section bodies", () => {
    // Simulate AI-generated section body with stray H2 + valid H3
    const aiRaw = `<!-- wp:heading {"level":2} --><h2>Stray H2 from AI</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>Some text with a stray H2 heading that the AI incorrectly included even though it was told not to.</p><!-- /wp:paragraph -->
<!-- wp:heading {"level":3} -->\n<h3>Subheading</h3>\n<!-- /wp:heading -->
<!-- wp:paragraph --><p>This is the valid section content.</p><!-- /wp:paragraph -->`;

    const cleaned = cleanupH2(aiRaw);

    const sections = [
      { id: "s0", heading: "Topic A", headingLevel: 2 as const, sectionType: "main" as const, html: cleaned, wordCount: 0, status: "generated" as const },
      { id: "s1", heading: "Topic B", headingLevel: 2 as const, sectionType: "main" as const, html: cleaned, wordCount: 0, status: "generated" as const },
      { id: "s2", heading: "Topic C", headingLevel: 2 as const, sectionType: "main" as const, html: cleaned, wordCount: 0, status: "generated" as const },
      { id: "s3", heading: "Topic D", headingLevel: 2 as const, sectionType: "main" as const, html: cleaned, wordCount: 0, status: "generated" as const },
      { id: "s4", heading: "Topic E", headingLevel: 2 as const, sectionType: "main" as const, html: cleaned, wordCount: 0, status: "generated" as const },
      { id: "s5", heading: "Topic F", headingLevel: 2 as const, sectionType: "main" as const, html: cleaned, wordCount: 0, status: "generated" as const },
    ];

    const doc: ArticleDocument = {
      metadata: { title: "Test", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 2000, focusKeyphrase: "test" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->`, fingerprint: "x" },
      introduction: { id: "intro", html: `<!-- wp:paragraph --><p>Intro text.</p><!-- /wp:paragraph -->`, wordCount: 3, status: "generated" },
      sections,
      visibleFaq: [],
      conclusion: { id: "conc", html: `<!-- wp:paragraph --><p>Conclusion text.</p><!-- /wp:paragraph -->`, wordCount: 3, status: "generated" },
      cta: { id: "cta", type: "cta", html: `<!-- wp:html --><div class="cta"><h2>Join</h2><a href="https://app.b2ihub.com/signup">Sign up</a></div><!-- /wp:html -->`, fingerprint: "c" },
      faqSchema: null,
      insertedLinks: [],
    };

    const html = renderArticleDocument(doc);
    const wpResult = validateWordpressBlockPairs(html);
    if (!wpResult.valid) console.error("WP block issues:", JSON.stringify(wpResult.issues, null, 2));
    expect(wpResult.valid).toBe(true);
  });

  it("conclusion split preserves block balance when H3+paragraph in last section", () => {
    const lastBody = `<!-- wp:heading {"level":3} -->\n<h3>Key Takeaway</h3>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph --><p>This is the concluding thought that wraps up the section content effectively.</p><!-- /wp:paragraph -->`;

    const sections = [
      { id: "s0", heading: "Topic A", headingLevel: 2 as const, sectionType: "main" as const, html: `<!-- wp:paragraph --><p>Body 1.</p><!-- /wp:paragraph -->`, wordCount: 3, status: "generated" as const },
      { id: "s1", heading: "Topic B", headingLevel: 2 as const, sectionType: "main" as const, html: lastBody, wordCount: 30, status: "generated" as const },
    ];

    const doc: ArticleDocument = {
      metadata: { title: "Test", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 500, focusKeyphrase: "test" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->`, fingerprint: "x" },
      introduction: { id: "intro", html: `<!-- wp:paragraph --><p>Intro.</p><!-- /wp:paragraph -->`, wordCount: 2, status: "generated" },
      sections,
      visibleFaq: [],
      conclusion: { id: "conc", html: `<!-- wp:paragraph --><p>Conclusion text.</p><!-- /wp:paragraph -->`, wordCount: 3, status: "generated" },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };

    const html = renderArticleDocument(doc);
    const wpResult = validateWordpressBlockPairs(html);
    if (!wpResult.valid) console.error("WP block issues:", JSON.stringify(wpResult.issues, null, 2));
    expect(wpResult.valid).toBe(true);

    const parsed = parseArticleDocumentFromHtml(html, doc);
    expect(parsed.doc).not.toBeNull();
    if (!parsed.doc) return;
    const html2 = renderArticleDocument(parsed.doc);
    const wpResult2 = validateWordpressBlockPairs(html2);
    if (!wpResult2.valid) console.error("Round-trip WP issues:", JSON.stringify(wpResult2.issues, null, 2));
    expect(wpResult2.valid).toBe(true);
  });
});

describe("pipeline: pre-stage validation", () => {
  it("C. invalid HTML before stage throws with clear message via guardStageOutput", () => {
    const doc = makeArticleDoc();
    const html = renderArticleDocument(doc);
    const badHtml = html + "<!-- wp:unmatched -->";
    const worseHtml = html.replace(/<!--\s*\/wp:paragraph\s*-->/g, "");
    // Both invalid → guardStageOutput throws
    expect(() => guardStageOutput(badHtml, worseHtml, createArticleIntegrityBaseline(html), "pre-val-stage")).toThrow();
  });
});

describe("final-article validation order", () => {
  it("validatePipelineOrder reports missing stages", () => {
    const issues = validatePipelineOrder({
      stageOutputs: [{ stage: "expansion", accepted: true }],
    } as any);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.code === "MISSING_STAGE")).toBe(true);
  });
});

describe("pipeline error hardening", () => {
  it("F. pipeline errors produce 500 with no internal details in response", async () => {
    const { toErrorResponse } = await import("@/lib/services/errors");
    // Simulate a pipeline guard failure
    const err = new Error("Stage paragraphs: both candidate and fallback invalid. Candidate 1 issue: test. Fallback 2 issues: test; test.");
    const res = toErrorResponse(err);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
    // Validation details must not leak
    const json = JSON.stringify(body);
    expect(json).not.toContain("candidate");
    expect(json).not.toContain("fallback");
    expect(json).not.toContain("paragraphs");
    expect(json).not.toContain("issue");
  });
});
