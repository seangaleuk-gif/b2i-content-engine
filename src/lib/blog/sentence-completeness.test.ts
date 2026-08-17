import { describe, expect, it } from "vitest";
import {
  analyzeSentenceCompleteness,
  hasFinitePredicate,
  opensWithImperativeVerb,
} from "@/lib/blog/sentence-completeness";

function complete(text: string): boolean {
  return analyzeSentenceCompleteness(text, "paragraph").complete;
}

describe("finite-predicate imperative recognition", () => {
  it("accepts the four proven imperative false positives", () => {
    for (const sentence of [
      "Emphasize your signature dishes nightly.",
      "Delight your regulars with a small freebie.",
      "Showcase your best tables by the window.",
      "Highlight the loyalty discount on every receipt.",
    ]) {
      expect(hasFinitePredicate(sentence), sentence).toBe(true);
      expect(complete(sentence), sentence).toBe(true);
    }
  });

  it("accepts the full required imperative VALID set", () => {
    for (const sentence of [
      "Emphasize your signature dishes nightly.",
      "Delight your regulars with a small freebie.",
      "Showcase your best tables by the window.",
      "Highlight the loyalty discount on every receipt.",
      "Improve your booking flow for repeat guests.",
      "Keep your menu easy to scan.",
      "Build stronger relationships with regular customers.",
    ]) {
      expect(hasFinitePredicate(sentence), sentence).toBe(true);
      expect(complete(sentence), sentence).toBe(true);
    }
  });

  it("accepts adjective-led objects after an imperative verb", () => {
    for (const sentence of [
      // Adjective-led object with an in-lexicon verb.
      "Build stronger relationships with regular customers.",
      // Adjective-led object with an out-of-lexicon but probable verb (suffix).
      "Emphasize strong relationships with regular customers.",
      "Advertise fresh specials every single week.",
      "Strengthen weak relationships with regular clients.",
      "Improve customer relations through better service.",
    ]) {
      expect(hasFinitePredicate(sentence), sentence).toBe(true);
      expect(complete(sentence), sentence).toBe(true);
      expect(opensWithImperativeVerb(sentence), sentence).toBe(true);
    }
  });

  it("rejects the full required INVALID noun-phrase fragment set", () => {
    for (const sentence of [
      "Better customer retention for restaurants.",
      "A stronger digital presence for repeat guests.",
      "More visibility across social media platforms.",
      "Customer loyalty through better service.",
      "Local restaurants with stronger repeat business.",
      "Strong digital presence for local brands.",
      "Native social videos with narrative, emotional value, and a duration under 60 seconds.",
      "Per your instructions for the next campaign.",
    ]) {
      expect(opensWithImperativeVerb(sentence), sentence).toBe(false);
      expect(hasFinitePredicate(sentence), sentence).toBe(false);
      expect(complete(sentence), sentence).toBe(false);
    }
  });

  it("accepts genuine subject + finite-verb uses of ambiguous lexicon words", () => {
    for (const sentence of [
      "Customers repeat their orders every week.",
      "Regular guests repeat the same booking pattern.",
      "Repeat the offer only when it works.",
      "Audiences trust peers more than ads.",
      "The store sold 24 units in 2026.",
      "The manager sold units.",
      "The team built new tools.",
      "Local teams adopt new tools.",
    ]) {
      expect(hasFinitePredicate(sentence), sentence).toBe(true);
      expect(complete(sentence), sentence).toBe(true);
    }
  });

  it("does not mistake sentence-internal base-form words for an imperative", () => {
    // The imperative rule only inspects the sentence-initial token. A base-form
    // verb later in the sentence is never treated as an imperative opener.
    for (const sentence of [
      "The team can emphasize quality in every reply.",
      "Restaurants highlight loyalty discounts to win repeat visits.",
      "Customers who showcase your photos become your best ambassadors.",
    ]) {
      expect(hasFinitePredicate(sentence), sentence).toBe(true);
      expect(complete(sentence), sentence).toBe(true);
    }
  });

  it("does not accept inflected, subjectless or closed-class openers as imperatives", () => {
    // 3rd-person-singular form without a subject is still a fragment.
    expect(opensWithImperativeVerb("Emphasizes your signature dishes nightly.")).toBe(false);
    expect(hasFinitePredicate("Emphasizes your signature dishes nightly.")).toBe(false);
    // Closed-class / prepositional openers are never imperatives.
    expect(opensWithImperativeVerb("Per your instructions.")).toBe(false);
    expect(opensWithImperativeVerb("More your customers value.")).toBe(false);
  });

  it("opensWithImperativeVerb accepts determiner-led and adjective-led objects but not bare-noun phrases", () => {
    // Determiner/possessive/article-led objects.
    expect(opensWithImperativeVerb("Emphasize your signature dishes nightly.")).toBe(true);
    expect(opensWithImperativeVerb("Highlight the loyalty discount on every receipt.")).toBe(true);
    // Adjective-led object of a probable verb.
    expect(opensWithImperativeVerb("Build stronger relationships with regular customers.")).toBe(true);
    expect(opensWithImperativeVerb("Emphasize strong relationships with regular customers.")).toBe(true);
    // A bare-noun object with an out-of-lexicon verb is not recognised (narrow).
    expect(opensWithImperativeVerb("Emphasize quality over quantity.")).toBe(false);
    // Noun-phrase fragments are never imperatives.
    expect(opensWithImperativeVerb("Better customer retention for restaurants.")).toBe(false);
    expect(opensWithImperativeVerb("Strong digital presence for local brands.")).toBe(false);
  });

  it("preserves auxiliary, -ed/-ing, inversion and existing prose behaviour", () => {
    for (const sentence of [
      "Prices rose sharply this year.",
      "The team improved results steadily.",
      "Brands that invest early will see stronger growth.",
      "Hong Kong is a global business hub.",
    ]) {
      expect(hasFinitePredicate(sentence), sentence).toBe(true);
      expect(complete(sentence), sentence).toBe(true);
    }
  });
});
