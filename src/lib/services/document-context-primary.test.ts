import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import { translateArticle } from "./translation-service";
import type { ChatMessage } from "@/lib/services/deepseek";
import {
  isDocumentContextTranslationPrimaryEnabled,
  runPrimaryDocumentContextTranslation,
  validatePrimaryDocumentContextResult,
  PrimaryDocumentContextTranslationError,
  DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG,
  type DocumentContextPrimaryFailure,
} from "./document-context-primary";
import type { DocumentContextTranslationShadowResult } from "./document-context-translation-shadow";
import { buildFaqSchemaBlock } from "./document-context-shadow-preview";
import { buildFaqSchemaJson } from "./translation-assembler";
import { hasEnglishHeavyProseBlock, hasExcessiveEnglish } from "./translation-validator";
import { SHADOW_CTA_COPY } from "./shadow-cantonese-quality";
import type { ShadowProviderResponse } from "./shadow-number-protection";

afterEach(() => {
  delete process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG];
  delete process.env.ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW;
  delete process.env.ENABLE_SHADOW_BILINGUAL_EDITORIAL_POLISH;
  delete process.env.DEEPSEEK_API_KEY;
});

// Minimal legacy-pipeline fixtures (mirroring translation-service.test.ts) so the
// flag-false routing test drives the old production path quickly without real AI
// calls. Kept local to avoid importing from another *.test.ts file.
function legacySourceDoc(): ArticleDocument {
  return {
    metadata: { title: "", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
    languageSwitcher: null, introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [], visibleFaq: [],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function legacyMinimalEnHtml(): string {
  return `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span></div><!-- /wp:html -->

<!-- wp:paragraph --><p>Introduction text.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} --><h2>測試一節</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>Section body.</p><!-- /wp:paragraph -->

<!-- b2i-conclusion-start -->
<!-- wp:paragraph --><p>Conclusion.</p><!-- /wp:paragraph -->
<!-- b2i-conclusion-end -->`;
}

function legacyMockHelper(calls: Array<{ componentId: string; componentKind: string }>) {
  return async (opts: { componentId: string; componentKind: string; blocks: Array<{ content: Array<{ type: string; text: string }> }> }) => {
    calls.push({ componentId: opts.componentId, componentKind: opts.componentKind });
    return {
      blocks: opts.blocks.map((b) => ({ ...b, content: b.content.map((n) => (n.type === "link" ? n : { ...n, text: "香港中文內容。" })) })),
      translatedHtml: "",
      passed: true,
      metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 },
    };
  };
}

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Creator Marketing Guide", slug: "creator-marketing-guide", metaDescription: "A guide to creator marketing for Hong Kong brands.", excerpt: "Creator marketing in Hong Kong.", targetWordCount: 1500, focusKeyphrase: "香港創作者市場推廣" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("p0", "Creator marketing reached 65% of SMEs within 6 months.")], status: "generated" },
    sections: [
      { id: "s0", heading: "Why creator marketing matters", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "Influencer marketing campaigns drive follower growth and engagement.")], status: "generated" },
      { id: "s1", heading: "Measuring campaign success", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s1-0", "Track engagement, saves, shares and comments.")], status: "generated" },
    ],
    conclusion: { id: "conc", blocks: [paragraphBlock("c0", "Start with a focused campaign.")], status: "generated" },
    visibleFaq: [
      { question: "What is creator marketing?", answerHtml: "<p>A campaign with 65% engagement.</p>", answerText: "A campaign with 65% engagement." },
    ],
    cta: {
      id: "cta", type: "cta",
      html: "<!-- wp:html --><div style=\"background:#1E3A8A;color:#fff;padding:32px 28px;border-radius:12px;margin:40px 0;text-align:center;\"><h2 style=\"color:#fff;margin-top:0;font-size:22px;\">Ready to grow your brand with Hong Kong creators?</h2><p style=\"font-size:16px;line-height:1.6;margin-bottom:24px;\">B2I Hub connects businesses directly with verified creators \u2014 no agencies, no commissions, no middlemen. Create your free profile today.</p><a href=\"https://app.b2ihub.com/signup\" style=\"display:inline-block;background:#F97316;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;\" target=\"_blank\" rel=\"noopener\">Create your free profile \u2192</a></div><!-- /wp:html -->",
      fingerprint: "cta-fp",
    },
    faqSchema: null,
    insertedLinks: [],
  };
}

interface ExtractedUnit {
  sourceUnitId: string;
  text?: string;
  block?: { content: Array<{ type: string; text: string }> };
  answerHtml?: string;
  answerText?: string;
  html?: string;
}

function extractJsonAfter(userContent: string, marker: string, endMarker: string): unknown {
  const idx = userContent.indexOf(marker);
  const start = idx + marker.length;
  const end = userContent.indexOf(endMarker, start);
  return JSON.parse(userContent.slice(start, end >= 0 ? end : undefined).trim());
}

function toChineseText(s: string): string {
  const masks: string[] = [];
  const masked = s.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; });
  const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
  return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

function toChineseHtml(s: string): string {
  const masks: string[] = [];
  const maskedTags = s.replace(/<[^>]*>/g, (m) => { masks.push(m); return `\u0001${masks.length - 1}\u0001`; });
  const maskedNums = maskedTags.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0002${masks.length - 1}\u0002`; });
  const replaced = maskedNums.replace(/[A-Za-z]+(?![$%])/g, "創");
  return replaced.replace(/\u0001(\d+)\u0001/g, (_m, i) => masks[Number(i)]).replace(/\u0002(\d+)\u0002/g, (_m, i) => masks[Number(i)]);
}

function toChineseUnit(u: ExtractedUnit): ExtractedUnit {
  if (u.block) return { ...u, block: { ...u.block, content: u.block.content.map((n) => (n.type === "link" ? n : { ...n, text: toChineseText(n.text) })) } };
  if (u.answerHtml !== undefined) return { ...u, answerHtml: toChineseHtml(u.answerHtml), answerText: toChineseText(u.answerText ?? "") };
  if (u.text !== undefined) return { ...u, text: toChineseText(u.text) };
  return u;
}

const isEditorialLabel = (label: string): boolean =>
  label === "editorial-bilingual-a" || label === "editorial-bilingual-b" || label === "editorial-monolingual-proofread";

function makeProvider() {
  const labels: string[] = [];
  const optionsByLabel: Record<string, Record<string, unknown>> = {};
  const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    labels.push(label);
    optionsByLabel[label] = options;
    const userContent = messages[1].content;
    if (label === "document-context-editorial-review") {
      // Bounded editorial review: return a `retain` decision for every selected unit.
      const ids = [...userContent.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1]);
      return { content: JSON.stringify(ids.map((id) => ({ sourceUnitId: id, decision: "retain", reasonCodes: [] }))), finishReason: "stop" };
    }
    if (isEditorialLabel(label)) {
      const marker = label === "editorial-monolingual-proofread"
        ? "COMPLETE REVISED CHINESE DOCUMENT UNITS (proofread these; numbers are protected as __NUM_n__ placeholders):"
        : "CURRENT CHINESE CANDIDATE UNITS (current batch, edit these; numbers are protected as __NUM_n__ placeholders):";
      const units = extractJsonAfter(userContent, marker, "\n\nReturn ONLY the units you changed") as ExtractedUnit[];
      return { content: JSON.stringify({ units }), finishReason: "stop" };
    }
    const units = (extractJsonAfter(userContent, "SOURCE UNITS (English):", "\n\nReturn the structured JSON") as ExtractedUnit[]).map(toChineseUnit);
    return { content: JSON.stringify({ units }), finishReason: "stop" };
  };
  return { callProvider, labels, optionsByLabel };
}

function emptyResultForTesting(): DocumentContextTranslationShadowResult {
  return {
    enabled: true, sourceDocumentFingerprint: null, planFingerprint: null,
    totalPlannedChunks: 0, substantiveChunkCallCount: 0, skippedProtectedChunks: 0,
    providerAttemptCount: 0, validChunkCount: 0, partialChunkCount: 0, failedChunkCount: 0,
    chunkResults: [], contractFailures: [], protectedParityFailures: [],
    coverage: { translatedSubstantive: { translated: 0, total: 0 }, wholeDocument: { translated: 0, protected: 0, unresolved: 0, total: 0 } },
    allChunksCompleted: false,
    assembly: { status: "not-run", missingUnits: [], doc: null },
    editorial: { enabled: true, status: "not-run", batchCount: 0, attemptCount: 0, acceptedBatchCount: 0, rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: 0, changedUnitCount: 0, unchangedUnitCount: 0, batches: [], failure: null, preEditorialDoc: null, polishedDoc: null, perUnitValid: 0, perUnitInvalid: 0, tokenUsage: null, invariantFailures: [], quality: null },
    review: { enabled: false, status: "not-run", callCount: 0, selectedUnitIds: [], selectedReasons: [], patches: [], appliedPatchCount: 0, retainedCount: 0, failure: null, diagnostics: [], truncated: false },
    preview: { previewOnly: true, retainedDoc: null, retainedSource: "none", stored: false, exportPath: null, timestamp: "" },
    warnings: [],
      languagePack: { version: "test", retrievedExampleIds: [], retrievalScores: [], exampleCount: 0, promptBudgetChars: 1200, glossaryApplications: 0, critical: 0, major: 0, minor: 0, advisory: 0, resolvedBudgets: { translation: { maxTokens: 65536, timeoutMs: 180000 }, editorial: { maxTokens: 32768, timeoutMs: 180000 } } },
      brandVoice: { version: "test", brandVoiceHash: "", usedDefault: true, styleProfileVersion: "test", hardRuleCount: 0, advisoryRuleCount: 0 },
  };
}

describe("primary-path feature-flag routing", () => {
  it("flag helper reflects the env value", () => {
    delete process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG];
    expect(isDocumentContextTranslationPrimaryEnabled()).toBe(false);
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    expect(isDocumentContextTranslationPrimaryEnabled()).toBe(true);
  });

  it("flag false preserves the old production path and never invokes the primary provider", async () => {
    delete process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG];
    // Fake key so the legacy pipeline's metadata/heading real calls fail fast.
    process.env.DEEPSEEK_API_KEY = "sk-test-mock-helper-orchestration";
    const primaryProvider = makeProvider();
    const oldCalls: Array<{ componentId: string; componentKind: string }> = [];
    const result = await translateArticle(
      legacyMinimalEnHtml(),
      legacySourceDoc(),
      [],
      {
        translateEditorialBlocks: legacyMockHelper(oldCalls) as never,
        documentContextPrimary: { callProvider: primaryProvider.callProvider },
      },
    );
    // The legacy production path ran: at least one expected editorial-block call recorded.
    expect(oldCalls.length).toBeGreaterThan(0);
    expect(oldCalls.some((c) => c.componentKind === "introduction")).toBe(true);
    // No document-context primary chunk or editorial labels were recorded.
    expect(primaryProvider.labels.length).toBe(0);
    expect(result).toBeDefined();
    expect(result.doc).toBeDefined();
  }, 15000);

  it("flag true never invokes the old production provider labels", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    process.env.ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW = "true";
    const provider = makeProvider();
    const result = await translateArticle(renderArticleDocument(makeEnDoc()), makeEnDoc(), [], { documentContextPrimary: { callProvider: provider.callProvider } });
    const oldLabels = ["introduction", "introduction-strict-repair", "section-", "metadata-final", "conclusion", "faq-", "title-parity-repair", "cta", "translate-heading-"];
    for (const label of provider.labels) {
      for (const old of oldLabels) {
        expect(label).not.toContain(old);
      }
    }
    expect(result.failedComponents.length).toBe(0);
  });

  it("flag true makes exactly ONE full-document translation call + ONE editorial review, no editorial calls", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    const provider = makeProvider();
    const result = await translateArticle(renderArticleDocument(makeEnDoc()), makeEnDoc(), [], { documentContextPrimary: { callProvider: provider.callProvider } });
    const editorialCalls = provider.labels.filter(isEditorialLabel);
    const chunkCalls = provider.labels.filter((l) => l.startsWith("document-context-shadow-chunk-"));
    const reviewCalls = provider.labels.filter((l) => l === "document-context-editorial-review");
    // The active zh-HK path is exactly TWO substantive calls: one full-document
    // translation + one bounded editorial review. No legacy editorial calls.
    expect(chunkCalls.length).toBe(1);
    expect(reviewCalls.length).toBe(1);
    expect(editorialCalls.length).toBe(0);
    expect(provider.labels.length).toBe(2);
    expect(result.failedComponents.length).toBe(0);
  });

  it("flag true makes one full-document translation call only (no editorial) for a production-sized fixture", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    const longBody = "Creator marketing is reshaping how Hong Kong brands connect with their audiences, and the results are increasingly hard to ignore.";
    const sections = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`, heading: `Section ${i + 1}`, headingLevel: 2 as const, sectionType: "main" as const,
      blocks: [
        paragraphBlock(`s${i}-0`, longBody),
        paragraphBlock(`s${i}-1`, `${longBody} More body for section ${i + 1} with a 65% figure.`),
        paragraphBlock(`s${i}-2`, `Additional context for section ${i + 1} covering engagement, saves, shares and comments.`),
      ],
      status: "generated" as const,
    }));
    const productionDoc: ArticleDocument = {
      metadata: { title: "Creator Marketing Guide", slug: "creator-marketing-guide", metaDescription: "A guide to creator marketing for Hong Kong brands.", excerpt: "Creator marketing in Hong Kong.", targetWordCount: 2500, focusKeyphrase: "香港創作者市場推廣" },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [paragraphBlock("p0", longBody), paragraphBlock("p1", "Creator marketing reached 65% of SMEs within 6 months.")], status: "generated" },
      sections,
      conclusion: { id: "conc", blocks: [paragraphBlock("c0", longBody)], status: "generated" },
      visibleFaq: Array.from({ length: 6 }, (_, i) => ({
        question: `What is the ${i + 1}th creator marketing best practice?`,
        answerHtml: `<p>Creator marketing best practice number ${i + 1} with 65% engagement.</p>`,
        answerText: `Creator marketing best practice number ${i + 1} with 65% engagement.`,
      })),
      cta: null, faqSchema: null, insertedLinks: [],
    };

    const provider = makeProvider();
    const result = await translateArticle(renderArticleDocument(productionDoc), productionDoc, [], { documentContextPrimary: { callProvider: provider.callProvider } });
    const chunkCalls = provider.labels.filter((l) => l.startsWith("document-context-shadow-chunk-"));
    const editorialCalls = provider.labels.filter(isEditorialLabel);
    const reviewCalls = provider.labels.filter((l) => l === "document-context-editorial-review");
    expect(editorialCalls.length).toBe(0);
    // A production-sized article is translated in one full-document call + one review.
    expect(chunkCalls.length).toBe(1);
    expect(reviewCalls.length).toBe(1);
    expect(provider.labels.length).toBe(2);
    expect(result.failedComponents.length).toBe(0);
  });
});

describe("primary-path two-call model routing", () => {
  async function runWithProvider() {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    process.env.ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW = "true";
    const provider = makeProvider();
    const result = await translateArticle(renderArticleDocument(makeEnDoc()), makeEnDoc(), [], { documentContextPrimary: { callProvider: provider.callProvider } });
    return { provider, result };
  }

  it("makes exactly two provider calls: one full-document translation + one editorial review", async () => {
    const { provider, result } = await runWithProvider();
    const chunkCalls = provider.labels.filter((l) => l.startsWith("document-context-shadow-chunk-"));
    const reviewCalls = provider.labels.filter((l) => l === "document-context-editorial-review");
    expect(chunkCalls.length).toBe(1);
    expect(reviewCalls.length).toBe(1);
    expect(provider.labels.length).toBe(2);
    expect(result.failedComponents.length).toBe(0);
  });

  it("routes the translation call with thinking disabled, 65536 tokens, 180000ms timeout", async () => {
    const { provider } = await runWithProvider();
    const chunkLabel = provider.labels.find((l) => l.startsWith("document-context-shadow-chunk-"))!;
    const opts = provider.optionsByLabel[chunkLabel];
    expect(opts.model).toBe("deepseek-v4-flash");
    expect(opts.thinkingMode).toBe("disabled");
    expect(opts.maxTokens).toBe(65536);
    expect(opts.timeoutMs).toBe(180000);
    expect(opts.maxRetries).toBe(0);
  });

  it("routes the editorial-review call with thinking enabled at medium effort, 65536 tokens, 180000ms", async () => {
    const { provider } = await runWithProvider();
    const opts = provider.optionsByLabel["document-context-editorial-review"];
    expect(opts.model).toBe("deepseek-v4-flash");
    expect(opts.thinkingMode).toBe("enabled");
    expect(opts.reasoningEffort).toBe("medium");
    expect(opts.maxTokens).toBe(65536);
    expect(opts.timeoutMs).toBe(180000);
    expect(opts.maxRetries).toBe(0);
  });
});

describe("primary-path review failure blocks saving", () => {
  it("rejects at stage 'review' with a clear failure when the review call exhausts tokens", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    process.env.ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW = "true";
    const provider = makeProvider();
    const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        // Token exhaustion: finish_reason=length, no usable patch JSON.
        return { content: "", finishReason: "length", truncated: true };
      }
      return provider.callProvider(messages, options, label);
    };
    await expect(
      translateArticle(renderArticleDocument(makeEnDoc()), makeEnDoc(), [], { documentContextPrimary: { callProvider } }),
    ).rejects.toThrow(/review/i);
  });

  it("rejects at stage 'review' when the review returns malformed patches", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    process.env.ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW = "true";
    const provider = makeProvider();
    const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        return { content: "not-json", finishReason: "stop" };
      }
      return provider.callProvider(messages, options, label);
    };
    await expect(
      translateArticle(renderArticleDocument(makeEnDoc()), makeEnDoc(), [], { documentContextPrimary: { callProvider } }),
    ).rejects.toThrow(/review/i);
  });

  it("a failed review never saves the unreviewed translation (save gate rejects)", () => {
    const r = emptyResultForTesting();
    r.assembly = { status: "assembled", missingUnits: [], doc: makeEnDoc() };
    r.allChunksCompleted = true;
    r.coverage = { translatedSubstantive: { translated: 7, total: 7 }, wholeDocument: { translated: 7, protected: 0, unresolved: 0, total: 7 } };
    r.preview = { previewOnly: true, retainedDoc: makeEnDoc(), retainedSource: "polished", stored: false, exportPath: null, timestamp: "" };
    r.review = { enabled: true, status: "failed", callCount: 1, selectedUnitIds: ["conclusion.block.5"], selectedReasons: [], patches: [], appliedPatchCount: 0, retainedCount: 0, failure: "review call truncated", diagnostics: ["truncated review output"], truncated: true };
    const f = validatePrimaryDocumentContextResult(r);
    expect(f).not.toBeNull();
    expect(f!.stage).toBe("review");
  });

  it("a truncated review call is reported as a review-stage failure (no unreviewed save)", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    process.env.ENABLE_DOCUMENT_CONTEXT_TRANSLATION_SHADOW = "true";
    const provider = makeProvider();
    const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
      if (label === "document-context-editorial-review") {
        return { content: JSON.stringify([{ sourceUnitId: "conclusion.block.5", decision: "retain", reasonCodes: [] }]), finishReason: "length", truncated: true };
      }
      return provider.callProvider(messages, options, label);
    };
    await expect(
      translateArticle(renderArticleDocument(makeEnDoc()), makeEnDoc(), [], { documentContextPrimary: { callProvider } }),
    ).rejects.toThrow(/review/i);
  });
});

describe("primary-path save mapping", () => {
  it("maps a fully polished document into a production Chinese save payload", async () => {
    const result = await runPrimaryDocumentContextTranslation(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result.failedComponents.length).toBe(0);
    expect(result.doc).toBeDefined();
    expect(result.doc.metadata.slug).toBe("creator-marketing-guide-zh");
    expect(result.title).toBe(result.doc.metadata.title);
    expect(result.html).toBe(renderArticleDocument(result.doc));
    expect(/[\u3400-\u9fff]/.test(result.doc.metadata.focusKeyphrase)).toBe(true);
    expect(result.zhCharCount).toBeGreaterThan(0);
    expect(result.estimatedReadingMinutes).toBeGreaterThanOrEqual(0);
  });

  it("saves identical visible FAQ and FAQ schema", async () => {
    const result = await runPrimaryDocumentContextTranslation(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result.doc.visibleFaq.length).toBeGreaterThan(0);
    const schema = JSON.parse(buildFaqSchemaJson(result.doc.visibleFaq));
    expect(result.doc.faqSchema).not.toBeNull();
    expect(result.doc.faqSchema!.html).toContain(schema.mainEntity[0].acceptedAnswer.text);
  });

  it("saves Chinese metadata and the localized CTA", async () => {
    const result = await runPrimaryDocumentContextTranslation(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result.doc.metadata.title).toContain("創");
    expect(result.doc.cta!.html).toContain(SHADOW_CTA_COPY.heading);
    expect(result.doc.cta!.html).toContain(SHADOW_CTA_COPY.button);
    expect(result.doc.cta!.html).toContain("https://app.b2ihub.com/signup");
  });

  it("does not save preview-only or debug fields", async () => {
    const result = await runPrimaryDocumentContextTranslation(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect("previewOnly" in result).toBe(false);
    expect("polishedDoc" in result).toBe(false);
    expect("preEditorialDoc" in result).toBe(false);
    expect("preview" in result).toBe(false);
    expect(result.structuredShadowResult).toBeUndefined();
  });
});

describe("primary-path rejection behaviour", () => {
  function makePassingResult(): DocumentContextTranslationShadowResult {
    const r = emptyResultForTesting();
    r.assembly = { status: "assembled", missingUnits: [], doc: makeEnDoc() };
    r.allChunksCompleted = true;
    r.coverage = { translatedSubstantive: { translated: 7, total: 7 }, wholeDocument: { translated: 7, protected: 0, unresolved: 0, total: 7 } };
    r.editorial = { enabled: true, status: "polished", batchCount: 3, attemptCount: 3, acceptedBatchCount: 3, rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: 0, changedUnitCount: 10, unchangedUnitCount: 0, batches: [], failure: null, preEditorialDoc: makeEnDoc(), polishedDoc: makeEnDoc(), perUnitValid: 10, perUnitInvalid: 0, tokenUsage: null, invariantFailures: [], quality: null };
    r.preview = { previewOnly: true, retainedDoc: makeEnDoc(), retainedSource: "polished", stored: false, exportPath: null, timestamp: "" };
    return r;
  }

  function expectFailure(result: DocumentContextTranslationShadowResult): DocumentContextPrimaryFailure {
    const f = validatePrimaryDocumentContextResult(result);
    expect(f).not.toBeNull();
    return f as DocumentContextPrimaryFailure;
  }

  it("the save gate no longer blocks on editorial status (partially-polished accepted)", () => {
    const r = makePassingResult();
    r.editorial.status = "partially-polished";
    r.editorial.acceptedBatchCount = 2;
    // Any residual failure is an independent deterministic check (e.g. faq-parity),
    // never the removed editorial stage.
    expect(validatePrimaryDocumentContextResult(r)?.stage).not.toBe("editorial");
  });

  it("the save gate no longer blocks on editorial status (pre-editorial accepted)", () => {
    const r = makePassingResult();
    r.editorial.status = "pre-editorial";
    r.editorial.acceptedBatchCount = 0;
    expect(validatePrimaryDocumentContextResult(r)?.stage).not.toBe("editorial");
  });

  it("rejects incomplete coverage", () => {
    const r = makePassingResult();
    r.coverage.translatedSubstantive = { translated: 5, total: 7 };
    expect(expectFailure(r).stage).toBe("coverage");
  });

  it("rejects assembly failure", () => {
    const r = makePassingResult();
    r.assembly.status = "incomplete";
    r.assembly.missingUnits = ["section.0.block.0"];
    expect(expectFailure(r).stage).toBe("assembly");
  });

  it("rejects a failed coherent chunk", () => {
    const r = makePassingResult();
    r.failedChunkCount = 1;
    expect(expectFailure(r).stage).toBe("coherent-translation");
  });

  it("rejects a genuine untranslated English paragraph (major) without invoking the old pipeline", async () => {
    const doc = makeEnDoc();
    doc.faqSchema = buildFaqSchemaBlock(doc.visibleFaq);
    (doc.sections[0].blocks[0] as { content: Array<{ type: string; text: string }> }).content[0].text = "Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell marketing content.";
    const r = makePassingResult();
    r.preview.retainedDoc = doc;
    expect(expectFailure(r).stage).toBe("quality");
  });

  it("exposes a clear error with stage and diagnostics on failure (no silent fallback)", () => {
    const r = makePassingResult();
    r.coverage.translatedSubstantive = { translated: 5, total: 7 };
    const f = validatePrimaryDocumentContextResult(r)!;
    const err = new PrimaryDocumentContextTranslationError(f.stage, f.diagnostics);
    expect(err.stage).toBe("coverage");
    expect(err.message).toContain("coverage");
    expect(err.message).toContain("primary translation failed");
  });
});

type ParagraphBlock = { id: string; type: "paragraph"; content: Array<{ type: "text"; text: string }> };

/** A realistic post-quality polished Traditional Chinese document based on the
 *  verified project-19 shadow output, including allowed English terms. */
function makeRealisticZhDoc(): ArticleDocument {
  const ctaHtml = `<!-- wp:html --><div style="background:#1E3A8A;color:#fff;padding:32px 28px;border-radius:12px;margin:40px 0;text-align:center;"><h2 style="color:#fff;margin-top:0;font-size:22px;">${SHADOW_CTA_COPY.heading}</h2><p style="font-size:16px;line-height:1.6;margin-bottom:24px;">${SHADOW_CTA_COPY.body}</p><a href="https://app.b2ihub.com/signup" style="display:inline-block;background:#F97316;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;" target="_blank" rel="noopener">${SHADOW_CTA_COPY.button}</a></div><!-- /wp:html -->`;
  const doc: ArticleDocument = {
    metadata: { title: "點解要同香港創作者市場推廣代理合作？", slug: "creator-marketing-guide-zh", metaDescription: "香港創作者市場推廣指南。", excerpt: "香港創作者市場推廣。", targetWordCount: 1500, focusKeyphrase: "香港創作者市場推廣" },
    languageSwitcher: { id: "sw", type: "language-switcher", html: "<span>English</span> | <a href=\"/blog/creator-marketing-guide-zh\">繁體中文</a>", fingerprint: "sw" },
    introduction: { id: "zh-intro", blocks: [paragraphBlock("p0", "正正因為咁，創作者市場推廣先會喺香港發展得咁快。品牌用 Instagram、YouTube 同 TikTok 等平台，衡量 KPI 同 B2C 成效。")], status: "generated" },
    sections: [
      { id: "zh-s0", heading: "點樣衡量推廣活動成效", headingLevel: 2, sectionType: "main", blocks: [
        paragraphBlock("s0-0", "品牌可以睇互動率、讚好同留言，仲有 YKONE、Open Influence、Assembly、StarNgage 同 Luna 等公司嘅案例。Reel 內容都好受歡迎。"),
        paragraphBlock("s0-1", "資料來源：<a href=\"https://anymindgroup.com/\">Hong Kong Social Media Creator Marketing | AnyMind Group</a>。"),
      ], status: "generated" },
      { id: "zh-s1", heading: "點樣建立長期忠誠度", headingLevel: 2, sectionType: "main", blocks: [
        paragraphBlock("s1-0", "來源：How to Find the Right Influencer Marketing Agency in Hong Kong。"),
        paragraphBlock("s1-1", "當你搵到真正適合嘅合作夥伴，成效自然會反映出嚟。B2I Hub 直接連繫企業同已認證創作者。"),
      ], status: "generated" },
    ],
    conclusion: { id: "zh-conc", blocks: [paragraphBlock("c0", "今日就開始，用自然嘅方式同客戶建立連繫。")], status: "generated" },
    visibleFaq: [
      { question: "咩係創作者市場推廣？", answerHtml: "<p>創作者市場推廣係透過創作者宣傳品牌。</p>", answerText: "創作者市場推廣係透過創作者宣傳品牌。" },
    ],
    cta: { id: "cta", type: "cta", html: ctaHtml, fingerprint: "cta-zh" },
    faqSchema: null,
    insertedLinks: [],
  };
  return doc;
}

function makeResultForDoc(doc: ArticleDocument): DocumentContextTranslationShadowResult {
  const r = emptyResultForTesting();
  r.assembly = { status: "assembled", missingUnits: [], doc };
  r.allChunksCompleted = true;
  r.coverage = { translatedSubstantive: { translated: 3, total: 3 }, wholeDocument: { translated: 3, protected: 0, unresolved: 0, total: 3 } };
    r.editorial = { enabled: true, status: "polished", batchCount: 3, attemptCount: 3, acceptedBatchCount: 3, rejectedBatchCount: 0, providerFailedCount: 0, validationRejectedCount: 0, skippedCount: 0, changedUnitCount: 10, unchangedUnitCount: 0, batches: [], failure: null, preEditorialDoc: makeEnDoc(), polishedDoc: makeEnDoc(), perUnitValid: 10, perUnitInvalid: 0, tokenUsage: null, invariantFailures: [], quality: null };
  doc.faqSchema = buildFaqSchemaBlock(doc.visibleFaq);
  r.preview = { previewOnly: true, retainedDoc: doc, retainedSource: "polished", stored: false, exportPath: null, timestamp: "" };
  return r;
}

describe("primary-path realistic English gate", () => {
  it("accepts a realistic polished Traditional Chinese document with allowed terms", () => {
    const r = makeResultForDoc(makeRealisticZhDoc());
    expect(validatePrimaryDocumentContextResult(r)).toBeNull();
  });

  it("the realistic document's rendered HTML passes both English validators", () => {
    const html = renderArticleDocument(makeRealisticZhDoc());
    expect(hasExcessiveEnglish(html)).toBe(false);
    expect(hasEnglishHeavyProseBlock(html)).toBe(false);
  });

  it("still rejects an all-English section", () => {
    const doc = makeRealisticZhDoc();
    (doc.sections[0].blocks[0] as ParagraphBlock).content[0].text = "Hong Kong brands increasingly value authentic voices because consumers are tired of hard-sell marketing content.";
    expect(validatePrimaryDocumentContextResult(makeResultForDoc(doc))?.stage).toBe("quality");
  });

  it("still rejects a genuinely untranslated English paragraph", () => {
    const doc = makeRealisticZhDoc();
    (doc.conclusion.blocks[0] as ParagraphBlock).content[0].text = "The goal is to spark a reply, not just a like across Instagram and TikTok.";
    expect(validatePrimaryDocumentContextResult(makeResultForDoc(doc))?.stage).toBe("quality");
  });

  it("still rejects a non-citation English-heavy prose block", () => {
    const doc = makeRealisticZhDoc();
    // English-heavy block with no approved-only content, so the quality gate's
    // major classification must reject it.
    (doc.sections[1].blocks[1] as ParagraphBlock).content[0].text = "Brands should measure performance across social platforms over a full six month window before scaling their whole strategy.";
    expect(validatePrimaryDocumentContextResult(makeResultForDoc(doc))?.stage).toBe("quality");
  });

  it("classifies an isolated TikTok-focused occurrence as minor and does not reject", () => {
    const doc = makeRealisticZhDoc();
    (doc.sections[1].blocks[1] as ParagraphBlock).content[0].text = "呢個 TikTok-focused 方案好受歡迎，成效都唔錯。";
    expect(validatePrimaryDocumentContextResult(makeResultForDoc(doc))).toBeNull();
  });

  it("retains minor findings in diagnostics without rejecting or reverting", () => {
    const doc = makeRealisticZhDoc();
    (doc.sections[1].blocks[1] as ParagraphBlock).content[0].text = "呢個 TikTok-focused 方案好受歡迎。";
    const r = makeResultForDoc(doc);
    expect(validatePrimaryDocumentContextResult(r)).toBeNull();
    expect(r.editorial.quality?.minorCount).toBeGreaterThan(0);
    // Minor findings do not count as fatal.
    expect(r.editorial.quality?.criticalCount).toBe(0);
    expect(r.editorial.quality?.majorCount).toBe(0);
  });
});

function makeFailingProvider() {
  const labels: string[] = [];
  const callProvider = async (messages: ChatMessage[], _options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    labels.push(label);
    // A chunk that returns an empty units array → coverage failure → save gate rejects.
    return { content: JSON.stringify({ units: [] }), finishReason: "stop" };
  };
  return { callProvider, labels };
}

describe("primary-path translateArticle failure isolation", () => {
  it("throws PrimaryDocumentContextTranslationError, invokes no old labels, no silent fallback, and leaves the English source unchanged", async () => {
    process.env[DOCUMENT_CONTEXT_TRANSLATION_PRIMARY_FLAG] = "true";
    const enDoc = makeEnDoc();
    const enBefore = JSON.stringify(enDoc);
    const provider = makeFailingProvider();
    await expect(
      translateArticle(renderArticleDocument(enDoc), enDoc, [], { documentContextPrimary: { callProvider: provider.callProvider } }),
    ).rejects.toThrow(PrimaryDocumentContextTranslationError);
    // Only coherent chunk labels were used (no editorial, no old production labels).
    for (const label of provider.labels) {
      expect(label.startsWith("document-context-shadow-chunk-")).toBe(true);
    }
    // No silent fallback and no editorial fail-fast: coverage fails -> throws.
    expect(provider.labels.filter(isEditorialLabel).length).toBe(0);
    // The English source is never mutated.
    expect(JSON.stringify(enDoc)).toBe(enBefore);
  });
});

describe("primary-path compatibility decisions", () => {
  it("derives the Chinese focus keyphrase only on the cloned retained doc, never mutating enDoc", async () => {
    const enDoc = makeEnDoc();
    enDoc.metadata.focusKeyphrase = "creator marketing";
    const enBefore = JSON.stringify(enDoc);
    const result = await runPrimaryDocumentContextTranslation(enDoc, { callProvider: makeProvider().callProvider });
    expect(/[\u3400-\u9fff]/.test(result.doc.metadata.focusKeyphrase)).toBe(true);
    expect(JSON.stringify(enDoc)).toBe(enBefore);
  });

  it("inherits the English language switcher unchanged", async () => {
    const enDoc = makeEnDoc();
    enDoc.languageSwitcher = { id: "sw", type: "language-switcher", html: "<span>English</span> | <a href=\"/blog/creator-marketing-guide-zh\">繁體中文</a>", fingerprint: "sw" };
    const result = await runPrimaryDocumentContextTranslation(enDoc, { callProvider: makeProvider().callProvider });
    expect(result.doc.languageSwitcher?.html).toBe(enDoc.languageSwitcher.html);
  });

  it("returns intentional empty metrics and decision arrays that the save flow does not consume", async () => {
    const result = await runPrimaryDocumentContextTranslation(makeEnDoc(), { callProvider: makeProvider().callProvider });
    expect(result.metrics).toEqual([]);
    expect(result.sourceDecisions).toEqual([]);
    expect(result.internalLinkDecisions).toEqual([]);
  });
});

describe("primary-path no-SQL / no-migration proof", () => {
  it("introduces no SQL statement, DB RPC, migration or schema change in the new primary source", () => {
    const content = fs.readFileSync(path.join(process.cwd(), "src/lib/services/document-context-primary.ts"), "utf8");
    // Actual SQL DDL/DML statements, DB RPC calls and database-repository imports.
    const sql = /CREATE TABLE|ALTER TABLE|INSERT INTO|DELETE FROM|UPDATE [\w"`\[.\]]+\s+SET|CREATE OR REPLACE FUNCTION|\.rpc\(|from\("supabase|blogVersionRepository|createClient/gi;
    expect(sql.test(content)).toBe(false);
  });
});
