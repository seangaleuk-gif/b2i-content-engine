import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  buildShadowMonolingualSystemPrompt,
  buildShadowMonolingualMessages,
  buildMonolingualConstraints,
} from "./document-context-translation-shadow-prompt";
import { buildMonolingualFindingsPrompt, buildFindingTokenMap, EDITORIAL_PATCH_UNIT_KEY, type StyleFinding } from "./cantonese-style-linter";
import { validateEditorialPatchShape, buildBilingualEditorialBatches } from "./document-context-shadow-preview";
import { buildTranslationSourceDocument } from "./translation-source-document";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import type { ChatMessage } from "./deepseek";

const isEditorialLabel = (label: string): boolean =>
  label === "editorial-bilingual-a" || label === "editorial-bilingual-b" || label === "editorial-monolingual-proofread";

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

function suppliedFindingTokens(userContent: string): string[] {
  return [...new Set([...userContent.matchAll(/"findingToken":"(F\d{3})"/g)].map((m) => m[1]))];
}

/** Mock that builds monolingual responses from the declared response schema. */
function makeProvider(monolingualUnits?: Array<Record<string, unknown>>) {
  const calls: Array<{ label: string; userContent: string; systemContent: string; options?: Record<string, unknown> }> = [];
  const toChinese = (s: string): string => {
    const masks: string[] = [];
    const masked = s.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; });
    const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
    return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
  };
  const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    const systemContent = messages[0].content;
    const userContent = messages[1].content;
    calls.push({ label, userContent, systemContent, options });
    if (isEditorialLabel(label)) {
      const marker = label === "editorial-monolingual-proofread"
        ? "COMPLETE REVISED CHINESE DOCUMENT UNITS (proofread these; numbers are protected as __NUM_n__ placeholders):"
        : "CURRENT CHINESE CANDIDATE UNITS (current batch, edit these; numbers are protected as __NUM_n__ placeholders):";
      const units = extractJsonAfter(userContent, marker, "\n\nReturn ONLY the units you changed") as Array<{ sourceUnitId: string; block?: { content: Array<{ type: string; text: string }> }; text?: string; answerHtml?: string; answerText?: string }>;
      if (label === "editorial-monolingual-proofread" && monolingualUnits) {
        return { content: JSON.stringify({ units: monolingualUnits, resolvedFindingTokens: [] }), finishReason: "stop" };
      }
      return { content: JSON.stringify({ units, resolvedFindingTokens: suppliedFindingTokens(userContent) }), finishReason: "stop" };
    }
    const raw = extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as Array<{ sourceUnitId: string; text?: string; block?: { content?: Array<{ type: string; text?: string }> }; answerHtml?: string; answerText?: string }>;
    const translated = raw.map((u) => {
      if (u.block && u.block.content) return { ...u, block: { ...u.block, content: u.block.content.map((n) => (n.type === "link" ? n : { ...n, text: toChinese(n.text ?? "") })) } };
      if (u.answerHtml !== undefined) return { ...u, answerHtml: toChinese(u.answerHtml), answerText: toChinese(u.answerText ?? "") };
      return { ...u, text: toChinese(u.text ?? "") };
    });
    return { content: JSON.stringify({ units: translated }), finishReason: "stop" };
  };
  return { callProvider, calls };
}

async function runShadow(enDoc: ArticleDocument, provider: ReturnType<typeof makeProvider>): Promise<ReturnType<typeof runDocumentContextTranslationShadow>> {
  process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
  process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG] = "true";
  return runDocumentContextTranslationShadow(enDoc, { callProvider: provider.callProvider });
}

describe("monolingual patch-schema contract (unitId → sourceUnitId)", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });

  it("1/2/3. the monolingual PATCH CONTRACT uses sourceUnitId and never instructs unitId", () => {
    const sys = buildShadowMonolingualSystemPrompt();
    expect(sys).toContain(EDITORIAL_PATCH_UNIT_KEY);
    expect(sys).toContain('{ "sourceUnitId": "section.3.block.2", "block":');
    expect(sys).not.toContain('{ "unitId":');
    expect(sys).not.toMatch(/returned unitId/);
  });

  it("4. grouped monolingual findings use sourceUnitId", () => {
    const findings: StyleFinding[] = [
      { findingId: "finding-1", sourceUnitId: "section.3.block.2", category: "language", severity: "minor", instructionCode: "mixed-register" },
      { findingId: "finding-2", sourceUnitId: "section.3.block.2", category: "language", severity: "minor", instructionCode: "non-hk-terminology" },
    ];
    const tokenMap = buildFindingTokenMap(findings);
    const prompt = buildMonolingualFindingsPrompt(findings, tokenMap);
    expect(prompt).toContain('"sourceUnitId":"section.3.block.2"');
    expect(prompt).not.toContain('"unitId"');
    expect(prompt).toContain('Each sourceUnitId may appear at most ONCE');
  });

  it("5. serialized document units use sourceUnitId", () => {
    const sourceDoc = buildTranslationSourceDocument(makeEnDoc());
    const chineseUnits = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0)[0].sourceUnits;
    const messages = buildShadowMonolingualMessages(chineseUnits, {
      constraints: buildMonolingualConstraints({ hasSourceReferences: false }),
      terminologyLedger: "",
    });
    const user = messages[1].content;
    // The serialized document section uses the canonical sourceUnitId key.
    expect(user).toContain('"sourceUnitId"');
    expect(user).not.toContain('"unitId"');
  });

  it("8. a missing identity key is rejected as missing-source-unit-id", () => {
    const unitById = new Map<string, never>();
    const reasons = validateEditorialPatchShape([{ text: "x" }], unitById);
    expect(reasons.some((r) => r.code === "missing-source-unit-id")).toBe(true);
  });

  it("6b. the active pipeline never invokes the editorial patch machinery (no editorial calls)", async () => {
    const provider = makeProvider();
    const result = await runShadow(makeEnDoc(), provider);
    expect(provider.calls.filter((c) => isEditorialLabel(c.label)).length).toBe(0);
    expect(result.editorial.status).toBe("not-run");
    expect(result.editorial.batchCount).toBe(0);
  });
});
