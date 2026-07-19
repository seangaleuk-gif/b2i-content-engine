import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { knowledgeRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const items = await knowledgeRepository.findByUser(userId);
    return NextResponse.json(items);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch knowledge items" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    const item = await knowledgeRepository.create({
      userId,
      title: body.title,
      content: body.content ?? "",
      tags: body.tags ?? [],
      pinned: body.pinned ?? false,
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to create knowledge item" },
      { status: 500 }
    );
  }
}
