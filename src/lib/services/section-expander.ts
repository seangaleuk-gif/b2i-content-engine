import type { ChatMessage, ChatOptions, ChatResult } from "@/lib/services/deepseek";
import { countReadableWords, robustJsonParse, splitLongParagraphs } from "@/lib/services/text-utils";
import { MAX_SECTION_EXPANSIONS, MAX_SECTION_TRIMS, MAX_SENTENCES_PER_PARAGRAPH } from "@/lib/services/generation-constants";

const stripMainH2Blocks = (html: string): string =>
  html
    .replace(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi, "")
    .replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, "");

export interface SectionExpansionContext {
  chatWithRetry: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;
}

interface Section {
  index: number;
  heading: string;
  body: string;
}

interface ExpansionResult {
  accepted: boolean;
  beforeSection: number;
  afterSection: number;
  sectionIndex: number;
  reason?: string;
}

/** Expand the weakest under-length sections to reach the word-count minimum.
 *  APPENDS additional content — never replaces. Accepts only if word count increases. */
export async function expandToMinimum(
  ctx: SectionExpansionContext,
  sections: Section[],
  originalSections: Section[],
  intro: string,
  conclusion: string,
  currentWordCount: number,
  minimumWordCount: number,
  allocatedPerSection: number,
  maxExpansions: number = MAX_SECTION_EXPANSIONS,
): Promise<{ sections: Section[]; finalWordCount: number; expansions: number; expansionResults: ExpansionResult[] }> {
  let expansions = 0;
  let wordCount = currentWordCount;
  const workingSections = sections.map((s) => ({ ...s }));
  const sectionCountBefore = sections.length;
  const headingSnapshot = sections.map((s) => s.heading);
  const results: ExpansionResult[] = [];
  const attemptsBySection = new Map<number, number>();

  while (wordCount < minimumWordCount && expansions < maxExpansions) {
    // Rank by shortfall from their original allocation (missing sections first)
    const ranked = workingSections
      .map((s, i) => ({
        ...s, origIndex: i,
        wc: countReadableWords(s.body),
        target: allocatedPerSection,
      }))
      .sort((a, b) => {
        // Missing sections first
        if (!a.body && b.body) return -1;
        if (a.body && !b.body) return 1;
        // Then by shortfall
        const sa = Math.max(0, a.target - a.wc);
        const sb = Math.max(0, b.target - b.wc);
        return sb - sa;
      });

    const target = ranked.find((r) => {
      const count = attemptsBySection.get(r.origIndex) ?? 0;
      return count < maxExpansions;
    });

    if (!target) break;
    attemptsBySection.set(target.origIndex, (attemptsBySection.get(target.origIndex) ?? 0) + 1);

    const articleShortfall = Math.max(1, minimumWordCount - wordCount);
    const requestedAddition = Math.max(50, target.target - target.wc);
    const isMissing = !target.body || target.wc === 0;

    console.log(`[section-expander:EXPAND] section=${target.origIndex} currentSectionWords=${target.wc} originalSectionTarget=${allocatedPerSection} articleShortfall=${articleShortfall} requestedAddition=${requestedAddition} isMissing=${isMissing}`);

    const expandPrompt = isMissing
      ? `Generate the full section body. Target approximately ${allocatedPerSection} words. WordPress block format. Return as JSON: {"body": "..."}\n\nSection heading: "${target.heading}"`
      : `Return ONLY additional WordPress paragraph, list, quote, or table blocks.\n\nDo NOT rewrite the existing section.\nDo NOT repeat the heading.\nDo NOT output an H2.\nDo NOT output the complete section.\n\nWrite approximately ${requestedAddition} additional readable words that continue naturally from the existing section.\n\nSection heading for context (do NOT repeat): "${target.heading}"\n\nExisting section body:\n${target.body.substring(target.body.length - 500)}\n\nReturn as JSON: {"body": "additional blocks only"}`;

    try {
      const res = await ctx.chatWithRetry(
        [{ role: "system", content: isMissing ? "Generate blog section body content in WordPress block format. Return JSON with body field." : "Generate ADDITIONAL paragraphs to append to a blog section. Return ONLY new content, not the full section. Return JSON with body field." }, { role: "user", content: expandPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );

      let aiBody = (robustJsonParse(res.content) as Record<string, string>).body || "";
      aiBody = stripMainH2Blocks(aiBody);

      const beforeWC = countReadableWords(target.body);
      const additionWC = countReadableWords(aiBody);

      let mergedBody: string;
      let afterWC: number;

      if (isMissing) {
        mergedBody = aiBody;
        afterWC = countReadableWords(mergedBody);
      } else {
        mergedBody = `${target.body}\n\n${aiBody}`;
        afterWC = countReadableWords(mergedBody);
      }

      if (afterWC > beforeWC) {
        workingSections[target.origIndex] = { ...workingSections[target.origIndex], body: mergedBody };
        results.push({ accepted: true, beforeSection: beforeWC, afterSection: afterWC, sectionIndex: target.origIndex });
        console.log(`[section-expander:EXPAND] section=${target.origIndex} beforeSection=${beforeWC} addition=${additionWC} afterSection=${afterWC} accepted=true`);
      } else {
        const newBodyOnly = isMissing ? afterWC : additionWC;
        results.push({ accepted: false, beforeSection: beforeWC, afterSection: newBodyOnly, sectionIndex: target.origIndex, reason: isMissing ? `too-few-words:${afterWC}` : `word-count-did-not-increase:${beforeWC}->${afterWC}` });
        console.log(`[section-expander:REJECT] section=${target.origIndex} reason=${results[results.length - 1].reason} beforeSection=${beforeWC} afterSection=${newBodyOnly}`);
      }

      // Recalculate total from structured components
      const allHtml = [intro, ...workingSections.map((s) => s.body), conclusion].join("\n\n");
      wordCount = countReadableWords(allHtml);
      console.log(`[section-expander:EXPAND] articleWords=${wordCount} minimum=${minimumWordCount}`);
      expansions++;
    } catch (err) {
      console.warn(`[section-expander:EXPAND] Expansion failed for section ${target.origIndex}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  // Structural invariants
  const finalCount = workingSections.length;
  const headingsChanged = headingSnapshot.some((h, i) => h !== workingSections[i]?.heading);
  console.log(`[section-expander:INVARIANT] sectionCountBefore=${sectionCountBefore} sectionCountAfter=${finalCount} headingsUnchanged=${!headingsChanged}`);

  return { sections: workingSections, finalWordCount: wordCount, expansions, expansionResults: results };
}

export async function trimToMaximum(
  ctx: SectionExpansionContext,
  sections: Section[],
  intro: string,
  conclusion: string,
  currentWordCount: number,
  maximumWordCount: number,
  maxTrims: number = MAX_SECTION_TRIMS,
): Promise<{ sections: Section[]; finalWordCount: number; trims: number }> {
  let trims = 0;
  let wordCount = currentWordCount;
  const workingSections = sections.map((s) => ({ ...s }));

  while (wordCount > maximumWordCount && trims < maxTrims) {
    const ranked = workingSections
      .map((s, i) => ({ ...s, origIndex: i, wc: countReadableWords(s.body) }))
      .sort((a, b) => b.wc - a.wc);

    const target = ranked[0];
    const excessWords = wordCount - maximumWordCount;
    const reductionNeeded = Math.max(50, Math.min(excessWords, 300));

    console.log(`[section-expander:TRIM] section=${target.origIndex} before=${target.wc} reductionNeeded=${reductionNeeded}`);

    const trimPrompt = `Trim this section body only.\n\nRemove approximately ${reductionNeeded} readable words while preserving:\n- Core meaning and evidence\n- Internal and external links\n- Keyphrase placement\n- H3 substructure where useful\n\nReturn valid WordPress body blocks only. Return as JSON: {"body": "..."}\n\nCurrent section body:\n${target.body}`;

    try {
      const res = await ctx.chatWithRetry(
        [{ role: "system", content: "You trim blog sections concisely. Preserve core meaning, links, and structure. Return JSON with body field. Never add H2 headings." }, { role: "user", content: trimPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );

      let newBody = (robustJsonParse(res.content) as Record<string, string>).body || target.body;
      newBody = stripMainH2Blocks(newBody);
      workingSections[target.origIndex] = { ...workingSections[target.origIndex], body: newBody };

      const allHtml = [intro, ...workingSections.map((s) => s.body), conclusion].join("\n\n");
      wordCount = countReadableWords(allHtml);
      trims++;
    } catch (err) {
      console.warn(`[section-expander:TRIM] Trim failed for section ${target.origIndex}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return { sections: workingSections, finalWordCount: wordCount, trims };
}

export function normalizeParagraphs(html: string, maxSentences: number = MAX_SENTENCES_PER_PARAGRAPH): { html: string; splitCount: number } {
  return splitLongParagraphs(html, maxSentences);
}
