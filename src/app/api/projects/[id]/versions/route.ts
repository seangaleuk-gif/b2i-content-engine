import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { blogVersionRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await getCurrentUserId();
    const { id } = await params;
    const versions = await blogVersionRepository.findByProject(Number(id));
    return NextResponse.json(versions);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch versions" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await getCurrentUserId();
    await params;
    const body = await request.json();
    const versionId = body.versionId;

    if (!versionId) {
      return NextResponse.json(
        { error: "versionId is required" },
        { status: 400 }
      );
    }

    await blogVersionRepository.delete(Number(versionId));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to delete version" },
      { status: 500 }
    );
  }
}
