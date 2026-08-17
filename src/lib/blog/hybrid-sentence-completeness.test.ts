// ── Stage 3G: hybrid policy unit tests (evaluation-only, no production wiring) ──
// Proves: default-authoritative behavior, high-confidence rescue/reject
// conditions, never-override hard rules, reason-code inventory completeness,
// and the no-override default for unknown/weak experimental reasons.

import { describe, expect, it } from "vitest";
import {
  decideSentenceCompletenessHybrid,
  REASON_CLASSIFICATION,
  REJECT_ELIGIBLE_REASONS,
  RESCUE_ELIGIBLE_REASONS,
  NEVER_OVERRIDE_REASONS,
  type HybridSentenceInput,
} from "@/lib/blog/hybrid-sentence-completeness";
import type { SentenceCompletenessAnalysis } from "@/lib/blog/sentence-completeness";

function input(overrides: Partial<HybridSentenceInput>): HybridSentenceInput {
  return {
    text: "Sample text.",
    kind: "paragraph",
    authoritative: { complete: true, issues: [], trailingFragment: null },
    experimental: { complete: true, reason: "main-clause-predicate" },
    ...overrides,
  };
}

function failAuth(code: "no-finite-predicate" | "missing-terminal-punctuation" = "no-finite-predicate"): SentenceCompletenessAnalysis {
  return {
    complete: false,
    issues: [{ code, message: code, trailingFragment: null }],
    trailingFragment: null,
  };
}

describe("hybrid reason-code inventory", () => {
  it("classifies every reason the clause-aware classifier can emit", () => {
    const classifierReasons = [
      "structural-kind",
      "source-citation",
      "hard-evidence",
      "punctuation-residue",
      "no-tokens",
      "question-inversion",
      "question-subject-wh",
      "question-inverted-aux",
      "question-unresolved",
      "subordinate-only",
      "subordinate-main-clause",
      "short-utterance",
      "possessive-imperative",
      "main-clause-predicate",
      "no-predicate-evidence",
    ];
    for (const reason of classifierReasons) {
      expect(REASON_CLASSIFICATION[reason], reason).toBeTruthy();
    }
  });

  it("rescue-eligible set contains only predicate-proving reasons", () => {
    expect([...RESCUE_ELIGIBLE_REASONS].sort()).toEqual([
      "main-clause-predicate",
      "possessive-imperative",
      "question-inversion",
      "question-inverted-aux",
      "question-subject-wh",
      "subordinate-main-clause",
    ]);
  });

  it("reject-eligible set is narrow and never contains weak reasons", () => {
    expect([...REJECT_ELIGIBLE_REASONS].sort()).toEqual(["subordinate-main-clause", "subordinate-only"]);
    for (const weak of ["no-predicate-evidence", "question-unresolved", "short-utterance"]) {
      expect(REJECT_ELIGIBLE_REASONS.has(weak)).toBe(false);
    }
  });

  it("never-override set contains all hard/structural mirror reasons", () => {
    for (const hard of [
      "hard-evidence",
      "punctuation-residue",
      "no-tokens",
      "structural-kind",
      "source-citation",
    ]) {
      expect(NEVER_OVERRIDE_REASONS.has(hard)).toBe(true);
    }
  });
});

describe("hybrid default-to-authoritative", () => {
  it("unknown experimental reason never overrides a pass", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "When feedback arrives.",
      experimental: { complete: false, reason: "brand-new-code" },
    }));
    expect(verdict).toEqual({
      complete: true,
      source: "authoritative",
      reason: "no-override-pass",
      experimentalReason: "brand-new-code",
    });
  });

  it("unknown experimental reason never overrides a fail", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "When feedback arrives, respond quickly and personally.",
      authoritative: failAuth(),
      experimental: { complete: true, reason: "brand-new-code" },
    }));
    expect(verdict.complete).toBe(false);
    expect(verdict.source).toBe("authoritative");
  });

  it("agree-pass returns authoritative pass", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "Customers plan their visits.",
    }));
    expect(verdict).toMatchObject({ complete: true, source: "authoritative", reason: "agree-pass" });
  });

  it("agree-fail returns authoritative fail", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "A stronger digital presence for repeat guests.",
      authoritative: failAuth(),
      experimental: { complete: false, reason: "no-predicate-evidence" },
    }));
    expect(verdict).toMatchObject({ complete: false, source: "authoritative" });
    expect(verdict.reason).toBe("no-rescue-weak-evidence");
  });
});

describe("hybrid high-confidence rescue", () => {
  it("rescues a no-finite-predicate fail with proven main-clause predicate", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "Customers arrive on time.",
      authoritative: failAuth(),
      experimental: { complete: true, reason: "main-clause-predicate" },
    }));
    expect(verdict).toMatchObject({ complete: true, source: "nlp-rescue", reason: "main-clause-predicate" });
  });

  it("rescues subordinate + imperative via main-clause-predicate", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "When feedback arrives, respond quickly and personally.",
      authoritative: failAuth(),
      experimental: { complete: true, reason: "main-clause-predicate" },
    }));
    expect(verdict).toMatchObject({ complete: true, source: "nlp-rescue" });
  });

  it("does NOT rescue when the failure is a hard non-finite issue", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "The menu is ready for the",
      authoritative: failAuth("missing-terminal-punctuation"),
      experimental: { complete: true, reason: "main-clause-predicate" },
    }));
    expect(verdict).toMatchObject({ complete: false, source: "authoritative", reason: "no-rescue-hard-evidence" });
  });

  it("does NOT rescue a no-finite-predicate fail with weak experimental pass evidence", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "Some text.",
      authoritative: failAuth(),
      experimental: { complete: true, reason: "short-utterance" },
    }));
    expect(verdict).toMatchObject({ complete: false, source: "authoritative", reason: "no-rescue-weak-evidence" });
  });

  it("does NOT rescue when the authoritative failure mixes issues", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "Example.",
      authoritative: {
        complete: false,
        issues: [
          { code: "no-finite-predicate", message: "fragment", trailingFragment: null },
          { code: "missing-aux-inversion", message: "inversion", trailingFragment: null },
        ],
        trailingFragment: null,
      },
      experimental: { complete: true, reason: "main-clause-predicate" },
    }));
    expect(verdict).toMatchObject({ complete: false, source: "authoritative" });
  });
});

describe("hybrid high-confidence rejection", () => {
  it("rejects subordinate-only evidence on a current pass", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "If the guest complained.",
      experimental: { complete: false, reason: "subordinate-only" },
    }));
    expect(verdict).toMatchObject({ complete: false, source: "nlp-reject", reason: "subordinate-only" });
  });

  it("never rejects on generic no-predicate-evidence", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "Prices rose sharply this year.",
      experimental: { complete: false, reason: "no-predicate-evidence" },
    }));
    expect(verdict).toMatchObject({ complete: true, source: "authoritative", reason: "no-override-pass" });
  });

  it("never rejects on question-unresolved (So what drives loyalty?)", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "So what drives loyalty?",
      experimental: { complete: false, reason: "question-unresolved" },
    }));
    expect(verdict).toMatchObject({ complete: true, source: "authoritative", reason: "no-override-pass" });
  });

  it("never rejects on short-utterance", () => {
    const verdict = decideSentenceCompletenessHybrid(input({
      text: "Walk-ins welcome.",
      experimental: { complete: false, reason: "short-utterance" },
    }));
    expect(verdict).toMatchObject({ complete: true, source: "authoritative" });
  });
});
