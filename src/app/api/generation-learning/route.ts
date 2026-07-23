import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { toErrorResponse } from "@/lib/services/errors";
import { generateLearningReport } from "@/lib/services/prompt-learning";

export async function GET() {
  try {
    await getCurrentUserId();
    const report = await generateLearningReport();
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    console.error("[generation-learning]", error);
    return toErrorResponse(error);
  }
}
