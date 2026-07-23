import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import { projectRepository, researchRepository, activityRepository } from "@/lib/repositories";
import { runBraveResearchWithRetry } from "@/lib/services/brave";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const { id } = await params;

    const project = await requireProjectAccess(userId, Number(id));

    if (!project.keyword && !project.name) {
      return NextResponse.json(
        { error: "Project has no keyword or topic to research" },
        { status: 400 }
      );
    }

    const query = project.keyword || project.name;

    console.log(`[research:generate] projectId=${id} | keyword="${project.keyword}" | name="${project.name}" | query="${query}"`);
    console.log(`[research:generate] calling runBraveResearchWithRetry("${query}")`);

    const results = await runBraveResearchWithRetry(query);

    console.log(`[research:generate] Brave returned ${results.length} results`);
    console.log(`[research:generate] categories: ${[...new Set(results.map(r => r.category))].join(", ")}`);

    await researchRepository.deleteByProject(Number(id));

    const saved = await researchRepository.createMany(
      results.map((r) => ({
        projectId: Number(id),
        category: r.category,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        position: r.position,
      }))
    );

    await activityRepository.create({
      userId,
      projectId: Number(id),
      action: "Research generated",
      description: `${saved.length} sources found for "${query}"`,
      type: "research",
    });

    return NextResponse.json(
      {
        success: true,
        query,
        sourcesFound: saved.length,
        sources: saved,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[research:generate] Error:", error);
    return toErrorResponse(error);
  }
}
