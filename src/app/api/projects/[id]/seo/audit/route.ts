import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { seoRepository, blogVersionRepository } from "@/lib/repositories";
import { runAudit, runChineseAudit } from "@/lib/services/seo-auditor";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await requireProjectAccess(userId, Number(id));

    const body = await request.json();
    const auditRunId = body._auditRunId || "unknown";
    const language: string = body.language || "en";
    const isChinese = language === "zh";

    console.log(`[SEO-AUDIT:${auditRunId}:api-input] keywordLen=${(body.keyword || "").length} blogLen=${(body.blog || "").length} lang=${language}`);

    // Find the latest version matching the requested language
    const versions = await blogVersionRepository.findByProject(Number(id));
    const targetedVersion = isChinese
      ? versions?.find((v: any) => v.slug?.endsWith("-zh"))
      : versions?.find((v: any) => !v.slug?.endsWith("-zh"));

    const title = (targetedVersion as any)?.title || body.title || project.name || "";
    const metaDescription = (targetedVersion as any)?.meta_description || body.metaDescription || "";
    const clientKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const projectKeyword = typeof project.keyword === "string" ? project.keyword.trim() : "";
    const keyword = clientKeyword || projectKeyword;

    console.log(`[KEYPHRASE-RESOLVE] client="${clientKeyword}" project="${projectKeyword}" resolved="${keyword}" len=${keyword.length}`);

    if (!keyword) {
      console.warn("[seo:audit] No focus keyphrase available — marking keyphrase checks as not_applicable");
    }
    const blog = (targetedVersion as any)?.blog || body.blog || (project as any).content || "";
    const faq = (targetedVersion as any)?.faq || [];
    const targetWordCount = (project as any).wordCount || (project as any).word_count || 2500;
    const targetKeyphraseCount = 5;

    console.log(`[seo:audit] versionId=${(targetedVersion as any)?.id} blogLen=${blog.length} title="${title.substring(0, 50)}..." metaLen=${metaDescription.length} keyword="${keyword}" lang=${language}`);

    if (!blog) {
      throw AppError.badRequest("No blog content to audit");
    }

    const result = isChinese
      ? runChineseAudit({
          title, metaDescription, keyword, blog, faq,
          englishWordCount: targetWordCount,
        })
      : runAudit({
          title, metaDescription, keyword, blog, faq,
          targetWordCount, targetKeyphraseCount,
        });

    // Delete only same-language checks for this project
    await seoRepository.deleteByProjectAndLanguage(Number(id), language);
    console.log(`[seo:audit] Deleted ${language} checks for project ${id}`);

    // Insert checks with language-specific category prefix
    const prefix = isChinese ? "zh-" : "";
    const inserted = await seoRepository.createMany(
      result.checks.map((c) => ({
        projectId: Number(id),
        label: c.label,
        description: `${c.measuredValue} (target: ${c.targetValue}) — ${c.explanation}`,
        status: c.status,
        score: c.score,
        fix: c.status !== "not_applicable" ? c.explanation : "",
        category: `${prefix}${c.category}`,
      }))
    );
    console.log(`[seo:audit] Inserted ${inserted.length} ${language} checks for project ${id}`);

    const kpCheck = result.checks.find((c) => c.id === "keyphrase_count");
    console.log(`[SEO-AUDIT:${auditRunId}:api-response] overallScore=${result.overallScore} kpStatus=${kpCheck?.status} kpScore=${kpCheck?.score} kpMeasured="${kpCheck?.measuredValue}"`);

    return NextResponse.json({
      ...result,
      _auditRunId: auditRunId,
      _engineVersion: "keyphrase-fix-1",
      _auditedVersionId: (targetedVersion as any)?.id,
      _auditedVersionNumber: (targetedVersion as any)?.version_number,
    }, { status: 201 });
  } catch (error) {
    console.error("[seo:audit]", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));

    await seoRepository.deleteByProject(Number(id));
    console.log(`[seo:audit] Deleted all checks for project ${id}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[seo:audit:DELETE]", error);
    return toErrorResponse(error);
  }
}
