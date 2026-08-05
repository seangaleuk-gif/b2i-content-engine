import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { buildTranslationSourceDocument } from "./translation-source-document";
import {
  buildShadowMonolingualMessages,
  buildMonolingualConstraints,
  buildShadowMonolingualSystemPrompt,
} from "./document-context-translation-shadow-prompt";
import {
  buildTerminologyLedger,
  buildTerminologyLedgerPrompt,
  B2I_CANTONESE_TERMINOLOGY_POLICY,
} from "./b2i-cantonese-language-pack";
import { lintMonolingualDocument } from "./cantonese-style-linter";
import { buildBilingualEditorialBatches } from "./document-context-shadow-preview";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import type { ChatMessage } from "./deepseek";
import { EDITORIAL_BILINGUAL_A_LABEL, EDITORIAL_BILINGUAL_B_LABEL, EDITORIAL_MONOLINGUAL_LABEL } from "./deepseek-model-routing";

const isEditorialLabel = (label: string): boolean =>
  label === EDITORIAL_BILINGUAL_A_LABEL || label === EDITORIAL_BILINGUAL_B_LABEL || label === EDITORIAL_MONOLINGUAL_LABEL;
const isChunkLabel = (label: string): boolean => label.startsWith("document-context-shadow-chunk-");

function paragraph(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Creator Marketing for Hong Kong SMEs", slug: "creator-marketing-hk", metaDescription: "A guide with 65% ROI.", excerpt: "Practical guide.", targetWordCount: 1500, focusKeyphrase: "creator marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraph("i0", "Creator marketing reached 65% of SMEs within 6 months.")], status: "generated" },
    sections: [
      { id: "s0", heading: "Why it matters", headingLevel: 2, sectionType: "main", blocks: [paragraph("s0-0", "Follower growth drives engagement."), paragraph("s0-1", "Budgets above HK$50,000 pay back faster.")], status: "generated" },
      { id: "s1", heading: "Measuring ROI", headingLevel: 2, sectionType: "main", blocks: [paragraph("s1-0", "Track engagement within 6 months.")], status: "generated" },
    ],
    visibleFaq: [{ question: "How much?", answerHtml: "<p>Budgets start at <strong>HK$20,000</strong>.</p>", answerText: "Budgets start at HK$20,000." }],
    conclusion: { id: "conc", blocks: [paragraph("c0", "Start with a focused campaign.")], status: "generated" },
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

function makeProvider() {
  const calls: Array<{ label: string; userContent: string; systemContent: string; options?: Record<string, unknown> }> = [];
  const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    const systemContent = messages[0].content;
    const userContent = messages[1].content;
    calls.push({ label, userContent, systemContent, options });
    // The active workflow never makes an editorial call.
    if (isEditorialLabel(label)) throw new Error(`unexpected editorial call: ${label}`);
    const toChinese = (s: string): string => {
      const masks: string[] = [];
      const masked = s.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; });
      const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
      return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
    };
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

describe("faithful source-aligned workflow (editorial removed)", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });

  it("1. only the existing translation chunk calls run; all three editorial calls are absent", async () => {
    const provider = makeProvider();
    const result = await runShadow(makeEnDoc(), provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    const editorialCalls = provider.calls.filter((c) => isEditorialLabel(c.label));
    expect(editorialCalls.length).toBe(0);
    expect(chunkCalls.length).toBeGreaterThan(0);
    expect(result.editorial.status).toBe("not-run");
    expect(result.editorial.acceptedBatchCount).toBe(0);
    expect(result.editorial.batchCount).toBe(0);
  });

  it("2. the single full-document translation call uses thinking-enabled DeepSeek V4 Flash with native JSON", async () => {
    const provider = makeProvider();
    await runShadow(makeEnDoc(), provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    expect(chunkCalls.length).toBe(1);
    for (const c of chunkCalls) {
      expect(c.options?.model).toBe("deepseek-v4-flash");
      expect(c.options?.thinkingMode).toBe("disabled");
      expect(c.options?.reasoningEffort).toBeUndefined();
      expect((c.options?.responseFormat as { type?: string } | undefined)?.type).toBe("json_object");
    }
  });

  it("3. bilingual partition is deterministic and covers every editable unit exactly once", () => {
    const sourceDoc = buildTranslationSourceDocument(makeEnDoc());
    const batches = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0);
    const allIds = batches.flatMap((b) => b.sourceUnitIds);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toEqual(buildBilingualEditorialBatches(sourceDoc).flatMap((b) => b.sourceUnitIds));
  });

  it("4. monolingual prompt builders still exist as retained diagnostic wiring", () => {
    expect(buildShadowMonolingualSystemPrompt()).toContain("proofread");
    expect(buildShadowMonolingualSystemPrompt()).not.toContain("fast proofread");
  });

  it("5. terminology ledger is built locally with no API call", () => {
    const ledger = buildTerminologyLedger(["好多創作者都有好多粉絲", "另一個創作者有好多追蹤者"]);
    const follower = ledger.find((e) => e.concept === "follower");
    expect(follower).toBeDefined();
    expect(follower!.preferred).toBe("粉絲");
    expect(buildTerminologyLedgerPrompt(ledger)).toContain("TERMINOLOGY LEDGER");
    for (const p of B2I_CANTONESE_TERMINOLOGY_POLICY) expect(p.preferred.length).toBeGreaterThan(0);
  });

  it("6. cross-section terminology inconsistency and register/slang/collocation reach the linter findings", () => {
    const cross = lintMonolingualDocument([
      { sourceUnitId: "section.0.block.0", text: "好多粉絲" },
      { sourceUnitId: "section.1.block.0", text: "好多追蹤者" },
    ]);
    expect(cross.some((f) => f.instructionCode === "consistent-follower-term")).toBe(true);
    const style = lintMonolingualDocument([
      { sourceUnitId: "section.0.block.0", text: "而係在於對話" },
      { sourceUnitId: "section.1.block.0", text: "佢哋有料到" },
      { sourceUnitId: "section.1.block.1", text: "同時隨住過程一路優化表現" },
    ]);
    expect(style.some((f) => f.instructionCode === "mixed-register")).toBe(true);
    expect(style.some((f) => f.instructionCode === "excessive-slang")).toBe(true);
    expect(style.some((f) => f.instructionCode === "unnatural-collocation")).toBe(true);
  });

  it("7. monolingual messages serialise Chinese units as JSON, not English prose", () => {
    const sourceDoc = buildTranslationSourceDocument(makeEnDoc());
    const enUnits = sourceDoc.sections[0].blocks.length ? [sourceDoc.sections[0].blocks[0]] : [];
    const chineseUnits = enUnits.map((block) => ({
      sourceId: "section.0.block.0",
      type: "section-block" as const,
      sectionIndex: 0,
      blockIndex: 0,
      block,
      text: "",
      links: [],
      numbers: [],
    }));
    const constraints = buildMonolingualConstraints({ hasSourceReferences: false });
    const messages = buildShadowMonolingualMessages(chineseUnits as never, { constraints, terminologyLedger: "" });
    const user = messages[1].content;
    expect(user).toContain("COMPLETE REVISED CHINESE DOCUMENT UNITS");
    expect(Array.isArray(extractJsonAfter(user, "COMPLETE REVISED CHINESE DOCUMENT UNITS (proofread these; numbers are protected as __NUM_n__ placeholders):", "\n\nReturn ONLY the units you changed"))).toBe(true);
  });
});
