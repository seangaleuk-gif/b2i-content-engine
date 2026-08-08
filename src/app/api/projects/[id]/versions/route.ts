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
    // The repository normalizes Supabase rows to the camelCase BlogVersion contract.
    return NextResponse.json(versions);
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

    const version = await blogVersionRepository.findById(Number(versionId));
    if (
      !version
      || Number(version.projectId) !== Number(id)
      || version.userId !== userId
    ) {
      throw AppError.notFound("Blog version");
    }
    await blogVersionRepository.delete(Number(versionId));
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
