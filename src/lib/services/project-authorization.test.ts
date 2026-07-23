import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHeadersFn, mockCookiesFn, mockGetUser, mockDbSelect, mockDbEq, mockDbOrder, mockDbLimit } = vi.hoisted(() => ({
  mockHeadersFn: vi.fn(),
  mockCookiesFn: vi.fn(),
  mockGetUser: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbEq: vi.fn(),
  mockDbOrder: vi.fn(),
  mockDbLimit: vi.fn(),
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

vi.mock("@/db", () => ({
  getDb: vi.fn(() => ({
    from: vi.fn(() => ({
      select: mockDbSelect,
    })),
  })),
}));

import { resolveAuthenticatedUserId, requireProjectAccess } from "@/lib/services/project-authorization";
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

function mockDbQuery(returnData: any[] | null, error: any = null) {
  const chain: any = { eq: mockDbEq, order: mockDbOrder, limit: mockDbLimit };
  mockDbSelect.mockReturnValue(chain);
  mockDbEq.mockReturnValue(chain);
  mockDbOrder.mockReturnValue(chain);
  mockDbLimit.mockResolvedValue({ data: returnData, error });
}

beforeEach(() => {
  mockHeadersFn.mockReset();
  mockCookiesFn.mockReset();
  mockGetUser.mockReset();
  mockDbSelect.mockReset();
  mockDbEq.mockReset();
  mockDbOrder.mockReset();
  mockDbLimit.mockReset();
  mockHeaders({});
  mockCookies([]);
  mockSupabaseUser(null);
  mockDbQuery(null);
});

describe("resolveAuthenticatedUserId", () => {
  it("throws AppError 401 when no session exists", async () => {
    mockHeaders({});
    mockCookies([]);
    mockSupabaseUser(null);

    try {
      await resolveAuthenticatedUserId();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(401);
      expect((e as AppError).code).toBe("UNAUTHORIZED");
    }
  });

  it("throws AppError 401 when cookie session is invalid", async () => {
    mockHeaders({});
    mockCookies([{ name: "sb-access-token", value: "invalid" }]);
    mockSupabaseUser(null, { message: "Invalid token" });

    try {
      await resolveAuthenticatedUserId();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(401);
    }
  });

  it("throws AppError 401 when cookie session has no user", async () => {
    mockHeaders({});
    mockCookies([{ name: "sb-access-token", value: "valid-but-no-user" }]);
    mockSupabaseUser(null);

    await expect(resolveAuthenticatedUserId()).rejects.toBeInstanceOf(AppError);
  });

  it("returns userId from valid cookie session", async () => {
    mockHeaders({});
    mockCookies([{ name: "sb-access-token", value: "valid-session" }]);
    mockSupabaseUser("user-123-cookie");

    const userId = await resolveAuthenticatedUserId();
    expect(userId).toBe("user-123-cookie");
  });

  it("returns userId from valid bearer token", async () => {
    mockHeaders({ authorization: "Bearer valid-token" });
    mockCookies([]);
    mockSupabaseUser("user-456-bearer");

    const userId = await resolveAuthenticatedUserId();
    expect(userId).toBe("user-456-bearer");
  });

  it("prefers bearer token over cookie when both present", async () => {
    mockHeaders({ authorization: "Bearer valid-token" });
    mockCookies([{ name: "sb-access-token", value: "cookie-token" }]);

    mockGetUser
      .mockResolvedValueOnce({ data: { user: { id: "user-bearer" } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: "user-cookie" } }, error: null });

    const userId = await resolveAuthenticatedUserId();
    expect(userId).toBe("user-bearer");
  });
});

describe("resolveAuthenticatedUserId — spoofed x-user-id immunity", () => {
  it("ignores x-user-id header and throws AppError 401 when no valid session exists", async () => {
    mockHeaders({ "x-user-id": "spoofed-user-id" });
    mockCookies([]);
    mockSupabaseUser(null);

    try {
      await resolveAuthenticatedUserId();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(401);
    }
  });

  it("ignores x-user-id header and uses cookie session instead", async () => {
    mockHeaders({ "x-user-id": "spoofed-user-id" });
    mockCookies([{ name: "sb-access-token", value: "real-session" }]);
    mockSupabaseUser("real-user-id");

    const userId = await resolveAuthenticatedUserId();
    expect(userId).toBe("real-user-id");
    expect(userId).not.toBe("spoofed-user-id");
  });

  it("ignores x-user-id header and uses bearer token instead", async () => {
    mockHeaders({
      "x-user-id": "spoofed-user-id",
      authorization: "Bearer real-bearer-token",
    });
    mockCookies([]);
    mockSupabaseUser("real-bearer-user");

    const userId = await resolveAuthenticatedUserId();
    expect(userId).toBe("real-bearer-user");
    expect(userId).not.toBe("spoofed-user-id");
  });
});

describe("requireProjectAccess", () => {
  it("returns the project when user owns it", async () => {
    mockDbLimit.mockResolvedValue({
      data: [{ id: 42, user_id: "owner-123", name: "Test Project" }],
      error: null,
    });

    const project = await requireProjectAccess("owner-123", 42);
    expect(project).toBeDefined();
    expect((project as any).id).toBe(42);
    expect((project as any).name).toBe("Test Project");
  });

  it("throws AppError 403 when project does not exist", async () => {
    mockDbLimit.mockResolvedValue({ data: [], error: null });

    try {
      await requireProjectAccess("owner-123", 999);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(403);
      expect((e as AppError).code).toBe("FORBIDDEN");
    }
  });

  it("throws AppError 403 when project belongs to another user", async () => {
    mockDbLimit.mockResolvedValue({ data: [], error: null });

    try {
      await requireProjectAccess("owner-123", 42);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(403);
    }
  });

  it("does not leak whether project exists via error message", async () => {
    mockDbLimit.mockResolvedValue({ data: [], error: null });

    try { await requireProjectAccess("owner-123", 999); } catch (e) {
      expect((e as AppError).message).toBe("Access denied");
    }
    try { await requireProjectAccess("owner-123", 42); } catch (e) {
      expect((e as AppError).message).toBe("Access denied");
    }
  });

  it("re-throws Db errors", async () => {
    const dbError = new Error("Database connection failed");
    mockDbLimit.mockResolvedValue({ data: null, error: dbError });

    await expect(requireProjectAccess("owner-123", 42)).rejects.toThrow("Database connection failed");
    await expect(requireProjectAccess("owner-123", 42)).rejects.not.toBeInstanceOf(AppError);
  });
});
