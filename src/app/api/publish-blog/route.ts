import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import { projectRepository, activityRepository, blogVersionRepository } from "@/lib/repositories";
import { syncLinksFromContent } from "@/lib/services/link-sync";
import { publishBilingual } from "@/lib/services/wordpress";

export async function POST(request: Request) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const body = await request.json();

    const { projectId, status } = body;
    const publishStatus = (status as "publish" | "draft") || "publish";

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    await requireProjectAccess(userId, Number(projectId));

    const versions = await blogVersionRepository.findByProject(Number(projectId));

    const enVersion = (versions as any[]).find((v: any) => v.slug && !v.slug.endsWith("-zh"));
    const zhVersion = (versions as any[]).find((v: any) => v.slug && v.slug.endsWith("-zh"));

    if (!enVersion) {
      return NextResponse.json({ error: "No English blog version to publish" }, { status: 400 });
    }

    console.log(`[publish-blog] Publishing to WordPress (${publishStatus}): EN slug=${enVersion.slug}${zhVersion ? `, ZH slug=${zhVersion.slug}` : ""}`);

    const wpResult = await publishBilingual(
      enVersion.title || projectId,
      enVersion.blog,
      enVersion.slug,
      (enVersion as any).categories || ["Creator Economy", "Resources"],
      (enVersion as any).tags || [],
      enVersion.title || projectId,
      (enVersion as any).metaDescription || "",
      "",
      zhVersion?.title || "",
      zhVersion?.blog || "",
      zhVersion?.slug || "",
      (zhVersion as any)?.categories || ["Creator Economy", "Resources"],
      (zhVersion as any)?.tags || [],
      zhVersion?.title || projectId,
      (zhVersion as any)?.metaDescription || "",
      "",
      publishStatus
    );
    console.log(`[publish-blog] EN: ${wpResult.en.url}, ZH: ${wpResult.zh.url || "skipped"}`);

    if (publishStatus === "publish") {
      const project = await projectRepository.findById(Number(projectId));
      if (project) {
        await projectRepository.update(Number(projectId), { status: "published" } as any);
      }
    }

    let linksSynced = 0;
    if (enVersion.blog) {
      linksSynced = await syncLinksFromContent(enVersion.blog, Number(projectId), userId);
    }

    const action = publishStatus === "publish" ? "Blog published to WordPress" : "Blog saved as draft on WordPress";
    await activityRepository.create({
      userId,
      projectId: Number(projectId),
      action,
      description: `EN: ${wpResult.en.url}${wpResult.zh.id ? ` + ZH` : ""}`,
      type: "published",
    });

    return NextResponse.json({
      success: true,
      projectId: Number(projectId),
      status: publishStatus === "publish" ? "published" : "draft",
      wp: {
        en: { id: wpResult.en.id, url: wpResult.en.url },
        zh: wpResult.zh.id ? { id: wpResult.zh.id, url: wpResult.zh.url } : null,
      },
      linksSynced,
    });
  } catch (error) {
    console.error("[publish-blog:POST]", error);
    return toErrorResponse(error);
  }
}
