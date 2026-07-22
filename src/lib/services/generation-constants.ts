export const SEO_TITLE_MIN = 50;
export const SEO_TITLE_MAX = 70;
export const META_MIN = 155;
export const META_MAX = 200;
export const FLESCH_MIN = 60;
export const FLESCH_MAX = 70;
export const DEFAULT_WORD_COUNT = 2500;

/** Internal generation buffer — sections are asked to generate more than the target
 *  so that the assembled article is more likely to hit the minimum. */
export const GENERATION_WORD_BUFFER = 1.18;

/** Maximum section expansions before giving up on hitting minimum */
export const MAX_SECTION_EXPANSIONS = 3;

/** Maximum section trims before giving up on hitting maximum */
export const MAX_SECTION_TRIMS = 2;

/** Word-count tolerance: article accepted between 95%-110% of target */
export function wordCountRange(target: number): { min: number; max: number } {
  return {
    min: Math.floor(target * 0.95),
    max: Math.ceil(target * 1.10),
  };
}

export const WORD_ALLOCATION = {
  INTRO: 0.08,
  CONCLUSION: 0.06,
  FAQ: 0.10,
} as const;

// ── Keyphrase occurrence range — dynamic, word-count-aware ──
// This replaces the old clamped keyphraseTarget() behavior with ranges
// that scale naturally with article length.

/** Legacy exports — kept for compatibility. Consumers should prefer keyphraseRangeForWordCount */
export const KEYPHRASE_MIN = 3;
export const KEYPHRASE_MAX = 5;

export interface KeyphraseRange {
  min: number;
  max: number;
}

export function keyphraseRangeForWordCount(wordCount: number): KeyphraseRange {
  if (wordCount <= 800)    return { min: 3, max: 5 };
  if (wordCount <= 1200)   return { min: 4, max: 7 };
  if (wordCount <= 1800)   return { min: 6, max: 10 };
  if (wordCount <= 2500)   return { min: 8, max: 15 };
  if (wordCount <= 3500)   return { min: 10, max: 20 };
  return { min: 12, max: 25 };
}

export function keyphraseTarget(wordCount: number): number {
  return keyphrasePreferredTarget(wordCount);
}

export function keyphrasePreferredTarget(wordCount: number): number {
  const { min, max } = keyphraseRangeForWordCount(wordCount);
  return Math.round((min + max) / 2);
}

// ── Per-component keyphrase budgets ──

export interface KeyphraseBudget {
  min: number;
  max: number;
  preferred: number;
}

export interface ComponentKeyphraseBudget {
  componentId: string;
  componentType: "introduction" | "main-section" | "mistakes" | "faq" | "conclusion";
  min: number;
  max: number;
  preferred: number;
  containsDesignatedKeyphraseH2?: boolean;
}

export function allocateComponentKeyphraseBudgets(input: {
  articleBudget: KeyphraseBudget;
  components: Array<{
    id: string;
    type: ComponentKeyphraseBudget["componentType"];
    plannedWordCount: number;
    containsDesignatedKeyphraseH2?: boolean;
  }>;
}): ComponentKeyphraseBudget[] {
  const { articleBudget } = input;
  let remaining = articleBudget.preferred;
  const results: ComponentKeyphraseBudget[] = [];
  const phaseLogs: string[] = [];

  function prefSum() { return results.reduce((s, r) => s + r.preferred, 0); }
  function eligible() { return results.filter((r) => r.preferred < r.max); }

  // Phase 1: Assign required placements
  for (const c of input.components) {
    let preferred = 0;
    let max = 0;
    let min = 0;

    if (c.type === "introduction") {
      preferred = Math.min(2, remaining);
      max = 2; min = 1;
    } else if (c.containsDesignatedKeyphraseH2) {
      preferred = Math.min(2, remaining);
      max = 2; min = 1;
    } else if (c.type === "faq" || c.type === "conclusion") {
      preferred = remaining > 2 ? 1 : 0;
      max = 1; min = 0;
    } else if (c.type === "mistakes") {
      preferred = remaining > 2 ? 1 : 0;
      max = 1; min = 0;
    }

    remaining -= preferred;
    results.push({ componentId: c.id, componentType: c.type, min, max, preferred, containsDesignatedKeyphraseH2: c.containsDesignatedKeyphraseH2 });
  }
  phaseLogs.push(`phase=1 assigned=${prefSum()} remaining=${remaining}`);

  // Phase 2: Distribute remaining to main sections with 0
  if (remaining > 0) {
    const zeroSections = results.filter((r) => r.componentType === "main-section" && r.preferred === 0);
    for (const s of zeroSections) {
      if (remaining <= 0) break;
      s.preferred = 1;
      s.max = 1;
      remaining--;
    }
    phaseLogs.push(`phase=2 assigned=${prefSum()} remaining=${remaining} zeroCount=${zeroSections.length}`);
  }

  // Phase 3: Upgrade main-section maxes from 1 to 2
  if (remaining > 0) {
    const upgradeable = results.filter((r) => r.componentType === "main-section" && r.max < 2);
    phaseLogs.push(`phase=3 eligible=${upgradeable.length} capacity=${upgradeable.length}`);
    for (const s of upgradeable) {
      if (remaining <= 0) break;
      s.max = 2;
      s.preferred++;
      remaining--;
    }
    phaseLogs.push(`phase=3 after assigned=${prefSum()} remaining=${remaining}`);
  }

  // Phase 4: Distribute remaining to any component with capacity, prioritized
  if (remaining > 0) {
    const ordering = new Map<string, number>([
      ["introduction", 0], ["main-section", 1], ["mistakes", 2], ["conclusion", 3], ["faq", 4],
    ]);
    const sorted = eligible()
      .sort((a, b) => {
        if (a.containsDesignatedKeyphraseH2 && !b.containsDesignatedKeyphraseH2) return -1;
        if (!a.containsDesignatedKeyphraseH2 && b.containsDesignatedKeyphraseH2) return 1;
        const pa = ordering.get(a.componentType) ?? 5;
        const pb = ordering.get(b.componentType) ?? 5;
        if (pa !== pb) return pa - pb;
        return a.componentId.localeCompare(b.componentId);
      });
    const avail = sorted.reduce((s, r) => s + (r.max - r.preferred), 0);
    phaseLogs.push(`phase=4 before=${prefSum()} remaining=${remaining} eligible=${sorted.length} avail=${avail}`);
    for (const s of sorted) {
      if (remaining <= 0) break;
      s.preferred++;
      remaining--;
    }
    phaseLogs.push(`phase=4 after=${prefSum()} remaining=${remaining}`);
  }

  // ── Invariants ──
  const preferredTotal = prefSum();
  const totalCapacity = results.reduce((s, r) => s + r.max, 0);
  const expectedPreferred = Math.min(articleBudget.preferred, totalCapacity);

  console.log(`[KP-ALLOC] total preferred=${preferredTotal} max=${totalCapacity} expected=${expectedPreferred}`);
  for (const l of phaseLogs) console.log(`[KP-ALLOC] ${l}`);

  if (preferredTotal !== expectedPreferred) {
    throw new Error(
      `Keyphrase allocation failed: expected preferred=${expectedPreferred}, got=${preferredTotal}, capacity=${totalCapacity}, articlePreferred=${articleBudget.preferred}`
    );
  }

  if (totalCapacity >= articleBudget.min && preferredTotal < articleBudget.min) {
    throw new Error(
      `Keyphrase allocation below minimum: min=${articleBudget.min}, got=${preferredTotal}, capacity=${totalCapacity}`
    );
  }

  for (const r of results) {
    if (r.min < 0 || r.preferred < r.min || r.preferred > r.max) {
      throw new Error(`Invalid budget for ${r.componentId}: min=${r.min} pref=${r.preferred} max=${r.max}`);
    }
  }

  return results;
}

export function buildComponentBudgetPrompt(budget: ComponentKeyphraseBudget, focusKeyphrase: string): string {
  const parts: string[] = [];
  parts.push(`\n\nEXACT KEYPHRASE BUDGET FOR THIS COMPONENT`);
  parts.push(`\nExact keyphrase: "${focusKeyphrase}"`);
  parts.push(`\nPreferred occurrences in this component: ${budget.preferred}`);
  parts.push(`\nMaximum allowed occurrences in this component: ${budget.max}`);
  parts.push(`\n\nThis is a local component budget, not the article-wide SEO target.`);
  parts.push(`\nDo not attempt to satisfy the complete article's keyphrase target inside this component.`);
  parts.push(`\nTreat the exact phrase as a limited resource.`);
  parts.push(`\nUse semantic variations, shortened references, pronouns, and natural topic references instead.`);
  parts.push(`\nDo not use the exact phrase more than once in the same paragraph.`);
  parts.push(`\nDo not force the phrase into unnatural sentences.`);

  if (budget.max === 0) {
    parts.push(`\nDo not use the exact keyphrase anywhere in this component.`);
  }

  if (budget.containsDesignatedKeyphraseH2) {
    parts.push(`\n\nThis component contains the designated keyphrase H2.`);
    parts.push(`\nThe heading already satisfies one required placement.`);
    parts.push(`\nDo not repeatedly restate the exact phrase in the body.`);
  }

  return parts.join("\n");
}

// ── Content validation thresholds ──

export const CONTENT_MIN_SECTION_WORDS = 80;
export const CONTENT_DUPLICATE_SIMILARITY = 0.85;
export const CONTENT_HEADING_DRIFT_MIN_OVERLAP = 0.15;
export const CONTENT_MIN_BODY_PARAGRAPHS = 2;

// ── Paragraph limits ──
export const MAX_SENTENCES_PER_PARAGRAPH = 3;

// ── Article density targets ──
export const ARTICLE_DENSITY_MIN_PERCENT = 0.5;
export const ARTICLE_DENSITY_MAX_PERCENT = 2.0;
export const SECTION_OVERUSE_THRESHOLD = 3;
export const SECTION_OVERUSE_WORD_LIMIT = 500;

// ── External link counts ──
export const EXTERNAL_LINKS_MIN = 2;
export const EXTERNAL_LINKS_MAX = 3;

// ── B2I-owned domains (not counted as external authoritative sources) ──
export const B2I_DOMAINS = ["b2ihub.com", "app.b2ihub.com"];
