export interface LinkInjectionResult {
  linksInjected: number;
  linksUsed: { displayText: string; url: string }[];
  modifiedContent: string;
}

const MAX_TOTAL_LINKS = 4;
const MIN_DISTANCE_CHARS = 500;

// Anchor-quality vocabulary. A keyword anchor is "specific" only when it
// carries at least one meaningful content word beyond geographic names and
// function words. A bare geographic or function-word anchor ("hong kong",
// "click here") does not meaningfully describe its destination and is rejected
// (or the link skipped) whenever a more specific keyword exists for the same
// link. Meaningful topic nouns ("marketing", "brand", "business") are kept:
// they are semantically suitable for the right destination.
const GENERIC_ANCHOR_WORDS = new Set([
  // Geographic / locale (do not by themselves describe a topic)
  "hong", "kong", "hk", "china", "shanghai", "asia", "city", "cities", "local", "regional",
  // Function words and vague anchors
  "the", "a", "an", "of", "for", "in", "on", "at", "to", "with", "and", "or",
  "it", "its", "this", "that", "these", "those", "here", "there", "you", "your",
  "our", "we", "us", "they", "their", "them", "what", "how", "why", "when",
  "where", "which", "who", "click", "read", "more", "learn", "see", "check",
  "best", "top", "new", "now", "today", "year", "years", "2025", "2026",
]);

export function anchorIsSpecific(keyword: string): boolean {
  const words = (keyword.toLowerCase().match(/[a-z0-9]+/gi) ?? [])
    .filter((word) => word.length > 2 && !GENERIC_ANCHOR_WORDS.has(word));
  return words.length > 0;
}

const SKIP_SELECTORS = [
  /<a\b[^>]*>[\s\S]*?<\/a>/gi,
  /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi,
  /<code\b[^>]*>[\s\S]*?<\/code>/gi,
  /<pre\b[^>]*>[\s\S]*?<\/pre>/gi,
  /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi,
  /<script[\s\S]*?<\/script>/gi,
  // Keyword matching runs over the rendered source string. Treat every tag
  // and WordPress comment as non-visible so an attribute or block name can
  // never win before the same keyword in editorial prose.
  /<[^>]+>/g,
];

function getSkipRanges(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const regex of SKIP_SELECTORS) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function isInSkipRange(pos: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
    if (start > pos) break;
  }
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findNearbyLink(content: string, pos: number, lookAhead: number): string | null {
  const window = content.substring(pos, pos + lookAhead);
  const linkMatch = window.match(/<a\b[^>]*href=["']([^"']*)["'][^>]*>/i);
  if (!linkMatch) return null;
  return linkMatch[1];
}

function hasNearbyLinkToUrl(
  content: string,
  pos: number,
  url: string,
  lookBehind: number,
  lookAhead: number
): boolean {
  const windowStart = Math.max(0, pos - lookBehind);
  const windowEnd = Math.min(content.length, pos + lookAhead);
  const window = content.substring(windowStart, windowEnd);
  const regex = new RegExp(
    `<a\\b[^>]*href=["']${escapeRegex(url)}["'][^>]*>`,
    "i"
  );
  return regex.test(window);
}

export async function injectLinks(
  content: string,
  userId: string
): Promise<LinkInjectionResult> {
  const { getDb } = await import("@/db");
  const db = getDb() as any;
  const { data: links } = await db
    .from("internal_links")
    .select("*")
    .eq("active", true)
    .order("priority", { ascending: false });

  if (!links || links.length === 0) {
    console.log("[link-injector] No active links found");
    return { linksInjected: 0, linksUsed: [], modifiedContent: content };
  }

  console.log(`[link-injector] Found ${links.length} active links`);

  const skipRanges = getSkipRanges(content);
  const linksUsed: { displayText: string; url: string }[] = [];
  const insertions: { pos: number; length: number; replacement: string }[] = [];
  let totalInjected = 0;
  const linkPositions: Map<string, number[]> = new Map();

  for (const link of links) {
    if (totalInjected >= MAX_TOTAL_LINKS) break;

    // Skip if article already contains a link to this destination URL
    const existingUrlPattern = new RegExp(
      `<a\\b[^>]*href=["']${escapeRegex(link.url_slug)}["'][^>]*>`,
      "i"
    );
    if (existingUrlPattern.test(content)) continue;

    const keywords: string[] = link.keywords && Array.isArray(link.keywords) ? link.keywords : [];
    if (keywords.length === 0) {
      keywords.push(link.displayText);
    }

    const maxForThis = link.maxPerArticle ?? 3;

    // Collect every keyword match for this link that passes the same
    // skip/nearby/conflict filters as before. Candidates from generic
    // geographic/function-word keywords are kept only as a fallback when no
    // specific (meaningful) anchor exists in the body, so a destination about
    // paid brand deals is never anchored to a bare "hong kong".
    interface AnchorCandidate {
      pos: number;
      len: number;
      specific: boolean;
    }
    const candidates: AnchorCandidate[] = [];
    for (const keyword of keywords) {
      const escaped = escapeRegex(keyword);
      const wordBoundaryPattern = new RegExp(
        `(?<![a-zA-Z0-9])(${escaped})(?![a-zA-Z0-9])`,
        "gi"
      );
      let match: RegExpExecArray | null;
      while ((match = wordBoundaryPattern.exec(content)) !== null) {
        const matchPos = match.index;
        const matchLen = match[0].length;
        if (isInSkipRange(matchPos, skipRanges)) continue;
        if (hasNearbyLinkToUrl(content, matchPos, link.url_slug, 400, 400)) continue;
        const conflicting = insertions.some(
          (ins) => matchPos < ins.pos + ins.length && matchPos + matchLen > ins.pos
        );
        if (conflicting) continue;
        candidates.push({ pos: matchPos, len: matchLen, specific: anchorIsSpecific(keyword) });
      }
    }

    // Only semantically suitable (specific) anchors are used. If the body
    // offers no meaningful anchor for this link, the link is SKIPPED rather
    // than inserting a weak geographic/function-word anchor; surrounding
    // grammar and capitalization are never sacrificed to satisfy a link count.
    const eligible = candidates
      .filter((candidate) => candidate.specific)
      .sort((a, b) => a.pos - b.pos);
    if (eligible.length === 0) continue;

    let injectedForThisLink = 0;
    const positionsForThisLink: number[] = [];
    for (const candidate of eligible) {
      if (injectedForThisLink >= maxForThis) break;
      if (totalInjected >= MAX_TOTAL_LINKS) break;

      const conflicting = insertions.some(
        (ins) => candidate.pos < ins.pos + ins.length && candidate.pos + candidate.len > ins.pos
      );
      if (conflicting) continue;

      // Also skip if an insertion already links to the same URL (duplicate destination prevention)
      const sameUrlInserted = insertions.some((ins) => ins.replacement.includes(link.url_slug));
      if (sameUrlInserted) break; // Don't add another link to the same URL

      let tooClose = false;
      for (const prevPos of positionsForThisLink) {
        if (Math.abs(candidate.pos - prevPos) < MIN_DISTANCE_CHARS) {
          tooClose = true;
          break;
        }
      }
      for (const [, positions] of linkPositions) {
        for (const prevPos of positions) {
          if (Math.abs(candidate.pos - prevPos) < MIN_DISTANCE_CHARS) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) break;
      }
      if (tooClose) continue;

      // The anchor is the body text at the match position: surrounding
      // capitalization and grammar are preserved exactly.
      const anchorText = content.substring(candidate.pos, candidate.pos + candidate.len);
      const replacement = `<a href="${link.url_slug}">${anchorText}</a>`;
      insertions.push({ pos: candidate.pos, length: candidate.len, replacement });
      positionsForThisLink.push(candidate.pos);
      injectedForThisLink++;
      totalInjected++;
    }

    if (injectedForThisLink > 0) {
      linkPositions.set(link.url_slug, positionsForThisLink);
      linksUsed.push({
        displayText: link.display_text ?? link.displayText,
        url: link.url_slug,
      });
    }
  }

  if (insertions.length === 0) {
    console.log("[link-injector] No link injection opportunities found");
    return { linksInjected: 0, linksUsed: [], modifiedContent: content };
  }

  insertions.sort((a, b) => b.pos - a.pos);

  let modifiedContent = content;
  for (const ins of insertions) {
    modifiedContent =
      modifiedContent.substring(0, ins.pos) +
      ins.replacement +
      modifiedContent.substring(ins.pos + ins.length);
  }

  console.log(`[link-injector] Injected ${totalInjected} links`);
  return { linksInjected: totalInjected, linksUsed, modifiedContent };
}
