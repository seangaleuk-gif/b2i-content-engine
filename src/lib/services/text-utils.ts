import { AppError } from "./errors";

export function countReadableWords(html: string): number {
  // Strip non-readable content first
  const readable = html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "") // CTA, switcher, schema
    .replace(/<script[\s\S]*?<\/script>/gi, "")                             // JSON-LD, inline scripts
    .replace(/<style[\s\S]*?<\/style>/gi, "")                               // CSS
    .replace(/<!--[\s\S]*?-->/g, "")                                        // All WP block comments
    .replace(/<[^>]+>/g, " ")                                               // HTML tags → spaces
    .replace(/https?:\/\/\S+/gi, "")                                        // URLs
    .replace(/```[\s\S]*?```/g, "")                                         // Code fences
    .replace(/[\[\]\(\)#*_~`>|{}]/g, " ")                                  // Markdown/metadata chars
    .replace(/\s+/g, " ")
    .trim();
  return readable ? readable.split(/\s+/).length : 0;
}

/** Word-count tolerance: article ok within 95%-110% of target */
export function wordCountRange(target: number): { min: number; max: number } {
  return {
    min: Math.floor(target * 0.95),
    max: Math.ceil(target * 1.10),
  };
}

/** Check if text contains the exact focus keyphrase as a contiguous substring (case-insensitive) */
export function containsExactPhrase(text: string, keyphrase: string): boolean {
  return text.toLowerCase().includes(keyphrase.toLowerCase().trim());
}

/** Count occurrences of exact keyphrase in text (case-insensitive) */
export function countKeyphraseOccurrences(text: string, keyphrase: string): number {
  if (!keyphrase) return 0;
  const lower = text.toLowerCase();
  const kp = keyphrase.toLowerCase().trim();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(kp, pos)) !== -1) {
    count++;
    pos += kp.length;
  }
  return count;
}

/** Canonical word counter — same as countReadableWords but with legacy API name */
export const countBodyWords = countReadableWords;

// Backward-compatible: countWords and cleanBodyText delegate to countReadableWords
export function countWords(text: string): number { return countReadableWords(text); }
export function cleanBodyText(text: string): string {
  // Return cleaned text (original behavior for clients that need the text)
  return text
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSentences(text: string): string[] {
  return cleanBodyText(text)
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

export function robustJsonParse(raw: string, stage?: string): unknown {
  // ── Diagnostics: log raw content before parsing ──
  if (stage) {
    console.log(`[JSON-PARSE:${stage}] type=${typeof raw} length=${raw.length}`);
    console.log(`[JSON-PARSE:${stage}] first300="${raw.substring(0, 300).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
    console.log(`[JSON-PARSE:${stage}] last300="${raw.substring(Math.max(0, raw.length - 300)).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
  }

  function logParseError(label: string, err: unknown, text: string): void {
    if (!stage) return;
    const msg = err instanceof Error ? err.message : String(err);
    const posMatch = msg.match(/position\s+(\d+)/i);
    const pos = posMatch ? parseInt(posMatch[1]) : -1;
    const ctx = pos >= 0
      ? ` ctx="${text.substring(Math.max(0, pos - 60), Math.min(text.length, pos + 60)).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`
      : "";
    console.log(`[JSON-PARSE:${stage}] ${label} FAILED: ${msg}${ctx}`);
  }

  // Direct parse
  try { return JSON.parse(raw); } catch (e) { logParseError("direct", e, raw); }

  // Extract from markdown code blocks
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlock) {
    if (stage) console.log(`[JSON-PARSE:${stage}] extracting from markdown code fence, innerLen=${codeBlock[1].length}`);
    const inner = codeBlock[1].trim();
    try { return JSON.parse(inner); } catch (e) { logParseError("codeFence", e, inner); }
  }

  // Find outermost JSON object
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const outer = objMatch[0];
    if (stage) console.log(`[JSON-PARSE:${stage}] extracting outermost JSON object, len=${outer.length}`);
    try { return JSON.parse(outer); } catch (e) {
      logParseError("outerObject", e, outer);
      // Repair trailing commas before closing brackets/braces
      const repaired = outer.replace(/,(\s*[}\]])/g, "$1");
      if (stage) console.log(`[JSON-PARSE:${stage}] repairing trailing commas, repairedLen=${repaired.length}`);
      try { return JSON.parse(repaired); } catch (e2) { logParseError("trailingComma", e2, repaired); }
      // Repair unescaped quotes inside known string properties (HTML with WordPress blocks)
      const malformedResult = extractMalformedJsonStringProperty(outer, ["body", "intro", "conclusion", "html", "blog", "faqHtml"]);
      if (malformedResult) {
        if (stage) console.log(`[JSON-PARSE:${stage}] malformed-string fallback succeeded property=${Object.keys(malformedResult)[0]}`);
        return malformedResult;
      }
    }
  }

  if (stage) {
    console.log(`[JSON-PARSE:${stage}] ALL ATTEMPTS FAILED — rawLen=${raw.length}`);
  }

  throw AppError.internal(
    new Error(`Failed to parse JSON response from AI${stage ? ` [stage: ${stage}]` : ""}`)
  );
}

function extractMalformedJsonStringProperty(raw: string, allowedProps: string[]): Record<string, string> | null {
  for (const prop of allowedProps) {
    const marker = `"${prop}"`;
    const startIdx = raw.indexOf(marker);
    if (startIdx < 0) continue;
    let colonIdx = raw.indexOf(":", startIdx + marker.length);
    if (colonIdx < 0) continue;
    let openQuote = raw.indexOf('"', colonIdx + 1);
    if (openQuote < 0) continue;

    // Forward scan, tag-aware. Only stop at `}` (single-property object boundary).
    // Quoted text inside prose (like "Learn More", "Shop Now") is skipped
    // because the next char after the quote is neither `}` nor a known property delimiter.
    let i = openQuote + 1;
    let inTag = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '<') inTag = true;
      if (ch === '>') inTag = false;
      if (ch === '"' && !inTag) {
        let next = i + 1;
        while (next < raw.length && /\s/.test(raw[next])) next++;
        // Only stop at the closing `}` — single-property objects end with "}
        if (next < raw.length && raw[next] === '}') {
          const value = raw.substring(openQuote + 1, i);
          const decoded = value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

          // ── Validate recovered content ──
          if (decoded.trim().length === 0) return null;

          // WordPress block balance
          const wpOpen = (decoded.match(/<!--\s*wp:\w+/gi) ?? []).length;
          const wpClose = (decoded.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
          if (wpOpen !== wpClose) return null;

          // Paragraph tag balance
          const pOpen = (decoded.match(/<p\b[^>]*>/gi) ?? []).length;
          const pClose = (decoded.match(/<\/p>/gi) ?? []).length;
          if (pOpen !== pClose) return null;

          return { [prop]: decoded };
        }
      }
      i++;
    }
  }
  return null;
}

export function repairMetaDescription(meta: string, min: number, max: number): string {
  if (meta.length >= min && meta.length <= max) return meta;

  if (meta.length < min) {
    const suffix = " Learn more at B2I Hub.";
    const candidate = meta + suffix;
    if (candidate.length <= max) return candidate;
    return meta + " Discover more at B2I Hub.";
  }

  const truncated = meta.substring(0, max);
  const lastPeriod = truncated.lastIndexOf(".");
  if (lastPeriod > min) return truncated.substring(0, lastPeriod + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 0 ? truncated.substring(0, lastSpace) + "\u2026" : truncated + "\u2026";
}

/** Split WordPress paragraph blocks that exceed MAX_SENTENCES per paragraph.
 *  Preserves inline HTML (<strong>, <em>, <a>, <br>). Never splits lists/headings/tables/quotes/html blocks. */
export function splitLongParagraphs(html: string, maxSentences: number = 3): { html: string; splitCount: number } {
  let splitCount = 0;

  const result = html.replace(
    /<!--\s*wp:paragraph\s*-->\s*<p>([\s\S]*?)<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi,
    (match: string, content: string) => {
      // Count sentences
      const sentences = content.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim().length > 0);
      if (sentences.length <= maxSentences) return match;

      // Split into groups of maxSentences
      const blocks: string[] = [];
      for (let i = 0; i < sentences.length; i += maxSentences) {
        const chunk = sentences.slice(i, i + maxSentences).join(" ");
        if (chunk.trim()) {
          blocks.push(`<!-- wp:paragraph -->\n<p>${chunk.trim()}</p>\n<!-- /wp:paragraph -->`);
        }
      }
      splitCount += blocks.length - 1;
      return blocks.join("\n\n");
    }
  );

  return { html: result, splitCount };
}
