// ── Shadow Cantonese quality (deterministic, no AI stages) ──
//
// Deterministic post-editorial quality fixes for the coherent shadow translation
// document. These are pure text transforms over the assembled Chinese
// ArticleDocument — no provider calls, no repair loops, no new stages. They
// only fix clear, safe terminology drift, one obvious typo, the English CTA,
// and produce a severity-based translation-quality report for the primary gate.
//
// Sentence naturalness is NOT rewritten here; that remains the responsibility
// of the existing three bilingual editorial batches.

import type { ArticleDocument, EditorialBlock, ProtectedArticleBlock } from "@/lib/blog/article-document";
import { fingerprintHtml } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import type { SourceReferenceFinding } from "./source-reference-localization";

// ── Approved CTA copy for the Traditional Chinese shadow document ──

export const SHADOW_CTA_COPY = {
  heading: "準備好同香港創作者一齊拓展你嘅品牌？",
  body: "B2I Hub 直接連繫企業同已認證創作者，毋須經代理、毋須佣金、亦無中間人。免費建立商業檔案，今日就開始合作。",
  button: "免費建立商業檔案 →",
};

// ── Deterministic terminology cleanup (approved glossary base) ──
// Word-boundary, case-insensitive replacements for safe, clear terminology drift.
// This is an approved product terminology base, NOT a general-purpose sentence
// rewriter. Order matters: longer phrases first so shorter rules do not
// double-process.

export const SHADOW_TERMINOLOGY_RULES: Array<[RegExp, string]> = [
  [/\binfluencer marketing\b/gi, "創作者市場推廣"],
  [/\bengagement rate\b/gi, "互動率"],
  [/\bengagement\b/gi, "互動"],
  [/\binfluencers?\b/gi, "創作者"],
  [/\bcampaigns?\b/gi, "推廣活動"],
  [/\bfollowers?\b/gi, "粉絲"],
  [/\bsaves\b/gi, "儲存"],
  [/\bshares\b/gi, "分享"],
  [/\bcomments\b/gi, "留言"],
  [/\brate card\b/gi, "收費表"],
  [/\bbrief\b/gi, "合作簡報"],
  [/\bLikes?\b/gi, "讚好"],
  // Stable Hong Kong locale conventions (editable prose only; source/citation
  // titles are excluded upstream).
  [/奈米創作者/g, "納米創作者"],
  [/奈米網紅/g, "納米網紅"],
];

/**
 * Normalize terminology + the obvious typo in a plain-text run. When `counter`
 * is provided, it records the number of glossary normalizations applied.
 */
export function normalizeShadowTerminologyText(text: string, counter?: { glossary: number }): string {
  let out = text;
  for (const [re, replacement] of SHADOW_TERMINOLOGY_RULES) {
    re.lastIndex = 0;
    const occurrences = out.split(re).length - 1;
    if (occurrences > 0) {
      out = out.replace(re, replacement);
      if (counter) counter.glossary += occurrences;
    }
  }
  const before = out;
  out = out.replace(/脗合/g, "吻合");
  if (counter && out !== before) counter.glossary += (before.split(/脗合/g).length - 1);
  return out;
}

/** Normalize terminology inside HTML text without touching tags or attributes. */
export function normalizeShadowTerminologyHtml(html: string): string {
  const masks: string[] = [];
  const masked = html.replace(/<[^>]*>/g, (tag) => {
    masks.push(tag);
    return `\u0000${masks.length - 1}\u0000`;
  });
  const cleaned = normalizeShadowTerminologyText(masked);
  return cleaned.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

// ── Deterministic Cantonese typography normalization ──

const TYPO_CJK = "\\u3400-\\u9fff";
const TYPO_CJK_PUNCT = "，。！？：；、（）「」『』〈〉《》【】";

/**
 * Normalize objectively unnecessary whitespace and punctuation spacing in
 * Chinese prose. Only removes ASCII spaces whose neighbours are both CJK or CJK
 * punctuation, so spaces inside Latin proper names ("B2I Hub", "Open Influence"),
 * URLs and numbers are preserved.
 */
export function normalizeCantoneseTypographyText(text: string): string {
  let out = text;
  out = out.replace(/ {2,}/g, " ");
  out = out.replace(new RegExp(`(?<=[${TYPO_CJK}${TYPO_CJK_PUNCT}]) (?=[${TYPO_CJK}${TYPO_CJK_PUNCT}])`, "g"), "");
  // Deduplicate repeated CJK terminal punctuation introduced by rendering.
  out = out.replace(/([。！？]){2,}/g, "$1");
  return out;
}

/** Typography normalization inside HTML text without touching tags/attributes. */
export function normalizeCantoneseTypographyHtml(html: string): string {
  const masks: string[] = [];
  const masked = html.replace(/<[^>]*>/g, (tag) => {
    masks.push(tag);
    return `\u0000${masks.length - 1}\u0000`;
  });
  const cleaned = normalizeCantoneseTypographyText(masked);
  return cleaned.replace(/\u0000(\d+)\u0000/g, (_m, i) => masks[Number(i)]);
}

const TERMINAL_PUNCT = /[.?!。？！]/;

/**
 * Fix citation/source-title blocks that end with duplicated terminal punctuation
 * (e.g. "Open Influence Inc..", "Hong Kong?.", "推廣？。"). If the title already
 * ends with a terminal mark, the renderer must not append another. Works for any
 * source title; no title-specific rules.
 */
function fixCitationTrailingPunctuation(block: EditorialBlock): EditorialBlock {
  if (block.type === "list" || block.type === "table") return block;
  const content = block.content;
  if (content.length === 0) return block;
  const lastIdx = content.length - 1;
  const last = content[lastIdx];
  const lastText = typeof last.text === "string" ? last.text : "";
  const before = content.slice(0, lastIdx).map((n) => n.text ?? "").join("").replace(/\s+$/g, "");
  let newLast = lastText;
  if (TERMINAL_PUNCT.test(before.slice(-1))) {
    // The title already ends with terminal punctuation: strip trailing terminal
    // punctuation added outside the title/link.
    newLast = lastText.replace(/^[\s]*[.?!。？！]+[\s]*$/g, "");
  } else {
    // Collapse a trailing run of 2+ terminal punctuation to its first character.
    newLast = newLast.replace(/([.?!。？！]){2,}(\s*)$/g, "$1$2");
  }
  if (newLast === lastText) return block;
  return { ...block, content: [...content.slice(0, lastIdx), { ...last, text: newLast }] };
}

function applyTextQuality(text: string, counter?: { glossary: number }): string {
  return normalizeCantoneseTypographyText(normalizeShadowTerminologyText(text, counter));
}

function applyTextQualityHtml(html: string): string {
  return normalizeCantoneseTypographyHtml(normalizeShadowTerminologyHtml(html));
}

/** Build unit-level editorial review hints from the severity-based English classifier. */
export function buildShadowQualityHints(units: Array<{ sourceUnitId: string; text: string }>): string {
  const lines: string[] = [];
  for (const unit of units) {
    const severity = classifyBlockEnglish(unit.text);
    if (severity === "minor") {
      const token = firstNonApprovedToken(unit.text) ?? "";
      lines.push(`- unit ${unit.sourceUnitId}: isolated mixed-language term "${token}" — review and rewrite naturally into Cantonese where appropriate.`);
    } else if (severity === "major") {
      lines.push(`- unit ${unit.sourceUnitId}: untranslated English — rewrite fully into natural Cantonese.`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "REVIEW HINTS (unit-level editorial guidance, NOT mandatory replacements):",
    ...lines,
    "Review each hinted unit and, when the English is unnecessary or awkward, rewrite it naturally into Hong Kong Cantonese while preserving meaning, numbers, URLs, structure and source-unit IDs.",
  ].join("\n");
}

// ── Citation-block detection (source-title lines are excluded from cleanup) ──

const CITATION_RE = /^\s*(?:來源|資料來源|Source)\s*[：:]/iu;

function blockVisibleText(block: EditorialBlock): string {
  const collect = (nodes: InlineContent[]): string => nodes.map((n) => n.text ?? "").join("");
  switch (block.type) {
    case "list":
      return block.items.map(collect).join(" ");
    case "table":
      return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
    default:
      return collect(block.content);
  }
}

function isCitationBlock(block: EditorialBlock): boolean {
  return CITATION_RE.test(blockVisibleText(block).trimStart());
}

function cleanInline(nodes: InlineContent[], counter?: { glossary: number }): InlineContent[] {
  return nodes.map((node) => ({
    ...node,
    text: typeof node.text === "string" ? applyTextQuality(node.text, counter) : node.text,
  }));
}

function cleanBlock(block: EditorialBlock, counter?: { glossary: number }): EditorialBlock {
  if (isCitationBlock(block)) return fixCitationTrailingPunctuation(block);
  switch (block.type) {
    case "list":
      return { ...block, items: block.items.map((nodes) => cleanInline(nodes, counter)) };
    case "table":
      return { ...block, headers: block.headers.map((nodes) => cleanInline(nodes, counter)), rows: block.rows.map((row) => row.map((nodes) => cleanInline(nodes, counter))) };
    default:
      return { ...block, content: cleanInline(block.content, counter) };
  }
}

// ── CTA localization ──

function localizeCta(cta: ProtectedArticleBlock | null): ProtectedArticleBlock | null {
  if (!cta) return cta;
  const hasWrapper = /<!--\s*wp:html\s*-->/.test(cta.html);
  let inner = cta.html.replace(/<!--\s*wp:html\s*-->/, "").replace(/<!--\s*\/wp:html\s*-->/, "").trim();
  inner = inner
    .replace(/(<h[12]\b[^>]*>)[\s\S]*?(<\/h[12]>)/i, (_m, open, close) => `${open}${SHADOW_CTA_COPY.heading}${close}`)
    .replace(/(<p\b[^>]*>)[\s\S]*?(<\/p>)/i, (_m, open, close) => `${open}${SHADOW_CTA_COPY.body}${close}`)
    .replace(/(<a\b[^>]*>)[\s\S]*?(<\/a>)/i, (_m, open, close) => `${open}${SHADOW_CTA_COPY.button}${close}`);
  const html = hasWrapper ? `<!-- wp:html -->\n${inner}\n<!-- /wp:html -->` : inner;
  return { ...cta, html, fingerprint: fingerprintHtml(html) };
}

// ── Severity-based translation-quality findings ──
// Replaces the binary prohibited-term gate with a professional, severity-based
// model. One isolated mixed-language expression is NOT equivalent to an
// untranslated paragraph.

export type QualitySeverity = "critical" | "major" | "minor" | "advisory";

export type QualityCategory =
  | "english-leak"
  | "terminology"
  | "structure"
  | "placeholder"
  | "faq-parity"
  | "url"
  | "number"
  | "protected-html"
  | "coverage"
  | "assembly"
  | "source-reference"
  | "semantic"
  | "language";

export interface QualityFinding {
  sourceUnitId: string;
  category: QualityCategory;
  severity: QualitySeverity;
  /** Safe matched token (never a full article sentence/paragraph). */
  matchedToken?: string;
  messageCode: string;
  /** The canonical replacement or expected value for a corrective finding. */
  replacement?: string;
  /** Whether the finding was auto-corrected, blocked saving, or is diagnostic-only. */
  action?: "corrected" | "blocked" | "diagnostic";
  /** The exact offending token that triggered the blocked finding. */
  offendingToken?: string;
  /** Short bounded window of translated text surrounding the offending token. */
  context?: string;
  /** Whether the offending English token appeared in the aligned English source. */
  tokenInSource?: boolean;
  /** Whether the offending English token is in the permanent allowlist. */
  tokenInAllowlist?: boolean;
  /** Whether the offending English token matched an auto-extracted entity. */
  tokenInAutoEntities?: boolean;
  /** The exact detector rule identifier that fired (e.g. literal-untranslated-verb). */
  detectorRule?: string;
}

export interface QualityReport {
  findings: QualityFinding[];
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  advisoryCount: number;
  glossaryNormalizations: number;
  approvedNameExemptions: number;
}

export function emptyQualityReport(): QualityReport {
  return {
    findings: [], criticalCount: 0, majorCount: 0, minorCount: 0, advisoryCount: 0,
    glossaryNormalizations: 0, approvedNameExemptions: 0,
  };
}

// Approved brand/platform/acronym tokens that are exempt/advisory (never fatal).
// Unknown proper names are handled heuristically and do not need manual additions.
export const APPROVED_EN_TERMS: ReadonlySet<string> = new Set([
  "instagram", "youtube", "tiktok", "wechat", "xiaohongshu", "facebook", "threads",
  "kpi", "roi", "ctr", "b2c", "b2b", "cpa", "cpm", "reel", "reels", "kol",
  "ykone", "open", "influence", "assembly", "starngage", "luna", "anymind",
  "b2i", "hub", "sme", "smme", "dtc",
]);

function isApprovedTerm(token: string): boolean {
  return APPROVED_EN_TERMS.has(token.toLowerCase());
}

/**
 * Conservative block-level English classification for editable prose.
 * Returns a severity for the whole block. It excludes HTML/URLs/citation blocks
 * upstream; here it only inspects visible prose text.
 *   - major:   genuine untranslated sentence/paragraph or an English-heavy block;
 *   - minor:   isolated mixed-language term(s) surrounded by natural Chinese;
 *   - advisory: only approved brands, platform names, acronyms or proper names;
 *   - none:    no English.
 */
/** Remove currency prefixes (e.g. HK$, US$, €) so a currency symbol is not miscounted as English prose. */
function stripCurrencyPrefixes(text: string): string {
  return text.replace(/[A-Za-z]+\$/g, "");
}

export function classifyBlockEnglish(blockText: string): "major" | "minor" | "advisory" | "none" {
  const noUrls = blockText.replace(/https?:\/\/\S+/gi, " ");
  const noCurrency = stripCurrencyPrefixes(noUrls);
  const tokens = noCurrency
    .replace(/[\u3400-\u9fff]+/g, " ")
    .split(/[^\w-]+/)
    .filter((t) => /^[A-Za-z][A-Za-z-]{1,}$/.test(t));
  if (tokens.length === 0) return "none";

  // Longest run of consecutive ORDINARY (non-approved) English word tokens.
  // Approved brand/platform names break the run so a CJK-punctuation-joined brand
  // list ("YKONE、Open Influence、Assembly") is never mistaken for prose.
  let best = 0;
  let cur = 0;
  for (const t of tokens) {
    if (!isApprovedTerm(t)) { cur += 1; best = Math.max(best, cur); } else { cur = 0; }
  }
  if (best >= 5) return "major";

  // English-heavy block: little meaningful CJK and substantial ordinary English.
  const latinChars = (noCurrency.match(/[A-Za-z]/g) || []).length;
  const cjkChars = (noCurrency.match(/[\u3400-\u9fff]/g) || []).length;
  if (latinChars > 0 && cjkChars < 30 && latinChars > 60) return "major";

  const hasOrdinary = tokens.some((t) => !isApprovedTerm(t));
  if (hasOrdinary) return "minor";
  return "advisory";
}

function editableUnitText(block: EditorialBlock): string {
  if (isCitationBlock(block)) return "";
  return blockVisibleText(block);
}

/** Enumerate editable non-citation Chinese text units with their source-unit IDs. */
export function collectEditableUnits(doc: ArticleDocument): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const push = (id: string, text: string) => { if (text) out.push({ id, text }); };
  push("metadata.title", doc.metadata.title);
  push("metadata.metaDescription", doc.metadata.metaDescription);
  push("metadata.excerpt", doc.metadata.excerpt);
  doc.introduction.blocks.forEach((b, i) => push(`introduction.block.${i}`, editableUnitText(b)));
  doc.sections.forEach((s, si) => {
    push(`section.${si}.heading`, s.heading);
    s.blocks.forEach((b, bi) => push(`section.${si}.block.${bi}`, editableUnitText(b)));
  });
  doc.conclusion.blocks.forEach((b, i) => push(`conclusion.block.${i}`, editableUnitText(b)));
  doc.visibleFaq.forEach((f, i) => {
    push(`faq.${i}.question`, f.question);
    push(`faq.${i}.answer`, f.answerText);
  });
  return out;
}

/** Analyze a document and produce severity-based quality findings. */
export function analyzeDocQuality(doc: ArticleDocument): QualityReport {
  const report = emptyQualityReport();
  for (const { id, text } of collectEditableUnits(doc)) {
    const severity = classifyBlockEnglish(text);
    if (severity === "major") {
      report.findings.push({ sourceUnitId: id, category: "english-leak", severity: "major", messageCode: "untranslated-english" });
      report.majorCount += 1;
    } else if (severity === "minor") {
      const token = firstNonApprovedToken(text);
      report.findings.push({ sourceUnitId: id, category: "english-leak", severity: "minor", matchedToken: token, messageCode: "mixed-language-term" });
      report.minorCount += 1;
    } else if (severity === "advisory") {
      report.findings.push({ sourceUnitId: id, category: "english-leak", severity: "advisory", messageCode: "approved-name" });
      report.advisoryCount += 1;
      report.approvedNameExemptions += 1;
    }
  }
  return report;
}

function firstNonApprovedToken(text: string): string | undefined {
  const noUrls = text.replace(/https?:\/\/\S+/gi, " ");
  const tokens = noUrls
    .replace(/[\u3400-\u9fff]+/g, " ")
    .split(/[^\w-]+/)
    .filter((t) => /^[A-Za-z][A-Za-z-]{1,}$/.test(t));
  return tokens.find((t) => !isApprovedTerm(t));
}

/** Map a source-reference finding severity into a QualityReport severity bucket. */
function sourceSeverityToQuality(severity: "critical" | "major" | "minor" | "advisory"): QualitySeverity {
  return severity;
}

/** Merge deterministic source-reference findings into a severity-based QualityReport. */
export function mergeSourceReferenceFindings(
  report: QualityReport,
  findings: SourceReferenceFinding[],
): QualityReport {
  const out = { ...report, findings: [...report.findings] };
  for (const f of findings) {
    out.findings.push({
      sourceUnitId: f.sourceUnitId,
      category: "source-reference",
      severity: sourceSeverityToQuality(f.severity),
      messageCode: f.messageCode,
    });
    if (f.severity === "critical") out.criticalCount += 1;
    else if (f.severity === "major") out.majorCount += 1;
    else if (f.severity === "minor") out.minorCount += 1;
    else out.advisoryCount += 1;
  }
  return out;
}

/**
 * Apply deterministic terminology cleanup + CTA localization to the shadow doc
 * (returns a new document; the input is never mutated). Also computes the
 * severity-based translation-quality report for the final gate.
 */
export function applyShadowCantoneseQuality(doc: ArticleDocument): { doc: ArticleDocument; report: QualityReport } {
  const out = structuredClone(doc) as ArticleDocument;
  const counter = { glossary: 0 };
  out.metadata.title = applyTextQuality(out.metadata.title, counter);
  out.metadata.metaDescription = applyTextQuality(out.metadata.metaDescription, counter);
  out.metadata.excerpt = applyTextQuality(out.metadata.excerpt, counter);
  out.introduction.blocks = out.introduction.blocks.map((b) => cleanBlock(b, counter));
  out.sections = out.sections.map((s) => ({ ...s, heading: applyTextQuality(s.heading, counter), blocks: s.blocks.map((b) => cleanBlock(b, counter)) }));
  out.conclusion.blocks = out.conclusion.blocks.map((b) => cleanBlock(b, counter));
  out.visibleFaq = out.visibleFaq.map((f) => ({
    ...f,
    question: applyTextQuality(f.question, counter),
    answerHtml: applyTextQualityHtml(f.answerHtml),
    answerText: applyTextQuality(f.answerText, counter),
  }));
  out.cta = localizeCta(out.cta);
  const report = analyzeDocQuality(out);
  report.glossaryNormalizations = counter.glossary;
  return { doc: out, report };
}
