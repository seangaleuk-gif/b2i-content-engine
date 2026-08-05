/**
 * Reproducible import of the approved Cantonese language data into the B2I
 * Content Engine's local runtime resource.
 *
 * Sources (openly licensed):
 *   1. Words.hk word list           (public domain) — official JSON endpoint
 *   2. Words.hk English index       (public domain) — official JSON endpoint
 *   3. HKCanCor via PyCantonese     (CC BY 4.0)     — pinned pycantonese exporter
 *
 * PRODUCTION behaviour:
 *   - downloads the real datasets and validates their schemas (JSON, not HTML);
 *   - invokes the pinned HKCanCor exporter through Python/PyCantonese;
 *   - enforces minimum acceptance counts; if any minimum is not met, or any
 *     source cannot be loaded, the import FAILS LOUDLY and the previous valid
 *     generated files are left untouched;
 *   - never reports a seed fallback as a successful corpus import;
 *   - writes each generated file atomically (temp + rename) and only after ALL
 *     required sources pass validation;
 *   - records checksums, versions, retrieval dates, licences and counts in
 *     `manifest.json`.
 *
 * SEED (unit tests only): pass `--seed` to build from `scripts/cantonese-seed.json`.
 * The seed output is tagged `provenance: "seed-test"` and is never presented as a
 * live corpus import.
 *
 * Run: `npx tsx scripts/import-cantonese-language-data.ts`
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(process.cwd());
const RAW_DIR = path.join(ROOT, ".tmp", "cantonese-raw");
const OUT_DIR = path.join(ROOT, "src", "data", "cantonese");
const SEED_PATH = path.join(ROOT, "scripts", "cantonese-seed.json");

export interface SourceSpec {
  id: string;
  url: string;
  licence: string;
  attribution: string;
  kind: "wordlist" | "english-index" | "corpus";
}

const SOURCES: SourceSpec[] = [
  {
    id: "wordshk-wordlist",
    url: "https://words.hk/faiman/analysis/wordslist.json",
    licence: "public-domain",
    attribution: "Words.hk (https://words.hk/)",
    kind: "wordlist",
  },
  {
    id: "wordshk-english-index",
    url: "https://words.hk/faiman/analysis/englishindex.json",
    licence: "public-domain",
    attribution: "Words.hk (https://words.hk/)",
    kind: "english-index",
  },
  {
    id: "hkcancor-pycantonese",
    url: "pycantonese:hkcancor()",
    licence: "CC-BY-4.0",
    attribution: "HKCanCor (Luke S. K. Wong), via PyCantonese — https://pycantonese.org/",
    kind: "corpus",
  },
];

// ── Minimum acceptance counts ────────────────────────────────────────────────

export const MIN_ACCEPTANCE = {
  lexicon: 20_000,
  englishTerms: 1_000,
  hkcancorOccurrences: 100_000,
  examples: 5_000,
} as const;

export interface AcceptanceCounts {
  lexicon: number;
  englishTerms: number;
  hkcancorOccurrences: number;
  examples: number;
}

/** Return `{ ok, errors }`; every failed minimum gate is listed. */
export function checkMinimums(counts: AcceptanceCounts): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (counts.lexicon < MIN_ACCEPTANCE.lexicon) errors.push(`lexicon ${counts.lexicon} < ${MIN_ACCEPTANCE.lexicon}`);
  if (counts.englishTerms < MIN_ACCEPTANCE.englishTerms) errors.push(`englishTerms ${counts.englishTerms} < ${MIN_ACCEPTANCE.englishTerms}`);
  if (counts.hkcancorOccurrences < MIN_ACCEPTANCE.hkcancorOccurrences) errors.push(`hkcancorOccurrences ${counts.hkcancorOccurrences} < ${MIN_ACCEPTANCE.hkcancorOccurrences}`);
  if (counts.examples < MIN_ACCEPTANCE.examples) errors.push(`examples ${counts.examples} < ${MIN_ACCEPTANCE.examples}`);
  return { ok: errors.length === 0, errors };
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

export interface LexiconEntry {
  word: string;
  jyutping: string;
  pos: string;
  frequency: number;
}

function nfkc(value: string): string {
  return value.normalize("NFKC");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isHtml(text: string): boolean {
  return /<html|<!\s*doctype|<body|<div\b|<table\b/i.test(text);
}

/** Parse the Words.hk wordslist JSON: `{ word: [jyutping, ...] }`. Throws on HTML / bad schema. */
export function parseWordslist(text: string): LexiconEntry[] {
  if (isHtml(text)) throw new Error("wordslist: HTML received, not a JSON dataset");
  const obj = JSON.parse(text) as Record<string, unknown>;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("wordslist: expected JSON object");
  const out: LexiconEntry[] = [];
  for (const [word, readings] of Object.entries(obj)) {
    const w = nfkc(word);
    if (!w || !/[\u3400-\u9fff]/.test(w)) continue;
    const jyutping = Array.isArray(readings) && typeof readings[0] === "string" ? nfkc(readings[0]) : "";
    out.push({ word: w, jyutping, pos: "noun", frequency: 1 });
  }
  return out;
}

export interface EnglishCandidate {
  cantonese: string;
  relevance: number;
}

/** Parse the Words.hk englishindex JSON: `{ term: [[word:jyutping, relevance], ...] }`. */
export function parseEnglishIndex(text: string): Record<string, EnglishCandidate[]> {
  if (isHtml(text)) throw new Error("englishindex: HTML received, not a JSON dataset");
  const obj = JSON.parse(text) as Record<string, unknown>;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("englishindex: expected JSON object");
  const out: Record<string, EnglishCandidate[]> = {};
  for (const [term, rawCands] of Object.entries(obj)) {
    if (!Array.isArray(rawCands)) continue;
    const seen = new Set<string>();
    const cands: EnglishCandidate[] = [];
    for (const raw of rawCands) {
      if (!Array.isArray(raw) || raw.length < 2) continue;
      const [entryStr, relevance] = raw as [string, number];
      const first = String(entryStr).split(",")[0];
      const cantonese = nfkc(first.split(":")[0].trim());
      if (!cantonese) continue;
      const key = `${cantonese}:${relevance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({ cantonese, relevance: Number(relevance) || 0 });
    }
    cands.sort((a, b) => b.relevance - a.relevance);
    if (cands.length > 0) out[term.toLowerCase()] = cands.slice(0, 5);
  }
  return out;
}

/**
 * Authoritative domain vocabulary (aligned with the B2I glossary). Corpus
 * suggestions from the general Words.hk English index must NEVER override these
 * mandatory mappings; tier distinctions (nano/micro/mid/top) are preserved here.
 */
export const DOMAIN_OVERLAY: Record<string, string[]> = {
  "influencer marketing": ["創作者市場推廣"],
  influencer: ["創作者"],
  "nano influencer": ["超小型創作者"],
  "micro influencer": ["微型創作者"],
  "mid tier influencer": ["中型創作者"],
  "top tier influencer": ["頂級創作者"],
  agency: ["市場推廣公司"],
  "brand awareness": ["品牌知名度"],
  follower: ["粉絲"],
  engagement: ["互動"],
  campaign: ["推廣活動"],
  creator: ["創作者"],
  brand: ["品牌"],
  marketing: ["市場推廣"],
  kol: ["KOL"],
};

/** Overlay the B2I domain vocabulary over the general Words.hk English index. */
export function applyGlossaryOverlay(index: Record<string, EnglishCandidate[]>): Record<string, EnglishCandidate[]> {
  const merged: Record<string, EnglishCandidate[]> = {};
  for (const [term, cands] of Object.entries(index)) merged[term] = cands;
  for (const [term, cantonese] of Object.entries(DOMAIN_OVERLAY)) {
    merged[term] = cantonese.map((c, i) => ({ cantonese: c, relevance: 100 - i }));
  }
  return merged;
}

// ── Download / export helpers ───────────────────────────────────────────────

async function downloadJson(url: string, rawPath: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!/json/i.test(type)) throw new Error(`${url}: unexpected Content-Type "${type}"`);
  const body = await res.text();
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, body, "utf8");
  return body;
}

function runPython(exporterPath: string, outPath: string): void {
  execFileSync("python", [exporterPath, outPath], { stdio: ["ignore", "inherit", "pipe"] });
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    out[key] = v && typeof v === "object" ? (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? sortObject(x as Record<string, unknown>) : x)) : sortObject(v as Record<string, unknown>)) : v;
  }
  return out;
}

// ── Example filtering ───────────────────────────────────────────────────────

export interface ExampleEntry {
  text: string;
  register: "spoken" | "neutral";
  source: string;
}

/** Filter raw HKCanCor utterances into usable, deduplicated spoken/neutral examples. */
export function filterExamples(utterances: Array<{ participant: string; text: string }>): ExampleEntry[] {
  const seen = new Set<string>();
  const out: ExampleEntry[] = [];
  for (const u of utterances) {
    const text = nfkc(u.text).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (text.length < 6 || text.length > 120) continue;
    if (!/[\u3400-\u9fff]/.test(text)) continue;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
    if (latin > 0 && latin / (latin + han) > 0.3) continue; // excessive code-switching
    const runs = (text.match(/[\u3400-\u9fff]{1,4}/g) || []).length;
    if (runs < 2) continue; // fragments / single interjection
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, register: "spoken", source: "hkcancor" });
  }
  return out;
}

// ── Main pipeline ───────────────────────────────────────────────────────────

export interface ImportOptions {
  seed?: boolean;
  outDir?: string;
}

export interface ImportResult {
  counts: AcceptanceCounts & { frequency: number; ngrams: number; variants: number };
  provenance: "live" | "seed-test";
  dataHash: string;
}

export interface LoadedSources {
  lexicon: LexiconEntry[];
  englishIndex: Record<string, EnglishCandidate[]>;
  hkcancor: {
    version: string;
    source_file_identifiers: { n_files: number; participants: string[] };
    occurrence_count: number;
    unique_word_count: number;
    utterance_count: number;
    word_frequency: Record<string, number>;
    pos: Record<string, string>;
    jyutping: Record<string, string>;
    utterances: Array<{ participant: string; text: string }>;
  };
}

/** Default source loader: downloads Words.hk JSON and exports HKCanCor via PyCantonese. */
export async function defaultLoadSources(): Promise<LoadedSources> {
  const wordslistBody = await downloadJson(SOURCES[0].url, path.join(RAW_DIR, "wordshk-wordslist.json"));
  const englishBody = await downloadJson(SOURCES[1].url, path.join(RAW_DIR, "wordshk-englishindex.json"));
  const lexicon = parseWordslist(wordslistBody);
  const englishIndex = applyGlossaryOverlay(parseEnglishIndex(englishBody));
  const hkPath = path.join(RAW_DIR, "hkcancor-export.json");
  runPython(path.join(ROOT, "scripts", "export-hkcancor.py"), hkPath);
  const hkcancor = JSON.parse(fs.readFileSync(hkPath, "utf8")) as LoadedSources["hkcancor"];
  return { lexicon, englishIndex, hkcancor };
}

/** Build the deterministic runtime files + counts from loaded sources (pure). */
export function buildRuntimeFiles(
  sources: LoadedSources,
  variants: Record<string, string>,
): { files: Record<string, string>; counts: AcceptanceCounts & { frequency: number; ngrams: number; variants: number } } {
  const normalizedVariants: Record<string, string> = {};
  for (const [v, p] of Object.entries(variants)) normalizedVariants[nfkc(v)] = nfkc(p);

  const lexiconSet = new Set<string>();
  const enrichedLexicon: LexiconEntry[] = [];
  for (const entry of sources.lexicon) {
    if (lexiconSet.has(entry.word)) continue;
    lexiconSet.add(entry.word);
    enrichedLexicon.push({
      ...entry,
      pos: sources.hkcancor.pos[entry.word] ?? "noun",
      frequency: sources.hkcancor.word_frequency[entry.word] ?? 1,
    });
  }

  const frequency: Record<string, number> = { ...sources.hkcancor.word_frequency };
  const examples = filterExamples(sources.hkcancor.utterances);

  const ngrams: Record<string, number> = {};
  for (const ex of examples) {
    const toks = ex.text.match(/[\u3400-\u9fff]{1,4}/g) || [];
    for (let i = 0; i < toks.length - 1; i++) {
      const bigram = `${toks[i]} ${toks[i + 1]}`;
      ngrams[bigram] = (ngrams[bigram] ?? 0) + 1;
    }
  }

  const files: Record<string, string> = {
    "cantonese-lexicon.json": JSON.stringify(enrichedLexicon.sort((a, b) => a.word.localeCompare(b.word, "zh-Hant")), null, 2) + "\n",
    "english-cantonese-index.json": JSON.stringify(sortObject(sources.englishIndex as unknown as Record<string, unknown>), null, 2) + "\n",
    "cantonese-frequency.json": JSON.stringify(sortObject(frequency as unknown as Record<string, unknown>), null, 2) + "\n",
    "cantonese-ngrams.json": JSON.stringify(sortObject(ngrams as unknown as Record<string, unknown>), null, 2) + "\n",
    "cantonese-examples.jsonl": examples.map((ex) => JSON.stringify(ex)).join("\n") + "\n",
    "cantonese-variants.json": JSON.stringify(sortObject(normalizedVariants as unknown as Record<string, unknown>), null, 2) + "\n",
  };

  const counts: AcceptanceCounts = {
    lexicon: enrichedLexicon.length,
    englishTerms: Object.keys(sources.englishIndex).length,
    hkcancorOccurrences: sources.hkcancor.occurrence_count,
    examples: examples.length,
  };
  return { files, counts: { ...counts, frequency: Object.keys(frequency).length, ngrams: Object.keys(ngrams).length, variants: Object.keys(normalizedVariants).length } };
}

/** Write generated files atomically (temp + rename), then the manifest. */
export function writeGeneratedFiles(outDir: string, files: Record<string, string>, manifest: Record<string, unknown>): void {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const finalPath = path.join(outDir, name);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, finalPath);
  }
  const manifestPath = path.join(outDir, "manifest.json");
  const tmpManifest = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.renameSync(tmpManifest, manifestPath);
}

export interface ImportOptions {
  seed?: boolean;
  outDir?: string;
  loadSources?: () => Promise<LoadedSources>;
}

export interface ImportResult {
  counts: AcceptanceCounts & { frequency: number; ngrams: number; variants: number };
  provenance: "live" | "seed-test";
  dataHash: string;
}

export async function runImport(opts: ImportOptions = {}): Promise<ImportResult> {
  const outDir = opts.outDir ?? OUT_DIR;
  const retrievedAt = new Date().toISOString();

  if (opts.seed) {
    return buildFromSeed(outDir, retrievedAt);
  }

  // 1. Load and validate all required sources (fails loudly on any failure).
  const sources = await (opts.loadSources ?? defaultLoadSources)();

  // 2. Build runtime data (in memory), no writes yet.
  const variants = JSON.parse(fs.readFileSync(SEED_PATH, "utf8")).variants as Record<string, string>;
  const { files, counts } = buildRuntimeFiles(sources, variants);

  // 3. Minimum acceptance gates — FAIL LOUDLY, write nothing (prior files intact).
  const gate = checkMinimums(counts);
  if (!gate.ok) {
    throw new Error(`Cantonese import rejected — minimum acceptance not met: ${gate.errors.join("; ")}`);
  }

  // 4. Deterministic content hash + manifest (checksums, versions, licences, counts).
  const dataHash = sha256Text(Object.keys(files).sort().map((k) => files[k]).join("\u0000"));
  const rawFiles: Record<string, string> = {
    "wordshk-wordslist.json": fs.existsSync(path.join(RAW_DIR, "wordshk-wordslist.json")) ? fs.readFileSync(path.join(RAW_DIR, "wordshk-wordslist.json"), "utf8") : "",
    "wordshk-englishindex.json": fs.existsSync(path.join(RAW_DIR, "wordshk-englishindex.json")) ? fs.readFileSync(path.join(RAW_DIR, "wordshk-englishindex.json"), "utf8") : "",
    "hkcancor-export.json": fs.existsSync(path.join(RAW_DIR, "hkcancor-export.json")) ? fs.readFileSync(path.join(RAW_DIR, "hkcancor-export.json"), "utf8") : "",
  };
  const manifest = {
    schemaVersion: 2,
    provenance: "live",
    generatedAt: retrievedAt,
    deterministic: true,
    dataHash,
    sources: SOURCES.map((s) => ({
      id: s.id, url: s.url, licence: s.licence, attribution: s.attribution,
      retrievedAt, status: "downloaded",
      checksum: sha256Text(rawFiles[s.id === "wordshk-wordlist" ? "wordshk-wordslist.json" : s.id === "wordshk-english-index" ? "wordshk-englishindex.json" : "hkcancor-export.json"]),
    })),
    versions: {
      pycantonese: sources.hkcancor.version,
      wordslistSchema: "word:jyutping[]",
      englishIndexSchema: "term:[[word:jyutping,relevance]]",
      hkcancorFiles: sources.hkcancor.source_file_identifiers.n_files,
    },
    counts,
    generatedFiles: Object.keys(files).sort(),
  };

  // 5. Atomic writes — only after all sources pass.
  writeGeneratedFiles(outDir, files, manifest);

  return { counts, provenance: "live", dataHash };
}

function buildFromSeed(outDir: string, retrievedAt: string): ImportResult {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8")) as {
    lexicon: LexiconEntry[];
    englishIndex: Record<string, Array<{ cantonese: string; relevance: number }>>;
    variants: Record<string, string>;
    examples: Array<{ text: string; register: string; source: string }>;
  };
  const normalizedVariants: Record<string, string> = {};
  for (const [v, p] of Object.entries(seed.variants)) normalizedVariants[nfkc(v)] = nfkc(p);
  const files: Record<string, string> = {
    "cantonese-lexicon.json": JSON.stringify(seed.lexicon, null, 2) + "\n",
    "english-cantonese-index.json": JSON.stringify(sortObject(seed.englishIndex as unknown as Record<string, unknown>), null, 2) + "\n",
    "cantonese-frequency.json": JSON.stringify(sortObject(seed.lexicon.reduce<Record<string, number>>((a, l) => { a[l.word] = l.frequency; return a; }, {}) as unknown as Record<string, unknown>), null, 2) + "\n",
    "cantonese-ngrams.json": "{} \n",
    "cantonese-examples.jsonl": seed.examples.map((ex) => JSON.stringify(ex)).join("\n") + "\n",
    "cantonese-variants.json": JSON.stringify(sortObject(normalizedVariants as unknown as Record<string, unknown>), null, 2) + "\n",
  };
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const finalPath = path.join(outDir, name);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, finalPath);
  }
  const dataHash = sha256Text(Object.keys(files).sort().map((k) => files[k]).join("\u0000"));
  const manifest = {
    schemaVersion: 2, provenance: "seed-test", generatedAt: retrievedAt, deterministic: true, dataHash,
    sources: SOURCES.map((s) => ({ id: s.id, url: s.url, licence: s.licence, attribution: s.attribution, retrievedAt, status: "seed-test", checksum: "seed" })),
    counts: { lexicon: seed.lexicon.length, englishTerms: Object.keys(seed.englishIndex).length, hkcancorOccurrences: 0, examples: seed.examples.length, frequency: seed.lexicon.length, ngrams: 0, variants: Object.keys(normalizedVariants).length },
    generatedFiles: Object.keys(files).sort(),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { counts: { lexicon: seed.lexicon.length, englishTerms: Object.keys(seed.englishIndex).length, hkcancorOccurrences: 0, examples: seed.examples.length, frequency: seed.lexicon.length, ngrams: 0, variants: Object.keys(normalizedVariants).length }, provenance: "seed-test", dataHash };
}

// ── Entry point (only when run directly) ────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runImport({ seed: process.argv.includes("--seed") })
    .then((r) => {
      console.log(`Cantonese import complete (provenance=${r.provenance}).`);
      console.log(JSON.stringify(r.counts));
    })
    .catch((err) => {
      console.error("Cantonese import FAILED:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
