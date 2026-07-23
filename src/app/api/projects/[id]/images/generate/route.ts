import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse } from "@/lib/services/errors";
import { generateImage, saveImage, getImageDimensions } from "@/lib/services/images";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveAuthenticatedUserId();
    const { id } = await params;
    const project = await requireProjectAccess(userId, Number(id));

    const body = await request.json();
    const type = body.type || "featured";
    const customPrompt = body.prompt || "";
    const dims = getImageDimensions(type);

    const prompt =
      customPrompt ||
      `Professional editorial photography, ${project.keyword || project.name}, Hong Kong setting, warm natural lighting, navy #1E3A8A and orange #F97316 accents, clean composition, no text overlay`;

    const url = await generateImage(prompt, dims.width, dims.height);

    const saved = await saveImage(Number(id), type, prompt, url, dims.width, dims.height);

    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    console.error("[images:generate]", error);
    return toErrorResponse(error);
  }
}
