// ── Shared Topic-Token Normalization ──
// One deterministic, dependency-free morphological canonicalizer for topic
// overlap. The section-grounding detector and every topic-overlap consumer
// (source relevance, claim-ownership scoring, incidental-evidence filtering)
// must agree on the SAME token space, otherwise a heading's morphological
// equivalents ("budgeting" vs "budgets") are treated as unrelated and a
// genuinely grounded section fails.
//
// Rules:
//  - deterministic only — no embeddings, model calls, fuzzy semantic matching
//    or generic suffix stripping (a stemmer would corrupt proper nouns and
//    platform names such as "Threads", "Insights", "Analytics");
//  - an explicit, auditable morphological-family map. Every family below is an
//    unambiguous inflection/derivation of one canonical base and is added
//    deliberately. Exact-token behaviour, stop-word removal and grounding
//    thresholds are unchanged for any token outside the map.

export interface MorphologicalFamily {
  canonical: string;
  forms: string[];
}

/** Auditable morphological families used by the shared topic-token
 *  normalizer. Each family maps a set of unambiguous surface forms to a single
 *  canonical base. Add new families only when every form in the family is a
 *  safe, deterministic equivalent of the canonical token. */
export const MORPHOLOGICAL_FAMILIES: MorphologicalFamily[] = [
  { canonical: "budget", forms: ["budget", "budgets", "budgeting", "budgeted", "budgetary"] },
  { canonical: "invest", forms: ["invest", "invests", "investing", "invested", "investment", "investments"] },
  { canonical: "spend", forms: ["spend", "spends", "spending", "spent"] },
  { canonical: "build", forms: ["build", "builds", "building", "built"] },
  { canonical: "plan", forms: ["plan", "plans", "planning", "planned"] },
  { canonical: "measure", forms: ["measure", "measures", "measuring", "measured", "measurement", "measurements"] },
  { canonical: "grow", forms: ["grow", "grows", "growing", "grew", "grown", "growth"] },
  { canonical: "reach", forms: ["reach", "reaches", "reaching", "reached"] },
  { canonical: "understand", forms: ["understand", "understands", "understanding", "understood"] },
];

const FORM_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  MORPHOLOGICAL_FAMILIES.flatMap((family) => family.forms.map((form) => [form, family.canonical] as const)),
);

/** Canonical morphological base of a single lowercase topic token. Tokens
 *  outside the family map are returned unchanged, preserving exact-token
 *  behaviour, stop-word removal and grounding strictness. */
export function normalizeTopicToken(token: string): string {
  const lower = token.toLowerCase();
  return FORM_TO_CANONICAL.get(lower) ?? lower;
}
