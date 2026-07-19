import { internalLinksRepository } from "@/lib/repositories";

export async function syncLinksFromContent(
  content: string,
  projectId: number,
  userId: string
): Promise<number> {
  const linkPattern = /<a\s+href=["']\/blog\/([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let createdCount = 0;

  while ((match = linkPattern.exec(content)) !== null) {
    const slug = match[1].trim();
    const displayText = match[2].replace(/<[^>]+>/g, "").trim();

    if (!slug || !displayText) continue;

    const urlSlug = `/blog/${slug}`;
    const existing = await internalLinksRepository.findBySlug(urlSlug);
    if (existing) continue;

    const keywordContext = extractSurroundingKeywords(content, match.index, match.index + match[0].length);
    const keywords = keywordContext.slice(0, 5);

    await internalLinksRepository.create({
      createdBy: userId,
      displayText,
      urlSlug,
      keywords,
      priority: 2,
      minPerArticle: 1,
      maxPerArticle: 3,
      active: true,
    });

    createdCount++;
    console.log(`[link-sync] Created auto-synced link: "${displayText}" -> ${urlSlug}`);
  }

  console.log(`[link-sync] Synced ${createdCount} new links from content`);
  return createdCount;
}

function extractSurroundingKeywords(
  content: string,
  matchStart: number,
  matchEnd: number
): string[] {
  const beforeText = content.substring(Math.max(0, matchStart - 80), matchStart);
  const afterText = content.substring(matchEnd, Math.min(content.length, matchEnd + 80));

  const stripTags = (text: string) => text.replace(/<[^>]+>/g, " ");
  const cleanedBefore = stripTags(beforeText);
  const cleanedAfter = stripTags(afterText);

  const wordsBefore = cleanedBefore.split(/\s+/).filter(Boolean).slice(-5);
  const wordsAfter = cleanedAfter.split(/\s+/).filter(Boolean).slice(0, 5);

  const allWords = [...wordsBefore, ...wordsAfter];
  const keywords: string[] = [];

  for (let i = 0; i < allWords.length - 1; i++) {
    const bigram = `${allWords[i]} ${allWords[i + 1]}`.toLowerCase();
    if (bigram.length > 4 && !keywords.includes(bigram)) {
      keywords.push(bigram);
    }
  }

  return keywords;
}
