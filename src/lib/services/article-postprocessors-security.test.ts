import { describe, expect, it } from "vitest";
import {
  normalizeArticleSlug,
  pairedSlugs,
  renderLanguageSwitcher,
} from "@/lib/services/article-postprocessors";

describe("canonical slug and language-switcher safety", () => {
  it("normalizes model-produced slugs to one lowercase path segment", () => {
    expect(normalizeArticleSlug('  Hong Kong / Trends"><script>alert(1)</script>  '))
      .toBe("hong-kong-trends-script-alert-1-script");
    expect(pairedSlugs("Campaign-Guide-zh")).toEqual({
      englishSlug: "campaign-guide",
      chineseSlug: "campaign-guide-zh",
    });
  });

  it("derives both language destinations from the safe English slug", () => {
    const html = renderLanguageSwitcher({
      currentLanguage: "en",
      englishSlug: 'Safe Guide"><img src=x onerror=alert(1)>',
      chineseSlug: 'untrusted" onclick="alert(2)',
    });
    expect(html).toContain('href="/blog/safe-guide-img-src-x-onerror-alert-1-zh"');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("untrusted");
  });
});
