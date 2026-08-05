import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  buildDocumentContextShadowSystemPrompt,
  buildShadowEditorialSystemPrompt,
  buildShadowMonolingualSystemPrompt,
} from "./document-context-translation-shadow-prompt";
import { buildDocumentBrief } from "./translation-chunk-planner";
import { buildTranslationSourceDocument } from "./translation-source-document";
import { TRANSLATION_BRAND_PROFILE, BILINGUAL_BRAND_PRINCIPLES, MONOLINGUAL_REGISTER_GUIDANCE } from "./zh-hk-style-contract";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import type { ChatMessage } from "./deepseek";

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(): ArticleDocument {
  return {
    metadata: { title: "Creator Marketing", slug: "creator-marketing-hk", metaDescription: "Meta.", excerpt: "Ex.", targetWordCount: 1000, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "i", blocks: [paragraphBlock("i0", "Creator marketing reached 65% of SMEs.")], status: "generated" },
    sections: [{ id: "s0", heading: "Why it matters", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Follower growth drives engagement.")], status: "generated" }],
    visibleFaq: [{ question: "How much?", answerHtml: "<p>HK$20,000.</p>", answerText: "HK$20,000." }],
    conclusion: { id: "c", blocks: [paragraphBlock("c0", "Start.")], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function extractJsonAfter(content: string, marker: string, endMarker: string): unknown {
  const idx = content.indexOf(marker);
  const start = idx + marker.length;
  const end = content.indexOf(endMarker, start);
  return JSON.parse(content.slice(start, end >= 0 ? end : undefined).trim());
}

function toChineseText(s: string): string {
  const masks: string[] = [];
  const masked = s.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; });
  const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
  return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

function translateUnit(u: { sourceUnitId: string; text?: string; block?: { content?: Array<{ type: string; text?: string }> }; answerHtml?: string; answerText?: string }): Record<string, unknown> {
  if (u.block && u.block.content) {
    return { ...u, block: { ...u.block, content: u.block.content.map((n) => (n.type === "link" ? n : { ...n, text: toChineseText(n.text ?? "") })) } };
  }
  if (u.answerHtml !== undefined) return { ...u, answerHtml: toChineseText(u.answerHtml), answerText: toChineseText(u.answerText ?? "") };
  return { ...u, text: toChineseText(u.text ?? "") };
}

function suppliedFindingTokens(userContent: string): string[] {
  return [...new Set([...userContent.matchAll(/"findingToken":"(F\d{3})"/g)].map((m) => m[1]))];
}

function makeProvider() {
  const calls: Array<{ label: string; systemContent: string }> = [];
  const callProvider = async (messages: ChatMessage[], _options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    calls.push({ label, systemContent: messages[0].content });
    const userContent = messages[1].content;
    if (label.startsWith("document-context-shadow-chunk-")) {
      const units = (extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as Array<{ sourceUnitId: string; text?: string; block?: { content?: Array<{ type: string; text?: string }> }; answerHtml?: string; answerText?: string }>).map(translateUnit);
      return { content: JSON.stringify({ units }), finishReason: "stop" };
    }
    if (label === "editorial-monolingual-proofread") {
      return { content: JSON.stringify({ units: [], resolvedFindingTokens: [] }), finishReason: "stop" };
    }
    const marker = "CURRENT CHINESE CANDIDATE UNITS (current batch, edit these; numbers are protected as __NUM_n__ placeholders):";
    const units = extractJsonAfter(userContent, marker, "\n\nReturn ONLY the units you changed") as Array<{ sourceUnitId: string; text?: string; block?: unknown }>;
    return { content: JSON.stringify({ units, resolvedFindingTokens: suppliedFindingTokens(userContent) }), finishReason: "stop" };
  };
  return { callProvider, calls };
}

async function runShadow(enDoc: ArticleDocument, provider: ReturnType<typeof makeProvider>, brandVoice?: string): Promise<unknown> {
  process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
  process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG] = "true";
  return runDocumentContextTranslationShadow(enDoc, { callProvider: provider.callProvider, brandVoice });
}

describe("Brand Voice data flow", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });

  it("7. the English prompt builder receives the Brand Voice via DEFAULT_PROMPTS", async () => {
    const { buildBlogPrompt } = await import("./prompt-builder");
    const { DEFAULT_PROMPTS } = await import("./default-prompts");
    const context = { project: { name: "X", keyword: "kp", audience: "", country: "HK", wordCount: 500, content: "", status: "" }, research: [], knowledge: [], promptSections: [{ key: "brand_voice", label: "brand_voice", content: DEFAULT_PROMPTS.brand_voice }], generationDate: "2026-08-03" } as never;
    const { systemPrompt } = buildBlogPrompt(context);
    expect(systemPrompt).toContain("Brand Voice");
    expect(systemPrompt).toContain("Warm and honest");
  });

  it("8/9. translation and editorial prompts receive the derived profiles", () => {
    const brief = buildDocumentBrief(buildTranslationSourceDocument(makeDoc()));
    const translationSystem = buildDocumentContextShadowSystemPrompt(brief, TRANSLATION_BRAND_PROFILE);
    expect(translationSystem).toContain("BRAND VOICE (compact):");
    expect(translationSystem).toContain("Warm and honest");
    expect(translationSystem).toContain("professional conversational Hong Kong Cantonese");

    const bilingualSystem = buildShadowEditorialSystemPrompt(brief, BILINGUAL_BRAND_PRINCIPLES);
    expect(bilingualSystem).toContain("BRAND VOICE PRINCIPLES:");
    expect(bilingualSystem).toContain("never change facts, numbers, URLs, brands, claims");

    const monolingualSystem = buildShadowMonolingualSystemPrompt(MONOLINGUAL_REGISTER_GUIDANCE);
    expect(monolingualSystem).toContain("REGISTER GUIDANCE (zh-HK):");
    expect(monolingualSystem).toContain("professional conversational Hong Kong Cantonese");
  });

  it("integration: the running pipeline injects the derived profiles into the translation chunks (no editorial stage)", async () => {
    const provider = makeProvider();
    await runShadow(makeDoc(), provider, undefined);
    const chunkSystems = provider.calls.filter((c) => c.label.startsWith("document-context-shadow-chunk-")).map((c) => c.systemContent);
    const editorialCalls = provider.calls.filter((c) => c.label === "editorial-bilingual-a" || c.label === "editorial-bilingual-b" || c.label === "editorial-monolingual-proofread");
    expect(chunkSystems.length).toBeGreaterThan(0);
    expect(editorialCalls.length).toBe(0);
    for (const s of chunkSystems) {
      expect(s).toContain("BRAND VOICE (compact):");
      expect(s).toContain("Warm and honest");
    }
  });

  it("12. raw Brand Voice text is not redundantly injected into every call", async () => {
    const provider = makeProvider();
    await runShadow(makeDoc(), provider, undefined);
    const allSystems = provider.calls.map((c) => c.systemContent).join("\n");
    // The full raw Brand Voice (long) is not pasted into every prompt; only the
    // compact derived profile appears, once per call family.
    expect(allSystems).not.toContain("You are the voice of B2I Hub.");
    expect(allSystems).toContain("BRAND VOICE (compact):");
  });
});
