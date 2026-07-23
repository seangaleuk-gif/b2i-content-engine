import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import { projectRepository } from "@/lib/repositories";
import { activityRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await resolveAuthenticatedUserId();
    const projects = await projectRepository.findByUser(userId);
    return NextResponse.json(projects);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await resolveAuthenticatedUserId();
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
    return toErrorResponse(error);
  }
}
