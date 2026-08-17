// ── Stage 3H: feature-flagged hybrid sentence-completeness authority tests ──
// Proves the full rollout matrix: flag default-off equivalence, exact flag-on
// corpus metrics, override diagnostics, hard-safety guarantees, no-new-false-
// accepts, and shared-authority propagation to existing callers.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeSentenceCompleteness,
  analyzeSentenceCompletenessDeterministic,
  type SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";
import { CORPUS } from "@/lib/blog/clause-aware-bakeoff.test";
import { validateProducerCandidate, type ProducerComponentContext } from "@/lib/blog/producer-content-contract";
import type { EditorialBlock } from "@/lib/blog/article-document";
import { decideSentenceCompletenessHybrid } from "@/lib/blog/hybrid-sentence-completeness";

const HYBRID_FLAG = "ENABLE_HYBRID_SENTENCE_COMPLETENESS";
const DEBUG_FLAG = "ENABLE_PIPELINE_DEBUG_TRACE";

function p(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function ctx(overrides: Partial<ProducerComponentContext> = {}): ProducerComponentContext {
  return { componentId: "section-4", componentType: "section", scope: "complete-component", ...overrides };
}

afterEach(() => {
  delete process.env[HYBRID_FLAG];
  delete process.env[DEBUG_FLAG];
  vi.restoreAllMocks();
});

describe("hybrid authority: feature flag OFF (default production behavior)", () => {
  const units: Array<{ text: string; kind: SentenceCompletenessKind }> = [
    { text: "When feedback arrives, respond quickly and personally.", kind: "paragraph" },
    { text: "Instead, weave service skills into your weekly routine.", kind: "paragraph" },
    { text: "When feedback arrives.", kind: "paragraph" },
    { text: "So what drives loyalty?", kind: "paragraph" },
    { text: "The menu is ready for the", kind: "paragraph" },
    { text: "A single orientation session won’t stick. Instead, weave service skills into your weekly routine. Keep it short and practical.", kind: "paragraph" },
    { text: "Yes, daily.", kind: "faq-answer" },
    { text: "Choose the Right Space", kind: "subheading" },
    { text: "Sources: local restaurants (2026).", kind: "paragraph" },
    { text: "", kind: "paragraph" },
    { text: "Choose a dish:", kind: "paragraph" },
    { text: "Item A", kind: "list-item" },
    { text: "2026", kind: "table-cell" },
    { text: "What they do stop for?", kind: "paragraph" },
    { text: "Customers plan their visits. Teams offer discounts on slow nights.", kind: "paragraph" },
  ];

  function run() {
    return units.map((entry) => ({
      text: entry.text,
      kind: entry.kind,
      result: JSON.stringify(
        analyzeSentenceCompleteness(entry.text, entry.kind, {
          allowColonBeforeStructuredContinuation: entry.kind === "paragraph",
        }),
      ),
    }));
  }

  it("A: flag unset is byte-identical to the deterministic baseline", () => {
    delete process.env[HYBRID_FLAG];
    const flagOff = run();
    const baseline = units.map((entry) => ({
      text: entry.text,
      kind: entry.kind,
      result: JSON.stringify(
        analyzeSentenceCompletenessDeterministic(entry.text, entry.kind, {
          allowColonBeforeStructuredContinuation: entry.kind === "paragraph",
        }),
      ),
    }));
    expect(flagOff).toEqual(baseline);
  });

  it("B: flag false is identical to flag unset", () => {
    delete process.env[HYBRID_FLAG];
    const unset = run();
    process.env[HYBRID_FLAG] = "false";
    expect(run()).toEqual(unset);
  });

  it("A/B: flag OFF results match the pre-hybrid production baseline exactly", () => {
    delete process.env[HYBRID_FLAG];
    const flagOff = run();
    // The pre-hybrid baseline is the deterministic analyzer: identical JSON.
    for (const entry of units) {
      const deterministic = analyzeSentenceCompletenessDeterministic(entry.text, entry.kind, {
        allowColonBeforeStructuredContinuation: entry.kind === "paragraph",
      });
      expect(flagOff.find((r) => r.text === entry.text)!.result).toBe(JSON.stringify(deterministic));
    }
  });
});

describe("hybrid authority: feature flag ON", () => {
  it("C: 184-corpus metrics match the hardened rescue-only policy (TP140 TN19 FP25 FN0)", () => {
    process.env[HYBRID_FLAG] = "true";
    const rows = CORPUS.map((entry) => ({
      text: entry.text,
      label: entry.label,
      verdict: analyzeSentenceCompleteness(entry.text, entry.kind).complete,
    }));
    const tp = rows.filter((r) => r.label === "valid" && r.verdict).length;
    const tn = rows.filter((r) => r.label === "invalid" && !r.verdict).length;
    const fp = rows.filter((r) => r.label === "invalid" && r.verdict).map((r) => r.text);
    const fn = rows.filter((r) => r.label === "valid" && !r.verdict).map((r) => r.text);
    expect(rows).toHaveLength(184);
    expect(tp).toBe(140);
    expect(tn).toBe(19);
    expect(fp).toHaveLength(25);
    expect(fn).toHaveLength(0);
  });

  it("D: known false rejection rescued with flag ON", () => {
    const text = "When feedback arrives, respond quickly and personally.";
    delete process.env[HYBRID_FLAG];
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(false);
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
  });

  it("E: adverbial-prefaced imperative rescued with flag ON", () => {
    const text = "Instead, weave service skills into your weekly routine.";
    delete process.env[HYBRID_FLAG];
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(false);
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
  });

  it("F: subordinate-only stays PASS with flag ON (NLP rejection is not production authority)", () => {
    const text = "When feedback arrives.";
    delete process.env[HYBRID_FLAG];
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
  });

  it("G: ambiguous question stays PASS with flag ON", () => {
    const text = "So what drives loyalty?";
    delete process.env[HYBRID_FLAG];
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
  });

  it("H: hard malformed input cannot be rescued with flag ON", () => {
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness("The menu is ready for the", "paragraph").complete).toBe(false);
    expect(analyzeSentenceCompleteness("What they do stop for?", "paragraph").complete).toBe(false);
    expect(analyzeSentenceCompleteness("…", "paragraph").complete).toBe(false);
  });

  it("I: unknown experimental reason never overrides the deterministic result", () => {
    const authoritative = analyzeSentenceCompletenessDeterministic("When feedback arrives.", "paragraph");
    const verdict = decideSentenceCompletenessHybrid({
      text: "When feedback arrives.",
      kind: "paragraph",
      authoritative,
      experimental: { complete: false, reason: "future-unclassified-code" },
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.source).toBe("authoritative");
  });

  it("J: flag ON introduces ZERO new false accepts relative to current B2I", () => {
    const currentB2IFPs = CORPUS.filter(
      (entry) => entry.label === "invalid" && analyzeSentenceCompletenessDeterministic(entry.text, entry.kind).complete,
    ).map((entry) => entry.text);
    expect(currentB2IFPs).toHaveLength(25);

    process.env[HYBRID_FLAG] = "true";
    const flagOnFPs = CORPUS.filter((entry) => {
      const on = analyzeSentenceCompleteness(entry.text, entry.kind).complete;
      return entry.label === "invalid" && on;
    }).map((entry) => entry.text);
    expect(flagOnFPs).toHaveLength(25);
    // Rescue-only authority never changes a pass: the FP set is EXACTLY the
    // current-B2I FP set, so newHybridFalseAccepts is zero.
    expect(flagOnFPs).toEqual(currentB2IFPs);
  });

  it("3I: the live production sentence is never rejected with flag ON", () => {
    const text = "When someone tells you what they loved or what went wrong, take it seriously.";
    delete process.env[HYBRID_FLAG];
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
  });

  it("3I: comma-less subordinate+declarative valid control is never rejected with flag ON", () => {
    const text = "When he arrives we leave.";
    delete process.env[HYBRID_FLAG];
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
    process.env[HYBRID_FLAG] = "true";
    expect(analyzeSentenceCompleteness(text, "paragraph").complete).toBe(true);
  });
});

describe("hybrid authority: override diagnostics", () => {
  it("logs only actual overrides when debug tracing is enabled", () => {
    process.env[HYBRID_FLAG] = "true";
    process.env[DEBUG_FLAG] = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = analyzeSentenceCompleteness(
      "A single orientation session won’t stick. Instead, weave service skills into your weekly routine. Keep it short and practical.",
      "paragraph",
    );
    expect(result.complete).toBe(true);

    const hybridLines = warnSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((line) => line.includes("[sentence-completeness-hybrid]"));
    expect(hybridLines).toHaveLength(1);
    expect(hybridLines[0]).toContain("current=fail");
    expect(hybridLines[0]).toContain("hybrid=pass");
    expect(hybridLines[0]).toContain("source=nlp-rescue");
    expect(hybridLines[0]).toContain("reason=main-clause-predicate");
    expect(hybridLines[0]).toContain('text="Instead, weave service skills into your weekly routine."');
  });

  it("emits no hybrid lines when debug tracing is disabled", () => {
    process.env[HYBRID_FLAG] = "true";
    delete process.env[DEBUG_FLAG];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    analyzeSentenceCompleteness("Instead, weave service skills into your weekly routine.", "paragraph");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("hybrid authority: production caller parity", () => {
  it("flag OFF: producer contract and direct callers show zero drift vs baseline", () => {
    delete process.env[HYBRID_FLAG];
    const candidate = { blocks: [p("p0", "Local teams share useful lessons from daily work with clear and honest words.")] };
    const baseline = validateProducerCandidate(candidate, ctx());
    process.env[HYBRID_FLAG] = "false";
    const flagFalse = validateProducerCandidate(candidate, ctx());
    expect(JSON.stringify(flagFalse)).toBe(JSON.stringify(baseline));
  });

  it("flag ON: every caller receives the SAME shared hybrid result", () => {
    process.env[HYBRID_FLAG] = "true";
    const block7 =
      "A single orientation session won’t stick. Instead, weave service skills into your weekly routine. Role-play common scenarios, share feedback from online reviews and celebrate staff who go the extra mile. Keep it short and practical, so it feels like support, not a lecture.";
    const candidate = { blocks: [p("p0", block7)] };
    const result = validateProducerCandidate(candidate, ctx());

    // The shared authority now PASSES the previously-failing paragraph: no
    // no-finite-predicate sentence-completeness violation is produced.
    expect(result.violations.some((v) => v.code === "no-finite-predicate")).toBe(false);
    // And the same unit via the direct shared entry point agrees.
    expect(analyzeSentenceCompleteness(block7, "paragraph").complete).toBe(true);
  });
});
