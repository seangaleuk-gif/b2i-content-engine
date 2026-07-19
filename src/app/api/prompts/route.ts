import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { promptRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const items = await promptRepository.findByUser(userId);
    return NextResponse.json(items);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch prompts" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    const item = await promptRepository.create({
      userId,
      name: body.name,
      purpose: body.purpose ?? "",
      tags: body.tags ?? [],
      template: body.template,
      variables: body.variables ?? {},
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to create prompt" },
      { status: 500 }
    );
  }
}
