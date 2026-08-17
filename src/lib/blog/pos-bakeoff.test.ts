// ── Stage 3C: isolated contextual POS/NLP bake-off (EVALUATION ONLY) ──
// Compares the current B2I finite-predicate detector against B2I + wink-pos-tagger
// and B2I + compromise on a gold corpus reused from existing regression fixtures.
// This harness is NOT production code: it imports the two NLP packages only here,
// never from intro/section/FAQ/conclusion/mutators, and it never changes the
// production verdict (analyzeSentenceCompleteness) or producer-content-contract.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { analyzeSentenceCompleteness, type SentenceCompletenessKind } from "@/lib/blog/sentence-completeness";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const WinkPosTagger = requireCjs("wink-pos-tagger") as unknown as new () => {
  tagSentence(text: string): Array<{ value: string; tag: string; pos: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const nlp = requireCjs("compromise") as unknown as (text: string) => {
  out(format: "json"): Array<{ text: string; terms: Array<{ text: string; tags: string[]; post: string }> }>;
  terms(): { out(format: "array"): string[] };
};

// ── Gold corpus (labels match existing regression fixtures) ──

interface CorpusEntry {
  text: string;
  label: "valid" | "invalid";
  kind: SentenceCompletenessKind;
  category: string;
  source: string;
}

const PAR = "paragraph" as const;
const FAQ = "faq-answer" as const;

const CORPUS: CorpusEntry[] = [
  // ── Previously proven production cases ──
  { text: "When feedback arrives, respond quickly and personally.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "live production snapshot 2026-08-17" },
  { text: "Customers repeat their orders every week.", label: "valid", kind: PAR, category: "subject+ambiguous-verb", source: "sentence-completeness.test.ts" },
  { text: "Repeat the offer only when it works.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "Repeat customers are valuable.", label: "valid", kind: PAR, category: "modifier+copula", source: "sentence-completeness.test.ts" },
  { text: "Build stronger relationships with regular customers.", label: "valid", kind: PAR, category: "adjective-led imperative", source: "sentence-completeness.test.ts" },
  { text: "Emphasize your signature dishes nightly.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "Delight your regulars with a small freebie.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "Showcase your best tables by the window.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "Highlight the loyalty discount on every receipt.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "A stronger digital presence for repeat guests.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "producer-content-contract.test.ts" },
  { text: "Local restaurants with stronger repeat business.", label: "invalid", kind: PAR, category: "modifier fragment", source: "producer-content-contract.test.ts" },
  // ── Ordinary declaratives ──
  { text: "Local teams share useful lessons from daily work with clear and honest words.", label: "valid", kind: PAR, category: "declarative", source: "producer-content-contract.test.ts" },
  { text: "Audiences trust peers more than ads.", label: "valid", kind: PAR, category: "declarative", source: "editorial-hardening-regression.test.ts" },
  { text: "The store sold 24 units in 2026.", label: "valid", kind: PAR, category: "declarative", source: "editorial-hardening-regression.test.ts" },
  { text: "Prices rose sharply this year.", label: "valid", kind: PAR, category: "declarative", source: "editorial-hardening-regression.test.ts" },
  { text: "The team improved results steadily.", label: "valid", kind: PAR, category: "declarative", source: "editorial-hardening-regression.test.ts" },
  { text: "Brands that invest early will see stronger growth.", label: "valid", kind: PAR, category: "declarative", source: "editorial-hardening-regression.test.ts" },
  { text: "Hong Kong is a global business hub.", label: "valid", kind: PAR, category: "proper-noun", source: "editorial-hardening-regression.test.ts" },
  // ── Questions / inversion ──
  { text: "What is the best platform for Hong Kong?", label: "valid", kind: PAR, category: "question", source: "faq-producer-validation.test.ts" },
  { text: "How does the loyalty programme work?", label: "valid", kind: PAR, category: "question", source: "faq-producer-validation.test.ts" },
  { text: "Is the menu fresh today?", label: "valid", kind: PAR, category: "inversion", source: "new shape" },
  // ── Imperatives ──
  { text: "Keep your menu easy to scan.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "Improve your booking flow for repeat guests.", label: "valid", kind: PAR, category: "imperative", source: "sentence-completeness.test.ts" },
  { text: "Focus on the guests who return every single month.", label: "valid", kind: PAR, category: "imperative", source: "producer-content-contract.test.ts" },
  // ── Subordinate + imperative / declarative main clause ──
  { text: "When a guest complains, apologise quickly.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "new shape A" },
  { text: "If they mention slow service, fix it immediately.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "new shape A" },
  { text: "When feedback arrives, the team responds quickly.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "new shape B" },
  { text: "When feedback arrives, we respond quickly.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "new shape B" },
  { text: "When the guest finishes dinner, the waiter brings the bill.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "new shape B" },
  // ── Subordinate clause ONLY (must stay invalid) ──
  { text: "When feedback arrives today.", label: "invalid", kind: PAR, category: "subordinate-only", source: "new shape C" },
  { text: "When the guest finishes dinner.", label: "invalid", kind: PAR, category: "subordinate-only", source: "new shape C" },
  { text: "If the guest complained.", label: "invalid", kind: PAR, category: "subordinate-only", source: "new shape C" },
  { text: "When feedback arrives.", label: "invalid", kind: PAR, category: "subordinate-only short", source: "new shape C" },
  // ── Contractions / auxiliaries ──
  { text: "It's a chance to show customers that their opinion matters.", label: "valid", kind: PAR, category: "contraction", source: "new shape" },
  { text: "We'll pass the compliment to the kitchen.", label: "valid", kind: PAR, category: "contraction", source: "new shape" },
  { text: "They're telling you they care about your restaurant.", label: "valid", kind: PAR, category: "contraction", source: "new shape" },
  { text: "The team can emphasize quality in every reply.", label: "valid", kind: PAR, category: "auxiliary", source: "producer-content-contract.test.ts" },
  { text: "Customers will return for the experience.", label: "valid", kind: PAR, category: "auxiliary", source: "new shape" },
  { text: "You should apologise sincerely.", label: "valid", kind: PAR, category: "auxiliary", source: "new shape" },
  // ── -ed / -ing forms ──
  { text: "The repaired section contains complete professional prose.", label: "valid", kind: PAR, category: "-ed participle", source: "blog-generation-service.test.ts" },
  { text: "Having a clear plan keeps the work steady.", label: "valid", kind: PAR, category: "-ing form", source: "new shape" },
  // ── FAQ answers ──
  { text: "Yes.", label: "valid", kind: FAQ, category: "faq-answer short", source: "faq-producer-validation.test.ts" },
  { text: "Daily.", label: "valid", kind: FAQ, category: "faq-answer short", source: "faq-producer-validation.test.ts" },
  { text: "Yes, daily.", label: "valid", kind: FAQ, category: "faq-answer short", source: "faq-producer-validation.test.ts" },
  { text: "Members enjoy free delivery on every order.", label: "valid", kind: FAQ, category: "faq-answer", source: "faq-producer-validation.test.ts" },
  { text: "Consistent rewards keep customers coming back.", label: "valid", kind: FAQ, category: "faq-answer", source: "faq-producer-validation.test.ts" },
  // ── Hong Kong / proper-noun prose ──
  { text: "The Eatitgo App helps restaurants give the appearance of a busy place.", label: "valid", kind: PAR, category: "proper-noun", source: "live section snapshot" },
  // ── Genuine fragments (must stay invalid) ──
  { text: "Better customer retention for restaurants.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "producer-content-contract.test.ts" },
  { text: "Free delivery for members.", label: "invalid", kind: PAR, category: "no-finite-predicate", source: "producer-content-contract.test.ts" },
  { text: "More visibility across social media platforms.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "producer-content-contract.test.ts" },
  { text: "Customer loyalty through better service.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "producer-content-contract.test.ts" },
  { text: "Strong digital presence for local brands.", label: "invalid", kind: PAR, category: "modifier fragment", source: "producer-content-contract.test.ts" },
  { text: "Native social videos with narrative, emotional value, and a duration under 60 seconds.", label: "invalid", kind: PAR, category: "modifier fragment", source: "trailing-fragment-regression.test.ts" },
  { text: "Another complete sentence to.", label: "invalid", kind: PAR, category: "trailing fragment", source: "final-qc-fragment-regression.test.ts" },
  { text: "The menu is ready for the", label: "invalid", kind: PAR, category: "trailing fragment", source: "producer-content-contract.test.ts" },
  // ── Shape E: noun phrase containing a verb-lexicon word as modifier ──
  { text: "More repeat strategies for local teams.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb word", source: "new shape E" },
  // ── Shape F: subject + ambiguous base-form verb ──
  { text: "Customers arrive on time.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "new shape F" },
  { text: "Teams respond to every review.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "new shape F" },
  // ── Shape G: modifier + ambiguous verb-looking token ──
  { text: "Better repeat plans for the season.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb-looking token", source: "new shape G" },
];

// ── Conservative assisted classifier (POS is a SECONDARY signal) ──

const SUBORDINATORS = new Set(["when", "if", "because", "although", "though", "since", "unless", "until", "while", "after", "before", "as", "whereas", "once"]);
const DETERMINERS = new Set(["a", "an", "the", "this", "that", "these", "those", "my", "our", "your", "their", "his", "her", "its", "another", "each", "every"]);

interface PosToken {
  word: string;
  isVerbFinite: boolean;
  isNoun: boolean;
  isPronoun: boolean;
  isDeterminer: boolean;
  isComma: boolean;
}

function winkTokens(text: string, tagger: { tagSentence(t: string): Array<{ value: string; tag: string; pos: string }> }): PosToken[] {
  return tagger.tagSentence(text).map((item) => ({
    word: item.value,
    isVerbFinite: item.tag === "word" && ["VB", "VBP", "VBZ", "VBD"].includes(item.pos),
    isNoun: item.tag === "word" && ["NN", "NNS", "NNP", "NNPS"].includes(item.pos),
    isPronoun: item.tag === "word" && ["PRP", "PRP$"].includes(item.pos),
    isDeterminer: item.tag === "word" && ["DT", "PDT"].includes(item.pos),
    isComma: item.tag === "punctuation" && item.pos === ",",
  }));
}

function compromiseTokens(text: string): PosToken[] {
  const json = nlp(text).out("json");
  const terms = json[0]?.terms ?? [];
  const tokens: PosToken[] = [];
  for (const term of terms) {
    tokens.push({
      word: term.text,
      isVerbFinite: term.tags.includes("Verb") && (term.tags.includes("PresentTense") || term.tags.includes("PastTense") || !term.tags.includes("Gerund")),
      isNoun: term.tags.includes("Noun"),
      isPronoun: term.tags.includes("Pronoun"),
      isDeterminer: term.tags.includes("Determiner") || term.tags.includes("Conjunction") === false && /^(?:a|an|the)$/i.test(term.text),
      isComma: term.post.includes(","),
    });
  }
  return tokens;
}

/** POS evidence may ADD validity to a B2I-invalid sentence, never remove it, and
 *  only when there is strong clause evidence of a genuine main-clause finite
 *  predicate (a subject before a predicate, an imperative, or a main clause
 *  after a subordinate clause). It never accepts a bare noun phrase, a
 *  subordinate-only clause, or a verb-word used as a noun premodifier. */
function assistedIsComplete(currentVerdict: boolean, tokens: PosToken[]): boolean {
  if (currentVerdict) return true;
  if (tokens.length === 0) return false;
  const predicates = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.isVerbFinite)
    .filter(({ token, index }) => {
      const next = tokens[index + 1];
      return !next || !next.isNoun; // verb directly before a noun = premodifier
    })
    .map(({ index }) => index);
  if (predicates.length === 0) return false;
  const first = tokens[0];
  if (SUBORDINATORS.has(first.word.toLowerCase())) {
    const commaIndex = tokens.findIndex((token) => token.isComma);
    if (commaIndex === -1) return false;
    if (!predicates.some((index) => index > commaIndex)) return false;
  }
  if (DETERMINERS.has(first.word.toLowerCase())) return false;
  return predicates.some((index) => {
    const before = tokens.slice(0, index);
    const hasSubject = before.some((token) => token.isNoun || token.isPronoun);
    const clauseInitial = index === 0 || tokens[index - 1]?.isComma || before.filter((token) => !token.isComma).length === 0;
    return hasSubject || clauseInitial;
  });
}

function evaluate() {
  const tagger = new WinkPosTagger();
  const rows = CORPUS.map((entry) => {
    const b2i = analyzeSentenceCompleteness(entry.text, entry.kind).complete;
    const wink = winkTokens(entry.text, tagger);
    const cmp = compromiseTokens(entry.text);
    return {
      ...entry,
      b2i,
      winkAssisted: assistedIsComplete(b2i, wink),
      compromiseAssisted: assistedIsComplete(b2i, cmp),
      winkVerbTokens: wink.filter((t) => t.isVerbFinite).map((t) => t.word),
      cmpVerbTokens: cmp.filter((t) => t.isVerbFinite).map((t) => t.word),
    };
  });

  const stats = (predicate: (row: (typeof rows)[number]) => boolean) => {
    const tp = rows.filter((r) => r.label === "valid" && predicate(r)).length;
    const tn = rows.filter((r) => r.label === "invalid" && !predicate(r)).length;
    const fp = rows.filter((r) => r.label === "invalid" && predicate(r)).map((r) => r.text);
    const fn = rows.filter((r) => r.label === "valid" && !predicate(r)).map((r) => r.text);
    return { tp, tn, fp, fn, fpCount: fp.length, fnCount: fn.length };
  };

  return {
    corpusSize: rows.length,
    rows,
    current: stats((r) => r.b2i),
    winkAssisted: stats((r) => r.winkAssisted),
    compromiseAssisted: stats((r) => r.compromiseAssisted),
  };
}

describe("Stage 3C POS bake-off (evaluation only)", () => {
  it("runs the bake-off and writes the report", () => {
    const report = evaluate();
    const outPath = path.resolve("debug", "pos-bakeoff-report.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    // Keep the harness green and self-documenting.
    expect(report.corpusSize).toBeGreaterThan(30);
    expect(report.rows).toHaveLength(report.corpusSize);
  });
});
