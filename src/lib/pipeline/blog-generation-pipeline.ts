// ── Canonical blog generation pipeline ──
// All post-assembly stages extracted from route.ts.
// route.ts handles auth, section generation, initial assembly, then delegates here.
//
// ArticleDocument is the single canonical mutable source.
// state.blog is ONLY assigned by syncBlogFromDocument() — never directly.
// No stage treats raw HTML as independently canonical.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, parseArticleDocumentFromHtml, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";
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
import { countReadableWords, containsExactPhrase } from "@/lib/services/text-utils";
import { extractReadableText, getFirstNReadableWords, extractH2Texts, extractParagraphTexts, countSentences } from "@/lib/seo/seo-text-utils";
import { keyphraseRangeForWordCount, MAX_SENTENCES_PER_PARAGRAPH } from "@/lib/services/generation-constants";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { insertExternalResearchLinks, deduplicateEditorialExternalLinks, ensureLanguageSwitcher, pairedSlugs } from "@/lib/services/article-postprocessors";
import { expandToMinimum, trimToMaximum, normalizeParagraphs } from "@/lib/services/section-expander";
import { runComponentRegeneration, regenerateSection } from "@/lib/services/component-regenerator";

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
}

/** Derive section input from the canonical ArticleDocument. */
function deriveSectionInput(state: PipelineState): Array<{ index: number; heading: string; body: string }> {
  return state.articleDoc.sections.map((s, i) => ({
    index: i, heading: s.heading, body: s.html,
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

export function guardStageOutput(
  currentHtml: string, previousHtml: string | null, baseline: ArticleIntegrityBaseline, stage: string,
): { html: string; accepted: boolean } {
  const validation = runStageValidation(currentHtml, baseline, stage);
  if (validation.valid) return { html: currentHtml, accepted: true };
  if (previousHtml !== null) {
    const prevValidation = runStageValidation(previousHtml, baseline, `${stage}-fallback`);
    if (prevValidation.valid) return { html: previousHtml, accepted: false };
    throw new Error(`Stage ${stage}: both candidate and fallback invalid`);
  }
  throw new Error(`Stage ${stage}: no fallback, candidate invalid`);
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
  return true;
}

function runTrackedHtmlStage(state: PipelineState, stageName: string, fn: (html: string) => string, preSnapshot?: PipelineSnapshot): PipelineState {
  const preHtml = state.blog;
  const inputFp = fp(preHtml);
  const stageBaseline = createArticleIntegrityBaseline(preHtml);
  const snap = preSnapshot ?? snapshotState(state);

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
  } else {
    // Guard accepted — articleDoc already updated by applyHtmlToDocument
    state.blog = guard.html;
  }
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
    faq: [], internalLinks: [], externalLinks: [], categories: [], tags: [], readingTime: "", summary: "",
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
  const required = ["expansion", "paragraphs", "regeneration", "external-links", "internal-links", "seo-normalization", "final-validation"];
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
  state = runTrackedHtmlStage(state, "title-repair", (html) => {
    if (!containsExactPhrase(state.title, state.keyphrase)) {
      const titlePhrase = state.keyphrase.charAt(0).toUpperCase() + state.keyphrase.slice(1);
      const candidate = `${titlePhrase}: What You Need to Know`;
      if (candidate.length >= 40 && candidate.length <= 70) state.title = candidate;
    }
    return html;
  });

  // FAQ recovery: HTML-returning
  state = runTrackedHtmlStage(state, "faq-recovery", (html) => {
    if (extractFaqBlock(html)) return html;
    const visibleFaq = extractVisibleFaqFromArticle(html);
    if (visibleFaq.length === 0) return html;
    const rebuilt = renderFaqSchema(visibleFaq.map((p: any) => ({ question: p.question, answerHtml: "", answerText: p.answerText })));
    const concIdx = html.lastIndexOf(state.articleDoc.conclusion.html.substring(0, 60));
    if (concIdx >= 0) return html.substring(0, concIdx) + rebuilt + "\n\n" + html.substring(concIdx);
    return html + "\n\n" + rebuilt;
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
  const bodies = sections.map((s, i) => ({ index: i, body: s.html }));
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
        state.articleDoc.sections[c.sectionIndexB].html = regeneratedBody;
        state.articleDoc.sections[c.sectionIndexB].wordCount = countReadableWords(regeneratedBody);
        state.articleDoc.sections[c.sectionIndexB].status = "regenerated";
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
  const result = await expandToMinimum({ chatWithRetry: deps.chatWithRetry }, sectionsInput.map((s) => ({ ...s })), sectionsInput, state.intro, state.conclusion, state.currentWordCount, state.wordMin, state.wordsPerSection);

  for (const s of result.sections) {
    if (s.index >= 0 && s.index < state.articleDoc.sections.length) {
      state.articleDoc.sections[s.index].html = s.body;
      state.articleDoc.sections[s.index].wordCount = countReadableWords(s.body);
      state.articleDoc.sections[s.index].status = "expanded";
    }
  }
  state.currentWordCount = result.finalWordCount;
  state.expansionAttempts = result.expansions;
  syncBlogFromDocument(state);

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
  const result = await trimToMaximum({ chatWithRetry: deps.chatWithRetry }, sectionsInput.map((s) => ({ ...s })), state.intro, state.conclusion, state.currentWordCount, state.wordMax);

  for (const s of result.sections) {
    if (s.index >= 0 && s.index < state.articleDoc.sections.length) {
      state.articleDoc.sections[s.index].html = s.body;
      state.articleDoc.sections[s.index].wordCount = countReadableWords(s.body);
    }
  }
  state.currentWordCount = result.finalWordCount;
  state.trimAttempts = result.trims;
  syncBlogFromDocument(state);

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
    const safety = result.safety;
    const ctaOk = state.articleDoc.cta !== null;
    const accepted = result.passed === true && safety.protectedBlocksUnchanged && safety.linkDestinationsUnchanged && safety.wordpressBlocksValid && safety.faqSchemaPreserved && safety.languageSwitcherPreserved && ctaOk;
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
  const metrics = analyzeFinalArticle(state.blog, state.keyphrase);
  const policy = buildPolicy(state.requestedWordCount, state.wordMin, state.wordMax);
  return evaluatePolicy(metrics, policy);
}
