import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { createDeepSeekClient } from "@/lib/services/deepseek";

export async function POST(request: Request) {
  try {
    await getCurrentUserId();

    const body = await request.json();
    const { systemPrompt, userMessage, model } = body;

    if (!systemPrompt || !userMessage) {
      return NextResponse.json(
        { error: "systemPrompt and userMessage are required" },
        { status: 400 }
      );
    }

    const { chat } = createDeepSeekClient();
    const result = await chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { model: model ?? "deepseek-chat" }
    );

    return NextResponse.json({
      content: result.content,
      usage: result.usage,
      model: result.model,
    });
  } catch (error) {
    console.error("[playground:POST]", error);
    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      {
        error: "Playground request failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
