// ── DeepSeek response diagnostics ──
// Captures raw responses, detects malformed patterns, saves failures to disk.
// Diagnostic-only — does not modify responses.

import * as fs from "fs";
import * as path from "path";

// ── Types ──

export interface DeepSeekParseDiagnostic {
  stage: string;
  rawLength: number;
  finishReason: string;
  apiCompleted: boolean;
  jsonParseSucceeded: boolean;
  errorMessage: string;
  errorPosition?: number;
  contextBefore?: string;
  contextAfter?: string;
  /** File path where raw response was saved on failure */
  savedFilePath?: string;
  detectedPatterns: string[];
}

// ── Pattern detection ──

const MALFORMED_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  {
    name: "markdown_code_fences",
    test: (s) => /```/.test(s),
  },
  {
    name: "json_opening_fence",
    test: (s) => /```json/i.test(s),
  },
  {
    name: "leading_text_before_json",
    test: (s) => /^[^{[]/.test(s.trim()),
  },
  {
    name: "trailing_text_after_json",
    test: (s) => {
      const trimmed = s.trim();
      if (trimmed.startsWith("{")) {
        const lastBrace = trimmed.lastIndexOf("}");
        return lastBrace >= 0 && lastBrace < trimmed.length - 1 && trimmed.substring(lastBrace + 1).trim().length > 0;
      }
      if (trimmed.startsWith("[")) {
        const lastBracket = trimmed.lastIndexOf("]");
        return lastBracket >= 0 && lastBracket < trimmed.length - 1 && trimmed.substring(lastBracket + 1).trim().length > 0;
      }
      return false;
    },
  },
  {
    name: "multiple_top_level_objects",
    test: (s) => {
      const braceDepth = [];
      let topLevelObjects = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "{") {
          braceDepth.push(i);
          if (braceDepth.length === 1) topLevelObjects++;
        } else if (s[i] === "}") {
          braceDepth.pop();
        }
      }
      return topLevelObjects > 1;
    },
  },
  {
    name: "utf8_bom",
    test: (s) => s.charCodeAt(0) === 0xfeff,
  },
  {
    name: "null_bytes",
    test: (s) => s.includes("\0"),
  },
  {
    name: "unescaped_control_chars",
    test: (s) => /[\x00-\x1f]/.test(s.replace(/\n/g, "").replace(/\r/g, "").replace(/\t/g, "")),
  },
  {
    name: "trailing_commas",
    test: (s) => /,(\s*[}\]])/m.test(s),
  },
  {
    name: "unterminated_strings",
    test: (s) => {
      let inString = false;
      let escaped = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; }
      }
      return inString; // ended inside a string = unterminated
    },
  },
  {
    name: "invalid_backslash_escape",
    test: (s) => {
      let inString = false;
      let escaped = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escaped) {
          if (!'"\\/bfnrtu'.includes(ch)) return true;
          escaped = false;
          continue;
        }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; }
      }
      return false;
    },
  },
  {
    name: "literal_newlines_in_strings",
    test: (s) => {
      let inString = false;
      let escaped = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; }
        if (inString && (ch === "\n" || ch === "\r")) return true;
      }
      return false;
    },
  },
  {
    name: "wordpress_blocks_outside_json",
    test: (s) => {
      const trimmed = s.trim();
      if (trimmed.startsWith("{")) {
        const lastBrace = trimmed.lastIndexOf("}");
        const after = lastBrace >= 0 ? trimmed.substring(lastBrace + 1) : "";
        return /<!--\s*wp:/.test(after);
      }
      return /<!--\s*wp:/.test(trimmed) && !trimmed.trim().startsWith("{");
    },
  },
  {
    name: "empty_response",
    test: (s) => !s || s.trim().length === 0,
  },
  {
    name: "already_object",
    test: (s) => {
      try {
        const val = JSON.parse(s);
        return typeof val !== "object" || val === null;
      } catch {
        return false;
      }
    },
  },
];

export function detectMalformedPatterns(raw: string): string[] {
  return MALFORMED_PATTERNS
    .filter((p) => p.test(raw))
    .map((p) => p.name);
}

// ── Response capture and logging ──

const DEBUG_DIR = "debug";

function ensureDebugDir(): string {
  const dir = path.resolve(DEBUG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function logRawResponse(
  stage: string,
  content: string,
  finishReason: string,
): void {
  console.log(`[DEEPSEEK-RAW:${stage}] type=${typeof content} length=${content.length} finishReason=${finishReason}`);
  console.log(`[DEEPSEEK-RAW:${stage}] first500="${content.substring(0, 500).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
  console.log(`[DEEPSEEK-RAW:${stage}] last500="${content.substring(Math.max(0, content.length - 500)).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);

  const patterns = detectMalformedPatterns(content);
  if (patterns.length > 0) {
    console.log(`[DEEPSEEK-RAW:${stage}] detected-patterns=${patterns.join(", ")}`);
  }
}

export function saveFailedResponse(
  stage: string,
  content: string,
): string {
  const dir = ensureDebugDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeStage = stage.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `failed-deepseek-response-${safeStage}-${timestamp}.txt`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, content, "utf-8");
  console.log(`[DEEPSEEK-DIAG] Failed response saved: ${filepath}`);
  return filepath;
}

export function reportParseError(
  stage: string,
  raw: string,
  error: Error,
): DeepSeekParseDiagnostic {
  const diagnostic: DeepSeekParseDiagnostic = {
    stage,
    rawLength: raw.length,
    finishReason: "unknown", // will be overridden by caller
    apiCompleted: false,
    jsonParseSucceeded: false,
    errorMessage: error.message,
    detectedPatterns: detectMalformedPatterns(raw),
  };

  // Try to extract position info from the error message
  const posMatch = error.message.match(/position\s+(\d+)/i);
  if (posMatch) {
    diagnostic.errorPosition = parseInt(posMatch[1]);
    const pos = diagnostic.errorPosition;
    diagnostic.contextBefore = raw.substring(Math.max(0, pos - 200), pos).replace(/\n/g, "\\n");
    diagnostic.contextAfter = raw.substring(pos, Math.min(raw.length, pos + 200)).replace(/\n/g, "\\n");
  }

  console.error(`\n[DEEPSEEK-PARSE-ERROR]`);
  console.error(`  stage=${stage}`);
  console.error(`  message=${error.message}`);
  if (diagnostic.errorPosition !== undefined) {
    console.error(`  position=${diagnostic.errorPosition}`);
    console.error(`  contextBefore=${diagnostic.contextBefore}`);
    console.error(`  contextAfter=${diagnostic.contextAfter}`);
  }
  console.error(`  rawLength=${raw.length}`);
  console.error(`  detectedPatterns=${diagnostic.detectedPatterns.join(", ") || "none"}`);

  // Save to file
  diagnostic.savedFilePath = saveFailedResponse(stage, raw);

  return diagnostic;
}

/**
 * Parses JSON from a DeepSeek response with full diagnostics.
 * Does NOT modify the response — only passes it to JSON.parse/robustJsonParse.
 */
export function parseDeepSeekResponse(
  stage: string,
  content: string,
  finishReason: string,
  robustParser: (raw: string) => unknown,
): { result: unknown; diagnostic: DeepSeekParseDiagnostic } {
  // Log raw response
  logRawResponse(stage, content, finishReason);

  const diagnostic: DeepSeekParseDiagnostic = {
    stage,
    rawLength: content.length,
    finishReason,
    apiCompleted: finishReason === "stop",
    jsonParseSucceeded: false,
    errorMessage: "",
    detectedPatterns: detectMalformedPatterns(content),
  };

  try {
    const result = robustParser(content);
    diagnostic.jsonParseSucceeded = true;
    console.log(`[DEEPSEEK-PARSE:${stage}] apiCompleted=${diagnostic.apiCompleted} jsonParseSucceeded=true`);
    return { result, diagnostic };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const fullDiagnostic = reportParseError(stage, content, error);
    fullDiagnostic.apiCompleted = finishReason === "stop";
    fullDiagnostic.finishReason = finishReason;
    console.error(`[DEEPSEEK-PARSE:${stage}] apiCompleted=${fullDiagnostic.apiCompleted} jsonParseSucceeded=false`);
    throw error;
  }
}
