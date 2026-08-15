// ── Final SEO Reconciliation (deterministic post-final-trim) ──
//
// The final trim removes non-keyphrase words, which raises keyphrase density:
// a document at 2.91% density can cross the hard 3% stuffing limit after
// trimming without any keyphrase occurrence being added. This stage is the
// deterministic density owner for the tail of the pipeline.
//
// It reuses the SEO normalizer's protected keyphrase-removal logic
// (complete-sentence removal inside editable paragraphs, with script/schema,
// wp:html switcher and CTA, wp:buttons, images, media and links tokenized
// byte-for-byte). Every removal is computed on a canonical ArticleDocument
// clone, re-parsed back to the canonical model, and accepted only when every
// hard gate passes:
//
//   - canonical visible word count stays inside wordMin..wordMax
//   - keyphrase density (identical formula to the final validation gate) <= 3%
//   - WordPress block structure stays valid
//   - malformed prose and coherence stay clean
//   - factual support and claim ownership stay clean
//   - link destinations are preserved
//   - CTA, FAQ/schema and language-switcher content is byte-identical
//
// When no safe correction exists the module returns accepted=false and the
// caller restores the exact pre-stage snapshot and fails closed.

import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  countCanonicalVisibleWords,
  parseArticleDocumentFromHtml,
} from "@/lib/blog/article-document";
import { computeKeyphraseDensity, englishKeyphraseDensity } from "@/lib/content-standards";
import { countExactPhrase, extractReadableText } from "@/lib/seo/seo-text-utils";
import {
  countEditableKeyphraseOccurrences,
  reduceProtectedKeyphraseOccurrences,
} from "@/lib/blog/final-seo-normalizer";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { validateCoherence } from "@/lib/blog/coherence";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { validateClaimOwnership, type ClaimOwnershipLedger } from "@/lib/blog/claim-ownership";

export interface CanonicalKeyphraseMetrics {
  wordCount: number;
  occurrences: number;
  density: number;
}

/**
 * The single canonical keyphrase-density calculation shared by the final trim
 * gate, the post-final-trim reconciliation stage and the final validation
 * gate: occurrences are counted on the rendered article's readable text
 * (wp:html/script content excluded) and divided by the canonical visible word
 * count (FAQ copy included). This is exactly what `analyzeFinalArticle` does
 * when the pipeline passes `countCanonicalVisibleWords(doc)`.
 */
export function canonicalKeyphraseMetrics(
  doc: ArticleDocument,
  keyphrase: string,
): CanonicalKeyphraseMetrics {
  const wordCount = countCanonicalVisibleWords(doc);
  const occurrences = countExactPhrase(
    extractReadableText(renderArticleDocument(doc)),
    keyphrase,
  );
  return {
    wordCount,
    occurrences,
    density: computeKeyphraseDensity(occurrences, keyphrase, wordCount),
  };
}

export interface FinalSeoReconcileResult {
  /** True when at least one keyphrase-bearing sentence was removed. */
  applied: boolean;
  /** True when density is inside the hard limit after the reconciliation. */
  accepted: boolean;
  occurrencesBefore: number;
  occurrencesAfter: number;
  densityBefore: number;
  densityAfter: number;
  wordCountBefore: number;
  wordCountAfter: number;
  removedSentences: number;
  removedWords: number;
  /** Canonical component/block of every committed removal. */
  selectedBlocks: Array<{ componentId: string; blockId: string }>;
  /** Human-readable reasons for a failed reconciliation (fail-closed). */
  rejectionReasons: string[];
}

const MAX_RECONCILE_REMOVALS = 60;

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

function protectedFields(doc: ArticleDocument): string {
  return JSON.stringify({
    languageSwitcher: doc.languageSwitcher,
    cta: doc.cta,
    visibleFaq: doc.visibleFaq,
    faqSchema: doc.faqSchema,
    metadata: doc.metadata,
  });
}

/** Every hard gate except the density bound itself, which the caller loops
 *  on. Returns human-readable reasons when the candidate is unsafe. */
function validateReconcileCandidate(
  candidate: ArticleDocument,
  originalRender: string,
  originalLinks: string[],
  originalProtected: string,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
  ledger: ClaimOwnershipLedger | undefined,
  wordMin: number,
  wordMax: number,
): string[] {
  const reasons: string[] = [];
  const wordCount = countCanonicalVisibleWords(candidate);
  if (wordCount < wordMin || wordCount > wordMax) {
    reasons.push(`word count ${wordCount} outside ${wordMin}-${wordMax}`);
  }
  const render = renderArticleDocument(candidate);
  const wpPair = validateWordpressBlockPairs(render);
  if (!wpPair.valid) {
    reasons.push(`WordPress block pairing invalid: ${wpPair.issues[0] ?? "unknown"}`);
  }
  for (const finding of scanMalformedProseInDocument(candidate)) {
    reasons.push(
      `malformed prose in ${finding.componentId}/${finding.blockId}: ` +
      finding.issues.map((issue) => issue.code).join(","),
    );
  }
  for (const violation of validateCoherence(candidate)) {
    reasons.push(`coherence ${violation.type} in ${violation.componentId}`);
  }
  for (const claim of scanFactualRisks(render, keyphrase, research).claims) {
    if (!claim.supported) {
      reasons.push(`unsupported claim "${claim.text.slice(0, 80)}"`);
    }
  }
  if (ledger) {
    for (const violation of validateClaimOwnership(candidate, ledger, keyphrase, research)) {
      reasons.push(`claim ownership ${violation.reason} in ${violation.componentId}`);
    }
  }
  if (JSON.stringify(collectLinkDestinations(render)) !== JSON.stringify(originalLinks)) {
    reasons.push("link destinations changed");
  }
  if (protectedFields(candidate) !== originalProtected) {
    reasons.push("protected content (CTA/FAQ/schema/switcher) changed");
  }
  if (render === originalRender) {
    reasons.push("reconciliation produced no change");
  }
  return reasons;
}

/** First paragraph block whose rendered text differs between the current
 *  canonical document and the candidate — the block the removal touched. */
function findChangedParagraph(
  candidate: ArticleDocument,
  current: ArticleDocument,
): { componentId: string; blockId: string } | null {
  const components: Array<{
    id: string;
    blocks: ArticleDocument["introduction"]["blocks"];
  }> = [
    { id: candidate.introduction.id, blocks: candidate.introduction.blocks },
    ...candidate.sections.map((section) => ({ id: section.id, blocks: section.blocks })),
    { id: candidate.conclusion.id, blocks: candidate.conclusion.blocks },
  ];
  const currentById = new Map<string, ArticleDocument["introduction"]["blocks"]>();
  for (const component of [
    { id: current.introduction.id, blocks: current.introduction.blocks },
    ...current.sections.map((section) => ({ id: section.id, blocks: section.blocks })),
    { id: current.conclusion.id, blocks: current.conclusion.blocks },
  ]) {
    currentById.set(component.id, component.blocks);
  }
  for (const component of components) {
    const currentBlocks = currentById.get(component.id);
    if (!currentBlocks) continue;
    for (let index = 0; index < component.blocks.length; index++) {
      const block = component.blocks[index];
      if (block.type !== "paragraph") continue;
      const currentBlock = currentBlocks.find(
        (item) => item.type === "paragraph" && item.id === block.id,
      );
      if (!currentBlock) continue;
      const textOf = (b: { type: string; content?: Array<{ text: string }> }): string =>
        (b.content ?? []).map((node) => node.text).join("");
      if (textOf(block) !== textOf(currentBlock)) {
        return { componentId: component.id, blockId: block.id };
      }
    }
  }
  return null;
}

/**
 * Deterministic post-final-trim keyphrase-density reconciliation on the
 * canonical document. When density is already inside the hard limit the
 * document is left untouched and the result is accepted. Otherwise complete
 * keyphrase-bearing sentences are removed from editable paragraphs (protected
 * blocks stay byte-identical), each removal is re-parsed back to the
 * ArticleDocument and must pass every hard gate, and only then is it committed
 * onto `doc`. The loop stops as soon as density is <= 3% (success) or no safe
 * removal exists (failure: the caller must restore the exact pre-stage
 * snapshot and fail closed).
 */
export function reconcileFinalKeyphraseDensity(
  doc: ArticleDocument,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
  ledger: ClaimOwnershipLedger | undefined,
  wordMin: number,
  wordMax: number,
): FinalSeoReconcileResult {
  const { stuffingAbove } = englishKeyphraseDensity();
  const result: FinalSeoReconcileResult = {
    applied: false,
    accepted: false,
    occurrencesBefore: 0,
    occurrencesAfter: 0,
    densityBefore: 0,
    densityAfter: 0,
    wordCountBefore: 0,
    wordCountAfter: 0,
    removedSentences: 0,
    removedWords: 0,
    selectedBlocks: [],
    rejectionReasons: [],
  };
  const kpLower = keyphrase.toLowerCase().trim();
  if (!kpLower) {
    result.rejectionReasons.push("empty focus keyphrase");
    return result;
  }

  const before = canonicalKeyphraseMetrics(doc, keyphrase);
  result.occurrencesBefore = before.occurrences;
  result.densityBefore = before.density;
  result.wordCountBefore = before.wordCount;
  result.occurrencesAfter = before.occurrences;
  result.densityAfter = before.density;
  result.wordCountAfter = before.wordCount;

  if (before.density <= stuffingAbove) {
    result.accepted = true;
    return result;
  }

  const originalRender = renderArticleDocument(doc);
  const originalLinks = collectLinkDestinations(originalRender);
  const originalProtected = protectedFields(doc);
  let previousWordCount = before.wordCount;

  for (let attempt = 0; attempt < MAX_RECONCILE_REMOVALS; attempt++) {
    const metrics = canonicalKeyphraseMetrics(doc, keyphrase);
    if (metrics.density <= stuffingAbove) {
      result.accepted = true;
      break;
    }
    const html = renderArticleDocument(doc);
    const editable = countEditableKeyphraseOccurrences(html, keyphrase);
    if (editable <= 0) {
      result.rejectionReasons.push(
        `density ${metrics.density.toFixed(2)}% > ${stuffingAbove}% with no editable paragraph occurrence to remove`,
      );
      break;
    }
    const reduction = reduceProtectedKeyphraseOccurrences(html, keyphrase, editable - 1);
    if (reduction.removed === 0) {
      result.rejectionReasons.push(
        `density ${metrics.density.toFixed(2)}% > ${stuffingAbove}% with no safely removable keyphrase-bearing sentence`,
      );
      break;
    }

    const parsed = parseArticleDocumentFromHtml(reduction.html, doc);
    if (!parsed.doc) {
      result.rejectionReasons.push(
        `candidate parse-back failed: ${parsed.errors[0] ?? "unknown error"}`,
      );
      break;
    }

    const battery = validateReconcileCandidate(
      parsed.doc,
      originalRender,
      originalLinks,
      originalProtected,
      keyphrase,
      research,
      ledger,
      wordMin,
      wordMax,
    );
    if (battery.length > 0) {
      result.rejectionReasons.push(...battery);
      break;
    }

    const selected = findChangedParagraph(parsed.doc, doc);
    if (selected) result.selectedBlocks.push(selected);
    const sentencePreview = reduction.changes
      .filter((change) => change.type === "keyphrase_removed")
      .map((change) => `"${(change.before ?? "").replace(/\s+/g, " ").trim().slice(0, 90)}"`)
      .join("; ");
    console.log(
      `[final-seo-reconcile] candidate accepted removal=${reduction.removed}` +
      ` block=${selected ? `${selected.componentId}/${selected.blockId}` : "unknown"}` +
      ` sentence=${sentencePreview || "unknown"}`,
    );

    doc.sections = parsed.doc.sections;
    doc.introduction = parsed.doc.introduction;
    doc.conclusion = parsed.doc.conclusion;
    result.removedSentences += reduction.removed;
    result.applied = true;

    const after = canonicalKeyphraseMetrics(doc, keyphrase);
    result.removedWords += Math.max(0, previousWordCount - after.wordCount);
    previousWordCount = after.wordCount;
    result.occurrencesAfter = after.occurrences;
    result.densityAfter = after.density;
    result.wordCountAfter = after.wordCount;
    console.log(
      `[final-seo-reconcile] after removal wc=${after.wordCount} occ=${after.occurrences}` +
      ` density=${after.density.toFixed(2)}%`,
    );
  }

  if (!result.accepted) {
    console.error(
      `[final-seo-reconcile] rollback=caller reason=${result.rejectionReasons.join("; ")}` +
      ` density=${result.densityAfter.toFixed(2)}%`,
    );
    return result;
  }

  const final = canonicalKeyphraseMetrics(doc, keyphrase);
  result.occurrencesAfter = final.occurrences;
  result.densityAfter = final.density;
  result.wordCountAfter = final.wordCount;
  console.log(
    `[final-seo-reconcile] accepted=true wc=${final.wordCount}` +
    ` occ=${final.occurrences} density=${final.density.toFixed(2)}%` +
    ` removedSentences=${result.removedSentences} removedWords=${result.removedWords}` +
    ` blocks=${result.selectedBlocks.length}`,
  );
  return result;
}
