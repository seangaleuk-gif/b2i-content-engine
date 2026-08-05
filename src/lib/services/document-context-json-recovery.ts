// ── Safe malformed-JSON diagnostics + outer-wrapper recovery ──
//
// The full-document zh-HK translation response is a single large JSON object.
// Occasionally the provider wraps it in prose or a harmless prefix/suffix. This
// module provides:
//   1. parseWithJsonDiagnostics — preserves the original JSON.parse error message,
//      extracts the reported character position, and builds a bounded REDACTED
//      snippet around that position for safe observability (no raw key material,
//      no full article text).
//   2. extractFirstBalancedJsonObject — on initial parse failure only, scans for
//      the first balanced top-level JSON object, respecting quoted strings and
//      escape sequences, and returns the extracted slice for a fresh parse.
//
// This module NEVER repairs quotes, commas, escapes, or brackets inside JSON; it
// NEVER invents or inserts content; and it NEVER accepts partial units. Any such
// repair must be rejected so a complete 105-unit response is never silently
// produced from an incomplete one. Recovery only helps when the response already
// contains a complete, valid JSON object wrapped in outer prose.

export interface JsonParseDiagnostics {
  /** Original JSON.parse error message (e.g. "Unexpected token 'X', ..."). */
  errorMessage: string;
  /** Reported 0-based character position extracted from the error, if available. */
  position: number | null;
  /** Bounded redacted snippet around the reported position. */
  snippet: string | null;
  /** True when the wrapped (balanced) object recovered a parseable slice. */
  recovered: boolean;
}

const SNIPPET_RADIUS = 60;
const SNIPPET_MAX = 400;

/** Extract a 0-based numeric character position from a JSON.parse error message. */
export function extractJsonErrorPosition(message: string): number | null {
  // "position N (line L column C)" or "at position N".
  const pos = /position\s+(\d+)/i.exec(message);
  if (pos) return Number(pos[1]);
  const col = /line\s+\d+\s+column\s+(\d+)/i.exec(message);
  if (col) return Number(col[1]) - 1;
  return null;
}

/** Build a bounded redacted snippet centered on `position` within `content`. */
export function buildRedactedSnippet(content: string, position: number): string {
  const start = Math.max(0, position - SNIPPET_RADIUS);
  const end = Math.min(content.length, position + SNIPPET_RADIUS + 1);
  let snippet = content.slice(start, end);
  if (snippet.length > SNIPPET_MAX) {
    snippet = `${snippet.slice(0, SNIPPET_MAX)}…`;
  }
  // Redact URLs to avoid persisting raw link targets.
  snippet = snippet.replace(/https?:\/\/\S+/gi, "[url]");
  if (start > 0) snippet = `…${snippet}`;
  if (end < content.length) snippet = `${snippet}…`;
  return snippet;
}

/**
 * Parse JSON while preserving full diagnostics. On failure, returns the original
 * error message, the reported position (when available) and a redacted snippet.
 */
export function parseWithJsonDiagnostics(content: string): {
  parsed: unknown;
  diagnostics: JsonParseDiagnostics | null;
} {
  try {
    return { parsed: JSON.parse(content), diagnostics: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = extractJsonErrorPosition(message);
    const snippet = position === null ? null : buildRedactedSnippet(content, position);
    return { parsed: null, diagnostics: { errorMessage: message, position, snippet, recovered: false } };
  }
}

/**
 * Scan for the first balanced top-level JSON object (respecting quoted strings
 * and escape sequences) and return the extracted slice, or null if no balanced
 * object exists. `content` is scanned from its first '{' so a prose prefix is
 * skipped; the slice ends at the matching top-level '}'.
 */
export function extractFirstBalancedJsonObject(content: string): string | null {
  const firstBrace = content.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return content.slice(firstBrace, i + 1);
      }
    }
  }
  return null;
}
