// ── Canonical content standards ──
// Single source of truth for all structural and quality thresholds.
// Not yet integrated — generation, translation and SEO still read their own constants.

// ── English word-count tolerance ──

export function englishWordTolerance(target: number): { min: number; max: number } {
  const tolerance = target >= 2000 ? 0.15 : 0.10;
  return {
    min: Math.floor(target * (1 - tolerance)),
    max: Math.round(target * (1 + tolerance)),
  };
}

// ── Dynamic heading / FAQ counts by word-count band ──

interface Band {
  minWords: number;
  maxWords: number;
  h2Min: number;
  h2Max: number;
  faqMin: number;
  faqMax: number;
}

const BANDS: Band[] = [
  { minWords: 500, maxWords: 999, h2Min: 3, h2Max: 4, faqMin: 2, faqMax: 3 },
  { minWords: 1000, maxWords: 1499, h2Min: 4, h2Max: 5, faqMin: 3, faqMax: 4 },
  { minWords: 1500, maxWords: 1999, h2Min: 5, h2Max: 6, faqMin: 4, faqMax: 5 },
  { minWords: 2000, maxWords: 2999, h2Min: 6, h2Max: 7, faqMin: 4, faqMax: 6 },
  { minWords: 3000, maxWords: 3999, h2Min: 7, h2Max: 8, faqMin: 5, faqMax: 6 },
  { minWords: 4000, maxWords: 5000, h2Min: 8, h2Max: 9, faqMin: 5, faqMax: 7 },
];

function bandForWordCount(wordCount: number): Band {
  for (const b of BANDS) {
    if (wordCount >= b.minWords && wordCount <= b.maxWords) return b;
  }
  if (wordCount < 500) return BANDS[0];
  return BANDS[BANDS.length - 1];
}

export function dynamicH2Range(wordCount: number): { min: number; max: number } {
  const b = bandForWordCount(wordCount);
  return { min: b.h2Min, max: b.h2Max };
}

export function dynamicFaqRange(wordCount: number): { min: number; max: number } {
  const b = bandForWordCount(wordCount);
  return { min: b.faqMin, max: b.faqMax };
}

// ── Title length ranges ──

export function englishTitleRange(): { min: number; max: number } {
  return { min: 50, max: 70 };
}

export function chineseTitleRange(): { min: number; max: number } {
  return { min: 25, max: 35 };
}

// ── Meta-description length ranges ──

export function englishMetaRange(): { min: number; max: number } {
  return { min: 155, max: 200 };
}

export function chineseMetaRange(): { min: number; max: number } {
  return { min: 80, max: 120 };
}

// ── Keyphrase density thresholds (article-wide) ──

export const KP_DENSITY_WARNING = 0.5;
export const KP_DENSITY_PREFERRED = 1.5;
export const KP_DENSITY_STUFFING = 3;

export function englishKeyphraseDensity(): { warningBelow: number; preferredMax: number; stuffingAbove: number } {
  return { warningBelow: KP_DENSITY_WARNING, preferredMax: KP_DENSITY_PREFERRED, stuffingAbove: KP_DENSITY_STUFFING };
}

export function chineseKeyphraseDensity(): { warningBelow: number; preferredMax: number; stuffingAbove: number } {
  return { warningBelow: KP_DENSITY_WARNING, preferredMax: KP_DENSITY_PREFERRED, stuffingAbove: KP_DENSITY_STUFFING };
}

// ── Paragraph sentence limit ──

export function paragraphSentenceLimit(): number {
  return 3;
}

// ── Internal / external link ranges ──

export function internalLinkRange(): { min: number; max: number } {
  return { min: 0, max: 4 };
}

export function externalLinkRange(): { min: number; max: number } {
  return { min: 0, max: Infinity };
}

// ── Chinese character range from paired English word count ──

export interface ChineseCharRange {
  min: number;
  max: number;
  preferred: number;
  hardMin: number;
}

export function chineseCharRange(englishWordCount: number): ChineseCharRange {
  const r = { pref: 1.80, min: 1.52, max: 2.20, hardMin: 1.28 };
  return {
    min: Math.round(englishWordCount * r.min),
    max: Math.round(englishWordCount * r.max),
    preferred: Math.round(englishWordCount * r.pref),
    hardMin: Math.round(englishWordCount * r.hardMin),
  };
}

// ── Translation FAQ count: exactly preserve the English source count ──

export function translationFaqCount(sourceFaqCount: number): number {
  return sourceFaqCount;
}

// ── Keyphrase density computation helpers ──

/** Count content-bearing words in a keyphrase (excludes stop words). */
export function getKeyphraseContentWordCount(keyphrase: string): number {
  const stopWords = new Set([
    "the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or",
    "is", "are", "was", "were", "be", "been", "being", "it", "its",
    "with", "by", "from", "as", "into", "than", "that", "this", "but",
    "not", "so", "if", "can", "will", "may", "would", "could", "should",
  ]);
  const words = keyphrase.toLowerCase().split(/\s+/);
  const content = words.filter((w) => !stopWords.has(w));
  return content.length > 0 ? content.length : words.length;
}

/** Compute weighted keyphrase density:
 *  density = (occurrences * kpContentWords / articleWords) * 100 */
export function computeKeyphraseDensity(
  occurrences: number,
  keyphrase: string,
  articleWordCount: number,
): number {
  if (articleWordCount <= 0) return 0;
  const kpWords = getKeyphraseContentWordCount(keyphrase);
  return (occurrences * kpWords / articleWordCount) * 100;
}

/** Compute keyphrase occurrence targets from article word count and keyphrase.
 *  Returns preferred, max, and min occurrences based on density targets. */
export function computeKeyphraseTargets(
  articleWordCount: number,
  keyphrase: string,
): { preferred: number; max: number; min: number } {
  if (articleWordCount <= 0 || !keyphrase) return { preferred: 0, max: 0, min: 0 };
  const kpWords = getKeyphraseContentWordCount(keyphrase);
  const preferred = Math.max(1, Math.round((KP_DENSITY_PREFERRED / 100) * articleWordCount / kpWords));
  const max = Math.max(preferred + 1, Math.round((KP_DENSITY_STUFFING / 100) * articleWordCount / kpWords));
  const min = Math.max(1, Math.round((KP_DENSITY_WARNING / 100) * articleWordCount / kpWords));
  return { preferred, max, min };
}
