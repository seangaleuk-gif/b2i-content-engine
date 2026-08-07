import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishBilingual } from "./wordpress";

const enHtml = "<!-- wp:paragraph --><p>English</p><!-- /wp:paragraph -->";
const zhHtml = "<!-- wp:paragraph --><p>中文</p><!-- /wp:paragraph -->";

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_WP_SITE_URL = "https://example.test";
  process.env.WP_USERNAME = "editor";
  process.env.WP_APP_PASSWORD = "app-password";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_WP_SITE_URL;
  delete process.env.WP_USERNAME;
  delete process.env.WP_APP_PASSWORD;
});

describe("bilingual WordPress transaction", () => {
  it("verifies both drafts before publishing either post", async () => {
    const states = new Map<number, "draft" | "publish">();
    const contents = new Map<number, string>();
    let nextId = 1;
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, method, body });
      if (url.endsWith("/posts") && method === "POST") {
        const id = nextId++;
        states.set(id, "draft");
        contents.set(id, String(body?.content || ""));
        return response({ id, link: `https://example.test/post-${id}` });
      }
      const match = url.match(/\/posts\/(\d+)/);
      const id = Number(match?.[1]);
      if (method === "GET") {
        return response({ id, link: `https://example.test/post-${id}`, status: states.get(id), content: { raw: contents.get(id) } });
      }
      if (method === "POST") {
        states.set(id, String(body?.status) as "draft" | "publish");
        return response({ id, link: `https://example.test/post-${id}`, status: states.get(id) });
      }
      return response({}, 404);
    }));

    const result = await publishBilingual(
      "English", enHtml, "english", [], [], "English", "Meta", "keyword",
      "中文", zhHtml, "english-zh", [], [], "中文", "摘要", "關鍵字", "publish",
    );
    expect(result.en.id).toBe(1);
    expect(result.zh.id).toBe(2);
    const firstPublish = calls.findIndex((call) => call.body?.status === "publish");
    const secondDraftRead = calls.findIndex((call) => call.url.includes("/posts/2?context=edit"));
    expect(firstPublish).toBeGreaterThan(secondDraftRead);
    expect(states.get(1)).toBe("publish");
    expect(states.get(2)).toBe("publish");
  });

  it("compensates the English draft if Chinese creation fails", async () => {
    let creates = 0;
    const deleted: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/posts") && method === "POST") {
        creates++;
        return creates === 1
          ? response({ id: 10, link: "https://example.test/en" })
          : response("Chinese create failed", 500);
      }
      if (url.includes("/posts/10?context=edit") && method === "GET") {
        return response({ id: 10, link: "https://example.test/en", status: "draft", content: { raw: enHtml } });
      }
      if (url.includes("/posts/10?force=true") && method === "DELETE") {
        deleted.push(10);
        return response({ deleted: true });
      }
      return response({}, 404);
    }));

    await expect(publishBilingual(
      "English", enHtml, "english", [], [], "English", "Meta", "keyword",
      "中文", zhHtml, "english-zh", [], [], "中文", "摘要", "關鍵字", "publish",
    )).rejects.toBeTruthy();
    expect(deleted).toEqual([10]);
  });
});
