import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import { toErrorResponse, AppError } from "@/lib/services/errors";
import { knowledgeRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const item = await knowledgeRepository.findByIdAndUser(Number(id), userId);

    if (!item) {
      throw AppError.notFound("Knowledge item");
    }

    return NextResponse.json(item);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const body = await request.json();

    const existing = await knowledgeRepository.findByIdAndUser(Number(id), userId);
    if (!existing) {
      throw AppError.notFound("Knowledge item");
    }

    const item = await knowledgeRepository.update(Number(id), body);
    return NextResponse.json(item);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId();
    const { id } = await params;
    const existing = await knowledgeRepository.findByIdAndUser(Number(id), userId);

    if (!existing) {
      throw AppError.notFound("Knowledge item");
    }

    await knowledgeRepository.delete(Number(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
