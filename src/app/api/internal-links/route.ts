import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { internalLinksRepository, suggestedLinksRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const links = await internalLinksRepository.findByUser(userId);
    const suggestions = await suggestedLinksRepository.findPendingByUser(userId);
    return NextResponse.json({ links, pendingSuggestions: suggestions.length });
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch internal links" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    if (!body.displayText || !body.url) {
      return NextResponse.json(
        { error: "displayText and url are required" },
        { status: 400 }
      );
    }

    const link = await internalLinksRepository.create({
      createdBy: userId,
      displayText: body.displayText,
      urlSlug: body.urlSlug ?? body.url,
      keywords: body.keywords ?? [],
      priority: body.priority ?? 2,
      minPerArticle: body.minPerArticle ?? 1,
      maxPerArticle: body.maxPerArticle ?? 3,
      active: body.active ?? true,
    });

    return NextResponse.json(link, { status: 201 });
  } catch (error) {
    console.error("[internal-links:POST]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to create internal link" },
      { status: 500 }
    );
  }
}
