import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import {
  projectRepository,
  researchRepository,
  knowledgeRepository,
  promptSectionRepository,
  blogVersionRepository,
  aiLogRepository,
} from "@/lib/repositories";
import { buildBlogPrompt, buildSystemPrompt, STAGE_SYSTEM_PROMPTS } from "@/lib/services/prompt-builder";
import { createDeepSeekClient } from "@/lib/services/deepseek";
import { countWords, robustJsonParse, repairMetaDescription } from "@/lib/services/text-utils";
import { META_MIN, META_MAX, DEFAULT_WORD_COUNT, WORD_ALLOCATION, keyphraseTarget } from "@/lib/services/generation-constants";
import { runComponentRegeneration, type GenContext } from "@/lib/services/component-regenerator";
import { buildGenerationReport, formatReport } from "@/lib/services/quality-scorer";

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
    const outlineSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.outline);
    const outlinePrompt = userMessage + "\n\n=== STEP 1 ===\nReturn ONLY an outline. Generate the title and 4-6 H2 section headings. Do NOT write full content yet. Return as JSON: {\"title\": \"...\", \"slug\": \"...\", \"metaDescription\": \"...\", \"h2Headings\": [\"Heading 1\", \"Heading 2\", ...]}.";
    const outlineRes = await chatWithRetry(
      [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
    );
    let outline: any;
    try {
      outline = robustJsonParse(outlineRes.content);
    } catch {
      console.error("[generate-blog:OUTLINE] JSON parse failed, retrying once...");
      const retryRes = await chatWithRetry(
        [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt + "\n\nCRITICAL: You MUST output valid JSON only. No markdown, no extra text." }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );
      try {
        outline = robustJsonParse(retryRes.content);
      } catch {
        return NextResponse.json({ error: "Failed to parse outline JSON after retry" }, { status: 500 });
      }
    }
    const h2Headings: string[] = outline?.h2Headings ?? [];
    if (h2Headings.length === 0) {
      return NextResponse.json({ error: "Outline generation failed: no H2 headings returned" }, { status: 500 });
    }

    // Repair meta description in code
    const rawMeta = outline.metaDescription || "";
    const repairedMeta = repairMetaDescription(rawMeta, META_MIN, META_MAX);
    if (repairedMeta !== rawMeta) {
      console.log(`[generate-blog:OUTLINE] Meta repaired: ${rawMeta.length} → ${repairedMeta.length} chars`);
    }

    // Calculate dynamic word targets
    const effectiveWordCount = (context.project.wordCount || DEFAULT_WORD_COUNT);
    const introTarget = Math.round(effectiveWordCount * WORD_ALLOCATION.INTRO);
    const conclusionTarget = Math.round(effectiveWordCount * WORD_ALLOCATION.CONCLUSION);
    const faqTarget = Math.round(effectiveWordCount * WORD_ALLOCATION.FAQ);
    const h2TotalTarget = effectiveWordCount - introTarget - conclusionTarget - faqTarget;
    const wordsPerSection = Math.round(h2TotalTarget / h2Headings.length);
    const exactKeyphraseTarget = keyphraseTarget(effectiveWordCount);
    console.log(`[generate-blog:TARGETS] total=${effectiveWordCount} intro=${introTarget} conclusion=${conclusionTarget} faq=${faqTarget} perSection=${wordsPerSection} keyphraseTarget=${exactKeyphraseTarget}`);

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

    // Select the best H2 for keyphrase and modify heading text in code (must run before parallel block)
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
    }

    // Build prompts for all parallel tasks
    const introSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.introduction);
    const introUserMsg = `Write the introduction (${introTarget} words) for this blog. Use WordPress block format. Return as JSON: {"intro": "..."}.\n\nTitle: ${generated.title}\nMeta: ${generated.metaDescription}\nKeyword: ${context.project.keyword}\n\n${userMessage.substring(0, 1000)}`;

    const sectionSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.section);

    const conclusionSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.conclusion);
    const conclusionUserMsg = `Write the conclusion (${conclusionTarget} words) for this blog. Include a CTA to create a B2I Hub profile. Return as JSON: {"conclusion": "..."}.\n\nTitle: ${generated.title}`;

    // Create parallel tasks array
    type ParallelResult = { type: "intro" | "section" | "conclusion"; index?: number; heading?: string; content: string };
    const tasks: Promise<ParallelResult>[] = [];

    // Intro task
    tasks.push(
      chatWithRetry(
        [{ role: "system", content: introSystemPrompt }, { role: "user", content: introUserMsg }],
        { responseFormat: { type: "json_object" }, maxTokens: 4096 }
      ).then((res) => ({ type: "intro" as const, content: (robustJsonParse(res.content) as Record<string, string>).intro || "" }))
    );

    // Section tasks (one per H2 heading)
    for (let i = 0; i < h2Headings.length; i++) {
      const h2Text = h2Headings[i];
      const prevHeading = i > 0 ? h2Headings[i - 1] : "(none)";
      const nextHeading = i < h2Headings.length - 1 ? h2Headings[i + 1] : "(none)";

      const sectionUserMsg = `Write the body content for this section. Target exactly ${wordsPerSection} words. Use WordPress block format (<!-- wp:paragraph -->, <!-- wp:list -->). Include exactly ${exactKeyphraseTarget} occurrences of the keyphrase "${keyphrase}" across the full article body — this section should contribute naturally.\n\nReturn as JSON: {\"body\": \"...\"}.\n\nArticle title: ${generated.title}\n\nThis section heading: ${h2Text}\nPrevious heading: ${prevHeading}\nNext heading: ${nextHeading}\n\nGUIDANCE:\n- This section is one independent part of a larger article.\n- Do NOT repeat statistics, examples, or explanations likely covered in other sections (see headings above).\n- Assume the previous heading's topic has already been explained — do not reintroduce it.\n- Focus exclusively on the content for THIS heading.\n- End this section with a smooth transition toward the next heading (${nextHeading}).`;

      tasks.push(
        chatWithRetry(
          [{ role: "system", content: sectionSystemPrompt }, { role: "user", content: sectionUserMsg }],
          { responseFormat: { type: "json_object" }, maxTokens: 8192 }
        ).then((res) => ({ type: "section" as const, index: i, heading: h2Text, content: (robustJsonParse(res.content) as Record<string, string>).body || "" }))
      );
    }

    // Conclusion task
    tasks.push(
      chatWithRetry(
        [{ role: "system", content: conclusionSystemPrompt }, { role: "user", content: conclusionUserMsg }],
        { responseFormat: { type: "json_object" }, maxTokens: 4096 }
      ).then((res) => ({ type: "conclusion" as const, content: (robustJsonParse(res.content) as Record<string, string>).conclusion || "" }))
    );

    // Execute all parallel tasks
    const results = await Promise.all(tasks);

    // Extract in deterministic order
    const intro = results.find((r) => r.type === "intro")?.content || "";
    const sectionResults = results
      .filter((r): r is ParallelResult & { type: "section"; index: number } => r.type === "section")
      .sort((a, b) => a.index - b.index);
    const conclusion = results.find((r) => r.type === "conclusion")?.content || "";

    console.log(`[generate-blog:INTRO] ${countWords(intro)} words`);
    for (const sr of sectionResults) {
      console.log(`[generate-blog:SECTION] ${sr.index + 1}/${h2Headings.length}: "${sr.heading}" — ${countWords(sr.content)} words`);
    }
    console.log(`[generate-blog:CONCLUSION] ${countWords(conclusion)} words`);

    // Assemble sections array in deterministic order
    const sections: string[] = [intro];
    for (const sr of sectionResults) {
      const headingBlock = `<!-- wp:heading {"level":2} -->\n<h2>${h2Headings[sr.index]}</h2>\n<!-- /wp:heading -->`;
      sections.push(`${headingBlock}\n${sr.content}`);
    }

    // ── PHASE D: Generate FAQ (sequential — depends on all section bodies) ──
    console.log("[generate-blog:FAQ] Generating FAQ...");
    const faqSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.faq);
    const faqPrompt = `Generate 4-6 FAQ questions and answers for this blog. Use <!-- wp:html --> blocks. Return as JSON: {\"faq\": [{\"question\": \"...\", \"answer\": \"...\"}], \"faqSchemaBlock\": \"...\"}.\n\nBlog title: ${generated.title}\nContent summary: ${sections.join("\n").substring(0, 1000)}`;
    const faqRes = await chatWithRetry(
      [{ role: "system", content: faqSystemPrompt }, { role: "user", content: faqPrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
    );
    const faqData = robustJsonParse(faqRes.content) as Record<string, unknown>;
    generated.faq = (faqData.faq as Array<{ question: string; answer: string }>) || [];
    sections.push((faqData.faqSchemaBlock as string) || "");

    // Append conclusion (already generated in parallel block)
    sections.push(conclusion);

    // ── PHASE F: Assemble ──
    generated.blog = sections.join("\n\n");
    const finalWordCount = countWords(generated.blog);
    const faqCount = generated.faq?.length ?? 0;
    console.log(`[generate-blog:ASSEMBLE] Total: ${finalWordCount} words, ${h2Headings.length} sections, ${faqCount} FAQ items, keyphrase in H2: ${keyphraseH2Index >= 0}`);

    // ===== POST-GENERATION: Component regeneration pipeline =====
    console.log("[generate-blog:REGENERATE] Starting component regeneration...");

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
    generated.blog = regeneratedBlog;

    const retryCount = regenLogs.filter((l) => l.includes("retry")).length;
    const componentRegens = regenLogs.filter((l) => l.includes("regenerated")).length;

    // ── Quality scoring ──
    const generationTimeMs = Date.now() - startTime;
    const postRegenWordCount = countWords(generated.blog);
    const estimatedTokens = Math.round((systemPrompt.length + userMessage.length) / 4 * (2 + h2Headings.length + 3)); // rough estimate

    const report = buildGenerationReport(
      generated.blog,
      generated.title,
      generated.metaDescription,
      keyphrase,
      effectiveWordCount,
      (generated.faq || []).length,
      generationTimeMs,
      retryCount,
      0, // jsonRepairs tracked via robustJsonParse internally
      componentRegens,
      warnings,
      estimatedTokens,
    );

    console.log(formatReport(report));

    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(projectId));
    console.log(`[generate-blog:VERSION] Next version: ${nextVersion}`);

    const { seedDefaultLinks: seedLinks } = await import("@/lib/services/default-links");
    await seedLinks(userId);

    const { injectLinks } = await import("@/lib/services/link-injector");
    const injectionResult = await injectLinks(generated.blog, userId);
    console.log(`[generate-blog:LINKS] Injected ${injectionResult.linksInjected} links`);

    if (injectionResult.linksInjected > 0) {
      generated.blog = injectionResult.modifiedContent;
    }

    await blogVersionRepository.create({
      projectId: Number(projectId),
      userId,
      versionNumber: nextVersion,
      title: generated.title,
      slug: generated.slug,
      metaDescription: generated.metaDescription,
      excerpt: generated.excerpt,
      blog: generated.blog,
      faq: generated.faq,
      internalLinks: generated.internalLinks,
      externalLinks: generated.externalLinks,
      categories: generated.categories,
      tags: generated.tags,
      readingTime: generated.readingTime,
      wordCount: postRegenWordCount,
      summary: generated.summary,
      model: "section-by-section",
      generationTimeMs: Date.now() - startTime,
      tokenUsage: { totalTokens: 0 },
      status: "draft",
    });

    await projectRepository.update(Number(projectId), {
      content: generated.blog,
    });

    await aiLogRepository.create({
      userId,
      model: "section-by-section",
      endpoint: "/api/generate-blog",
      status: "success",
      projectId: Number(projectId),
      promptSize: systemPrompt.length + userMessage.length,
      completionSize: generated.blog.length,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      generationTimeMs: Date.now() - startTime,
    });

    return NextResponse.json(
      {
        success: true,
        version: nextVersion,
        title: generated.title,
        slug: generated.slug,
        metaDescription: generated.metaDescription,
        excerpt: generated.excerpt,
        blog: generated.blog,
        faq: generated.faq,
        internalLinks: generated.internalLinks,
        externalLinks: generated.externalLinks,
        categories: generated.categories,
        tags: generated.tags,
        readingTime: generated.readingTime,
        wordCount: postRegenWordCount,
        summary: generated.summary,
        model: "section-by-section",
        generationTimeMs: Date.now() - startTime,
        tokenUsage: { totalTokens: 0 },
        qualityScore: report.qualityScore,
        qualityReport: {
          generationTimeMs: report.generationTimeMs,
          retryCount: report.retryCount,
          componentRegenerations: report.componentRegenerations,
          warnings: report.warnings,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[generate-blog:POST]", error);

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
