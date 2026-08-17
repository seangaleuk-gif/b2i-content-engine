import { describe, expect, it } from "vitest";
import { validateFaqPayload } from "@/lib/services/blog-generation-service";
import { analyzeSentenceCompleteness } from "@/lib/blog/sentence-completeness";

function faq(entries: Array<{ question: string; answer: string }>): unknown {
  return { entries };
}

describe("FAQ producer: answer completeness gate (classification A)", () => {
  it("rejects a noun-phrase fragment FAQ answer (the production failure shape)", () => {
    const result = validateFaqPayload(faq([
      { question: "How does the loyalty programme work?", answer: "Free delivery for members." },
    ]), 1, 1);
    expect(result.errors.some((error) => error.includes("answer is not a complete sentence"))).toBe(true);
  });

  it("rejects a list-style noun-phrase FAQ answer", () => {
    const result = validateFaqPayload(faq([
      { question: "What is the best platform?", answer: "WhatsApp, Facebook, and Instagram." },
    ]), 1, 1);
    expect(result.errors.some((error) => error.includes("answer is not a complete sentence"))).toBe(true);
  });

  it("accepts complete-sentence FAQ answers", () => {
    const result = validateFaqPayload(faq([
      { question: "How does the loyalty programme work?", answer: "Members enjoy free delivery on every order." },
      { question: "Why does this matter?", answer: "Consistent rewards keep customers coming back." },
    ]), 2, 2);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(2);
  });

  it("accepts short/terse answers that are not fragments (under the fragment threshold)", () => {
    // A terse answer is a complete prose unit: it is not a multi-word
    // verbless fragment, so it must not be rejected.
    for (const answer of ["Yes.", "Daily.", "Yes, daily.", "Yes, it is.", "Twice a week."]) {
      expect(analyzeSentenceCompleteness(answer, "faq-answer").complete, answer).toBe(true);
      const result = validateFaqPayload(faq([{ question: "Is it daily?", answer }]), 1, 1);
      expect(result.errors, answer).toEqual([]);
    }
  });

  it("a fragment answer among valid entries is flagged for repair while valid ones stay intact", () => {
    const result = validateFaqPayload(faq([
      { question: "Q1", answer: "Members enjoy free delivery on every order." },
      { question: "Q2", answer: "Free delivery for members." },
    ]), 2, 2);
    // The valid answer is preserved verbatim; the fragment answer is flagged so
    // the caller triggers the FAQ repair retry.
    expect(result.entries[0].answer).toBe("Members enjoy free delivery on every order.");
    expect(result.entries[1].answer).toBe("Free delivery for members.");
    expect(result.errors.some((error) => error.includes("answer is not a complete sentence"))).toBe(true);
  });
});
