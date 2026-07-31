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
import { countCanonicalVisibleWords } from "@/lib/blog/article-document";
import { analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const userId = await getCurrentUserId();

    const body = await request.json();
    const projectId = body.projectId;
    if (!projectId) {
      throw AppError.badRequest("projectId is required");
    }

    const project = await requireProjectAccess(userId, Number(projectId));

    const result: GenerationResult = await runBlogGeneration(userId, Number(projectId));

    const finalBlogHtml = result.generated.blog;
    const finalTitle = result.generated.title;
    const finalWordCount = countCanonicalVisibleWords(result.pipelineState.articleDoc);
    const generationTimeMs = Date.now() - startTime;

    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(projectId));
    const previousProjectContent = project.content ?? "";
    let savedVersionId: number | null = null;
    let projectUpdateAttempted = false;

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
      savedVersionId = Number((created as any).id);
      if (!Number.isFinite(savedVersionId)) {
        throw new Error("Created blog version did not return a valid ID");
      }

      projectUpdateAttempted = true;
      await projectRepository.update(Number(projectId), { content: finalBlogHtml });

      const [readbackVersion, readbackProject] = await Promise.all([
        blogVersionRepository.findById(savedVersionId),
        projectRepository.findByIdAndUser(Number(projectId), userId),
      ]);
      if (
        !readbackVersion
        || readbackVersion.blog !== finalBlogHtml
        || readbackVersion.title !== finalTitle
        || readbackVersion.slug !== result.generated.slug
        || !readbackProject
        || readbackProject.content !== finalBlogHtml
      ) {
        throw new Error(`Post-save readback did not match generated version ${savedVersionId} and project ${projectId}`);
      }

      const wordCountRecheck = countCanonicalVisibleWords(result.pipelineState.articleDoc);
      if (wordCountRecheck < result.wordMin || wordCountRecheck > result.wordMax) {
        throw new Error(`Post-save word count ${wordCountRecheck} outside range ${result.wordMin}-${result.wordMax}`);
      }
      const postSaveMetrics = analyzeFinalArticle(
        readbackVersion.blog,
        result.pipelineState.keyphrase,
        readbackVersion.title ?? "",
        readbackVersion.metaDescription ?? "",
        result.pipelineState.requestedWordCount,
        wordCountRecheck,
        {
          articleDoc: result.pipelineState.articleDoc,
          research: result.pipelineState.ctx?.research || [],
          claimOwnership: result.pipelineState.ctx?.claimOwnership,
        },
      );
      const postSavePolicy = result.pipelineState.policy;
      const postSaveValidation = evaluatePolicy(postSaveMetrics, postSavePolicy);
      if (!postSaveValidation.passed) {
        throw new Error(`Post-save validation failed: ${postSaveValidation.reasons.join("; ")}`);
      }
    } catch (saveErr) {
      const rollbackErrors: string[] = [];
      if (projectUpdateAttempted) {
        try {
          await projectRepository.update(Number(projectId), { content: previousProjectContent });
        } catch (rollbackError) {
          rollbackErrors.push(`Project rollback failed: ${String(rollbackError)}`);
        }
      }
      let rollbackVersionId = savedVersionId;
      if (rollbackVersionId === null) {
        try {
          const candidates = await blogVersionRepository.findByProject(Number(projectId));
          const ambiguousCreate = candidates.find((version: any) =>
            version.versionNumber === nextVersion
            && version.slug === result.generated.slug
            && version.blog === finalBlogHtml
          );
          rollbackVersionId = ambiguousCreate ? Number((ambiguousCreate as any).id) : null;
        } catch (lookupError) {
          rollbackErrors.push(`Version rollback lookup failed: ${String(lookupError)}`);
        }
      }
      if (rollbackVersionId !== null && Number.isFinite(rollbackVersionId)) {
        try {
          await blogVersionRepository.delete(rollbackVersionId);
        } catch (rollbackError) {
          rollbackErrors.push(`Version rollback failed: ${String(rollbackError)}`);
        }
      }
      const suffix = rollbackErrors.length > 0 ? `; ${rollbackErrors.join("; ")}` : "";
      console.error(`[generate-blog:SAVE] Compensated save failure: projectId=${projectId} versionId=${savedVersionId ?? "none"}${suffix}`, saveErr);
      throw AppError.internal(new Error(`Generation save failed and was compensated${suffix}: ${String(saveErr)}`));
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
      success: true,
      version: nextVersion,
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
      _versionId: savedVersionId,
    }, { status: 201 });

  } catch (error) {
    console.error("[generate-blog:POST]", error instanceof Error ? error.message : String(error));
    return toErrorResponse(error);
  }
}
