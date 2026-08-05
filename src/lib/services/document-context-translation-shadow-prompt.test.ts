import { describe, it, expect } from "vitest";
import {
  buildDocumentContextShadowUserPrompt,
  buildDocumentContextShadowMessages,
  buildShadowEditorialBatchUserPrompt,
  buildShadowMonolingualUserPrompt,
  buildShadowMonolingualSystemPrompt,
} from "./document-context-translation-shadow-prompt";
import { buildAvoidedTerminologyGuidance } from "./zh-hk-style-contract";
import type { TranslationChunk, DocumentBrief } from "./translation-chunk-planner";
import type { TranslationSourceUnit, TranslationSourceDocument } from "./translation-source-document";

const brief: DocumentBrief = {
  englishTitle: "Creator Marketing",
  focusKeyphrase: "creator marketing",
  headingOutline: [],
  articlePurpose: "",
  terminology: [],
  languageRegister: "",
  factualRule: "",
  codeSwitchingRule: "",
  canonicalityRule: "",
};

function emptySourceDoc(): TranslationSourceDocument {
  return {
    metadata: { title: "Creator Marketing", slug: "creator-marketing", metaDescription: "", excerpt: "", focusKeyphrase: "creator marketing", targetWordCount: 0 },
    introduction: [], sections: [], conclusion: [], faq: [], cta: null, insertedLinks: [],
  };
}

const metaUnit = (text: string): TranslationSourceUnit =>
  ({ sourceId: "metadata.title", type: "metadata-title", text, links: [], numbers: [] });

const faqUnit = (answerText: string): TranslationSourceUnit =>
  ({ sourceId: "faq.0.answer", type: "faq-answer", faqIndex: 0, answerHtml: `<p>${answerText}</p>`, answerText, links: [], numbers: [] });

function chunk(units: TranslationSourceUnit[]): TranslationChunk {
  return {
    chunkId: "chunk.0",
    role: "section",
    sourceUnitIds: units.map((u) => u.sourceId),
    units,
    documentBrief: brief,
    previousChunkContext: null,
    expectedOutputStructure: { kind: "translated-unit-list", description: "", fieldsPerUnit: [] },
    maxOutputTokens: 8000,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    fingerprint: "test",
  };
}

describe("terminology guidance delivery into prompts (post-audit)", () => {
  it("monolingual prompt receives the compact avoided→preferred list and the approved-wording instruction", () => {
    const prompt = buildShadowMonolingualUserPrompt([faqUnit("互動率高嘅追蹤群")], "CONSTRAINTS", "", "");
    expect(prompt).toContain("追蹤群 → 粉絲群");
    expect(prompt).toContain("Use the approved preferred wording.");
  });

  it("the approved-wording instruction never appears without real preferred wording", () => {
    // Clean text → empty guidance → no instruction.
    expect(buildAvoidedTerminologyGuidance(["純正自然嘅廣東話"], {})).toBe("");
    // A marker with no single safe replacement (活動廣告板) yields no instruction either.
    expect(buildAvoidedTerminologyGuidance(["呢個係戶外活動廣告板"], {})).toBe("");
  });

  it("translation chunk prompt includes the terminology guidance", () => {
    const prompt = buildDocumentContextShadowUserPrompt(brief, chunk([metaUnit("follower base is key")]), emptySourceDoc(), "");
    expect(prompt).toContain("追蹤群 → 粉絲群");
    expect(prompt).toContain("Use the approved preferred wording.");
  });

  it("bilingual editorial prompt includes terminology relevant to the Chinese candidate units", () => {
    const source = [metaUnit("follower base matters")];
    const candidates = [metaUnit("互動率高嘅追蹤群好重要")];
    const prompt = buildShadowEditorialBatchUserPrompt(source, candidates, "", "");
    expect(prompt).toContain("追蹤群 → 粉絲群");
  });

  it("bilingual editorial prompt omits the guidance when the candidates are clean", () => {
    const source = [metaUnit("follower base matters")];
    const candidates = [metaUnit("互動好重要")];
    const prompt = buildShadowEditorialBatchUserPrompt(source, candidates, "", "");
    expect(prompt).not.toContain("追蹤群 → 粉絲群");
    expect(prompt).not.toContain("Use the approved preferred wording.");
  });

  it("monolingual prompt no longer frames the task as a fast proofread", () => {
    expect(buildShadowMonolingualSystemPrompt()).not.toContain("fast proofread");
  });

  it("monolingual prompt requires truthful reviewed-unchanged accounting with reason codes", () => {
    const system = buildShadowMonolingualSystemPrompt();
    expect(system).toContain("Unchanged units must not appear in units");
    expect(system).toContain("reviewedUnchangedFindings");
    expect(system).toContain("natural-already");
    expect(system).toContain("source-fidelity");
    expect(system).not.toContain("resolvedFindingTokens");
    expect(system).not.toContain("reviewedUnchangedFindingTokens");
    expect(system).toContain("Do not report which findings were resolved");
    const user = buildShadowMonolingualUserPrompt([faqUnit("互動好重要")], "CONSTRAINTS", "", "");
    expect(user).not.toContain("resolvedFindingTokens");
    expect(user).toContain("reviewedUnchangedFindings");
  });
});

function sourceDocWithContent(): TranslationSourceDocument {
  return {
    metadata: { title: "Creator Marketing for Hong Kong SMEs", slug: "creator-marketing-hk", metaDescription: "A guide with 65% ROI.", excerpt: "Practical guide.", focusKeyphrase: "creator marketing", targetWordCount: 1500 },
    introduction: [{ id: "i0", type: "paragraph", content: [{ type: "text", text: "Creator marketing reached 65% of SMEs within 6 months." }] }],
    sections: [
      { heading: "Why it matters", sectionType: "main", blocks: [{ id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Follower growth drives engagement." }] }] },
    ],
    conclusion: [{ id: "c0", type: "paragraph", content: [{ type: "text", text: "Start with a focused campaign." }] }],
    faq: [{ question: "How much?", answerHtml: "<p>Budgets start at HK$20,000.</p>", answerText: "Budgets start at HK$20,000." }],
    cta: null,
    insertedLinks: [],
  };
}

describe("full-article read-only context + silent internal verification (active chunk prompt)", () => {
  it("1. every chunk user prompt carries the complete English article as read-only context", () => {
    const sourceDoc = sourceDocWithContent();
    const prompt = buildDocumentContextShadowUserPrompt(brief, chunk([metaUnit("Creator marketing reached 65% of SMEs within 6 months.")]), sourceDoc, "");
    expect(prompt).toContain("COMPLETE ENGLISH ARTICLE (READ-ONLY CONTEXT ONLY");
    // A distinctive sentence from the full document body is present as context.
    expect(prompt).toContain("Follower growth drives engagement.");
    expect(prompt).toContain("Budgets start at HK$20,000.");
  });

  it("2. the full article is clearly separated from the assigned source units", () => {
    const sourceDoc = sourceDocWithContent();
    const prompt = buildDocumentContextShadowUserPrompt(brief, chunk([metaUnit("follower base is key")]), sourceDoc, "");
    const readOnlyMarker = prompt.indexOf("COMPLETE ENGLISH ARTICLE (READ-ONLY CONTEXT ONLY");
    const assignedMarker = prompt.indexOf("SOURCE UNITS (English):");
    expect(readOnlyMarker).toBeGreaterThanOrEqual(0);
    expect(assignedMarker).toBeGreaterThan(readOnlyMarker);
    expect(prompt).toContain("NEVER translate, return or modify units from this list");
    expect(prompt).toContain("ASSIGNED SOURCE UNITS");
  });

  it("3. the prompt instructs the model to translate ONLY the assigned units", () => {
    const prompt = buildDocumentContextShadowUserPrompt(brief, chunk([metaUnit("follower base is key")]), sourceDocWithContent(), "");
    expect(prompt).toContain("Translate ONLY the ASSIGNED SOURCE UNITS");
    expect(prompt).toContain("Never return, add, modify or translate a unit outside the ASSIGNED set");
  });

  it("4. the prompt requires silent internal verification before output and forbids drafts/notes", () => {
    const prompt = buildDocumentContextShadowUserPrompt(brief, chunk([metaUnit("follower base is key")]), sourceDocWithContent(), "");
    expect(prompt).toContain("SILENT INTERNAL VERIFICATION");
    expect(prompt).toContain("literal English sentence structures");
    expect(prompt).toContain("unnatural Hong Kong Cantonese");
    expect(prompt).toContain("Mainland Chinese terminology");
    expect(prompt).toContain("excessive slang");
    expect(prompt).toContain("formal written-Chinese wording");
    expect(prompt).toContain("terminology inconsistent with the REQUIRED PROJECT GLOSSARY");
    expect(prompt).toContain("untranslated English left in any unit");
    expect(prompt).toContain("weakened or strengthened meaning");
    expect(prompt).toContain("No drafts, explanations, findings, review notes");
  });

  it("the full messages include the read-only article and a single user message", () => {
    const messages = buildDocumentContextShadowMessages(brief, chunk([metaUnit("follower base is key")]), sourceDocWithContent(), "", "");
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("COMPLETE ENGLISH ARTICLE (READ-ONLY CONTEXT ONLY");
  });
});
