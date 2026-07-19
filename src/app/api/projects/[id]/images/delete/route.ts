import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository } from "@/lib/repositories";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await projectRepository.findByIdAndUser(Number(id), userId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const imageId = body.imageId;
    if (!imageId) {
      return NextResponse.json({ error: "imageId is required" }, { status: 400 });
    }

    const { getDb } = await import("@/db");
    const db = getDb() as any;
    const { error } = await db.from("images").delete().eq("id", imageId).eq("project_id", Number(id));
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[images:delete]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to delete image" },
      { status: 500 }
    );
  }
}
