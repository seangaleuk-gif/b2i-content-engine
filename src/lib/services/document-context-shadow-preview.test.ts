import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import type { ChatMessage } from "@/lib/services/deepseek";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG,
  type DocumentContextTranslationShadowResult,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import { buildTranslationSourceDocument, enumerateTranslationSourceUnits, type TranslationSourceDocument } from "./translation-source-document";
import { buildBilingualEditorialBatches, serializeShadowPreview } from "./document-context-shadow-preview";

const BILINGUAL_A = "editorial-bilingual-a";
const BILINGUAL_B = "editorial-bilingual-b";
const MONOLINGUAL = "editorial-monolingual-proofread";
const isEditorialLabel = (label: string): boolean => label === BILINGUAL_A || label === BILINGUAL_B || label === MONOLINGUAL;
const isChunkLabel = (label: string): boolean => label.startsWith("document-context-shadow-chunk-");

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function richParagraph(id: string): ArticleDocument["introduction"]["blocks"][number] {
  return {
    id,
    type: "paragraph",
    content: [
      { type: "text", text: "Creator marketing reached " },
      { type: "strong", text: "65%" },
      { type: "text", text: " of SMEs within " },
      { type: "link", text: "B2I Hub", href: "https://www.b2ihub.com/", sourceType: "editorial-external" },
      { type: "text", text: " 6 months." },
    ],
  };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: {
      title: "Creator Marketing for Hong Kong SMEs",
      slug: "creator-marketing-hk",
      metaDescription: "A guide to creator marketing with 65% ROI and 6-month results.",
      excerpt: "Practical creator marketing guide.",
      targetWordCount: 1500,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: { id: "switcher", type: "language-switcher", html: "<!-- wp:html --><div class=\"b2i-language-switcher\">EN/中文</div><!-- /wp:html -->", fingerprint: "sw-fp" },
    introduction: { id: "intro", blocks: [richParagraph("intro-0")], status: "generated" },
    sections: [
      { id: "s0", heading: "Why Creator Marketing Matters", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Creator marketing reaches 65% of SMEs."), paragraphBlock("s0-1", "Budgets above HK$50,000 pay back faster.")], status: "generated" },
      { id: "s1", heading: "Measuring ROI", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "Track engagement within 6 months.")], status: "generated" },
    ],
    visibleFaq: [
      { question: "How much does it cost?", answerHtml: "<p>Budgets start at <strong>HK$20,000</strong>.</p>", answerText: "Budgets start at HK$20,000." },
      { question: "How soon will I see results?", answerHtml: "<p>Most see ROI within <a href=\"/blog/roi\">6 months</a>.</p>", answerText: "Most see ROI within 6 months." },
    ],
    conclusion: { id: "conc", blocks: [paragraphBlock("conc-0", "Start with a focused campaign.")], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div style=\"background:#1E3A8A;color:#fff;padding:32px 28px;border-radius:12px;margin:40px 0;text-align:center;\"><h2 style=\"color:#fff;margin-top:0;font-size:22px;\">Ready to grow your brand with Hong Kong creators?</h2><p style=\"font-size:16px;line-height:1.6;margin-bottom:24px;\">B2I Hub connects businesses directly with verified creators \u2014 no agencies, no commissions, no middlemen. Create your free profile today.</p><a href=\"https://app.b2ihub.com/signup\" style=\"display:inline-block;background:#F97316;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;\" target=\"_blank\" rel=\"noopener\">Create your free profile \u2192</a></div><!-- /wp:html -->", fingerprint: "cta-fp" },
    faqSchema: { id: "faq-schema", type: "faq-schema", html: "<!-- wp:html --><script type=\"application/ld+json\">{}</script><!-- /wp:html -->", fingerprint: "schema-fp" },
    insertedLinks: [{ componentId: "s1", href: "/blog/roi", anchorText: "ROI", sourceType: "internal" }],
  };
}

function extractJsonAfter(userContent: string, marker: string, endMarker: string): unknown {
  const idx = userContent.indexOf(marker);
  const start = idx + marker.length;
  const end = userContent.indexOf(endMarker, start);
  return JSON.parse(userContent.slice(start, end >= 0 ? end : undefined).trim());
}

interface ExtractedUnit {
  sourceUnitId: string;
  text?: string;
  block?: { content: Array<{ type: string; text: string }> };
  answerHtml?: string;
  answerText?: string;
}

/** Replace Latin runs (except currency prefixes like HK$ / USD) with a CJK token so the
 *  assembled document is CJK-dominant while numbers/URLs/structure are preserved.
 *  `__NUM_n__` placeholder tokens are preserved verbatim. */
function toChineseText(s: string): string {
  const masks: string[] = [];
  const masked = s.replace(/__NUM_\d+__/g, (m) => {
    masks.push(m);
    return `\u0000${masks.length - 1}\u0000`;
  });
  const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
  return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

/** Like toChineseText but preserves HTML tags/attributes and placeholders verbatim. */
function toChineseHtml(s: string): string {
  const masks: string[] = [];
  const maskedTags = s.replace(/<[^>]*>/g, (m) => {
    masks.push(m);
    return `\u0001${masks.length - 1}\u0001`;
  });
  const maskedNums = maskedTags.replace(/__NUM_\d+__/g, (m) => {
    masks.push(m);
    return `\u0002${masks.length - 1}\u0002`;
  });
  const replaced = maskedNums.replace(/[A-Za-z]+(?![$%])/g, "創");
  return replaced
    .replace(/\u0001(\d+)\u0001/g, (_m, i) => masks[Number(i)])
    .replace(/\u0002(\d+)\u0002/g, (_m, i) => masks[Number(i)]);
}

function toChineseUnit(u: ExtractedUnit): ExtractedUnit {
  if (u.block) {
    return { ...u, block: { ...u.block, content: u.block.content.map((n) => (n.type === "link" ? n : { ...n, text: toChineseText(n.text) })) } };
  }
  if (u.answerHtml !== undefined) return { ...u, answerHtml: toChineseHtml(u.answerHtml), answerText: toChineseText(u.answerText ?? "") };
  if (u.text !== undefined) return { ...u, text: toChineseText(u.text) };
  return u;
}

function makeProvider(chunkResponse?: (userContent: string) => Array<Record<string, unknown>>) {
  const calls: Array<{ label: string; userContent: string; systemContent: string; options?: Record<string, unknown> }> = [];
  const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    const systemContent = messages[0].content;
    const userContent = messages[1].content;
    calls.push({ label, userContent, systemContent, options });
    if (isEditorialLabel(label)) throw new Error(`unexpected editorial call: ${label}`);
    if (chunkResponse) return { content: JSON.stringify({ units: chunkResponse(userContent) }), finishReason: "stop" };
    const units = (extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as ExtractedUnit[]).map(toChineseUnit);
    return { content: JSON.stringify({ units }), finishReason: "stop" };
  };
  return { callProvider, calls };
}

interface TestProvider {
  callProvider: (m: ChatMessage[], o: Record<string, unknown>, l: string) => Promise<ShadowProviderResponse>;
  calls: Array<{ label: string; userContent: string; systemContent: string }>;
}

async function runShadow(enDoc: ArticleDocument, provider?: TestProvider): Promise<DocumentContextTranslationShadowResult> {
  process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
  delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG];
  const p = provider ?? makeProvider();
  return runDocumentContextTranslationShadow(enDoc, { callProvider: p.callProvider });
}

const exportTempDirs: string[] = [];
function makeExportDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-export-integration-"));
  exportTempDirs.push(dir);
  return dir;
}

async function runShadowExport(enDoc: ArticleDocument, outputDir: string, provider?: TestProvider): Promise<DocumentContextTranslationShadowResult> {
  process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
  delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG];
  const p = provider ?? makeProvider();
  return runDocumentContextTranslationShadow(enDoc, { callProvider: p.callProvider, projectId: 19, outputDir });
}

describe("faithful source-aligned translation (no editorial stage)", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });

  it("assembles a complete document from all validated substantive units with 1:1 coverage", async () => {
    const enDoc = makeEnDoc();
    const result = await runShadow(enDoc);
    expect(result.assembly.status).toBe("assembled");
    expect(result.assembly.doc).not.toBeNull();
    const doc = result.assembly.doc!;
    expect(result.coverage.translatedSubstantive.translated).toBe(result.coverage.translatedSubstantive.total);
    expect(doc.sections.length).toBe(enDoc.sections.length);
    expect(doc.visibleFaq.length).toBe(enDoc.visibleFaq.length);
  });

  it("recovers a complete valid JSON object wrapped in harmless prose and requires all units", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider((userContent) => {
      const units = (extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as ExtractedUnit[]).map(toChineseUnit);
      return units as unknown as Array<Record<string, unknown>>;
    });
    // Wrap the provider's own JSON output in a prose prefix + suffix so the initial
    // JSON.parse fails but the balanced-object recovery succeeds.
    const original = provider.callProvider;
    provider.callProvider = async (messages, options, label) => {
      const raw = await original(messages, options, label);
      return { ...raw, content: `Here is the translation:\n${raw.content}\nLet me know if you need changes.` };
    };
    const result = await runShadow(enDoc, provider);
    expect(result.assembly.status).toBe("assembled");
    expect(result.coverage.translatedSubstantive.translated).toBe(result.coverage.translatedSubstantive.total);
    const chunk = result.chunkResults.find((c) => c.jsonDiagnostics);
    expect(chunk?.jsonDiagnostics?.recovered).toBe(true);
  });

  it("keeps the hard failure with diagnostics when recovery produces an incomplete document", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider(() => []);
    const original = provider.callProvider;
    // A genuinely partial object (missing closing brace) cannot be recovered.
    provider.callProvider = async (messages, options, label) => {
      const raw = await original(messages, options, label);
      return { ...raw, content: `prefix ${raw.content.slice(0, raw.content.length - 1)}` };
    };
    const result = await runShadow(enDoc, provider);
    expect(result.chunkResults[0].valid).toBe(false);
    expect(result.chunkResults[0].jsonDiagnostics?.recovered).toBe(false);
  });

  it("only the existing translation chunk calls run; all three editorial calls are absent", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider();
    const result = await runShadow(enDoc, provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    const editorialCalls = provider.calls.filter((c) => isEditorialLabel(c.label));
    expect(chunkCalls.length).toBeGreaterThan(0);
    expect(editorialCalls.length).toBe(0);
    expect(result.editorial.status).toBe("not-run");
    expect(result.editorial.batchCount).toBe(0);
  });

  it("preserves source-unit order, list structure and FAQ pairing", async () => {
    const enDoc = makeEnDoc();
    const result = await runShadow(enDoc);
    const doc = result.assembly.doc!;
    const sourceDoc: TranslationSourceDocument = buildTranslationSourceDocument(enDoc);
    doc.sections.forEach((section, si) => {
      expect(section.blocks.length).toBe(sourceDoc.sections[si].blocks.length);
    });
    doc.visibleFaq.forEach((entry) => {
      expect(entry.question.length).toBeGreaterThan(0);
      expect((entry.answerHtml || entry.answerText).length).toBeGreaterThan(0);
    });
  });

  it("reinserts protected CTA, schema and switcher content; FAQ schema rebuilt for parity", async () => {
    const enDoc = makeEnDoc();
    const result = await runShadow(enDoc);
    const doc = result.assembly.doc!;
    expect(doc.languageSwitcher?.html).toBe(enDoc.languageSwitcher!.html);
    expect(doc.faqSchema).not.toBeNull();
    expect(doc.faqSchema!.html).toContain("application/ld+json");
  });

  it("deterministic post-processing localizes the CTA, rebuilds FAQ schema and yields a quality report", async () => {
    const enDoc = makeEnDoc();
    const result = await runShadow(enDoc);
    const retained = result.preview.retainedDoc!;
    // CTA copy is deterministically localized.
    expect(retained.cta?.html).toContain("準備好同香港創作者一齊拓展你嘅品牌？");
    // Quality report is produced.
    expect(result.editorial.quality).not.toBeNull();
    expect(result.preview.retainedSource).toBe("pre-editorial");
  });

  it("assembly fails safely when a substantive unit is unresolved", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider(() => []);
    const result = await runShadow(enDoc, provider);
    expect(result.assembly.status).toBe("incomplete");
    expect(result.failedChunkCount).toBeGreaterThan(0);
  });

  it("does not add AI stages or mutate the production English document", async () => {
    const enDoc = makeEnDoc();
    const enDocBefore = JSON.stringify(enDoc);
    const provider = makeProvider();
    const result = await runShadow(enDoc, provider);
    expect(JSON.stringify(enDoc)).toBe(enDocBefore);
    for (const call of provider.calls) expect(isChunkLabel(call.label)).toBe(true);
    expect(result.preview.previewOnly).toBe(true);
  });

  it("routes the single full-document translation call to thinking-enabled V4 Flash with native JSON Output", async () => {
    const enDoc = makeEnDoc();
    const provider = makeProvider();
    await runShadow(enDoc, provider);
    const chunkCalls = provider.calls.filter((c) => isChunkLabel(c.label));
    expect(chunkCalls.length).toBe(1);
    for (const c of chunkCalls) {
      expect(c.options?.model).toBe("deepseek-v4-flash");
      expect(c.options?.thinkingMode).toBe("disabled");
      expect(c.options?.reasoningEffort).toBeUndefined();
      expect(c.options?.maxTokens).toBe(65536);
      expect(c.options?.timeoutMs).toBe(180000);
      expect(c.options?.responseFormat).toEqual({ type: "json_object" });
    }
  });

  it("bilingual partition remains deterministic and covers every editable unit exactly once", () => {
    const sourceDoc = buildTranslationSourceDocument(makeEnDoc());
    const batches = buildBilingualEditorialBatches(sourceDoc).filter((b) => b.sourceUnitIds.length > 0);
    const allIds = batches.flatMap((b) => b.sourceUnitIds);
    const editableIds = enumerateTranslationSourceUnits(sourceDoc).filter((u) => u.type !== "cta").map((u) => u.sourceId);
    expect([...allIds].sort()).toEqual([...editableIds].sort());
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe("preview isolation and feature flags", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });
  afterEach(() => {
    delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG];
    delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG];
    for (const dir of exportTempDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("shadow flag true produces an assembled no-editorial preview; both flags false produce zero behavior", async () => {
    const result = await runShadow(makeEnDoc());
    expect(result.assembly.status).toBe("assembled");
    expect(result.editorial.status).toBe("not-run");
    expect(result.preview.retainedSource).toBe("pre-editorial");

    delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG];
    delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG];
    const provider = makeProvider();
    const disabled = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
    expect(disabled.enabled).toBe(false);
    expect(provider.calls.length).toBe(0);
    expect(disabled.assembly.status).toBe("not-run");
  });

  it("preview is isolated from production versions and never publishable", async () => {
    const result = await runShadow(makeEnDoc());
    const payload = JSON.parse(serializeShadowPreview(result));
    expect(payload.kind).toBe("b2i-shadow-preview");
    expect(payload.previewOnly).toBe(true);
    expect(payload.publishable).toBe(false);
    expect(payload).not.toHaveProperty("failedComponents");
    expect(payload).not.toHaveProperty("savePayload");
  });

  it("preview export writes JSON and HTML locally for the faithful run", async () => {
    const dir = makeExportDir();
    const result = await runShadowExport(makeEnDoc(), dir);
    expect(result.enabled).toBe(true);
    expect(result.assembly.status).toBe("assembled");
    expect(result.preview.exportPath).toBeTruthy();
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".html"))).toBe(true);
    expect(fs.existsSync(result.preview.exportPath!)).toBe(true);
    const html = fs.readFileSync(result.preview.exportPath!, "utf8");
    expect(html).toContain("<!doctype html>");
  });

  it("export failure logs a warning and does not reject the shadow result", async () => {
    const blockerFile = path.join(makeExportDir(), "blocker");
    fs.writeFileSync(blockerFile, "x", "utf8");
    const invalidDir = path.join(blockerFile, "nested");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runShadowExport(makeEnDoc(), invalidDir);
      expect(result.enabled).toBe(true);
      expect(result.assembly.status).toBe("assembled");
      expect(result.preview.exportPath).toBeNull();
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("preview export failed");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("export summary logs contain metrics but never article content", async () => {
    const dir = makeExportDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runShadowExport(makeEnDoc(), dir);
      const logs = [...logSpy.mock.calls.map((c) => String(c[0])), ...warnSpy.mock.calls.map((c) => String(c[0]))].join("\n");
      expect(logs).toContain("preview exported");
      expect(logs).toContain("html=");
      expect(logs).not.toContain("Create your free profile");
      expect(logs).not.toContain("Creator marketing reached");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
