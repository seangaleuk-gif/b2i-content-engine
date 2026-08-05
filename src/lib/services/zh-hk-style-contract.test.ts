import { describe, it, expect } from "vitest";
import {
  buildZhHkStyleContract,
  TRANSLATION_BRAND_PROFILE,
  BILINGUAL_BRAND_PRINCIPLES,
  MONOLINGUAL_REGISTER_GUIDANCE,
} from "./zh-hk-style-contract";
import { BRAND_VOICE_DEFAULT, BRAND_VOICE_VERSION, hashBrandVoice } from "./brand-voice";

describe("ZhHkStyleContract", () => {
  it("blank/missing Brand Voice compiles to the canonical default and marks usedDefault", () => {
    const contract = buildZhHkStyleContract(undefined);
    expect(contract.usedDefault).toBe(true);
    expect(contract.brandVoiceVersion).toBe(BRAND_VOICE_VERSION);
    expect(contract.brandVoiceHash).toBe(hashBrandVoice(BRAND_VOICE_DEFAULT));
    expect(contract.register).toBe("professional-conversational-hk-cantonese");
    expect(contract.hardRules.length).toBeGreaterThan(0);
    expect(contract.advisoryRules.length).toBeGreaterThan(0);
    expect(contract.translationProfile.length).toBeGreaterThan(0);
    expect(contract.bilingualPrinciples.length).toBeGreaterThan(0);
    expect(contract.monolingualRegister.length).toBeGreaterThan(0);
  });

  it("a custom Brand Voice is not marked as the default and keeps its own hash", () => {
    const contract = buildZhHkStyleContract("my custom voice");
    expect(contract.usedDefault).toBe(false);
    expect(contract.brandVoiceHash).not.toBe(hashBrandVoice(BRAND_VOICE_DEFAULT));
  });

  it("translationProfile is compact and reflects the approved voice without raw English-only rules", () => {
    expect(TRANSLATION_BRAND_PROFILE).toContain("Warm and honest");
    expect(TRANSLATION_BRAND_PROFILE).toContain("professional conversational Hong Kong Cantonese");
    expect(TRANSLATION_BRAND_PROFILE).toContain("No Mandarin-style formal written Chinese");
    expect(TRANSLATION_BRAND_PROFILE).toContain("No literal English sentence structures");
    expect(TRANSLATION_BRAND_PROFILE).toContain("No excessive slang");
    // English-only forbidden-word list must not leak into Cantonese grammar.
    expect(TRANSLATION_BRAND_PROFILE).not.toContain("leverage");
  });

  it("bilingualPrinciples include compact brand principles plus source-fidelity and terminology", () => {
    expect(BILINGUAL_BRAND_PRINCIPLES).toContain("Warm and honest");
    expect(BILINGUAL_BRAND_PRINCIPLES).toContain("never change facts, numbers, URLs, brands, claims");
    expect(BILINGUAL_BRAND_PRINCIPLES).toContain("Keep approved terminology consistent");
    expect(BILINGUAL_BRAND_PRINCIPLES).toContain("Avoid unnecessary English code-switching");
  });

  it("monolingualRegister is the full approved zh-HK register guidance", () => {
    expect(MONOLINGUAL_REGISTER_GUIDANCE).toContain("professional conversational Hong Kong Cantonese");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).toContain("「你」");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).toContain("「嘅」、「喺」、「唔」、「冇」、「佢哋」");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).toContain("Mandarin-style formal written Chinese");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).toContain("Cantonese sayings may be used occasionally");
  });

  it("English-only instructions are not treated as Cantonese grammar rules", () => {
    // Contractions and the English forbidden-word list are English-only rules.
    expect(MONOLINGUAL_REGISTER_GUIDANCE).not.toContain("contractions");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).not.toContain("it’s");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).not.toContain("leverage");
  });

  it("the old conflicting register instructions no longer override the approved register", () => {
    // No 書面語-as-mandate and no overly casual cha chaan teng instruction.
    expect(MONOLINGUAL_REGISTER_GUIDANCE).not.toContain("書面語");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).not.toContain("cha chaan teng");
    expect(MONOLINGUAL_REGISTER_GUIDANCE).not.toContain("milk tea");
  });
});
