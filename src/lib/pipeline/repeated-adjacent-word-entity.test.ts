import { afterEach, describe, expect, it } from "vitest";
import type { ArticleDocument, ArticleSection } from "@/lib/blog/article-document";
import {
  parseWordPressEditorialBlocks,
  countCanonicalVisibleWords,
} from "@/lib/blog/article-document";
import {
  scanSentenceQualityText,
  scanSentenceQualityInDocument,
  licensedRepeatedWordSpansFromEvidence,
} from "@/lib/blog/sentence-quality";
import { validateProducerCandidate } from "@/lib/blog/producer-content-contract";
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

const PROJECT26_SENTENCE =
  "For Asian-origin packaged goods and Japanese, Korean, or international food and beauty brands, DON DON DONKI stands out as a top retail channel in Hong Kong.";

const RESEARCH: Array<{ title?: string; snippet?: string; url?: string }> = [
  {
    title: "DON DON DONKI expands in Hong Kong",
    snippet:
      "DON DON DONKI operates several stores across the city and is known as a leading retail channel for Asian-origin packaged goods, Japanese and Korean snacks, and international food and beauty brands.",
    url: "https://example.com/don-don-donki-hong-kong",
  },
];

const SPANS = licensedRepeatedWordSpansFromEvidence(RESEARCH);

function hasRepeatedAdjacentWord(sentence: string, spans?: ReadonlySet<string>): boolean {
  return scanSentenceQualityText(sentence, spans ? { licensedRepeatedWordSpans: spans } : undefined)
    .some((issue) => issue.code === "repeated-adjacent-word");
}

// ── 1. Required PASS cases ──

describe("repeated-adjacent-word entity licensing (single authority)", () => {
  it("exact project-26 sentence is licensed with research evidence", () => {
    expect(hasRepeatedAdjacentWord(PROJECT26_SENTENCE, SPANS)).toBe(false);
    // Document-level scanner (same authority as the malformed-repair boundary
    // and final QC) agrees.
    const doc = buildDocWithSentence(PROJECT26_SENTENCE);
    expect(scanSentenceQualityInDocument(doc, { licensedRepeatedWordSpans: SPANS })).toEqual([]);
  });

  it("a repeated entity at the start of a sentence is licensed", () => {
    expect(hasRepeatedAdjacentWord("DON DON DONKI operates stores in Hong Kong.", SPANS)).toBe(false);
  });

  it("a repeated entity appearing mid-sentence is licensed", () => {
    expect(hasRepeatedAdjacentWord("I bought it from DON DON DONKI yesterday.", SPANS)).toBe(false);
  });

  it("a repeated entity ending the sentence is licensed", () => {
    expect(hasRepeatedAdjacentWord("The best prices come from DON DON DONKI.", SPANS)).toBe(false);
  });

  it("a research-supported fictional repeated-token brand is licensed", () => {
    const spans = licensedRepeatedWordSpansFromEvidence([
      { title: "BEE BEE Home opens its first showroom", snippet: "BEE BEE Home sells simple furniture for small apartments.", url: "" },
    ]);
    expect(hasRepeatedAdjacentWord("BEE BEE Home sells simple furniture.", spans)).toBe(false);
    expect(hasRepeatedAdjacentWord("Customers visit BEE BEE Home for budget sofas.", spans)).toBe(false);
  });

  // ── 2. Required FAIL cases (accidental duplicates are never licensed) ──

  it("normal accidental duplicates still fail", () => {
    expect(hasRepeatedAdjacentWord("The the campaign performed well.", SPANS)).toBe(true);
    expect(hasRepeatedAdjacentWord("Customers customers expect fast service.", SPANS)).toBe(true);
    expect(hasRepeatedAdjacentWord("We we should measure results.", SPANS)).toBe(true);
  });

  it("case-normalized duplicates still fail", () => {
    expect(hasRepeatedAdjacentWord("The the campaign and the The rival both failed.", SPANS)).toBe(true);
  });

  it("uppercase non-entity duplication still fails", () => {
    expect(hasRepeatedAdjacentWord("SALE SALE starts tomorrow.", SPANS)).toBe(true);
  });

  it("intensifier duplication still fails without entity evidence", () => {
    expect(hasRepeatedAdjacentWord("very very strong results followed.", SPANS)).toBe(true);
    expect(hasRepeatedAdjacentWord("really really good feedback arrived.", SPANS)).toBe(true);
  });

  it("a repeated-token sequence that is NOT the exact entity span still fails", () => {
    // "DON DON customers" is not the proven entity span "DON DON DONKI".
    expect(hasRepeatedAdjacentWord("DON DON customers return weekly.", SPANS)).toBe(true);
  });

  it("with no research evidence the detector stays strict", () => {
    expect(hasRepeatedAdjacentWord(PROJECT26_SENTENCE)).toBe(true);
    expect(hasRepeatedAdjacentWord("DON DON DONKI operates stores in Hong Kong.")).toBe(true);
  });

  it("the licensed span must come from supplied evidence, not just capitalization", () => {
    // A capitalized repeated pair without evidence is never licensed.
    const empty = new Set<string>();
    expect(hasRepeatedAdjacentWord("DON DON DONKI operates stores in Hong Kong.", empty)).toBe(true);
  });
});

// ── 3. Producer-contract parity ──

describe("repeated-adjacent-word producer-contract parity", () => {
  const paragraph = (text: string) => ({
    id: "section-0-wp-0",
    type: "paragraph" as const,
    content: [{ type: "text" as const, text }],
  });

  it("the producer contract licenses the project-26 entity when evidence is supplied", () => {
    const result = validateProducerCandidate(
      { blocks: [paragraph(PROJECT26_SENTENCE)] },
      {
        componentId: "section-0",
        componentType: "section",
        keyphrase: "don don donki hong kong retail",
        licensedRepeatedWordSpans: SPANS,
      },
    );
    expect(result.violations.some((violation) => violation.code === "repeated-adjacent-word")).toBe(false);
  });

  it("the producer contract still fails genuine duplicates with evidence supplied", () => {
    const result = validateProducerCandidate(
      { blocks: [paragraph("The the campaign performed well.")] },
      {
        componentId: "section-0",
        componentType: "section",
        keyphrase: "retail campaign",
        licensedRepeatedWordSpans: SPANS,
      },
    );
    expect(result.violations.some((violation) => violation.code === "repeated-adjacent-word")).toBe(true);
  });

  it("the producer contract stays strict without evidence", () => {
    const result = validateProducerCandidate(
      { blocks: [paragraph(PROJECT26_SENTENCE)] },
      { componentId: "section-0", componentType: "section", keyphrase: "don don donki" },
    );
    expect(result.violations.some((violation) => violation.code === "repeated-adjacent-word")).toBe(true);
  });
});

// ── 4. Pipeline parity: malformed-prose-repair boundary + final QC ──

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

const paragraph = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
function component(id: string, html: string): ArticleDocument["introduction"] {
  return { id, blocks: parseWordPressEditorialBlocks(html, id).blocks, status: "generated" };
}
function section(id: string, heading: string, html: string, sectionType: ArticleSection["sectionType"] = "main"): ArticleSection {
  return { ...component(id, html), heading, headingLevel: 2, sectionType };
}

function buildDocWithSentence(sentence: string): ArticleDocument {
  const para3 = (arr: string[], i: number) => paragraph(`${arr[i]} ${arr[i + 1]} ${arr[i + 2]}`);
  const introHtml = paragraph(`Opening guide to threads marketing hong kong gives local owners a clear place to start. ${S0[0]} ${S1[0]} ${S2[0]}`);
  const sections = [
    section("section-0", "Threads Marketing Hong Kong for Small Local Brands", [para3(S0, 0), para3(S0, 3), para3(S0, 6)].join("\n\n")),
    section("section-1", "Understand the People You Want to Reach", [para3(S1, 0), para3(S1, 3), para3(S1, 6)].join("\n\n")),
    section("section-2", "Build a Simple Weekly Content Routine", [para3(S2, 0), para3(S2, 3), para3(S2, 6)].join("\n\n")),
  ];
  sections.push(section("faq-section", "Frequently Asked Questions About Threads Marketing", "", "faq-heading"));
  const conclusionHtml = paragraph(`A useful threads marketing hong kong plan needs steady effort rather than a large budget. Consistency builds trust with followers who return each week. Review the results monthly and adjust the routine with care.`);
  const doc: ArticleDocument = {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-practical-sme-guide",
      metaDescription: "Learn how Hong Kong SMEs can use Threads to plan useful content, start genuine conversations, measure results, avoid common mistakes, and build steady local trust.",
      excerpt: "A practical guide for Hong Kong SMEs.",
      targetWordCount: 500,
      focusKeyphrase: "threads marketing hong kong",
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
  // Inject the offending sentence as section-0's first paragraph.
  doc.sections[0].blocks[0] = { id: "section-0-wp-0", type: "paragraph", content: [{ type: "text", text: sentence }] };
  return doc;
}

function runPipeline(doc: ArticleDocument, research: Array<{ title?: string; snippet?: string; url?: string }>) {
  const { min: wordMin, max: wordMax } = englishWordTolerance(500);
  const state = createPipelineState({
    userId: "u",
    projectId: "project-26-replay",
    keyphrase: "threads marketing hong kong",
    requestedWordCount: 500,
    articleDoc: doc,
    h2Headings: doc.sections.map((s) => s.heading),
    intro: "",
    conclusion: "",
    wordsPerSection: 300,
    exactKeyphraseTarget: 3,
    policy: buildPolicy(500, wordMin, wordMax, "threads marketing hong kong"),
    ctx: { research },
    wordMin,
    wordMax,
    systemPrompt: "test",
    userMessage: "test",
  });
  return runPostAssemblyPipeline(state, {
    chatWithRetry: async () => { throw new Error("Unexpected AI call"); },
    makeTrackedChatForStage: () => async () => { throw new Error("Unexpected tracked AI call"); },
    telemetry: {},
    context: { research },
  });
}

describe("repeated-adjacent-word pipeline parity", () => {
  it("project-26 replay: the sentence passes the malformed-prose-repair boundary and final QC when evidence licenses the entity", async () => {
    const doc = buildDocWithSentence(PROJECT26_SENTENCE);
    const result = await runPipeline(doc, RESEARCH);
    const stages = result.stageOutputs.map((output) => output.stage);
    const malformedIndex = stages.indexOf("malformed-prose-repair");
    const qcIndex = stages.indexOf("final-qc-scan");
    expect(malformedIndex).toBeGreaterThanOrEqual(0);
    expect(result.stageOutputs[malformedIndex].accepted).toBe(true);
    expect(result.stageOutputs[qcIndex].accepted).toBe(true);
    expect(result.stageOutputs.every((output) => output.accepted)).toBe(true);
    const validation = runFinalValidation(result);
    expect(validation.passed).toBe(true);
    const metrics = analyzeFinalArticle(
      result.blog,
      "threads marketing hong kong",
      result.title,
      result.metaDescription,
      500,
      countCanonicalVisibleWords(result.articleDoc),
    );
    expect(metrics.sentenceQualityViolationCount).toBe(0);
    // The entity sentence survived intact.
    expect(result.blog).toContain("DON DON DONKI");
  });

  it("the same sentence with a non-entity duplicate still fails closed at the boundary", async () => {
    const doc = buildDocWithSentence(
      "For Asian-origin packaged goods and Japanese, Korean, or international food and beauty brands, DON DON customers expect fast service in Hong Kong.",
    );
    await expect(runPipeline(doc, RESEARCH)).rejects.toThrow();
  });
});
