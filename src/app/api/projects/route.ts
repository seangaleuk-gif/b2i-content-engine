import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository } from "@/lib/repositories";
import { activityRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const projects = await projectRepository.findByUser(userId);
    return NextResponse.json(projects);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    const project = await projectRepository.create({
      userId,
      name: body.name,
      status: body.status ?? "draft",
      keyword: body.keyword ?? "",
      audience: body.audience ?? "",
      country: body.country ?? "US",
      wordCount: body.wordCount ?? 2500,
      content: body.content ?? "",
    });

    await activityRepository.create({
      userId,
      projectId: project.id,
      action: "Project created",
      description: project.name,
      type: "draft",
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    console.error("[projects:POST]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to create project", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
