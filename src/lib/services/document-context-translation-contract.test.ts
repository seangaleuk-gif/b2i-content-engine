import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { ChatMessage } from "./deepseek";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import { buildDocumentContextShadowSystemPrompt, buildDocumentContextShadowUserPrompt, FAITHFUL_TRANSLATION_CONTRACT } from "./document-context-translation-shadow-prompt";
import { HK_TRANSLATION_GLOSSARY, buildTranslationGlossaryPrompt } from "./translation-glossary";
import { CANTONESE_STYLE_EXAMPLES, CANTONESE_EXAMPLE_CATEGORIES, buildCantoneseStyleExamplePrompt } from "./translation-style-examples";
import { buildTranslationChunkPlan, type TranslationChunk } from "./translation-chunk-planner";
import { buildTranslationSourceDocument } from "./translation-source-document";
import type { DocumentBrief } from "./translation-chunk-planner";

const isEditorialLabel = (label: string): boolean =>
  label === "editorial-bilingual-a" || label === "editorial-bilingual-b" || label === "editorial-monolingual-proofread";
const isChunkLabel = (label: string): boolean => label.startsWith("document-context-shadow-chunk-");

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Creator Marketing for Hong Kong SMEs", slug: "creator-marketing-hk", metaDescription: "A guide with 65% ROI.", excerpt: "Practical guide.", targetWordCount: 1500, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("i0", "Creator marketing reached 65% of SMEs within 6 months.")], status: "generated" },
    sections: [
      { id: "s0", heading: "Why it matters", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Follower growth drives engagement."), paragraphBlock("s0-1", "Budgets above HK$50,000 pay back faster.")], status: "generated" },
      { id: "s1", heading: "Measuring ROI", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "Track engagement within 6 months.")], status: "generated" },
    ],
    visibleFaq: [{ question: "How much?", answerHtml: "<p>Budgets start at <strong>HK$20,000</strong>.</p>", answerText: "Budgets start at HK$20,000." }],
    conclusion: { id: "conc", blocks: [paragraphBlock("c0", "Start with a focused campaign.")], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Sign up</a></div><!-- /wp:html -->", fingerprint: "cta-fp" },
    faqSchema: null,
    insertedLinks: [],
  };
}

function extractJsonAfter(content: string, marker: string, endMarker: string): unknown {
  const idx = content.indexOf(marker);
  const start = idx + marker.length;
  const end = content.indexOf(endMarker, start);
  return JSON.parse(content.slice(start, end >= 0 ? end : undefined).trim());
}

function toChinese(s: string): string {
  const masks: string[] = [];
  const masked = s.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; });
  const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
  return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

function makeProvider() {
  const calls: Array<{ label: string; userContent: string; systemContent: string }> = [];
  const callProvider = async (messages: ChatMessage[], _options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    const userContent = messages[1].content;
    calls.push({ label, userContent, systemContent: messages[0].content });
    if (isEditorialLabel(label)) throw new Error(`unexpected editorial call: ${label}`);
    const raw = extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as Array<{ sourceUnitId: string; text?: string; block?: { content?: Array<{ type: string; text?: string }> }; answerHtml?: string; answerText?: string }>;
    const units = raw.map((u) => {
      if (u.block && u.block.content) return { ...u, block: { ...u.block, content: u.block.content.map((n) => (n.type === "link" ? n : { ...n, text: toChinese(n.text ?? "") })) } };
      if (u.answerHtml !== undefined) return { ...u, answerHtml: toChinese(u.answerHtml), answerText: toChinese(u.answerText ?? "") };
      return { ...u, text: toChinese(u.text ?? "") };
    });
    return { content: JSON.stringify({ units }), finishReason: "stop" };
  };
  return { callProvider, calls };
}

async function runShadow(enDoc: ArticleDocument, provider: ReturnType<typeof makeProvider>): Promise<ReturnType<typeof runDocumentContextTranslationShadow>> {
  process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
  return runDocumentContextTranslationShadow(enDoc, { callProvider: provider.callProvider });
}

describe("faithful zh-HK translation contract, glossary and examples", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });

  it("1. every translation chunk receives the same contract, glossary and examples", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider();
    await runShadow(enDoc, provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    expect(chunkCalls.length).toBeGreaterThan(0);
    for (const c of chunkCalls) {
      // Same reusable contract + full glossary in every system prompt.
      expect(c.systemContent).toContain("FAITHFUL TRANSLATION CONTRACT");
      expect(c.systemContent).toContain("CANONICAL HONG KONG TERMINOLOGY");
      expect(c.systemContent).toContain("創作者市場推廣");
      // Same full approved example set in every chunk user prompt.
      expect(c.userContent).toContain("STYLE EXAMPLES");
      expect(c.userContent).toContain("一間創作者市場推廣公司");
      // Nearby source context + exact source unit IDs.
      expect(c.userContent).toContain("SOURCE UNITS (English):");
      expect(c.userContent).toContain('"sourceUnitId"');
    }
  });

  it("2. agency consistently uses 市場推廣公司", () => {
    const agency = HK_TRANSLATION_GLOSSARY.find(([source]) => source === "agency");
    expect(agency?.[1]).toBe("市場推廣公司");
    expect(buildTranslationGlossaryPrompt()).toContain("agency → 市場推廣公司");
    expect(buildCantoneseStyleExamplePrompt()).toContain("一間創作者市場推廣公司");
  });

  it("3. nano and micro creators remain distinct", () => {
    const nano = HK_TRANSLATION_GLOSSARY.find(([source]) => source === "nano-influencer");
    const micro = HK_TRANSLATION_GLOSSARY.find(([source]) => source === "micro-influencer");
    expect(nano?.[1]).toBe("超小型創作者");
    expect(micro?.[1]).toBe("微型創作者");
    expect(nano?.[1]).not.toBe(micro?.[1]);
    expect(buildCantoneseStyleExamplePrompt()).toContain("微型創作者");
  });

  it("4. Mainland 營銷-based marketing terms are not requested by the prompt", () => {
    // The influencer-marketing term uses 市場推廣, not 營銷.
    expect(HK_TRANSLATION_GLOSSARY.some(([source, target]) => source.includes("influencer marketing") && target.includes("營銷"))).toBe(false);
    expect(buildTranslationGlossaryPrompt()).toContain("創作者市場推廣");
    // Mainland 營銷 terms are explicitly forbidden, never requested.
    expect(buildTranslationGlossaryPrompt()).toContain("FORBIDDEN TERMS");
    expect(buildTranslationGlossaryPrompt()).toContain("網紅營銷");
    expect(buildTranslationGlossaryPrompt()).not.toContain("influencer marketing → 營銷");
  });

  it("5. examples teach general categories, not exact article sentences", () => {
    const prompt = buildCantoneseStyleExamplePrompt();
    expect(CANTONESE_EXAMPLE_CATEGORIES.length).toBeGreaterThanOrEqual(7);
    for (const category of CANTONESE_EXAMPLE_CATEGORIES) {
      expect(CANTONESE_STYLE_EXAMPLES.some((e) => e.category === category)).toBe(true);
    }
    expect(prompt).toContain("English idioms");
    expect(prompt).toContain("one-size-fits-all");
    // No exact article sentence is embedded as a hard rule.
    expect(prompt).not.toContain("10,000");
  });

  it("6. no editorial calls are restored; 7. the active call flow is translation calls only", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider();
    const result = await runShadow(enDoc, provider);
    expect(provider.calls.some((c) => isEditorialLabel(c.label))).toBe(false);
    expect(provider.calls.every((c) => isChunkLabel(c.label))).toBe(true);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(result.editorial.status).toBe("not-run");
  });

  it("8. a translation chunk receives the contract, glossary and examples directly", () => {
    const enDoc = makeEnDoc();
    const sourceDoc = buildTranslationSourceDocument(enDoc);
    const plan = buildTranslationChunkPlan(sourceDoc);
    const chunk = plan.chunks.find((c) => c.role !== "protected-cta") as TranslationChunk;
    const brief: DocumentBrief = chunk.documentBrief;
    const sys = buildDocumentContextShadowSystemPrompt(brief);
    const user = buildDocumentContextShadowUserPrompt(brief, chunk, sourceDoc, "");
    expect(sys).toContain(FAITHFUL_TRANSLATION_CONTRACT);
    expect(sys).toContain("CANONICAL HONG KONG TERMINOLOGY");
    expect(user).toContain("SOURCE UNITS (English):");
    expect(user).toContain("sourceUnitId");
  });
});

/** Non-digit filler word bank so mock-translated blocks never introduce spurious numbers. */
const FILLER_WORDS = "brands measure engagement saves shares comments followers growth strategy budgets campaigns analytics performance reach impressions audience content community insight trust results authentic creator marketing".split(" ");
function fillerWordsOf(n: number): string {
  return Array.from({ length: n }, (_, i) => FILLER_WORDS[i % FILLER_WORDS.length]).join(" ");
}

/** A production-shaped article that the deterministic planner splits into exactly 7 substantive (non-CTA) chunks. */
function makeProductionDoc(): ArticleDocument {
  const body = "Creator marketing is reshaping how Hong Kong brands connect with their audiences across social platforms, and the results are increasingly hard to ignore.";
  const filler = fillerWordsOf(160);
  const sectionBlock = `${filler} ${body} Follower growth drives engagement across Instagram, YouTube and TikTok within a 6 month window.`;
  const sections = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`, heading: `Section ${i + 1}`, headingLevel: 2 as const, sectionType: "main" as const,
    blocks: [
      paragraphBlock(`s${i}-0`, sectionBlock),
      paragraphBlock(`s${i}-1`, `${filler} Budgets above HK$50,000 pay back faster.`),
      paragraphBlock(`s${i}-2`, `${filler} Measure saves, shares and comments across each platform.`),
    ],
    status: "generated" as const,
  }));
  return {
    metadata: { title: "Creator Marketing Guide", slug: "creator-marketing-guide", metaDescription: "A guide to creator marketing for Hong Kong brands.", excerpt: "Creator marketing in Hong Kong.", targetWordCount: 2500, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("p0", body), paragraphBlock("p1", `${body} Creator marketing reached 65% of SMEs within 6 months.`)], status: "generated" },
    sections,
    conclusion: { id: "conc", blocks: [paragraphBlock("c0", `${body} Start with a focused campaign.`)], status: "generated" },
    visibleFaq: Array.from({ length: 6 }, (_, i) => ({
      question: `What is the ${i + 1}th best practice for creator marketing?`,
      answerHtml: `<p>Best practice number ${i + 1} with 65% engagement and 6 months of results.</p>`,
      answerText: `Best practice number ${i + 1} with 65% engagement and 6 months of results.`,
    })),
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

describe("full-article read-only context and one-call-per-chunk active workflow", () => {
  it("1. every translation call receives the complete English article as read-only context", async () => {
    const enDoc = makeProductionDoc();
    const provider = makeProvider();
    await runShadow(enDoc, provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    expect(chunkCalls.length).toBeGreaterThan(0);
    for (const c of chunkCalls) {
      expect(c.userContent).toContain("COMPLETE ENGLISH ARTICLE (READ-ONLY CONTEXT ONLY");
      // The read-only context includes full-document body sentences from every part.
      expect(c.userContent).toContain("Section 5");
      expect(c.userContent).toContain("5th best practice for creator marketing");
      // Assigned units remain present and clearly labelled.
      expect(c.userContent).toContain("SOURCE UNITS (English):");
    }
  });

  it("2/3. assigned units are clearly separated from read-only context, and only assigned units are returned", async () => {
    const enDoc = makeProductionDoc();
    const provider = makeProvider();
    const result = await runShadow(enDoc, provider);
    for (const c of provider.calls.filter((c) => isChunkLabel(c.label))) {
      const readOnly = c.userContent.indexOf("COMPLETE ENGLISH ARTICLE (READ-ONLY CONTEXT ONLY");
      const assigned = c.userContent.indexOf("SOURCE UNITS (English):");
      expect(readOnly).toBeGreaterThanOrEqual(0);
      expect(assigned).toBeGreaterThan(readOnly);
    }
    // Coverage is complete and every returned unit is an assigned unit of a planned chunk.
    expect(result.coverage.translatedSubstantive.translated).toBe(result.coverage.translatedSubstantive.total);
    expect(result.contractFailures.length).toBe(0);
    expect(result.protectedParityFailures.length).toBe(0);
    const plan = buildTranslationChunkPlan(buildTranslationSourceDocument(enDoc));
    const assignedIds = new Set(plan.chunks.flatMap((c) => c.sourceUnitIds));
    for (const chunk of result.chunkResults) {
      for (const unit of chunk.translatedUnits) {
        expect(assignedIds.has(unit.sourceUnitId)).toBe(true);
      }
    }
  });

  it("5. only one DeepSeek call is made per chunk", async () => {
    const enDoc = makeProductionDoc();
    const provider = makeProvider();
    await runShadow(enDoc, provider);
    const counts = new Map<string, number>();
    for (const c of provider.calls) {
      if (isChunkLabel(c.label)) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(0);
    for (const [label, count] of counts) {
      expect(count).toBe(1);
      expect(label).toMatch(/^document-context-shadow-chunk-\d+$/);
    }
  });

  it("6. no editorial calls are restored", async () => {
    const enDoc = makeProductionDoc();
    const provider = makeProvider();
    await runShadow(enDoc, provider);
    expect(provider.calls.some((c) => isEditorialLabel(c.label))).toBe(false);
    expect(provider.calls.every((c) => isChunkLabel(c.label))).toBe(true);
  });

  it("7. the active workflow is exactly ONE full-document translation call; the old seven-call execution is no longer active", async () => {
    const enDoc = makeProductionDoc();
    const provider = makeProvider();
    const result = await runShadow(enDoc, provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    // Exactly one DeepSeek translation call, carrying every substantive unit.
    expect(provider.calls.length).toBe(1);
    expect(chunkCalls.length).toBe(1);
    expect(result.substantiveChunkCallCount).toBe(1);
    expect(result.totalPlannedChunks).toBe(1);
    expect(result.providerAttemptCount).toBe(1);
    expect(result.allChunksCompleted).toBe(true);
    // The single call is assigned every translatable source unit.
    const plan = buildTranslationChunkPlan(buildTranslationSourceDocument(enDoc));
    const substantiveUnitCount = plan.chunks
      .filter((c) => c.role !== "protected-cta")
      .reduce((sum, c) => sum + c.sourceUnitIds.length, 0);
    expect(result.coverage.translatedSubstantive.total).toBe(substantiveUnitCount);
  });
});
