import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository } from "@/lib/repositories";
import { activityRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await projectRepository.findByIdAndUser(Number(id), userId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch project" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const body = await request.json();

    const existing = await projectRepository.findByIdAndUser(Number(id), userId);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

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
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to update project" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const existing = await projectRepository.findByIdAndUser(Number(id), userId);

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await projectRepository.delete(Number(id));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to delete project" },
      { status: 500 }
    );
  }
}
