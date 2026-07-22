import type { ChatMessage, ChatOptions, ChatResult } from "@/lib/services/deepseek";
import { buildSystemPrompt, STAGE_SYSTEM_PROMPTS, type BlogContext } from "@/lib/services/prompt-builder";
import { cleanBodyText, countWords, robustJsonParse } from "@/lib/services/text-utils";
import { SEO_TITLE_MIN, SEO_TITLE_MAX, META_MIN, META_MAX, keyphraseRangeForWordCount, FLESCH_MIN, FLESCH_MAX } from "@/lib/services/generation-constants";

// ── Types ──

export interface GenContext {
  chatWithRetry: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;
  promptContext: BlogContext;
}

export interface ComponentFailure {
  component: string;
  reason: string;
  target: string;
  actual: string;
}

// ── Flesch helpers ──

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  let count = 0, prevVowel = false;
  for (const ch of word) {
    const v = "aeiou".includes(ch);
    if (v && !prevVowel) count++;
    prevVowel = v;
  }
  if (word.endsWith("e")) count--;
  return Math.max(1, count);
}

function fleschOnText(text: string): number {
  const cleaned = cleanBodyText(text);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const sentences = cleaned.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (words.length === 0 || sentences.length === 0) return 100;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
}

// ── Section helpers ──

interface SectionBlock {
  index: number;
  heading: string;
  body: string;
  start: number;
  end: number;
}

function extractSections(blog: string): SectionBlock[] {
  const sections: SectionBlock[] = [];
  const h2Regex = /<!--\s*wp:heading\s*\{[^}]*"level":2[^}]*\}\s*-->\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi;
  let match: RegExpExecArray | null;
  while ((match = h2Regex.exec(blog)) !== null) {
    const headingStart = match.index;
    const headingEnd = match.index + match[0].length;
    const headingText = cleanBodyText(match[1]);

    // Body is everything from heading end to next heading or end
    const nextStart = sections.length + 1;
    sections.push({ index: sections.length, heading: headingText, body: "", start: headingStart, end: 0 });
  }

  // Fill in body and end for each section
  for (let i = 0; i < sections.length; i++) {
    const bodyStart = sections[i].start + (blog.substring(sections[i].start).match(h2Regex)?.[0]?.length ?? 0);
    h2Regex.lastIndex = 0; // Reset regex
    // Find the actual match position
    const re = /<!--\s*wp:heading\s*\{[^}]*"level":2[^}]*\}\s*-->\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi;
    re.lastIndex = sections[i].start;
    const m = re.exec(blog);
    const bodyStartActual = m ? m.index + m[0].length : sections[i].start;

    const bodyEnd = i < sections.length - 1 ? sections[i + 1].start : blog.length;
    sections[i].body = blog.substring(bodyStartActual, bodyEnd).trim();
    sections[i].start = m ? m.index : sections[i].start;
    sections[i].end = bodyEnd;
  }

  return sections;
}

// Simpler approach: find sections by heading position
function extractSectionsSimple(blog: string): { index: number; headingBlock: string; headingText: string; bodyText: string; start: number; bodyStart: number; end: number }[] {
  const sections: { index: number; headingBlock: string; headingText: string; bodyText: string; start: number; bodyStart: number; end: number }[] = [];
  const re = /(<!--\s*wp:heading\s*\{[^}]*"level":2[^}]*\}\s*-->\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<!--\s*\/wp:heading\s*-->)/gi;
  let match: RegExpExecArray | null;
  const matches: { index: number; full: string; text: string }[] = [];

  while ((match = re.exec(blog)) !== null) {
    matches.push({ index: match.index, full: match[0], text: cleanBodyText(match[0]) });
  }

  for (let i = 0; i < matches.length; i++) {
    const bodyStart = matches[i].index + matches[i].full.length;
    const end = i < matches.length - 1 ? matches[i + 1].index : blog.length;
    sections.push({
      index: i,
      headingBlock: matches[i].full,
      headingText: matches[i].text,
      bodyText: blog.substring(bodyStart, end).trim(),
      start: matches[i].index,
      bodyStart,
      end,
    });
  }

  return sections;
}

function replaceSectionInBlog(blog: string, sectionIndex: number, newBody: string): string {
  const sections = extractSectionsSimple(blog);
  if (sectionIndex < 0 || sectionIndex >= sections.length) return blog;
  const s = sections[sectionIndex];
  return blog.substring(0, s.bodyStart) + newBody + blog.substring(s.end);
}

// ── Component validators ──

export function validateComponents(
  blog: string,
  title: string,
  meta: string,
  keyphrase: string,
): ComponentFailure[] {
  const failures: ComponentFailure[] = [];

  // Title
  const tl = title.length;
  if (tl < SEO_TITLE_MIN || tl > SEO_TITLE_MAX) {
    failures.push({ component: "title", reason: `Length ${tl}`, target: `${SEO_TITLE_MIN}-${SEO_TITLE_MAX}`, actual: `${tl}` });
  }

  // Meta
  const ml = meta.length;
  if (ml < META_MIN || ml > META_MAX) {
    failures.push({ component: "meta", reason: `Length ${ml}`, target: `${META_MIN}-${META_MAX}`, actual: `${ml}` });
  }

  if (!keyphrase) return failures;

  const blogCleaned = cleanBodyText(blog);
  const kpLower = keyphrase.toLowerCase();

  // Density — identifies which section to regenerate
  const kc = blogCleaned.toLowerCase().split(kpLower).length - 1;
  const kpRange = keyphraseRangeForWordCount(countWords(blogCleaned));
  if (kc < kpRange.min || kc > kpRange.max) {
    const sections = extractSectionsSimple(blog);
    if (sections.length > 0) {
      if (kc < kpRange.min) {
        // Find section with fewest keyphrases to add to
        let worstIdx = 0, worstCount = Infinity;
        for (const s of sections) {
          const count = cleanBodyText(s.bodyText).toLowerCase().split(kpLower).length - 1;
          if (count < worstCount) { worstCount = count; worstIdx = s.index; }
        }
        failures.push({ component: `section:${worstIdx}`, reason: `Density ${kc} (section ${worstIdx} has ${worstCount})`, target: `${kpRange.min}-${kpRange.max}`, actual: `${kc}` });
      } else {
        // Find section with most keyphrases to regenerate
        let worstIdx = 0, worstCount = 0;
        for (const s of sections) {
          const count = cleanBodyText(s.bodyText).toLowerCase().split(kpLower).length - 1;
          if (count > worstCount) { worstCount = count; worstIdx = s.index; }
        }
        failures.push({ component: `section:${worstIdx}`, reason: `Density ${kc} (section ${worstIdx} has ${worstCount})`, target: `${kpRange.min}-${kpRange.max}`, actual: `${kc}` });
      }
    } else {
      failures.push({ component: "density", reason: `Count ${kc}`, target: `${kpRange.min}-${kpRange.max}`, actual: `${kc}` });
    }
  }

  // Readability — identifies worst sections
  const fs = Math.round(fleschOnText(blog));
  if (fs < FLESCH_MIN || fs > FLESCH_MAX) {
    const sections = extractSectionsSimple(blog);
    const scored = sections
      .filter((s) => cleanBodyText(s.bodyText).length > 40)
      .map((s) => ({ index: s.index, score: Math.round(fleschOnText(s.bodyText)) }))
      .filter((s) => fs < FLESCH_MIN ? s.score < FLESCH_MIN : s.score > FLESCH_MAX)
      .sort((a, b) => fs < FLESCH_MIN ? a.score - b.score : b.score - a.score);

    const targets = scored.slice(0, 2); // Regenerate up to 2 worst sections
    if (targets.length === 0 && sections.length > 0) {
      // No section individually fails but overall fails — pick worst
      const all = sections
        .filter((s) => cleanBodyText(s.bodyText).length > 40)
        .map((s) => ({ index: s.index, score: Math.round(fleschOnText(s.bodyText)) }))
        .sort((a, b) => fs < FLESCH_MIN ? a.score - b.score : b.score - a.score);
      if (all.length > 0) {
        failures.push({ component: `section:${all[0].index}`, reason: `Flesch ${fs}`, target: `${FLESCH_MIN}-${FLESCH_MAX}`, actual: `${fs}` });
      }
    } else {
      for (const t of targets) {
        failures.push({ component: `section:${t.index}`, reason: `Flesch ${fs} (section ${t.index}: ${t.score})`, target: `${FLESCH_MIN}-${FLESCH_MAX}`, actual: `${fs}` });
      }
    }

    if (!failures.some((f) => f.component.startsWith("section:"))) {
      failures.push({ component: "readability", reason: `Flesch ${fs}`, target: `${FLESCH_MIN}-${FLESCH_MAX}`, actual: `${fs}` });
    }
  }

  return failures;
}

// ── Regeneration functions ──

export async function regenerateTitle(
  ctx: GenContext,
  currentTitle: string,
  keyphrase: string,
): Promise<string> {
  const prompt = `Generate 5 alternative SEO titles that are ${SEO_TITLE_MIN}-${SEO_TITLE_MAX} characters and include the keyphrase "${keyphrase}".\n\nCurrent title (${currentTitle.length} chars): "${currentTitle}"\n\nReturn as JSON: {"alternatives": ["title 1", "title 2", "title 3", "title 4", "title 5"]}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: "You are an SEO title writer. Return only valid JSON." }, { role: "user", content: prompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 512 }
  );

  const data = robustJsonParse(res.content) as Record<string, string[]>;
  const alternatives: string[] = data.alternatives || [];
  const kpLower = keyphrase.toLowerCase();

  for (const alt of alternatives) {
    if (alt.length >= SEO_TITLE_MIN && alt.length <= SEO_TITLE_MAX && alt.toLowerCase().includes(kpLower)) {
      return alt;
    }
  }

  return alternatives[0] || currentTitle;
}

export async function regenerateMeta(
  ctx: GenContext,
  currentMeta: string,
  keyword: string,
): Promise<string> {
  const prompt = `Generate 5 alternative meta descriptions that are ${META_MIN}-${META_MAX} characters and include the keyword "${keyword}".\n\nCurrent (${currentMeta.length} chars): "${currentMeta}"\n\nReturn as JSON: {"alternatives": ["meta 1", "meta 2", "meta 3", "meta 4", "meta 5"]}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: "You write SEO meta descriptions. Return only valid JSON." }, { role: "user", content: prompt }],
    { responseFormat: { type: "json_object" }, maxTokens: 1024 }
  );

  const data = robustJsonParse(res.content) as Record<string, string[]>;
  const alternatives: string[] = data.alternatives || [];

  for (const alt of alternatives) {
    if (alt.length >= META_MIN && alt.length <= META_MAX) return alt;
  }

  return alternatives[0] || currentMeta;
}

export async function regenerateIntroduction(
  ctx: GenContext,
  title: string,
  meta: string,
  keyword: string,
  wordTarget: number,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx.promptContext, STAGE_SYSTEM_PROMPTS.introduction);
  const userMsg = `Rewrite the introduction for this blog (target ${wordTarget} words). WordPress block format. Return as JSON: {"intro": "..."}.\n\nTitle: ${title}\nMeta: ${meta}\nKeyword: ${keyword}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
    { responseFormat: { type: "json_object" }, maxTokens: 4096 }
  );

  return (robustJsonParse(res.content) as Record<string, string>).intro || "";
}

export async function regenerateSection(
  ctx: GenContext,
  title: string,
  heading: string,
  prevHeading: string,
  nextHeading: string,
  wordTarget: number,
  keyphraseTarget: number,
  keyphrase: string,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx.promptContext, STAGE_SYSTEM_PROMPTS.section);
  const sectionResearchPrompt = ctx.promptContext.research?.length
    ? `\n\nREFERENCE SOURCES (use these URLs when referencing claims — cite with descriptive anchor text like "According to [Source Name]..." and link to the URL):\n${ctx.promptContext.research.map((r: any) => `- ${r.title || "Source"}: ${r.url || ""}`).join("\n")}`
    : "";
  const userMsg = `Return section BODY content only. Do NOT return the H2 heading. Start directly with a paragraph or list. The application will insert the heading.\n\nSection heading for context only (do NOT repeat):\n"${heading}"\n\nRewrite the body content for this section. Target exactly ${wordTarget} words. Include the keyphrase "${keyphrase}" naturally (target ${keyphraseTarget} across full article). WordPress block format.\n\nArticle title: ${title}\nPrevious heading: ${prevHeading}\nNext heading: ${nextHeading}\n\nGUIDANCE:\n- Do NOT repeat statistics, examples, or explanations from other sections.\n- Focus exclusively on the content for THIS heading.${sectionResearchPrompt}\n\nReturn as JSON: {"body": "..."}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
    { responseFormat: { type: "json_object" }, maxTokens: 8192 }
  );

  const raw = (robustJsonParse(res.content) as Record<string, string>).body || "";
  const clean = raw
    .replace(/<!--\s*wp:heading\s*\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi, "")
    .replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, "");
  if (clean !== raw) console.log(`[component-regenerator:SANITIZE] Removed leaked H2 from regenerated section`);
  return clean;
}

export async function regenerateFAQ(
  ctx: GenContext,
  title: string,
  contentSummary: string,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx.promptContext, STAGE_SYSTEM_PROMPTS.faq);
  const userMsg = `Regenerate the FAQ section. 4-6 questions. WordPress block format with FAQ schema. Return as JSON: {"faqSchemaBlock": "..."}.\n\nTitle: ${title}\nContent: ${contentSummary.substring(0, 1500)}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
    { responseFormat: { type: "json_object" }, maxTokens: 8192 }
  );

  return (robustJsonParse(res.content) as Record<string, string>).faqSchemaBlock || "";
}

export async function regenerateConclusion(
  ctx: GenContext,
  title: string,
  wordTarget: number,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx.promptContext, STAGE_SYSTEM_PROMPTS.conclusion);
  const userMsg = `Rewrite the conclusion (target ${wordTarget} words). Include a CTA to create a B2I Hub profile. WordPress block format. Return as JSON: {"conclusion": "..."}.\n\nTitle: ${title}`;

  const res = await ctx.chatWithRetry(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
    { responseFormat: { type: "json_object" }, maxTokens: 4096 }
  );

  return (robustJsonParse(res.content) as Record<string, string>).conclusion || "";
}

// ── Main regeneration loop ──

export async function runComponentRegeneration(
  ctx: GenContext,
  generated: { title: string; metaDescription: string; blog: string },
  h2Headings: string[],
  keyphrase: string,
  wordTargets: { intro: number; conclusion: number; perSection: number; keyphraseTarget: number },
): Promise<{ blog: string; title: string; meta: string; warnings: string[]; logs: string[] }> {
  const MAX_RETRIES = 3;
  const warnings: string[] = [];
  const logs: string[] = [];
  const attempts = new Map<string, number>();

  function log(msg: string) {
    console.log(`[REGENERATE] ${msg}`);
    logs.push(msg);
  }

  let currentTitle = generated.title;
  let currentMeta = generated.metaDescription;
  let currentBlog = generated.blog;

  for (let round = 0; round < MAX_RETRIES; round++) {
    const failures = validateComponents(currentBlog, currentTitle, currentMeta, keyphrase);

    if (failures.length === 0) {
      log("All checks passed");
      break;
    }

    // Group failures by component, skip exhausted ones
    const actionable = failures.filter((f) => (attempts.get(f.component) ?? 0) < MAX_RETRIES);

    if (actionable.length === 0) {
      for (const f of failures) {
        warnings.push(`${f.component}: ${f.reason} (target: ${f.target}, actual: ${f.actual})`);
      }
      log(`All components exhausted — returning with ${warnings.length} warning(s)`);
      break;
    }

    // Process one failure at a time (regenerating multiple could cascade)
    const failure = actionable[0];
    const attempt = (attempts.get(failure.component) ?? 0) + 1;
    attempts.set(failure.component, attempt);

    log(`${failure.component} — retry ${attempt}/${MAX_RETRIES} (${failure.reason})`);

    try {
      switch (true) {
        case failure.component === "title": {
          currentTitle = await regenerateTitle(ctx, currentTitle, keyphrase);
          break;
        }
        case failure.component === "meta": {
          currentMeta = await regenerateMeta(ctx, currentMeta, keyphrase);
          break;
        }
        case failure.component.startsWith("section:"): {
          const secIdx = parseInt(failure.component.split(":")[1]);
          const sections = extractSectionsSimple(currentBlog);
          if (secIdx >= 0 && secIdx < sections.length) {
            const s = sections[secIdx];
            const prevH = secIdx > 0 ? sections[secIdx - 1].headingText : "none";
            const nextH = secIdx < sections.length - 1 ? sections[secIdx + 1].headingText : "none";
            const newBody = await regenerateSection(ctx, currentTitle, s.headingText, prevH, nextH, wordTargets.perSection, wordTargets.keyphraseTarget, keyphrase);
            currentBlog = replaceSectionInBlog(currentBlog, secIdx, newBody);
          }
          break;
        }
        case failure.component === "density": {
          // Full-article density issue without specific section — regenerate introduction
          const newIntro = await regenerateIntroduction(ctx, currentTitle, currentMeta, keyphrase, wordTargets.intro);
          const sections = extractSectionsSimple(currentBlog);
          if (sections.length > 0) {
            currentBlog = currentBlog.substring(0, sections[0].start) + newIntro + currentBlog.substring(sections[0].start);
          }
          break;
        }
        case failure.component === "readability": {
          // Full-article readability issue — regenerate worst sections
          const sections = extractSectionsSimple(currentBlog);
          const scored = sections
            .filter((s) => cleanBodyText(s.bodyText).length > 40)
            .map((s) => ({ index: s.index, score: Math.round(fleschOnText(s.bodyText)) }))
            .sort((a, b) => a.score - b.score);
          if (scored.length > 0) {
            const worst = scored[0];
            const s = sections[worst.index];
            const prevH = worst.index > 0 ? sections[worst.index - 1].headingText : "none";
            const nextH = worst.index < sections.length - 1 ? sections[worst.index + 1].headingText : "none";
            const newBody = await regenerateSection(ctx, currentTitle, s.headingText, prevH, nextH, Math.round(wordTargets.perSection * 1.3), wordTargets.keyphraseTarget, keyphrase);
            currentBlog = replaceSectionInBlog(currentBlog, worst.index, newBody);
          }
          break;
        }
      }
      log(`${failure.component} — regenerated`);
    } catch (err) {
      log(`${failure.component} — ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Final validation — gather remaining warnings
  const finalFailures = validateComponents(currentBlog, currentTitle, currentMeta, keyphrase);
  for (const f of finalFailures) {
    warnings.push(`${f.component}: ${f.reason} (target: ${f.target}, actual: ${f.actual})`);
  }

  if (warnings.length > 0) {
    log(`Complete with ${warnings.length} warning(s): ${warnings.join("; ")}`);
  } else {
    log("Complete — all checks passed");
  }

  return { blog: currentBlog, title: currentTitle, meta: currentMeta, warnings, logs };
}
