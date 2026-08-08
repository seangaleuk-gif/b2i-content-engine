import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  deleteVersion: vi.fn(),
}));

vi.mock("@/lib/services/auth", () => ({ getCurrentUserId: vi.fn(async () => "user-1") }));
vi.mock("@/lib/services/project-authorization", () => ({
  requireProjectAccess: vi.fn(async () => ({ id: 1, userId: "user-1" })),
}));
vi.mock("@/lib/repositories", () => ({
  blogVersionRepository: {
    findById: mocks.findById,
    delete: mocks.deleteVersion,
    findByProject: vi.fn(async () => []),
  },
}));

import { DELETE } from "@/app/api/projects/[id]/versions/route";

describe("version deletion authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not delete a version owned by another project", async () => {
    mocks.findById.mockResolvedValue({ id: 99, projectId: 2, userId: "user-1" });
    const response = await DELETE(new Request("http://localhost/api/projects/1/versions", {
      method: "DELETE",
      body: JSON.stringify({ versionId: 99 }),
    }), { params: Promise.resolve({ id: "1" }) });

    expect(response.status).toBe(404);
    expect(mocks.deleteVersion).not.toHaveBeenCalled();
  });

  it("does not delete a version owned by another user", async () => {
    mocks.findById.mockResolvedValue({ id: 99, projectId: 1, userId: "user-2" });
    const response = await DELETE(new Request("http://localhost/api/projects/1/versions", {
      method: "DELETE",
      body: JSON.stringify({ versionId: 99 }),
    }), { params: Promise.resolve({ id: "1" }) });

    expect(response.status).toBe(404);
    expect(mocks.deleteVersion).not.toHaveBeenCalled();
  });

  it("deletes only the version matching both route project and current user", async () => {
    mocks.findById.mockResolvedValue({ id: 99, projectId: 1, userId: "user-1" });
    const response = await DELETE(new Request("http://localhost/api/projects/1/versions", {
      method: "DELETE",
      body: JSON.stringify({ versionId: 99 }),
    }), { params: Promise.resolve({ id: "1" }) });

    expect(response.status).toBe(200);
    expect(mocks.deleteVersion).toHaveBeenCalledWith(99);
  });
});
