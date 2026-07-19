import { internalLinksRepository, suggestedLinksRepository } from "@/lib/repositories";

const MIN_PHRASE_OCCURRENCES = 2;
const MIN_PHRASE_LENGTH = 2;
const MAX_PHRASE_LENGTH = 5;
const MIN_CONFIDENCE = 0.4;

interface PhraseCandidate {
  phrase: string;
  frequency: number;
  firstMatch: number;
}

export async function suggestLinks(
  content: string,
  projectId: number,
  userId: string
): Promise<number> {
  const plainText = content
    .replace(/<!-- [\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\[\]\(\)#*_~`>|]/g, " ")
    .replace(/\{.*?\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!plainText) return 0;

  const words = plainText.split(/\s+/);
  if (words.length < 10) return 0;

  const phraseCounts = new Map<string, { count: number; firstIndex: number }>();
  for (let len = MIN_PHRASE_LENGTH; len <= MAX_PHRASE_LENGTH; len++) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(" ").toLowerCase();
      const existing = phraseCounts.get(phrase);
      if (existing) {
        existing.count++;
      } else {
        phraseCounts.set(phrase, { count: 1, firstIndex: i });
      }
    }
  }

  const activeLinks = await internalLinksRepository.findActiveByUser(userId);
  const activeKeywords = new Set<string>();
  const activeUrls = new Set<string>();

  for (const link of activeLinks) {
    activeUrls.add(link.urlSlug.toLowerCase());
    const keywords = link.keywords && Array.isArray(link.keywords) ? link.keywords : [];
    for (const kw of keywords) {
      activeKeywords.add(kw.toLowerCase().trim());
    }
    activeKeywords.add(link.displayText.toLowerCase().trim());
  }

  const pendingSuggestions = await suggestedLinksRepository.findPendingByUser(userId);
  const pendingSet = new Set<string>();
  for (const s of pendingSuggestions) {
    pendingSet.add(`${s.phrase.toLowerCase()}::${s.suggestedUrl.toLowerCase()}`);
  }

  let createdCount = 0;

  for (const [phrase, info] of phraseCounts) {
    if (info.count < MIN_PHRASE_OCCURRENCES) continue;

    if (activeKeywords.has(phrase)) continue;

    const confidence = Math.min(1.0, info.count * 0.2 + (phrase.split(/\s+/).length * 0.1));
    if (confidence < MIN_CONFIDENCE) continue;

    const suggestedUrl = `/blog/${phrase.replace(/\s+/g, "-")}`;
    if (activeUrls.has(suggestedUrl)) continue;

    const pendingKey = `${phrase}::${suggestedUrl}`;
    if (pendingSet.has(pendingKey)) continue;

    const contextStart = Math.max(0, info.firstIndex - 3);
    const contextEnd = Math.min(words.length, info.firstIndex + 3 + phrase.split(/\s+/).length);
    const sourceContent = words.slice(contextStart, contextEnd).join(" ");

    await suggestedLinksRepository.create({
      userId,
      phrase,
      suggestedUrl,
      confidence,
      status: "pending",
      projectId,
      sourceContent,
    });

    pendingSet.add(pendingKey);
    createdCount++;
  }

  console.log(`[link-suggester] Created ${createdCount} new suggestions`);
  return createdCount;
}
