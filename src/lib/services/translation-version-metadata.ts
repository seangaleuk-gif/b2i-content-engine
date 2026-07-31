export interface TranslationVersionMetadata {
  sourceEnVersionId: number;
  focusKeyphrase: string;
}

const METADATA_TYPE = "b2i-translation";
const METADATA_VERSION = 1;

export function buildTranslationVersionSummary(
  sourceEnVersionId: number,
  focusKeyphrase: string,
): string {
  if (!Number.isInteger(sourceEnVersionId) || sourceEnVersionId <= 0) {
    throw new Error("sourceEnVersionId must be a positive integer");
  }
  return JSON.stringify({
    type: METADATA_TYPE,
    version: METADATA_VERSION,
    sourceEnVersionId,
    focusKeyphrase: focusKeyphrase.trim(),
  });
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
      return {
        sourceEnVersionId: Number(parsed.sourceEnVersionId),
        focusKeyphrase: typeof parsed.focusKeyphrase === "string" ? parsed.focusKeyphrase.trim() : "",
      };
    }
  } catch {
    // Fall through to the legacy marker.
  }

  const legacy = value.match(/^source-en-version:(\d+)$/);
  if (!legacy) return null;
  return { sourceEnVersionId: Number(legacy[1]), focusKeyphrase: "" };
}
