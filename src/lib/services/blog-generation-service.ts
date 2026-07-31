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
import { WORD_ALLOCATION, GENERATION_WORD_BUFFER } from "@/lib/services/generation-constants";
import { englishWordTolerance, englishMetaRange, computeKeyphraseTargets, getKeyphraseContentWordCount, dynamicH2Range, dynamicFaqRange } from "@/lib/content-standards";
import { runComponentRegeneration, regenerateIntroduction, regenerateSection, regenerateConclusion, type GenContext } from "@/lib/services/component-regenerator";
import { buildGenerationReport } from "@/lib/services/quality-scorer";
import { GenerationTelemetry } from "@/lib/services/generation-telemetry";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { type ArticleDocument, renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, extractVisibleFaqFromArticle, extractFaqPairsFromSectionBody, renderComponentHtml, countComponentWords, countCanonicalVisibleWords } from "@/lib/blog/article-document";
import { buildPolicy, analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { createPipelineState, runPostAssemblyPipeline, type PipelineState, type PipelineDependencies, validatePipelineOrder } from "@/lib/pipeline/blog-generation-pipeline";
import { pairedSlugs, sanitizeSectionUrls } from "@/lib/services/article-postprocessors";
import { rebalanceWpBlocks } from "@/lib/services/text-utils";
import { normalizeAiEditorialPayload, renderEditorialBlocksToWordPress, parseWordPressEditorialBlocks } from "@/lib/blog/article-content";
import { buildClaimOwnershipLedger, formatOwnedEvidencePacket } from "@/lib/blog/claim-ownership";

/** Strip ALL heading blocks (H2, H3, bare <h2>, bare <h3>) from section body content.
 *  Handles complete blocks, orphaned openers/closers, and malformed heading markup
 *  that the AI may produce despite explicit formatting instructions. */
function stripHeadingBlocks(raw: string): string {
  let cleaned = raw;

  // Pass 1: strip well-formed H2 heading blocks (opener + <h2>...</h2> + closer)
  cleaned = cleaned.replace(
    /<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*\n?<h2[^>]*>[\s\S]*?<\/h2>\s*\n?<!--\s*\/wp:heading\s*-->/gi,
    "",
  );

  // Pass 2: strip well-formed H3 heading blocks (opener + <h3>...</h3> + closer)
  cleaned = cleaned.replace(
    /<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*3[^}]*\}\s*-->\s*\n?<h3[^>]*>[\s\S]*?<\/h3>\s*\n?<!--\s*\/wp:heading\s*-->/gi,
    "",
  );

  // Pass 3: strip any remaining <!-- wp:heading ... --> openers and <!-- /wp:heading --> closers
  // (catches orphaned markers from malformed AI output)
  cleaned = cleaned.replace(/<!--\s*wp:heading[^>]*-->/gi, "");
  cleaned = cleaned.replace(/<!--\s*\/wp:heading\s*-->/gi, "");

  // Pass 4: strip bare <h2> and <h3> tags (opener + content + closer)
  cleaned = cleaned.replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, "");
  cleaned = cleaned.replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi, "");

  // Pass 5: strip any remaining orphaned <h2>, <h3>, </h2>, </h3> tags
  cleaned = cleaned.replace(/<\/?h[23]\b[^>]*>/gi, "");

  // Pass 6: clean up empty paragraph blocks that may result from heading removal
  cleaned = cleaned.replace(
    /<!--\s*wp:paragraph\s*-->\s*\n?<p>\s*<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi,
    "",
  );

  // Pass 7: rebalance WordPress blocks via shared utility
  cleaned = rebalanceWpBlocks(cleaned);

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
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
  let editorial = unique.filter((heading) => !faqPattern.test(heading) && !conclusionPattern.test(heading));
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
    const key = candidate.toLowerCase();
    if (!editorial.some((heading) => heading.toLowerCase() === key)) editorial.push(candidate);
  }

  if (editorial.length < editorialMin) {
    throw AppError.internal(new Error(
      `Outline produced ${editorial.length} editorial H2 headings; ${editorialMin}-${editorialMax} required`,
    ));
  }

  const faqHeading = existingFaq || `Frequently Asked Questions About ${topic}`;
  return [...editorial, faqHeading];
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
  const makeTrackedChatForStage = (stage: string) => ai.makeCallerForStage(stage);

  const research = await researchRepository.findByProject(Number(projectId));
  const knowledge = await knowledgeRepository.findByUser(userId);
  await promptSectionRepository.seedDefaults(userId);
  const promptSections = await promptSectionRepository.findByUser(userId);

  const context: BlogContext = {
    project: {
      name: project.name, keyword: project.keyword,
      audience: project.audience, country: project.country,
      wordCount: Number((project as any).word_count ?? 0),
      content: project.content ?? "", status: project.status,
    },
    research: research.map((r: any) => ({ category: r.category, title: r.title, snippet: r.snippet, url: r.url })),
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
Return ONLY an outline. Generate exactly ${editorialH2Min} editorial H2 section headings (the accepted editorial range is ${editorialH2Min}-${editorialH2Max}), followed by one final FAQ H2 heading (${editorialH2Min + 1} headings total). Do not include a Conclusion or Summary H2. The LAST heading MUST be an FAQ section. Do NOT write full content yet. Keep the title, slug, meta description and headings topic-level: do not place research statistics, percentages, dates, currencies, survey findings, quotations or source names in metadata or headings. Precise evidence will be assigned to one body section after the outline is approved. Return as JSON: {"title": "...", "slug": "...", "metaDescription": "...", "h2Headings": ["Editorial Heading 1", "Editorial Heading 2", "...", "Frequently Asked Questions About [Topic]"]}.`;

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

  let h2Headings: string[] = outline?.h2Headings ?? [];
  if (h2Headings.length === 0) {
    h2Headings = outline?.headings ?? [];
  }
  if (h2Headings.length === 0 && Array.isArray(outline?.sections)) {
    h2Headings = outline.sections.map((s: any) => typeof s === "string" ? s : s.heading ?? s.title ?? "").filter(Boolean);
  }
  if (h2Headings.length === 0) {
    console.error("[blog-generation] No H2 headings generated. Outline keys:", Object.keys(outline ?? {}));
    console.error("[blog-generation] Outline snippet:", JSON.stringify(outline).substring(0, 500));
    throw AppError.internal(new Error("No H2 headings generated"));
  }

  // Normalize the outline to the canonical policy: editorialH2Min-editorialH2Max
  // editorial headings plus exactly one FAQ heading at the end.
  h2Headings = normalizeOutlineHeadings(
    h2Headings,
    requestedWordCount,
    outline?.title || "",
    keyphrase,
  );
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

  /** Run async tasks with a concurrency limit, preserving result order. */
  async function runWithConcurrency<T>(taskFns: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = new Array(taskFns.length);
    let nextIdx = 0;
    async function worker(): Promise<void> {
      while (nextIdx < taskFns.length) {
        const idx = nextIdx++;
        activeGenerationRequests++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeGenerationRequests);
        try {
          results[idx] = await taskFns[idx]();
        } finally {
          activeGenerationRequests--;
        }
      }
    }
    const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  // Lazy task factories — each factory is wrapped by runWithConcurrency so
  // only `limit` HTTP requests are in flight simultaneously.
  const taskFactories: (() => Promise<TaskResult>)[] = [];

  const introUserMsg = `Write the introduction (${introTarget} words). Return JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Only use "paragraph" type unless another supported type is clearly useful.\n\nTitle: ${outline.title}${kpNote}${synthesisOnlyPrompt}`;
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
      const faqMsg = `Return FAQ content as structured JSON. Use: {"heading": "...", "entries": [{"question": "...", "answer": "..."}]}. Generate ${faqTarget} words total across ${faqRange.min}-${faqRange.max} entries. Each answer must be 1-3 complete sentences. Do not include HTML, WordPress comments, Markdown fences, signup URLs, CTA content, or precise statistics. Questions must be conceptual or practical rather than asking for a number already owned by a body section.\n\nHeading: "${h2Text}"\n\nTitle: ${outline.title}${kpNote}${synthesisOnlyPrompt}`;
      taskFactories.push(() => trackedChat("faq", [{ role: "system", content: bundle.faqSystem }, { role: "user", content: faqMsg }], { responseFormat: { type: "json_object" }, maxTokens: 6144, timeoutMs: 90_000 }).then(async (res: any) => {
        const raw = robustJsonParse(res.content, "faq");
        const heading = (raw as any).heading || h2Text;
        const entries: Array<{ question: string; answer: string }> = (raw as any).entries || [];
        if (entries.length < faqRange.min || entries.length > faqRange.max) {
          throw AppError.internal(new Error(`FAQ generation returned ${entries.length} entries; expected ${faqRange.min}-${faqRange.max}`));
        }
        // Sanitize answers — strip any signup URL or CTA content
        for (const e of entries) {
          e.answer = e.answer.replace(/https?:\/\/\S*(?:signup|register|sign-up)/gi, "").trim();
        }
        return { type: "faq", index: faqIndex, heading, content: JSON.stringify({ heading, entries }) };
      }));
    } else {
      // Editorial section: structured JSON blocks
      const ownedEvidence = formatOwnedEvidencePacket(claimOwnership, `section-${i}`);
      const sectionResearchPrompt = `\n\nCLAIM OWNERSHIP LEDGER — evidence below belongs ONLY to this section:\n${ownedEvidence}\n\nUse only assigned evidence. Preserve complete meaning and use natural named attribution. Never print SOURCE-N identifiers. Do not repeat precise evidence from earlier or later sections.`;
      const msg = `Return section BODY as structured JSON blocks. Do NOT return H2 heading. Section heading: "${h2Text}". Target ${wordsPerSection} words. Previous heading: ${prev}. Next heading: ${next}. Title: ${outline.title}. Return JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Use paragraph, subheading (H3 only), list, quote or table types as needed.${kpNote}${sectionResearchPrompt}`;
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

  const concUserMsg = `Write the conclusion (${conclusionTarget} words). Return JSON: {"blocks": [{"type": "paragraph", "text": "..."}]}. Only use "paragraph" type unless another type is clearly useful. Do NOT include any CTA content, signup buttons, or CTA headings — the application handles the CTA separately. Summarize only ideas already established in the body and do not repeat any precise factual claim.\n\nTitle: ${outline.title}${kpNote}${synthesisOnlyPrompt}`;
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

  const settledResults = await runWithConcurrency(taskFactories, 2);

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

  const articleDoc: ArticleDocument = {
    metadata: { title: outline.title || "Untitled", slug: slugs.englishSlug, metaDescription: repairedMeta, excerpt: outline.excerpt || "", targetWordCount: requestedWordCount, focusKeyphrase: keyphrase },
    languageSwitcher: { id: "ls", type: "language-switcher", html: `<!-- wp:html --><div class="b2i-language-switcher"><span>English</span> | <a href="/blog/${slugs.chineseSlug}">繁體中文</a></div><!-- /wp:html -->`, fingerprint: fingerprintHtml("switcher") },
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
    chatWithRetry: ai.chatWithRetry,
    makeTrackedChatForStage: (s: string) => ai.makeCallerForStage(s),
    telemetry,
    context,
  } satisfies PipelineDependencies);

  const finalBlog = pipelineState.blog;
  const finalTitle = pipelineState.title;
  const finalMeta = pipelineState.metaDescription;

  const generated = {
    title: finalTitle, slug: slugs.englishSlug, metaDescription: finalMeta,
    excerpt: outline.excerpt || "", blog: finalBlog, faq: pipelineState.faq || [],
    internalLinks: [], externalLinks: [], categories: [], tags: [], readingTime: "", summary: "",
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
