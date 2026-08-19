// ── Factual-Risk Scanner ──
// Post-generation scan that flags unsupported precise claims in editable article content.
// Uses only supplied project research text — never the live web.
//
// Supported claims are retained.
// Unsupported claims in editable content trigger targeted regeneration.
// If regeneration still has unsupported claims, the offending sentence is removed.

import {
  parseWordPressEditorialBlocks,
  renderEditorialBlocksToWordPress,
  type EditorialBlock,
  type SourceAttribution,
} from "@/lib/blog/article-document";
import { isSourceBoilerplate, stripSourceBoilerplate } from "@/lib/blog/source-boilerplate";
import { hasDanglingSentenceEnding } from "@/lib/blog/publication-quality";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { opensWithDiscourseDependency } from "@/lib/blog/transition-rules";

// ── Types ──

export interface FactualRisk {
  /** Array of claims found in the article text */
  claims: ScannedClaim[];
  /** Whether the article contains any high-risk (likely unsupported) claims */
  hasHighRisk: boolean;
}

export interface ScannedClaim {
  /** The exact claim text fragment */
  text: string;
  /** Position in the HTML where the claim starts */
  htmlPosition: number;
  /** The claim category */
  category: ClaimCategory;
  /** Whether this claim appears to be supported by research text */
  supported: boolean;
  /** Semantic support verdict: "supported", "contradicted" or "insufficient".
   *  A matching number/entity/keyword alone never yields "supported" — the
   *  evidence must entail the claim's material parts. */
  supportVerdict?: "supported" | "contradicted" | "insufficient";
  /** Complete sentence containing the detected fragment. */
  sentenceText?: string;
  /** Stable source identifier when the complete claim is supported. */
  evidenceId?: string;
  /** Exact research sentence used to support the claim. */
  evidenceText?: string;
  /** Research URL associated with the supporting sentence. */
  evidenceUrl?: string;
  /** Deterministic explanation for support or rejection. */
  supportReason?: string;
  /** Section index (which H2 section this appears in) */
  sectionIndex: number;
  /** Source paragraph ordinal within the scanned HTML (general-discovered
   *  claims only; pattern claims rely on the raw html position). */
  blockId?: string;
  /** Exact source span in the scanned visible text (general-discovered
   *  claims only). */
  sourceSpan?: { start: number; end: number };
  /** Diagnostic-only marker: general-discovered claims are SHADOW findings.
   *  They are reported (logs) but NEVER count toward hasHighRisk, never enter
   *  the unsupported set, never drive removal and never gate publication.
   *  The hard factual authority is source-derived: deterministic patterns +
   *  provenance + entailment. */
  shadow?: boolean;
}

// ── General verifiable-claim discovery ──
// CLAIM_PATTERNS is a deterministic high-risk detector but must never define
// the COMPLETE universe of factual claims: ordinary non-numeric assertions
// (platform capabilities, payment mechanics, service availability, company
// behaviour, rankings, event facts) carry no special keyword and would bypass
// it. The factual authority therefore accepts ONE bounded structured
// discovery result per scan invocation (supplied by the caller — the pipeline
// builds it from a single model call; tests supply fixtures) and merges
// verifiable discovered claims into the SAME entailment authority.

export interface GeneralDiscoveredClaim {
  /** Self-contained claim wording with all truth-conditional qualifiers. */
  claim: string;
}

/** One sentence submitted to general discovery, with a stable deterministic
 *  ID (`s<surface-sentence-index>`) that the response must echo exactly. */
export interface GeneralDiscoveryRequestSentence {
  sentenceId: string;
  sentence: string;
}

/** One classified sentence in the structured discovery response. */
export interface GeneralDiscoveryResponseSentence {
  sentenceId: string;
  verifiableClaims: string[];
}

export interface GeneralDiscoveryBatchRequest {
  sentences: GeneralDiscoveryRequestSentence[];
}

export interface GeneralDiscoveryBatchResult {
  sentences: GeneralDiscoveryResponseSentence[];
}

/** Per-scan-text discovery result: complete (claims may be empty — every
 *  sentence was classified) or unavailable (coverage is unknown and the
 *  factual authority must fail closed). */
export type GeneralDiscoveryCoverageEntry =
  | { status: "complete"; claims: GeneralDiscoveredClaim[] }
  | { status: "unavailable"; reason: string };

export type GeneralDiscoveredClaimsMap = Map<string, GeneralDiscoveryCoverageEntry>;

/** Bounded structured discovery over ONE sentence batch. Must account for
 *  every submitted sentence ID; throws on unverifiable batches. */
export type GeneralClaimDiscovery = (
  request: GeneralDiscoveryBatchRequest,
) => Promise<GeneralDiscoveryBatchResult>;

export interface FactualScanOptions {
  /** Pre-warmed discovery coverage keyed by visible body text. When present,
   *  the scanner merges complete results with pattern claims and throws the
   *  distinct factual-coverage error for unavailable entries. */
  generalDiscoveredClaims?: GeneralDiscoveredClaimsMap;
  /** Explicit source→prose provenance for the scanned component: exact
   *  sentences mapped to the SOURCE-X-CLAIM-Y IDs the producer was supplied.
   *  Attributed sentences are validated against their DECLARED evidence only —
   *  never reassigned heuristically from the whole ledger. */
  declaredAttributions?: SourceAttribution[];
  /** Free-prose accounting for the scanned component: sentences the producer
   *  classified as advice/opinion/rhetoric/hypothetical. They are never fed
   *  into general-claim discovery merging and never become factual claims. */
  freeProseSentences?: string[];
}

export type ClaimCategory =
  | "percentage"
  | "currency_amount"
  | "date_claim"
  | "numerical_growth"
  | "platform_metric"
  | "platform_feature"
  | "platform_behavior"
  | "comparative_performance"
  | "publishing_cadence"
  | "testimonial_quote"
  | "unattributed_source"
  | "business_result"
  | "market_wide_claim"
  | "general_claim"
  | "source_attributed";

export interface EvidenceLedgerEntry {
  evidenceId: string;
  title: string;
  snippet: string;
  url: string;
  approvedText: string;
  normalizedText: string;
  quantities: number[];
  geography: "hong-kong" | "global" | "unspecified";
  statisticQualifier: "average" | "median" | "unspecified";
  concepts: string[];
}

// ── Claim detection patterns ──

const CLAIM_PATTERNS: Array<{
  category: ClaimCategory;
  regex: RegExp;
  /** Generic quoted text must have explicit attribution before it is factual. */
  quotedText?: boolean;
}> = [
  // Percentages
  { category: "percentage", regex: /\d{1,3}(?:\.\d+)?%/gi },
  { category: "currency_amount", regex: /(?:HK\$|US\$|[$£€¥])\s*\d[\d,]*(?:\.\d+)?/gi },
  { category: "date_claim", regex: /\b(?:19|20)\d{2}\b/gi },
  {
    category: "platform_metric",
    regex: /\b(?:average|median)\s+engagement rate[^.!?]{0,100}?\d{1,3}(?:\.\d+)?%/gi,
  },
  {
    category: "platform_metric",
    regex: /\b\d{1,3}(?:\.\d+)?%[^.!?]{0,100}?(?:average|median)\s+engagement rate\b/gi,
  },
  // Numerical growth claims
  { category: "numerical_growth", regex: /(?:increased|decreased|grew|fell|rose|dropped|doubled|tripled|jumped|surged)\s+(?:by|from|to)\s+\d+(?:,\d{3})*(?:\.\d+)?(?![\d.,])/gi },
  { category: "numerical_growth", regex: /(?:jumped|surged|shot up|soared|plummeted|plunged)\s+\d+(?:,\d{3})*(?:\.\d+)?(?![\d.,])/gi },
  { category: "numerical_growth", regex: /\d+\s*(?:percent|per cent|times|x)\s+(?:increase|decrease|growth|drop|rise|fall|more)/gi },
  { category: "numerical_growth", regex: /\b\d+(?:\.\d+)?\s*x\s+(?:higher|lower|more|greater|better|faster)\b/gi },
  // Platform thresholds, recommended cadence and claimed peak-time windows
  { category: "platform_metric", regex: /\b\d[\d,]*\s+followers?\b/gi },
  {
    category: "platform_metric",
    regex: /\b\d+(?:\.\d+)?(?:,\d{3})*\s*(?:billion|million|thousand|bn|m|k)?\+?\s+(?:monthly active\s+|daily active\s+)?users?\b/gi,
  },
  { category: "publishing_cadence", regex: /\b\d+(?:\s*[–—-]\s*\d+)?\s+(?:posts?|threads?)\s+(?:per|a)\s+(?:day|week|month)\b/gi },
  { category: "publishing_cadence", regex: /\b(?:post|publish)\s+\d+(?:\s*[–—-]\s*\d+)?\s+times?\s+(?:per|a)\s+(?:day|week|month)\b/gi },
  { category: "platform_metric", regex: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi },
  { category: "platform_metric", regex: /\b(?:within|during)\s+the\s+first\s+(?:hour|day|week)\b/gi },
  { category: "platform_metric", regex: /\b(?:target|aim for|benchmark of)\s+\d+(?:\s*[–—-]\s*\d+)?%/gi },
  // Dated or current platform-capability claims must be present in research.
  { category: "platform_feature", regex: /\bas of \d{4},?[^.!?]{0,140}\b(?:launched|available|supports?|allows?|offers?)\b[^.!?]*/gi },
  {
    category: "platform_feature",
    regex:
      /\bthreads\b[^.!?]{0,100}\b(?:ads?|advertising|analytics|insights|links?|features?)\b[^.!?]{0,100}\b(?:available|unavailable|launched|rolled out|supported|allowed|offered|does not|doesn't|is not|isn't|are not|aren't|now|currently|yet)\b[^.!?]*/gi,
  },
  {
    category: "platform_feature",
    regex:
      /\bthreads\b[^.!?]{0,100}\b(?:supports?|allows?|offers?|includes?|has launched)\b[^.!?]{0,80}\b(?:ads?|advertising|analytics|insights|links?|features?)\b[^.!?]*/gi,
  },
  {
    category: "platform_feature",
    regex:
      /\bthreads\s+ads?\b[^.!?]{0,160}\b(?:meta ads manager|placement|targeting|call-to-action|cta|approval process|home feed|feed)\b[^.!?]*/gi,
  },
  {
    category: "platform_behavior",
    regex:
      /\b(?:the\s+)?(?:threads(?:'s)?\s+)?algorithm\b[^.!?]{0,160}\b(?:amplif(?:y|ies)|bur(?:y|ies)|favou?rs?|pushes?|rewards?|shows?|signals?|boosts?|ranks?)\b[^.!?]*/gi,
  },
  {
    category: "platform_behavior",
    regex:
      /\bthreads\b[^.!?]{0,80}\b(?:rewards?|favou?rs?|amplif(?:y|ies)|pushes?|boosts?)\b[^.!?]*/gi,
  },
  {
    category: "comparative_performance",
    regex:
      /\b(?:outperforms?|unmatched|dwarfs?|far (?:more|higher)|higher exposure|lower cpms?|faster than any|best time|peak hours?|most active|reach thousands)\b[^.!?]*/gi,
  },
  {
    category: "comparative_performance",
    regex:
      /\b(?:engagement|reach|exposure|visibility)\b[^.!?]{0,40}\b(?:will|can)\s+(?:drop|rise|increase|decrease|grow)\b[^.!?]*/gi,
  },
  // Comparative-quantity propositions ("worth more than a hundred one-time
  // visitors", "more than a thousand followers") are factual claims: the
  // evidence must assert the SAME comparison, not merely contain the number.
  {
    category: "comparative_performance",
    regex:
      /\b(?:more|less|better|worse|higher|lower|greater|worth\s+more|fewer|stronger|faster|cheaper|larger|bigger|smaller)\s+than\s+(?:a\s+)?(?:hundred|thousand|million|billion|hundreds|thousands|millions)\b[^.!?]*/gi,
  },
  // Superlative reputation propositions ("widely regarded as the best
  // channel", "known as the leading retail channel") require evidence that
  // asserts the same superlative strength.
  {
    category: "comparative_performance",
    regex:
      /\b(?:widely\s+)?(?:regarded|considered|seen|known)\s+as\s+the\s+(?:best|leading|top|most\s+\w+|number\s+one)\b[^.!?]*/gi,
  },
  // Business results
  { category: "business_result", regex: /generated?\s+\d+\s*(?:percent|%|times|x|more)/gi },
  { category: "business_result", regex: /(?:sales|revenue|traffic|leads|conversions?)\s+(?:rose|increased|grew|jumped|surged)\s+\d+(?:,\d{3})*(?:\.\d+)?(?![\d.,])/gi },
  { category: "business_result", regex: /\d+\s*(?:percent|%)\s+(?:increase|decrease|growth|boost|rise|drop)\s+in\s+(?:sales|revenue|traffic|leads|conversions?|engagement|visits?)/gi },
  // Testimonials with quotation marks
  {
    category: "testimonial_quote",
    regex: /(?:"[^"]{10,}"|“[^”]{10,}”)/gi,
    quotedText: true,
  },
  {
    category: "unattributed_source",
    regex: /\b(?:as one guide notes|according to recent data|research shows|studies show|experts say)\b[^.!?]*/gi,
  },
  // Unnamed business testimonials
  { category: "testimonial_quote", regex: /(?:a|one)\s+(?:local|small|Hong Kong)\s+(?:business|brand|company|shop|store|cafe|bakery|studio)\s+(?:told us|shared|reported|said|noted|found|experienced|saw)/gi },
  // "X more" claims
  { category: "business_result", regex: /\d+\s*(?:times|x)\s+more\s+(?:sales|revenue|traffic|leads|engagement|visits?|conversions?)/gi },
  // Unsupported market-wide assertions, superlatives and absolute language.
  // These must be supported by matching evidence, softened into clearly
  // non-factual advice, or removed.
  { category: "market_wide_claim", regex: /\bhit rock bottom\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\beveryone (?:is|has|can|will|sees?|wants?|expects?)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bbrands across (?:the )?(?:city|market|industry|region)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bthe (?:most effective|best|leading|top) (?:[a-z]+ ){0,3}(?:way|strategy|approach|tool|method|channel|platform)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bno longer guarantees?\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\b(?:nobody|no one) (?:can|will|ever|wants?|trusts?|clicks?)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\ball (?:businesses|brands|marketers|companies|teams)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bevery (?:business|brand|marketer|company|team|campaign|customer)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bguaranteed? (?:results?|success|growth|engagement|reach)\b[^.!?]*/gi },
  // Absolute format-ineffectiveness: a claim that a whole advertising format
  // "simply doesn't work anymore" requires equally strong evidence — a source
  // on ad fatigue alone never supports it.
  { category: "market_wide_claim", regex: /\b(?:ads?|promotions?|banner ads?|interruptive (?:ads?|promotions?)|(?:all|most|traditional) ads?)\b[^.!?]{0,80}\b(?:simply |just |basically )?don['\u2019]?t work anymore\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\b(?:ads?|promotions?|banner ads?)\b[^.!?]{0,80}\bno longer work\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bno (?:brand|business|company|team) can (?:succeed|survive|grow|win|thrive)\b[^.!?]*/gi },
  // Universal performance conclusions: an approach "won't work anymore",
  // "will not work", "cannot work", "never works", or guarantees an outcome.
  { category: "market_wide_claim", regex: /\b(?:it|that|this|they|the (?:old|traditional|conventional) (?:playbook|approach|strategy|method|way|model)|(?:ads?|promotions?|banner ads?|interruptive (?:ads?|promotions?)|loud|frequent) (?:messaging|advertising|promotions?))\b[^.!?]{0,80}\b(?:simply |just |basically )?(?:won['\u2019]?t|will not|doesn['\u2019]?t|do not|cannot|can['\u2019]?t|never) work(?: anymore)?\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\b(?:never works|no longer works)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\b(?:this|that|it|such an?|the (?:old|traditional) (?:approach|strategy|method|way|playbook|model)) (?:always|consistently|invariably|never|no longer) leads? to\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\b(?:does|do|can|could) (?:far )?more than\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bleads? to fewer (?:returns|results|sales|conversions|engagements?)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\bguarantees? (?:results?|success|growth|engagement|reach|sales|conversions?)\b[^.!?]*/gi },
  // Quantitative market claims: message/ad volume asserted as a market fact.
  { category: "market_wide_claim", regex: /\b(?:consumers?|people|users?|audiences?|customers?)\b[^.!?]{0,60}\b(?:bombarded|flooded|inundated|overwhelmed)\b[^.!?]*/gi },
  { category: "market_wide_claim", regex: /\b(?:thousands?|hundreds?|millions?) of (?:messages|ads?|promotions?|notifications?)\b[^.!?]*/gi },
];

// ── Claimhood: temporal scope vs genuine year assertions ──
// A year/date token alone is never automatically an atomic factual claim.
// "The Shape of the Market in 2026", "Our 2026 guide to Hong Kong retail
// marketing" and "Hong Kong Marketing Trends 2026" name a topic, document or
// edition — temporal context, not a proposition the text asserts. A year only
// becomes a claim when the sentence is a finite clause and the year sits in a
// temporal-adjunct position ("Hong Kong retail sales rose 6.5% in 2026") or
// heads the clause as its subject ("2026 marks the launch of Threads ads").
// This is a structural claimhood rule: no year, phrase or article is
// whitelisted, and a genuine assertion involving a year is still checked.

const TEMPORAL_PREPOSITIONS = new Set([
  "in", "during", "by", "through", "until", "till", "since", "from",
  "around", "about", "before", "after", "between", "throughout", "within",
  "over", "on", "at", "for",
]);

const MONTH_NAMES = new Set([
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec",
]);

const YEAR_WINDOW_QUALIFIERS = new Set([
  "early", "late", "mid", "mid-", "q1", "q2", "q3", "q4", "h1", "h2",
  "first", "second", "third", "fourth", "calendar", "fiscal",
]);

const SENTENCE_OPENER_TOKENS = new Set([
  "so", "and", "but", "yet", "however", "meanwhile", "still", "yes",
  "indeed", "again", "now", "here", "then", "also", "or",
]);

const YEAR_CLAIM_WH_START_RE = /^(?:why|what|which|who|whom|whose|when|where|how)\b/i;

// Imperative advice ("Plan ahead for 2026", "Expect more in 2026", "Start
// with a clear strategy for 2026") is guidance, not an assertion. A verb
// followed by "of/to/the/a/an" is not an imperative ("Start of 2026 saw…").
const YEAR_CLAIM_IMPERATIVE_START_RE =
  /^(?:expect|plan|prepare|get|start|begin|learn|discover|find|see|watch|read|use|try|adopt|embrace|focus|think|consider|look|build|create|make|put|ask|reach|target|aim|budget|save|invest|grow|improve|optimis\w*|optimiz\w*|test|measure|track|launch|post|share|engage|connect|follow|subscribe|join|register|book|apply|explore|check|compare|understand|remember|keep|stay|avoid|don['’]?t|let|imagine|picture|prep|gear|position|ready|set)\b\s+(?!of\b|to\b|the\b|a\b|an\b)/i;

// Tensed predicates: the sentence must be a full clause, not a nominal
// heading/topic label. Closed set in the same style as the scanner's other
// verb lists (attribution verbs, dangling-verb particles).
const FINITE_PREDICATE_RE =
  /\b(?:is|are|was|were|am|'s|'re|'m|will|won['’]?t|would|shall|should|may|might|can|could|must|have|has|had|'ve|do|does|did|be|been|being)\b|\b(?:rose|fell|grew|grown|drop(?:ped|s)?|increase(?:d|s)?|decrease(?:d|s)?|surge(?:d|s)?|jump(?:ed|s)?|climb(?:ed|s)?|decline(?:d|s)?|slump(?:ed|s)?|plunge(?:d|s)?|plummet(?:ed|s)?|recover(?:ed|s)?|rebound(?:ed|s)?|stabilis(?:ed|es)?|stabiliz(?:ed|es)?|improve(?:d|s)?|weaken(?:ed|s)?|soften(?:ed|s)?|accelerate(?:d|s)?|decelerate(?:ed|s)?|shift(?:ed|s)?|change(?:d|s)?|transform(?:ed|s)?|evolve(?:d|s)?|emerge(?:d|s)?|expand(?:ed|s)?|contract(?:ed|s)?|shrank|shrunk|shrink(?:s)?|double(?:d|s)?|triple(?:d|s)?|halve(?:d|s)?|hit(?:s)?|reach(?:ed|es)?|top(?:ped|s)?|exceed(?:ed|s)?|cross(?:ed|es)?|pass(?:ed|es)?|broke|broken|break(?:s)?|beat(?:en|s)?|set(?:s)?|record(?:ed|s)?|post(?:ed|s)?|report(?:ed|s)?|deliver(?:ed|s)?|produce(?:d|s)?|generate(?:d|s)?|achieve(?:d|s)?|earn(?:ed|s)?|brought|bring(?:s)?|attract(?:ed|s)?|drew|drawn|draw(?:s)?|welcomed|welcome(?:s)?|saw|seen|see(?:s)?|mark(?:ed|s)?|feature(?:d|s)?|include(?:d|s)?|offer(?:ed|s)?|launch(?:ed|es)?|release(?:d|s)?|introduce(?:d|s)?|debut(?:ed|s)?|start(?:ed|s)?|began|begun|begin(?:s)?|end(?:ed|s)?|open(?:ed|s)?|close(?:d|s)?|announce(?:d|s)?|unveil(?:ed|s)?|happen(?:ed|s)?|occur(?:red|s)?|took\s+place|take(?:s)?\s+place|arrive(?:d|s)?|return(?:ed|s)?|survive(?:d|s)?|thrive(?:d|s)?|spent|spend(?:s|ing)?|pay(?:s)?|paid|buy(?:s)?|bought|sell(?:s)?|sold|invest(?:ed|s)?|cost(?:s)?|save(?:d|s)?|budget(?:ed|s)?|hire(?:d|s)?|employ(?:ed|s)?|shop(?:ped|s)?|visit(?:ed|s)?|attend(?:ed|s)?|book(?:ed|s)?|order(?:ed|s)?|purchase(?:d|s)?)\b|\b(?:aim(?:s)?|expect(?:s)?|project(?:s)?|forecast(?:s)?|anticipate(?:s)?|predict(?:s)?|plan(?:s)?|schedule(?:s)?|target(?:s)?|want(?:s)?|need(?:s)?|hope(?:s)?|intend(?:s)?|trend(?:s)?|point(?:s)?|lead(?:s)?|look(?:s)?|remain(?:s)?|stay(?:s)?|continue(?:s)?|become(?:s)?|represent(?:s)?|signal(?:s)?|usher(?:s)?|herald(?:s)?|kick(?:s)?|drive(?:s)?|fuel(?:s)?|push(?:es)?|boost(?:s)?|strengthen(?:s)?|reshape(?:s)?|pave(?:s)?|promise(?:s)?|show(?:s)?|reveal(?:s)?|suggest(?:s)?|indicate(?:s)?|find(?:s)?|confirm(?:s)?|prove(?:s)?|demonstrate(?:s)?|highlight(?:s)?|emphasiz(?:es|e(?:d)?)|emphasise(?:s|d)?|stress(?:es)?|warn(?:s)?|argue(?:s)?|note(?:s)?|say(?:s)?|state(?:s)?|claim(?:s)?|work(?:s)?|fail(?:s)?|succeed(?:s)?|matter(?:s)?|count(?:s)?|apply(?:ies|s)?|follow(?:s)?|prepare(?:s)?|gear(?:s)?|position(?:s)?|ready(?:ies|s)?|turn(?:s)?|move(?:s)?|head(?:s)?|go(?:es)?|come(?:s)?|get(?:s)?|make(?:s)?|take(?:s)?|give(?:s)?|keep(?:s)?|hold(?:s)?|put(?:s)?|build(?:s)?|create(?:s)?|adopt(?:s)?|embrace(?:s)?|use(?:s)?|rel(?:ies|y)?|depend(?:s)?|ride(?:s)?|coast(?:s)?|glide(?:s)?|slide(?:s)?|drift(?:s)?|waver(?:s)?|struggle(?:s)?|grapple(?:s)?|navigate(?:s)?|steer(?:s)?|lay(?:s)?)\b/i;

// A year at clause head is a genuine assertion only when it is followed by a
// predicate — when it directly modifies a document/topic noun ("2026 guide",
// "2026 sales", "2026-2027 outlook", "2026: What to expect") it is scope.
const YEAR_MODIFIER_AFTER_RE =
  /^\s*(?:['’]s\b|[–—\-/]\s*\d|[.:,!?;]|(?:the\s+|our\s+|their\s+|this\s+|that\s+|a\s+)?(?:hong\s+kong\s+)?(?:guide|report|edition|forecast|outlook|trends?|landscape|market(?:s)?|marketing|retail|budget|roadmap|roundup|review|analysis|insights?|playbook|survey|study|summary|update|series|season|campaign|collection|lineup|directory|list|checklist|masterclass|webinar|event|conference|show|expo|forum|summit|sales|revenue|profits?|results?|figures?|earnings|performance|growth|numbers?|plans?|goals?|targets?|strategy|strategies|issues?|shopper(?:s)?|consumer(?:s)?|customer(?:s)?|audience(?:s)?|brand(?:s)?|business(?:es)?|industry|industries|scene|space|sector(?:s)?|edition|report))\b/i;

/**
 * Claimhood for `date_claim`: the year is an atomic factual claim ONLY inside
 * a finite clause where it is a temporal adjunct or the clause subject.
 * Nominal topic/document headings ("The Shape of the Market in 2026"),
 * document-scope noun phrases ("Our 2026 guide to…"), questions and
 * imperative advice are not propositions and never enter the verifier.
 */
function isYearAssertionClaim(sentenceText: string, yearOffset: number): boolean {
  const sentence = (sentenceText ?? "").trim();
  if (!sentence) return false;
  // A question never asserts ("What does 2026 hold?", "Why 2026 matters.").
  if (YEAR_CLAIM_WH_START_RE.test(sentence) || /\?\s*$/.test(sentence)) return false;
  // Imperative advice is guidance, not an assertion.
  if (YEAR_CLAIM_IMPERATIVE_START_RE.test(sentence)) return false;
  // Nominal fragments have no finite predicate → topic/document scope.
  if (!FINITE_PREDICATE_RE.test(sentence)) return false;

  const before = sentence.slice(0, yearOffset);
  const tokens = before.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const window = tokens.slice(-4);

  // A year immediately followed by a colon is a topic label ("Hong Kong
  // Retail in 2026: What to Expect", "2026: The Year of Retail") — framing,
  // never an assertion about the year.
  if (/[:：]/.test(sentence.slice(yearOffset + 4, yearOffset + 5))) return false;

  // Temporal-adjunct position: a temporal preposition governs the year and
  // the tokens between them are only month/quarter/qualifier words
  // ("sales rose 6.5% in 2026", "launched in March 2026", "by early 2026").
  // "in the 2026 report" is NOT adjunct — the article "the" shows the year
  // modifies the noun, so it stays document scope.
  for (let index = window.length - 1; index >= 0; index--) {
    if (!TEMPORAL_PREPOSITIONS.has(window[index])) continue;
    const between = window.slice(index + 1);
    if (between.every((token) =>
      MONTH_NAMES.has(token) || YEAR_WINDOW_QUALIFIERS.has(token),
    )) {
      return true;
    }
    break;
  }

  // Subject position: the year opens the clause (possibly after openers like
  // "So" / "However," / "March"). It is a claim only when followed by a
  // predicate; a following noun means it merely modifies that noun.
  if (
    tokens.length === 0
    || tokens.every((token) => SENTENCE_OPENER_TOKENS.has(token) || MONTH_NAMES.has(token))
  ) {
    const after = sentence.slice(yearOffset + 4);
    return !YEAR_MODIFIER_AFTER_RE.test(after);
  }
  return false;
}

// ── Claimhood: qualifier-governed fragments are not independent claims ──
// Decomposition must never drop a truth-conditional qualifier and emit a
// stronger claim than the text asserts: "widely seen as the best retail
// channel" must not additionally produce "the best retail channel". When a
// weakening qualifier (epistemic perception, modal, attribution, estimation)
// directly governs an absolute market-wide fragment, the fragment is not an
// independently asserted proposition — the qualified form is handled by its
// own pattern ("widely regarded/seen/known as the best…").

const MARKET_WIDE_GOVERNANCE_RE =
  /(?:widely|often|generally|commonly|increasingly|traditionally|frequently|usually|typically|long|now|still|reportedly|allegedly|perhaps|possibly|probably|likely|arguably|seemingly|by many|in many circles|by some estimates?)?\s*(?:seen|regarded|considered|viewed|perceived|known|hailed|touted|described|named|rated|voted|called|believed|thought|positioned|branded|framed|painted|portrayed|depicted|characterised|characterized|recognised|recognized|acknowledged)\s+(?:as|to be)\s+$|\b(?:may|might|can|could|would|should|perhaps|possibly|probably|likely|arguably|reportedly|allegedly|seemingly|seems?|appears?|estimated|expected|believed|thought|said|claimed|considered|projected|forecast)\s+(?:well\s+|to\s+)?(?:be\s+)?(?:the\s+)?(?:most\s+)?$|\b(?:reportedly|allegedly|according to\b[^.!?]{0,60}|by some estimates\b[^.!?]{0,40}|by some measures\b[^.!?]{0,40}|some say\b[^.!?]{0,30}|experts? (?:say|describe)\b[^.!?]{0,30})\s*[,;:]?\s*$/i;

/**
 * Claimhood for `market_wide_claim`: an absolute fragment ("the best channel",
 * "everyone", "no one can") whose strength token is directly governed by a
 * weakening qualifier ("widely seen as the best", "may be the best",
 * "according to experts, the best") is not an independent stronger claim.
 */
function isQualifierGovernedFragment(sentenceText: string, fragmentOffset: number): boolean {
  const prefix = (sentenceText ?? "").slice(0, fragmentOffset);
  return MARKET_WIDE_GOVERNANCE_RE.test(prefix);
}

// ── Research-source text extraction ──

export function buildEvidenceLedger(
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): EvidenceLedgerEntry[] {
  return (research ?? []).flatMap((item, sourceIndex) => {
    const title = decodeHtmlEntities(item.title ?? "");
    // Publisher boilerplate (legal disclaimers, opinion notices, privacy/cookie
    // text, navigation text) must never become evidence or usable quotations.
    if (isSourceBoilerplate(title)) return [];
    const snippet = stripSourceBoilerplate(decodeHtmlEntities(item.snippet ?? ""));
    const sourceSentences = splitEvidenceSentences(snippet);
    if (sourceSentences.length === 0 && title.trim()) sourceSentences.push(title.trim());
    return sourceSentences.map((sentence, claimIndex) => {
      const approvedText = sentence.replace(/\s+/g, " ").trim();
      const normalizedText = `${title} ${approvedText}`.replace(/\s+/g, " ").trim().toLowerCase();
      const geography = /\b(?:hong kong|hk)\b|香港/i.test(normalizedText)
        ? "hong-kong"
        : /\b(?:global|globally|worldwide|world average)\b|全球/i.test(normalizedText)
          ? "global"
          : "unspecified";
      const statisticQualifier = /\bmedian\b/i.test(normalizedText)
        ? "median"
        : /\baverage\b/i.test(normalizedText)
          ? "average"
          : "unspecified";
      return {
        evidenceId: `SOURCE-${sourceIndex + 1}-CLAIM-${claimIndex + 1}`,
        title,
        snippet,
        url: item.url ?? "",
        approvedText,
        normalizedText,
        quantities: extractQuantities(approvedText),
        geography,
        statisticQualifier,
        concepts: extractClaimConcepts(approvedText),
      };
    });
  });
}

// ── Scanner ──

/** The exact visible text a scan operates on — shared by the scanner and the
 *  discovery warmers so the cache key and the scan lookup always agree. */
export function visibleBodyTextForFactualScan(html: string): string {
  const scanHtml = stripPipelineCitationParagraphs(html)
    // Protected HTML assets are validated separately. This also excludes the
    // canonical visible FAQ, which receives its own structured factual pass.
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  return decodeHtmlEntities(scanHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

// ── General-claim discovery warming ──
// The discovery model call is asynchronous, while every scan and every final
// gate is synchronous. The pipeline therefore WARMS the cache (at most one
// bounded batch call per unique sentence set) before each gate, and the sync
// scans read the warmed result.
//
// Completeness contract: every sentence of the scanned text receives a stable
// deterministic ID and is submitted inside a bounded batch; the discovery
// function must account for every submitted ID (or throw). A batch that stays
// unavailable — provider failure, invalid JSON, truncation, missing/unknown/
// duplicate IDs — is recorded as UNAVAILABLE coverage for that text. The scan
// then fails closed with the distinct factual-coverage diagnostic: coverage
// is unknown, so the article is never saved on pattern-only fallback.
// CLAIM_PATTERNS remain merged high-risk backstops for complete coverage.

const GENERAL_DISCOVERY_MIN_WORDS = 8;
const GENERAL_DISCOVERY_CACHE_CAP = 400;
const GENERAL_DISCOVERY_BATCH_SENTENCES = 6;

function discoveryWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Warm discovery for one scan text: split into sentences, assign stable IDs
 * (`s<surface-sentence-index>`), submit in bounded batches, and verify every
 * batch accounts for every submitted sentence ID. Any batch that cannot be
 * completed marks the WHOLE text unavailable — never a silent pattern-only
 * fallback. Memoised per process so repeated scans of the same text never
 * re-call the model.
 */
export async function warmGeneralClaimDiscovery(
  html: string,
  discovery: GeneralClaimDiscovery,
  cache?: GeneralDiscoveredClaimsMap,
): Promise<GeneralDiscoveredClaimsMap> {
  const map = cache ?? new Map<string, GeneralDiscoveryCoverageEntry>();
  const text = visibleBodyTextForFactualScan(html);
  if (map.has(text) || discoveryWordCount(text) < GENERAL_DISCOVERY_MIN_WORDS) return map;
  if (map.size >= GENERAL_DISCOVERY_CACHE_CAP) {
    map.set(text, { status: "unavailable", reason: "discovery cache capacity reached" });
    return map;
  }

  const sentenceRangesList = sentenceRanges(text);
  const sentences: GeneralDiscoveryRequestSentence[] = sentenceRangesList.map((range, index) => ({
    sentenceId: `s${index}`,
    sentence: text.slice(range.start, range.end).replace(/\s+/g, " ").trim(),
  }));
  if (sentences.length === 0) {
    map.set(text, { status: "complete", claims: [] });
    return map;
  }

  const claims: GeneralDiscoveredClaim[] = [];
  for (let start = 0; start < sentences.length; start += GENERAL_DISCOVERY_BATCH_SENTENCES) {
    const batch = sentences.slice(start, start + GENERAL_DISCOVERY_BATCH_SENTENCES);
    try {
      const result = await discovery({ sentences: batch });
      // Defense in depth: the discovery seam already verifies completeness,
      // but a supplied discovery function must never bypass the contract.
      const violations = verifySubmittedSentenceCompleteness(batch, result);
      if (violations.length > 0) {
        map.set(text, { status: "unavailable", reason: violations.join("; ") });
        return map;
      }
      for (const entry of result.sentences) {
        for (const claim of entry.verifiableClaims) {
          claims.push({ claim: claim.trim() });
        }
      }
    } catch (err) {
      map.set(text, {
        status: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      });
      return map;
    }
  }
  map.set(text, { status: "complete", claims });
  return map;
}

/** Deterministic batch completeness check (shared with the discovery seam so
 *  warm and seam can never disagree about what "complete" means). */
export function verifySubmittedSentenceCompleteness(
  submitted: GeneralDiscoveryRequestSentence[],
  result: GeneralDiscoveryBatchResult | null,
): string[] {
  if (!result || !Array.isArray(result.sentences)) return ["response has no sentences array"];
  const errors: string[] = [];
  const submittedIds = submitted.map((s) => s.sentenceId);
  const returnedIds = result.sentences.map((s) => s.sentenceId);
  const returnedDuplicates = returnedIds.filter((id, index) => returnedIds.indexOf(id) !== index);
  if (returnedDuplicates.length > 0) {
    errors.push(`duplicate sentence ids in response: ${[...new Set(returnedDuplicates)].join(", ")}`);
  }
  const unknown = returnedIds.filter((id) => !submittedIds.includes(id));
  if (unknown.length > 0) {
    errors.push(`unknown sentence ids in response: ${[...new Set(unknown)].join(", ")}`);
  }
  const missing = submittedIds.filter((id) => !returnedIds.includes(id));
  if (missing.length > 0) {
    errors.push(`missing sentence ids in response: ${missing.join(", ")}`);
  }
  for (const entry of result.sentences) {
    if (typeof entry?.sentenceId !== "string" || !Array.isArray(entry.verifiableClaims)) {
      errors.push("response contains a malformed sentence entry");
    }
  }
  return errors;
}

/** Warm every canonical structured surface of a document (same surface set
 *  `scanUnsupportedClaimsInDocument` scans, so the final gates never discover
 *  a claim the warming step did not see). */
export async function warmGeneralClaimDiscoveryForDocument(
  doc: import("@/lib/blog/article-document").ArticleDocument,
  discovery: GeneralClaimDiscovery,
  cache?: GeneralDiscoveredClaimsMap,
): Promise<GeneralDiscoveredClaimsMap> {
  const map = cache ?? new Map<string, GeneralDiscoveryCoverageEntry>();
  for (const surface of collectStructuredFactualSurfaces(doc)) {
    await warmGeneralClaimDiscovery(surface.html, discovery, map);
  }
  return map;
}

export function scanFactualRisks(
  html: string,
  keyphrase: string,
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
  options?: FactualScanOptions,
): FactualRisk {
  const bodyText = visibleBodyTextForFactualScan(html);

  const evidenceLedger = buildEvidenceLedger(research);

  // Find H2 section boundaries for claim positioning
  const h2Positions: number[] = [];
  const h2Re = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi;
  let h2m: RegExpExecArray | null;
  while ((h2m = h2Re.exec(html)) !== null) {
    h2Positions.push(h2m.index);
  }

  function findSectionIndex(pos: number): number {
    let idx = 0;
    for (let i = h2Positions.length - 1; i >= 0; i--) {
      if (pos >= h2Positions[i]) { idx = i; break; }
    }
    return idx;
  }

  const claims: ScannedClaim[] = [];

  for (const { category, regex, quotedText } of CLAIM_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(bodyText)) !== null) {
      // Deduplicate by matching text
      const text = m[0].trim();
      if (claims.some((c) => normalizeForMatch(c.text) === normalizeForMatch(text))) continue;

      // Visible text may cross inline markup or use encoded entities. Never
      // discard a risky claim merely because it has no exact raw-HTML match.
      const htmlPos = html.indexOf(m[0]);
      const safeHtmlPos = htmlPos >= 0 ? htmlPos : 0;

      // Check if claim is in a protected block (CTA, switcher, schema)
      const beforeClaim = html.substring(0, safeHtmlPos);
      const lastOpenComment = beforeClaim.lastIndexOf("<!--");
      const lastCloseComment = beforeClaim.lastIndexOf("-->");
      if (lastOpenComment > lastCloseComment) continue; // Inside a comment block

      const sectionIndex = findSectionIndex(safeHtmlPos);
      const claimText = decodeHtmlEntities(m[0]).toLowerCase();
      const sentenceText = containingSentence(bodyText, m.index);

      // Claimhood: non-claims and meaning-altered decompositions must never
      // enter the unsupported set. A bare year in topic/document scope is
      // temporal metadata, not a proposition; an absolute fragment governed
      // by a weakening qualifier ("widely seen as the best channel") never
      // yields a stronger independent claim.
      const matchIndex = m.index;
      const claimSentenceRange = sentenceRanges(bodyText).find(
        (range) => matchIndex >= range.start && matchIndex < range.end,
      );
      const rawSentence = claimSentenceRange
        ? bodyText.slice(claimSentenceRange.start, claimSentenceRange.end)
        : bodyText;
      const claimOffsetInSentence = claimSentenceRange ? matchIndex - claimSentenceRange.start : 0;
      if (category === "date_claim" && !isYearAssertionClaim(rawSentence, claimOffsetInSentence)) {
        continue;
      }
      if (
        category === "market_wide_claim"
        && isQualifierGovernedFragment(rawSentence, claimOffsetInSentence)
      ) {
        continue;
      }

      // Quotation marks alone do not turn illustrative copy into a factual
      // testimonial. Suggested post prompts, hypothetical dialogue and calls
      // to action are ordinary editorial examples unless the surrounding
      // sentence explicitly attributes the words to a speaker or source.
      if (quotedText && !hasExplicitQuotationAttribution(sentenceText, m[0])) {
        continue;
      }

      const support = findSupportingEvidence(
        sentenceText,
        claimText,
        category,
        evidenceLedger,
      );
      const quotationHasNamedLink = category !== "testimonial_quote"
        || Boolean(
          support.entry?.url
          && html.includes(`href="${support.entry.url}"`),
        );

      claims.push({
        text: m[0],
        htmlPosition: safeHtmlPos,
        category,
        supported: Boolean(support.entry) && quotationHasNamedLink,
        supportVerdict: support.entry ? support.verdict : "insufficient",
        sentenceText,
        evidenceId: support.entry?.evidenceId,
        evidenceText: support.entry?.approvedText,
        evidenceUrl: support.entry?.url,
        supportReason: quotationHasNamedLink
          ? support.reason
          : "quotation is not accompanied by its named research-source URL",
        sectionIndex,
      });
    }
  }

  // General verifiable-claim merge — SHADOW/DIAGNOSTIC ONLY. The deterministic
  // patterns never define the complete universe of factual claims, so general
  // discovery is preserved as an observational layer: discovered claims are
  // merged, located, entailed and LOGGED, but they are never a mutation
  // authority. Ordinary editorial/guidance prose must never be deleted merely
  // because it lacks direct research entailment, and an unavailable or
  // unverifiable discovery result must never block publication — B2I is
  // source-first, not exhaustive post-hoc fact checking. Every merged general
  // claim carries `shadow: true` and is excluded from hasHighRisk, the
  // unsupported set, removal and every gate.
  const coverageEntry = options?.generalDiscoveredClaims?.get(bodyText);
  if (coverageEntry?.status === "unavailable") {
    console.warn(
      `[factual-general-claim-discovery:shadow] coverage unavailable for a factual surface — ` +
      `diagnostic layer skipped (reason=${coverageEntry.reason})`,
    );
  }
  const discoveredClaims = coverageEntry?.status === "complete" ? coverageEntry.claims : [];
  if (discoveredClaims.length > 0) {
    const sentenceRangeList = sentenceRanges(bodyText);
    const paragraphBlocks = [...html.matchAll(
      /<!--\s*wp:paragraph\s*-->([\s\S]*?)<!--\s*\/wp:paragraph\s*-->/gi,
    )];
    for (const item of discoveredClaims) {
      const claimText = (item.claim ?? "").trim();
      if (!claimText || claimText.length > 400) continue;

      const located = locateDiscoveredClaimSentence(
        claimText,
        bodyText,
        sentenceRangeList,
      );
      if (!located) {
        console.warn(
          `[factual-general-claim-discovery:shadow] discovered claim cannot be located in its source text — ` +
          `skipped (diagnostic only; claim="${claimText.slice(0, 120)}")`,
        );
        continue;
      }
      const sentenceText = bodyText.slice(located.start, located.end).replace(/\s+/g, " ").trim();
      // Free-prose accounting: sentences the producer classified as
      // advice/opinion/hypothetical are never fed into discovery merging.
      const freeProse = options?.freeProseSentences ?? [];
      if (freeProse.some((sentence) =>
        normalizeForMatch(sentenceText).includes(normalizeForMatch(sentence)),
      )) {
        continue;
      }
      if (normalizeForMatch(sentenceText).includes(normalizeForMatch(claimText)) === false
        && tokenOverlapRatio(claimText, sentenceText) < 0.5) {
        console.warn(
          `[factual-general-claim-discovery:shadow] discovered claim does not match any classified sentence — ` +
          `skipped (diagnostic only; claim="${claimText.slice(0, 120)}")`,
        );
        continue;
      }
      if (isDuplicateGeneralClaim(claimText, sentenceText, claims)) continue;

      const block = locateParagraphBlock(claimText, sentenceText, paragraphBlocks);
      const blockAnchorEnd = block ? block.anchorEnd : 0;
      const beforeClaim = html.substring(0, blockAnchorEnd);
      const lastOpenComment = beforeClaim.lastIndexOf("<!--");
      const lastCloseComment = beforeClaim.lastIndexOf("-->");
      if (lastOpenComment > lastCloseComment) continue; // protected block

      const support = findSupportingEvidence(
        sentenceText,
        claimText,
        "general_claim",
        evidenceLedger,
      );

      claims.push({
        text: claimText,
        htmlPosition: blockAnchorEnd,
        category: "general_claim",
        supported: Boolean(support.entry),
        supportVerdict: support.entry ? support.verdict : "insufficient",
        sentenceText,
        evidenceId: support.entry?.evidenceId,
        evidenceText: support.entry?.approvedText,
        evidenceUrl: support.entry?.url,
        supportReason: support.reason,
        sectionIndex: findSectionIndex(blockAnchorEnd),
        blockId: block?.blockId,
        sourceSpan: { start: located.start, end: located.end },
        shadow: true,
      });
    }
  }

  // Explicit SOURCE→PROSE provenance: attributed sentences are validated
  // against their DECLARED evidence only (never reassigned heuristically).
  // A located attributed sentence whose declared evidence fails entailment is
  // an unsupported hard claim — the existing cleanup removes it. A sentence
  // that no longer exists in the text (edited/removed by a later stage) drops
  // its attribution silently.
  const declaredAttributions = options?.declaredAttributions ?? [];
  if (declaredAttributions.length > 0) {
    const sentenceRangeList = sentenceRanges(bodyText);
    const paragraphBlocks = [...html.matchAll(
      /<!--\s*wp:paragraph\s*-->([\s\S]*?)<!--\s*\/wp:paragraph\s*-->/gi,
    )];
    for (const attribution of declaredAttributions) {
      const sentence = (attribution.sentence ?? "").trim();
      if (!sentence) continue;
      const located = locateDiscoveredClaimSentence(sentence, bodyText, sentenceRangeList);
      if (!located) continue; // stale attribution — sentence is gone
      const sentenceText = bodyText.slice(located.start, located.end).replace(/\s+/g, " ").trim();
      if (normalizeForMatch(sentenceText).includes(normalizeForMatch(sentence)) === false
        && tokenOverlapRatio(sentence, sentenceText) < 0.5) {
        continue; // stale attribution — sentence was edited
      }
      if (claims.some((c) => normalizeForMatch(c.text) === normalizeForMatch(sentence))) {
        continue; // identical proposition already claimed
      }

      const block = locateParagraphBlock(sentence, sentenceText, paragraphBlocks);
      const blockAnchorEnd = block ? block.anchorEnd : 0;
      const fidelity = validateAttributedSentenceFidelity(
        sentence,
        attribution.evidenceIds,
        evidenceLedger,
      );
      claims.push({
        text: sentence,
        htmlPosition: blockAnchorEnd,
        category: "source_attributed",
        supported: fidelity.supported,
        supportVerdict: fidelity.supported ? "supported" : "insufficient",
        sentenceText,
        evidenceId: fidelity.evidenceId,
        supportReason: fidelity.reason,
        sectionIndex: findSectionIndex(blockAnchorEnd),
        blockId: block?.blockId,
        sourceSpan: { start: located.start, end: located.end },
      });
    }
  }

  const hasHighRisk = claims.some((c) => !c.supported && !c.shadow);
  return { claims, hasHighRisk };
}

/** Absolute-superlative fragment detector for market-wide claims. */
const MARKET_WIDE_SUPERLATIVE_FRAGMENT_RE =
  /\bthe (?:most effective|best|leading|top) (?:[a-z]+ ){0,3}(?:way|strategy|approach|tool|method|channel|platform)\b/i;

/**
 * SOURCE → PROSE fidelity check for explicit provenance: the attributed
 * sentence must be entailed by its DECLARED evidence (a sub-ledger built from
 * the declared SOURCE-X-CLAIM-Y IDs) using the existing entailment authority.
 * A declared market-wide/superlative sentence runs through the market-wide
 * strength gate so a qualified source claim can never license a stronger
 * unqualified sentence.
 */
export function validateAttributedSentenceFidelity(
  sentence: string,
  evidenceIds: string[],
  ledger: EvidenceLedgerEntry[],
): { supported: boolean; reason: string; evidenceId?: string } {
  const byId = new Map(ledger.map((entry) => [entry.evidenceId, entry]));
  const declared = evidenceIds
    .map((id) => byId.get(id))
    .filter((entry): entry is EvidenceLedgerEntry => Boolean(entry));
  if (declared.length === 0) {
    return {
      supported: false,
      reason: "declared evidence ids do not exist in the approved research ledger",
    };
  }
  // An ABSOLUTE superlative fragment ("the best channel") runs through the
  // market-wide strength gate; a qualifier-governed fragment ("widely seen as
  // the best channel") uses the general comparison/superlative path — the same
  // claimhood rule as pattern extraction, so a qualified source claim can
  // never license a stronger unqualified sentence.
  const fragmentIndex = sentence.search(MARKET_WIDE_SUPERLATIVE_FRAGMENT_RE);
  const marketWide = fragmentIndex >= 0
    && !isQualifierGovernedFragment(sentence, fragmentIndex);
  const support = findSupportingEvidence(
    sentence,
    sentence,
    marketWide ? "market_wide_claim" : "general_claim",
    declared,
  );
  return {
    supported: Boolean(support.entry),
    reason: support.reason,
    evidenceId: support.entry?.evidenceId,
  };
}

/**
 * A discovered claim is a duplicate when an existing claim already carries the
 * same proposition: identical normalized wording, or — in the same sentence —
 * an existing pattern fragment contained in the discovered text whose
 * quantities fully cover the discovered claim's quantities ("6.5%" + "2026"
 * cover "sales rose 6.5% in 2026", so the general claim collapses into the
 * two deterministic claims instead of double-reporting the proposition).
 */
function isDuplicateGeneralClaim(
  claimText: string,
  sentenceText: string,
  existing: ScannedClaim[],
): boolean {
  const normalized = normalizeForMatch(claimText);
  if (existing.some((c) => normalizeForMatch(c.text) === normalized)) return true;
  const sentenceClaims = existing.filter((c) =>
    normalizeForMatch(c.sentenceText ?? "") === normalizeForMatch(sentenceText),
  );
  const quantities = extractQuantities(claimText);
  const sentenceQuantities = sentenceClaims.flatMap((c) => extractQuantities(c.text));
  return sentenceClaims.some((c) => normalized.includes(normalizeForMatch(c.text)))
    && quantities.every((q) => sentenceQuantities.includes(q));
}

function tokenOverlapRatio(a: string, b: string): number {
  const tokensA = contentTokens(a);
  const tokensB = contentTokens(b);
  if (tokensA.length === 0) return 0;
  return tokensA.filter((token) => tokensB.includes(token)).length / tokensA.length;
}

/**
 * Locate the discovered claim's sentence: exact containment first, then the
 * sentence with the highest token overlap (≥ 0.5). Returns the exact span.
 */
function locateDiscoveredClaimSentence(
  claimText: string,
  bodyText: string,
  ranges: TextRange[],
): TextRange | null {
  const normalized = normalizeForMatch(claimText);
  for (const range of ranges) {
    if (normalizeForMatch(bodyText.slice(range.start, range.end)).includes(normalized)) {
      return range;
    }
  }
  let best: TextRange | null = null;
  let bestRatio = 0.5;
  for (const range of ranges) {
    const ratio = tokenOverlapRatio(claimText, bodyText.slice(range.start, range.end));
    if (ratio > bestRatio) {
      best = range;
      bestRatio = ratio;
    }
  }
  return best;
}

function locateParagraphBlock(
  claimText: string,
  sentenceText: string,
  blocks: Array<RegExpExecArray>,
): { blockId: string; anchorEnd: number } | null {
  let best: { blockId: string; anchorEnd: number; ratio: number } | null = null;
  for (let index = 0; index < blocks.length; index++) {
    const match = blocks[index];
    const commentEnd = match[0].indexOf("-->");
    const anchorEnd = match.index + (commentEnd >= 0 ? commentEnd + 3 : match[0].length);
    const visible = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!visible) continue;
    const ratio = normalizeForMatch(visible).includes(normalizeForMatch(sentenceText))
      ? 1
      : tokenOverlapRatio(sentenceText, visible);
    if (!best || ratio > best.ratio) {
      best = { blockId: `wp-paragraph-${index + 1}`, anchorEnd, ratio };
    }
  }
  return best && best.ratio >= 0.5 ? best : null;
}

const DIRECT_ATTRIBUTION_RE = /\b(?:said|says|told(?:\s+us)?|shared|reported|noted|wrote|explained|added|recalled|commented|stated|claimed|observed)\b/i;
const SOURCE_ATTRIBUTION_RE = /\b(?:according to|in an interview|the (?:study|report|survey|research|analysis) (?:said|says|found|noted|reported|states?)|research from|data from)\b/i;
const ILLUSTRATIVE_QUOTE_CONTEXT_RE = /\b(?:for example|for instance|such as|try|ask|prompt|question|conversation starter|post idea|caption|template|you could say|you can say|consider asking|invite (?:people|readers|followers|customers)|use (?:a|the) phrase)\b/i;

/**
 * Generic quoted text is factual only when the sentence attributes it to a
 * speaker or named research source. This deliberately excludes examples such
 * as “Do you agree?” and “What is your biggest challenge?”.
 */
function hasExplicitQuotationAttribution(sentenceText: string, quotedText: string): boolean {
  const quote = decodeHtmlEntities(quotedText).trim();
  const unquoted = quote.replace(/^["“]|["”]$/g, "").trim();
  const context = sentenceText.replace(quotedText, " ").replace(quote, " ");
  const explicitlyAttributed = SOURCE_ATTRIBUTION_RE.test(context)
    || DIRECT_ATTRIBUTION_RE.test(context);

  if (ILLUSTRATIVE_QUOTE_CONTEXT_RE.test(context) && !explicitlyAttributed) return false;
  if (/\[[^\]]+\]/.test(unquoted)) return false;
  if (/\?$/.test(unquoted) && !explicitlyAttributed) return false;

  return explicitlyAttributed;
}

/**
 * Source citations are deterministic pipeline assets, not editorial claims.
 * Excluding the complete block prevents a year or number in a publication
 * title from being reclassified as an unsupported claim.
 */
function stripPipelineCitationParagraphs(html: string): string {
  return html
    .replace(
      /<!--\s*wp:paragraph\s*-->\s*<p\b[^>]*>\s*Sources?:\s*<a\b[\s\S]*?<\/a>\s*\.?\s*<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi,
      "",
    )
    .replace(
      /<p\b[^>]*>\s*Sources?:\s*<a\b[\s\S]*?<\/a>\s*\.?\s*<\/p>/gi,
      "",
    );
}

interface EvidenceSupport {
  entry?: EvidenceLedgerEntry;
  reason: string;
  /** Semantic verdict: a matching number/entity/keyword alone never yields
   *  "supported" — the evidence must entail the claim's material parts. */
  verdict: "supported" | "contradicted" | "insufficient";
}

const STOP_WORDS = new Set([
  "about", "after", "also", "among", "because", "before", "being", "between",
  "could", "from", "have", "into", "more", "most", "other", "over", "platform",
  "that", "their", "there", "these", "they", "this", "those", "through", "under",
  "using", "with", "would", "threads", "hong", "kong",
]);

const EXCLUSIVE_CONCEPT_GROUPS = [
  ["survey-sample", "general-users"],
  ["monthly-active-users", "advertising-reach"],
  ["brand-follow-none", "brand-follow-preference"],
  ["average", "median"],
];

function findSupportingEvidence(
  sentenceText: string,
  claimFragment: string,
  category: ClaimCategory,
  ledger: EvidenceLedgerEntry[],
): EvidenceSupport {
  if (ledger.length === 0) {
    return { reason: "no research evidence supplied", verdict: "insufficient" };
  }

  const claimQuantity = extractFirstQuantity(claimFragment);
  const claimConcepts = extractClaimConcepts(sentenceText);
  const claimTokens = contentTokens(sentenceText);
  const claimGeography = /\b(?:hong kong|hk)\b|香港/i.test(sentenceText)
    ? "hong-kong"
    : "unspecified";
  const claimQualifier = /\bmedian\b/i.test(sentenceText)
    ? "median"
    : /\baverage\b/i.test(sentenceText)
      ? "average"
      : "unspecified";

  let closestReason = claimQuantity === null
    ? "no evidence sentence entails the qualitative claim"
    : "exact quantity not present in compatible evidence";

  for (const entry of ledger) {
    if (
      claimQuantity !== null
      && !entry.quantities.some((quantity) => Math.abs(quantity - claimQuantity) < Number.EPSILON)
    ) {
      continue;
    }
    if (claimGeography === "hong-kong" && entry.geography !== "hong-kong") {
      closestReason = "research quantity has a different geographic scope";
      continue;
    }
    if (
      claimQualifier !== "unspecified"
      && entry.statisticQualifier !== claimQualifier
    ) {
      closestReason = "research uses a different statistical qualifier";
      continue;
    }

    // Temporal scope: when both the claim and the evidence carry an explicit
    // year and they differ, the evidence does not entail the claim's temporal
    // scope ("In 2025 new members received 50% off" is never supported by
    // "In 2026 new members receive 50% off").
    const claimYear = sentenceText.match(/\b(?:19|20)\d{2}\b/)?.[0];
    const evidenceYear = entry.approvedText.match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (claimYear !== undefined && evidenceYear !== undefined && claimYear !== evidenceYear) {
      closestReason = `evidence has a different temporal scope (${evidenceYear} vs claim ${claimYear})`;
      continue;
    }

    const conceptConflict = findConceptConflict(claimConcepts, entry.concepts);
    if (conceptConflict) {
      closestReason = conceptConflict;
      continue;
    }

    // Survey statistics may never be generalized to all users or residents.
    if (
      entry.concepts.includes("survey-sample")
      && !claimConcepts.includes("survey-sample")
    ) {
      closestReason = "survey respondents were generalized to a broader population";
      continue;
    }

    // Comparison/superlative entailment: a comparative or superlative claim
    // ("worth more than a hundred", "widely regarded as the best channel")
    // requires evidence asserting the SAME comparison strength. A matching
    // number, entity or keyword alone never entails the comparison. Checked
    // BEFORE the market-wide block so the reason names the comparison mismatch
    // precisely when one exists.
    const claimComparison = claimConcepts.includes("comparative-claim")
      || claimConcepts.includes("superlative-claim");
    const evidenceComparison = entry.concepts.includes("comparative-claim")
      || entry.concepts.includes("superlative-claim");
    if (claimComparison && !evidenceComparison) {
      closestReason = "evidence does not entail the claim's comparison/superlative";
      continue;
    }

    // Market-wide assertions and superlatives are only supported when the
    // research itself makes the same market-wide claim. A general trend in
    // research never supports "everyone", "rock bottom" or "the most effective".
    if (category === "market_wide_claim") {
      if (!entry.concepts.includes("market-wide-claim")) {
        closestReason = "research does not make the same market-wide assertion";
        continue;
      }
      // Evidence strength must match claim strength: a source on ad fatigue
      // never supports "banner ads simply don't work anymore"; a general trend
      // never supports "every customer expects" or "thousands of messages".
      const claimStrength = claimConcepts.filter((concept) =>
        (MARKET_WIDE_STRENGTH_CONCEPTS as readonly string[]).includes(concept),
      );
      if (
        claimStrength.length > 0
        && !claimStrength.some((concept) => entry.concepts.includes(concept))
      ) {
        closestReason = "research does not assert the same market-wide claim strength";
        continue;
      }
    }

    const evidenceTokens = contentTokens(entry.approvedText);
    const overlap = claimTokens.filter((token) => evidenceTokens.includes(token));
    const requiredOverlap = category === "date_claim"
      ? 1
      : claimQuantity !== null
        ? Math.min(2, Math.max(1, claimTokens.length))
        : Math.min(3, Math.max(2, claimTokens.length));
    const hasSemanticConcept = claimConcepts.some((concept) =>
      entry.concepts.includes(concept),
    );
    if (overlap.length < requiredOverlap && !hasSemanticConcept) {
      closestReason = "quantity matches but the subject or metric does not";
      continue;
    }
    // Material-part entailment: when NO semantic concept links the claim and
    // the evidence, a matching quantity/keyword/entity is not enough — the
    // evidence must cover at least half of the claim's content tokens so the
    // subject/relation/object proposition is genuinely entailed. Without this,
    // "retailers reward staff with a 50% discount when they hit service
    // targets" would be supported by evidence that merely says "new members
    // receive a 50% discount". Date claims are exempt: the year IS their whole
    // material proposition (temporal mismatch is handled by the year-scope
    // check above), so topical sentence length must not drown them out.
    if (!hasSemanticConcept && claimTokens.length >= 3 && category !== "date_claim") {
      const coverage = overlap.length / claimTokens.length;
      if (coverage < 0.5) {
        closestReason = `evidence does not entail the claim's subject/relation/object (material coverage ${Math.round(coverage * 100)}%)`;
        continue;
      }
    }

    return {
      entry,
      reason: `entailed by ${entry.evidenceId}`,
      verdict: "supported",
    };
  }

  return { reason: closestReason, verdict: "insufficient" };
}

function findConceptConflict(claimConcepts: string[], evidenceConcepts: string[]): string | null {
  for (const group of EXCLUSIVE_CONCEPT_GROUPS) {
    const claim = group.find((concept) => claimConcepts.includes(concept));
    const evidence = group.find((concept) => evidenceConcepts.includes(concept));
    if (claim && evidence && claim !== evidence) {
      if (evidence === "survey-sample" && claim === "general-users") {
        return "survey respondents were generalized to all users";
      }
      return `claim meaning "${claim}" conflicts with evidence meaning "${evidence}"`;
    }
  }
  return null;
}

const MARKET_WIDE_CLAIM_RE =
  /\b(?:hit rock bottom|everyone (?:is|has|can|will|sees?|wants?|expects?)|brands across (?:the )?(?:city|market|industry|region)|the most effective (?:way|strategy|approach|tool|method|channel|platform)|no longer guarantees?|nobody|no one (?:can|will|ever|wants?|trusts?|clicks?)|all (?:businesses|brands|marketers|companies|teams)|every (?:business|brand|marketer|company|team|campaign|customer)|guaranteed? (?:results?|success|growth|engagement|reach)|don['\u2019]?t work anymore|won['\u2019]?t work|will not work|doesn['\u2019]?t work|do not work|cannot work|can['\u2019]?t work|never works|no longer work|no (?:brand|business|company|team) can (?:succeed|survive|grow|win|thrive)|always leads? to|never leads? to|no longer leads? to|does (?:far )?more than|leads? to fewer|bombarded|flooded|inundated|overwhelmed|thousands? of (?:messages|ads?|promotions?|notifications?)|hundreds? of (?:messages|ads?|promotions?|notifications?)|millions? of (?:messages|ads?|promotions?|notifications?))\b/i;

/** Claim-strength concepts: a market-wide claim is only supported when the
 *  research asserts the SAME strength. Ad-fatigue evidence never supports
 *  "format X never works"; a general trend never supports "every customer". */
const MARKET_WIDE_STRENGTH_CONCEPTS = [
  "format-ineffectiveness",
  "message-volume",
  "every-customer",
  "no-brand-can",
  "rock-bottom",
  "absolute-outcome",
] as const;

function extractClaimConcepts(text: string): string[] {
  const normalized = decodeHtmlEntities(text).toLowerCase().replace(/\s+/g, " ");
  const concepts = new Set<string>();
  if (MARKET_WIDE_CLAIM_RE.test(normalized)) concepts.add("market-wide-claim");
  if (
    /\b(?:won['\u2019]?t work|will not work|doesn['\u2019]?t work|don['\u2019]?t work|do not work|cannot work|can['\u2019]?t work|never works?|no longer work)\b|work(?:s)? anymore\b/.test(normalized)
  ) {
    concepts.add("format-ineffectiveness");
  }
  if (/\b(?:always|never|no longer|invariably|consistently) leads? to\b|\bdoes (?:far )?more than\b|\bleads? to fewer\b|\bguarantees?\b/.test(normalized)) {
    concepts.add("absolute-outcome");
  }
  if (/\b(?:bombarded|flooded|inundated|overwhelmed)\b|\b(?:thousands?|hundreds?|millions?) of (?:messages|ads?|promotions?|notifications?)\b/.test(normalized)) concepts.add("message-volume");
  if (/\bevery customer\b/.test(normalized)) concepts.add("every-customer");
  if (/\bno (?:brand|business|company|team) can\b/.test(normalized)) concepts.add("no-brand-can");
  if (/\bhit rock bottom\b/.test(normalized)) concepts.add("rock-bottom");
  if (/\b(?:survey|surveyed|respondents?|participants?|sample)\b/.test(normalized)) concepts.add("survey-sample");
  if (/\b(?:hong kong|hk)?\s*(?:threads\s+)?users?\b/.test(normalized)) concepts.add("general-users");
  if (/\bmonthly active users?\b|\bmau\b/.test(normalized)) concepts.add("monthly-active-users");
  if (/\b(?:ad|ads|advertising|potential)\s+(?:audience\s+)?reach\b|\breachable through ads?\b|\bads? can reach\b/.test(normalized)) concepts.add("advertising-reach");
  if (/\b(?:do not|don't|does not|doesn't|never|no)\s+follow\b[^.!?]{0,40}\bbrands?\b|\bfollow no brand/.test(normalized)) concepts.add("brand-follow-none");
  if (/\b(?:prefer|rather)\b[^.!?]{0,70}\b(?:personal|individual)\s+accounts?\b|\bprefer\b[^.!?]{0,50}\bbrand accounts?\b/.test(normalized)) concepts.add("brand-follow-preference");
  if (/\b(?:tried|used|adoption|adopted)\b[^.!?]{0,40}\b(?:threads|platform)\b|\bthreads adoption\b/.test(normalized)) concepts.add("platform-use");
  if (/\b(?:usage|use)\b[^.!?]{0,50}\b(?:increased|decreased|remained|steady|changed)\b/.test(normalized)) concepts.add("platform-usage-change");
  if (/\bengagement rate\b/.test(normalized)) concepts.add("engagement-rate");
  if (/\b(?:posts?|threads?)\s+(?:per|a)\s+(?:day|week|month)\b/.test(normalized)) concepts.add("posting-cadence");
  if (/\b(?:am|pm|peak hours?|most active|posting time|post during)\b/.test(normalized)) concepts.add("posting-time");
  if (/\balgorithm\b/.test(normalized)) concepts.add("algorithm-distribution");
  if (/\bcpms?\b|\bcost per thousand\b/.test(normalized)) concepts.add("cpm");
  if (/\bmeta ads manager\b/.test(normalized)) concepts.add("ads-manager");
  if (/\btargeting\b|\bdemographics\b|\binterests\b|\bbehaviou?rs\b/.test(normalized)) concepts.add("ad-targeting");
  if (/\b(?:average|on average)\b/.test(normalized)) concepts.add("average");
  if (/\bmedian\b/.test(normalized)) concepts.add("median");
  // Comparison/superlative strength signals: a comparative or superlative
  // proposition ("worth more than a hundred", "widely regarded as the best")
  // requires evidence that asserts the SAME comparison strength — a number or
  // entity alone never entails the comparison.
  if (
    /\b(?:more|less|better|worse|higher|lower|greater|worth\s+more|fewer|stronger|faster|cheaper|larger|bigger|smaller)\s+than\b/.test(normalized)
  ) {
    concepts.add("comparative-claim");
  }
  if (
    /\b(?:widely\s+)?(?:regarded|considered|seen|known)\s+as\s+the\s+(?:best|leading|top|most\s+\w+|number\s+one)\b/.test(normalized)
    || /\bthe\s+(?:best|leading|top|highest|lowest|largest|biggest|strongest|fastest|cheapest|most\s+\w+)\s+(?!to\b|of\b)\w+\b/.test(normalized)
    || /\b(?:unmatched|number\s+one)\b/.test(normalized)
  ) {
    concepts.add("superlative-claim");
  }
  return [...concepts];
}

function contentTokens(text: string): string[] {
  return [...new Set(
    decodeHtmlEntities(text)
      .toLowerCase()
      .replace(/\d+(?:[.,]\d+)*/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
  )];
}

function splitEvidenceSentences(text: string): string[] {
  return sentenceRanges(text)
    .map((range) => text.slice(range.start, range.end).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function containingSentence(text: string, position: number): string {
  for (const range of sentenceRanges(text)) {
    if (position >= range.start && position < range.end) {
      return text.slice(range.start, range.end).replace(/\s+/g, " ").trim();
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

// ── Claim removal from section body ──

export interface RemoveSentencesOptions {
  /**
   * Normalized complete-sentence texts that must never be removed, even when
   * they match a claim fragment. Ownership enforcement uses this to preserve
   * the canonical owned occurrence when a duplicate shares the same block.
   */
  preserveSentenceTexts?: string[];
}

/**
 * Dependency references that dangle once their antecedent sentence (a claim,
 * statistic or number) has been removed: "That's a striking number",
 * "this result", "these findings", "the point is", "this shows", "it makes
 * sense", "that figure", "such numbers", ...
 */
const DEPENDENT_REFERENCE_PATTERNS: RegExp[] = [
  /^\s*(?:that['\u2019]?s|that is|this is|these are|those are|it['\u2019]?s|it is)\s+(?:a\s+)?(?:striking|remarkable|significant|telling|huge|big|small|key|clear|strong|interesting|useful|powerful|real)?\s*(?:number|figure|result|finding|statistic|percentage|share|rate|trend|pattern|growth|decline|jump|surge|drop|rise|shift|change|development|evidence|point)\b/i,
  /^\s*(?:this|that|these|those|the point|the result|the figure|the number|the data|the evidence|the survey|the study)\s+(?:result|findings?|numbers?|figures?|statistics?|percentage|share|rate|trends?|patterns?|growth|decline|jumps?|surges?|drops?|rises?|shifts?|changes?|developments?|evidence|point|data)\b/i,
  /^\s*(?:this|that)\s+shows?\b/i,
  /^\s*the point is\b/i,
];

/**
 * Sentence-initial transition openers that require an antecedent paragraph.
 * Mirrors the coherence validator's orphan-transition patterns so a removal
 * producer can never disagree with the final gate about whether "Instead,",
 * "However,", "Therefore,", "This means", etc. now dangle after an antecedent
 * removal. Includes demonstrative "This means/This shows/That is" openers used
 * as paragraph transitions.
 */
const ORPHAN_TRANSITION_OPENER_RE =
  /^\s*(?:instead|however|therefore|meanwhile|moreover|furthermore|nevertheless|nonetheless|consequently|additionally|likewise|similarly|hence|thus|yet|so|but|and)\s*[,:]/i;

const ORPHAN_TRANSITION_PHRASE_OPENER_RE =
  /^\s*(?:as a result|on the other hand|that said|in addition|at the same time|for this reason|for that reason|in other words)\s*[,:]/i;

const DEMONSTRATIVE_TRANSITION_OPENER_RE =
  /^\s*(?:this|that|these|those)\s+(?:means?|shows?|suggests?|indicates?|reflects?|is|are|was|were)\b/i;

/** True when the sentence opens with a transition that depends on the
 *  immediately preceding paragraph as its antecedent. */
function isOrphanTransitionOpener(sentence: string): boolean {
  const normalized = sentence.replace(/^\s*["\u201C'\u2018(]+\s*/, "");
  return ORPHAN_TRANSITION_OPENER_RE.test(normalized)
    || ORPHAN_TRANSITION_PHRASE_OPENER_RE.test(normalized)
    || DEMONSTRATIVE_TRANSITION_OPENER_RE.test(normalized);
}

function isDependentReference(sentence: string): boolean {
  const normalized = sentence.replace(/^\s*["\u201C'\u2018(]+\s*/, "");
  return DEPENDENT_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))
    || opensWithDiscourseDependency(normalized);
}

function isSourceCitationParagraph(text: string): boolean {
  return /^\s*sources?:/i.test(text);
}

export function removeUnsupportedSentences(
  sectionHtml: string,
  unsupportedClaims: ScannedClaim[],
  options?: RemoveSentencesOptions,
): { html: string; sentencesRemoved: number; orphanedTransitionsRemoved: number } {
  if (unsupportedClaims.length === 0) {
    return { html: sectionHtml, sentencesRemoved: 0, orphanedTransitionsRemoved: 0 };
  }
  const preservedSentences = new Set(
    (options?.preserveSentenceTexts ?? []).map((sentence) => normalizeForMatch(sentence)),
  );

  const paragraphRe =
    /<!--\s*wp:paragraph\s*-->\s*\n?<p\b[^>]*>[\s\S]*?<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi;
  const paragraphs = [...sectionHtml.matchAll(paragraphRe)];

  // Per-paragraph removal plans. Ranges are offsets into the ORIGINAL text.
  const plans: Array<{
    paragraphIndex: number;
    ranges: TextRange[];
    // True when the whole paragraph becomes empty and should be removed.
    removeWhole: boolean;
    // True when only a leading transition opener ("Instead, " / "However, ")
    // is stripped from the paragraph's first sentence, preserving the rest of
    // the sentence. The opener is replaced by nothing and the first alpha of
    // the remainder is capitalised so the sentence stays complete.
    stripTransitionOpener?: boolean;
  }> = [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const match = paragraphs[paragraphIndex];
    const paragraphHtml = match[0];
    const parsed = parseWordPressEditorialBlocks(
      paragraphHtml,
      `factual-repair-${paragraphIndex}`,
    );
    const paragraph = parsed.blocks[0];
    if (
      parsed.errors.length > 0
      || parsed.blocks.length !== 1
      || paragraph?.type !== "paragraph"
    ) {
      continue;
    }

    const text = paragraph.content.map((node) => node.text).join("");
    const relevantClaims = unsupportedClaims.filter((claim) =>
      normalizeForMatch(text).includes(normalizeForMatch(claim.text)),
    );
    if (relevantClaims.length === 0) continue;

    const ranges = sentenceRanges(text).filter((range) => {
      const sentence = normalizeForMatch(text.slice(range.start, range.end));
      if (preservedSentences.has(sentence)) return false;
      return relevantClaims.some((claim) => sentence.includes(normalizeForMatch(claim.text)));
    });
    if (ranges.length === 0) continue;

    // Links are immutable pipeline assets. If a claimed sentence contains an
    // anchor, leave it for regeneration/rejection rather than deleting the URL.
    const linkedRanges = inlineLinkRanges(paragraph);
    const safeRanges = ranges.filter(
      (range) => !linkedRanges.some((link) => rangesOverlap(range, link)),
    );
    if (safeRanges.length === 0) continue;

    let removalRanges = [...safeRanges].sort((a, b) => a.start - b.start);

    // Same-paragraph dependency handling: a sentence immediately following the
    // removed claim that refers back to it ("That's a striking number", "this
    // result", "the point is") must go too, otherwise it dangles. If it cannot
    // be removed safely, abort this paragraph's removal entirely.
    const lastRemoved = removalRanges[removalRanges.length - 1];
    const followingText = text.slice(lastRemoved.end).trim();
    const followingSentence = followingText.split(/(?<=[.!?])\s+/)[0] ?? "";
    if (followingSentence && isDependentReference(followingSentence)) {
      const dependentStart = text.indexOf(followingSentence, lastRemoved.end);
      const dependentRange = dependentStart >= 0
        ? { start: dependentStart, end: dependentStart + followingSentence.length }
        : null;
      const dependentLinked = dependentRange
        && linkedRanges.some((link) => rangesOverlap(link, dependentRange));
      if (dependentRange && !dependentLinked) {
        removalRanges.push(dependentRange);
      } else {
        // The dependent sentence carries a link or cannot be located — never
        // remove the claim and leave the reference dangling.
        continue;
      }
    }

    // Preceding setup: a sentence before the claim that introduces it ("The
    // point is:", "Here's the number:") dangles when the claim goes.
    const firstRemoved = removalRanges[0];
    const precedingText = text.slice(0, firstRemoved.start).trim();
    if (/:$/.test(precedingText) && precedingText.length > 0) {
      const setupStart = text.slice(0, firstRemoved.start).lastIndexOf(precedingText);
      const setupRange = { start: setupStart, end: setupStart + precedingText.length };
      const setupLinked = linkedRanges.some((link) => rangesOverlap(link, setupRange));
      if (!setupLinked) {
        removalRanges.unshift(setupRange);
      } else {
        continue;
      }
    }

    // A quotation is one semantic/evidentiary unit even when it spans several
    // sentences. Removing only the sentence containing the unsupported claim
    // can delete the opening mark while leaving later quoted prose and its
    // closing mark behind. Expand any intersected quotation to every sentence
    // that participates in that quotation. Abort this paragraph when the
    // source is already unbalanced, the atomic unit carries a protected link
    // or preserved owner sentence, or the resulting prose is not balanced.
    const quotationSafeRanges = expandRangesToWholeQuotations(text, removalRanges);
    if (!quotationSafeRanges) continue;
    if (quotationSafeRanges.some((range) =>
      linkedRanges.some((link) => rangesOverlap(range, link)),
    )) {
      continue;
    }
    const allSentenceRanges = sentenceRanges(text);
    if (allSentenceRanges.some((sentenceRange) =>
      quotationSafeRanges.some((range) => rangesOverlap(range, sentenceRange))
      && preservedSentences.has(normalizeForMatch(text.slice(sentenceRange.start, sentenceRange.end))),
    )) {
      continue;
    }
    removalRanges = quotationSafeRanges;

    // Merge overlapping ranges (dependent sentence may touch the claim range).
    removalRanges.sort((a, b) => a.start - b.start);
    const merged: TextRange[] = [];
    for (const range of removalRanges) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) {
        last.end = Math.max(last.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }

    plans.push({ paragraphIndex, ranges: merged, removeWhole: false });
  }

  // Cross-paragraph dependency handling: when a paragraph loses claim
  // sentences, the next non-source paragraph must not open with a reference to
  // the removed antecedent ("That's a striking number...") or with an orphaned
  // transition ("Instead, ...", "However, ...", "Therefore, ...", "This means
  // ..."). A dependent first sentence is removed when safe; an orphaned
  // transition opener is stripped from the paragraph (preserving the rest of
  // the sentence) when safe; otherwise the claim removal is aborted so no
  // dangling reference or orphan transition is ever left behind.
  for (const plan of [...plans]) {
    if (plan.ranges.length === 0) continue;
    for (let nextIndex = plan.paragraphIndex + 1; nextIndex < paragraphs.length; nextIndex++) {
      const nextMatch = paragraphs[nextIndex];
      const nextParsed = parseWordPressEditorialBlocks(nextMatch[0], `factual-next-${nextIndex}`);
      const nextBlock = nextParsed.blocks[0];
      if (nextParsed.errors.length > 0 || nextBlock?.type !== "paragraph") continue;
      const nextText = nextBlock.content.map((node) => node.text).join("");
      if (isSourceCitationParagraph(nextText)) continue;
      const nextFirstSentence = nextText.split(/(?<=[.!?])\s+/)[0] ?? nextText;
      const transitionOpener = isOrphanTransitionOpener(nextFirstSentence);
      if (!isDependentReference(nextFirstSentence) && !transitionOpener) break;
      const nextLinked = inlineLinkRanges(nextBlock);
      const nextRanges = sentenceRanges(nextText);
      const firstRange = nextRanges[0];
      const nextQuotation = analyzeQuotationIntegrity(nextText);
      const touchesQuotation = !nextQuotation.balanced || (
        firstRange
        && nextQuotation.spans.some((span) => rangesOverlap(span, firstRange))
      );
      const dependentLinked = firstRange
        && nextLinked.some((link) => rangesOverlap(link, firstRange));
      const nextKeepsSentence = nextRanges.length > 1;
      const nextHasOwnClaims = unsupportedClaims.some((claim) =>
        normalizeForMatch(nextText).includes(normalizeForMatch(claim.text)),
      );

      if (transitionOpener) {
        // An orphaned transition opener can be STRIPPED from the paragraph's
        // first sentence node-preservingly, keeping the substantive sentence
        // intact ("Instead, successful brands plan..." → "Successful brands
        // plan..."). This is structurally justified: the transition word is the
        // orphan; the sentence after it carries no reference to the removed
        // claim. Strip only when the opener is leading plain text (no link,
        // no number, no quotation) so the rest of the sentence survives.
        const openerText = nextFirstSentence.match(
          /^\s*(?:instead|however|therefore|meanwhile|moreover|furthermore|nevertheless|nonetheless|consequently|additionally|likewise|similarly|hence|thus|yet|so|but|and)\s*[,:]\s*|^\s*(?:as a result|on the other hand|that said|in addition|at the same time|for this reason|for that reason|in other words)\s*[,:]\s*|^\s*(?:this|that|these|those)\s+(?:means?|shows?|suggests?|indicates?|reflects?|is|are|was|were)\s+/i,
        )?.[0];
        if (openerText && !touchesQuotation) {
          const openerLength = nextText.length - nextText.trimStart().length + openerText.length;
          const openerEnd = Math.min(openerLength, nextText.length);
          const openerLinked = nextLinked.some((link) => rangesOverlap(link, { start: 0, end: openerEnd }));
          const openerStartsBlock = nextBlock.content[0]?.type === "text";
          if (!openerLinked && openerStartsBlock && openerEnd > 0 && openerEnd < nextText.length) {
            plans.push({
              paragraphIndex: nextIndex,
              ranges: [{ start: 0, end: openerEnd }],
              removeWhole: false,
              stripTransitionOpener: true,
            });
            break;
          }
        }
        // The opener cannot be stripped safely — abort the claim removal so
        // the transition is never left orphaned.
        plan.ranges = [];
        break;
      }

      // A single-sentence dependent paragraph is still removable when it is
      // pure reference prose (no links, no numbers, no claims of its own).
      const wholeParagraphDependent = !nextKeepsSentence
        && !dependentLinked
        && !nextHasOwnClaims
        && !/\d/.test(nextText)
        && (nextText.split(/\s+/).filter(Boolean).length <= 30);
      if (touchesQuotation || dependentLinked || nextHasOwnClaims || (!nextKeepsSentence && !wholeParagraphDependent)) {
        // The dependent sentence cannot be removed safely — abort the claim
        // removal so the reference is never left dangling.
        plan.ranges = [];
        break;
      }
      plans.push({
        paragraphIndex: nextIndex,
        ranges: wholeParagraphDependent ? nextRanges : [firstRange],
        removeWhole: wholeParagraphDependent,
      });
      break;
    }
  }

  let modified = sectionHtml;
  let removed = 0;
  // Apply from the last paragraph to the first so earlier replacements never
  // invalidate the original source positions of later ones.
  const applyOrder = plans
    .map((plan, order) => ({ plan, order }))
    .filter(({ plan }) => plan.ranges.length > 0)
    .sort((a, b) => b.plan.paragraphIndex - a.plan.paragraphIndex || a.order - b.order);
  for (const { plan } of applyOrder) {
    const match = paragraphs[plan.paragraphIndex];
    const paragraphHtml = match[0];
    const parsed = parseWordPressEditorialBlocks(paragraphHtml, `factual-apply-${plan.paragraphIndex}`);
    const paragraph = parsed.blocks[0];
    if (parsed.errors.length > 0 || paragraph?.type !== "paragraph") continue;
    let repaired = removeTextRanges(paragraph, plan.ranges);
    if (plan.stripTransitionOpener) {
      // Capitalise the first alpha of the remainder so the sentence stays
      // complete after the orphaned opener ("Instead, " / "However, ") goes.
      const firstText = repaired.content.find((node) => node.type === "text");
      if (firstText) {
        const alphaMatch = firstText.text.match(/[a-zA-Z]/);
        if (alphaMatch && alphaMatch.index !== undefined) {
          const index = alphaMatch.index;
          repaired = {
            ...repaired,
            content: repaired.content.map((node) =>
              node.type === "text" && node === firstText
                ? {
                    ...node,
                    text: node.text.slice(0, index) + node.text[index].toUpperCase() + node.text.slice(index + 1),
                  }
                : node,
            ),
          };
        }
      }
    }
    const finalized = finalizeRemovedParagraph(repaired);
    const repairedText = finalized
      ? finalized.content.map((node) => node.text).join("").trim()
      : "";
    // A removal that would consume the whole block to fix a dangling ending
    // must not delete protected inline content (links/emphasis). Abort this
    // paragraph's removal instead — the unsupported claim stays and the
    // deterministic producer never commits an incomplete textual remainder.
    if (finalized === null && paragraph.content.some((node) => node.type !== "text")) {
      continue;
    }
    const replacement = repairedText
      ? renderEditorialBlocksToWordPress([finalized!])
      : "";
    const start = match.index ?? 0;
    modified = modified.slice(0, start) + replacement + modified.slice(start + paragraphHtml.length);
    removed += plan.ranges.length;
  }

  const nonParagraphCleanup = removeUnsupportedNonParagraphBlocks(
    modified,
    unsupportedClaims,
  );
  modified = nonParagraphCleanup.html;
  removed += nonParagraphCleanup.removed;

  const continuity = repairOrphanedTransitions(modified);
  const finalHtml = continuity.html;

  // Structural fail-closed guard: a factual mutation must NEVER emit unbalanced
  // WordPress markup (e.g. an orphan "<!-- /wp:paragraph -->" from a sentence
  // splice that straddled a block boundary). If the removal produced invalid
  // structure, it fails HERE with a precise diagnostic rather than allowing
  // malformed HTML downstream to the strict re-parse boundary. The section's
  // claims are then left in place (fail-closed) — never silently weakened.
  const structure = validateWordpressBlockPairs(finalHtml);
  if (!structure.valid) {
    throw new Error(
      `factual removal produced invalid WordPress structure: ${structure.issues.join("; ")}`,
    );
  }

  return {
    html: finalHtml,
    sentencesRemoved: removed,
    orphanedTransitionsRemoved: continuity.removed,
  };
}

function removeUnsupportedNonParagraphBlocks(
  html: string,
  unsupportedClaims: ScannedClaim[],
): { html: string; removed: number } {
  let removed = 0;
  const blockRe =
    /<!--\s*wp:(list|quote|table)(?:\s[\s\S]*?)?\s*-->[\s\S]*?<!--\s*\/wp:\1\s*-->/gi;
  const matches = [...html.matchAll(blockRe)];
  let result = html;

  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const sourceBlock = match[0];
    const parsed = parseWordPressEditorialBlocks(sourceBlock, `factual-nonparagraph-${index}`);
    if (parsed.errors.length > 0 || parsed.blocks.length !== 1) continue;
    const block = parsed.blocks[0];
    let replacement: EditorialBlock | null = block;

    if (block.type === "list") {
      const retained = block.items.filter((item) => {
        const text = item.map((node) => node.text).join("");
        const risky = containsUnsupportedClaim(text, unsupportedClaims);
        if (!risky || item.some((node) => node.type === "link")) return true;
        removed++;
        return false;
      });
      replacement = retained.length > 0 ? { ...block, items: retained } : null;
    } else if (block.type === "quote") {
      const text = block.content.map((node) => node.text).join("");
      if (
        containsUnsupportedClaim(text, unsupportedClaims)
        && !block.content.some((node) => node.type === "link")
      ) {
        replacement = null;
        removed++;
      }
    } else if (block.type === "table") {
      const retainedRows = block.rows.filter((row) => {
        const text = row.flat().map((node) => node.text).join(" ");
        const hasLink = row.flat().some((node) => node.type === "link");
        if (!containsUnsupportedClaim(text, unsupportedClaims) || hasLink) return true;
        removed++;
        return false;
      });
      replacement = retainedRows.length > 0 ? { ...block, rows: retainedRows } : null;
    }

    if (replacement === block) continue;
    const rendered = replacement ? renderEditorialBlocksToWordPress([replacement]) : "";
    const start = match.index ?? 0;
    result = result.slice(0, start) + rendered + result.slice(start + sourceBlock.length);
  }
  return { html: result, removed };
}

function containsUnsupportedClaim(text: string, claims: ScannedClaim[]): boolean {
  const normalized = normalizeForMatch(text);
  return claims.some((claim) =>
    normalized.includes(normalizeForMatch(claim.text))
    || (
      claim.sentenceText
      && normalized.includes(normalizeForMatch(claim.sentenceText))
    ),
  );
}

const ORPHANED_EVIDENCE_TRANSITION_RE =
  /^(?:the (?:numbers|figures|data|statistics) speak for themselves|these (?:numbers|figures|results|findings) (?:show|prove|confirm|demonstrate) (?:it|this|the point)|the research (?:shows|proves|confirms) (?:it|this)|that result is significant|as the (?:numbers|figures|data) (?:above )?(?:show|demonstrate|confirm))\.?$/i;

/**
 * Remove evidence-introducing filler that becomes meaningless after an
 * unsupported factual sentence is deleted. This is intentionally narrow:
 * only a complete standalone sentence matching a known orphan pattern is
 * removed, never arbitrary neighbouring prose.
 */
export function repairOrphanedTransitions(
  html: string,
): { html: string; removed: number } {
  let removed = 0;
  const repaired = html.replace(
    /<!--\s*wp:paragraph\s*-->\s*\n?<p\b[^>]*>([\s\S]*?)<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi,
    (block, inner: string) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      if (!ORPHANED_EVIDENCE_TRANSITION_RE.test(text)) return block;
      removed++;
      return "";
    },
  );
  return {
    html: repaired.replace(/\n{3,}/g, "\n\n").trim(),
    removed,
  };
}

function extractFirstQuantity(text: string): number | null {
  return extractQuantities(text)[0] ?? null;
}

function extractQuantities(text: string): number[] {
  const quantities: number[] = [];
  const regex =
    /\b(\d+(?:\.\d+)?(?:,\d{3})*)\s*(billion|million|thousand|bn|m|k)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const base = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = match[2]?.toLowerCase();
    const multiplier = scale === "billion" || scale === "bn"
      ? 1_000_000_000
      : scale === "million" || scale === "m"
        ? 1_000_000
        : scale === "thousand" || scale === "k"
          ? 1_000
          : 1;
    quantities.push(base * multiplier);
  }
  return quantities;
}

interface TextRange {
  start: number;
  end: number;
}

function normalizeForMatch(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Public normalized-sentence form used by callers that pass sentences through
 * `preserveSentenceTexts`. Identical to the producer's internal
 * `normalizeForMatch`, so a caller can compute which section sentences a claim
 * removal would touch and decide whether the section keeps a grounding
 * carrier without it.
 */
export function normalizeSentenceForPreservation(text: string): string {
  return normalizeForMatch(text);
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (decimal) return decodeCodePoint(decimal, 10, entity);
      if (hexadecimal) return decodeCodePoint(hexadecimal, 16, entity);
      return name ? (named[name.toLowerCase()] ?? entity) : entity;
    },
  );
}

function decodeCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isFinite(codePoint)
    || codePoint < 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
}

function sentenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (
      char === "."
      && /\d/.test(text[index - 1] ?? "")
      && /\d/.test(text[index + 1] ?? "")
    ) {
      continue;
    }
    let end = index + 1;
    while (/[.!?]/.test(text[end] ?? "")) end++;
    while (/["”’)]/.test(text[end] ?? "")) end++;
    if (text.slice(start, end).trim()) ranges.push({ start, end });
    start = end;
    while (/\s/.test(text[start] ?? "")) start++;
    index = start - 1;
  }
  if (start < text.length && text.slice(start).trim()) {
    ranges.push({ start, end: text.length });
  }
  return ranges;
}

/**
 * Normalized complete-sentence texts of a rendered editorial region, using
 * EXACTLY the same sentence-range splitting and normalization the removal
 * producer applies when matching `preserveSentenceTexts`. Callers that want a
 * sentence to survive removal (e.g. a section's last topic-grounding carrier)
 * must pass these exact normalized texts, otherwise the producer's own
 * sentence ranges will not match and the sentence stays removable.
 */
export function normalizedSentenceTextsOfSectionHtml(sectionHtml: string): string[] {
  const paragraphRe =
    /<!--\s*wp:paragraph\s*-->\s*\n?<p\b[^>]*>[\s\S]*?<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi;
  const texts: string[] = [];
  for (const match of sectionHtml.matchAll(paragraphRe)) {
    const parsed = parseWordPressEditorialBlocks(match[0], "sentence-text-extraction");
    const paragraph = parsed.blocks[0];
    if (parsed.errors.length > 0 || paragraph?.type !== "paragraph") continue;
    const text = paragraph.content.map((node) => node.text).join("");
    for (const range of sentenceRanges(text)) {
      const sentence = normalizeForMatch(text.slice(range.start, range.end));
      if (sentence) texts.push(sentence);
    }
  }
  return texts;
}

function mergeTextRanges(ranges: TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Expand sentence-removal ranges so no paired quotation can be cut in half.
 * The returned ranges cover complete sentences participating in every touched
 * quotation; `null` means the input or candidate is structurally ambiguous and
 * must be left for regeneration/rejection rather than mutated.
 */
function expandRangesToWholeQuotations(
  text: string,
  ranges: TextRange[],
): TextRange[] | null {
  const quotation = analyzeQuotationIntegrity(text);
  if (!quotation.balanced) return null;
  const sentences = sentenceRanges(text);
  let expanded = mergeTextRanges(ranges);

  for (const span of quotation.spans) {
    if (!expanded.some((range) => rangesOverlap(range, span))) continue;
    const participatingSentences = sentences.filter((sentence) => rangesOverlap(sentence, span));
    if (participatingSentences.length === 0) return null;
    expanded = mergeTextRanges([...expanded, ...participatingSentences]);
  }

  let retained = text;
  for (const range of [...expanded].sort((left, right) => right.start - left.start)) {
    retained = retained.slice(0, range.start) + retained.slice(range.end);
  }
  return analyzeQuotationIntegrity(retained).balanced ? expanded : null;
}

function inlineLinkRanges(paragraph: Extract<EditorialBlock, { type: "paragraph" }>): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  for (const node of paragraph.content) {
    const next = cursor + node.text.length;
    if (node.type === "link") ranges.push({ start: cursor, end: next });
    cursor = next;
  }
  return ranges;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function removeTextRanges(
  paragraph: Extract<EditorialBlock, { type: "paragraph" }>,
  ranges: TextRange[],
): Extract<EditorialBlock, { type: "paragraph" }> {
  let cursor = 0;
  const content = paragraph.content.flatMap((node) => {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;
    let retained = "";
    let localCursor = nodeStart;
    for (const range of ranges) {
      if (!rangesOverlap({ start: nodeStart, end: nodeEnd }, range)) continue;
      const keepUntil = Math.max(nodeStart, range.start);
      if (keepUntil > localCursor) {
        retained += node.text.slice(localCursor - nodeStart, keepUntil - nodeStart);
      }
      localCursor = Math.max(localCursor, Math.min(nodeEnd, range.end));
    }
    if (localCursor < nodeEnd) retained += node.text.slice(localCursor - nodeStart);
    retained = retained.replace(/\s+/g, " ");
    return retained ? [{ ...node, text: retained }] : [];
  });

  if (content.length > 0) {
    content[0].text = content[0].text.trimStart();
    content[content.length - 1].text = content[content.length - 1].text.trimEnd();
  }
  return { ...paragraph, content };
}

/**
 * Bounded deterministic guard applied after a sentence/claim removal. A removal
 * can leave a paragraph reduced to terminal punctuation only (a lone `.`, `..`,
 * `!`, `…`) or ending in a dangling stop-word followed by a period (`…to.`,
 * `…and.`). Both are malformed fragments that must never survive:
 *
 * - a punctuation-only paragraph is semantically empty and removed as a whole
 *   block (the caller renders `null` as no block);
 * - a trailing dangling `stop-word.` residue is stripped so the paragraph ends
 *   cleanly; if that empties it, the block is removed.
 *
 * The dangling-ending trim is NODE-PRESERVING: it removes the trailing dangling
 * SENTENCE as one unit across inline nodes, so links/strong/emphasis in the
 * kept prefix survive. This never deletes substantive prose and never touches
 * links or numbers outside the dangling sentence itself.
 */
const PUNCTUATION_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;

function finalizeRemovedParagraph(
  paragraph: Extract<EditorialBlock, { type: "paragraph" }>,
): Extract<EditorialBlock, { type: "paragraph" }> | null {
  const text = paragraph.content.map((node) => node.text).join("").trim();
  if (!text) return null;
  if (PUNCTUATION_ONLY_RE.test(text)) return null;

  if (hasDanglingSentenceEnding(text)) {
    // Remove the whole trailing dangling sentence ATOMICALLY (its preceding
    // words AND its stop-word + period), never a mid-sentence slice: stripping
    // only "to." from "Brands allocate budget to." would leave "Brands
    // allocate budget" — a trailing fragment without terminal punctuation.
    // The complete dangling sentence is malformed anyway, so dropping it as
    // one unit is the only meaning-preserving deterministic action.
    const ranges = sentenceRanges(text);
    const lastRange = ranges[ranges.length - 1];
    if (lastRange) {
      const prefix = text.slice(0, lastRange.start).trimEnd();
      if (prefix && /[.!?]$/.test(prefix.replace(/["”’)\]]+$/, ""))) {
        // The dangling sentence is the trailing sentence and a complete prefix
        // exists. Remove only that sentence node-preservingly so inline links
        // and emphasis inside the prefix survive. The dangling sentence itself
        // must carry no link — deleting a link to fix the ending is never
        // acceptable, so the caller aborts the removal in that case.
        const danglingLinked = inlineLinkRanges(paragraph)
          .some((link) => rangesOverlap(link, lastRange));
        if (!danglingLinked) {
          const trimmed = removeTextRanges(paragraph, [lastRange]);
          const trimmedText = trimmed.content.map((node) => node.text).join("").trim();
          if (
            trimmedText
            && !hasDanglingSentenceEnding(trimmedText)
            && !PUNCTUATION_ONLY_RE.test(trimmedText)
          ) {
            return trimmed;
          }
          // The node-preserving trim left a residue it could not clean: the
          // paragraph must not be committed in that state.
          return null;
        }
        // The dangling sentence carries a link — removing it would delete
        // protected content. The caller aborts the whole removal.
        return null;
      }
      // The dangling sentence was the whole paragraph (or the prefix is
      // itself incomplete): removing it empties the block, which the caller
      // renders as no block at all.
      return null;
    }
  }
  return paragraph;
}

// ── Format claims for logging ──

export function formatClaimLog(claims: ScannedClaim[]): string {
  const hard = claims.filter((c) => !c.shadow);
  const supported = hard.filter((c) => c.supported);
  const unsupported = hard.filter((c) => !c.supported);
  const shadow = claims.filter((c) => c.shadow);
  const lines: string[] = [];
  lines.push(`Claims found: ${hard.length} (${unsupported.length} unsupported)${shadow.length > 0 ? ` + ${shadow.length} shadow` : ""}`);
  for (const c of unsupported) {
    lines.push(
      `  [UNSUPPORTED] [${c.category}] section=${c.sectionIndex}` +
      ` verdict=${c.supportVerdict ?? "insufficient"}` +
      ` reason="${c.supportReason ?? "no compatible evidence"}"` +
      ` text="${c.text.substring(0, 80)}"`,
    );
  }
  for (const c of supported) {
    lines.push(
      `  [SUPPORTED]   [${c.category}] section=${c.sectionIndex}` +
      ` verdict=${c.supportVerdict ?? "supported"}` +
      `${c.evidenceId ? ` evidence=${c.evidenceId}` : ""}` +
      ` text="${c.text.substring(0, 80)}"`,
    );
  }
  for (const c of shadow) {
    lines.push(
      `  [SHADOW]      [${c.category}] section=${c.sectionIndex}` +
      ` verdict=${c.supportVerdict ?? "insufficient"}` +
      ` reason="${c.supportReason ?? "no compatible evidence"}"` +
      ` text="${c.text.substring(0, 80)}"`,
    );
  }
  return lines.join("\n");
}

// ── Canonical-document unsupported-claim scanner ──

export interface LocatedUnsupportedClaim extends ScannedClaim {
  componentId: string;
  blockId: string;
  /** Structured canonical surface owning the claim (Stage 3M/3N). */
  surfaceType: "editorial-block" | "editorial-heading" | "faq-question" | "faq-answer";
  /** Stable FAQ entry index for FAQ surfaces. */
  faqIndex?: number;
}

// ── Structured factual surfaces (Stage 3M/3N) ──
// Every scanned factual claim must own an authoritative canonical surface:
// an editorial block, an editorial H2 heading, or a FAQ question/answer entry.
// The scanner never derives ownership by scanning one giant rendered blob and
// guessing afterwards — it scans each canonical surface with the same
// authoritative scanFactualRisks engine, so a legitimate visible claim can
// never come back as component/block "-".

interface StructuredFactualSurface {
  surfaceType: "editorial-block" | "editorial-heading" | "faq-question" | "faq-answer";
  componentId: string;
  blockId: string;
  html: string;
  headingText?: string;
  faqIndex?: number;
}

function escapeHeadingText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectStructuredFactualSurfaces(
  doc: import("@/lib/blog/article-document").ArticleDocument,
): StructuredFactualSurface[] {
  const surfaces: StructuredFactualSurface[] = [];
  const pushBlocks = (componentId: string, blocks: EditorialBlock[]): void => {
    for (const block of blocks) {
      surfaces.push({
        surfaceType: "editorial-block",
        componentId,
        blockId: block.id,
        html: renderEditorialBlocksToWordPress([block]),
      });
    }
  };
  pushBlocks(doc.introduction.id, doc.introduction.blocks);
  for (const section of doc.sections) {
    pushBlocks(section.id, section.blocks);
    if (section.heading && section.heading.trim()) {
      surfaces.push({
        surfaceType: "editorial-heading",
        componentId: section.id,
        blockId: `${section.id}-heading`,
        html: `<!-- wp:heading {"level":2} -->\n<h2>${escapeHeadingText(section.heading)}</h2>\n<!-- /wp:heading -->`,
        headingText: section.heading,
      });
    }
  }
  pushBlocks(doc.conclusion.id, doc.conclusion.blocks);
  doc.visibleFaq.forEach((entry, index) => {
    if (entry.question && entry.question.trim()) {
      surfaces.push({
        surfaceType: "faq-question",
        componentId: "faq",
        blockId: `faq-${index}-question`,
        html: `<p>${escapeHeadingText(entry.question)}</p>`,
        faqIndex: index,
      });
    }
    const answer = entry.answerHtml || (entry.answerText ? `<p>${escapeHeadingText(entry.answerText)}</p>` : "");
    if (answer && answer.trim()) {
      surfaces.push({
        surfaceType: "faq-answer",
        componentId: "faq",
        blockId: `faq-${index}-answer`,
        html: answer,
        faqIndex: index,
      });
    }
  });
  return surfaces;
}

// ── FAQ factual semantics (Stage 3N) ──
// FAQ questions and answers use the same factual semantics as the FAQ
// sanitizer: an INTERROGATIVE sentence never asserts a fact (the sanitizer
// never scans questions at all), and a bare topic-context year in an answer
// (isTopicContextYearClaim) is not an unsupported assertion. Percentages,
// currency, metrics, comparative/market-wide claims and factual date/result
// assertions inside FAQ content remain strict.

const INTERROGATIVE_START_RE = /^(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|will|would|should|may|might|shall|have|has|had)\b/i;

function isInterrogativeSentence(sentence: string): boolean {
  const trimmed = (sentence ?? "").trim();
  if (!trimmed) return false;
  if (/[?？]\s*$/.test(trimmed)) return true;
  return INTERROGATIVE_START_RE.test(trimmed);
}

// ── Temporal heading framing (Stage 3M) ──
// A standalone year used purely as non-assertive editorial/topic framing in a
// heading ("Hong Kong Beauty Salon Marketing in 2026") is not an unsupported
// factual assertion. The exemption is heading-only, applies ONLY to a bare
// date_claim whose text is just the year, and never applies when the heading
// carries quantitative/assertive factual signals (percentages, currency,
// movement/result verbs, market-wide claims), which keep their normal rules.

const YEAR_FRAMING_CLAIM_RE = /^(?:\s*(?:in|for|of|by|from|until|heading\s+into|as\s+we\s+approach)\s*)?(?:19|20)\d{2}$/i;

const ASSERTIVE_HEADING_SIGNALS: RegExp[] = [
  /\b\d+(?:\.\d+)?%/, // percentage
  /\b(?:HK\$|US\$|[$£€¥])\s*\d[\d,]*(?:\.\d+)?/, // currency amount
  // Assertive movement/result verbs — not framing nouns like "growth".
  /\b(?:grew|rose|fell|increased|decreased|jumped|surged|dropped|climbed|declined|hit|reached|surpassed|exceeded|outpaced|doubled|tripled|halved|gained|lost|spent|saw|expect\w*|predict\w*|forecast\w*|estimat\w*|boosted|cut|reduced)\b/i,
];

function isTemporalHeadingFraming(headingText: string, claim: ScannedClaim): boolean {
  if (claim.category !== "date_claim") return false;
  if (!YEAR_FRAMING_CLAIM_RE.test(claim.text.trim())) return false;
  const heading = headingText.replace(/\s+/g, " ").trim();
  return !ASSERTIVE_HEADING_SIGNALS.some((signal) => signal.test(heading));
}

/**
 * A bare 4-digit year in a `date_claim` that is the article's own topic year
 * (present in the focus keyphrase, title, meta description or a heading) is
 * topic context, not a precise factual assertion. For a topic-year article
 * ("Hong Kong Marketing Trends 2026") the year legitimately appears in every
 * section and in synthesis-only FAQ questions/answers; treating it as an
 * unsupported claim would block the article on content that merely names the
 * topic. Shared by the claim-ownership scanner and the structured FAQ
 * surfaces, matching the FAQ sanitizer's semantics exactly.
 */
export function isTopicContextYearClaim(
  claim: ScannedClaim,
  topicContext: { keyphrase: string; title?: string; metaDescription?: string; headings?: string[] },
): boolean {
  if (claim.category !== "date_claim") return false;
  const year = claim.text.trim();
  if (!/^(?:19|20)\d{2}$/.test(year)) return false;
  const haystack = [
    topicContext.keyphrase,
    topicContext.title ?? "",
    topicContext.metaDescription ?? "",
    ...(topicContext.headings ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(year.toLowerCase());
}

/**
 * THE authoritative absolute unsupported-claim verification over the canonical
 * ArticleDocument. This is the ONLY scanner the factual boundaries (factual-scan,
 * factual-final, final-preflight) and the final-QC gate use for unsupported
 * claims, so they can never disagree about which claim is unsupported and where
 * it lives. It scans each canonical surface (editorial blocks + editorial H2
 * headings) with the same `scanFactualRisks` the removal producer uses, and
 * assigns the claim to the surface that owns it. A legitimate visible claim is
 * never returned as component/block "-".
 */
export function scanUnsupportedClaimsInDocument(
  doc: import("@/lib/blog/article-document").ArticleDocument,
  keyphrase: string,
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
  options?: FactualScanOptions,
): LocatedUnsupportedClaim[] {
  const topicContext = {
    keyphrase,
    title: doc.metadata.title,
    metaDescription: doc.metadata.metaDescription,
    headings: doc.sections.map((section) => section.heading),
  };
  // Explicit provenance is owned per component: intro/sections/conclusion
  // carry their own attributions and free-prose accounting; FAQ is
  // synthesis-only (none).
  const attributionsByComponent = new Map<string, SourceAttribution[]>();
  const freeProseByComponent = new Map<string, string[]>();
  if (doc.introduction?.sourceAttributions?.length) {
    attributionsByComponent.set(doc.introduction.id, doc.introduction.sourceAttributions);
  }
  if (doc.introduction?.freeProseSentences?.length) {
    freeProseByComponent.set(doc.introduction.id, doc.introduction.freeProseSentences);
  }
  for (const section of doc.sections) {
    if (section.sourceAttributions?.length) {
      attributionsByComponent.set(section.id, section.sourceAttributions);
    }
    if (section.freeProseSentences?.length) {
      freeProseByComponent.set(section.id, section.freeProseSentences);
    }
  }
  if (doc.conclusion?.sourceAttributions?.length) {
    attributionsByComponent.set(doc.conclusion.id, doc.conclusion.sourceAttributions);
  }
  if (doc.conclusion?.freeProseSentences?.length) {
    freeProseByComponent.set(doc.conclusion.id, doc.conclusion.freeProseSentences);
  }
  const located: LocatedUnsupportedClaim[] = [];
  for (const surface of collectStructuredFactualSurfaces(doc)) {
    const surfaceOptions: FactualScanOptions = options
      ? {
          ...options,
          declaredAttributions: attributionsByComponent.get(surface.componentId) ?? [],
          freeProseSentences: freeProseByComponent.get(surface.componentId) ?? [],
        }
      : {
          declaredAttributions: attributionsByComponent.get(surface.componentId) ?? [],
          freeProseSentences: freeProseByComponent.get(surface.componentId) ?? [],
        };
    const unsupported = scanFactualRisks(surface.html, keyphrase, research, surfaceOptions).claims
      .filter((claim) => !claim.supported && !claim.shadow);
    for (const claim of unsupported) {
      if (
        surface.surfaceType === "editorial-heading"
        && surface.headingText
        && isTemporalHeadingFraming(surface.headingText, claim)
      ) {
        continue; // harmless temporal year framing in a heading
      }
      if (
        surface.surfaceType === "faq-question"
        && isInterrogativeSentence(claim.sentenceText ?? claim.text)
      ) {
        continue; // a question never asserts a fact (FAQ sanitizer semantics)
      }
      if (
        surface.surfaceType === "faq-answer"
        && isTopicContextYearClaim(claim, topicContext)
      ) {
        continue; // bare topic-context year in an FAQ answer (sanitizer semantics)
      }
      located.push({
        ...claim,
        componentId: surface.componentId,
        blockId: surface.blockId,
        surfaceType: surface.surfaceType,
        ...(surface.faqIndex !== undefined ? { faqIndex: surface.faqIndex } : {}),
      });
    }
  }
  return located;
}
