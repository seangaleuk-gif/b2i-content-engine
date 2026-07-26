import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { requireProjectAccess } from "@/lib/services/project-authorization";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { seoRepository } from "@/lib/repositories";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    await requireProjectAccess(userId, Number(id));

    const { searchParams } = new URL(request.url);
    const language = searchParams.get("language") || "en";

    const checks = language === "zh"
      ? await seoRepository.findByProjectAndLanguage(Number(id), "zh")
      : await seoRepository.findByProjectAndLanguage(Number(id), "en");
    return NextResponse.json(checks);
  } catch (error) {
    return toErrorResponse(error);
  }
}
