// ── Shared block-type-aware sentence-completeness validator ──
// One deterministic rule set for "is this block's prose complete?" used by:
//   - AI block acceptance (reject incomplete prose at the producer),
//   - malformed-prose scanning and repair,
//   - coherence validation (incomplete-sentence check),
//   - trim/compaction candidate validation,
//   - final QC and pre-save validation.
//
// Contract:
//   - Paragraphs, quotes and FAQ answers must contain complete prose. A block
//     that ends without terminal punctuation (or ends with an unfinished
//     setup) is incomplete.
//   - Headings, subheadings, list labels/items, table cells, titles, meta
//     descriptions and excerpts do NOT require sentence punctuation, but must
//     still reject unmistakable fragments ("go a", "is designed to",
//     "connect with", "works because", punctuation-only residue).
//   - Valid abbreviations, links, quotations, apostrophes, measurements and
//     stranded-preposition constructions are preserved (never flagged).
//   - This validator never guesses missing words and never appends
//     punctuation; it only reports.
//
// This module is a leaf: it must not import publication-quality,
// editorial-polish or any other validator so every consumer can depend on it
// without creating import cycles.

import { findSentenceBoundaryOffsets, splitSentences } from "@/lib/seo/seo-text-utils";
import { runSentenceCompletenessShadow } from "@/lib/blog/sentence-completeness-shadow";
import {
  decideHybridAuthority,
  isHybridSentenceCompletenessEnabled,
  runHybridOverrideDiagnostics,
} from "@/lib/blog/sentence-completeness-hybrid-authority";

export type SentenceCompletenessKind =
  | "paragraph" // full prose — terminal punctuation required
  | "quote" // full prose — terminal punctuation required
  | "faq-answer" // full prose — terminal punctuation required
  | "list-item" // structural — no punctuation required
  | "table-cell" // structural — no punctuation required
  | "subheading" // structural — no punctuation required
  | "heading" // structural — no punctuation required
  | "title" // structural — no punctuation required
  | "meta-description" // structural — no punctuation required
  | "excerpt"; // structural — no punctuation required

export type SentenceCompletenessIssueCode =
  | "missing-terminal-punctuation" // prose kinds only
  | "trailing-fragment" // structural kinds (and unmistakable tails)
  | "missing-aux-inversion" // prose interrogative with missing auxiliary inversion
  | "no-finite-predicate"; // sentence-like prose with no finite predicate (fragment)

export interface TrailingFragment {
  /** UTF-16 offset where the trailing fragment begins in the normalized text. */
  start: number;
  /** UTF-16 offset where the trailing fragment ends (text length). */
  end: number;
  /** The fragment text. */
  text: string;
}

export interface SentenceCompletenessIssue {
  code: SentenceCompletenessIssueCode;
  message: string;
  /** Non-null when the issue is a removable trailing tail. */
  trailingFragment: TrailingFragment | null;
}

export interface SentenceCompletenessAnalysis {
  complete: boolean;
  issues: SentenceCompletenessIssue[];
  /** The unmistakable trailing fragment of a prose block, if any. */
  trailingFragment: TrailingFragment | null;
}

export interface SentenceCompletenessOptions {
  /**
   * A paragraph ending in a colon is complete when the next canonical block
   * is the non-empty list/table it introduces. Callers must derive this from
   * the surrounding block sequence; it is never enabled for isolated prose.
   */
  allowColonBeforeStructuredContinuation?: boolean;
}

const PROSE_KINDS = new Set<SentenceCompletenessKind>([
  "paragraph",
  "quote",
  "faq-answer",
]);

export function isProseKind(kind: SentenceCompletenessKind): boolean {
  return PROSE_KINDS.has(kind);
}

/** Source: citations are citation metadata, not prose sentences. */
export function isSourceCitationText(text: string): boolean {
  return /^\s*sources?:\s/i.test(text);
}

/** Closing delimiters that belong to the preceding sentence. Apostrophes
 *  (possessives/contractions) are deliberately excluded. */
const CLOSING_DELIM_RE = /["\u201D\u2019)\]}]+$/;

/** Terminal sentence punctuation. */
const TERMINAL_MARK_RE = /[.!?]$/;

/** Unfinished-setup ending ("Here's what you need to know:") — a colon or
 *  dash that promises a continuation which is not present. */
const SETUP_ENDING_RE = /[:—–-]$/;

/** Bare determiners at the very end of a text are unmistakably fragmentary
 *  ("go a", "choose the", "pick an"). Matched case-sensitively so label-style
 *  items ("Item A", "Plan B") are never false positives, and only when at
 *  least one word precedes the determiner (a lone "A"/"The" item is an
 *  ambiguous label, not a provable fragment). */
const BARE_DETERMINER_END_RE = /\b[a-z]+\s+(?:a|an|the)\s*$/;

/** Dangling tail words: a preposition/infinitive-marker/conjunction at the
 *  very end without the phrase it introduces. Stranded-preposition
 *  constructions ("What are you waiting for?", "This is what we plan for.")
 *  are legitimate when an interrogative/relative pronoun earlier in the text
 *  supplies the object — those are never flagged. */
const DANGLING_TAIL_END_RE =
  /\b(?:to|with|for|from|of|at|into|onto|upon|because|and|or|but|as|than|that|which|while|when|if|so|yet|nor)\s*$/i;

const WH_ANTECEDENT_RE =
  /\b(?:what|which|who|whom|whose|where|how|why|when)\b/i;

/** Trailing hyphen/dash residue ("market-") is a mid-word cut. */
const TRAILING_HYPHEN_RE = /[—-]$/;

/** Punctuation-only residue (".", "...", "—"). */
const PUNCTUATION_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;
const PUNCTUATION_MARK_RE = /[.!?—–…]/;

/** A WH-question (interrogative ending in "?") whose subject pronoun directly
 *  precedes a finite auxiliary followed by a main verb is missing the required
 *  auxiliary inversion ("What they do stop for?" is wrong; "What do they stop
 *  for?" is correct). The main-verb requirement distinguishes the defect from
 *  a valid "What can I do about it?" where the word after the pronoun is a
 *  preposition, not a verb. */
const WH_INTERROGATIVE_RE = /\b(?:what|which|who|whom|whose|where|how|why|when)\b/i;
const SUBJECT_PRONOUNS = new Set(["i", "you", "we", "they", "he", "she", "it", "this", "that"]);
const AUXILIARY_WORDS = new Set([
  "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "shall", "should", "may", "might", "must",
]);

function isVerbWord(word: string): boolean {
  if (COMMON_FINITE_VERBS.has(word)) return true;
  if (/[a-z]+ed/i.test(word)) return true;
  return false;
}

/** True when a WH-question shows the provable missing-inversion defect: a
 *  subject pronoun directly followed by an auxiliary directly followed by a
 *  main verb ("What they do stop for?"). */
function findMissingAuxInversion(sentence: string): boolean {
  if (!/\?\s*$/.test(sentence)) return false;
  if (!WH_INTERROGATIVE_RE.test(sentence)) return false;
  const words = sentence.toLowerCase().match(/[a-z]+/gi) ?? [];
  for (let index = 0; index < words.length - 2; index++) {
    if (
      SUBJECT_PRONOUNS.has(words[index])
      && AUXILIARY_WORDS.has(words[index + 1])
      && isVerbWord(words[index + 2])
    ) {
      return true;
    }
  }
  return false;
}

/** Finite-predicate signals used to tell a real sentence from a noun-phrase
 *  fragment: copulas/auxiliaries, regular past-tense "-ed" forms, and a broad
 *  lexicon of common English finite verbs (base forms). A sentence-like prose
 *  unit with NONE of these has no finite predicate and is a fragment. */
const AUXILIARY_VERB_RE =
  /\b(?:am|is|are|was|were|be|been|being|do|does|did|have|has|had|will|would|shall|should|can|could|may|might|must)\b/i;

const COMMON_FINITE_VERBS = new Set<string>([
  // high-frequency base/irregular verbs
  "be", "have", "do", "say", "see", "go", "make", "take", "come", "think",
  "look", "want", "give", "use", "find", "tell", "ask", "work", "seem", "feel",
  "try", "leave", "call", "need", "become", "mean", "keep", "let", "begin",
  "help", "talk", "turn", "start", "move", "like", "live", "play", "walk",
  "show", "hear", "believe", "hold", "bring", "happen", "write", "provide",
  "sit", "stand", "lose", "pay", "meet", "include", "continue", "set", "learn",
  "change", "lead", "understand", "watch", "follow", "stop", "create", "speak",
  "read", "allow", "add", "spend", "grow", "open", "win", "offer", "remember",
  "love", "consider", "appear", "buy", "wait", "serve", "die", "send", "expect",
  "build", "stay", "fall", "cut", "reach", "remain", "suggest", "raise", "pass",
  "sell", "require", "report", "decide", "pull", "return", "explain", "hope",
  "develop", "carry", "break", "promise", "produce", "eat", "cover", "catch",
  "draw", "choose", "describe", "drop", "push", "travel", "contain", "throw",
  "spread", "drive", "dance", "realize", "discuss", "laugh", "maintain",
  "imagine", "express", "focus", "centre", "center", "matter", "trust", "prove",
  "plan", "shift", "invest", "adopt", "measure", "target", "launch", "expand",
  "deliver", "perform", "aim", "act", "answer", "apply", "arrange", "avoid",
  "base", "blow", "burn", "care", "cast", "check", "claim", "clear", "collect",
  "compare", "compete", "complete", "conduct", "connect", "consist", "control",
  "cook", "cost", "count", "cross", "cure", "deal", "defend", "define", "demand",
  "deny", "depend", "design", "destroy", "determine", "discover", "divide",
  "doubt", "dream", "drink", "employ", "encourage", "enjoy", "ensure", "enter",
  "escape", "examine", "exist", "explore", "face", "fail", "feed", "fight",
  "fill", "finish", "fit", "fix", "fly", "force", "forget", "forgive", "form",
  "gain", "gather", "guarantee", "handle", "hang", "hate", "hide", "hit", "hope",
  "hurt", "improve", "increase", "indicate", "inform", "intend", "introduce",
  "invent", "invite", "join", "judge", "jump", "kick", "kiss", "lay", "lend",
  "lie", "lift", "limit", "listen", "manage", "marry", "mention", "mind", "miss",
  "note", "notice", "obtain", "operate", "order", "organize", "own", "pack",
  "paint", "pick", "place", "point", "prefer", "prepare", "present", "prevent",
  "print", "protect", "provide", "punish", "put", "receive", "recognize",
  "record", "reduce", "refuse", "regard", "relate", "remove", "repeat",
  "replace", "reply", "represent", "respect", "rest", "reveal", "reward", "ride",
  "ring", "roll", "save", "search", "seek", "select", "settle", "shake", "shine",
  "shoot", "shut", "sing", "sleep", "smile", "stick", "strike", "study",
  "succeed", "suffer", "support", "suppose", "survive", "swim", "taste", "teach",
  "tend", "test", "thank", "touch", "trade", "train", "treat", "visit", "wake",
  "warn", "wear", "welcome", "wish", "wonder", "worry", "engage", "engage",
  "target", "allocate", "convert", "retain", "acquire", "scale", "segment",
  "personalize", "automate", "optimize", "publish", "schedule", "post", "reply",
  "recommend", "authenticate", "reward", "monetize", "subscribe", "download",
  "share", "review", "update", "generate", "research", "match", "shape",
  "build", "run", "note", "rise", "reflect", "affect", "influence", "shift",
  "revamp", "refresh", "boost", "lift", "cut", "trim", "shrink", "double",
  "triple", "grow", "soar", "jump", "climb", "surge", "slide", "dip",
  // common irregular past/participle forms
  "rose", "saw", "went", "came", "took", "made", "said", "gave", "found",
  "knew", "thought", "felt", "got", "built", "won", "lost", "led", "kept",
  "spent", "became", "began", "wrote", "spoke", "read", "chose", "broke",
  "drove", "fell", "grew", "threw", "rode", "paid", "met", "held", "brought",
  "sent", "ran", "sat", "stood", "left", "caught", "taught", "bought", "sold",
  "heard", "meant", "hung", "shot", "understood", "lay", "beat", "bent", "fed",
  "cost", "cut", "hit", "hurt", "shut", "let",
]);

/** True when a sentence-like prose unit carries at least one finite-predicate
 *  signal. The detector is deliberately recall-oriented (accepts copulas,
 *  auxiliaries, regular "-ed" past forms, "-ing" participles, base verbs and
 *  third-person "-s" verbs) so a genuine sentence is never rejected; only a
 *  sentence with NONE of these signals is a verbless noun-phrase fragment. */
export function hasFinitePredicate(text: string): boolean {
  const value = String(text ?? "");
  if (AUXILIARY_VERB_RE.test(value)) return true;
  // Copula/auxiliary contractions and negative contractions imply a finite
  // verb: "that's", "it's", "they're", "we'll", "I've", "don't", "can't".
  // Both straight (') and curly (’) apostrophes are accepted.
  if (/\b[a-z]+(?:'s|’s|'re|’re|'ll|’ll|'ve|’ve|'d|’d|'m|’m|n't|n’t)\b/i.test(value)) return true;
  if (/\b[a-z]+(?:ed|ing)\b/i.test(value)) return true;
  // A sentence-initial imperative verb is a finite predicate even when it is
  // not in the curated lexicon ("Emphasize your signature dishes nightly.").
  if (opensWithImperativeVerb(value)) return true;
  const words = value.toLowerCase().match(/[a-z]+/gi) ?? [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    // A base-form lexicon word is a finite predicate only when it is NOT a noun
    // premodifier. A lexicon token directly before a noun head with no subject
    // is a modifier ("repeat guests", "repeat business"), not a predicate; it
    // proves a finite predicate only in predicate position ("Audiences trust
    // peers", "Repeat the offer", "Customers repeat their orders").
    if (COMMON_FINITE_VERBS.has(word) && !isLexiconNounPremodifier(words, index)) return true;
    // Third-person singular present inflections: "applies" → "apply",
    // "goes" → "go", "watches" → "watch", "rewards" → "reward".
    if (word.endsWith("ies") && COMMON_FINITE_VERBS.has(word.slice(0, -3) + "y")) return true;
    if (word.endsWith("es") && COMMON_FINITE_VERBS.has(word.slice(0, -2))) return true;
    if (word.length > 3 && word.endsWith("s") && COMMON_FINITE_VERBS.has(word.slice(0, -1))) return true;
  }
  return false;
}

/** Common plural/abstract noun endings used to recognise a noun-phrase head in
 *  the narrow noun-premodifier and adjective-led-object detection. */
const NOUN_HEAD_SUFFIX_RE = /(?:tion|sion|ness|ment|ity|ance|ence|ism|ies|es|s)$/i;

/** Closed-class words that end in a noun-like suffix but are NOT noun heads
 *  ("is", "this", "was", "has", "his", "more", "less"). */
const NON_NOUN_HEAD_S_WORDS = new Set([
  "is", "was", "this", "has", "his", "hers", "ours", "yours", "theirs", "its",
  "less", "more", "does", "us", "plus", "versus", "means", "each",
]);

function looksLikeNounHead(word: string): boolean {
  if (!NOUN_HEAD_SUFFIX_RE.test(word)) return false;
  if (NON_NOUN_HEAD_S_WORDS.has(word)) return false;
  return true;
}

/** True when a word can introduce a subject noun phrase ("the store", "a
 *  brand", "these teams"). Reuses the object-determiner set, which covers
 *  articles, possessives, demonstratives and quantifiers. */
const SUBJECT_DETERMINER_RE =
  /^(?:your|the|their|our|his|her|its|my|a|an|this|that|these|those|any|every|each|all|some|no|both|either|neither)\b/i;

/** True when the token(s) before `index` form a likely subject of a finite
 *  verb: a subject pronoun, a plural/common noun, or a singular noun introduced
 *  by a determiner ("the store sold units"). A function word or a pre-head
 *  modifier ("for repeat guests", "stronger repeat business") is NOT a subject,
 *  so the lexicon word there is a noun premodifier. */
function isLikelySubject(words: string[], index: number): boolean {
  const prev = words[index - 1];
  if (!prev) return false;
  if (SUBJECT_PRONOUNS.has(prev)) return true;
  if (IMPERATIVE_NON_VERB_OPENERS.has(prev)) return false;
  if (/s$/i.test(prev)) return true; // plural noun subject
  const prevPrev = words[index - 2];
  if (prevPrev && SUBJECT_DETERMINER_RE.test(prevPrev)) return true; // determiner + singular noun subject
  return false;
}

/** True when a base-form lexicon verb at `index` is used as a noun premodifier
 *  rather than a finite predicate ("repeat guests", "repeat business"). It is a
 *  predicate when it is sentence-initial (imperative), has a clear subject
 *  before it, or is followed by an object/complement marker — never when it is
 *  a bare noun premodifier. */
function isLexiconNounPremodifier(words: string[], index: number): boolean {
  const next = words[index + 1];
  if (!next || !looksLikeNounHead(next)) return false;
  const prev = words[index - 1];
  if (!prev) return false; // sentence-initial → imperative
  if (isLikelySubject(words, index)) return false; // subject + verb → predicate
  return true; // no subject before a noun head → noun premodifier
}

/** Closed-class sentence openers that can never be an imperative verb: articles,
 *  determiners, possessives, quantifiers, pronouns, prepositions, conjunctions,
 *  auxiliaries/copulas, WH-/subordinating words and common adverb/conjunctive
 *  links. Excluding these prevents prepositional and nominal fragments such as
 *  "Per your instructions." or "More visibility across..." from being mistaken
 *  for imperatives (the required object-determiner shape would otherwise make
 *  "Per your..." look like an imperative). */
const IMPERATIVE_NON_VERB_OPENERS = new Set<string>([
  "a", "an", "the",
  "this", "that", "these", "those", "my", "your", "our", "their", "his", "her", "its",
  "whose", "both", "either", "neither", "each", "every", "some", "any", "all", "no",
  "none", "few", "several", "many", "much", "most", "more", "less", "least", "enough",
  "such", "another", "other",
  "i", "you", "we", "they", "he", "she", "it", "me", "us", "them", "him",
  "who", "whom", "which", "what", "where", "when", "why", "how", "whether", "if",
  "because", "although", "though", "since", "unless", "until", "while", "as", "than",
  "to", "for", "with", "without", "through", "across", "in", "on", "at", "by",
  "over", "under", "of", "from", "about", "after", "before", "between", "during",
  "against", "among", "along", "around", "within", "upon", "per", "via", "toward",
  "towards", "above", "below", "behind", "beside", "beyond", "inside", "outside",
  "into", "onto", "and", "or", "but", "nor", "yet", "so",
  "am", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "ought",
  "however", "therefore", "moreover", "meanwhile", "nevertheless", "nonetheless",
  "consequently", "additionally", "likewise", "similarly", "hence", "thus",
  "furthermore", "not", "only", "also", "too", "very", "just", "even", "quite",
  "rather", "still", "always", "never", "often", "here", "there", "now", "then",
  "already", "again", "soon", "well", "maybe", "perhaps",
]);

/** A determiner/possessive/article immediately after a sentence-initial word
 *  strongly signals a transitive imperative verb governing its object
 *  ("Emphasize YOUR signature dishes"). This object shape is a grammatical
 *  signal that noun-phrase and prepositional fragments never take ("Better
 *  customer retention ...", "A stronger digital presence ..."). */
const IMPERATIVE_OBJECT_DETERMINER_RE =
  /^(?:your|the|their|our|his|her|its|my|a|an|this|that|these|those|any|every|each|all|some|no|both|either|neither)\b/i;

/** An imperative is the base verb form ("Emphasize ..."). Inflected forms
 *  ("Emphasizes", "Emphasizing", "Emphasized") are never imperatives — a
 *  subjectless 3rd-person form is a genuine fragment. */
function isBaseFormVerbCandidate(word: string): boolean {
  if (/(?:ed|ing|ies|es)$/i.test(word)) return false;
  return true;
}

/** Productive verb-forming suffixes: a word ending in one of these is probable
 *  a base-form verb even when it is not in the curated finite-verb lexicon
 *  ("emphasize", "prioritize", "analyze", "strengthen"). Used ONLY to gate the
 *  narrow adjective-led imperative-object branch, never to accept arbitrary
 *  base forms as verbs. */
const IMPERATIVE_VERB_SUFFIX_RE = /(?:ize|yze|ise|ify|ate|en|ish)$/i;

/** True when a sentence-initial word is a probable base-form verb: it is in the
 *  curated finite-verb lexicon or carries a productive verb-forming suffix.
 *  Plain adjectives and common nouns ("strong", "better", "local", "digital")
 *  are excluded, so a noun-phrase fragment is never mistaken for an imperative. */
function isProbableImperativeVerb(word: string): boolean {
  if (COMMON_FINITE_VERBS.has(word)) return true;
  if (IMPERATIVE_VERB_SUFFIX_RE.test(word)) return true;
  return false;
}

/** True when `text` opens with a probable base-form imperative verb governing an
 *  object — either a determiner/possessive/article-introduced object
 *  ("Emphasize YOUR signature dishes") or an adjective-led object of a probable
 *  verb ("Build STRONGER relationships", "Emphasize STRONG relationships"). An
 *  imperative's understood subject is "you", and its sentence-initial base form
 *  IS its finite predicate, so these sentences carry a finite predicate even
 *  when the verb is not in the curated finite-verb lexicon. Deliberately narrow:
 *  the first word must be an uninflected base form that is not a closed-class
 *  function word; the object must be unambiguously determiner-introduced, or
 *  adjective-led with a probable verb and a noun head — so genuine noun-phrase
 *  and modifier fragments ("Better customer retention for restaurants.", "A
 *  stronger digital presence for repeat guests.") are never mistaken for
 *  imperatives. */
export function opensWithImperativeVerb(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  const tokens = value.match(/[a-zA-Z]+(?:['’][a-zA-Z]+)?/g) ?? [];
  const [firstToken, secondToken, thirdToken] = tokens;
  if (!firstToken || !secondToken) return false;
  const first = firstToken.toLowerCase();
  if (IMPERATIVE_NON_VERB_OPENERS.has(first)) return false;
  if (!isBaseFormVerbCandidate(first)) return false;
  // Determiner/possessive/article-introduced object — the unambiguous case.
  if (IMPERATIVE_OBJECT_DETERMINER_RE.test(secondToken)) return true;
  // Adjective-led object: [probable verb] [adjective/modifier] [noun head].
  // The second token must be a content word (not a determiner) and the third
  // must be a noun head. The probable-verb requirement on the FIRST word is
  // what keeps noun-phrase fragments ("Strong digital presence ...") out.
  if (
    thirdToken
    && isProbableImperativeVerb(first)
    && !IMPERATIVE_NON_VERB_OPENERS.has(secondToken.toLowerCase())
    && looksLikeNounHead(thirdToken.toLowerCase())
  ) {
    return true;
  }
  return false;
}

/** Sentence-like threshold: very short emphatic fragments ("Indeed.") are
 *  intentional, not paragraph fragments. Only multi-word sentence-like units
 *  are subject to the no-finite-predicate rule. */
const FRAGMENT_MIN_WORDS = 4;

export interface ProseSentenceDefect {
  code: Extract<SentenceCompletenessIssueCode, "missing-aux-inversion" | "no-finite-predicate">;
  message: string;
}

/** Detect a malformed missing-inversion interrogative. Provable only when the
 *  unit is a WH-question ending in "?" with a non-inverted subject+auxiliary. */
function findMissingAuxInversionDefect(sentence: string): ProseSentenceDefect | null {
  if (!findMissingAuxInversion(sentence)) return null;
  return {
    code: "missing-aux-inversion",
    message: "question is missing auxiliary inversion",
  };
}

/** Detect a sentence-like unit with no finite predicate (a noun-phrase or
 *  verbless fragment presented as a sentence). */
function findNoFinitePredicateDefect(sentence: string): ProseSentenceDefect | null {
  if (hasFinitePredicate(sentence)) return null;
  const words = sentence.split(/\s+/).filter(Boolean).length;
  if (words < FRAGMENT_MIN_WORDS) return null;
  if (!/[.!?]$/.test(sentence.trim())) return null;
  return {
    code: "no-finite-predicate",
    message: "sentence-like unit has no finite predicate (fragment)",
  };
}

/** Shared prose-defect rule: scan every sentence in a prose block for a
 *  missing-inversion interrogative or a no-finite-predicate fragment. This is
 *  the single authoritative rule used by producer acceptance, deterministic
 *  repair, final preflight and final QC. */
export function detectProseSentenceDefects(text: string): ProseSentenceDefect[] {
  const defects: ProseSentenceDefect[] = [];
  for (const sentence of splitSentences(text)) {
    const normalized = sentence.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const inversion = findMissingAuxInversionDefect(normalized);
    if (inversion) defects.push(inversion);
    const fragment = findNoFinitePredicateDefect(normalized);
    if (fragment) defects.push(fragment);
  }
  return defects;
}

function normalizeText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** True when the ending of `text` is an unmistakable fragment signature. */
export function hasUnmistakableFragmentEnding(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (PUNCTUATION_ONLY_RE.test(trimmed) && PUNCTUATION_MARK_RE.test(trimmed)) return true;
  if (TRAILING_HYPHEN_RE.test(trimmed)) return true;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  // Bare determiner and dangling tail signatures are unmistakable only when
  // at least one word precedes them; a lone "A", "The", "To" or "With" is an
  // ambiguous structural label, not a provable fragment.
  if (wordCount >= 2 && BARE_DETERMINER_END_RE.test(trimmed)) return true;
  if (
    wordCount >= 2
    && DANGLING_TAIL_END_RE.test(trimmed)
    && !WH_ANTECEDENT_RE.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/**
 * Analyze the sentence completeness of a single text unit. `kind` selects the
 * prose contract: prose kinds require terminal punctuation, structural kinds
 * only reject unmistakable fragments.
 *
 * Single shared authority point. Default behavior is the deterministic
 * baseline, with the Stage 3E/3F observational shadow logged (debug-gated)
 * alongside it and the ORIGINAL deterministic result returned. When the
 * explicit rollout flag ENABLE_HYBRID_SENTENCE_COMPLETENESS=true, the
 * Stage 3G conservative hybrid policy (clause-aware Compromise contextual
 * evidence via `decideSentenceCompletenessHybrid`) becomes authoritative and
 * its result is returned instead — overrides only, never generic differences.
 * Every caller (producer contract, malformed prose, coherence, trim/compaction,
 * final QC, services) inherits this single shared result automatically.
 */
export function analyzeSentenceCompleteness(
  text: string,
  kind: SentenceCompletenessKind,
  options?: SentenceCompletenessOptions,
): SentenceCompletenessAnalysis {
  const result = analyzeSentenceCompletenessDeterministic(text, kind, options);
  if (isHybridSentenceCompletenessEnabled()) {
    const { analysis, overrides } = decideHybridAuthority(text, kind, options, result);
    runHybridOverrideDiagnostics(overrides);
    return analysis;
  }
  runSentenceCompletenessShadow(text, kind, options);
  return result;
}

/**
 * The deterministic sentence-completeness core: the single authoritative
 * implementation, WITHOUT the observational shadow hook. Production callers
 * must use `analyzeSentenceCompleteness`; this export exists solely so the
 * shadow can re-evaluate the exact per-sentence units of a block (the same
 * units `detectProseSentenceDefects` judges) without recursively invoking the
 * shadow-wrapped entry point.
 */
export function analyzeSentenceCompletenessDeterministic(
  text: string,
  kind: SentenceCompletenessKind,
  options?: SentenceCompletenessOptions,
): SentenceCompletenessAnalysis {
  const normalized = normalizeText(text);
  if (!normalized) return { complete: true, issues: [], trailingFragment: null };

  // Source citations are citation metadata regardless of the surrounding kind.
  if (isSourceCitationText(normalized)) kind = "heading";

  if (!isProseKind(kind)) {
    // Structural kinds: no punctuation required, unmistakable fragments only.
    if (hasUnmistakableFragmentEnding(normalized)) {
      return {
        complete: false,
        issues: [{
          code: "trailing-fragment",
          message: "text ends with an unmistakable fragment",
          trailingFragment: { start: 0, end: normalized.length, text: normalized },
        }],
        trailingFragment: { start: 0, end: normalized.length, text: normalized },
      };
    }
    return { complete: true, issues: [], trailingFragment: null };
  }

  // Prose kinds: complete sentences with terminal punctuation are required.
  const tail = normalized.replace(CLOSING_DELIM_RE, "");
  if (options?.allowColonBeforeStructuredContinuation && /:$/.test(tail)) {
    return { complete: true, issues: [], trailingFragment: null };
  }
  if (TERMINAL_MARK_RE.test(tail) && !SETUP_ENDING_RE.test(tail)) {
    // A prose block that "looks complete" (ends with terminal punctuation)
    // must still contain genuine complete sentences. A missing-inversion
    // interrogative or a sentence-like no-finite-predicate fragment is a
    // publication defect even with correct terminal punctuation.
    const defects = detectProseSentenceDefects(normalized);
    if (defects.length > 0) {
      return {
        complete: false,
        issues: defects.map((defect) => ({
          code: defect.code,
          message: defect.message,
          trailingFragment: null,
        })),
        trailingFragment: null,
      };
    }
    return { complete: true, issues: [], trailingFragment: null };
  }

  // Incomplete: find the unmistakable trailing fragment. Everything after the
  // last unambiguous sentence boundary is the tail.
  const boundaries = findSentenceBoundaryOffsets(normalized);
  let trailingFragment: TrailingFragment | null = null;
  if (boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const fragmentText = normalized.slice(lastBoundary).trim();
    if (fragmentText) {
      const start = normalized.indexOf(fragmentText, lastBoundary);
      trailingFragment = { start, end: normalized.length, text: fragmentText };
    }
  }
  if (!trailingFragment) {
    // No complete sentence at all: the whole block is the fragment.
    trailingFragment = { start: 0, end: normalized.length, text: normalized };
  }

  const isSetupEnding = SETUP_ENDING_RE.test(tail);
  const message = boundaries.length === 0
    ? isSetupEnding
      ? "prose block is an unfinished setup (ends with a colon or dash)"
      : "prose block contains no complete sentence"
    : trailingFragment && hasUnmistakableFragmentEnding(trailingFragment.text)
      ? "prose block ends with an unmistakable trailing fragment"
      : "prose block is missing terminal punctuation";

  return {
    complete: false,
    issues: [{
      code: "missing-terminal-punctuation",
      message,
      trailingFragment,
    }],
    trailingFragment,
  };
}

/** Convenience: complete only when the text is valid prose for the kind. */
export function isSentenceComplete(
  text: string,
  kind: SentenceCompletenessKind,
  options?: SentenceCompletenessOptions,
): boolean {
  return analyzeSentenceCompleteness(text, kind, options).complete;
}
