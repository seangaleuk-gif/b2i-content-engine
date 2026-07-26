// ── Blog Generation Service ──
// Contains all generation logic: context loading, DeepSeek calls, assembly, pipeline.
// route.ts handles only auth, request validation, persistence, and response.

import {
  projectRepository, researchRepository, knowledgeRepository,
  promptSectionRepository,
} from "@/lib/repositories";
import { buildBlogPrompt } from "@/lib/services/prompt-builder";
import { getCompiledBundle } from "@/lib/services/prompt-compiler";
import { AiService, type ChatMessage, type ChatOptions } from "@/lib/services/deepseek";
import { AppError } from "@/lib/services/errors";
import { countReadableWords, robustJsonParse, repairMetaDescription, containsExactPhrase } from "@/lib/services/text-utils";
import { WORD_ALLOCATION, GENERATION_WORD_BUFFER } from "@/lib/services/generation-constants";
import { englishWordTolerance, englishMetaRange, computeKeyphraseTargets, getKeyphraseContentWordCount } from "@/lib/content-standards";
import { runComponentRegeneration, regenerateIntroduction, regenerateSection, regenerateConclusion, type GenContext } from "@/lib/services/component-regenerator";
import { buildGenerationReport } from "@/lib/services/quality-scorer";
import { GenerationTelemetry } from "@/lib/services/generation-telemetry";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { extractCtaFromConclusion, stripProtectedBlocksFromConclusion } from "@/lib/blog/protected-block-extractor";
import { countExactPhrase, extractReadableText } from "@/lib/seo/seo-text-utils";
import { type ArticleDocument, renderArticleDocument, fingerprintHtml, renderFaqSchema, detectClaimConflicts, extractVisibleFaqFromArticle } from "@/lib/blog/article-document";
import { buildPolicy, analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { createPipelineState, runPostAssemblyPipeline, type PipelineState, type PipelineDependencies, validatePipelineOrder } from "@/lib/pipeline/blog-generation-pipeline";
import { sanitizeSectionUrls } from "@/lib/services/article-postprocessors";
import { rebalanceWpBlocks } from "@/lib/services/text-utils";

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

export async function runBlogGeneration(
  userId: string,
  projectId: number,
): Promise<GenerationResult> {
  const telemetry = new GenerationTelemetry();
  telemetry.startTimer("total");

  const project = await projectRepository.findById(Number(projectId));
  if (!project) throw AppError.internal();

  const ai = new AiService(telemetry);
  const trackedChat = (stage: string, messages: ChatMessage[], options?: ChatOptions) => ai.call(stage, messages, options);
  const makeTrackedChatForStage = (stage: string) => ai.makeCallerForStage(stage);

  const research = await researchRepository.findByProject(Number(projectId));
  const knowledge = await knowledgeRepository.findByUser(userId);
  await promptSectionRepository.seedDefaults(userId);
  const promptSections = await promptSectionRepository.findByUser(userId);

  const context = {
    project: {
      name: project.name, keyword: project.keyword,
      audience: project.audience, country: project.country,
      wordCount: Number((project as any).word_count ?? 0),
      content: project.content ?? "", status: project.status,
    },
    research: research.map((r: any) => ({ category: r.category, title: r.title, snippet: r.snippet, url: r.url })),
    knowledge: knowledge.map((k: any) => ({ title: k.title, content: k.content, tags: k.tags })),
    promptSections: promptSections.map((s: any) => ({ key: s.section_key ?? "", label: s.section_key ?? "", content: s.content })),
  };

  const { systemPrompt, userMessage } = buildBlogPrompt(context);
  const { bundle } = getCompiledBundle(context);
  const requestedWordCount = context.project.wordCount || 2500;

  const { min: wordMin, max: wordMax } = englishWordTolerance(requestedWordCount);
  const keyphrase = (context.project.keyword ?? "").toLowerCase();

  // Phase A: Outline
  const outlineSystemPrompt = bundle.outlineSystem;
  const outlinePrompt = userMessage + "\n\n=== STEP 1 ===\nReturn ONLY an outline. Generate the title and 5-6 H2 section headings. The LAST heading MUST be an FAQ section. Do NOT write full content yet. Return as JSON: {\"title\": \"...\", \"slug\": \"...\", \"metaDescription\": \"...\", \"h2Headings\": [\"Heading 1\", \"Heading 2\", ..., \"Frequently Asked Questions About [Topic]\"]}.";
  
  const outlineRes = await trackedChat("outline",
    [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 8192 }
  );
  
  let outline: any;
  try {
    outline = robustJsonParse(outlineRes.content, "outline");
  } catch {
    const retryRes = await trackedChat("outline_retry",
      [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt + "\n\nCRITICAL: You MUST output valid JSON only." }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
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

  // ── Guarantee FAQ heading ──
  // The FAQ heading is programmatically ensured before section generation
  // so the AI never has a chance to omit it. If the AI included one in the
  // outline, it is kept. Otherwise a canonical FAQ heading is appended.
  const faqPattern = /faq|frequently.asked|common.question/i;
  let faqHeadingIndex = h2Headings.findIndex((h) => faqPattern.test(h));
  if (faqHeadingIndex < 0) {
    const topic = outline?.title
      ? outline.title.replace(/:.*$/, "").trim()
      : keyphrase
        ? keyphrase.replace(/\b\w/g, (c: string) => c.toUpperCase()).trim()
        : "This Topic";
    // Replace "Conclusion"/"Summary" type trailing headings with FAQ
    const nonFaqEnd = /conclusion|summary|final|wrap.?up|takeaway/i;
    const lastNonFaq = h2Headings.map((h, i) => nonFaqEnd.test(h) ? i : -1).filter((i) => i >= 0).pop();
    const faqHeading = `Frequently Asked Questions About ${topic}`;
    if (lastNonFaq !== undefined) {
      h2Headings[lastNonFaq] = faqHeading;
      faqHeadingIndex = lastNonFaq;
    } else {
      h2Headings.push(faqHeading);
      faqHeadingIndex = h2Headings.length - 1;
    }
  }
  // Mark the FAQ section type so ArticleDocument can use structured boundaries
  const faqSectionType = "faq-heading" as const;

  const { min: metaMin, max: metaMax } = englishMetaRange();
  const repairedMeta = repairMetaDescription(outline.metaDescription || "", metaMin, metaMax);

  const internalTarget = Math.ceil(requestedWordCount * GENERATION_WORD_BUFFER);
  const introTarget = Math.round(internalTarget * WORD_ALLOCATION.INTRO);
  const conclusionTarget = Math.round(internalTarget * WORD_ALLOCATION.CONCLUSION);
  const faqTarget = Math.round(internalTarget * WORD_ALLOCATION.FAQ);
  const h2TotalTarget = internalTarget - introTarget - conclusionTarget - faqTarget;
  const wordsPerSection = Math.round(h2TotalTarget / h2Headings.length);
  const kpTargets = computeKeyphraseTargets(requestedWordCount, keyphrase);
  const exactKeyphraseTarget = kpTargets.preferred;

  // Keyphrase injection into best H2
  let keyphraseH2Index = 0;
  if (keyphrase && h2Headings.length > 1) {
    const skipPatterns = /mistake|avoid|faq|conclusion|summary|final|wrap.?up/i;
    for (let i = 0; i < h2Headings.length; i++) {
      if (!skipPatterns.test(h2Headings[i].toLowerCase())) { keyphraseH2Index = i; break; }
    }
    const heading = h2Headings[keyphraseH2Index];
    // Only prepend keyphrase if the heading doesn't already contain it.
    // This prevents unnatural duplicates like "threads marketing hong kong: Why Threads Marketing Hong Kong Matters".
    if (!heading.toLowerCase().includes(keyphrase.toLowerCase())) {
      h2Headings[keyphraseH2Index] = `${keyphrase}: ${heading}`;
    }
  }

  // Keyphrase placement: article-level density target, not per-section quotas.
  const kpNote = keyphrase
    ? `\n\nUse the exact keyphrase "${keyphrase}" naturally across the article, approximately ${exactKeyphraseTarget} times total. Do NOT force it into every section. Place it naturally in the introduction, at least one heading, and the body where it reads naturally.`
    : "";

  // Section bodies array
  const sectionBodies: Array<{ index: number; heading: string; body: string; status: string }> = h2Headings.map((h: string, i: number) => ({
    index: i, heading: h, body: "", status: "pending",
  }));

  // Research summary
  const sectionResearchPrompt = context.research?.length
    ? `\n\nREFERENCE SOURCES (use these URLs when referencing claims):\n${(context.research as any[]).map((r: any) => `- ${r.title || "Source"}: ${r.url || ""}`).join("\n")}`
    : "";
  const researchUrls = (context.research || []).map((r: any) => r.url || r.link || "").filter(Boolean);

  // Phase B: Parallel section generation
  type TaskResult = { type: string; index?: number; heading?: string; content: string };
  const tasks: Promise<TaskResult>[] = [];

  const introUserMsg = `Write the introduction (${introTarget} words). Return as JSON: {"intro": "..."}.\n\nTitle: ${outline.title}${kpNote}`;
  tasks.push(trackedChat("intro", [{ role: "system", content: bundle.introSystem }, { role: "user", content: introUserMsg }], { responseFormat: { type: "json_object" }, maxTokens: 4096 })
    .then((res: any) => ({ type: "intro", content: (robustJsonParse(res.content, "intro") as any).intro || "" })));

  for (let i = 0; i < h2Headings.length; i++) {
    const h2Text = h2Headings[i];
    const prev = i > 0 ? h2Headings[i - 1] : "none";
    const next = i < h2Headings.length - 1 ? h2Headings[i + 1] : "none";
    const msg = `Return section BODY only. Do NOT return H2 heading. Start directly with a paragraph. Section heading: "${h2Text}". Target ${wordsPerSection} words. Previous: ${prev}. Next: ${next}. Title: ${outline.title}. Return as JSON: {"body": "..."}.${sectionResearchPrompt}`;
    
    tasks.push(trackedChat(`section_${i}`, [{ role: "system", content: bundle.sectionSystem }, { role: "user", content: msg }], { responseFormat: { type: "json_object" }, maxTokens: 8192 })
      .then((res: any) => {
        const raw = (robustJsonParse(res.content, `section_${i}`) as any).body || "";
        let clean = stripHeadingBlocks(raw);
        if (researchUrls.length > 0) clean = sanitizeSectionUrls(clean, researchUrls);
        if (clean.trim().length < 50) {
          // AI returned empty/whitespace content — mark as missing so expander regenerates it.
          return { type: "section", index: i, heading: h2Text, content: "", missing: true };
        }
        return { type: "section", index: i, heading: h2Text, content: clean };
      }));
  }

  const concUserMsg = `Write the conclusion (${conclusionTarget} words). Include a CTA. Return as JSON: {"conclusion": "..."}.\n\nTitle: ${outline.title}${kpNote}`;
  tasks.push(trackedChat("conclusion", [{ role: "system", content: bundle.conclusionSystem }, { role: "user", content: concUserMsg }], { responseFormat: { type: "json_object" }, maxTokens: 4096 })
    .then((res: any) => ({ type: "conclusion", content: (robustJsonParse(res.content, "conclusion") as any).conclusion || "" })));

  const settled = await Promise.allSettled(tasks);
  const results = settled.filter((s) => s.status === "fulfilled").map((s: any) => s.value);
  
  // Write section results back
  for (const r of results) {
    if (r.type === "section" && r.index !== undefined && r.index < sectionBodies.length) {
      if ((r as any).missing) {
        sectionBodies[r.index].body = "";
        sectionBodies[r.index].status = "missing";
      } else {
        sectionBodies[r.index].body = r.content;
        sectionBodies[r.index].status = "generated";
      }
    }
  }
  for (let i = 0; i < sectionBodies.length; i++) {
    if (!sectionBodies[i].body) { sectionBodies[i].status = "missing"; sectionBodies[i].body = "<!-- wp:paragraph --><p>Content unavailable for this section.</p><!-- /wp:paragraph -->"; }
  }

  const intro = results.find((r: any) => r.type === "intro")?.content || "";
  const conclusion = results.find((r: any) => r.type === "conclusion")?.content || "";

  // Assembly
  const ctaHtml = extractCtaFromConclusion(conclusion);
  const cleanConclusion = stripProtectedBlocksFromConclusion(conclusion, ctaHtml, "");
  const slugs = pairedSlugs(outline.slug || "blog-post");

  const articleDoc: ArticleDocument = {
    metadata: { title: outline.title || "Untitled", slug: outline.slug || "", metaDescription: repairedMeta, excerpt: outline.excerpt || "", targetWordCount: requestedWordCount, focusKeyphrase: keyphrase },
    languageSwitcher: { id: "ls", type: "language-switcher", html: `<!-- wp:html --><div class="b2i-language-switcher"><span>English</span> | <a href="/blog/${slugs.chineseSlug}">繁體中文</a></div><!-- /wp:html -->`, fingerprint: fingerprintHtml("switcher") },
    introduction: { id: "intro", html: intro, wordCount: countReadableWords(intro), status: "generated" },
    sections: sectionBodies.map((s) => ({
      id: `section-${s.index}`,
      heading: s.heading,
      headingLevel: 2 as const,
      sectionType: (faqPattern.test(s.heading) ? "faq-heading" : "main") as "main" | "faq-heading",
      html: s.body,
      wordCount: countReadableWords(s.body),
      status: s.status as any,
    })),
    visibleFaq: [],
    conclusion: { id: "conc", html: cleanConclusion, wordCount: countReadableWords(cleanConclusion), status: "generated" },
    cta: ctaHtml ? { id: "cta", type: "cta", html: ctaHtml, fingerprint: fingerprintHtml(ctaHtml) } : null,
    faqSchema: null,
    insertedLinks: [],
  };

  const blog = renderArticleDocument(articleDoc);

  // Pipeline
  const pipelineState = createPipelineState({
    userId, projectId: String(projectId), keyphrase, requestedWordCount,
    articleDoc, h2Headings, intro, conclusion: cleanConclusion,
    wordsPerSection, exactKeyphraseTarget,
    policy: buildPolicy(requestedWordCount, wordMin, wordMax, keyphrase),
    ctx: context, wordMin, wordMax, systemPrompt, userMessage: "",
  });
  pipelineState.blog = blog;

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
    title: finalTitle, slug: outline.slug || "", metaDescription: finalMeta,
    excerpt: outline.excerpt || "", blog: finalBlog, faq: [],
    internalLinks: [], externalLinks: [], categories: [], tags: [], readingTime: "", summary: "",
  };

  const qualityReport = buildGenerationReport(
    finalBlog, finalTitle, finalMeta,
    keyphrase, requestedWordCount, 0,
    Date.now(), pipelineState.retryCount, 0, pipelineState.componentRegenerations,
    pipelineState.warnings, 0, articleDoc.sections.length,
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

function pairedSlugs(slug: string): { englishSlug: string; chineseSlug: string } {
  return { englishSlug: slug, chineseSlug: slug + "-zh" };
}
