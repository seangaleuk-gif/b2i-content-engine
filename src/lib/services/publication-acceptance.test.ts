import { describe, expect, it } from "vitest";
import type { BlogVersion } from "@/db/schema/blog-versions";
import { buildTranslationVersionSummary } from "./translation-version-metadata";
import { selectBilingualVersionPair } from "./publication-acceptance";

function version(id: number, slug: string, summary: string | null = null): BlogVersion {
  return {
    id, projectId: 1, userId: "u", versionNumber: id, title: slug, slug,
    metaDescription: "meta", excerpt: "excerpt", blog: "<p>content</p>", faq: [],
    internalLinks: [], externalLinks: [], categories: [], tags: [], readingTime: null,
    wordCount: 1000, summary, model: null, promptVersion: null, generationTimeMs: null,
    tokenUsage: null, status: "draft", createdAt: new Date(0),
  };
}

describe("publication bilingual snapshot selection", () => {
  it("uses the source version ID stored in translation metadata", () => {
    const olderEn = version(10, "guide");
    const newerUnpairedEn = version(12, "guide-new");
    const zh = version(11, "guide-zh", buildTranslationVersionSummary(10, "香港創作者市場推廣"));
    const pair = selectBilingualVersionPair([newerUnpairedEn, zh, olderEn]);
    expect(pair?.en.id).toBe(10);
    expect(pair?.zh.id).toBe(11);
    expect(pair?.zhFocusKeyphrase).toBe("香港創作者市場推廣");
  });

  it("rejects an independently latest Chinese row without a source pair", () => {
    const en = version(10, "guide");
    const orphanZh = version(20, "guide-zh", buildTranslationVersionSummary(999, "關鍵字"));
    expect(selectBilingualVersionPair([orphanZh, en])).toBeNull();
  });
});
