import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseWordslist,
  parseEnglishIndex,
  applyGlossaryOverlay,
  DOMAIN_OVERLAY,
  checkMinimums,
  MIN_ACCEPTANCE,
  filterExamples,
  buildRuntimeFiles,
  writeGeneratedFiles,
  runImport,
  type LoadedSources,
} from "./import-cantonese-language-data";

const SAMPLE_WORDSLIST = JSON.stringify({
  香港: ["hoeng1 gong2", "hoeng1 gong2"],
  市場推廣: ["si5 coeng4 teoi1 gwong2"],
  "3A電池": ["saam1 ei1 din6 ci4,AAA電池:saam1 ei1 din6 ci4"],
  電池: ["din6 ci4"],
});

const SAMPLE_ENGLISH = JSON.stringify({
  marketing: [["營銷:jing4 siu1", 100], ["marketing:maa1 ket4 ting4", 100]],
  engagement: [["應酬:jing3 cau4", 59], ["婚約:fan1 joek3", 52]],
  video: [["影片:jing2 pin2", 90]],
});

const HTML = "<html><body>not a dataset</body></html>";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cantonese-import-"));
}

function validLoader(): () => Promise<LoadedSources> {
  const lexicon = Array.from({ length: MIN_ACCEPTANCE.lexicon }, (_, i) => ({
    word: `詞${String(i).padStart(5, "0")}`,
    jyutping: `ci4 ${i}`,
    pos: "noun" as const,
    frequency: 1,
  }));
  const englishIndex: Record<string, Array<{ cantonese: string; relevance: number }>> = {};
  for (let i = 0; i < MIN_ACCEPTANCE.englishTerms; i++) {
    englishIndex[`term${i}`] = [{ cantonese: `詞00001`, relevance: 100 }];
  }
  const utterances = Array.from({ length: 6500 }, (_, i) => ({
    participant: "SPK",
    text: `呢個係第${i}個例句，詞${String(i % lexicon.length).padStart(5, "0")} 好常用。`,
  }));
  const wordFrequency: Record<string, number> = {};
  for (let i = 0; i < lexicon.length; i++) wordFrequency[lexicon[i].word] = 100000;
  const pos: Record<string, string> = {};
  const jyutping: Record<string, string> = {};
  for (const l of lexicon) { pos[l.word] = "noun"; jyutping[l.word] = l.jyutping; }
  return async () => ({
    lexicon,
    englishIndex,
    hkcancor: {
      version: "5.0.0",
      source_file_identifiers: { n_files: 58, participants: ["SPK"] },
      occurrence_count: 200_000,
      unique_word_count: lexicon.length,
      utterance_count: utterances.length,
      word_frequency: wordFrequency,
      pos,
      jyutping,
      utterances,
    },
  });
}

describe("cantonese import: direct Words.hk JSON parsing", () => {
  it("parses the real wordslist JSON schema, not HTML", () => {
    const entries = parseWordslist(SAMPLE_WORDSLIST);
    expect(entries.some((e) => e.word === "香港")).toBe(true);
    expect(entries.some((e) => e.word === "3A電池")).toBe(true);
    expect(() => parseWordslist(HTML)).toThrow(/HTML|JSON/);
  });

  it("parses the real englishindex JSON schema, not HTML", () => {
    const index = parseEnglishIndex(SAMPLE_ENGLISH);
    expect(index.marketing[0].cantonese).toBe("營銷");
    expect(index.video[0].cantonese).toBe("影片");
    expect(() => parseEnglishIndex(HTML)).toThrow(/HTML|JSON/);
  });

  it("applies the B2I glossary overlay (tier terms preserved, distinct)", () => {
    const merged = applyGlossaryOverlay(parseEnglishIndex(SAMPLE_ENGLISH));
    for (const [term, c] of Object.entries(DOMAIN_OVERLAY)) {
      expect(merged[term]?.[0]?.cantonese).toBe(c[0]);
    }
    const tiers = ["nano influencer", "micro influencer", "mid tier influencer", "top tier influencer"];
    const cantonese = tiers.map((t) => merged[t]?.[0]?.cantonese);
    expect(new Set(cantonese).size).toBe(4); // all distinct
    // Glossary overlay wins over the general Words.hk sense for engagement.
    expect(merged.engagement?.[0]?.cantonese).toBe("互動");
  });
});

describe("cantonese import: minimum acceptance gates", () => {
  it("blocks incomplete datasets with clear errors", () => {
    const result = checkMinimums({ lexicon: 100, englishTerms: 50, hkcancorOccurrences: 100, examples: 10 });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("passes when all minimums are met", () => {
    const result = checkMinimums({
      lexicon: MIN_ACCEPTANCE.lexicon,
      englishTerms: MIN_ACCEPTANCE.englishTerms,
      hkcancorOccurrences: MIN_ACCEPTANCE.hkcancorOccurrences,
      examples: MIN_ACCEPTANCE.examples,
    });
    expect(result.ok).toBe(true);
  });

  it("production import cannot silently use seed (below-min data is rejected)", async () => {
    const dir = tmpDir();
    const small = {
      lexicon: [{ word: "香港", jyutping: "hoeng1 gong2", pos: "noun", frequency: 1 }],
      englishIndex: { marketing: [{ cantonese: "市場推廣", relevance: 100 }] },
      hkcancor: {
        version: "5.0.0", source_file_identifiers: { n_files: 1, participants: [] },
        occurrence_count: 100, unique_word_count: 1, utterance_count: 1,
        word_frequency: { 香港: 1 }, pos: {}, jyutping: {}, utterances: [],
      },
    };
    await expect(runImport({ outDir: dir, loadSources: async () => small })).rejects.toThrow(/minimum acceptance/);
  });

  it("the seed path is explicit and tagged seed-test, never live", async () => {
    const dir = tmpDir();
    const res = await runImport({ seed: true, outDir: dir });
    expect(res.provenance).toBe("seed-test");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.provenance).toBe("seed-test");
    expect(manifest.sources.every((s: { status: string }) => s.status === "seed-test")).toBe(true);
  });
});

describe("cantonese import: failure and atomicity", () => {
  it("a failed refresh preserves the previous valid corpus", async () => {
    const dir = tmpDir();
    // Simulate a prior valid corpus.
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ provenance: "live", version: "prior" }));
    fs.writeFileSync(path.join(dir, "cantonese-lexicon.json"), "prior-lexicon");
    // A transient download failure must NOT overwrite it.
    await expect(runImport({ outDir: dir, loadSources: async () => { throw new Error("network down"); } })).rejects.toThrow("network down");
    expect(fs.readFileSync(path.join(dir, "cantonese-lexicon.json"), "utf8")).toBe("prior-lexicon");
    expect(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).toContain("prior");
  });

  it("generated files are written atomically (no .tmp leftovers)", async () => {
    const dir = tmpDir();
    const { files, counts } = buildRuntimeFiles(await validLoader()(), {});
    writeGeneratedFiles(dir, files, { schemaVersion: 2, counts });
    expect(fs.existsSync(path.join(dir, "cantonese-lexicon.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("manifest counts match generated contents", async () => {
    const dir = tmpDir();
    await runImport({ outDir: dir, loadSources: validLoader() });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const lexicon = JSON.parse(fs.readFileSync(path.join(dir, "cantonese-lexicon.json"), "utf8")) as unknown[];
    const examples = fs.readFileSync(path.join(dir, "cantonese-examples.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    expect(manifest.provenance).toBe("live");
    expect(manifest.counts.lexicon).toBe(lexicon.length);
    expect(manifest.counts.examples).toBe(examples.length);
  });
});

describe("cantonese import: example filtering", () => {
  it("deduplicates, drops fragments and excessive code-switching", () => {
    const utterances = [
      { participant: "A", text: "呢個係一個完整例句。" },
      { participant: "A", text: "呢個係一個完整例句。" }, // duplicate
      { participant: "B", text: "啊" }, // fragment
      { participant: "C", text: "work hard play hard and just enjoy every single day of your life" }, // excessive English
      { participant: "D", text: "今日天氣好好，我哋出街食飯啦。" },
    ];
    const filtered = filterExamples(utterances);
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.register === "spoken")).toBe(true);
    expect(filtered.every((e) => e.source === "hkcancor")).toBe(true);
  });
});
