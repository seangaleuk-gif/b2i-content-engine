import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { projectRepository, blogVersionRepository, researchRepository } from "@/lib/repositories";
import { translateArticle } from "@/lib/services/translation-service";
import { countReadableWords } from "@/lib/services/text-utils";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await requireProjectAccess(userId, Number(id));

    const versions = await blogVersionRepository.findByProject(Number(id));
    const latest = versions?.[0];
    if (!latest || !latest.blog) {
      throw AppError.badRequest("No blog content to translate");
    }

    const targetSlug = (latest.slug ?? project.name.replace(/\s+/g, "-").toLowerCase()) + "-zh";

    // Build a minimal ArticleDocument from the existing version metadata
    const existingDoc = {
      metadata: {
        title: latest.title || "",
        slug: latest.slug || "",
        metaDescription: (latest as any).meta_description || "",
        excerpt: (latest as any).excerpt || "",
        targetWordCount: (latest as any).word_count || 0,
        focusKeyphrase: (latest as any).keyword || project.keyword || "",
      },
      languageSwitcher: null as any,
      introduction: { id: "intro", html: "", wordCount: 0, status: "generated" as const },
      sections: [],
      visibleFaq: (latest as any).faq || [],
      conclusion: { id: "conc", html: "", wordCount: 0, status: "generated" as const },
      cta: null as any,
      faqSchema: null as any,
      insertedLinks: [],
    };

    // Component-based translation
    const research = await researchRepository.findByProject(Number(id));
    const allVersions = await blogVersionRepository.findByProject(Number(id));
    const zhSlugs = new Set(
      (allVersions || [])
        .filter((v: any) => v.slug?.endsWith("-zh"))
        .map((v: any) => v.slug!.replace(/-zh$/, ""))
    );
    const result = await translateArticle(latest.blog, existingDoc, research, zhSlugs);

    if (result.failedComponents.length > 0) {
      console.log("[translate] Components below threshold:", result.failedComponents);
      console.log("[translate] Translation metrics:", JSON.stringify(result.metrics, null, 2));
    }

    // Update language switcher in the translated HTML
    const enSlug = latest.slug ?? "";
    const zhSlug = targetSlug;
    let zhBlog = result.html.replace(
      /b2i-language-switcher[\s\S]*?<\/div>/i,
      `b2i-language-switcher" data-language="zh"><a href="/blog/${enSlug}/">English</a> | <span>繁體中文</span></div>`
    );

    // Also update language switcher in the English source blog
    let enBlog = latest.blog;
    enBlog = enBlog.replace(
      /b2i-language-switcher[\s\S]*?<\/div>/i,
      `b2i-language-switcher" data-language="en"><span>English</span> | <a href="/blog/${zhSlug}/">繁體中文</a></div>`
    );

    if (enBlog !== latest.blog) {
      const { getDb } = await import("@/db");
      const db = getDb() as any;
      const { data: enExisting } = await db
        .from("blog_versions")
        .select("id")
        .eq("project_id", Number(id))
        .eq("slug", latest.slug)
        .limit(1);
      if (enExisting?.length > 0) {
        await db.from("blog_versions").update({ blog: enBlog }).eq("id", enExisting[0].id);
      }
    }

    // Extract internal/external links from translated HTML
    const { internalLinks, externalLinks } = extractLinks(zhBlog);

    // Inherit categories/tags
    const categories = (latest as any).categories || [];
    const tags = (latest as any).tags || [];

    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(id));

    const saved = await blogVersionRepository.create({
      projectId: Number(id),
      userId,
      versionNumber: nextVersion,
      title: result.title || latest.title,
      slug: zhSlug,
      metaDescription: result.metaDescription || (latest as any).meta_description || "",
      excerpt: "",
      blog: zhBlog,
      faq: extractVisibleFaqAsArray(zhBlog),
      internalLinks,
      externalLinks,
      categories,
      tags,
      readingTime: `${result.estimatedReadingMinutes} min`,
      // wordCount stores CJK character count for Chinese content (not English whitespace words)
      wordCount: result.zhCharCount,
      summary: "",
      model: "deepseek-v4-flash",
      promptVersion: "translation-v3",
      generationTimeMs: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } as any);

    return NextResponse.json({ success: true, version: saved }, { status: 201 });
  } catch (error) {
    console.error("[translate]", error);
    return toErrorResponse(error);
  }
}

// ── Helpers ──

function extractLinks(html: string): { internalLinks: string[]; externalLinks: string[] } {
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  const seenInternal = new Set<string>();
  const seenExternal = new Set<string>();
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (href.startsWith("/blog/") && !href.includes("wp:") && !seenInternal.has(href)) {
      internalLinks.push(href);
      seenInternal.add(href);
    } else if (href.startsWith("http") && !href.includes("b2ihub.com") && !href.includes("schema.org") && !seenExternal.has(href)) {
      externalLinks.push(href);
      seenExternal.add(href);
    }
  }
  return { internalLinks, externalLinks };
}

function extractVisibleFaqAsArray(html: string): Array<{ question: string; answer: string }> {
  const faq: Array<{ question: string; answer: string }> = [];
  const qaRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>\s*(?:<\/p>\s*<!--\s*\/wp:paragraph\s*-->\s*<!--\s*wp:paragraph\s*-->\s*<p>)?\s*([\s\S]*?)(?=<strong\b|<h2\b|<!--\s*wp:heading|<!--\s*wp:html|$)/gi;
  let m;
  while ((m = qaRe.exec(html)) !== null) {
    const question = m[1].replace(/<[^>]+>/g, "").trim();
    const answerRaw = m[2].replace(/<\/p>\s*<!--\s*\/wp:paragraph\s*-->/i, "");
    const answer = answerRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if ((question.endsWith("?") || question.endsWith("？")) && answer.length > 10) {
      faq.push({ question, answer });
    }
  }
  return faq;
}
