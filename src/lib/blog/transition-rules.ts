// ── Shared Orphan-Transition and Discourse-Dependency Rules ──
// One authoritative definition of a paragraph that OPENS with an orphaned
// transition ("So, ...", "Instead, ...", "However, ...") or with an anaphoric
// discourse connector that depends on an antecedent ("That's why...", "This
// means...", "That approach..."). Used by:
//  - the coherence validator (validateCoherence) to flag orphan transitions and
//    deletion-created discourse openings;
//  - the paragraph-normalization producer (splitLongParagraphs) so a long
//    paragraph is never split at a sentence boundary whose next sentence would
//    open a chunk with an orphan transition;
//  - the factual-removal producer (removeUnsupportedSentences) so a sentence
//    removal never leaves a dependent "That's why..." / "This means..."
//    paragraph behind;
//  - the trim/compaction producers so a paragraph whose neighbour depends on it
//    is never deleted.
// Keeping the rules in one leaf module guarantees every producer and the
// authoritative scanner agree on exactly the same vocabulary.

/** A paragraph opening with one of these transition words followed by a comma
 *  or colon is contrast/summary-dependent and orphaned without a substantive
 *  antecedent. */
export const ORPHAN_TRANSITION_RE =
  /^\s*(?:instead|however|therefore|meanwhile|moreover|furthermore|nevertheless|nonetheless|consequently|additionally|likewise|similarly|hence|thus|yet|so|but|and)\s*[,:]/i;

/** Transition phrases with the same orphan dependency. */
export const ORPHAN_TRANSITION_PHRASES =
  /^\s*(?:as a result|on the other hand|that said|in addition|at the same time|for this reason|for that reason|in other words)\s*[,:]/i;

/** True when `text` opens with an orphan-transition construction. */
export function opensWithOrphanTransition(text: string): boolean {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return false;
  return ORPHAN_TRANSITION_RE.test(trimmed) || ORPHAN_TRANSITION_PHRASES.test(trimmed);
}

// ── Shared discourse-dependency rules ──
// A sentence/paragraph that OPENS with an anaphoric discourse connector
// depends on an antecedent/setup in the preceding text ("That's why...",
// "This means...", "As a result...", "That approach..."). When the antecedent
// is deleted (factual removal, trim, paragraph removal), the opener becomes a
// deletion-created discourse opening — exactly the production defect where an
// unsupported intro claim was removed and "That's why customer community
// marketing has become such a powerful way..." was left as the new first
// paragraph. These rules are the generic dependency class, not phrase patches.
//
// Two predicates are exported for two call sites with different precision
// requirements:
//  - `opensWithDiscourseDependency` (FULL) is used by DELETION PRODUCERS that
//    know an antecedent is being removed (factual removal, paragraph removal,
//    trim). Being conservative there only means a removal is skipped, so it
//    includes the demonstrative-determiner + abstraction-noun class ("That
//    approach...", "This strategy...").
//  - `opensWithStrictDiscourseDependency` (STRICT) is used by the coherence
//    SCANNER's absolute check, which cannot know whether a demonstrative noun
//    refers to prior content or to the surrounding section context. A section
//    that legitimately opens with "This approach builds trust..." must not be
//    blocked, so the strict set covers only openers that are dependent in
//    every context: resultative copula ("That's why..."), demonstrative +
//    inferential verb ("This means...") and prepositional anaphora
//    ("Given this...", "As a result of that...").

const DISCOURSE_DEMONSTRATIVES = "this|that|these|those";

/** Resultative copula + complementizer: "That's why...", "This is how...",
 *  "That's what makes...", "This is because...", "That's the reason...".
 *  The opener states a reason, method or explanation that must have been
 *  established earlier. Dependent in every context. */
const DISCOURSE_RESULTATIVE_COPULA_RE =
  /^\s*(?:that['’]?s|this['’]?s|that is|this is|these are|those are|it['’]?s|it is)\s+(?:exactly|precisely|partly|largely|why|how|what|because|the\s+(?:reason|point|answer|explanation|key|thing))\b/i;

/** Demonstrative + inferential verb: "This means...", "That shows...",
 *  "These suggest...". The demonstrative's referent is prior content.
 *  Dependent in every context. */
const DISCOURSE_DEMONSTRATIVE_VERB_RE =
  new RegExp(
    `^\\s*(?:${DISCOURSE_DEMONSTRATIVES})\\s+(?:means?|shows?|suggests?|indicates?|proves?|confirms?|reflects?|represents?|demonstrates?|implies?|reveals?|points? to)\\b`,
    "i",
  );

/** Prepositional anaphora: "Given this...", "With that in mind...",
 *  "Because of these...", "As a result of that...". The prepositional object
 *  refers to prior content. Dependent in every context. */
const DISCOURSE_PREPOSITIONAL_ANAPHORA_RE =
  new RegExp(
    `^\\s*(?:given|with|because of|as a result of|in light of|in view of|in response to|based on|following|despite|apart from|in spite of|thanks to|owing to|on the basis of)\\s+(?:${DISCOURSE_DEMONSTRATIVES}|such|the above|the following)\\b`,
    "i",
  );

/** Demonstrative determiner + anaphoric abstraction noun: "That approach...",
 *  "This strategy...", "These numbers...". The noun's referent must have been
 *  introduced earlier. Only safe to enforce in deletion producers, where a
 *  removal is being considered and a conservative skip is harmless. Self-
 *  referential nouns ("guide", "article", "section") are deliberately absent —
 *  they refer to the text itself, never to deleted content. */
const DISCOURSE_DEMONSTRATIVE_NOUN_RE =
  new RegExp(
    `^\\s*(?:${DISCOURSE_DEMONSTRATIVES})\\s+(?:approach|strategy|tactic|method|methodology|technique|framework|model|idea|concept|notion|principle|practice|finding|result|outcome|figure|number|statistic|percentage|share|rate|data|evidence|claim|argument|point|example|case|situation|scenario|problem|issue|challenge|concern|benefit|advantage|disadvantage|drawback|limitation|caveat|shift|change|move|increase|decrease|growth|decline|jump|surge|drop|rise|trend|pattern|behaviour|behavior|metric|signal|lesson|takeaway|insight|observation|conclusion|distinction|nuance|fact)\\b`,
    "i",
  );

export const DISCOURSE_DEPENDENT_OPENERS: ReadonlyArray<RegExp> = [
  DISCOURSE_RESULTATIVE_COPULA_RE,
  DISCOURSE_DEMONSTRATIVE_VERB_RE,
  DISCOURSE_PREPOSITIONAL_ANAPHORA_RE,
  DISCOURSE_DEMONSTRATIVE_NOUN_RE,
];

/** Strict subset safe for the coherence scanner's absolute check: openers that
 *  are dependent in every context, with no demonstrative-determiner + noun
 *  ambiguity. */
export const STRICT_DISCOURSE_DEPENDENT_OPENERS: ReadonlyArray<RegExp> = [
  DISCOURSE_RESULTATIVE_COPULA_RE,
  DISCOURSE_DEMONSTRATIVE_VERB_RE,
  DISCOURSE_PREPOSITIONAL_ANAPHORA_RE,
];

/** True when `text` opens with a discourse connector that depends on an
 *  antecedent/setup in the preceding text. FULL rule — used by deletion
 *  producers (factual removal, paragraph removal, trim) so they never sever an
 *  antecedent. Shared so every producer uses the same vocabulary. */
export function opensWithDiscourseDependency(text: string): boolean {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return false;
  return DISCOURSE_DEPENDENT_OPENERS.some((re) => re.test(trimmed));
}

/** True when `text` opens with a discourse connector that is dependent in
 *  EVERY context (resultative copula, demonstrative + inferential verb,
 *  prepositional anaphora). STRICT rule — used by the coherence scanner's
 *  absolute opening check, where a false positive would block a legitimate
 *  section opener. */
export function opensWithStrictDiscourseDependency(text: string): boolean {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return false;
  return STRICT_DISCOURSE_DEPENDENT_OPENERS.some((re) => re.test(trimmed));
}
