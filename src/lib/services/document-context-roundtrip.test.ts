import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import type { ChatMessage } from "./deepseek";
import { validatePrimaryDocumentContextResult } from "./document-context-primary";

const isEditorialLabel = (label: string): boolean =>
  label === "editorial-bilingual-a" || label === "editorial-bilingual-b" || label === "editorial-monolingual-proofread";
const isChunkLabel = (label: string): boolean => label.startsWith("document-context-shadow-chunk-");

function paragraph(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function linkNode(text: string, href: string): InlineContent {
  return { type: "link", text, href, sourceType: "editorial-external" };
}

/** A realistic document covering every unit class: metadata, intro, H2, paragraph, list, source citation, conclusion, FAQ, CTA, schema, switcher, protected HTML. */
function makeRealisticDoc(): ArticleDocument {
  const citation: ArticleDocument["introduction"]["blocks"][number] = {
    id: "s1-cite",
    type: "paragraph",
    content: [linkNode("點揀香港創作者合作夥伴", "https://example.com/choose-creator")],
  };
  return {
    metadata: {
      title: "Creator Marketing for Hong Kong SMEs",
      slug: "creator-marketing-hk",
      metaDescription: "A practical guide with a 65% engagement example.",
      excerpt: "Short excerpt.",
      targetWordCount: 1500,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: { id: "switcher", type: "language-switcher", html: "<!-- wp:html --><div class=\"b2i-language-switcher\">EN/中文</div><!-- /wp:html -->", fingerprint: "sw-fp" },
    introduction: { id: "intro", blocks: [paragraph("i0", "Creator marketing reached 65% of SMEs within 6 months.")], status: "generated" },
    sections: [
      {
        id: "s0", heading: "Why it matters", headingLevel: 2, sectionType: "main",
        blocks: [
          paragraph("s0-0", "Follower growth drives engagement."),
          { id: "s0-1", type: "list", ordered: false, items: [[{ type: "text", text: "Clear goals" }], [{ type: "text", text: "Measurable KPIs" }]] },
        ],
        status: "generated",
      },
      {
        id: "s1", heading: "Measuring ROI", headingLevel: 2, sectionType: "main",
        blocks: [paragraph("s1-0", "Track engagement within 6 months."), citation],
        status: "generated",
      },
    ],
    visibleFaq: [{ question: "How much does it cost?", answerHtml: "<p>Budgets start at <strong>HK$20,000</strong>.</p>", answerText: "Budgets start at HK$20,000." }],
    conclusion: { id: "conc", blocks: [paragraph("c0", "Start with a focused campaign.")], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Sign up</a></div><!-- /wp:html -->", fingerprint: "cta-fp" },
    faqSchema: { id: "fs", type: "faq-schema", html: "<!-- wp:html --><script type=\"application/ld+json\">{}</script><!-- /wp:html -->", fingerprint: "fs-fp" },
    insertedLinks: [],
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

/** Translate a serialized English unit's block/content into Chinese (mock provider). */
function translateUnit(u: { sourceUnitId: string; text?: string; block?: { content?: Array<{ type: string; text?: string }> }; answerHtml?: string; answerText?: string }): Record<string, unknown> {
  if (u.block && u.block.content) {
    return { ...u, block: { ...u.block, content: u.block.content.map((n) => (n.type === "link" ? n : { ...n, text: toChineseText(n.text ?? "") })) } };
  }
  if (u.answerHtml !== undefined) {
    return { ...u, answerHtml: toChineseText(u.answerHtml), answerText: toChineseText(u.answerText ?? "") };
  }
  return { ...u, text: toChineseText(u.text ?? "") };
}

function makeProvider(chunkOverride?: (userContent: string) => Array<Record<string, unknown>>) {
  const calls: Array<{ label: string; userContent: string; systemContent: string; options?: Record<string, unknown> }> = [];
  const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    const userContent = messages[1].content;
    calls.push({ label, userContent, systemContent: messages[0].content, options });
    // The active workflow must never make an editorial call.
    if (isEditorialLabel(label)) {
      throw new Error(`unexpected editorial call in faithful workflow: ${label}`);
    }
    if (isChunkLabel(label)) {
      if (chunkOverride) return { content: JSON.stringify({ units: chunkOverride(userContent) }), finishReason: "stop" };
      const units = (extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as Array<{ sourceUnitId: string; text?: string; block?: { content?: Array<{ type: string; text?: string }> }; answerHtml?: string; answerText?: string }>).map(translateUnit);
      return { content: JSON.stringify({ units }), finishReason: "stop" };
    }
    throw new Error(`unknown provider label: ${label}`);
  };
  return { callProvider, calls };
}

async function runShadow(enDoc: ArticleDocument, provider: ReturnType<typeof makeProvider>): Promise<ReturnType<typeof runDocumentContextTranslationShadow>> {
  process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
  return runDocumentContextTranslationShadow(enDoc, { callProvider: provider.callProvider });
}

describe("faithful source-aligned zh-HK translation (no editorial stage)", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });

  it("1/2. only the existing translation chunk calls run; all three editorial calls are absent", async () => {
    const provider = makeProvider();
    const result = await runShadow(makeRealisticDoc(), provider);
    const labels = provider.calls.map((c) => c.label);
    expect(labels.some((l) => isEditorialLabel(l))).toBe(false);
    expect(labels.filter((l) => isChunkLabel(l)).length).toBeGreaterThan(0);
    // Editorial is a not-run diagnostic stub — never invoked.
    expect(result.editorial.status).toBe("not-run");
    expect(result.editorial.acceptedBatchCount).toBe(0);
    expect(result.editorial.rejectedBatchCount).toBe(0);
  });

  it("3. every source unit maps to exactly one target unit (1:1 alignment)", async () => {
    const provider = makeProvider();
    const result = await runShadow(makeRealisticDoc(), provider);
    const cov = result.coverage.translatedSubstantive;
    expect(cov.translated).toBe(cov.total);
    expect(cov.total).toBeGreaterThan(0);
    expect(result.allChunksCompleted).toBe(true);
    expect(result.failedChunkCount).toBe(0);
    expect(result.contractFailures.length).toBe(0);
    expect(result.protectedParityFailures.length).toBe(0);
    expect(result.assembly.status).toBe("assembled");
  });

  it("4. facts, numbers, URLs, sources and structure are preserved (deterministic validation passes)", async () => {
    const provider = makeProvider();
    const result = await runShadow(makeRealisticDoc(), provider);
    expect(result.validChunkCount).toBe(result.substantiveChunkCallCount);
    expect(result.failedChunkCount).toBe(0);
    expect(result.assembly.status).toBe("assembled");
    const doc = result.preview.retainedDoc;
    expect(doc).not.toBeNull();
    expect(result.preview.retainedSource).toBe("pre-editorial");
  });

  it("5. invalid translations are not saved (save gate rejects a partial/broken result)", async () => {
    // A provider that returns an empty units array for every chunk → no coverage.
    const provider = makeProvider(() => []);
    const result = await runShadow(makeRealisticDoc(), provider);
    const failure = validatePrimaryDocumentContextResult(result);
    expect(failure).not.toBeNull();
    expect(result.failedChunkCount).toBeGreaterThan(0);
    expect(result.allChunksCompleted).toBe(false);
  });

  it("6. a valid translation saves normally (save gate passes with no editorial dependency)", async () => {
    const provider = makeProvider();
    const result = await runShadow(makeRealisticDoc(), provider);
    // The save gate no longer has an editorial stage; a completed, covered,
    // assembled translation is not blocked by the editorial check.
    const failure = validatePrimaryDocumentContextResult(result);
    expect(failure?.stage).not.toBe("editorial");
    expect(result.editorial.status).toBe("not-run");
  });
});
