import { describe, it, expect } from "vitest";
import {
  englishWordTolerance,
  dynamicH2Range,
  dynamicFaqRange,
  englishTitleRange,
  chineseTitleRange,
  englishMetaRange,
  chineseMetaRange,
  englishKeyphraseDensity,
  chineseKeyphraseDensity,
  paragraphSentenceLimit,
  internalLinkRange,
  externalLinkRange,
  chineseCharRange,
  translationFaqCount,
} from "./content-standards";

// ── Word-count tolerance ──

describe("englishWordTolerance", () => {
  it("below 2000 uses ±10%", () => {
    const r = englishWordTolerance(1500);
    expect(r.min).toBe(1350);
    expect(r.max).toBe(1650);
  });

  it("at 2000 uses ±15%", () => {
    const r = englishWordTolerance(2000);
    expect(r.min).toBe(1700);
    expect(r.max).toBe(2300);
  });

  it("above 2000 uses ±15%", () => {
    const r = englishWordTolerance(2500);
    expect(r.min).toBe(2125);
    expect(r.max).toBe(2875);
  });

  it("zero target returns floor(0) to ceil(0)", () => {
    const r = englishWordTolerance(0);
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
  });
});

// ── Dynamic H2 range ──

describe("dynamicH2Range", () => {
  it("500–999 words: 3–4 H2s", () => {
    expect(dynamicH2Range(500)).toEqual({ min: 3, max: 4 });
    expect(dynamicH2Range(750)).toEqual({ min: 3, max: 4 });
    expect(dynamicH2Range(999)).toEqual({ min: 3, max: 4 });
  });

  it("1,000–1,499 words: 4–5 H2s", () => {
    expect(dynamicH2Range(1000)).toEqual({ min: 4, max: 5 });
    expect(dynamicH2Range(1250)).toEqual({ min: 4, max: 5 });
    expect(dynamicH2Range(1499)).toEqual({ min: 4, max: 5 });
  });

  it("1,500–1,999 words: 5–6 H2s", () => {
    expect(dynamicH2Range(1500)).toEqual({ min: 5, max: 6 });
    expect(dynamicH2Range(1750)).toEqual({ min: 5, max: 6 });
    expect(dynamicH2Range(1999)).toEqual({ min: 5, max: 6 });
  });

  it("2,000–2,999 words: 6–7 H2s", () => {
    expect(dynamicH2Range(2000)).toEqual({ min: 6, max: 7 });
    expect(dynamicH2Range(2500)).toEqual({ min: 6, max: 7 });
    expect(dynamicH2Range(2999)).toEqual({ min: 6, max: 7 });
  });

  it("3,000–3,999 words: 7–8 H2s", () => {
    expect(dynamicH2Range(3000)).toEqual({ min: 7, max: 8 });
    expect(dynamicH2Range(3500)).toEqual({ min: 7, max: 8 });
    expect(dynamicH2Range(3999)).toEqual({ min: 7, max: 8 });
  });

  it("4,000–5,000 words: 8–9 H2s", () => {
    expect(dynamicH2Range(4000)).toEqual({ min: 8, max: 9 });
    expect(dynamicH2Range(4500)).toEqual({ min: 8, max: 9 });
    expect(dynamicH2Range(5000)).toEqual({ min: 8, max: 9 });
  });

  it("clamps below 500 to smallest band", () => {
    expect(dynamicH2Range(0)).toEqual({ min: 3, max: 4 });
    expect(dynamicH2Range(499)).toEqual({ min: 3, max: 4 });
  });

  it("clamps above 5000 to largest band", () => {
    expect(dynamicH2Range(5001)).toEqual({ min: 8, max: 9 });
    expect(dynamicH2Range(10000)).toEqual({ min: 8, max: 9 });
  });
});

// ── Dynamic FAQ range ──

describe("dynamicFaqRange", () => {
  it("500–999 words: 2–3 FAQs", () => {
    expect(dynamicFaqRange(500)).toEqual({ min: 2, max: 3 });
    expect(dynamicFaqRange(999)).toEqual({ min: 2, max: 3 });
  });

  it("1,000–1,499 words: 3–4 FAQs", () => {
    expect(dynamicFaqRange(1000)).toEqual({ min: 3, max: 4 });
    expect(dynamicFaqRange(1499)).toEqual({ min: 3, max: 4 });
  });

  it("1,500–1,999 words: 4–5 FAQs", () => {
    expect(dynamicFaqRange(1500)).toEqual({ min: 4, max: 5 });
    expect(dynamicFaqRange(1999)).toEqual({ min: 4, max: 5 });
  });

  it("2,000–2,999 words: 4–6 FAQs", () => {
    expect(dynamicFaqRange(2000)).toEqual({ min: 4, max: 6 });
    expect(dynamicFaqRange(2500)).toEqual({ min: 4, max: 6 });
    expect(dynamicFaqRange(2999)).toEqual({ min: 4, max: 6 });
  });

  it("3,000–3,999 words: 5–6 FAQs", () => {
    expect(dynamicFaqRange(3000)).toEqual({ min: 5, max: 6 });
    expect(dynamicFaqRange(3999)).toEqual({ min: 5, max: 6 });
  });

  it("4,000–5,000 words: 5–7 FAQs", () => {
    expect(dynamicFaqRange(4000)).toEqual({ min: 5, max: 7 });
    expect(dynamicFaqRange(5000)).toEqual({ min: 5, max: 7 });
  });

  it("clamps below 500 to smallest band", () => {
    expect(dynamicFaqRange(0)).toEqual({ min: 2, max: 3 });
  });

  it("clamps above 5000 to largest band", () => {
    expect(dynamicFaqRange(5001)).toEqual({ min: 5, max: 7 });
  });
});

// ── Title ranges ──

describe("englishTitleRange", () => {
  it("returns 50–70", () => {
    expect(englishTitleRange()).toEqual({ min: 50, max: 70 });
  });
});

describe("chineseTitleRange", () => {
  it("returns 25–35", () => {
    expect(chineseTitleRange()).toEqual({ min: 25, max: 35 });
  });
});

// ── Meta ranges ──

describe("englishMetaRange", () => {
  it("returns 155–200", () => {
    expect(englishMetaRange()).toEqual({ min: 155, max: 200 });
  });
});

describe("chineseMetaRange", () => {
  it("returns 80–120", () => {
    expect(chineseMetaRange()).toEqual({ min: 80, max: 120 });
  });
});

// ── Keyphrase density ──

describe("englishKeyphraseDensity", () => {
  it("returns correct thresholds", () => {
    const d = englishKeyphraseDensity();
    expect(d.warningBelow).toBe(0.5);
    expect(d.preferredMax).toBe(1.5);
    expect(d.stuffingAbove).toBe(3);
  });
});

describe("chineseKeyphraseDensity", () => {
  it("returns the same thresholds (same policy)", () => {
    const d = chineseKeyphraseDensity();
    expect(d.warningBelow).toBe(0.5);
    expect(d.preferredMax).toBe(1.5);
    expect(d.stuffingAbove).toBe(3);
  });
});

// ── Paragraph sentence limit ──

describe("paragraphSentenceLimit", () => {
  it("returns 3", () => {
    expect(paragraphSentenceLimit()).toBe(3);
  });
});

// ── Link ranges ──

describe("internalLinkRange", () => {
  it("returns 0–4", () => {
    expect(internalLinkRange()).toEqual({ min: 0, max: 4 });
  });
});

describe("externalLinkRange", () => {
  it("returns 0–Infinity", () => {
    const r = externalLinkRange();
    expect(r.min).toBe(0);
    expect(r.max).toBe(Infinity);
  });
});

// ── Chinese character range ──

describe("chineseCharRange", () => {
  it("for 2500 English words: preferred ~4500, pass 3800–5500, hard min 3200", () => {
    const r = chineseCharRange(2500);
    expect(r.preferred).toBe(4500);
    expect(r.min).toBe(3800);
    expect(r.max).toBe(5500);
    expect(r.hardMin).toBe(3200);
  });

  it("for 1500 English words", () => {
    const r = chineseCharRange(1500);
    expect(r.preferred).toBe(2700);
    expect(r.min).toBe(2280);
    expect(r.max).toBe(3300);
    expect(r.hardMin).toBe(1920);
  });

  it("for 4000 English words", () => {
    const r = chineseCharRange(4000);
    expect(r.preferred).toBe(7200);
    expect(r.min).toBe(6080);
    expect(r.max).toBe(8800);
    expect(r.hardMin).toBe(5120);
  });

  it("zero word count returns all zeros", () => {
    const r = chineseCharRange(0);
    expect(r.preferred).toBe(0);
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.hardMin).toBe(0);
  });
});

// ── Translation FAQ count (exact preservation) ──

describe("translationFaqCount", () => {
  it("preserves source count exactly", () => {
    expect(translationFaqCount(4)).toBe(4);
    expect(translationFaqCount(5)).toBe(5);
    expect(translationFaqCount(6)).toBe(6);
    expect(translationFaqCount(0)).toBe(0);
    expect(translationFaqCount(100)).toBe(100);
  });

  it("never truncates or pads", () => {
    for (let n = 0; n <= 10; n++) {
      expect(translationFaqCount(n)).toBe(n);
    }
  });
});
