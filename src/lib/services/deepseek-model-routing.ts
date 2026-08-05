// ── DeepSeek model + thinking + budget routing for the document-context shadow path ──
//
// Routes every document-context shadow request to the correct model, thinking mode
// and output budget. The active zh-HK translation path is a SINGLE full-document
// call (thinking DISABLED) followed by ONE bounded editorial-review call (thinking
// ENABLED, medium effort). Both use the same large output budget (65,536 tokens,
// 180,000ms) so the full document / patch set is returned without truncation. The
// (retained dead-code) editorial-polish calls remain thinking-disabled with the
// editorial budget.
//
// Configurable via environment variables with documented defaults. This module
// never calls a provider — it only resolves request config.

export interface ModelRouting {
  model: string;
  thinkingMode: "enabled" | "disabled";
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens: number;
  timeoutMs: number;
}

export const EDITORIAL_POLISH_LABEL = "document-context-shadow-editorial-polish";
export const EDITORIAL_BILINGUAL_A_LABEL = "editorial-bilingual-a";
export const EDITORIAL_BILINGUAL_B_LABEL = "editorial-bilingual-b";
export const EDITORIAL_MONOLINGUAL_LABEL = "editorial-monolingual-proofread";
export const EDITORIAL_REVIEW_LABEL = "document-context-editorial-review";

/** Provider-compatible upper safety bound for output tokens. Raised to allow the
 *  single full-document translation call to use up to 65,536 tokens. Editorial
 *  routing keeps its own 32,768 default and is unaffected. */
export const MAX_OUTPUT_TOKENS_LIMIT = 65536;

// The single full-document translation call needs a large output budget to hold
// the complete zh-HK document JSON. Thinking is disabled for this call so the
// full budget is reserved for the document output, with no truncation risk.
const TRANSLATION_MAX_TOKENS = 65536;
const TRANSLATION_TIMEOUT_MS = 180000;
// The single bounded editorial-review call returns JSON patches for up to 25
// selected units; it uses thinking (medium effort) for claim/register judgement
// and the same large output budget as the translation call.
const REVIEW_MAX_TOKENS = 65536;
const REVIEW_TIMEOUT_MS = 180000;
const EDITORIAL_DEFAULT_MAX_TOKENS = 32768;
const EDITORIAL_DEFAULT_TIMEOUT_MS = 180000;

export function isCoherentChunkLabel(label: string): boolean {
  return /^document-context-shadow-chunk-\d+$/.test(label);
}

export function isEditorialPolishLabel(label: string): boolean {
  return label === EDITORIAL_POLISH_LABEL;
}

export function isEditorialBilingualLabel(label: string): boolean {
  return label === EDITORIAL_BILINGUAL_A_LABEL || label === EDITORIAL_BILINGUAL_B_LABEL;
}

export function isEditorialMonolingualLabel(label: string): boolean {
  return label === EDITORIAL_MONOLINGUAL_LABEL;
}

/** The single bounded editorial-review call label (a substantive 2nd call). */
export function isEditorialReviewLabel(label: string): boolean {
  return label === EDITORIAL_REVIEW_LABEL;
}

/** True for any of the three editorial calls (two bilingual + one monolingual). */
export function isAnyEditorialLabel(label: string): boolean {
  return isEditorialPolishLabel(label) || isEditorialBilingualLabel(label) || isEditorialMonolingualLabel(label);
}

/** Parse a positive integer from an env value; safely fall back on invalid/empty/zero/negative/non-numeric. */
function parsePositiveInt(value: string | undefined, fallback: number, max?: number): number {
  if (value === undefined || value === null) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) return fallback;
  if (max !== undefined && n > max) return max;
  return n;
}

function translationRouting(): ModelRouting {
  return {
    model: process.env.DEEPSEEK_TRANSLATION_MODEL || "deepseek-v4-flash",
    // The single full-document translation call uses thinking DISABLED so the
    // entire output budget is reserved for the complete zh-HK document JSON.
    thinkingMode: "disabled",
    reasoningEffort: undefined,
    maxTokens: TRANSLATION_MAX_TOKENS,
    timeoutMs: TRANSLATION_TIMEOUT_MS,
  };
}

function editorialRouting(): ModelRouting {
  return {
    model: process.env.DEEPSEEK_EDITORIAL_MODEL || "deepseek-v4-flash",
    thinkingMode: (process.env.DEEPSEEK_EDITORIAL_THINKING ?? "true") === "true" ? "enabled" : "disabled",
    reasoningEffort: (process.env.DEEPSEEK_EDITORIAL_REASONING_EFFORT || "high") as "low" | "medium" | "high",
    maxTokens: parsePositiveInt(process.env.DEEPSEEK_EDITORIAL_MAX_TOKENS, EDITORIAL_DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS_LIMIT),
    timeoutMs: parsePositiveInt(process.env.DEEPSEEK_EDITORIAL_TIMEOUT_MS, EDITORIAL_DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Editorial routing is deliberately NON-THINKING. DeepSeek V4 Flash thinking mode
 * is unreliable for these revision calls: the entire output budget can be consumed
 * by reasoning before any patch JSON is returned (finish_reason=length, content=0).
 * All three editorial calls reserve the full 32,768-token budget for the final
 * JSON patch and never enable thinking. No automatic thinking-enabled fallback.
 */
function editorialNonThinkingRouting(): ModelRouting {
  const base = editorialRouting();
  return { ...base, thinkingMode: "disabled", reasoningEffort: undefined };
}

/** The single bounded editorial-review call: thinking-enabled, medium effort, small budget. */
function reviewRouting(): ModelRouting {
  return {
    model: process.env.DEEPSEEK_EDITORIAL_MODEL || "deepseek-v4-flash",
    thinkingMode: "enabled",
    reasoningEffort: (process.env.DEEPSEEK_EDITORIAL_REASONING_EFFORT || "medium") as "low" | "medium" | "high",
    maxTokens: REVIEW_MAX_TOKENS,
    timeoutMs: REVIEW_TIMEOUT_MS,
  };
}

export function resolveModelRouting(label: string): ModelRouting {
  if (isEditorialReviewLabel(label)) return reviewRouting();
  if (isAnyEditorialLabel(label)) return editorialNonThinkingRouting();
  // Coherent translation chunks (and any other label) — translation routing.
  return translationRouting();
}

/** Expose the resolved per-purpose budgets for diagnostics. */
export function resolveResolvedBudgets(): {
  translation: { maxTokens: number; timeoutMs: number };
  editorial: { maxTokens: number; timeoutMs: number };
} {
  return {
    translation: {
      maxTokens: translationRouting().maxTokens,
      timeoutMs: translationRouting().timeoutMs,
    },
    editorial: {
      maxTokens: editorialRouting().maxTokens,
      timeoutMs: editorialRouting().timeoutMs,
    },
  };
}
