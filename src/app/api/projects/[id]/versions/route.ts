import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { blogVersionRepository } from "@/lib/repositories";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));
    const url = new URL(request.url);
    const language = url.searchParams.get("language");
    let versions = await blogVersionRepository.findByProject(Number(id));
    if (language === "en") {
      versions = versions.filter((v: any) => !v.slug?.endsWith("-zh"));
    } else if (language === "zh") {
      versions = versions.filter((v: any) => v.slug?.endsWith("-zh"));
    }
    // Supabase returns database column names. The client contract is camelCase;
    // normalize here so version selectors and audit labels never receive an
    // undefined `versionNumber`.
    return NextResponse.json(versions.map((version: any) => ({
      ...version,
      projectId: version.project_id,
      userId: version.user_id,
      versionNumber: version.version_number,
      metaDescription: version.meta_description,
      internalLinks: version.internal_links,
      externalLinks: version.external_links,
      readingTime: version.reading_time,
      wordCount: version.word_count,
      promptVersion: version.prompt_version,
      generationTimeMs: version.generation_time_ms,
      tokenUsage: version.token_usage,
      createdAt: version.created_at,
      updatedAt: version.updated_at,
    })));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));
    const body = await request.json();
    const versionId = body.versionId;

    if (!versionId) {
      throw AppError.badRequest("versionId is required");
    }

    await blogVersionRepository.delete(Number(versionId));
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
