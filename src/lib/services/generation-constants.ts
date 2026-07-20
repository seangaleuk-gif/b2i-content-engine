export const SEO_TITLE_MIN = 50;
export const SEO_TITLE_MAX = 70;
export const META_MIN = 155;
export const META_MAX = 200;
export const KEYPHRASE_MIN = 3;
export const KEYPHRASE_MAX = 5;
export const FLESCH_MIN = 60;
export const FLESCH_MAX = 70;
export const DEFAULT_WORD_COUNT = 2500;

export const WORD_ALLOCATION = {
  INTRO: 0.08,
  CONCLUSION: 0.06,
  FAQ: 0.10,
} as const;

export function keyphraseTarget(wordCount: number): number {
  return Math.max(KEYPHRASE_MIN, Math.min(KEYPHRASE_MAX, Math.round(wordCount / 550)));
}
