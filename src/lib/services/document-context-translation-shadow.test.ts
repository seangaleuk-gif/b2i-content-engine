import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { DeepSeekError, type ChatMessage } from "@/lib/services/deepseek";
import {
  runDocumentContextTranslationShadow,
  isDocumentContextTranslationShadowEnabled,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  type DocumentContextTranslationShadowResult,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function wordParagraph(id: string, words: number): ArticleDocument["introduction"]["blocks"][number] {
  const sentence = "Creator marketing drives engagement and measurable growth for Hong Kong small businesses across social channels. ";
  const repeats = Math.ceil(words / sentence.trim().split(/\s+/).length);
  return { id, type: "paragraph", content: [{ type: "text", text: sentence.repeat(repeats).trim() }] };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: {
      title: "How Creator Marketing Drives SME Growth in 2026",
      slug: "creator-marketing-sme-growth",
      metaDescription: "Creator marketing helps Hong Kong SMEs grow. Learn ROI, engagement and 6-month results in this guide.",
      excerpt: "A practical guide to creator marketing for Hong Kong SMEs.",
      targetWordCount: 2500,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("intro-0", "Creator marketing reached 65% of SMEs.")], status: "generated" },
    sections: [
      { id: "s0", heading: "Why Creator Marketing Matters", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Creator marketing reaches 65% of SMEs."), paragraphBlock("s0-1", "Budgets above HK$50,000 see faster payback.")], status: "generated" },
      { id: "s1", heading: "Measuring ROI Across Platforms", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "Budgets above HK$50,000 see faster payback.")], status: "generated" },
    ],
    visibleFaq: [
      { question: "How much does creator marketing cost?", answerHtml: "<p>Budgets typically start at HK$20,000.</p>", answerText: "Budgets typically start at HK$20,000." },
    ],
    conclusion: { id: "conc", blocks: [paragraphBlock("conc-0", "Start with a focused campaign.")], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Create your free profile</a></div><!-- /wp:html -->", fingerprint: "cta-fingerprint" },
    faqSchema: null,
    insertedLinks: [],
  };
}

function makeRepresentativeEnDoc(): ArticleDocument {
  const sections = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    heading: `Section ${i + 1} of Creator Marketing`,
    headingLevel: 2 as const,
    sectionType: "main" as const,
    blocks: [0, 1, 2, 3].map((b) => wordParagraph(`s${i}-${b}`, 68)),
    status: "generated" as const,
  }));
  return {
    metadata: {
      title: "The Complete Guide to Creator Marketing for Hong Kong SMEs in 2026",
      slug: "creator-marketing-guide-hong-kong",
      metaDescription: "A complete creator marketing guide for Hong Kong SMEs covering strategy, ROI, engagement and long-term growth.",
      excerpt: "A practical, evidence-based guide to creator marketing for Hong Kong small and medium businesses.",
      targetWordCount: 2800,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [wordParagraph("intro-0", 120), wordParagraph("intro-1", 120)], status: "generated" },
    sections,
    visibleFaq: Array.from({ length: 4 }, (_, i) => ({
      question: `FAQ question number ${i + 1} about creator marketing?`,
      answerHtml: `<p>This is a detailed answer for FAQ ${i + 1} covering budget and expected results.</p>`,
      answerText: `This is a detailed answer for FAQ ${i + 1} covering budget and expected results.`,
    })),
    conclusion: { id: "conc", blocks: [wordParagraph("conc-0", 120), wordParagraph("conc-1", 100)], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Create your free profile</a></div><!-- /wp:html -->", fingerprint: "cta-fingerprint" },
    faqSchema: null,
    insertedLinks: [],
  };
}

function makeSingleChunkDoc(): ArticleDocument {
  return {
    metadata: {
      title: "Single Chunk Title",
      slug: "single-chunk",
      metaDescription: "A single substantive chunk for single-chunk shadow tests in 2026.",
      excerpt: "",
      targetWordCount: 800,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("intro-0", "Introduction text.")], status: "generated" },
    sections: [
      { id: "s0", heading: "One Section", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Section body with 10,000 followers, 65% engagement, HK$50,000 budget and 10-15 posts."), paragraphBlock("s0-1", "More body.")], status: "generated" },
    ],
    visibleFaq: [],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    cta: { id: "cta", type: "cta", html: "<!-- wp:html --><div><a href=\"https://app.b2ihub.com/signup\">Sign up</a></div><!-- /wp:html -->", fingerprint: "cta-fingerprint" },
    faqSchema: null,
    insertedLinks: [],
  };
}

interface ExtractedUnit {  sourceUnitId: string;
  text?: string;
  block?: unknown;
  answerHtml?: string;
  answerText?: string;
}

function extractSourceUnits(userContent: string): ExtractedUnit[] {
  const marker = "SOURCE UNITS (English):";
  const idx = userContent.indexOf(marker);
  const start = idx + marker.length;
  const endMarker = "\n\nReturn the structured JSON";
  const end = userContent.indexOf(endMarker, start);
  const json = userContent.slice(start, end >= 0 ? end : undefined).trim();
  return JSON.parse(json) as ExtractedUnit[];
}

interface MockProvider {
  callProvider: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>;
  calls: Array<{ label: string; userContent: string; systemContent: string; units: ExtractedUnit[] }>;
}

function makeProvider(
  transform?: (units: ExtractedUnit[], label: string) => ExtractedUnit[],
): MockProvider {
  const calls: MockProvider["calls"] = [];
  const callProvider = async (messages: ChatMessage[], _options: Record<string, unknown>, label: string) => {
    const systemContent = messages[0].content;
    const userContent = messages[1].content;
    const units = extractSourceUnits(userContent);
    calls.push({ label, userContent, systemContent, units });
    const resultUnits = transform ? transform(units, label) : units;
    return { content: JSON.stringify({ units: resultUnits }), finishReason: "stop" };
  };
  return { callProvider, calls };
}

describe("document-context translation shadow", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; });

  it("flag false causes zero shadow provider calls", async () => {
    const provider = makeProvider();
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
    expect(result.enabled).toBe(false);
    expect(provider.calls.length).toBe(0);
    expect(result.providerAttemptCount).toBe(0);
    expect(result.substantiveChunkCallCount).toBe(0);
  });

  it("flag false produces a minimal disabled result with no source doc work", async () => {
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result.enabled).toBe(false);
    expect(result.sourceDocumentFingerprint).toBeNull();
    expect(result.planFingerprint).toBeNull();
    expect(result.totalPlannedChunks).toBe(0);
  });

  it("flag true builds the source document and a deterministic chunk plan", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
    expect(result.enabled).toBe(true);
    expect(result.sourceDocumentFingerprint).toBeTruthy();
    expect(result.planFingerprint).toBeTruthy();
    expect(result.totalPlannedChunks).toBeGreaterThan(0);
    expect(result.coverage.wholeDocument.total).toBeGreaterThan(0);
  });

  it("flag true produces a deterministic plan (identical fingerprints across runs)", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const a = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: makeProvider().callProvider });
    const b = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(a.sourceDocumentFingerprint).toBe(b.sourceDocumentFingerprint);
    expect(a.planFingerprint).toBe(b.planFingerprint);
  });

  it("provider calls occur once per substantive chunk and never for protected CTA chunks", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    expect(provider.calls.length).toBe(1); // one substantive chunk (chunk.0)
    expect(result.skippedProtectedChunks).toBe(1); // CTA chunk skipped
    expect(result.substantiveChunkCallCount).toBe(1);
    expect(result.providerAttemptCount).toBe(1);
    expect(provider.calls[0].label).toBe("document-context-shadow-chunk-0");
    // The CTA source unit must not be part of a translated chunk.
    expect(provider.calls[0].units.some((u) => u.sourceUnitId === "cta")).toBe(false);
  });

  it("chunks are called in canonical order", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: provider.callProvider });
    const labels = provider.calls.map((c) => c.label);
    const expected = labels.map((_, index) => `document-context-shadow-chunk-${index}`);
    expect(labels).toEqual(expected);
  });

  it("each prompt contains the document brief, heading outline, English units and stable IDs", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
    const system = provider.calls[0].systemContent;
    const user = provider.calls[0].userContent;
    expect(system).toContain("How Creator Marketing Drives SME Growth in 2026");
    expect(system).toContain("Why Creator Marketing Matters");
    expect(system).toContain("Measuring ROI Across Platforms");
    expect(system).toContain("Hong Kong Cantonese");
    expect(system).toContain("fact-check");
    expect(user).toContain("section.0.heading");
    expect(user).toContain("section.1.block.0");
  });

  it("the single full-document call carries no previous translated context", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: provider.callProvider });
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].userContent).toContain("(none — this is the first chunk)");
  });

  it("accepts mocked valid structured responses", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    expect(result.validChunkCount).toBe(1);
    expect(result.failedChunkCount).toBe(0);
    expect(result.allChunksCompleted).toBe(true);
  });

  it("reports missing, extra, duplicated, reordered and unknown source IDs", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const cases: Array<{ name: string; transform: (units: ExtractedUnit[]) => ExtractedUnit[]; match: (r: DocumentContextTranslationShadowResult) => boolean }> = [
      { name: "missing", transform: (u) => u.slice(1), match: (r) => r.chunkResults[0].missingIds.length > 0 },
      { name: "extra", transform: (u) => [...u, { sourceUnitId: "bogus.id", text: "x" }], match: (r) => r.chunkResults[0].extraIds.length > 0 },
      { name: "duplicated", transform: (u) => [u[0], ...u], match: (r) => r.chunkResults[0].duplicateIds.length > 0 },
      { name: "reordered", transform: (u) => [u[1], u[0], ...u.slice(2)], match: (r) => r.chunkResults[0].reorderedIds.length > 0 },
      { name: "unknown", transform: (u) => u.map((x) => x.sourceUnitId === "metadata.title" ? { ...x, sourceUnitId: "nope.id" } : x), match: (r) => r.chunkResults[0].extraIds.length > 0 || r.contractFailures.length > 0 },
    ];
    for (const c of cases) {
      const provider = makeProvider(c.transform);
      const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
      expect(c.match(result), c.name).toBe(true);
    }
  });

  it("reports number, URL and structure parity failures", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const stripDigits = (s: string): string => s.replace(/\d+/g, "");
    const stripUnit = (u: ExtractedUnit): ExtractedUnit => {
      if (u.block !== undefined) {
        return { ...u, block: JSON.parse(JSON.stringify(u.block).replace(/("text":")[^"]*(")/g, (m, a, b) => `${a}${stripDigits(m.slice(a.length, -b.length))}${b}`)) };
      }
      if (u.answerHtml !== undefined) {
        return { ...u, answerHtml: stripDigits(u.answerHtml), answerText: stripDigits(u.answerText ?? "") };
      }
      if (u.text !== undefined) return { ...u, text: stripDigits(u.text) };
      return u;
    };
    const provider = makeProvider((units) => units.map(stripUnit));
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
    expect(result.protectedParityFailures.length).toBeGreaterThan(0);
    // At least one chunk is partial or failed on number parity.
    expect(result.partialChunkCount + result.failedChunkCount).toBeGreaterThanOrEqual(1);
    expect(result.validChunkCount).toBeLessThan(result.substantiveChunkCallCount);
  });

  it("a provider failure on the single full-document call fails the whole result (no later chunks)", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider((units, label) => {
      if (label === "document-context-shadow-chunk-0") throw new Error("mock failure");
      return units;
    });
    const result = await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: provider.callProvider });
    expect(result.failedChunkCount).toBe(1);
    expect(result.substantiveChunkCallCount).toBe(1);
    expect(result.providerAttemptCount).toBe(1);
    expect(result.validChunkCount).toBe(0);
    expect(result.allChunksCompleted).toBe(false);
  });

  it("provider exceptions and timeouts are caught and reported as failed chunks", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider((_units, label) => {
      if (label === "document-context-shadow-chunk-0") throw new Error("timeout");
      return _units;
    });
    const result = await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: provider.callProvider });
    expect(result.failedChunkCount).toBeGreaterThanOrEqual(1);
    expect(result.allChunksCompleted).toBe(false);
  });

  it("malformed provider JSON is recorded as a failed chunk, not repaired", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const callProvider = async () => ({ content: "not json", finishReason: "stop" });
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider });
    expect(result.failedChunkCount).toBe(1);
    expect(result.validChunkCount).toBe(0);
    expect(result.chunkResults[0].errors.some((e) => /malformed/.test(e))).toBe(true);
  });

  it("the English source document remains byte-equivalent after the shadow", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const enDoc = makeEnDoc();
    const before = JSON.stringify(enDoc);
    await runDocumentContextTranslationShadow(enDoc, { callProvider: makeProvider().callProvider });
    expect(JSON.stringify(enDoc)).toBe(before);
  });

  it("no shadow output is persisted and the result is diagnostic only", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result).not.toHaveProperty("doc");
    expect(result).not.toHaveProperty("blog");
    expect(result).not.toHaveProperty("html");
    expect(result).toHaveProperty("chunkResults");
    expect(result).toHaveProperty("allChunksCompleted");
  });

  it("diagnostic logs exclude full article content", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: makeProvider().callProvider });
      const logs = [...logSpy.mock.calls.map((c) => String(c[0])), ...warnSpy.mock.calls.map((c) => String(c[0]))].join("\n");
      expect(logs).toContain("[document-context-shadow]");
      expect(logs).not.toContain("Creator marketing drives engagement and measurable growth");
      expect(logs).not.toContain("app.b2ihub.com/signup");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("a typical fixture makes exactly one full-document provider call and skips the protected chunk", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    const result = await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: provider.callProvider });
    expect(result.skippedProtectedChunks).toBe(1);
    // The whole document is translated in exactly one provider call.
    expect(result.substantiveChunkCallCount).toBe(1);
    expect(result.providerAttemptCount).toBe(1);
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].label).toBe("document-context-shadow-chunk-0");
  });

  it("attempt metrics include retries reported by the provider", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const callProvider = async () => ({ content: JSON.stringify({ units: [] }), finishReason: "stop", attemptsUsed: 2 });
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider });
    // attemptsUsed 2 means 3 actual provider attempts for the single chunk.
    expect(result.chunkResults[0].attemptCount).toBe(3);
    expect(result.providerAttemptCount).toBe(3);
    expect(result.substantiveChunkCallCount).toBe(1);
  });

  it("perfect substantive coverage is 100% and protected units are reported separately", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const result = await runDocumentContextTranslationShadow(makeRepresentativeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result.validChunkCount).toBe(result.substantiveChunkCallCount);
    expect(result.failedChunkCount).toBe(0);
    const sub = result.coverage.translatedSubstantive;
    const whole = result.coverage.wholeDocument;
    expect(sub.translated).toBe(sub.total);
    // Protected CTA is excluded from the substantive total but counted separately.
    expect(whole.protected).toBe(1);
    expect(whole.translated).toBe(sub.translated);
    expect(whole.unresolved).toBe(0);
    expect(whole.total).toBe(sub.total + whole.protected);
    // Perfect run is 100% of substantive units.
    expect(sub.translated / sub.total).toBe(1);
  });

  it("failed chunks contribute zero validated translated units to coverage", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    // Return no units at all -> every expected unit missing -> the chunk is fully failed.
    const provider = makeProvider(() => []);
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    expect(result.failedChunkCount).toBe(1);
    expect(result.validChunkCount).toBe(0);
    expect(result.coverage.translatedSubstantive.translated).toBe(0);
    expect(result.coverage.translatedSubstantive.total).toBeGreaterThan(0);
    expect(result.coverage.wholeDocument.unresolved).toBe(result.coverage.translatedSubstantive.total);
  });

  it("a chunk with 2 invalid units contributes (total-2) translated and 2 unresolved units", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    // Build a single substantive chunk with a known unit count; drop the last two units.
    const provider = makeProvider((units) => units.slice(0, Math.max(0, units.length - 2)));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    const expectedTotal = chunk.expectedUnitCount;
    // Two missing units -> 2 invalid; the rest valid.
    expect(chunk.valid).toBe(false);
    expect(chunk.partialValid).toBe(true);
    expect(chunk.translatedSourceUnitIds.length).toBe(expectedTotal - 2);
    expect(result.coverage.translatedSubstantive.translated).toBe(expectedTotal - 2);
    expect(result.coverage.wholeDocument.unresolved).toBe(2);
  });

  it("invalid-unit diagnostics contain source ID, English source, returned Chinese and categories", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider((units) => units.slice(0, Math.max(0, units.length - 1)));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    expect(chunk.invalidUnits.length).toBeGreaterThan(0);
    for (const repair of chunk.invalidUnits) {
      expect(repair.sourceUnitId).toBeTruthy();
      expect(repair.sourceUnit.sourceId).toBe(repair.sourceUnitId);
      expect(repair.categories.length).toBeGreaterThan(0);
    }
  });

  it("no full chunk is reported as zero coverage solely because one unit fails", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    // Drop only one unit; the rest stay valid.
    const provider = makeProvider((units) => units.slice(1));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    expect(chunk.partialValid).toBe(true);
    expect(chunk.translatedSourceUnitIds.length).toBe(chunk.expectedUnitCount - 1);
    expect(result.coverage.translatedSubstantive.translated).toBeGreaterThan(0);
  });

  it("coverage numerator is built from returned validated IDs, not the planned chunk size", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: makeProvider().callProvider });
    // For valid chunks the numerator equals the number of returned, validated unit IDs.
    const returnedCount = result.chunkResults
      .filter((c) => c.valid)
      .reduce((sum, c) => sum + new Set(c.translatedSourceUnitIds).size, 0);
    expect(result.coverage.translatedSubstantive.translated).toBe(returnedCount);
  });

  it("truncation with shadow retries disabled produces one failed attempt only", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const callProvider = async () => { throw new DeepSeekError("truncated", "truncated"); };
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider });
    expect(result.failedChunkCount).toBe(1);
    expect(result.chunkResults[0].attemptCount).toBe(1);
    expect(result.chunkResults[0].truncated).toBe(true);
    expect(result.chunkResults[0].categories).toContain("truncation");
  });

  it("detailed chunk errors identify missing IDs and validation categories", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider((units) => units.slice(0, units.length - 2)); // drop last two units
    const result = await runDocumentContextTranslationShadow(makeEnDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    expect(chunk.valid).toBe(false);
    expect(chunk.missingIds.length).toBeGreaterThan(0);
    expect(chunk.expectedUnitCount - chunk.returnedUnitCount).toBeGreaterThan(0);
    expect(chunk.categories).toContain("ID contract");
    expect(chunk.failingUnitIds.length).toBeGreaterThan(0);
  });
  it("flag helper reports the env value deterministically", () => {
    delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG];
    expect(isDocumentContextTranslationShadowEnabled()).toBe(false);
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    expect(isDocumentContextTranslationShadowEnabled()).toBe(true);
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "false";
    expect(isDocumentContextTranslationShadowEnabled()).toBe(false);
  });

  it("10,000, percentages, currency and ranges round-trip exactly through placeholders", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider();
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    expect(chunk.valid).toBe(true);
    const blockUnit = chunk.perUnit.find((u) => u.sourceUnitId === "section.0.block.0");
    expect(blockUnit).toBeDefined();
    expect(blockUnit!.numberParity.lost).toEqual([]);
    expect(blockUnit!.numberParity.extra).toEqual([]);
    // The submitted prompt must contain placeholder tokens, not the raw numbers.
    const user = provider.calls[0].userContent;
    expect(user).toContain("__NUM_0__");
  });

  it("missing number placeholder hard-fails the specific body unit", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const drop = (u: ExtractedUnit): ExtractedUnit => {
      if (u.block === undefined) return u;
      const b = u.block as { id: string; type: string; content: Array<{ type: string; text: string }> };
      return { ...u, block: { ...b, content: b.content.map((n) => ({ ...n, text: n.text.replace(/__NUM_0__/, "") })) } };
    };
    const provider = makeProvider((units) => units.map(drop));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    expect(chunk.valid).toBe(false);
    const blockUnit = chunk.perUnit.find((u) => u.sourceUnitId === "section.0.block.0");
    expect(blockUnit!.valid).toBe(false);
    expect(blockUnit!.missingPlaceholders).toContain("__NUM_0__");
    // Other units remain valid.
    expect(chunk.partialValid).toBe(true);
  });

  it("duplicated number placeholder hard-fails the specific body unit", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const duplicate = (u: ExtractedUnit): ExtractedUnit => {
      if (u.block === undefined) return u;
      const b = u.block as { id: string; type: string; content: Array<{ type: string; text: string }> };
      return { ...u, block: { ...b, content: b.content.map((n) => ({ ...n, text: n.text.replace(/__NUM_0__/, "__NUM_0____NUM_0__") })) } };
    };
    const provider = makeProvider((units) => units.map(duplicate));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    const blockUnit = chunk.perUnit.find((u) => u.sourceUnitId === "section.0.block.0");
    expect(blockUnit!.valid).toBe(false);
    expect(blockUnit!.extraPlaceholders).toContain("__NUM_0__");
  });

  it("empty English excerpt with a numbered Chinese excerpt produces a warning, not a hard failure", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider((units) => units.map((u) => u.sourceUnitId === "metadata.excerpt" ? { ...u, text: "有 10,000 個 followers 嘅摘要" } : u));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    const chunk = result.chunkResults[0];
    expect(chunk.valid).toBe(true);
    const excerpt = chunk.perUnit.find((u) => u.sourceUnitId === "metadata.excerpt");
    expect(excerpt?.advisory).toBe(true);
    expect(excerpt?.warnings.length).toBeGreaterThan(0);
  });

  it("metadata number differences do not invalidate otherwise valid chunks", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    const provider = makeProvider((units) => units.map((u) => u.sourceUnitId === "metadata.metaDescription" ? { ...u, text: "no numbers here" } : u));
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider: provider.callProvider });
    expect(result.chunkResults[0].valid).toBe(true);
    expect(result.validChunkCount).toBe(1);
  });

  it("shadow warnings surface when a top-level failure occurs but never throw", async () => {
    process.env[DOCUMENT_CONTEXT_SHADOW_FLAG] = "true";
    // A throwing provider at every chunk still resolves with a diagnostic result.
    const callProvider = async () => { throw new Error("boom"); };
    const result = await runDocumentContextTranslationShadow(makeSingleChunkDoc(), { callProvider });
    expect(result.failedChunkCount).toBe(1);
    expect(result.allChunksCompleted).toBe(false);
  });
});
