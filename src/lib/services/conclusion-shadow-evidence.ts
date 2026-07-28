import { type EditorialBlock } from "@/lib/blog/article-content";
import type { StructuredTranslationShadowResult } from "./editorial-block-translation";
import type { NumberProtectionState } from "./editorial-block-protection";
import * as fs from "fs";
import * as path from "path";

// ── Evidence record type ──

export interface ConclusionShadowEvidenceRecord {
  timestamp: string;
  evidenceId: string;
  componentIdHash: string;
  sourceStructureSignature: string;
  shadowPassed: boolean;
  repaired: boolean;
  errorCategories: string[];
  blockCount: number;
  blockTypes: string[];
  hasMultipleParagraphs: boolean;
  hasStrong: boolean;
  hasEmphasis: boolean;
  hasLinks: boolean;
  linkCount: number;
  hasList: boolean;
  hasTable: boolean;
  placeholderCount: number;
  hasDate: boolean;
  hasCurrency: boolean;
  hasPercentage: boolean;
  hasRange: boolean;
  hasSuffixNumber: boolean;
  numberPreserved: boolean;
  linksPreserved: boolean;
  placeholderIntegrityPassed: boolean;
  conclusionPolicyPassed: boolean;
  sourceCharacters: number;
  translatedCharacters: number;
  characterRatio: number;
}

function getEvidenceDir(): string {
  return process.env.CONCLUSION_SHADOW_EVIDENCE_DIR || "tmp/structured-translation-production-evidence";
}

// ── Error categorization ──

export type EvidenceErrorCategory =
  | "api_or_network"
  | "malformed_json"
  | "schema"
  | "block_structure"
  | "inline_structure"
  | "placeholder"
  | "number_preservation"
  | "link_preservation"
  | "conclusion_policy"
  | "empty_translation"
  | "configuration"
  | "unknown";

export function categorizeErrors(errors: string[]): EvidenceErrorCategory[] {
  const categories = new Set<EvidenceErrorCategory>();
  for (const e of errors) {
    if (/translation call failed|network|timeout|fetch|api_failure/i.test(e)) {
      categories.add("api_or_network");
    } else if (/JSON|parse|malformed/i.test(e)) {
      categories.add("malformed_json");
    } else if (/componentKind|payload contains|unexpected key|missing required|safety/i.test(e)) {
      categories.add("schema");
    } else if (/count mismatch|type mismatch|seq mismatch|ordered|item|header|row|cell|block structure|block count/i.test(e)) {
      categories.add("block_structure");
    } else if (/inline|node.*seq|node.*type|inline structure/i.test(e)) {
      categories.add("inline_structure");
    } else if (/placeholder/i.test(e)) {
      categories.add("placeholder");
    } else if (/number mismatch|numbers lost|number.*lost|number.*extra/i.test(e)) {
      categories.add("number_preservation");
    } else if (/link.*lost|links lost/i.test(e)) {
      categories.add("link_preservation");
    } else if (/CTA|signup|call.?to.?action/i.test(e)) {
      categories.add("conclusion_policy");
    } else if (/no readable|empty/i.test(e)) {
      categories.add("empty_translation");
    } else if (/disabled|not configured|no.*key/i.test(e)) {
      categories.add("configuration");
    } else {
      categories.add("unknown");
    }
  }
  return [...categories];
}

// ── Hashing ──

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function computeStructureSignature(blocks: EditorialBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    parts.push(b.type);
    if (b.type === "list") parts.push(b.ordered ? "ol" : "ul");
    if (b.type === "paragraph" || b.type === "subheading" || b.type === "quote") {
      for (const n of b.content) parts.push(n.type);
    }
    if (b.type === "list") {
      parts.push(`items:${b.items.length}`);
      for (const item of b.items) {
        for (const n of item) parts.push(n.type);
      }
    }
    if (b.type === "table") {
      parts.push(`headers:${b.headers.length},rows:${b.rows.length}`);
    }
  }
  return simpleHash(parts.join("|"));
}

// ── Numeric diversity classification ──

const DATE_RE = /january|february|march|april|may|june|july|august|september|october|november|december|^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}\/\d{1,2}\/\d{4}$/i;
const CURRENCY_RE = /^\$|hk|usd|eur|gbp|jpy|cny|港元|港幣|美元|歐元|英鎊|日圓|人民幣/i;
const PERCENTAGE_RE = /[%％]/;
const RANGE_RE = /–|—|to\s+\d/i;
const SUFFIX_RE = /[xX×KkMmBb]$/;

function classifyOriginalValues(values: string[]): {
  hasDate: boolean; hasCurrency: boolean; hasPercentage: boolean;
  hasRange: boolean; hasSuffixNumber: boolean;
} {
  let hasDate = false, hasCurrency = false, hasPercentage = false;
  let hasRange = false, hasSuffixNumber = false;
  for (const v of values) {
    if (DATE_RE.test(v)) hasDate = true;
    if (CURRENCY_RE.test(v)) hasCurrency = true;
    if (PERCENTAGE_RE.test(v)) hasPercentage = true;
    if (RANGE_RE.test(v)) hasRange = true;
    if (SUFFIX_RE.test(v)) hasSuffixNumber = true;
  }
  return { hasDate, hasCurrency, hasPercentage, hasRange, hasSuffixNumber };
}

// ── Structural diversity helpers ──

function countInlineNodeTypes(blocks: EditorialBlock[]): {
  strongCount: number; emphasisCount: number; linkCount: number;
  hasList: boolean; hasTable: boolean;
} {
  let strongCount = 0, emphasisCount = 0, linkCount = 0;
  let hasList = false, hasTable = false;
  for (const b of blocks) {
    if (b.type === "list") hasList = true;
    if (b.type === "table") hasTable = true;
    const walk = (nodes: { type: string }[]) => {
      for (const n of nodes) {
        if (n.type === "strong") strongCount++;
        else if (n.type === "emphasis") emphasisCount++;
        else if (n.type === "link") linkCount++;
      }
    };
    if (b.type === "paragraph" || b.type === "subheading" || b.type === "quote") {
      walk(b.content);
    } else if (b.type === "list") {
      for (const item of b.items) walk(item);
    } else if (b.type === "table") {
      for (const h of b.headers) walk(h);
      for (const r of b.rows) for (const c of r) walk(c);
    }
  }
  return { strongCount, emphasisCount, linkCount, hasList, hasTable };
}

// ── Evidence control ──

export function isConclusionShadowEvidenceEnabled(): boolean {
  return process.env.ENABLE_STRUCTURED_TRANSLATION_SHADOW_EVIDENCE === "true";
}

// ── Record writer ──

export async function recordConclusionShadowEvidence(
  result: StructuredTranslationShadowResult,
  protectedBlocks: EditorialBlock[],
  protectionState: NumberProtectionState,
): Promise<void> {
  if (!result.attempted) return;

  const blockTypes = [...new Set(protectedBlocks.map((b) => b.type))];
  const struct = countInlineNodeTypes(protectedBlocks);
  const numClass = classifyOriginalValues(protectionState.originalValues);

  const record: ConclusionShadowEvidenceRecord = {
    timestamp: new Date().toISOString(),
    evidenceId: simpleHash(result.componentId + Date.now().toString()),
    componentIdHash: simpleHash(result.componentId),
    sourceStructureSignature: computeStructureSignature(protectedBlocks),
    shadowPassed: result.passed,
    repaired: result.repaired,
    errorCategories: categorizeErrors(result.errors),
    blockCount: protectedBlocks.length,
    blockTypes,
    hasMultipleParagraphs: protectedBlocks.filter((b) => b.type === "paragraph").length > 1,
    hasStrong: struct.strongCount > 0,
    hasEmphasis: struct.emphasisCount > 0,
    hasLinks: struct.linkCount > 0,
    linkCount: struct.linkCount,
    hasList: struct.hasList,
    hasTable: struct.hasTable,
    placeholderCount: protectionState.placeholders.length,
    hasDate: numClass.hasDate,
    hasCurrency: numClass.hasCurrency,
    hasPercentage: numClass.hasPercentage,
    hasRange: numClass.hasRange,
    hasSuffixNumber: numClass.hasSuffixNumber,
    numberPreserved: result.passed || !result.errors.some((e) => /number/i.test(e)),
    linksPreserved: result.passed || !result.errors.some((e) => /link/i.test(e)),
    placeholderIntegrityPassed: result.passed || !result.errors.some((e) => /placeholder/i.test(e)),
    conclusionPolicyPassed: result.passed || !result.errors.some((e) => /CTA|signup/i.test(e)),
    sourceCharacters: result.metrics?.sourceCharacters ?? 0,
    translatedCharacters: result.metrics?.translatedCharacters ?? 0,
    characterRatio: result.metrics?.characterRatio ?? 0,
  };

  const dir = path.resolve(getEvidenceDir());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, `evidence-${record.evidenceId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
}
