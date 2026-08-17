// ── Stage 3G/3H/3I: conservative hybrid sentence-completeness decision policy ──
// The pure decision policy. Stage 3G proved it on the 172-sentence gold corpus;
// Stage 3H consumed it as the FEATURE-FLAGGED shared production authority via
// sentence-completeness-hybrid-authority.ts (flag ENABLE_HYBRID_SENTENCE_COMPLETENESS,
// default OFF). This module itself is pure: it has no flag handling, no
// segmentation, and no authority — it only decides one unit given the
// authoritative analysis and the clause-aware experimental verdict.
//
// Stage 3I hardening: the first controlled live rollout exposed that NLP
// REJECTION is not high-confidence — Compromise mis-tags the main-clause verb
// in "When someone tells you what they loved or what went wrong, take it
// seriously." ("take" → Noun), so the `subordinate-main-clause` fail direction
// falsely rejects valid English; `subordinate-only` similarly collides with
// valid comma-less subordinate+main-clause sentences ("When he arrives we
// leave."). Both rejection categories depend on Compromise's tagging, so the
// production authority is asymmetric: deterministic B2I + high-confidence NLP
// RESCUE only (`rescue-only` mode). NLP rejection remains available for
// benchmarking and shadow/diagnostic use via the `mode` parameter.
//
// Architecture: the authoritative deterministic analyzer remains the default;
// the clause-aware Compromise classifier may ONLY override the deterministic
// verdict in HIGH-CONFIDENCE grammatical situations. There is no generic
// "experimental !== current → use experimental" logic — every override requires
// the experimental reason code to belong to a closed, classified set of proven
// shapes, and rescue additionally requires the authoritative failure to be
// exclusively a finite-predicate classification with no hard residue.
//
// Unknown/new reason codes default to NO OVERRIDE (authoritative result wins).

import { isAuthoritativePunctuationOnlyResidue } from "@/lib/blog/sentence-quality";
import type {
  SentenceCompletenessAnalysis,
  SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";
import type { ClauseAwareVerdictResult } from "@/lib/blog/clause-aware-classifier";

export type HybridDecisionSource = "authoritative" | "nlp-rescue" | "nlp-reject";

export type HybridReasonCode =
  | "agree-pass"
  | "agree-fail"
  | "no-override-pass"
  | "no-override-fail"
  | "no-rescue-hard-evidence"
  | "no-rescue-weak-evidence";

export interface HybridSentenceInput {
  /** Exact sentence-like unit text (the unit the authoritative analyzer judged). */
  text: string;
  kind: SentenceCompletenessKind;
  authoritative: SentenceCompletenessAnalysis;
  experimental: ClauseAwareVerdictResult;
}

export interface HybridVerdict {
  complete: boolean;
  source: HybridDecisionSource;
  /** Policy-level decision reason. */
  reason: HybridReasonCode | string;
  /** The experimental reason code when an override occurred, else the
   *  experimental reason code that was considered. */
  experimentalReason: string;
}

// ── Reason-code classification ──
//
// Rescue eligible: experimental PASS evidence that PROVES an independent
// finite predicate/main clause (real predicate with subject or clause-initial
// imperative, unambiguously possessive-object imperative, proven question
// shapes, or an independent main clause following a real subordinate clause).
//
// Reject eligible: experimental FAIL evidence that PROVES the unit is only a
// subordinate clause with no independent main clause. Noun-phrase/misparse
// shapes are deliberately NOT reject-eligible: the surface shape
// [modifier][noun][verb-ambiguous -s token][preposition] also matches valid
// sentences such as "A strong plan works for the team.", so rejecting on that
// evidence is not high-confidence. Those units stay authoritative PASS and are
// reported as known conservative errors rather than forced to fail.
//
// Observational: weak evidence that must never override (the classifier simply
// failing to find a predicate, short-utterance deferral, unresolved questions).
//
// Never override: evidence that mirrors authoritative hard corruption or
// structural determination; the classifier never disagrees there anyway.

export type ReasonCategory = "rescue" | "reject" | "observational" | "never-override";

export const REASON_CLASSIFICATION: Record<string, ReasonCategory> = {
  "main-clause-predicate": "rescue",
  "possessive-imperative": "rescue",
  "question-inversion": "rescue",
  "question-subject-wh": "rescue",
  "question-inverted-aux": "rescue",
  "subordinate-main-clause": "rescue", // pass direction; the fail direction is reject-eligible
  "subordinate-only": "reject",
  "no-predicate-evidence": "observational",
  "short-utterance": "observational",
  "question-unresolved": "observational",
  "structural-kind": "never-override",
  "source-citation": "never-override",
  "hard-evidence": "never-override",
  "punctuation-residue": "never-override",
  "no-tokens": "never-override",
};

export const RESCUE_ELIGIBLE_REASONS: ReadonlySet<string> = new Set(
  Object.entries(REASON_CLASSIFICATION)
    .filter(([, category]) => category === "rescue")
    .map(([reason]) => reason),
);

/** Rejection authority modes (Stage 3I):
 *  - "full-reject": Stage 3G policy (subordinate-only + subordinate-main-clause) — benchmark only;
 *  - "narrow-reject": subordinate-only rejection only — benchmark only;
 *  - "rescue-only": NO NLP rejection (production recommendation). */
export type HybridPolicyMode = "full-reject" | "narrow-reject" | "rescue-only";

const REJECT_ELIGIBLE_BY_MODE: Record<HybridPolicyMode, ReadonlySet<string>> = {
  "full-reject": new Set(["subordinate-only", "subordinate-main-clause"]),
  "narrow-reject": new Set(["subordinate-only"]),
  "rescue-only": new Set(),
};

/** Full-reject rejection set (Stage 3G; kept for compatibility and benchmarking). */
export const REJECT_ELIGIBLE_REASONS: ReadonlySet<string> = REJECT_ELIGIBLE_BY_MODE["full-reject"];

export const NEVER_OVERRIDE_REASONS: ReadonlySet<string> = new Set(
  Object.entries(REASON_CLASSIFICATION)
    .filter(([, category]) => category === "never-override")
    .map(([reason]) => reason),
);

/** Whether an experimental reason is high-confidence rescue evidence. */
export function isRescueEligible(reason: string): boolean {
  return RESCUE_ELIGIBLE_REASONS.has(reason);
}

/** Whether an experimental reason is high-confidence rejection evidence under
 *  the given policy mode. */
export function isRejectEligible(reason: string, mode: HybridPolicyMode = "full-reject"): boolean {
  return REJECT_ELIGIBLE_BY_MODE[mode].has(reason);
}

/** Rejection-eligible set for a given policy mode. */
export function rejectEligibleReasonsFor(mode: HybridPolicyMode): ReadonlySet<string> {
  return REJECT_ELIGIBLE_BY_MODE[mode];
}

/**
 * Decide the hybrid verdict for one sentence-like unit. The authoritative B2I
 * result is the default and is returned unchanged unless a high-confidence
 * override applies:
 *
 * - RESCUE (current FAIL → hybrid PASS): the failure must be exclusively
 *   `no-finite-predicate`, with no punctuation residue, and the experimental
 *   evidence must prove an independent predicate/main clause.
 * - REJECT (current PASS → hybrid FAIL): only under the rejection-eligible set
 *   for the given mode (Stage 3I: "full-reject" and "narrow-reject" are
 *   benchmark-only; production uses "rescue-only" — no NLP rejection).
 *
 * Unknown experimental reasons never override.
 */
export function decideSentenceCompletenessHybrid(
  input: HybridSentenceInput,
  mode: HybridPolicyMode = "full-reject",
): HybridVerdict {
  const { text, authoritative, experimental } = input;

  if (authoritative.complete) {
    // Authoritative PASS is the default. Reject only on the mode's
    // rejection-eligible high-confidence reasons.
    if (
      !experimental.complete
      && REJECT_ELIGIBLE_BY_MODE[mode].has(experimental.reason)
    ) {
      return {
        complete: false,
        source: "nlp-reject",
        reason: experimental.reason,
        experimentalReason: experimental.reason,
      };
    }
    return {
      complete: true,
      source: "authoritative",
      reason: experimental.complete ? "agree-pass" : "no-override-pass",
      experimentalReason: experimental.reason,
    };
  }

  // Authoritative FAIL: rescue only under all safety conditions.
  const exclusivelyFinitePredicate =
    authoritative.issues.length > 0
    && authoritative.issues.every((issue) => issue.code === "no-finite-predicate");
  const noHardResidue = !isAuthoritativePunctuationOnlyResidue(text);
  if (
    exclusivelyFinitePredicate
    && noHardResidue
    && experimental.complete
    && RESCUE_ELIGIBLE_REASONS.has(experimental.reason)
  ) {
    return {
      complete: true,
      source: "nlp-rescue",
      reason: experimental.reason,
      experimentalReason: experimental.reason,
    };
  }

  const reason: HybridReasonCode =
    exclusivelyFinitePredicate && noHardResidue
      ? "no-rescue-weak-evidence"
      : "no-rescue-hard-evidence";
  return {
    complete: false,
    source: "authoritative",
    reason,
    experimentalReason: experimental.reason,
  };
}
