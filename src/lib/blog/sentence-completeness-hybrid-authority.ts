// ── Stage 3H/3I: feature-flagged hybrid sentence-completeness authority ──
// Controlled rollout of the conservative hybrid policy behind an explicit
// opt-in flag. When ENABLE_HYBRID_SENTENCE_COMPLETENESS=true, the shared
// analyzeSentenceCompleteness layer returns the hybrid decision; otherwise the
// deterministic baseline is returned byte-for-byte (default OFF).
//
// Stage 3I hardening: the production authority is ASYMMETRIC — deterministic
// B2I + high-confidence NLP RESCUE only (mode "rescue-only"). NLP rejection is
// NOT part of production authority: the first controlled live rollout showed
// that rejection evidence (`subordinate-main-clause` / `subordinate-only`)
// depends on Compromise verb tagging and can falsely reject valid English.
//
// Only the shared layer may switch authority — no producer/mutator implements
// its own hybrid decision. Hard safety guarantees are inherited unchanged:
//   - CURRENT FAIL → PASS only when the authoritative failure is exclusively
//     the finite-predicate family, the experimental reason is rescue-eligible,
//     and no hard malformed/punctuation/structural issue exists;
//   - CURRENT PASS can NEVER become FAIL from NLP evidence;
//   - ambiguous/unknown reasons never override;
//   - hard malformed/corruption failures are never rescued.
//
// Recursion protection: per-unit authoritative verdicts come from the
// deterministic core (never the wrapper), and the classifier consumes the
// analysis it is given. Override diagnostics reuse the pipeline debug flag so
// debugging and authority remain separate concerns.

import {
  analyzeSentenceCompletenessDeterministic,
  isProseKind,
  isSourceCitationText,
  type SentenceCompletenessAnalysis,
  type SentenceCompletenessKind,
  type SentenceCompletenessOptions,
} from "@/lib/blog/sentence-completeness";
import { clauseAwareVerdict } from "@/lib/blog/clause-aware-classifier";
import {
  decideSentenceCompletenessHybrid,
  type HybridDecisionSource,
} from "@/lib/blog/hybrid-sentence-completeness";
import { splitSentences } from "@/lib/seo/seo-text-utils";

const HYBRID_FLAG = "ENABLE_HYBRID_SENTENCE_COMPLETENESS";
const DEBUG_FLAG = "ENABLE_PIPELINE_DEBUG_TRACE";
const SNIPPET_LENGTH = 160;
const HYBRID_TAG = "[sentence-completeness-hybrid]";
// Production authority is asymmetric (Stage 3I): high-confidence rescue only,
// never NLP rejection.
const PRODUCTION_POLICY_MODE = "rescue-only" as const;

export function isHybridSentenceCompletenessEnabled(): boolean {
  return process.env[HYBRID_FLAG] === "true";
}

/** Bounded, single-line, quote-safe text snippet for override diagnostics. */
function boundedText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, "'")
    .replace(/\\/g, "/")
    .slice(0, SNIPPET_LENGTH);
}

export interface HybridAuthorityUnitOverride {
  /** The exact sentence-like unit whose verdict was overridden. */
  unit: string;
  /** Deterministic per-unit verdict. */
  current: boolean;
  /** Hybrid per-unit verdict. */
  hybrid: boolean;
  source: HybridDecisionSource;
  reason: string;
}

export interface HybridAuthorityResult {
  analysis: SentenceCompletenessAnalysis;
  /** Only units where the hybrid decision differs from the deterministic one. */
  overrides: HybridAuthorityUnitOverride[];
}

/**
 * Produce the feature-flagged hybrid aggregate for one (text, kind) unit using
 * the deterministic result as the baseline. Hard outcomes (missing terminal
 * punctuation, trailing fragments, missing-aux-inversion, structural kinds,
 * source citations, colon continuations) are returned unchanged; only the
 * per-sentence finite-predicate family is re-decided by the hybrid policy in
 * RESCUE-ONLY mode (current PASS can never become FAIL from NLP evidence).
 */
export function decideHybridAuthority(
  text: string,
  kind: SentenceCompletenessKind,
  options: SentenceCompletenessOptions | undefined,
  deterministic: SentenceCompletenessAnalysis,
): HybridAuthorityResult {
  if (!isProseKind(kind)) return { analysis: deterministic, overrides: [] };
  if (isSourceCitationText(text)) return { analysis: deterministic, overrides: [] };
  if (!text || !text.trim()) return { analysis: deterministic, overrides: [] };
  const hardIssues = deterministic.issues.filter((issue) => issue.code !== "no-finite-predicate");
  if (hardIssues.length > 0) return { analysis: deterministic, overrides: [] };

  const overrides: HybridAuthorityUnitOverride[] = [];
  const failures: string[] = [];
  for (const unit of splitSentences(text)) {
    const unitDeterministic = analyzeSentenceCompletenessDeterministic(unit, kind, options);
    const experimental = clauseAwareVerdict(unit, kind, unitDeterministic);
    const unitHybrid = decideSentenceCompletenessHybrid(
      {
        text: unit,
        kind,
        authoritative: unitDeterministic,
        experimental,
      },
      PRODUCTION_POLICY_MODE,
    );
    if (unitDeterministic.complete !== unitHybrid.complete) {
      overrides.push({
        unit,
        current: unitDeterministic.complete,
        hybrid: unitHybrid.complete,
        source: unitHybrid.source,
        reason: unitHybrid.reason,
      });
    }
    if (!unitHybrid.complete) failures.push(unit);
  }

  if (failures.length === 0) {
    return { analysis: { complete: true, issues: [], trailingFragment: null }, overrides };
  }
  return {
    analysis: {
      complete: false,
      issues: failures.map(() => ({
        code: "no-finite-predicate",
        message: "sentence-like unit has no finite predicate (fragment)",
        trailingFragment: null,
      })),
      trailingFragment: null,
    },
    overrides,
  };
}

/**
 * Debug-gated diagnostics: when ENABLE_PIPELINE_DEBUG_TRACE=true, emit one
 * concise line per ACTUAL authoritative override. No-override decisions are
 * never logged. Observational-only; never affects the returned analysis.
 */
export function runHybridOverrideDiagnostics(overrides: HybridAuthorityUnitOverride[]): void {
  if (process.env[DEBUG_FLAG] !== "true") return;
  for (const override of overrides) {
    const currentVerdict = override.current ? "pass" : "fail";
    const hybridVerdict = override.hybrid ? "pass" : "fail";
    const snippet = boundedText(override.unit);
    console.warn(
      `${HYBRID_TAG} current=${currentVerdict} hybrid=${hybridVerdict} source=${override.source} reason=${override.reason} text="${snippet}"`,
    );
  }
}
