import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import {
  projectRepository,
  blogVersionRepository,
  aiLogRepository,
} from "@/lib/repositories";
import { runBlogGeneration, type GenerationResult } from "@/lib/services/blog-generation-service";

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const userId = await resolveAuthenticatedUserId();

    const body = await request.json();
    const projectId = body.projectId;
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    await requireProjectAccess(userId, Number(projectId));

    const result: GenerationResult = await runBlogGeneration(userId, Number(projectId));

    const finalBlogHtml = result.generated.blog;
    const finalTitle = result.generated.title;
    const finalWordCount = finalBlogHtml.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(/\s+/).length;
    const generationTimeMs = Date.now() - startTime;

    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(projectId));
    let savedVersionId: number | null = null;
    try {
      const created = await blogVersionRepository.create({
        projectId: Number(projectId), userId, versionNumber: nextVersion,
        title: finalTitle, slug: result.generated.slug,
        metaDescription: result.generated.metaDescription,
        excerpt: result.generated.excerpt || "",
        blog: finalBlogHtml, faq: result.generated.faq || [],
        internalLinks: result.generated.internalLinks || [],
        externalLinks: result.generated.externalLinks || [],
        categories: result.generated.categories || [],
        tags: result.generated.tags || [],
        readingTime: result.generated.readingTime || "",
        wordCount: finalWordCount,
        summary: result.generated.summary || "",
        model: "section-by-section",
        generationTimeMs,
        tokenUsage: { totalTokens: 0 },
        status: "draft",
      });
      savedVersionId = (created as any).id ?? null;
      await projectRepository.update(Number(projectId), { content: finalBlogHtml });
    } catch (saveErr) {
      const errMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
      console.error(`[generate-blog:SAVE] Save failed: projectId=${projectId} versionId=${savedVersionId ?? "none"} error=${errMsg}`);
      if (savedVersionId !== null) {
        try { await blogVersionRepository.delete(savedVersionId); } catch {}
      }
      return NextResponse.json({ error: "Failed to save article", detail: errMsg }, { status: 500 });
    }

    try {
      await aiLogRepository.create({
        userId, model: "section-by-section", endpoint: "/api/generate-blog",
        status: "success", projectId: Number(projectId),
        promptSize: result.systemPrompt.length + result.userMessage.length,
        completionSize: finalBlogHtml.length,
        tokensIn: 0, tokensOut: 0, tokensTotal: 0, generationTimeMs,
      });
    } catch (e) { console.error("[AI-LOG] Non-fatal:", String(e)); }

    return NextResponse.json({
      success: true, version: nextVersion,
      title: finalTitle,
      slug: result.generated.slug,
      metaDescription: result.generated.metaDescription,
      excerpt: result.generated.excerpt,
      blog: finalBlogHtml,
      faq: result.generated.faq,
      internalLinks: result.generated.internalLinks,
      externalLinks: result.generated.externalLinks,
      categories: result.generated.categories,
      tags: result.generated.tags,
      readingTime: result.generated.readingTime,
      wordCount: finalWordCount,
      summary: result.generated.summary,
      model: "section-by-section",
      generationTimeMs,
      tokenUsage: { totalTokens: 0 },
      qualityScore: result.qualityReport?.qualityScore ?? null,
    }, { status: 201 });

  } catch (error) {
    console.error("[generate-blog:POST]", error instanceof Error ? error.message : String(error));
    return toErrorResponse(error);
  }
}
