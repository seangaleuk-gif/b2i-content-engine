// ── Local Cantonese corpus: runtime indexes, retrieval, validation ──
//
// Loads the deterministic processed files under `src/data/cantonese/` ONCE and
// caches efficient Set/Map indexes for the lifetime of the server process. No
// raw corpus is parsed on request, and the full datasets are never sent to
// DeepSeek — only a small deterministic selection of examples is injected into
// the single full-document translation prompt.
//
// Retrieval is deterministic and local (no AI call). Post-translation validation
// is diagnostic-only unless an error is objective, matching the save-gate rules.

import * as fs from "node:fs";
import * as path from "node:path";
import { HK_TRANSLATION_GLOSSARY } from "./translation-glossary";
import type { QualityFinding } from "./shadow-cantonese-quality";

const DATA_DIR = path.join(process.cwd(), "src", "data", "cantonese");

// ── Data shapes ─────────────────────────────────────────────────────────────

export interface LexiconEntry {
  word: string;
  jyutping: string;
  pos: string;
  frequency: number;
}

export interface ExampleEntry {
  text: string;
  register: "spoken" | "neutral" | "professional-candidate" | "marketing" | "business";
  source: string;
}

export interface SourceMetadata {
  id: string;
  url: string;
  licence: string;
  attribution: string;
  downloadedAt: string | null;
  status: string;
}

export interface CorpusData {
  lexicon: LexiconEntry[];
  englishIndex: Record<string, Array<{ cantonese: string; relevance: number }>>;
  frequency: Record<string, number>;
  nGrams: Record<string, number>;
  examples: ExampleEntry[];
  variants: Record<string, string>;
  manifest: {
    dataHash: string;
    counts: Record<string, number>;
    sources: SourceMetadata[];
  };
}

export interface CantoneseIndexes {
  validWords: ReadonlySet<string>;
  variants: ReadonlyMap<string, string>;
  englishIndex: ReadonlyMap<string, ReadonlyArray<{ cantonese: string; relevance: number }>>;
  frequency: ReadonlyMap<string, number>;
  nGrams: ReadonlyMap<string, number>;
  examples: ReadonlyArray<ExampleEntry>;
  examplesByRegister: ReadonlyMap<ExampleEntry["register"], ReadonlyArray<ExampleEntry>>;
  pos: ReadonlyMap<string, string>;
  metadata: { dataHash: string; counts: Record<string, number>; sources: SourceMetadata[] };
  /** Total number of stored entries (lexicon + index terms + variants + examples). */
  size: number;
}

const REGISTERS: ExampleEntry["register"][] = ["spoken", "neutral", "professional-candidate", "marketing", "business"];

/** Build efficient indexes from raw corpus data (pure; testable at any scale). */
export function buildCantoneseIndexes(data: CorpusData): CantoneseIndexes {
  const validWords = new Set<string>();
  const pos = new Map<string, string>();
  const frequency = new Map<string, number>();
  for (const entry of data.lexicon) {
    validWords.add(entry.word);
    pos.set(entry.word, entry.pos);
    frequency.set(entry.word, entry.frequency);
  }

  const variants = new Map<string, string>(Object.entries(data.variants));
  for (const v of variants.keys()) validWords.add(v);
  for (const p of variants.values()) validWords.add(p);

  const englishIndex = new Map<string, Array<{ cantonese: string; relevance: number }>>();
  for (const [term, cands] of Object.entries(data.englishIndex)) {
    englishIndex.set(term.toLowerCase(), [...cands].sort((a, b) => b.relevance - a.relevance));
  }

  const nGrams = new Map<string, number>(Object.entries(data.nGrams));
  for (const freq of Object.values(data.frequency)) void freq;

  const examplesByRegister = new Map<ExampleEntry["register"], ExampleEntry[]>();
  for (const reg of REGISTERS) examplesByRegister.set(reg, []);
  for (const ex of data.examples) {
    examplesByRegister.get(ex.register)?.push(ex);
  }

  const size =
    data.lexicon.length +
    Object.keys(data.englishIndex).length +
    Object.keys(data.variants).length +
    data.examples.length;

  return {
    validWords,
    variants,
    englishIndex,
    frequency,
    nGrams,
    examples: data.examples,
    examplesByRegister,
    pos,
    metadata: {
      dataHash: data.manifest.dataHash,
      counts: data.manifest.counts,
      sources: data.manifest.sources,
    },
    size,
  };
}

// ── Cached loader ───────────────────────────────────────────────────────────

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
}
function readJsonl(name: string): ExampleEntry[] {
  return fs
    .readFileSync(path.join(DATA_DIR, name), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ExampleEntry);
}

function loadAndBuild(): CantoneseIndexes {
  const manifest = readJson("manifest.json") as CorpusData["manifest"];
  const corpus: CorpusData = {
    lexicon: readJson("cantonese-lexicon.json") as LexiconEntry[],
    englishIndex: readJson("english-cantonese-index.json") as CorpusData["englishIndex"],
    frequency: readJson("cantonese-frequency.json") as Record<string, number>,
    nGrams: fs.existsSync(path.join(DATA_DIR, "cantonese-ngrams.json"))
      ? (readJson("cantonese-ngrams.json") as Record<string, number>)
      : {},
    examples: readJsonl("cantonese-examples.jsonl"),
    variants: readJson("cantonese-variants.json") as Record<string, string>,
    manifest,
  };
  return buildCantoneseIndexes(corpus);
}

let cached: CantoneseIndexes | null = null;

/** Return the cached runtime indexes, building them once for the process lifetime. */
export function getCantoneseIndexes(): CantoneseIndexes {
  if (!cached) cached = loadAndBuild();
  return cached;
}

/** Reset the process cache (primarily for tests). */
export function resetCantoneseIndexesCache(): void {
  cached = null;
}

// ── English glossary terms used to bias retrieval ───────────────────────────

const B2I_GLOSSARY_ENGLISH_TERMS: string[] = [
  ...HK_TRANSLATION_GLOSSARY.map(([src]) => src.split(" / ")[0].toLowerCase()),
  "influencer marketing", "nano-influencer", "micro-influencer", "mid-tier", "top-tier",
];

// ── Deterministic example retrieval ─────────────────────────────────────────

export interface RetrievedExample {
  example: ExampleEntry;
  score: number;
  matchedTerms: string[];
}

const REGISTER_PRIORITY: Record<ExampleEntry["register"], number> = {
  "professional-candidate": 5,
  marketing: 4,
  business: 3,
  neutral: 2,
  spoken: 1,
};

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeCjk(text: string): string[] {
  return (text.match(/[\u3400-\u9fff]{1,4}/g) || []).filter((t) => t.length > 0);
}

/** Select a small, deterministic, highly relevant set of corpus examples. */
export function retrieveCorpusCantoneseExamples(
  docText: string,
  glossaryTerms: string[] = [],
  max = 30,
): RetrievedExample[] {
  const idx = getCantoneseIndexes();
  const lower = docText.toLowerCase();

  // English-index terms present in the article.
  const matchedEnglish: Array<{ term: string; cantonese: string }> = [];
  for (const [term, cands] of idx.englishIndex) {
    if (lower.includes(term)) {
      matchedEnglish.push({ term, cantonese: cands[0]?.cantonese ?? "" });
    }
  }
  const gloss = glossaryTerms.map((t) => t.toLowerCase());

  const scored = idx.examples.map((example): RetrievedExample => {
    let score = REGISTER_PRIORITY[example.register] ?? 1;
    const matchedTerms: string[] = [];
    const textTokens = new Set(tokenizeCjk(example.text));
    for (const m of matchedEnglish) {
      if (m.cantonese && example.text.includes(m.cantonese)) {
        score += 2;
        matchedTerms.push(m.term);
      }
    }
    // Glossary overlap.
    for (const g of gloss) {
      if (g && example.text.includes(g)) { score += 3; matchedTerms.push(g); }
    }
    // Frequent-word presence (naturalness bias).
    let freqPoints = 0;
    for (const tok of textTokens) {
      const f = idx.frequency.get(tok);
      if (f && f >= 200) freqPoints += 1;
    }
    if (freqPoints >= 2) score += 1;
    // Part-of-speech compatibility: prefer examples containing at least one
    // verb (natural sentence structure), matching the lexicon POS index.
    const hasVerb = [...textTokens].some((tok) => idx.pos.get(tok) === "verb");
    if (hasVerb) score += 1;
    return { example, score, matchedTerms };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.example.text.localeCompare(b.example.text, "zh-Hant"));

  const seen = new Set<string>();
  const out: RetrievedExample[] = [];
  for (const s of scored) {
    if (seen.has(s.example.text)) continue;
    seen.add(s.example.text);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Format the retrieved corpus examples as a lower-priority prompt section. */
export function buildCorpusExamplesPrompt(docText: string, glossaryTerms: string[] = [], max = 30): string {
  const selected = retrieveCorpusCantoneseExamples(docText, glossaryTerms, max);
  if (selected.length === 0) return "";
  const lines = selected.map((s, i) => `${i + 1}. ${s.example.text}`);
  return [
    "RETRIEVED CANTONESE CORPUS EXAMPLES (LANGUAGE-ONLY reference — these demonstrate natural spoken/neutral Cantonese phrasing and are LOWER priority than the approved B2I style examples above. They must NEVER influence the JSON shape, block type, list/table dimensions or inline structure of the units you return. A source paragraph must stay a paragraph; inline links must stay inline links.)",
    ...lines,
  ].join("\n");
}

/** Default glossary terms for corpus retrieval (B2I glossary source terms). */
export const DEFAULT_GLOSSARY_TERMS: ReadonlyArray<string> = B2I_GLOSSARY_ENGLISH_TERMS;

// ── Post-translation corpus validation (diagnostic-only unless objective) ───

export interface CorpusValidationResult {
  findings: QualityFinding[];
  variantCorrections: Array<{ sourceUnitId: string; variant: string; preferred: string }>;
  unknownTokenCount: number;
  collisionCount: number;
}

/**
 * Validate translated Chinese units against the local corpus. Produces advisory
 * (diagnostic-only) findings unless an error is objective. Variant corrections
 * are reported with an audit record (they are applied by the deterministic
 * language-pack normaliser).
 */
export function validateCantoneseCorpus(
  units: Array<{ id: string; text: string }>,
): CorpusValidationResult {
  const idx = getCantoneseIndexes();
  const findings: QualityFinding[] = [];
  const variantCorrections: CorpusValidationResult["variantCorrections"] = [];
  let unknownTokenCount = 0;
  let collisionCount = 0;
  const push = (f: QualityFinding): void => { findings.push(f); };

  // Collision candidates: a Cantonese term that is the TOP candidate for two or
  // more distinct English terms (a conflation risk in the stored index). Bound the
  // set and precompile a single regex so per-unit cost stays negligible.
  const candidateTerms = new Map<string, string[]>();
  for (const [term, cands] of idx.englishIndex) {
    const top = cands[0]?.cantonese;
    if (!top) continue;
    candidateTerms.set(top, [...(candidateTerms.get(top) ?? []), term]);
  }
  const collidedList = [...candidateTerms.entries()]
    .filter(([, terms]) => terms.length >= 2)
    .map(([top]) => top)
    .sort((a, b) => b.length - a.length)
    .slice(0, 500);
  const collisionRe = collidedList.length > 0 ? new RegExp(collidedList.map(escapeRe).join("|"), "u") : null;

  for (const { id, text } of units) {
    if (!text) continue;
    const tokens = tokenizeCjk(text);
    if (tokens.length === 0) continue;

    // Collision check: if a unit uses a Cantonese term that the index maps to
    // multiple distinct English concepts, flag it (diagnostic-only).
    if (collisionRe) {
      const collisionMatch = text.match(collisionRe);
      if (collisionMatch) {
        collisionCount += 1;
        push({
          sourceUnitId: id,
          category: "language",
          severity: "advisory",
          matchedToken: collisionMatch[0],
          messageCode: "corpus-collision",
          replacement: "ensure the term maps to the correct English concept",
          action: "diagnostic",
          detectorRule: "corpus-collision",
          context: text.slice(0, 60),
        });
      }
    }

    // Variant normalisation audit.
    for (const [variant, preferred] of idx.variants) {
      if (text.includes(variant)) {
        variantCorrections.push({ sourceUnitId: id, variant, preferred });
      }
    }

    // Token validation: unknown CJK tokens (not in lexicon, not a known variant).
    const unknown: string[] = [];
    for (const tok of tokens) {
      if (idx.validWords.has(tok)) continue;
      if (!unknown.includes(tok)) unknown.push(tok);
      if (unknown.length >= 5) break;
    }
    if (unknown.length > 0) {
      unknownTokenCount += unknown.length;
      push({
        sourceUnitId: id,
        category: "language",
        severity: "advisory",
        matchedToken: unknown.join("、"),
        messageCode: "corpus-unknown-token",
        replacement: "confirm against Words.hk or translate/transliterate if a proper noun",
        action: "diagnostic",
        detectorRule: "corpus-token-validation",
        context: text.slice(0, 60),
      });
    }

    // Naturalness: flag a bigram of two common words that never appears in the
    // stored n-grams — diagnostic-only (a rare phrase is not automatically wrong).
    const words = (text.match(/[\u3400-\u9fff]{2,}/g) || []);
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      const hi = idx.frequency.get(words[i]) ?? 0;
      const hj = idx.frequency.get(words[i + 1]) ?? 0;
      if (hi >= 200 && hj >= 200 && !idx.nGrams.has(bigram)) {
        push({
          sourceUnitId: id,
          category: "language",
          severity: "advisory",
          matchedToken: bigram,
          messageCode: "corpus-rare-combination",
          action: "diagnostic",
          detectorRule: "corpus-naturalness",
          context: text.slice(0, 60),
        });
        break; // one per unit
      }
    }
  }

  return { findings, variantCorrections, unknownTokenCount, collisionCount };
}
