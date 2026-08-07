import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { projectRepository, activityRepository, blogVersionRepository, researchRepository } from "@/lib/repositories";
import { syncLinksFromContent } from "@/lib/services/link-sync";
import { compensateBilingualWordPress, publishBilingual } from "@/lib/services/wordpress";
import {
  selectBilingualVersionPair,
  validatePublicationPair,
} from "@/lib/services/publication-acceptance";

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    const { projectId, status } = body;
    const publishStatus = (status as "publish" | "draft") || "publish";

    if (!projectId) {
      throw AppError.badRequest("projectId is required");
    }

    const project = await requireProjectAccess(userId, Number(projectId));

    const versions = await blogVersionRepository.findByProject(Number(projectId));
    const pair = selectBilingualVersionPair(versions);
    if (!pair) throw AppError.badRequest("No explicitly paired English and Traditional Chinese versions are ready to publish");
    const { en: enVersion, zh: zhVersion, zhFocusKeyphrase } = pair;
    const research = await researchRepository.findByProject(Number(projectId));
    const acceptance = validatePublicationPair({
      pair,
      englishKeyphrase: project.keyword || "",
      requestedWordCount: project.wordCount || enVersion.wordCount || 2500,
      research,
    });
    console.log("[publish-blog] final acceptance", JSON.stringify({
      projectId: Number(projectId),
      status: publishStatus,
      enVersionId: enVersion.id,
      zhVersionId: zhVersion.id,
      accepted: acceptance.accepted,
      errors: acceptance.errors,
      diagnostics: acceptance.diagnostics,
    }));
    if (!acceptance.accepted) {
      throw AppError.badRequest(`Final bilingual acceptance failed: ${acceptance.errors.slice(0, 8).join("; ")}`);
    }

    console.log(`[publish-blog] Publishing validated pair to WordPress (${publishStatus}): EN slug=${enVersion.slug}, ZH slug=${zhVersion.slug}`);

    const wpResult = await publishBilingual(
      enVersion.title || String(projectId),
      enVersion.blog || "",
      enVersion.slug || "",
      enVersion.categories || ["Creator Economy", "Resources"],
      enVersion.tags || [],
      enVersion.title || String(projectId),
      enVersion.metaDescription || "",
      project.keyword || "",
      zhVersion.title || "",
      zhVersion.blog || "",
      zhVersion.slug || "",
      zhVersion.categories || ["Creator Economy", "Resources"],
      zhVersion.tags || [],
      zhVersion.title || String(projectId),
      zhVersion.metaDescription || "",
      zhFocusKeyphrase,
      publishStatus
    );
    console.log(`[publish-blog] EN: ${wpResult.en.url}, ZH: ${wpResult.zh.url}`);

    if (publishStatus === "publish") {
      try {
        const updatedProject = await projectRepository.update(Number(projectId), {
          status: "published",
          publishedUrl: wpResult.en.url,
        });
        if (!updatedProject) throw new Error("Published project status readback was missing");
      } catch (projectUpdateError) {
        await compensateBilingualWordPress(wpResult.en.id, wpResult.zh.id);
        throw projectUpdateError;
      }
    }

    let linksSynced = 0;
    if (enVersion.blog) {
      try {
        linksSynced = await syncLinksFromContent(enVersion.blog, Number(projectId), userId);
      } catch (linkSyncError) {
        console.error("[publish-blog] Non-blocking link sync failed", linkSyncError);
      }
    }

    const action = publishStatus === "publish" ? "Blog published to WordPress" : "Blog saved as draft on WordPress";
    try {
      await activityRepository.create({
        userId,
        projectId: Number(projectId),
        action,
        description: `EN: ${wpResult.en.url} + ZH: ${wpResult.zh.url}`,
        type: "published",
      });
    } catch (activityError) {
      console.error("[publish-blog] Non-blocking activity log failed", activityError);
    }

    return NextResponse.json({
      success: true,
      projectId: Number(projectId),
      status: publishStatus === "publish" ? "published" : "draft",
      wp: {
        en: { id: wpResult.en.id, url: wpResult.en.url },
        zh: { id: wpResult.zh.id, url: wpResult.zh.url },
      },
      linksSynced,
    });
  } catch (error) {
    console.error("[publish-blog:POST]", error);
    return toErrorResponse(error);
  }
}
