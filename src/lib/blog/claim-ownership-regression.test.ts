import { describe, expect, it } from "vitest";
import {
  type ArticleDocument,
  type EditorialBlock,
  renderComponentHtml,
  renderArticleDocument,
  renderFaqSchema,
  parseArticleDocumentFromHtml,
} from "@/lib/blog/article-document";
import {
  buildClaimOwnershipLedger,
  collectOwnershipOccurrences,
  enforceOwnershipAndVerify,
  validateClaimOwnership,
  type ClaimOwnershipLedger,
} from "./claim-ownership";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { assertRenderedCacheMatchesDocument, runFinalValidation } from "@/lib/pipeline/blog-generation-pipeline";
import { createPipelineState } from "@/lib/pipeline/blog-generation-pipeline";
import { englishWordTolerance } from "@/lib/content-standards";
import {
  analyzeCanonicalEnglishCta,
  CANONICAL_ENGLISH_CTA_FINGERPRINT,
  CANONICAL_ENGLISH_CTA_HTML,
} from "@/lib/blog/canonical-cta";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { validateFaqParity, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";

const KEYPHRASE = "threads marketing hong kong";
const RESEARCH = [
  {
    title: "Hong Kong Threads audience",
    snippet: "Threads has 2.4 million monthly active users in Hong Kong.",
    url: "https://example.com/audience",
  },
  {
    title: "Threads market awareness growth",
    snippet: "Awareness rose from 36% in 2023 to 66% in 2025 among surveyed Hong Kong respondents.",
    url: "https://example.com/awareness",
  },
];

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function linkedParagraph(id: string, pre: string, href: string, post: string): EditorialBlock {
  return {
    id,
    type: "paragraph",
    content: [
      { type: "text", text: pre },
      { type: "link", text: "source", href, sourceType: "editorial-external" },
      { type: "text", text: post },
    ],
  };
}

function makeDocument(): ArticleDocument {
  return {
    metadata: {
      title: "Threads Marketing Hong Kong Guide",
      slug: "threads-marketing-hong-kong",
      metaDescription: "A practical guide.",
      excerpt: "A practical guide.",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: {
      id: "ls",
      type: "language-switcher",
      html: '<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-zh">繁體中文</a></div><!-- /wp:html -->',
      fingerprint: "ls",
    },
    introduction: {
      id: "intro",
      status: "generated",
      blocks: [
        paragraph(
          "intro-claim",
          "Threads has 2.4 million monthly active users in Hong Kong. This guide explains how a small team can join useful conversations.",
        ),
        paragraph(
          "intro-2",
          "Start small, stay consistent, and measure the replies that come back to you.",
        ),
      ],
    },
    sections: [
      {
        id: "section-0",
        heading: "Who Uses Threads in Hong Kong",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          linkedParagraph(
            "audience-owned",
            "According to the audience study, Threads has 2.4 million monthly active users in Hong Kong (",
            RESEARCH[0].url,
            ").",
          ),
          paragraph(
            "audience-duplicate",
            "Threads has 2.4 million monthly active users in Hong Kong. That audience gives local teams room to test focused conversations.",
          ),
        ],
      },
      {
        id: "section-1",
        heading: "Market Growth and Awareness",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph(
            "growth-owned",
            "Among surveyed Hong Kong respondents, awareness rose from 36% in 2023 to 66% in 2025.",
          ),
        ],
      },
      {
        id: "faq",
        heading: "Frequently Asked Questions",
        headingLevel: 2,
        sectionType: "faq-heading",
        status: "generated",
        blocks: [],
      },
    ],
    visibleFaq: [
      {
        question: "How many users does Threads have in Hong Kong?",
        answerHtml: "<p>Threads has 2.4 million monthly active users in Hong Kong as of the latest figures.</p>",
        answerText: "Threads has 2.4 million monthly active users in Hong Kong as of the latest figures.",
      },
      {
        question: "How should a local team start?",
        answerHtml: "",
        answerText: "Start with one useful topic and improve it from real replies.",
      },
    ],
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: [
        paragraph(
          "conclusion-copy",
          "Start with one useful topic and improve it from real replies.",
        ),
        paragraph(
          "conclusion-claim",
          "Awareness rose from 36% in 2023 to 66% in 2025 among surveyed respondents.",
        ),
      ],
    },
    cta: {
      id: "cta",
      type: "cta",
      html: CANONICAL_ENGLISH_CTA_HTML,
      fingerprint: CANONICAL_ENGLISH_CTA_FINGERPRINT,
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema([
        {
          question: "How many users does Threads have in Hong Kong?",
          answerHtml: "",
          answerText: "Threads has 2.4 million monthly active users in Hong Kong as of the latest figures.",
        },
        {
          question: "How should a local team start?",
          answerHtml: "",
          answerText: "Start with one useful topic and improve it from real replies.",
        },
      ]),
      fingerprint: "schema",
    },
    insertedLinks: [],
  };
}

function buildLedger(doc: ArticleDocument): ClaimOwnershipLedger {
  return buildClaimOwnershipLedger(doc.sections, RESEARCH);
}

describe("claim-ownership enforcement/validation unification", () => {
  it("returns zero violations from the same canonical document after enforcement", () => {
    const doc = makeDocument();
    const ledger = buildLedger(doc);
    const before = validateClaimOwnership(doc, ledger, KEYPHRASE, RESEARCH);
    expect(before.some((v) => v.componentKind === "introduction")).toBe(true);
    expect(before.some((v) => v.componentKind === "conclusion")).toBe(true);
    expect(before.some((v) => v.componentKind === "faq")).toBe(true);
    expect(before.some((v) => v.reason === "duplicate-owned-occurrence")).toBe(true);

    const verified = enforceOwnershipAndVerify(doc, ledger, KEYPHRASE, RESEARCH);
    expect(verified.violations).toEqual([]);
    expect(validateClaimOwnership(verified.doc, ledger, KEYPHRASE, RESEARCH)).toEqual([]);

    // The same canonical document rendered → parse → rescanned by the final
    // gate metric also yields zero.
    const metrics = analyzeFinalArticle(
      renderArticleDocument(verified.doc),
      KEYPHRASE,
      verified.doc.metadata.title,
      verified.doc.metadata.metaDescription,
      2500,
      undefined,
      { articleDoc: verified.doc, research: RESEARCH, claimOwnership: ledger },
    );
    expect(metrics.claimOwnershipViolationCount).toBe(0);
  });

  it("detects violations in the introduction, sections, conclusion and FAQ with full location detail", () => {
    const doc = makeDocument();
    const ledger = buildLedger(doc);
    const violations = validateClaimOwnership(doc, ledger, KEYPHRASE, RESEARCH);

    const intro = violations.find((v) => v.componentKind === "introduction");
    expect(intro).toBeTruthy();
    expect(intro!.componentId).toBe("intro");
    expect(intro!.reason).toBe("outside-owner");
    expect(intro!.blockId).toBe("intro-claim");
    expect(intro!.ownerSectionId).toBe("section-0");
    expect(intro!.snippet.length).toBeGreaterThan(0);

    const conclusion = violations.find((v) => v.componentKind === "conclusion");
    expect(conclusion).toBeTruthy();
    expect(conclusion!.componentId).toBe("conclusion");

    const faq = violations.find((v) => v.componentKind === "faq");
    expect(faq).toBeTruthy();
    expect(faq!.componentId).toBe("faq-0");
    expect(faq!.reason).toBe("outside-owner");

    const duplicate = violations.find((v) => v.reason === "duplicate-owned-occurrence");
    expect(duplicate).toBeTruthy();
    expect(duplicate!.componentKind).toBe("section");
  });

  it("removes the non-owner duplicate while the canonical owner stays byte-for-byte unchanged", () => {
    const doc = makeDocument();
    const ledger = buildLedger(doc);
    const ownerBlockBefore = renderComponentHtml({
      id: "section-0",
      blocks: [doc.sections[0].blocks[0]],
      status: doc.sections[0].status,
    });

    const verified = enforceOwnershipAndVerify(doc, ledger, KEYPHRASE, RESEARCH);

    const ownerBlockAfter = renderComponentHtml({
      id: "section-0",
      blocks: [verified.doc.sections[0].blocks[0]],
      status: verified.doc.sections[0].status,
    });
    expect(ownerBlockAfter).toBe(ownerBlockBefore);
    expect(ownerBlockAfter).toContain(RESEARCH[0].url);

    const section0Text = renderComponentHtml(verified.doc.sections[0]);
    expect((section0Text.match(/2\.4 million/g) ?? []).length).toBe(1);
    expect(renderComponentHtml(verified.doc.introduction)).not.toContain("2.4 million");
    expect(renderComponentHtml(verified.doc.conclusion)).not.toContain("36% in 2023");
  });

  it("stale rendered HTML cannot cause disagreement (canonical cache is asserted)", () => {
    const doc = makeDocument();
    const ledger = buildLedger(doc);
    const verified = enforceOwnershipAndVerify(doc, ledger, KEYPHRASE, RESEARCH);

    const rendered = renderArticleDocument(verified.doc);
    const parsed = parseArticleDocumentFromHtml(rendered, verified.doc);
    expect(parsed.doc).toBeTruthy();
    expect(validateClaimOwnership(parsed.doc!, ledger, KEYPHRASE, RESEARCH)).toEqual([]);

    // A stale rendered cache must be rejected by the pipeline's canonical check.
    const state = createPipelineState({
      userId: "u",
      projectId: "p",
      keyphrase: KEYPHRASE,
      requestedWordCount: 2500,
      articleDoc: verified.doc,
      h2Headings: verified.doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500),
      ctx: { research: RESEARCH, claimOwnership: ledger },
      wordMin: 2125,
      wordMax: 2875,
      systemPrompt: "test",
      userMessage: "test",
    });
    state.blog = rendered + "<!-- stale -->";
    expect(() => assertRenderedCacheMatchesDocument(state)).toThrow(/rendered cache diverged/);
  });

  it("does not alter CTA, links or WordPress structure and keeps FAQ/schema parity during enforcement", () => {
    const doc = makeDocument();
    const ledger = buildLedger(doc);
    const ctaHtmlBefore = doc.cta!.html;
    const switcherHtmlBefore = doc.languageSwitcher!.html;
    const faqTextBefore = doc.visibleFaq.map((entry) => `${entry.question}|${entry.answerText}`);

    const verified = enforceOwnershipAndVerify(doc, ledger, KEYPHRASE, RESEARCH);

    expect(verified.doc.cta!.html).toBe(ctaHtmlBefore);
    expect(verified.doc.languageSwitcher!.html).toBe(switcherHtmlBefore);

    // FAQ questions and unrelated answers stay; only claim sentences are removed.
    expect(verified.doc.visibleFaq[1].answerText).toBe(faqTextBefore[1].split("|")[1]);
    expect(verified.doc.visibleFaq[0].answerText).not.toContain("2.4 million");

    const rendered = renderArticleDocument(verified.doc);
    expect(validateWordpressBlockPairs(rendered).valid).toBe(true);
    const cta = analyzeCanonicalEnglishCta(rendered);
    expect(cta.valid, cta.issues.join("; ")).toBe(true);
    // The FAQPage schema is re-derived from the corrected canonical FAQ so the
    // visible FAQ and the schema stay in parity.
    const schemaHtml = extractFaqBlock(rendered);
    const parity = validateFaqParity(
      extractVisibleFaqFromArticle(rendered, verified.doc).map((e) => ({
        question: e.question,
        answerHtml: "",
        answerText: e.answerText,
      })),
      schemaHtml,
    );
    expect(parity.valid, parity.issues.map((i) => i.type).join("; ")).toBe(true);
    expect(schemaHtml).toContain(verified.doc.visibleFaq[0].answerText);
    expect(schemaHtml).not.toContain("2.4 million");
  });

  it("unresolved ownership violations still block final acceptance", () => {
    const doc = makeDocument();
    const ledger = buildLedger(doc);
    // Make the FAQ violation unrepairable: put the claim in the question text.
    doc.visibleFaq[0] = {
      question: "Threads has 2.4 million monthly active users in Hong Kong, so how many is that?",
      answerHtml: "",
      answerText: "The audience is large and growing steadily.",
    };
    const verified = enforceOwnershipAndVerify(doc, ledger, KEYPHRASE, RESEARCH);
    expect(verified.violations.length).toBeGreaterThan(0);

    const range = englishWordTolerance(2500);
    const state = createPipelineState({
      userId: "u",
      projectId: "p",
      keyphrase: KEYPHRASE,
      requestedWordCount: 2500,
      articleDoc: verified.doc,
      h2Headings: verified.doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 350,
      exactKeyphraseTarget: 9,
      policy: buildPolicy(2500, range.min, range.max, KEYPHRASE),
      ctx: { research: RESEARCH, claimOwnership: ledger },
      wordMin: range.min,
      wordMax: range.max,
      systemPrompt: "test",
      userMessage: "test",
    });
    state.blog = renderArticleDocument(verified.doc);
    const validation = runFinalValidation(state);
    expect(validation.passed).toBe(false);
    expect(validation.reasons.some((reason) => reason.includes("claim ownership violations"))).toBe(true);
    const evaluated = evaluatePolicy(
      analyzeFinalArticle(
        state.blog,
        KEYPHRASE,
        state.title,
        state.metaDescription,
        2500,
        undefined,
        { articleDoc: verified.doc, research: RESEARCH, claimOwnership: ledger },
      ),
      state.policy,
    );
    expect(evaluated.passed).toBe(false);
    expect(evaluated.reasons.some((reason) => reason.includes("claim ownership violations"))).toBe(true);
  });

  it("treats the article's own topic year as context, not an owned claim (topic-year articles)", () => {
    const topicKeyphrase = "hong kong marketing trends 2026";
    const topicResearch = [
      {
        title: "Digital and social media trends in Hong Kong in 2026",
        snippet: "Hong Kong marketing trends 2026 are shaped by social commerce and community engagement.",
        url: "https://example.com/2026-trends",
      },
      {
        title: "Spending survey",
        snippet: "78% of surveyed local businesses plan to increase their marketing budget.",
        url: "https://example.com/spending",
      },
    ];
    const doc: ArticleDocument = {
      metadata: {
        title: "Hong Kong Marketing Trends 2026",
        slug: "hong-kong-marketing-trends-2026",
        metaDescription: "The Hong Kong marketing trends 2026 landscape and what it means for local teams.",
        excerpt: "A practical guide.",
        targetWordCount: 2500,
        focusKeyphrase: topicKeyphrase,
      },
      languageSwitcher: null,
      introduction: {
        id: "intro",
        status: "generated",
        blocks: [
          paragraph(
            "intro-1",
            "This guide covers the Hong Kong marketing trends 2026 and how local teams can adapt their plans.",
          ),
        ],
      },
      sections: [
        {
          id: "section-0",
          heading: "The Big Picture: Hong Kong Marketing in 2026",
          headingLevel: 2,
          sectionType: "main",
          status: "generated",
          blocks: [
            paragraph(
              "s0-1",
              "Hong Kong marketing trends 2026 point toward social commerce as the main driver of growth.",
            ),
            paragraph(
              "s0-2",
              "According to the spending survey, 78% of surveyed local businesses plan to increase their marketing budget.",
            ),
          ],
        },
        {
          id: "section-1",
          heading: "Social Commerce in 2026",
          headingLevel: 2,
          sectionType: "main",
          status: "generated",
          blocks: [
            paragraph(
              "s1-1",
              "In 2026, shopping is becoming a social, community-driven experience rather than a one-way transaction.",
            ),
          ],
        },
        {
          id: "faq",
          heading: "Frequently Asked Questions",
          headingLevel: 2,
          sectionType: "faq-heading",
          status: "generated",
          blocks: [],
        },
      ],
      visibleFaq: [
        {
          question: "What is driving the Hong Kong marketing trends 2026?",
          answerHtml: "",
          answerText: "Consumer behaviour shifts and the growing role of digital platforms are the main drivers.",
        },
        {
          question: "What role does data play in Hong Kong marketing trends 2026?",
          answerHtml: "",
          answerText: "Data helps teams plan with a clearer view of what is actually working.",
        },
      ],
      conclusion: {
        id: "conclusion",
        status: "generated",
        blocks: [
          paragraph(
            "conc-1",
            "Hong Kong marketing trends 2026 reward brands that stay human and keep testing.",
          ),
        ],
      },
      cta: null,
      faqSchema: null,
      insertedLinks: [],
    };
    const ledger = buildClaimOwnershipLedger(doc.sections, topicResearch);

    // The topic year in FAQ questions and non-owner sections is not a violation.
    const occurrences = collectOwnershipOccurrences(doc, topicKeyphrase, topicResearch);
    expect(
      occurrences.some(
        (o) => o.componentKind === "faq" && o.claim.category === "date_claim" && o.claim.text.trim() === "2026",
      ),
    ).toBe(false);
    expect(
      occurrences.some((o) => o.componentId === "section-1" && o.claim.category === "date_claim"),
    ).toBe(false);
    // A genuine percentage claim outside its owner IS still an ownership claim.
    expect(occurrences.some((o) => o.claim.category === "percentage" && o.claim.text.includes("78%"))).toBe(true);

    const verified = enforceOwnershipAndVerify(doc, ledger, topicKeyphrase, topicResearch);
    expect(verified.violations).toEqual([]);
    // The topic year stays in the non-owner section and FAQ questions untouched.
    expect(renderComponentHtml(verified.doc.sections[1])).toContain("In 2026,");
    expect(verified.doc.visibleFaq[0].question).toContain("2026");
    expect(validateClaimOwnership(verified.doc, ledger, topicKeyphrase, topicResearch)).toEqual([]);
  });
});
