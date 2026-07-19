import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { projectRepository } from "@/lib/repositories";
import { activityRepository } from "@/lib/repositories";
import { profileRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();

    const [totalProjects, published, drafts, research, recentProjects, activity, profile] =
      await Promise.all([
        projectRepository.countByUser(userId),
        projectRepository.countByUserAndStatus(userId, "published"),
        projectRepository.countByUserAndStatus(userId, "draft"),
        projectRepository.countByUserAndStatus(userId, "research"),
        projectRepository.findByUser(userId),
        activityRepository.findByUser(userId, 10),
        profileRepository.findOrCreate(userId),
      ]);

    return NextResponse.json({
      stats: {
        totalProjects,
        published,
        drafts,
        research,
      },
      recentProjects: recentProjects.slice(0, 5),
      activity: activity.slice(0, 10),
      profile: {
        apiCreditsUsed: Number((profile as Record<string, unknown>).api_credits_used ?? 0),
        apiCreditsLimit: Number((profile as Record<string, unknown>).api_credits_limit ?? 10000),
        storageUsedBytes: Number((profile as Record<string, unknown>).storage_used_bytes ?? 0),
        storageLimitBytes: Number((profile as Record<string, unknown>).storage_limit_bytes ?? 5368709120),
      },
    });
  } catch (error) {
    console.error("[dashboard] Error:", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch dashboard data", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
