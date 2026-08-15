// ── Canonical blog generation pipeline ──
// All post-assembly stages extracted from route.ts.
// route.ts handles auth, section generation, initial assembly, then delegates here.
//
// ArticleDocument is the single canonical mutable source.
// state.blog is ONLY assigned by syncBlogFromDocument() — never directly.
// No stage treats raw HTML as independently canonical.

import * as fs from "node:fs";
import * as path from "node:path";
import { PipelineDebugTrace, isPipelineDebugTraceEnabled, traceContextFor } from "@/lib/pipeline/pipeline-debug-trace";
import { captureIntegrityRejection, updateIntegrityRejectionRollback } from "@/lib/pipeline/pipeline-failure-snapshot";
import type { ArticleDocument, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";
import { renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, parseArticleDocumentFromHtml, renderComponentHtml, renderEditorialBlocksToWordPress, parseWordPressEditorialBlocks, parseCompleteEditorialRegion, countCanonicalVisibleWords, extractVisibleFaqFromArticle, extractPlainTextFromEditorialBlocks, validateFaqParity, decodeHtmlEntities } from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { type FinalSeoNormalizerResult } from "@/lib/blog/final-seo-normalizer";
import { normalizeFinalSeo } from "@/lib/blog/final-seo-normalizer";
import {
  createArticleIntegrityBaseline,
  createIntegrityBaselineAfterLinkRemoval,
  validateFinalArticleIntegrity,
  validateWordpressBlockPairs,
  type ArticleIntegrityBaseline,
} from "@/lib/blog/article-integrity";
import type { FinalArticlePolicy, FinalArticleMetrics } from "@/lib/blog/final-article-policy";
import { buildPolicy, analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { extractReadableText, getFirstNReadableWords, extractH2Texts, extractParagraphTexts, countSentences, countReadableWords, containsExactPhrase, countEditorialExternalLinks, extractEditorialExternalLinkUrls } from "@/lib/seo/seo-text-utils";
import { FLESCH_MAX, FLESCH_MIN, GENERATION_BUILD_ID, GENERATION_WORD_BUFFER, MAX_SENTENCES_PER_PARAGRAPH, WORD_ALLOCATION } from "@/lib/services/generation-constants";
import { normalizeEnglishTitleCasing } from "@/lib/services/text-utils";
import { insertExternalResearchLinksIntoDocument, deduplicateEditorialExternalLinks, pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";
import { expandToMinimum, trimToMaximum, normalizeParagraphs } from "@/lib/services/section-expander";
import {
  runEditorialPolish,
  isEditorialPolishEnabled,
  extractEditableBlocks,
  findMalformedEditableBlocks,
  findProseOnlyEditableBlockIds,
  findRepetitionPairTargets,
  applyDeterministicRepetitionFallback,
  repetitionPairSurfaceFlags,
  findWeakenedEditableBlockIds,
  repairDeterministicMalformedProse,
  type EditorialPolishMode,
} from "@/lib/pipeline/editorial-polish";
import { runComponentRegeneration, regenerateConclusion, regenerateSection } from "@/lib/services/component-regenerator";
import { scanFactualRisks, removeUnsupportedSentences, formatClaimLog } from "@/lib/blog/factual-risk-scanner";
import { enforceInternalLinkLimit } from "@/lib/blog/final-article-policy";
import { trimConclusionToBudget, extractRoboticPhraseMatches } from "@/lib/blog/publication-quality";
import { isEligibleExternalSourceUrl } from "@/lib/services/article-postprocessors";
import {
  enforceOwnershipAndVerify,
  formatOwnedEvidencePacket,
  formatOwnershipViolationDetails,
  isTopicContextYearClaim,
  validateClaimOwnership,
} from "@/lib/blog/claim-ownership";
import { reconcilePostOwnershipKeyphrase, enforceEditorialH2Keyphrase } from "@/lib/blog/post-ownership-seo-reconcile";
import {
  reconcileFinalKeyphraseDensity,
  canonicalKeyphraseMetrics,
} from "@/lib/blog/final-seo-reconcile";
import {
  validateArticleIntegrityContract,
  type ContractCategory,
} from "@/lib/blog/article-integrity-contract";
import { scanEnglishLanguageConsistency, formatLanguageConsistencyViolations } from "@/lib/blog/language-consistency";
import {
  compressDocumentStructureAware,
  validateCoherence,
  coherenceViolationSummary,
  MIN_SECTION_WORDS,
  type CoherenceViolation,
} from "@/lib/blog/coherence";
import { isSentenceComplete } from "@/lib/blog/sentence-completeness";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import {
  scanMalformedProseInBlocks,
  scanMalformedProseInDocument,
  classifyMalformedIssue,
} from "@/lib/blog/publication-quality";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import { countBoilerplateInDocument } from "@/lib/blog/source-boilerplate";
import {
  assessSourceSectionRelevance,
  assessSectionTopicGrounding,
  assessHeadingNaturalness,
  removeOffTopicSourceCitations,
  collectOffTopicSourceCitationBlockIds,
  formatRelevanceViolations,
  essentialGroundingCarrierSentenceTexts,
  countSectionGroundingCarriers,
} from "@/lib/blog/content-relevance";
import { repairTemporalFreshnessDocument, findTemporalFreshnessIssues } from "@/lib/blog/temporal-freshness";
import {
  runFullDocumentEditorial,
  isFullDocumentEditorialEnabled,
  type FullDocumentEditorialOutcome,
} from "@/lib/pipeline/full-document-editorial";
import {
  analyzeCanonicalEnglishCta,
  CANONICAL_ENGLISH_CTA_FINGERPRINT,
  CANONICAL_ENGLISH_CTA_HTML,
} from "@/lib/blog/canonical-cta";
import { dynamicFaqRange, englishKeyphraseDensity } from "@/lib/content-standards";

// ── Types ──

export interface PipelineStageOutput {
  stage: string;
  inputFingerprint: string;
  outputFingerprint: string;
  accepted: boolean;
  fallbackSource?: string;
  metadata?: Record<string, unknown>;
}

export interface PipelineState {
  readonly userId: string;
  readonly projectId: string;
  readonly keyphrase: string;
  readonly requestedWordCount: number;
  blog: string;
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  faq: Array<{ question: string; answer: string }>;
  internalLinks: any[];
  externalLinks: any[];
  categories: string[];
  tags: string[];
  readingTime: string;
  summary: string;
  articleDoc: ArticleDocument;
  stageOutputs: PipelineStageOutput[];
  h2Headings: string[];
  intro: string;
  conclusion: string;
  wordsPerSection: number;
  exactKeyphraseTarget: number;
  retryCount: number;
  componentRegenerations: number;
  warnings: string[];
  startTime: number;
  normalizationResult: FinalSeoNormalizerResult | null;
  normalizationAccepted: boolean;
  qualityReport: any | null;
  policy: FinalArticlePolicy;
  ctx: any;
  baseline: ArticleIntegrityBaseline | null;
  wordMin: number;
  wordMax: number;
  estimatedTokens: number;
  systemPrompt: string;
  userMessage: string;
  currentWordCount: number;
  expansionAttempts: number;
  trimAttempts: number;
  fullDocumentEditorial?: FullDocumentEditorialOutcome | null;
  /** Opt-in stage-by-stage debug tracing (observational only; created only
   *  when ENABLE_PIPELINE_DEBUG_TRACE=true). Never present in production
   *  unless explicitly enabled, and never mutated by pipeline stages. */
  debugTrace?: PipelineDebugTrace;
}

// ── Pipeline dependencies ──

export interface PipelineDependencies {
  chatWithRetry: any;
  makeTrackedChatForStage: (stage: string) => any;
  telemetry: any;
  context: any;
}

// ── Helpers ──

function fp(html: string): string { return fingerprintHtml(html); }

/**
 * Trace the canonical keyphrase-density trajectory across the mutating tail
 * stages. Uses the identical canonical calculation as the final validation
 * gate (occurrences on the rendered readable text, divided by the canonical
 * visible word count), so the logs and the gate can never disagree.
 */
function traceKeyphraseDensity(label: string, state: PipelineState): void {
  const metrics = canonicalKeyphraseMetrics(state.articleDoc, state.keyphrase);
  console.log(
    `[kp-density] ${label} wc=${metrics.wordCount} occ=${metrics.occurrences}` +
    ` density=${metrics.density.toFixed(2)}% fp=${fp(state.blog)}`,
  );
}

/**
 * The single stage-aware integrity contract enforcement point for the
 * post-editorial deterministic tail. The stage declares the categories it
 * legitimately owns; ANY violation the candidate introduced OUTSIDE that
 * ownership restores the exact pre-mutation snapshot and fails closed, so the
 * final preflight/QC can never discover damage an earlier boundary should
 * have rejected.
 */
function enforceIntegrityContract(
  state: PipelineState,
  deps: PipelineDependencies,
  snap: PipelineSnapshot,
  ownedCategories: ReadonlySet<ContractCategory>,
  label: string,
  options?: { allowRemovalAttributedSeoDrift?: boolean },
): void {
  const previous = JSON.parse(snap.articleDoc) as ArticleDocument;
  const result = validateArticleIntegrityContract(state.articleDoc, {
    keyphrase: state.keyphrase,
    research: deps.context?.research || [],
    ledger: deps.context?.claimOwnership,
    wordMin: state.wordMin,
    wordMax: state.wordMax,
    previous,
    ownedCategories,
    allowRemovalAttributedSeoDrift: options?.allowRemovalAttributedSeoDrift,
  });
  const trace = state.debugTrace;
  const traceCtx = trace ? traceContextFor(state) : undefined;
  if (!result.valid) {
    // Observational trace: finalize the failing stage against the REJECTED
    // candidate (before restore) so the introduced violations and the first
    // corrupting stage are preserved in the diagnostics.
    trace?.rejectContract(
      label,
      result.violations.map((v) => `${v.category}:${v.message}`),
      result.ownedViolations.map((v) => `${v.category}:${v.message}`),
      state.articleDoc,
      traceCtx!,
    );
    // Quarantine the rejected candidate BEFORE rollback destroys it. The
    // artifact is diagnostic-only (debug/pipeline-failures/): it is never
    // written to blog_versions or project content, and a write failure only
    // logs a warning — it can never mask the integrity failure below or
    // change generation behaviour.
    const quarantinePath = captureIntegrityRejection({
      projectId: state.projectId,
      stage: label,
      previous,
      rejected: state.articleDoc,
      violations: result.violations.map((v) => `${v.category}:${v.message}`),
      ownedViolations: result.ownedViolations.map((v) => `${v.category}:${v.message}`),
      keyphrase: state.keyphrase,
      trace,
    });
    // Roll back to the exact pre-stage snapshot. If rollback itself throws, we
    // still record "failed" on the artifact best-effort and then re-throw the
    // ORIGINAL integrity-contract failure (never the rollback error) so the
    // pipeline stays fail-closed.
    let rollbackFailed = false;
    try {
      restoreSnapshot(state, snap);
      syncBlogFromDocument(state);
    } catch (rollbackError) {
      rollbackFailed = true;
      console.error(
        `[${label}] integrity contract rollback FAILED — ` +
        (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
      );
    }
    if (quarantinePath) {
      // Best-effort: the rollback update must never mask the original failure.
      updateIntegrityRejectionRollback(quarantinePath, rollbackFailed ? "failed" : "success");
    }
    console.error(
      `[${label}] integrity contract rejected — rollback=${rollbackFailed ? "failed" : "success"}` +
      ` violations=${JSON.stringify(result.violations.map((v) => `${v.category}:${v.message}`))}` +
      ` restoredFp=${fp(state.blog)}`,
    );
    throw new Error(
      `${label} integrity contract violated: ` +
      result.violations.map((v) => `${v.category}: ${v.message}`).join("; "),
    );
  }
  if (result.ownedViolations.length > 0) {
    trace?.recordContract(
      label,
      true,
      [],
      result.ownedViolations.map((v) => `${v.category}:${v.message}`),
    );
    console.log(
      `[${label}] integrity contract owned-violations=` +
      JSON.stringify(result.ownedViolations.map((v) => `${v.category}:${v.message}`)),
    );
  } else {
    trace?.recordContract(label, true, [], []);
  }
}

/** THE ONLY place state.blog is assigned. No other code may assign state.blog directly. */
function syncBlogFromDocument(state: PipelineState): void {
  state.blog = renderArticleDocument(state.articleDoc);
  state.faq = state.articleDoc.visibleFaq.map((entry) => ({
    question: entry.question,
    answer: entry.answerText,
  }));
}

/** Keep the canonical ArticleDocument metadata aligned with the pipeline's
 * legacy scalar fields until those consumers can read metadata directly. */
function syncMetadataToDocument(state: PipelineState): void {
  state.articleDoc.metadata.title = state.title;
  state.articleDoc.metadata.slug = state.slug;
  state.articleDoc.metadata.metaDescription = state.metaDescription;
  state.articleDoc.metadata.excerpt = state.excerpt;
}

/** Fail immediately if the rendered cache diverges from the canonical document. */
export function assertRenderedCacheMatchesDocument(state: Pick<PipelineState, "articleDoc" | "blog">): void {
  const canonicalHtml = renderArticleDocument(state.articleDoc);
  if (state.blog !== canonicalHtml) {
    throw new Error(
      `Pipeline rendered cache diverged from ArticleDocument: cached=${fingerprintHtml(state.blog)} canonical=${fingerprintHtml(canonicalHtml)}`,
    );
  }
}

/**
 * Non-mutating diagnostic of the editorial-H2 keyphrase status. At least one
 * normal editorial H2 (FAQ, conclusion and CTA/protected headings never count)
 * is a quality target; the exact focus keyphrase in an editorial H2 is a SOFT
 * SEO signal, not a save-blocking invariant. Heading naturalness is reported
 * separately because naturalness/structural corruption remains a genuine hard
 * quality gate.
 */
function evaluateEditorialH2Status(state: PipelineState): {
  editorialH2Exists: boolean;
  exactKeyphrase: boolean;
  unnaturalHeadings: number;
} {
  const kpLower = state.keyphrase.toLowerCase().trim();
  const editorialHeadings = state.articleDoc.sections
    .filter(
      (section) =>
        section.sectionType !== "faq-heading"
        && section.sectionType !== "conclusion-heading",
    )
    .map((section) => section.heading);
  return {
    editorialH2Exists: editorialHeadings.length > 0,
    exactKeyphrase: editorialHeadings.some((heading) =>
      heading.toLowerCase().includes(kpLower),
    ),
    unnaturalHeadings: assessHeadingNaturalness(state.articleDoc, state.keyphrase).length,
  };
}


/** SEO normalization runs before canonical CTA restoration, so a missing CTA at
 * this stage must not discard an otherwise valid normalized article. */
export function shouldAcceptSeoNormalization(result: FinalSeoNormalizerResult): boolean {
  const safety = result.safety;
  return result.passed === true
    && (result.after?.malformedProseCount ?? 0) <= (result.before?.malformedProseCount ?? 0)
    && safety.protectedBlocksUnchanged
    && safety.linkDestinationsUnchanged
    && safety.wordpressBlocksValid
    && safety.faqSchemaPreserved
    && safety.languageSwitcherPreserved;
}

/**
 * Editorial-H2 keyphrase repair bounded by the hard density limit. The H2
 * keyphrase placement is a soft signal; keyphrase stuffing is a hard gate. A
 * heading repair that would push density above 3% is rolled back so no later
 * stage can reintroduce density above the hard limit. Returns the rollback
 * decision so the caller can log it.
 */
export function applyEditorialH2WithDensityGuard(
  doc: ArticleDocument,
  keyphrase: string,
): { satisfied: boolean; rolledBack: boolean; densityAfter: number } {
  const snapshot = JSON.stringify(doc);
  const result = enforceEditorialH2Keyphrase(doc, keyphrase);
  const { stuffingAbove } = englishKeyphraseDensity();
  const densityAfter = canonicalKeyphraseMetrics(doc, keyphrase).density;
  if (result.satisfied && densityAfter > stuffingAbove) {
    const restored = JSON.parse(snapshot) as ArticleDocument;
    doc.sections = restored.sections;
    doc.introduction = restored.introduction;
    doc.conclusion = restored.conclusion;
    doc.visibleFaq = restored.visibleFaq;
    doc.languageSwitcher = restored.languageSwitcher;
    doc.cta = restored.cta;
    doc.faqSchema = restored.faqSchema;
    doc.metadata = restored.metadata;
    doc.insertedLinks = restored.insertedLinks;
    return { satisfied: false, rolledBack: true, densityAfter };
  }
  return { satisfied: result.satisfied, rolledBack: false, densityAfter };
}

/** Compute the exact readable word count used by final validation. */
export function finalReadableWordCount(
  state: Pick<PipelineState, "articleDoc">,
): number {
  return countCanonicalVisibleWords(state.articleDoc);
}

/**
 * Candidate policy for the editorial point in the pipeline. CTA and its
 * signup URL are restored by the following application-owned stage, so their
 * absence here must not reject otherwise safe editorial improvements.
 */
export function evaluateEditorialStageCandidate(
  metrics: FinalArticleMetrics,
  policy: FinalArticlePolicy,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.readableWordCount < policy.wordCountMin || metrics.readableWordCount > policy.wordCountMax) {
    reasons.push(`word count=${metrics.readableWordCount} (range: ${policy.wordCountMin}-${policy.wordCountMax})`);
  }
  if (metrics.h2Count < policy.h2Min || metrics.h2Count > policy.h2Max) {
    reasons.push(`H2 count=${metrics.h2Count} (range: ${policy.h2Min}-${policy.h2Max})`);
  }
  if (metrics.faqEntryCount < policy.faqEntryMin || metrics.faqEntryCount > policy.faqEntryMax) {
    reasons.push(`FAQ entries=${metrics.faqEntryCount} (range: ${policy.faqEntryMin}-${policy.faqEntryMax})`);
  }
  if (metrics.longParagraphCount !== 0) reasons.push(`long paragraphs=${metrics.longParagraphCount}`);
  if (metrics.keyphraseDensity > 3) {
    reasons.push(`keyphrase density=${metrics.keyphraseDensity.toFixed(2)}%`);
  }
  if (metrics.uniqueInternalLinkCount > policy.internalLinkMax) {
    reasons.push(`internal links=${metrics.uniqueInternalLinkCount}`);
  }
  if (metrics.wpBlockCountMismatch) reasons.push("WP block count mismatch");
  if (metrics.nestedParagraphCount !== 0) {
    reasons.push(`nested paragraphs=${metrics.nestedParagraphCount}`);
  }
  if (metrics.malformedHeadingCount !== 0) {
    reasons.push(`malformed headings=${metrics.malformedHeadingCount}`);
  }
  if (policy.requiredFaqParity && !metrics.faqParityValid) reasons.push("FAQ parity mismatch");
  if (metrics.hasPlaceholderContent) reasons.push("placeholder content found");
  if (metrics.hasRawProseOutsideBlocks) reasons.push("raw prose outside WordPress blocks");
  if (!metrics.hasConclusionContent) reasons.push("conclusion content missing");
  if ((metrics.claimConflictCount ?? 0) > policy.maxClaimConflicts) {
    reasons.push(`factual contradictions=${metrics.claimConflictCount}`);
  }
  if ((metrics.malformedProseCount ?? 0) > policy.maxMalformedProseIssues) {
    reasons.push(`malformed prose issues=${metrics.malformedProseCount}`);
  }
  if ((metrics.staleTemporalClaimCount ?? 0) > policy.maxStaleTemporalClaims) {
    reasons.push(`stale temporal claims=${metrics.staleTemporalClaimCount}`);
  }
  if ((metrics.repeatedIdeaPairCount ?? 0) > policy.maxRepeatedIdeaPairs) {
    reasons.push(`repeated idea pairs=${metrics.repeatedIdeaPairCount}`);
  }
  if ((metrics.conclusionWordRatio ?? 0) > policy.maxConclusionWordRatio) {
    reasons.push(`conclusion share=${((metrics.conclusionWordRatio ?? 0) * 100).toFixed(1)}%`);
  }
  if ((metrics.conclusionNewNumericClaimCount ?? 0) > policy.maxConclusionNewNumericClaims) {
    reasons.push(`new numeric claims in conclusion=${metrics.conclusionNewNumericClaimCount}`);
  }
  if ((metrics.factualScore ?? 100) < policy.minimumFactualScore) {
    reasons.push(`factual score=${metrics.factualScore}`);
  }
  if ((metrics.editorialScore ?? 100) < policy.minimumEditorialScore) {
    reasons.push(`editorial score=${metrics.editorialScore}`);
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * Choose which document to commit after the editorial transaction.
 *
 * Successful targeted repairs (malformed, weakened, repetition) are correctness
 * fixes applied to specific stable block IDs and must persist even when the
 * score-gated general polish is rejected. A rejected later candidate must never
 * restore a fragment that a targeted repair already fixed.
 */
export function chooseEditorialCommitDoc(params: {
  baselineDoc: ArticleDocument;
  workingDoc: ArticleDocument;
  targetedRepairsDoc: ArticleDocument | null;
  accepted: boolean;
}): { doc: ArticleDocument; targetedRepairsPersisted: boolean } {
  if (params.accepted) return { doc: params.workingDoc, targetedRepairsPersisted: false };
  if (params.targetedRepairsDoc) return { doc: params.targetedRepairsDoc, targetedRepairsPersisted: true };
  return { doc: params.baselineDoc, targetedRepairsPersisted: false };
}

/** Return the only article-level word count used by the pipeline and final gate. */
export function assertFinalWordCountParity(
  state: Pick<PipelineState, "articleDoc">,
): number {
  return finalReadableWordCount(state);
}

/** Render a canonical structured component to WordPress HTML. */
function componentHtml(component: ArticleDocument["introduction"]): string {
  return renderComponentHtml(component);
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * FAQ is synthesis-only. Remove every precise factual sentence, including a
 * supported one, so the FAQ cannot become a second owner for section evidence.
 * The editor never receives FAQ blocks; this deterministic pass is the sole
 * factual boundary for visible FAQ answers before schema recovery.
 */
export function sanitizeFaqFactualClaims(
  entries: ArticleDocument["visibleFaq"],
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
  topicContext?: { keyphrase: string; title?: string; metaDescription?: string; headings?: string[] },
): {
  entries: ArticleDocument["visibleFaq"];
  unsupportedSentencesRemoved: number;
  citationsAdded: number;
} {
  let unsupportedSentencesRemoved = 0;
  const citationsAdded = 0;
  const effectiveContext = topicContext ?? { keyphrase };

  const sanitized = entries.map((entry, index) => {
    const paragraphHtml =
      `<!-- wp:paragraph --><p>${escapeHtmlText(entry.answerText)}</p><!-- /wp:paragraph -->`;
    const initialRisk = scanFactualRisks(paragraphHtml, keyphrase, research);
    const claimsToRemove = initialRisk.claims.filter(
      (claim) => !isTopicContextYearClaim(claim, effectiveContext),
    );
    const cleanup = removeUnsupportedSentences(paragraphHtml, claimsToRemove);
    unsupportedSentencesRemoved += cleanup.sentencesRemoved;

    const remainingClaims = scanFactualRisks(
      cleanup.html,
      keyphrase,
      research,
    ).claims.filter((claim) => !isTopicContextYearClaim(claim, effectiveContext));
    if (remainingClaims.length > 0) {
      throw new Error(
        `Precise factual claim could not be removed safely from synthesis-only FAQ ${index + 1}: ` +
        remainingClaims[0].text,
      );
    }

    // The answer text is canonical plain text: strip the paragraph wrapper and
    // tags WITHOUT destroying entities (extractReadableText would replace
    // letter entities with spaces), then decode the entities the scan HTML
    // introduced. The schema is rendered from this same text, so the canonical
    // answer and the schema answer are always the same semantic string.
    const cleanedText = cleanup.html
      .replace(/<!--\s*wp:paragraph\s*-->[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<!--\s*\/wp:paragraph\s*-->/i, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    let answerText = decodeHtmlEntities(cleanedText);
    if (!answerText) {
      answerText =
        "Use the practical guidance in the relevant section and adapt it to your audience and goals.";
    }

    return {
      ...entry,
      answerText,
      answerHtml: `<p>${escapeHtmlText(answerText)}</p>`,
    };
  });

  return { entries: sanitized, unsupportedSentencesRemoved, citationsAdded };
}

/** Replace a component's structured blocks from validated WordPress HTML. */
function replaceComponentHtml(
  component: ArticleDocument["introduction"],
  html: string,
  status?: ArticleDocument["introduction"]["status"],
): void {
  const parsed = parseCompleteEditorialRegion(html, component.id);
  if (parsed.errors.length > 0 || (html.trim().length > 0 && parsed.blocks.length === 0)) {
    throw new Error(
      `Component ${component.id} rejected invalid editorial HTML: ` +
      `${parsed.errors.join("; ") || "no supported editorial blocks"}`,
    );
  }
  component.blocks = parsed.blocks;
  if (status) component.status = status;
}

/** Replace the exact candidate object that the editor will later commit. */
function replaceArticleDocumentInPlace(target: ArticleDocument, source: ArticleDocument): void {
  const copy = structuredClone(source);
  target.metadata = copy.metadata;
  target.languageSwitcher = copy.languageSwitcher;
  target.introduction = copy.introduction;
  target.sections = copy.sections;
  target.conclusion = copy.conclusion;
  target.visibleFaq = copy.visibleFaq;
  target.cta = copy.cta;
  target.faqSchema = copy.faqSchema;
  target.insertedLinks = copy.insertedLinks;
  if (copy.sourceReferences) target.sourceReferences = copy.sourceReferences;
  else delete target.sourceReferences;
}

function paragraphPlainText(block: EditorialBlock): string | null {
  if (block.type !== "paragraph") return null;
  if (block.content.some((node) => node.type !== "text")) return null;
  return block.content.map((node) => node.text).join("").trim();
}

function safeTrimParagraph(
  block: EditorialBlock,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): { wordCount: number; plainText: string | null } | null {
  if (block.type !== "paragraph") return null;
  const html = renderEditorialBlocksToWordPress([block]);
  const wordCount = countReadableWords(html);
  if (wordCount < 6) return null;
  const claims = scanFactualRisks(html, keyphrase, research).claims;
  if (
    /<a\b/i.test(html)
    || claims.length > 0
    || (keyphrase.trim() && containsExactPhrase(html, keyphrase))
    || /(?:HK\$|US\$|[$£€¥]|\b(?:19|20)\d{2}\b|\d)/i.test(html)
    || /according to|research (?:from|by)|data (?:from|shows)|study (?:from|by)/i.test(html)
  ) return null;
  return { wordCount, plainText: paragraphPlainText(block) };
}

export interface FinalTrimFallbackResult {
  removedWords: number;
  shortenedSentences: number;
  removedParagraphs: number;
  finalWordCount: number;
}

/**
 * Close a residual word-count overrun without slicing prose. This fallback may
 * remove only a complete trailing sentence from a fact-free plain paragraph or
 * one complete fact-free paragraph from an editable H2 section.
 */
export function trimResidualSafeProseToMaximum(
  doc: ArticleDocument,
  wordMax: number,
  wordMin: number,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): FinalTrimFallbackResult {
  let removedWords = 0;
  let shortenedSentences = 0;
  let removedParagraphs = 0;
  const sections = () => doc.sections.filter(
    (section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading",
  );

  for (let guard = 0; guard < 20 && countCanonicalVisibleWords(doc) > wordMax; guard++) {
    const excess = countCanonicalVisibleWords(doc) - wordMax;
    const candidates: Array<{
      section: ArticleDocument["sections"][number];
      block: Extract<EditorialBlock, { type: "paragraph" }>;
      remainder: string;
      sentenceWords: number;
      distanceFromEnd: number;
    }> = [];
    for (const section of sections()) {
      for (let blockIndex = section.blocks.length - 1; blockIndex >= 0; blockIndex--) {
        const block = section.blocks[blockIndex];
        const safe = safeTrimParagraph(block, keyphrase, research);
        if (!safe?.plainText || block.type !== "paragraph") continue;
        const sentences = safe.plainText.match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g)?.map((v) => v.trim()).filter(Boolean) ?? [];
        if (sentences.length < 2) continue;
        const trailing = sentences[sentences.length - 1];
        const sentenceWords = countReadableWords(trailing);
        const remainder = safe.plainText.slice(0, safe.plainText.lastIndexOf(trailing)).trim();
        if (sentenceWords < 4 || countReadableWords(remainder) < 12) continue;
        if (countCanonicalVisibleWords(doc) - sentenceWords < wordMin) continue;
        candidates.push({ section, block, remainder, sentenceWords, distanceFromEnd: section.blocks.length - 1 - blockIndex });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => {
      const ac = a.sentenceWords >= excess ? 0 : 1;
      const bc = b.sentenceWords >= excess ? 0 : 1;
      return ac - bc || (ac === 0 ? a.sentenceWords - b.sentenceWords : b.sentenceWords - a.sentenceWords) || a.distanceFromEnd - b.distanceFromEnd;
    });
    const selected = candidates[0];
    selected.block.content = [{ type: "text", text: selected.remainder }];
    selected.section.status = "trimmed";
    removedWords += selected.sentenceWords;
    shortenedSentences++;
  }

  for (let guard = 0; guard < 20 && countCanonicalVisibleWords(doc) > wordMax; guard++) {
    const excess = countCanonicalVisibleWords(doc) - wordMax;
    const candidates: Array<{ section: ArticleDocument["sections"][number]; blockIndex: number; wordCount: number; distanceFromEnd: number }> = [];
    for (const section of sections()) {
      if (section.blocks.filter((block) => block.type === "paragraph").length <= 1) continue;
      const sectionWords = countReadableWords(renderComponentHtml(section));
      for (let blockIndex = section.blocks.length - 1; blockIndex >= 0; blockIndex--) {
        const safe = safeTrimParagraph(section.blocks[blockIndex], keyphrase, research);
        if (!safe || sectionWords - safe.wordCount < 50) continue;
        if (countCanonicalVisibleWords(doc) - safe.wordCount < wordMin) continue;
        candidates.push({ section, blockIndex, wordCount: safe.wordCount, distanceFromEnd: section.blocks.length - 1 - blockIndex });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => {
      const ac = a.wordCount >= excess ? 0 : 1;
      const bc = b.wordCount >= excess ? 0 : 1;
      return ac - bc || (ac === 0 ? a.wordCount - b.wordCount : b.wordCount - a.wordCount) || a.distanceFromEnd - b.distanceFromEnd;
    });
    const selected = candidates[0];
    selected.section.blocks.splice(selected.blockIndex, 1);
    selected.section.status = "trimmed";
    removedWords += selected.wordCount;
    removedParagraphs++;
  }

  return { removedWords, shortenedSentences, removedParagraphs, finalWordCount: countCanonicalVisibleWords(doc) };
}

/** Derive section input from the canonical ArticleDocument. */
function deriveSectionInput(state: PipelineState): Array<{
  index: number;
  id: string;
  heading: string;
  body: string;
  evidencePrompt?: string;
}> {
  const ledger = state.ctx?.claimOwnership;
  return state.articleDoc.sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) =>
      section.sectionType !== "faq-heading"
      && section.sectionType !== "conclusion-heading"
    )
    .map(({ section, index }) => ({
      index,
      id: section.id,
      heading: section.heading,
      body: componentHtml(section),
      evidencePrompt: ledger ? formatOwnedEvidencePacket(ledger, section.id) : undefined,
    }));
}

// ── Validation ──

interface StageValidationResult {
  valid: boolean; nestedParagraphs: number; malformedHeadings: number;
  wpBlocksValid: boolean; unclosedTags: string[]; issues: string[];
}

function runStageValidation(html: string, baseline: ArticleIntegrityBaseline, stage: string): StageValidationResult {
  const result = validateFinalArticleIntegrity(html, baseline);
  const unclosed = result.errors.filter((e) => e.startsWith("Unclosed HTML tags"));
  const unclosedTags = unclosed.length > 0 ? [unclosed[0]] : [];
  const wpPairResult = validateWordpressBlockPairs(html);
  const wpBlocksValid = wpPairResult.valid;
  const issues = [...new Set([...result.errors, ...wpPairResult.issues])];
  return { valid: result.valid && wpBlocksValid, nestedParagraphs: result.metrics.nestedParagraphCount,
    malformedHeadings: result.metrics.malformedHeadingCount, wpBlocksValid, unclosedTags, issues };
}

function logValidationFailure(
  stage: string,
  label: "Candidate" | "Fallback",
  html: string,
  validation: StageValidationResult,
): void {
  const entry = {
    htmlLength: html.length,
    fingerprint: fp(html),
    valid: validation.valid,
    wpBlocksValid: validation.wpBlocksValid,
    nestedParagraphs: validation.nestedParagraphs,
    malformedHeadings: validation.malformedHeadings,
    unclosedTags: validation.unclosedTags,
    issues: validation.issues,
  };
  console.error(`[PIPELINE:${stage}] ${label} validation failed`);
  console.error(JSON.stringify(entry, null, 2));
}

function formatIssueSummary(validation: StageValidationResult, maxIssues = 5): string {
  const count = validation.issues.length;
  const shown = validation.issues.slice(0, maxIssues);
  let summary = `${count} issue${count !== 1 ? "s" : ""}`;
  if (shown.length > 0) {
    summary += `: ${shown.join("; ")}`;
    if (count > maxIssues) summary += ` ... and ${count - maxIssues} more`;
  }
  return summary;
}

function assertValidStageInput(
  html: string,
  baseline: ArticleIntegrityBaseline,
  stageName: string,
): void {
  const validation = runStageValidation(html, baseline, stageName);
  if (!validation.valid) {
    logValidationFailure(stageName, "Candidate", html, validation);
    throw new Error(
      `Stage ${stageName} received invalid pre-stage HTML. ` +
      `${formatIssueSummary(validation)}`,
    );
  }
}

export function guardStageOutput(
  currentHtml: string, previousHtml: string | null, baseline: ArticleIntegrityBaseline, stage: string,
): { html: string; accepted: boolean } {
  const validation = runStageValidation(currentHtml, baseline, stage);
  if (validation.valid) return { html: currentHtml, accepted: true };

  logValidationFailure(stage, "Candidate", currentHtml, validation);

  if (previousHtml !== null) {
    const prevValidation = runStageValidation(previousHtml, baseline, `${stage}-fallback`);
    if (prevValidation.valid) return { html: previousHtml, accepted: false };

    logValidationFailure(stage, "Fallback", previousHtml, prevValidation);

    throw new Error(
      `Stage ${stage}: both candidate and fallback invalid. ` +
      `Candidate ${formatIssueSummary(validation)}. ` +
      `Fallback ${formatIssueSummary(prevValidation)}.`,
    );
  }
  throw new Error(
    `Stage ${stage}: no fallback available, candidate invalid. ` +
    `${formatIssueSummary(validation)}`,
  );
}

export function recordStage(state: PipelineState, stageName: string, inputFp: string, outputFp: string, accepted: boolean, fallbackSource?: string, metadata?: Record<string, unknown>): void {
  state.stageOutputs.push({ stage: stageName, inputFingerprint: inputFp, outputFingerprint: outputFp, accepted, fallbackSource, metadata });
}

/**
 * Final-document editorial boundary precondition. Before the model may diagnose the
 * complete document, the canonical render must be structurally sound: balanced and
 * type-correct WordPress blocks, canonical/render cache equality, protected-content
 * integrity, FAQ/schema parity and exactly one canonical CTA. This ensures the
 * final-document diagnosis never receives structurally invalid HTML.
 */
export function assertFinalEditorialBoundary(state: PipelineState): void {
  const html = state.blog;
  const canonicalRender = renderArticleDocument(state.articleDoc);
  if (canonicalRender !== html) {
    throw new Error(
      `Final-document editorial boundary: canonical/render cache mismatch (canonical render ${fingerprintHtml(canonicalRender)} vs cache ${fp(html)})`,
    );
  }

  const baseline = createArticleIntegrityBaseline(html);
  const integrity = validateFinalArticleIntegrity(html, baseline);
  const wpPair = validateWordpressBlockPairs(html);
  if (!integrity.valid || !wpPair.valid) {
    const issues = [...integrity.errors, ...wpPair.issues];
    throw new Error(`Final-document editorial boundary: invalid canonical render. ${issues.join("; ")}`);
  }

  const cta = analyzeCanonicalEnglishCta(html);
  if (
    !cta.valid
    || state.articleDoc.cta?.html.replace(/\s+/g, " ").trim()
      !== CANONICAL_ENGLISH_CTA_HTML.replace(/\s+/g, " ").trim()
    || state.articleDoc.cta?.fingerprint !== CANONICAL_ENGLISH_CTA_FINGERPRINT
  ) {
    throw new Error(`Final-document editorial boundary: CTA integrity failed. ${cta.issues.join("; ")}`);
  }

  const slugs = pairedSlugs(state.articleDoc.metadata.slug || "blog-post");
  const canonicalSwitcher = renderLanguageSwitcher({
    currentLanguage: "en",
    englishSlug: slugs.englishSlug,
    chineseSlug: slugs.chineseSlug,
  });
  if (
    state.articleDoc.languageSwitcher?.html !== canonicalSwitcher
    || state.articleDoc.languageSwitcher?.fingerprint !== fingerprintHtml(canonicalSwitcher)
  ) {
    throw new Error("Final-document editorial boundary: English language switcher is not canonical");
  }

  // FAQ / schema parity from the canonical FAQ array.
  const faqRange = dynamicFaqRange(state.articleDoc.metadata.targetWordCount || state.requestedWordCount);
  if (
    state.articleDoc.visibleFaq.length < faqRange.min
    || state.articleDoc.visibleFaq.length > faqRange.max
  ) {
    throw new Error(
      `Final-document editorial boundary: canonical visible FAQ count=${state.articleDoc.visibleFaq.length}`
      + ` outside ${faqRange.min}-${faqRange.max}`,
    );
  }
  const renderedFaq = extractVisibleFaqFromArticle(html, state.articleDoc);
  const schemaHtml = extractFaqBlock(html);
  const parity = validateFaqParity(state.articleDoc.visibleFaq, schemaHtml);
  const renderedMatchesCanonical = renderedFaq.length === state.articleDoc.visibleFaq.length
    && renderedFaq.every((entry, index) => {
      const canonical = state.articleDoc.visibleFaq[index];
      return canonical
        && entry.question.replace(/\s+/g, " ").trim() === canonical.question.replace(/\s+/g, " ").trim()
        && entry.answerText.replace(/\s+/g, " ").trim() === canonical.answerText.replace(/\s+/g, " ").trim();
    });
  if (!schemaHtml || !parity.valid || !renderedMatchesCanonical) {
    throw new Error(
      `Final-document editorial boundary: FAQ/schema parity mismatch`+
      ` (canonical=${state.articleDoc.visibleFaq.length} rendered=${renderedFaq.length})`,
    );
  }
}


// ── State snapshot (articleDoc is the canonical source) ──

export interface PipelineSnapshot {
  articleDoc: string;
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  currentWordCount: number;
  expansionAttempts: number;
  trimAttempts: number;
  retryCount: number;
  componentRegenerations: number;
  normalizationResult: FinalSeoNormalizerResult | null;
  normalizationAccepted: boolean;
  fullDocumentEditorial: FullDocumentEditorialOutcome | null;
}

export function snapshotState(state: PipelineState): PipelineSnapshot {
  return {
    articleDoc: JSON.stringify(state.articleDoc),
    title: state.title,
    slug: state.slug,
    metaDescription: state.metaDescription,
    excerpt: state.excerpt,
    currentWordCount: state.currentWordCount,
    expansionAttempts: state.expansionAttempts,
    trimAttempts: state.trimAttempts,
    retryCount: state.retryCount,
    componentRegenerations: state.componentRegenerations,
    normalizationResult: state.normalizationResult,
    normalizationAccepted: state.normalizationAccepted,
    fullDocumentEditorial: state.fullDocumentEditorial
      ? structuredClone(state.fullDocumentEditorial)
      : null,
  };
}

function restoreSnapshot(state: PipelineState, snap: PipelineSnapshot): void {
  state.articleDoc = JSON.parse(snap.articleDoc);
  syncBlogFromDocument(state);
  state.title = snap.title;
  state.slug = snap.slug;
  state.metaDescription = snap.metaDescription;
  state.excerpt = snap.excerpt;
  state.currentWordCount = snap.currentWordCount;
  state.expansionAttempts = snap.expansionAttempts;
  state.trimAttempts = snap.trimAttempts;
  state.retryCount = snap.retryCount;
  state.componentRegenerations = snap.componentRegenerations;
  state.normalizationResult = snap.normalizationResult;
  state.normalizationAccepted = snap.normalizationAccepted;
  state.fullDocumentEditorial = snap.fullDocumentEditorial
    ? structuredClone(snap.fullDocumentEditorial)
    : null;
  syncMetadataToDocument(state);
}

// ── Stage runner: HTML-returning stages must parse back to ArticleDocument ──

function applyHtmlToDocument(state: PipelineState, html: string, existingDoc: ArticleDocument): boolean {
  const parseResult = parseArticleDocumentFromHtml(html, existingDoc);
  if (!parseResult.doc) {
    console.error(`[PIPELINE] Failed to parse HTML back to ArticleDocument: ${parseResult.errors.join("; ")}`);
    return false;
  }
  state.articleDoc = parseResult.doc;
  syncBlogFromDocument(state);
  assertRenderedCacheMatchesDocument(state);
  return true;
}

export function runTrackedHtmlStage(state: PipelineState, stageName: string, fn: (html: string) => string, preSnapshot?: PipelineSnapshot): PipelineState {
  // Several structured stages mutate a cloned/canonical candidate before they
  // enter this common guard. When a snapshot is supplied, the comparison
  // baseline must be that true pre-stage document rather than the already
  // mutated render; otherwise protected-content loss can compare equal to
  // itself and bypass rollback.
  const preHtml = preSnapshot
    ? renderArticleDocument(JSON.parse(preSnapshot.articleDoc) as ArticleDocument)
    : state.blog;
  const inputFp = fp(preHtml);
  const stageBaseline = createArticleIntegrityBaseline(preHtml);
  const snap = preSnapshot ?? snapshotState(state);
  const trace = state.debugTrace;
  const traceCtx = trace ? traceContextFor(state) : undefined;
  trace?.beginStage(stageName, snap.articleDoc, traceCtx!);

  assertValidStageInput(preHtml, stageBaseline, stageName);

  const resultHtml = fn(state.blog);
  syncMetadataToDocument(state);

  // Parse back to ArticleDocument. If parsing fails, restore snapshot.
  if (!applyHtmlToDocument(state, resultHtml, state.articleDoc)) {
    console.warn(`[PIPELINE:${stageName}] HTML-to-document parse failed — restoring pre-stage state`);
    restoreSnapshot(state, snap);
    trace?.endStage(stageName, state.articleDoc, traceCtx!, false, true);
    recordStage(state, stageName, inputFp, inputFp, false, "parse-failure");
    return state;
  }

  const guard = guardStageOutput(state.blog, preHtml, stageBaseline, stageName);
  if (!guard.accepted) {
    restoreSnapshot(state, snap);
  }
  assertRenderedCacheMatchesDocument(state);
  const outputFp = fp(state.blog);
  trace?.endStage(stageName, state.articleDoc, traceCtx!, guard.accepted, !guard.accepted);
  recordStage(state, stageName, inputFp, outputFp, guard.accepted, guard.accepted ? undefined : "pre-stage-restore");
  return state;
}

// ── Pipeline state factory ──

export function createPipelineState(params: {
  userId: string; projectId: string; keyphrase: string; requestedWordCount: number;
  articleDoc: ArticleDocument; h2Headings: string[];
  intro: string; conclusion: string; wordsPerSection: number; exactKeyphraseTarget: number;
  policy: FinalArticlePolicy; ctx: any; wordMin: number; wordMax: number;
  systemPrompt: string; userMessage: string;
  retryCount?: number; componentRegenerations?: number;
}): PipelineState {
  const blog = renderArticleDocument(params.articleDoc);
  return {
    userId: params.userId, projectId: params.projectId, keyphrase: params.keyphrase,
    requestedWordCount: params.requestedWordCount, blog,
    title: params.articleDoc.metadata.title, slug: params.articleDoc.metadata.slug,
    metaDescription: params.articleDoc.metadata.metaDescription, excerpt: params.articleDoc.metadata.excerpt,
    faq: params.articleDoc.visibleFaq.map((entry) => ({ question: entry.question, answer: entry.answerText })),
    internalLinks: [], externalLinks: [], categories: [], tags: [], readingTime: "", summary: "",
    articleDoc: params.articleDoc, stageOutputs: [],
    h2Headings: params.h2Headings,
    intro: params.intro, conclusion: params.conclusion,
    wordsPerSection: params.wordsPerSection, exactKeyphraseTarget: params.exactKeyphraseTarget,
    retryCount: params.retryCount ?? 0, componentRegenerations: params.componentRegenerations ?? 0,
    warnings: [], startTime: Date.now(),
    normalizationResult: null, normalizationAccepted: false, qualityReport: null,
    policy: params.policy, ctx: params.ctx, baseline: null,
    wordMin: params.wordMin, wordMax: params.wordMax,
    estimatedTokens: 0, systemPrompt: params.systemPrompt, userMessage: params.userMessage,
    currentWordCount: 0, expansionAttempts: 0, trimAttempts: 0,
    fullDocumentEditorial: null,
    debugTrace: isPipelineDebugTraceEnabled() ? new PipelineDebugTrace() : undefined,
  };
}

export function validatePipelineOrder(state: PipelineState): Array<{ code: string; message: string; stage: string }> {
  const issues: Array<{ code: string; message: string; stage: string }> = [];
  const stages = state.stageOutputs.map((s) => s.stage);
  const required = [
    "claim-check", "source-relevance-repair", "expansion", "trim", "paragraphs", "regeneration",
    "seo-normalization", "title-repair", "factual-scan", "claim-ownership", "temporal-freshness",
    "post-factual-keyphrase", "paragraphs-final", "malformed-prose-repair", "claim-ownership-final",
    "language-switcher", "internal-links", "external-links", "external-dedup",
    "link-enforce", "factual-final", "post-ownership-seo-reconcile", "cta-preserve", "final-trim",
    "final-seo-reconcile", "faq-recovery", "wc-check", "final-preflight", "editorial-h2-enforce", "final-qc-scan",
    "final-document-editorial", "editorial-h2-save-assert", "final-validation",
  ];
  if (isEditorialPolishEnabled()) {
    required.push("conclusion-discipline", "editorial-polish");
  }
  if (!isFullDocumentEditorialEnabled()) {
    const index = required.indexOf("final-document-editorial");
    if (index >= 0) required.splice(index, 1);
  }
  for (const req of required) {
    if (!stages.includes(req)) issues.push({ code: "MISSING_STAGE", message: `Required stage "${req}" not found`, stage: req });
  }
  const expectedOrder = [
    "claim-check",
    "source-relevance-repair",
    ...(isEditorialPolishEnabled() ? ["conclusion-discipline"] : []),
    "expansion", "trim", "paragraphs", "regeneration", "seo-normalization",
    "title-repair", "factual-scan", "claim-ownership", "temporal-freshness", "post-factual-keyphrase",
    "paragraphs-final", "malformed-prose-repair",
    ...(isEditorialPolishEnabled() ? ["editorial-polish"] : []),
    "claim-ownership-final", "language-switcher", "internal-links", "external-links",
    "external-dedup",     "link-enforce", "factual-final", "post-ownership-seo-reconcile", "cta-preserve",
    "final-trim", "final-seo-reconcile", "faq-recovery", "wc-check", "final-preflight", "editorial-h2-enforce", "final-qc-scan",
    ...(isFullDocumentEditorialEnabled() ? ["final-document-editorial"] : []),
    "editorial-h2-save-assert",
    "final-validation",
  ];
  for (let left = 0; left < expectedOrder.length; left++) {
    for (let right = left + 1; right < expectedOrder.length; right++) {
      const earlier = expectedOrder[left];
      const later = expectedOrder[right];
      const earlierIndex = stages.indexOf(earlier);
      const laterIndex = stages.indexOf(later);
      if (earlierIndex >= 0 && laterIndex >= 0 && earlierIndex > laterIndex) {
        issues.push({
          code: "STAGE_ORDER",
          message: `${earlier} must run before ${later}`,
          stage: earlier,
        });
      }
    }
  }
  return issues;
}


function temporalMetricsFor(
  state: PipelineState,
  doc: ArticleDocument,
  referenceDate: Date,
): FinalArticleMetrics {
  return analyzeFinalArticle(
    renderArticleDocument(doc),
    state.keyphrase,
    doc.metadata.title,
    doc.metadata.metaDescription,
    state.requestedWordCount,
    countCanonicalVisibleWords(doc),
    {
      articleDoc: doc,
      research: state.ctx?.research || [],
      claimOwnership: state.ctx?.claimOwnership,
      referenceDate,
    },
  );
}

export function validateTemporalCandidate(
  state: PipelineState,
  before: FinalArticleMetrics,
  after: FinalArticleMetrics,
): string[] {
  const reasons: string[] = [];
  if ((after.staleTemporalClaimCount ?? 0) !== 0) {
    reasons.push(`stale temporal claims=${after.staleTemporalClaimCount ?? 0}`);
  }
  if ((after.unsupportedFactualClaimCount ?? 0) > (before.unsupportedFactualClaimCount ?? 0)) {
    reasons.push(`unsupported factual claims regressed: ${before.unsupportedFactualClaimCount ?? 0} → ${after.unsupportedFactualClaimCount ?? 0}`);
  }
  if ((after.claimOwnershipViolationCount ?? 0) > (before.claimOwnershipViolationCount ?? 0)) {
    reasons.push(`claim ownership regressed: ${before.claimOwnershipViolationCount ?? 0} → ${after.claimOwnershipViolationCount ?? 0}`);
  }
  if ((after.factualScore ?? 100) < (before.factualScore ?? 100)) {
    reasons.push(`factual score regressed: ${before.factualScore ?? 100} → ${after.factualScore ?? 100}`);
  }
  if ((after.claimConflictCount ?? 0) > (before.claimConflictCount ?? 0)) {
    reasons.push(`claim conflicts regressed: ${before.claimConflictCount ?? 0} → ${after.claimConflictCount ?? 0}`);
  }
  if ((after.editorialScore ?? 100) < (before.editorialScore ?? 100)) {
    reasons.push(`editorial score regressed: ${before.editorialScore ?? 100} → ${after.editorialScore ?? 100}`);
  }
  if ((after.conclusionNewNumericClaimCount ?? 0) > (before.conclusionNewNumericClaimCount ?? 0)) {
    reasons.push(`new conclusion numbers regressed: ${before.conclusionNewNumericClaimCount ?? 0} → ${after.conclusionNewNumericClaimCount ?? 0}`);
  }
  if ((after.repeatedIdeaPairCount ?? 0) > (before.repeatedIdeaPairCount ?? 0)) {
    reasons.push(`repetition regressed: ${before.repeatedIdeaPairCount ?? 0} → ${after.repeatedIdeaPairCount ?? 0}`);
  }
  if ((after.malformedProseCount ?? 0) > (before.malformedProseCount ?? 0)) {
    reasons.push(`malformed prose regressed: ${before.malformedProseCount ?? 0} → ${after.malformedProseCount ?? 0}`);
  }
  if (before.readableWordCount >= state.wordMin && before.readableWordCount <= state.wordMax) {
    if (after.readableWordCount < state.wordMin || after.readableWordCount > state.wordMax) {
      reasons.push(`word count=${after.readableWordCount} (range: ${state.wordMin}-${state.wordMax})`);
    }
  } else if (before.readableWordCount > state.wordMax && after.readableWordCount > before.readableWordCount) {
    reasons.push(`word count overrun regressed: ${before.readableWordCount} → ${after.readableWordCount}`);
  } else if (before.readableWordCount < state.wordMin && after.readableWordCount < before.readableWordCount) {
    reasons.push(`word count shortfall regressed: ${before.readableWordCount} → ${after.readableWordCount}`);
  }
  return reasons;
}

function runTemporalFreshnessStage(
  state: PipelineState,
  deps: PipelineDependencies,
): PipelineState {
  const inputFingerprint = fp(state.blog);
  const snap = snapshotState(state);
  const trace = state.debugTrace;
  const traceCtx = trace ? traceContextFor(state) : undefined;
  trace?.beginStage("temporal-freshness", snap.articleDoc, traceCtx!);
  const referenceDate = deps.context?.generationDate
    ? new Date(deps.context.generationDate)
    : new Date();
  const initialIssues = findTemporalFreshnessIssues(state.articleDoc, referenceDate);

  if (initialIssues.length === 0) {
    trace?.endStage("temporal-freshness", state.articleDoc, traceCtx!, true, false);
    recordStage(state, "temporal-freshness", inputFingerprint, inputFingerprint, true, undefined, {
      detected: 0,
      rewrittenSentences: 0,
      removedSentences: 0,
    });
    return state;
  }

  const beforeMetrics = temporalMetricsFor(state, state.articleDoc, referenceDate);
  const repair = repairTemporalFreshnessDocument(state.articleDoc, referenceDate);
  state.title = state.articleDoc.metadata.title;
  state.metaDescription = state.articleDoc.metadata.metaDescription;
  state.excerpt = state.articleDoc.metadata.excerpt;
  syncBlogFromDocument(state);
  const afterMetrics = temporalMetricsFor(state, state.articleDoc, referenceDate);
  const reasons = validateTemporalCandidate(state, beforeMetrics, afterMetrics);

  if (repair.unresolved.length > 0) {
    const first = repair.unresolved[0];
    reasons.push(`unresolved ${first.componentId}: ${first.issue.sentence}`);
  }

  if (reasons.length > 0) {
    trace?.endStage("temporal-freshness", state.articleDoc, traceCtx!, false, true);
    restoreSnapshot(state, snap);
    recordStage(state, "temporal-freshness", inputFingerprint, inputFingerprint, false, "pre-stage-restore", {
      detected: initialIssues.length,
      rewrittenSentences: repair.rewrittenSentences,
      removedSentences: repair.removedSentences,
      changedComponentIds: repair.changedComponentIds,
      beforeCanonicalWordCount: beforeMetrics.readableWordCount,
      afterCanonicalWordCount: afterMetrics.readableWordCount,
      reasons,
    });
    throw new Error(
      `Temporal freshness repair was rejected without changing the working article: ${reasons.join("; ")}`,
    );
  }

  trace?.endStage("temporal-freshness", state.articleDoc, traceCtx!, true, false);
  recordStage(state, "temporal-freshness", inputFingerprint, fp(state.blog), true, undefined, {
    detected: initialIssues.length,
    rewrittenSentences: repair.rewrittenSentences,
    removedSentences: repair.removedSentences,
    changedComponentIds: repair.changedComponentIds,
    beforeCanonicalWordCount: beforeMetrics.readableWordCount,
    afterCanonicalWordCount: afterMetrics.readableWordCount,
  });
  console.log(
    `[temporal-freshness] detected=${initialIssues.length}` +
    ` rewritten=${repair.rewrittenSentences}` +
    ` removed=${repair.removedSentences}` +
    ` accepted=true`,
  );
  return state;
}

/**
 * Remove only pure off-topic `Source:` citation paragraphs at the earliest
 * canonical boundary. Running this before expansion means the existing word-
 * count owner can compensate for intentionally removed citation text. The
 * final QC scanner remains a mutation-free backstop for anything introduced
 * later or anything that cannot be removed safely.
 */
export function runSourceRelevanceRepairStage(
  state: PipelineState,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): PipelineState {
  const inputFingerprint = fp(state.blog);
  const preRemovalHtml = state.blog;
  const snap = snapshotState(state);
  const trace = state.debugTrace;
  const traceCtx = trace ? traceContextFor(state) : undefined;
  trace?.beginStage("source-relevance-repair", snap.articleDoc, traceCtx!);
  const stageBaseline = createArticleIntegrityBaseline(preRemovalHtml);
  const initial = assessSourceSectionRelevance(state.articleDoc, research);

  if (initial.length === 0) {
    trace?.endStage("source-relevance-repair", state.articleDoc, traceCtx!, true, false);
    recordStage(state, "source-relevance-repair", inputFingerprint, inputFingerprint, true, undefined, {
      detected: 0,
      removedBlockIds: [],
      removedUrls: [],
      unresolved: 0,
    });
    return state;
  }

  const targets = collectOffTopicSourceCitationBlockIds(state.articleDoc, initial);
  const removedBlockIds = targets.map((target) => target.blockId);
  const removedUrls = targets.map((target) => target.url);
  const removed = removeOffTopicSourceCitations(state.articleDoc, initial);
  if (removed !== targets.length) {
    trace?.endStage("source-relevance-repair", state.articleDoc, traceCtx!, false, true);
    restoreSnapshot(state, snap);
    recordStage(state, "source-relevance-repair", inputFingerprint, inputFingerprint, false, "pre-stage-restore", {
      detected: initial.length,
      targeted: targets.length,
      removed,
      reason: "target-removal-count-mismatch",
    });
    throw new Error(`Source relevance repair removed ${removed} of ${targets.length} selected citation blocks`);
  }

  syncBlogFromDocument(state);
  const candidateBaseline = createIntegrityBaselineAfterLinkRemoval(stageBaseline, removedUrls);
  const guard = guardStageOutput(
    state.blog,
    preRemovalHtml,
    candidateBaseline,
    "source-relevance-repair",
  );
  const remaining = assessSourceSectionRelevance(state.articleDoc, research);
  if (!guard.accepted || remaining.length > 0) {
    trace?.endStage("source-relevance-repair", state.articleDoc, traceCtx!, false, true);
    restoreSnapshot(state, snap);
    recordStage(state, "source-relevance-repair", inputFingerprint, inputFingerprint, false, "pre-stage-restore", {
      detected: initial.length,
      removedBlockIds,
      removedUrls,
      unresolved: remaining.length,
      reason: !guard.accepted ? "integrity-rejection" : "unresolved-source-relevance",
    });
    throw new Error(
      `Source relevance repair failed before expansion: ${!guard.accepted
        ? "candidate integrity rejection"
        : `${remaining.length} unresolved citation(s)`}`,
    );
  }

  trace?.endStage("source-relevance-repair", state.articleDoc, traceCtx!, true, false);
  recordStage(state, "source-relevance-repair", inputFingerprint, fp(state.blog), true, undefined, {
    detected: initial.length,
    removedBlockIds,
    removedUrls,
    unresolved: 0,
  });
  console.log(
    `[source-relevance-repair] beforeFingerprint=${inputFingerprint} afterFingerprint=${fp(state.blog)}`
    + ` removedBlockIds=[${removedBlockIds.join(", ")}]`
    + ` removedUrls=[${removedUrls.join(", ")}] unresolved=0`,
  );
  return state;
}

// ── Post-assembly pipeline ──

export async function runPostAssemblyPipeline(
  state: PipelineState,
  deps: PipelineDependencies,
): Promise<PipelineState> {
  const weakenedComponentIds = new Set<string>();
  assertRenderedCacheMatchesDocument(state);
  console.log(
    `[pipeline] build=${GENERATION_BUILD_ID} assembly words=${countCanonicalVisibleWords(state.articleDoc)}`,
  );
  state.baseline = createArticleIntegrityBaseline(state.blog);
  state.stageOutputs.push({ stage: "assembly", inputFingerprint: fp(state.blog), outputFingerprint: fp(state.blog), accepted: true });

  state = await runClaimCheck(state, deps);
  state = runSourceRelevanceRepairStage(state, deps.context?.research || []);
  if (isEditorialPolishEnabled()) state = runConclusionDiscipline(state);
  state = await runExpansion(state, deps);
  state = await runTrim(state, deps);

  // Paragraph normalization: HTML-returning, must parse back
  state = runTrackedHtmlStage(state, "paragraphs", (html) => {
    return normalizeParagraphs(html, MAX_SENTENCES_PER_PARAGRAPH).html;
  });

  state = await runRegeneration(state, deps);

  state = await runSeoNormalization(state, deps);

  // Title repair: non-HTML mutation (title only)
  // Uses one AI retry maximum, then deterministic fallback.
  // Titles 40–49 characters are accepted with a soft warning (not a 500 error).
  // Deterministic proper-noun casing is always applied so configured proper
  // nouns ("Hong Kong", "HSBC", "AI") and keyphrase casing stay exact — a model
  // or keyphrase prepend can never produce "Hong kong marketing trends 2026".
  state = runTrackedHtmlStage(state, "title-repair", (html) => {
    state.title = normalizeEnglishTitleCasing(state.title, state.keyphrase);
    const titleOk = state.title.length >= 40 && state.title.length <= 70 && containsExactPhrase(state.title, state.keyphrase);
    if (titleOk) return html;

    // One deterministic attempt: prepend keyphrase if missing and within length
    if (!containsExactPhrase(state.title, state.keyphrase)) {
      const titlePhrase = normalizeEnglishTitleCasing(state.keyphrase, state.keyphrase);
      const candidate = `${titlePhrase}: ${state.title}`;
      if (candidate.length >= 40 && candidate.length <= 70) {
        state.title = candidate;
        console.log(`[title-repair] deterministic prepend: "${state.title}"`);
        return html;
      }
      // Try shorter suffix format
      const shortCandidate = `${titlePhrase}: What You Need to Know`;
      if (shortCandidate.length >= 40 && shortCandidate.length <= 70) {
        state.title = shortCandidate;
        console.log(`[title-repair] deterministic suffix: "${state.title}"`);
        return html;
      }
    }

    // Accept 40-49 as soft warning (don't throw, don't loop)
    if (state.title.length >= 40 && state.title.length < 50) {
      console.log(`[title-repair] soft-warning: title length ${state.title.length} accepted`);
      return html;
    }

    console.log(`[title-repair] no fix applied — title="${state.title}" len=${state.title.length}`);
    return html;
  });

  // The final paragraph normalization runs after factual cleanup and claim
  // ownership repair, immediately before the structured editorial transaction.

  // Factual-risk scan and repair: HTML-returning
  state = runTrackedHtmlStage(state, "factual-scan", (html) => {
    const snap = snapshotState(state);
    const research = deps.context?.research || [];
    const editableComponents: Array<{
      label: string;
      component: ArticleDocument["introduction"];
    }> = [
      { label: "introduction", component: state.articleDoc.introduction },
      ...state.articleDoc.sections
        .filter(
          (section) =>
            section.sectionType !== "faq-heading"
            && section.sectionType !== "conclusion-heading"
            && section.status !== "missing",
        )
        .map((section) => ({ label: section.id, component: section })),
      { label: "conclusion", component: state.articleDoc.conclusion },
    ];

    let repaired = false;
    for (const { label, component } of editableComponents) {
      const componentHtmlBefore = componentHtml(component);
      const risk = scanFactualRisks(componentHtmlBefore, state.keyphrase, research);
      console.log(`[factual-scan:${label}] ${formatClaimLog(risk.claims)}`);
      if (!risk.hasHighRisk) continue;

      const unsupported = risk.claims.filter((claim) => !claim.supported);
      // Section topic grounding is a hard invariant: a claim removal must
      // never delete the section's LAST sentence carrying a heading content
      // word (that would silently unground the section and fail final QC).
      // When a single paragraph is the section's only grounding carrier, its
      // sentences are preserved so other unsupported claims are still removed
      // — the producer chooses another safe removal instead of destroying the
      // section's grounded substance. Only main sections carry a heading;
      // intro and conclusion have no grounding requirement.
      const groundingCarriers = "sectionType" in component && component.sectionType === "main"
        ? essentialGroundingCarrierSentenceTexts(component as ArticleSection)
        : [];
      const cleanup = removeUnsupportedSentences(
        componentHtmlBefore,
        unsupported,
        groundingCarriers.length > 0
          ? { preserveSentenceTexts: groundingCarriers }
          : undefined,
      );
      const cleanupWouldEmpty = cleanup.sentencesRemoved > 0 && !cleanup.html.trim();
      if (cleanupWouldEmpty) {
        state.warnings.push(
          `Factual repair could not empty ${label}; final validation will reject the unresolved claim`,
        );
      } else if (cleanup.sentencesRemoved > 0) {
        replaceComponentHtml(component, cleanup.html, "normalized");
        weakenedComponentIds.add(component.id);
        repaired = true;
        console.log(
          `[factual-scan:${label}] removed ${cleanup.sentencesRemoved} complete unsupported sentence/list item/row(s)` +
          (cleanup.orphanedTransitionsRemoved > 0
            ? ` and ${cleanup.orphanedTransitionsRemoved} orphaned transition(s)`
            : ""),
        );
      }
      const factualCandidateHtml = cleanupWouldEmpty ? componentHtmlBefore : cleanup.html;
      const remaining = scanFactualRisks(
        factualCandidateHtml,
        state.keyphrase,
        research,
      ).claims.filter((claim) => !claim.supported);
      if (remaining.length > 0) {
        state.warnings.push(
          `Unresolved factual claim in ${label}: ${remaining[0].text}`,
        );
      }
    }
    const faqCleanup = sanitizeFaqFactualClaims(
      state.articleDoc.visibleFaq,
      state.keyphrase,
      research,
      {
        keyphrase: state.keyphrase,
        title: state.articleDoc.metadata.title,
        metaDescription: state.articleDoc.metadata.metaDescription,
        headings: state.articleDoc.sections.map((section) => section.heading),
      },
    );
    state.articleDoc.visibleFaq = faqCleanup.entries;
    if (faqCleanup.unsupportedSentencesRemoved > 0 || faqCleanup.citationsAdded > 0) {
      repaired = true;
      if (state.articleDoc.visibleFaq.length > 0) {
        const schemaHtml = renderFaqSchema(state.articleDoc.visibleFaq);
        state.articleDoc.faqSchema = {
          id: "faq-schema",
          type: "faq-schema",
          html: schemaHtml,
          fingerprint: fingerprintHtml(schemaHtml),
        };
      }
      console.log(
        `[factual-scan:faq] removed ${faqCleanup.unsupportedSentencesRemoved} precise factual sentence(s)`,
      );
    }
    if (repaired) syncBlogFromDocument(state);
    // Stage-aware integrity contract: factual removal owns the factual claims
    // it removes, the word count and the FAQ entries it corrects; everything
    // else — malformed prose, sentence quality, links, WordPress structure,
    // FAQ parity, protected content outside the FAQ — must be untouched, or
    // the exact snapshot is restored and the pipeline fails closed here. A
    // sentence removal that would leave an incomplete remainder is therefore
    // rejected at ITS owner, never carried to malformed-prose-repair.
    //
    // A removed sentence may legitimately contain the focus keyphrase; that
    // derived occurrence decrease is mechanically attributable to the removal
    // and is restored downstream by post-ownership-seo-reconcile. Direct SEO
    // mutation (insertion, rewrite, heading edit) still fails closed.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["factual", "word-count", "protected-content"]),
      "factual-scan",
      { allowRemovalAttributedSeoDrift: true },
    );
    return state.blog;
  });

  // Approved evidence is now assigned to one authoritative section. This
  // deterministic stage removes every supported occurrence outside its owner
  // and keeps only the strongest occurrence inside the owner. It runs before
  // links so sentence removal is never blocked by a newly injected anchor.
  //
  // Enforcement and the final gate share one authoritative scanner, one text
  // normalisation and one location model over the canonical ArticleDocument.
  // Immediately after enforcement the stage re-renders from the canonical
  // document, rescans the rendered canonical state and performs one bounded
  // targeted second pass. Unresolved violations are never converted into
  // warnings: the stage fails, which blocks saving and publishing.
  state = runTrackedHtmlStage(state, "claim-ownership", () => {
    const research = deps.context?.research || [];
    const ledger = deps.context?.claimOwnership;
    const snap = snapshotState(state);
    if (!ledger || ledger.entries.length === 0) return state.blog;
    const verified = enforceOwnershipAndVerify(
      state.articleDoc,
      ledger,
      state.keyphrase,
      research,
    );
    for (const componentId of verified.repair.changedComponentIds) weakenedComponentIds.add(componentId);
    if (verified.secondPassRepair) {
      for (const componentId of verified.secondPassRepair.changedComponentIds) {
        weakenedComponentIds.add(componentId);
      }
    }
    if (verified.violations.length > 0) {
      console.error(
        `[claim-ownership] ${verified.violations.length} unresolved violation(s) after enforcement:\n` +
        formatOwnershipViolationDetails(verified.violations, ledger).join("\n"),
      );
      throw new Error(
        `Claim ownership violations remain after enforcement: ${verified.violations.length}` +
        ` (first=${verified.violations[0].evidenceId} in ${verified.violations[0].componentId} reason=${verified.violations[0].reason})`,
      );
    }
    state.articleDoc = verified.doc;
    syncBlogFromDocument(state);
    // Stage-aware integrity contract: ownership enforcement owns factual and
    // ownership changes, the canonical visible-FAQ entries it corrects, and
    // the word count; everything else — FAQ parity (the corrected answers
    // must still match the rendered block and the schema), links, WordPress
    // structure — must be untouched, or the exact snapshot is restored and
    // the pipeline fails closed here.
    //
    // A removed outside-owner occurrence may legally contain the focus
    // keyphrase; that derived occurrence decrease is mechanically attributable
    // to the ownership removal and is restored downstream by
    // post-ownership-seo-reconcile. Direct SEO mutation still fails closed.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["factual", "ownership", "word-count", "protected-content"]),
      "claim-ownership",
      { allowRemovalAttributedSeoDrift: true },
    );
    console.log(
      `[claim-ownership] removed=${verified.repair.removedSentences}` +
      ` outside-owner=${verified.repair.removedOutOfOwnerOccurrences}` +
      ` duplicate-owned=${verified.repair.removedDuplicateOccurrences}` +
      ` faq-removed=${verified.repair.removedFaqSentences}` +
      ` verified=${verified.violations.length}` +
      (verified.secondPassRepair ? ` second-pass=${verified.secondPassRepair.removedSentences}` : ""),
    );
    return state.blog;
  });

  // Temporal repair is guarded comparatively. It may rewrite only the stale
  // clause (or remove a complete stale sentence when another sentence remains),
  // and it is accepted only when factual reliability, ownership, conclusion
  // numbers, repetition, malformed prose and word count do not regress.
  state = runTemporalFreshnessStage(state, deps);

  // Opening/H2 keyphrase placement is a soft SEO signal. Do not mutate
  // approved prose after factual repair merely to force an exact phrase.
  state = runTrackedHtmlStage(state, "post-factual-keyphrase", (html) => html);

  // Paragraph normalization immediately precedes editorial polish so the AI
  // receives the final paragraph boundaries it is allowed to edit.
  state = runTrackedHtmlStage(state, "paragraphs-final", (html) => {
    const result = normalizeParagraphs(html, MAX_SENTENCES_PER_PARAGRAPH);
    return result.html;
  });

  const editorialResearch = deps.context?.research || [];
  const protectedSentencesByBlockId = Object.fromEntries(
    extractEditableBlocks(state.articleDoc).map((block) => {
      const sentences = scanFactualRisks(block.html, state.keyphrase, editorialResearch).claims
        .filter((claim) => claim.supported && claim.sentenceText)
        .map((claim) => claim.sentenceText!.replace(/\s+/g, " ").trim())
        .filter((sentence, index, all) => sentence.length > 0 && all.indexOf(sentence) === index);
      return [block.blockId, sentences];
    }),
  );

  // Factual and ownership sentence removal can expose a dangling connector or
  // incomplete fragment. Repair those deterministic cases before any broad
  // editor sees the article, using stable block IDs rather than text ordinals.
  // Explicit unresolved-output policy: a stage responsible for deterministic
  // malformed-prose repair must (1) repair deterministically when safe,
  // (2) remove an invalid whole block when safe and meaning-preserving
  // (bounded removal is enabled here), (3) classify what remains, and (4) fail
  // at this repair boundary for genuine publication-breaking corruption rather
  // than carrying known defects through the rest of the pipeline. Scanner
  // false positives cannot block publication because the false-positive-prone
  // patterns are eliminated at the scanner level (classifyMalformedIssue).
  {
    const inputFingerprint = fp(state.blog);
    const snap = snapshotState(state);
    const trace = state.debugTrace;
    const traceCtx = trace ? traceContextFor(state) : undefined;
    trace?.beginStage("malformed-prose-repair", snap.articleDoc, traceCtx!);
    const deterministic = repairDeterministicMalformedProse(
      state.articleDoc,
      state.wordMin,
      protectedSentencesByBlockId,
      true,
      state.keyphrase,
    );
    syncBlogFromDocument(state);
    // Boundary policy: scan the FULL document (all block types, matching the
    // final gate) after the repair. Genuine publication-breaking corruption
    // that could not be repaired or safely removed fails HERE; the stage must
    // never carry known corruption downstream. The sentence-quality scanner
    // (the same authoritative scanner final QC uses) is an absolute hard gate
    // here too: duplicated determiners, malformed noun phrases, repeated
    // adjacent words, broken punctuation and fragments are never carried past
    // this repair boundary.
    const remainingMalformed = scanMalformedProseInDocument(state.articleDoc);
    const hardUnresolved = remainingMalformed.filter((finding) =>
      finding.issues.some((issue) => classifyMalformedIssue(issue.code) === "hard"),
    );
    const remainingSentenceQuality = scanSentenceQualityInDocument(state.articleDoc);
    const sentenceQualityUnresolved = remainingSentenceQuality.length;
    const candidateFingerprint = fp(state.blog);
    const stageMetadata = {
      repairedBlockIds: deterministic.repairedBlockIds,
      removedBlockIds: deterministic.removedBlockIds,
      unresolvedEditableBlockIds: deterministic.unresolved.map((issue) => issue.blockId),
      unresolvedDocumentBlockIds: hardUnresolved.map((issue) => issue.blockId),
      unresolvedSentenceQualityBlockIds: remainingSentenceQuality.map((issue) => issue.blockId),
      candidateFingerprint,
    };
    console.log(
      `[malformed-prose-repair] deterministic repaired=${deterministic.repairedBlockIds.length}` +
      ` removed=${deterministic.removedBlockIds.length}` +
      ` unresolvedEditable=${deterministic.unresolved.length}` +
      ` unresolvedDocument=${hardUnresolved.length}` +
      ` unresolvedSentenceQuality=${sentenceQualityUnresolved}`,
    );
    if (hardUnresolved.length > 0 || sentenceQualityUnresolved > 0) {
      // Rejected repair restores the exact pre-stage canonical snapshot, then
      // the pipeline fails closed (zero writes) at this repair boundary.
      trace?.endStage("malformed-prose-repair", state.articleDoc, traceCtx!, false, true);
      restoreSnapshot(state, snap);
      recordStage(
        state,
        "malformed-prose-repair",
        inputFingerprint,
        fp(state.blog),
        false,
        "pre-stage-restore",
        stageMetadata,
      );
      throw new Error(
        `Unresolved malformed prose at repair boundary (${hardUnresolved.length}): ` +
        hardUnresolved
          .map((finding) =>
            `${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}] component=${finding.componentId}`,
          )
          .join("; ")
        + (sentenceQualityUnresolved > 0
          ? ` | unresolved sentence-quality (${sentenceQualityUnresolved}): ` +
            remainingSentenceQuality
              .map((finding) =>
                `${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}] component=${finding.componentId}`,
              )
              .join("; ")
          : ""),
      );
    }
    // Stage-aware integrity contract: the repair owns malformed/sentence
    // quality, the word count and coherence changes it makes; it must never
    // damage links, facts, FAQ parity, protected content or structure. Its
    // bounded whole-block removal may remove a block that contained the focus
    // keyphrase; that derived occurrence decrease is mechanically attributable
    // to the removal and is restored downstream by post-ownership-seo-reconcile.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["malformed", "sentence-quality", "word-count", "coherence"]),
      "malformed-prose-repair",
      { allowRemovalAttributedSeoDrift: true },
    );
    recordStage(
      state,
      "malformed-prose-repair",
      inputFingerprint,
      candidateFingerprint,
      true,
      undefined,
      stageMetadata,
    );
    trace?.endStage("malformed-prose-repair", state.articleDoc, traceCtx!, true, false);
  }

  // Editorial polish: improves coherence, flow and natural language without
  // damaging structure, evidence, SEO, FAQ, CTA or schema. It runs before
  // application-owned link insertion so exact factual sentences remain safely
  // removable during the deterministic evidence stages.
  // validation decides whether the cloned candidate is committed atomically.
  const preEditorialHtml = state.blog;
  const preEditorialDoc = structuredClone(state.articleDoc);
  const preEditorialMetrics = analyzeFinalArticle(
    preEditorialHtml,
    state.keyphrase,
    state.title,
    state.metaDescription,
    state.requestedWordCount,
    countCanonicalVisibleWords(state.articleDoc),
  );
  const rejectedEditorialCandidates: Array<{
    stage: string;
    accepted: boolean;
    reason: string;
    score: number;
  }> = [];
  const recordEditorialCandidate = (
    stage: string,
    result: Awaited<ReturnType<typeof runEditorialPolish>> | null,
  ): void => {
    if (!result) return;
    const score = analyzeFinalArticle(
      renderArticleDocument(result.doc),
      state.keyphrase,
      state.title,
      state.metaDescription,
      state.requestedWordCount,
      countCanonicalVisibleWords(result.doc),
    ).editorialScore ?? 100;
    rejectedEditorialCandidates.push({
      stage,
      accepted: result.result.accepted,
      reason: result.result.reason,
      score,
    });
  };
  if (isEditorialPolishEnabled()) {
    const inputFingerprint = fp(state.blog);
    const trace = state.debugTrace;
    const traceCtx = trace ? traceContextFor(state) : undefined;
    trace?.beginStage("editorial-polish", JSON.stringify(preEditorialDoc), traceCtx!);
    const editorCtx = { chatWithRetry: deps.chatWithRetry };
    const research = editorialResearch;
    // Dedicated source-list blocks remain application-owned. Evidence-bearing
    // prose is editable because parseReplacement() locks only its exact factual
    // sentences, numbers, attributions and hrefs.
    const protectedBlockIds = extractEditableBlocks(state.articleDoc)
      .filter((block) =>
        /^\s*<!--\s*wp:paragraph\s*-->\s*<p\b[^>]*>\s*Sources?:/i.test(block.html),
      )
      .map((block) => block.blockId);

    const buildComparativeValidator = (
      baselineDoc: ArticleDocument,
      mode: EditorialPolishMode = "general",
    ) => {
      const baselineHtml = renderArticleDocument(baselineDoc);
      const baselineMetrics = analyzeFinalArticle(
        baselineHtml,
        state.keyphrase,
        state.title,
        state.metaDescription,
        state.requestedWordCount,
        countCanonicalVisibleWords(baselineDoc),
      );
      const existingUnsupported = new Set(
        scanFactualRisks(baselineHtml, state.keyphrase, research).claims
          .filter((claim) => !claim.supported)
          .map((claim) => claim.text.replace(/\s+/g, " ").trim().toLowerCase()),
      );
      return (candidate: ArticleDocument) => {
        let candidateHtml = renderArticleDocument(candidate);
        const metrics = analyzeFinalArticle(
          candidateHtml,
          state.keyphrase,
          state.title,
          state.metaDescription,
          state.requestedWordCount,
          countCanonicalVisibleWords(candidate),
        );
        const evaluated = evaluateEditorialStageCandidate(metrics, state.policy);
        // Editorial score and repetition are comparative acceptance criteria at
        // this stage. The strict thresholds remain owned by final validation.
        let hardReasons = evaluated.reasons.filter(
          (reason) => !reason.startsWith("repeated idea pairs=") && !reason.startsWith("editorial score="),
        );
        // Word-count overrun is the one hard rejection that can be fixed
        // deterministically without altering editorial quality.  If it is the
        // ONLY hard reason, run the bounded safe-trim logic on the candidate
        // before giving up.
        if (hardReasons.length === 1 && hardReasons[0].startsWith("word count=")) {
          const excess = metrics.readableWordCount - state.policy.wordCountMax;
          if (excess > 0) {
            const trimmedDoc = structuredClone(candidate);
            const residual = trimResidualSafeProseToMaximum(
              trimmedDoc, state.policy.wordCountMax, state.policy.wordCountMin,
              state.keyphrase, deps.context?.research || [],
            );
            if (residual.removedWords > 0) {
              const trimmedMetrics = analyzeFinalArticle(
                renderArticleDocument(trimmedDoc),
                state.keyphrase, state.title, state.metaDescription,
                state.requestedWordCount, countCanonicalVisibleWords(trimmedDoc),
              );
              const trimmedEval = evaluateEditorialStageCandidate(trimmedMetrics, state.policy);
              const trimmedHard = trimmedEval.reasons.filter(
                (r) => !r.startsWith("repeated idea pairs=") && !r.startsWith("editorial score="),
              );
              if (trimmedHard.length === 0) {
                // Commit and validate the same trimmed document. Mutating only
                // the metrics would approve one candidate and save another.
                replaceArticleDocumentInPlace(candidate, trimmedDoc);
                candidateHtml = renderArticleDocument(candidate);
                Object.assign(metrics, trimmedMetrics);
                hardReasons = [];
                console.log(
                  `[editorial-wc-trim] trimmed candidate ${residual.removedWords} words → ` +
                  `${trimmedMetrics.readableWordCount} (max ${state.policy.wordCountMax})`,
                );
              }
            }
          }
        }
        const comparativeReasons: string[] = [];
        const baselineRepeats = baselineMetrics.repeatedIdeaPairCount ?? 0;
        const candidateRepeats = metrics.repeatedIdeaPairCount ?? 0;
        if (candidateRepeats > baselineRepeats) {
          comparativeReasons.push(`repetition regressed: ${baselineRepeats} → ${candidateRepeats}`);
        } else if (
          mode !== "malformed"
          && mode !== "weakened"
          && baselineRepeats > state.policy.maxRepeatedIdeaPairs
          && candidateRepeats >= baselineRepeats
        ) {
          comparativeReasons.push(`repetition did not improve: ${baselineRepeats} → ${candidateRepeats}`);
        }
        const baselineScore = baselineMetrics.editorialScore ?? 100;
        const candidateScore = metrics.editorialScore ?? 100;
        if (candidateScore < baselineScore) {
          comparativeReasons.push(`editorial score regressed: ${baselineScore} → ${candidateScore}`);
        } else if (baselineScore < state.policy.minimumEditorialScore && candidateScore <= baselineScore) {
          comparativeReasons.push(`editorial score did not improve: ${baselineScore} → ${candidateScore}`);
        }
        if (
          mode === "prose-only"
          && baselineScore < state.policy.minimumEditorialScore
          && candidateScore < state.policy.minimumEditorialScore
        ) {
          comparativeReasons.push(
            `editorial score remains below minimum: ${candidateScore} < ${state.policy.minimumEditorialScore}`,
          );
        }
        const newUnsupported = scanFactualRisks(
          candidateHtml,
          state.keyphrase,
          research,
        ).claims.filter(
          (claim) =>
            !claim.supported
            && !existingUnsupported.has(
              claim.text.replace(/\s+/g, " ").trim().toLowerCase(),
            ),
        );
        const ownershipViolations = deps.context?.claimOwnership
          ? validateClaimOwnership(
              candidate,
              deps.context.claimOwnership,
              state.keyphrase,
              research,
            )
          : [];
        const reasons = [
          ...hardReasons,
          ...comparativeReasons,
          ...newUnsupported.map(
            (claim) => `new unsupported ${claim.category}: ${claim.text}`,
          ),
          ...ownershipViolations.map(
            (violation) => `claim ownership changed: ${violation.evidenceId} in ${violation.componentId}`,
          ),
        ];
        return reasons.length === 0
          ? { passed: true, reasons: [] }
          : { passed: false, reasons };
      };
    };

    // Malformed prose has first editorial ownership. Factual and ownership
    // cleanup may expose a broken fragment, so repair those exact stable block
    // IDs before asking the repetition or general editor to touch the article.
    let workingDoc = state.articleDoc;
    let malformedResult: Awaited<ReturnType<typeof runEditorialPolish>> | null = null;
    let malformedFallback: ReturnType<typeof repairDeterministicMalformedProse> | null = null;
    let malformedFallbackApplied = false;
    let weakenedResult: Awaited<ReturnType<typeof runEditorialPolish>> | null = null;
    let repetitionResult: Awaited<ReturnType<typeof runEditorialPolish>> | null = null;
    let generalResult: Awaited<ReturnType<typeof runEditorialPolish>> | null = null;
    let proseOnlyResult: Awaited<ReturnType<typeof runEditorialPolish>> | null = null;
    // Successful targeted repairs (malformed, weakened, repetition) are
    // correctness fixes applied to specific stable block IDs. They must persist
    // to the canonical document even when the score-gated general polish is
    // rejected, so a later restore or fallback can never resurrect the repaired
    // fragment. The general/prose-only polish remains atomic on the 80 minimum.
    let targetedRepairsDoc: ArticleDocument | null = null;
    const malformedBlocks = findMalformedEditableBlocks(workingDoc)
      .filter((block) => !protectedBlockIds.includes(block.blockId));
    if (malformedBlocks.length > 0) {
      const malformedIssuesByBlockId = Object.fromEntries(
        malformedBlocks.map((block) => [block.blockId, block.issues]),
      );
      malformedResult = await runEditorialPolish(
        workingDoc,
        state.keyphrase,
        async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-malformed-repair"),
        {
          protectedBlockIds,
          editableBlockIds: malformedBlocks.map((block) => block.blockId),
          protectedSentencesByBlockId,
          malformedIssuesByBlockId,
          mode: "malformed",
          validateProductionCandidate: buildComparativeValidator(workingDoc, "malformed"),
        },
      );
      if (malformedResult.result.accepted) {
        workingDoc = malformedResult.doc;
        targetedRepairsDoc = workingDoc;
      } else {
        const fallbackDoc = structuredClone(workingDoc);
        malformedFallback = repairDeterministicMalformedProse(
          fallbackDoc,
          state.wordMin,
          protectedSentencesByBlockId,
          true,
          state.keyphrase,
        );
        const fallbackChanged = malformedFallback.repairedBlockIds.length > 0
          || malformedFallback.removedBlockIds.length > 0;
        if (fallbackChanged && malformedFallback.unresolved.length === 0) {
          const fallbackValidation = buildComparativeValidator(workingDoc, "malformed")(fallbackDoc);
          if (fallbackValidation.passed) {
            workingDoc = fallbackDoc;
            malformedFallbackApplied = true;
            targetedRepairsDoc = workingDoc;
            console.log(
              `[editorial-malformed-repair] deterministic fallback repaired=${malformedFallback.repairedBlockIds.length}` +
              ` removed=${malformedFallback.removedBlockIds.length}`,
            );
          }
        }
      }
    }

    // Sentence cleanup can leave a component technically valid but editorially
    // thin or abrupt. Only fact-free blocks inside components that actually
    // lost content are exposed to this continuity repair.
    const weakenedBlockIds = findWeakenedEditableBlockIds(
      workingDoc,
      weakenedComponentIds,
      state.keyphrase,
      research,
      protectedSentencesByBlockId,
    ).filter((blockId) => !protectedBlockIds.includes(blockId));
    if (weakenedBlockIds.length > 0) {
      weakenedResult = await runEditorialPolish(
        workingDoc,
        state.keyphrase,
        async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-post-cleanup-repair"),
        {
          protectedBlockIds,
          editableBlockIds: weakenedBlockIds,
          protectedSentencesByBlockId,
          mode: "weakened",
          maxAttempts: 1,
          validateProductionCandidate: buildComparativeValidator(workingDoc, "weakened"),
        },
      );
      if (weakenedResult.result.accepted) {
        workingDoc = weakenedResult.doc;
        targetedRepairsDoc = workingDoc;
      }
    }

    // Last-resort malformed resolution: one unresolved fragment (common after
    // factual-scan sentence removal) must not permanently block repetition
    // repair.  Run the deterministic repair again with block removal enabled
    // on the exact remaining blocks, then re-scan.  Fail closed only if the
    // block cannot be safely repaired or removed.
    const lingeringMalformed = findMalformedEditableBlocks(workingDoc)
      .filter((block) => !protectedBlockIds.includes(block.blockId));
    if (lingeringMalformed.length > 0) {
      console.log(
        `[editorial-malformed-last-resort] unresolved=${lingeringMalformed.length}` +
        ` blocks=${lingeringMalformed.map((b) => b.blockId).join(",")}`,
      );
      const docClone = structuredClone(workingDoc);
      const lastResort = repairDeterministicMalformedProse(
        docClone, state.wordMin, protectedSentencesByBlockId, true, state.keyphrase,
      );
      const resolved = lastResort.repairedBlockIds.length + lastResort.removedBlockIds.length;
      if (resolved > 0 && lastResort.unresolved.length === 0) {
        const lrValidation = buildComparativeValidator(workingDoc, "malformed")(docClone);
        if (lrValidation.passed) {
          workingDoc = docClone;
          targetedRepairsDoc = workingDoc;
          console.log(
            `[editorial-malformed-last-resort] resolved repaired=${lastResort.repairedBlockIds.length}` +
            ` removed=${lastResort.removedBlockIds.length}`,
          );
        } else {
          console.log(
            `[editorial-malformed-last-resort] rejected: ${lrValidation.reasons.join("; ")}`,
          );
        }
      } else {
        console.log(
          `[editorial-malformed-last-resort] still-unresolved=${lastResort.unresolved.length}` +
          ` repaired=${lastResort.repairedBlockIds.length} removed=${lastResort.removedBlockIds.length}`,
        );
      }
    }

    // Repetition repair runs only after malformed prose is clean. Otherwise its
    // candidate would be rejected for an unrelated pre-existing fragment.
    const unresolvedMalformed = findMalformedEditableBlocks(workingDoc);
    const repetitionTargets = unresolvedMalformed.length === 0
      ? findRepetitionPairTargets(workingDoc)
          .filter((target) => !protectedBlockIds.includes(target.blockId))
      : [];
    if (repetitionTargets.length > 0) {
      // Exact repetition diagnostics: stable IDs, overlap, protected-surface
      // flags and the first 180 characters of each paragraph.
      for (const target of repetitionTargets) {
        const aFlags = repetitionPairSurfaceFlags(
          workingDoc,
          {
            componentKind: target.preserveComponentKind,
            componentId: target.preserveComponentId,
            blockId: target.preserveBlockId,
            text: target.preserveText,
          },
          state.keyphrase,
        );
        const bFlags = repetitionPairSurfaceFlags(
          workingDoc,
          {
            componentKind: target.componentKind,
            componentId: target.componentId,
            blockId: target.blockId,
            text: target.text,
          },
          state.keyphrase,
        );
        console.log(
          `[editorial-repetition-pair] pair=1` +
          ` a=${target.preserveComponentKind}:${target.preserveComponentId}:${target.preserveBlockId}` +
          ` b=${target.componentKind}:${target.componentId}:${target.blockId}` +
          ` overlap=${target.overlap.toFixed(2)}` +
          ` aKeyphrase=${aFlags.keyphrase} bKeyphrase=${bFlags.keyphrase}` +
          ` aNumbers=${aFlags.numbers.join(",")} bNumbers=${bFlags.numbers.join(",")}` +
          ` aLinks=${aFlags.linkCount} bLinks=${bFlags.linkCount}` +
          ` aQuotes=${aFlags.quoteCount} bQuotes=${bFlags.quoteCount}` +
          ` aText="${target.preserveText.slice(0, 180)}"` +
          ` bText="${target.text.slice(0, 180)}"`,
        );
      }
      const repetitionScoreBefore = analyzeFinalArticle(
        renderArticleDocument(workingDoc),
        state.keyphrase,
        state.title,
        state.metaDescription,
        state.requestedWordCount,
        countCanonicalVisibleWords(workingDoc),
      ).editorialScore ?? 100;
      repetitionResult = await runEditorialPolish(
        workingDoc,
        state.keyphrase,
        async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-repetition-repair"),
        {
          protectedBlockIds,
          editableBlockIds: repetitionTargets.map((target) => target.blockId),
          protectedSentencesByBlockId,
          repetitionTargets,
          mode: "repetition",
          validateProductionCandidate: buildComparativeValidator(workingDoc, "repetition"),
        },
      );
      if (repetitionResult.result.accepted) {
        workingDoc = repetitionResult.doc;
        targetedRepairsDoc = workingDoc;
        console.log(
          `[editorial-repetition-repair] accepted score=${repetitionScoreBefore} → ` +
          `${(analyzeFinalArticle(renderArticleDocument(workingDoc), state.keyphrase, state.title, state.metaDescription, state.requestedWordCount, countCanonicalVisibleWords(workingDoc)).editorialScore ?? 100)}`,
        );
      } else {
        // Bounded deterministic fallback: both AI attempts failed to reduce the
        // same pairs. Sentence-level dedup against each preserved partner keeps
        // every number, link, quote, attribution, protected sentence and exact
        // keyphrase occurrence, and removes only provably duplicated plain
        // prose. It never invents filler.
        const fallback = applyDeterministicRepetitionFallback(workingDoc, repetitionTargets, {
          minimumWordCount: state.wordMin,
          keyphrase: state.keyphrase,
          protectedSentencesByBlockId,
        });
        for (const item of fallback.applied) {
          console.log(
            `[editorial-repetition-fallback] ${item.action} ${item.blockId}` +
            ` before="${item.before.slice(0, 120)}" after="${item.after.slice(0, 120)}"`,
          );
        }
        for (const item of fallback.skipped) {
          console.log(`[editorial-repetition-fallback] skipped ${item.blockId}: ${item.reason}`);
        }
        if (fallback.applied.length > 0) {
          const fallbackValidation = buildComparativeValidator(workingDoc, "repetition")(fallback.doc);
          if (fallbackValidation.passed) {
            workingDoc = fallback.doc;
            targetedRepairsDoc = workingDoc;
            console.log(
              `[editorial-repetition-fallback] committed applied=${fallback.applied.length}` +
              ` score=${repetitionScoreBefore} → ` +
              `${(analyzeFinalArticle(renderArticleDocument(workingDoc), state.keyphrase, state.title, state.metaDescription, state.requestedWordCount, countCanonicalVisibleWords(workingDoc)).editorialScore ?? 100)}`,
            );
          } else {
            console.log(
              `[editorial-repetition-fallback] rejected: ${fallbackValidation.reasons.join("; ")}`,
            );
          }
        }
      }
    }

    // The broad/general editor has exactly one owner.  When the complete-
    // document layer is enabled it owns broad rewriting later, after links and
    // protected application blocks exist.  Earlier targeted correctness
    // repairs remain active here.
    if (!isFullDocumentEditorialEnabled()) {
      generalResult = await runEditorialPolish(
        workingDoc,
        state.keyphrase,
        async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-polish"),
        {
          protectedBlockIds,
          protectedSentencesByBlockId,
          validateProductionCandidate: buildComparativeValidator(workingDoc, "general"),
        },
      );
      if (generalResult.result.accepted) workingDoc = generalResult.doc;
    }

    // If the broad editor is rejected for touching a protected number or if an
    // accepted broad candidate still remains below the editorial threshold,
    // make one final attempt using only deterministically fact-free blocks.
    const postGeneralMetrics = analyzeFinalArticle(
      renderArticleDocument(workingDoc),
      state.keyphrase,
      state.title,
      state.metaDescription,
      state.requestedWordCount,
      countCanonicalVisibleWords(workingDoc),
    );
    const postGeneralEditorialScore = postGeneralMetrics.editorialScore ?? 100;
    const proseOnlyBlockIds = !isFullDocumentEditorialEnabled()
      && postGeneralEditorialScore < state.policy.minimumEditorialScore
      ? findProseOnlyEditableBlockIds(
          workingDoc,
          state.keyphrase,
          research,
          protectedSentencesByBlockId,
        ).filter((blockId) => !protectedBlockIds.includes(blockId))
      : [];
    if (proseOnlyBlockIds.length > 0) {
      proseOnlyResult = await runEditorialPolish(
        workingDoc,
        state.keyphrase,
        async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-prose-only-fallback"),
        {
          protectedBlockIds,
          editableBlockIds: proseOnlyBlockIds,
          protectedSentencesByBlockId,
          mode: "prose-only",
          validateProductionCandidate: buildComparativeValidator(workingDoc, "prose-only"),
        },
      );
      if (proseOnlyResult.result.accepted) workingDoc = proseOnlyResult.doc;
    }

    const anyEditorialCandidateAccepted = malformedResult?.result.accepted === true
      || malformedFallbackApplied
      || weakenedResult?.result.accepted === true
      || repetitionResult?.result.accepted === true
      || generalResult?.result.accepted === true
      || proseOnlyResult?.result.accepted === true;
    const finalEditorialMetrics = analyzeFinalArticle(
      renderArticleDocument(workingDoc),
      state.keyphrase,
      state.title,
      state.metaDescription,
      state.requestedWordCount,
      countCanonicalVisibleWords(workingDoc),
    );
    const finalEditorialScore = finalEditorialMetrics.editorialScore ?? 100;
    recordEditorialCandidate("malformed", malformedResult);
    recordEditorialCandidate("weakened", weakenedResult);
    recordEditorialCandidate("repetition", repetitionResult);
    recordEditorialCandidate("general", generalResult);
    recordEditorialCandidate("prose-only", proseOnlyResult);
    const editorialScoreBreakdown = {
      malformedProseCount: finalEditorialMetrics.malformedProseCount ?? 0,
      repeatedIdeaPairCount: finalEditorialMetrics.repeatedIdeaPairCount ?? 0,
      roboticPhraseCount: finalEditorialMetrics.roboticPhraseCount ?? 0,
      conclusionWordRatio: finalEditorialMetrics.conclusionWordRatio ?? 0,
      conclusionPenalty: (finalEditorialMetrics.conclusionWordRatio ?? 0) > 0.18
        ? 35
        : (finalEditorialMetrics.conclusionWordRatio ?? 0) > 0.15
          ? 15
          : 0,
    };
    // The general polish transaction is atomic: incremental general/prose-only
    // edits are not committed when the article still misses the production
    // threshold. Successfully repaired stable block IDs (malformed, weakened,
    // repetition) are still persisted so final validation never sees a
    // fragment that a targeted repair already fixed.
    const accepted = anyEditorialCandidateAccepted
      && finalEditorialScore >= state.policy.minimumEditorialScore;
    const commitDecision = chooseEditorialCommitDoc({
      baselineDoc: preEditorialDoc,
      workingDoc,
      targetedRepairsDoc,
      accepted,
    });
    const targetedRepairsPersisted = commitDecision.targetedRepairsPersisted;
    state.articleDoc = commitDecision.doc;
    syncBlogFromDocument(state);
    assertRenderedCacheMatchesDocument(state);
    if (accepted) {
      console.log(
        `[editorial-polish] accepted: malformed=${malformedResult?.result.accepted === true}` +
        ` malformedFallback=${malformedFallbackApplied}` +
        ` weakened=${weakenedResult?.result.accepted === true}` +
        ` repetition=${repetitionResult?.result.accepted === true}` +
        ` general=${generalResult?.result.accepted === true}` +
        ` proseOnly=${proseOnlyResult?.result.accepted === true}` +
        ` score=${finalEditorialScore}` +
        ` malformedRemaining=${findMalformedEditableBlocks(state.articleDoc).length}` +
        ` repeatedPairs=${editorialScoreBreakdown.repeatedIdeaPairCount}` +
        ` robotic=${editorialScoreBreakdown.roboticPhraseCount}` +
        ` conclusionPenalty=${editorialScoreBreakdown.conclusionPenalty}`,
      );
    } else {
      console.log(
        `[editorial-polish] rejected: ${generalResult?.result.reason ?? "general editor deferred to final-document owner"}` +
        (malformedResult ? `; malformed=${malformedResult.result.reason}` : "") +
        (weakenedResult ? `; weakened=${weakenedResult.result.reason}` : "") +
        (repetitionResult ? `; repetition=${repetitionResult.result.reason}` : "") +
        (proseOnlyResult ? `; proseOnly=${proseOnlyResult.result.reason}` : "") +
        (targetedRepairsPersisted
          ? `; targeted repairs persisted (malformed/weakened/repetition) despite score ${finalEditorialScore} < ${state.policy.minimumEditorialScore}; ` +
            `malformedRemaining=${findMalformedEditableBlocks(state.articleDoc).length}`
          : anyEditorialCandidateAccepted
            ? `; editorial score remains below minimum: ${finalEditorialScore} < ${state.policy.minimumEditorialScore}`
            : "") +
        `; score breakdown malformed=${editorialScoreBreakdown.malformedProseCount}` +
        ` repeatedPairs=${editorialScoreBreakdown.repeatedIdeaPairCount}` +
        ` robotic=${editorialScoreBreakdown.roboticPhraseCount}` +
        ` conclusionRatio=${editorialScoreBreakdown.conclusionWordRatio.toFixed(3)}` +
        ` conclusionPenalty=${editorialScoreBreakdown.conclusionPenalty}`,
      );
    }
    recordStage(
      state,
      "editorial-polish",
      inputFingerprint,
      fp(state.blog),
      accepted,
      accepted ? undefined : targetedRepairsPersisted ? "targeted-repairs-persisted" : "pre-stage-restore",
      {
        malformed: malformedResult?.result ?? null,
        malformedBlockCount: malformedBlocks.length,
        malformedFallback,
        malformedFallbackApplied,
        weakened: weakenedResult?.result ?? null,
        weakenedBlockCount: weakenedBlockIds.length,
        repetition: repetitionResult?.result ?? null,
        repetitionBlockCount: repetitionTargets.length,
        general: generalResult?.result ?? null,
        proseOnly: proseOnlyResult?.result ?? null,
        proseOnlyBlockCount: proseOnlyBlockIds.length,
        finalEditorialScore,
        editorialScoreBreakdown,
        minimumEditorialScore: state.policy.minimumEditorialScore,
        targetedRepairsPersisted,
      },
    );
    trace?.endStage("editorial-polish", state.articleDoc, traceCtx!, accepted, !accepted);
  }

  // The editor is never allowed to change ownership. This is a confirmation
  // gate that fails the generation if the editor re-introduced a violation;
  // it never silently converts an unresolved violation into a warning.
  state = runTrackedHtmlStage(state, "claim-ownership-final", (html) => {
    const ledger = deps.context?.claimOwnership;
    if (!ledger) return html;
    const violations = validateClaimOwnership(
      state.articleDoc,
      ledger,
      state.keyphrase,
      deps.context?.research || [],
    );
    if (violations.length > 0) {
      console.error(
        `[claim-ownership-final] ${violations.length} violation(s) after editorial polish:\n` +
        formatOwnershipViolationDetails(violations, ledger).join("\n"),
      );
      throw new Error(
        `Claim ownership violations after editorial polish: ${violations.length}` +
        ` (first=${violations[0].evidenceId} in ${violations[0].componentId} reason=${violations[0].reason})`,
      );
    }
    return html;
  });

  // Application-owned navigation and links run only after factual and
  // editorial content is settled, so anchors cannot make a bad factual
  // sentence undeletable earlier in the pipeline.
  state = runTrackedHtmlStage(state, "language-switcher", () => {
    const snap = snapshotState(state);
    const slugs = pairedSlugs(state.slug || "blog-post");
    const switcherHtml = renderLanguageSwitcher({
      currentLanguage: "en",
      englishSlug: slugs.englishSlug,
      chineseSlug: slugs.chineseSlug,
    });
    state.articleDoc.languageSwitcher = {
      id: "en-language-switcher",
      type: "language-switcher",
      html: switcherHtml,
      fingerprint: fingerprintHtml(switcherHtml),
    };
    syncBlogFromDocument(state);
    // Stage-aware integrity contract: the switcher stage owns the switcher
    // field; everything else must be untouched.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["cta-switcher-schema", "protected-content"]),
      "language-switcher",
    );
    return state.blog;
  });

  state = await runInternalLinks(state, deps);

  {
    const snap = snapshotState(state);
    state = runTrackedHtmlStage(state, "external-links", () => {
      const researchItems = deps.context?.research || [];
      const eligible = researchItems.filter(
        (item: { url?: string }) => typeof item?.url === "string" && isEligibleExternalSourceUrl(item.url),
      );
      const rejected = researchItems.length - eligible.length;
      console.log(
        `[external-links:candidates] researchSources=${researchItems.length}` +
        ` eligible=${eligible.length} rejected=${rejected}`,
      );
      if (eligible.length === 0) {
        const message = researchItems.length === 0
          ? "no research sources available — 0 external links injected"
          : "no eligible external sources (all B2I-owned or invalid URLs) — 0 external links injected";
        console.log(`[external-links] WARNING: ${message}`);
        state.warnings.push(`External links: ${message}`);
        return state.blog;
      }
      const requested = Math.min(6, eligible.length);
      const before = countEditorialExternalLinks(state.blog);
      // Canonical model-based insertion: each citation is added as a NEW
      // paragraph block, so existing editorial text, punctuation, inline
      // nodes, sentence boundaries and block order are never altered.
      const result = insertExternalResearchLinksIntoDocument(state.articleDoc, eligible, 6);
      syncBlogFromDocument(state);
      const after = countEditorialExternalLinks(state.blog);
      console.log(
        `[external-links:inject] requested=${requested} inserted=${result.insertedLinks}` +
        ` skipped=${Math.max(0, requested - result.insertedLinks)}` +
        ` externalBefore=${before} externalAfter=${after}`,
      );
      return state.blog;
    });
    // Stage-aware integrity contract: link injection owns link changes only;
    // every other invariant (FAQ parity, protected content, facts) must hold.
    enforceIntegrityContract(state, deps, snap, new Set<ContractCategory>(["links", "word-count"]), "external-links");
  }

  {
    const snap = snapshotState(state);
    state = runTrackedHtmlStage(state, "external-dedup", (html) =>
      deduplicateEditorialExternalLinks(html).html,
    );
    enforceIntegrityContract(state, deps, snap, new Set<ContractCategory>(["links", "word-count"]), "external-dedup");
  }

  {
    const snap = snapshotState(state);
    state = runTrackedHtmlStage(state, "link-enforce", (html) => {
      const result = enforceInternalLinkLimit(html, 4);
      console.log(`[link-enforce] retained=${result.retained.length} removed=${result.removed.length}`);
      return result.html;
    });
    enforceIntegrityContract(state, deps, snap, new Set<ContractCategory>(["links", "word-count"]), "link-enforce");
  }

  state = runTrackedHtmlStage(state, "factual-final", (html) => {
    const research = deps.context?.research || [];
    const factualComponents = [
      { label: "introduction", html: componentHtml(state.articleDoc.introduction) },
      ...state.articleDoc.sections
        .filter((section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading")
        .map((section) => ({ label: section.id, html: componentHtml(section) })),
      { label: "conclusion", html: componentHtml(state.articleDoc.conclusion) },
      ...state.articleDoc.visibleFaq.map((entry, index) => ({
        label: `faq-${index + 1}`,
        html: `${entry.question} ${entry.answerHtml || entry.answerText}`,
      })),
    ];
    for (const component of factualComponents) {
      const unsupported = scanFactualRisks(component.html, state.keyphrase, research).claims
        .filter((claim) => !claim.supported);
      if (unsupported.length > 0) {
        state.warnings.push(
          `Final factual confirmation found ${unsupported.length} unsupported claim(s) in ${component.label}`,
        );
      }
    }
    const ledger = deps.context?.claimOwnership;
    const ownershipViolations = ledger
      ? validateClaimOwnership(state.articleDoc, ledger, state.keyphrase, research)
      : [];
    if (ownershipViolations.length > 0) {
      console.error(
        `[factual-final] ${ownershipViolations.length} claim ownership violation(s) at the final factual gate:\n` +
        formatOwnershipViolationDetails(ownershipViolations, ledger).join("\n"),
      );
      throw new Error(
        `Final claim ownership violations: ${ownershipViolations.length}` +
        ` (first=${ownershipViolations[0].evidenceId} in ${ownershipViolations[0].componentId} reason=${ownershipViolations[0].reason})`,
      );
    }
    return html;
  });

  // Factual and ownership removal run after SEO normalisation and can remove
  // the exact keyphrase from its H2 and opening placements. This deterministic
  // stage restores the keyphrase in one suitable editorial H2 and naturally in
  // the first 100 readable words, keeping density inside 0.5%–3% and never
  // introducing unsupported claims, ownership violations, repetition or
  // protected-content changes.
  state = runTrackedHtmlStage(state, "post-ownership-seo-reconcile", (html) => {
    const snap = snapshotState(state);
    const research = deps.context?.research || [];
    traceKeyphraseDensity("factual-ownership-cleanup", state);
    const result = reconcilePostOwnershipKeyphrase(
      state.articleDoc,
      state.keyphrase,
      research,
      deps.context?.claimOwnership,
    );
    syncBlogFromDocument(state);
    // Always log the outcome. A silent no-op previously hid the reason the
    // editorial-H2 guarantee was not restored mid-pipeline; the authoritative
    // save-boundary stage below now enforces it regardless.
    console.log(
      `[post-ownership-seo-reconcile] h2=${result.h2KeyphraseRestored}` +
      ` first100=${result.first100KeyphraseRestored}` +
      ` occ=${result.keyphraseCountBefore} → ${result.keyphraseCountAfter}` +
      ` density=${result.densityBefore.toFixed(2)}% → ${result.densityAfter.toFixed(2)}%` +
      (result.h2KeyphraseRestored || result.first100KeyphraseRestored
        ? ""
        : " (no change committed)"),
    );
    traceKeyphraseDensity("post-ownership-seo-reconcile", state);
    // Stage-aware integrity contract: the reconciliation owns SEO/keyphrase
    // and word-count changes only; links, facts, FAQ parity and protected
    // content must be untouched or the exact snapshot is restored.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["seo", "word-count"]),
      "post-ownership-seo-reconcile",
    );
    return state.blog;
  });


  // CTA preservation: the editor cannot target the CTA, and this deterministic
  // stage still verifies that exactly one canonical signup CTA remains.
  // Ensures exactly one CTA block with one CTA heading and one signup URL.
  // If the CTA is missing or damaged, sets it on the canonical ArticleDocument
  // and re-renders — avoiding fragile HTML string surgery that can break WP blocks.
  state = runTrackedHtmlStage(state, "cta-preserve", (html) => {
    const snap = snapshotState(state);
    const cta = analyzeCanonicalEnglishCta(html);
    const canonicalDocCta = state.articleDoc.cta?.html.replace(/\s+/g, " ").trim()
      === CANONICAL_ENGLISH_CTA_HTML.replace(/\s+/g, " ").trim()
      && state.articleDoc.cta?.fingerprint === CANONICAL_ENGLISH_CTA_FINGERPRINT;
    if (cta.valid && canonicalDocCta) {
      enforceIntegrityContract(
        state,
        deps,
        snap,
        new Set<ContractCategory>(["cta-switcher-schema", "protected-content"]),
        "cta-preserve",
      );
      return html;
    }

    console.log(`[cta-preserve] canonical CTA check failed: ${cta.issues.join("; ")} — re-injecting`);

    // Set CTA on the canonical ArticleDocument and re-render.
    // renderArticleDocument() places CTA at the correct position
    // (after FAQ schema, as the final visible block). No HTML surgery needed.
    state.articleDoc.cta = {
      id: "cta",
      type: "cta",
      html: CANONICAL_ENGLISH_CTA_HTML,
      fingerprint: CANONICAL_ENGLISH_CTA_FINGERPRINT,
    };
    syncBlogFromDocument(state);
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["cta-switcher-schema", "protected-content"]),
      "cta-preserve",
    );
    return state.blog;
  });

  // Deterministic final trim, then one bounded targeted section-compaction
  // call when needed, then a coherence gate. Trimming is structure-aware:
  // repetition and low-value detail are removed first, complete arguments,
  // examples, transitions, evidence and heading relationships are preserved,
  // and unresolved coherence damage blocks saving. The trim is density-aware:
  // it must not accept a trimmed candidate that crosses the hard keyphrase
  // stuffing limit without resolving it deterministically right here.
  state = await runFinalTrimStage(state, deps);

  // Deterministic post-final-trim SEO reconciliation. Final trim removes
  // non-keyphrase words, which can raise keyphrase density above the hard 3%
  // limit without any occurrence being added. This stage reuses the protected
  // keyphrase-removal logic and re-validates every hard gate on the canonical
  // ArticleDocument before committing; when no safe correction exists it
  // restores the exact pre-stage snapshot and fails closed (blocks saving).
  state = runTrackedHtmlStage(state, "final-seo-reconcile", (html) => {
    const snap = snapshotState(state);
    const research = deps.context?.research || [];
    traceKeyphraseDensity("final-seo-reconcile:before", state);
    const result = reconcileFinalKeyphraseDensity(
      state.articleDoc,
      state.keyphrase,
      research,
      deps.context?.claimOwnership,
      state.wordMin,
      state.wordMax,
    );
    if (!result.accepted) {
      restoreSnapshot(state, snap);
      syncBlogFromDocument(state);
      console.error(
        `[final-seo-reconcile] rollback=success reason=${result.rejectionReasons.join("; ")}` +
        ` inputFp=${fp(html)} restoredFp=${fp(state.blog)}`,
      );
      throw new Error(
        `Final keyphrase density reconciliation failed: ` +
        `${result.rejectionReasons.join("; ")}`,
      );
    }
    syncBlogFromDocument(state);
    traceKeyphraseDensity("final-seo-reconcile:after", state);
    // Stage-aware integrity contract: the reconciliation owns SEO density,
    // word count and the sentence-quality/malformed effects of its removals;
    // links, facts, FAQ parity and protected content must be untouched.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["seo", "word-count", "malformed", "sentence-quality"]),
      "final-seo-reconcile",
    );
    return state.blog;
  });

  // FAQ schema is application-owned. Always regenerate it from canonical,
  // protected visible FAQ entries after every content-changing stage.
  state = runTrackedHtmlStage(state, "faq-recovery", () => {
    const snap = snapshotState(state);
    if (state.articleDoc.visibleFaq.length === 0) {
      state.articleDoc.faqSchema = null;
      syncBlogFromDocument(state);
      enforceIntegrityContract(
        state,
        deps,
        snap,
        new Set<ContractCategory>(["cta-switcher-schema"]),
        "faq-recovery",
      );
      return state.blog;
    }
    const schemaHtml = renderFaqSchema(state.articleDoc.visibleFaq);
    state.articleDoc.faqSchema = {
      id: "faq-schema",
      type: "faq-schema",
      html: schemaHtml,
      fingerprint: fingerprintHtml(schemaHtml),
    };
    syncBlogFromDocument(state);
    console.log(
      `[faq-recovery] regenerated schema from ${state.articleDoc.visibleFaq.length} protected FAQ entries`,
    );
    // Stage-aware integrity contract: schema regeneration owns the schema
    // field; canonical/rendered/schema semantic parity must hold.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>(["cta-switcher-schema"]),
      "faq-recovery",
    );
    return state.blog;
  });

  // CTA, language switcher and JSON-LD are application-owned and excluded by
  // the canonical word counter.
  state = runTrackedHtmlStage(state, "wc-check", (html) => {
    const finalWordCount = assertFinalWordCountParity(state);
    console.log(`[wc-check] canonical word count=${finalWordCount} range=${state.wordMin}-${state.wordMax}`);
    return html;
  });

  // Final preflight: immediately before final validation, re-run deterministic
  // malformed repair (last-resort block removal allowed), rebuild the visible
  // FAQ and FAQ schema from the current canonical entries, and confirm parity.
  // The final gate must never discover a malformed fragment or FAQ mismatch
  // that a prior stage claimed to repair. Known genuine corruption that could
  // not be repaired or safely removed fails closed HERE, at the last repair
  // boundary, so final QC stays a backstop for defects missed earlier rather
  // than the routine first point where already-known defects abort generation.
  state = runTrackedHtmlStage(state, "final-preflight", () => {
    const snap = snapshotState(state);
    const repair = repairDeterministicMalformedProse(
      state.articleDoc,
      state.wordMin,
      protectedSentencesByBlockId,
      true,
      state.keyphrase,
    );
    // Boundary policy: scan the full document (all block types) after the
    // repair; genuine corruption that still cannot be repaired or safely
    // removed fails closed HERE, at the last repair boundary. The
    // sentence-quality scanner (the same authoritative scanner final QC uses)
    // is an absolute hard gate here too — a duplicated determiner, malformed
    // noun phrase, repeated adjacent word, broken punctuation or fragment that
    // survives every prior stage must fail at this boundary, never reach
    // final QC unseen.
    const remainingMalformed = scanMalformedProseInDocument(state.articleDoc);
    const hardUnresolved = remainingMalformed.filter((finding) =>
      finding.issues.some((issue) => classifyMalformedIssue(issue.code) === "hard"),
    );
    const remainingSentenceQuality = scanSentenceQualityInDocument(state.articleDoc);
    const sentenceQualityUnresolved = remainingSentenceQuality.length;
    console.log(
      `[final-preflight] deterministic malformed repair repaired=${repair.repairedBlockIds.length}` +
      ` removed=${repair.removedBlockIds.length}` +
      ` unresolvedEditable=${repair.unresolved.length}` +
      ` unresolvedDocument=${hardUnresolved.length}` +
      ` unresolvedSentenceQuality=${sentenceQualityUnresolved}`,
    );
    if (hardUnresolved.length > 0 || sentenceQualityUnresolved > 0) {
      restoreSnapshot(state, snap);
      throw new Error(
        `Unresolved malformed prose at final repair boundary (${hardUnresolved.length}): ` +
        hardUnresolved
          .map((finding) =>
            `${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}] component=${finding.componentId}`,
          )
          .join("; ")
        + (sentenceQualityUnresolved > 0
          ? ` | unresolved sentence-quality (${sentenceQualityUnresolved}): ` +
            remainingSentenceQuality
              .map((finding) =>
                `${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}] component=${finding.componentId}`,
              )
              .join("; ")
          : ""),
      );
    }
    // The deterministic malformed repair above can remove non-keyphrase words,
    // raising keyphrase density past the hard 3% limit. This repair boundary
    // owns that: the same deterministic reconcile runs here and fails closed
    // (restoring the exact pre-preflight snapshot) when it cannot be resolved.
    const densityReconcile = reconcileFinalKeyphraseDensity(
      state.articleDoc,
      state.keyphrase,
      deps.context?.research || [],
      deps.context?.claimOwnership,
      state.wordMin,
      state.wordMax,
    );
    if (!densityReconcile.accepted) {
      restoreSnapshot(state, snap);
      console.error(
        `[final-preflight] density resolution failed — rollback=success` +
        ` reason=${densityReconcile.rejectionReasons.join("; ")}`,
      );
      throw new Error(
        `Final preflight could not keep keyphrase density inside the hard limit: ` +
        `${densityReconcile.rejectionReasons.join("; ")}`,
      );
    }
    if (densityReconcile.applied) {
      console.log(
        `[final-preflight] density reconcile removed=${densityReconcile.removedSentences} sentence(s)` +
        ` density=${densityReconcile.densityBefore.toFixed(2)}% → ${densityReconcile.densityAfter.toFixed(2)}%`,
      );
    }
    // Stage-aware integrity contract at the last repair boundary: the repair
    // owns malformed/sentence quality, word count, SEO density and coherence;
    // FAQ parity, links, facts, ownership and protected content must hold.
    enforceIntegrityContract(
      state,
      deps,
      snap,
      new Set<ContractCategory>([
        "malformed",
        "sentence-quality",
        "word-count",
        "seo",
        "coherence",
      ]),
      "final-preflight",
    );
    if (state.articleDoc.visibleFaq.length > 0) {
      const schemaHtml = renderFaqSchema(state.articleDoc.visibleFaq);
      state.articleDoc.faqSchema = {
        id: "faq-schema",
        type: "faq-schema",
        html: schemaHtml,
        fingerprint: fingerprintHtml(schemaHtml),
      };
    }
    syncBlogFromDocument(state);
    const canonical = extractVisibleFaqFromArticle(state.blog, state.articleDoc);
    const schemaHtml = extractFaqBlock(state.blog);
    const parity = validateFaqParity(
      canonical.map((entry) => ({
        question: entry.question,
        answerHtml: "",
        answerText: entry.answerText,
      })),
      schemaHtml,
    );
    const renderedCount = (state.blog.match(/"@type": "Question"/g) ?? []).length;
    const finalExternalLinks = countEditorialExternalLinks(state.blog);
    console.log(
      `[external-links:final] saved=${finalExternalLinks}` +
      ` urls=[${extractEditorialExternalLinkUrls(state.blog).join(", ")}]`,
    );
    console.log(
      `[final-preflight] FAQ parity valid=${parity.valid}` +
      ` canonical=${state.articleDoc.visibleFaq.length}` +
      ` rendered=${canonical.length}` +
      ` schema=${renderedCount}`,
    );
    if (!parity.valid) {
      const first = parity.issues[0];
      throw new Error(
        `Final preflight FAQ parity mismatch: canonical=${state.articleDoc.visibleFaq.length}` +
        ` rendered=${canonical.length} schema=${renderedCount}` +
        ` first=${first ? first.type : "unknown"}${first && first.index !== undefined ? `@${first.index}` : ""}`,
      );
    }
    return state.blog;
  });

  // ── Mutating editorial-H2 keyphrase reconciliation ──
  // A natural editorial H2 carrying the exact focus keyphrase is a SEO quality
  // target, not a save-blocking invariant. The mid-pipeline
  // post-ownership-seo-reconcile stage restores the keyphrase only when every
  // all-or-nothing guarantee holds and can silently no-op; this deterministic
  // stage makes one best-effort natural repair using the same reconciliation
  // logic. It runs BEFORE the mutation-free final QC so that backstop measures
  // the repaired document. When no natural, non-duplicated, naturalness-clean
  // repair can be produced, the original headings are kept unchanged and the
  // pipeline continues — the H2 keyphrase miss is reported as a soft diagnostic
  // and the final SEO audit deducts points. Naturalness/structural corruption
  // is still a genuine hard gate below.
  state = runTrackedHtmlStage(state, "editorial-h2-enforce", () => {
    const result = applyEditorialH2WithDensityGuard(state.articleDoc, state.keyphrase);
    syncBlogFromDocument(state);
    if (result.rolledBack) {
      // The H2 keyphrase placement is a soft signal; stuffing is a hard gate.
      // The heading change was rolled back so a later stage can never
      // reintroduce density above the hard limit.
      console.log(
        `[editorial-h2-enforce] satisfied=true but density=${result.densityAfter.toFixed(2)}% > 3%` +
        ` — heading change rolled back (soft skip)`,
      );
    } else if (result.satisfied) {
      console.log(
        `[editorial-h2-enforce] satisfied=true` +
        ` density=${result.densityAfter.toFixed(2)}%`,
      );
    } else {
      // Missing exact-focus-keyphrase in an editorial H2 is soft. Never force
      // an awkward, duplicated or unnatural heading; keep originals untouched.
      console.log(
        `[editorial-h2-reconcile] satisfied=false repair=not-committed` +
        ` reason=natural-repair-unavailable severity=soft`,
      );
    }
    return state.blog;
  });

  // Authoritative final canonical quality scan. Runs once after every
  // mutating stage (SEO, factual, ownership, links, CTA, trim, FAQ recovery)
  // and immediately before full-document diagnosis: unresolved coherence,
  // malformed-prose, sentence-quality, source-boilerplate, claim-strength
  // inflation, source-to-section relevance and heading-naturalness violations
  // are hard failures here and again in the pre-save gate. Shadow editorial
  // diagnosis can never repair deterministic corruption — it is diagnosis-only.
  state = runTrackedHtmlStage(state, "final-qc-scan", () => {
    const research = deps.context?.research || [];
    // Mutation-free backstop: the owning repair stage ran before expansion, so
    // any finding here is new, embedded in prose, or otherwise unsafe to alter.
    const relevance = assessSourceSectionRelevance(state.articleDoc, research);
    const coherence = validateCoherence(state.articleDoc);
    const malformed = scanMalformedProseInDocument(state.articleDoc);
    const sentenceQuality = scanSentenceQualityInDocument(state.articleDoc);
    const boilerplate = countBoilerplateInDocument(state.articleDoc);
    const ungrounded = assessSectionTopicGrounding(state.articleDoc);
    const headings = assessHeadingNaturalness(state.articleDoc, state.keyphrase);
    const unsupportedClaims = scanFactualRisks(
      state.blog,
      state.keyphrase,
      research,
    ).claims.filter((claim) => !claim.supported);
    const unresolved = coherence.length
      + malformed.length
      + sentenceQuality.length
      + boilerplate.length
      + relevance.length
      + ungrounded.length
      + headings.length
      + unsupportedClaims.length;
    if (unresolved > 0) {
      console.error(
        `[final-qc-scan] ${unresolved} unresolved deterministic quality violation(s):\n` +
        [
          ...coherenceViolationSummary(coherence),
          ...malformed.map((block) =>
            `type=malformed-prose component=${block.componentId} block=${block.blockId} issues=${block.issues.map((issue) => issue.message).join("; ")}`,
          ),
          ...sentenceQuality.flatMap((block) =>
            block.issues.map((issue) =>
              `type=${issue.code} component=${block.componentId} block=${block.blockId} sentence="${issue.sentence.slice(0, 120)}"`,
            ),
          ),
          ...boilerplate.map((block) =>
            `type=boilerplate component=${block.componentId} block=${block.blockId} blockType=${block.blockType} snippet="${block.snippet}"`,
          ),
          ...formatRelevanceViolations(relevance).map((line) => `type=off-topic-source ${line}`),
          ...ungrounded.map((section) => `type=ungrounded-section ${section}`),
          ...headings.map((violation) =>
            `type=heading-${violation.code} section=${violation.sectionId} heading="${violation.heading.slice(0, 120)}"`,
          ),
          ...unsupportedClaims.map((claim) =>
            `type=unsupported-claim category=${claim.category} text="${claim.text.slice(0, 120)}"`,
          ),
        ].join("\n"),
      );
      throw new Error(
        `Unresolved deterministic quality violations before final validation: ${unresolved}` +
        ` (coherence=${coherence.length} malformed=${malformed.length} sentenceQuality=${sentenceQuality.length}` +
        ` boilerplate=${boilerplate.length} relevance=${relevance.length + ungrounded.length}` +
        ` headings=${headings.length} unsupportedClaims=${unsupportedClaims.length})`,
      );
    }
    console.log(
      `[final-qc-scan] clean coherence=0 malformed=0 sentenceQuality=0 boilerplate=0 relevance=0 headings=0 unsupported=0`,
    );
    return state.blog;
  });

  // Enterprise-style final-document editorial transaction. This is deliberately
  // the last content-changing owner: it sees the fully trimmed, linked article
  // with final CTA, FAQ, schema and WordPress markup already present. The only
  // following stage is the canonical validation-only gate.
  if (isFullDocumentEditorialEnabled()) {
    const inputFingerprint = fp(state.blog);
    const trace = state.debugTrace;
    const traceCtx = trace ? traceContextFor(state) : undefined;
    trace?.beginStage("final-document-editorial", JSON.stringify(state.articleDoc), traceCtx!);
    // Boundary precondition: only structurally valid canonical HTML may reach the
    // final-document diagnosis. Do not send invalid HTML to the model.
    assertFinalEditorialBoundary(state);
    const outcome = await runFullDocumentEditorial({
      doc: state.articleDoc,
      keyphrase: state.keyphrase,
      research: deps.context?.research || [],
      protectedSentencesByBlockId,
      validateProductionCandidate: (candidate) => {
        const wordCount = countCanonicalVisibleWords(candidate);
        return {
          passed: wordCount >= state.wordMin && wordCount <= state.wordMax,
          reasons: wordCount >= state.wordMin && wordCount <= state.wordMax
            ? []
            : [`canonical word count ${wordCount} outside ${state.wordMin}-${state.wordMax}`],
        };
      },
      aiCall: async (messages, options, label) =>
        deps.chatWithRetry(messages, options, label || "final-document-editorial"),
    });
    state.fullDocumentEditorial = outcome;
    state.articleDoc = outcome.doc;
    syncBlogFromDocument(state);
    recordStage(
      state,
      "final-document-editorial",
      inputFingerprint,
      fp(state.blog),
      outcome.accepted,
      outcome.accepted ? undefined : "pre-stage-restore",
      {
        qualityRunId: outcome.runId,
        mode: outcome.mode,
        status: outcome.status,
        callCount: outcome.callCount,
        findings: outcome.findings.map((finding) => ({
          findingId: finding.findingId,
          category: finding.category,
          severity: finding.severity,
          blockIds: finding.blockIds,
          evidenceIds: finding.evidenceIds,
          brandRuleIds: finding.brandRuleIds,
          source: finding.source,
        })),
        selectedUnitIds: outcome.selectedUnitIds,
        patches: outcome.patches,
        unresolvedFindingIds: outcome.unresolvedFindingIds,
        mandatoryOverflow: outcome.mandatoryOverflow,
        diagnostics: outcome.diagnostics,
      },
    );
    trace?.endStage("final-document-editorial", state.articleDoc, traceCtx!, outcome.accepted, !outcome.accepted);
    console.log(
      `[final-document-editorial] run=${outcome.runId} mode=${outcome.mode}` +
      ` findings=${outcome.findings.length} selected=${outcome.selectedUnitIds.length}` +
      ` acceptedPatches=${outcome.patches.filter((patch) => patch.accepted).length}` +
      ` rejectedPatches=${outcome.patches.filter((patch) => !patch.accepted).length}` +
      ` unresolved=${outcome.unresolvedFindingIds.length} status=${outcome.status}`,
    );
    if (!outcome.accepted) {
      throw new Error(
        `Final-document editorial acceptance failed: ${[
          ...outcome.diagnostics,
          ...outcome.unresolvedFindingIds.map((id) => `unresolved ${id}`),
        ].join("; ")}`,
      );
    }
  }

  // ── Non-mutating editorial-H2 soft diagnostic at the final save boundary ──
  // Reports whether a qualifying editorial H2 exists, whether the exact focus
  // keyphrase is present, and heading naturalness. An absent exact keyphrase in
  // an editorial H2 is a SOFT SEO signal and must never block persistence.
  // Genuine heading-naturalness corruption is a real quality defect and remains
  // a hard failure here as a defensive backstop. It is the last content stage
  // immediately before final validation.
  state = runTrackedHtmlStage(state, "editorial-h2-save-assert", () => {
    const status = evaluateEditorialH2Status(state);
    if (status.unnaturalHeadings > 0) {
      throw new Error(
        `Editorial-H2 naturalness corruption at save boundary: ` +
        `unnatural=${status.unnaturalHeadings}`,
      );
    }
    console.log(
      `[editorial-h2-save-assert] editorialH2=${status.editorialH2Exists}` +
      ` exactKeyphrase=${status.exactKeyphrase}` +
      ` naturalness=${status.unnaturalHeadings}` +
      ` severity=${status.exactKeyphrase ? "ok" : "soft"}`,
    );
    return state.blog;
  });

  // Final validation
  state = runTrackedHtmlStage(state, "final-validation", (html) => {
    const result = runFinalValidation(state);
    if (!result.passed) {
      if (
        process.env.DEBUG_EDITORIAL === "true"
        && result.reasons.some((reason) => reason.includes("editorial score"))
      ) {
        writeEditorialFailureArtifact(state, {
          preEditorialHtml,
          preEditorialMetrics,
          rejectedEditorialCandidates,
          finalReasons: result.reasons,
        });
      }
      throw new Error(`Final validation failed: ${result.reasons.join("; ")}`);
    }
    return html;
  });

  const orderIssues = validatePipelineOrder(state);
  if (orderIssues.length > 0) console.warn(`[PIPELINE] Order issues: ${orderIssues.map((i) => i.message).join("; ")}`);

  return state;
}

// ── Stage implementations ──

async function runClaimCheck(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const components = [
    { kind: "introduction" as const, component: state.articleDoc.introduction },
    ...state.articleDoc.sections
      .filter(
        (section) =>
          section.sectionType !== "faq-heading"
          && section.sectionType !== "conclusion-heading",
      )
      .map((component) => ({ kind: "section" as const, component })),
    { kind: "conclusion" as const, component: state.articleDoc.conclusion },
  ];
  const bodies = components.map(({ component }, index) => ({
    index,
    body: componentHtml(component),
  }));
  const conflicts = detectClaimConflicts(bodies, { claims: [] });
  if (conflicts.length === 0) {
    const fpSnap = fp(state.blog);
    recordStage(state, "claim-check", fpSnap, fpSnap, true, undefined, { skipped: true, reason: "no-conflicts" });
    return state;
  }

  const preHtml = state.blog;
  const snap = snapshotState(state);
  const targetIndexes = [...new Set(conflicts.map((conflict) => conflict.sectionIndexB))];
  for (const targetIndex of targetIndexes) {
    const target = components[targetIndex];
    if (!target || target.kind === "introduction") continue;
    try {
      const conclusionTarget = Math.round(
        state.requestedWordCount * GENERATION_WORD_BUFFER * WORD_ALLOCATION.CONCLUSION,
      );
      const regeneratedBody = target.kind === "conclusion"
        ? await regenerateConclusion(
            { chatWithRetry: deps.makeTrackedChatForStage("claim_fix"), promptContext: deps.context } as any,
            state.title,
            conclusionTarget,
            extractReadableText(
              [
                componentHtml(state.articleDoc.introduction),
                ...state.articleDoc.sections.map(componentHtml),
              ].join("\n"),
            ),
          )
        : await (async () => {
            const sectionPosition = state.articleDoc.sections.findIndex(
              (section) => section.id === target.component.id,
            );
            const previousHeading = sectionPosition > 0
              ? state.articleDoc.sections[sectionPosition - 1]?.heading ?? "Introduction"
              : "Introduction";
            const nextHeading = sectionPosition >= 0
              && sectionPosition < state.articleDoc.sections.length - 1
              ? state.articleDoc.sections[sectionPosition + 1]?.heading ?? "Conclusion"
              : "Conclusion";
            return regenerateSection(
              { chatWithRetry: deps.makeTrackedChatForStage("claim_fix"), promptContext: deps.context } as any,
              state.title,
              target.component.heading,
              previousHeading,
              nextHeading,
              state.wordsPerSection,
              state.exactKeyphraseTarget,
              state.keyphrase,
              target.component.id,
            );
          })();
      if (regeneratedBody && countReadableWords(regeneratedBody) > 0) {
        replaceComponentHtml(target.component, regeneratedBody, "regenerated");
        syncBlogFromDocument(state);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.warnings.push(
        `Claim repair failed for ${target.component.id}: ${message}`,
      );
      console.warn(
        `[claim-check] repair failed for ${target.component.id}: ${message}`,
      );
    }
  }
  return runTrackedHtmlStage(state, "claim-check", (html) => html, snap);
}

function runConclusionDiscipline(state: PipelineState): PipelineState {
  const inputFingerprint = fp(state.blog);
  const trace = state.debugTrace;
  const traceCtx = trace ? traceContextFor(state) : undefined;
  trace?.beginStage("conclusion-discipline", JSON.stringify(state.articleDoc), traceCtx!);
  const maxConclusionWords = Math.min(
    300,
    Math.max(80, Math.round(state.requestedWordCount * 0.12)),
  );
  const result = trimConclusionToBudget(state.articleDoc, maxConclusionWords);
  if (result.removedBlocks > 0) syncBlogFromDocument(state);
  trace?.endStage("conclusion-discipline", state.articleDoc, traceCtx!, true, false);
  recordStage(
    state,
    "conclusion-discipline",
    inputFingerprint,
    fp(state.blog),
    true,
    undefined,
    { ...result, maxConclusionWords },
  );
  return state;
}

async function runExpansion(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  state.currentWordCount = countCanonicalVisibleWords(state.articleDoc);
  if (state.currentWordCount >= state.wordMin) {
    const fpSnap = fp(state.blog);
    recordStage(state, "expansion", fpSnap, fpSnap, true, undefined, { skipped: true, reason: "already-in-range" });
    return state;
  }

  const snap = snapshotState(state);
  const sectionsInput = deriveSectionInput(state);
  const result = await expandToMinimum(
    {
      chatWithRetry: deps.chatWithRetry,
      measureCanonicalVisibleWords: (workingSections) => {
        const candidate = structuredClone(state.articleDoc);
        for (const section of workingSections) {
          if (section.index >= 0 && section.index < candidate.sections.length) {
            replaceComponentHtml(candidate.sections[section.index], section.body);
          }
        }
        return countCanonicalVisibleWords(candidate);
      },
    },
    sectionsInput.map((section) => ({ ...section })),
    sectionsInput,
    componentHtml(state.articleDoc.introduction),
    componentHtml(state.articleDoc.conclusion),
    state.currentWordCount,
    state.wordMin,
    state.wordsPerSection,
  );

  for (const s of result.sections) {
    if (s.index >= 0 && s.index < state.articleDoc.sections.length) {
      replaceComponentHtml(state.articleDoc.sections[s.index], s.body, "expanded");
    }
  }
  state.expansionAttempts = result.expansions;
  syncBlogFromDocument(state);
  state.currentWordCount = countCanonicalVisibleWords(state.articleDoc);

  return runTrackedHtmlStage(state, "expansion", (html) => html, snap);
}

async function runTrim(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  if (state.currentWordCount <= state.wordMax) {
    const fpSnap = fp(state.blog);
    recordStage(state, "trim", fpSnap, fpSnap, true, undefined, { skipped: true, reason: "already-in-range" });
    return state;
  }

  const snap = snapshotState(state);
  const sectionsInput = deriveSectionInput(state);
  const result = await trimToMaximum(
    {
      chatWithRetry: deps.chatWithRetry,
      measureCanonicalVisibleWords: (workingSections) => {
        const candidate = structuredClone(state.articleDoc);
        for (const section of workingSections) {
          if (section.index >= 0 && section.index < candidate.sections.length) {
            replaceComponentHtml(candidate.sections[section.index], section.body);
          }
        }
        return countCanonicalVisibleWords(candidate);
      },
    },
    sectionsInput.map((section) => ({ ...section })),
    componentHtml(state.articleDoc.introduction),
    componentHtml(state.articleDoc.conclusion),
    state.currentWordCount,
    state.wordMax,
  );

  for (const s of result.sections) {
    if (s.index >= 0 && s.index < state.articleDoc.sections.length) {
      replaceComponentHtml(state.articleDoc.sections[s.index], s.body);
    }
  }
  state.trimAttempts = result.trims;
  syncBlogFromDocument(state);
  state.currentWordCount = countCanonicalVisibleWords(state.articleDoc);

  return runTrackedHtmlStage(state, "trim", (html) => html, snap);
}

async function runRegeneration(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  const genCtx: any = { chatWithRetry: deps.chatWithRetry, promptContext: deps.context };
  const { blog: regeneratedBlog, title: regeneratedTitle, meta: regeneratedMeta } = await runComponentRegeneration(
    genCtx, { title: state.title, metaDescription: state.metaDescription, blog: state.blog },
    state.h2Headings, state.keyphrase,
    {
      intro: state.wordsPerSection,
      conclusion: Math.round(
        state.requestedWordCount * GENERATION_WORD_BUFFER * WORD_ALLOCATION.CONCLUSION,
      ),
      perSection: state.wordsPerSection,
      keyphraseTarget: state.exactKeyphraseTarget,
    },
  );
  state.title = regeneratedTitle;
  state.metaDescription = regeneratedMeta;

  return runTrackedHtmlStage(state, "regeneration", (html) => regeneratedBlog, snap);
}

type CompactionBlock =
  | { type: "paragraph"; text: string }
  | { type: "subheading"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export type CompactionParseRejectionReason = "invalid-json" | "schema-invalid";

export type CompactionParseResult =
  | { accepted: true; blocks: CompactionBlock[]; normalizedWrapper: boolean }
  | { accepted: false; reason: CompactionParseRejectionReason; diagnostic: string };

/** Parse a bounded compaction payload without guessing at ambiguous content.
 * A complete Markdown JSON fence or harmless prose around one complete JSON
 * object is recoverable. Syntactically invalid JSON and schema-invalid JSON
 * remain separate rejection classes for production observability. */
export function parseCompactionBlocksJson(raw: string): CompactionParseResult {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidates = [
    { text: trimmed, normalized: false },
    ...(fenced ? [{ text: fenced[1].trim(), normalized: true }] : []),
    ...(firstBrace >= 0 && lastBrace > firstBrace
      ? [{ text: trimmed.slice(firstBrace, lastBrace + 1), normalized: true }]
      : []),
  ];
  let parsed: unknown;
  let normalizedWrapper = false;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate.text);
      normalizedWrapper = candidate.normalized;
      break;
    } catch {
      // Try the next bounded representation; never repair JSON string content.
    }
  }
  if (parsed === undefined) {
    return {
      accepted: false,
      reason: "invalid-json",
      diagnostic: `unable to parse one complete JSON object (chars=${raw.length})`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { accepted: false, reason: "schema-invalid", diagnostic: "root must be an object" };
  }
  const rawBlocks = (parsed as { blocks?: unknown }).blocks;
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    return { accepted: false, reason: "schema-invalid", diagnostic: "blocks must be a non-empty array" };
  }

  const blocks: CompactionBlock[] = [];
  for (let index = 0; index < rawBlocks.length; index++) {
    const block = rawBlocks[index];
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return { accepted: false, reason: "schema-invalid", diagnostic: `block=${index} must be an object` };
    }
    const item = block as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (item.type === "paragraph" && text) {
      blocks.push({ type: "paragraph", text });
    } else if (item.type === "subheading" && text) {
      blocks.push({ type: "subheading", text });
    } else if (item.type === "list" && Array.isArray(item.items) && item.items.length > 0) {
      if (!item.items.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
        return { accepted: false, reason: "schema-invalid", diagnostic: `block=${index} list items must be non-empty strings` };
      }
      if (item.ordered !== undefined && typeof item.ordered !== "boolean") {
        return { accepted: false, reason: "schema-invalid", diagnostic: `block=${index} ordered must be boolean` };
      }
      blocks.push({ type: "list", ordered: item.ordered === true, items: (item.items as string[]).map((entry) => entry.trim()) });
    } else if (item.type === "quote" && text) {
      blocks.push({ type: "quote", text });
    } else if (item.type === "table" && Array.isArray(item.headers) && Array.isArray(item.rows)) {
      const headers = item.headers;
      const rows = item.rows;
      if (
        headers.length === 0
        || !headers.every((entry) => typeof entry === "string" && entry.trim().length > 0)
        || rows.length === 0
        || !rows.every((row) => Array.isArray(row)
          && row.length === headers.length
          && row.every((entry) => typeof entry === "string" && entry.trim().length > 0))
      ) {
        return { accepted: false, reason: "schema-invalid", diagnostic: `block=${index} table dimensions or cells are invalid` };
      }
      blocks.push({
        type: "table",
        headers: (headers as string[]).map((entry) => entry.trim()),
        rows: (rows as string[][]).map((row) => row.map((entry) => entry.trim())),
      });
    } else {
      return {
        accepted: false,
        reason: "schema-invalid",
        diagnostic: `block=${index} unsupported type or missing required content (${String(item.type)})`,
      };
    }
  }
  return { accepted: true, blocks, normalizedWrapper };
}

function compactionBlocksToHtml(blocks: CompactionBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "paragraph") {
        return `<!-- wp:paragraph --><p>${escapeCompactionText(block.text)}</p><!-- /wp:paragraph -->`;
      }
      if (block.type === "subheading") {
        return `<!-- wp:heading {"level":3} --><h3>${escapeCompactionText(block.text)}</h3><!-- /wp:heading -->`;
      }
      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${escapeCompactionText(item)}</li>`).join("");
        return `<!-- wp:list {"ordered":${block.ordered}} --><${tag}>${items}</${tag}><!-- /wp:list -->`;
      }
      if (block.type === "table") {
        const headers = block.headers.map((header) => `<th>${escapeCompactionText(header)}</th>`).join("");
        const rows = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeCompactionText(cell)}</td>`).join("")}</tr>`)
          .join("");
        return `<!-- wp:table --><figure class="wp-block-table"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></figure><!-- /wp:table -->`;
      }
      return `<!-- wp:quote --><blockquote><p>${escapeCompactionText(block.text)}</p></blockquote><!-- /wp:quote -->`;
    })
    .join("\n\n");
}

/** Escape compaction prose except for strictly-formed anchor tags, so a model
 *  can keep a source citation (link) in the compacted section. The anchor is
 *  later parsed into a real editorial link node; all other markup is escaped
 *  and can never introduce protected content. */
function escapeCompactionText(text: string): string {
  const anchors: string[] = [];
  const protectedText = text.replace(
    /<a\s+href="https?:\/\/[^"\s]+"[^>]*>[\s\S]*?<\/a>/gi,
    (anchor) => {
      anchors.push(anchor);
      return `\u0000${anchors.length - 1}\u0000`;
    },
  );
  const escaped = protectedText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => anchors[Number(index)] ?? "");
}

function extractLinkHrefsFromHtml(html: string): string[] {
  const hrefs: string[] = [];
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

function extractProtectedQuotationTexts(blocks: EditorialBlock[]): string[] {
  const quotes = new Set<string>();
  for (const block of blocks) {
    const text = extractPlainTextFromEditorialBlocks([block]).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (block.type === "quote") quotes.add(text);
    for (const span of analyzeQuotationIntegrity(text).spans) {
      const quoted = text.slice(span.start + 1, span.end - 1).trim();
      if (quoted) quotes.add(quoted);
    }
  }
  return [...quotes];
}

function protectedSectionStructureSignature(blocks: EditorialBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "subheading") {
      return [`subheading:${extractPlainTextFromEditorialBlocks([block]).replace(/\s+/g, " ").trim()}`];
    }
    if (block.type === "list") {
      return [`list:${block.ordered ? "ordered" : "unordered"}:${block.items.length}`];
    }
    if (block.type === "table") {
      const headers = block.headers.map((cell) => cell.map((node) => node.text).join("").trim());
      const rows = block.rows.map((row) => row.map((cell) => cell.map((node) => node.text).join("").trim()));
      return [`table:${JSON.stringify({ headers, rows })}`];
    }
    return [];
  });
}

function protectedArticleContentUnchanged(before: ArticleDocument, after: ArticleDocument): boolean {
  return JSON.stringify({
    languageSwitcher: before.languageSwitcher,
    cta: before.cta,
    visibleFaq: before.visibleFaq,
    faqSchema: before.faqSchema,
    metadata: before.metadata,
  }) === JSON.stringify({
    languageSwitcher: after.languageSwitcher,
    cta: after.cta,
    visibleFaq: after.visibleFaq,
    faqSchema: after.faqSchema,
    metadata: after.metadata,
  });
}

export type CompactionRejectionReason =
  | CompactionParseRejectionReason
  | "ai-call"
  | "target-unavailable"
  | "not-shorter"
  | "min-section-words"
  | "word-count"
  | "link-equivalence"
  | "claim-equivalence"
  | "ownership"
  | "unsupported-claim"
  | "quote-integrity"
  | "malformed-prose"
  | "section-grounding"
  | `coherence:${CoherenceViolation["type"]}`
  | "source-relevance"
  | "wordpress-integrity"
  | "protected-content";

interface BoundedCompactionResult {
  removedWords: number;
  sectionId: string | null;
  accepted: boolean;
  rejectionReasons: CompactionRejectionReason[];
}

function rejectCompaction(
  state: PipelineState,
  snap: PipelineSnapshot,
  sectionId: string | null,
  reasons: CompactionRejectionReason[],
  diagnostic?: string,
): BoundedCompactionResult {
  restoreSnapshot(state, snap);
  const safeDiagnostic = diagnostic
    ? ` diagnostic="${diagnostic.replace(/[\r\n]+/g, " ").slice(0, 240)}"`
    : "";
  console.error(
    `[final-trim:compaction] rejected section=${sectionId ?? "none"}`
    + ` reason=${reasons[0] ?? "target-unavailable"}`
    + ` reasons=[${reasons.join(",")}] rollback=success${safeDiagnostic}`,
  );
  return { removedWords: 0, sectionId, accepted: false, rejectionReasons: reasons };
}

function supportedClaimSentences(
  html: string,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): string[] {
  return scanFactualRisks(html, keyphrase, research).claims
    .filter((claim) => claim.supported && claim.sentenceText)
    .map((claim) => claim.sentenceText!.replace(/\s+/g, " ").trim().toLowerCase());
}

/** A block whose prose is the corruption being repaired (incomplete sentence
 *  or orphan-transition opening) is not required evidence. Uses the shared
 *  sentence-completeness validator so trim/compaction validation can never
 *  disagree with AI acceptance, malformed-prose scanning or the final QC and
 *  pre-save gates. */
function isCorruptBlockText(text: string, hasStructuredContinuation = false): boolean {
  if (!isSentenceComplete(text, "paragraph", {
    allowColonBeforeStructuredContinuation: hasStructuredContinuation,
  })) return true;
  if (
    /^\s*(?:instead|however|therefore|meanwhile|moreover|furthermore|nevertheless|nonetheless|consequently|additionally|likewise|similarly|hence|thus|yet|so|but|and)\s*[,:]|^\s*(?:as a result|on the other hand|that said|in addition|for example|for instance)\s*[,:]/i.test(text)
  ) {
    return true;
  }
  return false;
}

/** Supported claims from the coherent blocks of a section only. Used when
 *  compacting an AFFECTED section: the corrupted paragraph being repaired is
 *  not required evidence, so its incidental claims do not need preservation. */
function supportedClaimsInCoherentBlocks(
  html: string,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): string[] {
  const claims: string[] = [];
  const blockRe =
    /<!--\s*wp:(paragraph|quote)(?:\s[\s\S]*?)?\s*-->([\s\S]*?)<!--\s*\/wp:\1\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const blockHtml = m[0];
    const text = blockHtml
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const remainder = html.slice(blockRe.lastIndex).trimStart();
    const hasStructuredContinuation = /^<!--\s*wp:(?:list|table)\b/i.test(remainder);
    if (isCorruptBlockText(text, hasStructuredContinuation)) continue;
    for (const claim of scanFactualRisks(blockHtml, keyphrase, research).claims) {
      if (claim.supported && claim.sentenceText) {
        claims.push(claim.sentenceText.replace(/\s+/g, " ").trim().toLowerCase());
      }
    }
  }
  return claims;
}

/** Last paragraph of the previous editorial section and first paragraph of the
 *  next editorial section, so a compacted section keeps its transitions
 *  coherent across section boundaries. */
function buildCompactionNeighbourContext(doc: ArticleDocument, sectionIndex: number): string {
  const parts: string[] = [];
  const prev = doc.sections[sectionIndex - 1];
  if (prev && prev.sectionType !== "faq-heading" && prev.sectionType !== "conclusion-heading") {
    const lastParagraph = [...prev.blocks].reverse().find((block) => block.type === "paragraph");
    if (lastParagraph) {
      parts.push(`Previous section ("${prev.heading}") ends with: "${extractPlainTextFromEditorialBlocks([lastParagraph]).slice(0, 300)}"`);
    }
  }
  const next = doc.sections[sectionIndex + 1];
  if (next && next.sectionType !== "faq-heading" && next.sectionType !== "conclusion-heading") {
    const firstParagraph = next.blocks.find((block) => block.type === "paragraph");
    if (firstParagraph) {
      parts.push(`Next section ("${next.heading}") starts with: "${extractPlainTextFromEditorialBlocks([firstParagraph]).slice(0, 300)}"`);
    }
  }
  return parts.join("\n");
}

/**
 * One bounded targeted section-compaction call. When deterministic compression
 * cannot safely reach the maximum — or reaches it but damages coherence — the
 * affected section is compacted by the model with the complete section
 * context: the heading, the full section body (including its links and source
 * citations), the neighbouring paragraphs, and the section's owned evidence.
 *
 * The candidate is rejected — restoring the complete prior canonical snapshot
 * — unless it is strictly shorter, coherent, factually equivalent (same
 * supported claims and links, no new unsupported claims), ownership-clean,
 * topic-relevant, quotation-complete (verbatim or removed as a whole), within
 * the canonical word-count range and structurally valid.
 */
async function runBoundedSectionCompaction(
  state: PipelineState,
  deps: PipelineDependencies,
  options?: { targetSectionIds?: string[] },
): Promise<BoundedCompactionResult> {
  const research = deps.context?.research || [];
  const editorialSections = state.articleDoc.sections.filter(
    (section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading",
  );
  let target: ArticleDocument["sections"][number] | undefined;
  if (options?.targetSectionIds && options.targetSectionIds.length > 0) {
    target = editorialSections.find((section) => options.targetSectionIds!.includes(section.id));
  } else {
    target = editorialSections
      .map((section) => ({ section, words: countReadableWords(componentHtml(section)) }))
      .filter((entry) => entry.words > MIN_SECTION_WORDS + 80)
      .sort((a, b) => b.words - a.words)[0]?.section;
  }
  const snap = snapshotState(state);
  if (!target) {
    return rejectCompaction(
      state,
      snap,
      options?.targetSectionIds?.[0] ?? null,
      ["target-unavailable"],
      "no eligible editable section matched the requested target",
    );
  }
  const ledger = deps.context?.claimOwnership;
  const evidencePrompt = ledger
    ? formatOwnedEvidencePacket(ledger, target.id)
    : "";
  const originalHtml = componentHtml(target);
  const originalWords = countReadableWords(originalHtml);
  const originalLinks = extractLinkHrefsFromHtml(originalHtml);
  // When repairing an AFFECTED section, supported claims inside the corrupted
  // paragraph being repaired are not required evidence; otherwise every
  // supported claim of the original section must be preserved.
  const originalClaims = options?.targetSectionIds && options.targetSectionIds.length > 0
    ? supportedClaimsInCoherentBlocks(originalHtml, state.keyphrase, research)
    : supportedClaimSentences(originalHtml, state.keyphrase, research);
  const originalQuotes = extractProtectedQuotationTexts(target.blocks);
  const sectionIndex = state.articleDoc.sections.findIndex((section) => section.id === target.id);
  const neighbourContext = sectionIndex >= 0
    ? buildCompactionNeighbourContext(state.articleDoc, sectionIndex)
    : "";

  const prompt = [
    `Rewrite the section below more concisely so the article can meet its maximum word count.`,
    `Keep EVERY fact, statistic, link, source citation, example and claim from the original section.`,
    `Quotations and their attributions must be preserved COMPLETELY and VERBATIM, or the whole quotation must be removed — never shorten, truncate or rephrase a quotation.`,
    `Never keep a paragraph that begins with a contrast transition ("Instead", "However", "Therefore", "Meanwhile", "For example") unless the paragraph before it establishes the contrast — preserve the antecedent or rewrite the dependent paragraph safely.`,
    `Keep the meaning and structure identical. Do not add new facts, claims, numbers or opinions.`,
    `Remove only repetition and low-value detail.`,
    `Keep all sentences complete. Never leave an example, setup, quotation or comparison unfinished.`,
    `Preserve every H3 subheading, list shape and table exactly.`,
    `Return JSON only: {"blocks": [{"type": "paragraph", "text": "..."}]}. Allowed types are paragraph, subheading, list, quote and table. Lists require ordered and items. Tables require headers and rows.`,
    `Section heading: ${target.heading}`,
    ...(neighbourContext ? [`Neighbouring context:\n${neighbourContext}`] : []),
    ...(evidencePrompt ? [`Evidence owned by this section: ${evidencePrompt}`] : []),
    `Original section body:\n${originalHtml}`,
  ].join("\n\n");

  let content = "";
  try {
    const response = await deps.chatWithRetry(
      [
        {
          role: "system",
          content: "You are a careful editor who compresses marketing articles without losing facts, links, quotations, examples or meaning.",
        },
        { role: "user", content: prompt },
      ],
      { responseFormat: { type: "json_object" }, temperature: 0.2 },
      "final-trim-compaction",
      1,
    );
    content = response.content;
  } catch (error) {
    return rejectCompaction(
      state,
      snap,
      target.id,
      ["ai-call"],
      error instanceof Error ? error.message : String(error),
    );
  }

  const parsedPayload = parseCompactionBlocksJson(content);
  if (!parsedPayload.accepted) {
    return rejectCompaction(
      state,
      snap,
      target.id,
      [parsedPayload.reason],
      parsedPayload.diagnostic,
    );
  }
  const candidateHtml = compactionBlocksToHtml(parsedPayload.blocks);
  const parsed = parseWordPressEditorialBlocks(candidateHtml, `${target.id}-compaction`);
  if (parsed.errors.length > 0 || parsed.blocks.length === 0) {
    return rejectCompaction(
      state,
      snap,
      target.id,
      ["wordpress-integrity"],
      parsed.errors.join("; ") || "no parsed editorial blocks",
    );
  }

  const candidateWords = countReadableWords(candidateHtml);
  const candidateLinks = extractLinkHrefsFromHtml(candidateHtml);
  // The candidate uses the same per-block claim extraction as the original
  // side, so date claims inside source-citation paragraphs compare equally.
  const candidateClaims = supportedClaimsInCoherentBlocks(candidateHtml, state.keyphrase, research);
  const candidateUnsupported = scanFactualRisks(candidateHtml, state.keyphrase, research).claims
    .filter((claim) => !claim.supported);

  const candidate = structuredClone(state.articleDoc);
  const targetIndex = candidate.sections.findIndex((section) => section.id === target.id);
  if (targetIndex < 0) {
    return rejectCompaction(state, snap, target.id, ["target-unavailable"]);
  }
  candidate.sections[targetIndex] = {
    ...candidate.sections[targetIndex],
    blocks: parsed.blocks,
    status: "trimmed",
  };

  const sectionCoherence = validateCoherence(candidate).filter(
    (violation) => violation.componentId === target.id,
  );
  const linkEquivalence = originalLinks.every((href) => candidateLinks.includes(href))
    && candidateLinks.every((href) => originalLinks.includes(href));
  const claimEquivalence = originalClaims.every((sentence) =>
    candidateClaims.some((candidateSentence) => candidateSentence.includes(sentence) || sentence.includes(candidateSentence)),
  );
  // Quotations: preserved verbatim or removed as a whole — never truncated.
  const candidateQuotes = extractProtectedQuotationTexts(parsed.blocks);
  const quoteIntegrity = candidateQuotes.every((quote) => originalQuotes.includes(quote));
  const candidateMalformed = scanMalformedProseInBlocks(parsed.blocks);
  const unmatchedQuotes = candidateMalformed.some((finding) =>
    finding.issues.some((issue) => issue.code === "unmatched-quotation"),
  );
  const ownershipViolations = ledger
    ? validateClaimOwnership(candidate, ledger, state.keyphrase, research)
      .filter((violation) => violation.componentId === target.id)
    : [];
  const relevanceViolations = assessSourceSectionRelevance(candidate, research)
    .filter((violation) => violation.sectionId === target.id);
  // Section topic grounding is a hard invariant: the compacted section body
  // must still share a content word with its own H2, or final QC fails. The
  // AI rewrite is rejected and the snapshot preserved when grounding is lost.
  const sectionGroundingCarriers = countSectionGroundingCarriers(candidate.sections[targetIndex]);
  const grounded = sectionGroundingCarriers > 0;
  const canonicalCount = countCanonicalVisibleWords(candidate);
  const withinWordRange = canonicalCount >= state.wordMin && canonicalCount <= state.wordMax;
  const wpStructureValid = validateWordpressBlockPairs(renderArticleDocument(candidate)).valid;
  const shorter = candidateWords < originalWords;
  const withinFloor = candidateWords >= MIN_SECTION_WORDS;
  const structurallyValid = parsed.errors.length === 0;
  const protectedStructure = JSON.stringify(protectedSectionStructureSignature(target.blocks))
    === JSON.stringify(protectedSectionStructureSignature(parsed.blocks));
  const protectedContent = protectedStructure && protectedArticleContentUnchanged(state.articleDoc, candidate);

  const accepted = shorter
    && withinFloor
    && linkEquivalence
    && claimEquivalence
    && quoteIntegrity
    && !unmatchedQuotes
    && candidateMalformed.length === 0
    && ownershipViolations.length === 0
    && candidateUnsupported.length === 0
    && sectionCoherence.length === 0
    && relevanceViolations.length === 0
    && grounded
    && withinWordRange
    && wpStructureValid
    && structurallyValid
    && protectedContent;

  if (!accepted) {
    const reasons: CompactionRejectionReason[] = [];
    if (!shorter) reasons.push("not-shorter");
    if (!withinFloor) reasons.push("min-section-words");
    if (!withinWordRange) reasons.push("word-count");
    if (!linkEquivalence) reasons.push("link-equivalence");
    if (!claimEquivalence) reasons.push("claim-equivalence");
    if (ownershipViolations.length > 0) reasons.push("ownership");
    if (candidateUnsupported.length > 0) reasons.push("unsupported-claim");
    if (!quoteIntegrity || unmatchedQuotes) reasons.push("quote-integrity");
    if (candidateMalformed.length > 0 && !unmatchedQuotes) reasons.push("malformed-prose");
    for (const violation of sectionCoherence) reasons.push(`coherence:${violation.type}`);
    if (relevanceViolations.length > 0) reasons.push("source-relevance");
    if (!grounded) reasons.push("section-grounding");
    if (!wpStructureValid || !structurallyValid) reasons.push("wordpress-integrity");
    if (!protectedContent) reasons.push("protected-content");
    return rejectCompaction(
      state,
      snap,
      target.id,
      [...new Set(reasons)],
      `originalWords=${originalWords} candidateWords=${candidateWords} canonical=${canonicalCount}`,
    );
  }

  state.articleDoc = candidate;
  console.log(
    `[final-trim:compaction] accepted section=${target.id} words ${originalWords} → ${candidateWords} canonical=${canonicalCount}`,
  );
  return {
    removedWords: originalWords - candidateWords,
    sectionId: target.id,
    accepted: true,
    rejectionReasons: [],
  };
}

function coherenceIdentity(violation: CoherenceViolation): string {
  const snippet = violation.snippet.replace(/\s+/g, " ").trim();
  return `${violation.componentId}:${violation.blockId ?? "-"}:${violation.type}:${snippet}`;
}

function newlyIntroducedCoherenceViolations(
  before: CoherenceViolation[],
  after: CoherenceViolation[],
): CoherenceViolation[] {
  const existing = new Set(before.map(coherenceIdentity));
  return after.filter((violation) => !existing.has(coherenceIdentity(violation)));
}

function logTrimCoherenceDiagnostics(
  label: "preTrimCoherenceViolations" | "postTrimCoherenceViolations" | "newTrimIntroducedViolations" | "finalCoherenceViolations",
  violations: CoherenceViolation[],
): void {
  console.log(`[final-trim] ${label}=${JSON.stringify(coherenceViolationSummary(violations))}`);
}

/**
 * Structure-aware final trim with a bounded targeted section-compaction
 * fallback.
 *
 * 1. Deterministic compression runs first. If it reaches the target but
 *    created coherence damage, the result is REJECTED and the complete
 *    pre-trim PipelineSnapshot is restored.
 * 2. The bounded section-compaction fallback is then invoked ONLY for the
 *    affected sections (the ones with coherence violations), or for the
 *    largest section when the maximum is still exceeded. Each candidate is
 *    accepted only when it is shorter, coherent, factually equivalent,
 *    ownership-clean, topic-relevant, quotation-complete, within the canonical
 *    word-count range and structurally valid; otherwise the snapshot is
 *    restored and the candidate discarded.
 * 3. Unresolved coherence damage or an out-of-range word count after the
 *    bounded fallback remains a hard failure: it throws and blocks saving
 *    with zero database writes. Coherence failures are never converted into
 *    warnings.
 */
export async function runFinalTrimStage(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  const stageBaseline = createArticleIntegrityBaseline(preHtml);
  const initialWordCount = countCanonicalVisibleWords(state.articleDoc);
  const preTrimCoherence = validateCoherence(state.articleDoc);
  const trace = state.debugTrace;
  const traceCtx = trace ? traceContextFor(state) : undefined;
  trace?.beginStage("final-trim", snap.articleDoc, traceCtx!);
  traceKeyphraseDensity("final-trim:before", state);
  logTrimCoherenceDiagnostics("preTrimCoherenceViolations", preTrimCoherence);
  if (initialWordCount <= state.wordMax) {
    console.log(`[final-trim] skipped (wc=${initialWordCount} <= ${state.wordMax})`);
    logTrimCoherenceDiagnostics("postTrimCoherenceViolations", preTrimCoherence);
    logTrimCoherenceDiagnostics("newTrimIntroducedViolations", []);
    trace?.endStage("final-trim", state.articleDoc, traceCtx!, true, false);
    recordStage(state, "final-trim", inputFp, inputFp, true, undefined, {
      skipped: true,
      reason: "within-max",
      preTrimCoherenceViolations: preTrimCoherence,
      postTrimCoherenceViolations: preTrimCoherence,
      newTrimIntroducedViolations: [],
    });
    return state;
  }

  const research = deps.context?.research || [];
  let totalRemoved = 0;

  // 1. Structure-aware deterministic compression.
  const compression = compressDocumentStructureAware(
    state.articleDoc,
    state.wordMax,
    state.wordMin,
    state.keyphrase,
    research,
  );
  totalRemoved += compression.removedWords;
  syncBlogFromDocument(state);
  console.log(
    `[final-trim] structure-aware removed=${compression.removedWords}` +
    ` paragraphs=${compression.removedParagraphs}` +
    ` shortened=${compression.shortenedSentences}` +
    ` remainingExcess=${compression.remainingExcess}`,
  );

  let coherence = validateCoherence(state.articleDoc);
  const deterministicPostTrimCoherence = coherence;
  const newTrimIntroduced = newlyIntroducedCoherenceViolations(preTrimCoherence, coherence);
  logTrimCoherenceDiagnostics("postTrimCoherenceViolations", deterministicPostTrimCoherence);
  logTrimCoherenceDiagnostics("newTrimIntroducedViolations", newTrimIntroduced);
  let finalWordCount = countCanonicalVisibleWords(state.articleDoc);

  if (coherence.length > 0) {
    // 2a. Restore only when deterministic trimming introduced a new violation.
    //     Pre-existing violations are reported accurately and repaired from
    //     the current coherent-as-possible deterministic candidate.
    const affectedSectionIds = [...new Set(coherence.map((violation) => violation.componentId))];
    if (newTrimIntroduced.length > 0) {
      restoreSnapshot(state, snap);
      syncBlogFromDocument(state);
      totalRemoved = 0;
      console.log(
        `[final-trim] deterministic trim rejected`+
        ` (${newTrimIntroduced.length} newly introduced coherence violation(s):`+
        ` ${newTrimIntroduced[0].type} in ${newTrimIntroduced[0].componentId})` +
        ` — rollback=success; compacting affected sections: ${affectedSectionIds.join(", ")}`,
      );
    } else {
      console.log(
        `[final-trim] deterministic trim did not introduce the ${coherence.length}`+
        ` pre-existing coherence violation(s); compacting affected sections: ${affectedSectionIds.join(", ")}`,
      );
    }
    for (const sectionId of affectedSectionIds.slice(0, 3)) {
      const compaction = await runBoundedSectionCompaction(state, deps, { targetSectionIds: [sectionId] });
      if (compaction.accepted) totalRemoved += compaction.removedWords;
    }
    syncBlogFromDocument(state);
    finalWordCount = countCanonicalVisibleWords(state.articleDoc);
    coherence = validateCoherence(state.articleDoc);
  } else if (finalWordCount > state.wordMax) {
    // 2b. Still over the maximum with a clean deterministic result: one
    //     bounded compaction of the largest section.
    const compaction = await runBoundedSectionCompaction(state, deps);
    if (compaction.accepted) totalRemoved += compaction.removedWords;
    finalWordCount = countCanonicalVisibleWords(state.articleDoc);
    syncBlogFromDocument(state);
    coherence = validateCoherence(state.articleDoc);
  }
  logTrimCoherenceDiagnostics("finalCoherenceViolations", coherence);

  // 3. Post-trim gate: unresolved coherence damage or an out-of-range word
  //    count after the bounded fallback blocks saving.
  if (coherence.length > 0) {
    console.error(
      `[final-trim] ${coherence.length} coherence violation(s) after trimming and bounded compaction:\n` +
      coherenceViolationSummary(coherence).join("\n"),
    );
    trace?.endStage("final-trim", state.articleDoc, traceCtx!, false, true);
    throw new Error(
      `Coherence violations after final trim: ${coherence.length}` +
      ` (first=${coherence[0].type} in ${coherence[0].componentId})`,
    );
  }
  if (finalWordCount > state.wordMax || finalWordCount < state.wordMin) {
    console.error(
      `[final-trim] word count ${finalWordCount} outside ${state.wordMin}-${state.wordMax} after trimming and bounded compaction`,
    );
    trace?.endStage("final-trim", state.articleDoc, traceCtx!, false, true);
    throw new Error(
      `Final trim could not reach the word-count range: ${finalWordCount} (target ${state.wordMin}-${state.wordMax})`,
    );
  }

  // 4. Density-aware acceptance: trimming removes non-keyphrase words, which
  //    raises keyphrase density. A trim candidate that crosses the hard 3%
  //    stuffing limit must be resolved deterministically right here, before
  //    the trimmed output is accepted — never handed downstream unresolved.
  //    When no safe correction exists the complete pre-trim snapshot is
  //    restored and the trim fails closed (blocks saving).
  const densityReconcile = reconcileFinalKeyphraseDensity(
    state.articleDoc,
    state.keyphrase,
    research,
    deps.context?.claimOwnership,
    state.wordMin,
    state.wordMax,
  );
  if (!densityReconcile.accepted) {
    trace?.endStage("final-trim", state.articleDoc, traceCtx!, false, true);
    restoreSnapshot(state, snap);
    syncBlogFromDocument(state);
    console.error(
      `[final-trim] density resolution failed — rollback=success` +
      ` reason=${densityReconcile.rejectionReasons.join("; ")}` +
      ` restoredFp=${fp(state.blog)}`,
    );
    throw new Error(
      `Final trim created unresolvable keyphrase density: ` +
      `${densityReconcile.rejectionReasons.join("; ")}`,
    );
  }
  if (densityReconcile.applied) {
    syncBlogFromDocument(state);
    totalRemoved += densityReconcile.removedWords;
    finalWordCount = countCanonicalVisibleWords(state.articleDoc);
    console.log(
      `[final-trim] density reconcile removed=${densityReconcile.removedSentences} sentence(s)` +
      ` (${densityReconcile.removedWords} words) ` +
      `density=${densityReconcile.densityBefore.toFixed(2)}% → ${densityReconcile.densityAfter.toFixed(2)}%`,
    );
  }
  // Stage-aware integrity contract: final trim legitimately owns word count,
  // malformed/sentence quality (pass-0 residue purge), SEO density and
  // coherence; it must never damage FAQ parity, links, facts, ownership,
  // protected content or WordPress structure — otherwise the exact pre-trim
  // snapshot is restored and the pipeline fails closed.
  enforceIntegrityContract(
    state,
    deps,
    snap,
    new Set<ContractCategory>([
      "malformed",
      "sentence-quality",
      "word-count",
      "seo",
      "coherence",
    ]),
    "final-trim",
  );
  traceKeyphraseDensity("final-trim:after", state);

  if (totalRemoved > 0) {
    console.log(
      `[final-trim] total removed=${totalRemoved} final wc=${finalWordCount} target=${state.wordMax}`,
    );
  } else {
    console.log(`[final-trim] no safe content removed — excess=${initialWordCount - state.wordMax}`);
  }

  // Record the stage with the true pre-trim fingerprint; restore the snapshot
  // if the integrity guard rejects the trimmed output.
  const guard = guardStageOutput(state.blog, preHtml, stageBaseline, "final-trim");
  if (!guard.accepted) {
    restoreSnapshot(state, snap);
    syncBlogFromDocument(state);
  }
  assertRenderedCacheMatchesDocument(state);
  const outputFp = fp(state.blog);
  trace?.endStage("final-trim", state.articleDoc, traceCtx!, guard.accepted, !guard.accepted);
  recordStage(
    state,
    "final-trim",
    inputFp,
    outputFp,
    guard.accepted,
    guard.accepted ? undefined : "pre-stage-restore",
    {
      preTrimCoherenceViolations: preTrimCoherence,
      postTrimCoherenceViolations: deterministicPostTrimCoherence,
      newTrimIntroducedViolations: newTrimIntroduced,
      finalCoherenceViolations: coherence,
    },
  );
  return state;
}

async function runInternalLinks(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  let skipReason = "no-links-to-inject";
  let diagnostic: string | undefined;
  try {
    const { seedDefaultLinks } = await import("@/lib/services/default-links");
    const { injectLinks } = await import("@/lib/services/link-injector");
    await seedDefaultLinks(state.userId);
    const result = await injectLinks(state.blog, state.userId);
    if (result.linksInjected > 0) {
      state = runTrackedHtmlStage(state, "internal-links", (html) => result.modifiedContent, snap);
      // Stage-aware integrity contract: link injection owns link changes only;
      // every other invariant must hold or the exact snapshot is restored.
      enforceIntegrityContract(state, deps, snap, new Set<ContractCategory>(["links", "word-count"]), "internal-links");
      return state;
    }
  } catch (err) {
    skipReason = "link-injection-failed";
    diagnostic = err instanceof Error ? err.message : String(err);
    state.warnings.push(`Internal-link injection failed and was skipped: ${diagnostic}`);
    console.warn(
      `[internal-links] candidate=link-injection pass=false reason=${skipReason}`+
      ` rollback=not-needed recoverable=true diagnostic="${diagnostic.replace(/[\r\n]+/g, " ").slice(0, 240)}"`,
    );
  }
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  recordStage(state, "internal-links", inputFp, inputFp, true, undefined, {
    skipped: true,
    reason: skipReason,
    ...(diagnostic ? { diagnostic } : {}),
  });
  return state;
}

async function runSeoNormalization(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  let skipReason = "normalization-rejected";
  let diagnostic: string | undefined;
  try {
    const result = await normalizeFinalSeo(
      {
        html: state.blog,
        focusKeyphrase: state.keyphrase,
        targetWordCount: state.requestedWordCount,
        targetKeyphraseCount: state.exactKeyphraseTarget,
        minReadingEase: FLESCH_MIN,
        maxReadingEase: FLESCH_MAX,
        canonicalVisibleWordCount: countCanonicalVisibleWords(state.articleDoc),
      },
      deps.chatWithRetry as any,
    );
    console.log(
      `[seo-normalization] canonicalWords=${countCanonicalVisibleWords(state.articleDoc)}` +
      ` candidateWords=${result.after.readableWordCount}` +
      ` faqEntries=${state.articleDoc.visibleFaq.length}`,
    );
    const accepted = shouldAcceptSeoNormalization(result);
    state.normalizationResult = result;
    state.normalizationAccepted = accepted;

    const candidateAfter = result.after;
    const candidateDensity = typeof candidateAfter?.keyphraseDensity === "number"
      ? candidateAfter.keyphraseDensity.toFixed(2)
      : "?";
    console.log(
      `[kp-density] seo-normalization:candidate wc=${candidateAfter?.readableWordCount ?? "?"}` +
      ` occ=${candidateAfter?.exactKeyphraseCount ?? "?"}` +
      ` density=${candidateDensity}%` +
      ` accepted=${accepted} reasons=${result.passed ? "none" : "see [SEO-NORMALIZER] log"}`,
    );

    if (accepted) {
      const committed = runTrackedHtmlStage(state, "seo-normalization", (html) => result.html, snap);
      traceKeyphraseDensity("seo-normalization:accepted", state);
      return committed;
    }
    traceKeyphraseDensity("seo-normalization:rejected(restored)", state);
  } catch (error) {
    state.normalizationResult = null;
    state.normalizationAccepted = false;
    skipReason = "normalization-failed";
    diagnostic = error instanceof Error ? error.message : String(error);
    console.warn(
      `[seo-normalization] candidate=normalization pass=false reason=${skipReason}`+
      ` rollback=not-needed recoverable=true diagnostic="${diagnostic.replace(/[\r\n]+/g, " ").slice(0, 240)}"`,
    );
  }
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  recordStage(state, "seo-normalization", inputFp, inputFp, true, undefined, {
    skipped: true,
    reason: skipReason,
    ...(diagnostic ? { diagnostic } : {}),
  });
  return state;
}

export function runFinalValidation(state: PipelineState): { passed: boolean; reasons: string[] } {
  const canonicalWordCount = state.articleDoc
    ? countCanonicalVisibleWords(state.articleDoc)
    : undefined;
  const metrics = analyzeFinalArticle(
    state.blog,
    state.keyphrase,
    state.title,
    state.metaDescription,
    state.requestedWordCount,
    canonicalWordCount,
    {
      articleDoc: state.articleDoc,
      research: state.ctx?.research || [],
      claimOwnership: state.ctx?.claimOwnership,
      referenceDate: state.ctx?.generationDate ? new Date(state.ctx.generationDate) : new Date(),
      fullDocumentEditorial: state.fullDocumentEditorial,
    },
  );
  const policy = buildPolicy(state.requestedWordCount, state.wordMin, state.wordMax, state.keyphrase);
  const result = evaluatePolicy(metrics, policy);
  if (state.articleDoc) {
    const density = canonicalKeyphraseMetrics(state.articleDoc, state.keyphrase);
    console.log(
      `[kp-density] final-validation wc=${density.wordCount} occ=${density.occurrences}` +
      ` density=${density.density.toFixed(2)}%` +
      ` gateDensity=${metrics.keyphraseDensity.toFixed(2)}%` +
      ` passed=${result.passed} fp=${fp(state.blog)}`,
    );
  }
  if (!result.passed && state.articleDoc) {
    const languageViolations = scanEnglishLanguageConsistency(state.articleDoc);
    if (languageViolations.length > 0) {
      console.error(
        `[final-validation] ${languageViolations.length} language-consistency violation(s):\n` +
        formatLanguageConsistencyViolations(languageViolations).join("\n"),
      );
    }
  }
  return result;
}

/**
 * Development-only diagnostic artifact for articles that fail final validation
 * solely on editorial quality. Enabled only by DEBUG_EDITORIAL=true; never
 * writes to Supabase and never persists as a blog version. The failed article
 * would otherwise be discarded, making the exact repeated pairs impossible to
 * inspect. Credentials and research payloads are never included.
 */
export function writeEditorialFailureArtifact(
  state: PipelineState,
  context: {
    preEditorialHtml: string;
    preEditorialMetrics: FinalArticleMetrics;
    rejectedEditorialCandidates: Array<{ stage: string; accepted: boolean; reason: string; score: number }>;
    finalReasons: string[];
  },
): void {
  try {
    const finalMetrics = analyzeFinalArticle(
      state.blog,
      state.keyphrase,
      state.title,
      state.metaDescription,
      state.requestedWordCount,
      countCanonicalVisibleWords(state.articleDoc),
    );
    const pairs = findRepetitionPairTargets(state.articleDoc).map((target) => {
      const aFlags = repetitionPairSurfaceFlags(
        state.articleDoc,
        {
          componentKind: target.preserveComponentKind,
          componentId: target.preserveComponentId,
          blockId: target.preserveBlockId,
          text: target.preserveText,
        },
        state.keyphrase,
      );
      const bFlags = repetitionPairSurfaceFlags(
        state.articleDoc,
        {
          componentKind: target.componentKind,
          componentId: target.componentId,
          blockId: target.blockId,
          text: target.text,
        },
        state.keyphrase,
      );
      return {
        a: `${target.preserveComponentKind}:${target.preserveComponentId}:${target.preserveBlockId}`,
        b: `${target.componentKind}:${target.componentId}:${target.blockId}`,
        overlap: target.overlap,
        duplicatedIdea: target.duplicatedIdea,
        aKeyphrase: aFlags.keyphrase,
        bKeyphrase: bFlags.keyphrase,
        aNumbers: aFlags.numbers,
        bNumbers: bFlags.numbers,
        aText: target.preserveText.slice(0, 180),
        bText: target.text.slice(0, 180),
      };
    });
    const artifact = {
      createdAt: new Date().toISOString(),
      title: state.title,
      keyphrase: state.keyphrase,
      requestedWordCount: state.requestedWordCount,
      preEditorialScore: context.preEditorialMetrics.editorialScore ?? 100,
      preEditorialBreakdown: {
        malformed: context.preEditorialMetrics.malformedProseCount ?? 0,
        repeatedPairs: context.preEditorialMetrics.repeatedIdeaPairCount ?? 0,
        robotic: context.preEditorialMetrics.roboticPhraseCount ?? 0,
        conclusionRatio: context.preEditorialMetrics.conclusionWordRatio ?? 0,
      },
      finalScore: finalMetrics.editorialScore ?? 100,
      finalBreakdown: {
        malformed: finalMetrics.malformedProseCount ?? 0,
        repeatedPairs: finalMetrics.repeatedIdeaPairCount ?? 0,
        robotic: finalMetrics.roboticPhraseCount ?? 0,
        conclusionRatio: finalMetrics.conclusionWordRatio ?? 0,
      },
      finalReasons: context.finalReasons,
      repeatedPairs: pairs,
      rejectedCandidates: context.rejectedEditorialCandidates,
      roboticMatches: extractRoboticPhraseMatches(state.blog),
      malformedFindings: findMalformedEditableBlocks(state.articleDoc).map((block) => ({
        blockId: block.blockId,
        issues: block.issues,
      })),
      preEditorialHtml: context.preEditorialHtml,
      postTargetedRepairsHtml: state.blog,
    };
    const dir = path.join(process.cwd(), "debug");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `editorial-failure-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2), "utf8");
    console.log(`[editorial-failure-artifact] written to ${file}`);
  } catch (error) {
    console.warn(
      `[editorial-failure-artifact] could not write artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
