import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import { projectRepository } from "@/lib/repositories";
import { activityRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const { id } = await params;
    const project = await requireProjectAccess(userId, Number(id));
    return NextResponse.json(project);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const { id } = await params;
    const body = await request.json();

    const existing = await requireProjectAccess(userId, Number(id));

    const project = await projectRepository.update(Number(id), body);

    if (body.content && body.content !== existing.content) {
      await activityRepository.create({
        userId,
        projectId: Number(id),
        action: "Draft saved",
        description: existing.name,
        type: "draft",
      });
    }

    if (body.status === "published" && existing.status !== "published") {
      await activityRepository.create({
        userId,
        projectId: Number(id),
        action: "Published",
        description: existing.name,
        type: "publish",
      });
    }

    return NextResponse.json(project);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const { id } = await params;

    await requireProjectAccess(userId, Number(id));

    await projectRepository.delete(Number(id));

    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
