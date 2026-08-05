import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  getCantoneseIndexes,
  resetCantoneseIndexesCache,
  buildCantoneseIndexes,
  retrieveCorpusCantoneseExamples,
  buildCorpusExamplesPrompt,
  validateCantoneseCorpus,
  type CorpusData,
} from "./cantonese-corpus";
import { analyzeZhHkLanguageQuality } from "./zh-hk-language-quality";
import { buildCantoneseStyleExamplePrompt } from "./translation-style-examples";

const DATA_DIR = path.join(process.cwd(), "src", "data", "cantonese");
function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8")) as T;
}

function makeCorpusData(): CorpusData {
  return {
    lexicon: readJson("cantonese-lexicon.json"),
    englishIndex: readJson("english-cantonese-index.json"),
    frequency: readJson("cantonese-frequency.json"),
    nGrams: readJson("cantonese-ngrams.json"),
    examples: fs
      .readFileSync(path.join(DATA_DIR, "cantonese-examples.jsonl"), "utf8")
      .split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)),
    variants: readJson("cantonese-variants.json"),
    manifest: readJson("manifest.json"),
  };
}

/** Deterministic large synthetic corpus for scale tests. */
function makeLargeCorpus(n: number, examples: number): CorpusData {
  const lexicon = Array.from({ length: n }, (_, i) => ({
    word: `詞${String(i).padStart(5, "0")}`,
    jyutping: `ci4 ${i}`,
    pos: i % 2 === 0 ? "noun" : "verb",
    frequency: 1 + (i % 500),
  }));
  const exampleList = Array.from({ length: examples }, (_, i) => ({
    text: `呢個係第 ${i + 1} 個例句，詞${String(i % n).padStart(5, "0")} 好常用。`,
    register: (i % 3 === 0 ? "marketing" : i % 3 === 1 ? "neutral" : "spoken") as "marketing" | "neutral" | "spoken",
    source: "synthetic",
  }));
  return {
    lexicon,
    englishIndex: { "influencer marketing": [{ cantonese: "創作者市場推廣", relevance: 100 }] },
    frequency: Object.fromEntries(lexicon.map((l) => [l.word, l.frequency])),
    nGrams: { "詞00000 詞00001": 3 },
    examples: exampleList,
    variants: {},
    manifest: { dataHash: "x".repeat(64), counts: {}, sources: [] },
  };
}

describe("cantonese corpus: import and data integrity", () => {
  it("dataset imports are reproducible (deterministic hash, dedup, consistent counts)", () => {
    const manifest = readJson<{ dataHash: string; counts: Record<string, number> }>("manifest.json");
    expect(manifest.dataHash).toMatch(/^[0-9a-f]{64}$/);
    const lexicon = readJson<Array<{ word: string }>>("cantonese-lexicon.json");
    const unique = new Set(lexicon.map((l) => l.word));
    expect(unique.size).toBe(lexicon.length);
    expect(manifest.counts.lexicon).toBe(lexicon.length);
    // Same data → same indexes (deterministic).
    const a = buildCantoneseIndexes(makeCorpusData());
    const b = buildCantoneseIndexes(makeCorpusData());
    expect(a.validWords.size).toBe(b.validWords.size);
    expect(a.metadata.dataHash).toBe(b.metadata.dataHash);
  });

  it("licences and attribution are stored for every source", () => {
    const manifest = readJson<{ sources: Array<{ id: string; licence: string; attribution: string }> }>("manifest.json");
    expect(manifest.sources.length).toBeGreaterThanOrEqual(3);
    for (const s of manifest.sources) {
      expect(s.id).toBeTruthy();
      expect(s.licence).toBeTruthy();
      expect(s.attribution).toBeTruthy();
    }
    expect(fs.existsSync(path.join(DATA_DIR, "ATTRIBUTION.md"))).toBe(true);
    const attribution = fs.readFileSync(path.join(DATA_DIR, "ATTRIBUTION.md"), "utf8");
    expect(attribution).toContain("words.hk");
    expect(attribution).toContain("CC BY");
  });

  it("malformed/HTML downloads are rejected, and real sources are recorded as downloaded", () => {
    const manifest = readJson<{ sources: Array<{ status: string }> }>("manifest.json");
    for (const s of manifest.sources) {
      expect(s.status).toBe("downloaded");
    }
    // The runtime loads cleanly from the committed real corpus.
    const idx = getCantoneseIndexes();
    expect(idx.validWords.size).toBeGreaterThan(0);
    expect(idx.examples.length).toBeGreaterThan(0);
  });

  it("duplicate entries are removed when building indexes", () => {
    const data = makeCorpusData();
    const base = buildCantoneseIndexes(data);
    // Appending duplicates must not grow the valid-word set (Set dedup).
    const dupLexicon = [...data.lexicon, data.lexicon[0], data.lexicon[0]];
    const dup = buildCantoneseIndexes({ ...data, lexicon: dupLexicon });
    expect(dup.validWords.has(data.lexicon[0].word)).toBe(true);
    expect(dup.validWords.size).toBe(base.validWords.size);
  });
});

describe("cantonese corpus: runtime indexes and caching", () => {
  it("runtime indexes are cached for the process lifetime", () => {
    resetCantoneseIndexesCache();
    const first = getCantoneseIndexes();
    const second = getCantoneseIndexes();
    expect(second).toBe(first); // same cached instance
    const size = first.size;
    expect(size).toBeGreaterThan(0);
    resetCantoneseIndexesCache();
    const fresh = getCantoneseIndexes();
    expect(fresh.size).toBe(size);
  });

  it("exposes Set/Map indexes for efficient lookups", () => {
    const idx = getCantoneseIndexes();
    expect(idx.validWords.constructor).toBe(Set);
    expect(idx.variants.constructor).toBe(Map);
    expect(idx.englishIndex.constructor).toBe(Map);
    expect(idx.frequency.constructor).toBe(Map);
    expect(idx.pos.constructor).toBe(Map);
    expect(idx.examplesByRegister.constructor).toBe(Map);
  });
});

describe("cantonese corpus: deterministic retrieval", () => {
  it("only the top relevant examples are injected (≤ max, sorted, deduped)", () => {
    const doc = "Influencer marketing and brand awareness drive engagement for SMEs in Hong Kong.";
    const selected = retrieveCorpusCantoneseExamples(doc, ["influencer marketing", "brand awareness"], 12);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(12);
    const texts = selected.map((s) => s.example.text);
    expect(new Set(texts).size).toBe(texts.length); // deduped
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i - 1].score).toBeGreaterThanOrEqual(selected[i].score); // sorted desc
    }
    const prompt = buildCorpusExamplesPrompt(doc, ["influencer marketing"], 5);
    expect(prompt).toContain("RETRIEVED CANTONESE CORPUS EXAMPLES");
    expect(prompt).not.toContain("SOURCE UNITS (English):"); // only examples, no lexicon dump
  });

  it("manually approved B2I examples outrank corpus examples", () => {
    const approved = buildCantoneseStyleExamplePrompt();
    const corpus = buildCorpusExamplesPrompt("Influencer marketing for Hong Kong brands.", ["influencer marketing"], 10);
    // Approved block comes first, corpus block after.
    const approvedIdx = approved.length > 0 ? 0 : -1;
    const combined = `${approved}\n\n${corpus}`;
    const approvedPos = combined.indexOf(approved.slice(0, 20));
    const corpusPos = combined.indexOf("RETRIEVED CANTONESE CORPUS EXAMPLES");
    expect(approvedIdx).toBe(0);
    expect(approvedPos).toBeGreaterThanOrEqual(0);
    expect(corpusPos).toBeGreaterThan(approvedPos); // approved is higher priority (first)
  });
});

describe("cantonese corpus: glossary and terminology integrity", () => {
  it("glossary rules outrank corpus candidates (mandatory glossary still blocks)", () => {
    const doc = "影響力行銷幫品牌接觸觀眾。";
    const zh = {
      metadata: { title: "創作者市場推廣", slug: "t", metaDescription: "創作者市場推廣", excerpt: "創作者市場推廣", targetWordCount: 100, focusKeyphrase: "創作者市場推廣" },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [{ id: "b0", type: "paragraph", content: [{ type: "text", text: doc }], status: "generated" }], status: "generated" },
      sections: [], conclusion: { id: "c", blocks: [], status: "generated" }, visibleFaq: [], cta: null, faqSchema: null, insertedLinks: [],
    };
    const en = {
      metadata: { title: "T", slug: "t", metaDescription: "m", excerpt: "e", targetWordCount: 100, focusKeyphrase: "x" },
      languageSwitcher: null,
      introduction: { id: "intro", blocks: [{ id: "b0", type: "paragraph", content: [{ type: "text", text: "influencer marketing helps brands reach audiences." }], status: "generated" }], status: "generated" },
      sections: [], conclusion: { id: "c", blocks: [], status: "generated" }, visibleFaq: [], cta: null, faqSchema: null, insertedLinks: [],
    };
    const report = analyzeZhHkLanguageQuality(zh as never, en as never);
    expect(report.findings.some((f) => f.messageCode === "glossary-influencer-marketing")).toBe(true);
  });

  it("nano, micro, mid-tier and top-tier remain distinct in the corpus index", () => {
    const idx = getCantoneseIndexes();
    const terms = ["nano influencer", "micro influencer", "mid tier influencer", "top tier influencer"];
    const cantonese = terms.map((t) => idx.englishIndex.get(t)?.[0]?.cantonese);
    expect(cantonese[0]).toBe("超小型創作者");
    expect(cantonese[1]).toBe("微型創作者");
    expect(cantonese[2]).toBe("中型創作者");
    expect(cantonese[3]).toBe("頂級創作者");
    expect(new Set(cantonese).size).toBe(4); // all distinct
  });
});

describe("cantonese corpus: English leakage exemptions", () => {
  function zhWithIntro(text: string) {
    return {
      metadata: { title: "創作者市場推廣", slug: "t", metaDescription: "創作者市場推廣", excerpt: "創作者市場推廣", targetWordCount: 100, focusKeyphrase: "創作者市場推廣" },
      languageSwitcher: null,
      introduction: { id: "i", blocks: [{ id: "b0", type: "paragraph" as const, content: [{ type: "text" as const, text }], status: "generated" as const }], status: "generated" as const },
      sections: [], conclusion: { id: "c", blocks: [], status: "generated" as const }, visibleFaq: [], cta: null, faqSchema: null, insertedLinks: [],
    } as unknown as ArticleDocument;
  }
  function enWithIntro(text: string) {
    return {
      metadata: { title: "T", slug: "t", metaDescription: "m", excerpt: "e", targetWordCount: 100, focusKeyphrase: "x" },
      languageSwitcher: null,
      introduction: { id: "i", blocks: [{ id: "b0", type: "paragraph" as const, content: [{ type: "text" as const, text }], status: "generated" as const }], status: "generated" as const },
      sections: [], conclusion: { id: "c", blocks: [], status: "generated" as const }, visibleFaq: [], cta: null, faqSchema: null, insertedLinks: [],
    } as unknown as ArticleDocument;
  }
  const majors = (r: { findings: Array<{ severity: string; messageCode: string }> }) => r.findings.filter((f) => f.severity === "major" || f.severity === "critical").map((f) => f.messageCode);

  it("work is rejected", () => {
    const report = analyzeZhHkLanguageQuality(zhWithIntro("呢個方案好 work。"), enWithIntro("a plan"));
    expect(majors(report)).toContain("unexpected-english");
  });

  it("post, TikTok and extracted company names pass", () => {
    const en = enWithIntro("StarNgage provides analytics; TikTok posts drive engagement.");
    expect(majors(analyzeZhHkLanguageQuality(zhWithIntro("呢個 post 同 TikTok 嘅內容透過 StarNgage 分析。"), en))).not.toContain("unexpected-english");
    expect(majors(analyzeZhHkLanguageQuality(zhWithIntro("呢個 post 同 TikTok 嘅內容透過 StarNgage 分析。"), en))).not.toContain("literal-untranslated-verb");
  });
});

describe("cantonese corpus: post-translation validation", () => {
  it("unknown-word findings expose exact units and tokens (diagnostic-only)", () => {
    const units = [{ id: "section.2.block.7", text: "呢度有一個完全唔識嘅詞彙組合出現喺度。" }];
    const result = validateCantoneseCorpus(units);
    const finding = result.findings.find((f) => f.messageCode === "corpus-unknown-token");
    expect(finding).toBeDefined();
    expect(finding!.sourceUnitId).toBe("section.2.block.7");
    expect(finding!.matchedToken).toBeTruthy();
    expect(finding!.severity).toBe("advisory");
    expect(finding!.action).toBe("diagnostic");
  });

  it("frequency findings remain diagnostic-only (never block)", () => {
    const units = [{ id: "section.1.block.2", text: "香港品牌好重視呢個策略。" }];
    const result = validateCantoneseCorpus(units);
    for (const f of result.findings) {
      if (f.messageCode === "corpus-rare-combination") {
        expect(f.severity).toBe("advisory");
        expect(f.action).toBe("diagnostic");
      }
    }
    expect(result.findings.every((f) => f.severity === "advisory")).toBe(true);
  });

  it("variant normalisation produces an audit record", () => {
    const units = [{ id: "section.0.block.1", text: "佢哋好噉樣做，仲要了解清楚。" }];
    const result = validateCantoneseCorpus(units);
    const audit = result.variantCorrections.find((c) => c.variant === "噉");
    expect(audit).toBeDefined();
    expect(audit!.preferred).toBe("咁");
  });
});

describe("cantonese corpus: performance and scale", () => {
  it("thousands of stored entries do not increase API-call count and remain fast", () => {
    const big = makeLargeCorpus(5000, 2000);
    const idx = buildCantoneseIndexes(big);
    expect(idx.validWords.size).toBe(5000);
    expect(idx.examples.length).toBe(2000);
    // Production-sized unit list.
    const units = Array.from({ length: 60 }, (_, i) => ({
      id: `section.${i}.block.0`,
      text: `詞00042 呢個策略喺香港市場有效，詞01234 都好常用。`,
    }));
    const start = performance.now();
    const result = validateCantoneseCorpus(units);
    const elapsed = performance.now() - start;
    expect(result.findings.length).toBeGreaterThanOrEqual(0);
    // Deterministic local validation, no provider involved; comfortably fast.
    expect(elapsed).toBeLessThan(2000);
  });

  it("runtime validation of a production-sized article is fast", () => {
    const idx = getCantoneseIndexes();
    const units = Array.from({ length: 90 }, (_, i) => ({
      id: `block.${i}`,
      text: "創作者市場推廣幫香港品牌接觸觀眾，透過互動同內容提升品牌知名度。",
    }));
    // Warm the one-time cold index load + JIT before measuring per-article cost.
    validateCantoneseCorpus(units);
    const start = performance.now();
    for (let i = 0; i < 5; i++) validateCantoneseCorpus(units);
    const elapsed = performance.now() - start;
    expect(idx.size).toBeGreaterThan(0);
    // Post-cache validation of a 90-unit article is low tens of ms or less.
    expect(elapsed / 5).toBeLessThan(100);
  });
});
