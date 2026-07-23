// ── Article Integrity Validator ──
// Captures a structural baseline before normalization and validates after.

import { detectNestedParagraphs } from "@/lib/blog/article-document";

export interface ArticleIntegrityBaseline {
  htmlHash: string;
  wordpressOpeningBlocks: number;
  wordpressClosingBlocks: number;
  linkDestinations: string[];
  externalLinkDestinations: string[];
  internalLinkDestinations: string[];
  faqSchemaBlocks: string[];
  languageSwitcherBlocks: string[];
  ctaBlocks: string[];
  scriptBlocks: string[];
}

export interface ArticleIntegrityResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    wordpressOpeningBlocks: number;
    wordpressClosingBlocks: number;
    nestedParagraphCount: number;
    malformedHeadingCount: number;
    linkDestinationsPreserved: boolean;
    faqSchemaPresent: boolean;
    faqSchemaValid: boolean;
    languageSwitcherPresent: boolean;
    ctaPresent: boolean;
  };
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

function extractWpHtmlBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<!--\s*wp:html\s*-->([\s\S]*?)<!--\s*\/wp:html\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function extractScriptBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[2] || "");
  }
  return blocks;
}

function extractLinkHrefs(html: string): string[] {
  const hrefs: string[] = [];
  // Exclude wp:html blocks
  const wpHtmlRanges: [number, number][] = [];
  const wpHtmlRe = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wm: RegExpExecArray | null;
  while ((wm = wpHtmlRe.exec(html)) !== null) {
    wpHtmlRanges.push([wm.index, wm.index + wm[0].length]);
  }
  const scriptRe = /<script[\s\S]*?<\/script>/gi;
  while ((wm = scriptRe.exec(html)) !== null) {
    wpHtmlRanges.push([wm.index, wm.index + wm[0].length]);
  }

  const linkRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;

  let lm: RegExpExecArray | null;
  let iteration = 0;
  let previousLastIndex = -1;

  while ((lm = linkRe.exec(html)) !== null) {
    iteration++;

    if (linkRe.lastIndex <= previousLastIndex) {
      throw new Error(
        "extractLinkHrefs regex made no progress: iteration=" + iteration +
        " lastIndex=" + linkRe.lastIndex +
        " previousLastIndex=" + previousLastIndex +
        " match[0]=\"" + (lm[0]?.substring(0, 100) ?? "null") + "\""
      );
    }

    if (iteration > 10000) {
      throw new Error("extractLinkHrefs exceeded safe iteration limit: " + iteration);
    }

    previousLastIndex = linkRe.lastIndex;

    hrefs.push(lm[1]);
  }

  return hrefs.sort();
}

/** Capture a structural baseline before any normalization run. */
export function createArticleIntegrityBaseline(html: string): ArticleIntegrityBaseline {
  const allHrefs = extractLinkHrefs(html);
  console.log(`[INTEGRITY] extractLinkHrefs completed, count=${allHrefs.length}`);
  const wpHtmlBlocks = extractWpHtmlBlocks(html);
  const scriptBlocks = extractScriptBlocks(html);

  const languageSwitcherBlocks = wpHtmlBlocks.filter((b) =>
    /b2i-language-switcher/i.test(b),
  );
  const ctaBlocks = wpHtmlBlocks.filter((b) =>
    /\bcta\b/i.test(b) || /call.to.action/i.test(b) || /B2I Hub profile/i.test(b),
  );
  const faqSchemaBlocks = scriptBlocks.filter((b) =>
    /FAQPage/i.test(b),
  );

  return {
    htmlHash: simpleHash(html),
    wordpressOpeningBlocks: (html.match(/<!--\s*wp:\w+/gi) ?? []).length,
    wordpressClosingBlocks: (html.match(/<!--\s*\/wp:\w+/gi) ?? []).length,
    linkDestinations: allHrefs,
    externalLinkDestinations: allHrefs.filter((h) => h.startsWith("http")),
    internalLinkDestinations: allHrefs.filter((h) => !h.startsWith("http")),
    faqSchemaBlocks,
    languageSwitcherBlocks,
    ctaBlocks,
    scriptBlocks,
  };
}

/** Validate article integrity against a pre-normalization baseline. */
export function validateFinalArticleIntegrity(
  html: string,
  baseline: ArticleIntegrityBaseline,
): ArticleIntegrityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Strip <script> and <!-- wp:html --> blocks before counting structural HTML tags.
  // FAQ JSON-LD answer text and language switcher markup must not be counted as article structure.
  const structHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");

  const openingBlocks = (html.match(/<!--\s*wp:\w+/gi) ?? []).length;
  const closingBlocks = (html.match(/<!--\s*\/wp:\w+/gi) ?? []).length;
  const blockMatch = openingBlocks === closingBlocks;

  // Nested paragraph detection — uses shared canonical implementation
  const nestedParagraphs = detectNestedParagraphs(html);
  const hasNested = nestedParagraphs > 0;

  // H2 validity: every <h2> must be wrapped in a level-2 wp:heading block
  const bareH2 = structHtml.match(/<h2[^>]*>/gi) ?? [];
  const headingOpeners = html.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) ?? [];
  const malformedHeadings = Math.abs(bareH2.length - headingOpeners.length);

  // ── Heading block shape validation ──
  // Each wp:heading block must match: opener → optional whitespace → <h2>/<h3> → optional whitespace → closer.
  // No other WordPress block may appear inside the heading block.
  const headingBlockErrors: string[] = [];
  const headingBlockRe = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi;
  const headingCloseRe = /<!--\s*\/wp:heading\s*-->/g;
  let hbm: RegExpExecArray | null;
  while ((hbm = headingBlockRe.exec(html)) !== null) {
    const openEnd = hbm.index + hbm[0].length;
    // Find matching close
    headingCloseRe.lastIndex = openEnd;
    const closeMatch = headingCloseRe.exec(html);
    if (!closeMatch) {
      headingBlockErrors.push(`wp:heading at offset ${hbm.index}: missing closing marker`);
      continue;
    }
    const closeStart = closeMatch.index;
    const region = html.substring(openEnd, closeStart);

    // Find the heading element inside
    const headingElMatch = region.match(/<h([23])\b[^>]*>[\s\S]*?<\/h\1>/i);
    if (!headingElMatch) {
      headingBlockErrors.push(`wp:heading at offset ${hbm.index}: no <h2> or <h3> found`);
      continue;
    }
    const hElStart = region.indexOf(headingElMatch[0]);
    const hElEnd = hElStart + headingElMatch[0].length;

    // Check for other wp: blocks before the heading element
    const beforeHeading = region.substring(0, hElStart);
    const wpBlocksBefore = beforeHeading.match(/<!--\s*wp:\w+/gi) ?? [];
    if (wpBlocksBefore.length > 0) {
      headingBlockErrors.push(
        `wp:heading at offset ${hbm.index}: ${wpBlocksBefore.length} nested WordPress block(s) before <h${headingElMatch[1]}>`
      );
    }

    // Check for other wp: blocks after the heading element
    const afterHeading = region.substring(hElEnd);
    const wpBlocksAfter = afterHeading.match(/<!--\s*wp:\w+/gi) ?? [];
    if (wpBlocksAfter.length > 0) {
      headingBlockErrors.push(
        `wp:heading at offset ${hbm.index}: ${wpBlocksAfter.length} nested WordPress block(s) after <h${headingElMatch[1]}>`
      );
    }
  }

  // Check for wp:heading closers with no matching opener (hanging closer)
  headingCloseRe.lastIndex = 0;
  const closeCount = (html.match(headingCloseRe) ?? []).length;
  // Reset and recount openers for h2 and h3
  const openCount = (html.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*[23][^}]*\}\s*-->/gi) ?? []).length;
  if (openCount !== closeCount) {
    headingBlockErrors.push(
      `wp:heading block mismatch: ${openCount} opening vs ${closeCount} closing`
    );
  }

  // Unclosed tags — count only in structural HTML (omit script and wp:html blocks)
  const unclosedTags: string[] = [];
  const tagPairs: Array<{ open: string; close: RegExp }> = [
    { open: "<p>", close: /<\/p>/g },
    { open: "<h2", close: /<\/h2>/g },
    { open: "<h3", close: /<\/h3>/g },
    { open: "<ul>", close: /<\/ul>/g },
    { open: "<ol>", close: /<\/ol>/g },
    { open: "<li>", close: /<\/li>/g },
  ];
  for (const pair of tagPairs) {
    const tagName = pair.open.replace(/[<>]/g, "").replace(/\s.*/, "");
    const openCount = (structHtml.match(new RegExp(pair.open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length;
    const closeCount = (structHtml.match(pair.close) ?? []).length;
    if (openCount !== closeCount) {
      unclosedTags.push(`${tagName}: ${openCount}/${closeCount}`);
    }
  }

  // Link destinations
  const currentHrefs = extractLinkHrefs(html);
  const baselineHrefs = [...baseline.linkDestinations].sort();
  const linksPreserved = JSON.stringify(currentHrefs) === JSON.stringify(baselineHrefs);

  if (!linksPreserved) {
    const missing = baselineHrefs.filter((h) => !currentHrefs.includes(h));
    const added = currentHrefs.filter((h) => !baselineHrefs.includes(h));
    if (missing.length > 0) errors.push(`Missing link destinations: ${missing.join(", ")}`);
    if (added.length > 0) warnings.push(`Added link destinations: ${added.join(", ")}`);
  }

  // FAQ schema
  const faqPresent = /FAQPage/i.test(html);
  let faqValid = false;
  if (faqPresent) {
    const scriptMatches = html.match(/<script\s[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
    for (const s of scriptMatches) {
      try {
        const jsonStr = s.replace(/<script[^>]*>/, "").replace(/<\/script>/, "");
        const parsed = JSON.parse(jsonStr);
        if (parsed["@type"] === "FAQPage" && Array.isArray(parsed.mainEntity) && parsed.mainEntity.length > 0) {
          faqValid = true;
          break;
        }
      } catch { /* invalid JSON */ }
    }
  }
  const hadFaqBefore = baseline.faqSchemaBlocks.length > 0;
  if (hadFaqBefore && (!faqPresent || !faqValid)) {
    errors.push("FAQ schema existed before normalization but is now missing or invalid");
  }

  // Language switcher
  const switcherPresent = /b2i-language-switcher/i.test(html);
  const hadSwitcherBefore = baseline.languageSwitcherBlocks.length > 0;
  if (hadSwitcherBefore && !switcherPresent) {
    errors.push("Language switcher existed before normalization but is now missing");
  }

  // CTA
  const ctaPresent = /\bcta\b/i.test(html) || /call.to.action/i.test(html) || /B2I Hub profile/i.test(html);
  const hadCtaBefore = baseline.ctaBlocks.length > 0;
  if (hadCtaBefore && !ctaPresent) {
    errors.push("CTA existed before normalization but is now missing");
  }

  // Non-structural warnings
  if (!blockMatch) {
    errors.push(`WordPress block mismatch: ${openingBlocks} opening vs ${closingBlocks} closing`);
  }
  if (hasNested) {
    errors.push(`${nestedParagraphs} nested paragraph(s) detected`);
  }
  if (malformedHeadings > 0) {
    // Report exactly which H2 tags lack a wp:heading wrapper
    const allH2s = structHtml.match(/<h2[^>]*>/gi) ?? [];
    const headingBlocks = html.match(/<!--\s*wp:heading\s+[^>]*-->\s*<h2/gi) ?? [];
    const bareH2Snippets = allH2s.filter((h2) => {
      // An H2 is "bare" if there's no wp:heading block directly before it in the raw HTML
      const idx = html.indexOf(h2);
      if (idx < 0) return false;
      const before = html.substring(Math.max(0, idx - 60), idx);
      return !/<!--\s*wp:heading\s+/.test(before);
    });
    const snippet = bareH2Snippets.slice(0, 3).map((h) => {
      const idx = html.indexOf(h);
      return `"${h}" at offset ${idx} ctx="${html.substring(Math.max(0, idx - 40), Math.min(html.length, idx + h.length + 40)).replace(/\n/g, "\\n")}"`;
    }).join("; ");
    errors.push(`${malformedHeadings} malformed heading block(s)${snippet ? ": " + snippet : ""}`);
  }

  // Heading block shape: no other wp block may appear inside a wp:heading block
  for (const hbe of headingBlockErrors) {
    errors.push(hbe);
  }
  if (unclosedTags.length > 0) {
    // Report which tag is unbalanced with surrounding context
    const details = unclosedTags.map((t) => {
      const [tagName, counts] = t.split(": ");
      const openRegex = new RegExp(`<${tagName.replace(/\d.*/, "")}[^>]*>`, "gi");
      // Find the first unclosed occurrence
      const openMatches = structHtml.match(openRegex) ?? [];
      const closeRegex = new RegExp(`<\\/${tagName.replace(/\d.*/, "")}>`, "gi");
      const closeMatches = structHtml.match(closeRegex) ?? [];
      if (openMatches.length <= closeMatches.length) return t;
      // Find the Nth open tag without a close
      const lastOpenIdx = structHtml.lastIndexOf(openRegex.source.replace(/\\\//g, "/"));
      const ctx = lastOpenIdx > 0
        ? structHtml.substring(Math.max(0, lastOpenIdx - 80), Math.min(structHtml.length, lastOpenIdx + 80)).replace(/\n/g, "\\n")
        : "ctx=unavailable";
      return `${t} ctx="${ctx}"`;
    });
    errors.push(`Unclosed HTML tags: ${details.join("; ")}`);
  }

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    warnings,
    metrics: {
      wordpressOpeningBlocks: openingBlocks,
      wordpressClosingBlocks: closingBlocks,
      nestedParagraphCount: nestedParagraphs,
      malformedHeadingCount: malformedHeadings,
      linkDestinationsPreserved: linksPreserved,
      faqSchemaPresent: faqPresent,
      faqSchemaValid: faqValid,
      languageSwitcherPresent: switcherPresent,
      ctaPresent,
    },
  };
}

// ── Type-aware WordPress block pair validation ──

interface WpBlockToken {
  kind: "open" | "close";
  type: string;
  index: number;
}

export interface WpBlockValidationResult {
  valid: boolean;
  issues: string[];
}

/** Tokenize WordPress block comment markers from HTML into a sequence of open/close tokens.
 *  Self-closing blocks (`<!-- wp:block /-->`) are skipped. */
export function tokenizeWordpressBlockComments(html: string): WpBlockToken[] {
  const tokens: WpBlockToken[] = [];
  const re = /<!--\s*(?:\/)?(wp:[\w-]+)(?:\s[^>]*)?\s*(?:\/)?\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const full = m[0];
    const type = m[1];
    // Self-closing: <!-- wp:block /-->
    if (/\/-->\s*$/.test(full)) continue;
    // Closing: starts with /
    if (full.startsWith("<!-- /") || full.startsWith("<!--  /")) {
      tokens.push({ kind: "close", type, index: m.index });
    } else {
      tokens.push({ kind: "open", type, index: m.index });
    }
  }
  return tokens;
}

/** Validate WordPress block pairing by matching types, not just total counts.
 *  Uses a stack to ensure every opener is matched by a closer of the same type,
 *  with no crossing. */
export function validateWordpressBlockPairs(html: string): WpBlockValidationResult {
  const stack: Array<{ type: string; index: number }> = [];
  const issues: string[] = [];

  for (const token of tokenizeWordpressBlockComments(html)) {
    if (token.kind === "open") {
      stack.push({ type: token.type, index: token.index });
      continue;
    }

    const opener = stack.pop();

    if (!opener) {
      issues.push(
        `Unexpected closing block wp:${token.type} at offset ${token.index}`
      );
      continue;
    }

    if (opener.type !== token.type) {
      issues.push(
        `WordPress block type mismatch: opened wp:${opener.type} at offset ${opener.index} but closed wp:${token.type} at offset ${token.index}`
      );
    }
  }

  for (const opener of stack) {
    issues.push(
      `Unclosed WordPress block wp:${opener.type} at offset ${opener.index}`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
