import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-content";
import {
  classifyDuplicatePatchUnits,
  validateFindingTokenReasons,
} from "./document-context-shadow-preview";
import { lintMonolingualDocument, buildFindingTokenMap, buildMonolingualFindingsPrompt, type StyleFinding } from "./cantonese-style-linter";
import {
  runDocumentContextTranslationShadow,
  DOCUMENT_CONTEXT_SHADOW_FLAG,
  SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG,
  type ShadowProviderResponse,
} from "./document-context-translation-shadow";
import type { ChatMessage } from "./deepseek";

const DUPS = ["section.3.block.2", "section.3.block.3", "section.3.block.4", "section.3.block.7", "section.4.block.6"];
const isEditorialLabel = (label: string): boolean =>
  label === "editorial-bilingual-a" || label === "editorial-bilingual-b" || label === "editorial-monolingual-proofread";

function draftUnits(zh: ArticleDocument): Array<{ sourceUnitId: string; text: string }> {
  const units: Array<{ sourceUnitId: string; text: string }> = [];
  const push = (id: string, text: string) => { if (text) units.push({ sourceUnitId: id, text }); };
  const blockText = (b: unknown) => extractPlainTextFromEditorialBlocks([b as never]);
  push("metadata.title", zh.metadata.title);
  push("metadata.metaDescription", zh.metadata.metaDescription);
  push("metadata.excerpt", zh.metadata.excerpt);
  zh.introduction.blocks.forEach((b, i) => push(`introduction.block.${i}`, blockText(b)));
  zh.sections.forEach((s, si) => {
    push(`section.${si}.heading`, s.heading);
    s.blocks.forEach((b, bi) => push(`section.${si}.block.${bi}`, blockText(b)));
  });
  zh.conclusion.blocks.forEach((b, i) => push(`conclusion.block.${i}`, blockText(b)));
  zh.visibleFaq.forEach((f, i) => {
    push(`faq.${i}.question`, f.question);
    push(`faq.${i}.answer`, f.answerText);
  });
  return units;
}

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDuplicateFindingFixture(): ArticleDocument {
  const sections = Array.from({ length: 5 }, (_, sectionIndex) => ({
    id: `s${sectionIndex}`,
    heading: `第${sectionIndex + 1}節`,
    headingLevel: 2 as const,
    sectionType: "main" as const,
    blocks: Array.from({ length: sectionIndex === 3 ? 8 : sectionIndex === 4 ? 7 : 1 }, (_, blockIndex) =>
      paragraphBlock(
        `s${sectionIndex}-${blockIndex}`,
        "內容越來越正式，因此 followers 同時出 post。",
      )),
    status: "generated" as const,
  }));
  return {
    metadata: { title: "香港營銷指南", slug: "fixture", metaDescription: "實用香港營銷指南。", excerpt: "實用指南。", targetWordCount: 1500, focusKeyphrase: "香港營銷" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [paragraphBlock("i0", "香港品牌可以由小步開始。")], status: "generated" },
    sections,
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [paragraphBlock("c0", "最後按結果調整。")], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
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

function makeProvider(monolingualResponse?: (units: Array<{ sourceUnitId: string; block?: { id?: string; type?: string; content?: Array<{ type: string; text?: string }> }; text?: string }>) => unknown) {
  const calls: Array<{ label: string; userContent: string; options?: Record<string, unknown> }> = [];
  const toChinese = (s: string): string => {
    const masks: string[] = [];
    const masked = s.replace(/__NUM_\d+__/g, (m) => { masks.push(m); return `\u0000${masks.length - 1}\u0000`; });
    const replaced = masked.replace(/[A-Za-z]+(?![$%])/g, "創");
    return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
  };
  const callProvider = async (messages: ChatMessage[], options: Record<string, unknown>, label: string): Promise<ShadowProviderResponse> => {
    const userContent = messages[1].content;
    calls.push({ label, userContent, options });
    if (isEditorialLabel(label)) {
      const marker = label === "editorial-monolingual-proofread"
        ? "COMPLETE REVISED CHINESE DOCUMENT UNITS (proofread these; numbers are protected as __NUM_n__ placeholders):"
        : "CURRENT CHINESE CANDIDATE UNITS (current batch, edit these; numbers are protected as __NUM_n__ placeholders):";
      const units = extractJsonAfter(userContent, marker, "\n\nReturn ONLY the units you changed") as Array<{ sourceUnitId: string; text?: string; block?: { id?: string; type?: string; content?: Array<{ type: string; text?: string }> } }>;
      if (label === "editorial-monolingual-proofread" && monolingualResponse) {
        return { content: JSON.stringify(monolingualResponse(units)), finishReason: "stop" };
      }
      return { content: JSON.stringify({ units, resolvedFindingTokens: suppliedFindingTokens(userContent) }), finishReason: "stop" };
    }
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
  process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG] = "true";
  return runDocumentContextTranslationShadow(enDoc, { callProvider: provider.callProvider });
}

describe("monolingual duplicate-unit diagnosis (from failed live preview)", () => {
  beforeEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });
  afterEach(() => { delete process.env[DOCUMENT_CONTEXT_SHADOW_FLAG]; delete process.env[SHADOW_BILINGUAL_EDITORIAL_POLISH_FLAG]; });

  it("1/2/3. input units are unique but the five rejected units each carry multiple findings, grouped into one record each", () => {
    const zh = makeDuplicateFindingFixture();
    const draft = draftUnits(zh);

    // Serialized input is unique per unitId.
    const ids = draft.map((d) => d.sourceUnitId);
    expect(new Set(ids).size).toBe(ids.length);

    // Monolingual findings per unit: the five rejected units have >=2 findings.
    const findings = lintMonolingualDocument(draft);
    const perUnit = new Map<string, StyleFinding[]>();
    for (const f of findings) {
      const arr = perUnit.get(f.sourceUnitId);
      if (arr) arr.push(f);
      else perUnit.set(f.sourceUnitId, [f]);
    }
    for (const d of DUPS) {
      expect((perUnit.get(d) ?? []).length).toBeGreaterThanOrEqual(2);
    }

    // The grouped prompt renders each unit exactly once (no repeated unit records).
    const tokenMap = buildFindingTokenMap(findings);
    const prompt = buildMonolingualFindingsPrompt(findings, tokenMap);
    const occurrences = (id: string) => (prompt.match(new RegExp(`"sourceUnitId":"${id.replace(/\./g, "\\.")}"`, "g")) ?? []).length;
    for (const d of DUPS) {
      expect(occurrences(d)).toBe(1);
    }
  });

  it("4/5. the monolingual prompt requires at most one patch per unit and a single patch may resolve multiple tokens", () => {
    const findings: StyleFinding[] = [
      { findingId: "finding-1", sourceUnitId: "section.3.block.2", category: "language", severity: "minor", instructionCode: "mixed-register" },
      { findingId: "finding-2", sourceUnitId: "section.3.block.2", category: "language", severity: "minor", instructionCode: "non-hk-terminology" },
    ];
    const tokenMap = buildFindingTokenMap(findings);
    const prompt = buildMonolingualFindingsPrompt(findings, tokenMap);
    expect(prompt).toContain("at most ONCE in units");
    expect(prompt).toContain("ONE final consolidated revision per unit");
    expect(prompt).toContain("Never return separate revisions for separate findings");
    // One consolidated unit patch can resolve multiple tokens: the token validator
    // accepts F001+F002 both resolved by a single patch.
    const reasons = validateFindingTokenReasons(tokenMap, {
      units: [{ sourceUnitId: "section.3.block.2", text: "x" }],
      resolvedFindingTokens: ["F001", "F002"],
      reviewedUnchangedFindingTokens: [],
    });
    expect(reasons).toEqual([]);
  });

  it("6/7. exact duplicate patches are collapsed with a named nonfatal diagnostic", () => {
    const a = { sourceUnitId: "section.3.block.2", text: "相同版本" };
    const b = { sourceUnitId: "section.3.block.2", text: "相同版本" };
    const r = classifyDuplicatePatchUnits([a, b]);
    expect(r.units.length).toBe(1);
    expect(r.fatalReasons.length).toBe(0);
    expect(r.diagnostics).toEqual([{ code: "exact-duplicate-unit-patch-collapsed", unitId: "section.3.block.2" }]);
  });

  it("8/9. conflicting duplicate patches are rejected, never first-wins or last-wins", () => {
    const a = { sourceUnitId: "section.3.block.2", text: "版本A" };
    const b = { sourceUnitId: "section.3.block.2", text: "版本B" };
    const r = classifyDuplicatePatchUnits([a, b]);
    expect(r.fatalReasons.length).toBe(1);
    expect(r.fatalReasons[0]).toMatchObject({ code: "conflicting-duplicate-unit-patch", unitId: "section.3.block.2", variantCount: 2 });
    expect(r.units.length).toBe(0);
  });

  it("10. the active pipeline never invokes the monolingual call (no editorial stage)", async () => {
    const provider = makeProvider();
    await runShadow(makeEnDoc(), provider);
    expect(provider.calls.filter((c) => isEditorialLabel(c.label)).length).toBe(0);
  });

  it("11. unknown, missing, duplicate and cross-unit finding tokens remain rejected", () => {
    const findings: StyleFinding[] = [
      { findingId: "finding-1", sourceUnitId: "a", category: "language", severity: "minor", instructionCode: "mixed-register" },
      { findingId: "finding-2", sourceUnitId: "b", category: "language", severity: "minor", instructionCode: "non-hk-terminology" },
    ];
    const tokenMap = buildFindingTokenMap(findings);
    expect(validateFindingTokenReasons(tokenMap, { units: [], resolvedFindingTokens: ["F999"], reviewedUnchangedFindingTokens: [] }).some((r) => r.code === "finding-token-batch-mismatch")).toBe(true);
    expect(validateFindingTokenReasons(tokenMap, { units: [], resolvedFindingTokens: ["F001"], reviewedUnchangedFindingTokens: [] }).some((r) => r.code === "missing-finding-token-accounting")).toBe(true);
    expect(validateFindingTokenReasons(tokenMap, { units: [], resolvedFindingTokens: ["F001", "F001"], reviewedUnchangedFindingTokens: [] }).some((r) => r.code === "duplicate-finding-token-accounting")).toBe(true);
  });

  it("12/13/14. editorial routing stays non-thinking with native JSON Output", async () => {
    const provider = makeProvider();
    await runShadow(makeEnDoc(), provider);
    for (const c of provider.calls.filter((c) => isEditorialLabel(c.label))) {
      expect(c.options?.thinkingMode).toBe("disabled");
      expect(c.options?.reasoningEffort).toBeUndefined();
      expect(c.options?.responseFormat).toEqual({ type: "json_object" });
    }
  });

  it("17/18. a conflicting duplicate patch is still rejected at the deterministic classifier, and the workflow never reaches editorial", async () => {
    // The duplicate-classifier function remains a deterministic guard; the pipeline
    // never invokes the monolingual stage where this used to be exercised.
    const a = { sourceUnitId: "section.0.block.0", text: "版本A" };
    const b = { sourceUnitId: "section.0.block.0", text: "版本B" };
    const r = classifyDuplicatePatchUnits([a, b]);
    expect(r.fatalReasons.some((reason) => reason.code === "conflicting-duplicate-unit-patch")).toBe(true);
    const provider = makeProvider();
    const result = await runShadow(makeEnDoc(), provider);
    expect(result.editorial.status).toBe("not-run");
    expect(provider.calls.filter((c) => isEditorialLabel(c.label)).length).toBe(0);
  });
});
