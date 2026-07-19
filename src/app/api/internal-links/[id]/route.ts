import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { internalLinksRepository } from "@/lib/repositories";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const body = await request.json();

    const links = await internalLinksRepository.findByUser(userId);
    const existing = links.find((l) => l.id === Number(id));
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (body.displayText !== undefined) updateData.displayText = body.displayText;
    if (body.url !== undefined) updateData.url = body.url;
    if (body.keywords !== undefined) updateData.keywords = body.keywords;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.minPerArticle !== undefined) updateData.minPerArticle = body.minPerArticle;
    if (body.maxPerArticle !== undefined) updateData.maxPerArticle = body.maxPerArticle;
    if (body.active !== undefined) updateData.active = body.active;
    if (body.pinned !== undefined) updateData.pinned = body.pinned;

    const updated = await internalLinksRepository.update(Number(id), updateData);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("[internal-links:PATCH]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to update internal link" },
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

    const links = await internalLinksRepository.findByUser(userId);
    const existing = links.find((l) => l.id === Number(id));
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await internalLinksRepository.delete(Number(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to delete internal link" },
      { status: 500 }
    );
  }
}
