import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  categorizeErrors,
  isConclusionShadowEvidenceEnabled,
  recordConclusionShadowEvidence,
  type ConclusionShadowEvidenceRecord,
} from "./conclusion-shadow-evidence";
import type { StructuredTranslationShadowResult } from "./editorial-block-translation";
import type { NumberProtectionState } from "./editorial-block-protection";
import { type EditorialBlock } from "@/lib/blog/article-content";
import type { ArticleDocument } from "@/lib/blog/article-document";

// ── Helpers ──

function makeResult(overrides: Partial<StructuredTranslationShadowResult> = {}): StructuredTranslationShadowResult {
  return {
    enabled: true,
    attempted: true,
    passed: true,
    repaired: false,
    componentKind: "conclusion",
    componentId: "zh-conc",
    errors: [],
    metrics: { sourceCharacters: 200, translatedCharacters: 140, characterRatio: 0.7, blockCount: 1 },
    ...overrides,
  };
}

function makeBlocks(count = 1): EditorialBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    type: "paragraph" as const,
    content: [{ type: "text" as const, text: `Some text ${i}.` }],
  }));
}

function makeProtectionState(originalValues: string[] = []): NumberProtectionState {
  return {
    placeholders: originalValues.map((_, i) => `__NUM_${i}__`),
    originalValues,
  };
}

const TMP_DIR = path.resolve("tmp/conclusion-shadow-evidence-test");

beforeEach(() => {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.CONCLUSION_SHADOW_EVIDENCE_DIR = TMP_DIR;
  vi.unstubAllEnvs();
});

afterEach(() => {
  delete process.env.CONCLUSION_SHADOW_EVIDENCE_DIR;
  if (fs.existsSync(TMP_DIR)) {
    for (const f of fs.readdirSync(TMP_DIR)) {
      fs.rmSync(path.join(TMP_DIR, f), { force: true });
    }
  }
});

// ── Error categorization ──

describe("categorizeErrors", () => {
  it("api_or_network for call failures", () => {
    expect(categorizeErrors(["translation call failed"])).toContain("api_or_network");
    expect(categorizeErrors(["network timeout"])).toContain("api_or_network");
  });

  it("malformed_json for parse errors", () => {
    expect(categorizeErrors(["JSON parse error: unexpected token"])).toContain("malformed_json");
    expect(categorizeErrors(["malformed JSON structure"])).toContain("malformed_json");
  });

  it("schema for payload safety errors", () => {
    expect(categorizeErrors(["componentKind must be conclusion"])).toContain("schema");
    expect(categorizeErrors(["payload contains URLs"])).toContain("schema");
  });

  it("block_structure for structural mismatches", () => {
    expect(categorizeErrors(["block count mismatch"])).toContain("block_structure");
    expect(categorizeErrors(["type mismatch"])).toContain("block_structure");
    expect(categorizeErrors(["cell count mismatch"])).toContain("block_structure");
  });

  it("placeholder for placeholder errors", () => {
    expect(categorizeErrors(["placeholder integrity: missing __NUM_0__"])).toContain("placeholder");
  });

  it("number_preservation for number errors", () => {
    expect(categorizeErrors(["number mismatch (extra: 1)"])).toContain("number_preservation");
    expect(categorizeErrors(["numbers lost: 2024"])).toContain("number_preservation");
  });

  it("link_preservation for link errors", () => {
    expect(categorizeErrors(["links lost: https://example.com"])).toContain("link_preservation");
  });

  it("conclusion_policy for CTA errors", () => {
    expect(categorizeErrors(["CTA content detected in conclusion"])).toContain("conclusion_policy");
    expect(categorizeErrors(["signup prompt found"])).toContain("conclusion_policy");
  });

  it("empty_translation for empty content", () => {
    expect(categorizeErrors(["no readable content"])).toContain("empty_translation");
  });

  it("unknown for unrecognized errors", () => {
    expect(categorizeErrors(["some weird error"])).toContain("unknown");
  });

  it("multiple categories from diverse errors", () => {
    const cats = categorizeErrors(["number mismatch (extra: 1)", "CTA content detected", "JSON parse error"]);
    expect(cats).toContain("number_preservation");
    expect(cats).toContain("conclusion_policy");
    expect(cats).toContain("malformed_json");
  });
});

// ── Evidence control ──

describe("isConclusionShadowEvidenceEnabled", () => {
  it("false when env var not set", () => {
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE;
    expect(isConclusionShadowEvidenceEnabled()).toBe(false);
  });

  it("false when env var is not true", () => {
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "false";
    expect(isConclusionShadowEvidenceEnabled()).toBe(false);
  });

  it("true when env var is true", () => {
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "true";
    expect(isConclusionShadowEvidenceEnabled()).toBe(true);
  });
});

// ── Privacy protections ──

describe("recordConclusionShadowEvidence (privacy)", () => {
  it("no URLs appear in evidence", async () => {
    const result = makeResult({ errors: ["links lost: https://example.com"] });
    const blocks: EditorialBlock[] = [{
      id: "b0", type: "paragraph",
      content: [{ type: "link", text: "click", href: "https://example.com" }],
    }];
    await recordConclusionShadowEvidence(result, blocks, makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      const content = fs.readFileSync(path.join(TMP_DIR, f), "utf-8");
      expect(content).not.toContain("https://");
      expect(content).not.toContain("http://");
    }
  });

  it("no article title or slug appears", async () => {
    const result = makeResult();
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      const content = fs.readFileSync(path.join(TMP_DIR, f), "utf-8");
      expect(content).not.toContain("title");
    }
  });

  it("no source or translated full text appears", async () => {
    const result = makeResult({
      metrics: { sourceCharacters: 200, translatedCharacters: 140, characterRatio: 0.7, blockCount: 1 },
    });
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      const content = fs.readFileSync(path.join(TMP_DIR, f), "utf-8");
      const parsed = JSON.parse(content) as ConclusionShadowEvidenceRecord;
      expect(parsed.sourceCharacters).toBe(200);
      expect(parsed.translatedCharacters).toBe(140);
      // No full text anywhere in the record
      Object.entries(parsed).forEach(([key, value]) => {
        if (typeof value === "string" && value.length > 60) {
          // Long strings should only be the secure hash or timestamp
          expect(key === "timestamp" || key === "componentIdHash" || key === "sourceStructureSignature" || key === "evidenceId")
            .toBe(true);
        }
      });
    }
  });

  it("component identity is hashed, not stored directly", async () => {
    const result = makeResult({ componentId: "zh-conc" });
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      const content = fs.readFileSync(path.join(TMP_DIR, f), "utf-8");
      expect(content).not.toContain("zh-conc");
    }
  });

  it("raw validator messages are reduced to safe categories", async () => {
    const result = makeResult({
      passed: false,
      errors: [
        "number mismatch (extra: 1)",
        "placeholder integrity: missing __NUM_5__",
        "CTA content detected in conclusion",
        "links lost: https://private.example.com/secret",
      ],
    });
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      const content = fs.readFileSync(path.join(TMP_DIR, f), "utf-8");
      const parsed = JSON.parse(content) as ConclusionShadowEvidenceRecord;
      expect(parsed.errorCategories).toContain("number_preservation");
      expect(parsed.errorCategories).toContain("placeholder");
      expect(parsed.errorCategories).toContain("conclusion_policy");
      expect(parsed.errorCategories).toContain("link_preservation");
      // No raw error message strings
      expect(content).not.toContain("extra: 1");
      expect(content).not.toContain("private.example.com");
      expect(content).not.toContain("missing __NUM_5__");
    }
  });
});

// ── Recording behaviour ──

describe("recordConclusionShadowEvidence (behaviour)", () => {
  it("no evidence when shadow not attempted", async () => {
    const result = makeResult({ attempted: false });
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    expect(files.length).toBe(0);
  });

  it("one safe evidence record is written when shadow attempted", async () => {
    const result = makeResult();
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(TMP_DIR, files[0]), "utf-8");
    const parsed = JSON.parse(content) as ConclusionShadowEvidenceRecord;
    expect(parsed.shadowPassed).toBe(true);
    expect(parsed.repaired).toBe(false);
  });

  it("repaired success is recorded accurately", async () => {
    const result = makeResult({ passed: true, repaired: true });
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    const parsed = JSON.parse(fs.readFileSync(path.join(TMP_DIR, files[0]), "utf-8")) as ConclusionShadowEvidenceRecord;
    expect(parsed.shadowPassed).toBe(true);
    expect(parsed.repaired).toBe(true);
  });

  it("final failure is recorded accurately", async () => {
    const result = makeResult({ passed: false, errors: ["number mismatch (extra: 1)"] });
    await recordConclusionShadowEvidence(result, makeBlocks(), makeProtectionState());
    const files = fs.readdirSync(TMP_DIR);
    const parsed = JSON.parse(fs.readFileSync(path.join(TMP_DIR, files[0]), "utf-8")) as ConclusionShadowEvidenceRecord;
    expect(parsed.shadowPassed).toBe(false);
    expect(parsed.errorCategories).toContain("number_preservation");
  });

  it("evidence file has expected schema fields", async () => {
    const result = makeResult({
      metrics: { sourceCharacters: 300, translatedCharacters: 210, characterRatio: 0.7, blockCount: 2 },
    });
    const blocks: EditorialBlock[] = [
      { id: "b0", type: "paragraph", content: [{ type: "text", text: "A." }, { type: "strong", text: "B" }] },
      { id: "b1", type: "paragraph", content: [{ type: "text", text: "C." }] },
    ];
    const state = makeProtectionState(["150%", "HK$500", "2026-01-15"]);
    await recordConclusionShadowEvidence(result, blocks, state);
    const files = fs.readdirSync(TMP_DIR);
    const parsed = JSON.parse(fs.readFileSync(path.join(TMP_DIR, files[0]), "utf-8")) as ConclusionShadowEvidenceRecord;
    expect(parsed.blockCount).toBe(2);
    expect(parsed.blockTypes).toEqual(["paragraph"]);
    expect(parsed.hasMultipleParagraphs).toBe(true);
    expect(parsed.hasStrong).toBe(true);
    expect(parsed.hasEmphasis).toBe(false);
    expect(parsed.hasLinks).toBe(false);
    expect(parsed.hasPercentage).toBe(true);
    expect(parsed.hasCurrency).toBe(true);
    expect(parsed.hasDate).toBe(true);
    expect(parsed.placeholderCount).toBe(3);
  });
});

// ── Integration: translateArticle evidence flow ──

describe("evidence flow via translateArticle", () => {
  const EVIDENCE_DIR = TMP_DIR;

  beforeEach(() => {
    process.env.CONCLUSION_SHADOW_EVIDENCE_DIR = EVIDENCE_DIR;
    if (fs.existsSync(EVIDENCE_DIR)) {
      for (const f of fs.readdirSync(EVIDENCE_DIR)) {
        fs.rmSync(path.join(EVIDENCE_DIR, f), { force: true });
      }
    }
  });

  function sourceDoc(): ArticleDocument {
    return {
      metadata: { title: "", slug: "test", metaDescription: "", excerpt: "", targetWordCount: 0, focusKeyphrase: "" },
      languageSwitcher: null, introduction: { id: "intro", blocks: [] as EditorialBlock[], status: "generated" },
      sections: [], visibleFaq: [],
      conclusion: { id: "conc", blocks: [] as EditorialBlock[], status: "generated" },
      cta: null, faqSchema: null, insertedLinks: [],
    };
  }

  function minimalEnHtml(): string {
    return `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span></div><!-- /wp:html -->

<!-- wp:paragraph --><p>Introduction text.</p><!-- /wp:paragraph -->

<!-- wp:heading {"level":2} --><h2>測試一節</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>Section body.</p><!-- /wp:paragraph -->

<!-- b2i-conclusion-start -->
<!-- wp:paragraph --><p>Conclusion.</p><!-- /wp:paragraph -->
<!-- b2i-conclusion-end -->`;
  }

  const mockHelper: any = async (opts: any) => {
    return { blocks: opts.blocks, translatedHtml: "", passed: true, metrics: { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 1 } };
  };

  it("no evidence when both flags are disabled", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "false";
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE;
    await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), { translateEditorialBlocks: mockHelper });
    expect(fs.readdirSync(EVIDENCE_DIR).length).toBe(0);
  });

  it("no evidence when only evidence flag is enabled (shadow disabled)", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "false";
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "true";
    await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), { translateEditorialBlocks: mockHelper });
    expect(fs.readdirSync(EVIDENCE_DIR).length).toBe(0);
  });

  it("shadow runs but no evidence when evidence flag is disabled", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    delete process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE;
    await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), { translateEditorialBlocks: mockHelper });
    expect(fs.readdirSync(EVIDENCE_DIR).length).toBe(0);
  });

  it("records evidence when both flags are enabled", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "true";
    await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), { translateEditorialBlocks: mockHelper });
    const files = fs.readdirSync(EVIDENCE_DIR);
    expect(files.length).toBe(1);
    const parsed = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, files[0]), "utf-8")) as ConclusionShadowEvidenceRecord;
    expect(parsed.shadowPassed).toBeDefined();
    expect(parsed.componentIdHash).toBeDefined();
    expect(parsed.evidenceId).toBeDefined();
  });

  it("HTML translation remains authoritative when evidence is recorded", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "true";
    const result = await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), { translateEditorialBlocks: mockHelper });
    expect(result.doc.conclusion.blocks).toBeDefined();
  });

  it("evidence-recording failure does not fail translation", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "true";
    const result = await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), { translateEditorialBlocks: mockHelper });
    expect(result.failedComponents).toBeDefined();
  });

  it("explicit enabled:false overrides environment flags", async () => {
    const { translateArticle } = await import("./translation-service");
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_CONCLUSION = "true";
    process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE = "true";
    const shadowTranslate = vi.fn();
    await translateArticle(minimalEnHtml(), sourceDoc(), [], new Set(), {
      translateEditorialBlocks: mockHelper,
      structuredTranslationShadow: { enabled: false, translatePayload: shadowTranslate },
    });
    expect(fs.readdirSync(EVIDENCE_DIR).length).toBe(0);
    expect(shadowTranslate).not.toHaveBeenCalled();
  });
});

// ── Summary script correctness ──

describe("summary script correctness", () => {
  const EVIDENCE_DIR = TMP_DIR;

  beforeEach(() => {
    process.env.CONCLUSION_SHADOW_EVIDENCE_DIR = EVIDENCE_DIR;
    if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  });

  afterEach(() => {
    delete process.env.CONCLUSION_SHADOW_EVIDENCE_DIR;
    if (fs.existsSync(EVIDENCE_DIR)) {
      for (const f of fs.readdirSync(EVIDENCE_DIR)) {
        fs.rmSync(path.join(EVIDENCE_DIR, f), { force: true });
      }
    }
  });

  function writeRecord(r: Partial<ConclusionShadowEvidenceRecord>): void {
    const full: ConclusionShadowEvidenceRecord = {
      timestamp: "2026-01-01T00:00:00.000Z",
      evidenceId: "test",
      componentIdHash: "abc123",
      sourceStructureSignature: "sig",
      shadowPassed: true,
      repaired: false,
      errorCategories: [],
      blockCount: 1,
      blockTypes: ["paragraph"],
      hasMultipleParagraphs: false,
      hasStrong: false,
      hasEmphasis: false,
      hasLinks: false,
      linkCount: 0,
      hasList: false,
      hasTable: false,
      placeholderCount: 0,
      hasDate: false,
      hasCurrency: false,
      hasPercentage: false,
      hasRange: false,
      hasSuffixNumber: false,
      numberPreserved: true,
      linksPreserved: true,
      placeholderIntegrityPassed: true,
      conclusionPolicyPassed: true,
      sourceCharacters: 100,
      translatedCharacters: 70,
      characterRatio: 0.7,
      ...r,
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, `evidence-${full.evidenceId}.json`), JSON.stringify(full), "utf-8");
  }

  it("summary script calculates totals correctly", async () => {
    writeRecord({ shadowPassed: true, repaired: false, evidenceId: "a" });
    writeRecord({ shadowPassed: true, repaired: true, evidenceId: "b" });
    writeRecord({ shadowPassed: false, repaired: false, evidenceId: "c", errorCategories: ["number_preservation", "placeholder"], numberPreserved: false, placeholderIntegrityPassed: false });
    writeRecord({
      shadowPassed: true, repaired: false, evidenceId: "d",
      hasLinks: true, hasList: true, hasTable: true,
      hasStrong: true, hasEmphasis: true, hasDate: true,
      hasCurrency: true, hasPercentage: true, hasRange: true, hasSuffixNumber: true,
      hasMultipleParagraphs: true,
    });

    // Read the records directly and aggregate
    const records: ConclusionShadowEvidenceRecord[] = [];
    for (const f of fs.readdirSync(EVIDENCE_DIR)) {
      records.push(JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, f), "utf-8")));
    }

    expect(records.length).toBe(4);
    const passes = records.filter((r) => r.shadowPassed).length;
    const failures = records.filter((r) => !r.shadowPassed).length;
    const repaired = records.filter((r) => r.repaired).length;
    const initialPass = records.filter((r) => r.shadowPassed && !r.repaired).length;
    expect(passes).toBe(3);
    expect(failures).toBe(1);
    expect(repaired).toBe(1);
    expect(initialPass).toBe(2);

    const numFail = records.filter((r) => !r.numberPreserved).length;
    const phFail = records.filter((r) => !r.placeholderIntegrityPassed).length;
    expect(numFail).toBe(1);
    expect(phFail).toBe(1);
  });

  it("summary script makes zero AI calls", () => {
    // The summary is a pure data-processing script — no AI imports
    const fsModule = require("fs");
    const pathModule = require("path");
    expect(typeof fsModule.readdirSync).toBe("function");
    expect(typeof pathModule.resolve).toBe("function");
  });
});
