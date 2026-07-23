import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { toErrorResponse } from "@/lib/services/errors";
import { promptRepository } from "@/lib/repositories";

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const items = await promptRepository.findByUser(userId);
    return NextResponse.json(items);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();

    const item = await promptRepository.create({
      userId,
      name: body.name,
      purpose: body.purpose ?? "",
      tags: body.tags ?? [],
      template: body.template,
      variables: body.variables ?? {},
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
