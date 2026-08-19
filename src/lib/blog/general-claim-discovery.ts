// ── General verifiable-claim discovery (bounded structured call) ──
// CLAIM_PATTERNS is a deterministic high-risk backstop but cannot define the
// complete universe of factual claims: ordinary declarative assertions
// (platform capabilities, payment/advertising mechanics, service availability,
// market conditions, company behaviour, rankings, event facts) carry no
// special keyword. This module is the ONE bounded structured model call that
// supplies verifiable-claim discovery to the existing factual-scan authority.
//
// Completeness contract (no silent boundaries):
// - every sentence of a scanned surface receives a stable deterministic ID
//   (`s<surfaceIndex>`) and is submitted inside a bounded batch;
// - the structured response must account for EVERY submitted sentence ID
//   exactly once — no missing, duplicate or unknown IDs;
// - each sentence returns `verifiableClaims: []` (successfully classified:
//   advice/hypothetical/opinion) or one or more self-contained claims with
//   preserved qualifiers;
// - truncated (`finishReason=length`), malformed, incomplete or invalid
//   responses are retried for THAT batch only; if still incomplete, the batch
//   is UNAVAILABLE and factual coverage is incomplete — discovery never fails
//   open to pattern-only fallback.
//
// It is NOT a new pipeline stage and NOT a second factual judge — the scanner
// merges its results into the same findSupportingEvidence entailment authority
// and the same cleanup path.

import type { ChatMessage } from "@/lib/services/deepseek";
import type {
  GeneralClaimDiscovery,
  GeneralDiscoveryBatchRequest,
  GeneralDiscoveryBatchResult,
  GeneralDiscoveryResponseSentence,
} from "@/lib/blog/factual-risk-scanner";

export const GENERAL_CLAIM_DISCOVERY_STAGE = "factual-general-claim-discovery";

/** Content-level retries per batch (beyond the provider retry seam): the
 *  first attempt plus one re-attempt of THE SAME BATCH. Bounded by design. */
const BATCH_CONTENT_ATTEMPTS = 2;
const MAX_CLAIM_LENGTH = 400;
const DISCOVERY_MAX_TOKENS = 2048;
const DISCOVERY_MAX_TOKENS_CAP = 4096;

/** Distinct coverage failure — reported as factual-discovery/coverage
 *  unavailable, never as an unsupported-content defect. */
export class GeneralClaimDiscoveryUnavailableError extends Error {
  constructor(reason: string) {
    super(`general claim discovery unavailable: ${reason}`);
    this.name = "GeneralClaimDiscoveryUnavailableError";
  }
}

const SYSTEM_PROMPT = [
  "You are the claimhood extraction component of a deterministic fact-checking pipeline.",
  "You receive a bounded batch of sentences, each with a stable sentenceId.",
  "Classify EVERY submitted sentence and return, for EACH sentenceId (exactly once):",
  "the externally verifiable factual claims that sentence contains.",
  "",
  "For each sentence return:",
  '- "sentenceId": the exact ID you were given;',
  '- "verifiableClaims": [] when the sentence has no verifiable claims, otherwise one or more claims.',
  "",
  "Include ordinary non-numeric claims, for example:",
  '- platform or product capabilities ("You can show a short, friendly ad to anyone who has walked past your street in the last week");',
  '- business/service availability and payment or advertising mechanics ("you only pay when someone actually taps or calls");',
  "- market conditions, company behaviour, rankings or relationships, event facts;",
  "- measurable causal or performance statements.",
  "",
  "EXCLUDE:",
  '- advice, guidance or recommendations ("Start small and test what works");',
  "- rhetorical language, subjective opinion, and clearly hypothetical or illustrative examples;",
  "- structural/topic text, headings, bare years, and propositions already driven by numbers, percentages, dates, comparatives or superlatives;",
  "- anything the text does not actually assert.",
  "",
  "MANDATORY:",
  "- Preserve every truth-conditional qualifier (widely seen, reportedly, may, might, estimated, according to, temporal scope).",
  "  NEVER strengthen modality, attribution, comparison or certainty.",
  "- Quote each claim self-contained, using the EXACT source wording (a sentence or a complete clause) from ITS OWN sentence.",
  "- Do not invent, merge or paraphrase content.",
  "- Return EVERY submitted sentenceId exactly once, even when verifiableClaims is empty.",
  "",
  "Respond ONLY with JSON matching this shape:",
  '{"sentences":[{"sentenceId":"s0","verifiableClaims":["<exact wording>"]},{"sentenceId":"s1","verifiableClaims":[]}]}',
].join("\n");

function userMessageFor(batch: GeneralDiscoveryBatchRequest): string {
  return [
    "Classify every sentence ID below. Every submitted sentenceId must appear exactly once in your response.",
    "",
    JSON.stringify({ sentences: batch.sentences }, null, 0),
  ].join("\n");
}

/**
 * Parse the model's structured discovery response. Tolerant of markdown
 * fences; anything that is not a valid `{sentences:[...]}` object yields null.
 */
export function parseGeneralDiscoveryResponse(content: string): GeneralDiscoveryBatchResult | null {
  if (!content || typeof content !== "string") return null;
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned) as unknown;
  } catch {
    return null;
  }
  const sentences = (parsed as { sentences?: unknown })?.sentences;
  if (!Array.isArray(sentences)) return null;
  return { sentences: sentences as GeneralDiscoveryResponseSentence[] };
}

/**
 * Deterministic completeness verification: every submitted sentence ID must
 * appear exactly once — no missing IDs, no duplicates, no unknown IDs — and
 * every claim entry must be a valid non-empty bounded string. Returns the
 * list of violations (empty = complete).
 */
export function verifyGeneralDiscoveryCompleteness(
  request: GeneralDiscoveryBatchRequest,
  result: GeneralDiscoveryBatchResult | null,
): string[] {
  if (!result || !Array.isArray(result.sentences)) {
    return ["response has no sentences array"];
  }
  const errors: string[] = [];
  const submittedIds = request.sentences.map((s) => s.sentenceId);
  const returnedIds = result.sentences.map((s) => s.sentenceId);

  const submittedDuplicates = submittedIds.filter((id, index) => submittedIds.indexOf(id) !== index);
  if (submittedDuplicates.length > 0) {
    errors.push(`duplicate submitted sentence ids: ${[...new Set(submittedDuplicates)].join(", ")}`);
  }
  const returnedDuplicates = returnedIds.filter((id, index) => returnedIds.indexOf(id) !== index);
  if (returnedDuplicates.length > 0) {
    errors.push(`duplicate sentence ids in response: ${[...new Set(returnedDuplicates)].join(", ")}`);
  }
  const unknown = returnedIds.filter((id) => !submittedIds.includes(id));
  if (unknown.length > 0) {
    errors.push(`unknown sentence ids in response: ${[...new Set(unknown)].join(", ")}`);
  }
  const missing = submittedIds.filter((id) => !returnedIds.includes(id));
  if (missing.length > 0) {
    errors.push(`missing sentence ids in response: ${missing.join(", ")}`);
  }
  for (const entry of result.sentences) {
    if (typeof entry?.sentenceId !== "string") {
      errors.push("response contains a sentence entry without a sentenceId");
      continue;
    }
    if (!Array.isArray(entry.verifiableClaims)) {
      errors.push(`sentence ${entry.sentenceId} has no verifiableClaims array`);
      continue;
    }
    for (const claim of entry.verifiableClaims) {
      if (typeof claim !== "string" || !claim.trim() || claim.trim().length > MAX_CLAIM_LENGTH) {
        errors.push(`sentence ${entry.sentenceId} has an invalid claim entry`);
      }
    }
  }
  return errors;
}

export interface GeneralClaimDiscoveryOptions {
  /** Bounded completion budget for a structured batch response. */
  maxTokens?: number;
}

/**
 * Build the bounded structured claim-discovery call from the pipeline's
 * existing `chatWithRetry` seam. Exactly ONE call per batch; a batch that is
 * truncated, malformed, incomplete or unverifiable is retried once (same
 * batch only, bounded budget escalation) and then throws
 * `GeneralClaimDiscoveryUnavailableError` — coverage is unknown, never
 * silently pattern-only.
 */
export function makeGeneralClaimDiscovery(
  chatWithRetry: (messages: ChatMessage[], options?: Record<string, unknown>, stage?: string) => Promise<{ content: string; finishReason?: string }>,
  options?: GeneralClaimDiscoveryOptions,
): GeneralClaimDiscovery {
  const baseMaxTokens = options?.maxTokens ?? DISCOVERY_MAX_TOKENS;
  return async (request: GeneralDiscoveryBatchRequest): Promise<GeneralDiscoveryBatchResult> => {
    if (!request?.sentences?.length) {
      return { sentences: [] };
    }
    let lastIssue = "no attempt succeeded";
    for (let attempt = 0; attempt < BATCH_CONTENT_ATTEMPTS; attempt++) {
      const maxTokens = Math.min(
        DISCOVERY_MAX_TOKENS_CAP,
        Math.floor(baseMaxTokens * (attempt === 0 ? 1 : 1.5)),
      );
      try {
        const result = await chatWithRetry(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessageFor(request) },
          ],
          {
            temperature: 0,
            maxTokens,
            responseFormat: { type: "json_object" },
          },
          GENERAL_CLAIM_DISCOVERY_STAGE,
        );
        if (result.finishReason === "length") {
          lastIssue = "truncated response (max token budget reached)";
          continue;
        }
        const parsed = parseGeneralDiscoveryResponse(result.content);
        const violations = verifyGeneralDiscoveryCompleteness(request, parsed);
        if (violations.length === 0) {
          return parsed!;
        }
        lastIssue = violations.join("; ");
      } catch (err) {
        lastIssue = err instanceof Error ? err.message : String(err);
      }
    }
    throw new GeneralClaimDiscoveryUnavailableError(lastIssue);
  };
}
