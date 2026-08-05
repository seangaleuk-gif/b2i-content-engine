// ── Structured source-reference localization (deterministic, no provider calls) ──
//
// Source references (external citation blocks) are represented internally as
// structured SourceReferenceUnit data instead of ordinary body paragraphs. This
// module:
//   - detects citation blocks in the English source document and extracts the
//     immutable original title / publisher / URL;
//   - matches the corresponding translated Chinese block (by position, which the
//     document-context assembly preserves 1:1) and captures the localized display
//     title the model produced;
//   - deterministically re-renders the visible Chinese citation block so the
//     English original is never shown beside the Chinese title;
//   - validates canonical invariants (count, presence, URL, title, publisher,
//     mapping) and returns severity-based findings;
//   - exposes reusable QA categories for source / semantic / language issues.
//
// It never adds provider calls, retries, repair stages or SQL. The original
// English title, publisher and URL are preserved internally for traceability.

import type { ArticleDocument, EditorialBlock, SourceReferenceUnit } from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";

// ── Citation-block detection ──

const CITATION_LABEL_RE = /^\s*(?:來源|資料來源|Source)\s*[：:]/iu;

function blockVisibleText(block: EditorialBlock): string {
  const collect = (nodes: InlineContent[]): string => nodes.map((n) => n.text ?? "").join("");
  switch (block.type) {
    case "list":
      return block.items.map(collect).join(" ");
    case "table":
      return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
    default:
      return collect(block.content);
  }
}

/** True when a block is a source citation line (來源：/資料來源：/Source:). */
export function isSourceReferenceBlock(block: EditorialBlock): boolean {
  return CITATION_LABEL_RE.test(blockVisibleText(block).trimStart());
}

// ── Content positions ──
// Sections (in order) followed by conclusion blocks. The document-context
// assembly preserves this order 1:1 between the English source and the Chinese
// result, so positions line up and can be matched by source-unit-ID-shaped key.

export interface ContentPosition {
  key: string;
  block: EditorialBlock;
}

function contentPositionsOfSections(sections: ArticleDocument["sections"]): ContentPosition[] {
  const positions: ContentPosition[] = [];
  for (let si = 0; si < sections.length; si++) {
    for (let bi = 0; bi < sections[si].blocks.length; bi++) {
      positions.push({ key: `section.${si}.block.${bi}`, block: sections[si].blocks[bi] });
    }
  }
  return positions;
}

export function enumerateSourceReferencePositions(doc: ArticleDocument): ContentPosition[] {
  const positions = contentPositionsOfSections(doc.sections);
  for (let i = 0; i < doc.conclusion.blocks.length; i++) {
    positions.push({ key: `conclusion.block.${i}`, block: doc.conclusion.blocks[i] });
  }
  return positions;
}

// ── Inline content helpers ──

interface SourceLinkExtraction {
  title: string;
  url?: string;
}

/** Extract the source title (and URL) from a citation block's inline content. */
export function extractSourceLinkFromBlock(block: EditorialBlock): SourceLinkExtraction | null {
  if (block.type === "list" || block.type === "table") {
    return { title: blockVisibleText(block) };
  }
  const link = block.content.find((n): n is Extract<InlineContent, { type: "link" }> => n.type === "link");
  if (link) {
    return { title: link.text, url: link.href };
  }
  const text = blockVisibleText(block)
    .replace(/^\s*(?:來源|資料來源|Source)\s*[：:]\s*/iu, "")
    .replace(/[。.！？!?]+$/u, "")
    .trim();
  return text ? { title: text } : null;
}

/**
 * Approved deterministic publisher-name map (host → display name). Used instead of
 * hostname-derived slugs so the reader-facing source never shows "Anymindgroup",
 * "Openinfluence", "Influencermarketinghub" or "Starngage".
 */
export const APPROVED_PUBLISHER_NAMES: Readonly<Record<string, string>> = {
  "anymindgroup.com": "AnyMind Group",
  "openinfluence.com": "Open Influence",
  "influencermarketinghub.com": "Influencer Marketing Hub",
  "starngage.com": "StarNgage",
  "lunagroup.com": "Luna Group",
  "luna.hk": "Luna",
  "example.com": "Example",
};

/**
 * Deterministically strip a model-generated trailing publisher suffix from a
 * localized source-title display string, so the canonical approved publisher is
 * rendered exactly once (never twice and never as a raw hostname slug).
 *
 * - After a strong vertical-bar separator (`|` / `｜`) a short trailing segment is
 *   treated as a publisher suffix and removed — this is the classic "title | publisher"
 *   form the model tends to emit (e.g. "… | AnyMind Group", "… | 香港創作者代理商").
 * - After a dash separator (`—` / `–` / `-`) the trailing segment is removed only
 *   when it clearly resembles a publisher: the canonical publisher, an approved
 *   publisher alias, a hostname-derived slug, or a single alphanumeric token. This
 *   avoids removing legitimate em-dash phrasing from a normal title.
 * - A long trailing segment (> 30 chars) after any separator is assumed to be part
 *   of the title and is never removed.
 */
export function stripTrailingPublisherSuffix(
  localizedDisplayTitle: string,
  canonicalPublisher?: string,
): string {
  const title = (localizedDisplayTitle ?? "").trim();
  if (!title) return title;

  const barMatch = title.match(/[\s]*[|｜][\s]*([^|｜]+)$/u);
  if (barMatch) {
    const segment = barMatch[1].trim();
    if (segment.length > 0 && segment.length <= 30) {
      return title.replace(barMatch[0], "").trim();
    }
  }

  const dashMatch = title.match(/[\s]*[—–-][\s]*([^—–-]+)$/u);
  if (dashMatch) {
    const segment = dashMatch[1].trim();
    if (segment.length === 0 || segment.length > 30) return title;
    const lower = segment.toLowerCase();
    const resemblesPublisher =
      Boolean(canonicalPublisher && lower === canonicalPublisher.trim().toLowerCase()) ||
      Object.values(APPROVED_PUBLISHER_NAMES).some((n) => n.toLowerCase() === lower) ||
      isHostnameDerivedPublisherName(segment) ||
      /^[A-Za-z][A-Za-z0-9]+$/.test(segment);
    if (resemblesPublisher) {
      return title.replace(dashMatch[0], "").trim();
    }
  }

  return title;
}

/** Approved display publisher name for a URL, or undefined when unknown (never invent). */
export function approvedPublisherName(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
  return APPROVED_PUBLISHER_NAMES[host];
}

/** True when a display string looks like a hostname-derived slug (single uncased word). */
export function isHostnameDerivedPublisherName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  // Approved names are multi-word or map to known hosts; a hostname-derived slug is
  // a single capitalized concatenation that is NOT an approved publisher name.
  if (/^[A-Za-z][A-Za-z0-9]+$/.test(trimmed)) {
    return !Object.values(APPROVED_PUBLISHER_NAMES).includes(trimmed);
  }
  return false;
}

/** Deterministic approved publisher identity for a source URL, or undefined when unknown. */
export function derivePublisherName(url: string): string | undefined {
  return approvedPublisherName(url);
}

/** Build a paragraph block that renders the visible Chinese citation line. */
export function buildSourceReferenceBlock(unit: SourceReferenceUnit): EditorialBlock {
  const rawTitle = unit.localizedDisplayTitle && unit.localizedDisplayTitle.trim()
    ? unit.localizedDisplayTitle.trim()
    : unit.originalTitle;
  // Belt-and-braces: never let a model-added publisher suffix reach the reader. The
  // canonical approved publisher is appended exactly once below.
  const title = stripTrailingPublisherSuffix(rawTitle, unit.originalPublisher);
  const content: InlineContent[] = [{ type: "text", text: "來源：" }];
  if (unit.originalUrl) {
    content.push({ type: "link", text: title, href: unit.originalUrl, sourceType: "editorial-external" });
  } else {
    content.push({ type: "text", text: title });
  }
  // Deterministic publisher display: approved localized publisher, else the approved
  // deterministic name for the URL host. A hostname-derived slug is never shown.
  const publisher = (unit.localizedPublisher && unit.localizedPublisher.trim())
    ? unit.localizedPublisher.trim()
    : (unit.originalPublisher && unit.originalPublisher.trim() ? unit.originalPublisher.trim() : "");
  if (publisher) content.push({ type: "text", text: ` — ${publisher}` });
  return { id: `source-ref-${unit.sourceReferenceId}`, type: "paragraph", content };
}

// ── Localization: extract originals from English + localized from Chinese ──

export interface SourceLocalizationResult {
  doc: ArticleDocument;
  units: SourceReferenceUnit[];
  findings: SourceReferenceFinding[];
  diagnostics: {
    sourceReferenceCount: number;
    localizedTitleCount: number;
    officialLocalizedNameCount: number;
    aiLocalizedTitleCount: number;
    canonicalSourceFailures: number;
  };
}

/** Extract the immutable originals from the English source document. */
export function extractSourceReferenceOriginals(enDoc: ArticleDocument): Map<string, SourceReferenceUnit> {
  const map = new Map<string, SourceReferenceUnit>();
  let seq = 0;
  for (const pos of enumerateSourceReferencePositions(enDoc)) {
    if (!isSourceReferenceBlock(pos.block)) continue;
    const link = extractSourceLinkFromBlock(pos.block);
    if (!link) continue;
    map.set(pos.key, {
      sourceReferenceId: `source-ref-${seq++}`,
      sourceUnitId: pos.key,
      originalTitle: link.title,
      originalPublisher: link.url ? derivePublisherName(link.url) : undefined,
      originalUrl: link.url,
    });
  }
  return map;
}

// ── QA categories (source / semantic / language) ──

export type SourceReferenceFindingCategory =
  | "source-title-not-localized"
  | "source-title-semantic-drift"
  | "source-publisher-altered"
  | "source-url-altered"
  | "source-mapping-altered"
  | "source-title-punctuation"
  | "source-title-duplicate-publisher"
  | "source-title-unnecessary-english";

export type SourceFindingSeverity = "critical" | "major" | "minor" | "advisory";

export interface SourceReferenceFinding {
  sourceReferenceId: string;
  sourceUnitId: string;
  category: SourceReferenceFindingCategory;
  severity: SourceFindingSeverity;
  messageCode: string;
}

/** True when the localized title still looks like untranslated English prose. */
function isLikelyEnglishTitle(title: string): boolean {
  const latinChars = (title.match(/[A-Za-z]/g) || []).length;
  const cjkChars = (title.match(/[\u3400-\u9fff]/g) || []).length;
  return latinChars >= 4 && cjkChars === 0;
}

/** Validate canonical invariants between the English originals and the localized Chinese units. */
export function validateSourceReferences(
  originals: Map<string, SourceReferenceUnit>,
  units: SourceReferenceUnit[],
): SourceReferenceFinding[] {
  const findings: SourceReferenceFinding[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    const original = originals.get(unit.sourceUnitId);
    if (!original) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-mapping-altered",
        severity: "critical",
        messageCode: "source-without-english-counterpart",
      });
      continue;
    }
    if (seen.has(unit.sourceUnitId)) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-mapping-altered",
        severity: "critical",
        messageCode: "duplicate-source-reference",
      });
    }
    seen.add(unit.sourceUnitId);

    const urlChanged = Boolean(original.originalUrl) && original.originalUrl !== unit.originalUrl;
    if (urlChanged) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-url-altered",
        severity: "critical",
        messageCode: "source-url-altered",
      });
    }
    if (original.originalPublisher && original.originalPublisher !== unit.originalPublisher) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-publisher-altered",
        severity: "major",
        messageCode: "source-publisher-altered",
      });
    }
    if (unit.localizedDisplayTitle && isLikelyEnglishTitle(unit.localizedDisplayTitle)) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-title-not-localized",
        severity: "minor",
        messageCode: "source-title-not-localized",
      });
    }
    if (unit.originalUrl && unit.localizedPublisher && unit.originalPublisher && unit.localizedPublisher !== unit.originalPublisher) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-publisher-altered",
        severity: "major",
        messageCode: "localized-publisher-without-approval",
      });
    }
    // Reader-facing publisher display must never be a hostname-derived slug.
    const displayPublisher = unit.localizedPublisher?.trim() || unit.originalPublisher?.trim() || "";
    if (displayPublisher && isHostnameDerivedPublisherName(displayPublisher)) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-publisher-altered",
        severity: "critical",
        messageCode: "source-publisher-slug",
      });
    }
    // Belt-and-braces: the reader must never see the canonical publisher more than
    // once (an embedded publisher suffix still in the title PLUS the appended one).
    // The normal path strips the suffix before storage, so this only fires on a
    // residual duplication that slipped through.
    const appendedPublisher = (unit.localizedPublisher?.trim() || unit.originalPublisher?.trim() || "").toLowerCase();
    const localizedTitleLower = (unit.localizedDisplayTitle ?? "").toLowerCase();
    if (appendedPublisher && localizedTitleLower.includes(appendedPublisher)) {
      findings.push({
        sourceReferenceId: unit.sourceReferenceId,
        sourceUnitId: unit.sourceUnitId,
        category: "source-title-duplicate-publisher",
        severity: "major",
        messageCode: "source-title-duplicate-publisher",
      });
    }
  }
  for (const [key, original] of originals) {
    if (!units.some((u) => u.sourceUnitId === key)) {
      findings.push({
        sourceReferenceId: original.sourceReferenceId,
        sourceUnitId: key,
        category: "source-mapping-altered",
        severity: "critical",
        messageCode: "missing-source-reference",
      });
    }
  }
  return findings;
}

/**
 * Deterministically localize every source reference in a Chinese document using
 * the immutable English originals. Rebuilds each citation block (the English
 * original is never shown beside the Chinese title), attaches the structured
 * sourceReferences to the document and returns severity-based findings.
 */
export function applySourceReferenceLocalization(
  zhDoc: ArticleDocument,
  enDoc: ArticleDocument,
): SourceLocalizationResult {
  const originals = extractSourceReferenceOriginals(enDoc);
  const out = structuredClone(zhDoc) as ArticleDocument;
  const units: SourceReferenceUnit[] = [];
  let aiLocalized = 0;

  for (const pos of enumerateSourceReferencePositions(out)) {
    const original = originals.get(pos.key);
    if (!original) continue;
    // A Chinese position is only a source reference when it is still a citation
    // block. If the English original exists here but the Chinese block is no
    // longer a citation line, the source was removed/reassigned and validation
    // reports it as missing (critical).
    if (!isSourceReferenceBlock(pos.block)) continue;

    let sectionIndex = -1;
    let blockIndex = -1;
    const sectionRe = /^section\.(\d+)\.block\.(\d+)$/.exec(pos.key);
    if (sectionRe) {
      sectionIndex = Number(sectionRe[1]);
      blockIndex = Number(sectionRe[2]);
    } else {
      const concRe = /^conclusion\.block\.(\d+)$/.exec(pos.key);
      if (concRe) {
        sectionIndex = -1;
        blockIndex = Number(concRe[1]);
      }
    }

    const current = extractSourceLinkFromBlock(pos.block);
    // Strip any model-generated trailing publisher suffix BEFORE storing, so the
    // canonical title, validation and rendering all agree on a clean display title.
    const localizedDisplayTitle = stripTrailingPublisherSuffix(
      current?.title?.trim() || original.originalTitle,
      original.originalPublisher,
    );
    if (localizedDisplayTitle && localizedDisplayTitle !== original.originalTitle) {
      aiLocalized += 1;
    }
    const unit: SourceReferenceUnit = {
      ...original,
      sourceUnitId: pos.key,
      // The URL actually present in the Chinese block, so validation can detect
      // any byte-for-byte change against the immutable English original.
      originalUrl: current?.url ?? original.originalUrl,
      localizedDisplayTitle,
    };
    units.push(unit);

    const rebuilt = buildSourceReferenceBlock(unit);
    if (sectionIndex >= 0) {
      out.sections[sectionIndex].blocks[blockIndex] = rebuilt;
    } else if (blockIndex >= 0) {
      out.conclusion.blocks[blockIndex] = rebuilt;
    }
  }

  out.sourceReferences = units;

  const findings = validateSourceReferences(originals, units);
  const criticalOrMajor = findings.filter((f) => f.severity === "critical" || f.severity === "major").length;
  return {
    doc: out,
    units,
    findings,
    diagnostics: {
      sourceReferenceCount: units.length,
      localizedTitleCount: units.filter((u) => u.localizedDisplayTitle && !isLikelyEnglishTitle(u.localizedDisplayTitle)).length,
      officialLocalizedNameCount: units.filter((u) => u.localizedPublisher).length,
      aiLocalizedTitleCount: aiLocalized,
      canonicalSourceFailures: criticalOrMajor,
    },
  };
}

/** Human-readable summary used by the preview payload and logs. */
export function summarizeSourceFindings(findings: SourceReferenceFinding[]): string[] {
  return [...new Set(findings.map((f) => `${f.severity}:${f.messageCode}`))];
}
