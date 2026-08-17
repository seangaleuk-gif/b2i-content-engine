// ── Stage 3D/3E: clause-aware experimental sentence-completeness classifier ──
// EXPERIMENTAL. Combines: authoritative B2I deterministic hard evidence
// (malformed/structural), Compromise contextual POS evidence, and conservative
// clause-shape guards. It can rescind a B2I `no-finite-predicate` finding when
// Compromise finds a genuine main-clause finite predicate, AND it can REJECT a
// B2I-valid sentence when clause evidence proves it is only a subordinate
// clause or a bare noun phrase. It never overrides structural corruption.
//
// Shadow-observational only (Stage 3E): the authoritative verdict is passed in
// as `analysis` so the classifier NEVER re-invokes the authoritative analyzer
// (recursion protection). Compromise is loaded lazily so merely importing this
// module — and therefore merely importing the authoritative sentence-completeness
// leaf — never pays the POS-tagging/loading cost when the debug flag is off.
// It has no authority over any production decision.

import {
  isSourceCitationText,
  type SentenceCompletenessAnalysis,
  type SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";
import { isAuthoritativePunctuationOnlyResidue } from "@/lib/blog/sentence-quality";
import { createRequire } from "module";
const requireCjs = createRequire(import.meta.url);

type CompromiseNlp = (text: string) => {
  out(format: "json"): Array<{ text: string; terms: Array<{ text: string; tags: string[]; post: string }> }>;
};

let nlpInstance: CompromiseNlp | undefined;

/** Lazy Compromise singleton: the classifier module can be imported (and the
 *  authoritative leaf imported through it) without initializing Compromise
 *  until the first actual POS-tagging call. */
function getNlp(): CompromiseNlp {
  if (!nlpInstance) {
    nlpInstance = requireCjs("compromise") as unknown as CompromiseNlp;
  }
  return nlpInstance;
}

// Bounded tokenization cache: the same prose block is re-analyzed many times
// across pipeline stages under the debug flag. Compromise tagging is the only
// significant shadow cost, and its output is deterministic for a given text,
// so caching identical texts removes the repeated POS work while keeping the
// classifier verdict computation exact. The cache only ever fills when the
// debug flag is on (compromiseTokens is never called otherwise).
const TOKEN_CACHE_MAX = 2000;
const tokenCache = new Map<string, PosToken[]>();

/** Exact-text cache key: identical pipeline block texts (byte-identical on
 *  repeat analysis) reuse their tag set; whitespace-variant texts are never
 *  conflated. */
function cacheKey(text: string): string {
  return text;
}

function rememberTokens(key: string, tokens: PosToken[]): void {
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(key, tokens);
}

// ── Token model ──

export interface PosToken {
  word: string;
  isVerbFinite: boolean;
  isNoun: boolean;
  isPronoun: boolean;
  isDeterminer: boolean;
  isAdjective: boolean;
  isExpression: boolean;
  isGerund: boolean;
  isComma: boolean;
}

export function compromiseTokens(text: string): PosToken[] {
  const key = cacheKey(text);
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const terms = getNlp()(text).out("json")[0]?.terms ?? [];
  const tokens = terms.map((term) => {
    const tags = term.tags;
    return {
      word: term.text.toLowerCase(),
      isVerbFinite: tags.includes("Verb")
        && !tags.includes("Gerund")
        && (tags.includes("PresentTense") || tags.includes("PastTense") || tags.includes("Modal") || tags.includes("Auxiliary")),
      isNoun: tags.includes("Noun") && !tags.includes("Pronoun"),
      isPronoun: tags.includes("Pronoun"),
      isDeterminer: tags.includes("Determiner") || tags.includes("Possessive") && tags.includes("Pronoun"),
      isAdjective: tags.includes("Adjective"),
      isExpression: tags.includes("Expression"),
      isGerund: tags.includes("Gerund"),
      isComma: term.post.includes(","),
    };
  });
  rememberTokens(key, tokens);
  return tokens;
}

// ── Clause-shape guard constants ──

const SUBORDINATORS = new Set([
  "when", "if", "because", "although", "though", "since", "unless", "until",
  "while", "after", "before", "as", "whereas", "once", "whenever", "even if",
  "even though", "now that",
]);
const WH_WORDS = new Set(["who", "what", "which", "whose", "where", "when", "why", "how", "whom"]);
const DETERMINER_WORDS = new Set(["a", "an", "the", "this", "that", "these", "those", "my", "our", "your", "their", "his", "her", "its", "another", "each", "every"]);
const POSSESSIVE_PRONOUNS = new Set(["your", "our", "their", "my", "his", "her", "its"]);
const INVERSION_AUX = new Set([
  "do", "does", "did", "is", "are", "was", "were", "has", "have", "had",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
]);

/** A 3rd-person-singular "-s" verb candidate whose surroundings mark it as a
 *  plural-noun head misparse: [adjective] [singular noun] [3sg -s verb] [prep].
 *  Example: "Better repeat plans for the season." / "Digital marketing plans
 *  for the season." read "plans" as a verb, but the shape is a noun phrase.
 *  Positive controls: those two sentences. Negative controls: "Customers plan
 *  their visits.", "The plan works for everyone.", "Better service wins.",
 *  "Digital marketing plans the campaign." (all pass because they lack the
 *  shape: plural subject / determiner-led subject / no trailing preposition /
 *  determiner-led object). */
function isThreeSingularMisparse(tokens: PosToken[], index: number): boolean {
  const token = tokens[index];
  if (!/s$/i.test(token.word)) return false; // must be a 3rd-person -s form
  const prev = tokens[index - 1];
  const prevPrev = tokens[index - 2];
  const next = tokens[index + 1];
  if (!prev || !prev.isNoun) return false; // singular noun subject
  if (prevPrev && !prevPrev.isAdjective) return false; // adjective immediately before the subject
  // A determiner-led object or a comma means this is a real verb+object
  // ("plans the campaign", "keeps the work steady") — not a misparse. A
  // trailing preposition/nothing is the plural-noun-head misparse signature
  // ("plans for the season", "offers for members").
  if (next && (next.isDeterminer || next.isComma)) return false;
  return true;
}

/** A bare noun-phrase / modifier fragment: at least two content tokens that are
 *  all nouns or adjectives, with no determiner, pronoun, expression or verb
 *  ("Walk-ins welcome." → noun+noun). Short elliptical responses that contain
 *  an adverb, expression or determiner ("Yes, daily.", "Once a month.") are
 *  NOT bare noun phrases and are deferred to the existing short-utterance
 *  threshold. */
function isBareNounPhrase(tokens: PosToken[]): boolean {
  if (tokens.length < 2) return false;
  if (tokens.some((token) => token.isDeterminer || token.isPronoun || token.isExpression || token.isVerbFinite)) return false;
  return tokens.every((token) =>
    token.isComma || token.isNoun || token.isAdjective,
  ) && tokens.some((token) => token.isNoun || token.isAdjective);
}

// ── Real-predicate evaluation ──

/** True when a clause (a token slice) contains a genuine finite predicate:
 *  a subject before it, an imperative (clause-initial verb), or a main clause
 *  after a comma boundary. The "-s" misparse guard applies. Compromise tags
 *  noun modifiers as nouns, so a verb directly before a noun is treated as a
 *  genuine verb+object rather than a premodifier. */
export function hasRealPredicate(tokens: PosToken[]): boolean {
  const predicates = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.isVerbFinite)
    .filter(({ index }) => !isThreeSingularMisparse(tokens, index))
    .map(({ index }) => index);
  if (predicates.length === 0) return false;
  return predicates.some((index) => {
    const before = tokens.slice(0, index);
    // A subject may be a noun, a pronoun, or a gerund subject ("Cooking well
    // takes practice." — "cooking" is a gerund acting as the subject).
    const hasSubject = before.some((token) => token.isNoun || token.isPronoun || token.isGerund);
    const clauseInitial = index === 0 || tokens[index - 1]?.isComma
      || before.filter((token) => !token.isComma).length === 0;
    return hasSubject || clauseInitial;
  });
}

/** Short elliptical utterances (≤ 3 tokens) with terminal punctuation: "Yes.",
 *  "Daily.", "Yes, daily.", "Twice a week." are valid responses — defer to the
 *  existing threshold. A bare noun-phrase fragment ("Walk-ins welcome.") is
 *  not. */
function shortUtteranceVerdict(tokens: PosToken[], text: string, analysis: { complete: boolean }): boolean {
  if (isAuthoritativePunctuationOnlyResidue(text)) return false;
  if (isBareNounPhrase(tokens)) return false;
  return analysis.complete;
}

// ── Main experimental verdict ──

export interface ClauseAwareVerdictResult {
  complete: boolean;
  /** Short machine-readable category for the decision branch that produced the
   *  verdict, used only in shadow disagreement logs. */
  reason: string;
}

/** Clause-aware experimental verdict over the same (text, kind) unit the
 *  authoritative analyzer judged. `analysis` MUST be the authoritative
 *  `analyzeSentenceCompleteness(text, kind)` result — passing it in (instead of
 *  re-invoking the analyzer here) is what prevents recursive shadow execution. */
export function clauseAwareVerdict(
  text: string,
  kind: SentenceCompletenessKind,
  analysis: SentenceCompletenessAnalysis,
): ClauseAwareVerdictResult {
  // Structural kinds (headings, list items, table cells) and source citations
  // keep the authoritative structural semantics — no predicate required.
  if (kind !== "paragraph" && kind !== "quote" && kind !== "faq-answer") {
    return { complete: analysis.complete, reason: "structural-kind" };
  }
  if (isSourceCitationText(text)) return { complete: analysis.complete, reason: "source-citation" };

  // Authoritative hard evidence that POS must NEVER override.
  const hardIssues = analysis.issues.filter((issue) => issue.code !== "no-finite-predicate");
  if (hardIssues.length > 0) return { complete: false, reason: "hard-evidence" };
  if (isAuthoritativePunctuationOnlyResidue(text)) return { complete: false, reason: "punctuation-residue" };

  const tokens = compromiseTokens(text);
  if (tokens.length === 0) return { complete: false, reason: "no-tokens" };
  const first = tokens[0].word;
  const trimmed = text.trim();

  // Interrogative shapes (checked before the subordinator guard so legitimate
  // "When does the restaurant close?" questions are never rejected).
  if (/[?]\s*$/.test(trimmed)) {
    if (INVERSION_AUX.has(first)) return { complete: true, reason: "question-inversion" }; // yes/no inversion: "Is the menu fresh today?"
    if (WH_WORDS.has(first)) {
      if (tokens[1]?.isVerbFinite) return { complete: true, reason: "question-subject-wh" }; // subject wh-question: "Who arrives first?"
      if (tokens.some((token) => INVERSION_AUX.has(token.word))) return { complete: true, reason: "question-inverted-aux" }; // "When does the restaurant close?"
    }
    return { complete: false, reason: "question-unresolved" };
  }

  // Subordinate-only guard: a leading subordinate clause is not sufficient; an
  // independent main clause must follow (typically after a comma). The guard
  // applies only when the leading clause genuinely has a predicate — an
  // adverbial answer like "Once a month." is not a subordinate clause.
  if (SUBORDINATORS.has(first)) {
    const commaIndex = tokens.findIndex((token) => token.isComma);
    if (commaIndex === -1) {
      if (hasRealPredicate(tokens)) return { complete: false, reason: "subordinate-only" };
    } else if (hasRealPredicate(tokens.slice(0, commaIndex))) {
      return {
        complete: hasRealPredicate(tokens.slice(commaIndex + 1)),
        reason: "subordinate-main-clause",
      };
    }
  }

  // Short elliptical utterances (≤ 3 content tokens): defer to the existing
  // threshold unless they are bare noun-phrase fragments.
  if (tokens.filter((token) => !token.isComma).length <= 3) {
    return { complete: shortUtteranceVerdict(tokens, text, analysis), reason: "short-utterance" };
  }

  // Imperative with a possessive-pronoun object ("Showcase your best tables").
  // Compromise occasionally tags such imperatives as nouns; a sentence-initial
  // word followed by a possessive object is an unambiguous imperative signal.
  // Restricted to possessive pronouns ("your/our/their/my/his/her/its") so
  // participial fragments like "Having a clear plan." are never accepted.
  const second = tokens[1];
  if (
    second
    && POSSESSIVE_PRONOUNS.has(second.word)
    && !DETERMINER_WORDS.has(first)
    && !WH_WORDS.has(first)
    && !SUBORDINATORS.has(first)
  ) {
    return { complete: true, reason: "possessive-imperative" };
  }

  // Ordinary declarative / imperative: the whole sentence is the clause.
  const complete = hasRealPredicate(tokens);
  return {
    complete,
    reason: complete ? "main-clause-predicate" : "no-predicate-evidence",
  };
}
