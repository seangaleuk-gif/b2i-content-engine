import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import { researchRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));

    const sources = await researchRepository.findByProject(Number(id));
    return NextResponse.json(sources);
  } catch (error) {
    return toErrorResponse(error);
  }
}
