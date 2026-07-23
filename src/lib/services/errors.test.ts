import { describe, it, expect } from "vitest";
import { AppError, toErrorResponse } from "@/lib/services/errors";

describe("AppError", () => {
  it("extends Error", () => {
    const err = new AppError(400, "BAD_REQUEST", "Bad request");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AppError");
  });

  it("stores status, code, message", () => {
    const err = new AppError(422, "UNPROCESSABLE", "Invalid input");
    expect(err.status).toBe(422);
    expect(err.code).toBe("UNPROCESSABLE");
    expect(err.message).toBe("Invalid input");
  });

  it("stores optional cause", () => {
    const cause = new Error("DB down");
    const err = new AppError(500, "INTERNAL_ERROR", "Internal error", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("AppError factory methods", () => {
  it("unauthorized() returns 401 with code UNAUTHORIZED", () => {
    const err = AppError.unauthorized();
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Unauthorized");
  });

  it("forbidden() returns 403 with code FORBIDDEN", () => {
    const err = AppError.forbidden();
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Access denied");
  });

  it("notFound() returns 404 with custom resource name", () => {
    const err = AppError.notFound("Project");
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Project not found");
  });

  it("notFound() defaults to 'Resource'", () => {
    const err = AppError.notFound();
    expect(err.message).toBe("Resource not found");
  });

  it("badRequest() returns 400", () => {
    const err = AppError.badRequest("Name is required");
    expect(err.status).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toBe("Name is required");
  });

  it("conflict() returns 409", () => {
    const err = AppError.conflict("Duplicate entry");
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Duplicate entry");
  });

  it("unprocessable() returns 422", () => {
    const err = AppError.unprocessable("Invalid format");
    expect(err.status).toBe(422);
    expect(err.code).toBe("UNPROCESSABLE");
    expect(err.message).toBe("Invalid format");
  });

  it("tooManyRequests() returns 429", () => {
    const err = AppError.tooManyRequests();
    expect(err.status).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toBe("Too many requests");
  });

  it("tooManyRequests() accepts custom message", () => {
    const err = AppError.tooManyRequests("API limit exceeded");
    expect(err.message).toBe("API limit exceeded");
  });

  it("internal() returns 500", () => {
    const err = AppError.internal();
    expect(err.status).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("Internal server error");
  });

  it("internal() accepts custom message and cause", () => {
    const cause = new Error("DB timeout");
    const err = AppError.internal("Database unavailable", cause);
    expect(err.message).toBe("Database unavailable");
    expect(err.cause).toBe(cause);
  });
});

describe("toErrorResponse", () => {
  it("maps AppError to its status, message, and code", async () => {
    const err = AppError.forbidden();
    const res = toErrorResponse(err);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Access denied");
    expect(body.code).toBe("FORBIDDEN");
  });

  it("maps 401 correctly", async () => {
    const res = toErrorResponse(AppError.unauthorized());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("maps 400 correctly", async () => {
    const res = toErrorResponse(AppError.badRequest("Missing field"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing field");
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("maps 500 correctly", async () => {
    const res = toErrorResponse(AppError.internal());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("maps unknown errors to generic 500 with no internal details", async () => {
    const res = toErrorResponse(new Error("Database password: secret123"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).not.toContain("secret123");
    expect(body.error).not.toContain("password");
  });

  it("maps non-Error throws to generic 500", async () => {
    const res = toErrorResponse("just a string");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("maps null/undefined to generic 500", async () => {
    const res = toErrorResponse(null);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("never exposes internal cause in response body", async () => {
    const cause = new Error("DB connection refused at 10.0.0.1:5432");
    const err = AppError.internal("Database unavailable", cause);
    const res = toErrorResponse(err);
    const body = await res.json();
    expect(body.error).toBe("Database unavailable");
    expect(JSON.stringify(body)).not.toContain("10.0.0.1");
    expect(JSON.stringify(body)).not.toContain("5432");
  });

  it("preserves status codes: 400, 401, 403, 404, 409, 422, 429, 500", () => {
    const cases: [AppError, number][] = [
      [AppError.badRequest("x"), 400],
      [AppError.unauthorized(), 401],
      [AppError.forbidden(), 403],
      [AppError.notFound(), 404],
      [AppError.conflict("x"), 409],
      [AppError.unprocessable("x"), 422],
      [AppError.tooManyRequests(), 429],
      [AppError.internal(), 500],
    ];
    for (const [err, expected] of cases) {
      expect(toErrorResponse(err).status).toBe(expected);
    }
  });
});

describe("service-layer errors", () => {
  it("AppError.internal preserves message and code in response", async () => {
    const err = AppError.internal("WordPress publish failed", new Error("401 auth"));
    const res = toErrorResponse(err);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("WordPress publish failed");
  });

  it("provider error details never reach response body", async () => {
    const cause = new Error("Brave Search API returned 401: Invalid API key abc123");
    const err = AppError.internal("Research request failed", cause);
    const res = toErrorResponse(err);
    const body = await res.json();
    expect(body.error).toBe("Research request failed");
    expect(JSON.stringify(body)).not.toContain("Brave");
    expect(JSON.stringify(body)).not.toContain("abc123");
    expect(JSON.stringify(body)).not.toContain("API key");
  });

  it("AppError.tooManyRequests preserves 429 in response", async () => {
    const err = AppError.tooManyRequests("Research rate limit exceeded");
    const res = toErrorResponse(err);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.error).toBe("Research rate limit exceeded");
  });

  it("AppError.notFound preserves 404 in response", async () => {
    const err = AppError.notFound("Project");
    const res = toErrorResponse(err);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toBe("Project not found");
  });

  it("AppError.badRequest preserves 400 in response", async () => {
    const err = AppError.badRequest("Name is required");
    const res = toErrorResponse(err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.error).toBe("Name is required");
  });

  it("AppError.conflict preserves 409 in response", async () => {
    const err = AppError.conflict("Duplicate entry");
    const res = toErrorResponse(err);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("AppError.unprocessable preserves 422 in response", async () => {
    const err = AppError.unprocessable("Invalid format");
    const res = toErrorResponse(err);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("UNPROCESSABLE");
  });

  it("AppError with arbitrary status preserves that status", async () => {
    const err = new AppError(502, "BAD_GATEWAY", "Upstream service unavailable");
    const res = toErrorResponse(err);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("BAD_GATEWAY");
    expect(body.error).toBe("Upstream service unavailable");
  });

  it("only toErrorResponse constructs NextResponse — AppError has no toResponse method", () => {
    const err = AppError.internal("test");
    expect((err as any).toResponse).toBeUndefined();
  });

  it("non-AppError internal cause is never exposed", async () => {
    const err = new Error("Postgres connection failed: password=admin123");
    const res = toErrorResponse(err);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("Postgres");
    expect(JSON.stringify(body)).not.toContain("admin123");
    expect(JSON.stringify(body)).not.toContain("password");
  });
});

describe("response shape verification", () => {
  it("standard 401 response has error and code fields only", async () => {
    const res = toErrorResponse(AppError.unauthorized());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(body.error).toBe("Unauthorized");
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("generic 500 response has error and code fields only", async () => {
    const res = toErrorResponse(new Error("anything at all"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("generic 500 response never contains the thrown message", async () => {
    const res = toErrorResponse(new Error("Database connection to 10.x.x.x refused"));
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("10.");
    expect(JSON.stringify(body)).not.toContain("refused");
  });

  it("generic 500 response never contains provider error messages", async () => {
    const res = toErrorResponse(new Error("Hugging Face API returned 503"));
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("Hugging");
    expect(JSON.stringify(body)).not.toContain("503");
  });

  it("generic 500 response never contains stack traces", async () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at Object.<anonymous> (C:\\Users\\user\\src\\secret.ts:42:5)";
    const res = toErrorResponse(err);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("secret.ts");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("generic 500 response never contains filesystem paths", async () => {
    const err = new Error("ENOENT: no such file, open '/etc/secrets/db.conf'");
    const res = toErrorResponse(err);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("/etc/secrets");
    expect(JSON.stringify(body)).not.toContain("ENOENT");
  });

  it("detailed cause logged but absent from response", async () => {
    const cause = new Error("DB password is hunter2");
    const err = AppError.internal("Service unavailable", cause);
    const res = toErrorResponse(err);
    const body = await res.json();
    expect(body.error).toBe("Service unavailable");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("response has no detail field", async () => {
    const res = toErrorResponse(AppError.internal("test"));
    const body = await res.json();
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("cause");
    expect(body).not.toHaveProperty("stack");
  });
});
