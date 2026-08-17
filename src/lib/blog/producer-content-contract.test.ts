import { describe, expect, it } from "vitest";
import type { EditorialBlock } from "@/lib/blog/article-document";
import {
  dedupeProducerViolations,
  validateProducerCandidate,
  type ProducerComponentContext,
  type ProducerValidationResult,
} from "@/lib/blog/producer-content-contract";

function p(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}
function h3(id: string, text: string): EditorialBlock {
  return { id, type: "subheading", level: 3, content: [{ type: "text", text }] };
}

function ctx(overrides: Partial<ProducerComponentContext> = {}): ProducerComponentContext {
  return { componentId: "intro", componentType: "introduction", ...overrides };
}
function validateBlocks(
  blocks: EditorialBlock[],
  overrides: Partial<ProducerComponentContext> = {},
): ProducerValidationResult {
  return validateProducerCandidate({ blocks }, ctx(overrides));
}
function validateText(text: string, overrides: Partial<ProducerComponentContext> = {}): ProducerValidationResult {
  return validateBlocks([p("p0", text)], overrides);
}
function validateFaq(
  entries: Array<{ question: string; answer: string }>,
  overrides: Partial<ProducerComponentContext> = {},
): ProducerValidationResult {
  return validateProducerCandidate(
    { faqEntries: entries },
    ctx({ componentId: "faq", componentType: "faq", faqRange: { min: 1, max: 6 }, ...overrides }),
  );
}

describe("producer-content-contract: valid complete components", () => {
  it("accepts a normal declarative paragraph", () => {
    expect(validateText("Local teams share useful lessons from daily work with clear and honest words.").passed).toBe(true);
  });

  it("accepts valid imperatives including adjective-led objects", () => {
    for (const sentence of [
      "Repeat the offer only when it works.",
      "Build stronger relationships with regular customers.",
      "Keep your menu easy to scan.",
      "Emphasize strong relationships with regular customers.",
    ]) {
      expect(validateText(sentence).passed, sentence).toBe(true);
    }
  });

  it("accepts genuine subject + finite-verb uses of ambiguous lexicon words", () => {
    for (const sentence of [
      "Customers repeat their orders every week.",
      "Repeat customers are valuable.",
      "Audiences trust peers more than ads.",
      "The store sold 24 units in 2026.",
    ]) {
      expect(validateText(sentence).passed, sentence).toBe(true);
    }
  });

  it("accepts natural H2/H3 headings without finite predicates", () => {
    const result = validateBlocks([
      p("p0", "Community platform planning shapes how teams approach the work."),
      h3("h3a", "Choose the Right Space"),
      p("p1", "Your community can live on WhatsApp without a formal page or public feed."),
      h3("h3b", "Tailor Content to Local Culture"),
      p("p2", "Local teams adapt their voice to the customers they serve."),
    ], { componentId: "section-1", componentType: "section" });
    expect(result.passed, JSON.stringify(result.violations)).toBe(true);
  });

  it("accepts a valid intro, section and conclusion", () => {
    expect(validateBlocks([
      p("p0", "Local teams share useful lessons from daily work with clear and honest words."),
      p("p1", "Regular replies also show customers that a real person is listening."),
    ]).passed).toBe(true);

    expect(validateBlocks([
      p("p0", "Community platform planning shapes how teams approach the work."),
      h3("h3a", "Choose the Right Space"),
      p("p1", "Your community can live on WhatsApp without a formal page or public feed."),
    ], { componentId: "section-1", componentType: "section" }).passed).toBe(true);

    expect(validateBlocks([
      p("p0", "A small weekly plan keeps the work steady without adding stress to the whole team."),
    ], { componentType: "conclusion" }).passed).toBe(true);
  });

  it("accepts a valid additive expansion fragment without surrounding context", () => {
    const result = validateText("Owners can also track weekly replies to spot what works best.", {
      componentId: "section-2",
      componentType: "section",
      scope: "additive-fragment",
    });
    expect(result.passed, JSON.stringify(result.violations)).toBe(true);
  });
});

describe("producer-content-contract: invalid complete components", () => {
  it("rejects genuine no-finite-predicate fragments", () => {
    for (const sentence of [
      "A stronger digital presence for repeat guests.",
      "Local restaurants with stronger repeat business.",
      "Free delivery for members.",
      "Better customer retention for restaurants.",
    ]) {
      const result = validateText(sentence);
      expect(result.passed, sentence).toBe(false);
      // One fragment-family violation after deduplication (no-finite-predicate
      // and malformed fragment collapse to a single finding).
      const fragmentFamily = result.violations.filter((v) =>
        v.code === "no-finite-predicate" || v.code === "fragment",
      );
      expect(fragmentFamily.length, sentence).toBe(1);
    }
  });

  it("rejects duplicated determiners", () => {
    const result = validateText("The a menu changes daily.");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "duplicated-determiner")).toBe(true);
  });

  it("rejects repeated adjacent words", () => {
    const result = validateText("Focus focus on the menu.");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "repeated-adjacent-word")).toBe(true);
  });

  it("rejects broken punctuation", () => {
    // A sentence ending with a dangling determiner is broken punctuation
    // (also caught as a trailing fragment by completeness — distinct families).
    const result = validateText("The menu is ready for the");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "broken-punctuation")).toBe(true);
  });

  it("rejects malformed noun phrases", () => {
    const result = validateText("Broader these market changes shape the plan.");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "malformed-noun-phrase")).toBe(true);
  });

  it("rejects punctuation residue", () => {
    const result = validateText(".");
    expect(result.passed).toBe(false);
    // The authoritative malformed-prose leaf reports it as punctuation-fragment;
    // the explicit residue rule dedupes into the same defect family.
    expect(result.violations.some((v) => v.code === "punctuation-residue" || v.code === "punctuation-fragment")).toBe(true);
  });

  it("rejects an unfinished example at component scope", () => {
    const result = validateText("For example, a local team plans to test.");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "unfinished-example")).toBe(true);
  });

  it("rejects an orphan/dependent opening at component scope", () => {
    const result = validateText("However, the team replied quickly.");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "orphan-transition")).toBe(true);
  });

  it("rejects a strict dangling reference at component scope", () => {
    const result = validateText("That's why customers come back for the specials.");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "dangling-reference")).toBe(true);
  });

  it("rejects an empty H3 subsection in a complete section", () => {
    const result = validateBlocks([
      h3("h3a", "Choose the Right Space"),
      h3("h3b", "Tailor Content to Local Culture"),
    ], { componentId: "section-1", componentType: "section" });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "empty-subsection")).toBe(true);
  });

  it("rejects a structurally empty component", () => {
    const result = validateBlocks([]);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "empty-component")).toBe(true);
  });

  it("rejects an incomplete FAQ answer", () => {
    const result = validateFaq([{ question: "How does the loyalty programme work?", answer: "Free delivery for members." }]);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "no-finite-predicate")).toBe(true);
  });
});

describe("producer-content-contract: FAQ parity with the existing local fix", () => {
  it("rejects list-style and fragment FAQ answers", () => {
    for (const answer of ["WhatsApp, Facebook, and Instagram.", "Free delivery for members."]) {
      const result = validateFaq([{ question: "What is the best platform?", answer }]);
      expect(result.passed, answer).toBe(false);
    }
  });

  it("accepts complete-sentence FAQ answers", () => {
    const result = validateFaq([
      { question: "How does the loyalty programme work?", answer: "Members enjoy free delivery on every order." },
      { question: "Why does this matter?", answer: "Consistent rewards keep customers coming back." },
    ]);
    expect(result.passed, JSON.stringify(result.violations)).toBe(true);
  });

  it("accepts short/terse answers under the fragment threshold", () => {
    for (const answer of ["Yes.", "Daily.", "Yes, daily."]) {
      expect(validateFaq([{ question: "Is it daily?", answer }]).passed, answer).toBe(true);
    }
  });

  it("accepts a valid FAQ question without declarative finite-predicate logic", () => {
    const result = validateFaq([{ question: "What is the best platform for Hong Kong?", answer: "WhatsApp is the most popular choice." }]);
    expect(result.passed, JSON.stringify(result.violations)).toBe(true);
  });

  it("rejects empty, unbalanced-quotation, Chinese and markup FAQ content", () => {
    expect(validateFaq([{ question: "", answer: "Members enjoy free delivery." }]).violations.some((v) => v.code === "faq-question-empty")).toBe(true);
    expect(validateFaq([{ question: "\"Is the menu fresh?", answer: "Yes, it is." }]).violations.some((v) => v.code === "unmatched-quotation")).toBe(true);
    expect(validateFaq([{ question: "為什麼重要?", answer: "Members enjoy free delivery." }]).violations.some((v) => v.code === "faq-non-english")).toBe(true);
    expect(validateFaq([{ question: "Is it fresh?", answer: "Free delivery <b>today</b>." }]).violations.some((v) => v.code === "faq-markup")).toBe(true);
  });

  it("enforces the FAQ entry-count range", () => {
    const result = validateProducerCandidate(
      { faqEntries: [{ question: "Q1", answer: "Members enjoy free delivery." }, { question: "Q2", answer: "Rewards keep customers coming back." }] },
      ctx({ componentId: "faq", componentType: "faq", faqRange: { min: 4, max: 6 } }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.code === "faq-entry-count")).toBe(true);
  });
});

describe("producer-content-contract: context safety (additive fragment vs complete component)", () => {
  it("does not apply component coherence to an additive fragment without context", () => {
    // A transition opener that would be orphaned as a complete component's
    // first paragraph is NOT judged against missing context in additive scope.
    const additive = validateText("However, the team replied quickly.", {
      componentId: "section-2",
      componentType: "section",
      scope: "additive-fragment",
    });
    expect(additive.passed, JSON.stringify(additive.violations)).toBe(true);
  });

  it("catches the equivalent violation when the rule is applicable at complete-component scope", () => {
    const complete = validateText("However, the team replied quickly.", {
      componentId: "section-2",
      componentType: "section",
    });
    expect(complete.passed).toBe(false);
    expect(complete.violations.some((v) => v.code === "orphan-transition")).toBe(true);
  });

  it("still applies language gates to additive fragments", () => {
    const fragment = validateText("Free delivery for members.", {
      componentId: "section-2",
      componentType: "section",
      scope: "additive-fragment",
    });
    expect(fragment.passed).toBe(false);
    expect(fragment.violations.some((v) => v.code === "no-finite-predicate")).toBe(true);
  });
});

describe("producer-content-contract: deterministic fingerprint and deduplication", () => {
  it("produces a deterministic fingerprint for blocks and FAQ candidates", () => {
    const a = validateText("Local teams share useful lessons from daily work with clear and honest words.");
    const b = validateText("Local teams share useful lessons from daily work with clear and honest words.");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(validateText("A different sentence entirely for the fingerprint.").fingerprint);
    const faq = validateFaq([{ question: "Q", answer: "Members enjoy free delivery." }]);
    expect(faq.fingerprint).toBeTruthy();
  });

  it("does not hide genuinely distinct violations", () => {
    const result = validateText("The a menu changes daily.");
    const codes = result.violations.map((v) => v.code);
    // Two genuinely distinct defects in one paragraph — a fragment sentence and
    // a duplicated determiner — are both reported (different defect families).
    const combined = validateText("Free delivery for members. The a menu changes daily.");
    expect(combined.passed).toBe(false);
    const combinedCodes = combined.violations.map((v) => v.code);
    expect(combinedCodes.some((c) => c === "no-finite-predicate" || c === "fragment")).toBe(true);
    expect(combinedCodes.some((c) => c === "duplicated-determiner")).toBe(true);
    expect(codes).not.toHaveLength(0);
  });

  it("dedupeProducerViolations collapses same-defect duplicates across leaves", () => {
    const duplicates = dedupeProducerViolations([
      { rule: "sentence-completeness", code: "no-finite-predicate", componentId: "intro", blockId: "p0", message: "a", text: "Free delivery for members." },
      { rule: "malformed-prose", code: "fragment", componentId: "intro", blockId: "p0", message: "b", text: "Free delivery for members." },
    ]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].code).toBe("no-finite-predicate");
    // Distinct text stays distinct.
    const distinct = dedupeProducerViolations([
      { rule: "sentence-completeness", code: "no-finite-predicate", componentId: "intro", blockId: "p0", message: "a", text: "Free delivery for members." },
      { rule: "sentence-completeness", code: "no-finite-predicate", componentId: "intro", blockId: "p0", message: "b", text: "Better customer retention." },
    ]);
    expect(distinct).toHaveLength(2);
  });
});
