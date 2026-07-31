import { describe, expect, it } from "vitest";
import { buildTranslationVersionSummary, parseTranslationVersionSummary } from "./translation-version-metadata";

describe("translation version metadata", () => {
  it("round-trips source pairing and the Chinese keyphrase without abusing excerpt", () => {
    const summary = buildTranslationVersionSummary(42, "香港Threads市場推廣");
    expect(parseTranslationVersionSummary(summary)).toEqual({
      sourceEnVersionId: 42,
      focusKeyphrase: "香港Threads市場推廣",
    });
  });

  it("parses legacy source markers", () => {
    expect(parseTranslationVersionSummary("source-en-version:42")).toEqual({
      sourceEnVersionId: 42,
      focusKeyphrase: "",
    });
  });

  it("rejects malformed metadata", () => {
    expect(parseTranslationVersionSummary("not metadata")).toBeNull();
  });
});
