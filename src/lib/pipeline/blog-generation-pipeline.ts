// ── Canonical blog generation pipeline ──
// All post-assembly stages extracted from route.ts.
// route.ts handles auth, section generation, initial assembly, then delegates here.
//
// ArticleDocument is the single canonical mutable source.
// state.blog is ONLY assigned by syncBlogFromDocument() — never directly.
// No stage treats raw HTML as independently canonical.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, parseArticleDocumentFromHtml, extractVisibleFaqFromArticle, renderComponentHtml, parseWordPressEditorialBlocks } from "@/lib/blog/article-document";
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
import { MAX_SENTENCES_PER_PARAGRAPH } from "@/lib/services/generation-constants";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { insertExternalResearchLinks, deduplicateEditorialExternalLinks, ensureLanguageSwitcher, pairedSlugs } from "@/lib/services/article-postprocessors";
import { expandToMinimum, trimToMaximum, normalizeParagraphs } from "@/lib/services/section-expander";
import { runEditorialPolish, isEditorialPolishEnabled } from "@/lib/pipeline/editorial-polish";
import { runComponentRegeneration, regenerateSection } from "@/lib/services/component-regenerator";
import { scanFactualRisks, removeUnsupportedSentences, formatClaimLog } from "@/lib/blog/factual-risk-scanner";
import { enforceInternalLinkLimit } from "@/lib/blog/final-article-policy";

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
  state: Pick<PipelineState, "blog" | "keyphrase" | "title" | "metaDescription" | "requestedWordCount">,
): number {
  return analyzeFinalArticle(
    state.blog,
    state.keyphrase,
    state.title,
    state.metaDescription,
    state.requestedWordCount,
  ).readableWordCount;
}

/** Prevent different word-count helpers from silently disagreeing at the final gate. */
export function assertFinalWordCountParity(
  state: Pick<PipelineState, "blog" | "keyphrase" | "title" | "metaDescription" | "requestedWordCount">,
): number {
  const policyWordCount = finalReadableWordCount(state);
  const pipelineWordCount = countReadableWords(state.blog);
  const delta = Math.abs(policyWordCount - pipelineWordCount);
  // The legacy helper may differ by one or two words around punctuation or
  // underscores. Material divergence indicates stale/duplicated HTML and fails.
  const allowedDelta = Math.max(2, Math.ceil(policyWordCount * 0.002));
  if (delta > allowedDelta) {
    throw new Error(
      `Final word-count divergence: pipeline=${pipelineWordCount} policy=${policyWordCount} delta=${delta}`,
    );
  }
  return policyWordCount;
}

/** Render a canonical structured component to WordPress HTML. */
function componentHtml(component: ArticleDocument["introduction"]): string {
  return renderComponentHtml(component);
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
function deriveSectionInput(state: PipelineState): Array<{ index: number; heading: string; body: string }> {
  return state.articleDoc.sections.map((section, index) => ({
    index,
    heading: section.heading,
    body: componentHtml(section),
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
  const required = ["expansion", "paragraphs", "regeneration", "external-links", "internal-links", "seo-normalization", "factual-scan", "link-enforce", "faq-recovery", "paragraphs-final", "cta-preserve", "wc-check", "final-validation"];
  for (const req of required) {
    if (!stages.includes(req)) issues.push({ code: "MISSING_STAGE", message: `Required stage "${req}" not found`, stage: req });
  }
  const intIdx = stages.indexOf("internal-links");
  const seoIdx = stages.indexOf("seo-normalization");
  if (intIdx >= 0 && seoIdx >= 0 && intIdx > seoIdx) {
    issues.push({ code: "STAGE_ORDER", message: "internal-links must run before seo-normalization", stage: "internal-links" });
  }
  return issues;
}

// ── Post-assembly pipeline ──

export async function runPostAssemblyPipeline(
  state: PipelineState,
  deps: PipelineDependencies,
): Promise<PipelineState> {
  assertRenderedCacheMatchesDocument(state);
  state.baseline = createArticleIntegrityBaseline(state.blog);
  state.stageOutputs.push({ stage: "assembly", inputFingerprint: fp(state.blog), outputFingerprint: fp(state.blog), accepted: true });

  state = await runClaimCheck(state, deps);
  state = await runExpansion(state, deps);
  state = await runTrim(state, deps);

  // Paragraph normalization: HTML-returning, must parse back
  state = runTrackedHtmlStage(state, "paragraphs", (html) => {
    return normalizeParagraphs(html, MAX_SENTENCES_PER_PARAGRAPH).html;
  });

  state = await runRegeneration(state, deps);

  // Language switcher: HTML-returning
  state = runTrackedHtmlStage(state, "language-switcher", (html) => {
    const slugs = pairedSlugs(state.slug || "blog-post");
    const lsHtml = `<!-- wp:html --><div class="b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/${slugs.chineseSlug}">繁體中文</a></div><!-- /wp:html -->`;
    return /b2i-language-switcher/i.test(html) ? html : lsHtml + "\n\n" + html;
  });

  // External links: HTML-returning
  state = runTrackedHtmlStage(state, "external-links", (html) => {
    const researchItems = deps.context?.research || [];
    if (researchItems.length === 0) return html;
    return insertExternalResearchLinks(html, researchItems, 3).html;
  });

  // External dedup: HTML-returning
  state = runTrackedHtmlStage(state, "external-dedup", (html) => {
    return deduplicateEditorialExternalLinks(html).html;
  });

  state = await runInternalLinks(state, deps);
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

  // Paragraph normalization moved to after faq-recovery (after all stages
  // that modify section bodies). See paragraphs-final stage below.

  // Factual-risk scan and repair: HTML-returning
  state = runTrackedHtmlStage(state, "factual-scan", (html) => {
    const research = deps.context?.research || [];
    const risk = scanFactualRisks(html, state.keyphrase, research);
    console.log(`[factual-scan] ${formatClaimLog(risk.claims)}`);
    
    if (risk.hasHighRisk) {
      const unsupported = risk.claims.filter((c: any) => !c.supported);
      // Group unsupported claims by section index
      const bySection = new Map<number, typeof unsupported>();
      for (const c of unsupported) {
        if (!bySection.has(c.sectionIndex)) bySection.set(c.sectionIndex, []);
        bySection.get(c.sectionIndex)!.push(c);
      }
      
      // Attempt targeted repair for each affected section
      for (const [sectionIdx, sectionClaims] of bySection) {
        const section = state.articleDoc.sections[sectionIdx];
        if (!section || section.status === "missing") continue;
        
        // Remove unsupported sentences from the section
        const { html: cleanedHtml, sentencesRemoved } = removeUnsupportedSentences(componentHtml(section), sectionClaims);
        if (sentencesRemoved > 0 && cleanedHtml.length > 50) {
          console.log(`[factual-scan] section=${sectionIdx} removed ${sentencesRemoved} unsupported sentence(s)`);
          replaceComponentHtml(state.articleDoc.sections[sectionIdx], cleanedHtml, "normalized");
        }
      }
      syncBlogFromDocument(state);
    }
    return state.blog;
  });

  // Internal-link limit enforcement: HTML-returning
  state = runTrackedHtmlStage(state, "link-enforce", (html) => {
    const result = enforceInternalLinkLimit(html, 4);
    console.log(`[link-enforce] retained=${result.retained.length} removed=${result.removed.length}`);
    return result.html;
  });

  // Deterministic final trim: HTML-returning
  // Removes repetition, filler and redundant examples from editable sections
  // while preserving headings, FAQ, conclusion, CTA, sourced claims, links, and protected blocks.
  // Runs after all editorial link enforcement but BEFORE FAQ recovery (which adds schema).
  state = runTrackedHtmlStage(state, "final-trim", (html) => {
    const initialWordCount = countReadableWords(html);
    if (initialWordCount <= state.wordMax) {
      console.log(`[final-trim] skipped (wc=${initialWordCount} <= ${state.wordMax})`);
      return html;
    }

    const excess = initialWordCount - state.wordMax;
    let totalRemoved = 0;
    let workingHtml = html;
    const maxPasses = Math.min(8, Math.ceil(excess / 100) + 1);

    for (let pass = 0; pass < maxPasses; pass++) {
      const currentWordCount = countReadableWords(workingHtml);
      if (currentWordCount <= state.wordMax) break;

      const stillExcess = currentWordCount - state.wordMax;
      const editableSections = state.articleDoc.sections.filter((section) => section.sectionType !== "faq-heading");
      const targetPerPass = Math.max(30, Math.ceil(stillExcess / Math.max(1, editableSections.length)));
      let passRemoved = 0;

      for (let index = 0; index < state.articleDoc.sections.length; index++) {
        if (passRemoved >= targetPerPass * 1.5) break;

        const section = state.articleDoc.sections[index];
        if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;

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
        if (/<a\b/i.test(lastParagraph) || /\d+\s*(?:%|percent|times)/i.test(lastParagraph)) continue;

        const lastIndex = sectionHtml.lastIndexOf(lastParagraph);
        if (lastIndex < 0) continue;

        const trimmedHtml = (
          sectionHtml.substring(0, lastIndex).trim()
          + sectionHtml.substring(lastIndex + lastParagraph.length)
        ).trim();
        replaceComponentHtml(section, trimmedHtml, "trimmed");
        totalRemoved += lastParagraphWordCount;
        passRemoved += lastParagraphWordCount;
        console.log(`[final-trim] pass=${pass} section=${index} removed ${lastParagraphWordCount} words`);
      }

      if (passRemoved === 0) break;

      // Commit each pass before measuring the next one. Measuring stale state.blog
      // caused every pass to believe the original excess still existed and over-trim.
      syncBlogFromDocument(state);
      workingHtml = state.blog;
    }

    if (totalRemoved > 0) {
      const finalWordCount = countReadableWords(workingHtml);
      console.log(`[final-trim] total removed=${totalRemoved} final wc=${finalWordCount} target=${state.wordMax}`);
    } else {
      console.log(`[final-trim] no paragraphs removed — excess=${excess}`);
    }

    return workingHtml;
  });

  // FAQ recovery: HTML-returning.
  // After all content-changing stages, extracts visible FAQ and ensures
  // the FAQPage JSON-LD schema matches. Rebuilds if missing or parity mismatched.
  state = runTrackedHtmlStage(state, "faq-recovery", (html) => {
    const existingFaqBlock = extractFaqBlock(html);

    // Extract visible FAQ using the SAME HTML-scanning method that analyzeFinalArticle uses.
    // Passing no doc parameter ensures the FAQ count here matches what final-validation will compute.
    const visibleFaq = extractVisibleFaqFromArticle(html);

    // Check parity even when schema already exists — paragraph splitting,
    // trimming, or factual-scan may have changed visible FAQ structure.
    if (existingFaqBlock && visibleFaq.length > 0) {
      const schemaQuestionCount = (existingFaqBlock.match(/"name"\s*:\s*"/gi) ?? []).length;
      if (schemaQuestionCount === visibleFaq.length) {
        console.log(`[faq-recovery] FAQ parity valid (${visibleFaq.length} visible = ${schemaQuestionCount} schema) — skipping`);
        return html;
      }
      // Parity mismatch — rebuild schema from final visible FAQ.
      console.log(`[faq-recovery] FAQ parity mismatch: ${visibleFaq.length} visible vs ${schemaQuestionCount} schema — rebuilding`);
    } else if (existingFaqBlock && visibleFaq.length === 0) {
      console.log(`[faq-recovery] Schema exists but no visible FAQ — keeping existing schema`);
      return html;
    } else if (!existingFaqBlock) {
      console.log(`[faq-recovery] No existing FAQ schema found`);
    }

    if (visibleFaq.length === 0) {
      console.log(`[faq-recovery] No visible FAQ found — skipping`);
      return html;
    }

    // Build FAQPage JSON-LD from visible FAQ pairs.
    console.log(`[faq-recovery] Rebuilding FAQ schema from ${visibleFaq.length} visible entries`);
    const rebuilt = renderFaqSchema(visibleFaq.map((p: any) => ({ question: p.question, answerHtml: "", answerText: p.answerText })));

    // Remove any existing FAQ schema block (stale/wrong-parity) before inserting the new one.
    let targetHtml = html;
    if (existingFaqBlock) {
      targetHtml = targetHtml.replace(existingFaqBlock, "");
    }

    // Insert before the CTA block (last wp:html block containing signup URL).
    const signupIdx = targetHtml.lastIndexOf("app.b2ihub.com/signup");
    let insertAt = targetHtml.length;
    if (signupIdx >= 0) {
      // Find the nearest <!-- wp:html --> opener before the signup URL
      const beforeSignup = targetHtml.substring(0, signupIdx);
      const wpHtmlOpeners = beforeSignup.match(/<!--\s*wp:html\s*-->/g);
      if (wpHtmlOpeners && wpHtmlOpeners.length > 0) {
        const lastOpener = beforeSignup.lastIndexOf(wpHtmlOpeners[wpHtmlOpeners.length - 1]);
        if (lastOpener >= 0) insertAt = lastOpener;
      }
    } else {
      // Fallback: insert before the last wp:html block if no signup URL found
      const wpHtmlIdx = targetHtml.lastIndexOf("<!-- /wp:html -->");
      if (wpHtmlIdx >= 0) {
        const openerAt = targetHtml.lastIndexOf("<!-- wp:html -->", wpHtmlIdx);
        if (openerAt >= 0) insertAt = openerAt;
      }
    }

    return targetHtml.substring(0, insertAt) + rebuilt + "\n\n" + targetHtml.substring(insertAt);
  });

  // Paragraph normalization — LAST content-changing stage before CTA and validation.
  // Runs after factorial-scan, final-trim, and faq-recovery so no later
  // syncBlogFromDocument() can rejoin split paragraphs.
  state = runTrackedHtmlStage(state, "paragraphs-final", (html) => {
    const result = normalizeParagraphs(html, MAX_SENTENCES_PER_PARAGRAPH);
    return result.html;
  });

  // Editorial polish: improves coherence, flow and natural language without
  // damaging structure, links, SEO, FAQ, CTA or schema. Runs after links are
  // inserted and paragraphs are normalized but BEFORE CTA preservation so
  // canonical CTA can be restored if the editor accidentally damages it.
  if (isEditorialPolishEnabled()) {
    const editorCtx = { chatWithRetry: deps.chatWithRetry };
    const epResult = await runEditorialPolish(
      state.articleDoc,
      state.keyphrase,
      async (messages, options) => editorCtx.chatWithRetry(messages, options, "editorial-polish"),
    );
    if (epResult.result.accepted) {
      console.log(
        `[editorial-polish] accepted: wc ${epResult.result.inputWordCount}→${epResult.result.candidateWordCount}` +
        ` kp ${epResult.result.keyphraseBefore}→${epResult.result.keyphraseAfter}` +
        ` edits=${epResult.result.proposedEdits} applied=${epResult.result.appliedEdits}`
      );
      state.articleDoc = epResult.doc;
      syncBlogFromDocument(state);
    } else {
      console.log(`[editorial-polish] rejected: ${epResult.result.reason}`);
    }
  }

  // CTA preservation: runs after ALL content-changing stages and FAQ recovery.
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

  // Post-CTA word-count parity check. CTA, visible FAQ cards and JSON-LD are
  // application-owned wp:html blocks and therefore do not count as editorial
  // body words. Use the exact final-policy metric and fail on helper divergence.
  state = runTrackedHtmlStage(state, "wc-check", (html) => {
    const finalWordCount = assertFinalWordCountParity(state);
    console.log(`[wc-check] canonical word count=${finalWordCount} range=${state.wordMin}-${state.wordMax}`);
    return html;
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
  const sections = state.articleDoc.sections;
  const bodies = sections.map((section, index) => ({ index, body: componentHtml(section) }));
  const conflicts = detectClaimConflicts(bodies, { claims: [] });
  if (conflicts.length === 0) {
    const fpSnap = fp(state.blog);
    recordStage(state, "claim-check", fpSnap, fpSnap, true, undefined, { skipped: true, reason: "no-conflicts" });
    return state;
  }

  const preHtml = state.blog;
  const snap = snapshotState(state);
  for (const c of conflicts) {
    const section = sections[c.sectionIndexB];
    if (!section) continue;
    try {
      const prevHeading = c.sectionIndexB > 0 ? state.h2Headings[c.sectionIndexB - 1] : "none";
      const nextHeading = c.sectionIndexB < state.h2Headings.length - 1 ? state.h2Headings[c.sectionIndexB + 1] : "none";
      const regeneratedBody = await regenerateSection(
        { chatWithRetry: deps.makeTrackedChatForStage("claim_fix"), promptContext: deps.context } as any,
        state.title, section.heading, prevHeading, nextHeading, state.wordsPerSection, state.exactKeyphraseTarget, state.keyphrase,
      );
      if (regeneratedBody && countReadableWords(regeneratedBody) > 0) {
        replaceComponentHtml(state.articleDoc.sections[c.sectionIndexB], regeneratedBody, "regenerated");
        syncBlogFromDocument(state);
      }
    } catch (err) { /* continue */ }
  }
  return runTrackedHtmlStage(state, "claim-check", (html) => html, snap);
}

async function runExpansion(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  state.currentWordCount = countReadableWords(state.blog);
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
  state.currentWordCount = countReadableWords(state.blog);

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
  state.currentWordCount = countReadableWords(state.blog);

  return runTrackedHtmlStage(state, "trim", (html) => html, snap);
}

async function runRegeneration(state: PipelineState, deps: PipelineDependencies): Promise<PipelineState> {
  const snap = snapshotState(state);
  const genCtx: any = { chatWithRetry: deps.chatWithRetry, promptContext: deps.context };
  const { blog: regeneratedBlog, title: regeneratedTitle, meta: regeneratedMeta } = await runComponentRegeneration(
    genCtx, { title: state.title, metaDescription: state.metaDescription, blog: state.blog },
    state.h2Headings, state.keyphrase,
    { intro: state.wordsPerSection, conclusion: state.wordsPerSection, perSection: state.wordsPerSection, keyphraseTarget: state.exactKeyphraseTarget },
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
      { html: state.blog, focusKeyphrase: state.keyphrase, targetWordCount: state.requestedWordCount, targetKeyphraseCount: state.exactKeyphraseTarget, minReadingEase: 60, maxReadingEase: 80 },
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
  const metrics = analyzeFinalArticle(state.blog, state.keyphrase, state.title, state.metaDescription, state.requestedWordCount);
  const policy = buildPolicy(state.requestedWordCount, state.wordMin, state.wordMax, state.keyphrase);
  return evaluatePolicy(metrics, policy);
}
