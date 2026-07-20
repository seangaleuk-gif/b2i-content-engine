import type { ChatMessage, ChatOptions, ChatResult } from "@/lib/services/deepseek";
import { cleanBodyText } from "@/lib/services/text-utils";

interface BlogData {
  title?: string;
  blog?: string;
}

interface FixerContext {
  generated: BlogData;
  chatWithRetry: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;
}

// ── Paragraph extraction ──

interface ParagraphBlock {
  full: string;
  text: string;
  start: number;
  end: number;
}

function extractParagraphBlocks(html: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  const regex = /<!--\s*wp:paragraph\s*-->([\s\S]*?)<!--\s*\/wp:paragraph\s*-->/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const full = match[0];
    const text = cleanBodyText(match[1]);
    blocks.push({ full, text, start: match.index, end: match.index + full.length });
  }
  return blocks;
}

function replaceParagraphBlock(html: string, block: ParagraphBlock, newText: string): string {
  const modifiedBlock = block.full.replace(block.text, newText);
  return html.substring(0, block.start) + modifiedBlock + html.substring(block.end);
}

// ── fixTitle ──

interface TitleFixParams {
  currentLength: number;
  targetMin: number;
  targetMax: number;
  keyphrase?: string;
}

export async function fixTitle(ctx: FixerContext, params: TitleFixParams): Promise<string | null> {
  const { currentLength, targetMin, targetMax, keyphrase } = params;
  const title = ctx.generated.title ?? "";
  if (title.length >= targetMin && title.length <= targetMax) return null;

  // Deterministic: too long → truncate at word boundary
  if (title.length > targetMax) {
    const truncated = title.substring(0, targetMax);
    const lastSpace = truncated.lastIndexOf(" ");
    const fixed = lastSpace > targetMin
      ? truncated.substring(0, lastSpace) + "\u2026"
      : truncated.substring(0, targetMax - 1) + "\u2026";
    if (fixed.length >= targetMin && fixed.length <= targetMax) {
      console.log(`[FIXER:title] Deterministic truncation: ${title.length} → ${fixed.length} chars`);
      return fixed;
    }
  }

  // Deterministic: too short + keyphrase available → prepend
  if (title.length < targetMin && keyphrase && !title.toLowerCase().includes(keyphrase.toLowerCase())) {
    const candidates = [`${keyphrase}: ${title}`, `${keyphrase} \u2014 ${title}`];
    for (const c of candidates) {
      if (c.length >= targetMin && c.length <= targetMax) {
        console.log(`[FIXER:title] Deterministic prepend: ${title.length} → ${c.length} chars`);
        return c;
      }
    }
  }

  // AI fallback — send only the title, not the article
  console.log(`[FIXER:title] AI fallback — requesting alternatives`);
  const direction = title.length < targetMin ? "expand" : "shorten";

  const prompt = `Generate 5 alternative SEO titles that ${direction} this one. Each must be ${targetMin}-${targetMax} characters, include the keyphrase "${keyphrase ?? ""}", and preserve the original meaning.\n\nOriginal (${title.length} chars): "${title}"\n\nReturn as JSON: {"alternatives": ["title 1", "title 2", "title 3", "title 4", "title 5"]}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: "You are an SEO title writer. Return only valid JSON." }, { role: "user", content: prompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 512 }
  );

  const data = JSON.parse(res.content);
  const alternatives: string[] = data.alternatives || [];

  // Pick first alternative that satisfies constraints
  const kpLower = keyphrase?.toLowerCase() ?? "";
  for (const alt of alternatives) {
    if (alt.length >= targetMin && alt.length <= targetMax && (!kpLower || alt.toLowerCase().includes(kpLower))) {
      console.log(`[FIXER:title] Selected alternative: "${alt}" (${alt.length} chars)`);
      return alt;
    }
  }

  // Fallback: pick the closest by length
  const best = alternatives.reduce((a, b) => {
    const aDist = Math.abs(a.length - ((targetMin + targetMax) / 2));
    const bDist = Math.abs(b.length - ((targetMin + targetMax) / 2));
    return aDist < bDist ? a : b;
  }, alternatives[0]);
  return best || null;
}

// ── fixKeyphraseDensity ──

interface DensityFixParams {
  keyphrase: string;
  currentCount: number;
  targetMin: number;
  targetMax: number;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fixKeyphraseDensity(ctx: FixerContext, params: DensityFixParams): Promise<string | null> {
  const { keyphrase, currentCount, targetMin, targetMax } = params;
  if (currentCount >= targetMin && currentCount <= targetMax) return null;

  const blog = ctx.generated.blog ?? "";
  const blocks = extractParagraphBlocks(blog);
  if (blocks.length === 0) return null;

  const delta = currentCount < targetMin ? targetMin - currentCount : currentCount - targetMax;
  const action = currentCount < targetMin ? "add" : "remove";
  const kpRegex = new RegExp(escapeRegex(keyphrase), "gi");

  // Score each paragraph by keyphrase occurrences
  const scored = blocks.map((b, i) => ({
    block: b,
    index: i,
    count: (b.text.match(kpRegex) || []).length,
  }));

  let target: typeof scored[0];
  if (action === "add") {
    // Pick paragraph with lowest density (min 20 chars to avoid empty blocks)
    const candidates = scored.filter((s) => s.block.text.length > 20).sort((a, b) => a.count - b.count);
    target = candidates[0];
  } else {
    // Pick paragraph with highest density
    const candidates = scored.filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
    target = candidates[0];
  }

  if (!target) return null;

  console.log(`[FIXER:density] ${action} ${delta} occurrence(s) in paragraph #${target.index + 1} (${target.block.text.length} chars, ${target.count} mentions)`);

  const prompt = `${action} exactly ${delta} natural occurrence(s) of "${keyphrase}" in this paragraph. Make the smallest possible change. Do not rewrite any sentence that doesn't need the keyphrase.\n\nParagraph:\n"${target.block.text}"\n\nReturn as JSON: {"text": "..."}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: `Surgical editor. ${action} ${delta} "${keyphrase}" occurrence(s). Minimum change.` }, { role: "user", content: prompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 2048 }
  );

  const data = JSON.parse(res.content);
  const modifiedText: string = data.text || "";
  if (!modifiedText || modifiedText === target.block.text) return null;

  const modified = replaceParagraphBlock(blog, target.block, modifiedText);
  return modified;
}

// ── fixReadability ──

interface ReadabilityFixParams {
  currentFlesch: number;
  targetMin: number;
  targetMax: number;
}

function fleschScore(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (words.length === 0 || sentences.length === 0) return 100;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
}

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  let count = 0;
  let prevVowel = false;
  for (const ch of word) {
    const isVowel = "aeiou".includes(ch);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  if (word.endsWith("e")) count--;
  return Math.max(1, count);
}

export async function fixReadability(ctx: FixerContext, params: ReadabilityFixParams): Promise<string | null> {
  const { currentFlesch, targetMin, targetMax } = params;
  if (currentFlesch >= targetMin && currentFlesch <= targetMax) return null;

  const blog = ctx.generated.blog ?? "";
  const blocks = extractParagraphBlocks(blog);
  if (blocks.length === 0) return null;

  // Score each paragraph individually
  const scored = blocks
    .map((b, i) => ({ block: b, index: i, score: Math.round(fleschScore(b.text)), text: b.text }))
    .filter((s) => s.text.length > 60); // Skip very short paragraphs

  if (scored.length === 0) return null;

  // Pick the worst-scoring paragraphs (up to 3, below target)
  const isTooComplex = currentFlesch < targetMin;
  const worst = scored
    .filter((s) => isTooComplex ? s.score < targetMin : s.score > targetMax)
    .sort((a, b) => isTooComplex ? a.score - b.score : b.score - a.score)
    .slice(0, 3);

  if (worst.length === 0) return null;

  console.log(`[FIXER:readability] Simplifying ${worst.length} paragraph(s) (scores: ${worst.map((w) => w.score).join(", ")})`);

  const paragraphsBlock = worst.map((w, i) => `[${i + 1}] (Flesch: ${w.score}, target: ${targetMin}-${targetMax})\n"${w.text}"`).join("\n\n");

  const prompt = `${isTooComplex ? "Simplify" : "Add vocabulary variety to"} these ${worst.length} paragraph(s). For each, make only the minimum changes needed to ${isTooComplex ? `increase readability (target Flesch: ${targetMin}-${targetMax}). Shorten sentences, use simpler words.` : "use more varied vocabulary while keeping clarity."} Return each paragraph's modified text.\n\n${paragraphsBlock}\n\nReturn as JSON: {"paragraphs": ["modified 1", "modified 2", ...]}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: `Surgical readability editor. ${isTooComplex ? "Simplify" : "Add variety to"} ${worst.length} paragraph(s). Minimum changes.` }, { role: "user", content: prompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 4096 }
  );

  const data = JSON.parse(res.content);
  const modifiedParagraphs: string[] = data.paragraphs || [];
  if (modifiedParagraphs.length === 0) return null;

  // Apply replacements in reverse order (preserves positions)
  let modified = blog;
  const replacements = worst
    .map((w, i) => ({ block: w.block, newText: modifiedParagraphs[i] || w.text }))
    .filter((r) => r.newText !== r.block.text)
    .sort((a, b) => b.block.start - a.block.start); // Reverse order for safe replacement

  for (const r of replacements) {
    modified = replaceParagraphBlock(modified, r.block, r.newText);
  }

  console.log(`[FIXER:readability] Replaced ${replacements.length} paragraph(s)`);
  return modified !== blog ? modified : null;
}
