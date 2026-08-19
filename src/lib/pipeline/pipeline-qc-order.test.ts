import { afterEach, describe, expect, it } from "vitest";
import type { ArticleDocument, ArticleSection } from "@/lib/blog/article-document";
import {
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import { findRepetitionPairTargets } from "@/lib/pipeline/editorial-polish";
import {
  createPipelineState,
  runPostAssemblyPipeline,
  runFinalValidation,
} from "@/lib/pipeline/blog-generation-pipeline";
import { analyzeFinalArticle, buildPolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";

afterEach(() => {
  delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
  delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
});

const KEYPHRASE = "threads marketing hong kong";
const AGREEMENT_BLOCK = "section:section-0:section-0-wp-0";
const BASELINE = "Social media offers a direct line to your customers. They offer unprecedented reach and engagement opportunities if used correctly.";
const REPAIRED = "Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly.";

const paragraph = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
function component(id: string, html: string): ArticleDocument["introduction"] {
  return { id, blocks: parseWordPressEditorialBlocks(html, id).blocks, status: "generated" };
}
function section(id: string, heading: string, html: string, sectionType: ArticleSection["sectionType"] = "main"): ArticleSection {
  return { ...component(id, html), heading, headingLevel: 2, sectionType };
}

// Clean, non-repetitive 500-word article that passes the full post-assembly
// pipeline with zero deterministic repetition pairs (so the final-document
// editor succeeds rather than overflowing on repetition findings).
const S0 = [
  "Local brands can build a loyal audience through honest daily replies.",
  "Threads users appreciate accounts that answer questions within an hour.",
  "A consistent marketing voice helps Hong Kong stores stay memorable.",
  "Short weekly videos earn more attention than a long polished post.",
  "Follower questions reveal which product topics deserve a full thread.",
  "Small brands can post twice weekly without hiring any extra marketing staff.",
  "Threads works best when the account speaks in a consistent and friendly voice.",
  "Local brands who answer quickly build a noticeable reputation in the feed.",
  "A weekly thread strategy reduces guesswork and keeps the content calendar full.",
];
const S1 = [
  "Clear audience research tells the owner which district to serve first.",
  "People who visit the shop often follow the brand for practical tips.",
  "A short survey reveals the exact topics that make readers reply.",
  "Understanding customer needs reduces wasted effort on the wrong offers.",
  "Reaching the right people depends on listening more than broadcasting.",
  "Survey replies help the owner understand which product news people value.",
  "Demographic data shows the age range that visits the shop most often.",
  "Regular buyers describe their habits clearly in a short anonymous survey.",
  "Understanding follower needs prevents wasted effort on irrelevant promotions.",
];
const S2 = [
  "A simple weekly routine keeps posting consistent all month long.",
  "Owners can draft three thread ideas during a quiet Monday morning.",
  "Content that answers real questions earns shares without paid ads.",
  "Scheduling posts in advance protects the routine during busy weeks.",
  "Measuring replies each Friday shows which routine steps actually work.",
  "Monday posts can recap the weekend with one useful takeaway for readers.",
  "Wednesday threads invite customers to share their favourite product memory.",
  "Friday content previews the weekend menu with a clear call to action.",
  "A fixed posting hour lets followers know exactly when fresh content appears.",
];

function buildDoc(withDefect: boolean): ArticleDocument {
  const para3 = (arr: string[], i: number) => paragraph(`${arr[i]} ${arr[i + 1]} ${arr[i + 2]}`);
  const introHtml = paragraph(`Opening guide to ${KEYPHRASE} gives local owners a clear place to start. ${S0[0]} ${S1[0]} ${S2[0]}`);
  const sections = [
    section("section-0", "Threads Marketing Hong Kong for Small Local Brands", [para3(S0, 0), para3(S0, 3), para3(S0, 6)].join("\n\n")),
    section("section-1", "Understand the People You Want to Reach", [para3(S1, 0), para3(S1, 3), para3(S1, 6)].join("\n\n")),
    section("section-2", "Build a Simple Weekly Content Routine", [para3(S2, 0), para3(S2, 3), para3(S2, 6)].join("\n\n")),
  ];
  sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
  const conclusionHtml = paragraph(`A useful ${KEYPHRASE} plan needs steady effort rather than a large budget. Consistency builds trust with followers who return each week. Review the results monthly and adjust the routine with care.`);
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
    introduction: component("intro", introHtml),
    sections,
    visibleFaq: [
      { question: "How should an SME start? ", answerHtml: "", answerText: "Begin with one clear audience and a simple posting routine. Reply to every genuine question in the feed before the day ends." },
      { question: "How often should I post? ", answerHtml: "", answerText: "Twice a week keeps the account visible without straining a small team. A fixed posting hour helps followers know when to check for news." },
      { question: "What should I measure? ", answerHtml: "", answerText: "Track replies, profile visits and saves each week. Review which topics earn genuine conversation instead of counting likes alone." },
    ],
    conclusion: component("conclusion", conclusionHtml),
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  if (withDefect) {
    doc.sections[0].blocks[0] = { id: "section-0-wp-0", type: "paragraph", content: [{ type: "text", text: BASELINE }] };
  }
  return doc;
}

function makeState(doc: ArticleDocument) {
  const { min: wordMin, max: wordMax } = englishWordTolerance(500);
  return createPipelineState({
    userId: "u",
    projectId: "qc-order",
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
}

function editorAi(label: string): string {
  switch (label) {
    case "final-document-diagnosis":
      return JSON.stringify({ findings: [
        { findingId: "agree-1", category: "pronoun-agreement", severity: "high", publishability: "blocking", blockIds: [AGREEMENT_BLOCK], message: "They cannot refer to singular Social media.", evidenceIds: [], brandRuleIds: [], confidence: 0.97 },
      ] });
    case "final-document-patch":
      return JSON.stringify({ edits: [{ blockId: AGREEMENT_BLOCK, replacementHtml: paragraph(REPAIRED), reason: "Fix agreement." }] });
    case "final-document-acceptance":
      return JSON.stringify({ decisions: [{ blockId: AGREEMENT_BLOCK, decision: "accept", reasonCodes: [] }] });
    case "final-document-verification":
      return JSON.stringify({ resolved: [{ findingId: "agree-1", resolved: true }], newBlockingFindings: [] });
    default:
      throw new Error("Unexpected AI call: " + label);
  }
}

describe("Stage 3Q: final-document-editorial precedes the authoritative final QC", () => {
  it("the repair changes the fingerprint and final QC sees the post-repair version, matched by validation and persistence", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = buildDoc(true);
    // Precondition: this doc has no deterministic repetition, so the editor can
    // focus on the agreement finding rather than overflowing on repetition.
    expect(findRepetitionPairTargets(doc).length).toBe(0);

    const result = await runPostAssemblyPipeline(makeState(doc), {
      chatWithRetry: async (_m: unknown[], _o: unknown, label?: string) => ({ content: editorAi(label ?? "") }),
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [] },
    });
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;

    const stages = result.stageOutputs.map((output) => output.stage);
    const editorIndex = stages.indexOf("final-document-editorial");
    const qcIndex = stages.indexOf("final-qc-scan");
    const saveAssertIndex = stages.indexOf("editorial-h2-save-assert");
    const validationIndex = stages.indexOf("final-validation");

    // final-document-editorial precedes final-qc-scan.
    expect(editorIndex).toBeGreaterThanOrEqual(0);
    expect(editorIndex).toBeLessThan(qcIndex);
    // final-qc-scan precedes the validation-only gates.
    expect(qcIndex).toBeLessThan(saveAssertIndex);
    expect(saveAssertIndex).toBeLessThan(validationIndex);

    const editor = result.stageOutputs[editorIndex];
    const qc = result.stageOutputs[qcIndex];
    const saveAssert = result.stageOutputs[saveAssertIndex];
    const validation = result.stageOutputs[validationIndex];

    // An accepted repair changed the canonical ArticleDocument fingerprint.
    expect(editor.inputFingerprint).not.toBe(editor.outputFingerprint);
    // The authoritative final QC receives that exact changed fingerprint.
    expect(qc.inputFingerprint).toBe(editor.outputFingerprint);
    // final validation (and persistence) receive the same validated fingerprint.
    expect(saveAssert.inputFingerprint).toBe(qc.outputFingerprint);
    expect(validation.inputFingerprint).toBe(qc.outputFingerprint);

    // The repaired candidate (and only it) reaches QC and persistence.
    expect(result.blog).toContain("It offers unprecedented reach");
    expect(result.blog).not.toContain("They offer");
    // The exact regression: the authoritative final QC scanned "It offers".
    expect(renderArticleDocument(result.articleDoc)).toContain("It offers unprecedented reach");
    expect(renderArticleDocument(result.articleDoc)).not.toContain("They offer");

    // Final validation passes on the exact committed candidate.
    expect(runFinalValidation(result).passed).toBe(true);
    // Every stage after final-qc-scan is validation-only (stable fingerprint).
    for (const output of result.stageOutputs.slice(qcIndex + 1)) {
      expect(output.inputFingerprint, `stage ${output.stage}`).toBe(output.outputFingerprint);
    }
  });

  it("when the editor makes no changes, final QC sees the unchanged canonical fingerprint", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = buildDoc(false);
    const result = await runPostAssemblyPipeline(makeState(doc), {
      chatWithRetry: async () => ({ content: '{"findings":[]}' }),
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [] },
    });
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;

    const stages = result.stageOutputs.map((output) => output.stage);
    const editor = result.stageOutputs[stages.indexOf("final-document-editorial")];
    const qc = result.stageOutputs[stages.indexOf("final-qc-scan")];
    expect(editor.inputFingerprint).toBe(editor.outputFingerprint);
    expect(qc.inputFingerprint).toBe(editor.outputFingerprint);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
    expect(runFinalValidation(result).passed).toBe(true);
  });

  it("when the editor fails closed, no mutated candidate reaches QC or persistence", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = buildDoc(true);
    const run = () => runPostAssemblyPipeline(makeState(doc), {
      chatWithRetry: async (_m: unknown[], _o: unknown, label?: string) => {
        const response = editorAi(label ?? "");
        if (label === "final-document-verification") {
          return { content: JSON.stringify({ resolved: [{ findingId: "agree-1", resolved: false }], newBlockingFindings: [] }) };
        }
        return { content: response };
      },
      makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
      telemetry: {},
      context: { research: [] },
    });
    await expect(run()).rejects.toThrow(/Final-document editorial acceptance failed/);
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
  });
});
