import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { injectLinks } from "@/lib/services/link-injector";

const db = vi.hoisted(() => {
  const order = vi.fn();
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    order,
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: vi.fn(() => chain), chain, order };
});

vi.mock("@/db", () => ({
  getDb: () => ({ from: db.from }),
}));

beforeEach(() => {
  db.from.mockClear();
  db.chain.select.mockClear();
  db.chain.eq.mockClear();
  db.order.mockReset();
});

describe("injectLinks visible-text boundaries", () => {
  it("never injects into WordPress comments or HTML attributes", async () => {
    db.order.mockResolvedValue({
      data: [{
        display_text: "marketing",
        url_slug: "/blog/marketing-guide",
        keywords: ["marketing"],
        max_per_article: 1,
      }],
    });
    const html = '<!-- wp:paragraph --><p data-topic="marketing">A marketing plan helps local teams.</p><!-- /wp:paragraph -->';

    const result = await injectLinks(html, "user-1");

    expect(result.linksInjected).toBe(1);
    expect(result.modifiedContent).toContain('data-topic="marketing"');
    expect(result.modifiedContent).toContain(
      'A <a href="/blog/marketing-guide">marketing</a> plan',
    );
    expect(result.modifiedContent).toContain("<!-- wp:paragraph -->");
    expect(validateWordpressBlockPairs(result.modifiedContent).valid).toBe(true);
  });

  it("does not treat a WordPress block name as visible anchor text", async () => {
    db.order.mockResolvedValue({
      data: [{
        display_text: "paragraph",
        url_slug: "/blog/writing-guide",
        keywords: ["paragraph"],
        max_per_article: 1,
      }],
    });
    const html = "<!-- wp:paragraph --><p>This paragraph gives a useful example.</p><!-- /wp:paragraph -->";

    const result = await injectLinks(html, "user-1");

    expect(result.modifiedContent).toContain("<!-- wp:paragraph -->");
    expect(result.modifiedContent).toContain(
      'This <a href="/blog/writing-guide">paragraph</a> gives',
    );
    expect(validateWordpressBlockPairs(result.modifiedContent).valid).toBe(true);
  });
});
