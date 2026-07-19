import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository } from "@/lib/repositories";
import { generateImage, saveImage, getImageDimensions } from "@/lib/services/images";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const project = await projectRepository.findByIdAndUser(Number(id), userId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const type = body.type || "featured";
    const customPrompt = body.prompt || "";
    const dims = getImageDimensions(type);

    const prompt =
      customPrompt ||
      `Professional editorial photography, ${project.keyword || project.name}, Hong Kong setting, warm natural lighting, navy #1E3A8A and orange #F97316 accents, clean composition, no text overlay`;

    const url = await generateImage(prompt, dims.width, dims.height);

    // Pollinations generates asynchronously — the URL returns immediately but may take seconds to render
    const saved = await saveImage(Number(id), type, prompt, url, dims.width, dims.height);

    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    console.error("[images:generate]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to generate image", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
