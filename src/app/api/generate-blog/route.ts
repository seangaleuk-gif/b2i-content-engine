import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import {
  projectRepository,
  blogVersionRepository,
  aiLogRepository,
} from "@/lib/repositories";
import { runBlogGeneration, type GenerationResult } from "@/lib/services/blog-generation-service";

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const userId = await getCurrentUserId();

    const body = await request.json();
    const projectId = body.projectId;
    if (!projectId) {
      throw AppError.badRequest("projectId is required");
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
      console.error(`[generate-blog:SAVE] Save failed: projectId=${projectId} versionId=${savedVersionId ?? "none"}`, saveErr);
      if (savedVersionId !== null) {
        try { await blogVersionRepository.delete(savedVersionId); } catch {}
      }
      throw AppError.internal("Failed to save article", saveErr);
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
