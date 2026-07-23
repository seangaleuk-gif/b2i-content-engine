import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { blogVersionRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));
    const versions = await blogVersionRepository.findByProject(Number(id));
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

    await blogVersionRepository.delete(Number(versionId));
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
