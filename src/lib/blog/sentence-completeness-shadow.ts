// ── Stage 3E/3F: sentence-completeness observational shadow ──
// Runs the clause-aware Compromise classifier BESIDE the authoritative shared
// sentence-completeness analyzer and logs disagreements. ZERO authority: it
// never triggers or prevents repair, never alters producer validation, the
// producer contract, malformed-prose results, final QC or persistence.
//
// GRANULARITY (Stage 3F): the authoritative analyzer evaluates sentence-like
// units within a prose block (`detectProseSentenceDefects` → `splitSentences`),
// while the aggregate result describes the whole block. The shadow therefore
// compares verdicts PER UNIT using the SAME `splitSentences` segmentation the
// authoritative analyzer uses — there is exactly one sentence segmentation. The
// experimental classifier receives the exact unit the deterministic
// finite-predicate logic judges, so unit-level disagreements are attributable
// to the classifier, not to comparing a whole paragraph against one sentence.
//
// Gating reuses the existing pipeline debug flag (ENABLE_PIPELINE_DEBUG_TRACE,
// canonically owned by src/lib/pipeline/pipeline-debug-trace.ts). When the flag
// is off the shadow returns before touching Compromise, so no POS-tagging cost
// is paid and no linguistic-shadow log is emitted. The flag check is inlined
// here (instead of importing pipeline-debug-trace) because this module is
// imported by the sentence-completeness leaf, which must stay free of validator
// dependency cycles.
//
// Recursion protection: per-unit authoritative verdicts come from
// `analyzeSentenceCompletenessDeterministic` (the shadow-free core) and the
// classifier receives that analysis as input and never re-invokes the
// analyzer, so shadow execution can never recurse.

import {
  analyzeSentenceCompletenessDeterministic,
  isSourceCitationText,
  type SentenceCompletenessAnalysis,
  type SentenceCompletenessKind,
  type SentenceCompletenessOptions,
} from "@/lib/blog/sentence-completeness";
import { clauseAwareVerdict } from "@/lib/blog/clause-aware-classifier";
import { splitSentences } from "@/lib/seo/seo-text-utils";

const ENABLE_FLAG = "ENABLE_PIPELINE_DEBUG_TRACE";
const SNIPPET_LENGTH = 160;
const SHADOW_TAG = "[sentence-completeness-shadow]";
const PROSE_KINDS = new Set<SentenceCompletenessKind>(["paragraph", "quote", "faq-answer"]);

// Stable bounded dedup of already-emitted unit disagreements. Repeated checks
// of the same unit across pipeline stages (the same block is re-analyzed many
// times) must not spam the log, while different units always stay visible.
const DEDUP_MAX = 512;
const recentDisagreements = new Set<string>();
const recentDisagreementOrder: string[] = [];

export function isSentenceCompletenessShadowEnabled(): boolean {
  return process.env[ENABLE_FLAG] === "true";
}

/** Reset the disagreement dedup (test isolation and debug-run boundaries). */
export function resetSentenceCompletenessShadowDedup(): void {
  recentDisagreements.clear();
  recentDisagreementOrder.length = 0;
}

/** Bounded, single-line, quote-safe text snippet for the disagreement log. */
function boundedText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, "'")
    .replace(/\\/g, "/")
    .slice(0, SNIPPET_LENGTH);
}

function emitDisagreement(
  kind: SentenceCompletenessKind,
  unit: string,
  unitAuthoritative: SentenceCompletenessAnalysis,
  unitExperimental: { complete: boolean; reason: string },
): void {
  const currentVerdict = unitAuthoritative.complete ? "pass" : "fail";
  const experimentalVerdict = unitExperimental.complete ? "pass" : "fail";
  const issue = unitAuthoritative.issues[0];
  const issueCode = issue ? issue.code : "none";
  const key = `${kind}|${currentVerdict}|${experimentalVerdict}|${issueCode}|${unit}`;
  if (recentDisagreements.has(key)) return;
  recentDisagreements.add(key);
  recentDisagreementOrder.push(key);
  if (recentDisagreementOrder.length > DEDUP_MAX) {
    const oldest = recentDisagreementOrder.shift();
    if (oldest !== undefined) recentDisagreements.delete(oldest);
  }
  const issueField = issue ? ` currentIssue=${issue.code}` : "";
  const snippet = boundedText(unit);
  console.warn(
    `${SHADOW_TAG} kind=${kind} current=${currentVerdict} experimental=${experimentalVerdict}${issueField} reason=${unitExperimental.reason} text="${snippet}"`,
  );
}

/**
 * Compare authoritative and experimental verdicts per sentence-like unit of a
 * prose block. Logs one concise bounded event per unit disagreement and
 * returns nothing. Never throws: any experimental failure is swallowed so the
 * shadow can never affect a production decision.
 */
export function runSentenceCompletenessShadow(
  text: string,
  kind: SentenceCompletenessKind,
  options?: SentenceCompletenessOptions,
): void {
  if (!isSentenceCompletenessShadowEnabled()) return;
  if (!text || !text.trim()) return;
  // Structural kinds (headings, list items, table cells) and source citations
  // are resolved deterministically by the authoritative analyzer; the
  // experimental classifier mirrors those results, so a disagreement is
  // impossible — skip the POS work entirely.
  if (!PROSE_KINDS.has(kind)) return;
  if (isSourceCitationText(text)) return;

  // The authoritative segmentation: the same splitSentences used by the
  // authoritative detectProseSentenceDefects. One segmentation definition.
  for (const unit of splitSentences(text)) {
    let unitAuthoritative: SentenceCompletenessAnalysis;
    let unitExperimental: { complete: boolean; reason: string };
    try {
      unitAuthoritative = analyzeSentenceCompletenessDeterministic(unit, kind, options);
      unitExperimental = clauseAwareVerdict(unit, kind, unitAuthoritative);
    } catch {
      // Experimental failures are observational only and must never surface.
      continue;
    }
    if (unitAuthoritative.complete === unitExperimental.complete) continue;
    emitDisagreement(kind, unit, unitAuthoritative, unitExperimental);
  }
}
