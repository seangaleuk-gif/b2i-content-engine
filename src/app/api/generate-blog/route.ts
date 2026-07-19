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
import { buildBlogPrompt } from "@/lib/services/prompt-builder";
import { createDeepSeekClient } from "@/lib/services/deepseek";

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

function countBodyWords(text: string): number {
  const cleaned = text
    .replace(/<!-- \/?wp:\w+.*?-->/g, "")
    .replace(/<!-- wp:html -->[\s\S]*?<!-- \/wp:html -->/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[\[\]\(\)#*_~`>|]/g, " ")
    .replace(/\{.*?\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

function parseBlogJson(raw: string): GeneratedBlog {
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim();

  try {
    const parsed = JSON.parse(jsonStr) as GeneratedBlog;
    if (!parsed.title || !parsed.blog) {
      throw new Error("Response missing required fields: title and blog");
    }
    return parsed;
  } catch (firstError) {
    if (codeBlockMatch) {
      const parsed = JSON.parse(raw.trim()) as GeneratedBlog;
      if (!parsed.title || !parsed.blog) {
        throw new Error("Response missing required fields: title and blog");
      }
      return parsed;
    }
    throw new Error(
      `Failed to parse blog JSON: ${firstError instanceof Error ? firstError.message : String(firstError)}`
    );
  }
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
    const result = await chatWithRetry(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { responseFormat: { type: "json_object" }, maxTokens: 32768 }
    );

    // ===== LOG STEP 4: DEEPSEEK RESPONSE =====
    console.log(`[generate-blog:STEP4] Model: ${result.model}`);
    console.log(`[generate-blog:STEP4] Prompt tokens: ${result.usage.promptTokens}`);
    console.log(`[generate-blog:STEP4] Completion tokens: ${result.usage.completionTokens}`);
    console.log(`[generate-blog:STEP4] Total tokens: ${result.usage.totalTokens}`);
    console.log(`[generate-blog:STEP4] Raw content length: ${result.content.length} chars`);
    console.log(`[generate-blog:STEP4] Raw content first 200 chars: "${result.content.substring(0, 200)}"`);

    let generated: GeneratedBlog;
    try {
      generated = parseBlogJson(result.content);
    } catch {
      return NextResponse.json(
        { error: "Failed to parse AI response as JSON" },
        { status: 500 }
      );
    }

    if (!generated.blog) {
      return NextResponse.json(
        { error: "AI did not generate blog content" },
        { status: 500 }
      );
    }

    const wordCount = countBodyWords(generated.blog);

    const targetWordCount = context.project.wordCount;
    const firstWordCount = wordCount;
    let continuationUsed = false;

    if (targetWordCount > 0 && firstWordCount < targetWordCount) {
      console.log(`[generate-blog:CONTINUE] First pass: ${firstWordCount} words < target ${targetWordCount}. Starting continuation loop...`);

      let currentContent = generated.blog;
      let currentWords = firstWordCount;
      let continuationAttempts = 0;
      const MAX_CONTINUATION_ATTEMPTS = 3;

      while (currentWords < targetWordCount && continuationAttempts < MAX_CONTINUATION_ATTEMPTS) {
        continuationAttempts++;
        const remaining = targetWordCount - currentWords;

        const continuePrompt = `You wrote a ${currentWords}-word article. The requirement is ${targetWordCount} words. Write ${remaining} more words of additional content to expand the article. Return ONLY the new content as a simple JSON object with one field: {"additionalContent": "..."}. Do NOT return the full article. Do NOT use markdown code blocks. The response must be parseable by JSON.parse().`;

        console.log(`[generate-blog:CONTINUE] Attempt ${continuationAttempts}/${MAX_CONTINUATION_ATTEMPTS}: need ${remaining} more words`);

        try {
          const contResult = await chatWithRetry(
            [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
              { role: "assistant", content: result.content },
              { role: "user", content: continuePrompt },
            ],
            { responseFormat: { type: "json_object" }, maxTokens: 16384 }
          );

          let additionalContent = "";
          try {
            const parsed = JSON.parse(contResult.content);
            additionalContent = parsed.additionalContent || "";
          } catch {
            console.log(`[generate-blog:CONTINUE] Attempt ${continuationAttempts}: JSON.parse failed, trying regex fallback`);
          }

          if (additionalContent && additionalContent.length > 50) {
            currentContent = currentContent + "\n\n" + additionalContent;
            currentWords = countBodyWords(currentContent);
            generated.blog = currentContent;
            continuationUsed = true;
            console.log(`[generate-blog:CONTINUE] Attempt ${continuationAttempts}: +${additionalContent.length} chars → ${currentWords} words total`);
          } else {
            console.log(`[generate-blog:CONTINUE] Attempt ${continuationAttempts}: no usable content returned`);
            break;
          }
        } catch (err) {
          console.log(`[generate-blog:CONTINUE] Attempt ${continuationAttempts} failed: ${err instanceof Error ? err.message : err}`);
          break;
        }
      }

      console.log(`[generate-blog:CONTINUE] Loop complete. Final: ${countBodyWords(generated.blog)} words after ${continuationAttempts} continuation attempt(s)`);
    }

    const finalWordCount = countBodyWords(generated.blog);
    console.log(`[generate-blog:STEP5] Final word count: ${finalWordCount} words${continuationUsed ? " (after continuation)" : ""}`);

    console.log(`[generate-blog:STEP5] FAQ count: ${generated.faq?.length ?? 0}`);
    console.log(`[generate-blog:STEP5] Generation time: ${Date.now() - startTime}ms`);
    console.log("======== [generate-blog] PIPELINE COMPLETE ========");

    const nextVersion = await blogVersionRepository.getNextVersionNumber(
      Number(projectId)
    );

    const generationTimeMs = Date.now() - startTime;

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
      wordCount: finalWordCount,
      summary: generated.summary,
      model: result.model,
      generationTimeMs,
      tokenUsage: result.usage,
      status: "draft",
    });

    await projectRepository.update(Number(projectId), {
      content: generated.blog,
    });

    await aiLogRepository.create({
      userId,
      model: result.model,
      endpoint: "/api/generate-blog",
      status: "success",
      projectId: Number(projectId),
      promptSize: systemPrompt.length + userMessage.length,
      completionSize: result.content.length,
      tokensIn: result.usage.promptTokens,
      tokensOut: result.usage.completionTokens,
      tokensTotal: result.usage.totalTokens,
      generationTimeMs,
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
        wordCount: finalWordCount,
        summary: generated.summary,
        model: result.model,
        generationTimeMs,
        tokenUsage: result.usage,
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
