import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { knowledgeRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const item = await knowledgeRepository.findByIdAndUser(Number(id), userId);

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(item);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch knowledge item" },
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

    const existing = await knowledgeRepository.findByIdAndUser(Number(id), userId);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const item = await knowledgeRepository.update(Number(id), body);
    return NextResponse.json(item);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to update knowledge item" },
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
    const existing = await knowledgeRepository.findByIdAndUser(Number(id), userId);

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await knowledgeRepository.delete(Number(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to delete knowledge item" },
      { status: 500 }
    );
  }
}
