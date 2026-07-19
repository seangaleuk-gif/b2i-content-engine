import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository, researchRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await projectRepository.findByIdAndUser(Number(id), userId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const sources = await researchRepository.findByProject(Number(id));
    return NextResponse.json(sources);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch research" },
      { status: 500 }
    );
  }
}
