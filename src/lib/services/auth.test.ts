import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHeadersFn, mockCookiesFn, mockGetUser } = vi.hoisted(() => ({
  mockHeadersFn: vi.fn(),
  mockCookiesFn: vi.fn(),
  mockGetUser: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

vi.mock("next/headers", () => ({
  headers: mockHeadersFn,
  cookies: mockCookiesFn,
}));

import { getCurrentUserId } from "@/lib/services/auth";
import { AppError } from "@/lib/services/errors";

function mockHeaders(map: Record<string, string>) {
  mockHeadersFn.mockReturnValue({
    get: (key: string) => map[key] ?? null,
    has: (key: string) => key in map,
  });
}

function mockCookies(allCookies: Array<{ name: string; value: string }>) {
  mockCookiesFn.mockReturnValue({
    getAll: () => allCookies,
  });
}

function mockSupabaseUser(userId: string | null, error: any = null) {
  if (error) {
    mockGetUser.mockResolvedValue({ data: { user: null }, error });
  } else if (userId) {
    mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  } else {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  }
}

beforeEach(() => {
  mockHeadersFn.mockReset();
  mockCookiesFn.mockReset();
  mockGetUser.mockReset();
  mockHeaders({});
  mockCookies([]);
  mockSupabaseUser(null);
});

describe("getCurrentUserId — spoofed x-user-id immunity", () => {
  it("ignores x-user-id header when no real session exists", async () => {
    mockHeaders({ "x-user-id": "spoofed-user-id" });
    mockCookies([]);
    mockSupabaseUser(null);

    await expect(getCurrentUserId()).rejects.toThrow(AppError);
    try { await getCurrentUserId(); } catch (e) {
      expect((e as AppError).status).toBe(401);
      expect((e as AppError).code).toBe("UNAUTHORIZED");
    }
  });

  it("ignores x-user-id header and uses cookie session instead", async () => {
    mockHeaders({ "x-user-id": "spoofed-user-id" });
    mockCookies([{ name: "sb-access-token", value: "real-session" }]);
    mockSupabaseUser("real-user-from-cookie");

    const userId = await getCurrentUserId();
    expect(userId).toBe("real-user-from-cookie");
  });

  it("ignores x-user-id header and uses bearer token instead", async () => {
    mockHeaders({
      "x-user-id": "spoofed-user-id",
      authorization: "Bearer real-bearer-token",
    });
    mockCookies([]);
    mockSupabaseUser("real-user-from-bearer");

    const userId = await getCurrentUserId();
    expect(userId).toBe("real-user-from-bearer");
  });

  it("ignores x-user-id even when it looks like a valid uuid", async () => {
    mockHeaders({ "x-user-id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    mockCookies([]);
    mockSupabaseUser(null);

    await expect(getCurrentUserId()).rejects.toThrow(AppError);
  });
});

describe("getCurrentUserId — identity resolution", () => {
  it("returns userId from valid cookie session", async () => {
    mockCookies([{ name: "sb-access-token", value: "valid" }]);
    mockSupabaseUser("cookie-user-1");

    const userId = await getCurrentUserId();
    expect(userId).toBe("cookie-user-1");
  });

  it("returns userId from valid bearer token", async () => {
    mockHeaders({ authorization: "Bearer valid-token" });
    mockSupabaseUser("bearer-user-1");

    const userId = await getCurrentUserId();
    expect(userId).toBe("bearer-user-1");
  });

  it("prefers bearer token over cookie", async () => {
    mockHeaders({ authorization: "Bearer bearer-token" });
    mockCookies([{ name: "sb-access-token", value: "cookie-token" }]);

    mockGetUser
      .mockResolvedValueOnce({ data: { user: { id: "bearer-user" } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: "cookie-user" } }, error: null });

    const userId = await getCurrentUserId();
    expect(userId).toBe("bearer-user");
  });

  it("throws AppError 401 when no auth method succeeds", async () => {
    mockHeaders({});
    mockCookies([]);
    mockSupabaseUser(null);

    try {
      await getCurrentUserId();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(401);
      expect((e as AppError).code).toBe("UNAUTHORIZED");
    }
  });
});

it("getCurrentUserId does NOT return user ID from x-user-id header", async () => {
  mockHeaders({ "x-user-id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  mockCookies([]);
  mockSupabaseUser(null);

  await expect(getCurrentUserId()).rejects.toThrow(AppError);
});
