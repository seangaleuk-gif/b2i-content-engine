import { B2I_DOMAINS } from "@/lib/services/generation-constants";
import { assessHeadingSourceTextRelevance } from "@/lib/blog/content-relevance";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";

/** Deterministic language switcher inserted as the first article block.
 *  Links to the paired slug in the alternate language. */
export function renderLanguageSwitcher(params: {
  currentLanguage: "en" | "zh";
  englishSlug: string;
  chineseSlug: string;
}): string {
  const { currentLanguage } = params;
  // Slugs originate in model-produced outline JSON. Derive both destinations
  // from one normalized English slug so quote characters, paths, schemes and
  // mismatched alternate slugs can never enter the protected href markup.
  const { englishSlug, chineseSlug } = pairedSlugs(params.englishSlug || params.chineseSlug);

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

/** Normalize a model-produced slug to one safe WordPress path segment. */
export function normalizeArticleSlug(baseSlug: string): string {
  const normalized = String(baseSlug || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "blog-post";
}

/** Generate paired slugs: EN uses a safe normal slug, ZH appends -zh. */
export function pairedSlugs(baseSlug: string): { englishSlug: string; chineseSlug: string } {
  const clean = normalizeArticleSlug(baseSlug).replace(/-zh$/, "") || "blog-post";
  return {
    englishSlug: clean,
    chineseSlug: `${clean}-zh`,
  };
}

/** A research source URL is eligible for external links when it is a valid
 *  http(s) URL and not B2I-owned. Shared by the research dispatch, the
 *  external-link stage and link diagnostics. */
export function isEligibleExternalSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return !B2I_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
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

  // Two-phase, WordPress-aware block scan. The opener is located first, then
  // the block's true end is found by scanning to the next comment and
  // requiring it to be the exact closer for the same block type. A block whose
  // content contains ANY inline comment (e.g. a legacy
  // "<!-- /wp:paragraph -->" artifact) is never a valid citation anchor: the
  // computed end would fall mid-block and split it. This replaces the fragile
  // single-pass lazy regex, whose content match could not distinguish an
  // inline comment from the real closer.
  type BlockRange = {
    start: number;
    end: number;
    type: string;
    html: string;
    text: string;
    sectionIndex: number;
  };
  const blocks: BlockRange[] = [];
  const openerRe = /<!--\s*wp:([a-z]+)(?:\s[\s\S]*?)?\s*-->/gi;
  let opener: RegExpExecArray | null;
  let sectionIndex = 0;
  const sectionHeadings: string[] = [];
  while ((opener = openerRe.exec(articleHtml)) !== null) {
    const type = opener[1].toLowerCase();
    const contentStart = opener.index + opener[0].length;
    if (type === "heading") {
      // Locate the heading's own region (up to the next comment) so the H2
      // text is read without crossing into the following block.
      const closeAt = articleHtml.indexOf("<!--", contentStart);
      if (closeAt < 0) continue;
      const region = articleHtml.slice(contentStart, closeAt);
      const h2match = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(region);
      if (h2match) {
        sectionIndex++;
        sectionHeadings[sectionIndex] = h2match[1].replace(/<[^>]+>/g, " ").trim();
      }
      continue;
    }
    if (type === "html") continue;
    const closerAt = articleHtml.indexOf("<!--", contentStart);
    if (closerAt < 0) continue;
    const closer = /^<!--\s*\/wp:([a-z]+)\s*-->/i.exec(articleHtml.slice(closerAt));
    if (!closer || closer[1].toLowerCase() !== type) continue;
    const closerEnd = closerAt + closer[0].length;
    // The computed end must be a TRUE block boundary: the text after the
    // closer is a block opener, a component marker or EOF. Anything else means
    // the closer was actually an inline comment and the match truncated.
    const tail = articleHtml.slice(closerEnd).replace(/^\s+/, "");
    if (!isVerifiedBlockBoundary(tail)) continue;
    const blockHtml = articleHtml.slice(opener.index, closerEnd);
    blocks.push({
      start: opener.index,
      end: closerEnd,
      type,
      html: blockHtml,
      text: visibleText(blockHtml),
      sectionIndex,
    });
  }

  const candidates = blocks.map((block, index) => ({
    text: block.text,
    sectionHeading: sectionHeadings[block.sectionIndex] ?? "",
    sectionKey: String(block.sectionIndex),
    order: index,
  }));
  const assignments = selectExternalCitationAssignments(researchItems, candidates, count);
  if (assignments.length === 0) return { html: articleHtml, linksInserted: 0 };

  const positionByOrder = new Map(blocks.map((block, index) => [index, block.end]));
  let result = articleHtml;
  let linksInserted = 0;
  for (const assignment of assignments.sort(
    (left, right) => (positionByOrder.get(right.candidate.order) ?? 0) - (positionByOrder.get(left.candidate.order) ?? 0),
  )) {
    const position = positionByOrder.get(assignment.candidate.order) ?? -1;
    if (position < 0) continue;
    // Insertion-time safety: the position must still be a verified block
    // boundary in the current result, so a citation can never split a block.
    const tail = result.slice(position).replace(/^\s+/, "");
    if (!isVerifiedBlockBoundary(tail)) continue;
    const citation = `<!-- wp:paragraph --><p>Source: <a href="${escapeHtmlAttribute(assignment.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(assignment.source.title)}</a>${citationTerminalPunctuation(assignment.source.title)}</p><!-- /wp:paragraph -->`;
    result = result.slice(0, position) + `\n\n${citation}` + result.slice(position);
    linksInserted++;
  }
  return { html: result, linksInserted };
}

/** True when the text after a block's computed end is a block opener, a
 *  component marker or EOF — i.e. the position is a verified block boundary. */
function isVerifiedBlockBoundary(tail: string): boolean {
  return tail.length === 0
    || /^<!--\s*wp:/i.test(tail)
    || tail.startsWith("<!-- b2i-conclusion-start -->")
    || tail.startsWith("<!-- b2i-conclusion-end -->")
    || tail.startsWith("<!-- b2i-faq-heading -->");
}

export interface ExternalCitationCandidate {
  /** Plain text of the block used for lexical scoring. */
  text: string;
  /** H2 heading of the owning section ("" for the introduction). */
  sectionHeading: string;
  /** Unique per component (used for the one-citation-per-section rule). */
  sectionKey: string;
  /** Stable order within the component (used for insertion sequencing). */
  order: number;
}

export interface ExternalCitationAssignment {
  source: { url: string; title: string; snippet?: string };
  candidate: ExternalCitationCandidate;
  score: number;
}

/**
 * THE shared external-citation selection core. Used by both the html-level
 * producer and the canonical ArticleDocument producer, so the two can never
 * disagree about which source attaches to which section. Filters B2I-owned
 * URLs, scores lexical/quantity/quotation relevance plus section-topic
 * agreement, and enforces one citation per section and per URL.
 */
export function selectExternalCitationAssignments(
  researchItems: Array<{ url: string; title: string; snippet?: string }>,
  candidates: ExternalCitationCandidate[],
  count: number,
): ExternalCitationAssignment[] {
  if (!researchItems || researchItems.length === 0) return [];
  const external = researchItems.filter((item) => {
    try {
      const host = new URL(item.url).hostname.toLowerCase().replace("www.", "");
      return !B2I_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  });
  if (external.length === 0 || candidates.length === 0) return [];

  const scored: ExternalCitationAssignment[] = [];
  for (const source of external) {
    const sourceText = `${source.title} ${source.snippet ?? ""}`;
    const sourceTokenSet = tokenSet(sourceText);
    for (const candidate of candidates) {
      const score = evidenceRelevanceScore(candidate.text, sourceText);
      if (score <= 0) continue;
      if (!assessHeadingSourceTextRelevance(candidate.sectionHeading ?? "", sourceText).relevant) continue;
      const headingOverlap = [...tokenSet(candidate.sectionHeading ?? "")]
        .filter((token) => sourceTokenSet.has(token)).length;
      scored.push({
        source,
        candidate,
        score: score + Math.min(60, headingOverlap * 8),
      });
    }
  }
  scored.sort((left, right) => right.score - left.score);

  const assignments: ExternalCitationAssignment[] = [];
  const usedUrls = new Set<string>();
  const usedSections = new Set<string>();
  for (const item of scored) {
    if (assignments.length >= count) break;
    const normalizedUrl = item.source.url.replace(/\/$/, "").toLowerCase();
    if (usedUrls.has(normalizedUrl) || usedSections.has(item.candidate.sectionKey)) continue;
    assignments.push(item);
    usedUrls.add(normalizedUrl);
    usedSections.add(item.candidate.sectionKey);
  }
  return assignments;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/\d+(?:[.,]\d+)*/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !["that", "this", "with", "from", "threads"].includes(word)),
  );
}

/** Terminal punctuation for an external-source citation paragraph.
 *
 *  The anchor text is the source title, which may already carry its own
 *  terminal punctuation (e.g. "How is AR changing digital marketing in Hong
 *  Kong?"). Appending an unconditional period produces the invalid `? .`
 *  double-punctuation that the sentence-quality/fragment gates reject. This
 *  helper returns EXACTLY ONE terminal mark for the `Source: <title>` sentence:
 *   - "" when the title already ends in `.`, `?` or `!` (looking past any
 *     trailing quotes, parentheses or brackets so `"Why?"`, `(Yes!)`, `Title.`
 *     and `Really?` are all recognised);
 *   - "." otherwise.
 *
 *  The mark is placed OUTSIDE the anchor (the anchor holds only the title), so
 *  the citation reads "Source: Title." / "Source: Title?" without ever
 *  producing `? .`, `! .` or `. .`. */
export function citationTerminalPunctuation(title: string): string {
  const content = String(title ?? "").trimEnd();
  const withoutClosers = content.replace(/["'“”‘’)\]}>]+$/, "");
  if (/[.!?]$/.test(withoutClosers.trimEnd())) return "";
  return ".";
}

/** Canonical editorial blocks eligible as citation anchors (same set the
 *  html-level producer scans: paragraph, list, quote, table; headings and
 *  protected html excluded). */
function citationAnchorText(block: EditorialBlock): string | null {
  const inlineText = (content: Array<{ text: string }>): string =>
    content.map((node) => node.text).join(" ");
  if (block.type === "paragraph" || block.type === "quote") {
    return inlineText(block.content).trim();
  }
  if (block.type === "list") {
    return block.items.map((item) => inlineText(item)).join(" ");
  }
  if (block.type === "table") {
    const headerTexts = block.headers.map((cell) => inlineText(cell));
    const rowTexts = block.rows.flatMap((row) => row.map((cell) => inlineText(cell)));
    return [...headerTexts, ...rowTexts].join(" ");
  }
  return null;
}

/**
 * THE canonical external-link producer: inserts each selected citation as a
 * NEW paragraph block into the ArticleDocument model. Existing editorial
 * blocks — and therefore every existing editorial character, inline node,
 * punctuation, sentence boundary and block order — are never altered, split,
 * deleted or relocated. The citation block itself is the only addition, so
 * the operation is text-preserving by invariant regardless of any malformed
 * or legacy content elsewhere in the document.
 */
export function insertExternalResearchLinksIntoDocument(
  doc: ArticleDocument,
  researchItems: Array<{ url: string; title: string; snippet?: string }>,
  count: number = 6,
): { insertedLinks: number; citations: Array<{ url: string; title: string }> } {
  const components: Array<{ key: string; heading: string; blocks: ArticleDocument["introduction"]["blocks"] }> = [
    { key: "intro", heading: "", blocks: doc.introduction.blocks },
    ...doc.sections
      .filter((section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading")
      .map((section) => ({ key: section.id, heading: section.heading, blocks: section.blocks })),
    { key: "conclusion", heading: "", blocks: doc.conclusion.blocks },
  ];

  const candidates: ExternalCitationCandidate[] = [];
  for (const component of components) {
    component.blocks.forEach((block, index) => {
      const text = citationAnchorText(block);
      if (text === null || !text.trim()) return;
      candidates.push({
        text,
        sectionHeading: component.heading,
        sectionKey: component.key,
        order: index,
      });
    });
  }

  const assignments = selectExternalCitationAssignments(researchItems, candidates, count);
  const citations: Array<{ url: string; title: string }> = [];
  if (assignments.length === 0) return { insertedLinks: 0, citations };

  // Insert after each matched block; process in descending order so earlier
  // insertions never shift later target indices.
  const grouped = new Map<string, Array<{ assignment: ExternalCitationAssignment; order: number }>>();
  for (const assignment of assignments) {
    const entry = grouped.get(assignment.candidate.sectionKey) ?? [];
    entry.push({ assignment, order: assignment.candidate.order });
    grouped.set(assignment.candidate.sectionKey, entry);
  }
  for (const [key, entries] of grouped) {
    const component = components.find((item) => item.key === key);
    if (!component) continue;
    let shift = 0;
    for (const { assignment, order } of entries.sort((left, right) => right.order - left.order)) {
      const targetIndex = order + 1 + shift;
      const terminal = citationTerminalPunctuation(assignment.source.title);
      const citationContent: Extract<EditorialBlock, { type: "paragraph" }>["content"] = [
        { type: "text", text: "Source: " },
        { type: "link", text: assignment.source.title, href: assignment.source.url },
      ];
      if (terminal) citationContent.push({ type: "text", text: terminal });
      const citationBlock: Extract<EditorialBlock, { type: "paragraph" }> = {
        id: `${key}-external-citation-${citations.length}`,
        type: "paragraph",
        content: citationContent,
      };
      component.blocks.splice(targetIndex, 0, citationBlock);
      citations.push({ url: assignment.source.url, title: assignment.source.title });
      shift++;
    }
    if (component.blocks.length > 0) {
      (component as { status?: string }).status = "normalized";
    }
  }
  return { insertedLinks: citations.length, citations };
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
  if (hasQuotation && overlap >= 6) return 80 + overlap;
  // Prose-only sources: substantial lexical agreement (the same token
  // threshold as quoted evidence) is enough to attach a relevant source
  // link. Without this, sources carrying no numbers or quotations could
  // never be linked even when they match the paragraph.
  return overlap >= 6 ? overlap : 0;
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
