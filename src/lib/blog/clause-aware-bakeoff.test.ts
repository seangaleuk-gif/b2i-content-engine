// ── Stage 3D: clause-aware Compromise bake-off on an expanded gold corpus ──
// EVALUATION-ONLY. Benchmarks four systems:
//   A. Current B2I (analyzeSentenceCompleteness)
//   B. Stage 3C Compromise rescue-only policy
//   C. New clause-aware Compromise experimental classifier (clause-aware-classifier.ts)
//   D. Wink-assisted rescue-only baseline (3C policy)
// The corpus reuses every Stage 3C sentence verbatim plus many controlled
// positive/negative variants. Gold labels match the existing regression
// fixtures and the grammatical truth for the new controlled shapes.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { analyzeSentenceCompleteness, type SentenceCompletenessKind } from "@/lib/blog/sentence-completeness";
import { clauseAwareVerdict, compromiseTokens, type PosToken } from "@/lib/blog/clause-aware-classifier";
import { decideSentenceCompletenessHybrid } from "@/lib/blog/hybrid-sentence-completeness";

const requireCjs = createRequire(import.meta.url);
const WinkPosTagger = requireCjs("wink-pos-tagger") as unknown as new () => {
  tagSentence(text: string): Array<{ value: string; tag: string; pos: string }>;
};

// ── Corpus ──

interface CorpusEntry {
  text: string;
  label: "valid" | "invalid";
  kind: SentenceCompletenessKind;
  category: string;
  source: string;
}
const PAR = "paragraph" as const;
const FAQ = "faq-answer" as const;
const SUB = "subheading" as const;

export const CORPUS: CorpusEntry[] = [
  // ── Previously proven production cases (Stage 3C corpus, verbatim) ──
  { text: "When feedback arrives, respond quickly and personally.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3C/live snapshot" },
  { text: "Customers repeat their orders every week.", label: "valid", kind: PAR, category: "subject+ambiguous-verb", source: "3C" },
  { text: "Repeat the offer only when it works.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "Repeat customers are valuable.", label: "valid", kind: PAR, category: "modifier+copula", source: "3C" },
  { text: "Build stronger relationships with regular customers.", label: "valid", kind: PAR, category: "adjective-led imperative", source: "3C" },
  { text: "Emphasize your signature dishes nightly.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "Delight your regulars with a small freebie.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "Showcase your best tables by the window.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "Highlight the loyalty discount on every receipt.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "A stronger digital presence for repeat guests.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "3C" },
  { text: "Local restaurants with stronger repeat business.", label: "invalid", kind: PAR, category: "modifier fragment", source: "3C" },
  { text: "Local teams share useful lessons from daily work with clear and honest words.", label: "valid", kind: PAR, category: "declarative", source: "3C" },
  { text: "Audiences trust peers more than ads.", label: "valid", kind: PAR, category: "declarative", source: "3C" },
  { text: "The store sold 24 units in 2026.", label: "valid", kind: PAR, category: "declarative", source: "3C" },
  { text: "Prices rose sharply this year.", label: "valid", kind: PAR, category: "declarative", source: "3C" },
  { text: "The team improved results steadily.", label: "valid", kind: PAR, category: "declarative", source: "3C" },
  { text: "Brands that invest early will see stronger growth.", label: "valid", kind: PAR, category: "declarative", source: "3C" },
  { text: "Hong Kong is a global business hub.", label: "valid", kind: PAR, category: "proper-noun", source: "3C" },
  { text: "What is the best platform for Hong Kong?", label: "valid", kind: PAR, category: "question", source: "3C" },
  { text: "How does the loyalty programme work?", label: "valid", kind: PAR, category: "question", source: "3C" },
  { text: "Is the menu fresh today?", label: "valid", kind: PAR, category: "inversion", source: "3C" },
  { text: "Keep your menu easy to scan.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "Improve your booking flow for repeat guests.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "Focus on the guests who return every single month.", label: "valid", kind: PAR, category: "imperative", source: "3C" },
  { text: "When a guest complains, apologise quickly.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3C" },
  { text: "If they mention slow service, fix it immediately.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3C" },
  { text: "When feedback arrives, the team responds quickly.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3C" },
  { text: "When feedback arrives, we respond quickly.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3C" },
  { text: "When the guest finishes dinner, the waiter brings the bill.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3C" },
  { text: "When feedback arrives today.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3C" },
  { text: "When the guest finishes dinner.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3C" },
  { text: "If the guest complained.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3C" },
  { text: "When feedback arrives.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3C" },
  { text: "It's a chance to show customers that their opinion matters.", label: "valid", kind: PAR, category: "contraction", source: "3C" },
  { text: "We'll pass the compliment to the kitchen.", label: "valid", kind: PAR, category: "contraction", source: "3C" },
  { text: "They're telling you they care about your restaurant.", label: "valid", kind: PAR, category: "contraction", source: "3C" },
  { text: "The team can emphasize quality in every reply.", label: "valid", kind: PAR, category: "auxiliary", source: "3C" },
  { text: "Customers will return for the experience.", label: "valid", kind: PAR, category: "auxiliary", source: "3C" },
  { text: "You should apologise sincerely.", label: "valid", kind: PAR, category: "auxiliary", source: "3C" },
  { text: "The repaired section contains complete professional prose.", label: "valid", kind: PAR, category: "-ed", source: "3C" },
  { text: "Having a clear plan keeps the work steady.", label: "valid", kind: PAR, category: "-ing", source: "3C" },
  { text: "Yes.", label: "valid", kind: FAQ, category: "faq-answer short", source: "3C" },
  { text: "Daily.", label: "valid", kind: FAQ, category: "faq-answer short", source: "3C" },
  { text: "Yes, daily.", label: "valid", kind: FAQ, category: "faq-answer short", source: "3C" },
  { text: "Members enjoy free delivery on every order.", label: "valid", kind: FAQ, category: "faq-answer", source: "3C" },
  { text: "Consistent rewards keep customers coming back.", label: "valid", kind: FAQ, category: "faq-answer", source: "3C" },
  { text: "The Eatitgo App helps restaurants give the appearance of a busy place.", label: "valid", kind: PAR, category: "proper-noun", source: "3C/snapshot" },
  { text: "Better customer retention for restaurants.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "3C" },
  { text: "Free delivery for members.", label: "invalid", kind: PAR, category: "no-finite-predicate", source: "3C" },
  { text: "More visibility across social media platforms.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "3C" },
  { text: "Customer loyalty through better service.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "3C" },
  { text: "Strong digital presence for local brands.", label: "invalid", kind: PAR, category: "modifier fragment", source: "3C" },
  { text: "Native social videos with narrative, emotional value, and a duration under 60 seconds.", label: "invalid", kind: PAR, category: "modifier fragment", source: "3C" },
  { text: "Another complete sentence to.", label: "invalid", kind: PAR, category: "trailing fragment", source: "3C" },
  { text: "The menu is ready for the", label: "invalid", kind: PAR, category: "trailing fragment", source: "3C" },
  { text: "More repeat strategies for local teams.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb word", source: "3C" },
  { text: "Customers arrive on time.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3C" },
  { text: "Teams respond to every review.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3C" },
  { text: "Better repeat plans for the season.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb-looking token", source: "3C" },

  // ── Subordinate + imperative (positive) ──
  { text: "Whenever a guest calls, thank them by name.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3D control" },
  { text: "After the meal ends, send a quick follow-up.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3D control" },
  { text: "Before you open, greet the first guests warmly.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3D control" },
  { text: "While they wait, offer them water.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3D control" },
  { text: "Once they arrive, welcome them personally.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3D control" },
  { text: "If they mention a problem, fix it on the spot.", label: "valid", kind: PAR, category: "subordinate+imperative", source: "3D control" },

  // ── Subordinate + declarative (positive) ──
  { text: "Because regulars return, the staff smiles.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "Although the queue is long, guests stay calm.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "Unless the menu changes, prices hold steady.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "While the kitchen runs, the team cleans.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "After the rush ends, staff rest.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "Before they leave, we thank them.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "Once the doors close, the team reviews the day.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },
  { text: "Whenever the phone rings, someone answers.", label: "valid", kind: PAR, category: "subordinate+declarative", source: "3D control" },

  // ── Subordinate-only fragments (negative) ──
  { text: "Because the queue is long.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "Although the menu changes.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "While the kitchen runs.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "After the rush ends.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "Before they leave.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "Once the doors close.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "Whenever the phone rings.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "Unless the menu changes.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "When the guest complained.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "If they mentioned the wait.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "After the rush ended.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },
  { text: "Before the kitchen closed.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },

  // ── Ordinary imperatives (positive) ──
  { text: "Respond quickly to every review.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "Thank them for their honesty.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "Fix the problem before they leave.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "Send a follow-up after the visit.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "Welcome every guest with a smile.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "Mention something specific they said.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "Turn every comment into a reason to return.", label: "valid", kind: PAR, category: "imperative", source: "3D control" },
  { text: "So make feedback work for you, and turn every comment into a reason to return.", label: "valid", kind: PAR, category: "coordinator+imperative", source: "production snapshot" },

  // ── Adverbial-initial imperative (positive; live 3F failure unit) ──
  // Stage 3F live run: Block 7 of section 4 ("Training Your Team to Deliver
  // Service Worth Returning For") failed authoritative `no-finite-predicate` on
  // exactly this sentence. It is grammatically a valid imperative preceded by
  // the adverbial "Instead,". "weave" is not in the curated finite-verb
  // lexicon, so the deterministic analyzer cannot see the predicate; the
  // clause-aware classifier recognizes the comma-initial imperative.
  { text: "Instead, weave service skills into your weekly routine.", label: "valid", kind: PAR, category: "adverbial-initial imperative", source: "3F/live snapshot" },

  // ── Stage 3I: live production rejection + generic controls ──
  // The first controlled live rollout (ENABLE_HYBRID_SENTENCE_COMPLETENESS=true)
  // falsely rejected the valid live sentence below via nlp-reject
  // reason=subordinate-main-clause (Compromise tags the main-clause imperative
  // "take" as a Noun). Nearby generic controls exercise the same families:
  // subordinate clause + imperative/declarative main clause (valid), and
  // genuinely subordinate-only fragments (invalid). No exact-text exceptions.
  { text: "When someone tells you what they loved or what went wrong, take it seriously.", label: "valid", kind: PAR, category: "subordinate clause + imperative main clause", source: "3I/live production" },
  { text: "Respond to comments and messages promptly.", label: "valid", kind: PAR, category: "imperative", source: "3I/live production" },
  { text: "When a guest leaves a review, reply within a day.", label: "valid", kind: PAR, category: "subordinate clause + imperative main clause", source: "3I control" },
  { text: "If someone praises the team, thank them publicly.", label: "valid", kind: PAR, category: "subordinate clause + imperative main clause", source: "3I control" },
  { text: "Whenever a complaint arrives, handle it calmly.", label: "valid", kind: PAR, category: "subordinate clause + imperative main clause", source: "3I control" },
  { text: "When someone raises a concern, the team responds.", label: "valid", kind: PAR, category: "subordinate + declarative main clause", source: "3I control" },
  { text: "If a guest asks a question, staff answer it.", label: "valid", kind: PAR, category: "subordinate + declarative main clause", source: "3I control" },
  { text: "When he arrives, we leave.", label: "valid", kind: PAR, category: "subordinate + declarative main clause", source: "3I control" },
  { text: "When he arrives we leave.", label: "valid", kind: PAR, category: "subordinate + declarative main clause (no comma)", source: "3I control" },
  { text: "When someone tells you what they loved.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3I control" },
  { text: "If someone praises the team.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3I control" },
  { text: "Whenever a complaint arrives.", label: "invalid", kind: PAR, category: "subordinate-only", source: "3I control" },

  // ── British English verb forms (positive) ──
  { text: "They organise the roster every week.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "We recognise returning guests by name.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "Chefs specialise in local dishes.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "The team summarises the feedback daily.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "Guests emphasise what they value.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "We analyse the survey results monthly.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "If the bill is wrong, apologise at once.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },
  { text: "When a guest complains, apologise sincerely.", label: "valid", kind: PAR, category: "british-english", source: "3D control" },

  // ── Ambiguous noun/verb words: subject + verb (positive) ──
  { text: "Customers plan their visits.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3D control" },
  { text: "Teams offer discounts on slow nights.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3D control" },
  { text: "Guests return for the experience.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3D control" },
  { text: "Regulars visit on weekends.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3D control" },
  { text: "We email the menu each week.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3D control" },
  { text: "Special offers attract new guests.", label: "valid", kind: PAR, category: "subject+ambiguous base verb", source: "3D control" },
  { text: "The host greets every table.", label: "valid", kind: PAR, category: "declarative", source: "3D control" },

  // ── Ambiguous noun/verb words: modifier fragments (negative) ──
  { text: "Digital marketing plans for the season.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb-looking token", source: "3D control" },
  { text: "Seasonal plans for the kitchen.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb-looking token", source: "3D control" },
  { text: "Repeat business for local teams.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb-looking token", source: "3D control" },
  { text: "Limited time offers for members.", label: "invalid", kind: PAR, category: "modifier+ambiguous verb-looking token", source: "3D control" },
  { text: "Early-bird specials every day.", label: "invalid", kind: PAR, category: "modifier fragment", source: "3D control" },

  // ── Questions / inversion (positive) ──
  { text: "When does the restaurant close?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Where do guests park?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Why do customers return?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Who arrives first?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "What happened last night?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Can we book a table?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Do you take reservations?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Will they come back?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "Are you open on Mondays?", label: "valid", kind: PAR, category: "question", source: "3D control" },
  { text: "When feedback arrives?", label: "invalid", kind: PAR, category: "subordinate-only", source: "3D control" },

  // ── Relative clauses (positive) ──
  { text: "Guests who return often know the staff.", label: "valid", kind: PAR, category: "relative clause", source: "3D control" },
  { text: "A strategy that works is worth repeating.", label: "valid", kind: PAR, category: "relative clause", source: "3D control" },
  { text: "Teams that listen improve their service.", label: "valid", kind: PAR, category: "relative clause", source: "3D control" },
  { text: "Chefs who train create better dishes.", label: "valid", kind: PAR, category: "relative clause", source: "3D control" },
  { text: "The dish that sells best changes weekly.", label: "valid", kind: PAR, category: "relative clause", source: "3D control" },

  // ── Participial / gerund / infinitive (positive) ──
  { text: "Investing in staff training improves service.", label: "valid", kind: PAR, category: "gerund subject", source: "3D control" },
  { text: "Using feedback helps teams improve.", label: "valid", kind: PAR, category: "gerund subject", source: "3D control" },
  { text: "Improving service grows the business.", label: "valid", kind: PAR, category: "gerund subject", source: "3D control" },
  { text: "Training staff pays off over time.", label: "valid", kind: PAR, category: "gerund subject", source: "3D control" },
  { text: "Cooking well takes practice.", label: "valid", kind: PAR, category: "gerund subject", source: "3D control" },
  { text: "Feedback arriving daily keeps the team honest.", label: "valid", kind: PAR, category: "participial", source: "3D control" },
  { text: "To succeed, restaurants need consistency.", label: "valid", kind: PAR, category: "infinitive", source: "3D control" },
  { text: "To grow, you must listen to guests.", label: "valid", kind: PAR, category: "infinitive", source: "3D control" },
  { text: "Having a clear plan.", label: "invalid", kind: PAR, category: "participial fragment", source: "3D control" },

  // ── Contractions (positive) ──
  { text: "That's the reason they return.", label: "valid", kind: PAR, category: "contraction", source: "3D control" },
  { text: "You're welcome to call us.", label: "valid", kind: PAR, category: "contraction", source: "3D control" },
  { text: "We've kept the same menu for years.", label: "valid", kind: PAR, category: "contraction", source: "3D control" },
  { text: "Guests won't wait forever.", label: "valid", kind: PAR, category: "contraction", source: "3D control" },
  { text: "It doesn't matter when they visit.", label: "valid", kind: PAR, category: "contraction", source: "3D control" },

  // ── Auxiliaries (positive) ──
  { text: "The kitchen must stay clean.", label: "valid", kind: PAR, category: "auxiliary", source: "3D control" },
  { text: "They may offer a discount.", label: "valid", kind: PAR, category: "auxiliary", source: "3D control" },
  { text: "Staff could improve their responses.", label: "valid", kind: PAR, category: "auxiliary", source: "3D control" },

  // ── Coordinated clauses (positive) ──
  { text: "Guests eat well and they return often.", label: "valid", kind: PAR, category: "coordinated", source: "3D control" },
  { text: "The team listens and they adapt quickly.", label: "valid", kind: PAR, category: "coordinated", source: "3D control" },
  { text: "Feedback helps and customers notice.", label: "valid", kind: PAR, category: "coordinated", source: "3D control" },

  // ── Short FAQ answers (positive) ──
  { text: "No.", label: "valid", kind: FAQ, category: "faq-answer short", source: "3D control" },
  { text: "Twice a week.", label: "valid", kind: FAQ, category: "faq-answer short", source: "3D control" },
  { text: "Once a month.", label: "valid", kind: FAQ, category: "faq-answer short", source: "3D control" },
  { text: "Both options work.", label: "valid", kind: FAQ, category: "faq-answer", source: "3D control" },

  // ── Headings (structural kind, no finite predicate required) ──
  { text: "Choose the Right Space", label: "valid", kind: SUB, category: "heading", source: "3D control" },
  { text: "Turn complaints into loyalty", label: "valid", kind: SUB, category: "heading", source: "production snapshot" },
  { text: "Make your place feel welcoming", label: "valid", kind: SUB, category: "heading", source: "production snapshot" },
  { text: "Turning Insights into Action", label: "valid", kind: SUB, category: "heading", source: "production snapshot" },
  { text: "Act on what you hear", label: "valid", kind: SUB, category: "heading", source: "production snapshot" },
  { text: "Measure what matters", label: "valid", kind: SUB, category: "heading", source: "3D control" },

  // ── Noun-phrase fragments (negative) ──
  { text: "A stronger presence for local brands.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "3D control" },
  { text: "An honest thank you to every guest.", label: "invalid", kind: PAR, category: "noun-phrase fragment", source: "3D control" },
  { text: "Walk-ins welcome.", label: "invalid", kind: PAR, category: "modifier fragment", source: "3D control" },

  // ── Trailing fragments (negative) ──
  { text: "Pick your favourite dish for", label: "invalid", kind: PAR, category: "trailing fragment", source: "3D control" },
  { text: "We asked them if", label: "invalid", kind: PAR, category: "trailing fragment", source: "3D control" },
  { text: "They decided to", label: "invalid", kind: PAR, category: "trailing fragment", source: "3D control" },

  // ── Prose from production snapshots (positive) ──
  { text: "Feedback is more than a way to measure how you're doing.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
  { text: "Negative feedback can be uncomfortable, but it's also a gift.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
  { text: "Collecting feedback is only the first step.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
  { text: "Share what you learn with your team.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
  { text: "You can also use feedback to shape your marketing.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
  { text: "Remember, feedback is a conversation, not a one-way street.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
  { text: "That feeling keeps them coming back.", label: "valid", kind: PAR, category: "production prose", source: "snapshot" },
];

// ── Stage 3C rescue-only policy (systems B and D) ──

const SUBORDINATORS = new Set(["when", "if", "because", "although", "though", "since", "unless", "until", "while", "after", "before", "as", "whereas", "once"]);
const DETERMINERS = new Set(["a", "an", "the", "this", "that", "these", "those", "my", "our", "your", "their", "his", "her", "its", "another", "each", "every"]);

function rescueOnlyAssisted(currentVerdict: boolean, tokens: PosToken[]): boolean {
  if (currentVerdict) return true;
  if (tokens.length === 0) return false;
  const predicates = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.isVerbFinite)
    .filter(({ index }) => {
      const next = tokens[index + 1];
      return !next || !next.isNoun;
    })
    .map(({ index }) => index);
  if (predicates.length === 0) return false;
  const first = tokens[0];
  if (SUBORDINATORS.has(first.word)) {
    const commaIndex = tokens.findIndex((token) => token.isComma);
    if (commaIndex === -1) return false;
    if (!predicates.some((index) => index > commaIndex)) return false;
  }
  if (DETERMINERS.has(first.word)) return false;
  return predicates.some((index) => {
    const before = tokens.slice(0, index);
    const hasSubject = before.some((token) => token.isNoun || token.isPronoun);
    const clauseInitial = index === 0 || tokens[index - 1]?.isComma || before.filter((token) => !token.isComma).length === 0;
    return hasSubject || clauseInitial;
  });
}

function winkTokens(text: string, tagger: { tagSentence(t: string): Array<{ value: string; tag: string; pos: string }> }): PosToken[] {
  return tagger.tagSentence(text).map((item) => ({
    word: item.value,
    isVerbFinite: item.tag === "word" && ["VB", "VBP", "VBZ", "VBD"].includes(item.pos),
    isNoun: item.tag === "word" && ["NN", "NNS", "NNP", "NNPS"].includes(item.pos),
    isPronoun: item.tag === "word" && ["PRP", "PRP$"].includes(item.pos),
    isDeterminer: item.tag === "word" && ["DT", "PDT"].includes(item.pos),
    isAdjective: item.tag === "word" && ["JJ", "JJR", "JJS"].includes(item.pos),
    isExpression: false,
    isGerund: false,
    isComma: item.tag === "punctuation" && item.pos === ",",
  }));
}

// ── Benchmark ──

function metrics(rows: Array<{ text: string; label: string; category: string; verdict: boolean }>) {
  const tp = rows.filter((r) => r.label === "valid" && r.verdict).length;
  const tn = rows.filter((r) => r.label === "invalid" && !r.verdict).length;
  const fp = rows.filter((r) => r.label === "invalid" && r.verdict).map((r) => r.text);
  const fn = rows.filter((r) => r.label === "valid" && !r.verdict).map((r) => r.text);
  const precision = tp / (tp + fp.length || 1);
  const recall = tp / (tp + fn.length || 1);
  const accuracy = (tp + tn) / rows.length;
  return { tp, tn, fpCount: fp.length, fnCount: fn.length, fp, fn, precision, recall, accuracy };
}

describe("Stage 3D clause-aware Compromise bake-off (evaluation only)", () => {
  it("benchmarks four systems on the expanded gold corpus", () => {
    const tagger = new WinkPosTagger();
    const start = Date.now();
    const rows = CORPUS.map((entry) => {
      const b2i = analyzeSentenceCompleteness(entry.text, entry.kind);
      const cmpTokens = compromiseTokens(entry.text);
      const wink = winkTokens(entry.text, tagger);
      const clauseAware = clauseAwareVerdict(entry.text, entry.kind, b2i);
      const hybrid = decideSentenceCompletenessHybrid({
        text: entry.text,
        kind: entry.kind,
        authoritative: b2i,
        experimental: clauseAware,
      }, "full-reject");
      const hybridNarrowReject = decideSentenceCompletenessHybrid({
        text: entry.text,
        kind: entry.kind,
        authoritative: b2i,
        experimental: clauseAware,
      }, "narrow-reject");
      const hybridRescueOnly = decideSentenceCompletenessHybrid({
        text: entry.text,
        kind: entry.kind,
        authoritative: b2i,
        experimental: clauseAware,
      }, "rescue-only");
      return {
        text: entry.text,
        label: entry.label,
        category: entry.category,
        kind: entry.kind,
        source: entry.source,
        current: b2i.complete,
        rescueOnlyCompromise: rescueOnlyAssisted(b2i.complete, cmpTokens),
        clauseAware: clauseAware.complete,
        clauseAwareReason: clauseAware.reason,
        hybrid: hybrid.complete,
        hybridSource: hybrid.source,
        hybridReason: hybrid.reason,
        hybridNarrowReject: hybridNarrowReject.complete,
        hybridRescueOnly: hybridRescueOnly.complete,
        rescueOnlyWink: rescueOnlyAssisted(b2i.complete, wink),
      };
    });
    const elapsed = Date.now() - start;

    const report = {
      corpusSize: rows.length,
      byCategory: (() => {
        const map = new Map<string, number>();
        for (const row of rows) map.set(row.category, (map.get(row.category) ?? 0) + 1);
        return Object.fromEntries(map);
      })(),
      elapsedMs: elapsed,
      perSentenceMs: elapsed / rows.length,
      current: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.current }))),
      rescueOnlyCompromise: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.rescueOnlyCompromise }))),
      clauseAware: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.clauseAware }))),
      hybrid: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.hybrid }))),
      hybridNarrowReject: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.hybridNarrowReject }))),
      hybridRescueOnly: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.hybridRescueOnly }))),
      rescueOnlyWink: metrics(rows.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.rescueOnlyWink }))),
      rows,
    };
    const outPath = path.resolve("debug", "clause-aware-bakeoff-report.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

    expect(report.corpusSize).toBe(184);
    // Stage 3D verified metrics on the ORIGINAL 171 sentences must hold
    // exactly (item H of Stage 3F: metrics unchanged when sentences are
    // supplied individually). The 172nd entry is the 3F live failure unit; the
    // remaining entries are the Stage 3I live-production unit and controls.
    const original171 = rows.filter(
      (row) => row.source !== "3F/live snapshot"
        && row.source !== "3I/live production"
        && row.source !== "3I control",
    );
    expect(original171).toHaveLength(171);
    const originalMetrics = metrics(original171.map((r) => ({ text: r.text, label: r.label, category: r.category, verdict: r.clauseAware })));
    expect(originalMetrics.tp).toBe(127);
    expect(originalMetrics.tn).toBe(40);
    expect(originalMetrics.fpCount).toBe(1);
    expect(originalMetrics.fnCount).toBe(3);
    expect(originalMetrics.fp).toEqual(["Repeat business for local teams."]);
    expect(originalMetrics.fn).toEqual([
      "Prices rose sharply this year.",
      "After the rush ends, staff rest.",
      "Whenever the phone rings, someone answers.",
    ]);
    // Full 184-corpus clause-aware metrics. The live sentence and the
    // comma-less subordinate+declarative control are valid sentences that
    // Compromise mis-tags (main-clause verb / no-comma subordinate-only), so
    // the full clause-aware system gains two known FNs.
    expect(report.clauseAware.tp).toBe(135);
    expect(report.clauseAware.tn).toBe(43);
    expect(report.clauseAware.fpCount).toBe(1);
    expect(report.clauseAware.fnCount).toBe(5);
    expect(report.clauseAware.fp).toEqual(["Repeat business for local teams."]);
    expect(report.clauseAware.fn).toEqual([
      "Prices rose sharply this year.",
      "After the rush ends, staff rest.",
      "Whenever the phone rings, someone answers.",
      "When someone tells you what they loved or what went wrong, take it seriously.",
      "When he arrives we leave.",
    ]);
    // The clause-aware classifier must be able to rescue every known B2I FN.
    for (const fn of report.current.fn) {
      const row = rows.find((r) => r.text === fn);
      expect(row, `must rescue: ${fn}`).toBeTruthy();
    }
    // Stage 3I policy matrix. Full-reject (B) falsely rejects the live sentence
    // AND the comma-less subordinate+declarative control; narrow-reject (D)
    // still falsely rejects the comma-less control; rescue-only (C) never
    // rejects valid English (FN 0) and its FP set equals the current-B2I FP set.
    expect(report.hybrid.tp).toBe(138);
    expect(report.hybrid.tn).toBe(32);
    expect(report.hybrid.fpCount).toBe(12);
    expect(report.hybrid.fnCount).toBe(2);
    expect(report.hybrid.fn).toEqual([
      "When someone tells you what they loved or what went wrong, take it seriously.",
      "When he arrives we leave.",
    ]);
    expect(report.hybridNarrowReject.tp).toBe(139);
    expect(report.hybridNarrowReject.tn).toBe(32);
    expect(report.hybridNarrowReject.fpCount).toBe(12);
    expect(report.hybridNarrowReject.fnCount).toBe(1);
    expect(report.hybridNarrowReject.fn).toEqual(["When he arrives we leave."]);
    expect(report.hybridRescueOnly.tp).toBe(140);
    expect(report.hybridRescueOnly.tn).toBe(19);
    expect(report.hybridRescueOnly.fpCount).toBe(25);
    expect(report.hybridRescueOnly.fnCount).toBe(0);
    expect(report.hybridRescueOnly.fn).toEqual([]);
    // Rescue-only FP set is exactly the current-B2I FP set (no new false
    // accepts) and every known current-B2I false rejection is rescued.
    expect(report.hybridRescueOnly.fp).toEqual(report.current.fp);
    expect(report.hybridRescueOnly.fp).toHaveLength(report.current.fpCount);
    for (const fn of report.current.fn) {
      expect(rows.find((r) => r.text === fn)!.hybridRescueOnly, `must rescue: ${fn}`).toBe(true);
    }
    expect(report.hybrid.fp).toEqual([
      "Better repeat plans for the season.",
      "While the kitchen runs.",
      "Once the doors close.",
      "Whenever the phone rings.",
      "Digital marketing plans for the season.",
      "Seasonal plans for the kitchen.",
      "Repeat business for local teams.",
      "Limited time offers for members.",
      "When feedback arrives?",
      "Having a clear plan.",
      "An honest thank you to every guest.",
      "Walk-ins welcome.",
    ]);
    // The live production sentence must be accepted by every candidate policy
    // EXCEPT the unsafe full-reject (B) that caused the rollout rejection.
    const live = "When someone tells you what they loved or what went wrong, take it seriously.";
    expect(rows.find((r) => r.text === live)!.hybridRescueOnly).toBe(true);
    expect(rows.find((r) => r.text === live)!.hybridNarrowReject).toBe(true);
    expect(rows.find((r) => r.text === live)!.hybrid).toBe(false);
  });
});
