// ── Canonical blog generation pipeline ──
// All post-assembly stages extracted from route.ts.
// route.ts handles auth, section generation, initial assembly, then delegates here.
//
// ArticleDocument is the single canonical mutable source.
// state.blog is ONLY assigned by syncBlogFromDocument() — never directly.
// No stage treats raw HTML as independently canonical.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, parseArticleDocumentFromHtml, renderComponentHtml, parseWordPressEditorialBlocks, countCanonicalVisibleWords, extractVisibleFaqFromArticle, validateFaqParity } from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { type FinalSeoNormalizerResult } from "@/lib/blog/final-seo-normalizer";
import { normalizeFinalSeo } from "@/lib/blog/final-seo-normalizer";
import {
  createArticleIntegrityBaseline,
  validateFinalArticleIntegrity,
  validateWordpressBlockPairs,
  type ArticleIntegrityBaseline,
} from "@/lib/blog/article-integrity";
import type { FinalArticlePolicy, FinalArticleMetrics } from "@/lib/blog/final-article-policy";
import { buildPolicy, analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { extractReadableText, getFirstNReadableWords, extractH2Texts, extractParagraphTexts, countSentences, countCtaHeadingTags, countReadableWords, containsExactPhrase } from "@/lib/seo/seo-text-utils";
import { FLESCH_MAX, FLESCH_MIN, GENERATION_WORD_BUFFER, MAX_SENTENCES_PER_PARAGRAPH, WORD_ALLOCATION } from "@/lib/services/generation-constants";
import { insertExternalResearchLinks, deduplicateEditorialExternalLinks, pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";
import { expandToMinimum, trimToMaximum, normalizeParagraphs } from "@/lib/services/section-expander";
import {
  runEditorialPolish,
  isEditorialPolishEnabled,
  extractEditableBlocks,
  findMalformedEditableBlocks,
  findProseOnlyEditableBlockIds,
  findRepeatedEditableBlockIds,
  findWeakenedEditableBlockIds,
  repairDeterministicMalformedProse,
  type EditorialPolishMode,
} from "@/lib/pipeline/editorial-polish";
import { runComponentRegeneration, regenerateConclusion, regenerateSection } from "@/lib/services/component-regenerator";
import { scanFactualRisks, removeUnsupportedSentences, formatClaimLog } from "@/lib/blog/factual-risk-scanner";
import { enforceInternalLinkLimit } from "@/lib/blog/final-article-policy";
import { trimConclusionToBudget } from "@/lib/blog/publication-quality";
import {
  enforceClaimOwnership,
  formatOwnedEvidencePacket,
  validateClaimOwnership,
} from "@/lib/blog/claim-ownership";
import { repairTemporalFreshnessDocument, findTemporalFreshnessIssues } from "@/lib/blog/temporal-freshness";

const CANONICAL_CTA_HTML = `<!-- wp:html -->
<div style="background: #1E3A8A; color: #fff; padding: 32px 28px; border-radius: 12px; margin: 40px 0; text-align: center;">
  <h2 style="color: #fff; margin-top: 0; font-size: 22px;">Ready to grow your brand with Hong Kong creators?</h2>
  <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px;">B2I Hub connects businesses directly with verified creators — no agencies, no commissions, no middlemen. Create your free profile and start collaborating today.</p>
  <a href="https://app.b2ihub.com/signup" style="display: inline-block; background: #F97316; color: #fff; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;" target="_blank" rel="noopener">Create Your Free Profile →</a>
</div>
<!-- /wp:html -->`;

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

/** THE ONLY place state.blog is assigned. No other code may assign state.blog directly. */
function syncBlogFromDocument(state: PipelineState): void {
  state.blog = renderArticleDocument(state.articleDoc);
  state.faq = state.articleDoc.visibleFaq.map((entry) => ({
    question: entry.question,
    answer: entry.answerText,
  }));
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

/** SEO normalization runs before canonical CTA restoration, so a missing CTA at
 * this stage must not discard an otherwise valid normalized article. */
export function shouldAcceptSeoNormalization(result: FinalSeoNormalizerResult): boolean {
  const safety = result.safety;
  return result.passed === true
    && safety.protectedBlocksUnchanged
    && safety.linkDestinationsUnchanged
    && safety.wordpressBlocksValid
    && safety.faqSchemaPreserved
    && safety.languageSwitcherPreserved;
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
  workingDoc: ArticleDocument;
  targetedRepairsDoc: ArticleDocument | null;
  accepted: boolean;
}): { doc: ArticleDocument; targetedRepairsPersisted: boolean } {
  if (params.accepted) return { doc: params.workingDoc, targetedRepairsPersisted: false };
  if (params.targetedRepairsDoc) return { doc: params.targetedRepairsDoc, targetedRepairsPersisted: true };
  return { doc: params.workingDoc, targetedRepairsPersisted: false };
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
): {
  entries: ArticleDocument["visibleFaq"];
  unsupportedSentencesRemoved: number;
  citationsAdded: number;
} {
  let unsupportedSentencesRemoved = 0;
  const citationsAdded = 0;

  const sanitized = entries.map((entry, index) => {
    const paragraphHtml =
      `<!-- wp:paragraph --><p>${escapeHtmlText(entry.answerText)}</p><!-- /wp:paragraph -->`;
    const initialRisk = scanFactualRisks(paragraphHtml, keyphrase, research);
    const cleanup = removeUnsupportedSentences(paragraphHtml, initialRisk.claims);
    unsupportedSentencesRemoved += cleanup.sentencesRemoved;

    const remainingClaims = scanFactualRisks(
      cleanup.html,
      keyphrase,
      research,
    ).claims;
    if (remainingClaims.length > 0) {
      throw new Error(
        `Precise factual claim could not be removed safely from synthesis-only FAQ ${index + 1}: ` +
        remainingClaims[0].text,
      );
    }

    let answerText = extractReadableText(cleanup.html).trim();
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
  const parsed = parseWordPressEditorialBlocks(html, component.id);
  component.blocks = parsed.blocks;
  if (status) component.status = status;
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
  const issues: string[] = [...result.errors];
  for (const wpIssue of wpPairResult.issues) issues.push(wpIssue);
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

// ── State snapshot (articleDoc is the canonical source) ──

interface PipelineSnapshot {
  articleDoc: string;
  title: string;
  metaDescription: string;
  currentWordCount: number;
  expansionAttempts: number;
  trimAttempts: number;
  retryCount: number;
  componentRegenerations: number;
  normalizationResult: any;
  normalizationAccepted: boolean;
}

function snapshotState(state: PipelineState): PipelineSnapshot {
  return {
    articleDoc: JSON.stringify(state.articleDoc),
    title: state.title,
    metaDescription: state.metaDescription,
    currentWordCount: state.currentWordCount,
    expansionAttempts: state.expansionAttempts,
    trimAttempts: state.trimAttempts,
    retryCount: state.retryCount,
    componentRegenerations: state.componentRegenerations,
    normalizationResult: state.normalizationResult,
    normalizationAccepted: state.normalizationAccepted,
  };
}

function restoreSnapshot(state: PipelineState, snap: PipelineSnapshot): void {
  state.articleDoc = JSON.parse(snap.articleDoc);
  syncBlogFromDocument(state);
  state.title = snap.title;
  state.metaDescription = snap.metaDescription;
  state.currentWordCount = snap.currentWordCount;
  state.expansionAttempts = snap.expansionAttempts;
  state.trimAttempts = snap.trimAttempts;
  state.retryCount = snap.retryCount;
  state.componentRegenerations = snap.componentRegenerations;
  state.normalizationResult = snap.normalizationResult;
  state.normalizationAccepted = snap.normalizationAccepted;
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

function runTrackedHtmlStage(state: PipelineState, stageName: string, fn: (html: string) => string, preSnapshot?: PipelineSnapshot): PipelineState {
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  const stageBaseline = createArticleIntegrityBaseline(preHtml);
  const snap = preSnapshot ?? snapshotState(state);

  assertValidStageInput(preHtml, stageBaseline, stageName);

  const resultHtml = fn(state.blog);

  // Parse back to ArticleDocument. If parsing fails, restore snapshot.
  if (!applyHtmlToDocument(state, resultHtml, state.articleDoc)) {
    console.warn(`[PIPELINE:${stageName}] HTML-to-document parse failed — restoring pre-stage state`);
    restoreSnapshot(state, snap);
    recordStage(state, stageName, inputFp, inputFp, false, "parse-failure");
    return state;
  }

  const guard = guardStageOutput(state.blog, preHtml, stageBaseline, stageName);
  if (!guard.accepted) {
    restoreSnapshot(state, snap);
  }
  assertRenderedCacheMatchesDocument(state);
  const outputFp = fp(state.blog);
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
  };
}

export function validatePipelineOrder(state: PipelineState): Array<{ code: string; message: string; stage: string }> {
  const issues: Array<{ code: string; message: string; stage: string }> = [];
  const stages = state.stageOutputs.map((s) => s.stage);
  const required = [
    "claim-check", "expansion", "trim", "paragraphs", "regeneration",
    "seo-normalization", "title-repair", "factual-scan", "claim-ownership", "temporal-freshness",
    "post-factual-keyphrase", "paragraphs-final", "malformed-prose-repair", "claim-ownership-final",
    "language-switcher", "internal-links", "external-links", "external-dedup",
    "link-enforce", "factual-final", "cta-preserve", "final-trim",
    "faq-recovery", "wc-check", "final-preflight", "final-validation",
  ];
  if (isEditorialPolishEnabled()) {
    required.push("conclusion-discipline", "editorial-polish");
  }
  for (const req of required) {
    if (!stages.includes(req)) issues.push({ code: "MISSING_STAGE", message: `Required stage "${req}" not found`, stage: req });
  }
  const expectedOrder = [
    "claim-check",
    ...(isEditorialPolishEnabled() ? ["conclusion-discipline"] : []),
    "expansion", "trim", "paragraphs", "regeneration", "seo-normalization",
    "title-repair", "factual-scan", "claim-ownership", "temporal-freshness", "post-factual-keyphrase",
    "paragraphs-final", "malformed-prose-repair",
    ...(isEditorialPolishEnabled() ? ["editorial-polish"] : []),
    "claim-ownership-final", "language-switcher", "internal-links", "external-links",
    "external-dedup", "link-enforce", "factual-final", "cta-preserve",
    "final-trim", "faq-recovery", "wc-check", "final-preflight", "final-validation",
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
  if (after.readableWordCount < state.wordMin || after.readableWordCount > state.wordMax) {
    reasons.push(`word count=${after.readableWordCount} (range: ${state.wordMin}-${state.wordMax})`);
  }
  return reasons;
}

function runTemporalFreshnessStage(
  state: PipelineState,
  deps: PipelineDependencies,
): PipelineState {
  const inputFingerprint = fp(state.blog);
  const snap = snapshotState(state);
  const referenceDate = deps.context?.generationDate
    ? new Date(deps.context.generationDate)
    : new Date();
  const initialIssues = findTemporalFreshnessIssues(state.articleDoc, referenceDate);

  if (initialIssues.length === 0) {
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
    restoreSnapshot(state, snap);
    recordStage(state, "temporal-freshness", inputFingerprint, inputFingerprint, false, "pre-stage-restore", {
      detected: initialIssues.length,
      rewrittenSentences: repair.rewrittenSentences,
      removedSentences: repair.removedSentences,
      changedComponentIds: repair.changedComponentIds,
      reasons,
    });
    throw new Error(
      `Temporal freshness repair was rejected without changing the working article: ${reasons.join("; ")}`,
    );
  }

  recordStage(state, "temporal-freshness", inputFingerprint, fp(state.blog), true, undefined, {
    detected: initialIssues.length,
    rewrittenSentences: repair.rewrittenSentences,
    removedSentences: repair.removedSentences,
    changedComponentIds: repair.changedComponentIds,
  });
  console.log(
    `[temporal-freshness] detected=${initialIssues.length}` +
    ` rewritten=${repair.rewrittenSentences}` +
    ` removed=${repair.removedSentences}` +
    ` accepted=true`,
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
  state.baseline = createArticleIntegrityBaseline(state.blog);
  state.stageOutputs.push({ stage: "assembly", inputFingerprint: fp(state.blog), outputFingerprint: fp(state.blog), accepted: true });

  state = await runClaimCheck(state, deps);
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
  state = runTrackedHtmlStage(state, "title-repair", (html) => {
    const titleOk = state.title.length >= 40 && state.title.length <= 70 && containsExactPhrase(state.title, state.keyphrase);
    if (titleOk) return html;

    // One deterministic attempt: prepend keyphrase if missing and within length
    if (!containsExactPhrase(state.title, state.keyphrase)) {
      const titlePhrase = state.keyphrase.charAt(0).toUpperCase() + state.keyphrase.slice(1);
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
      const cleanup = removeUnsupportedSentences(componentHtmlBefore, unsupported);
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
    );
    state.articleDoc.visibleFaq = faqCleanup.entries;
    if (faqCleanup.unsupportedSentencesRemoved > 0 || faqCleanup.citationsAdded > 0) {
      repaired = true;
      console.log(
        `[factual-scan:faq] removed ${faqCleanup.unsupportedSentencesRemoved} precise factual sentence(s)`,
      );
    }
    if (repaired) syncBlogFromDocument(state);
    return state.blog;
  });

  // Approved evidence is now assigned to one authoritative section. This
  // deterministic stage removes every supported occurrence outside its owner
  // and keeps only the strongest occurrence inside the owner. It runs before
  // links so sentence removal is never blocked by a newly injected anchor.
  state = runTrackedHtmlStage(state, "claim-ownership", () => {
    const research = deps.context?.research || [];
    const ledger = deps.context?.claimOwnership;
    if (!ledger || ledger.entries.length === 0) return state.blog;
    const repair = enforceClaimOwnership(state.articleDoc, ledger, state.keyphrase, research);
    for (const componentId of repair.changedComponentIds) weakenedComponentIds.add(componentId);
    if (repair.unresolved.length > 0) {
      const first = repair.unresolved[0];
      state.warnings.push(
        `Claim ownership repair could not safely remove ${first.evidenceId} from ${first.componentId}`,
      );
    }
    syncBlogFromDocument(state);
    const violations = validateClaimOwnership(state.articleDoc, ledger, state.keyphrase, research);
    if (violations.length > 0) {
      const first = violations[0];
      state.warnings.push(
        `Claim ownership violation remains: ${first.evidenceId} in ${first.componentId} (${first.reason})`,
      );
    }
    console.log(
      `[claim-ownership] removed=${repair.removedSentences} outside-owner=${repair.removedOutOfOwnerOccurrences}` +
      ` duplicate-owned=${repair.removedDuplicateOccurrences}`,
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
  {
    const inputFingerprint = fp(state.blog);
    const deterministic = repairDeterministicMalformedProse(
      state.articleDoc,
      state.wordMin,
      protectedSentencesByBlockId,
    );
    syncBlogFromDocument(state);
    recordStage(
      state,
      "malformed-prose-repair",
      inputFingerprint,
      fp(state.blog),
      true,
      undefined,
      {
        repairedBlockIds: deterministic.repairedBlockIds,
        removedBlockIds: deterministic.removedBlockIds,
        unresolvedBlockIds: deterministic.unresolved.map((issue) => issue.blockId),
      },
    );
    if (deterministic.repairedBlockIds.length > 0 || deterministic.removedBlockIds.length > 0) {
      console.log(
        `[malformed-prose-repair] deterministic repaired=${deterministic.repairedBlockIds.length}` +
        ` removed=${deterministic.removedBlockIds.length}` +
        ` unresolved=${deterministic.unresolved.length}`,
      );
    }
  }

  // Editorial polish: improves coherence, flow and natural language without
  // damaging structure, evidence, SEO, FAQ, CTA or schema. It runs before
  // application-owned link insertion so exact factual sentences remain safely
  // removable during the deterministic evidence stages.
  // validation decides whether the cloned candidate is committed atomically.
  if (isEditorialPolishEnabled()) {
    const inputFingerprint = fp(state.blog);
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
        const candidateHtml = renderArticleDocument(candidate);
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
        const hardReasons = evaluated.reasons.filter(
          (reason) => !reason.startsWith("repeated idea pairs=") && !reason.startsWith("editorial score="),
        );
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

    // Repetition repair runs only after malformed prose is clean. Otherwise its
    // candidate would be rejected for an unrelated pre-existing fragment.
    const unresolvedMalformed = findMalformedEditableBlocks(workingDoc);
    const repeatedBlockIds = unresolvedMalformed.length === 0
      ? findRepeatedEditableBlockIds(workingDoc)
          .filter((blockId) => !protectedBlockIds.includes(blockId))
      : [];
    if (repeatedBlockIds.length > 0) {
      repetitionResult = await runEditorialPolish(
        workingDoc,
        state.keyphrase,
        async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-repetition-repair"),
        {
          protectedBlockIds,
          editableBlockIds: repeatedBlockIds,
          protectedSentencesByBlockId,
          mode: "repetition",
          validateProductionCandidate: buildComparativeValidator(workingDoc, "repetition"),
        },
      );
      if (repetitionResult.result.accepted) {
        workingDoc = repetitionResult.doc;
        targetedRepairsDoc = workingDoc;
      }
    }

    const generalResult = await runEditorialPolish(
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
    const proseOnlyBlockIds = postGeneralEditorialScore < state.policy.minimumEditorialScore
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
      || generalResult.result.accepted
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
    // The general polish transaction is atomic: incremental general/prose-only
    // edits are not committed when the article still misses the production
    // threshold. Successfully repaired stable block IDs (malformed, weakened,
    // repetition) are still persisted so final validation never sees a
    // fragment that a targeted repair already fixed.
    const accepted = anyEditorialCandidateAccepted
      && finalEditorialScore >= state.policy.minimumEditorialScore;
    const commitDecision = chooseEditorialCommitDoc({ workingDoc, targetedRepairsDoc, accepted });
    const targetedRepairsPersisted = commitDecision.targetedRepairsPersisted;
    state.articleDoc = commitDecision.doc;
    if (accepted || targetedRepairsPersisted) syncBlogFromDocument(state);
    if (accepted) {
      console.log(
        `[editorial-polish] accepted: malformed=${malformedResult?.result.accepted === true}` +
        ` malformedFallback=${malformedFallbackApplied}` +
        ` weakened=${weakenedResult?.result.accepted === true}` +
        ` repetition=${repetitionResult?.result.accepted === true}` +
        ` general=${generalResult.result.accepted}` +
        ` proseOnly=${proseOnlyResult?.result.accepted === true}` +
        ` score=${finalEditorialScore}` +
        ` malformedRemaining=${findMalformedEditableBlocks(state.articleDoc).length}` +
        ` repeats=${findRepeatedEditableBlockIds(state.articleDoc).length}`,
      );
    } else {
      console.log(
        `[editorial-polish] rejected: ${generalResult.result.reason}` +
        (malformedResult ? `; malformed=${malformedResult.result.reason}` : "") +
        (weakenedResult ? `; weakened=${weakenedResult.result.reason}` : "") +
        (repetitionResult ? `; repetition=${repetitionResult.result.reason}` : "") +
        (proseOnlyResult ? `; proseOnly=${proseOnlyResult.result.reason}` : "") +
        (targetedRepairsPersisted
          ? `; targeted repairs persisted (malformed/weakened/repetition) despite score ${finalEditorialScore} < ${state.policy.minimumEditorialScore}; ` +
            `malformedRemaining=${findMalformedEditableBlocks(state.articleDoc).length}`
          : anyEditorialCandidateAccepted
            ? `; editorial score remains below minimum: ${finalEditorialScore} < ${state.policy.minimumEditorialScore}`
            : ""),
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
        repetitionBlockCount: repeatedBlockIds.length,
        general: generalResult.result,
        proseOnly: proseOnlyResult?.result ?? null,
        proseOnlyBlockCount: proseOnlyBlockIds.length,
        finalEditorialScore,
        minimumEditorialScore: state.policy.minimumEditorialScore,
        targetedRepairsPersisted,
      },
    );
  }

  // The editor is never allowed to change ownership. This is a confirmation
  // gate only; it does not silently repair a rejected editorial candidate.
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
      const first = violations[0];
      state.warnings.push(
        `Editorial claim ownership confirmation found ${violations.length} violation(s); ` +
        `first=${first.evidenceId} in ${first.componentId} (${first.reason})`,
      );
    }
    return html;
  });

  // Application-owned navigation and links run only after factual and
  // editorial content is settled, so anchors cannot make a bad factual
  // sentence undeletable earlier in the pipeline.
  state = runTrackedHtmlStage(state, "language-switcher", () => {
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
    return state.blog;
  });

  state = await runInternalLinks(state, deps);

  state = runTrackedHtmlStage(state, "external-links", (html) => {
    const researchItems = deps.context?.research || [];
    if (researchItems.length === 0) return html;
    return insertExternalResearchLinks(html, researchItems, 6).html;
  });

  state = runTrackedHtmlStage(state, "external-dedup", (html) =>
    deduplicateEditorialExternalLinks(html).html,
  );

  state = runTrackedHtmlStage(state, "link-enforce", (html) => {
    const result = enforceInternalLinkLimit(html, 4);
    console.log(`[link-enforce] retained=${result.retained.length} removed=${result.removed.length}`);
    return result.html;
  });

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
      const first = ownershipViolations[0];
      state.warnings.push(
        `Final claim ownership confirmation found ${ownershipViolations.length} violation(s); ` +
        `first=${first.evidenceId} (${first.reason})`,
      );
    }
    return html;
  });


  // CTA preservation: the editor cannot target the CTA, and this deterministic
  // stage still verifies that exactly one canonical signup CTA remains.
  // Ensures exactly one CTA block with one CTA heading and one signup URL.
  // If the CTA is missing or damaged, sets it on the canonical ArticleDocument
  // and re-renders — avoiding fragile HTML string surgery that can break WP blocks.
  state = runTrackedHtmlStage(state, "cta-preserve", (html) => {
    const signupCount = (html.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
    const headingCount = countCtaHeadingTags(html);
    const ctaOk = signupCount === 1 && headingCount >= 1;
    if (ctaOk) return html;

    console.log(`[cta-preserve] CTA check failed: signup=${signupCount} headings=${headingCount} — re-injecting`);

    // Set CTA on the canonical ArticleDocument and re-render.
    // renderArticleDocument() places CTA at the correct position
    // (after FAQ schema, as the final visible block). No HTML surgery needed.
    state.articleDoc.cta = {
      id: "cta",
      type: "cta",
      html: CANONICAL_CTA_HTML,
      fingerprint: fingerprintHtml(CANONICAL_CTA_HTML),
    };
    syncBlogFromDocument(state);
    return state.blog;
  });

  // Deterministic final trim. This can only remove complete, unlinked paragraph
  // blocks from editable H2 sections; it never slices prose or touches protected
  // blocks. All article-level measurements use the canonical document counter.
  state = runTrackedHtmlStage(state, "final-trim", (html) => {
    const initialWordCount = countCanonicalVisibleWords(state.articleDoc);
    if (initialWordCount <= state.wordMax) {
      console.log(`[final-trim] skipped (wc=${initialWordCount} <= ${state.wordMax})`);
      return html;
    }

    const excess = initialWordCount - state.wordMax;
    let totalRemoved = 0;
    const maxPasses = Math.min(8, Math.ceil(excess / 100) + 1);

    for (let pass = 0; pass < maxPasses; pass++) {
      const currentWordCount = countCanonicalVisibleWords(state.articleDoc);
      if (currentWordCount <= state.wordMax) break;

      const stillExcess = currentWordCount - state.wordMax;
      const editableSections = state.articleDoc.sections.filter(
        (section) => section.sectionType !== "faq-heading"
          && section.sectionType !== "conclusion-heading",
      );
      const targetPerPass = Math.max(
        30,
        Math.ceil(stillExcess / Math.max(1, editableSections.length)),
      );
      let passRemoved = 0;

      for (let index = 0; index < state.articleDoc.sections.length; index++) {
        if (passRemoved >= targetPerPass * 1.5) break;

        const section = state.articleDoc.sections[index];
        if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") {
          continue;
        }

        const sectionHtml = componentHtml(section);
        if (sectionHtml.length < 100) continue;
        const sectionWordCount = countReadableWords(sectionHtml);
        if (sectionWordCount < 80) continue;

        const paragraphBlocks = sectionHtml.match(
          /<!--\s*wp:paragraph\s*-->\s*\n?<p>[\s\S]*?<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi,
        );
        if (!paragraphBlocks || paragraphBlocks.length <= 1) continue;

        const lastParagraph = paragraphBlocks[paragraphBlocks.length - 1];
        const lastParagraphWordCount = countReadableWords(lastParagraph);
        if (lastParagraphWordCount < 10) continue;
        const paragraphClaims = scanFactualRisks(
          lastParagraph,
          state.keyphrase,
          deps.context?.research || [],
        ).claims;
        if (
          /<a\b/i.test(lastParagraph)
          || paragraphClaims.length > 0
          || /(?:HK\$|US\$|[$£€¥]|\b(?:19|20)\d{2}\b|\d)/i.test(lastParagraph)
          || /according to|research (?:from|by)|data (?:from|shows)|study (?:from|by)/i.test(lastParagraph)
        ) {
          continue;
        }

        const lastIndex = sectionHtml.lastIndexOf(lastParagraph);
        if (lastIndex < 0) continue;
        const trimmedHtml = (
          sectionHtml.substring(0, lastIndex).trim()
          + sectionHtml.substring(lastIndex + lastParagraph.length)
        ).trim();
        replaceComponentHtml(section, trimmedHtml, "trimmed");
        totalRemoved += lastParagraphWordCount;
        passRemoved += lastParagraphWordCount;
        console.log(
          `[final-trim] pass=${pass} section=${index} removed ${lastParagraphWordCount} words`,
        );
      }

      if (passRemoved === 0) break;
      syncBlogFromDocument(state);
    }

    const finalWordCount = countCanonicalVisibleWords(state.articleDoc);
    if (totalRemoved > 0) {
      console.log(
        `[final-trim] total removed=${totalRemoved} final wc=${finalWordCount} target=${state.wordMax}`,
      );
    } else {
      console.log(`[final-trim] no safe paragraphs removed — excess=${excess}`);
    }
    return state.blog;
  });

  // FAQ schema is application-owned. Always regenerate it from canonical,
  // protected visible FAQ entries after every content-changing stage.
  state = runTrackedHtmlStage(state, "faq-recovery", () => {
    if (state.articleDoc.visibleFaq.length === 0) {
      state.articleDoc.faqSchema = null;
      syncBlogFromDocument(state);
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
  // that a prior stage claimed to repair.
  state = runTrackedHtmlStage(state, "final-preflight", () => {
    const repair = repairDeterministicMalformedProse(
      state.articleDoc,
      state.wordMin,
      protectedSentencesByBlockId,
      true,
    );
    if (repair.repairedBlockIds.length > 0 || repair.removedBlockIds.length > 0) {
      console.log(
        `[final-preflight] deterministic malformed repair repaired=${repair.repairedBlockIds.length}` +
        ` removed=${repair.removedBlockIds.length}` +
        ` unresolved=${repair.unresolved.length}`,
      );
    }
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

  // Final validation
  state = runTrackedHtmlStage(state, "final-validation", (html) => {
    const result = runFinalValidation(state);
    if (!result.passed) throw new Error(`Final validation failed: ${result.reasons.join("; ")}`);
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
  const maxConclusionWords = Math.min(
    300,
    Math.max(80, Math.round(state.requestedWordCount * 0.12)),
  );
  const result = trimConclusionToBudget(state.articleDoc, maxConclusionWords);
  if (result.removedBlocks > 0) syncBlogFromDocument(state);
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
    { chatWithRetry: deps.chatWithRetry },
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
    { chatWithRetry: deps.chatWithRetry },
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

async function runInternalLinks(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  try {
    const { seedDefaultLinks } = await import("@/lib/services/default-links");
    const { injectLinks } = await import("@/lib/services/link-injector");
    await seedDefaultLinks(state.userId);
    const result = await injectLinks(state.blog, state.userId);
    if (result.linksInjected > 0) {
      return runTrackedHtmlStage(state, "internal-links", (html) => result.modifiedContent, snap);
    }
  } catch (err) {
    // Non-fatal
  }
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  recordStage(state, "internal-links", inputFp, inputFp, true, undefined, { skipped: true, reason: "no-links-to-inject" });
  return state;
}

async function runSeoNormalization(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  try {
    const result = await normalizeFinalSeo(
      { html: state.blog, focusKeyphrase: state.keyphrase, targetWordCount: state.requestedWordCount, targetKeyphraseCount: state.exactKeyphraseTarget, minReadingEase: FLESCH_MIN, maxReadingEase: FLESCH_MAX },
      deps.chatWithRetry as any,
    );
    const accepted = shouldAcceptSeoNormalization(result);
    state.normalizationResult = result;
    state.normalizationAccepted = accepted;

    if (accepted) {
      return runTrackedHtmlStage(state, "seo-normalization", (html) => result.html, snap);
    }
  } catch {
    state.normalizationResult = null;
    state.normalizationAccepted = false;
  }
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  recordStage(state, "seo-normalization", inputFp, inputFp, true, undefined, { skipped: true, reason: "normalization-rejected-or-failed" });
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
    },
  );
  const policy = buildPolicy(state.requestedWordCount, state.wordMin, state.wordMax, state.keyphrase);
  return evaluatePolicy(metrics, policy);
}
