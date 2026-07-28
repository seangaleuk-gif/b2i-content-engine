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

    // Find the latest version matching the requested language.
    const versions = await blogVersionRepository.findByProject(Number(id));
    const targetedVersion = isChinese
      ? versions?.find((v: any) => v.slug?.endsWith("-zh"))
      : versions?.find((v: any) => !v.slug?.endsWith("-zh"));

    let pairedEnglishVersion: any = undefined;
    if (isChinese) {
      // Read the source English version ID from the Chinese version's summary field.
      // Format: "source-en-version:<ID>" (set during translation).
      const summary: string = (targetedVersion as any)?.summary || "";
      const sourceMatch = summary.match(/^source-en-version:(\d+)$/);
      if (sourceMatch) {
        const sourceId = Number(sourceMatch[1]);
        pairedEnglishVersion = versions?.find((v: any) => v.id === sourceId);
      }
      // Fallback for legacy versions without summary marker: find by slug matching
      if (!pairedEnglishVersion) {
        const enSlug = ((targetedVersion as any)?.slug || "").replace(/-zh$/, "");
        pairedEnglishVersion = versions?.find((v: any) => v.slug === enSlug);
      }
      if (!pairedEnglishVersion) {
        throw AppError.badRequest(
          `Cannot identify the English source version for Chinese version ${(targetedVersion as any)?.id}. ` +
          `Re-translate the article to create a proper paired version.`
        );
      }
    }

    const title = (targetedVersion as any)?.title || body.title || project.name || "";
    const metaDescription = (targetedVersion as any)?.meta_description || body.metaDescription || "";

    // For Chinese: use the saved Chinese keyphrase from the version's excerpt only.
    // Never fall back to the English project keyword.
    if (isChinese) {
      const zhKeyword = ((targetedVersion as any)?.excerpt || "").trim();
      if (!zhKeyword || !/[\u4e00-\u9fff]/.test(zhKeyword)) {
        throw AppError.badRequest(
          `Chinese SEO audit requires a valid Chinese keyphrase. ` +
          `The Chinese version's excerpt field is empty or lacks CJK characters. ` +
          `Re-translate the article to generate the Chinese keyphrase.`
        );
      }
      body.keyword = zhKeyword;
    }
    const clientKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const projectKeyword = typeof project.keyword === "string" ? project.keyword.trim() : "";
    const keyword = isChinese ? clientKeyword : (clientKeyword || projectKeyword);

    console.log(`[KEYPHRASE-RESOLVE] zh="${(targetedVersion as any)?.excerpt}" client="${clientKeyword}" project="${projectKeyword}" resolved="${keyword}" len=${keyword.length}`);

    if (!keyword) {
      console.warn("[seo:audit] No focus keyphrase available — marking keyphrase checks as not_applicable");
    }
    const blog = (targetedVersion as any)?.blog || body.blog || (project as any).content || "";
    const faq = (targetedVersion as any)?.faq || [];
    const targetWordCount = (project as any).wordCount || (project as any).word_count || 2500;
    const targetKeyphraseCount = 5;

    // Use the paired English version's word count for chineseCharRange, and its FAQ count for parity.
    // Fall back to canonical HTML parsing when the saved faq field is empty.
    let pairedEnglishFaqCount = 0;
    if (isChinese && pairedEnglishVersion) {
      const savedFaq = (pairedEnglishVersion as any)?.faq;
      if (Array.isArray(savedFaq) && savedFaq.length > 0) {
        pairedEnglishFaqCount = savedFaq.length;
      } else if ((pairedEnglishVersion as any)?.blog) {
        const { extractVisibleFaqFromArticle } = await import("@/lib/blog/article-document");
        const parsedFaq = extractVisibleFaqFromArticle((pairedEnglishVersion as any).blog);
        pairedEnglishFaqCount = parsedFaq.length;
      }
    }
    const englishWordCount = isChinese
      ? ((pairedEnglishVersion as any)?.word_count || targetWordCount)
      : targetWordCount;

    console.log(`[seo:audit] versionId=${(targetedVersion as any)?.id} sourceEnVersionId=${(pairedEnglishVersion as any)?.id} blogLen=${blog.length} title="${title.substring(0, 50)}..." metaLen=${metaDescription.length} keyword="${keyword}" lang=${language} enWordCount=${englishWordCount} enFaqCount=${pairedEnglishFaqCount}`);

    if (!blog) {
      throw AppError.badRequest("No blog content to audit");
    }

    const result = isChinese
      ? runChineseAudit({
          title, metaDescription, keyword, blog, faq,
          englishWordCount,
          pairedEnglishFaqCount,
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
