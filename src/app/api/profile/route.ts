import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { profileRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const profile = await profileRepository.findOrCreate(userId);

    return NextResponse.json({ ...profile });
  } catch (error) {
    console.error("[profile] Error:", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch profile", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
