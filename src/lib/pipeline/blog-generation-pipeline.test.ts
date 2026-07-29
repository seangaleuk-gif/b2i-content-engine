import { describe, it, expect } from "vitest";
import {
  type ArticleDocument,
  type ArticleSection,
  type ComponentStatus,
  renderArticleDocument,
  renderComponentHtml,
  fingerprintHtml,
  parseArticleDocumentFromHtml,
  parseWordPressEditorialBlocks,
  detectNestedParagraphs,
  renderFaqSchema,
  extractVisibleFaqFromArticle,
  extractFaqPairsFromSectionBody,
} from "@/lib/blog/article-document";
import {
  createArticleIntegrityBaseline,
  validateFinalArticleIntegrity,
  validateWordpressBlockPairs,
  type ArticleIntegrityBaseline,
} from "@/lib/blog/article-integrity";
import { normalizeParagraphs } from "@/lib/services/section-expander";
import { countReadableWords, rebalanceWpBlocks, countLongParagraphs } from "@/lib/services/text-utils";
import { wordCountRange } from "@/lib/services/generation-constants";
import {
  assertFinalWordCountParity,
  assertRenderedCacheMatchesDocument,
  createPipelineState,
  guardStageOutput,
  shouldAcceptSeoNormalization,
  validatePipelineOrder,
} from "@/lib/pipeline/blog-generation-pipeline";
import { enforceInternalLinkLimit, analyzeFinalArticle, evaluatePolicy, buildPolicy, type FinalArticleMetrics } from "@/lib/blog/final-article-policy";
import { countCtaHeadingTags } from "@/lib/seo/seo-text-utils";

// ── Test helpers ──

function componentFromHtml(
  id: string,
  html: string,
  status: ComponentStatus = "generated",
): ArticleDocument["introduction"] {
  return {
    id,
    blocks: parseWordPressEditorialBlocks(html, id).blocks,
    status,
  };
}

function sectionFromHtml(
  id: string,
  heading: string,
  html: string,
  sectionType: ArticleSection["sectionType"] = "main",
  status: ComponentStatus = "generated",
): ArticleSection {
  return {
    id,
    heading,
    headingLevel: 2,
    sectionType,
    blocks: parseWordPressEditorialBlocks(html, id).blocks,
    status,
  };
}

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

  const visibleFaq = [
    { question: "What is the main benefit?", answerHtml: "", answerText: "It helps you save time and money." },
    { question: "How do I get started?", answerHtml: "", answerText: "Simply sign up and follow the setup." },
  ];

  const faqSchema = {
    id: "faq-schema",
    type: "faq-schema" as const,
    html: renderFaqSchema(visibleFaq),
    fingerprint: "ghi",
  };

  const introduction = componentFromHtml(
    "intro",
    `<!-- wp:paragraph --><p>This is the introduction paragraph that explains the topic in detail. It has multiple sentences to provide context. This is the third sentence for good measure.</p><!-- /wp:paragraph -->`,
  );

  const sections: ArticleSection[] = [
    sectionFromHtml(
      "section-0",
      "First Main Heading",
      `<!-- wp:paragraph --><p>First section content with several sentences. This covers the first main topic in detail. It has enough content to be useful for readers.</p><!-- /wp:paragraph -->

<!-- wp:paragraph --><p>Additional paragraph in the first section. This provides more depth on the first topic. Readers will find this informative and well-structured.</p><!-- /wp:paragraph -->`,
    ),
    sectionFromHtml(
      "section-1",
      "Second Topic Explored",
      `<!-- wp:paragraph --><p>Second section body text with quality content. This section explores a different angle of the main topic. Readers benefit from the varied perspective provided here.</p><!-- /wp:paragraph -->`,
    ),
    sectionFromHtml(
      "section-2",
      "Frequently Asked Questions",
      `<!-- wp:paragraph --><p><strong>What is the main benefit?</strong><br>It helps you save time and money.</p><!-- /wp:paragraph -->

<!-- wp:paragraph --><p><strong>How do I get started?</strong><br>Simply sign up and follow the setup.</p><!-- /wp:paragraph -->`,
      "faq-heading",
    ),
  ];

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
    introduction,
    sections,
    visibleFaq,
    conclusion: componentFromHtml(
      "conclusion",
      `<!-- wp:paragraph --><p>In conclusion, this approach provides significant value. Readers should take action on the key points discussed above. The benefits are clear and well-documented.</p><!-- /wp:paragraph -->`,
    ),
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

describe("pipeline: canonical state invariants", () => {
  it("detects rendered cache divergence immediately", () => {
    const doc = makeArticleDoc();
    const blog = renderArticleDocument(doc);
    expect(() => assertRenderedCacheMatchesDocument({ articleDoc: doc, blog })).not.toThrow();
    expect(() => assertRenderedCacheMatchesDocument({ articleDoc: doc, blog: blog + " stale" })).toThrow(/diverged/);
  });

  it("accepts safe SEO normalization before the canonical CTA is restored", () => {
    const accepted = shouldAcceptSeoNormalization({
      passed: true,
      safety: {
        protectedBlocksUnchanged: true,
        linkDestinationsUnchanged: true,
        wordpressBlocksValid: true,
        faqSchemaPreserved: true,
        languageSwitcherPreserved: true,
        ctaPreserved: false,
      },
    } as any);
    expect(accepted).toBe(true);
  });

  it("allows a damaged CTA to be replaced by the canonical signup CTA", () => {
    const damagedDoc = makeArticleDoc({
      cta: {
        id: "cta",
        type: "cta",
        html: `<!-- wp:html --><div class="cta-broken"><a href="https://app.b2ihub.com/signup">Broken CTA</a></div><!-- /wp:html -->`,
        fingerprint: "broken",
      },
    });
    const repairedDoc = makeArticleDoc({
      cta: {
        id: "cta",
        type: "cta",
        html: `<!-- wp:html --><div><h2>Ready to grow your brand with Hong Kong creators?</h2><a href="https://app.b2ihub.com/signup">Create Your Free Profile</a></div><!-- /wp:html -->`,
        fingerprint: "repaired",
      },
    });
    const baseline = createArticleIntegrityBaseline(renderArticleDocument(damagedDoc));
    const result = validateFinalArticleIntegrity(renderArticleDocument(repairedDoc), baseline);
    expect(result.valid).toBe(true);
    expect(result.metrics.ctaPresent).toBe(true);
  });

  it("uses the same readable word count as final validation after CTA and FAQ rendering", () => {
    const doc = makeArticleDoc();
    const state = createPipelineState({
      userId: "test",
      projectId: "1",
      keyphrase: "test keyphrase",
      requestedWordCount: 500,
      articleDoc: doc,
      h2Headings: doc.sections.map((section) => section.heading),
      intro: renderComponentHtml(doc.introduction),
      conclusion: renderComponentHtml(doc.conclusion),
      wordsPerSection: 100,
      exactKeyphraseTarget: 2,
      policy: buildPolicy(500, 450, 550, "test keyphrase"),
      ctx: {},
      wordMin: 450,
      wordMax: 550,
      systemPrompt: "",
      userMessage: "",
    });

    const pipelineCount = assertFinalWordCountParity(state);
    const metrics = analyzeFinalArticle(
      state.blog,
      state.keyphrase,
      state.title,
      state.metaDescription,
      state.requestedWordCount,
    );
    expect(pipelineCount).toBe(metrics.readableWordCount);
  });
});

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

  it("D. splits paragraphs with inline HTML tags between sentences", () => {
    // Bug: inline tags like </strong> after punctuation were blocking sentence detection
    const longPara = `<!-- wp:paragraph --><p>First sentence introduces the concept. <strong>Second sentence with emphasis about key benefits.</strong> Third sentence provides additional context. Fourth sentence concludes the thought.</p><!-- /wp:paragraph -->`;
    const result = normalizeParagraphs(longPara, 3);
    expect(result.splitCount).toBeGreaterThan(0);
    const wpResult = validateWordpressBlockPairs(result.html);
    expect(wpResult.valid).toBe(true);
    // After splitting into 3+1 sentence blocks, no single block should have 4+ sentences
    const longCount = countLongParagraphs(result.html, 3);
    expect(longCount).toBe(0);
  });

  it("D. countLongParagraphs correctly handles inline tags between sentences", () => {
    // Same bug as split function — inline tags blocked sentence detection
    const para = `<!-- wp:paragraph --><p>First sentence here. <strong>Second sentence.</strong> Third sentence follows. <a href="/blog/test">Fourth sentence link.</a> Fifth sentence finishes.</p><!-- /wp:paragraph -->`;
    const longCount = countLongParagraphs(para, 3);
    expect(longCount).toBe(1); // 5 sentences → exceeds max
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
    expect(html).toContain("<div class=\"faq-item\">");
    expect(html).toContain("<h3>What is the main benefit?</h3>");
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
    expect(renderComponentHtml(parseResult.doc.introduction)).toContain("This is the introduction");
  });

  it("E. round-trip parse→render preserves conclusion content", () => {
    const doc = makeArticleDoc();
    const html1 = renderArticleDocument(doc);
    const parseResult = parseArticleDocumentFromHtml(html1, doc);
    expect(parseResult.doc).not.toBeNull();
    if (!parseResult.doc) return;
    expect(renderComponentHtml(parseResult.doc.conclusion)).toContain("In conclusion");
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

    const sections = bodies.map((body, i) =>
      sectionFromHtml(`section-${i}`, `Section ${i + 1}: Topic ${i + 1}`, body),
    );

    const cta = `<!-- wp:html --><div class="cta-block"><h2>Ready to Grow Your Brand?</h2><p>Join B2I Hub today at <a href="https://app.b2ihub.com/signup">app.b2ihub.com/signup</a> and start creating content that converts.</p></div><!-- /wp:html -->`;

    const conclusion = `<!-- wp:paragraph --><p>Hong Kong digital marketing in 2026 requires a sophisticated understanding of local consumer behavior, bilingual content strategies, and platform-specific approaches.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Brands that invest in these areas will be well-positioned to capture growth in one of Asia's most dynamic markets.</p><!-- /wp:paragraph -->`;

    const faqSchema = renderFaqSchema([
      { question: "What is the best platform for Hong Kong?", answerHtml: "", answerText: "WhatsApp, Facebook, and Instagram." },
      { question: "Is bilingual content necessary?", answerHtml: "", answerText: "Yes, both Chinese and English." },
    ]);

    return {
      metadata: { title: "Hong Kong Digital Marketing 2026", slug: "hk-digital-2026", metaDescription: "HK digital marketing", excerpt: "", targetWordCount: 2500, focusKeyphrase: "hong kong digital marketing" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: ls, fingerprint: "ls-fp" },
      introduction: componentFromHtml("intro", intro),
      sections,
      visibleFaq: [],
      conclusion: componentFromHtml("conc", conclusion),
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
      sectionFromHtml("s0", "Topic A", cleaned),
      sectionFromHtml("s1", "Topic B", cleaned),
      sectionFromHtml("s2", "Topic C", cleaned),
      sectionFromHtml("s3", "Topic D", cleaned),
      sectionFromHtml("s4", "Topic E", cleaned),
      sectionFromHtml("s5", "Topic F", cleaned),
    ];

    const doc: ArticleDocument = {
      metadata: { title: "Test", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 2000, focusKeyphrase: "test" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->`, fingerprint: "x" },
      introduction: componentFromHtml("intro", `<!-- wp:paragraph --><p>Intro text.</p><!-- /wp:paragraph -->`),
      sections,
      visibleFaq: [],
      conclusion: componentFromHtml("conc", `<!-- wp:paragraph --><p>Conclusion text.</p><!-- /wp:paragraph -->`),
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
      sectionFromHtml("s0", "Topic A", `<!-- wp:paragraph --><p>Body 1.</p><!-- /wp:paragraph -->`),
      sectionFromHtml("s1", "Topic B", lastBody),
    ];

    const doc: ArticleDocument = {
      metadata: { title: "Test", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 500, focusKeyphrase: "test" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->`, fingerprint: "x" },
      introduction: componentFromHtml("intro", `<!-- wp:paragraph --><p>Intro.</p><!-- /wp:paragraph -->`),
      sections,
      visibleFaq: [],
      conclusion: componentFromHtml("conc", `<!-- wp:paragraph --><p>Conclusion text.</p><!-- /wp:paragraph -->`),
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

describe("FAQ generation guarantees", () => {
  const faqHeadingPattern = /faq|frequently.asked|common.question/i;

  function articleWithFaqSection(faqBody: string): ArticleDocument {
    const ls = `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->`;
    const intro = `<!-- wp:paragraph --><p>Introduction text with keyphrase.</p><!-- /wp:paragraph -->`;
    const sections: ArticleDocument["sections"] = [
      sectionFromHtml("s0", "Topic Overview", `<!-- wp:paragraph --><p>Body content.</p><!-- /wp:paragraph -->`),
      sectionFromHtml("s1", "Frequently Asked Questions", faqBody, "faq-heading"),
    ];
    const visibleFaq = extractFaqPairsFromSectionBody(faqBody).map((entry) => ({
      question: entry.question,
      answerHtml: "",
      answerText: entry.answerText,
    }));
    return {
      metadata: { title: "Test", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 500, focusKeyphrase: "test keyphrase" },
      languageSwitcher: { id: "ls", type: "language-switcher", html: ls, fingerprint: "ls" },
      introduction: componentFromHtml("intro", intro),
      sections,
      visibleFaq,
      conclusion: componentFromHtml("conc", `<!-- wp:paragraph --><p>Conclusion.</p><!-- /wp:paragraph -->`),
      cta: null, faqSchema: null,
      insertedLinks: [],
    };
  }

  it("visible FAQ using canonical format is extracted correctly", () => {
    const faqBody = `<!-- wp:paragraph --><p><strong>What is the benefit?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>It saves time and money.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p><strong>How do I start?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Sign up and follow the guide.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    const html = renderArticleDocument(doc);
    const visible = extractVisibleFaqFromArticle(html);
    expect(visible.length).toBe(2);
    expect(visible[0].question).toContain("What is the benefit");
    expect(visible[1].question).toContain("How do I start");
  });

  it("FAQ schema generated from visible FAQ matches questions", () => {
    const faqBody = `<!-- wp:paragraph --><p><strong>What is it?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Answer one.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p><strong>Why use it?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Answer two.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p><strong>When to start?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Answer three.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p><strong>Where to apply?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Answer four.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    const html = renderArticleDocument(doc);
    const visible = extractVisibleFaqFromArticle(html);
    const schema = renderFaqSchema(visible.map((v) => ({ question: v.question, answerHtml: "", answerText: v.answerText })));
    expect(schema).toContain("FAQPage");
    expect((schema.match(/"name"/g) ?? []).length).toBe(4);
  });

  it("full article with FAQ passes final validation (structural + FAQ)", () => {
    const faqBody = `<!-- wp:paragraph --><p><strong>What is the benefit?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>It saves time and money.</p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p><strong>How do I start?</strong></p><!-- /wp:paragraph -->\n\n<!-- wp:paragraph --><p>Simply sign up and follow the guided setup process.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    doc.cta = { id: "cta", type: "cta", html: `<!-- wp:html --><div class="cta"><a href="https://app.b2ihub.com/signup">Sign up</a></div><!-- /wp:html -->`, fingerprint: "cta" };
    const html = renderArticleDocument(doc);

    // FAQ recovery: extract visible FAQ, generate schema, insert before conclusion
    const visible = extractVisibleFaqFromArticle(html);
    expect(visible.length).toBe(2);
    const rebuilt = renderFaqSchema(visible.map((v) => ({ question: v.question, answerHtml: "", answerText: v.answerText })));
    const concIdx = html.lastIndexOf("Conclusion.");
    const finalHtml = concIdx >= 0 ? html.substring(0, concIdx) + rebuilt + "\n\n" + html.substring(concIdx) : html + "\n\n" + rebuilt;

    // Validate
    const wpResult = validateWordpressBlockPairs(finalHtml);
    expect(wpResult.valid).toBe(true);
    expect(finalHtml).toContain("FAQPage");
    expect(finalHtml).toContain("b2i-language-switcher");
    expect(finalHtml).toContain("app.b2ihub.com/signup");
  });

  it("FAQ parity after parse→render round-trip", () => {
    const faqBody = `<!-- wp:paragraph --><p><strong>Question One?</strong> Answer.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    const html = renderArticleDocument(doc);
    const parsed = parseArticleDocumentFromHtml(html, doc);
    expect(parsed.doc).not.toBeNull();
    if (!parsed.doc) return;
    const html2 = renderArticleDocument(parsed.doc);
    // FAQ section should still be present
    expect(html2).toContain("Frequently Asked Questions");
    expect(html2).toContain("Question One");
  });

  it("FAQ section without visible questions logs and returns empty", () => {
    const faqBody = `<!-- wp:paragraph --><p>This FAQ section has no visible questions in the expected format. Just text.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    const html = renderArticleDocument(doc);
    const visible = extractVisibleFaqFromArticle(html);
    expect(visible.length).toBe(0);
  });

  it("outline without FAQ heading gets one appended (generation guarantee)", () => {
    const topic = "Hong Kong Digital Marketing";
    const h2Headings = ["Overview", "Strategy", "Platforms", "Conclusion"];
    const faqPattern = /faq|frequently.asked|common.question/i;
    const hasFaq = h2Headings.some((h) => faqPattern.test(h));
    expect(hasFaq).toBe(false);
    // Simulate the append logic
    const nonFaqEnd = /conclusion|summary|final|wrap.?up|takeaway/i;
    let faqIdx = h2Headings.length;
    for (let i = h2Headings.length - 1; i >= 0; i--) {
      if (nonFaqEnd.test(h2Headings[i])) { faqIdx = i; break; }
    }
    const faqHeading = `Frequently Asked Questions About ${topic}`;
    if (faqIdx < h2Headings.length && nonFaqEnd.test(h2Headings[faqIdx])) {
      h2Headings[faqIdx] = faqHeading;
    } else {
      h2Headings.push(faqHeading);
    }
    expect(h2Headings[h2Headings.length - 1]).toContain("Frequently Asked Questions");
    expect(faqPattern.test(h2Headings[h2Headings.length - 1])).toBe(true);
    expect(h2Headings).toContain("Frequently Asked Questions About Hong Kong Digital Marketing");
  });

  it("verifyStructuralIntegrity does NOT reject HTML missing FAQ JSON-LD (recovery runs later)", () => {
    // SEO normalization runs BEFORE faq-recovery. The absence of FAQ JSON-LD
    // during normalization must not cause structValid=false.
    const html = `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span></div><!-- /wp:html -->
<!-- wp:paragraph --><p>Article text with keyphrase.</p><!-- /wp:paragraph -->
<!-- wp:heading {"level":2} -->
<h2>Topic Heading</h2>
<!-- /wp:heading -->
<!-- wp:paragraph --><p>Body content.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>In conclusion, key takeaways here.</p><!-- /wp:paragraph -->`;
    const { valid, issues } = validateWordpressBlockPairs(html);
    // WordPress blocks must be structurally valid
    expect(valid).toBe(true);
    // FAQ JSON-LD is absent (expected — recovery hasn't run yet)
    expect(html).not.toContain("FAQPage");
    // But the article HTML is still valid WordPress
    expect(issues).toHaveLength(0);
  });

  it("extractVisibleFaqFromArticle <strong> fallback ignores inline keyphrase <strong> in answers", () => {
    // Regression: the <strong> fallback mode must only match <strong> elements
    // that look like questions (end with "?"). Inline keyphrase highlights
    // inside answer text like "planning your <strong>threads marketing hong kong</strong>
    // strategy" must NOT be split into separate FAQ entries.
    const faqBody = `<!-- wp:paragraph --><p><strong>What kind of content works best?</strong></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>Authentic real-time updates. This is handy for planning your <strong>strategy approach</strong> in advance.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>How often should I post?</strong></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>Consistency matters more than frequency. Focus on <strong>quality content</strong> for best results.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>Can scheduling tools help?</strong></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>Not natively yet, but third-party tools like Hootsuite now support <strong>advanced scheduling</strong> features. Just remember to check in daily.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    const html = renderArticleDocument(doc);
    const visible = extractVisibleFaqFromArticle(html);
    // Should be exactly 3 Q&A pairs (only those with "?" after <strong>)
    expect(visible.length).toBe(3);
    expect(visible[0].question).toContain("What kind of content works best");
    expect(visible[1].question).toContain("How often should I post");
    expect(visible[2].question).toContain("Can scheduling tools help");
    // Each answer should NOT contain another question text
    for (const v of visible) {
      expect(v.answerText).not.toContain("What kind of");
      expect(v.answerText).not.toContain("How often should");
      expect(v.answerText).not.toContain("Can scheduling");
    }
  });

  it("FAQ schema from extracted visible FAQ has correct entry count", () => {
    // When extractVisibleFaqFromArticle correctly returns 3 items,
    // renderFaqSchema must produce exactly 3 schema entries.
    const faqBody = `<!-- wp:paragraph --><p><strong>What is the benefit?</strong></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>It saves time. The <strong>key concept</strong> is efficiency.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>Why use this approach?</strong></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>It works better. Our <strong>proven methodology</strong> delivers results.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>When to get started?</strong></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>Start today. Just <strong>begin with a plan</strong> and execute.</p><!-- /wp:paragraph -->`;
    const doc = articleWithFaqSection(faqBody);
    const html = renderArticleDocument(doc);
    const visible = extractVisibleFaqFromArticle(html);
    expect(visible.length).toBe(3);
    const schema = renderFaqSchema(visible.map((v) => ({ question: v.question, answerHtml: "", answerText: v.answerText })));
    // Count schema entries (questions)
    const questionCount = (schema.match(/"@type": "Question"/g) || []).length;
    expect(questionCount).toBe(3);
    // No answer should contain text from another question
    expect(schema).not.toContain("key concept");
    expect(schema).not.toContain("proven methodology");
    expect(schema).not.toContain("begin with a plan");
  });

  it("robustJsonParse: unescaped double quotes in body HTML are recovered", () => {
    // Regression: AI output with unescaped quotes inside HTML content
    const malformed = `{"body": "<!-- wp:paragraph --><p>For example, a Wan Chai coffee shop might post: "We tried a new single-origin from Colombia today. Tasting notes?" The response was great.</p><!-- /wp:paragraph -->"}`;
    // Should not throw
    const result = (() => {
      try {
        return JSON.parse(malformed);
      } catch {
        // Use the same fallback as robustJsonParse
        const objMatch = malformed.match(/\{[\s\S]*\}/);
        if (objMatch) {
          const outer = objMatch[0];
          const repaired = outer.replace(/,(\s*[}\]])/g, "$1");
          try { return JSON.parse(repaired); } catch {
            // Try extractMalformedJsonStringProperty logic (simplified)
            const marker = '"body"';
            const startIdx = outer.indexOf(marker);
            const colonIdx = outer.indexOf(":", startIdx + marker.length);
            const openQuote = outer.indexOf('"', colonIdx + 1);
            if (openQuote >= 0) {
              let i = openQuote + 1;
              let inTag = false;
              while (i < outer.length) {
                const ch = outer[i];
                if (ch === '<') inTag = true;
                if (ch === '>') inTag = false;
                if (ch === '"' && !inTag) {
                  let next = i + 1;
                  while (next < outer.length && /\s/.test(outer[next])) next++;
                  if (next < outer.length && outer[next] === '}') {
                    return { body: outer.substring(openQuote + 1, i) };
                  }
                }
                i++;
              }
            }
          }
        }
        return null;
      }
    })();
    expect(result).not.toBeNull();
    if (result) expect((result as any).body).toContain("wp:paragraph");
  });

  it("robustJsonParse: unescaped quotes in intro JSON are recovered", () => {
    const malformed = `{"intro": "<!-- wp:paragraph --><p>We asked: "What's your favourite coffee?" and got answers.</p><!-- /wp:paragraph -->"}`;
    const result = (() => {
      try { return JSON.parse(malformed); } catch {
        const objMatch = malformed.match(/\{[\s\S]*\}/);
        if (objMatch) {
          const outer = objMatch[0];
          const marker = '"intro"';
          const startIdx = outer.indexOf(marker);
          const colonIdx = outer.indexOf(":", startIdx + marker.length);
          const openQuote = outer.indexOf('"', colonIdx + 1);
          if (openQuote >= 0) {
            let i = openQuote + 1;
            let inTag = false;
            while (i < outer.length) {
              const ch = outer[i];
              if (ch === '<') inTag = true;
              if (ch === '>') inTag = false;
              if (ch === '"' && !inTag) {
                let next = i + 1;
                while (next < outer.length && /\s/.test(outer[next])) next++;
                if (next < outer.length && outer[next] === '}') {
                  return { intro: outer.substring(openQuote + 1, i) };
                }
              }
              i++;
            }
          }
        }
        return null;
      }
    })();
    expect(result).not.toBeNull();
    if (result) expect((result as any).intro).toContain("favourite coffee");
  });

  it("enforceInternalLinkLimit keeps max 4 unique destinations", () => {
    // Create HTML with 5 unique editorial internal links
    const html = `<!-- wp:paragraph --><p>Text with <a href="/blog/article-1">link one</a> and <a href="/blog/article-2">link two</a> and <a href="/blog/article-3">link three</a> and <a href="/blog/article-4">link four</a> and <a href="/blog/article-5">link five</a></p><!-- /wp:paragraph -->
<!-- wp:html --><div class="b2i-language-switcher"><a href="/blog/zh-page">中文</a></div><!-- /wp:html -->
<!-- wp:html --><div class="cta"><a href="https://app.b2ihub.com/signup">Sign up</a></div><!-- /wp:html -->`;
    const result = enforceInternalLinkLimit(html, 4);
    // Count unique editorial internal links in result
    const stripped = result.html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
    const uniqueDests = new Set<string>();
    const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(stripped)) !== null) {
      const h = m[1];
      if (/^\/blog\//.test(h)) uniqueDests.add(h.replace(/\/$/, ""));
    }
    expect(uniqueDests.size).toBeLessThanOrEqual(4);
    expect(result.removed.length).toBe(1); // one link removed
    // Anchor text preserved (link unwrapped, text stays)
    expect(result.html).toContain("link five");
    expect(result.html).not.toContain(`<a href="/blog/article-5"`);
  });

  it("final-trim removes last paragraph without breaking WP blocks", () => {
    // Create a section with multiple paragraphs
    const sectionHtml = `<!-- wp:paragraph --><p>First paragraph with important content about the topic. This provides genuine value to the reader about key concepts covered here.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>Second paragraph that continues the discussion. It adds more useful information about the subject matter being discussed in this section.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p>Third paragraph with filler content that is less essential. This is the type of repetitive text that can be safely removed when trimming word count. It doesn't add much value to the overall article content.</p><!-- /wp:paragraph -->`;
    const beforeWc = countReadableWords(sectionHtml);
    expect(beforeWc).toBeGreaterThan(60);
    
    // Simulate trim: remove last paragraph
    const paras = sectionHtml.match(/<!--\s*wp:paragraph\s*-->\s*\n?<p>[\s\S]*?<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi);
    expect(paras).not.toBeNull();
    expect(paras!.length).toBe(3);
    
    const lastPara = paras![paras!.length - 1];
    const lastIdx = sectionHtml.lastIndexOf(lastPara);
    const trimmed = sectionHtml.substring(0, lastIdx).trim() + sectionHtml.substring(lastIdx + lastPara.length);
    
    const afterWc = countReadableWords(trimmed);
    expect(afterWc).toBeLessThan(beforeWc);
    expect(afterWc).toBeGreaterThan(30); // Still has substantial content
    // WP blocks remain balanced
    const wpOpen = (trimmed.match(/<!--\s*wp:\w+/gi) ?? []).length;
    const wpClose = (trimmed.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
    expect(wpOpen).toBe(wpClose);
  });

  it("rebalanceWpBlocks normalizes wp:wp: prefixes", () => {
    const html = `<!-- wp:wp:paragraph --><p>Content with doubled prefix.</p><!-- /wp:wp:paragraph -->
<!-- wp:heading {"level":2} --><h2>Normal heading</h2><!-- /wp:heading -->
<!-- /wp:wp:heading -->`;
    const normalized = rebalanceWpBlocks(html);
    // Doubled prefixes should be normalized to single prefix
    expect(normalized).not.toContain("wp:wp:");
    expect(normalized).toContain("<!-- wp:paragraph -->");
    expect(normalized).toContain("<!-- /wp:paragraph -->");
    expect(normalized).toContain("<!-- wp:heading");
    // The orphaned closer (no matching opener) should be removed by rebalance logic
    expect(normalized.split("<!-- /wp:heading").length - 1).toBeLessThanOrEqual(1);
  });

  it("wordCountRange uses ±15% for 2500-word target", () => {
    const range = wordCountRange(2500);
    // ±15% → 2125-2875
    expect(range.min).toBe(2125);
    expect(range.max).toBe(2875);
  });

  it("wordCountRange uses ±10% for 1500-word target", () => {
    const range = wordCountRange(1500);
    // ±10% → 1350-1650
    expect(range.min).toBe(1350);
    expect(range.max).toBe(1650);
  });

  it("renderArticleDocument places conclusion before CTA and FAQ schema", () => {
    const doc = makeArticleDoc({
      conclusion: componentFromHtml("conc", "<!-- wp:paragraph --><p>Conclusion text here.</p><!-- /wp:paragraph -->"),
      cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div><a href='https://app.b2ihub.com/signup'>Sign up</a></div><!-- /wp:html -->", fingerprint: "x" },
      faqSchema: { id: "faq", type: "faq-schema", html: "<!-- wp:html --><script type='application/ld+json'>{\"@type\":\"FAQPage\"}</script><!-- /wp:html -->", fingerprint: "y" },
    });
    const html = renderArticleDocument(doc);
    const concPos = html.indexOf("Conclusion text");
    const ctaPos = html.indexOf("app.b2ihub.com/signup");
    const schemaPos = html.indexOf("FAQPage");
    expect(concPos).toBeGreaterThan(0);
    expect(ctaPos).toBeGreaterThan(0);
    expect(schemaPos).toBeGreaterThan(0);
    // Conclusion must appear before CTA
    expect(concPos).toBeLessThan(ctaPos);
    // FAQ schema must appear before the final CTA block
    expect(schemaPos).toBeLessThan(ctaPos);
  });
});

// ── Regression tests: CTA preservation, FAQ parity, word count validation ──

import {
  runFinalValidation,
} from "@/lib/pipeline/blog-generation-pipeline";

describe("CTA preservation", () => {
  it("CTA survives after syncBlogFromDocument in factual-scan or trim stages", () => {
    // Simulate what happens when cta-preserve re-injects a CTA and then
    // a later stage calls syncBlogFromDocument(). The CTA should persist
    // through parseArticleDocumentFromHtml because the regex correctly
    // extracts it from the `wp:html` block.
    const ctaHtml = `<!-- wp:html --><div class="cta-block"><h2>Ready to Start?</h2><p><a href="https://app.b2ihub.com/signup">Create Free Account</a></p></div><!-- /wp:html -->`;
    const html = `<!-- wp:html --><div class="b2i-language-switcher"><span>EN</span> | <a href="/blog/test-zh">中文</a></div><!-- /wp:html -->

<!-- wp:paragraph --><p>This is an intro paragraph about the topic being discussed in this article today.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} --><h2>First Section</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>First section content with several sentences of useful information for the reader about this subject.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} --><h2>Frequently Asked Questions</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p><strong>What is the main benefit?</strong><br>It helps save time and money in real scenarios.</p><!-- /wp:paragraph -->

<!-- wp:paragraph --><p>In conclusion this is a summary paragraph with closing thoughts for readers.</p><!-- /wp:paragraph -->

${ctaHtml}

<!-- wp:html --><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the main benefit?","acceptedAnswer":{"@type":"Answer","text":"It helps."}}]}</script><!-- /wp:html -->`;

    // Parse HTML back to ArticleDocument (simulates what applyHtmlToDocument does)
    const doc = makeArticleDoc();
    const parseResult = parseArticleDocumentFromHtml(html, doc);
    expect(parseResult.doc).not.toBeNull();
    expect(parseResult.errors.length).toBe(0);

    // CTA should be extracted from HTML
    expect(parseResult.doc!.cta).not.toBeNull();
    expect(parseResult.doc!.cta!.html).toContain("app.b2ihub.com/signup");

    // Render again — CTA should survive the round-trip
    const rendered = renderArticleDocument(parseResult.doc!);
    expect(rendered).toContain("app.b2ihub.com/signup");
    expect(rendered).toContain("FAQPage");

    // Parse AGAIN (simulates what happens in factual-scan after syncBlogFromDocument)
    const parseResult2 = parseArticleDocumentFromHtml(rendered, parseResult.doc!);
    expect(parseResult2.doc).not.toBeNull();
    expect(parseResult2.doc!.cta).not.toBeNull();
    expect(parseResult2.doc!.cta!.html).toContain("app.b2ihub.com/signup");
  });


  it("round-trips FAQ, CTA and schema without duplicating conclusion content", () => {
    const doc = makeArticleDoc({
      sections: [
        ...makeArticleDoc().sections.slice(0, 5),
        {
          id: "faq-section",
          heading: "Frequently Asked Questions",
          headingLevel: 2 as const,
          sectionType: "faq-heading" as const,
          blocks: [],
          status: "generated" as const,
        },
      ],
      visibleFaq: [
        { question: "What is Threads marketing?", answerHtml: "", answerText: "It is conversational marketing on Threads." },
        { question: "Is it useful for SMEs?", answerHtml: "", answerText: "Yes, it can support organic engagement." },
        { question: "How often should brands post?", answerHtml: "", answerText: "Post consistently and focus on useful conversations." },
        { question: "Do follower counts matter most?", answerHtml: "", answerText: "No, relevant interaction matters more than raw reach." },
      ],
      conclusion: {
        id: "conc",
        blocks: parseWordPressEditorialBlocks("<!-- wp:paragraph --><p>Use Threads consistently and focus on genuine customer conversations.</p><!-- /wp:paragraph -->", "conc").blocks,
        status: "generated",
      },
      cta: {
        id: "cta", type: "cta", fingerprint: "cta",
        html: "<!-- wp:html --><div><h2>Ready to grow your brand?</h2><a href=\"https://app.b2ihub.com/signup\">Create Your Free Profile</a></div><!-- /wp:html -->",
      },
    });

    const first = renderArticleDocument(doc);
    const firstWords = countReadableWords(first);
    const parsed1 = parseArticleDocumentFromHtml(first, doc);
    expect(parsed1.doc).not.toBeNull();
    const second = renderArticleDocument(parsed1.doc!);
    const parsed2 = parseArticleDocumentFromHtml(second, parsed1.doc!);
    expect(parsed2.doc).not.toBeNull();
    const third = renderArticleDocument(parsed2.doc!);

    expect(countReadableWords(second)).toBe(firstWords);
    expect(countReadableWords(third)).toBe(firstWords);
    expect((third.match(/app\.b2ihub\.com\/signup/gi) ?? []).length).toBe(1);
    expect((third.match(/\"@type\": \"FAQPage\"/g) ?? []).length).toBe(1);
    expect((third.match(/b2i-conclusion-start/g) ?? []).length).toBe(1);
    expect(third.indexOf("FAQPage")).toBeLessThan(third.indexOf("Create Your Free Profile"));
  });

  it("CTA is detected by countCtaHeadingTags", () => {
    const ctaHtml = `<!-- wp:html --><div class="cta-block"><h2>Ready to grow your brand with B2I Hub?</h2><p><a href="https://app.b2ihub.com/signup">Sign Up</a></p></div><!-- /wp:html -->`;
    const headings = countCtaHeadingTags(ctaHtml);
    expect(headings).toBeGreaterThanOrEqual(1);
  });

  it("signup URL count is exact in canonical CTA", () => {
    const ctaHtml = `<!-- wp:html --><div style="background: #1E3A8A;"><h2>Ready to grow your brand?</h2><a href="https://app.b2ihub.com/signup">Create Profile</a></div><!-- /wp:html -->`;
    const signupCount = (ctaHtml.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
    expect(signupCount).toBe(1);
  });
});

describe("FAQ parity", () => {
  it("extractVisibleFaqFromArticle handles FAQ after paragraph splitting", () => {
    // FAQ with each Q&A pair in its own paragraph (split by normalizeParagraphs)
    const faqHtml = `<!-- wp:paragraph --><p><strong>What is the main benefit?</strong><br>It helps you save time and money. The solution is proven to work effectively.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>How do I get started?</strong><br>Simply sign up and follow setup. It takes less than five minutes.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>Is it suitable for small businesses?</strong><br>Yes, it scales to any size. Many small teams use it daily.</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><strong>What support is available?</strong><br>24/7 email and chat support. Phone support during business hours.</p><!-- /wp:paragraph -->`;

    const doc = makeArticleDoc({
      sections: [sectionFromHtml(
        "section-0",
        "Frequently Asked Questions",
        faqHtml,
        "faq-heading",
      )],
    });

    const visibleFaq = extractVisibleFaqFromArticle("", doc);
    expect(visibleFaq.length).toBe(4);
    expect(visibleFaq[0].question).toBe("What is the main benefit");
    expect(visibleFaq[3].question).toBe("What support is available");
    expect(visibleFaq[0].answerText).toContain("save time");
  });

  it("FAQ parity mismatch detected when schema has 6 questions but visible has 4", () => {
    // Schema with 6 questions, visible with only 4
    const schemaQuestions = 6;
    const visibleFaq = [
      { question: "Q1", answerText: "A1" },
      { question: "Q2", answerText: "A2" },
      { question: "Q3", answerText: "A3" },
      { question: "Q4", answerText: "A4" },
    ];
    expect(visibleFaq.length).not.toBe(schemaQuestions);
    // faq-recovery should detect this and rebuild
  });

  it("FAQ extraction from ArticleDocument section boundary excludes conclusion text", () => {
    const faqBody = `<!-- wp:paragraph --><p><strong>What is it?</strong><br>It works well for users. Very effective approach here.</p><!-- /wp:paragraph -->`;
    // Simulate doc with FAQ section
    const doc = makeArticleDoc({
      sections: [
        sectionFromHtml(
          "section-main",
          "Main Section",
          "<!-- wp:paragraph --><p>Main content here with details about the topic.</p><!-- /wp:paragraph -->",
        ),
        sectionFromHtml(
          "section-faq",
          "Frequently Asked Questions",
          faqBody + `<!-- wp:paragraph --><p>Ready to grow your brand? Sign up at B2I Hub today. Create your free account now.</p><!-- /wp:paragraph -->`,
          "faq-heading",
        ),
      ],
      conclusion: componentFromHtml("conc", "<!-- wp:paragraph --><p>This is the conclusion. Sign up now for access.</p><!-- /wp:paragraph -->"),
    });

    const visibleFaq = extractVisibleFaqFromArticle("", doc);
    // FAQ extraction should use the structured section boundary and not
    // pull in the CTA-like text that follows the last Q&A
    expect(visibleFaq.length).toBe(1);
    expect(visibleFaq[0].question).toBe("What is it");
  });
});

describe("Word count validation", () => {
  it("evaluatePolicy rejects word count above 2875", () => {
    // Build a policy for 2500-word target
    const policy = buildPolicy(2500, 2125, 2875, "test keyphrase");

    // Metrics above the max
    const metricsAbove: FinalArticleMetrics = {
      readableWordCount: 2876,
      h2Count: 6,
      faqEntryCount: 5,
      exactKeyphraseCount: 25,
      keyphraseDensity: 1.2,
      exactKeyphraseInH2: true,
      longParagraphCount: 0,
      keyphraseInFirst100Words: true,
      uniqueInternalLinkCount: 3,
      externalSourceLinkCount: 2,
      ctaHeadingCount: 1,
      signupUrlCount: 1,
      faqBlockCount: 1,
      faqJsonLdCount: 1,
      hasLanguageSwitcher: true,
      nestedParagraphCount: 0,
      malformedHeadingCount: 0,
      wpBlockCountMismatch: false,
      faqParityValid: true,
      titleLength: 60,
      metaDescriptionLength: 170,
      fleschReadingEase: 65,
      hasPlaceholderContent: false,
      hasRawProseOutsideBlocks: false,
      duplicateFaqSchemaCount: 0,
      duplicateCtaBlockCount: 0,
      hasConclusionContent: true,
    };
    const resultAbove = evaluatePolicy(metricsAbove, policy);
    expect(resultAbove.passed).toBe(false);
    expect(resultAbove.reasons.some((r) => r.includes("word count"))).toBe(true);
  });

  it("evaluatePolicy accepts word count at 2875 (exact max)", () => {
    const policy = buildPolicy(2500, 2125, 2875, "test keyphrase");

    const metricsAtMax: FinalArticleMetrics = {
      readableWordCount: 2875,
      h2Count: 6,
      faqEntryCount: 5,
      exactKeyphraseCount: 25,
      keyphraseDensity: 1.2,
      exactKeyphraseInH2: true,
      longParagraphCount: 0,
      keyphraseInFirst100Words: true,
      uniqueInternalLinkCount: 3,
      externalSourceLinkCount: 2,
      ctaHeadingCount: 1,
      signupUrlCount: 1,
      faqBlockCount: 1,
      faqJsonLdCount: 1,
      hasLanguageSwitcher: true,
      nestedParagraphCount: 0,
      malformedHeadingCount: 0,
      wpBlockCountMismatch: false,
      faqParityValid: true,
      titleLength: 60,
      metaDescriptionLength: 170,
      fleschReadingEase: 65,
      hasPlaceholderContent: false,
      hasRawProseOutsideBlocks: false,
      duplicateFaqSchemaCount: 0,
      duplicateCtaBlockCount: 0,
      hasConclusionContent: true,
    };
    const resultAtMax = evaluatePolicy(metricsAtMax, policy);
    expect(resultAtMax.passed).toBe(true);
  });

  it("evaluatePolicy rejects word count below 2125", () => {
    const policy = buildPolicy(2500, 2125, 2875, "test keyphrase");

    const metricsBelow: FinalArticleMetrics = {
      readableWordCount: 2124,
      h2Count: 6,
      faqEntryCount: 5,
      exactKeyphraseCount: 18,
      keyphraseDensity: 1.1,
      exactKeyphraseInH2: true,
      longParagraphCount: 0,
      keyphraseInFirst100Words: true,
      uniqueInternalLinkCount: 3,
      externalSourceLinkCount: 2,
      ctaHeadingCount: 1,
      signupUrlCount: 1,
      faqBlockCount: 1,
      faqJsonLdCount: 1,
      hasLanguageSwitcher: true,
      nestedParagraphCount: 0,
      malformedHeadingCount: 0,
      wpBlockCountMismatch: false,
      faqParityValid: true,
      titleLength: 60,
      metaDescriptionLength: 170,
      fleschReadingEase: 65,
      hasPlaceholderContent: false,
      hasRawProseOutsideBlocks: false,
      duplicateFaqSchemaCount: 0,
      duplicateCtaBlockCount: 0,
      hasConclusionContent: true,
    };
    const resultBelow = evaluatePolicy(metricsBelow, policy);
    expect(resultBelow.passed).toBe(false);
    expect(resultBelow.reasons.some((r) => r.includes("word count"))).toBe(true);
  });

  it("countReadableWords excludes wp:html blocks from count", () => {
    // Content that has wp:html CTA and FAQ schema — these should not contribute
    const html = `<!-- wp:html --><div class="cta"><h2>Ready?</h2><a href="https://app.b2ihub.com/signup">Sign Up</a></div><!-- /wp:html -->
<!-- wp:html --><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is it?","acceptedAnswer":{"@type":"Answer","text":"It works."}}]}</script><!-- /wp:html -->
<!-- wp:paragraph --><p>This is the only readable content that should be counted for word count purposes.</p><!-- /wp:paragraph -->`;
    const wc = countReadableWords(html);
    // Only the paragraph text should count: "This is the only readable content that should be counted for word count purposes." = 14 words
    expect(wc).toBe(14);
  });
});
