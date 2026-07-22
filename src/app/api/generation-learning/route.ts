import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { generateLearningReport } from "@/lib/services/prompt-learning";

export async function GET() {
  try {
    await getCurrentUserId();
    const report = await generateLearningReport();
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[generation-learning]", error);
    return NextResponse.json({ error: "Failed to generate learning report" }, { status: 500 });
  }
}
