import { B2I_DOMAINS } from "@/lib/services/generation-constants";

/** Deterministic language switcher inserted as the first article block.
 *  Links to the paired slug in the alternate language. */
export function renderLanguageSwitcher(params: {
  currentLanguage: "en" | "zh";
  englishSlug: string;
  chineseSlug: string;
}): string {
  const { currentLanguage, englishSlug, chineseSlug } = params;

  if (currentLanguage === "en") {
    return `<!-- wp:html -->
<div class="b2i-language-switcher" data-language="en">
  <span>English</span> |
  <a href="/blog/${chineseSlug}">繁體中文</a>
</div>
<!-- /wp:html -->`;
  }

  return `<!-- wp:html -->
<div class="b2i-language-switcher" data-language="zh">
  <a href="/blog/${englishSlug}">English</a> |
  <span>繁體中文</span>
</div>
<!-- /wp:html -->`;
}

/** Check if an article already has a language switcher block */
export function hasLanguageSwitcher(html: string): boolean {
  return /<!--\s*wp:html\s*-->[\s\S]*?b2i-language-switcher[\s\S]*?<!--\s*\/wp:html\s*-->/i.test(html) ||
    /class\s*=\s*["']b2i-language-switcher["']/i.test(html);
}

/** Prepend language switcher to article HTML. No-op if already present. */
export function ensureLanguageSwitcher(html: string, params: {
  currentLanguage: "en" | "zh";
  englishSlug: string;
  chineseSlug: string;
}): string {
  if (hasLanguageSwitcher(html)) return html;
  const switcher = renderLanguageSwitcher(params);
  return `${switcher}\n\n${html}`;
}

/** Generate paired slugs: EN uses normal slug, ZH appends -zh */
export function pairedSlugs(baseSlug: string): { englishSlug: string; chineseSlug: string } {
  const clean = baseSlug.replace(/\/$/, "").replace(/^-zh$/, "");
  return {
    englishSlug: clean.replace(/-zh$/, ""),
    chineseSlug: clean.endsWith("-zh") ? clean : `${clean}-zh`,
  };
}

/** Insert external authoritative research links into article body.
 *  Uses only project research URLs, never invents links.
 *  Inserts at top-level WordPress block boundaries — never inside a block.
 *  Distributes links across separate sections (max 1 per section, no consecutives). */
export function insertExternalResearchLinks(
  articleHtml: string,
  researchItems: Array<{ url: string; title: string; snippet?: string }>,
  count: number = 3,
): { html: string; linksInserted: number } {
  if (!researchItems || researchItems.length === 0) {
    return { html: articleHtml, linksInserted: 0 };
  }

  // Filter out B2I-owned domains
  const external = researchItems.filter((r) => {
    try {
      const host = new URL(r.url).hostname.toLowerCase().replace("www.", "");
      return !B2I_DOMAINS.some((d) => host.endsWith(d));
    } catch {
      return false;
    }
  });

  if (external.length === 0) {
    return { html: articleHtml, linksInserted: 0 };
  }

  // Pick up to `count` unique domain sources
  const used = new Set<string>();
  const selected = external.filter((r) => {
    try {
      const host = new URL(r.url).hostname;
      if (used.has(host)) return false;
      used.add(host);
      return used.size <= count;
    } catch {
      return false;
    }
  });

  if (selected.length === 0) {
    return { html: articleHtml, linksInserted: 0 };
  }

  // Build individual link blocks
  const linkBlocks = selected.map((s) => {
    const displayDomain = (() => {
      try { return new URL(s.url).hostname.replace("www.", ""); } catch { return s.url; }
    })();
    return `<!-- wp:paragraph -->
<p>Read more at <a href="${s.url}" target="_blank" rel="noopener noreferrer">${displayDomain}</a></p>
<!-- /wp:paragraph -->`;
  });

  // ── Parse top-level WordPress block boundaries ──
  type BlockRange = { start: number; end: number; type: string; innerStart: number };
  const blocks: BlockRange[] = [];

  // Match every top-level wp:block opening
  const blockRe = /<!--\s*(wp:\w+)(?:\s[^>]*)?\s*-->/g;
  const openings: Array<{ index: number; type: string; matchEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(articleHtml)) !== null) {
    openings.push({ index: m.index, type: m[1], matchEnd: m.index + m[0].length });
  }

  // Match every closing block
  const closingRe = /<!--\s*\/wp:\w+\s*-->/g;
  const closings: number[] = [];
  while ((m = closingRe.exec(articleHtml)) !== null) {
    closings.push(m.index);
  }

  // Pair them: each opening matches the corresponding closing (nested wp blocks don't exist at top level)
  for (let i = 0; i < openings.length && i < closings.length; i++) {
    const open = openings[i];
    const closePos = closings[i];
    if (closePos > open.matchEnd) {
      blocks.push({ start: open.index, end: closePos + closings[i], type: open.type, innerStart: open.matchEnd });
    }
  }

  // ── Identify eligible insertion boundaries ──
  // An insertion boundary is the gap between two consecutive top-level blocks.
  // Each boundary = index in the gaps array.
  // We also consider before the first block and after the last block.

  // Classify each block's section affinity by its preceding H2 heading
  const sectionBoundaries: number[] = [0]; // positions after which section changes (index in blocks)

  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].type === "wp:heading") {
      sectionBoundaries.push(i);
    }
  }
  sectionBoundaries.push(blocks.length);

  // Group boundaries (gaps between blocks) into sections
  type Boundary = { position: number; eligible: boolean; sectionIdx: number };
  const boundaries: Boundary[] = [];

  // Before first block
  boundaries.push({ position: blocks.length > 0 ? blocks[0].start : articleHtml.length, eligible: true, sectionIdx: 0 });

  for (let i = 0; i < blocks.length; i++) {
    const pos = blocks[i].end; // gap after this block, before next
    const blockType = blocks[i].type;

    // Ineligible: never insert right after a heading block (would split heading from its content)
    const isHeading = blockType === "wp:heading";
    // Ineligible: never insert inside wp:html (blocks extracted but boundaries are after close)
    const isProtected = blockType === "wp:html";

    // Find which section this belongs to
    let secIdx = 0;
    for (let s = 1; s < sectionBoundaries.length; s++) {
      if (i < sectionBoundaries[s]) { secIdx = s - 1; break; }
      secIdx = sectionBoundaries.length - 1;
    }

    boundaries.push({
      position: pos,
      eligible: !isHeading && !isProtected,
      sectionIdx: secIdx,
    });
  }

  // After last block
  boundaries.push({
    position: articleHtml.length,
    eligible: true,
    sectionIdx: sectionBoundaries.length > 1 ? sectionBoundaries.length - 2 : 0,
  });

  // ── Distribute links: at most 1 link per section, no consecutive boundaries ──
  const linkAssignments: Array<{ boundaryIdx: number; linkHtml: string }> = [];
  const usedSections = new Set<number>();
  let lastUsedBoundary = -2; // prevent consecutive

  for (let linkIdx = 0; linkIdx < linkBlocks.length; linkIdx++) {
    let bestBoundary = -1;
    let bestSection = -1;

    for (let b = 0; b < boundaries.length; b++) {
      if (!boundaries[b].eligible) continue;
      if (usedSections.has(boundaries[b].sectionIdx)) continue;
      if (b === lastUsedBoundary + 1 || b === lastUsedBoundary - 1) continue;

      // Prefer boundaries deeper into the article
      if (bestBoundary === -1 || boundaries[b].position > boundaries[bestBoundary].position) {
        bestBoundary = b;
        bestSection = boundaries[b].sectionIdx;
      }
    }

    if (bestBoundary === -1) {
      // Fallback: use any eligible boundary even if section reused
      for (let b = 0; b < boundaries.length; b++) {
        if (!boundaries[b].eligible) continue;
        if (b === lastUsedBoundary + 1 || b === lastUsedBoundary - 1) continue;
        if (bestBoundary === -1 || boundaries[b].position > boundaries[bestBoundary].position) {
          bestBoundary = b;
        }
      }
      if (bestBoundary === -1) break;
    }

    linkAssignments.push({ boundaryIdx: bestBoundary, linkHtml: linkBlocks[linkIdx] });
    if (bestSection >= 0) usedSections.add(bestSection);
    lastUsedBoundary = bestBoundary;
  }

  if (linkAssignments.length === 0) {
    return { html: articleHtml, linksInserted: 0 };
  }

  // ── Build output by inserting at boundaries (process in reverse order so indices stay correct) ──
  linkAssignments.sort((a, b) => b.boundaryIdx - a.boundaryIdx); // reverse — highest boundary first

  let result = articleHtml;
  for (const assignment of linkAssignments) {
    const pos = boundaries[assignment.boundaryIdx].position;
    if (pos <= result.length) {
      result = result.substring(0, pos) + `\n\n${assignment.linkHtml}` + result.substring(pos);
    }
  }

  return { html: result, linksInserted: linkAssignments.length };
}

// ── URL sanitization for section content ──

/**
 * Strip <a> tags whose href is NOT in the allowed research sources list.
 * Preserves the anchor text (removes only the <a> wrapper), or removes the
 * element entirely if it's an external link not from research sources.
 * Internal links (relative, same-domain) are preserved.
 */
export function sanitizeSectionUrls(
  html: string,
  allowedUrls: string[],
): string {
  if (!allowedUrls || allowedUrls.length === 0) return html;

  const allowedSet = new Set(allowedUrls.map((u) => u.replace(/\/$/, "").toLowerCase()));

  return html.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (match, href, text) => {
    // Preserve internal links
    if (href.startsWith("/") || href.startsWith("#")) return match;
    if (B2I_DOMAINS.some((d) => href.toLowerCase().includes(d))) return match;

    // Check against allowed research URLs
    const normalized = href.replace(/\/$/, "").toLowerCase();
    if (allowedSet.has(normalized)) return match;

    // URL not in allowed list — keep anchor text, remove link wrapper
    return text;
  });
}
