import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { seoRepository, blogVersionRepository } from "@/lib/repositories";
import { runAudit, runChineseAudit } from "@/lib/services/seo-auditor";
import { parseTranslationVersionSummary } from "@/lib/services/translation-version-metadata";
import { countReadableWords } from "@/lib/seo/seo-text-utils";
import { extractVisibleFaqFromArticle, parseArticleDocumentFromHtml, countCanonicalVisibleWords, type ArticleDocument } from "@/lib/blog/article-document";

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

    // Resolve the exact requested saved version when the UI is viewing
    // historical content; otherwise use the latest version for the language.
    const versions = await blogVersionRepository.findByProject(Number(id));
    const requestedVersionNumber = Number(body.versionNumber);
    const languageVersions = (versions ?? []).filter((version) =>
      isChinese ? version.slug?.endsWith("-zh") : !version.slug?.endsWith("-zh"),
    );
    const targetedVersion = Number.isInteger(requestedVersionNumber) && requestedVersionNumber > 0
      ? languageVersions.find((version) => version.versionNumber === requestedVersionNumber)
      : languageVersions[0];
    if (!targetedVersion) {
      throw AppError.badRequest(
        Number.isInteger(requestedVersionNumber) && requestedVersionNumber > 0
          ? `Blog version ${requestedVersionNumber} was not found for language ${language}.`
          : `No saved blog version was found for language ${language}.`,
      );
    }

    let pairedEnglishVersion: any = undefined;
    if (isChinese) {
      // Read the source English version ID from the Chinese version's summary field.
      // Supports the current structured envelope and the legacy source-en-version:<ID> marker.
      const summaryMetadata = parseTranslationVersionSummary(targetedVersion.summary);
      if (summaryMetadata) {
        pairedEnglishVersion = versions?.find((v) => v.id === summaryMetadata.sourceEnVersionId);
      }
      // Fallback for legacy versions without summary marker: find by slug matching
      if (!pairedEnglishVersion) {
        const enSlug = (targetedVersion.slug || "").replace(/-zh$/, "");
        pairedEnglishVersion = versions?.find((v) => v.slug === enSlug);
      }
      if (!pairedEnglishVersion) {
        throw AppError.badRequest(
          `Cannot identify the English source version for Chinese version ${targetedVersion.id}. ` +
          `Re-translate the article to create a proper paired version.`
        );
      }
    }

    const title = targetedVersion.title || body.title || project.name || "";
    const metaDescription = targetedVersion.metaDescription || body.metaDescription || "";

    // For Chinese, read the keyphrase from the structured translation metadata.
    // Legacy versions stored it in excerpt, so retain that narrow fallback only
    // when the summary is the old source-en-version:<ID> marker.
    if (isChinese) {
      const summaryValue = String(targetedVersion.summary || "");
      const translationMetadata = parseTranslationVersionSummary(summaryValue);
      const legacySummary = /^source-en-version:\d+$/.test(summaryValue.trim());
      const legacyExcerptKeyphrase = legacySummary ? String(targetedVersion.excerpt || "").trim() : "";
      const zhKeyword = (translationMetadata?.focusKeyphrase || legacyExcerptKeyphrase).trim();
      if (!zhKeyword || !/[\u3400-\u9fff]/u.test(zhKeyword)) {
        throw AppError.badRequest(
          `Chinese SEO audit requires a valid Chinese keyphrase in the translation metadata. ` +
          `Re-translate the article to create an updated paired version.`
        );
      }
      body.keyword = zhKeyword;
    }
    const clientKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const projectKeyword = typeof project.keyword === "string" ? project.keyword.trim() : "";
    const keyword = isChinese ? clientKeyword : (clientKeyword || projectKeyword);

    console.log(`[KEYPHRASE-RESOLVE] client="${clientKeyword}" project="${projectKeyword}" resolved="${keyword}" len=${keyword.length}`);

    if (!keyword) {
      console.warn("[seo:audit] No focus keyphrase available — marking keyphrase checks as not_applicable");
    }
    const blog = targetedVersion.blog || body.blog || project.content || "";
    const faq = targetedVersion.faq || [];
    const targetWordCount = (project as any).wordCount || (project as any).word_count || 2500;
    const targetKeyphraseCount = 5;

    // Use the paired English version's word count for chineseCharRange, and its FAQ count for parity.
    // Fall back to canonical HTML parsing when the saved faq field is empty.
    let pairedEnglishFaqCount = 0;
    if (isChinese && pairedEnglishVersion) {
      const savedFaq = pairedEnglishVersion?.faq;
      if (Array.isArray(savedFaq) && savedFaq.length > 0) {
        pairedEnglishFaqCount = savedFaq.length;
      } else if (pairedEnglishVersion?.blog) {
        const parsedFaq = extractVisibleFaqFromArticle(pairedEnglishVersion.blog);
        pairedEnglishFaqCount = parsedFaq.length;
      }
    }
    const englishWordCount = isChinese
      ? (pairedEnglishVersion?.wordCount || targetWordCount)
      : targetWordCount;

    // For the log, separate the configured TARGET from MEASURED values of the
    // exact saved canonical content. `targetWordCount` is the project's
    // configured target (a target, never a measurement). `measuredWordCount`
    // uses the SAME authoritative canonical counter as the pipeline and the
    // audit's word_count check (intro + editorial sections + conclusion + FAQ
    // Q&A; CTA, language switcher and schema excluded), so the log, the
    // publication gate and the SEO score can never disagree.
    const measuredFaqCount = (Array.isArray(targetedVersion.faq) && targetedVersion.faq.length > 0)
      ? targetedVersion.faq.length
      : (() => {
          try {
            const parsedFaq = extractVisibleFaqFromArticle(blog);
            return parsedFaq.length;
          } catch {
            return 0;
          }
        })();
    const measuredWordCount = (() => {
      try {
        const seedDoc: ArticleDocument = {
          metadata: {
            title,
            slug: "",
            metaDescription,
            excerpt: "",
            targetWordCount,
            focusKeyphrase: keyword,
          },
          languageSwitcher: null,
          introduction: { id: "audit-introduction", blocks: [], status: "generated" },
          sections: [],
          visibleFaq: [],
          conclusion: { id: "audit-conclusion", blocks: [], status: "generated" },
          cta: null,
          faqSchema: null,
          insertedLinks: [],
        };
        const parsed = parseArticleDocumentFromHtml(blog, seedDoc);
        return parsed.doc ? countCanonicalVisibleWords(parsed.doc) : countReadableWords(blog);
      } catch {
        return countReadableWords(blog);
      }
    })();

    console.log(`[seo:audit] versionId=${targetedVersion.id} sourceEnVersionId=${pairedEnglishVersion?.id} blogLen=${blog.length} title="${title.substring(0, 50)}..." metaLen=${metaDescription.length} keyword="${keyword}" lang=${language} targetWordCount=${targetWordCount} measuredWordCount(canonical)=${measuredWordCount} pairedEnFaqCount=${pairedEnglishFaqCount} measuredFaqCount=${measuredFaqCount}`);

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
      auditRunId,
      engineVersion: "editorial-safety-2",
      auditedVersionId: targetedVersion.id,
      auditedVersionNumber: targetedVersion.versionNumber,
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
