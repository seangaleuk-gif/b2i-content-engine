import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { buildTranslationSourceDocument } from "./translation-source-document";
import { buildTranslationChunkPlan } from "./translation-chunk-planner";
import {
  B2I_CANTONESE_LANGUAGE_PACK_VERSION,
  B2I_CANTONESE_TERMINOLOGY,
  B2I_CANTONESE_CANDIDATES,
  B2I_CANTONESE_STYLE_PRINCIPLES,
  retrieveCantoneseExamples,
  buildLanguagePackExamplePrompt,
} from "./b2i-cantonese-language-pack";
import { buildDocumentContextShadowUserPrompt } from "./document-context-translation-shadow-prompt";
import { buildShadowEditorialBatchUserPrompt } from "./document-context-translation-shadow-prompt";
import type { TranslationSourceUnit } from "./translation-source-document";

function makeEnDoc(): ArticleDocument {
  return {
    metadata: { title: "Creator Marketing Guide", slug: "creator-marketing-guide", metaDescription: "A guide.", excerpt: "Creator marketing.", targetWordCount: 1500, focusKeyphrase: "香港創作者市場推廣" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [{ id: "p0", type: "paragraph", content: [{ type: "text", text: "Align campaign goals and find the right match for a beauty brand." }] }], status: "generated" },
    sections: [
      { id: "s0", heading: "Why creator-led marketing matters", headingLevel: 2, sectionType: "main", blocks: [{ id: "s0-0", type: "paragraph", content: [{ type: "text", text: "Creator-led marketing builds long-term loyalty." }] }], status: "generated" },
    ],
    conclusion: { id: "conc", blocks: [{ id: "c0", type: "paragraph", content: [{ type: "text", text: "Keep everyone honest and bring new ideas into new territory." }] }], status: "generated" },
    visibleFaq: [],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

describe("B2I Cantonese language pack", () => {
  it("is versioned and has a small controlled terminology list", () => {
    expect(B2I_CANTONESE_LANGUAGE_PACK_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}\.v\d+$/);
    expect(B2I_CANTONESE_TERMINOLOGY.length).toBeGreaterThan(0);
    expect(B2I_CANTONESE_TERMINOLOGY.length).toBeLessThanOrEqual(10);
    expect(B2I_CANTONESE_STYLE_PRINCIPLES.length).toBeGreaterThan(0);
  });

  it("retrieves relevant approved examples for matching source content", () => {
    const retrieved = retrieveCantoneseExamples("align campaign goals and measure results for the campaign");
    expect(retrieved.some((r) => r.example.id === "align-goals")).toBe(true);
    expect(retrieved.every((r) => r.score > 0)).toBe(true);
  });

  it("does not retrieve unrelated examples", () => {
    const retrieved = retrieveCantoneseExamples("tax filing and accounting compliance procedures");
    expect(retrieved.length).toBe(0);
  });

  it("retrieves relevant examples for each tested concept", () => {
    const cases: Array<[string, string]> = [
      ["align campaign goals and agree on shared objectives", "align-goals"],
      ["how to measure the performance of a campaign", "keep-honest"],
      ["building long-term customer loyalty over time", "build-loyalty"],
      ["a platform-specific strategy for TikTok and Instagram", "platform-content"],
      ["creator-led marketing builds audience trust", "creator-led"],
      ["data-driven decisions guide the strategy", "data-driven"],
    ];
    for (const [source, expectedId] of cases) {
      const retrieved = retrieveCantoneseExamples(source);
      expect(retrieved.some((r) => r.example.id === expectedId), source).toBe(true);
    }
  });

  it("does not retrieve unrelated examples merely for sharing generic words", () => {
    // Only generic overlap (brand/marketing/strategy) -> no relevant example.
    const retrieved = retrieveCantoneseExamples("a brand marketing strategy for the business");
    expect(retrieved.length).toBe(0);
  });

  it("only approved examples are retrievable (raw candidates are never approved)", () => {
    const candidateIds = new Set(B2I_CANTONESE_CANDIDATES.map((c) => c.id));
    expect(B2I_CANTONESE_CANDIDATES.every((c) => c.approved === false)).toBe(true);
    // Retrieval only ever draws from the approved pool.
    const retrieved = retrieveCantoneseExamples("align campaign goals creator-led marketing loyalty");
    for (const r of retrieved) {
      expect(candidateIds.has(r.example.id)).toBe(false);
      expect(r.example.approved).toBe(true);
    }
  });

  it("is deterministic for equal inputs", () => {
    const source = "align campaign goals find the right match";
    expect(retrieveCantoneseExamples(source)).toEqual(retrieveCantoneseExamples(source));
  });

  it("obeys the prompt-size budget and removes duplicate example IDs", () => {
    const many = retrieveCantoneseExamples("align campaign goals campaign creator marketing platform data strategy loyalty brand influence");
    const ids = many.map((r) => r.example.id);
    expect(new Set(ids).size).toBe(ids.length);
    const budgeted = retrieveCantoneseExamples("align campaign goals campaign creator marketing platform data strategy loyalty brand influence", {}, { maxPromptChars: 120 });
    expect(budgeted.length).toBeLessThanOrEqual(many.length);
    expect(budgeted.length).toBeLessThan(6);
  });

  it("builds a compact prompt section listing only retrieved examples", () => {
    const retrieved = retrieveCantoneseExamples("align campaign goals");
    const prompt = buildLanguagePackExamplePrompt(retrieved);
    expect(prompt).toContain(B2I_CANTONESE_LANGUAGE_PACK_VERSION);
    expect(prompt).toContain("align campaign goals");
    // Unrelated content is not in the section.
    const unrelated = buildLanguagePackExamplePrompt(retrieveCantoneseExamples("tax compliance"));
    expect(unrelated).toBe("");
  });

  it("translation prompts receive the relevant style examples", () => {
    const sourceDoc = buildTranslationSourceDocument(makeEnDoc());
    const plan = buildTranslationChunkPlan(sourceDoc);
    const chunk = plan.chunks.find((c) => c.role === "section") ?? plan.chunks[0];
    const retrieved = retrieveCantoneseExamples(chunkSourceTextOf(chunk));
    const prompt = buildDocumentContextShadowUserPrompt(chunk.documentBrief, chunk, sourceDoc, "", buildLanguagePackExamplePrompt(retrieved));
    expect(prompt).toContain("B2I CANTONESE STYLE EXAMPLES");
  });

  it("editorial prompts receive the relevant style examples for their units", () => {
    const units: TranslationSourceUnit[] = [];
    const prompt = buildShadowEditorialBatchUserPrompt(units, units, "", "", "", buildLanguagePackExamplePrompt(retrieveCantoneseExamples("align campaign goals")));
    expect(prompt).toContain("B2I CANTONESE STYLE EXAMPLES");
    expect(prompt).toContain("align campaign goals");
  });
});

// Local helper to serialize a chunk's source text for retrieval (mirrors chunkSourceText).
function chunkSourceTextOf(chunk: { units: TranslationSourceUnit[] }): string {
  return chunk.units.map((unit) => {
    if (unit.type === "faq-answer") return unit.answerText || unit.answerHtml || "";
    if (unit.type === "introduction-block" || unit.type === "section-block" || unit.type === "conclusion-block") {
      const block = unit.block;
      const collect = (nodes: Array<{ text?: string }>): string => nodes.map((n) => n.text ?? "").join(" ");
      if (block.type === "list") return block.items.map(collect).join(" ");
      if (block.type === "table") return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
      return collect(block.content);
    }
    if (unit.type === "cta") return unit.html || "";
    return unit.text || "";
  }).join(" ");
}


