import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository, activityRepository, blogVersionRepository } from "@/lib/repositories";
import { syncLinksFromContent } from "@/lib/services/link-sync";
import { publishBilingual } from "@/lib/services/wordpress";

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    const { projectId, status } = body;
    const publishStatus = (status as "publish" | "draft") || "publish";

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const project = await projectRepository.findByIdAndUser(Number(projectId), userId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const versions = await blogVersionRepository.findByProject(Number(projectId));

    const enVersion = (versions as any[]).find((v: any) => v.slug && !v.slug.endsWith("-zh"));
    const zhVersion = (versions as any[]).find((v: any) => v.slug && v.slug.endsWith("-zh"));

    if (!enVersion) {
      return NextResponse.json({ error: "No English blog version to publish" }, { status: 400 });
    }

    console.log(`[publish-blog] Publishing to WordPress (${publishStatus}): EN slug=${enVersion.slug}${zhVersion ? `, ZH slug=${zhVersion.slug}` : ""}`);

    let wpResult;
    try {
      wpResult = await publishBilingual(
        enVersion.title || project.name,
        enVersion.blog,
        enVersion.slug,
        (enVersion as any).categories || ["Creator Economy", "Resources"],
        (enVersion as any).tags || [],
        enVersion.title || project.name,
        (enVersion as any).metaDescription || "",
        (project as any).keyword || "",
        zhVersion?.title || "",
        zhVersion?.blog || "",
        zhVersion?.slug || "",
        (zhVersion as any)?.categories || ["Creator Economy", "Resources"],
        (zhVersion as any)?.tags || [],
        zhVersion?.title || project.name,
        (zhVersion as any)?.metaDescription || "",
        (project as any).keyword || "",
        publishStatus
      );
      console.log(`[publish-blog] EN: ${wpResult.en.url}, ZH: ${wpResult.zh.url || "skipped"}`);
    } catch (wpErr) {
      console.error("[publish-blog] WordPress publish failed:", wpErr);
      return NextResponse.json(
        { error: "WordPress publish failed", detail: wpErr instanceof Error ? wpErr.message : String(wpErr) },
        { status: 502 }
      );
    }

    if (publishStatus === "publish") {
      await projectRepository.update(Number(projectId), { status: "published" } as any);
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
      description: `${project.name} (EN: ${wpResult.en.url})${wpResult.zh.id ? ` + ZH` : ""}`,
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
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to publish blog", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
