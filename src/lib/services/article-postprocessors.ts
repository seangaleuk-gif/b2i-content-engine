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

  type BlockRange = {
    start: number;
    end: number;
    type: string;
    html: string;
    text: string;
    sectionIndex: number;
  };
  const blocks: BlockRange[] = [];
  const blockRe = /<!--\s*wp:(\w+)(?:\s[\s\S]*?)?\s*-->([\s\S]*?)<!--\s*\/wp:\1\s*-->/gi;
  let match: RegExpExecArray | null;
  let sectionIndex = 0;
  while ((match = blockRe.exec(articleHtml)) !== null) {
    const type = match[1].toLowerCase();
    const full = match[0];
    if (type === "heading" && /<h2\b/i.test(full)) sectionIndex++;
    if (type === "html" || type === "heading") continue;
    blocks.push({
      start: match.index,
      end: match.index + full.length,
      type,
      html: full,
      text: visibleText(full),
      sectionIndex,
    });
  }

  type Assignment = {
    position: number;
    sectionIndex: number;
    source: (typeof external)[number];
    score: number;
  };
  const candidates: Assignment[] = [];
  for (const source of external) {
    for (const block of blocks) {
      const score = evidenceRelevanceScore(block.text, `${source.title} ${source.snippet ?? ""}`);
      if (score <= 0) continue;
      candidates.push({
        position: block.end,
        sectionIndex: block.sectionIndex,
        source,
        score,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.position - right.position);

  const assignments: Assignment[] = [];
  const usedUrls = new Set<string>();
  const usedSections = new Set<number>();
  for (const candidate of candidates) {
    if (assignments.length >= count) break;
    const normalizedUrl = candidate.source.url.replace(/\/$/, "").toLowerCase();
    if (usedUrls.has(normalizedUrl) || usedSections.has(candidate.sectionIndex)) continue;
    assignments.push(candidate);
    usedUrls.add(normalizedUrl);
    usedSections.add(candidate.sectionIndex);
  }

  if (assignments.length === 0) return { html: articleHtml, linksInserted: 0 };

  let result = articleHtml;
  for (const assignment of assignments.sort((left, right) => right.position - left.position)) {
    const citation = `<!-- wp:paragraph --><p>Source: <a href="${escapeHtmlAttribute(assignment.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(assignment.source.title)}</a>.</p><!-- /wp:paragraph -->`;
    result = result.slice(0, assignment.position) + `\n\n${citation}` + result.slice(assignment.position);
  }
  return { html: result, linksInserted: assignments.length };
}

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedQuantities(text: string): number[] {
  const values: number[] = [];
  const re = /\b(\d+(?:\.\d+)?(?:,\d{3})*)\s*(billion|million|thousand|bn|m|k)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const base = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = match[2]?.toLowerCase();
    values.push(base * (
      scale === "billion" || scale === "bn" ? 1_000_000_000
        : scale === "million" || scale === "m" ? 1_000_000
          : scale === "thousand" || scale === "k" ? 1_000
            : 1
    ));
  }
  return values;
}

function evidenceRelevanceScore(blockText: string, sourceText: string): number {
  const blockQuantities = normalizedQuantities(blockText);
  const sourceQuantities = normalizedQuantities(sourceText);
  const sharedQuantity = blockQuantities.some((left) =>
    sourceQuantities.some((right) => Math.abs(left - right) < Number.EPSILON),
  );
  const tokens = (text: string) => [...new Set(
    text.toLowerCase()
      .replace(/\d+(?:[.,]\d+)*/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !["that", "this", "with", "from", "threads"].includes(word)),
  )];
  const blockTokens = tokens(blockText);
  const sourceTokens = tokens(sourceText);
  const overlap = blockTokens.filter((token) => sourceTokens.includes(token)).length;
  if (sharedQuantity) return overlap > 0 ? 100 + overlap : 0;

  // A directly quoted passage must receive a named source link even when it
  // contains no number. Require substantial lexical agreement to avoid
  // attaching a merely topical source.
  const hasQuotation = /["“”]/.test(blockText);
  return hasQuotation && overlap >= 6 ? 80 + overlap : 0;
}

function escapeHtmlAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlText(text: string): string {
  return escapeHtmlAttribute(text).replace(/'/g, "&#39;");
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

// ── Editorial external link deduplication ──

/**
 * Remove duplicate editorial external links from article HTML.
 * For each external URL appearing multiple times, keep only the first
 * occurrence as an anchor; convert later occurrences to plain text
 * while preserving the anchor text.
 *
 * Does NOT affect: internal links, CTA/signup, language-switcher, or schema links.
 */
export function deduplicateEditorialExternalLinks(html: string): { html: string; removed: number } {
  const seenUrls = new Set<string>();
  let removed = 0;

  // Strip schema/script blocks for URL classification but process the full HTML
  // We need to classify each <a> tag: is it editorial external?
  const result = html.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, text) => {
      // Preserve internal links
      if (href.startsWith("/") || href.startsWith("#")) return match;
      // Preserve B2I domain links (CTA, signup, language-switcher)
      if (B2I_DOMAINS.some((d) => href.toLowerCase().includes(d))) return match;

      // Normalize URL for comparison
      const normalized = href.replace(/\/$/, "").toLowerCase();

      if (seenUrls.has(normalized)) {
        removed++;
        return text; // plain text, no link
      }

      seenUrls.add(normalized);
      return match; // first occurrence — keep as link
    }
  );

  return { html: result, removed };
}
