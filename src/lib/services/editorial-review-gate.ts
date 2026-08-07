// ── Post-editorial-review gate: naturalness, mandatory-resolution and CTA parity ──
//
// Deterministic checks that run AFTER the bounded editorial-review call applies its
// text-leaf patches. Removing an untranslated English token (e.g. "nice-to-have")
// is not enough: the replacement must be natural professional Hong Kong Cantonese
// and must preserve meaning. These checks reject the review (fail at stage
// "review") so the version is NOT saved with an unnatural or lossy patch.
//
// This module is pure data + pure text checks. It makes ZERO provider calls and
// never mutates the document.

import type { ArticleDocument } from "@/lib/blog/article-document";
import type { QualityReport } from "./shadow-cantonese-quality";

// ── Naturalness gate ─────────────────────────────────────────────────────────

/**
 * Unnatural zh-HK calques that the model produces when it removes an English token
 * but fails to render natural professional Cantonese. Each entry maps the
 * unnatural fragment to the English concept it misrepresents, for a clear
 * rejection reason. These are the proven failures from project-19 (e.g.
 * "nice-to-have" → 「有就最好」) and close calque variants.
 */
const UNNATURAL_PHRASE_MARKERS: Array<[RegExp, string]> = [
  [/有就最好/gu, "nice-to-have (literal, unnatural calque)"],
  [/有就好/gu, "nice-to-have (literal, unnatural calque)"],
  [/算係最好/gu, "nice-to-have (literal, unnatural calque)"],
  [/活動廣告板/gu, "walking billboard (literal, unnatural calque)"],
  [/人肉廣告板/gu, "walking billboard (overly literal and unprofessional)"],
  [/令(?:所有人|各方|雙方)老實啲/gu, "keeps everyone honest (literal, meaning should express accountability)"],
  [/保持誠實/gu, "keeps everyone honest (literal, meaning should express accountability)"],
];

/** Detect unnatural calque phrases in a document; return matched markers per unit. */
export function findUnnaturalCalques(doc: ArticleDocument): Array<{ sourceUnitId: string; marker: string; reason: string }> {
  const hits: Array<{ sourceUnitId: string; marker: string; reason: string }> = [];
  const check = (id: string, text: string): void => {
    for (const [re, reason] of UNNATURAL_PHRASE_MARKERS) {
      re.lastIndex = 0;
      if (re.test(text)) {
        hits.push({ sourceUnitId: id, marker: re.source, reason });
      }
    }
  };
  check("metadata.title", doc.metadata.title);
  check("metadata.metaDescription", doc.metadata.metaDescription);
  check("metadata.excerpt", doc.metadata.excerpt);
  doc.introduction.blocks.forEach((b, i) => check(`introduction.block.${i}`, blockText(b)));
  doc.sections.forEach((s, si) => {
    check(`section.${si}.heading`, s.heading);
    s.blocks.forEach((b, bi) => check(`section.${si}.block.${bi}`, blockText(b)));
  });
  doc.conclusion.blocks.forEach((b, i) => check(`conclusion.block.${i}`, blockText(b)));
  doc.visibleFaq.forEach((f, i) => {
    check(`faq.${i}.question`, f.question);
    check(`faq.${i}.answer`, f.answerText);
  });
  return hits;
}

// ── CTA parity gate ──────────────────────────────────────────────────────────

/**
 * The canonical zh-HK CTA must preserve all three value claims from the English
 * source ("no agencies, no commissions, no middlemen"). Each claim has an accepted
 * set of zh-HK renderings. If any claim is absent from the protected CTA, parity is
 * broken and the version must not be saved.
 */
const CTA_CLAIM_MARKERS: Array<{ claim: string; regex: RegExp }> = [
  { claim: "no agencies", regex: /毋須經代理|毋須經紀|無代理商|冇代理商|無代理|冇代理|no agencies|不經代理/gu },
  { claim: "no commissions", regex: /毋須支付佣金|毋須佣金|無佣金|冇佣金|不收取佣金|no commissions|no commission/gu },
  { claim: "no middlemen", regex: /沒有中間人|無中間人|冇中間人|毋須中間人|無中介|冇中介|no middlemen|no middleman/gu },
];

export interface CtaParityResult {
  ok: boolean;
  missingClaims: string[];
}

/** Verify the protected CTA retains all three value claims. A document with no
 *  protected CTA is not a claim-loss (the CTA was never present), so it passes. */
export function checkCtaParity(doc: ArticleDocument): CtaParityResult {
  if (!doc.cta) return { ok: true, missingClaims: [] };
  const ctaHtml = doc.cta.html ?? "";
  const missing: string[] = [];
  for (const { claim, regex } of CTA_CLAIM_MARKERS) {
    regex.lastIndex = 0;
    if (!regex.test(ctaHtml)) missing.push(claim);
  }
  return { ok: missing.length === 0, missingClaims: missing };
}

// ── Mandatory-finding resolution gate ────────────────────────────────────────

/** Whether a mandatory (critical/major) finding remains anywhere in the document. */
export function unresolvedMandatoryFindings(report: QualityReport): Array<{ sourceUnitId: string; messageCode: string }> {
  return report.findings
    .filter((f) => f.severity === "critical" || f.severity === "major")
    .map((f) => ({ sourceUnitId: f.sourceUnitId, messageCode: f.messageCode }));
}

// ── Shared text helpers ──────────────────────────────────────────────────────

import type { EditorialBlock, InlineContent } from "@/lib/blog/article-content";

function inlineText(nodes: InlineContent[]): string {
  return nodes.map((n) => n.text ?? "").join("");
}

function blockText(block: EditorialBlock): string {
  switch (block.type) {
    case "list":
      return block.items.map((n) => inlineText(n)).join(" ");
    case "table":
      return [...block.headers.map((n) => inlineText(n)), ...block.rows.flat().map((n) => inlineText(n))].join(" ");
    case "paragraph":
    case "subheading":
    case "quote":
      return inlineText(block.content);
    default:
      return "";
  }
}
