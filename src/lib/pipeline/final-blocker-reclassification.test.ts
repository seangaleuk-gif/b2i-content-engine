import { afterEach, describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  fingerprintHtml,
} from "@/lib/blog/article-document";
import { findRepetitionPairTargets } from "@/lib/pipeline/editorial-polish";
import {
  runFullDocumentEditorial,
  isBlockingFinding,
} from "@/lib/pipeline/full-document-editorial";
import {
  buildPolicy,
  evaluatePolicy,
  type FinalArticleMetrics,
} from "@/lib/blog/final-article-policy";
import {
  createPipelineState,
  runPostAssemblyPipeline,
  runFinalValidation,
} from "@/lib/pipeline/blog-generation-pipeline";
import { englishWordTolerance } from "@/lib/content-standards";

afterEach(() => {
  delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
  delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
  delete process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS;
  delete process.env.ENABLE_EDITORIAL_POLISH;
});

const KEYPHRASE = "threads marketing hong kong";

function paragraphBlock(id: string, text: string) {
  return { id, type: "paragraph" as const, content: [{ type: "text" as const, text }] };
}

// A small canonical-clean article; callers can inject a verbatim duplicate to
// create a deterministic cross-section-repetition pair.
function cleanDoc(withDuplicate: boolean): ArticleDocument {
  const p = (id: string, text: string) => paragraphBlock(id, text);
  const dup = "Local teams can share useful lessons from daily work with clear and honest words.";
  const section0Blocks = [
    p("section-0-wp-0", `${dup} Simple examples help busy owners understand the idea and take a practical next step.`),
    p("section-0-wp-1", "Regular replies also show customers that a real person is listening to their needs. A small weekly plan keeps the work steady without adding stress to the whole team."),
    p("section-0-wp-2", "Owners can note common questions and turn those questions into helpful future posts. This approach builds trust slowly and gives the business a clear voice in Hong Kong."),
    p("section-0-wp-3", "Survey replies help the owner understand which product news people value. Demographic data shows the age range that visits the shop most often."),
    p("section-0-wp-4", "Twice a week keeps the account visible without straining a small team. A fixed posting hour helps followers know when to check for news."),
    p("section-0-wp-5", "Track replies, profile visits and saves each week. Review which topics earn genuine conversation instead of counting likes alone."),
    ...(withDuplicate ? [p("section-0-wp-6", `${dup} Simple examples help busy owners understand the idea and take a practical next step.`)] : []),
  ];
  const doc: ArticleDocument = {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content, start genuine conversations, measure results, avoid common mistakes, and build steady local trust.",
      excerpt: "A practical guide for Hong Kong SMEs.",
      targetWordCount: 500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/threads-marketing-hong-kong-practical-sme-guide-zh">繁體中文</a></div><!-- /wp:html -->`,
      fingerprint: "language-switcher",
    },
    introduction: { id: "intro", blocks: [p("intro-0", "Opening guide to threads marketing hong kong gives local owners a clear place to start. Regular replies build trust with every customer who returns.")], status: "generated" },
    sections: [{
      id: "section-0",
      heading: "Threads Marketing Hong Kong for Small Local Brands",
      headingLevel: 2,
      sectionType: "main",
      blocks: section0Blocks,
      status: "generated",
    }, {
      id: "section-1",
      heading: "Understand the People You Want to Reach",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        p("section-1-wp-0", "Clear audience research tells the owner which district to serve first. People who visit the shop often follow the brand for practical tips."),
        p("section-1-wp-1", "A short survey reveals the exact topics that make readers reply. Understanding customer needs reduces wasted effort on the wrong offers."),
        p("section-1-wp-2", "Reaching the right people depends on listening more than broadcasting. Regular buyers describe their habits clearly in a short anonymous survey."),
        p("section-1-wp-3", "Monday posts can recap the weekend with one useful takeaway for readers. A fixed posting hour lets followers know exactly when fresh content appears."),
        p("section-1-wp-4", "Wednesday threads invite customers to share their favourite product memory. Friday content previews the weekend menu with a clear call to action."),
        p("section-1-wp-5", "Scheduling posts in advance protects the routine during busy weeks. Measuring replies each Friday shows which routine steps actually work."),
      ],
      status: "generated",
    }, {
      id: "section-2",
      heading: "Build a Simple Weekly Content Routine",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        p("section-2-wp-0", "A simple weekly routine keeps posting consistent all month long. Owners can draft three thread ideas during a quiet Monday morning."),
        p("section-2-wp-1", "Content that answers real questions earns shares without paid ads. A fixed posting hour lets followers know exactly when fresh content appears."),
        p("section-2-wp-2", "Small brands who answer quickly build a noticeable reputation in the feed. A weekly thread strategy reduces guesswork and keeps the calendar full."),
        p("section-2-wp-3", "Staff can gather honest feedback during quiet morning hours and turn it into better service decisions. Consistency matters more than any single clever campaign."),
      ],
      status: "generated",
    }, {
      id: "faq-section",
      heading: "Frequently Asked Questions About Threads Marketing",
      headingLevel: 2,
      sectionType: "faq-heading",
      blocks: [],
      status: "generated",
    }],
    visibleFaq: [
      { question: "How should an SME start? ", answerHtml: "", answerText: "Begin with one clear audience and a simple posting routine. Reply to every genuine question in the feed before the day ends." },
      { question: "How often should I post? ", answerHtml: "", answerText: "Twice a week keeps the account visible without straining a small team. A fixed posting hour helps followers know when to check for news." },
      { question: "What should I measure? ", answerHtml: "", answerText: "Track replies, profile visits and saves each week. Review which topics earn genuine conversation instead of counting likes alone." },
    ],
    conclusion: { id: "conclusion", blocks: [p("conclusion-0", "A useful plan needs steady effort rather than a large budget. Consistency builds trust with followers who return each week.")], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  return doc;
}

// ── 1. Repetition is detected but never blocks ──

describe("final publication blockers: repetition is soft", () => {
  it("deterministic cross-section-repetition findings are detected but classified stylistic", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cleanDoc(true);
    expect(findRepetitionPairTargets(doc).length).toBeGreaterThan(0);

    const outcome = await runFullDocumentEditorial({
      doc,
      keyphrase: KEYPHRASE,
      research: [],
      aiCall: async () => ({ content: '{"findings":[]}' }),
    });
    // Detection preserved: the repetition findings are still reported.
    expect(outcome.findings.some((finding) => finding.category === "cross-section-repetition")).toBe(true);
    expect(outcome.findings.some((finding) => finding.findingId.startsWith("det-repetition-"))).toBe(true);
    // But they are never publication-blocking.
    expect(outcome.blockingCount).toBe(0);
    expect(outcome.selectedUnitIds).toEqual([]);
    expect(outcome.accepted).toBe(true);
    expect(outcome.unresolvedFindingIds).toEqual([]);
    // Baseline retained (no repair was attempted for a soft signal).
    expect(renderArticleDocument(outcome.doc)).toBe(renderArticleDocument(doc));
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
  });

  it("isBlockingFinding is false for deterministic repetition and for exaggerated-claim", () => {
    const repetition = {
      findingId: "det-repetition-1",
      category: "cross-section-repetition" as const,
      severity: "high" as const,
      publishability: "stylistic" as const,
      blockIds: ["section:section-0:section-0-wp-0"],
      message: "Overlap",
      evidenceIds: [],
      brandRuleIds: [],
      confidence: 1,
      source: "deterministic" as const,
    };
    expect(isBlockingFinding(repetition)).toBe(false);
    // Exaggerated claims are owned by factual validation, never editorial.
    const exaggerated = {
      findingId: "m1",
      category: "exaggerated-claim" as const,
      severity: "high" as const,
      publishability: "blocking" as const,
      blockIds: ["section:section-0:section-0-wp-0"],
      message: "Overstated",
      evidenceIds: [],
      brandRuleIds: [],
      confidence: 0.95,
      source: "model" as const,
    };
    expect(isBlockingFinding(exaggerated)).toBe(false);
  });
});

// ── 2. Genuine hard defects still block; unsafe rewrites still rejected ──

describe("final publication blockers: genuine hard defects remain hard", () => {
  it("an unsafe rewrite of a genuine hard defect is rejected and the baseline is retained", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cleanDoc(false);
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await runFullDocumentEditorial({
      doc,
      keyphrase: KEYPHRASE,
      research: [],
      aiCall: async (_m, _o, label) => {
        switch (label) {
          case "final-document-diagnosis":
            return { content: JSON.stringify({ findings: [
              { findingId: "agree-1", category: "pronoun-agreement", severity: "high", publishability: "blocking", blockIds: ["section:section-0:section-0-wp-0"], message: "Agreement defect.", evidenceIds: [], brandRuleIds: [], confidence: 0.97 },
            ] }) };
          case "final-document-patch":
            // Unsafe rewrite: adds an unsupported number.
            return { content: JSON.stringify({ edits: [
              { blockId: "section:section-0:section-0-wp-0", replacementHtml: "<!-- wp:paragraph --><p>Local teams can share 90% more useful lessons with clear and honest words. Simple examples help busy owners understand the idea.</p><!-- /wp:paragraph -->", reason: "Fix agreement." },
            ] }) };
          default:
            throw new Error("Unexpected call: " + label);
        }
      },
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.blockingCount).toBe(1);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
  });
});

// ── 3. Final policy: soft gates never hard-fail; objective gates still do ──

function passingMetrics(overrides: Partial<FinalArticleMetrics> = {}): FinalArticleMetrics {
  return {
    readableWordCount: 2500,
    h2Count: 6,
    faqEntryCount: 4,
    faqBlockCount: 1,
    faqJsonLdCount: 1,
    longParagraphCount: 0,
    keyphraseDensity: 1.5,
    exactKeyphraseInH2: false,
    keyphraseInFirst100Words: true,
    uniqueInternalLinkCount: 2,
    ctaHeadingCount: 1,
    signupUrlCount: 1,
    hasLanguageSwitcher: true,
    wpBlockCountMismatch: false,
    nestedParagraphCount: 0,
    malformedHeadingCount: 0,
    faqParityValid: true,
    hasPlaceholderContent: false,
    hasRawProseOutsideBlocks: false,
    duplicateFaqSchemaCount: 0,
    duplicateCtaBlockCount: 0,
    canonicalCtaValid: true,
    hasConclusionContent: true,
    claimConflictCount: 0,
    malformedProseCount: 0,
    repeatedIdeaPairCount: 0,
    conclusionWordRatio: 0.1,
    conclusionNewNumericClaimCount: 0,
    factualScore: 100,
    editorialScore: 100,
    unsupportedFactualClaimCount: 0,
    claimOwnershipViolationCount: 0,
    staleTemporalClaimCount: 0,
    englishLanguageConsistencyViolationCount: 0,
    coherenceViolationCount: 0,
    boilerplateBlockCount: 0,
    malformedProseBlockCount: 0,
    sentenceQualityViolationCount: 0,
    sourceRelevanceViolationCount: 0,
    unnaturalHeadingCount: 0,
    titleLength: 60,
    keyphraseCount: 10,
    ...overrides,
  } as FinalArticleMetrics;
}

describe("final publication blockers: final-policy severity", () => {
  it("repetition, editorial score, legacy malformed and conclusion share never hard-fail even under enforcement", () => {
    process.env.ENABLE_EDITORIAL_POLISH = "true"; // publicationGate = true
    const policy = buildPolicy(2500, 2125, 2875, KEYPHRASE);
    expect(policy.enforcePublicationQuality).toBe(true);
    const metrics = passingMetrics({
      repeatedIdeaPairCount: 5,
      editorialScore: 40,
      malformedProseCount: 1, // legacy rendered-HTML count (canonical is 0)
      conclusionWordRatio: 0.25,
      roboticPhraseCount: 8,
    });
    const result = evaluatePolicy(metrics, policy);
    expect(result.passed).toBe(true);
    // The signals remain visible as soft diagnostics.
    expect(result.reasons.some((reason) => reason.startsWith("[SOFT] repeated idea pairs"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("[SOFT] editorial score"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("[SOFT] malformed prose issues"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("[SOFT] conclusion share"))).toBe(true);
  });

  it("canonical malformed, sentence quality, unsupported claims and contradictions still hard-fail", () => {
    process.env.ENABLE_EDITORIAL_POLISH = "true";
    const policy = buildPolicy(2500, 2125, 2875, KEYPHRASE);
    expect(evaluatePolicy(passingMetrics({ malformedProseBlockCount: 1 }), policy).passed).toBe(false);
    expect(evaluatePolicy(passingMetrics({ sentenceQualityViolationCount: 1 }), policy).passed).toBe(false);
    expect(evaluatePolicy(passingMetrics({ unsupportedFactualClaimCount: 1 }), policy).passed).toBe(false);
    expect(evaluatePolicy(passingMetrics({ claimConflictCount: 1 }), policy).passed).toBe(false);
    expect(evaluatePolicy(passingMetrics({ coherenceViolationCount: 1 }), policy).passed).toBe(false);
  });
});

// ── 4. Pipeline-level: a repetitive article with the editor enabled passes ──

describe("final publication blockers: pipeline end-to-end", () => {
  it("a repetitive article passes the whole final path; repetition alone never blocks", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS = "true";
    const doc = cleanDoc(true); // contains a verbatim duplicate paragraph
    const { min: wordMin, max: wordMax } = englishWordTolerance(500);
    const state = createPipelineState({
      userId: "u",
      projectId: "blocker-reclassification",
      keyphrase: KEYPHRASE,
      requestedWordCount: 500,
      articleDoc: doc,
      h2Headings: doc.sections.map((s) => s.heading),
      intro: "",
      conclusion: "",
      wordsPerSection: 300,
      exactKeyphraseTarget: 3,
      policy: buildPolicy(500, wordMin, wordMax, KEYPHRASE),
      ctx: { research: [] },
      wordMin,
      wordMax,
      systemPrompt: "test",
      userMessage: "test",
    });
    const result = await runPostAssemblyPipeline(state, {
      chatWithRetry: async () => ({ content: '{"findings":[]}' }),
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [] },
    });
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
    delete process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS;

    const stages = result.stageOutputs.map((output) => output.stage);
    const editor = result.stageOutputs[stages.indexOf("final-document-editorial")];
    const qc = result.stageOutputs[stages.indexOf("final-qc-scan")];
    const validation = result.stageOutputs[stages.indexOf("final-validation")];
    // Repetition was detected by the editor but never blocked.
    expect(editor.accepted).toBe(true);
    expect(editor.inputFingerprint).toBe(editor.outputFingerprint);
    // Final QC and final validation see the same retained fingerprint.
    expect(qc.inputFingerprint).toBe(editor.outputFingerprint);
    expect(validation.inputFingerprint).toBe(qc.outputFingerprint);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
    expect(runFinalValidation(result).passed).toBe(true);
  });
});
