import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { suggestedLinksRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const suggestions = await suggestedLinksRepository.findPendingByUser(userId);
    return NextResponse.json({ suggestions });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch suggested links" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    if (!body.id || !body.action) {
      return NextResponse.json(
        { error: "id and action are required" },
        { status: 400 }
      );
    }

    if (body.action === "approve") {
      await suggestedLinksRepository.approve(body.id);
      return NextResponse.json({ success: true, approved: true });
    } else if (body.action === "reject") {
      await suggestedLinksRepository.reject(body.id);
      return NextResponse.json({ success: true, rejected: true });
    } else {
      return NextResponse.json(
        { error: "Invalid action. Use 'approve' or 'reject'" },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error("[suggested-links:POST]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to process suggested link" },
      { status: 500 }
    );
  }
}
