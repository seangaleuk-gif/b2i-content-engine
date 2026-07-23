import { NextResponse } from "next/server";

export class AppError extends Error {
  readonly name = "AppError";

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }

  static unauthorized(cause?: unknown): AppError {
    return new AppError(401, "UNAUTHORIZED", "Unauthorized", cause);
  }

  static forbidden(cause?: unknown): AppError {
    return new AppError(403, "FORBIDDEN", "Access denied", cause);
  }

  static notFound(resource = "Resource"): AppError {
    return new AppError(404, "NOT_FOUND", `${resource} not found`);
  }

  static badRequest(message: string): AppError {
    return new AppError(400, "BAD_REQUEST", message);
  }

  static conflict(message: string): AppError {
    return new AppError(409, "CONFLICT", message);
  }

  static unprocessable(message: string): AppError {
    return new AppError(422, "UNPROCESSABLE", message);
  }

  static tooManyRequests(message = "Too many requests"): AppError {
    return new AppError(429, "RATE_LIMITED", message);
  }

  static internal(cause?: unknown): AppError {
    return new AppError(500, "INTERNAL_ERROR", "Internal server error", cause);
  }
}

const FIXED_500 = { error: "Internal server error", code: "INTERNAL_ERROR" as const };

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      if (error.cause) {
        console.error(`[AppError ${error.code}]`, error.cause);
      }
      if (error.message !== FIXED_500.error) {
        console.error(`[AppError ${error.code}] suppressed message:`, error.message);
      }
      return NextResponse.json(FIXED_500, { status: error.status });
    }

    if (error.cause) {
      console.error(`[AppError ${error.code}]`, error.cause);
    }
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  console.error("[unhandled]", error instanceof Error ? error.message : String(error));
  return NextResponse.json(FIXED_500, { status: 500 });
}
