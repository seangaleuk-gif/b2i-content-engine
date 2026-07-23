import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbSelect, mockDbEq, mockDbOrder, mockDbLimit } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbEq: vi.fn(),
  mockDbOrder: vi.fn(),
  mockDbLimit: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: vi.fn(() => ({
    from: vi.fn(() => ({
      select: mockDbSelect,
    })),
  })),
}));

import { requireProjectAccess } from "@/lib/services/project-authorization";
import { AppError } from "@/lib/services/errors";

function mockDbQuery(returnData: any[] | null, error: any = null) {
  const chain: any = { eq: mockDbEq, order: mockDbOrder, limit: mockDbLimit };
  mockDbSelect.mockReturnValue(chain);
  mockDbEq.mockReturnValue(chain);
  mockDbOrder.mockReturnValue(chain);
  mockDbLimit.mockResolvedValue({ data: returnData, error });
}

beforeEach(() => {
  mockDbSelect.mockReset();
  mockDbEq.mockReset();
  mockDbOrder.mockReset();
  mockDbLimit.mockReset();
  mockDbQuery(null);
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
