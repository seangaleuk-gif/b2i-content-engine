// ── WordPress block-comment structure ──
// Single structural parser for serialized Gutenberg block comments. It parses
// complete HTML comments first, then validates the WordPress marker grammar.
// Consumers must not use broad cross-document regexes to discover block ranges.

export interface WordpressBlockToken {
  kind: "open" | "close";
  type: string;
  index: number;
  end: number;
  attributes: Record<string, unknown> | null;
}

export interface WordpressBlockRange {
  type: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  depth: number;
  attributes: Record<string, unknown> | null;
}

export interface WordpressBlockStructure {
  valid: boolean;
  issues: string[];
  tokens: WordpressBlockToken[];
  ranges: WordpressBlockRange[];
  openingCount: number;
  closingCount: number;
  selfClosingCount: number;
}

const BLOCK_TYPE = /^wp:[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const WORDPRESS_LIKE = /^\/?\s*wp:/i;
const LEAF_BLOCK_TYPES = new Set([
  "wp:paragraph",
  "wp:heading",
  "wp:html",
  "wp:image",
  "wp:separator",
  "wp:spacer",
]);

interface ParsedMarker {
  kind: "open" | "close" | "self";
  type: string;
  attributes: Record<string, unknown> | null;
}

function parseAttributes(raw: string, index: number): { value: Record<string, unknown> | null; issue: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, issue: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, issue: `WordPress block attributes at offset ${index} must be a JSON object` };
    }
    return { value: parsed as Record<string, unknown>, issue: null };
  } catch {
    return { value: null, issue: `Malformed WordPress block attributes at offset ${index}` };
  }
}

function parseMarker(body: string, index: number): { marker: ParsedMarker | null; issue: string | null } {
  const trimmed = body.trim();
  if (!WORDPRESS_LIKE.test(trimmed)) return { marker: null, issue: null };

  if (trimmed.startsWith("/")) {
    const closeMatch = trimmed.match(/^\/\s*(wp:[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*)\s*$/);
    if (!closeMatch || !BLOCK_TYPE.test(closeMatch[1])) {
      return { marker: null, issue: `Malformed closing WordPress block marker at offset ${index}` };
    }
    return { marker: { kind: "close", type: closeMatch[1], attributes: null }, issue: null };
  }

  const typeMatch = trimmed.match(/^(wp:[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*)([\s\S]*)$/);
  if (!typeMatch || !BLOCK_TYPE.test(typeMatch[1])) {
    return { marker: null, issue: `Malformed opening WordPress block marker at offset ${index}` };
  }

  let remainder = typeMatch[2].trim();
  let kind: ParsedMarker["kind"] = "open";
  if (/\/\s*$/.test(remainder)) {
    kind = "self";
    remainder = remainder.replace(/\/\s*$/, "").trim();
  }
  const attributes = parseAttributes(remainder, index);
  if (attributes.issue) return { marker: null, issue: attributes.issue };
  return { marker: { kind, type: typeMatch[1], attributes: attributes.value }, issue: null };
}

/** Parse and validate serialized Gutenberg block comments and return exact ranges. */
export function parseWordpressBlockStructure(html: string): WordpressBlockStructure {
  const issues: string[] = [];
  const tokens: WordpressBlockToken[] = [];
  let selfClosingCount = 0;
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf("<!--", cursor);
    if (start < 0) break;
    const close = html.indexOf("-->", start + 4);
    if (close < 0) {
      const remainder = html.slice(start + 4).trimStart();
      if (WORDPRESS_LIKE.test(remainder)) {
        issues.push(`Unclosed WordPress block comment at offset ${start}`);
      }
      break;
    }

    const end = close + 3;
    const parsed = parseMarker(html.slice(start + 4, close), start);
    if (parsed.issue) issues.push(parsed.issue);
    if (parsed.marker) {
      if (parsed.marker.kind === "self") {
        selfClosingCount++;
      } else {
        tokens.push({
          kind: parsed.marker.kind,
          type: parsed.marker.type,
          index: start,
          end,
          attributes: parsed.marker.attributes,
        });
      }
    }
    cursor = end;
  }

  const stack: Array<WordpressBlockToken & { depth: number }> = [];
  const ranges: WordpressBlockRange[] = [];
  for (const token of tokens) {
    if (token.kind === "open") {
      const parent = stack[stack.length - 1];
      if (parent && LEAF_BLOCK_TYPES.has(parent.type)) {
        issues.push(
          `WordPress block ${token.type} at offset ${token.index} cannot be nested inside leaf block ${parent.type} at offset ${parent.index}`,
        );
      }
      stack.push({ ...token, depth: stack.length });
      continue;
    }

    const opener = stack[stack.length - 1];
    if (!opener) {
      issues.push(`Unexpected closing block ${token.type} at offset ${token.index}`);
      continue;
    }
    if (opener.type !== token.type) {
      issues.push(
        `WordPress block type mismatch: opened ${opener.type} at offset ${opener.index} but closed ${token.type} at offset ${token.index}`,
      );
      continue;
    }

    stack.pop();
    ranges.push({
      type: opener.type,
      start: opener.index,
      openEnd: opener.end,
      closeStart: token.index,
      end: token.end,
      depth: opener.depth,
      attributes: opener.attributes,
    });
  }

  for (const opener of stack) {
    issues.push(`Unclosed WordPress block ${opener.type} at offset ${opener.index}`);
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  return {
    valid: issues.length === 0,
    issues,
    tokens,
    ranges,
    openingCount: tokens.filter((token) => token.kind === "open").length,
    closingCount: tokens.filter((token) => token.kind === "close").length,
    selfClosingCount,
  };
}

/** Compatibility export: self-closing blocks intentionally have no pair token. */
export function tokenizeWordpressBlockComments(html: string): WordpressBlockToken[] {
  return parseWordpressBlockStructure(html).tokens;
}

export function validateWordpressBlockPairs(html: string): { valid: boolean; issues: string[] } {
  const parsed = parseWordpressBlockStructure(html);
  return { valid: parsed.valid, issues: parsed.issues };
}
