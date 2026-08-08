// ── Blog Generation Service ──
// Contains all generation logic: context loading, DeepSeek calls, assembly, pipeline.
// route.ts handles only auth, request validation, persistence, and response.

import {
  projectRepository, researchRepository, knowledgeRepository,
  promptSectionRepository,
} from "@/lib/repositories";
import { buildBlogPrompt, buildOutlineBrief, type BlogContext } from "@/lib/services/prompt-builder";
import { getCompiledBundle } from "@/lib/services/prompt-compiler";
import { AiService, type ChatMessage, type ChatOptions } from "@/lib/services/deepseek";
import { AppError } from "@/lib/services/errors";
import { countReadableWords, robustJsonParse, repairMetaDescription, containsExactPhrase } from "@/lib/services/text-utils";
import { extractEditorialExternalLinkUrls } from "@/lib/seo/seo-text-utils";
import { runBraveResearchWithRetry } from "@/lib/services/brave";
import { WORD_ALLOCATION, GENERATION_WORD_BUFFER } from "@/lib/services/generation-constants";
import { englishWordTolerance, englishMetaRange, computeKeyphraseTargets, getKeyphraseContentWordCount, dynamicH2Range, dynamicFaqRange } from "@/lib/content-standards";
import { runComponentRegeneration, regenerateIntroduction, regenerateSection, regenerateConclusion, type GenContext } from "@/lib/services/component-regenerator";
import { buildGenerationReport } from "@/lib/services/quality-scorer";
import { GenerationTelemetry } from "@/lib/services/generation-telemetry";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { type ArticleDocument, renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, extractVisibleFaqFromArticle, extractFaqPairsFromSectionBody, renderComponentHtml, countComponentWords, countCanonicalVisibleWords } from "@/lib/blog/article-document";
import { buildPolicy, analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { createPipelineState, runPostAssemblyPipeline, type PipelineState, type PipelineDependencies, validatePipelineOrder } from "@/lib/pipeline/blog-generation-pipeline";
import { pairedSlugs, sanitizeSectionUrls, isEligibleExternalSourceUrl, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";
import { CTA_CONTENT_RE, normalizeAiEditorialPayload, renderEditorialBlocksToWordPress, parseWordPressEditorialBlocks } from "@/lib/blog/article-content";
import { buildClaimOwnershipLedger, formatOwnedEvidencePacket } from "@/lib/blog/claim-ownership";
import { stripSourceBoilerplate } from "@/lib/blog/source-boilerplate";
import { repairHeadingNaturalness } from "@/lib/blog/content-relevance";

export class OutlineHeadingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlineHeadingValidationError";
  }
}

/** Normalize an AI outline to the canonical H2 policy.
 * dynamicH2Range() counts editorial H2s only; the FAQ heading is additional. */
export function normalizeOutlineHeadings(
  rawHeadings: unknown,
  requestedWordCount: number,
  title: string,
  keyphrase: string,
): string[] {
  const faqPattern = /faq|frequently\s*asked|common\s*questions?/i;
  const conclusionPattern = /^(?:conclusion|summary|final thoughts?|wrap[ -]?up|key takeaways?)(?:\s*[:—–-].*)?$/i;
  const { min: editorialMin, max: editorialMax } = dynamicH2Range(requestedWordCount);

  const cleaned = Array.isArray(rawHeadings)
    ? rawHeadings
        .filter((heading): heading is string => typeof heading === "string")
        .map((heading) => heading.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    : [];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const heading of cleaned) {
    const key = heading.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(heading);
    }
  }

  const existingFaq = unique.find((heading) => faqPattern.test(heading));
  const repairedEditorial: string[] = [];
  for (const [index, heading] of unique
    .filter((candidate) => !faqPattern.test(candidate) && !conclusionPattern.test(candidate))
    .entries()) {
    const repair = repairHeadingNaturalness(heading, keyphrase, `outline-${index}`);
    if (!repair.resolved) {
      throw new OutlineHeadingValidationError(
        `Outline H2 ${index + 1} is not safely repairable: ${repair.remainingViolations.map((item) => item.code).join(", ")} — "${heading}"`,
      );
    }
    if (repair.changed) {
      console.log(
        `[outline-heading-normalization] index=${index} issues=${repair.initialViolations.map((item) => item.code).join(",")} before=${JSON.stringify(repair.original)} after=${JSON.stringify(repair.heading)}`,
      );
    }
    if (!repairedEditorial.some((candidate) => candidate.toLowerCase() === repair.heading.toLowerCase())) {
      repairedEditorial.push(repair.heading);
    }
  }
  let editorial = repairedEditorial;
  if (editorial.length > editorialMax) editorial = editorial.slice(0, editorialMax);

  const topic = (title || keyphrase || "This Topic").replace(/:.*$/, "").trim();
  const fallbackCandidates = [
    `Why ${topic} Matters in Hong Kong`,
    `How to Build a Practical ${topic} Strategy`,
    `Content and Execution Tips for ${topic}`,
    `How to Measure Results from ${topic}`,
    `Common ${topic} Mistakes to Avoid`,
    `Next Steps for ${topic}`,
    `${topic}: A Practical Action Plan`,
    `Tools and Resources for ${topic}`,
  ];

  for (const candidate of fallbackCandidates) {
    if (editorial.length >= editorialMin) break;
    const repair = repairHeadingNaturalness(candidate, keyphrase, `outline-fallback-${editorial.length}`);
    if (!repair.resolved) continue;
    const key = repair.heading.toLowerCase();
    if (!editorial.some((heading) => heading.toLowerCase() === key)) editorial.push(repair.heading);
  }

  if (editorial.length < editorialMin) {
    throw new OutlineHeadingValidationError(
      `Outline produced ${editorial.length} editorial H2 headings; ${editorialMin}-${editorialMax} required`,
    );
  }

  const faqHeading = existingFaq || `Frequently Asked Questions About ${topic}`;
  return [...editorial, faqHeading];
}

function extractOutlineHeadings(outline: unknown): string[] {
  if (!outline || typeof outline !== "object") return [];
  const record = outline as Record<string, unknown>;
  if (Array.isArray(record.h2Headings)) return record.h2Headings.filter((item): item is string => typeof item === "string");
  if (Array.isArray(record.headings)) return record.headings.filter((item): item is string => typeof item === "string");
  if (!Array.isArray(record.sections)) return [];
  return record.sections
    .map((section) => {
      if (typeof section === "string") return section;
      if (!section || typeof section !== "object") return "";
      const item = section as Record<string, unknown>;
      return typeof item.heading === "string" ? item.heading : typeof item.title === "string" ? item.title : "";
    })
    .filter(Boolean);
}

/** Model-produced metadata is plain text, never an HTML or WordPress surface. */
function normalizeOutlinePlainText(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value;
  // Two passes also remove tags that were entity-encoded once.
  for (let pass = 0; pass < 2; pass++) {
    text = text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:39|x27);/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }
  return text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

interface AcceptedFaqPayload {
  entries: Array<{ question: string; answer: string }>;
  errors: string[];
}

function validateFaqPayload(raw: unknown, min: number, max: number): AcceptedFaqPayload {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).entries)) {
    return { entries: [], errors: ["entries must be an array"] };
  }
  const rawEntries = (raw as { entries: unknown[] }).entries;
  const errors: string[] = [];
  if (rawEntries.length < min || rawEntries.length > max) {
    errors.push(`entry count ${rawEntries.length}; expected ${min}-${max}`);
  }
  const entries: Array<{ question: string; answer: string }> = [];
  for (const [index, entry] of rawEntries.entries()) {
    if (!entry || typeof entry !== "object") {
      errors.push(`entry ${index + 1} must be an object`);
      continue;
    }
    const item = entry as Record<string, unknown>;
    const question = typeof item.question === "string" ? item.question.replace(/\s+/g, " ").trim() : "";
    const answer = typeof item.answer === "string" ? item.answer.replace(/\s+/g, " ").trim() : "";
    if (!question) errors.push(`entry ${index + 1} has an empty question`);
    if (!answer) errors.push(`entry ${index + 1} has an empty answer`);
    if (/<!--[\s\S]*?-->|<[^>]+>|```/.test(question) || /<!--[\s\S]*?-->|<[^>]+>|```/.test(answer)) {
      errors.push(`entry ${index + 1} contains markup`);
    }
    const faqCopy = `${question} ${answer}`;
    if (
      CTA_CONTENT_RE.test(faqCopy)
      || /https?:\/\/\S*(?:signup|register|sign-up)|app\.b2ihub\.com\/signup|\b(?:sign[- ]?up|register)\b/i.test(faqCopy)
    ) {
      errors.push(`entry ${index + 1} contains protected CTA/signup copy`);
    }
    if (/\p{Script=Han}/u.test(question) || /\p{Script=Han}/u.test(answer)) {
      errors.push(`entry ${index + 1} is not English-only`);
    }
    entries.push({ question, answer });
  }
  return { entries, errors };
}

export { buildGenerationReport, buildPolicy, analyzeFinalArticle, evaluatePolicy, validatePipelineOrder };

export interface GenerationResult {
  generated: {
    title: string; slug: string; metaDescription: string; excerpt: string;
    blog: string; faq: Array<{ question: string; answer: string }>;
    internalLinks: string[]; externalLinks: string[];
    categories: string[]; tags: string[]; readingTime: string; summary: string;
  };
  pipelineState: PipelineState;
  qualityReport: any;
  h2Headings: string[];
  wordMin: number;
  wordMax: number;
  retryCount: number;
  componentRegens: number;
  estimatedTokens: number;
  systemPrompt: string;
  userMessage: string;
}

/** Optional overrides for test dependency injection. */
export interface GenerationOverrides {
  /** When provided, replaces the internal DeepSeek request function. */
  requestDeepSeek?: (stage: string, messages: ChatMessage[], options?: ChatOptions) => Promise<{ content: string }>;
}

export interface ResearchDispatchDecision {
  mode: "manual" | "auto" | "auto-ineligible";
  existingCount: number;
  willRun: boolean;
  reason: string;
}

/**
 * Run lazy generation tasks with bounded concurrency. On the first failure no
 * further task is started, but every already-running sibling is awaited before
 * the failure escapes. This prevents late model completions from outliving a
 * failed generation boundary.
 */
export async function runGenerationTasksWithConcurrency<T>(
  taskFns: Array<() => Promise<T>>,
  limit: number,
  onActiveCount?: (active: number) => void,
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer");
  const results: T[] = new Array(taskFns.length);
  let nextIndex = 0;
  let active = 0;
  let failed = false;
  let firstFailure: unknown;

  async function worker(): Promise<void> {
    while (!failed && nextIndex < taskFns.length) {
      const index = nextIndex++;
      active++;
      onActiveCount?.(active);
      try {
        results[index] = await taskFns[index]();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
      } finally {
        active--;
        onActiveCount?.(active);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, taskFns.length) },
    () => worker(),
  );
  await Promise.all(workers);
  if (failed) throw firstFailure;
  return results;
}

/**
 * Deterministic research-dispatch decision for a normal blog generation.
 *
 * Contract (supported by the UI generation step "Loading Research", the
 * English pipeline doc's "research/evidence preparation" first step, and the
 * generation prompts that assign approved evidence to body sections):
 * research is automatic by default; manually generated sources are used as-is
 * and suppress automatic research.
 */
export function resolveResearchDispatch(
  existingCount: number,
  topic: string,
): ResearchDispatchDecision {
  if (existingCount > 0) {
    return {
      mode: "manual",
      existingCount,
      willRun: false,
      reason: `manual research already present (${existingCount} sources)`,
    };
  }
  if (!topic || !topic.trim()) {
    return {
      mode: "auto-ineligible",
      existingCount: 0,
      willRun: false,
      reason: "no keyword or topic to research",
    };
  }
  return {
    mode: "auto",
    existingCount: 0,
    willRun: true,
    reason: "no approved research; automatic research eligible",
  };
}

/** Deduplicate research items by normalized URL, preserving first occurrence. */
export function deduplicateResearchItems<T extends { url?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const normalized = item.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(item);
  }
  return out;
}

export async function runBlogGeneration(
  userId: string,
  projectId: number,
  overrides?: GenerationOverrides,
): Promise<GenerationResult> {
  const telemetry = new GenerationTelemetry();
  telemetry.startTimer("total");

  const project = await projectRepository.findById(Number(projectId));
  if (!project) throw AppError.internal();

  const ai = new AiService(telemetry);
  const trackedChat = overrides?.requestDeepSeek
    ? overrides.requestDeepSeek
    : (stage: string, messages: ChatMessage[], options?: ChatOptions) => ai.call(stage, messages, options);
  const pipelineChatWithRetry = overrides?.requestDeepSeek
    ? (messages: ChatMessage[], options?: ChatOptions, stage = "pipeline") =>
        overrides.requestDeepSeek!(stage, messages, options)
    : ai.chatWithRetry;
  const makeTrackedChatForStage = overrides?.requestDeepSeek
    ? (stage: string) => (messages: ChatMessage[], options?: ChatOptions) =>
        overrides.requestDeepSeek!(stage, messages, options)
    : (stage: string) => ai.makeCallerForStage(stage);

  const research = await researchRepository.findByProject(Number(projectId));
  const knowledge = await knowledgeRepository.findByUser(userId);
  await promptSectionRepository.seedDefaults(userId);
  const promptSections = await promptSectionRepository.findByUser(userId);

  // ── Research dispatch ──
  // Automatic by default: when no approved research rows exist, run the
  // research provider for the project topic and persist the results so the
  // article pipeline, factual scanner, claim ownership and external-link
  // stages all receive the same approved sources. Manually generated rows
  // suppress automatic research. Provider failures degrade to the previous
  // no-research behavior with a clear warning — never fake sources.
  const researchTopic = project.keyword || project.name || "";
  const dispatch = resolveResearchDispatch(research.length, researchTopic);
  console.log(
    `[research-dispatch] requested=auto resolvedMode=${dispatch.mode}` +
    ` autoEligible=${dispatch.willRun} manualSources=${research.length}` +
    ` willRun=${dispatch.willRun} reason="${dispatch.reason}"`,
  );
  const researchWarnings: string[] = [];
  if (dispatch.willRun) {
    console.log(`[research:start] topic="${researchTopic}" mode=auto`);
    try {
      const rawResults = await runBraveResearchWithRetry(researchTopic);
      const deduped = deduplicateResearchItems(rawResults);
      console.log(
        `[research:provider] calls=1 success=${deduped.length > 0 ? 1 : 0}` +
        ` failed=${deduped.length > 0 ? 0 : 1}` +
        ` raw=${rawResults.length} parsed=${deduped.length}`,
      );
      if (deduped.length === 0) {
        console.log(`[research:results] raw=${rawResults.length} parsed=0 approved=0 rejected=${rawResults.length}`);
        researchWarnings.push("Automatic research returned no sources; generation continues without research evidence.");
      } else {
        await researchRepository.createMany(
          deduped.map((item) => ({
            projectId: Number(projectId),
            category: item.category,
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            position: item.position,
          })),
        );
        const persisted = await researchRepository.findByProject(Number(projectId));
        research.splice(0, research.length, ...persisted);
        const eligible = research.filter((item) => isEligibleExternalSourceUrl(item.url)).length;
        console.log(
          `[research:results] raw=${rawResults.length} parsed=${deduped.length}` +
          ` approved=${research.length} rejected=${rawResults.length - deduped.length}`,
        );
        console.log(
          `[research:handoff] claims=0 sources=${research.length} externalLinkCandidates=${eligible}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[research:provider] failed=1 error="${message}"`);
      console.log(`[research:results] raw=0 parsed=0 approved=0 rejected=0`);
      researchWarnings.push(
        `Automatic research failed (${message}); generation continues without research evidence.`,
      );
    }
  } else {
    const eligible = research.filter((item) => isEligibleExternalSourceUrl(item.url)).length;
    console.log(
      `[research:handoff] claims=0 sources=${research.length} externalLinkCandidates=${eligible}`,
    );
  }

  const context: BlogContext = {
    project: {
      name: project.name, keyword: project.keyword,
      audience: project.audience, country: project.country,
      wordCount: Number((project as any).word_count ?? 0),
      content: project.content ?? "", status: project.status,
    },
    research: research.map((r: any) => ({ category: r.category, title: r.title, snippet: stripSourceBoilerplate(r.snippet ?? ""), url: r.url })),
    knowledge: knowledge.map((k: any) => ({ title: k.title, content: k.content, tags: k.tags })),
    promptSections: promptSections.map((s: any) => ({ key: s.section_key ?? "", label: s.section_key ?? "", content: s.content })),
    generationDate: new Date().toISOString().slice(0, 10),
  };

  const { systemPrompt } = buildBlogPrompt(context);
  const userMessage = buildOutlineBrief(context);
  const { bundle } = getCompiledBundle(context);
  const requestedWordCount = context.project.wordCount || 2500;

  const { min: wordMin, max: wordMax } = englishWordTolerance(requestedWordCount);
  const { min: editorialH2Min, max: editorialH2Max } = dynamicH2Range(requestedWordCount);
  const keyphrase = (context.project.keyword ?? "").toLowerCase();

  // Phase A: Outline. The dynamic H2 range counts editorial headings only;
  // the required FAQ heading is additional and always last.
  const outlineSystemPrompt = bundle.outlineSystem;
  const outlinePrompt = userMessage + `

=== STEP 1 ===
Return ONLY an outline. Generate exactly ${editorialH2Min} editorial H2 section headings (the accepted editorial range is ${editorialH2Min}-${editorialH2Max}), followed by one final FAQ H2 heading (${editorialH2Min + 1} headings total). Do not include a Conclusion or Summary H2. The LAST heading MUST be an FAQ section. Do NOT write full content yet. Keep the title, slug, meta description and headings topic-level: do not place research statistics, percentages, dates, currencies, survey findings, quotations or source names in metadata or headings. Precise evidence will be assigned to one body section after the outline is approved. Write the title, slug, meta description and headings in ENGLISH ONLY — never use Chinese characters, and never end the slug with "-zh". Return as JSON: {"title": "...", "slug": "...", "metaDescription": "...", "h2Headings": ["Editorial Heading 1", "Editorial Heading 2", "...", "Frequently Asked Questions About [Topic]"]}.`;

  const outlineRes = await trackedChat("outline",
    [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 4096, timeoutMs: 60_000 }
  );

  let outline: any;
  try {
    outline = robustJsonParse(outlineRes.content, "outline");
  } catch {
    const retryRes = await trackedChat("outline_retry",
      [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt + "\n\nCRITICAL: You MUST output valid JSON only." }],
      { responseFormat: { type: "json_object" }, maxTokens: 4096, timeoutMs: 60_000 }
    );
    outline = robustJsonParse(retryRes.content, "outline-retry");
  }

  if (!outline || typeof outline !== "object" || Array.isArray(outline)) {
    throw AppError.internal(new Error("Outline response must be a JSON object"));
  }

  outline.title = normalizeOutlinePlainText(outline?.title) || "Untitled";
  outline.metaDescription = normalizeOutlinePlainText(outline?.metaDescription);
  outline.excerpt = normalizeOutlinePlainText(outline?.excerpt);

  let h2Headings = extractOutlineHeadings(outline);
  if (h2Headings.length === 0) {
    console.error("[blog-generation] No H2 headings generated. Outline keys:", Object.keys(outline));
    throw AppError.internal(new Error("No H2 headings generated"));
  }

  // Normalize the outline to the canonical policy: editorialH2Min-editorialH2Max
  // editorial headings plus exactly one FAQ heading at the end.
  try {
    h2Headings = normalizeOutlineHeadings(
      h2Headings,
      requestedWordCount,
      outline?.title || "",
      keyphrase,
    );
  } catch (error) {
    if (!(error instanceof OutlineHeadingValidationError)) throw error;
    console.warn(`[outline-heading-validation] retrying before drafting: ${error.message}`);
    const qualityRetryPrompt = `${outlinePrompt}\n\nYour previous outline headings failed deterministic acceptance: ${error.message}. Return ONLY JSON containing a corrected \"h2Headings\" array. Preserve the intended section topics, but remove repeated years, repeated locations, duplicated keyphrases and topic phrases repeated across a colon. Do not include full article content. Previous headings: ${JSON.stringify(h2Headings)}`;
    const retryRes = await trackedChat("outline_quality_retry",
      [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: qualityRetryPrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 4096, timeoutMs: 60_000 },
    );
    const retryOutline = robustJsonParse(retryRes.content, "outline-quality-retry");
    const retryHeadings = extractOutlineHeadings(retryOutline);
    if (retryHeadings.length === 0) {
      throw AppError.internal(new Error("Outline heading quality retry returned no H2 headings"));
    }
    try {
      h2Headings = normalizeOutlineHeadings(
        retryHeadings,
        requestedWordCount,
        outline?.title || "",
        keyphrase,
      );
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      throw AppError.internal(new Error(`Outline headings failed deterministic acceptance after one targeted retry: ${message}`));
    }
  }
  const faqPattern = /faq|frequently\s*asked|common\s*questions?/i;

  const { min: metaMin, max: metaMax } = englishMetaRange();
  const repairedMeta = repairMetaDescription(outline.metaDescription || "", metaMin, metaMax);

  const internalTarget = Math.ceil(requestedWordCount * GENERATION_WORD_BUFFER);
  const introTarget = Math.round(internalTarget * WORD_ALLOCATION.INTRO);
  const conclusionTarget = Math.round(internalTarget * WORD_ALLOCATION.CONCLUSION);
  const faqTarget = Math.round(internalTarget * WORD_ALLOCATION.FAQ);
  const faqRange = dynamicFaqRange(requestedWordCount);
  const h2TotalTarget = internalTarget - introTarget - conclusionTarget - faqTarget;
  const editorialHeadingCount = Math.max(1, h2Headings.length - 1);
  const wordsPerSection = Math.round(h2TotalTarget / editorialHeadingCount);
  const kpTargets = computeKeyphraseTargets(requestedWordCount, keyphrase);
  const exactKeyphraseTarget = kpTargets.preferred;

  // Keyphrase placement: article-level density target, not per-section quotas.
  const kpNote = keyphrase
    ? `\n\nUse the exact keyphrase "${keyphrase}" naturally across the article, approximately ${exactKeyphraseTarget} times total. Do NOT force it into every section. Place it naturally in the introduction or a heading only when it reads naturally, and use it in the body without forcing repetition.`
    : "";

  // Section bodies array
  const sectionBodies: Array<{ index: number; heading: string; body: string; status: string }> = h2Headings.map((h: string, i: number) => ({
    index: i, heading: h, body: "", status: "pending",
  }));

  // Nuclear evidence boundary: every approved claim is assigned to exactly one
  // editorial section before any prose is generated. Introduction, FAQ and
  // conclusion are synthesis-only and receive no precise research evidence.
  const ownershipSections = h2Headings
    .map((heading, index) => ({
      id: `section-${index}`,
      heading,
      sectionType: index === h2Headings.length - 1 ? "faq-heading" as const : "main" as const,
    }));
  const claimOwnership = buildClaimOwnershipLedger(ownershipSections, context.research);
  context.claimOwnership = claimOwnership;
  const synthesisOnlyPrompt = `\n\nEVIDENCE OWNERSHIP: This component is synthesis-only. Do not use statistics, dates, currencies, quotations, performance benchmarks, posting frequencies, survey findings or platform-availability claims. Summarize or frame ideas without repeating precise evidence owned by body sections.`;
  const researchUrls = (context.research || []).map((r: any) => r.url || r.link || "").filter(Boolean);

  // Phase B: Parallel section generation
  type TaskResult = { type: string; index?: number; heading?: string; content: string };

  // Log active request count for diagnostics
  let activeGenerationRequests = 0;
  let maxObservedConcurrency = 0;

  // Lazy task factories — each factory is wrapped by runWithConcurrency so
  // only `limit` HTTP requests are in flight simultaneously.
  const taskFactories: (() => Promise<TaskResult>)[] = [];

  const introUserMsg = `Write the introduction (${introTarget} words). Write it in ENGLISH ONLY — do not use Chinese characters. Return JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Only use "paragraph" type unless another supported type is clearly useful.\n\nTitle: ${outline.title}${kpNote}${synthesisOnlyPrompt}`;
  taskFactories.push(() => trackedChat("intro", [{ role: "system", content: bundle.introSystem }, { role: "user", content: introUserMsg }], { responseFormat: { type: "json_object" }, maxTokens: 6144, timeoutMs: 90_000 }).then(async (res: any) => {
    let parsed: any;
    try { parsed = robustJsonParse(res.content, "intro"); } catch {
      const retryMsg = introUserMsg + `\n\nYour previous response was not valid JSON. Return ONLY valid JSON with the format: {"blocks": [{"type": "paragraph", "text": "..."}]}. No HTML, no WordPress comments, no Markdown fences.`;
      const retryRes = await trackedChat("intro_retry", [{ role: "system", content: bundle.introSystem }, { role: "user", content: retryMsg }], { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 60_000 });
      parsed = robustJsonParse(retryRes.content, "intro-retry");
    }
    const normalized = normalizeAiEditorialPayload(parsed, "intro");
    if (normalized.errors.length > 0 || normalized.blocks.length === 0) {
      const repairMsg = `Your previous response had errors: ${normalized.errors.join("; ")}.\n\nReturn ONLY valid JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Supported types: paragraph, subheading, list, quote, table. No HTML. No WordPress comments. No Markdown fences.\n\nOriginal request and approved evidence:\n${introUserMsg}`;
      const repairRes = await trackedChat("intro_repair", [{ role: "system", content: bundle.introSystem }, { role: "user", content: repairMsg }], { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 60_000 });
      const repaired = robustJsonParse(repairRes.content, "intro-repair");
      const repairedNorm = normalizeAiEditorialPayload(repaired, "intro");
      if (repairedNorm.errors.length > 0 || repairedNorm.blocks.length === 0) {
        throw AppError.internal(new Error(`Introduction generation failed after retry: ${repairedNorm.errors.join("; ") || "empty blocks"}`));
      }
      return { type: "intro", content: renderEditorialBlocksToWordPress(repairedNorm.blocks) };
    }
    return { type: "intro", content: renderEditorialBlocksToWordPress(normalized.blocks) };
  }));

  const faqIndex = h2Headings.length - 1;

  for (let i = 0; i < h2Headings.length; i++) {
    const h2Text = h2Headings[i];
    const isFaq = (i === faqIndex);
    const prev = i > 0 ? h2Headings[i - 1] : "none";
    const next = i < h2Headings.length - 1 ? h2Headings[i + 1] : "none";

    if (isFaq) {
      // FAQ: structured output with heading + entries, not an editorial section
      const faqMsg = `Return FAQ content as structured JSON. Use: {"heading": "...", "entries": [{"question": "...", "answer": "..."}]}. Generate ${faqTarget} words total across ${faqRange.min}-${faqRange.max} entries. Each answer must be 1-3 complete sentences. Write every question and answer in ENGLISH ONLY — do not use Chinese characters. Do not include HTML, WordPress comments, Markdown fences, signup URLs, CTA content, or precise statistics. Questions must be conceptual or practical rather than asking for a number already owned by a body section.\n\nHeading: "${h2Text}"\n\nTitle: ${outline.title}${kpNote}${synthesisOnlyPrompt}`;
      taskFactories.push(() => trackedChat("faq", [{ role: "system", content: bundle.faqSystem }, { role: "user", content: faqMsg }], { responseFormat: { type: "json_object" }, maxTokens: 6144, timeoutMs: 90_000 }).then(async (res: any) => {
        let raw: unknown;
        let parsed: AcceptedFaqPayload;
        try {
          raw = robustJsonParse(res.content, "faq");
          parsed = validateFaqPayload(raw, faqRange.min, faqRange.max);
        } catch (error) {
          parsed = { entries: [], errors: [error instanceof Error ? error.message : String(error)] };
          raw = {};
        }
        if (parsed.errors.length > 0) {
          const repairMsg = `${faqMsg}\n\nYour previous FAQ failed deterministic acceptance: ${parsed.errors.join("; ")}. Return ONLY corrected JSON with ${faqRange.min}-${faqRange.max} complete entries. Do not return HTML, WordPress comments, Markdown, CTA/signup copy or Chinese text.`;
          const repairRes = await trackedChat("faq_repair", [{ role: "system", content: bundle.faqSystem }, { role: "user", content: repairMsg }], { responseFormat: { type: "json_object" }, maxTokens: 6144, timeoutMs: 60_000 });
          raw = robustJsonParse(repairRes.content, "faq-repair");
          parsed = validateFaqPayload(raw, faqRange.min, faqRange.max);
          if (parsed.errors.length > 0) {
            throw AppError.internal(new Error(`FAQ generation failed deterministic acceptance after one targeted retry: ${parsed.errors.join("; ")}`));
          }
        }
        // The accepted outline owns the FAQ H2. The FAQ model owns only the
        // Q&A entries and may not replace an already validated heading with
        // markup, a different topic, or a second H2 variant.
        const returnedHeading = typeof (raw as any).heading === "string"
          ? (raw as any).heading.replace(/\s+/g, " ").trim()
          : "";
        const heading = h2Text;
        if (returnedHeading && returnedHeading !== h2Text) {
          console.log(
            `[faq-heading] ignored model override returned=${JSON.stringify(returnedHeading)} canonical=${JSON.stringify(h2Text)}`,
          );
        }
        const entries = parsed.entries;
        return { type: "faq", index: faqIndex, heading, content: JSON.stringify({ heading, entries }) };
      }));
    } else {
      // Editorial section: structured JSON blocks
      const ownedEvidence = formatOwnedEvidencePacket(claimOwnership, `section-${i}`);
      const sectionResearchPrompt = `\n\nCLAIM OWNERSHIP LEDGER — evidence below belongs ONLY to this section:\n${ownedEvidence}\n\nUse only assigned evidence. Preserve complete meaning and use natural named attribution. Never print SOURCE-N identifiers. Do not repeat precise evidence from earlier or later sections.`;
      const msg = `Return section BODY as structured JSON blocks. Do NOT return H2 heading. Write the body in ENGLISH ONLY — do not use Chinese characters. Section heading: "${h2Text}". Target ${wordsPerSection} words. Previous heading: ${prev}. Next heading: ${next}. Title: ${outline.title}. Return JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Use paragraph, subheading (H3 only), list, quote or table types as needed.${kpNote}${sectionResearchPrompt}`;
      taskFactories.push(() => trackedChat(`section_${i}`, [{ role: "system", content: bundle.sectionSystem }, { role: "user", content: msg }], { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 90_000 }).then(async (res: any) => {
        const raw = robustJsonParse(res.content, `section_${i}`);
        const normalized = normalizeAiEditorialPayload(raw, `section-${i}`);
        if (normalized.errors.length > 0 || normalized.blocks.length === 0) {
          const repairMsg = `Your previous response for the section "${h2Text}" had errors: ${normalized.errors.join("; ") || "no valid blocks"}. Return ONLY valid JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Supported types: paragraph, subheading, list, quote, table. No HTML. No WordPress comments. No Markdown fences. Do NOT include H2 headings.\n\nOriginal request and approved evidence:\n${msg}`;
          const repairRes = await trackedChat(`section_${i}_repair`, [{ role: "system", content: bundle.sectionSystem }, { role: "user", content: repairMsg }], { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 60_000 });
          const repaired = robustJsonParse(repairRes.content, `section-${i}-repair`);
          const repairedNorm = normalizeAiEditorialPayload(repaired, `section-${i}`);
          if (repairedNorm.errors.length > 0 || repairedNorm.blocks.length === 0) {
            throw AppError.internal(new Error(`Section ${i} ("${h2Text}"): generation failed after retry — ${repairedNorm.errors.join("; ") || "empty blocks"}`));
          }
          let html = renderEditorialBlocksToWordPress(repairedNorm.blocks);
          if (researchUrls.length > 0) html = sanitizeSectionUrls(html, researchUrls);
          return { type: "section", index: i, heading: h2Text, content: html };
        }
        let html = renderEditorialBlocksToWordPress(normalized.blocks);
        if (researchUrls.length > 0) html = sanitizeSectionUrls(html, researchUrls);
        return { type: "section", index: i, heading: h2Text, content: html };
      }));
    }
  }

  const concUserMsg = `Write the conclusion (${conclusionTarget} words). Write it in ENGLISH ONLY — do not use Chinese characters. Return JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Only use "paragraph" type unless another type is clearly useful. Do NOT include any CTA content, signup buttons, or CTA headings — the application handles the CTA separately. Summarize only ideas already established in the body and do not repeat any precise factual claim.\n\nTitle: ${outline.title}${kpNote}${synthesisOnlyPrompt}`;
  taskFactories.push(() => trackedChat("conclusion", [{ role: "system", content: bundle.conclusionSystem }, { role: "user", content: concUserMsg }], { responseFormat: { type: "json_object" }, maxTokens: 6144, timeoutMs: 90_000 }).then(async (res: any) => {
    let parsed: any;
    try { parsed = robustJsonParse(res.content, "conclusion"); } catch {
      const retryMsg = concUserMsg + `\n\nYour previous response was not valid JSON. Return ONLY valid JSON with the format: {"blocks": [{"type": "paragraph", "text": "..."}]}. No CTA, no signup content, no HTML, no WordPress comments.`;
      const retryRes = await trackedChat("conclusion_retry", [{ role: "system", content: bundle.conclusionSystem }, { role: "user", content: retryMsg }], { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 60_000 });
      parsed = robustJsonParse(retryRes.content, "conclusion-retry");
    }
    const normalized = normalizeAiEditorialPayload(parsed, "conclusion", { disallowCtaContent: true });
    if (normalized.errors.length > 0 || normalized.blocks.length === 0) {
      const repairMsg = `Your previous response had errors: ${normalized.errors.join("; ") || "empty blocks"}. Return ONLY valid conclusion JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. No CTA content. No signup buttons. No HTML.\n\nOriginal request and approved evidence:\n${concUserMsg}`;
      const repairRes = await trackedChat("conclusion_repair", [{ role: "system", content: bundle.conclusionSystem }, { role: "user", content: repairMsg }], { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 60_000 });
      const repaired = robustJsonParse(repairRes.content, "conclusion-repair");
      const repairedNorm = normalizeAiEditorialPayload(repaired, "conclusion", { disallowCtaContent: true });
      if (repairedNorm.errors.length > 0 || repairedNorm.blocks.length === 0) {
        throw AppError.internal(new Error(`Conclusion generation failed after retry: ${repairedNorm.errors.join("; ") || "empty blocks"}`));
      }
      return { type: "conclusion", content: renderEditorialBlocksToWordPress(repairedNorm.blocks) };
    }
    return { type: "conclusion", content: renderEditorialBlocksToWordPress(normalized.blocks) };
  }));

  const settledResults = await runGenerationTasksWithConcurrency(
    taskFactories,
    2,
    (active) => {
      activeGenerationRequests = active;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeGenerationRequests);
    },
  );

  console.log(`[blog-generation] max observed concurrency: ${maxObservedConcurrency}`);
  const results = settledResults.filter((r) => r !== undefined);

  // Write editorial section results back
  for (const r of results) {
    if (r.type === "section" && r.index !== undefined && r.index < sectionBodies.length) {
      sectionBodies[r.index].body = r.content;
      sectionBodies[r.index].status = "generated";
    }
  }

  // Extract structured FAQ result (not stored in sectionBodies — rendered from visibleFaq)
  let faqHeadingText = "";
  let faqEntries: Array<{ question: string; answer: string }> = [];
  const faqResult = results.find((r: any) => r.type === "faq");
  if (faqResult) {
    try {
      const faqData = JSON.parse(faqResult.content);
      faqHeadingText = faqData.heading || h2Headings[h2Headings.length - 1] || "Frequently Asked Questions";
      faqEntries = faqData.entries || [];
    } catch {
      console.warn("[blog-generation] Failed to parse structured FAQ result — falling back to empty FAQ");
    }
  }

  const intro = results.find((r: any) => r.type === "intro")?.content || "";
  const conclusion = results.find((r: any) => r.type === "conclusion")?.content || "";

  // Early abort: intro must have content
  if (!intro) {
    throw AppError.internal(new Error("Introduction generation returned empty content — aborting before section generation"));
  }

  // Conclusion must have content — no CTA extraction since the pipeline handles CTA
  if (!conclusion) {
    throw AppError.internal(new Error("Conclusion generation returned empty content"));
  }

  // Assembly — no CTA extraction from conclusion; CTA is handled by the pipeline
  const slugs = pairedSlugs(outline.slug || "blog-post");

  // Build sections array excluding FAQ (rendered separately from visibleFaq)
  const docSections: ArticleDocument["sections"] = sectionBodies
    .filter((s) => s.index !== faqIndex)
    .map((s) => ({
      id: `section-${s.index}`,
      heading: s.heading,
      headingLevel: 2 as const,
      sectionType: "main" as const,
      blocks: parseWordPressEditorialBlocks(s.body, `section-${s.index}`).blocks,
      status: s.status as any,
    }));
  // Add the FAQ heading section (empty blocks, rendered from visibleFaq)
  if (faqHeadingText) {
    docSections.push({
      id: `section-${faqIndex}`,
      heading: faqHeadingText,
      headingLevel: 2 as const,
      sectionType: "faq-heading",
      blocks: [],
      status: "generated" as any,
    });
  }

  const languageSwitcherHtml = renderLanguageSwitcher({
    currentLanguage: "en",
    englishSlug: slugs.englishSlug,
    chineseSlug: slugs.chineseSlug,
  });
  const articleDoc: ArticleDocument = {
    metadata: { title: outline.title || "Untitled", slug: slugs.englishSlug, metaDescription: repairedMeta, excerpt: outline.excerpt || "", targetWordCount: requestedWordCount, focusKeyphrase: keyphrase },
    languageSwitcher: { id: "language-switcher", type: "language-switcher", html: languageSwitcherHtml, fingerprint: fingerprintHtml(languageSwitcherHtml) },
    introduction: { id: "intro", blocks: parseWordPressEditorialBlocks(intro, "intro").blocks, status: "generated" },
    sections: docSections,
    visibleFaq: faqEntries.map((e) => ({
      question: e.question,
      answerHtml: "",
      answerText: e.answer,
    })),
    conclusion: { id: "conc", blocks: parseWordPressEditorialBlocks(conclusion, "conc").blocks, status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };

  // Pipeline
  const pipelineState = createPipelineState({
    userId, projectId: String(projectId), keyphrase, requestedWordCount,
    articleDoc, h2Headings, intro, conclusion,
    wordsPerSection, exactKeyphraseTarget,
    policy: buildPolicy(requestedWordCount, wordMin, wordMax, keyphrase),
    ctx: context, wordMin, wordMax, systemPrompt, userMessage: "",
  });

  await runPostAssemblyPipeline(pipelineState, {
    chatWithRetry: pipelineChatWithRetry,
    makeTrackedChatForStage,
    telemetry,
    context,
  } satisfies PipelineDependencies);
  if (researchWarnings.length > 0) {
    pipelineState.warnings.push(...researchWarnings);
  }

  const finalBlog = pipelineState.blog;
  const finalTitle = pipelineState.title;
  const finalMeta = pipelineState.metaDescription;

  const generated = {
    title: finalTitle, slug: pipelineState.slug, metaDescription: finalMeta,
    excerpt: pipelineState.excerpt, blog: finalBlog, faq: pipelineState.faq || [],
    internalLinks: [], externalLinks: extractEditorialExternalLinkUrls(finalBlog),
    categories: [], tags: [], readingTime: "", summary: "",
  };

  const qualityReport = buildGenerationReport(
    finalBlog, finalTitle, finalMeta,
    keyphrase, requestedWordCount, 0,
    Date.now(), pipelineState.retryCount, 0, pipelineState.componentRegenerations,
    pipelineState.warnings, 0, articleDoc.sections.length,
    countCanonicalVisibleWords(pipelineState.articleDoc ?? articleDoc),
  );

  return {
    generated,
    pipelineState,
    qualityReport,
    h2Headings,
    wordMin, wordMax,
    retryCount: pipelineState.retryCount,
    componentRegens: pipelineState.componentRegenerations,
    estimatedTokens: 0,
    systemPrompt, userMessage,
  };
}
