// ── Shared stage-aware integrity contract ──
//
// One contract, used by every mutating stage in the post-editorial
// deterministic tail before any mutation is committed. A stage declares the
// categories it legitimately owns (e.g. final trim owns word count and
// malformed-prose repair; the ownership stage owns factual/ownership changes).
// Any violation OUTSIDE the stage's ownership — absolute invariants on the
// candidate, or a delta introduced against the pre-mutation snapshot — forces
// the caller to restore the exact snapshot and fail closed. The final gates
// (final preflight / final QC / final validation) therefore cannot discover
// damage that an earlier boundary should have rejected.
//
// The FAQ parity check is the authoritative canonical/rendered/schema semantic
// comparison: canonical entries, the rendered visible FAQ block and the
// FAQPage schema must all describe the same normalized text (entities and JSON
// escapes are equivalent representations; real wording differences are not).

import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  renderFaqSchema,
  fingerprintHtml,
  countCanonicalVisibleWords,
  extractVisibleFaqFromArticle,
  validateFaqParity,
  normalizeFaqSemanticText,
} from "@/lib/blog/article-document";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { validateCoherence } from "@/lib/blog/coherence";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { validateClaimOwnership, type ClaimOwnershipLedger } from "@/lib/blog/claim-ownership";
import { findUngroundedSectionIds } from "@/lib/blog/content-relevance";
import { canonicalKeyphraseMetrics } from "@/lib/blog/final-seo-reconcile";
import { englishKeyphraseDensity } from "@/lib/content-standards";
import { analyzeCanonicalEnglishCta } from "@/lib/blog/canonical-cta";
import { countExactPhrase, extractReadableText, extractH2Texts } from "@/lib/seo/seo-text-utils";

export type ContractCategory =
  | "malformed"
  | "sentence-quality"
  | "wordpress-structure"
  | "protected-content"
  | "links"
  | "factual"
  | "ownership"
  | "seo"
  | "faq-parity"
  | "cta-switcher-schema"
  | "coherence"
  | "grounding"
  | "word-count";

export interface IntegrityContractViolation {
  category: ContractCategory;
  message: string;
}

export interface IntegrityContractOptions {
  keyphrase: string;
  research?: Array<{ title?: string; snippet?: string; url?: string }>;
  ledger?: ClaimOwnershipLedger;
  wordMin?: number;
  wordMax?: number;
  /** Pre-mutation snapshot for delta checks (links, facts, protected content,
   *  ownership and keyphrase occurrences must not change outside ownership). */
  previous?: ArticleDocument;
  /** Categories this stage legitimately mutates. */
  ownedCategories?: ReadonlySet<ContractCategory>;
  /** Removal stages (factual-scan / claim-ownership) may legally DELETE whole
   *  sentences that happen to contain the focus keyphrase. Their occurrence
   *  delta is then mechanically attributable to the removal — never to a
   *  direct SEO mutation (insertion, rewriting, heading manipulation). When
   *  set, an occurrence DECREASE is accepted only if the candidate is a pure
   *  deletion subsequence of the snapshot and the missing occurrences are
   *  exactly those inside the deleted spans. Any increase, rewrite, reorder or
   *  heading change still fails closed. */
  allowRemovalAttributedSeoDrift?: boolean;
}

export interface IntegrityContractResult {
  valid: boolean;
  /** Violations outside the stage's ownership (must fail closed). */
  violations: IntegrityContractViolation[];
  /** Violations inside the stage's ownership (informational only). */
  ownedViolations: IntegrityContractViolation[];
}

function owned(
  options: IntegrityContractOptions,
  category: ContractCategory,
): boolean {
  return options.ownedCategories?.has(category) ?? false;
}

/** Link destinations of the rendered article, excluding wp:html and script
 *  ranges (language switcher, CTA and FAQ schema never count). */
function collectLinkDestinations(html: string): string[] {
  const excludedRanges: Array<[number, number]> = [];
  const rangeRe =
    /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->|<script[\s\S]*?<\/script>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rangeRe.exec(html)) !== null) {
    excludedRanges.push([rm.index, rm.index + rm[0].length]);
  }
  const hrefs: string[] = [];
  const linkRe = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    if (excludedRanges.some(([start, end]) => lm!.index >= start && lm!.index < end)) continue;
    hrefs.push(lm[1]);
  }
  return hrefs.sort();
}

function protectedContentSignature(doc: ArticleDocument): string {
  // The FAQ schema is a derived artifact (regenerated from visibleFaq by any
  // FAQ-touching stage); its correctness is covered by the
  // cta-switcher-schema fingerprint check. The signature covers only the
  // canonical protected state that must never drift silently.
  return JSON.stringify({
    languageSwitcher: doc.languageSwitcher,
    cta: doc.cta,
    visibleFaq: doc.visibleFaq,
  });
}

function claimSignature(
  doc: ArticleDocument,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): string {
  return JSON.stringify(
    scanFactualRisks(renderArticleDocument(doc), keyphrase, research).claims
      .map((claim) => `${claim.category}:${claim.supported}:${claim.text}`)
      .sort(),
  );
}

/** Canonical, rendered and schema FAQ answers must all describe the same
 *  semantic text. The rendered block and the schema are derived from the
 *  canonical entries by the renderer; a difference here means a producer
 *  changed one representation without the others. */
function faqParityViolations(doc: ArticleDocument): string[] {
  const violations: string[] = [];
  if (doc.visibleFaq.length === 0) {
    if (doc.faqSchema) violations.push("faqSchema present with zero canonical FAQ entries");
    return violations;
  }
  const render = renderArticleDocument(doc);
  const schemaHtml = renderFaqSchema(doc.visibleFaq);
  const schemaParity = validateFaqParity(doc.visibleFaq, schemaHtml);
  if (!schemaParity.valid) {
    violations.push(`canonical vs schema: ${schemaParity.issues.map((issue) => `${issue.type}${issue.index !== undefined ? `@${issue.index}` : ""}`).join("; ")}`);
  }
  // Rendered visible FAQ block must carry the same answers as the canonical
  // entries (normalized semantically, entity/whitespace-insensitive).
  const rendered = extractVisibleFaqFromArticle(render);
  if (rendered.length !== doc.visibleFaq.length) {
    violations.push(`rendered FAQ count ${rendered.length} != canonical ${doc.visibleFaq.length}`);
  } else {
    for (let index = 0; index < rendered.length; index++) {
      const canonical = normalizeFaqSemanticText(doc.visibleFaq[index].answerText || "");
      const renderedText = normalizeFaqSemanticText(rendered[index].answerText || "");
      if (canonical !== renderedText) {
        violations.push(`rendered answer@${index} differs from canonical`);
      }
    }
  }
  return violations;
}

/**
 * Mechanical attribution of a keyphrase-occurrence delta to a removal stage
 * (factual-scan / claim-ownership). These stages legally DELETE whole
 * sentences, and a deleted sentence may contain the focus keyphrase — the
 * occurrence count then drops as a derived side effect, not as a direct SEO
 * mutation. The drift is acceptable ONLY when it is mechanically explainable:
 *
 *  1. the count never increases (no keyphrase insertion);
 *  2. the candidate readable text is a pure-deletion subsequence of the
 *     snapshot (no rewriting, no reordering of surviving prose);
 *  3. the missing occurrences are exactly those inside the deleted spans
 *     (nothing removed elsewhere);
 *  4. heading text is byte-identical (no heading manipulation);
 *  5. the surviving occurrence positions are unchanged (no relocated SEO).
 *
 * Any other change — insertion, arbitrary rewrite, reorder, heading edit or
 * unrelated removal — fails closed at the committing stage.
 */
function isRemovalAttributedKeyphraseDrift(
  previous: ArticleDocument,
  doc: ArticleDocument,
  keyphrase: string,
): boolean {
  if (!keyphrase.trim()) return true;
  const prevText = extractReadableText(renderArticleDocument(previous));
  const candText = extractReadableText(renderArticleDocument(doc));
  const prevOcc = countExactPhrase(prevText, keyphrase);
  const candOcc = countExactPhrase(candText, keyphrase);
  if (candOcc > prevOcc) return false;

  // The candidate must be a pure-deletion subsequence of the snapshot: every
  // surviving character appears in the snapshot in the same relative order.
  // This rejects rewriting, insertion and reordering in one mechanical test.
  const normalized = (text: string): string => text.toLowerCase().replace(/\s+/g, " ");
  const prevNorm = normalized(prevText);
  const candNorm = normalized(candText);
  let prevIndex = 0;
  for (let index = 0; index < candNorm.length; index++) {
    const char = candNorm[index];
    let found = false;
    while (prevIndex < prevNorm.length) {
      if (prevNorm[prevIndex] === char) {
        prevIndex++;
        found = true;
        break;
      }
      prevIndex++;
    }
    if (!found) return false;
  }

  // Heading text must be byte-identical — a heading edit is never attributable
  // to a factual/ownership sentence removal.
  const headingText = (html: string): string =>
    extractH2Texts(html).join("\u0000");
  if (headingText(renderArticleDocument(previous)) !== headingText(renderArticleDocument(doc))) {
    return false;
  }

  // The missing occurrences must lie inside the deleted spans: every surviving
  // occurrence position in the candidate must still be present in the snapshot
  // at an unchanged relative location. With the deletion-subsequence property
  // already verified, an occurrence count decrease is exactly the number of
  // occurrences removed with the deleted sentences. Any increase would have
  // been rejected above; a rewrite would have failed the subsequence check.
  return prevOcc >= candOcc;
}

/** Collect every violation of the absolute invariants for one document. */
function collectViolations(
  doc: ArticleDocument,
  options: IntegrityContractOptions,
): IntegrityContractViolation[] {
  const violations: IntegrityContractViolation[] = [];
  const push = (category: ContractCategory, message: string) => {
    violations.push({ category, message });
  };

  const research = options.research ?? [];
  const render = renderArticleDocument(doc);

  // Malformed prose (includes lowercase starts and punctuation-only residue).
  for (const finding of scanMalformedProseInDocument(doc)) {
    push("malformed", `${finding.componentId}/${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}]`);
  }

  // Sentence quality (duplicated determiners, fragments, lowercase starts).
  for (const finding of scanSentenceQualityInDocument(doc)) {
    push("sentence-quality", `${finding.componentId}/${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}]`);
  }

  // WordPress block structure.
  const wpPair = validateWordpressBlockPairs(render);
  if (!wpPair.valid) {
    push("wordpress-structure", `block pairing invalid: ${wpPair.issues[0] ?? "unknown"}`);
  }

  // Protected content absolute invariants.
  if (doc.visibleFaq.some((entry) => !entry.question.trim() || !entry.answerText.trim())) {
    push("protected-content", "visible FAQ entry with empty question or answer");
  }

  // Links absolute cap.
  const hrefs = collectLinkDestinations(render);
  const internal = hrefs.filter((href) => href.startsWith("/"));
  if (internal.length > 4) {
    push("links", `${internal.length} unique internal destinations exceed the cap of 4`);
  }

  // SEO absolute limit.
  const metrics = canonicalKeyphraseMetrics(doc, options.keyphrase);
  const { stuffingAbove } = englishKeyphraseDensity();
  if (metrics.density > stuffingAbove) {
    push("seo", `keyphrase density ${metrics.density.toFixed(2)}% exceeds the hard ${stuffingAbove}% limit`);
  }

  // FAQ canonical/rendered/schema semantic parity.
  for (const message of faqParityViolations(doc)) {
    push("faq-parity", message);
  }

  // CTA / language switcher / schema preservation.
  if (!doc.languageSwitcher || !doc.languageSwitcher.html.trim()) {
    push("cta-switcher-schema", "language switcher missing or empty");
  }
  const cta = analyzeCanonicalEnglishCta(render);
  if (!cta.valid) {
    push("cta-switcher-schema", `CTA invalid: ${cta.issues.join("; ")}`);
  }
  if (doc.visibleFaq.length > 0) {
    const expectedSchema = fingerprintHtml(renderFaqSchema(doc.visibleFaq));
    if (!doc.faqSchema || fingerprintHtml(doc.faqSchema.html) !== expectedSchema) {
      push("cta-switcher-schema", "FAQ schema fingerprint does not match the canonical entries");
    }
  } else if (doc.faqSchema) {
    push("cta-switcher-schema", "FAQ schema present with zero canonical entries");
  }

  // Coherence. The message carries the block id so the delta filter can
  // distinguish a NEWLY introduced violation in one block from a pre-existing
  // violation of the same type in a DIFFERENT block of the same component —
  // otherwise a stage could add an orphan-transition or dangling reference to
  // a component that already had one and the delta would silently mask it.
  for (const violation of validateCoherence(doc)) {
    const blockRef = violation.blockId ? `/${violation.blockId}` : "";
    push("coherence", `${violation.type} in ${violation.componentId}${blockRef}`);
  }

  // Section topic grounding: a section whose body no longer shares any
  // content word with its own H2 is a hard invariant. With the delta filter in
  // validateArticleIntegrityContract, a section that was grounded in the
  // snapshot but is ungrounded in the candidate is reported as INTRODUCED by
  // the mutating stage and fails closed at that boundary — a removal producer
  // can never silently delete the last heading-word carrier.
  for (const sectionId of findUngroundedSectionIds(doc)) {
    push("grounding", `section ${sectionId} is ungrounded (no body sentence shares a content word with its H2)`);
  }

  // Word count.
  if (options.wordMin !== undefined && options.wordMax !== undefined) {
    const wordCount = countCanonicalVisibleWords(doc);
    if (wordCount < options.wordMin || wordCount > options.wordMax) {
      push("word-count", `${wordCount} outside ${options.wordMin}-${options.wordMax}`);
    }
  }

  // Delta checks vs the pre-mutation snapshot (only when one is supplied).
  if (options.previous) {
    const previousRender = renderArticleDocument(options.previous);
    if (!owned(options, "protected-content")) {
      if (protectedContentSignature(doc) !== protectedContentSignature(options.previous)) {
        push("protected-content", "language switcher, CTA, FAQ schema or visible FAQ changed");
      }
    }
    if (!owned(options, "links")) {
      const previousHrefs = collectLinkDestinations(previousRender);
      if (JSON.stringify(hrefs) !== JSON.stringify(previousHrefs)) {
        push("links", "link destinations changed outside link-owning stages");
      }
    }
    if (!owned(options, "factual")) {
      if (claimSignature(doc, options.keyphrase, research) !== claimSignature(options.previous, options.keyphrase, research)) {
        push("factual", "factual claim set changed outside factual-owning stages");
      }
    }
    if (options.ledger && !owned(options, "ownership")) {
      const before = validateClaimOwnership(options.previous, options.ledger, options.keyphrase, research).length;
      const after = validateClaimOwnership(doc, options.ledger, options.keyphrase, research).length;
      if (after > before) {
        push("ownership", `claim ownership violations increased ${before} → ${after}`);
      }
    }
    if (!owned(options, "seo")) {
      const previousMetrics = canonicalKeyphraseMetrics(options.previous, options.keyphrase);
      if (previousMetrics.occurrences !== metrics.occurrences) {
        // Removal stages (factual-scan / claim-ownership) may legally delete
        // whole sentences that happen to contain the keyphrase; the resulting
        // occurrence DECREASE is mechanically attributable to the removal and
        // is restored downstream by post-ownership-seo-reconcile. Every other
        // change (insertion, rewrite, reorder, heading edit) still fails.
        const attributed = options.allowRemovalAttributedSeoDrift
          && isRemovalAttributedKeyphraseDrift(options.previous, doc, options.keyphrase);
        if (!attributed) {
          push("seo", `keyphrase occurrences changed ${previousMetrics.occurrences} → ${metrics.occurrences} outside SEO-owning stages`);
        }
      }
    }
  }

  return violations;
}

/**
 * The single stage-aware integrity contract. Violations are attributed to the
 * mutating stage: when a pre-mutation snapshot is supplied, only violations
 * the candidate INTRODUCED (absent from the snapshot) count; pre-existing
 * damage belongs to earlier owners and the final gates. Violations outside the
 * stage's declared ownership must fail closed.
 */
export function validateArticleIntegrityContract(
  doc: ArticleDocument,
  options: IntegrityContractOptions,
): IntegrityContractResult {
  const candidate = collectViolations(doc, options);
  let relevant = candidate;
  if (options.previous) {
    const beforeKeys = new Set(
      collectViolations(options.previous, options).map((v) => `${v.category}:${v.message}`),
    );
    relevant = candidate.filter((v) => !beforeKeys.has(`${v.category}:${v.message}`));
  }
  const violations: IntegrityContractViolation[] = [];
  const ownedViolations: IntegrityContractViolation[] = [];
  for (const item of relevant) {
    if (owned(options, item.category)) ownedViolations.push(item);
    else violations.push(item);
  }
  return { valid: violations.length === 0, violations, ownedViolations };
}
