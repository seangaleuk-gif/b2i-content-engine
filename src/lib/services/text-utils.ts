import { AppError } from "./errors";
import { findSentenceBoundaryOffsets, splitSentences } from "@/lib/seo/seo-text-utils";
import { parseWordpressBlockStructure, type WordpressBlockRange } from "@/lib/blog/wordpress-block-structure";

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

export function robustJsonParse(raw: string, stage?: string): unknown {
  // Log shape only. Model responses can contain private article copy and must
  // never be echoed into application logs, even as first/last snippets.
  if (stage) {
    console.log(`[JSON-PARSE:${stage}] type=${typeof raw} length=${raw.length}`);
  }

  function logParseError(label: string, err: unknown, text: string): void {
    if (!stage) return;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[JSON-PARSE:${stage}] ${label} FAILED: ${msg} inputLength=${text.length}`);
  }

  // Direct parse
  try { return JSON.parse(raw); } catch (e) { logParseError("direct", e, raw); }

  // JSON-aware content-quote repair: character-by-character scanner that
  // replaces unescaped ASCII " inside string values with Unicode curly quotes.
  // A " is a closing delimiter if the next non-ws char is , } ] \n or :
  // (keys end with `":` and values end with `",` `"}` `"]` `"\n`).
  // Anything else means the " is a content quote (e.g. "for you" in text).
  const quoteRepairedOutput = (() => {
    const out: string[] = [];
    let inString = false, escaped = false, expectRight = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { out.push(ch); escaped = false; continue; }
      if (ch === '\\') { out.push(ch); escaped = true; continue; }
      if (ch === '"') {
        if (inString) {
          const after = raw.substring(i + 1).replace(/^[\s]*/, "");
          if (after.length === 0 || ",]}\n:".includes(after[0])) {
            out.push(ch); inString = false;
          } else {
            // Content quote — alternate between left and right curly quotes
            out.push(expectRight ? '\u201D' : '\u201C');
            expectRight = !expectRight;
          }
        } else {
          out.push(ch); inString = true;
        }
      } else {
        out.push(ch);
      }
    }
    return out.join('');
  })();
  try { return JSON.parse(quoteRepairedOutput); } catch (e) { logParseError("quoteRepaired", e, quoteRepairedOutput); }

  // Extract from markdown code blocks

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
    // Script blocks are tracked separately: their JSON content (FAQPage schema)
    // contains `"}` patterns that would falsely trigger truncation.
    let i = openQuote + 1;
    let inTag = false;
    let inScript = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '\\') { i += 2; continue; }
      // Check </script> close before generic < opener
      if (ch === '<' && raw.substring(i, i + 9).toLowerCase() === '</script>') {
        inScript = false;
        inTag = true;
        i++;
        continue;
      }
      if (ch === '<') {
        inTag = true;
        const tagStart = raw.substring(i, Math.min(i + 8, raw.length)).toLowerCase();
        if (tagStart.startsWith('<script')) inScript = true;
      }
      if (ch === '>') inTag = false;
      if (ch === '"' && !inTag && !inScript) {
        let next = i + 1;
        while (next < raw.length && /\s/.test(raw[next])) next++;
        // Only stop at the closing `}` — single-property objects end with "}
        if (next < raw.length && raw[next] === '}') {
          const value = raw.substring(openQuote + 1, i);
          const decoded = value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

          // ── Validate recovered content ──
          if (decoded.trim().length === 0) return null;

          // WordPress block balance — lenient: if unbalanced, try to balance
          // by trimming content after the last unmatched opener. This handles
          // cases where unescaped quotes inside HTML cause premature stopping.
          let extract = decoded;
          let wpOpen = (extract.match(/<!--\s*wp:\w+(?:\s[^>]*)?-->/gi) ?? []).length;
          let wpClose = (extract.match(/<!--\s*\/wp:\w+-->/gi) ?? []).length;
          if (wpOpen !== wpClose) {
            // Try to rebalance by removing content from the last unbalanced block
            const openers = [...extract.matchAll(/<!--\s*wp:\w+(?:\s[^>]*)?-->/gi)];
            const closers = [...extract.matchAll(/<!--\s*\/wp:\w+-->/gi)];
            // If we have more openers than closers, the last opener is incomplete
            if (openers.length > closers.length && closers.length > 0) {
              const lastClose = closers[closers.length - 1];
              extract = extract.substring(0, lastClose.index + lastClose[0].length);
              wpOpen = (extract.match(/<!--\s*wp:\w+(?:\s[^>]*)?-->/gi) ?? []).length;
              wpClose = (extract.match(/<!--\s*\/wp:\w+-->/gi) ?? []).length;
            }
          }

          // Paragraph tag balance — lenient: count only block-level <p> usage
          const pOpen = (extract.match(/<!--\s*wp:paragraph\s*-->/gi) ?? []).length;
          const pClose = (extract.match(/<!--\s*\/wp:paragraph\s*-->/gi) ?? []).length;
          if (pOpen !== pClose && (pOpen === 0 || pClose === 0)) return null;

          return { [prop]: extract };
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

/** Split validated, top-level WordPress paragraph blocks only. */
interface InlineTagToken {
  start: number;
  end: number;
  kind: "open" | "close" | "self" | "comment";
  name: string | null;
}

interface InlineScan {
  valid: boolean;
  error: string | null;
  visibleText: string;
  rawIndexByVisibleIndex: number[];
  stackAtVisibleIndex: string[][];
  tags: InlineTagToken[];
}

const VOID_INLINE_TAGS = new Set(["br", "img", "hr", "input", "source", "wbr"]);
const BLOCK_HTML_TAGS = new Set([
  "address", "article", "aside", "blockquote", "button", "div", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol",
  "p", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

function findHtmlTagEnd(html: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  for (let index = start + 1; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index + 1;
  }
  return -1;
}

function scanInlineHtml(html: string): InlineScan {
  const visible: string[] = [];
  const rawIndexByVisibleIndex: number[] = [];
  const stackAtVisibleIndex: string[][] = [];
  const tags: InlineTagToken[] = [];
  const stack: string[] = [];

  for (let index = 0; index < html.length;) {
    if (html.startsWith("<!--", index)) {
      const commentEnd = html.indexOf("-->", index + 4);
      if (commentEnd < 0) {
        return { valid: false, error: `unclosed inline HTML comment at offset ${index}`, visibleText: "", rawIndexByVisibleIndex: [], stackAtVisibleIndex: [], tags: [] };
      }
      tags.push({ start: index, end: commentEnd + 3, kind: "comment", name: null });
      index = commentEnd + 3;
      continue;
    }

    if (html[index] === "<") {
      const end = findHtmlTagEnd(html, index);
      if (end < 0) {
        return { valid: false, error: `unclosed inline HTML tag at offset ${index}`, visibleText: "", rawIndexByVisibleIndex: [], stackAtVisibleIndex: [], tags: [] };
      }
      const raw = html.slice(index, end);
      const close = raw.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>$/);
      const open = raw.match(/^<\s*([A-Za-z][\w:-]*)(?:\s[\s\S]*?)?\s*(\/?)>$/);
      if (close) {
        const name = close[1].toLowerCase();
        if (stack[stack.length - 1] !== name) {
          return { valid: false, error: `mismatched inline closing tag </${name}> at offset ${index}`, visibleText: "", rawIndexByVisibleIndex: [], stackAtVisibleIndex: [], tags: [] };
        }
        stack.pop();
        tags.push({ start: index, end, kind: "close", name });
      } else if (open) {
        const name = open[1].toLowerCase();
        if (BLOCK_HTML_TAGS.has(name)) {
          return { valid: false, error: `block-level <${name}> is not valid inside a paragraph`, visibleText: "", rawIndexByVisibleIndex: [], stackAtVisibleIndex: [], tags: [] };
        }
        const selfClosing = open[2] === "/" || VOID_INLINE_TAGS.has(name);
        tags.push({ start: index, end, kind: selfClosing ? "self" : "open", name });
        if (!selfClosing) stack.push(name);
      } else {
        return { valid: false, error: `malformed inline HTML tag at offset ${index}`, visibleText: "", rawIndexByVisibleIndex: [], stackAtVisibleIndex: [], tags: [] };
      }
      index = end;
      continue;
    }

    visible.push(html[index]);
    rawIndexByVisibleIndex.push(index);
    stackAtVisibleIndex.push([...stack]);
    index++;
  }

  if (stack.length > 0) {
    return { valid: false, error: `unclosed inline HTML tag <${stack[stack.length - 1]}>`, visibleText: "", rawIndexByVisibleIndex: [], stackAtVisibleIndex: [], tags: [] };
  }
  return {
    valid: true,
    error: null,
    visibleText: visible.join(""),
    rawIndexByVisibleIndex,
    stackAtVisibleIndex,
    tags,
  };
}

function findSafeRawBoundary(
  html: string,
  punctuationRawIndex: number,
  nextVisibleRawIndex: number,
  openAtPunctuation: string[],
  tags: InlineTagToken[],
): number | null {
  const stack = [...openAtPunctuation];
  let cursor = punctuationRawIndex + 1;
  let boundary = cursor;
  for (const tag of tags) {
    if (tag.start < cursor || tag.end > nextVisibleRawIndex) continue;
    if (/\S/.test(html.slice(cursor, tag.start))) return null;
    if (stack.length === 0) return tag.start;
    if (tag.kind === "close") {
      if (stack[stack.length - 1] !== tag.name) return null;
      stack.pop();
    } else if (tag.kind === "open" && tag.name) {
      stack.push(tag.name);
    }
    cursor = tag.end;
    if (stack.length === 0) boundary = cursor;
  }
  if (/\S/.test(html.slice(cursor, nextVisibleRawIndex))) return null;
  return stack.length === 0 ? Math.max(boundary, nextVisibleRawIndex) : null;
}

function splitParagraphBlock(
  html: string,
  range: WordpressBlockRange,
  maxSentences: number,
): { replacement: string; splitCount: number } {
  const original = html.slice(range.start, range.end);
  const opener = html.slice(range.start, range.openEnd);
  const closer = html.slice(range.closeStart, range.end);
  const inner = html.slice(range.openEnd, range.closeStart);
  const paragraph = inner.match(/^(\s*)(<p\b[^>]*>)([\s\S]*)(<\/p>)(\s*)$/i);
  if (!paragraph) {
    throw new Error(`Invalid wp:paragraph HTML at offset ${range.start}: expected one complete <p> wrapper`);
  }
  if (/"anchor"\s*:/.test(opener) || /\bid\s*=/i.test(paragraph[2])) {
    return { replacement: original, splitCount: 0 };
  }

  const content = paragraph[3];
  const scan = scanInlineHtml(content);
  if (!scan.valid) {
    throw new Error(`Invalid wp:paragraph HTML at offset ${range.start}: ${scan.error}`);
  }
  const boundaries = findSentenceBoundaryOffsets(scan.visibleText);
  const sentenceCount = splitSentences(scan.visibleText).length;
  if (sentenceCount <= maxSentences) return { replacement: original, splitCount: 0 };

  const rawBoundaries: number[] = [];
  for (let sentenceIndex = maxSentences; sentenceIndex < sentenceCount; sentenceIndex += maxSentences) {
    const visibleBoundary = boundaries[sentenceIndex - 1];
    if (visibleBoundary === undefined) return { replacement: original, splitCount: 0 };
    let nextVisible = visibleBoundary;
    while (nextVisible < scan.visibleText.length && /\s/.test(scan.visibleText[nextVisible])) nextVisible++;
    if (nextVisible >= scan.visibleText.length) break;
    const punctuationVisibleIndex = visibleBoundary - 1;
    const rawBoundary = findSafeRawBoundary(
      content,
      scan.rawIndexByVisibleIndex[punctuationVisibleIndex],
      scan.rawIndexByVisibleIndex[nextVisible],
      scan.stackAtVisibleIndex[punctuationVisibleIndex],
      scan.tags,
    );
    if (rawBoundary === null) return { replacement: original, splitCount: 0 };
    rawBoundaries.push(rawBoundary);
  }

  const chunks: string[] = [];
  let start = 0;
  for (const boundary of [...rawBoundaries, content.length]) {
    const chunk = content.slice(start, boundary).trim();
    if (chunk) {
      const chunkScan = scanInlineHtml(chunk);
      if (!chunkScan.valid) return { replacement: original, splitCount: 0 };
      chunks.push(chunk);
    }
    start = boundary;
  }
  if (chunks.length <= 1) return { replacement: original, splitCount: 0 };

  const blocks = chunks.map((chunk) =>
    `${opener}${paragraph[1]}${paragraph[2]}${chunk}${paragraph[4]}${paragraph[5]}${closer}`,
  );
  return { replacement: blocks.join("\n\n"), splitCount: blocks.length - 1 };
}

export function splitLongParagraphs(html: string, maxSentences: number = 3): { html: string; splitCount: number } {
  if (!Number.isInteger(maxSentences) || maxSentences < 1) {
    throw new Error(`maxSentences must be a positive integer, received ${maxSentences}`);
  }
  const structure = parseWordpressBlockStructure(html);
  if (!structure.valid) {
    throw new Error(`Invalid WordPress block structure: ${structure.issues.join("; ")}`);
  }

  const paragraphs = structure.ranges
    .filter((range) => range.type === "wp:paragraph" && range.depth === 0)
    .sort((a, b) => b.start - a.start);
  let result = html;
  let splitCount = 0;
  for (const range of paragraphs) {
    const split = splitParagraphBlock(html, range, maxSentences);
    if (split.splitCount === 0) continue;
    result = result.slice(0, range.start) + split.replacement + result.slice(range.end);
    splitCount += split.splitCount;
  }
  return { html: result, splitCount };
}

/** Return human-readable word count label based on slug language.
 *  English slugs display "N words", Chinese slugs display "N Chinese characters". */
export function formatWordCount(count: number, slug?: string): string {
  const isChinese = slug ? /-zh$/i.test(slug) : false;
  return isChinese
    ? `${count.toLocaleString()} Chinese characters`
    : `${count.toLocaleString()} words`;
}

/** Remove excess WordPress block closers and rebalance <li>/</li> tags.
 *  AI-generated content can contain orphaned closers when heading blocks
 *  are stripped or when the model produces malformed markup.
 *  Also normalizes doubled block prefixes like <!-- /wp:wp:paragraph -->
 *  to their correct form <!-- /wp:paragraph -->. */
export function rebalanceWpBlocks(html: string): string {
  let cleaned = html;

  // Pass 1: Normalize doubled "wp:wp:" prefixes to "wp:"
  // The AI sometimes generates <!-- wp:wp:paragraph --> or <!-- /wp:wp:paragraph -->
  // which causes structural validation failures.
  cleaned = cleaned.replace(
    /(<!--\s*\/?)\s*wp:wp:([\w-]+)/gi,
    "$1wp:$2",
  );

  // Stack-based matching: track opener positions and types, remove mismatched closers.
  const tokenRe = /<!--\s*(\/?)(wp:[\w-]+)(?:\s[^>]*)?\s*-->/gi;
  type WpPos = { pos: number; len: number; type: string; isOpener: boolean };
  const tokens: WpPos[] = [];
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(cleaned)) !== null) {
    tokens.push({
      pos: tm.index,
      len: tm[0].length,
      type: tm[2],
      isOpener: tm[1] !== "/",
    });
  }

  // Stack-based validation — mark orphaned closers (no matching opener) and
  // unclosed openers (no matching closer).
  const orphaned = new Set<number>();
  const stack: WpPos[] = [];
  for (const t of tokens) {
    if (t.isOpener) {
      stack.push(t);
    } else {
      if (stack.length > 0 && stack[stack.length - 1].type === t.type) {
        stack.pop();
      } else {
        orphaned.add(t.pos);
      }
    }
  }
  for (const t of stack) orphaned.add(t.pos);

  // Remove orphaned markers in reverse order
  const sorted = [...orphaned].sort((a, b) => b - a);
  for (const pos of sorted) {
    const t = tokens.find((x) => x.pos === pos);
    if (t) cleaned = cleaned.substring(0, t.pos) + cleaned.substring(t.pos + t.len);
  }

  // Rebalance <li> vs </li>
  const liOpen = (cleaned.match(/<li\b[^>]*>/gi) ?? []).length;
  const liClose = (cleaned.match(/<\/li>/gi) ?? []).length;
  if (liClose > liOpen) {
    let excessLI = liClose - liOpen;
    let liPos = cleaned.length;
    while (excessLI > 0 && liPos > 0) {
      liPos = cleaned.lastIndexOf("</li>", liPos - 1);
      if (liPos < 0) break;
      cleaned = cleaned.substring(0, liPos) + cleaned.substring(liPos + 5);
      excessLI--;
    }
  }

  return cleaned;
}

/** Count editorial WordPress paragraph blocks that exceed maxSentences.
 *  Uses the exact same sentence-counting logic as splitLongParagraphs.
 *  Shared by: paragraphs-final pipeline stage, SEO audit, final validation, post-save readback. */
export function countLongParagraphs(html: string, maxSentences: number = 3): number {
  const structure = parseWordpressBlockStructure(html);
  const paragraphs = structure.ranges.filter(
    (range) => range.type === "wp:paragraph" && range.depth === 0,
  );
  let count = 0;
  for (const range of paragraphs) {
    const inner = html.slice(range.openEnd, range.closeStart);
    const paragraph = inner.match(/^\s*<p\b[^>]*>([\s\S]*)<\/p>\s*$/i);
    if (!paragraph) {
      count++;
      continue;
    }
    const content = paragraph[1].trim();
    if (!content) continue;
    const scan = scanInlineHtml(content);
    if (!scan.valid || splitSentences(scan.visibleText).length > maxSentences) count++;
  }
  return count;
}

/** Count visible CJK characters in HTML for Chinese content.
 *  Strips wp:html blocks, scripts, styles, HTML tags, URLs, and non-CJK text.
 *  Returns count of characters in the CJK Unified Ideographs range plus full-width forms. */
export function countChineseCharacters(html: string): number {
  const readable = html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[a-zA-Z0-9]/g, "")
    .replace(/\s+/g, "");
  let count = 0;
  for (const ch of readable) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF) ||
        (code >= 0xF900 && code <= 0xFAFF)) {
      count++;
    }
  }
  return count;
}

/** Map English word-count target to Traditional Chinese character-count range.
 *  For 2,500 English words: SEO pass 3,800–5,500, hard fail <3,200, preferred ~4,500. */
export function chineseCharRange(englishWordCount: number): {
  min: number; max: number; preferred: number; hardMin: number;
} {
  const r = { pref: 1.80, min: 1.52, max: 2.20, hardMin: 1.28 };
  return {
    min: Math.round(englishWordCount * r.min),
    max: Math.round(englishWordCount * r.max),
    preferred: Math.round(englishWordCount * r.pref),
    hardMin: Math.round(englishWordCount * r.hardMin),
  };
}

/** Deterministically insert zhKeyphrase into a Chinese title if missing.
 *  Returns the title with keyphrase prepended as `{keyphrase}：{title}`.
 *  Removes duplicate keyphrase occurrences and duplicate separators. */
export function ensureKeyphraseInTitle(title: string, keyphrase: string): string {
  if (!keyphrase || !title) return title || keyphrase;
  if (!/[\u4e00-\u9fff]/.test(keyphrase)) return title;
  if (title.includes(keyphrase)) return title;

  // Prepend: keyphrase + colon + space + title
  let result = `${keyphrase}：${title}`;

  // Remove any duplicate keyphrase occurrences (keep first)
  const kpEscaped = keyphrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kpRe = new RegExp(`(${kpEscaped}).*?(${kpEscaped})`, "g");
  result = result.replace(kpRe, "$1");

  // Clean duplicate separators
  result = result.replace(/([：:-])\s*\1/g, "$1");

  // Remove separator followed by same-semantics content (if title starts with keyphrase's Chinese portion)
  // e.g. if keyphrase="來源本地化" and title="來源本地化完整指南" → "來源本地化：完整指南"
  const cjkKp = keyphrase.replace(/[a-zA-Z\s]+/g, "");
  if (cjkKp && result.includes(`：${cjkKp}`)) {
    result = result.replace(`：${cjkKp}`, `${cjkKp}`);
  }

  return result;
}

// ── Deterministic English title casing ──

/** Configured proper nouns whose exact casing must always be preserved in an
 *  English title. "Hong kong" from a lowercase keyphrase is corrected to the
 *  canonical "Hong Kong" casing. */
const TITLE_PROPER_NOUNS: Array<{ match: RegExp; canonical: string }> = [
  { match: /\bhong\s+kong\b/i, canonical: "Hong Kong" },
  { match: /\bhsbc\b/i, canonical: "HSBC" },
  { match: /\bb2i\s*hub\b/i, canonical: "B2I Hub" },
  { match: /\bai\b/i, canonical: "AI" },
  { match: /\bar\b/i, canonical: "AR" },
  { match: /\bseo\b/i, canonical: "SEO" },
  { match: /\bsme\b/i, canonical: "SME" },
  { match: /\bmeta\b/i, canonical: "Meta" },
  { match: /\bthreads\b/i, canonical: "Threads" },
  { match: /\bwhatsapp\b/i, canonical: "WhatsApp" },
  { match: /\binstagram\b/i, canonical: "Instagram" },
  { match: /\btiktok\b/i, canonical: "TikTok" },
  { match: /\blinkedin\b/i, canonical: "LinkedIn" },
  { match: /\byoutube\b/i, canonical: "YouTube" },
  { match: /\bwechat\b/i, canonical: "WeChat" },
  { match: /\bcauseway bay\b/i, canonical: "Causeway Bay" },
  { match: /\bkowloon\b/i, canonical: "Kowloon" },
  { match: /\bapac\b/i, canonical: "APAC" },
  { match: /\bhk\b/i, canonical: "HK" },
];

const TITLE_SMALL_WORDS = new Set([
  "a", "an", "and", "or", "but", "for", "of", "on", "in", "to", "with",
  "by", "at", "from", "as", "vs", "via", "nor", "yet", "so", "the",
]);

function capitalizeToken(token: string): string {
  if (token.length <= 1) return token;
  if (/^[A-Z0-9]{2,}$/.test(token)) return token; // keep acronyms/numbers
  if (/[a-z]/.test(token) === false) return token; // keep "2026" and all-caps
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** Replace configured proper nouns with their exact canonical casing. */
export function fixConfiguredProperNouns(text: string): string {
  let result = text;
  for (const { match, canonical } of TITLE_PROPER_NOUNS) {
    result = result.replace(match, canonical);
  }
  return result;
}

/**
 * Deterministic English title casing: configured proper nouns keep their exact
 * casing ("Hong Kong", "HSBC", "AI"), acronyms stay uppercase, small words are
 * lowercased (unless first/last), and every other word is capitalized. This
 * turns a model-produced "Hong kong marketing trends 2026: ..." into
 * "Hong Kong Marketing Trends 2026: ..." without touching numbers or URLs.
 */
export function normalizeEnglishTitleCasing(title: string, keyphrase?: string): string {
  if (!title) return title;
  const withProperNouns = fixConfiguredProperNouns(String(title));
  const keyphraseWords = new Set(
    (keyphrase ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  const segments = withProperNouns.split(/(:\s*)/g); // keep the colon separator
  return segments
    .map((segment) => {
      if (/^\s*:\s*$/.test(segment)) return segment;
      const words = segment.split(/(\s+)/g); // keep whitespace
      const tokenIndexes = words.map((word, index) => (/\S/.test(word) ? index : -1)).filter((i) => i >= 0);
      const result = words.map((word, index) => {
        if (!/\S/.test(word)) return word;
        const position = tokenIndexes.indexOf(index);
        const firstOrLast = position === 0 || position === tokenIndexes.length - 1;
        const lower = word.toLowerCase();
        // The configured keyphrase casing stays exact wherever it appears.
        if (keyphraseWords.has(lower) && !/^\d+$/.test(lower)) return capitalizeToken(word);
        if (TITLE_SMALL_WORDS.has(lower) && !firstOrLast) return lower;
        // Hyphenated compounds are capitalized per part.
        if (word.includes("-") && !/^[A-Z0-9-]{3,}$/.test(word)) {
          return word.split("-").map((part) => capitalizeToken(part)).join("-");
        }
        return capitalizeToken(word);
      });
      return result.join("");
    })
    .join("");
}

/** Title-case a keyphrase for natural heading placement ("hong kong marketing
 *  trends 2026" → "Hong Kong Marketing Trends 2026"). */
export function titleCaseKeyphrase(keyphrase: string): string {
  return normalizeEnglishTitleCasing(keyphrase);
}
