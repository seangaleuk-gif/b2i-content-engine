export interface TranslationVersionMetadata {
  sourceEnVersionId: number;
  focusKeyphrase: string;
  review?: TranslationReviewSummary;
}

/** Optional editorial-review diagnostics embedded in the saved version summary. */
export interface TranslationReviewSummary {
  selectedUnitIds: string[];
  selectedReasons: Array<{ sourceUnitId: string; reasons: string[]; mandatory: boolean }>;
  decisions: Array<{
    sourceUnitId: string;
    decision: "replace" | "retain";
    reasonCodes: string[];
    edits?: Array<{ fieldId: string; replacementText: string }>;
  }>;
  appliedEditCount: number;
  retainedCount: number;
  status: "not-run" | "run" | "failed";
  failure: string | null;
  documentAccepted?: boolean;
  unresolvedUnitIds?: string[];
}

const METADATA_TYPE = "b2i-translation";
const METADATA_VERSION = 1;

export function buildTranslationVersionSummary(
  sourceEnVersionId: number,
  focusKeyphrase: string,
  review?: TranslationReviewSummary,
): string {
  if (!Number.isInteger(sourceEnVersionId) || sourceEnVersionId <= 0) {
    throw new Error("sourceEnVersionId must be a positive integer");
  }
  const payload: Record<string, unknown> = {
    type: METADATA_TYPE,
    version: METADATA_VERSION,
    sourceEnVersionId,
    focusKeyphrase: focusKeyphrase.trim(),
  };
  if (review) {
    payload.review = {
      status: review.status,
      selectedUnitIds: review.selectedUnitIds,
      selectedReasons: review.selectedReasons,
      decisions: review.decisions,
      appliedEditCount: review.appliedEditCount,
      retainedCount: review.retainedCount,
      failure: review.failure,
      documentAccepted: review.documentAccepted ?? false,
      unresolvedUnitIds: review.unresolvedUnitIds ?? [],
    };
  }
  return JSON.stringify(payload);
}

/** Parse the current envelope and the legacy source-en-version:<ID> marker. */
export function parseTranslationVersionSummary(summary: unknown): TranslationVersionMetadata | null {
  if (typeof summary !== "string" || !summary.trim()) return null;
  const value = summary.trim();

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.type === METADATA_TYPE
      && parsed.version === METADATA_VERSION
      && Number.isInteger(parsed.sourceEnVersionId)
      && Number(parsed.sourceEnVersionId) > 0
    ) {
      const reviewValue = parsed.review;
      const review = reviewValue && typeof reviewValue === "object" && !Array.isArray(reviewValue)
        ? reviewValue as Record<string, unknown>
        : null;
      const parsedReview: TranslationReviewSummary | undefined = review
        && ["not-run", "run", "failed"].includes(String(review.status))
        ? {
            status: review.status as TranslationReviewSummary["status"],
            selectedUnitIds: Array.isArray(review.selectedUnitIds) ? review.selectedUnitIds.map(String) : [],
            selectedReasons: Array.isArray(review.selectedReasons)
              ? review.selectedReasons as TranslationReviewSummary["selectedReasons"]
              : [],
            decisions: Array.isArray(review.decisions)
              ? review.decisions as TranslationReviewSummary["decisions"]
              : [],
            appliedEditCount: Number.isFinite(Number(review.appliedEditCount)) ? Number(review.appliedEditCount) : 0,
            retainedCount: Number.isFinite(Number(review.retainedCount)) ? Number(review.retainedCount) : 0,
            failure: typeof review.failure === "string" ? review.failure : null,
            documentAccepted: review.documentAccepted === true,
            unresolvedUnitIds: Array.isArray(review.unresolvedUnitIds) ? review.unresolvedUnitIds.map(String) : [],
          }
        : undefined;
      return {
        sourceEnVersionId: Number(parsed.sourceEnVersionId),
        focusKeyphrase: typeof parsed.focusKeyphrase === "string" ? parsed.focusKeyphrase.trim() : "",
        ...(parsedReview ? { review: parsedReview } : {}),
      };
    }
  } catch {
    // Fall through to the legacy marker.
  }

  const legacy = value.match(/^source-en-version:(\d+)$/);
  if (!legacy) return null;
  return { sourceEnVersionId: Number(legacy[1]), focusKeyphrase: "" };
}
