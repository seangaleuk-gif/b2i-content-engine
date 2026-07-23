import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { toErrorResponse } from "@/lib/services/errors";
import { profileRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const profile = await profileRepository.findOrCreate(userId);

    return NextResponse.json({ ...profile });
  } catch (error) {
    console.error("[profile] Error:", error);
    return toErrorResponse(error);
  }
}
