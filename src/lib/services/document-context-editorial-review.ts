// ── Bounded zh-HK editorial review (one extra DeepSeek call) ──
//
// After the one full-document translation + deterministic validation, a bounded
// editorial review call examines ONLY units selected by deterministic rules that
// are at risk of meaning, terminology, register or naturalness problems. The
// reviewer may ONLY return text-leaf edits addressed by server-generated opaque
// fieldIds. It may never return complete blocks or define structure. The server
// reconstructs the final document by applying accepted text edits onto a deep
// clone and rerunning full validation.
//
// Exactly one review call maximum. If the review call fails, is incomplete, is
// structurally invalid, exceeds mandatory capacity, or leaves a blocking finding
// unrepaired, the new translation is NOT saved and precise diagnostics are
// reported — there is no silent fallback to the unreviewed translation.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { buildFaqSchemaBlock } from "./document-context-shadow-preview";
import { resolveModelRouting, EDITORIAL_REVIEW_LABEL } from "./deepseek-model-routing";
import { getCantoneseIndexes, type CantoneseIndexes } from "./cantonese-corpus";
import {
  collectAlignedUnits,
  extractAutoAllowedEntities,
  findUnexpectedEnglishToken,
  applyZhHkLanguageQuality,
  type AlignedUnit,
} from "./zh-hk-language-quality";
import type { QualityReport } from "./shadow-cantonese-quality";
import { buildTranslationGlossaryPrompt } from "./translation-glossary";
import type { TranslationSourceDocument } from "./translation-source-document";
import { editorialStructureSignature } from "./editorial-block-translation";
import type { ChatMessage } from "./deepseek";
import type { ShadowProviderResponse } from "./shadow-number-protection";
import type { ZhHkStyleContract } from "./zh-hk-style-contract";
import { ZH_HK_AVOIDED_TERM_MARKERS } from "./zh-hk-style-contract";
import {
  buildEditableFieldIndex,
  applyEditableFieldEdits,
  type EditableField,
  type FieldIndex,
} from "./document-context-editable-fields";
import {
  findUnnaturalCalques,
  checkCtaParity,
  unresolvedMandatoryFindings,
} from "./editorial-review-gate";

// ── Selection constants ─────────────────────────────────────────────────────

/** Hard maximum number of selected units per review call. */
export const REVIEW_SELECTION_CAP = 25;

// Source-claim risk patterns (applied to the ENGLISH source text).
const CLAIM_CLAUSE_RE =
  /\b(reduce|reduces|reduced|reducing|increase|increases|increased|lead(?:s)? to|result(?:s)? in|because|therefore|so that|means|ensure(?:s)?|boost(?:s|ed)?|improve(?:s|d)?|lower|raise|cut|add to|create(?:s|d)?)\b/iu;
const RISK_OUTCOME_RE =
  /\b(risk|risks|effectiveness|performance|outcome(?:s)?|impact|benefit(?:s)?|value|worth|hazard|effective)\b/iu;
const ATTRIBUTION_RE =
  /\b(according to|per\b|says that|says|said|found|notes?|points out|reports|argues|states|notes that|warns?|puts it|observes?)\b/iu;
const SUPERLATIVE_RE =
  /\b(most|best|largest|biggest|strongest|fastest|top|leading|unmatched|most important|biggest mistake|highest|most popular|prominent)\b/iu;
const NEGATION_RE =
  /\b(not|never|no longer|doesn'?t|don'?t|won'?t|isn'?t|aren'?t|shouldn'?t|cannot|can'?t|wouldn'?t)\b/iu;
const FACTUAL_RE = /\b\d+(?:[.,]\d+)*%?|\$?\d[\d,.]*(?:%| dollars?|港元| HKD)?|\bHK\$\s?\d|\b\d+(?:st|nd|rd|th)\b/iu;

// Translation-risk patterns (applied to the CHINESE output).
const CALQUE_RE = /精製|大粉絲|人性化|被見到|被相信|賣到貨|大名人/gu;
const SLANG_RE = /人肉|靜靜雞|靚到爆|吹水|搞掂晒/gu;
const REDUNDANT_ALT_RE = /(創作者|意見領袖|KOL)\s*或者\s*(創作者|意見領袖|KOL)/gu;
const MAINLAND_RE = /營銷|視頻|網絡紅人|質量|信息|博主|素質/gu;
const UNNATURAL_PASSIVE_RE = /被(?!動|告|壓|迫|授權|選|指定|人|訪|捕|綁)/gu;

// Concrete avoided-language markers that must be surfaced for review. Derived from
// the style contract's authoritative marker list plus the proven V30 problem
// phrases (variants such as 觀眾檔案, and naturalness failures like 老實啲 / 標註朋友 /
// 租返嚟 / 隨機爆紅 / 成功同否). Markers are escaped so regex meta-characters are safe.
const AVOIDED_LANGUAGE_MARKERS = [
  ...ZH_HK_AVOIDED_TERM_MARKERS,
  "觀眾檔案",
  "受眾檔案",
  "儲存",
  "老實啲",
  "標註朋友",
  "人口群組",
  "隨機爆紅",
  "租返嚟",
  "被見到",
  "被相信",
  "成功同否",
  "了唔了解",
];
const AVOIDED_LANGUAGE_RE = new RegExp(AVOIDED_LANGUAGE_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");

const CREATOR_FAMILY_RE = /\b(creator|creators|influencer|influencers|kol|nano[- ]?influencer|micro[- ]?influencer|mid[- ]?tier|top[- ]?tier|macro[- ]?influencer)\b/iu;

// ── Reason mapping ──

export interface ReviewSelection {
  sourceUnitId: string;
  reasons: string[];
  mandatory: boolean;
}

function findingReason(messageCode: string): string | null {
  if (messageCode === "unexpected-english") return "untranslated-english";
  if (messageCode === "forbidden-terminology") return "mainland-terminology";
  if (messageCode.startsWith("glossary-")) return "glossary-collision";
  if (messageCode.startsWith("literal-mixed-particle") || messageCode.startsWith("literal-untranslated-verb") || messageCode.startsWith("literal-english-cn-auxiliary")) return "malformed-cantonese";
  if (messageCode === "simplified-chinese") return "mainland-terminology";
  if (messageCode === "corpus-collision") return "meaning-collision";
  if (messageCode === "corpus-rare-combination") return "naturalness";
  if (messageCode === "safe-normalization") return "register";
  return null;
}

function priorityOf(reasons: string[]): number {
  if (reasons.includes("mandatory-blocking-finding")) return 6;
  if (reasons.some((r) => ["factual-claim", "claim-clause", "claim-strength", "negation", "claim-inversion"].includes(r))) return 5;
  if (reasons.includes("attribution")) return 4;
  if (reasons.includes("avoided-language")) return 4;
  if (reasons.some((r) => ["meaning-collision", "redundant-alternative", "glossary-collision"].includes(r))) return 3;
  if (reasons.some((r) => ["terminology", "terminology-inconsistency"].includes(r))) return 2;
  return 1;
}

// Reason-count used for tie-breaking. Terminology-only reasons are excluded so a
// unit padded with terminology/terminology-inconsistency cannot out-rank a unit
// that carries a genuine claim, attribution, duplication or language-quality risk.
const TERMINOLOGY_REASONS = new Set(["terminology", "terminology-inconsistency"]);
function riskWeight(reasons: string[]): number {
  return reasons.filter((r) => !TERMINOLOGY_REASONS.has(r)).length;
}

// ── Terminology-inconsistency (per-unit, canonical-rendering aware) ──

/** Global-flagged regexes retain lastIndex across `.test()` calls. Reset before use. */
function testRe(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

const CREATOR_ZH_RENDERINGS = ["創作者", "KOL", "意見領袖", "網紅", "超小型創作者", "微型創作者", "中型創作者", "大型創作者", "頂級創作者"];

/** Which creator/tier renderings a unit's Chinese text actually contains. */
function zhCreatorRenderings(zh: string): Set<string> {
  return new Set(CREATOR_ZH_RENDERINGS.filter((r) => zh.includes(r)));
}

/**
 * Doc-level terminology-consistency. For each English creator/tier term used in
 * the article, gather the distinct Chinese renderings actually produced. A term is
 * genuinely inconsistent when it maps to >1 rendering; its canonical rendering is
 * the most common one. A unit earns `terminology-inconsistency` ONLY when it
 * carries a conflicted term AND renders it with a non-canonical Chinese form.
 */
function buildCanonicalRenderings(aligned: AlignedUnit[]): Map<string, string> {
  const termToRenderingCount = new Map<string, Map<string, number>>();
  for (const u of aligned) {
    if (!u.zh) continue;
    const renderings = zhCreatorRenderings(u.zh);
    if (renderings.size === 0) continue;
    const terms = (u.en.match(CREATOR_FAMILY_RE) || []).map((t) => t.toLowerCase());
    for (const term of terms) {
      const counts = termToRenderingCount.get(term) ?? new Map<string, number>();
      for (const r of renderings) counts.set(r, (counts.get(r) ?? 0) + 1);
      termToRenderingCount.set(term, counts);
    }
  }
  const canonicalByTerm = new Map<string, string>();
  for (const [term, counts] of termToRenderingCount) {
    if (counts.size < 2) continue; // rendered consistently -> not inconsistent
    let canonical = "";
    let max = -1;
    for (const [rendering, count] of counts) {
      if (count > max) { max = count; canonical = rendering; }
    }
    canonicalByTerm.set(term, canonical);
  }
  return canonicalByTerm;
}

/** True when this unit renders a conflicted term with a non-canonical Chinese form. */
function isUnitTerminologicallyInconsistent(unit: AlignedUnit, canonicalByTerm: Map<string, string>): boolean {
  if (!unit.zh) return false;
  const terms = (unit.en.match(CREATOR_FAMILY_RE) || []).map((t) => t.toLowerCase());
  const renderings = zhCreatorRenderings(unit.zh);
  if (renderings.size === 0) return false;
  for (const term of terms) {
    const canonical = canonicalByTerm.get(term);
    if (!canonical) continue;
    if (!renderings.has(canonical)) return true;
  }
  return false;
}

/**
 * Deterministically select units for editorial review.
 *
 * Mandatory selection: every unit with an active BLOCKING (critical/major) quality
 * finding is a mandatory candidate. Mandatory units receive the highest priority
 * and can never be displaced by the cap. If mandatory units alone exceed the
 * supported capacity, `capacityExceeded` is true (the caller must fail clearly).
 * Advisory candidates fill the remaining capacity, prioritised by risk tier.
 * Units with ONLY an unknown-corpus-token finding are never selected.
 */
export function selectEditorialReviewCandidates(params: {
  aligned: AlignedUnit[];
  qualityReport: QualityReport;
  indexes: CantoneseIndexes;
}): { selected: ReviewSelection[]; mandatoryCount: number; capacityExceeded: boolean } {
  const { aligned, qualityReport, indexes } = params;
  const findingByUnit = new Map<string, string[]>();
  const blockingByUnit = new Map<string, Set<string>>();
  for (const f of qualityReport.findings) {
    const reason = findingReason(f.messageCode);
    if (reason) findingByUnit.set(f.sourceUnitId, [...(findingByUnit.get(f.sourceUnitId) ?? []), reason]);
    if (f.severity === "critical" || f.severity === "major") {
      const set = blockingByUnit.get(f.sourceUnitId) ?? new Set<string>();
      set.add(f.messageCode);
      blockingByUnit.set(f.sourceUnitId, set);
    }
  }

  // Doc-level terminology-consistency: detect when a specific English creator/tier
  // term maps to >1 distinct Chinese rendering, and its canonical (most common)
  // rendering. Terminology-inconsistency is only added to a unit that genuinely
  // renders a conflicted term with a non-canonical form — never as unconditional
  // padding for merely containing 創作者.
  const canonicalByTerm = buildCanonicalRenderings(aligned);

  // Collision regex (bounded, corroborating only).
  const candidateTerms = new Map<string, string[]>();
  for (const [term, cands] of indexes.englishIndex) {
    const top = cands[0]?.cantonese;
    if (top) candidateTerms.set(top, [...(candidateTerms.get(top) ?? []), term]);
  }
  const collided = [...candidateTerms.entries()]
    .filter(([, terms]) => terms.length >= 2)
    .map(([top]) => top)
    .sort((a, b) => b.length - a.length)
    .slice(0, 500);
  const collisionRe = collided.length > 0 ? new RegExp(collided.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "u") : null;

  const mandatory: ReviewSelection[] = [];
  const advisory: ReviewSelection[] = [];
  for (const unit of aligned) {
    if (!unit.zh) continue;
    const reasons = new Set<string>([...(findingByUnit.get(unit.id) ?? [])]);

    // Source-claim risk (English).
    if (testRe(FACTUAL_RE, unit.en)) reasons.add("factual-claim");
    if (testRe(CLAIM_CLAUSE_RE, unit.en) || testRe(RISK_OUTCOME_RE, unit.en)) reasons.add("claim-clause");
    if (testRe(ATTRIBUTION_RE, unit.en)) reasons.add("attribution");
    if (testRe(SUPERLATIVE_RE, unit.en)) reasons.add("claim-strength");
    if (testRe(NEGATION_RE, unit.en)) reasons.add("negation");

    // Translation-risk patterns (Chinese).
    if (testRe(CALQUE_RE, unit.zh)) reasons.add("calque");
    if (testRe(SLANG_RE, unit.zh)) reasons.add("excessive-slang");
    if (testRe(REDUNDANT_ALT_RE, unit.zh)) reasons.add("redundant-alternative");
    if (testRe(MAINLAND_RE, unit.zh)) reasons.add("mainland-terminology");
    if (testRe(UNNATURAL_PASSIVE_RE, unit.zh)) reasons.add("unnatural-passive");
    if (testRe(AVOIDED_LANGUAGE_RE, unit.zh)) reasons.add("avoided-language");
    if (reasons.size > 0 && collisionRe && testRe(collisionRe, unit.zh)) reasons.add("meaning-collision");
    if (testRe(CREATOR_FAMILY_RE, unit.en) || /創作者|KOL|意見領袖|超小型創作者|微型創作者|中型創作者|大型創作者|頂級創作者/.test(unit.zh)) {
      reasons.add("terminology");
    }
    if (isUnitTerminologicallyInconsistent(unit, canonicalByTerm)) {
      reasons.add("terminology-inconsistency");
    }

    const blockingCodes = blockingByUnit.get(unit.id);
    if (blockingCodes && blockingCodes.size > 0) {
      // Mandatory blocking candidate: cannot be displaced by the cap.
      mandatory.push({ sourceUnitId: unit.id, reasons: ["mandatory-blocking-finding", ...[...blockingCodes]], mandatory: true });
      continue;
    }
    // Never select a unit for an unknown-corpus-token finding alone.
    if (reasons.size === 0) continue;
    if (reasons.size === 1 && findingByUnit.get(unit.id)?.length === 1 && findingByUnit.get(unit.id)![0] === "untranslated-english" && reasons.has("untranslated-english") && !unit.en) {
      continue;
    }
    advisory.push({ sourceUnitId: unit.id, reasons: [...reasons], mandatory: false });
  }

  const mandatoryCount = mandatory.length;
  const capacityExceeded = mandatoryCount > REVIEW_SELECTION_CAP;
  if (capacityExceeded) {
    // Mandatory units cannot be displaced; do not silently omit any of them.
    return { selected: [...mandatory].slice(0, REVIEW_SELECTION_CAP), mandatoryCount, capacityExceeded: true };
  }
  advisory.sort((a, b) => {
    const pa = priorityOf(a.reasons);
    const pb = priorityOf(b.reasons);
    if (pa !== pb) return pb - pa;
    return riskWeight(b.reasons) - riskWeight(a.reasons);
  });
  const remaining = REVIEW_SELECTION_CAP - mandatoryCount;

  // Protect avoided-language candidates from displacement: take the top `remaining`
  // ranked candidates, then if an avoided-language unit was pushed out by
  // higher-priority non-avoided padding, swap up to 2 of them back in (replacing
  // the lowest-priority non-avoided selections). When the cap has room for all
  // candidates this is a no-op — avoided units are never artificially limited.
  const AVOIDED_RESERVED_SLOTS = 2;
  const initialAdvisory = advisory.slice(0, remaining);
  const avoidedInInitial = initialAdvisory.filter((a) => a.reasons.includes("avoided-language")).length;
  const displacedAvoided = advisory.slice(remaining).filter((a) => a.reasons.includes("avoided-language"));
  const shortfall = Math.max(0, AVOIDED_RESERVED_SLOTS - avoidedInInitial);
  const selectedAdvisory = [...initialAdvisory];
  for (let i = 0; i < Math.min(shortfall, displacedAvoided.length); i++) {
    const replaceIdx = selectedAdvisory.reduce<number>(
      (worst, cur, idx) => {
        if (cur.reasons.includes("avoided-language")) return worst;
        if (worst === -1) return idx;
        const worstRisk = riskWeight(selectedAdvisory[worst].reasons);
        const curRisk = riskWeight(cur.reasons);
        return curRisk < worstRisk ? idx : worst;
      },
      -1,
    );
    if (replaceIdx === -1) break;
    selectedAdvisory[replaceIdx] = displacedAvoided[i];
  }
  const selected = [...mandatory, ...selectedAdvisory];
  return { selected, mandatoryCount, capacityExceeded: false };
}

// ── Review prompt ───────────────────────────────────────────────────────────

export interface ReviewUnit {
  sourceUnitId: string;
  en: string;
  zh: string;
  fields: EditableField[];
  reasons: string[];
  previous?: { id: string; en: string; zh: string };
  next?: { id: string; en: string; zh: string };
}

function extractNumbers(text: string): string[] {
  return [...new Set((text.match(/\d+(?:[.,]\d+)*%?|\$\d[\d,.]*|HK\$\s?\d+/g) || []))];
}
function extractUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/\S+/g) || []))];
}

/** Build the reviewer system prompt (glossary + style contract + constraints). */
export function buildEditorialReviewSystemPrompt(styleContract: ZhHkStyleContract): string {
  const preferred = [...styleContract.preferredTerms.entries()].map(([a, b]) => `${a} → ${b}`).join("; ");
  // Only emit avoided terms that have a real, non-identity preferred replacement.
  // Markers with no safe deterministic replacement are dropped from the map so the
  // reviewer is never told to "repair X into X"; they are still surfaced via the
  // unit's selection reason (avoided-language).
  const avoided = [...styleContract.avoidedTerms.entries()]
    .filter(([a, b]) => b !== a)
    .map(([a, b]) => `${a} → ${b}`).join("; ");
  return [
    "You are a senior bilingual Hong Kong Cantonese editor. Review selected translated units against their immutable English source and return JSON text-leaf edits only.",
    "",
    buildTranslationGlossaryPrompt(),
    "",
    "STYLE CONTRACT (professional Hong Kong Cantonese):",
    styleContract.translationProfile,
    preferred ? `PREFERRED TERMS: ${preferred}` : "",
    avoided ? `AVOIDED TERMS (repair these): ${avoided}` : "",
    "",
    "REVIEW REQUIREMENTS:",
    "- Compare every selected translation directly with its English source.",
    "- Preserve the EXACT meaning and claim strength. Never strengthen or weaken a claim.",
    "- CHECK CLAIM POLARITY: if the English source asserts a reduction/avoidance (e.g. 'reduces risk', 'fewer risks', 'avoids mistakes'), the Chinese must not imply the opposite (e.g. 'brings risk'). Reverse any inverted claim so it matches the source.",
    "- Remove invented claims, additions and unsupported attribution.",
    "- Repair omissions, inversions and meaning changes.",
    "- Use natural professional Hong Kong Cantonese; avoid excessive slang, translationese and Mainland wording.",
    "- Remove accidental untranslated English (e.g. 'nice-to-have') by translating it naturally.",
    "- Preserve useful Hong Kong code-switching (e.g. KPI, Instagram, Reel).",
    "- Keep terminology consistent across the article (creator/influencer/KOL/tier terms must stay distinct and correct).",
    "- DO NOT invent tier categories. Use only the tier terms present in the English source (e.g. nano, micro, macro, top-tier); never add or merge a tier that the English does not name (do not insert 中型 or 大型 unless the English says 'mid-tier' or 'macro').",
    "- A RETAIN decision is not a pass: a retained unit must still have none of the listed AVOIDED MARKERS and must read as natural Hong Kong Cantonese. If a retained unit contains a listed avoided marker or an awkward phrase (e.g. 活動廣告板, 觀眾檔案, 老實啲, 標註朋友, 租返嚟嘅名氣, 隨機爆紅, 被見到／被相信, 儲存, 成功同否, 佢哋了唔了解), return a REPLACE decision and fix it.",
    "- For LIST units: review and fix EVERY list item text. Do not repair only one item and leave other items awkward — check each supplied fieldId.",
    "- You may edit ONLY the supplied editable FIELD ID values. Edit only text; never structure.",
    "- Leave acceptable units unchanged (decision: retain with an empty edits array).",
    "",
    "FORBIDDEN:",
    "- Do NOT return complete blocks, nodes, paths, arrays of content, or any structure definition.",
    "- Do NOT invent fieldIds. Only reference the fieldIds supplied for each unit.",
    "- Do NOT summarise, add new information, or strengthen/weaken claims.",
    "- Do NOT change numbers, percentages, prices, dates or URLs.",
    "- Do NOT change source attribution (source names, 來源 citation links).",
    "- Do NOT change block type, list/table dimensions, heading level, inline structure, or link hrefs.",
    "- Do NOT edit adjacent read-only context.",
    "- Do NOT edit unselected units.",
    "- Return ONLY the JSON decision object. No drafts, explanations or notes.",
  ].join("\n");
}

/** Build the reviewer user prompt with selected units + editable fields + read-only context. */
export function buildEditorialReviewUserPrompt(units: ReviewUnit[]): string {
  const parts: string[] = ["Review the following selected source units. Return one decision object.", ""];
  const byId = new Map(units.map((u) => [u.sourceUnitId, u]));
  const orderedIds = units.map((u) => u.sourceUnitId);
  for (const id of orderedIds) {
    const u = byId.get(id)!;
    const nums = extractNumbers(u.en);
    const urls = extractUrls(u.en);
    const fieldsText = u.fields.length > 0
      ? u.fields.map((f) => `  - fieldId=${f.fieldId} | currentText=${f.currentText} | nodeType=${f.readOnlyContext.nodeType}${f.readOnlyContext.isLink ? " (link label; href immutable)" : ""}`).join("\n")
      : "  - (no editable fields)";
    parts.push(
      `### ${u.sourceUnitId}`,
      `ENGLISH: ${u.en}`,
      `CURRENT ZH-HK: ${u.zh}`,
      `PROTECTED: numbers=[${nums.join(",") || "none"}] urls=[${urls.join(",") || "none"}]`,
      `SELECTION REASONS: ${u.reasons.join(", ")}`,
      `EDITABLE FIELDS (edit only these text values):`,
      fieldsText,
    );
    if (u.previous) parts.push(`CONTEXT (previous, READ-ONLY, do NOT edit): ${u.previous.zh}`);
    if (u.next) parts.push(`CONTEXT (next, READ-ONLY, do NOT edit): ${u.next.zh}`);
    parts.push("");
  }
  parts.push(
    "RESPONSE FORMAT — return ONE JSON object:",
    JSON.stringify({
      decisions: [
        {
          sourceUnitId: "section.0.block.5",
          decision: "replace",
          edits: [{ fieldId: "f_xxxxxxx", replacementText: "修正後嘅文字" }],
          reasonCodes: ["meaning-fidelity", "terminology"],
        },
        {
          sourceUnitId: "section.1.block.2",
          decision: "retain",
          edits: [],
          reasonCodes: [],
        },
      ],
    }, null, 2),
    "",
    "- Provide EXACTLY one decision per selected sourceUnitId, in the same order as listed.",
    "- decision \"replace\" requires at least one valid edit referencing a supplied fieldId.",
    "- decision \"retain\" must have an EMPTY edits array.",
    "- reasonCodes are short codes such as meaning-inversion, claim-strength, attribution, omission, terminology, register, slang, translationese, naturalness, untranslated-english.",
  );
  return parts.join("\n");
}

export function buildEditorialReviewMessages(params: {
  units: ReviewUnit[];
  styleContract: ZhHkStyleContract;
}): ChatMessage[] {
  return [
    { role: "system", content: buildEditorialReviewSystemPrompt(params.styleContract) },
    { role: "user", content: buildEditorialReviewUserPrompt(params.units) },
  ];
}

// ── Decision parsing / validation ───────────────────────────────────────────

export interface ReviewEdit {
  fieldId: string;
  replacementText: string;
}

export interface ReviewDecision {
  sourceUnitId: string;
  decision: "replace" | "retain";
  edits: ReviewEdit[];
  reasonCodes: string[];
}

// Keys that would indicate the model is trying to define structure/nodes/paths.
const FORBIDDEN_STRUCTURE_KEYS = ["replacement", "block", "content", "children", "nodes", "paths", "items", "rows", "headers", "href", "url", "type", "ordered", "level", "text-node"];

export function parseEditorialReviewDecisions(content: string): ReviewDecision[] {
  const cleaned = content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned) as unknown;
  let raw: Array<Record<string, unknown>>;
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { decisions?: unknown }).decisions)) {
    raw = (parsed as { decisions: Array<Record<string, unknown>> }).decisions;
  } else {
    throw new Error("editorial-review: expected a JSON object with a decisions array");
  }
  return raw.map((d) => {
    if (typeof d.sourceUnitId !== "string" || (d.decision !== "replace" && d.decision !== "retain")) {
      throw new Error("editorial-review: decision missing sourceUnitId or invalid decision");
    }
    const edits = Array.isArray(d.edits)
      ? (d.edits as Array<Record<string, unknown>>).map((e) => {
          if (typeof e.fieldId !== "string" || typeof e.replacementText !== "string") {
            throw new Error("editorial-review: edit missing fieldId or replacementText");
          }
          return { fieldId: e.fieldId, replacementText: e.replacementText };
        })
      : [];
    return {
      sourceUnitId: d.sourceUnitId,
      decision: d.decision as "replace" | "retain",
      edits,
      reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes.map(String) : [],
    };
  });
}

export interface DecisionValidationResult {
  ok: boolean;
  errors: string[];
  decisions: ReviewDecision[];
}

/** Validate decisions against the selected set + the field index (schema-level). */
export function validateEditorialReviewDecisions(params: {
  decisions: ReviewDecision[];
  selectedUnitIds: string[];
  fieldIndex: FieldIndex;
  allowedEntities: ReadonlySet<string>;
}): DecisionValidationResult {
  const { decisions, selectedUnitIds, fieldIndex, allowedEntities } = params;
  const errors: string[] = [];
  const selectedSet = new Set(selectedUnitIds);

  // Structure-key rejection (a response attempting to define structure).
  for (const d of decisions) {
    for (const key of FORBIDDEN_STRUCTURE_KEYS) {
      if (key in (d as unknown as Record<string, unknown>)) {
        errors.push(`decision for ${d.sourceUnitId} attempts to define structure via "${key}"`);
      }
    }
  }

  const ids = decisions.map((d) => d.sourceUnitId);
  const duplicatedUnits = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicatedUnits.length > 0) errors.push(`duplicate unit decisions: ${[...new Set(duplicatedUnits)].join(", ")}`);

  const missingUnits = selectedUnitIds.filter((id) => !ids.includes(id));
  if (missingUnits.length > 0) errors.push(`selected unit missing a decision: ${missingUnits.join(", ")}`);

  const seenFieldIds = new Set<string>();
  for (const d of decisions) {
    if (!selectedSet.has(d.sourceUnitId)) {
      errors.push(`decision for unselected unit ${d.sourceUnitId}`);
      continue;
    }
    if (d.decision === "retain") {
      if (d.edits.length > 0) errors.push(`retain decision for ${d.sourceUnitId} contains edits`);
      continue;
    }
    if (d.decision === "replace") {
      if (d.edits.length === 0) {
        errors.push(`replace decision for ${d.sourceUnitId} has no valid edits`);
        continue;
      }
      for (const edit of d.edits) {
        const field = fieldIndex.byId.get(edit.fieldId);
        if (!field) {
          errors.push(`unknown field ${edit.fieldId} in unit ${d.sourceUnitId}`);
          continue;
        }
        if (field.sourceUnitId !== d.sourceUnitId) {
          errors.push(`field ${edit.fieldId} belongs to unit ${field.sourceUnitId}, not ${d.sourceUnitId}`);
          continue;
        }
        if (seenFieldIds.has(edit.fieldId)) {
          errors.push(`duplicate field ${edit.fieldId}`);
          continue;
        }
        seenFieldIds.add(edit.fieldId);
        const normalized = edit.replacementText.normalize("NFC");
        if (normalized.length === 0) {
          errors.push(`empty replacement for ${edit.fieldId}`);
          continue;
        }
        if (findUnexpectedEnglishToken(normalized, allowedEntities)) {
          errors.push(`field ${edit.fieldId} replacement contains unexpected English`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, decisions };
}

// ── Post-review structural integrity ──

/** Immutable structural fingerprint: block signatures, dims, heading levels, FAQ shape, metadata presence. */
export function documentStructureSignature(doc: ArticleDocument): string {
  const parts: string[] = [];
  parts.push(doc.introduction.blocks.map((b) => editorialStructureSignature([b])[0]).join("|"));
  for (const s of doc.sections) {
    parts.push(`heading:${s.headingLevel}`);
    parts.push(s.blocks.map((b) => editorialStructureSignature([b])[0]).join("|"));
  }
  parts.push(doc.conclusion.blocks.map((b) => editorialStructureSignature([b])[0]).join("|"));
  parts.push(`faq:${doc.visibleFaq.length}`);
  parts.push(`metadata:${doc.metadata.title.length}:${doc.metadata.metaDescription.length}:${doc.metadata.excerpt.length}`);
  return parts.join("§");
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface EditorialReviewOutcome {
  doc: ArticleDocument;
  status: "run" | "failed" | "not-run";
  selectedUnitIds: string[];
  selectedReasons: Array<{ sourceUnitId: string; reasons: string[]; mandatory: boolean }>;
  decisions: ReviewDecision[];
  appliedEditCount: number;
  retainedCount: number;
  failure: string | null;
  diagnostics: string[];
  callCount: number;
  truncated: boolean;
}

/** Run the bounded editorial review: select → call → parse → validate → apply → revalidate. */
export async function runEditorialReview(params: {
  enDoc: ArticleDocument;
  sourceDoc: TranslationSourceDocument;
  zhDoc: ArticleDocument;
  qualityReport: QualityReport;
  styleContract: ZhHkStyleContract;
  callProvider: (messages: ChatMessage[], options: Record<string, unknown>, label: string) => Promise<ShadowProviderResponse>;
}): Promise<EditorialReviewOutcome> {
  const { enDoc, sourceDoc, zhDoc, qualityReport, styleContract, callProvider } = params;
  void sourceDoc;
  const indexes = getCantoneseIndexes();
  const aligned = collectAlignedUnits(enDoc, zhDoc);
  const fieldIndex = buildEditableFieldIndex(zhDoc, enDoc);
  const allowedEntities = extractAutoAllowedEntities(enDoc);
  const { selected, mandatoryCount, capacityExceeded } = selectEditorialReviewCandidates({ aligned, qualityReport, indexes });

  const base: EditorialReviewOutcome = {
    doc: zhDoc, status: "not-run", selectedUnitIds: [], selectedReasons: [],
    decisions: [], appliedEditCount: 0, retainedCount: 0, failure: null, diagnostics: [], callCount: 0, truncated: false,
  };

  if (capacityExceeded) {
    return {
      ...base,
      status: "failed",
      failure: `mandatory review capacity exceeded (${mandatoryCount} mandatory units > ${REVIEW_SELECTION_CAP})`,
      diagnostics: ["mandatory review capacity exceeded", `mandatory=${mandatoryCount}`, `cap=${REVIEW_SELECTION_CAP}`],
      selectedUnitIds: selected.map((s) => s.sourceUnitId),
      selectedReasons: selected.map((s) => ({ sourceUnitId: s.sourceUnitId, reasons: s.reasons, mandatory: s.mandatory })),
    };
  }
  if (selected.length === 0) return base;

  const alignedById = new Map(aligned.map((u) => [u.id, u]));
  const ordered = aligned.map((u) => u.id);
  const units: ReviewUnit[] = selected.map((s) => {
    const pos = ordered.indexOf(s.sourceUnitId);
    const prev = pos > 0 ? alignedById.get(ordered[pos - 1]) : undefined;
    const next = pos >= 0 && pos < ordered.length - 1 ? alignedById.get(ordered[pos + 1]) : undefined;
    const cur = alignedById.get(s.sourceUnitId)!;
    return {
      sourceUnitId: s.sourceUnitId,
      en: cur.en,
      zh: cur.zh,
      fields: fieldIndex.byUnit.get(s.sourceUnitId) ?? [],
      reasons: s.reasons,
      previous: prev ? { id: prev.id, en: prev.en, zh: prev.zh } : undefined,
      next: next ? { id: next.id, en: next.en, zh: next.zh } : undefined,
    };
  });

  for (const s of selected) {
    console.warn(`[document-context-shadow] review select | unit=${s.sourceUnitId} | reasons=[${s.reasons.join(",")}]`);
  }

  const routing = resolveModelRouting(EDITORIAL_REVIEW_LABEL);
  const messages = buildEditorialReviewMessages({ units, styleContract });
  let response: ShadowProviderResponse;
  try {
    response = await callProvider(messages, {
      maxTokens: routing.maxTokens,
      timeoutMs: routing.timeoutMs,
      temperature: 0.2,
      model: routing.model,
      thinkingMode: routing.thinkingMode,
      reasoningEffort: routing.reasoningEffort,
      responseFormat: { type: "json_object" },
      maxRetries: 0,
    }, EDITORIAL_REVIEW_LABEL);
  } catch (error) {
    return { ...base, status: "failed", failure: `provider error: ${error instanceof Error ? error.message : String(error)}`, diagnostics: ["provider error"], callCount: 1 };
  }

  if (response.finishReason === "length" || response.truncated) {
    return { ...base, status: "failed", failure: "review call truncated", diagnostics: ["truncated review output"], callCount: 1, truncated: true };
  }
  if (!response.content || !response.content.trim()) {
    return { ...base, status: "failed", failure: "empty review response", diagnostics: ["empty review output"], callCount: 1 };
  }

  let decisions: ReviewDecision[];
  try {
    decisions = parseEditorialReviewDecisions(response.content);
  } catch (error) {
    return { ...base, status: "failed", failure: `malformed review decisions: ${error instanceof Error ? error.message : String(error)}`, diagnostics: ["malformed review JSON"], callCount: 1 };
  }

  const validation = validateEditorialReviewDecisions({
    decisions,
    selectedUnitIds: selected.map((s) => s.sourceUnitId),
    fieldIndex,
    allowedEntities,
  });
  console.warn(`[document-context-shadow] review decisions | returned=${decisions.length} valid=${validation.ok} rejected=${validation.errors.length}`);
  if (!validation.ok) {
    return { ...base, status: "failed", failure: `invalid review decisions: ${validation.errors.join("; ")}`, diagnostics: validation.errors, callCount: 1 };
  }

  const selectedUnitIdSet = new Set(selected.map((s) => s.sourceUnitId));
  const edits: Array<{ fieldId: string; replacementText: string }> = [];
  for (const d of decisions) {
    if (d.decision === "replace") edits.push(...d.edits);
  }
  // Log before/after text per changed field BEFORE application (deterministic
  // before-snapshot). After application the diff confirms which fields actually changed.
  const beforeTextByField = new Map<string, string>();
  for (const e of edits) {
    const field = fieldIndex.byId.get(e.fieldId);
    beforeTextByField.set(e.fieldId, field ? field.currentText : "<unknown>");
    console.warn(`[document-context-shadow] review edit | field=${e.fieldId} unit=${field?.sourceUnitId ?? "?"} before=${JSON.stringify(field?.currentText ?? "")} after=${JSON.stringify(e.replacementText)}`);
  }
  const applied = applyEditableFieldEdits(zhDoc, edits, fieldIndex, selectedUnitIdSet);
  console.warn(`[document-context-shadow] review apply | edits=${edits.length} accepted=${applied.applied.length} rejected=${applied.errors.length}`);
  if (applied.errors.length > 0) {
    return { ...base, status: "failed", failure: `invalid review edits: ${applied.errors.join("; ")}`, diagnostics: applied.errors, callCount: 1 };
  }

  // Post-apply: deterministic zh-HK normalisation + quality report; structure integrity.
  const { doc: normalizedDoc, report } = applyZhHkLanguageQuality(applied.doc, enDoc);
  const beforeSig = documentStructureSignature(zhDoc);
  const afterSig = documentStructureSignature(normalizedDoc);
  if (beforeSig !== afterSig) {
    return { ...base, status: "failed", failure: "review changed document structure", diagnostics: ["structure signature changed after review"], callCount: 1, doc: normalizedDoc };
  }

  // ── Strengthened post-editorial gate ──
  // 1. All mandatory findings (critical/major) must be resolved anywhere in the doc,
  //    not only on selected units.
  const remainingBlocking = unresolvedMandatoryFindings(report);
  console.warn(`[document-context-shadow] review scan | remainingMandatory=${remainingBlocking.length}`);
  if (remainingBlocking.length > 0) {
    for (const b of remainingBlocking) console.warn(`[document-context-shadow] review unresolved | unit=${b.sourceUnitId} finding=${b.messageCode}`);
    return {
      ...base, status: "failed",
      failure: `blocking finding(s) not repaired: ${remainingBlocking.map((f) => `${f.sourceUnitId}:${f.messageCode}`).join(", ")}`,
      diagnostics: remainingBlocking.map((f) => `${f.sourceUnitId}:${f.messageCode}`),
      callCount: 1,
      doc: normalizedDoc,
    };
  }
  // 2. Naturalness: removing an English token is not enough — reject unnatural
  //    calque replacements (e.g. nice-to-have → 有就最好).
  const calques = findUnnaturalCalques(normalizedDoc);
  if (calques.length > 0) {
    for (const c of calques) console.warn(`[document-context-shadow] review unnatural | unit=${c.sourceUnitId} marker=${c.marker} reason=${c.reason}`);
    return {
      ...base, status: "failed",
      failure: `unnatural review replacement(s): ${calques.map((c) => `${c.sourceUnitId}:${c.reason}`).join(", ")}`,
      diagnostics: calques.map((c) => `${c.sourceUnitId}:${c.reason}`),
      callCount: 1,
      doc: normalizedDoc,
    };
  }
  // 3. Protected CTA parity: all three value claims must survive.
  const ctaParity = checkCtaParity(normalizedDoc);
  console.warn(`[document-context-shadow] review cta | ok=${ctaParity.ok} missing=${ctaParity.missingClaims.join(",") || "none"}`);
  if (!ctaParity.ok) {
    return {
      ...base, status: "failed",
      failure: `protected CTA lost claim(s): ${ctaParity.missingClaims.join(", ")}`,
      diagnostics: [`CTA parity failed: missing ${ctaParity.missingClaims.join(", ")}`],
      callCount: 1,
      doc: normalizedDoc,
    };
  }

  // Final post-editorial quality scan summary.
  console.warn(`[document-context-shadow] review finalScan | critical=${report.criticalCount} major=${report.majorCount} minor=${report.minorCount} advisory=${report.advisoryCount}`);

  normalizedDoc.faqSchema = buildFaqSchemaBlock(normalizedDoc.visibleFaq);
  const retainedCount = decisions.filter((d) => d.decision === "retain").length;
  console.warn(`[document-context-shadow] review result | status=run applied=${applied.applied.length} retained=${retainedCount}`);
  return {
    doc: normalizedDoc,
    status: "run",
    selectedUnitIds: selected.map((s) => s.sourceUnitId),
    selectedReasons: selected.map((s) => ({ sourceUnitId: s.sourceUnitId, reasons: s.reasons, mandatory: s.mandatory })),
    decisions,
    appliedEditCount: applied.applied.length,
    retainedCount,
    failure: null,
    diagnostics: [],
    callCount: 1,
    truncated: false,
  };
}
