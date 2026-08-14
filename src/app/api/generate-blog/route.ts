import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import {
  blogVersionRepository,
  aiLogRepository,
} from "@/lib/repositories";
import { runBlogGeneration, type GenerationResult } from "@/lib/services/blog-generation-service";
import { countCanonicalVisibleWords, renderArticleDocument } from "@/lib/blog/article-document";
import { analyzeFinalArticle, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { runFinalValidation } from "@/lib/pipeline/blog-generation-pipeline";

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

    const canonicalRender = renderArticleDocument(result.pipelineState.articleDoc);
    const persistedFaq = result.pipelineState.articleDoc.visibleFaq.map((entry) => ({
      question: entry.question,
      answer: entry.answerText,
    }));
    const representationIssues: string[] = [];
    if (result.pipelineState.blog !== canonicalRender) representationIssues.push("rendered cache differs from ArticleDocument");
    if (result.generated.blog !== canonicalRender) representationIssues.push("generated blog differs from canonical render");
    if (result.generated.title !== result.pipelineState.title
      || result.generated.title !== result.pipelineState.articleDoc.metadata.title) {
      representationIssues.push("title differs from canonical metadata");
    }
    if (result.generated.slug !== result.pipelineState.slug
      || result.generated.slug !== result.pipelineState.articleDoc.metadata.slug) {
      representationIssues.push("slug differs from canonical metadata");
    }
    if (result.generated.metaDescription !== result.pipelineState.metaDescription
      || result.generated.metaDescription !== result.pipelineState.articleDoc.metadata.metaDescription) {
      representationIssues.push("meta description differs from canonical metadata");
    }
    if (result.generated.excerpt !== result.pipelineState.excerpt
      || result.generated.excerpt !== result.pipelineState.articleDoc.metadata.excerpt) {
      representationIssues.push("excerpt differs from canonical metadata");
    }
    if (JSON.stringify(result.generated.faq || []) !== JSON.stringify(persistedFaq)) {
      representationIssues.push("FAQ payload differs from canonical FAQ");
    }
    if (representationIssues.length > 0) {
      console.error(
        `[generate-blog:PRE-SAVE] canonical agreement failed projectId=${projectId}`+
        ` reasons=[${representationIssues.join("; ")}] zeroWrites=true`,
      );
      throw AppError.unprocessable(`Canonical pre-save agreement failed: ${representationIssues.join("; ")}`);
    }

    const finalBlogHtml = result.generated.blog;
    const finalTitle = result.generated.title;
    const finalWordCount = countCanonicalVisibleWords(result.pipelineState.articleDoc);
    const generationTimeMs = Date.now() - startTime;

    // Defence in depth: never begin persistence unless the exact canonical
    // pipeline result still passes the sole final acceptance policy.
    const preSaveValidation = runFinalValidation(result.pipelineState);
    if (!preSaveValidation.passed) {
      console.error(
        `[generate-blog:PRE-SAVE] final policy failed projectId=${projectId}`+
        ` firstInvariant="${preSaveValidation.reasons[0] ?? "unknown"}" zeroWrites=true`,
      );
      throw AppError.unprocessable(
        `Final validation failed before save: ${preSaveValidation.reasons.join("; ")}`,
      );
    }

    const previousProjectContent = project.content ?? "";
    let savedVersionId: number | null = null;
    let savedVersionNumber: number | null = null;

    try {
      const created = await blogVersionRepository.createEnglishVersionAtomically({
        projectId: Number(projectId), userId,
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
        tokenUsage: {
          totalTokens: 0,
          qualityAcceptance: result.pipelineState.fullDocumentEditorial
            ? {
                runId: result.pipelineState.fullDocumentEditorial.runId,
                mode: result.pipelineState.fullDocumentEditorial.mode,
                status: result.pipelineState.fullDocumentEditorial.status,
                accepted: result.pipelineState.fullDocumentEditorial.accepted,
                selectedUnitIds: result.pipelineState.fullDocumentEditorial.selectedUnitIds,
                unresolvedFindingIds: result.pipelineState.fullDocumentEditorial.unresolvedFindingIds,
                mandatoryOverflow: result.pipelineState.fullDocumentEditorial.mandatoryOverflow,
                acceptedPatchCount: result.pipelineState.fullDocumentEditorial.patches.filter((patch) => patch.accepted).length,
                findings: result.pipelineState.fullDocumentEditorial.findings.map((finding) => ({
                  findingId: finding.findingId,
                  category: finding.category,
                  severity: finding.severity,
                  blockIds: finding.blockIds,
                  source: finding.source,
                })),
                patches: result.pipelineState.fullDocumentEditorial.patches,
                diagnostics: result.pipelineState.fullDocumentEditorial.diagnostics,
              }
            : null,
        },
        status: "draft",
      });
      savedVersionId = Number(created.id);
      savedVersionNumber = created.versionNumber;
      if (savedVersionId === null || !Number.isFinite(savedVersionId)) {
        throw new Error("Created blog version did not return a valid ID");
      }
      if (savedVersionNumber === null || !Number.isFinite(savedVersionNumber)) {
        throw new Error("Created blog version did not return a valid version number");
      }

      const readbackVersion = await blogVersionRepository.findById(savedVersionId);
      if (
        !readbackVersion
        || readbackVersion.blog !== finalBlogHtml
        || readbackVersion.title !== finalTitle
        || readbackVersion.slug !== result.generated.slug
      ) {
        throw new Error(`Post-save readback did not match generated version ${savedVersionId}`);
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
          fullDocumentEditorial: result.pipelineState.fullDocumentEditorial,
        },
      );
      const postSavePolicy = result.pipelineState.policy;
      const postSaveValidation = evaluatePolicy(postSaveMetrics, postSavePolicy);
      if (!postSaveValidation.passed) {
        throw new Error(`Post-save validation failed: ${postSaveValidation.reasons.join("; ")}`);
      }
    } catch (saveErr) {
      const rollbackErrors: string[] = [];
      if (savedVersionId !== null && Number.isFinite(savedVersionId)) {
        try {
          await blogVersionRepository.delete(savedVersionId);
        } catch (rollbackError) {
          rollbackErrors.push(`Version rollback failed: ${String(rollbackError)}`);
        }
        try {
          await blogVersionRepository.synchronizeProjectContentToLatestEnglish(
            Number(projectId),
            userId,
            previousProjectContent,
          );
        } catch (rollbackError) {
          rollbackErrors.push(`Project-content reconciliation failed: ${String(rollbackError)}`);
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
      version: savedVersionNumber,
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
