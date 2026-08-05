// ── Reusable pre-editorial Cantonese style linter ──
//
// A deterministic, reusable style linter that inspects an editorial batch's draft
// Chinese units BEFORE the editorial call and produces typed findings. It detects
// reusable issue classes (not article-specific strings) and never makes arbitrary
// sentence replacements. Findings are editorial guidance; the model does the
// rewriting within the existing three editorial calls.

import { classifyBlockEnglish } from "./shadow-cantonese-quality";
import { ZH_HK_AVOIDED_TERM_MARKERS, preferredReplacementFor } from "./zh-hk-style-contract";

export type LinterCategory =
  | "literal-structure"
  | "formal-register"
  | "unnecessary-code-switching"
  | "repetitive-template"
  | "terminology-inconsistency"
  | "source"
  | "semantic"
  | "language";

export type LinterSeverity = "minor" | "advisory" | "major";

export interface StyleFinding {
  findingId: string;
  sourceUnitId: string;
  category: LinterCategory;
  severity: LinterSeverity;
  safeToken?: string;
  instructionCode: string;
}

export interface LinterUnit {
  sourceUnitId: string;
  text: string;
}

// Small stable marker sets (NOT exhaustive blacklists). These are reusable issue
// signals plus structural/context detection.

const LITERAL_MARKERS: Array<[RegExp, string]> = [
  [/表露無遺/g, "rewrite-metaphor"],
  [/對齊/g, "rewrite-alignment"],
  [/自有品牌力量/g, "rewrite-owned-power"],
  [/沿途優化表現/g, "rewrite-funnel"],
  [/最終建立忠誠度嘅嘢/g, "rewrite-loyalty"],
  [/令所有人保持誠實/g, "rewrite-accountability"],
  [/從你嘅努力中學習/g, "rewrite-learn"],
  [/搵到嗰個匹配/g, "rewrite-match"],
  [/所以就係點解/g, "rewrite-tautology"],
];

const FORMAL_MARKERS: Array<[RegExp, string]> = [
  [/然而/g, "formal-transition"],
  [/因此/g, "formal-transition"],
  [/此外/g, "formal-transition"],
  [/從而/g, "formal-transition"],
  [/為此/g, "formal-transition"],
  [/進行/g, "formal-verb"],
  [/以及/g, "formal-listing"],
];

const REPETITIVE_TEMPLATE_RE = /所以就係點解/g;

const TERMINOLOGY_GROUPS: Array<{ variants: string[]; instructionCode: string }> = [
  { variants: ["代理公司", "市場推廣公司"], instructionCode: "consistent-agency-term" },
  { variants: ["粉絲", "追蹤者"], instructionCode: "consistent-follower-term" },
  { variants: ["質量", "質素"], instructionCode: "consistent-quality-term" },
  { variants: ["匹配", "吻合", "配合"], instructionCode: "consistent-fit-term" },
  { variants: ["發布", "發佈"], instructionCode: "consistent-publish-term" },
];

// ── Semantic findings (meaning drift / incomplete / role change) ──

const SEMANTIC_MARKERS: Array<[RegExp, string]> = [
  [/係咪匹配/gu, "incomplete-comparison"],
  [/有冇匹配/gu, "incomplete-comparison"],
  [/同你嘅.*係咪/g, "incomplete-comparison"],
  [/採用將[^。]*嘅[^。]*(?:KPI|指標)/gu, "literal-english-syntax"],
  [/變咗定義/gu, "meaning-role-change"],
  [/嘅定義/gu, "meaning-role-change"],
  [/完全改變人哋對[^。]*嘅定義/gu, "meaning-role-change"],
  [/由.../gu, "incomplete-comparison"],
];

// ── Language findings (register / hk form / slang / connectives) ──

const NON_HK_MARKERS: Array<[RegExp, string]> = [
  [/越來越/gu, "non-hk-terminology"],
  [/發布/g, "non-hk-terminology"],
  [/真實性/g, "non-hk-terminology"],
  [/人口群組/gu, "non-hk-terminology"],
  [/網絡/gu, "non-hk-terminology"],
  [/支持者/gu, "non-hk-terminology"],
];

const SLANG_MARKERS: Array<[RegExp, string]> = [
  [/有料到/g, "excessive-slang"],
  [/呃like/g, "excessive-slang"],
  [/爆紅/g, "excessive-slang"],
];

const MIXED_REGISTER_RE = /而係在於|而在於|在於/gu;
const UNNATURAL_COLLOCATION_RE = /隨住過程一路優化|一路優化表現/gu;
const ROBOTIC_CONNECTIVE_RE = /同時/g;

const EN_WORD_RE = /^[A-Za-z][A-Za-z-]{1,}$/;

// ── Deterministic hard/advisory rule IDs (reusable, never full sentences) ──

// Only objectively high-confidence, exactly matchable, publication-critical rules
// are HARD. Style-naturalness rules (register mixing, slang, unnatural terminology,
// literal English structure) are advisory: the wording is usually understandable
// and publishable, and the proofreader improves it as a quality target. The three
// source rules are owned by deterministic validation (source-reference-localization)
// and `malformed-cantonese` has no detector, so none of them belongs in the linter
// hard set.
export const HARD_RULE_IDS: ReadonlySet<string> = new Set([
  "mainland-register",
  "avoidable-code-switching",
]);

export function isHardRuleFinding(finding: StyleFinding): boolean {
  return HARD_RULE_IDS.has(finding.instructionCode);
}

// ── Actionable hard-finding classification + resolution ──

export type HardFindingWaiverCode =
  | "protected-unit"
  | "immutable-proper-noun"
  | "url-part"
  | "approved-brand"
  | "outside-editable-chinese";

export interface HardFindingWaiver {
  ruleId: string;
  sourceUnitId: string;
  waiverCode: HardFindingWaiverCode;
}

const VALID_WAIVER_CODES: ReadonlySet<string> = new Set<HardFindingWaiverCode>([
  "protected-unit",
  "immutable-proper-noun",
  "url-part",
  "approved-brand",
  "outside-editable-chinese",
]);

/** Only deterministic, code-generated waiver codes are accepted; free-form ones are rejected. */
export function isValidHardFindingWaiver(waiverCode: string): boolean {
  return VALID_WAIVER_CODES.has(waiverCode);
}

export interface ActionableHardFinding {
  sourceUnitId: string;
  ruleId: string;
  findingId?: string;
}

export interface HardFindingClassification {
  actionable: ActionableHardFinding[];
  waived: HardFindingWaiver[];
}

/**
 * Classify hard findings into actionable (must be resolved by the proofreader) and
 * deterministically waived (protected units, approved brands, URL parts, immutable
 * proper nouns, outside editable Chinese reader-facing content). A waived finding is
 * NOT required to resolve and carries a stable waiver code.
 */
export function classifyHardFindings(
  findings: StyleFinding[],
  opts: {
    isProtectedUnit: (sourceUnitId: string) => boolean;
    waiverFor: (finding: StyleFinding) => HardFindingWaiverCode | undefined;
  },
): HardFindingClassification {
  const actionable: ActionableHardFinding[] = [];
  const waived: HardFindingWaiver[] = [];
  for (const f of findings) {
    if (!isHardRuleFinding(f)) continue;
    if (opts.isProtectedUnit(f.sourceUnitId)) {
      waived.push({ ruleId: f.instructionCode, sourceUnitId: f.sourceUnitId, waiverCode: "protected-unit" });
      continue;
    }
    const waiver = opts.waiverFor(f);
    if (waiver) {
      waived.push({ ruleId: f.instructionCode, sourceUnitId: f.sourceUnitId, waiverCode: waiver });
      continue;
    }
    actionable.push({ sourceUnitId: f.sourceUnitId, ruleId: f.instructionCode, findingId: f.findingId });
  }
  return { actionable, waived };
}

export type HardFindingResolutionStatus = "resolved" | "remaining" | "introduced";

export interface HardFindingOutcome {
  sourceUnitId: string;
  ruleId: string;
  status: HardFindingResolutionStatus;
}

/**
 * Evaluate how the proofread resolved the pre-existing actionable hard findings.
 * Compares against the COMPLETE post-proofread document (not only changed units):
 * a hard finding still present in its unit is `remaining`; one that is gone is
 * `resolved`; a hard finding present after that was not actionable before is
 * `introduced`.
 */
export function evaluateHardFindingResolution(
  actionableBefore: ActionableHardFinding[],
  afterFindings: StyleFinding[],
): { outcomes: HardFindingOutcome[]; remaining: HardFindingOutcome[]; introduced: HardFindingOutcome[] } {
  const afterHard = new Set(afterFindings.filter(isHardRuleFinding).map((f) => `${f.sourceUnitId}\u0000${f.instructionCode}`));
  const beforeSet = new Set(actionableBefore.map((a) => `${a.sourceUnitId}\u0000${a.ruleId}`));
  const outcomes: HardFindingOutcome[] = actionableBefore.map((a) => ({
    sourceUnitId: a.sourceUnitId,
    ruleId: a.ruleId,
    status: afterHard.has(`${a.sourceUnitId}\u0000${a.ruleId}`) ? "remaining" : "resolved",
  }));
  const introduced: HardFindingOutcome[] = [];
  for (const f of afterFindings) {
    if (!isHardRuleFinding(f)) continue;
    if (!beforeSet.has(`${f.sourceUnitId}\u0000${f.instructionCode}`)) {
      introduced.push({ sourceUnitId: f.sourceUnitId, ruleId: f.instructionCode, status: "introduced" });
    }
  }
  const remaining = outcomes.filter((o) => o.status === "remaining");
  return { outcomes, remaining, introduced };
}

// ── Register drift (Mainland/formal wording in conversational Cantonese contexts) ──

const REGISTER_DRIFT_MARKERS: Array<[RegExp, string]> = [
  [/越來越/gu, "mainland-register"],
  [/正在/g, "mainland-register"],
  [/儘管/g, "mainland-register"],
  [/人口群組/gu, "mainland-register"],
];

// ── Literal-English structural categories (reusable patterns) ──

const LITERAL_ENGLISH_MARKERS: Array<[RegExp, string]> = [
  [/觀眾會獎勵嗰啲創作者/gu, "literal-english-syntax"],
  [/呢種諗法開始出現裂痕/gu, "literal-metaphor"],
  [/追住最大嘅名氣/gu, "literal-metaphor"],
  [/擴大做得好嘅嘢/gu, "literal-english-syntax"],
  [/要睇真偽/gu, "literal-metaphor"],
  [/在於對話，在於人同人之間嘅交流/gu, "redundant-comparative"],
  [/同一個真實嘅聲音合作/gu, "literal-english-syntax"],
];

// ── Slang policy: allow mild, flag as ADVISORY ──
// A single exact slang phrase (冇癮 / 爆紅 / 一千個心心 / 靜靜雞搞垮 / …) is a style
// preference, not proof of excess: it is understandably publishable and must never
// block saving. The proofreader improves it only when a passage becomes too casual.
const MILD_SLANG: readonly string[] = ["夾唔夾", "貼地", "頭痕", "照稿讀", "碌走"];
const EXCESSIVE_SLANG_MARKERS: Array<[RegExp, string]> = [
  [/靚到爆/g, "excessive-slang"],
  [/有料到/g, "excessive-slang"],
  [/靜靜雞搞垮/g, "excessive-slang"],
  [/一千個心心/g, "excessive-slang"],
  [/冇癮/g, "excessive-slang"],
];

// ── Code-switching: approved English terms allowed; avoidable words flagged ──

const ALLOWED_ENGLISH_TERMS: ReadonlySet<string> = new Set([
  "B2I", "Hub", "Instagram", "YouTube", "TikTok", "Threads", "WeChat", "Reel", "KPI", "B2C", "KOL",
]);

/** Approved English brand/platform/abbreviation terms that may remain English. */
export const APPROVED_ENGLISH_TERMS: ReadonlySet<string> = ALLOWED_ENGLISH_TERMS;

const AVOIDABLE_CODE_SWITCH_MARKERS: Array<[RegExp, string]> = [
  [/出\s*post\b/gu, "avoidable-code-switching"],
  [/\bfollowers\b/gu, "avoidable-code-switching"],
  [/\bengagement\b/gu, "avoidable-code-switching"],
  [/\bcampaign\b/gu, "avoidable-code-switching"],
  [/\bagency\b/gu, "avoidable-code-switching"],
  [/\bpost\b/gu, "avoidable-code-switching"],
];

// ── Unnatural terminology markers (reusable signals from the style contract) ──
// Shared single source of truth with `ZH_HK_AVOIDED_TERM_MARKERS` so the linter,
// the preferred-replacement map and the contract cannot drift.

const UNNATURAL_TERMINOLOGY_MARKERS: readonly string[] = ZH_HK_AVOIDED_TERM_MARKERS;

const CITATION_LABEL_RE = /^\s*(?:來源|資料來源|Source)\s*[：:]/iu;

/** True when a unit is a source citation line (來源：/資料來源：/Source:). */
export function isSourceCitationUnit(text: string): boolean {
  return CITATION_LABEL_RE.test(text.trimStart());
}

/** True when a citation line's title is still English (not yet localized). */
function isUnlocalizedSourceTitle(text: string): boolean {
  const m = text.trimStart().match(CITATION_LABEL_RE);
  if (!m) return false;
  const title = text.slice(m[0].length).replace(/[。.!?！？]+$/u, "");
  const latinChars = (title.match(/[A-Za-z]/g) || []).length;
  const cjkChars = (title.match(/[\u3400-\u9fff]/g) || []).length;
  return latinChars >= 4 && cjkChars === 0;
}

function firstOrdinaryEnglishToken(text: string): string | undefined {
  const noUrls = text.replace(/https?:\/\/\S+/gi, " ").replace(/[A-Za-z]+\$/g, "");
  const tokens = noUrls.replace(/[\u3400-\u9fff]+/g, " ").split(/[^\w-]+/).filter((t) => EN_WORD_RE.test(t));
  return tokens.find((t) => !ALLOWED_ENGLISH_TERMS.has(t));
}

function instructionText(code: string): string {
  switch (code) {
    case "rewrite-metaphor": return "Rewrite the English metaphor as a natural Cantonese idea rather than a literal translation.";
    case "rewrite-alignment": return "Rewrite 'alignment' naturally (e.g. 對目標有共識) instead of a literal 對齊.";
    case "rewrite-owned-power": return "Rewrite 'owned brand power' per context instead of 自有品牌力量.";
    case "rewrite-funnel": return "Rewrite the funnel metaphor naturally.";
    case "rewrite-loyalty": return "Rewrite loyalty wording as natural Cantonese (e.g. 長遠建立顧客忠誠度).";
    case "rewrite-accountability": return "Rewrite 'keeping everyone honest' as natural accountability phrasing.";
    case "rewrite-learn": return "Rewrite 'learning from efforts' naturally (e.g. 了解今次有咩做得好).";
    case "rewrite-match": return "Rewrite 'finding the match' naturally (e.g. 搵到真正適合嘅合作夥伴).";
    case "rewrite-tautology": return "Vary the 'that is why' connective; avoid repeating 所以就係點解.";
    case "formal-transition": return "Replace the formal written-Chinese transition with a conversational Cantonese equivalent.";
    case "formal-verb": return "Replace the formal verb construction with natural Cantonese.";
    case "formal-listing": return "Replace the formal listing construction with natural Cantonese.";
    case "review-code-switching": return "Review the ordinary English word; use natural Cantonese when one exists, keeping only brands/platforms/acronyms in English.";
    case "vary-connective": return "Vary the repeated connective template across the article.";
    case "consistent-agency-term": return "Use one consistent term (代理公司 or 市場推廣公司) across the article.";
    case "consistent-follower-term": return "Use one consistent term (粉絲 or 追蹤者) across the article.";
    case "consistent-quality-term": return "Use one consistent quality term (質量 or 質素) across the article.";
    case "consistent-fit-term": return "Use one consistent term (匹配 / 吻合 / 配合) across the article; prefer natural Hong Kong phrasing over 匹配.";
    case "consistent-publish-term": return "Use one consistent publish term (發布 or 發佈) across the article.";
    case "incomplete-comparison": return "Complete the comparison so it is not left dangling or ambiguous.";
    case "meaning-role-change": return "Restore the original meaning/role; a concept must not change (e.g. perception becoming definition).";
    case "literal-english-syntax": return "Rewrite the English-derived noun structure into natural Cantonese sentence order.";
    case "non-hk-terminology": return "Replace the Mainland / overly formal term with its Hong Kong Traditional Chinese form.";
    case "excessive-slang": return "Replace slang that weakens the professional business tone with a natural, credible Cantonese equivalent.";
    case "mixed-register": return "Keep the register consistent; do not mix formal written-Chinese wording inside conversational Cantonese.";
    case "unnatural-collocation": return "Rewrite the awkward collocation into natural Cantonese.";
    case "repetitive-connective": return "Vary the repeated connective (e.g. 同時) to avoid robotic repetition.";
    case "source-title-not-localized": return "Localize the source title into natural Traditional Chinese; keep the href unchanged and do not show the English original beside it.";
    case "mainland-register": return "Replace the Mainland/formal term with its natural Hong Kong Cantonese form (e.g. 越來越 → 越嚟越, 正在 → 而家正, 儘管 → 雖然, 在於 → 重點係, 人口群組 → 目標客群).";
    case "avoidable-code-switching": return "Replace the avoidable English word with its natural Cantonese term (post → 貼文, followers → 粉絲, engagement → 互動, campaign → 推廣活動, agency → 代理公司／市場推廣公司).";
    case "unnatural-terminology": return "Replace the unnatural term with the approved preferred wording (see terminology).";
    case "literal-metaphor": return "Rewrite the literal English metaphor as a natural Cantonese idea.";
    case "redundant-comparative": return "Remove the redundant comparative structure and rewrite naturally.";
    case "malformed-cantonese": return "Complete or fix the malformed/incomplete Cantonese sentence.";
    default: return "Review and rewrite naturally into Hong Kong Cantonese.";
  }
}

/**
 * Deterministic precedence used to collapse overlapping style findings that share
 * the identical matched span (e.g. 擴大做得好嘅嘢 firing both literal-english-syntax
 * and unnatural-terminology). Lower number wins; the winner is the primary category.
 */
const STYLE_FINDING_PRECEDENCE: ReadonlyMap<string, number> = new Map([
  ["mainland-register", 1],
  ["avoidable-code-switching", 2],
  ["literal-english-syntax", 3],
  ["unnatural-terminology", 4],
  ["mixed-register", 5],
  ["excessive-slang", 6],
]);

function styleFindingPrecedence(instructionCode: string): number {
  return STYLE_FINDING_PRECEDENCE.get(instructionCode) ?? 100;
}

/**
 * Deduplicate findings that describe the identical matched span in the same unit,
 * keeping only the highest-precedence primary category (so a phrase is never emitted
 * twice under overlapping style categories). Only the overlapping style rules in
 * `STYLE_FINDING_PRECEDENCE` are collapsed; unrelated rules (e.g. repetitive
 * connectives, non-blocking rewrite hints) that happen to share a span are never
 * merged, and findings without a matched phrase are keyed by their rule ID.
 */
export function dedupeStyleFindings(findings: StyleFinding[]): StyleFinding[] {
  const keptByKey = new Map<string, StyleFinding>();
  const result: StyleFinding[] = [];
  for (const f of findings) {
    if (!STYLE_FINDING_PRECEDENCE.has(f.instructionCode)) {
      result.push(f);
      continue;
    }
    const key = `${f.sourceUnitId}\u0000${f.safeToken ?? f.instructionCode}`;
    const existing = keptByKey.get(key);
    if (!existing) {
      keptByKey.set(key, f);
      result.push(f);
    } else if (styleFindingPrecedence(f.instructionCode) < styleFindingPrecedence(existing.instructionCode)) {
      const idx = result.indexOf(existing);
      if (idx >= 0) result[idx] = f;
      keptByKey.set(key, f);
    }
  }
  return result;
}

/**
 * Lint an editorial batch's draft units. Deterministic, per-batch scoped.
 * Returns typed findings with stable findingIds (deterministic order).
 */
export function lintEditorialDraft(units: LinterUnit[]): StyleFinding[] {
  const findings: StyleFinding[] = [];
  let seq = 0;
  const add = (sourceUnitId: string, category: LinterCategory, severity: LinterSeverity, instructionCode: string, safeToken?: string): void => {
    findings.push({ findingId: `finding-${++seq}`, sourceUnitId, category, severity, instructionCode, safeToken });
  };

  const batchText = units.map((u) => u.text).join("\n");
  const templateCount = (batchText.match(REPETITIVE_TEMPLATE_RE) || []).length;
  const connectiveCount = (batchText.match(ROBOTIC_CONNECTIVE_RE) || []).length;

  for (const group of TERMINOLOGY_GROUPS) {
    const present = group.variants.filter((v) => batchText.includes(v));
    if (present.length >= 2) {
      for (const unit of units) {
        if (group.variants.some((v) => unit.text.includes(v))) {
          add(unit.sourceUnitId, "terminology-inconsistency", "minor", group.instructionCode, present.join("/"));
        }
      }
    }
  }

  for (const unit of units) {
    const text = unit.text;
    if (!text) continue;

    // Source-reference citation lines are handled deterministically by
    // source-reference localization; they are NOT prose-edit targets. Only a
    // source-title localization finding may be raised for them, so the model is
    // never asked to "fix" preserved English brand names inside a citation.
    if (isSourceCitationUnit(text)) {
      if (isUnlocalizedSourceTitle(text)) {
        add(unit.sourceUnitId, "source", "minor", "source-title-not-localized", "english-source-title");
      }
      continue;
    }

    for (const [re, code] of LITERAL_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "literal-structure", "minor", code, m[0]);
    }
    for (const [re, code] of FORMAL_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "formal-register", "minor", code, m[0]);
    }
    if (classifyBlockEnglish(text) === "minor") {
      const token = firstOrdinaryEnglishToken(text);
      if (token) add(unit.sourceUnitId, "unnecessary-code-switching", "minor", "review-code-switching", token);
    }
    for (const [re, code] of AVOIDABLE_CODE_SWITCH_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "unnecessary-code-switching", "minor", code, m[0]);
    }
    for (const [re, code] of REGISTER_DRIFT_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "formal-register", "minor", code, m[0]);
    }
    for (const [re, code] of LITERAL_ENGLISH_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "literal-structure", "minor", code, m[0]);
    }
    for (const marker of UNNATURAL_TERMINOLOGY_MARKERS) {
      if (text.includes(marker)) add(unit.sourceUnitId, "terminology-inconsistency", "minor", "unnatural-terminology", marker);
    }
    const mildSlangHits = MILD_SLANG.filter((s) => text.includes(s)).length;
    if (mildSlangHits >= 2) add(unit.sourceUnitId, "language", "advisory", "mild-slang", "mild-slang");
    for (const [re, code] of EXCESSIVE_SLANG_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "language", "minor", code, m[0]);
    }
    if (templateCount >= 2) {
      const m = text.match(REPETITIVE_TEMPLATE_RE);
      if (m) add(unit.sourceUnitId, "repetitive-template", "minor", "vary-connective", "所以就係點解");
    }
    if (connectiveCount >= 3 && ROBOTIC_CONNECTIVE_RE.test(text)) {
      add(unit.sourceUnitId, "language", "minor", "repetitive-connective", "同時");
    }
    for (const [re, code] of SEMANTIC_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "semantic", "minor", code, m[0]);
    }
    for (const [re, code] of NON_HK_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "language", "minor", code, m[0]);
    }
    for (const [re, code] of SLANG_MARKERS) {
      const m = text.match(re);
      if (m) add(unit.sourceUnitId, "language", "minor", code, m[0]);
    }
    const mixed = text.match(MIXED_REGISTER_RE);
    if (mixed) add(unit.sourceUnitId, "language", "minor", "mixed-register", mixed[0]);
    const collocation = text.match(UNNATURAL_COLLOCATION_RE);
    if (collocation) add(unit.sourceUnitId, "language", "minor", "unnatural-collocation", collocation[0]);
  }

  return dedupeStyleFindings(findings);
}

// ── Batch-scoped finding response tokens ──
// The model must not reproduce canonical database-style finding IDs. Instead
// each finding gets a compact, deterministic, batch-unique response token
// (F001, F002, ...). The model returns tokens; the application maps them back
// to canonical finding IDs before storing diagnostics.

export interface EditorialFindingToken {
  /** Canonical internal finding ID (never sent to the model). */
  canonicalFindingId: string;
  /** Compact machine-safe response token the model sees and returns. */
  responseToken: string;
  /** The source-unit the finding belongs to (for batch ownership checks). */
  sourceUnitId: string;
}

// ── Reviewed-unchanged reason codes ──
// When the model deliberately leaves an advisory finding unchanged it must account
// for it with EXACTLY one closed reason code. Arbitrary free-form reasons are not
// accepted. Genuinely resolved findings never require a reason code.
export const REVIEWED_UNCHANGED_REASON_CODES = [
  "natural-already",
  "preferred-absent",
  "context-conflict",
  "source-fidelity",
] as const;

export type ReviewedUnchangedReasonCode = (typeof REVIEWED_UNCHANGED_REASON_CODES)[number];

/** True when a string is a valid reviewed-unchanged reason code. */
export function isValidReviewedUnchangedReasonCode(code: string): boolean {
  return (REVIEWED_UNCHANGED_REASON_CODES as readonly string[]).includes(code);
}

/**
 * The single authoritative key for an editorial patch target. Every live editorial
 * response patch must carry this property (never the legacy `unitId`). Shared by
 * the prompt builders, the response parser, the runtime shape validator and the
 * scope validators so the model, prompts, parser and validators cannot drift.
 */
export const EDITORIAL_PATCH_UNIT_KEY = "sourceUnitId" as const;

const RESPONSE_TOKEN_RE = /^F\d{3}$/;

/** True when a string is a valid finding response-token format (e.g. F001). */
export function isValidFindingResponseToken(token: string): boolean {
  return RESPONSE_TOKEN_RE.test(token);
}

/**
 * Build the deterministic per-batch response-token map for a findings array.
 * Tokens are generated in the same deterministic order as the findings, are
 * unique within the batch, and contain no natural-language prefix.
 */
export function buildFindingTokenMap(findings: StyleFinding[]): EditorialFindingToken[] {
  return findings.map((f, i) => ({
    canonicalFindingId: f.findingId,
    responseToken: `F${String(i + 1).padStart(3, "0")}`,
    sourceUnitId: f.sourceUnitId,
  }));
}

/** Render editorial findings as a compact prompt section using batch-scoped response tokens. */
export function buildEditorialFindingsPrompt(findings: StyleFinding[], tokenMap: EditorialFindingToken[] = buildFindingTokenMap(findings)): string {
  if (findings.length === 0) return "";
  const byId = new Map(tokenMap.map((t) => [t.canonicalFindingId, t.responseToken]));
  const lines = findings.map((f) => JSON.stringify({
    findingToken: byId.get(f.findingId) ?? f.findingId,
    sourceUnitId: f.sourceUnitId,
    category: f.category,
    severity: f.severity,
    instructionCode: f.instructionCode,
    matchedPhrase: f.safeToken ?? undefined,
    preferredReplacement: preferredReplacementFor(f.safeToken),
    instruction: instructionText(f.instructionCode),
  }));
  return [
    "EDITORIAL FINDINGS (review EVERY finding; copy each findingToken exactly):",
    ...lines,
    "Response contract: return ONLY { \"units\": [changed units], \"resolvedFindingTokens\": [\"F001\", ...], \"reviewedUnchangedFindings\": [{\"findingToken\": \"F002\", \"reasonCode\": \"natural-already\"}, ...] }.",
    "- Copy finding tokens exactly. Do not shorten, renumber, translate or reconstruct them.",
    "- Every supplied token must appear in exactly one accounting array:",
    "    resolvedFindingTokens — ONLY findings whose unit you genuinely improved with a real text change; a byte-identical patch is not a change and cannot justify a resolved token.",
    "    reviewedUnchangedFindings — findings you deliberately left unchanged, each with exactly one valid reasonCode (natural-already | preferred-absent | context-conflict | source-fidelity).",
    "- Return only supplied tokens. Never invent, renumber or reconstruct tokens.",
  ].join("\n");
}

// ── Monolingual (document-level) proofread findings ──
// The final editorial call reviews the complete revised Chinese document as
// independent Hong Kong business writing. It receives ONLY monolingual and
// document-level findings (never bilingual semantic/source categories, which
// belong to the two bilingual revision calls).

const MONOLINGUAL_CATEGORIES = new Set<LinterCategory>([
  "language",
  "terminology-inconsistency",
  "formal-register",
  "repetitive-template",
  "unnecessary-code-switching",
  "literal-structure",
]);

/** Cross-section terminology inconsistency: a preferred term varies across sections. */
function crossSectionTerminologyFindings(units: LinterUnit[], add: (sourceUnitId: string, category: LinterCategory, severity: LinterSeverity, instructionCode: string, safeToken?: string) => void): void {
  const perSection = new Map<string, Set<string>>();
  const sectionOf = (id: string): string => {
    const m = /^section\.(\d+)\./.exec(id);
    return m ? `section.${m[1]}` : id.split(".")[0] ?? id;
  };
  for (const unit of units) {
    const section = sectionOf(unit.sourceUnitId);
    if (!perSection.has(section)) perSection.set(section, new Set());
    perSection.get(section)!.add(unit.text);
  }
  for (const group of TERMINOLOGY_GROUPS) {
    const presentSections = [...perSection.entries()].filter(([, texts]) => {
      const all = [...texts].join("\n");
      return group.variants.filter((v) => all.includes(v)).length >= 2;
    });
    if (presentSections.length >= 2) {
      for (const unit of units) {
        if (group.variants.some((v) => unit.text.includes(v))) {
          add(unit.sourceUnitId, "terminology-inconsistency", "minor", group.instructionCode, presentSections.map(([s]) => s).join("|"));
        }
      }
    }
  }
}

/**
 * Run monolingual document-level findings over the complete revised Chinese
 * document. Only language / terminology-consistency / register / repetition
 * categories are returned; bilingual and source categories are excluded so the
 * final proofread is isolated from English prose.
 */
export function lintMonolingualDocument(units: LinterUnit[]): StyleFinding[] {
  const all = lintEditorialDraft(units);
  const findings = all.filter((f) => MONOLINGUAL_CATEGORIES.has(f.category));
  let seq = findings.reduce((max, f) => {
    const m = /^finding-(\d+)$/.exec(f.findingId);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const add = (sourceUnitId: string, category: LinterCategory, severity: LinterSeverity, instructionCode: string, safeToken?: string): void => {
    findings.push({ findingId: `finding-${++seq}`, sourceUnitId, category, severity, instructionCode, safeToken });
  };
  crossSectionTerminologyFindings(units, add);
  return findings;
}

export interface ProofreadFindingComparison {
  sourceUnitId: string;
  resolvedRuleIds: string[];
  introducedRuleIds: string[];
  remainingRuleIds: string[];
}

/**
 * Compare hard-rule findings before and after the monolingual proofread, per changed
 * unit. Used by the before/after editorial quality gate: a change that INTRODUCES a
 * new hard-rule finding is rejected; resolving hard findings while leaving advisory
 * findings is accepted.
 */
export function compareProofreadFindings(before: StyleFinding[], after: StyleFinding[], changedUnitIds: string[]): ProofreadFindingComparison[] {
  const comparisons: ProofreadFindingComparison[] = [];
  for (const unitId of changedUnitIds) {
    const beforeHard = new Set(before.filter((f) => f.sourceUnitId === unitId && isHardRuleFinding(f)).map((f) => f.instructionCode));
    const afterHard = new Set(after.filter((f) => f.sourceUnitId === unitId && isHardRuleFinding(f)).map((f) => f.instructionCode));
    comparisons.push({
      sourceUnitId: unitId,
      resolvedRuleIds: [...beforeHard].filter((r) => !afterHard.has(r)),
      introducedRuleIds: [...afterHard].filter((r) => !beforeHard.has(r)),
      remainingRuleIds: [...afterHard].filter((r) => beforeHard.has(r)),
    });
  }
  return comparisons;
}

/**
 * Render monolingual findings GROUPED BY UNIT so a unit with multiple findings is
 * represented exactly once in the prompt. Each unit carries all of its finding
 * tokens, and the model must produce ONE consolidated revision per unit. This
 * prevents the model from returning one patch per finding for the same unit.
 */
export function buildMonolingualFindingsPrompt(findings: StyleFinding[], tokenMap: EditorialFindingToken[] = buildFindingTokenMap(findings)): string {
  if (findings.length === 0) return "";
  const byUnit = new Map<string, StyleFinding[]>();
  for (const f of findings) {
    const arr = byUnit.get(f.sourceUnitId);
    if (arr) arr.push(f);
    else byUnit.set(f.sourceUnitId, [f]);
  }
  const byId = new Map(tokenMap.map((t) => [t.canonicalFindingId, t.responseToken]));
  const lines = [...byUnit.entries()].map(([sourceUnitId, unitFindings]) => JSON.stringify({
    [EDITORIAL_PATCH_UNIT_KEY]: sourceUnitId,
    findingTokens: unitFindings.map((f) => byId.get(f.findingId)),
    findings: unitFindings.map((f) => ({
      findingToken: byId.get(f.findingId),
      category: f.category,
      instructionCode: f.instructionCode,
      matchedPhrase: f.safeToken ?? undefined,
      preferredReplacement: preferredReplacementFor(f.safeToken),
      instruction: instructionText(f.instructionCode),
    })),
  }));
  return [
    "MONOLINGUAL FINDINGS (grouped per unit; review EVERY finding for the unit together and produce ONE final consolidated revision per unit):",
    ...lines,
    "Response contract: return ONLY { \"units\": [genuinely changed units], \"reviewedUnchangedFindings\": [{\"findingToken\": \"F002\", \"reasonCode\": \"natural-already\"}, ...] }.",
    "- Copy finding tokens exactly. Do not shorten, renumber, translate or reconstruct them.",
    "- Rewrite units only when their reader-facing Chinese content genuinely changes. Never echo an unchanged unit in `units`.",
    "- Do not report which findings were resolved — the application determines resolution by comparing the final document with the supplied findings.",
    "- For every finding you deliberately leave unchanged, include its finding token in `reviewedUnchangedFindings` with exactly one valid reasonCode (natural-already | preferred-absent | context-conflict | source-fidelity).",
    "- Improve awkward but publishable wording when a clearly better, more natural and more professional Hong Kong Cantonese version is available; leave it unchanged only when it is already natural and professional.",
    "- Return only supplied tokens.",
    `- Each ${EDITORIAL_PATCH_UNIT_KEY} may appear at most ONCE in units. Never return separate revisions for separate findings.`,
    "- Unchanged units must not appear in units.",
  ].join("\n");
}


