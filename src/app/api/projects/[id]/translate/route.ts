import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { blogVersionRepository, researchRepository } from "@/lib/repositories";
import { translateArticle } from "@/lib/services/translation-service";
import { runChineseAudit } from "@/lib/services/seo-auditor";
import {
  type ArticleDocument,
  fingerprintHtml,
  extractVisibleFaqFromArticle,
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  renderComponentHtml,
} from "@/lib/blog/article-document";
import { pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";
import { buildTranslationVersionSummary } from "@/lib/services/translation-version-metadata";
import type { BlogVersion } from "@/db/schema/blog-versions";
import { scanTemporalFreshness } from "@/lib/blog/temporal-freshness";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const projectId = Number(id);
    const project = await requireProjectAccess(userId, projectId);

    const versions = (await blogVersionRepository.findByProject(projectId)) ?? [];
    const latest = versions.find((version) => !version.slug?.endsWith("-zh")) ?? versions[0];
    if (!latest?.blog) {
      throw AppError.badRequest("No blog content to translate");
    }

    const staleSourceIssues = scanTemporalFreshness(
      [latest.title || "", latest.metaDescription || "", latest.blog].join("\n"),
      new Date(),
    );
    if (staleSourceIssues.length > 0) {
      const first = staleSourceIssues[0];
      throw AppError.badRequest(
        `The English source contains stale temporal wording: "${first.sentence}". `
        + "Regenerate or repair the English article before translation so both language versions remain factually aligned.",
      );
    }

    const baseSlug = latest.slug || project.name.replace(/\s+/g, "-").toLowerCase();
    const slugs = pairedSlugs(baseSlug);
    const existingDoc = createExistingDocument(latest, project.keyword || "", slugs.englishSlug);

    const research = await researchRepository.findByProject(projectId);
    const result = await translateArticle(latest.blog, existingDoc, research);

    if (result.failedComponents.length > 0) {
      console.error("[translate] Rejected translation candidate:", result.failedComponents);
      throw AppError.badRequest(
        `Translation failed for components: ${result.failedComponents.join(", ")}`
      );
    }

    if (!result.doc || result.doc.metadata.slug !== slugs.chineseSlug) {
      throw AppError.internal(new Error("Translation returned a non-canonical Chinese slug"));
    }
    const zhBlog = renderArticleDocument(result.doc);
    if (zhBlog !== result.html) {
      throw AppError.internal(new Error("Translation HTML diverged from its canonical ArticleDocument"));
    }

    const zhKeyword = result.doc.metadata.focusKeyphrase || "";
    if (!/[\u3400-\u9fff]/.test(zhKeyword)) {
      throw AppError.badRequest("Translation did not produce a valid Chinese focus keyphrase");
    }

    const { doc: parsedEnglishDoc, errors: englishParseErrors } =
      parseArticleDocumentFromHtml(latest.blog, existingDoc);
    if (!parsedEnglishDoc || englishParseErrors.length > 0) {
      throw AppError.internal(
        new Error(`Could not reconstruct the English ArticleDocument: ${englishParseErrors.join("; ")}`)
      );
    }
    parsedEnglishDoc.metadata.slug = slugs.englishSlug;
    const enSwitcherHtml = renderLanguageSwitcher({
      currentLanguage: "en",
      englishSlug: slugs.englishSlug,
      chineseSlug: slugs.chineseSlug,
    });
    parsedEnglishDoc.languageSwitcher = {
      id: "en-language-switcher",
      type: "language-switcher",
      html: enSwitcherHtml,
      fingerprint: fingerprintHtml(enSwitcherHtml),
    };
    const enBlog = renderArticleDocument(parsedEnglishDoc);

    const { internalLinks, externalLinks } = extractEditorialLinks(result.doc);
    const categories = Array.isArray(latest.categories) ? latest.categories : [];
    const tags = Array.isArray(latest.tags) ? latest.tags : [];
    const pairedEnFaqCount = getSavedFaqCount(latest, parsedEnglishDoc);

    const zhAudit = runChineseAudit({
      title: result.title || latest.title || "",
      metaDescription: result.metaDescription || latest.metaDescription || "",
      keyword: zhKeyword,
      blog: zhBlog,
      faq: result.doc.visibleFaq.map((entry) => ({
        question: entry.question,
        answer: entry.answerText,
      })),
      englishWordCount: latest.wordCount || 2500,
      pairedEnglishFaqCount: pairedEnFaqCount,
    });

    const hardFailures = zhAudit.checks.filter((check) => check.status === "fail");
    if (hardFailures.length > 0) {
      const details = hardFailures
        .map((check) => `${check.label}: ${check.measuredValue} vs ${check.targetValue}`)
        .join("; ");
      console.error(`[translate] Chinese SEO hard failures: ${details}`);
      throw AppError.badRequest(
        `Chinese SEO audit failed: ${hardFailures.map((check) => check.label).join(", ")}`
      );
    }
    const softWarnings = zhAudit.checks
      .filter((check) => check.status === "warning")
      .map((check) => ({ id: check.id, label: check.label, score: check.score }));

    const nextVersion = await blogVersionRepository.getNextVersionNumber(projectId);
    let createdChineseId: number | null = null;
    let englishUpdateAttempted = false;

    try {
      const created = await blogVersionRepository.create({
        projectId,
        userId,
        versionNumber: nextVersion,
        title: result.title || latest.title,
        slug: slugs.chineseSlug,
        metaDescription: result.metaDescription || latest.metaDescription || "",
        excerpt: result.doc.metadata.excerpt,
        blog: zhBlog,
        faq: result.doc.visibleFaq.map((entry) => ({
          question: entry.question,
          answer: entry.answerText,
        })),
        internalLinks,
        externalLinks,
        categories,
        tags,
        readingTime: `${result.estimatedReadingMinutes} min`,
        wordCount: result.zhCharCount,
        summary: buildTranslationVersionSummary(Number(latest.id), zhKeyword),
        model: "deepseek-v4-flash",
        promptVersion: "translation-v6-freshness-hk-editorial",
        generationTimeMs: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      } as any);
      createdChineseId = Number((created as any).id);
      if (!Number.isFinite(createdChineseId)) {
        createdChineseId = null;
        throw new Error("Created Chinese version did not return a valid ID");
      }

      englishUpdateAttempted = true;
      await blogVersionRepository.update(Number(latest.id), { blog: enBlog } as any);

      const [savedChinese, savedEnglish] = await Promise.all([
        blogVersionRepository.findById(createdChineseId),
        blogVersionRepository.findById(Number(latest.id)),
      ]);
      if (
        !savedChinese ||
        savedChinese.blog !== zhBlog ||
        savedChinese.slug !== slugs.chineseSlug ||
        !savedEnglish ||
        savedEnglish.blog !== enBlog
      ) {
        throw new Error("Bilingual post-save readback did not match the canonical documents");
      }
    } catch (persistenceError) {
      const rollbackErrors: string[] = [];
      if (englishUpdateAttempted) {
        try {
          await blogVersionRepository.update(Number(latest.id), { blog: latest.blog } as any);
        } catch (rollbackError) {
          rollbackErrors.push(`English rollback failed: ${String(rollbackError)}`);
        }
      }
      let rollbackChineseId = createdChineseId;
      if (rollbackChineseId === null) {
        try {
          const candidates = await blogVersionRepository.findByProject(projectId);
          const ambiguousCreate = candidates.find((version: any) =>
            version.versionNumber === nextVersion
            && version.slug === slugs.chineseSlug
            && version.blog === zhBlog
          );
          rollbackChineseId = ambiguousCreate ? Number((ambiguousCreate as any).id) : null;
        } catch (lookupError) {
          rollbackErrors.push(`Chinese rollback lookup failed: ${String(lookupError)}`);
        }
      }
      if (rollbackChineseId !== null && Number.isFinite(rollbackChineseId)) {
        try {
          await blogVersionRepository.delete(rollbackChineseId);
        } catch (rollbackError) {
          rollbackErrors.push(`Chinese rollback failed: ${String(rollbackError)}`);
        }
      }
      const suffix = rollbackErrors.length > 0 ? `; ${rollbackErrors.join("; ")}` : "";
      throw AppError.internal(new Error(`Bilingual save failed and was compensated${suffix}: ${String(persistenceError)}`));
    }

    return NextResponse.json({
      version: {
        id: createdChineseId,
        versionNumber: nextVersion,
        language: "zh",
        slug: slugs.chineseSlug,
        sourceEnVersionId: latest.id,
        keyphrase: zhKeyword,
      },
      chineseSeo: {
        score: zhAudit.overallScore,
        softWarnings: softWarnings.length,
        warningDetails: softWarnings,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("[translate]", error);
    return toErrorResponse(error);
  }
}

function createExistingDocument(
  latest: BlogVersion,
  projectKeyword: string,
  englishSlug: string,
): ArticleDocument {
  return {
    metadata: {
      title: latest.title || "",
      slug: englishSlug,
      metaDescription: latest.metaDescription || "",
      excerpt: latest.excerpt || "",
      targetWordCount: latest.wordCount || 0,
      focusKeyphrase: projectKeyword,
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: Array.isArray(latest.faq)
      ? latest.faq.map((entry: any) => ({
          question: entry.question || "",
          answerHtml: entry.answerHtml || entry.answer || "",
          answerText: entry.answerText || entry.answer || "",
        }))
      : [],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function getSavedFaqCount(latest: any, parsedEnglishDoc: ArticleDocument): number {
  if (Array.isArray(latest.faq) && latest.faq.length > 0) return latest.faq.length;
  if (parsedEnglishDoc.visibleFaq.length > 0) return parsedEnglishDoc.visibleFaq.length;
  return extractVisibleFaqFromArticle(String(latest.blog || "")).length;
}

function extractEditorialLinks(doc: ArticleDocument): { internalLinks: string[]; externalLinks: string[] } {
  const editorialHtml = [
    renderComponentHtml(doc.introduction),
    ...doc.sections.map((section) => renderComponentHtml(section)),
    renderComponentHtml(doc.conclusion),
    ...doc.visibleFaq.map((entry) => entry.answerHtml),
  ].join("\n");
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  const seenInternal = new Set<string>();
  const seenExternal = new Set<string>();
  const hrefRe = /<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(editorialHtml)) !== null) {
    const href = match[1];
    if (href.startsWith("/blog/") && !seenInternal.has(href)) {
      internalLinks.push(href);
      seenInternal.add(href);
    } else if (
      /^https?:\/\//i.test(href)
      && !/b2ihub\.com/i.test(href)
      && !/schema\.org/i.test(href)
      && !seenExternal.has(href)
    ) {
      externalLinks.push(href);
      seenExternal.add(href);
    }
  }
  return { internalLinks, externalLinks };
}
