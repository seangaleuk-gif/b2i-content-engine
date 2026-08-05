import { describe, it, expect } from "vitest";
import {
  BRAND_VOICE_DEFAULT,
  BRAND_VOICE_VERSION,
  hashBrandVoice,
  isBlankBrandVoice,
  isCanonicalBrandVoice,
  resolveBrandVoice,
} from "./brand-voice";
import { DEFAULT_PROMPTS } from "./default-prompts";

describe("canonical B2I Hub Brand Voice default", () => {
  it("version is the approved stable identifier", () => {
    expect(BRAND_VOICE_VERSION).toBe("b2i-brand-voice-zh-hk-v2");
  });

  it("the approved text is the only canonical default and is used by DEFAULT_PROMPTS", () => {
    expect(DEFAULT_PROMPTS.brand_voice).toBe(BRAND_VOICE_DEFAULT);
    // Key approved content present.
    expect(BRAND_VOICE_DEFAULT).toContain("You are the voice of B2I Hub.");
    expect(BRAND_VOICE_DEFAULT).toContain("## Personality");
    expect(BRAND_VOICE_DEFAULT).toContain("## Chinese Content — Traditional Chinese for Hong Kong");
    expect(BRAND_VOICE_DEFAULT).toContain("professional conversational Hong Kong Cantonese");
    // The conflicting overly-casual instruction is gone.
    expect(BRAND_VOICE_DEFAULT).not.toContain("cha chaan teng");
    expect(BRAND_VOICE_DEFAULT).not.toContain("milk tea");
  });

  it("missing and blank values fall back to the approved default", () => {
    expect(isBlankBrandVoice(null)).toBe(true);
    expect(isBlankBrandVoice(undefined)).toBe(true);
    expect(isBlankBrandVoice("")).toBe(true);
    expect(isBlankBrandVoice("   ")).toBe(true);
    expect(isBlankBrandVoice("custom")).toBe(false);
    expect(resolveBrandVoice(null)).toBe(BRAND_VOICE_DEFAULT);
    expect(resolveBrandVoice("   ")).toBe(BRAND_VOICE_DEFAULT);
    expect(resolveBrandVoice("custom voice")).toBe("custom voice");
  });

  it("isCanonicalBrandVoice identifies the exact default", () => {
    expect(isCanonicalBrandVoice(BRAND_VOICE_DEFAULT)).toBe(true);
    expect(isCanonicalBrandVoice("custom")).toBe(false);
  });

  it("hash is stable and distinguishes values", () => {
    expect(hashBrandVoice(BRAND_VOICE_DEFAULT)).toBe(hashBrandVoice(BRAND_VOICE_DEFAULT));
    expect(hashBrandVoice("a")).not.toBe(hashBrandVoice("b"));
    expect(hashBrandVoice("a").length).toBeGreaterThan(0);
  });

  it("existing customised values are never overwritten by the fallback", () => {
    // resolveBrandVoice only returns the default for blank values; a custom value is kept.
    expect(resolveBrandVoice("my custom brand voice")).toBe("my custom brand voice");
  });
});
