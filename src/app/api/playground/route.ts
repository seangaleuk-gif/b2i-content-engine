import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { toErrorResponse } from "@/lib/services/errors";
import { AiService } from "@/lib/services/deepseek";

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

    const ai = new AiService();
    const result = await ai.chat(
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
    return toErrorResponse(error);
  }
}
