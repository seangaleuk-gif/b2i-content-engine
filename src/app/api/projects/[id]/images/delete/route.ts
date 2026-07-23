import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));

    const body = await request.json();
    const imageId = body.imageId;
    if (!imageId) {
      throw AppError.badRequest("imageId is required");
    }

    const { getDb } = await import("@/db");
    const db = getDb() as any;
    const { error } = await db.from("images").delete().eq("id", imageId).eq("project_id", Number(id));
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[images:delete]", error);
    return toErrorResponse(error);
  }
}
