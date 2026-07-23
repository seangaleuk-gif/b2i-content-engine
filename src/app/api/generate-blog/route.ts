import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import {
  projectRepository,
  researchRepository,
  knowledgeRepository,
  promptSectionRepository,
  blogVersionRepository,
  aiLogRepository,
  generationAnalyticsRepository,
} from "@/lib/repositories";
import { buildAnalyticsRecord } from "@/lib/services/generation-analytics";
import { buildBlogPrompt, STAGE_SYSTEM_PROMPTS } from "@/lib/services/prompt-builder";
import { getCompiledBundle } from "@/lib/services/prompt-compiler";
import { createDeepSeekClient } from "@/lib/services/deepseek";
import { countReadableWords, robustJsonParse, repairMetaDescription, containsExactPhrase, splitLongParagraphs } from "@/lib/services/text-utils";
import { META_MIN, META_MAX, DEFAULT_WORD_COUNT, WORD_ALLOCATION, keyphraseTarget, keyphraseRangeForWordCount, keyphrasePreferredTarget, allocateComponentKeyphraseBudgets, buildComponentBudgetPrompt, type ComponentKeyphraseBudget, GENERATION_WORD_BUFFER, MAX_SECTION_EXPANSIONS, MAX_SENTENCES_PER_PARAGRAPH, wordCountRange, SEO_TITLE_MIN, SEO_TITLE_MAX } from "@/lib/services/generation-constants";
import { runComponentRegeneration, regenerateIntroduction, regenerateSection, regenerateConclusion, type GenContext } from "@/lib/services/component-regenerator";
import { buildGenerationReport, formatReport } from "@/lib/services/quality-scorer";
import { GenerationTelemetry, type AiCallRecord } from "@/lib/services/generation-telemetry";
import { validateContent, type ContentValidationReport } from "@/lib/services/content-validator";
import { ensureLanguageSwitcher, pairedSlugs, insertExternalResearchLinks, sanitizeSectionUrls, deduplicateEditorialExternalLinks } from "@/lib/services/article-postprocessors";
import { expandToMinimum, trimToMaximum, normalizeParagraphs } from "@/lib/services/section-expander";
import { normalizeFinalSeo, type FinalSeoNormalizerResult } from "@/lib/blog/final-seo-normalizer";
import { createArticleIntegrityBaseline, validateFinalArticleIntegrity, validateWordpressBlockPairs, type ArticleIntegrityBaseline } from "@/lib/blog/article-integrity";
import { extractFaqBlock, extractCtaFromConclusion, stripProtectedBlocksFromConclusion, countCtaHeadings, countSignupUrls, countFaqBlocks } from "@/lib/blog/protected-block-extractor";
import { validateFinalArticleInvariants } from "@/lib/blog/article-final-invariants";
import { FLESCH_MIN, FLESCH_MAX, KEYPHRASE_MAX } from "@/lib/services/generation-constants";
import { countExactPhrase, extractReadableText, getFirstNReadableWords, countCtaHeadingTags, hasLanguageSwitcher, countEditorialExternalLinks } from "@/lib/seo/seo-text-utils";
import { type ArticleDocument, type ArticleSection, type ProtectedArticleBlock, renderArticleDocument, fingerprintHtml, classifyHeadings, renderFaqSchema, extractEditableContent, applyEditableContent, detectClaimConflicts, validateFaqParity, detectNestedParagraphs, extractVisibleFaqFromArticle, type ClaimConflict } from "@/lib/blog/article-document";
import * as fs from "fs";
import * as path from "path";

// ── Failed JSON response saving ──

function saveFailedJsonResponse(stage: string, rawContent: string): string | null {
  try {
    const dir = path.resolve("debug");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeStage = stage.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `failed-deepseek-response-${safeStage}-${timestamp}.txt`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, rawContent, "utf-8");
    console.log(`[DEEPSEEK-DIAG] Failed response saved: ${filepath}`);
    return filepath;
  } catch (e) {
    console.error(`[DEEPSEEK-DIAG] Could not save failed response: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Parse a DeepSeek response with full diagnostics. On failure, saves raw content
 * to debug/ and reports parsing context.
 */
function parseDeepSeekJson(stage: string, content: string): unknown {
  // Log raw content diagnostics
  console.log(`[DEEPSEEK-DIAG:${stage}] type=${typeof content} length=${content.length}`);
  const first500 = content.substring(0, 500);
  const last500 = content.substring(Math.max(0, content.length - 500));
  console.log(`[DEEPSEEK-DIAG:${stage}] first500="${first500.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
  console.log(`[DEEPSEEK-DIAG:${stage}] last500="${last500.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);

  try {
    return robustJsonParse(content, stage);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[DEEPSEEK-DIAG:${stage}] PARSE FAILED: ${errMsg}`);
    
    // Extract position info
    const posMatch = errMsg.match(/position\s+(\d+)/i);
    if (posMatch) {
      const pos = parseInt(posMatch[1]);
      const ctxBefore = content.substring(Math.max(0, pos - 200), pos).replace(/\n/g, "\\n");
      const ctxAfter = content.substring(pos, Math.min(content.length, pos + 200)).replace(/\n/g, "\\n");
      console.error(`[DEEPSEEK-DIAG:${stage}] errorPosition=${pos}`);
      console.error(`[DEEPSEEK-DIAG:${stage}] contextBefore=${ctxBefore}`);
      console.error(`[DEEPSEEK-DIAG:${stage}] contextAfter=${ctxAfter}`);
    }

    saveFailedJsonResponse(stage, content);
    throw err;
  }
}

// ── Diagnostic trace ──
function traceH2(stage: string, headings: string[], keyphrase: string) {
  const kp = keyphrase.toLowerCase();
  if (!kp) return;
  console.log(`\n[TRACE:H2] === ${stage} (${headings.length} headings) ===`);
  for (let i = 0; i < headings.length; i++) {
    const has = headings[i].toLowerCase().includes(kp);
    console.log(`[TRACE:H2]   [${i}] "${headings[i].substring(0, 80)}" — keyphrase: ${has ? "YES" : "NO"}`);
  }
  console.log(`[TRACE:H2] === end ${stage} ===\n`);
}

// ── Structural integrity ──
/** Strip all WordPress H2 heading blocks and bare <h2> tags from section body.
 *  Assembly is the SOLE owner of main outline H2 headings. */
function stripMainH2Blocks(html: string): string {
  let result = html;
  // WordPress block format: <!-- wp:heading {"level":2} --><h2>...</h2><!-- /wp:heading -->
  result = result.replace(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi, "");
  // Bare <h2> tags
  result = result.replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, "");
  return result;
}

/** Validate WordPress block pairing using type-aware stack-based matching.
 *  Returns per-type mismatch details and a list of specific issues. */
function validateWpBlocks(html: string): { opening: number; closing: number; mismatches: number; issues: string[] } {
  const result = validateWordpressBlockPairs(html);
  const opening = (html.match(/<!--\s*wp:\w+/gi) || []).length;
  const closing = (html.match(/<!--\s*\/wp:\w+/gi) || []).length;
  return { opening, closing, mismatches: result.valid ? 0 : 1, issues: result.issues };
}

/**
 * Extract the CTA block from the conclusion ONLY (not from the full article).
 * Searching the full article caused overmatching: the regex matched from the
 * FAQ's <!-- wp:html --> opener through to the CTA's <!-- /wp:html --> closer,
 * capturing FAQ schema + conclusion paragraphs + CTA in a single oversized block.
 */
function traceHtmlH2(stage: string, html: string, keyphrase: string) {
  const kp = keyphrase.toLowerCase();
  if (!kp || !html) return;
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(html)) !== null) {
    matches.push(m[1]);
  }
  console.log(`\n[TRACE:HTML] === ${stage} (${matches.length} H2s in HTML) ===`);
  for (let i = 0; i < matches.length; i++) {
    const has = matches[i].toLowerCase().includes(kp);
    console.log(`[TRACE:HTML]   [${i}] "${matches[i].substring(0, 80)}" — keyphrase: ${has ? "YES" : "NO"}`);
  }
  console.log(`[TRACE:HTML] === end ${stage} ===\n`);
}

// ── Post-assembly checkpoint helpers ──

function logPostMemory(label: string): void {
  const mem = process.memoryUsage();
  console.log(`[POST-MEM-${label}] heapUsed=${Math.round(mem.heapUsed / 1024)}KB heapTotal=${Math.round(mem.heapTotal / 1024)}KB rss=${Math.round(mem.rss / 1024)}KB external=${Math.round(mem.external / 1024)}KB`);
}

function logPostSize(label: string, html: string): void {
  console.log(`[POST-SIZE-${label}] chars=${html.length} words~=${html.split(/\s+/).filter(Boolean).length} type=${typeof html}`);
}

// ── Stage validation ──

interface StageValidationResult {
  valid: boolean;
  nestedParagraphs: number;
  malformedHeadings: number;
  wpBlocksValid: boolean;
  unclosedTags: string[];
  issues: string[];
}

function runStageValidation(html: string, baseline: ArticleIntegrityBaseline, stage: string): StageValidationResult {
  const result = validateFinalArticleIntegrity(html, baseline);
  const unclosed = result.errors.filter((e) => e.startsWith("Unclosed HTML tags"));
  const unclosedTags = unclosed.length > 0 ? [unclosed[0]] : [];

  const wpPairResult = validateWordpressBlockPairs(html);
  const wpBlocksValid = wpPairResult.valid;

  const issues: string[] = [...result.errors];
  for (const wpIssue of wpPairResult.issues) {
    issues.push(wpIssue);
  }

  console.log(`[generate-blog:INTEGRITY:${stage}]`);
  console.log(`  valid=${result.valid}`);
  console.log(`  nestedParagraphs=${result.metrics.nestedParagraphCount}`);
  console.log(`  malformedHeadings=${result.metrics.malformedHeadingCount}`);
  console.log(`  wpBlocksValid=${wpBlocksValid}`);
  console.log(`  unclosedTags=${unclosedTags.length}`);
  console.log(`  issueCount=${issues.length}`);
  for (let i = 0; i < issues.length; i++) {
    console.log(`  issue[${i}]=${issues[i]}`);
  }

  return {
    valid: result.valid && wpBlocksValid,
    nestedParagraphs: result.metrics.nestedParagraphCount,
    malformedHeadings: result.metrics.malformedHeadingCount,
    wpBlocksValid,
    unclosedTags,
    issues,
  };
}

/**
 * Validate stage output. If invalid and a previous valid HTML is provided, restore it.
 * If both candidate and fallback are invalid, throw to abort the pipeline.
 * Returns the HTML that should be used going forward.
 */
function guardStageOutput(
  currentHtml: string,
  previousHtml: string | null,
  baseline: ArticleIntegrityBaseline,
  stage: string,
): { html: string; accepted: boolean } {
  const validation = runStageValidation(currentHtml, baseline, stage);
  
  if (validation.valid) {
    return { html: currentHtml, accepted: true };
  }
  
  // Stage output invalid — reject
  console.warn(`[generate-blog:INTEGRITY:${stage}] Stage output REJECTED — issues: ${validation.issues.join("; ")}`);
  
  if (previousHtml !== null) {
    const prevValidation = runStageValidation(previousHtml, baseline, `${stage}-fallback`);
    if (prevValidation.valid) {
      console.log(`[generate-blog:INTEGRITY:${stage}] Restoring previous valid HTML`);
      return { html: previousHtml, accepted: false };
    }
    // Fallback also invalid — abort, do not continue with broken HTML
    console.error(`[generate-blog:INTEGRITY:${stage}] Both candidate and fallback HTML failed validation — aborting pipeline`);
    throw new Error(
      `Stage ${stage} integrity failure: both candidate and fallback HTML are invalid. ` +
      `Candidate issues: ${validation.issues.slice(0, 3).join("; ")}. ` +
      `Fallback issues: ${prevValidation.issues.slice(0, 3).join("; ")}`
    );
  }
  
  // No fallback — abort instead of continuing with invalid HTML
  console.error(`[generate-blog:INTEGRITY:${stage}] No fallback available and candidate invalid — aborting pipeline`);
  throw new Error(
    `Stage ${stage} integrity failure: no fallback HTML available. ` +
    `Issues: ${validation.issues.slice(0, 5).join("; ")}`
  );
}

interface GeneratedBlog {
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  blog: string;
  faq: { question: string; answer: string }[];
  internalLinks: string[];
  externalLinks: string[];
  categories: string[];
  tags: string[];
  readingTime: string;
  summary: string;
}

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const userId = await getCurrentUserId();
    const body = await request.json();
    const projectId = body.projectId;

    if (!projectId) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 }
      );
    }

    const project = await projectRepository.findByIdAndUser(
      Number(projectId),
      userId
    );

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const telemetry = new GenerationTelemetry();
    const trackedChat = async (stage: string, messages: Parameters<typeof chatWithRetry>[0], options?: Parameters<typeof chatWithRetry>[1]) => {
      const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
      let result: Awaited<ReturnType<typeof chatWithRetry>>;
      try {
        result = await chatWithRetry(messages, options);
        telemetry.recordAiCall({ stage, durationMs: 0, promptChars, completionChars: result.content.length, completed: true, jsonRepaired: false });
      } catch (e) {
        telemetry.recordAiCall({ stage, durationMs: 0, promptChars, completionChars: 0, completed: false, jsonRepaired: false });
        throw e;
      }
      return result;
    };

    /**
     * Wraps trackedChat with a fixed stage name for use in GenContext.
     * Fixes the t.reduce is not a function bug caused by argument position mismatch
     * when trackedChat (stage, messages, options) is called as chatWithRetry (messages, options).
     */
    function makeTrackedChatForStage(stage: string): typeof chatWithRetry {
      return ((messages: Parameters<typeof chatWithRetry>[0], options?: Parameters<typeof chatWithRetry>[1]) =>
        trackedChat(stage, messages, options)) as typeof chatWithRetry;
    }

    telemetry.startTimer("total");

    // ===== LOG STEP 1: DATABASE VALUES =====
    console.log("[generate-blog:STEP1] Project from DB:");
    console.log(`  name: "${project.name}"`);
    console.log(`  keyword: "${project.keyword}"`);
    console.log(`  audience: "${project.audience}"`);
    console.log(`  country: "${project.country}"`);
    console.log(`  word_count (raw): ${(project as Record<string, unknown>).word_count} (type: ${typeof (project as Record<string, unknown>).word_count})`);
    console.log(`  status: "${project.status}"`);
    console.log(`  content length: ${(project.content ?? "").length} chars`);

    const research = await researchRepository.findByProject(Number(projectId));
    const knowledge = await knowledgeRepository.findByUser(userId);

    console.log(`[generate-blog:STEP1] Research items: ${research.length}`);
    console.log(`[generate-blog:STEP1] Knowledge items: ${knowledge.length}`);

    await promptSectionRepository.seedDefaults(userId);
    const promptSections = await promptSectionRepository.findByUser(userId);

    console.log(`[generate-blog:STEP1] Prompt sections: ${promptSections.length}`);
    const coreSections = ["brand_voice", "seo_rules", "formatting_rules", "hong_kong_context", "blog_structure", "cta", "publish_checklist"];
    for (const s of promptSections) {
      const key = (s as Record<string, unknown>).section_key as string;
      const content = (s.content ?? "") as string;
      const isCore = coreSections.includes(key);
      const prefix = isCore ? "✓" : " ";
      console.log(`  ${prefix} ${key}: ${content.length} chars — "${content.substring(0, 100).replace(/\n/g, ' ')}..."`);
    }

    const context = {
      project: {
        name: project.name,
        keyword: project.keyword,
        audience: project.audience,
        country: project.country,
        wordCount: Number((project as Record<string, unknown>).word_count ?? 0),
        content: project.content ?? "",
        status: project.status,
      },
      research: research.map((r) => ({
        category: r.category,
        title: r.title,
        snippet: r.snippet,
        url: r.url,
      })),
      knowledge: knowledge.map((k) => ({
        title: k.title,
        content: k.content,
        tags: k.tags,
      })),
      promptSections: promptSections.map((s) => ({
        key: (s as Record<string, unknown>).section_key as string ?? "",
        label: (s as Record<string, unknown>).section_key as string ?? "",
        content: s.content,
      })),
    };

    // ===== LOG STEP 2: PROMPT ASSEMBLY =====
    const { systemPrompt, userMessage } = buildBlogPrompt(context);

    // ── Compile prompt bundle once — all stages reuse this ──
    const { bundle, cacheHit, compileTimeMs } = getCompiledBundle(context);
    telemetry.recordMetric("promptCompileTimeMs", compileTimeMs);
    if (cacheHit) {
      telemetry.recordMetric("promptCacheHit", 1);
    } else {
      telemetry.recordMetric("promptCacheMiss", 1);
    }
    console.log(`[generate-blog:PROMPTS] Compile ${compileTimeMs}ms, cache ${cacheHit ? "HIT" : "MISS"}`);

    const hasWordCount = userMessage.includes("Target Word Count");
    const hasWordCountSystem = systemPrompt.includes("Target Word Count");
    console.log(`[generate-blog:STEP2] System prompt: ${systemPrompt.length} chars`);
    console.log(`[generate-blog:STEP2] User message: ${userMessage.length} chars`);
    console.log(`[generate-blog:STEP2] Total prompt: ${systemPrompt.length + userMessage.length} chars`);
    console.log(`[generate-blog:STEP2] Contains word count in user message: ${hasWordCount}`);
    console.log(`[generate-blog:STEP2] Contains word count in system prompt: ${hasWordCountSystem}`);
    console.log(`[generate-blog:STEP2] User message starts with: "${userMessage.substring(0, 200)}..."`);

    // ===== LOG STEP 3: DEEPSEEK REQUEST =====
    console.log(`[generate-blog:STEP3] DeepSeek call params: { responseFormat: "json_object", maxTokens: 16384 }`);
    console.log(`[generate-blog:STEP3] Full prompt (system+user): ${systemPrompt.length + userMessage.length} chars`);

    // ===== FULL PROMPT DUMP =====
    console.log("=== SYSTEM PROMPT (first 2000 chars) ===");
    console.log(systemPrompt.substring(0, 2000));
    console.log("=== USER MESSAGE (FULL) ===");
    console.log(userMessage);
    console.log("=== USER MESSAGE END ===");

    // Research check
    const researchInjected = context.research && context.research.length > 0;
    console.log(`=== Research injected into prompt: ${researchInjected ? "YES" : "NO"} ===`);
    if (researchInjected) {
      console.log(`=== Research count: ${context.research.length} items ===`);
      const top = context.research.slice(0, 3);
      top.forEach((r, i) => {
        console.log(`  [${i + 1}] title: "${r.title}"`);
        console.log(`           snippet: "${r.snippet.substring(0, 120)}..."`);
        console.log(`           url: "${r.url}"`);
      });
    }

    console.log(`=== TOTALS: system=${systemPrompt.length} user=${userMessage.length} combined=${systemPrompt.length + userMessage.length} ===`);
    // ============================

    const { chatWithRetry } = createDeepSeekClient();
    const targetWordCount = context.project.wordCount;

    // ── PHASE A: Generate outline (title + H2 headings) ──
    console.log("[generate-blog:OUTLINE] Generating outline...");
    telemetry.startTimer("outline");
    const outlineSystemPrompt = bundle.outlineSystem;
    const outlinePrompt = userMessage + "\n\n=== STEP 1 ===\nReturn ONLY an outline. Generate the title and 4-6 H2 section headings. Do NOT write full content yet. Return as JSON: {\"title\": \"...\", \"slug\": \"...\", \"metaDescription\": \"...\", \"h2Headings\": [\"Heading 1\", \"Heading 2\", ...]}.";
    const outlineRes = await trackedChat("outline",
      [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
    );
    let outline: any;
    try {
      outline = robustJsonParse(outlineRes.content, "outline");
    } catch {
      console.error("[generate-blog:OUTLINE] JSON parse failed, retrying once...");
      const retryRes = await trackedChat("outline_retry",
        [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt + "\n\nCRITICAL: You MUST output valid JSON only. No markdown, no extra text." }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );
      try {
        outline = robustJsonParse(retryRes.content, "outline-retry");
      } catch {
        return NextResponse.json({ error: "Failed to parse outline JSON after retry" }, { status: 500 });
      }
    }
    const h2Headings: string[] = outline?.h2Headings ?? [];
    traceH2("1. Outline from DeepSeek", h2Headings, (context.project.keyword ?? "").toLowerCase());
    telemetry.endTimer("outline");
    telemetry.recordMetric("h2Headings", h2Headings.length);
    if (h2Headings.length === 0) {
      return NextResponse.json({ error: "Outline generation failed: no H2 headings returned" }, { status: 500 });
    }

    // Repair meta description in code
    const rawMeta = outline.metaDescription || "";
    const repairedMeta = repairMetaDescription(rawMeta, META_MIN, META_MAX);
    if (repairedMeta !== rawMeta) {
      console.log(`[generate-blog:OUTLINE] Meta repaired: ${rawMeta.length} → ${repairedMeta.length} chars`);
    }

    // Calculate dynamic word targets with generation buffer
    const requestedWordCount = context.project.wordCount || DEFAULT_WORD_COUNT;
    const internalTarget = Math.ceil(requestedWordCount * GENERATION_WORD_BUFFER);
    const { min: minWords, max: maxWords } = wordCountRange(requestedWordCount);
    const introTarget = Math.round(internalTarget * WORD_ALLOCATION.INTRO);
    const conclusionTarget = Math.round(internalTarget * WORD_ALLOCATION.CONCLUSION);
    const faqTarget = Math.round(internalTarget * WORD_ALLOCATION.FAQ);
    const h2TotalTarget = internalTarget - introTarget - conclusionTarget - faqTarget;
    const wordsPerSection = Math.round(h2TotalTarget / h2Headings.length);
    const exactKeyphraseTarget = keyphraseTarget(requestedWordCount);
    const kpRange = keyphraseRangeForWordCount(requestedWordCount);
    console.log(`[generate-blog:TARGETS] requested=${requestedWordCount} internal=${internalTarget} range=${minWords}-${maxWords} perSection=${wordsPerSection} kpRange=${kpRange.min}-${kpRange.max} kpTarget=${exactKeyphraseTarget}`);

    // Select the best H2 for keyphrase — must run BEFORE budget computation
    const keyphrase = (context.project.keyword ?? "").toLowerCase();
    let keyphraseH2Index = -1;
    if (keyphrase && h2Headings.length > 0) {
      const skipPatterns = /mistake|avoid|faq|conclusion|summary|final|wrap.?up/i;
      const kpWords = keyphrase.split(/\s+/);
      for (let i = 0; i < h2Headings.length; i++) {
        const h = h2Headings[i].toLowerCase();
        if (skipPatterns.test(h)) continue;
        if (kpWords.some((w) => h.includes(w))) { keyphraseH2Index = i; break; }
      }
      if (keyphraseH2Index === -1) {
        for (let i = 0; i < h2Headings.length; i++) {
          if (!skipPatterns.test(h2Headings[i].toLowerCase())) { keyphraseH2Index = i; break; }
        }
      }
      if (keyphraseH2Index === -1) keyphraseH2Index = 0;
      const original = h2Headings[keyphraseH2Index];
      h2Headings[keyphraseH2Index] = `${keyphrase}: ${original}`;
      console.log(`[generate-blog:H2-KEYPHRASE] Selected H2 #${keyphraseH2Index + 1}: "${original}" → "${h2Headings[keyphraseH2Index]}"`);
      traceH2("2. After keyphrase injection", h2Headings, keyphrase);
    }

    // ── Per-component keyphrase budgets ──
    // Classify headings: detect Common Mistakes and FAQ patterns to avoid double-counting
    const isMistakesHeading = (h: string) => /mistake|avoid|pitfall/i.test(h);
    const isFaqHeading = (h: string) => /faq|frequently|question/i.test(h);

    const classifiedComponents = h2Headings.map((h, idx) => {
      let type: ComponentKeyphraseBudget["componentType"] = "main-section";
      if (isMistakesHeading(h)) type = "mistakes";
      else if (isFaqHeading(h)) type = "faq";
      console.log(`[KP-BUDGET] section-${idx} heading="${h.substring(0, 60)}" type=${type} designatedH2=${idx === keyphraseH2Index}`);
      return {
        id: `section-${idx}`,
        type,
        plannedWordCount: wordsPerSection,
        containsDesignatedKeyphraseH2: idx === keyphraseH2Index,
      };
    });

    // Check if mistakes and FAQ types are already covered by headings
    const hasMistakesComponent = classifiedComponents.some((c) => c.type === "mistakes");
    const hasFaqComponent = classifiedComponents.some((c) => c.type === "faq");

    const allBudgetComponents = [
      { id: "intro", type: "introduction" as const, plannedWordCount: introTarget },
      ...classifiedComponents,
      // Only add synthetic components if not already covered by a heading
      ...(hasMistakesComponent ? [] : [{ id: "mistakes", type: "mistakes" as const, plannedWordCount: Math.round(wordsPerSection * 0.8) }]),
      ...(hasFaqComponent ? [] : [{ id: "faq", type: "faq" as const, plannedWordCount: faqTarget }]),
      { id: "conclusion", type: "conclusion" as const, plannedWordCount: conclusionTarget },
    ];

    const componentBudgets = allocateComponentKeyphraseBudgets({
      articleBudget: { min: kpRange.min, max: kpRange.max, preferred: exactKeyphraseTarget },
      components: allBudgetComponents,
    });
    const budgetMap = new Map(componentBudgets.map((b) => [b.componentId, b]));
    // Log budgets
    const budgetTotals = componentBudgets.reduce((acc, b) => ({ pref: acc.pref + b.preferred, max: acc.max + b.max }), { pref: 0, max: 0 });
    console.log(`[KP-BUDGET] article min=${kpRange.min} preferred=${exactKeyphraseTarget} max=${kpRange.max}`);
    for (const b of componentBudgets) {
      const comp = allBudgetComponents.find((c) => c.id === b.componentId);
      console.log(`[KP-BUDGET] id=${b.componentId} type=${b.componentType} heading="${comp?.id?.startsWith("section-") ? h2Headings[parseInt(b.componentId.replace("section-", ""))]?.substring(0, 50) ?? "" : ""}" plannedWords=${comp?.plannedWordCount ?? "N/A"} min=${b.min} preferred=${b.preferred} max=${b.max} designated=${!!b.containsDesignatedKeyphraseH2}`);
    }
    console.log(`[KP-BUDGET] totals preferred=${budgetTotals.pref} max=${budgetTotals.max}`);

    // ── Allocation invariants ──
    const preferredCapacity = budgetTotals.max;
    const expectedPreferred = Math.min(exactKeyphraseTarget, preferredCapacity);
    if (budgetTotals.pref !== expectedPreferred && preferredCapacity >= exactKeyphraseTarget) {
      console.warn(`[KP-BUDGET] WARNING: preferred total ${budgetTotals.pref} != expected ${expectedPreferred} (capacity=${preferredCapacity})`);
    }
    if (budgetTotals.pref < kpRange.min && preferredCapacity >= kpRange.min) {
      console.error(`[KP-BUDGET] ERROR: preferred total ${budgetTotals.pref} < article minimum ${kpRange.min} but capacity ${preferredCapacity} supports it`);
    }
    if (componentBudgets.length !== allBudgetComponents.length) {
      console.error(`[KP-BUDGET] ERROR: budget count ${componentBudgets.length} != component count ${allBudgetComponents.length}`);
    }

    // ── Authoritative section array (created once, never filtered/compacted/rebuilt) ──
    type SectionStatus = "pending" | "generated" | "recovered" | "missing" | "expanded" | "regenerated";
    interface GeneratedSection {
      index: number;
      heading: string;
      body: string;
      status: SectionStatus;
      error?: string;
    }
    const authoritativeSections: GeneratedSection[] = h2Headings.map((heading, index) => ({
      index,
      heading,
      body: "",
      status: "pending" as SectionStatus,
    }));
    function logSectionState(stage: string) {
      console.log(`[generate-blog:SECTION-STATE] stage=${stage} count=${authoritativeSections.length} indexes=[${authoritativeSections.map(s => s.index).join(",")}] statuses=[${authoritativeSections.map(s => s.status).join(",")}]`);
    }
    logSectionState("initialized");

    const generated: GeneratedBlog = {
      title: outline.title || "Untitled",
      slug: outline.slug || "",
      metaDescription: repairedMeta,
      blog: "",
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
      excerpt: outline.excerpt || "",
    };

    // ── PHASE B–E (PARALLEL): Introduction, all H2 sections, Conclusion run concurrently ──
    console.log("[generate-blog:PARALLEL] Starting parallel generation (intro + sections + conclusion)...");
    telemetry.startTimer("parallel_block");

    // Build prompts for all parallel tasks
    const introSystemPrompt = bundle.introSystem;
    const introBudget = budgetMap.get("intro")!;
    const introUserMsg = `Write the introduction (${introTarget} words) for this blog. Use WordPress block format. Return as JSON: {"intro": "..."}.\n\nTitle: ${generated.title}\nMeta: ${generated.metaDescription}\nKeyword: ${context.project.keyword}\n\n${userMessage.substring(0, 1000)}${buildComponentBudgetPrompt(introBudget, context.project.keyword)}`;

    const sectionSystemPrompt = bundle.sectionSystem;

    const conclusionSystemPrompt = bundle.conclusionSystem;
    const conclusionBudget = budgetMap.get("conclusion")!;
    const conclusionUserMsg = `Write the conclusion (${conclusionTarget} words) for this blog. Include a CTA to create a B2I Hub profile. Return as JSON: {"conclusion": "..."}.\n\nTitle: ${generated.title}${buildComponentBudgetPrompt(conclusionBudget, context.project.keyword)}`;

    // ── Research source summary for section prompts ──
    const sectionResearchPrompt = context.research?.length
      ? `\n\nREFERENCE SOURCES (use these URLs when referencing claims — cite with descriptive anchor text like "According to [Source Name]..." and link to the URL):\n${context.research.map((r: any) => `- ${r.title || "Source"}: ${r.url || ""}${r.snippet ? ` (${r.snippet.substring(0, 120)})` : ""}`).join("\n")}`
      : "";

    // Build allowed research URL list for post-generation sanitization
    const researchUrls = (context.research || []).map((r: any) => r.url || r.link || "").filter(Boolean);

    // Create parallel tasks array
    type ParallelResult = { type: "intro" | "section" | "conclusion"; index?: number; heading?: string; content: string };
    const tasks: Promise<ParallelResult>[] = [];

    // Intro task
    tasks.push(
      trackedChat("intro",
        [{ role: "system", content: introSystemPrompt }, { role: "user", content: introUserMsg }],
        { responseFormat: { type: "json_object" }, maxTokens: 4096 }
      ).then((res) => ({ type: "intro" as const, content: (robustJsonParse(res.content, "intro") as Record<string, string>).intro || "" }))
    );

    // Section tasks (one per H2 heading)
    for (let i = 0; i < h2Headings.length; i++) {
      const h2Text = h2Headings[i];
      const prevHeading = i > 0 ? h2Headings[i - 1] : "(none)";
      const nextHeading = i < h2Headings.length - 1 ? h2Headings[i + 1] : "(none)";

      const sectionBudget = budgetMap.get(`section-${i}`)!;
      const sectionUserMsg = `Return section BODY content only. Do NOT return the section H2 heading. Do NOT output any level-2 heading. The application will insert the H2 heading separately. You may use H3 headings when needed. Start directly with a paragraph, list, table, quote, or H3 block.\n\nSection heading for context only (do NOT repeat):\n"${h2Text}"\n\nWrite the body content. Target exactly ${wordsPerSection} words. Use WordPress block format (<!-- wp:paragraph -->, <!-- wp:list -->).\n\nReturn as JSON: {\"body\": \"...\"}.\n\nArticle title: ${generated.title}\nPrevious heading: ${prevHeading}\nNext heading: ${nextHeading}\n\nGUIDANCE:\n- This section is one independent part of a larger article.\n- Do NOT repeat statistics, examples, or explanations likely covered in other sections (see headings above).\n- Assume the previous heading's topic has already been explained — do not reintroduce it.\n- Focus exclusively on the content for THIS heading.\n- End this section with a smooth transition toward the next heading (${nextHeading}).${sectionResearchPrompt}${buildComponentBudgetPrompt(sectionBudget, context.project.keyword)}`;

    tasks.push(
      trackedChat(`section_${i}`,
          [{ role: "system", content: sectionSystemPrompt }, { role: "user", content: sectionUserMsg }],
          { responseFormat: { type: "json_object" }, maxTokens: 8192 }
        ).then((res) => {
          const raw = (robustJsonParse(res.content, `section_${i}`) as Record<string, string>).body || "";
          let clean = stripMainH2Blocks(raw);
          if (clean !== raw) console.log(`[generate-blog:SANITIZE] Removed leaked H2 from section ${i}`);
          // Strip external links not from research sources
          if (researchUrls.length > 0) {
            const beforeUrls = clean;
            clean = sanitizeSectionUrls(clean, researchUrls);
            if (clean !== beforeUrls) {
              const removedUrls = (beforeUrls.match(/<a\b[^>]*href="([^"]*)"[^>]*>/gi) ?? []).filter(
                (a: string) => !clean.includes(a)
              );
              console.log(`[generate-blog:SANITIZE] section ${i}: removed ${removedUrls.length} non-research external link(s)`);
            }
          }
          return { type: "section" as const, index: i, heading: h2Text, content: clean };
        })
      );
    }

    // Conclusion task
    tasks.push(
      trackedChat("conclusion",
        [{ role: "system", content: conclusionSystemPrompt }, { role: "user", content: conclusionUserMsg }],
        { responseFormat: { type: "json_object" }, maxTokens: 4096 }
      ).then((res) => ({ type: "conclusion" as const, content: (robustJsonParse(res.content, "conclusion") as Record<string, string>).conclusion || "" }))
    );

    // Execute all parallel tasks with fault tolerance
    traceH2("3. Before parallel generation", h2Headings, keyphrase);
    const settled = await Promise.allSettled(tasks);

    // Classify results
    const successful: ParallelResult[] = [];
    const failed: { type: string; index?: number; heading?: string; error: string }[] = [];

    for (const s of settled) {
      if (s.status === "fulfilled") {
        successful.push(s.value);
      } else {
        // Determine which task failed from its position
        const idx = settled.indexOf(s);
        const taskIdx = idx as number;
        let taskType = "unknown";
        let taskIndex: number | undefined;
        let taskHeading: string | undefined;

        if (taskIdx === 0) {
          taskType = "intro";
        } else if (taskIdx === tasks.length - 1) {
          taskType = "conclusion";
        } else {
          const sectionIdx = taskIdx - 1;
          taskType = "section";
          taskIndex = sectionIdx;
          taskHeading = h2Headings[sectionIdx] ?? "unknown";
        }

        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        failed.push({ type: taskType, index: taskIndex, heading: taskHeading, error: reason });
        telemetry.recordTaskFailure(taskType, taskType === "section" ? `section_${taskIndex}` : taskType, reason);
        console.log(`[generate-blog:PARALLEL] FAILED: ${taskType}${taskIndex !== undefined ? ` #${taskIndex}` : ""} — ${reason}`);
      }
    }

    // ── Regenerate failed components before assembly ──
    const recovered: ParallelResult[] = [];

    if (failed.length > 0) {
      console.log(`[generate-blog:RECOVERY] Attempting to recover ${failed.length} failed task(s)...`);
      telemetry.startTimer("parallel_recovery");

      for (const f of failed) {
        try {
          if (f.type === "intro") {
            const newIntro = await regenerateIntroduction(
              { chatWithRetry: makeTrackedChatForStage("recovery_intro"), promptContext: context } as GenContext,
              generated.title, generated.metaDescription, keyphrase, introTarget,
            );
            recovered.push({ type: "intro", content: newIntro });
            telemetry.recordRecovery();
            console.log(`[generate-blog:RECOVERY] Intro recovered`);
          } else if (f.type === "conclusion") {
            const newConc = await regenerateConclusion(
              { chatWithRetry: makeTrackedChatForStage("recovery_conclusion"), promptContext: context } as GenContext,
              generated.title, conclusionTarget,
            );
            recovered.push({ type: "conclusion", content: newConc });
            telemetry.recordRecovery();
            console.log(`[generate-blog:RECOVERY] Conclusion recovered`);
          } else if (f.type === "section" && f.index !== undefined) {
            const prevHeading = f.index > 0 ? h2Headings[f.index - 1] : "none";
            const nextHeading = f.index < h2Headings.length - 1 ? h2Headings[f.index + 1] : "none";
            const newBody = await regenerateSection(
              { chatWithRetry: makeTrackedChatForStage("recovery_section"), promptContext: context } as GenContext,
              generated.title, f.heading || h2Headings[f.index], prevHeading, nextHeading, wordsPerSection, exactKeyphraseTarget, keyphrase,
            );
            recovered.push({ type: "section", index: f.index, heading: f.heading, content: newBody });
            telemetry.recordRecovery();
            console.log(`[generate-blog:RECOVERY] Section #${f.index} recovered`);
          }
        } catch (recoveryErr) {
          telemetry.recordUnrecovered();
          const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
          const stack = recoveryErr instanceof Error ? (recoveryErr.stack ?? "").split("\n").slice(0, 5).join("\n") : "no stack";
          console.error(`[generate-blog:RECOVERY] ${f.type}${f.index !== undefined ? ` #${f.index}` : ""} — FAILED: ${msg}`);
          console.error(`[generate-blog:RECOVERY-STACK]\n${stack}`);
          if (recoveryErr instanceof TypeError && msg.includes("reduce")) {
            console.error(`[generate-blog:RECOVERY-TYPE] typeof=${typeof (recoveryErr as any).value} inspected at recovery call for section ${f.index}`);
          }
        }
      }

      telemetry.endTimer("parallel_recovery");
    }

    // Combine successful + recovered
    const allResults = [...successful, ...recovered];

    // ── Write parallel results into authoritative section array (indexed write-back, never filter/rebuild) ──
    const hasIntro = allResults.some((r) => r.type === "intro");
    const sectionResults = allResults.filter((r): r is ParallelResult & { type: "section"; index: number } => r.type === "section");
    const totalSections = h2Headings.length;

    // Write section results back by index
    for (const sr of sectionResults) {
      if (sr.index >= 0 && sr.index < authoritativeSections.length) {
        authoritativeSections[sr.index].body = sr.content;
        authoritativeSections[sr.index].status = recovered.some((rr) => rr.type === "section" && rr.index === sr.index) ? "recovered" : "generated";
      }
    }
    // Mark all sections NOT in results as "missing" (preserves index, never removes)
    const resultIndices = new Set(sectionResults.map((s) => s.index));
    for (let i = 0; i < authoritativeSections.length; i++) {
      if (!resultIndices.has(i)) {
        authoritativeSections[i].body = "";
        authoritativeSections[i].status = "missing";
        authoritativeSections[i].error = "generation failed or unrecovered";
      }
    }
    logSectionState("after-parallel");

    // ── KP-COMPONENT: log each component's actual keyphrase count vs budget ──
    const kpLower = keyphrase.toLowerCase();
    for (let i = 0; i < authoritativeSections.length; i++) {
      const body = authoritativeSections[i].body || "";
      const actual = countExactPhrase(extractReadableText(body), keyphrase);
      const budget = budgetMap.get(`section-${i}`);
      if (budget) {
        console.log(`[KP-COMPONENT] id=section-${i} type=${budget.componentType} actual=${actual} preferred=${budget.preferred} max=${budget.max} valid=${actual <= budget.max}`);
      }
    }
    const introText = allResults.find((r) => r.type === "intro")?.content || "";
    const introActual = countExactPhrase(extractReadableText(introText), keyphrase);
    const introKpBudget = budgetMap.get("intro");
    if (introKpBudget) {
      console.log(`[KP-COMPONENT] id=intro type=introduction actual=${introActual} preferred=${introKpBudget.preferred} max=${introKpBudget.max} valid=${introActual <= introKpBudget.max}`);
    }
    const concText = allResults.find((r) => r.type === "conclusion")?.content || "";
    const concActual = countExactPhrase(extractReadableText(concText), keyphrase);
    const concKpBudget = budgetMap.get("conclusion");
    if (concKpBudget) {
      console.log(`[KP-COMPONENT] id=conclusion type=conclusion actual=${concActual} preferred=${concKpBudget.preferred} max=${concKpBudget.max} valid=${concActual <= concKpBudget.max}`);
    }

    const availableSections = sectionResults.length;

    if (!hasIntro) {
      console.error("[generate-blog:RECOVERY] Introduction missing after recovery — aborting");
      return NextResponse.json({ error: "Introduction generation failed and could not be recovered" }, { status: 500 });
    }

    const missingRatio = totalSections > 0 ? (totalSections - availableSections) / totalSections : 0;
    if (missingRatio > 0.3) {
      console.error(`[generate-blog:RECOVERY] ${totalSections - availableSections}/${totalSections} sections missing (${Math.round(missingRatio * 100)}%) — aborting`);
      return NextResponse.json({ error: `Too many section failures: ${totalSections - availableSections}/${totalSections} could not be generated` }, { status: 500 });
    }

    if (availableSections < totalSections) {
      console.warn(`[generate-blog:RECOVERY] ${totalSections - availableSections} section(s) unrecovered — continuing with partial content`);
    }

    const unrecoveredCount = totalSections - availableSections;
    if (unrecoveredCount > 0) {
      telemetry.recordMetric("unrecoveredSections", unrecoveredCount);
    }

    // ── Hard recovery: ensure NO missing sections reach assembly ──
    const missingSectionIndices: number[] = [];
    for (let i = 0; i < authoritativeSections.length; i++) {
      if (authoritativeSections[i].status === "missing" || !authoritativeSections[i].body) {
        missingSectionIndices.push(i);
      }
    }

    if (missingSectionIndices.length > 0) {
      console.warn(`[generate-blog:RECOVERY] ${missingSectionIndices.length} section(s) still missing — attempting hard recovery before assembly`);
      telemetry.startTimer("hard_recovery");

      for (const idx of missingSectionIndices) {
        const s = authoritativeSections[idx];
        const prevHeading = idx > 0 ? h2Headings[idx - 1] : "none";
        const nextHeading = idx < h2Headings.length - 1 ? h2Headings[idx + 1] : "none";
        try {
          const recoveredBody = await regenerateSection(
            { chatWithRetry: makeTrackedChatForStage("hard_recovery_section"), promptContext: context } as GenContext,
            generated.title, s.heading, prevHeading, nextHeading, wordsPerSection, exactKeyphraseTarget, keyphrase,
          );
          if (recoveredBody && countReadableWords(recoveredBody) > 0) {
            authoritativeSections[idx].body = recoveredBody;
            authoritativeSections[idx].status = "recovered";
            authoritativeSections[idx].error = undefined;
            console.log(`[generate-blog:RECOVERY] Hard recovery: section #${idx + 1} ("${s.heading.substring(0, 40)}") — recovered (${countReadableWords(recoveredBody)} words)`);
          } else {
            console.error(`[generate-blog:RECOVERY] Hard recovery: section #${idx + 1} returned empty body`);
          }
        } catch (hardErr) {
          console.error(`[generate-blog:RECOVERY] Hard recovery: section #${idx + 1} FAILED — ${hardErr instanceof Error ? hardErr.message : String(hardErr)}`);
        }
      }

      telemetry.endTimer("hard_recovery");

      // Recheck after hard recovery
      const stillMissing = authoritativeSections.filter((s) => s.status === "missing" || !s.body);
      if (stillMissing.length > 0) {
        const missingNames = stillMissing.map((s) => `#${s.index + 1} "${s.heading}"`).join(", ");
        console.error(`[generate-blog:RECOVERY] ${stillMissing.length} section(s) still unrecovered after hard recovery: ${missingNames} — aborting`);
        return NextResponse.json({
          error: `Section generation failed: ${stillMissing.length} section(s) could not be generated or recovered`,
          missingSections: stillMissing.map((s) => ({ index: s.index, heading: s.heading })),
        }, { status: 500 });
      }
    }

    // ── Component-level validation and safety caps before assembly ──
    const MAX_COMPONENT_CHARS = 500_000;   // 500KB per component
    const MAX_ARTICLE_CHARS = 2_000_000;    // 2MB total article
    const COMPONENT_GROWTH_WARN = 5;        // Warn if component grows 5x in one operation

    // Extract intro/conclusion
    let intro = allResults.find((r) => r.type === "intro")?.content || "";
    let conclusion = allResults.find((r) => r.type === "conclusion")?.content || "";

    // ── Component size safety caps ──
    const truncMessage = "\n<!-- content truncated: exceeded component size limit -->";
    if (intro.length > MAX_COMPONENT_CHARS) {
      console.error(`[generate-blog:SAFETY] Intro size ${intro.length} exceeds limit ${MAX_COMPONENT_CHARS} — truncating`);
      intro = intro.substring(0, MAX_COMPONENT_CHARS - truncMessage.length) + truncMessage;
    }
    for (let i = 0; i < authoritativeSections.length; i++) {
      const body = authoritativeSections[i].body || "";
      if (body.length > MAX_COMPONENT_CHARS) {
        console.error(`[generate-blog:SAFETY] Section ${i} body size ${body.length} exceeds limit ${MAX_COMPONENT_CHARS} — truncating`);
        authoritativeSections[i].body = body.substring(0, MAX_COMPONENT_CHARS - truncMessage.length) + truncMessage;
      }
    }
    if (conclusion.length > MAX_COMPONENT_CHARS) {
      console.error(`[generate-blog:SAFETY] Conclusion size ${conclusion.length} exceeds limit ${MAX_COMPONENT_CHARS} — truncating`);
      conclusion = conclusion.substring(0, MAX_COMPONENT_CHARS - truncMessage.length) + truncMessage;
    }

    if (!intro || countReadableWords(intro) === 0) {
      console.error("[generate-blog:RECOVERY] Introduction is empty after recovery — aborting");
      return NextResponse.json({ error: "Introduction generation failed and could not be recovered" }, { status: 500 });
    }

    console.log(`[generate-blog:INTRO] ${countReadableWords(intro)} words (${intro.length} chars)`);
    for (const s of authoritativeSections) {
      const bLen = (s.body || "").length;
      console.log(`[generate-blog:SECTION] ${s.index + 1}/${totalSections}: "${s.heading}" — ${countReadableWords(s.body)} words — ${bLen} chars — status=${s.status}`);
    }
    console.log(`[generate-blog:CONCLUSION] ${countReadableWords(conclusion)} words (${conclusion.length} chars)`);

    // Validate each component before assembly — uses type-aware WordPress block pairing
    let componentsValid = true;
    const componentIssues: string[] = [];
    const failedComponentIndices: number[] = [];
    for (let i = 0; i < authoritativeSections.length; i++) {
      const s = authoritativeSections[i];
      const wc = countReadableWords(s.body);
      const hasNestedP = /<p[^>]*>(?:(?!<\/p>).)*<p[^>]*>/g.test(s.body || "");
      const wpPairResult = validateWordpressBlockPairs(s.body || "");
      const hasWpIssue = !wpPairResult.valid;
      const valid = wc > 0 && !hasNestedP && !hasWpIssue;
      console.log(`[generate-blog:COMPONENT] section${i} valid=${valid} wc=${wc} nestedP=${hasNestedP} wpBlockValid=${!hasWpIssue}`);
      if (hasWpIssue) {
        for (const issue of wpPairResult.issues) {
          console.log(`[generate-blog:COMPONENT] section${i} wpIssue="${issue}"`);
        }
      }
      if (!valid) {
        componentsValid = false;
        failedComponentIndices.push(i);
        if (wc === 0) componentIssues.push(`section${i}: empty body`);
        if (hasNestedP) componentIssues.push(`section${i}: nested <p>`);
        if (hasWpIssue) componentIssues.push(`section${i}: wp block type mismatch (${wpPairResult.issues.slice(0, 2).join("; ")})`);
      }
    }

    if (!componentsValid) {
      console.error(`[generate-blog:COMPONENT] ${componentIssues.length} component issue(s): ${componentIssues.join("; ")}`);
      // Attempt regeneration for components with structural WP block issues
      console.log(`[generate-blog:COMPONENT] Attempting regeneration for ${failedComponentIndices.length} failed component(s)...`);
      // Iterate over a COPY — successful regenerations are removed from the original,
      // so we must not mutate the array being iterated.
      let remainingFailed: number[] = [];
      for (const idx of [...failedComponentIndices]) {
        const s = authoritativeSections[idx];
        const prevHeading = idx > 0 ? h2Headings[idx - 1] : "none";
        const nextHeading = idx < h2Headings.length - 1 ? h2Headings[idx + 1] : "none";
        const wpPairResult = validateWordpressBlockPairs(s.body || "");
        let repaired = false;
        try {
          const regeneratedBody = await regenerateSection(
            { chatWithRetry: makeTrackedChatForStage("component_fix"), promptContext: context } as GenContext,
            generated.title, s.heading, prevHeading, nextHeading, wordsPerSection, exactKeyphraseTarget, keyphrase,
          );
          if (regeneratedBody && countReadableWords(regeneratedBody) > 0) {
            const regenWpResult = validateWordpressBlockPairs(regeneratedBody);
            if (regenWpResult.valid) {
              authoritativeSections[idx].body = regeneratedBody;
              authoritativeSections[idx].status = "regenerated";
              console.log(`[generate-blog:COMPONENT] section${idx} successfully regenerated with valid WP blocks`);
              repaired = true;
              // Remove corresponding issue
              const issueIdx = componentIssues.findIndex((ci) => ci.startsWith(`section${idx}:`));
              if (issueIdx >= 0) componentIssues.splice(issueIdx, 1);
            } else {
              console.error(`[generate-blog:COMPONENT] section${idx} regeneration still has WP block issues: ${regenWpResult.issues.join("; ")}`);
            }
          }
        } catch (regenErr) {
          console.error(`[generate-blog:COMPONENT] section${idx} regeneration failed: ${regenErr instanceof Error ? regenErr.message : String(regenErr)}`);
        }
        if (!repaired) {
          remainingFailed.push(idx);
        }
      }
      // Replace original array with remaining failures (no splice during iteration)
      failedComponentIndices.length = 0;
      failedComponentIndices.push(...remainingFailed);

      // Recheck after regeneration
      if (failedComponentIndices.length > 0) {
        console.error(`[generate-blog:COMPONENT] ${failedComponentIndices.length} component(s) still structurally invalid after regeneration — aborting assembly`);
        return NextResponse.json({
          error: "Component structural validation failed",
          detail: componentIssues.join("; "),
          failedComponents: failedComponentIndices.map((i) => ({ index: i, heading: h2Headings[i] })),
        }, { status: 422 });
      }
      componentsValid = true;
    }

    // ── Build canonical ArticleDocument from generated components ──
    console.log("[ASSEMBLY] building ArticleDocument");
    const assemblyStartTime = Date.now();

    // Extract CTA from conclusion and strip it from conclusion HTML
    const initialCtaBlockHtml = extractCtaFromConclusion(conclusion);
    const initialCleanConclusion = stripProtectedBlocksFromConclusion(
      conclusion,
      initialCtaBlockHtml,
      "", // FAQ not generated yet
    );

    // Build language switcher
    const slugs = pairedSlugs(generated.slug || "blog-post");
    const langSwitcherHtml = `<!-- wp:html -->
<div class="b2i-language-switcher" data-language="en">
  <span>English</span> |
  <a href="/blog/${slugs.chineseSlug}">繁體中文</a>
</div>
<!-- /wp:html -->`;

    // Build ArticleDocument
    const articleDoc: ArticleDocument = {
      metadata: {
        title: generated.title,
        slug: generated.slug,
        metaDescription: generated.metaDescription,
        excerpt: generated.excerpt || "",
        targetWordCount: requestedWordCount,
        focusKeyphrase: keyphrase,
      },
      languageSwitcher: {
        id: "language-switcher",
        type: "language-switcher",
        html: langSwitcherHtml,
        fingerprint: fingerprintHtml(langSwitcherHtml),
      },
      introduction: { id: "intro", html: intro, wordCount: countReadableWords(intro), status: "generated" },
      sections: authoritativeSections.map((s) => ({
        id: `section-${s.index}`,
        html: s.body,
        wordCount: countReadableWords(s.body),
        status: s.status as ArticleSection["status"],
        heading: s.heading,
        headingLevel: 2 as const,
        sectionType: "main" as const,
      })),
      visibleFaq: generated.faq.map((f) => ({
        question: f.question,
        answerHtml: "", // filled after FAQ generation
        answerText: "", // filled after FAQ generation
      })),
      conclusion: { id: "conclusion", html: initialCleanConclusion, wordCount: countReadableWords(initialCleanConclusion), status: "generated" },
      cta: initialCtaBlockHtml ? {
        id: "cta",
        type: "cta",
        html: initialCtaBlockHtml,
        fingerprint: fingerprintHtml(initialCtaBlockHtml),
      } : null,
      faqSchema: null, // filled after FAQ generation
      insertedLinks: [],
    };

    // ── Construction-time invariant: CTA must not remain in conclusion ──
    if (articleDoc.cta && /app\.b2ihub\.com\/signup/i.test(articleDoc.conclusion.html)) {
      throw new Error("CTA signup URL remained inside canonical conclusion after extraction");
    }

    // Render canonical article
    let articleHtml = renderArticleDocument(articleDoc);
    let currentWordCount = countReadableWords(articleHtml);
    telemetry.endTimer("parallel_block");

    // ── Traces ──
    traceHtmlH2("4. After parallel block (from HTML)", articleHtml, keyphrase);
    traceH2("4. After parallel block (from array)", h2Headings, keyphrase);

    // ── PHASE D: Generate FAQ (sequential — depends on all section bodies) ──
    const sectionBodies = authoritativeSections.filter((s) => s.body).map((s) => s.body.substring(0, 500));
    const summaryText = sectionBodies.join("\n").substring(0, 1000);

    if (sectionBodies.length <= 1) {
      console.warn("[generate-blog:FAQ] Too few section bodies for FAQ — skipping");
      telemetry.recordWarning("faq_skipped:insufficient_sections");
    } else {
      console.log("[generate-blog:FAQ] Generating FAQ...");
      telemetry.startTimer("faq");
      const faqSystemPrompt = bundle.faqSystem;
      const faqPrompt = `Generate 4-6 FAQ questions and answers for this blog. Use <!-- wp:html --> blocks. Return as JSON: {\"faq\": [{\"question\": \"...\", \"answer\": \"...\"}], \"faqSchemaBlock\": \"...\"}.\n\nBlog title: ${generated.title}\nContent summary: ${summaryText}`;
      const faqRes = await trackedChat("faq",
        [{ role: "system", content: faqSystemPrompt }, { role: "user", content: faqPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );
      const faqData = robustJsonParse(faqRes.content, "faq") as Record<string, unknown>;
      generated.faq = (faqData.faq as Array<{ question: string; answer: string }>) || [];
      
      // Update ArticleDocument with FAQ entries (single source for visible + schema)
      articleDoc.visibleFaq = generated.faq.map((f) => ({
        question: f.question,
        answerHtml: f.answer || "",
        answerText: (f.answer || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      }));
      // Deterministic FAQ schema — never from the model
      const schemaHtml = renderFaqSchema(articleDoc.visibleFaq);
      articleDoc.faqSchema = {
        id: "faq-schema",
        type: "faq-schema",
        html: schemaHtml,
        fingerprint: fingerprintHtml(schemaHtml),
      };
      telemetry.endTimer("faq");
    }

    // Re-render after FAQ
    articleHtml = renderArticleDocument(articleDoc);
    traceHtmlH2("5. Before assembly (from HTML)", articleHtml, keyphrase);

    // ── KP-PRE-ASSEMBLY ──
    const preAssemblyWC = countReadableWords(articleHtml);
    const preAssemblyKP = countExactPhrase(extractReadableText(articleHtml), keyphrase);
    console.log(`[KP-PRE-ASSEMBLY] wordCount=${preAssemblyWC} exactCount=${preAssemblyKP} preferred=${exactKeyphraseTarget} min=${kpRange.min} max=${kpRange.max}`);

    telemetry.startTimer("assemble");
    generated.blog = articleHtml;
    telemetry.endTimer("assemble");

    // ── KP-RAW-ASSEMBLED ──
    const rawWC = countReadableWords(generated.blog);
    const rawKP = countExactPhrase(extractReadableText(generated.blog), keyphrase);
    console.log(`[KP-RAW-ASSEMBLED] wordCount=${rawWC} exactCount=${rawKP} preferred=${exactKeyphraseTarget} min=${kpRange.min} max=${kpRange.max}`);

    // ── Final diagnostics ──
    const assemblyTimeMs = Date.now() - assemblyStartTime;
    console.log(`[ASSEMBLY] finalChars=${generated.blog.length} finalWordCount=${countReadableWords(generated.blog)} assemblyTimeMs=${assemblyTimeMs}`);
    if (generated.blog.length > MAX_ARTICLE_CHARS) {
      console.error(`[ASSEMBLY] SAFETY — final article ${generated.blog.length} chars exceeds limit ${MAX_ARTICLE_CHARS} — truncating`);
      generated.blog = generated.blog.substring(0, MAX_ARTICLE_CHARS - truncMessage.length) + truncMessage;
    }

    // ── Assembly diagnostics ──
    const diagWpOpening = (generated.blog.match(/<!--\s*wp:\w+/gi) ?? []).length;
    const diagWpClosing = (generated.blog.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
    console.log(`[generate-blog:ASSEMBLY-DIAG] wpOpening=${diagWpOpening} wpClosing=${diagWpClosing}`);

    // ── Create integrity baseline from initial assembly ──
    let assemblyBaseline = createArticleIntegrityBaseline(generated.blog);

    const assemblyGuard = guardStageOutput(generated.blog, null, assemblyBaseline, "assembly");
    if (!assemblyGuard.accepted) {
      generated.blog = assemblyGuard.html;
      console.warn("[generate-blog:INTEGRITY:assembly] Initial assembly failed structural validation — continuing with best available HTML");
    }

    // ── Structural invariants ──
    console.log("[POST-N3 before structural invariants");
    const h2AfterAssembly = (generated.blog.match(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? []).length;
    console.log(`[generate-blog:STRUCTURE] sections=${totalSections} expected=${h2Headings.length} mainH2AfterAssembly=${h2AfterAssembly}`);
    if (h2AfterAssembly !== h2Headings.length) {
      telemetry.recordWarning(`h2Mismatch: expected ${h2Headings.length}, got ${h2AfterAssembly}`);
      console.warn(`[generate-blog:STRUCTURE] H2 count mismatch: expected ${h2Headings.length}, got ${h2AfterAssembly}`);
    }

    const hasDupH2s = /<h2[^>]*>([\s\S]*?)<\/h2>\s*(?:<!--\s*\/wp:heading\s*-->)?\s*(?:<!--\s*wp:heading[^>]*-->)?\s*<h2[^>]*>\s*\1\s*<\/h2>/i;
    if (hasDupH2s.test(generated.blog)) {
      console.warn("[generate-blog:STRUCTURE] Duplicate consecutive H2 detected");
      telemetry.recordWarning("dupConsecutiveH2");
    }

    const nestedParaCount = detectNestedParagraphs(generated.blog);
    if (nestedParaCount > 0) {
      console.warn(`[generate-blog:STRUCTURE] ${nestedParaCount} nested paragraph(s) detected`);
      telemetry.recordWarning("nestedParagraphs");
    }
    console.log("[POST-N3 after structural invariants");

    console.log(`[generate-blog:STRUCTURE] wpBlocksValid=true nestedParagraphs=${nestedParaCount}`);
    console.log("[POST-N4 before traceHtmlH2");
    traceHtmlH2("6. After assembly (generated.blog)", generated.blog, keyphrase);
    console.log("[POST-N4 after traceHtmlH2");

    // ── Claim consistency check — detect conflicting recommendations across sections ──
    console.log("[CLAIM-CHECK] Detecting claim conflicts across sections...");
    const sectionBodiesForClaims = authoritativeSections.map((s) => ({ index: s.index, body: s.body }));
    const conflicts = detectClaimConflicts(sectionBodiesForClaims, { claims: [] });
    if (conflicts.length > 0) {
      console.warn(`[CLAIM-CHECK] ${conflicts.length} claim conflict(s) detected`);
      for (const c of conflicts) {
        console.warn(`[CLAIM-CHECK]   ${c.detail}`);
      }
      // Regenerate conflicting components with explicit corrected claim
      for (const c of conflicts) {
        const sectionB = authoritativeSections[c.sectionIndexB];
        if (!sectionB) continue;
        console.log(`[CLAIM-CHECK] Regenerating section ${c.sectionIndexB} to resolve "${c.valueB}" conflict...`);
        try {
          const prevHeading = c.sectionIndexB > 0 ? h2Headings[c.sectionIndexB - 1] : "none";
          const nextHeading = c.sectionIndexB < h2Headings.length - 1 ? h2Headings[c.sectionIndexB + 1] : "none";
          const fixPrompt = `CRITICAL: Your previous output said "${c.valueB}" which conflicts with another section saying "${c.valueA}". Use "${c.valueA}" consistently.`;
          const regeneratedBody = await regenerateSection(
            { chatWithRetry: makeTrackedChatForStage("claim_fix"), promptContext: context } as GenContext,
            generated.title, sectionB.heading, prevHeading, nextHeading, wordsPerSection, exactKeyphraseTarget, keyphrase,
          );
          // We can't pass custom prompt to regenerateSection, so log the fix instruction instead
          console.log(`[CLAIM-CHECK] fixInstruction="${fixPrompt}"`);
          if (regeneratedBody && countReadableWords(regeneratedBody) > 0) {
            authoritativeSections[c.sectionIndexB].body = regeneratedBody;
            authoritativeSections[c.sectionIndexB].status = "regenerated";
            articleDoc.sections[c.sectionIndexB].html = regeneratedBody;
            articleDoc.sections[c.sectionIndexB].wordCount = countReadableWords(regeneratedBody);
            articleDoc.sections[c.sectionIndexB].status = "regenerated";
            // Re-render
            generated.blog = renderArticleDocument(articleDoc);
            console.log(`[CLAIM-CHECK] Section ${c.sectionIndexB} regenerated`);
          }
        } catch (regenErr) {
          console.error(`[CLAIM-CHECK] Section ${c.sectionIndexB} regeneration failed: ${regenErr instanceof Error ? regenErr.message : String(regenErr)}`);
        }
      }
      // Re-check after regeneration
      const recheckConflicts = detectClaimConflicts(
        authoritativeSections.map((s) => ({ index: s.index, body: s.body })),
        { claims: [] },
      );
      if (recheckConflicts.length > 0) {
        console.error(`[CLAIM-CHECK] ${recheckConflicts.length} conflict(s) still unresolved after regeneration`);
        // Warn but don't abort — claim consistency is informational at this stage
        telemetry.recordWarning(`claimConflicts:${recheckConflicts.length}`);
      }
    }

    // ── Expansion / trimming (deterministic) ──
    console.log("[POST-N5 before expansion/trim word count");
    currentWordCount = countReadableWords(generated.blog);
    const { min: wordMin, max: wordMax } = wordCountRange(requestedWordCount);
    console.log(`[generate-blog:WORDS] initial=${currentWordCount} targetRange=${wordMin}-${wordMax}`);
    console.log("[POST-N5 after word count, articleSize=" + generated.blog.length);

    let expansionAttempts = 0;
    let trimAttempts = 0;

    // ── CTA/FAQ from canonical ArticleDocument fields (not extraction) ──
    console.log("[POST-N6 using canonical ArticleDocument protected blocks");
    const faqBlock = articleDoc.faqSchema?.html || "";
    const ctaBlock = articleDoc.cta?.html || "";

    // ── Diagnostics: conclusion is already clean in ArticleDocument ──
    console.log(`[CTA-EXTRACT] conclusion is stored clean in ArticleDocument`);
    console.log(`[CTA-EXTRACT] ctaLen=${ctaBlock.length} cleanConclusionLen=${articleDoc.conclusion.html.length}`);
    // Verify: canonical conclusion must NOT contain CTA
    if (/app\.b2ihub\.com\/signup/i.test(articleDoc.conclusion.html)) {
      console.error(`[CTA-EXTRACT] ❌ CTA still in canonical conclusion!`);
    } else {
      console.log(`[CTA-EXTRACT] ✓ Canonical conclusion is CTA-free`);
    }
    // ── Stage counts with conclusion fingerprint ──
    const conclusionFingerprint = (() => {
      const clean = articleDoc.conclusion.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const firstSentence = clean.split(/[.!?。！？]/)[0]?.trim().substring(0, 60) || "";
      return firstSentence || articleDoc.conclusion.html.substring(0, 60);
    })();
    const snapCounts = (label: string, html: string) => {
      const fpCount = conclusionFingerprint ? (html.match(new RegExp(conclusionFingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length : -1;
      console.log(`[DUPE-TRACE:${label}] signup=${countSignupUrls(html)} cta=${countCtaHeadings(html)} faq=${countFaqBlocks(html)} conc=${fpCount} chars=${html.length}`);
    };
    snapCounts("initial-blog", generated.blog);
    snapCounts("canonical-conclusion", articleDoc.conclusion.html);
    if (ctaBlock) snapCounts("extracted-cta-block", ctaBlock);
    if (faqBlock) snapCounts("extracted-faq-block", faqBlock);
    console.log("[POST-N6 after extraction, faqBlockLen=" + faqBlock.length + " ctaBlockLen=" + ctaBlock.length + " canonicalConclusionLen=" + articleDoc.conclusion.html.length);

    console.log("[POST-N7 before logSectionState");
    logSectionState("before-expansion");
    console.log("[POST-N7 after logSectionState");
    console.log("[POST-N7.1 articleSize=" + generated.blog.length + " currentWordCount=" + currentWordCount + " wordMin=" + wordMin + " wordMax=" + wordMax);

    if (currentWordCount < wordMin) {
      // ── Per-stage CTA/FAQ/H2/link counting ──
      const countCTA = (h: string) => (h.match(/B2I Hub/i) ?? []).length;
      const countH2s = (h: string) => (h.match(/<h2[^>]*>/gi) ?? []).length;
      const countFAQ = (h: string) => (h.match(/FAQPage/i) ?? []).length;
      const countSignup = (h: string) => (h.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
      const preXpCTA = countCTA(generated.blog);
      const preXpH2 = countH2s(generated.blog);
      const preXpFAQ = countFAQ(generated.blog);
      const preXpSignup = countSignup(generated.blog);
      console.log(`[CMP-COUNT:pre-expand] cta=${preXpCTA} h2=${preXpH2} faq=${preXpFAQ} signup=${preXpSignup}`);

      console.log("[POST-N8 before expandToMinimum");
      const sectionsInput = authoritativeSections.map((s) => ({ index: s.index, heading: s.heading, body: s.body }));
      const result = await expandToMinimum(
        { chatWithRetry },
        sectionsInput.map((s) => ({ ...s })),
        sectionsInput,
        intro, conclusion,
        currentWordCount, wordMin,
        wordsPerSection,
      );
      // Write expanded bodies back by index
      for (const s of result.sections) {
        if (s.index >= 0 && s.index < authoritativeSections.length) {
          authoritativeSections[s.index].body = s.body;
          authoritativeSections[s.index].status = authoritativeSections[s.index].status === "missing" ? "expanded" : "expanded";
        }
      }
      currentWordCount = result.finalWordCount;
      expansionAttempts = result.expansions;
      logSectionState("after-expansion");

      // Safe reassembly — update ArticleDocument, re-render
      const preExpH2 = h2Headings.length;
      const preExpansionHtml = generated.blog;

      // Update document sections with expanded bodies
      for (let i = 0; i < authoritativeSections.length && i < articleDoc.sections.length; i++) {
        articleDoc.sections[i].html = authoritativeSections[i].body;
        articleDoc.sections[i].wordCount = countReadableWords(authoritativeSections[i].body);
        if (authoritativeSections[i].status === "missing") {
          articleDoc.sections[i].status = "expanded";
        }
      }
      generated.blog = renderArticleDocument(articleDoc);
      snapCounts("post-expand-assembly", generated.blog);
      const expGuard = guardStageOutput(generated.blog, preExpansionHtml, assemblyBaseline, "expansion");
      generated.blog = expGuard.html;
      if (!expGuard.accepted) {
        console.warn("[generate-blog:STRUCTURE] Expansion produced invalid HTML — restored pre-expansion version");
        currentWordCount = countReadableWords(generated.blog);
      }
      const postXpCTA = countCTA(generated.blog);
      const postXpH2 = countH2s(generated.blog);
      const postXpFAQ = countFAQ(generated.blog);
      const postXpSignup = countSignup(generated.blog);
      console.log(`[CMP-COUNT:post-expand] cta=${postXpCTA} h2=${postXpH2} faq=${postXpFAQ} signup=${postXpSignup}`);
      if (postXpCTA > preXpCTA) console.warn(`[CMP-COUNT:CTA-DUP] CTA grew from ${preXpCTA} to ${postXpCTA} after expansion reassembly`);
      if (postXpH2 > preXpH2) console.warn(`[CMP-COUNT:H2-DUP] H2 grew from ${preXpH2} to ${postXpH2} after expansion reassembly`);
      const postExpH2 = (generated.blog.match(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? []).length;
      const wpValid = validateWpBlocks(generated.blog);
      console.log(`[generate-blog:STRUCTURE] h2=${postExpH2}/${preExpH2} wpOpening=${wpValid.opening} wpClosing=${wpValid.closing} wpMismatches=${wpValid.mismatches}`);
      if (postExpH2 !== preExpH2) {
        console.error(`[generate-blog:STRUCTURE] H2 changed after expansion: ${preExpH2} → ${postExpH2}. Reverting.`);
        // Restore pre-expansion bodies from backup
        for (const s of sectionsInput) {
          if (s.index >= 0 && s.index < authoritativeSections.length) {
            authoritativeSections[s.index].body = s.body;
          }
        }
        generated.blog = renderArticleDocument(articleDoc);
        snapCounts("post-revert-assembly", generated.blog);
        const revertGuard = guardStageOutput(generated.blog, preExpansionHtml, assemblyBaseline, "expansion-revert");
        generated.blog = revertGuard.html;
        currentWordCount = countReadableWords(generated.blog);
      }
      console.log(`[generate-blog:EXPAND] attempts=${result.expansions} final=${currentWordCount}`);
      console.log("[POST-N8 after expandToMinimum, articleSize=" + generated.blog.length);
    } else if (currentWordCount > wordMax) {
      console.log("[POST-N9 before trimToMaximum");
      const sectionsInput = authoritativeSections.map((s) => ({ index: s.index, heading: s.heading, body: s.body }));
      const result = await trimToMaximum(
        { chatWithRetry },
        sectionsInput.map((s) => ({ ...s })),
        intro, conclusion,
        currentWordCount, wordMax,
      );
      for (const s of result.sections) {
        if (s.index >= 0 && s.index < authoritativeSections.length) {
          authoritativeSections[s.index].body = s.body;
        }
      }
      currentWordCount = result.finalWordCount;
      trimAttempts = result.trims;
      const preTrimHtml = generated.blog;
      // Update document sections with trimmed bodies
      for (let i = 0; i < authoritativeSections.length && i < articleDoc.sections.length; i++) {
        articleDoc.sections[i].html = authoritativeSections[i].body;
        articleDoc.sections[i].wordCount = countReadableWords(authoritativeSections[i].body);
      }
      generated.blog = renderArticleDocument(articleDoc);
      snapCounts("post-trim-assembly", generated.blog);
      const trimGuard = guardStageOutput(generated.blog, preTrimHtml, assemblyBaseline, "trim");
      generated.blog = trimGuard.html;
      if (!trimGuard.accepted) {
        console.warn("[generate-blog:STRUCTURE] Trim produced invalid HTML — restored pre-trim version");
      }
      console.log(`[generate-blog:TRIM] attempts=${result.trims} final=${currentWordCount}`);
      console.log("[POST-N9 after trimToMaximum, articleSize=" + generated.blog.length);
    }
    console.log("[POST-N10 before paragraph normalization, articleSize=" + generated.blog.length);
    const preParagraphHtml = generated.blog;
    const paraResult = normalizeParagraphs(generated.blog, MAX_SENTENCES_PER_PARAGRAPH);
    generated.blog = paraResult.html;
    const paraGuard = guardStageOutput(generated.blog, preParagraphHtml, assemblyBaseline, "paragraphs");
    generated.blog = paraGuard.html;
    console.log(`[generate-blog:PARAGRAPHS] split=${paraResult.splitCount} remaining=${0}`);
    snapCounts("post-paragraphs", generated.blog);
    console.log("[POST-N10 after paragraph normalization, articleSize=" + generated.blog.length);

    // ── Content validation ──
    console.log("[POST-N11 before validateContent");
    const contentReport: ContentValidationReport = validateContent(generated.blog, h2Headings);
    console.log("[POST-N11 after validateContent");
    if (contentReport.issues.length > 0) {
      console.log(`[generate-blog:CONTENT] ${contentReport.errors} error(s), ${contentReport.warnings} warning(s)`);
      for (const issue of contentReport.issues) {
        const prefix = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
        console.log(`  ${prefix} [${issue.check}] ${issue.location}: ${issue.message}`);
      }
      if (contentReport.errors > 0) {
        telemetry.recordMetric("semanticErrors", contentReport.errors);
      }
      if (contentReport.warnings > 0) {
        telemetry.recordMetric("semanticWarnings", contentReport.warnings);
      }
      // Record semantic warnings in telemetry
      for (const issue of contentReport.issues) {
        if (issue.severity === "warning" || issue.severity === "error") {
          telemetry.recordWarning(`content:${issue.check}:${issue.location}`);
        }
      }
    } else {
      console.log("[generate-blog:CONTENT] All checks passed");
    }
    console.log("[POST-N12 before traceHtmlH2 (regeneration prep)");
    traceHtmlH2("7. Before component regeneration", generated.blog, keyphrase);
    console.log("[POST-N12 after traceHtmlH2");

    // ===== POST-GENERATION: Component regeneration pipeline =====
    console.log("[POST-N13 before runComponentRegeneration, articleSize=" + generated.blog.length);
    telemetry.startTimer("regeneration");

    const genCtx: GenContext = {
      chatWithRetry,
      promptContext: context,
    };

    const { blog: regeneratedBlog, title: regeneratedTitle, meta: regeneratedMeta, warnings, logs: regenLogs } = await runComponentRegeneration(
      genCtx,
      { title: generated.title, metaDescription: generated.metaDescription, blog: generated.blog },
      h2Headings,
      keyphrase,
      { intro: introTarget, conclusion: conclusionTarget, perSection: wordsPerSection, keyphraseTarget: exactKeyphraseTarget },
    );

    generated.title = regeneratedTitle;
    generated.metaDescription = regeneratedMeta;
    const preRegenHtml = generated.blog;
    generated.blog = regeneratedBlog;
    const regenGuard = guardStageOutput(generated.blog, preRegenHtml, assemblyBaseline, "regeneration");
    generated.blog = regenGuard.html;
    snapCounts("post-regeneration", generated.blog);
    if (!regenGuard.accepted) {
      console.warn("[generate-blog:REGENERATE] Regenerated HTML failed integrity — restored previous version");
    }
    console.log("[POST-N13 after runComponentRegeneration, articleSize=" + generated.blog.length);
    traceHtmlH2("8. After component regeneration", generated.blog, keyphrase);

    // ── Post-processing: language switcher ──
    console.log("[POST-N14 before language switcher");
    const preSwitcherHtml = generated.blog;
    generated.blog = ensureLanguageSwitcher(generated.blog, {
      currentLanguage: "en",
      englishSlug: slugs.englishSlug,
      chineseSlug: slugs.chineseSlug,
    });
    const switcherGuard = guardStageOutput(generated.blog, preSwitcherHtml, assemblyBaseline, "switcher");
    generated.blog = switcherGuard.html;
    console.log("[generate-blog:LANGUAGE-SWITCHER] inserted=true");
    console.log("[POST-N14 after language switcher, articleSize=" + generated.blog.length);

    // ── Post-processing: external research links ──
    console.log("[POST-N15 before external links");
    const researchItems = context.research?.map((r: any) => ({
      url: r.url || r.link || "",
      title: r.title || r.name || "",
      snippet: r.snippet || r.description || "",
    })) ?? [];
    const preExternalHtml = generated.blog;
    const extLinkResult = insertExternalResearchLinks(generated.blog, researchItems, 3);
    generated.blog = extLinkResult.html;
    const extLinkGuard = guardStageOutput(generated.blog, preExternalHtml, assemblyBaseline, "external-links");
    generated.blog = extLinkGuard.html;
    console.log(`[generate-blog:EXTERNAL-LINKS] candidates=${researchItems.length} injected=${extLinkResult.linksInserted}`);
    console.log("[POST-N15 after external links, articleSize=" + generated.blog.length);

    // ── Deduplicate editorial external links (same URL → keep first, plain text rest) ──
    const dedupResult = deduplicateEditorialExternalLinks(generated.blog);
    generated.blog = dedupResult.html;
    if (dedupResult.removed > 0) {
      console.log(`[generate-blog:EXTERNAL-LINKS] deduplicated ${dedupResult.removed} duplicate external link(s)`);
    }

    // ── Post-processing: repair title ──
    console.log("[POST-N16 before title repair");
    let repairedTitle = generated.title;
    if (!containsExactPhrase(generated.title, keyphrase)) {
      const titlePhrase = keyphrase.charAt(0).toUpperCase() + keyphrase.slice(1);
      const candidate = `${titlePhrase}: What You Need to Know`;
      if (candidate.length >= SEO_TITLE_MIN && candidate.length <= SEO_TITLE_MAX) {
        repairedTitle = candidate;
      } else if (candidate.length < SEO_TITLE_MIN) {
        repairedTitle = `${titlePhrase}: Essential Guide for Hong Kong Marketers`;
      } else {
        repairedTitle = candidate.substring(0, SEO_TITLE_MAX - 3).replace(/\s+[^\s]*$/, "") + "\u2026";
      }
      generated.title = repairedTitle;
      console.log(`[generate-blog:TITLE] exactKeyphrase=${containsExactPhrase(repairedTitle, keyphrase)} length=${repairedTitle.length} repaired=true`);
    } else {
      console.log(`[generate-blog:TITLE] exactKeyphrase=true length=${generated.title.length} repaired=false`);
    }

    const retryCount = regenLogs.filter((l) => l.includes("retry")).length;
    const componentRegens = regenLogs.filter((l) => l.includes("regenerated")).length;
    telemetry.endTimer("regeneration");
    telemetry.recordMetric("retryCount", retryCount);
    telemetry.recordMetric("componentRegenerations", componentRegens);
    console.log("[POST-N16 after title repair");

    // ── Internal link injection ──
    console.log("[POST-N17 before internal links");
    const preLinksHtml = generated.blog;
    const { seedDefaultLinks: seedLinks } = await import("@/lib/services/default-links");
    await seedLinks(userId);
    const { injectLinks } = await import("@/lib/services/link-injector");
    const injectionResult = await injectLinks(generated.blog, userId);
    if (injectionResult.linksInjected > 0) {
      generated.blog = injectionResult.modifiedContent;
      const linkGuard = guardStageOutput(generated.blog, preLinksHtml, assemblyBaseline, "internal-links");
      generated.blog = linkGuard.html;
    }
    console.log(`[generate-blog:INTERNAL-LINKS] injected=${injectionResult.linksInjected}`);
    console.log("[POST-N17 after internal links, articleSize=" + generated.blog.length);

    // ── Final SEO Normalization ──
    console.log("[POST-N18 before SEO normalization");
    logPostMemory("18-normalization-start");
    const preNormalizationHtml = generated.blog;
    logPostSize("18-pre-normalize", preNormalizationHtml);
    const integrityBaseline = createArticleIntegrityBaseline(preNormalizationHtml);
    let normalizationResult: FinalSeoNormalizerResult | null = null;
    let normalizationAccepted = false;
    const rejectionReasons: string[] = [];

    try {
      console.log("[generate-blog:NORMALIZE] Starting final SEO normalization...");
      normalizationResult = await normalizeFinalSeo(
        {
          html: preNormalizationHtml,
          focusKeyphrase: keyphrase,
          targetWordCount: requestedWordCount,
          targetKeyphraseCount: exactKeyphraseTarget,
          minReadingEase: FLESCH_MIN,
          maxReadingEase: FLESCH_MAX,
        },
        chatWithRetry as unknown as (messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>) => Promise<{ content: string }>,
      );

      console.log(`[generate-blog:NORMALIZE] passed=${normalizationResult.passed}`);

      const safety = normalizationResult.safety;
      const ctaPreserved = articleDoc.cta !== null; // structural: CTA never passed to normalizer
      normalizationAccepted =
        normalizationResult.passed === true &&
        safety.protectedBlocksUnchanged === true &&
        safety.linkDestinationsUnchanged === true &&
        safety.wordpressBlocksValid === true &&
        safety.faqSchemaPreserved === true &&
        safety.languageSwitcherPreserved === true &&
        ctaPreserved;

      if (!normalizationAccepted) {
        if (normalizationResult.passed !== true) rejectionReasons.push("passed=false");
        if (!safety.protectedBlocksUnchanged) rejectionReasons.push("protected-blocks-changed");
        if (!safety.linkDestinationsUnchanged) rejectionReasons.push("link-destinations-changed");
        if (!safety.wordpressBlocksValid) rejectionReasons.push("wordpress-blocks-invalid");
        if (!safety.faqSchemaPreserved) rejectionReasons.push("faq-schema-missing");
        if (!safety.languageSwitcherPreserved) rejectionReasons.push("language-switcher-missing");
        if (!ctaPreserved) rejectionReasons.push("cta-missing");
      }

      console.log(`[generate-blog:NORMALIZE] accepted=${normalizationAccepted}`);
      console.log(`[generate-blog:NORMALIZE] rejection reasons=${rejectionReasons.join("; ") || "none"}`);

      if (normalizationAccepted) {
        generated.blog = normalizationResult.html;
        console.log(`[generate-blog:NORMALIZE] Accepted normalized HTML`);
      } else {
        generated.blog = preNormalizationHtml;
        console.log(`[generate-blog:NORMALIZE] fallback used=true`);
        console.log(`[generate-blog:NORMALIZE] Output rejected — restoring exact pre-normalization HTML`);
      }
      snapCounts("post-normalizer", generated.blog);

      if (!normalizationResult.passed) {
        console.warn(`[generate-blog:NORMALIZE] Normalization warnings (${normalizationResult.warnings.length}): ${normalizationResult.warnings.join("; ")}`);
        warnings.push(...normalizationResult.warnings.map((w) => `seo-normalizer: ${w}`));
      }

      telemetry.recordMetric("normalizerAccepted", normalizationAccepted ? 1 : 0);
      telemetry.recordMetric("normalizerBeforeWC", normalizationResult.before.readableWordCount);
      telemetry.recordMetric("normalizerAfterWC", normalizationResult.after.readableWordCount);
      telemetry.recordMetric("normalizerChanges", normalizationResult.changes.length);
    } catch (normErr) {
      console.error(`[generate-blog:NORMALIZE] Normalization error (non-fatal): ${normErr instanceof Error ? normErr.message : String(normErr)}`);
      console.log(`[generate-blog:NORMALIZE] fallback used=true`);
      telemetry.recordWarning(`normalizationFailed:${normErr instanceof Error ? normErr.message : String(normErr)}`);
      generated.blog = preNormalizationHtml;
    }

    // ── Final article integrity gate (runs before save) ──
    const finalIntegrity = validateFinalArticleIntegrity(generated.blog, integrityBaseline);
    const wpPairResult = validateWordpressBlockPairs(generated.blog);
    if (!finalIntegrity.valid || !wpPairResult.valid) {
      console.error(`[generate-blog:INTEGRITY] Final article integrity FAILED`);
      for (const err of finalIntegrity.errors) {
        console.error(`[generate-blog:INTEGRITY]   ${err}`);
      }
      if (!wpPairResult.valid) {
        for (const issue of wpPairResult.issues) {
          console.error(`[generate-blog:INTEGRITY]   wpPair: ${issue}`);
        }
      }

      // If the current blog is the accepted normalized version, try falling back to pre-normalization
      if (normalizationAccepted && generated.blog !== preNormalizationHtml) {
        console.log("[generate-blog:INTEGRITY] Accepted HTML failed integrity — restoring pre-normalization snapshot");
        generated.blog = preNormalizationHtml;
        const fallbackIntegrity = validateFinalArticleIntegrity(preNormalizationHtml, integrityBaseline);
        const fallbackWpPair = validateWordpressBlockPairs(preNormalizationHtml);
        if (!fallbackIntegrity.valid || !fallbackWpPair.valid) {
          console.error("[generate-blog:INTEGRITY] Pre-normalization HTML also failed integrity — aborting save");
          telemetry.recordWarning("integrityGateFailure:both");
          return NextResponse.json({
            error: "Article integrity validation failed",
            detail: "Neither normalized nor pre-normalization HTML passed the integrity gate",
            integrity: fallbackIntegrity,
          }, { status: 422 });
        }
        console.log("[generate-blog:INTEGRITY] Pre-normalization HTML passes integrity — continuing with fallback");
        telemetry.recordWarning("integrityGateFallback:preNormalization");
      } else if (!normalizationAccepted && generated.blog === preNormalizationHtml) {
        // Pre-normalization HTML itself failed integrity — abort
        console.error("[generate-blog:INTEGRITY] Pre-normalization HTML failed integrity — aborting save");
        telemetry.recordWarning("integrityGateFailure:preNormalization");
        return NextResponse.json({
          error: "Article integrity validation failed",
          detail: "Pre-normalization HTML failed the integrity gate",
          integrity: finalIntegrity,
        }, { status: 422 });
      } else {
        console.error("[generate-blog:INTEGRITY] Integrity gate failure — aborting save");
        telemetry.recordWarning("integrityGateFailure");
        return NextResponse.json({
          error: "Article integrity validation failed",
          detail: finalIntegrity.errors.join("; "),
          integrity: finalIntegrity,
        }, { status: 422 });
      }
    } else {
      console.log("[generate-blog:INTEGRITY] Final article integrity PASSED");
    }
    console.log("[POST-N19 after integrity gate, articleSize=" + generated.blog.length);

    // ── Immutable final values ──
    console.log("[POST-N20 before final structural validation");
    const finalBlogHtml = generated.blog;
    snapCounts("pre-save", finalBlogHtml);
    const finalTitle = generated.title;
    const finalMetaDescription = generated.metaDescription;
    const finalWordCount = countReadableWords(finalBlogHtml);

    // ── Final structural validation ──
    const finalH2Count = (finalBlogHtml.match(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? []).length;
    const hasDupFinal = /<h2[^>]*>([\s\S]*?)<\/h2>\s*(?:<!--\s*\/wp:heading\s*-->)?\s*(?:<!--\s*wp:heading[^>]*-->)?\s*<h2[^>]*>\s*\1\s*<\/h2>/i.test(finalBlogHtml);
    const hasNestedFinal = detectNestedParagraphs(finalBlogHtml) > 0;
    const switcherPresent = /b2i-language-switcher/i.test(finalBlogHtml);
    const faqPresent = /FAQPage|application\/ld\+json.*faq/i.test(finalBlogHtml);
    const titleHasKeyphrase = containsExactPhrase(finalTitle, keyphrase);
    const titleLen = finalTitle.length;

    console.log(`[generate-blog:FINAL-STRUCTURAL] h2Count=${finalH2Count}/${h2Headings.length} dupH2=${hasDupFinal} nestedP=${hasNestedFinal} switcher=${switcherPresent} faq=${faqPresent}`);
    console.log(`[generate-blog:FINAL-SEO] title=${titleLen}ch keyphrase=${titleHasKeyphrase} words=${finalWordCount} range=${wordMin}-${wordMax}`);

    if (finalH2Count !== h2Headings.length || hasDupFinal || hasNestedFinal || !switcherPresent) {
      telemetry.recordWarning("finalStructuralFailure");
      console.error("[generate-blog:FINAL] Structural validation failed — aborting save");
      return NextResponse.json({ error: "Final structural validation failed", failures: [
        !(finalH2Count === h2Headings.length) ? `H2 count mismatch: ${finalH2Count}/${h2Headings.length}` : null,
        hasDupFinal ? "Duplicate consecutive H2" : null,
        hasNestedFinal ? "Nested paragraph tags" : null,
        !switcherPresent ? "Language switcher missing" : null,
      ].filter(Boolean) }, { status: 422 });
    }

    // ── FAQ parity validation — extract visible Q&A and schema from finalBlogHtml ──
    const faqSchemaBlock = extractFaqBlock(finalBlogHtml);
    if (faqSchemaBlock) {
      // Extract visible FAQ questions AND answers from the FAQ section region only
      const visibleFaqPairs = extractVisibleFaqFromArticle(finalBlogHtml);

      if (visibleFaqPairs.length > 0) {
        const visibleEntries = visibleFaqPairs.map((p) => ({
          question: p.question,
          answerHtml: "",
          answerText: p.answerText,
        }));

        const parityResult = validateFaqParity(visibleEntries, faqSchemaBlock);
        if (!parityResult.valid) {
          console.error(`[generate-blog:FAQ-PARITY] FAQ schema/visible mismatch from final HTML: ${parityResult.issues.map((i) => i.detail).join("; ")}`);
          telemetry.recordWarning(`faqParityFailed:${parityResult.issues.length}`);
          return NextResponse.json({
            error: "FAQ parity validation failed",
            detail: parityResult.issues.map((i) => i.detail).join("; "),
            issues: parityResult.issues,
          }, { status: 422 });
        }
        console.log(`[generate-blog:FAQ-PARITY] FAQ schema matches visible entries in final HTML — valid (${visibleFaqPairs.length} questions, answers checked)`);
      }
    }

    // ── Final invariant check (must run BEFORE save — prevents invalid articles from being persisted) ──
    const finalInvariant = validateFinalArticleInvariants(finalBlogHtml);
    if (!finalInvariant.valid) {
      console.error(`[generate-blog:INVARIANT] Final invariant FAILED: ${finalInvariant.errors.join("; ")}`);
      telemetry.recordWarning(`finalInvariantFailed:${finalInvariant.errors.join("|")}`);
      return NextResponse.json({
        error: "Final article invariant validation failed",
        detail: finalInvariant.errors.join("; "),
        counts: finalInvariant.counts,
      }, { status: 422 });
    }

    // ── Save/audit parity: use immutable values ──
    const generationTimeMs = Date.now() - startTime;
    const articleBodyText = finalBlogHtml
      .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    // Save blog version with final values
    console.log("[POST-N21 before save");
    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(projectId));
    console.log(`[generate-blog:VERSION] Next version: ${nextVersion}`);

    await blogVersionRepository.create({
      projectId: Number(projectId),
      userId,
      versionNumber: nextVersion,
      title: finalTitle,
      slug: generated.slug,
      metaDescription: finalMetaDescription,
      excerpt: generated.excerpt,
      blog: finalBlogHtml,
      faq: generated.faq,
      internalLinks: generated.internalLinks,
      externalLinks: generated.externalLinks,
      categories: generated.categories,
      tags: generated.tags,
      readingTime: generated.readingTime,
      wordCount: finalWordCount,
      summary: generated.summary,
      model: "section-by-section",
      generationTimeMs: Date.now() - startTime,
      tokenUsage: { totalTokens: 0 },
      status: "draft",
    });

    await projectRepository.update(Number(projectId), {
      content: finalBlogHtml,
    });

    console.log(`[generate-blog:FINAL-PARITY] blog=true title=${titleHasKeyphrase} meta=${finalMetaDescription.length > 0} words=${finalWordCount === countReadableWords(finalBlogHtml)}`);

    await aiLogRepository.create({
      userId,
      model: "section-by-section",
      endpoint: "/api/generate-blog",
      status: "success",
      projectId: Number(projectId),
      promptSize: systemPrompt.length + userMessage.length,
      completionSize: finalBlogHtml.length,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      generationTimeMs: Date.now() - startTime,
    });
    console.log("[POST-N21 after save");

    // ── Quality scoring (on final immutable values) ──
    console.log("[POST-N22 before quality scoring");
    const estimatedTokens = Math.round((systemPrompt.length + userMessage.length) / 4 * (2 + h2Headings.length + 3));
    const qualityReport = buildGenerationReport(
      finalBlogHtml, finalTitle, finalMetaDescription,
      keyphrase, requestedWordCount, (generated.faq || []).length,
      generationTimeMs, retryCount, 0, componentRegens, warnings, estimatedTokens,
      articleDoc.sections.length, // editorial H2 count (excludes CTA heading)
    );
    console.log(formatReport(qualityReport));

    telemetry.recordMetric("qualityScore", qualityReport.qualityScore.overall);
    telemetry.recordMetric("wordCount", finalWordCount);
    telemetry.recordMetric("targetWordCount", requestedWordCount);
    telemetry.recordMetric("titleLength", finalTitle.length);
    telemetry.recordMetric("metaLength", finalMetaDescription.length);
    telemetry.endTimer("total");
    console.log("[POST-N22 after quality scoring, before response");

    // ── Analytics (passive) ──
    try {
      const analyticsRecord = buildAnalyticsRecord(
        Number(projectId),
        finalTitle,
        telemetry.generateReport(),
        qualityReport.qualityScore,
        requestedWordCount,
        finalWordCount,
        warnings,
        Number(contentReport?.warnings ?? 0),
        Number(contentReport?.errors ?? 0),
      );
      await generationAnalyticsRepository.insert(analyticsRecord as unknown as Record<string, unknown>);
      console.log("[generate-blog:ANALYTICS] Saved");
    } catch (analyticsErr) {
      console.error("[generate-blog:ANALYTICS] Failed (non-fatal):", analyticsErr instanceof Error ? analyticsErr.message : String(analyticsErr));
    }

    snapCounts("api-response", finalBlogHtml);
    // ── KP-FINAL ──
    const finalWC = countReadableWords(finalBlogHtml);
    const finalKP = countExactPhrase(extractReadableText(finalBlogHtml), keyphrase);
    const finalRange = keyphraseRangeForWordCount(finalWC);
    const finalInRange = finalKP >= finalRange.min && finalKP <= finalRange.max;
    console.log(`[KP-FINAL] wordCount=${finalWC} exactCount=${finalKP} preferred=${exactKeyphraseTarget} min=${finalRange.min} max=${finalRange.max} passed=${finalInRange}`);
    if (normalizationResult) {
      const beforeKP = normalizationResult.before.exactKeyphraseCount;
      const afterKP = normalizationResult.after.exactKeyphraseCount;
      const removed = Math.max(0, beforeKP - afterKP);
      const added = Math.max(0, afterKP - beforeKP);
      console.log(`[KP-FINAL] beforeNorm=${beforeKP} afterNorm=${afterKP} removed=${removed} added=${added}`);
    }

    // ── Quality diagnostics ──
    const qcTitleHasKp = finalTitle.toLowerCase().includes(keyphrase);
    const qcFirst100 = getFirstNReadableWords(finalBlogHtml, 100).toLowerCase().includes(keyphrase);
    const qcSwitcher = hasLanguageSwitcher(finalBlogHtml);
    const qcCtaHeads = countCtaHeadingTags(finalBlogHtml);
    const qcEditorialLinks = countEditorialExternalLinks(finalBlogHtml);
    const qcRange = keyphraseRangeForWordCount(finalWC);
    const qcWpOk = validateWpBlocks(finalBlogHtml).mismatches === 0;
    console.log(`[QUALITY-CHECK] titleHasKeyphrase=${qcTitleHasKp} first100HasKeyphrase=${qcFirst100} languageSwitcher=${qcSwitcher} ctaHeadingCount=${qcCtaHeads} editorialExternalLinks=${qcEditorialLinks} wordCount=${finalWC} acceptedMinimum=${qcRange.min} acceptedMaximum=${qcRange.max} wordCountWithinRange=${finalWC >= qcRange.min && finalWC <= qcRange.max} wpBlocksValid=${qcWpOk}`);

    console.log("[POST-N23 before final response JSON");
    logPostMemory("23-response");
    return NextResponse.json(
      {
        success: true,
        version: nextVersion,
        title: finalTitle,
        slug: generated.slug,
        metaDescription: finalMetaDescription,
        excerpt: generated.excerpt,
        blog: finalBlogHtml,
        faq: generated.faq,
        internalLinks: generated.internalLinks,
        externalLinks: generated.externalLinks,
        categories: generated.categories,
        tags: generated.tags,
        readingTime: generated.readingTime,
        wordCount: finalWordCount,
        summary: generated.summary,
        model: "section-by-section",
        generationTimeMs: Date.now() - startTime,
        tokenUsage: { totalTokens: 0 },
        qualityScore: qualityReport.qualityScore,
        finalValidation: {
          h2Count: finalH2Count,
          h2Expected: h2Headings.length,
          hasDuplicates: hasDupFinal,
          hasNestedParagraphs: hasNestedFinal,
          hasLanguageSwitcher: switcherPresent,
          hasFaqSchema: faqPresent,
          titleLength: finalTitle.length,
          titleHasKeyphrase,
          wordCount: finalWordCount,
          wordCountRange: `${wordMin}-${wordMax}`,
        },
        normalization: normalizationResult ? {
          passed: normalizationResult.passed,
          changes: normalizationResult.changes.length,
          before: normalizationResult.before,
          after: normalizationResult.after,
          warnings: normalizationResult.warnings,
        } : null,
        telemetry: telemetry.generateReport(),
      },
      { status: 201 }
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[generate-blog:POST]", {
      errorName: err.constructor.name,
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 10).join("\n"),
    });

    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      {
        error: "Failed to generate blog",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
