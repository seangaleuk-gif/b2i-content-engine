import type { ChatMessage, ChatOptions, ChatResult } from "@/lib/services/deepseek";
import { countReadableWords, robustJsonParse, splitLongParagraphs } from "@/lib/services/text-utils";
import { validateWordpressBlockPairs } from "@/lib/blog/article-integrity";
import { validateProducerSentenceAccounting } from "@/lib/blog/producer-content-contract";
import type { SourceAttribution } from "@/lib/blog/article-document";
import {
  extractPlainTextFromEditorialBlocks,
  parseWordPressEditorialBlocks,
} from "@/lib/blog/article-document";
import { scanMalformedProseInBlocks } from "@/lib/blog/publication-quality";
import { extractReadableText } from "@/lib/seo/seo-text-utils";
import { MAX_SECTION_EXPANSIONS, MAX_SECTION_TRIMS } from "@/lib/services/generation-constants";
import { paragraphSentenceLimit } from "@/lib/content-standards";

export interface SectionExpansionContext {
  chatWithRetry: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;
  /** Optional canonical article counter supplied by the ArticleDocument owner. */
  measureCanonicalVisibleWords?: (sections: ExpandableSection[]) => number;
  /** Compatibility input; evidence is accepted only through each section's evidencePrompt. */
  research?: unknown[];
}

export interface ExpandableSection {
  index: number;
  id?: string;
  heading: string;
  body: string;
  /** Approved evidence owned by this section; no other evidence is permitted. */
  evidencePrompt?: string;
  /** SOURCE-X-CLAIM-Y IDs owned by this section (for provenance validation). */
  ownedEvidenceIds?: ReadonlySet<string>;
  /** Internal-only source provenance accepted for this section (output). */
  attributions?: SourceAttribution[];
  /** Internal-only free-prose accounting accepted for this section (output). */
  freeProseSentences?: string[];
}

interface ExpansionResult {
  accepted: boolean;
  beforeSection: number;
  afterSection: number;
  sectionIndex: number;
  reason?: string;
  /** Internal-only source provenance declared by the expansion response. */
  attributions?: SourceAttribution[];
  /** Internal-only free-prose accounting declared by the expansion response. */
  freeProseSentences?: string[];
}

function validateEditorialFragment(html: string): { valid: boolean; reason?: string } {
  if (!html.trim()) return { valid: false, reason: "empty-fragment" };
  if (/<h2\b|<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2/i.test(html)) {
    return { valid: false, reason: "fragment-introduced-h2" };
  }
  const wp = validateWordpressBlockPairs(html);
  if (!wp.valid) {
    return { valid: false, reason: `invalid-wordpress-fragment:${wp.issues.join(";")}` };
  }
  const openingTypes = [...html.matchAll(/<!--\s*wp:([\w/-]+)/gi)]
    .map((match) => match[1].toLowerCase());
  const supportedTypes = new Set(["paragraph", "heading", "list", "quote", "table"]);
  const unsupportedType = openingTypes.find((type) => !supportedTypes.has(type));
  if (unsupportedType) {
    return { valid: false, reason: `unsupported-editorial-block:${unsupportedType}` };
  }
  const parsed = parseWordPressEditorialBlocks(html, "section-transform-candidate");
  if (parsed.errors.length > 0) {
    return { valid: false, reason: `unparseable-editorial-fragment:${parsed.errors.join(";")}` };
  }
  if (parsed.blocks.length === 0 || parsed.blocks.length !== openingTypes.length) {
    return {
      valid: false,
      reason: `incomplete-editorial-parse:opened=${openingTypes.length}:parsed=${parsed.blocks.length}`,
    };
  }
  const sourceText = extractReadableText(html).replace(/\s+/g, " ").trim();
  const canonicalText = extractPlainTextFromEditorialBlocks(parsed.blocks).replace(/\s+/g, " ").trim();
  if (sourceText !== canonicalText) {
    return { valid: false, reason: "editorial-text-roundtrip-mismatch" };
  }
  const malformed = scanMalformedProseInBlocks(parsed.blocks);
  if (malformed.length > 0) {
    return {
      valid: false,
      reason: `malformed-editorial-fragment:${malformed.map((finding) =>
        `${finding.blockId}[${finding.issues.map((issue) => issue.code).join(",")}]`
      ).join(";")}`,
    };
  }
  return { valid: true };
}

function orderedHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
}

function numericTokens(html: string): string[] {
  return (html.match(/(?:HK\$|US\$|[$£€¥])?\d[\d,.]*(?:%|\s*(?:percent|per cent))?/gi) ?? []);
}

/** Expand the weakest under-length sections to reach the word-count minimum.
 *  APPENDS additional content — never replaces. Accepts only if word count increases. */
export async function expandToMinimum(
  ctx: SectionExpansionContext,
  sections: ExpandableSection[],
  originalSections: ExpandableSection[],
  intro: string,
  conclusion: string,
  currentWordCount: number,
  minimumWordCount: number,
  allocatedPerSection: number,
  maxExpansions: number = MAX_SECTION_EXPANSIONS,
): Promise<{ sections: ExpandableSection[]; finalWordCount: number; expansions: number; expansionResults: ExpansionResult[] }> {
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

    const evidenceBoundary = target.evidencePrompt?.trim()
      ? `\n\nCLAIM OWNERSHIP BOUNDARY:\n${target.evidencePrompt}\nUse only this assigned evidence. Do not introduce or repeat any other precise statistic, date, currency, quotation, benchmark, posting frequency, survey result or platform-availability claim.\nDeclare source provenance for every source-backed factual sentence via "sourceAttributions": [{"sentence":"<exact sentence as written>","evidenceIds":["SOURCE-1-CLAIM-2"]}] using ONLY the evidence IDs above.`
      : `\n\nCLAIM OWNERSHIP BOUNDARY:\nNo precise evidence is assigned. Do not introduce statistics, dates, currencies, quotations, benchmarks, posting frequencies, survey results or platform-availability claims. Return sourceAttributions: [].`;
    const expandPrompt = isMissing
      ? `Generate the full section body. Target approximately ${allocatedPerSection} words. WordPress block format. Return as JSON: {"body": "..."}\n\nSection heading: "${target.heading}"${evidenceBoundary}`
      : `Return ONLY additional WordPress paragraph, list, quote, or table blocks.\n\nDo NOT rewrite the existing section.\nDo NOT repeat the heading.\nDo NOT output an H2.\nDo NOT output the complete section.\nDo NOT repeat a precise claim already present in the existing section. Prefer non-statistical practical guidance, examples and transitions.\n\nWrite approximately ${requestedAddition} additional readable words that continue naturally from the existing section.\n\nSection heading for context (do NOT repeat): "${target.heading}"\n\nExisting section body:\n${target.body.substring(target.body.length - 900)}${evidenceBoundary}\n\nReturn as JSON: {"body": "additional blocks only"}`;

    try {
      const res = await ctx.chatWithRetry(
        [{ role: "system", content: isMissing ? "Generate blog section body content in WordPress block format. Return JSON with body field." : "Generate ADDITIONAL paragraphs to append to a blog section. Return ONLY new content, not the full section. Return JSON with body field." }, { role: "user", content: expandPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );

      const aiPayload = robustJsonParse(res.content) as Record<string, unknown>;
      const aiBody = typeof aiPayload.body === "string" ? aiPayload.body : "";
      const rawAttributions = aiPayload.sourceAttributions;
      const attributions: SourceAttribution[] | undefined = Array.isArray(rawAttributions)
        && rawAttributions.length > 0
        ? rawAttributions
            .filter((entry): entry is SourceAttribution =>
              typeof entry === "object"
              && entry !== null
              && typeof (entry as SourceAttribution).sentence === "string"
              && Array.isArray((entry as SourceAttribution).evidenceIds)
              && (entry as SourceAttribution).evidenceIds.every((id) => typeof id === "string"))
            .map((entry) => ({
              sentence: (entry as SourceAttribution).sentence.trim(),
              evidenceIds: (entry as SourceAttribution).evidenceIds.filter((id) => typeof id === "string"),
            }))
            .filter((entry) => entry.sentence.length > 0 && entry.evidenceIds.length > 0)
        : undefined;
      const rawFreeProse = aiPayload.freeProseSentences;
      const freeProseSentences: string[] | undefined = Array.isArray(rawFreeProse)
        && rawFreeProse.length > 0
        ? rawFreeProse.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            .map((entry) => entry.trim())
        : undefined;

      const beforeWC = countReadableWords(target.body);
      const additionWC = countReadableWords(aiBody);

      if (/<a\b[^>]*href\s*=|app\.b2ihub\.com\/signup/i.test(aiBody)) {
        results.push({
          accepted: false,
          beforeSection: beforeWC,
          afterSection: additionWC,
          sectionIndex: target.origIndex,
          reason: "expansion-introduced-link-or-cta",
        });
        console.log(`[section-expander:REJECT] section=${target.origIndex} reason=expansion-introduced-link-or-cta`);
        expansions++;
        continue;
      }

      const fragmentValidation = validateEditorialFragment(aiBody);
      if (!fragmentValidation.valid) {
        results.push({
          accepted: false,
          beforeSection: beforeWC,
          afterSection: additionWC,
          sectionIndex: target.origIndex,
          reason: fragmentValidation.reason,
        });
        console.log(`[section-expander:REJECT] section=${target.origIndex} reason=${fragmentValidation.reason}`);
        expansions++;
        continue;
      }

      // Source-first provenance: the response must account for EVERY new
      // sentence exactly once (source_fact via sourceAttributions or
      // free_prose via freeProseSentences) with owned evidence only and
      // declared-only fidelity. Violations reject the expansion (the existing
      // bounded retry keeps the section unchanged).
      if (attributions?.length || freeProseSentences?.length) {
        const parsedBlocks = parseWordPressEditorialBlocks(aiBody, `section-${target.origIndex}-expansion`);
        const violations = validateProducerSentenceAccounting(
          {
            blocks: parsedBlocks.blocks,
            sourceAttributions: attributions,
            freeProseSentences,
          },
          {
            componentId: target.id ?? `section-${target.origIndex}`,
            componentType: "section",
            scope: "additive-fragment",
            keyphrase: undefined,
            ownedEvidenceIds: target.ownedEvidenceIds ?? new Set(),
            research: undefined,
            synthesisOnly: false,
          },
        );
        if (violations.length > 0) {
          results.push({
            accepted: false,
            beforeSection: beforeWC,
            afterSection: additionWC,
            sectionIndex: target.origIndex,
            reason: `expansion-source-provenance:${violations.map((v) => v.code).join(",")}`,
          });
          console.log(`[section-expander:REJECT] section=${target.origIndex} reason=expansion-source-provenance`);
          expansions++;
          continue;
        }
      }

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
        const mergedValidation = validateEditorialFragment(mergedBody);
        if (!mergedValidation.valid) {
          results.push({ accepted: false, beforeSection: beforeWC, afterSection: afterWC, sectionIndex: target.origIndex, reason: mergedValidation.reason });
          console.log(`[section-expander:REJECT] section=${target.origIndex} reason=${mergedValidation.reason}`);
          expansions++;
          continue;
        }
        workingSections[target.origIndex] = { ...workingSections[target.origIndex], body: mergedBody, attributions, freeProseSentences };
        results.push({ accepted: true, beforeSection: beforeWC, afterSection: afterWC, sectionIndex: target.origIndex, attributions, freeProseSentences });
        console.log(`[section-expander:EXPAND] section=${target.origIndex} beforeSection=${beforeWC} addition=${additionWC} afterSection=${afterWC} accepted=true`);
      } else {
        const newBodyOnly = isMissing ? afterWC : additionWC;
        results.push({ accepted: false, beforeSection: beforeWC, afterSection: newBodyOnly, sectionIndex: target.origIndex, reason: isMissing ? `too-few-words:${afterWC}` : `word-count-did-not-increase:${beforeWC}->${afterWC}` });
        console.log(`[section-expander:REJECT] section=${target.origIndex} reason=${results[results.length - 1].reason} beforeSection=${beforeWC} afterSection=${newBodyOnly}`);
      }

      // Recalculate total from structured components
      wordCount = ctx.measureCanonicalVisibleWords
        ? ctx.measureCanonicalVisibleWords(workingSections)
        : countReadableWords([intro, ...workingSections.map((s) => s.body), conclusion].join("\n\n"));
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
  sections: ExpandableSection[],
  intro: string,
  conclusion: string,
  currentWordCount: number,
  maximumWordCount: number,
  maxTrims: number = MAX_SECTION_TRIMS,
): Promise<{ sections: ExpandableSection[]; finalWordCount: number; trims: number }> {
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

    const trimPrompt = `Trim this section body only.\n\nRemove approximately ${reductionNeeded} readable words while preserving:\n- Every factual sentence and its exact numbers, dates, currencies, named sources and URLs\n- Internal and external links\n- Keyphrase placement\n- H3 substructure where useful\n\nDo not add any new factual claim or move evidence to another section.\n\nReturn valid WordPress body blocks only. Return as JSON: {"body": "..."}\n\nCurrent section body:\n${target.body}`;

    try {
      const res = await ctx.chatWithRetry(
        [{ role: "system", content: "You trim blog sections concisely. Preserve core meaning, links, and structure. Return JSON with body field. Never add H2 headings." }, { role: "user", content: trimPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );

      const newBody = (robustJsonParse(res.content) as Record<string, string>).body || target.body;
      const beforeSectionWords = countReadableWords(target.body);
      const afterSectionWords = countReadableWords(newBody);
      const fragmentValidation = validateEditorialFragment(newBody);
      const hrefsPreserved = JSON.stringify(orderedHrefs(newBody)) === JSON.stringify(orderedHrefs(target.body));
      const numbersPreserved = JSON.stringify(numericTokens(newBody)) === JSON.stringify(numericTokens(target.body));
      if (!fragmentValidation.valid || afterSectionWords >= beforeSectionWords || !hrefsPreserved || !numbersPreserved) {
        console.log(
          `[section-expander:TRIM-REJECT] section=${target.origIndex}` +
          ` reason=${fragmentValidation.reason ?? (afterSectionWords >= beforeSectionWords ? "not-shorter" : !hrefsPreserved ? "href-parity" : "numeric-parity")}`,
        );
        trims++;
        continue;
      }
      workingSections[target.origIndex] = { ...workingSections[target.origIndex], body: newBody };

      wordCount = ctx.measureCanonicalVisibleWords
        ? ctx.measureCanonicalVisibleWords(workingSections)
        : countReadableWords([intro, ...workingSections.map((s) => s.body), conclusion].join("\n\n"));
      trims++;
    } catch (err) {
      console.warn(`[section-expander:TRIM] Trim failed for section ${target.origIndex}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return { sections: workingSections, finalWordCount: wordCount, trims };
}

export function normalizeParagraphs(html: string, maxSentences: number = paragraphSentenceLimit()): { html: string; splitCount: number } {
  return splitLongParagraphs(html, maxSentences);
}

