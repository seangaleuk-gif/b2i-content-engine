export interface LinkInjectionResult {
  linksInjected: number;
  linksUsed: { displayText: string; url: string }[];
  modifiedContent: string;
}

const MAX_TOTAL_LINKS = 5;
const MIN_DISTANCE_CHARS = 500;

const SKIP_SELECTORS = [
  /<a\b[^>]*>[\s\S]*?<\/a>/gi,
  /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi,
  /<code\b[^>]*>[\s\S]*?<\/code>/gi,
  /<pre\b[^>]*>[\s\S]*?<\/pre>/gi,
  /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi,
  /<script[\s\S]*?<\/script>/gi,
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

    const keywords: string[] = link.keywords && Array.isArray(link.keywords) ? link.keywords : [];
    if (keywords.length === 0) {
      keywords.push(link.displayText);
    }

    const maxForThis = link.maxPerArticle ?? 3;
    let injectedForThisLink = 0;
    const positionsForThisLink: number[] = [];

    for (const keyword of keywords) {
      if (injectedForThisLink >= maxForThis) break;
      if (totalInjected >= MAX_TOTAL_LINKS) break;

      const escaped = escapeRegex(keyword);
      const wordBoundaryPattern = new RegExp(
        `(?<![a-zA-Z0-9])(${escaped})(?![a-zA-Z0-9])`,
        "gi"
      );

      let match: RegExpExecArray | null;
      while (
        (match = wordBoundaryPattern.exec(content)) !== null &&
        injectedForThisLink < maxForThis &&
        totalInjected < MAX_TOTAL_LINKS
      ) {
        const matchPos = match.index;
        const matchLen = match[0].length;

        if (isInSkipRange(matchPos, skipRanges)) continue;

        if (hasNearbyLinkToUrl(content, matchPos, link.url_slug, 400, 400)) continue;

        const conflicting = insertions.some(
          (ins) => matchPos < ins.pos + ins.length && matchPos + matchLen > ins.pos
        );
        if (conflicting) continue;

        const prevPositions = positionsForThisLink;
        let tooClose = false;
        for (const prevPos of prevPositions) {
          if (Math.abs(matchPos - prevPos) < MIN_DISTANCE_CHARS) {
            tooClose = true;
            break;
          }
        }
        for (const [, positions] of linkPositions) {
          for (const prevPos of positions) {
            if (Math.abs(matchPos - prevPos) < MIN_DISTANCE_CHARS) {
              tooClose = true;
              break;
            }
          }
          if (tooClose) break;
        }
        if (tooClose) continue;

        const replacement = `<a href="${link.url_slug}">${match[0]}</a>`;
        insertions.push({ pos: matchPos, length: matchLen, replacement });
        positionsForThisLink.push(matchPos);
        injectedForThisLink++;
        totalInjected++;

        if (linksUsed.find((u) => u.url === link.url_slug)) break;
      }
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
