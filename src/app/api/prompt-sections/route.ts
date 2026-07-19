import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { promptSectionRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const sections = await promptSectionRepository.findByUser(userId);
    return NextResponse.json(sections);
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch prompt sections" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    console.log(`[prompt-sections:POST] userId=${userId} sectionKey=${body.sectionKey} contentLen=${body.content?.length ?? 0}`);

    if (!body.sectionKey || body.content === undefined) {
      console.log(`[prompt-sections:POST] Missing fields — sectionKey=${!!body.sectionKey} content=${body.content !== undefined}`);
      return NextResponse.json(
        { error: "sectionKey and content are required" },
        { status: 400 }
      );
    }

    const section = await promptSectionRepository.upsert(
      userId,
      body.sectionKey,
      body.content
    );

    console.log(`[prompt-sections:POST] Upserted section: id=${(section as any)?.id} key=${(section as any)?.section_key} len=${(section as any)?.content?.length}`);
    return NextResponse.json(section);
  } catch (error) {
    console.error("[prompt-sections:POST] Error:", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to upsert prompt section" },
      { status: 500 }
    );
  }
}
