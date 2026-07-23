import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { projectRepository, blogVersionRepository } from "@/lib/repositories";
import { promptSectionRepository } from "@/lib/repositories";
import { AiService } from "@/lib/services/deepseek";

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

    const promptSections = await promptSectionRepository.findByUser(userId);
    const translationRules = (promptSections as Record<string, unknown>[]).find(
      (s) => (s as Record<string, unknown>).section_key === "translation_rules"
    );
    const rulesContent = (translationRules as Record<string, unknown>)?.content as string ?? "";

    const targetSlug = (latest.slug ?? project.name.replace(/\s+/g, "-").toLowerCase()) + "-zh";

    const systemPrompt = `You are a professional translator specializing in Hong Kong Traditional Chinese (zh-HK). Translate the following blog post accurately while preserving:

- The original tone, personality, and voice
- WordPress block format
- All HTML structure, links, and formatting
- Use full-width punctuation for Chinese text
- Adapt idioms and expressions naturally for a Hong Kong audience
- Use colloquial Hong Kong Cantonese phrasing where appropriate
- Do NOT translate: brand names (B2I Hub), URLs, code, statistics, or proper nouns
- Hong Kong Traditional Chinese characters

${rulesContent}`;

    const userMessage = `Translate this blog post to Traditional Chinese (Hong Kong):

Title: ${latest.title || project.name}

${latest.blog}

Output as a JSON object with these fields:
{
  "title": "translated title in Traditional Chinese",
  "metaDescription": "translated meta description in Traditional Chinese",
  "blog": "translated blog content in WordPress block format",
  "slug": "${targetSlug}"
}`;

    const ai = new AiService();
    const result = await ai.chatWithRetry(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { responseFormat: { type: "json_object" }, maxTokens: 32768 }
    );

    let translated: { title: string; metaDescription: string; blog: string; slug: string };
    try {
      console.log("[translate] Raw response length:", result.content.length);
      console.log("[translate] First 500 chars:", result.content.substring(0, 500));

      const cleaned = result.content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      console.log("[translate] Cleaned length:", cleaned.length);
      console.log("[translate] Cleaned first 500:", cleaned.substring(0, 500));

      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) {
        console.error("[translate] No JSON pattern match found in response");
        throw AppError.internal();
      }
      console.log("[translate] JSON match length:", match[0].length);
      translated = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error("[translate] Parse error:", parseErr);
      console.error("[translate] Full response:", result.content.substring(0, 2000));
      throw AppError.internal(parseErr);
    }

    const enSlug = latest.slug ?? "";
    const zhSlug = translated.slug || targetSlug;

    translated.blog = translated.blog.replace(
      /<a\s[^>]*href="[^"]*"[^>]*>.*?(?:English|EN).*?<\/a>\s*<a\s[^>]*href="[^"]*"[^>]*>.*?(?:中文|Chinese|ZH).*?<\/a>/gi,
      `<a href="/blog/${zhSlug}/">閱讀中文版</a> <a href="/blog/${enSlug}/">Read in English</a>`
    );

    let enBlog = latest.blog;
    enBlog = enBlog.replace(
      /<a\s[^>]*href="[^"]*"[^>]*>.*?(?:English|EN).*?<\/a>\s*<a\s[^>]*href="[^"]*"[^>]*>.*?(?:中文|Chinese|ZH).*?<\/a>/gi,
      `<a href="/blog/${enSlug}/">Read in English</a> <a href="/blog/${zhSlug}/">閱讀中文版</a>`
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

    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(id));

    const saved = await blogVersionRepository.create({
      projectId: Number(id),
      userId,
      versionNumber: nextVersion,
      title: translated.title || latest.title,
      slug: translated.slug || targetSlug,
      metaDescription: translated.metaDescription || latest.metaDescription || "",
      excerpt: "",
      blog: translated.blog,
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: ["Creator Economy", "Resources"],
      tags: [],
      readingTime: "",
      wordCount: translated.blog?.split(/\s+/).filter(Boolean).length ?? 0,
      summary: "",
      model: result.model,
      promptVersion: "translation-v1",
      generationTimeMs: 0,
      tokenUsage: result.usage,
    } as any);

    return NextResponse.json({ success: true, version: saved }, { status: 201 });
  } catch (error) {
    console.error("[translate]", error);
    return toErrorResponse(error);
  }
}
