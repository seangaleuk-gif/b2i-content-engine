// ── Stage 3I: hybrid authority policy-safety tests ──
// Proves on the expanded corpus (with the live production sentence and generic
// controls) that the asymmetric RESCUE-ONLY authority is the only candidate
// policy with ZERO known false rejection of valid English, and replays the
// latest restaurant-run sentence-completeness overrides through policies
// B (full-reject), C (rescue-only) and D (narrow-reject).

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { analyzeSentenceCompletenessDeterministic, type SentenceCompletenessKind } from "@/lib/blog/sentence-completeness";
import { clauseAwareVerdict } from "@/lib/blog/clause-aware-classifier";
import {
  decideSentenceCompletenessHybrid,
  rejectEligibleReasonsFor,
  type HybridPolicyMode,
} from "@/lib/blog/hybrid-sentence-completeness";
import { CORPUS } from "@/lib/blog/clause-aware-bakeoff.test";

const LIVE = "When someone tells you what they loved or what went wrong, take it seriously.";
const NO_COMMA = "When he arrives we leave.";
const SO_WHAT = "So what drives loyalty?";
const WEAVE = "Instead, weave service skills into your weekly routine.";
const WHEN_FEEDBACK_IMPERATIVE = "When feedback arrives, respond quickly and personally.";
const RESPOND = "Respond to comments and messages promptly.";

function decide(text: string, mode: HybridPolicyMode, kind: SentenceCompletenessKind = "paragraph") {
  const authoritative = analyzeSentenceCompletenessDeterministic(text, kind);
  const experimental = clauseAwareVerdict(text, kind, authoritative);
  return decideSentenceCompletenessHybrid({ text, kind, authoritative, experimental }, mode);
}

describe("Stage 3I: policy mode rejection sets", () => {
  it("full-reject keeps the Stage 3G rejection allowlist", () => {
    expect([...rejectEligibleReasonsFor("full-reject")].sort()).toEqual(["subordinate-main-clause", "subordinate-only"]);
  });

  it("narrow-reject removes subordinate-main-clause", () => {
    expect([...rejectEligibleReasonsFor("narrow-reject")].sort()).toEqual(["subordinate-only"]);
  });

  it("rescue-only removes ALL NLP rejection", () => {
    expect([...rejectEligibleReasonsFor("rescue-only")]).toEqual([]);
  });
});

describe("Stage 3I: generic rejection weakness (no special-casing)", () => {
  it("full-reject falsely rejects the live sentence via subordinate-main-clause", () => {
    const authoritative = analyzeSentenceCompletenessDeterministic(LIVE, "paragraph");
    const experimental = clauseAwareVerdict(LIVE, "paragraph", authoritative);
    expect(authoritative.complete).toBe(true);
    expect(experimental.complete).toBe(false);
    expect(experimental.reason).toBe("subordinate-main-clause");
    expect(decide(LIVE, "full-reject").complete).toBe(false);
  });

  it("narrow-reject and rescue-only accept the live sentence", () => {
    expect(decide(LIVE, "narrow-reject").complete).toBe(true);
    expect(decide(LIVE, "rescue-only").complete).toBe(true);
  });

  it("subordinate-only also collides with valid comma-less subordinate+declarative sentences", () => {
    const authoritative = analyzeSentenceCompletenessDeterministic(NO_COMMA, "paragraph");
    const experimental = clauseAwareVerdict(NO_COMMA, "paragraph", authoritative);
    expect(authoritative.complete).toBe(true);
    expect(experimental.reason).toBe("subordinate-only");
    expect(decide(NO_COMMA, "full-reject").complete).toBe(false);
    expect(decide(NO_COMMA, "narrow-reject").complete).toBe(false);
    expect(decide(NO_COMMA, "rescue-only").complete).toBe(true);
  });
});

describe("Stage 3I: new false accepts/rejects relative to current B2I", () => {
  function policyMetrics(mode: HybridPolicyMode) {
    const rows = CORPUS.map((entry) => ({
      text: entry.text,
      label: entry.label,
      kind: entry.kind,
      deterministic: analyzeSentenceCompletenessDeterministic(entry.text, entry.kind).complete,
      verdict: decide(entry.text, mode, entry.kind).complete,
    }));
    const tp = rows.filter((r) => r.label === "valid" && r.verdict).length;
    const tn = rows.filter((r) => r.label === "invalid" && !r.verdict).length;
    const fp = rows.filter((r) => r.label === "invalid" && r.verdict).map((r) => r.text);
    const fn = rows.filter((r) => r.label === "valid" && !r.verdict).map((r) => r.text);
    const precision = tp / (tp + fp.length || 1);
    const recall = tp / (tp + fn.length || 1);
    const accuracy = (tp + tn) / rows.length;
    const newFalseAccepts = fp.filter(
      (text) => rows.find((r) => r.text === text)!.deterministic === false,
    );
    const newFalseRejects = fn.filter(
      (text) => rows.find((r) => r.text === text)!.deterministic === true,
    );
    return { rows: rows.length, tp, tn, fpCount: fp.length, fnCount: fn.length, fp, fn, precision, recall, accuracy, newFalseAccepts, newFalseRejects };
  }

  it("B (full-reject): 2 new false rejects, 0 new false accepts", () => {
    const m = policyMetrics("full-reject");
    expect(m.rows).toBe(184);
    expect(m.newFalseRejects).toEqual([LIVE, NO_COMMA]);
    expect(m.newFalseAccepts).toEqual([]);
    expect(m.fnCount).toBe(2);
  });

  it("D (narrow-reject): 1 new false reject (comma-less collision), 0 new false accepts", () => {
    const m = policyMetrics("narrow-reject");
    expect(m.newFalseRejects).toEqual([NO_COMMA]);
    expect(m.newFalseAccepts).toEqual([]);
    expect(m.fnCount).toBe(1);
  });

  it("C (rescue-only): ZERO new false rejects and ZERO new false accepts", () => {
    const m = policyMetrics("rescue-only");
    expect(m.newFalseRejects).toEqual([]);
    expect(m.newFalseAccepts).toEqual([]);
    expect(m.fnCount).toBe(0);
    expect(m.fpCount).toBe(25);
  });
});

describe("Stage 3I: safety bar for the recommended rescue-only authority", () => {
  it("all known valid production failures are accepted", () => {
    for (const text of [LIVE, SO_WHAT, WEAVE, WHEN_FEEDBACK_IMPERATIVE, RESPOND]) {
      expect(decide(text, "rescue-only").complete, text).toBe(true);
    }
  });

  it("hard malformed/corruption results can never be rescued", () => {
    expect(decide("The menu is ready for the", "rescue-only").complete).toBe(false);
    expect(decide("What they do stop for?", "rescue-only").complete).toBe(false);
  });

  it("unknown experimental reasons cannot override", () => {
    const authoritative = analyzeSentenceCompletenessDeterministic("When feedback arrives.", "paragraph");
    const verdict = decideSentenceCompletenessHybrid(
      {
        text: "When feedback arrives.",
        kind: "paragraph",
        authoritative,
        experimental: { complete: false, reason: "future-unclassified-code" },
      },
      "rescue-only",
    );
    expect(verdict.complete).toBe(true);
    expect(verdict.source).toBe("authoritative");
  });

  it("rescue-only never produces an nlp-reject", () => {
    for (const entry of CORPUS) {
      const verdict = decide(entry.text, "rescue-only");
      expect(verdict.source, entry.text).not.toBe("nlp-reject");
    }
  });
});

describe("Stage 3I: latest restaurant-run override replay", () => {
  it("replays every unique sentence-completeness override through B/C/D with no valid unit rejected by C", () => {
    const replayPath = path.resolve("debug", "hybrid-live-replay-report.json");
    const prior = JSON.parse(fs.readFileSync(replayPath, "utf8")) as { rows: Array<{ text: string }> };
    const units = new Map<string, string>();
    for (const row of prior.rows) units.set(row.text, row.text);
    // Known live overrides from the Stage 3I controlled rollout.
    for (const text of [LIVE, RESPOND]) units.set(text, text);
    expect(units.size).toBeGreaterThan(15);

    const report: Array<{
      text: string;
      deterministic: boolean;
      experimental: boolean;
      experimentalReason: string;
      fullReject: boolean;
      rescueOnly: boolean;
      narrowReject: boolean;
      rescueOnlyOverride: string;
    }> = [];
    for (const text of units.values()) {
      const authoritative = analyzeSentenceCompletenessDeterministic(text, "paragraph");
      const experimental = clauseAwareVerdict(text, "paragraph", authoritative);
      const full = decide(text, "full-reject");
      const rescue = decide(text, "rescue-only");
      const narrow = decide(text, "narrow-reject");
      report.push({
        text,
        deterministic: authoritative.complete,
        experimental: experimental.complete,
        experimentalReason: experimental.reason,
        fullReject: full.complete,
        rescueOnly: rescue.complete,
        narrowReject: narrow.complete,
        rescueOnlyOverride: authoritative.complete === rescue.complete ? "none" : rescue.source,
      });
    }

    const outPath = path.resolve("debug", "hybrid-policy-live-replay.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ units: report.length, rows: report }, null, 2), "utf8");

    // The recommended policy never rejects a unit the deterministic analyzer
    // accepts, and never introduces a reject override at all.
    for (const row of report) {
      expect(row.rescueOnlyOverride, row.text).not.toBe("nlp-reject");
      if (row.deterministic) expect(row.rescueOnly, row.text).toBe(true);
    }
    const liveRow = report.find((row) => row.text === LIVE);
    expect(liveRow).toBeTruthy();
    expect(liveRow!.rescueOnly).toBe(true);
    expect(liveRow!.fullReject).toBe(false);
  });
});
