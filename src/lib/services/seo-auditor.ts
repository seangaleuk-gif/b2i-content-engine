import { countReadableWords, countLongParagraphs, countChineseCharacters, chineseCharRange } from "./text-utils";
import { SEO_TITLE_MIN, SEO_TITLE_MAX, META_MIN, META_MAX, keyphraseRangeForWordCount, type KeyphraseRange, FLESCH_MIN, FLESCH_MAX, KEYPHRASE_DENSITY_MIN, KEYPHRASE_DENSITY_MAX, KEYPHRASE_DENSITY_PREFERRED, getKeyphraseContentWordCount, wordCountRange } from "./generation-constants";
import { extractVisibleFaqFromArticle } from "../blog/article-document";

export type AuditStatus = "pass" | "warning" | "fail" | "not_applicable";

export interface AuditCheck {
  id: string;
  label: string;
  score: number | null;
  status: AuditStatus;
  measuredValue: string;
  targetValue: string;
  explanation: string;
  category: string;
}

export interface AuditResult {
  overallScore: number;
  checks: AuditCheck[];
  summary: { passed: number; warnings: number; failed: number; notApplicable: number };
}

export interface AuditInput {
  title: string;
  metaDescription: string;
  keyword: string;
  blog: string;
  faq?: Array<{ question: string; answer: string }>;
  targetWordCount: number;
  targetKeyphraseCount: number;
}

// ── Canonical text extraction ──

function extractReadableText(html: string): string {
  return html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractH2Texts(html: string): string[] {
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const texts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(html)) !== null) {
    texts.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return texts;
}

// ── Canonical text extraction ──

function countExactPhrase(text: string, phrase: string): number {
  if (!phrase) return 0;
  const lower = text.toLowerCase();
  const target = phrase.toLowerCase().trim();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(target, pos)) !== -1) {
    count++;
    pos += target.length;
  }
  return count;
}

// ── Helpers ──

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

function fleschScore(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (words.length === 0 || sentences.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
}

function closeVariant(phrase: string, heading: string): boolean {
  const p = phrase.toLowerCase().replace(/s\b/g, "").replace(/[^a-z0-9\s]/g, "").trim();
  const h = heading.toLowerCase().replace(/s\b/g, "").replace(/[^a-z0-9\s]/g, "").trim();
  if (!p || !h) return false;
  return h.includes(p) || p.includes(h);
}

// ── Category weights ──
const CATEGORY_WEIGHTS: Record<string, number> = {
  "SEO Fundamentals": 35,
  "Content & Keyphrase": 25,
  "Readability": 15,
  "Links": 10,
  "Structure & Schema": 10,
  "Images": 5,
};

// ── Density-aware keyphrase scoring ──

interface KeyphraseScore {
  score: number;
  status: "pass" | "warning" | "fail";
  message: string;
}

const DENSITY_DISPLAY_MAX = 1.5;
const KP_DENSITY_STUFFING = KEYPHRASE_DENSITY_MAX; // 3% — hard failure

function scoreKeyphraseCount(
  exactCount: number,
  range: KeyphraseRange,
  densityPct: number | null,
): KeyphraseScore {
  const densityHealthy = densityPct !== null && densityPct >= KEYPHRASE_DENSITY_MIN && densityPct <= DENSITY_DISPLAY_MAX;

  if (exactCount >= range.min && exactCount <= range.max) {
    return { score: 100, status: "pass", message: "The exact keyphrase usage is appropriate for the article length." };
  }

  const below = exactCount < range.min ? range.min - exactCount : 0;
  const above = exactCount > range.max ? exactCount - range.max : 0;
  const overshoot = Math.max(below, above);

  if (overshoot <= 2) {
    const direction = below > 0 ? "below" : "above";
    return {
      score: 80, status: "warning",
      message: `Keyphrase count is slightly ${direction} the recommended range of ${range.min}–${range.max}.`,
    };
  }

  if (overshoot <= 5) {
    const direction = below > 0
      ? "Use the exact keyphrase more naturally throughout the article."
      : "Reduce repeated use of the exact keyphrase slightly.";
    return {
      score: 60, status: "warning",
      message: `${direction} Recommended range: ${range.min}–${range.max} for this article length.`,
    };
  }

  // Far outside range, but density is healthy — warning, not failure
  if (densityHealthy) {
    const direction = below > 0
      ? "The exact phrase may be underused. Add it naturally in relevant sections."
      : "The exact phrase appears more often than the recommended count range, but its overall density is still within the healthy range. Consider replacing some repetitions with natural variations.";
    return {
      score: 60, status: "warning",
      message: `${direction} Recommended range: ${range.min}–${range.max} for this article length.`,
    };
  }

  // Far below range and density is low → fail
  if (below > 0) {
    return {
      score: 0, status: "fail",
      message: `The exact phrase may be underused. Add it naturally in relevant sections. Recommended: ${range.min}–${range.max} for this article length.`,
    };
  }

  // Far above range and density is excessive → fail
  return {
    score: 0, status: "fail",
    message: `The exact phrase is repeated too frequently. Reduce repetition to avoid over-optimisation. Recommended: ${range.min}–${range.max} for this article length.`,
  };
}

// ── Main audit ──

export function runAudit(input: AuditInput): AuditResult {
  const { title, metaDescription, keyword, blog, faq, targetWordCount, targetKeyphraseCount } = input;
  const checks: AuditCheck[] = [];
  const readableText = extractReadableText(blog);
  const readableWords = countReadableWords(blog);
  const keywordLower = keyword?.toLowerCase().trim() ?? "";
  const h2Texts = extractH2Texts(blog);

  const makeCheck = (
    id: string, label: string, score: number | null, status: AuditStatus,
    measuredValue: string, targetValue: string, explanation: string, category: string,
  ): AuditCheck => ({ id, label, score, status, measuredValue, targetValue, explanation, category });

  // ── SEO Fundamentals (35%) ──

  // 1. SEO Title Length
  const titleLen = title.length;
  if (titleLen >= SEO_TITLE_MIN && titleLen <= SEO_TITLE_MAX) {
    checks.push(makeCheck("title_length", "SEO Title Length", 100, "pass", `${titleLen} chars`, `${SEO_TITLE_MIN}-${SEO_TITLE_MAX}`, "Title length is within the recommended range.", "SEO Fundamentals"));
  } else if (titleLen > 0 && titleLen < SEO_TITLE_MIN) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${titleLen} chars`, `${SEO_TITLE_MIN}-${SEO_TITLE_MAX}`, "Title is too short. Add more descriptive words.", "SEO Fundamentals"));
  } else if (titleLen > SEO_TITLE_MAX) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${titleLen} chars`, `${SEO_TITLE_MIN}-${SEO_TITLE_MAX}`, "Title is too long. Google truncates titles over ~60 chars.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("title_length", "SEO Title Length", 0, "fail", "0 chars", `${SEO_TITLE_MIN}-${SEO_TITLE_MAX}`, "No SEO title found.", "SEO Fundamentals"));
  }

  // 2. Meta Description Length
  const metaLen = metaDescription.length;
  if (metaLen >= META_MIN && metaLen <= META_MAX) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 100, "pass", `${metaLen} chars`, `${META_MIN}-${META_MAX}`, "Meta description is within the recommended range.", "SEO Fundamentals"));
  } else if (metaLen > 0 && metaLen < META_MIN) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 40, "warning", `${metaLen} chars`, `${META_MIN}-${META_MAX}`, "Meta description is too short. Expand to include the keyphrase and a CTA.", "SEO Fundamentals"));
  } else if (metaLen > META_MAX) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 50, "warning", `${metaLen} chars`, `${META_MIN}-${META_MAX}`, "Meta description is too long. Google truncates at ~160 chars.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("meta_length", "Meta Description Length", 0, "fail", "0 chars", `${META_MIN}-${META_MAX}`, "No meta description found.", "SEO Fundamentals"));
  }

  // 3. Focus Keyphrase in SEO Title (was "in H1")
  if (keywordLower) {
    const inTitle = title.toLowerCase().includes(keywordLower);
    if (inTitle) {
      checks.push(makeCheck("keyphrase_title", "Focus Keyphrase in SEO Title", 100, "pass", `"${keyword}" found`, "Exact phrase in title", "The focus keyphrase appears in the SEO title.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("keyphrase_title", "Focus Keyphrase in SEO Title", 0, "fail", `"${keyword}" not found`, "Exact phrase in title", "The focus keyphrase is missing from the SEO title.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("keyphrase_title", "Focus Keyphrase in SEO Title", null, "not_applicable", "No keyphrase", "Exact phrase in title", "No focus keyphrase set for this project.", "SEO Fundamentals"));
  }

  // 4. Body Word Count — uses tolerance range matching the generation pipeline
  // (±10% below 2000, ±15% at 2000+)
  if (targetWordCount > 0) {
    const { min: wcMin, max: wcMax } = wordCountRange(targetWordCount);
    const targetLabel = `${wcMin.toLocaleString()}–${wcMax.toLocaleString()}`;
    if (readableWords >= wcMin && readableWords <= wcMax) {
      checks.push(makeCheck("word_count", "Body Word Count", 100, "pass", `${readableWords.toLocaleString()} words`, targetLabel, "Word count is within the accepted tolerance range.", "SEO Fundamentals"));
    } else if (readableWords >= Math.floor(wcMin * 0.90) && readableWords <= Math.ceil(wcMax * 1.05)) {
      checks.push(makeCheck("word_count", "Body Word Count", 60, "warning", `${readableWords.toLocaleString()} words`, targetLabel, "Word count is slightly outside the tolerance range.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("word_count", "Body Word Count", 0, "fail", `${readableWords.toLocaleString()} words`, targetLabel, "Word count is significantly outside the tolerance range.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("word_count", "Body Word Count", null, "not_applicable", "No target", "N/A", "No target word count configured.", "SEO Fundamentals"));
  }

  // ── Content & Keyphrase (25%) ──

  // 5. Keyphrase in First 100 Words — soft warning per pipeline policy
  if (keywordLower) {
    const first100 = readableText.split(/\s+/).slice(0, 100).join(" ").toLowerCase();
    const inFirst100 = first100.includes(keywordLower);
    if (inFirst100) {
      checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", 100, "pass", "Found", "First 100 words", "The keyphrase appears early in the content.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", 60, "warning", "Not found", "First 100 words", "The keyphrase should appear within the first paragraph (quality target, not a hard requirement).", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", null, "not_applicable", "No keyphrase", "First 100 words", "", "Content & Keyphrase"));
  }

  // 6. Keyphrase in H2
  if (keywordLower) {
    const exactInH2 = h2Texts.some((h) => h.toLowerCase().includes(keywordLower));
    const closeInH2 = !exactInH2 && h2Texts.some((h) => closeVariant(keyword, h));
    const matchedHeading = h2Texts.find((h) => h.toLowerCase().includes(keywordLower)) ?? h2Texts.find((h) => closeVariant(keyword, h));
    if (exactInH2) {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 100, "pass", `"${matchedHeading}"`, "Exact phrase in H2", "The exact keyphrase appears in an H2 heading.", "Content & Keyphrase"));
    } else if (closeInH2) {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 60, "warning", `Close match: "${matchedHeading}"`, "Exact phrase in H2", "A close variant of the keyphrase was found in an H2, but not the exact phrase.", "Content & Keyphrase"));
    } else if (h2Texts.length > 0) {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 60, "warning", "Not found", "Exact phrase in H2", "The keyphrase is missing from all H2 headings (quality target, not a hard requirement).", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 60, "warning", "No H2 headings", "Exact phrase in H2", "No H2 headings found. Add H2s to structure your content.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", null, "not_applicable", "No keyphrase", "Exact phrase in H2", "", "Content & Keyphrase"));
  }

  // 7. Exact Keyphrase Count (separate from density)
  if (keywordLower) {
    const exactCount = countExactPhrase(readableText, keywordLower);
    const range = keyphraseRangeForWordCount(readableWords);
    const densityPct = readableWords > 0 ? (exactCount / readableWords) * 100 : null;
    const { score, status, message } = scoreKeyphraseCount(exactCount, range, densityPct);
    console.log(`[seo:audit:keyphrase] len=${keywordLower.length} count=${exactCount} range=${range.min}-${range.max} density=${densityPct?.toFixed(2)} score=${score} status=${status}`);
    checks.push(makeCheck(
      "keyphrase_count", "Exact Keyphrase Count",
      score, status,
      `${exactCount} occurrences`,
      `Recommended: ${range.min}–${range.max} for a ${readableWords.toLocaleString()}-word article`,
      message,
      "Content & Keyphrase",
    ));
  } else {
    checks.push(makeCheck("keyphrase_count", "Exact Keyphrase Count", null, "not_applicable", "No keyphrase", "Recommended range based on word count", "", "Content & Keyphrase"));
  }

  // 8. Keyphrase Density (percentage) — matches pipeline policy:
  //    <0.5% = soft warning, ~1% = preferred, >3% = hard stuffing failure
  if (keywordLower && readableWords > 0) {
    const exactCount = countExactPhrase(readableText, keywordLower);
    const kpWords = getKeyphraseContentWordCount(keywordLower);
    const densityPct = (exactCount * kpWords / readableWords) * 100;
    const densityStr = `${densityPct.toFixed(2)}%`;
    const targetStr = `${KEYPHRASE_DENSITY_MIN}%–${KEYPHRASE_DENSITY_PREFERRED}% (stuffing at ${KP_DENSITY_STUFFING}%)`;
    if (densityPct >= KEYPHRASE_DENSITY_MIN && densityPct <= DENSITY_DISPLAY_MAX) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 100, "pass", densityStr, targetStr, "Density is within the healthy range.", "Content & Keyphrase"));
    } else if (densityPct >= 0.3 && densityPct < KEYPHRASE_DENSITY_MIN) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is slightly below the minimum (soft SEO warning).", "Content & Keyphrase"));
    } else if (densityPct > DENSITY_DISPLAY_MAX && densityPct <= KP_DENSITY_STUFFING) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is above the preferred range but below stuffing threshold.", "Content & Keyphrase"));
    } else if (densityPct > KP_DENSITY_STUFFING) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Density exceeds the stuffing threshold (hard failure). Reduce keyphrase occurrences.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Density is critically low — keyphrase is nearly absent.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_density", "Keyphrase Density", null, "not_applicable", "N/A", `${KEYPHRASE_DENSITY_MIN}%–${DENSITY_DISPLAY_MAX}%`, "", "Content & Keyphrase"));
  }

  // ── Readability (15%) ──

  // 9. Paragraph Length
  // Uses countLongParagraphs — the same function as the post-save readback
  // and pipeline's paragraphs-final stage. Ensures audit UI matches actual enforcement.
  const totalParas = (blog.match(/<!--\s*wp:paragraph\s*-->/gi) ?? []).length;
  const longParas = countLongParagraphs(blog, 3);

  let paraScore: number;
  let paraStatus: AuditStatus;
  let paraMsg: string;

  // Long paragraphs are a SOFT warning per pipeline policy — never a hard failure.
  if (longParas === 0) {
    paraScore = 100;
    paraStatus = "pass";
    paraMsg = "All analysed paragraphs stay within the recommended sentence limit.";
  } else if (longParas <= 2) {
    paraScore = 80;
    paraStatus = "warning";
    paraMsg = `${longParas} paragraph(s) contain more than 3 sentences. Consider splitting longer paragraphs into shorter sections to improve readability on desktop and mobile.`;
  } else if (longParas <= 5) {
    paraScore = 60;
    paraStatus = "warning";
    paraMsg = `${longParas} paragraphs exceed 3 sentences. Breaking these into shorter blocks will help readers scan the content more easily.`;
  } else {
    paraScore = 60;
    paraStatus = "warning";
    paraMsg = `${longParas} of ${totalParas} paragraphs exceed 3 sentences. This makes the article difficult to scan. Split longer paragraphs into shorter sections.`;
  }

  checks.push(makeCheck(
    "paragraph_length", "Paragraph Length",
    paraScore, paraStatus,
    `${totalParas} paragraphs analysed`,
    "Max 3 sentences per paragraph",
    `${totalParas} paragraphs analysed. ${longParas === 0 ? "All within the sentence limit." : `${longParas} paragraph(s) contain more than 3 sentences.`} ${paraMsg}`,
    "Readability",
  ));

  // 10. Reading Level
  const fs = fleschScore(readableText);
  const fsRounded = Math.round(fs);
  if (fsRounded >= FLESCH_MIN && fsRounded <= FLESCH_MAX) {
    checks.push(makeCheck("reading_level", "Reading Level", 100, "pass", `Flesch ${fsRounded}`, `${FLESCH_MIN}-${FLESCH_MAX}`, "Reading ease is within the target range.", "Readability"));
  } else if ((fsRounded >= FLESCH_MIN - 10 && fsRounded < FLESCH_MIN) || (fsRounded > FLESCH_MAX && fsRounded <= FLESCH_MAX + 10)) {
    checks.push(makeCheck("reading_level", "Reading Level", 50, "warning", `Flesch ${fsRounded}`, `${FLESCH_MIN}-${FLESCH_MAX}`, "Reading ease is slightly outside the target range.", "Readability"));
  } else {
    checks.push(makeCheck("reading_level", "Reading Level", 0, "fail", `Flesch ${fsRounded}`, `${FLESCH_MIN}-${FLESCH_MAX}`, fsRounded < FLESCH_MIN ? "Text is too complex. Simplify sentences and use shorter words." : "Text is too simple for the target audience.", "Readability"));
  }

  // ── Links (10%) ──

  // 11. Internal Links
  const wpHtmlRanges: [number, number][] = [];
  let wm: RegExpExecArray | null;
  const wpHtmlRegex = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  while ((wm = wpHtmlRegex.exec(blog)) !== null) wpHtmlRanges.push([wm.index, wm.index + wm[0].length]);
  const scriptRegex = /<script[\s\S]*?<\/script>/gi;
  while ((wm = scriptRegex.exec(blog)) !== null) wpHtmlRanges.push([wm.index, wm.index + wm[0].length]);

  const uniqueInternal = new Set<string>();
  let linksInHeadings = 0;
  let linksSplittingKeyphrase = 0;
  const linkRegex = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRegex.exec(blog)) !== null) {
    const href = lm[1];
    const pos = lm.index;
    if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue;
    if (href.startsWith("/blog/")) {
      uniqueInternal.add(href);
    }
    // Check if link is inside a heading
    const before = blog.substring(0, pos);
    const afterH2 = before.lastIndexOf("<h2");
    const afterCloseH2 = before.lastIndexOf("</h2>");
    if (afterH2 > afterCloseH2) linksInHeadings++;
    // Check if link splits exact keyphrase
    if (keywordLower) {
      const tagText = lm[0].replace(/<[^>]+>/g, "");
      const fullMatch = `${tagText}${blog.substring(lm.index + lm[0].length, lm.index + lm[0].length + 50)}`;
      if (keywordLower.split(/\s+/).some((w) => tagText.toLowerCase().includes(w) && !fullMatch.toLowerCase().includes(keywordLower))) {
        linksSplittingKeyphrase++;
      }
    }
  }
  const intLinkCount = uniqueInternal.size;
  if (intLinkCount >= 0 && intLinkCount <= 4) {
    checks.push(makeCheck("internal_links", "Internal Links", 100, "pass", `${intLinkCount} unique`, "0–4", "Internal link count is within the accepted range.", "Links"));
  } else {
    checks.push(makeCheck("internal_links", "Internal Links", 0, "fail", `${intLinkCount} unique`, "0–4", "More than 4 unique internal links — exceeds the maximum (hard failure).", "Links"));
  }

  // 12. External Links
  const externalSet = new Set<string>();
  let lm2: RegExpExecArray | null;
  while ((lm2 = linkRegex.exec(blog)) !== null) {
    const href = lm2[1];
    const pos = lm2.index;
    if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue;
    if (href.startsWith("http")) externalSet.add(href);
  }
  const extLinkCount = externalSet.size;
  if (extLinkCount > 0) {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", `${extLinkCount} unique`, "0+ accepted", "External links are present — this supports editorial credibility.", "Links"));
  } else {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", "0 unique", "0+ accepted", "No external links found — 0 is acceptable per policy.", "Links"));
  }

  // ── Structure & Schema (10%) ──

  // 13. FAQ Schema
  const scriptMatches = blog.match(/<script\s[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  let schemaValid = false;
  for (const scriptBlock of scriptMatches) {
    try {
      const jsonStr = scriptBlock.replace(/<script[^>]*>/, "").replace(/<\/script>/, "");
      const parsed = JSON.parse(jsonStr);
      if (parsed["@type"] === "FAQPage" && Array.isArray(parsed.mainEntity) && parsed.mainEntity.length > 0) {
        schemaValid = true;
        break;
      }
    } catch { /* invalid JSON */ }
  }
  if (schemaValid) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 100, "pass", "Valid FAQPage JSON-LD", "FAQPage schema", "Valid FAQPage structured data found.", "Structure & Schema"));
  } else if (scriptMatches.length > 0) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 50, "warning", "JSON-LD found, no FAQPage", "FAQPage schema", "JSON-LD exists but no valid FAQPage schema detected.", "Structure & Schema"));
  } else {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", "Not found", "FAQPage schema", "No JSON-LD FAQPage schema found.", "Structure & Schema"));
  }

  // ── Images (5%) ──

  // 14. Image Alt Text
  const imgMatches = blog.match(/<img[^>]*>/gi) ?? [];
  const imgsWithAlt = imgMatches.filter((img) => /alt=["'][^"']*["']/i.test(img) && !/alt=["']\s*["']/i.test(img));
  if (imgMatches.length === 0) {
    checks.push(makeCheck("image_alt", "Image Alt Text", null, "not_applicable", "No images", "Descriptive alt text", "No images found in the content.", "Images"));
  } else if (imgsWithAlt.length === imgMatches.length) {
    checks.push(makeCheck("image_alt", "Image Alt Text", 100, "pass", `${imgMatches.length} with alt`, "All images have alt text", "All images have descriptive alt text.", "Images"));
  } else {
    const missing = imgMatches.length - imgsWithAlt.length;
    checks.push(makeCheck("image_alt", "Image Alt Text", 0, "fail", `${missing}/${imgMatches.length} missing`, "All images have alt text", `${missing} image(s) are missing alt text.`, "Images"));
  }

  // ── Weighted scoring ──
  let weightedSum = 0;
  let applicableWeight = 0;
  const categoryScores = new Map<string, { sum: number; weight: number; count: number }>();

  for (const check of checks) {
    if (!categoryScores.has(check.category)) {
      categoryScores.set(check.category, { sum: 0, weight: CATEGORY_WEIGHTS[check.category] ?? 10, count: 0 });
    }
    const cs = categoryScores.get(check.category)!;
    if (check.status !== "not_applicable" && check.score !== null) {
      cs.sum += check.score;
      cs.count++;
    }
  }

  for (const [cat, cs] of categoryScores) {
    const catWeight = CATEGORY_WEIGHTS[cat] ?? 10;
    if (cs.count > 0) {
      const avg = cs.sum / cs.count;
      weightedSum += (avg / 100) * catWeight;
      applicableWeight += catWeight;
    }
  }

  // Redistribute not_applicable category weight
  const naCategories = [...categoryScores.entries()].filter(([_, cs]) => cs.count === 0);
  if (naCategories.length > 0 && applicableWeight > 0) {
    const naWeight = naCategories.reduce((s, [cat]) => s + (CATEGORY_WEIGHTS[cat] ?? 10), 0);
    const redistributionFactor = 1 + naWeight / applicableWeight;
    weightedSum *= redistributionFactor;
  }

  const overallScore = applicableWeight > 0 ? Math.round(weightedSum) : 0;

  return {
    overallScore,
    checks,
    summary: {
      passed: checks.filter((c) => c.status === "pass").length,
      warnings: checks.filter((c) => c.status === "warning").length,
      failed: checks.filter((c) => c.status === "fail").length,
      notApplicable: checks.filter((c) => c.status === "not_applicable").length,
    },
  };
}

// ── Traditional Chinese SEO audit ──
// Shares the same scoring framework as runAudit() with Chinese-specific rules.

export interface ChineseAuditInput {
  title: string;
  metaDescription: string;
  keyword: string;
  blog: string;
  faq?: Array<{ question: string; answer: string }>;
  englishWordCount: number;
}

export function runChineseAudit(input: ChineseAuditInput): AuditResult {
  const { title, metaDescription, keyword, blog, faq, englishWordCount } = input;
  const checks: AuditCheck[] = [];
  const keywordLower = keyword?.toLowerCase().trim() ?? "";
  const keywordHasCjk = /[\u4e00-\u9fff]/.test(keywordLower);
  const h2Texts = extractH2Texts(blog);
  const zhCharCount = countChineseCharacters(blog);
  const zhRange = chineseCharRange(englishWordCount);

  const makeCheck = (id: string, label: string, score: number | null, status: AuditStatus, measuredValue: string, targetValue: string, explanation: string, category: string): AuditCheck => ({ id, label, score, status, measuredValue, targetValue, explanation, category });

  // 1. SEO Title Length — Chinese range: 25–35 visible Chinese characters
  const titleLen = title.length;
  const ZH_TITLE_MIN = 25;
  const ZH_TITLE_MAX = 35;
  if (titleLen >= ZH_TITLE_MIN && titleLen <= ZH_TITLE_MAX) {
    checks.push(makeCheck("title_length", "SEO Title Length", 100, "pass", `${titleLen} chars`, `${ZH_TITLE_MIN}–${ZH_TITLE_MAX}`, "Title length is within the recommended Chinese range.", "SEO Fundamentals"));
  } else if (titleLen >= 20 && titleLen < ZH_TITLE_MIN) {
    checks.push(makeCheck("title_length", "SEO Title Length", 90, "warning", `${titleLen} chars`, `${ZH_TITLE_MIN}–${ZH_TITLE_MAX}`, "Title is slightly short for Chinese content.", "SEO Fundamentals"));
  } else if (titleLen > ZH_TITLE_MAX && titleLen <= 40) {
    checks.push(makeCheck("title_length", "SEO Title Length", 90, "warning", `${titleLen} chars`, `${ZH_TITLE_MIN}–${ZH_TITLE_MAX}`, "Title is slightly long for Chinese SEO.", "SEO Fundamentals"));
  } else if (titleLen > 0 && titleLen < 20) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${titleLen} chars`, `${ZH_TITLE_MIN}–${ZH_TITLE_MAX}`, "Title is too short for Chinese content.", "SEO Fundamentals"));
  } else if (titleLen > 40) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${titleLen} chars`, `${ZH_TITLE_MIN}–${ZH_TITLE_MAX}`, "Title is too long for Chinese SEO.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("title_length", "SEO Title Length", 0, "fail", "0 chars", `${ZH_TITLE_MIN}–${ZH_TITLE_MAX}`, "No SEO title found.", "SEO Fundamentals"));
  }

  // 2. Meta Description Length — Chinese range: 80–120 visible Chinese characters
  const metaLen = metaDescription.length;
  const ZH_META_MIN = 80;
  const ZH_META_MAX = 120;
  if (metaLen >= ZH_META_MIN && metaLen <= ZH_META_MAX) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 100, "pass", `${metaLen} chars`, `${ZH_META_MIN}–${ZH_META_MAX}`, "Meta description is within the recommended Chinese range.", "SEO Fundamentals"));
  } else if (metaLen >= 60 && metaLen < ZH_META_MIN) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 90, "warning", `${metaLen} chars`, `${ZH_META_MIN}–${ZH_META_MAX}`, "Meta description is slightly short for Chinese content.", "SEO Fundamentals"));
  } else if (metaLen > ZH_META_MAX && metaLen <= 140) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 90, "warning", `${metaLen} chars`, `${ZH_META_MIN}–${ZH_META_MAX}`, "Meta description is slightly long for Chinese SEO.", "SEO Fundamentals"));
  } else if (metaLen > 0 && metaLen < 60) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 40, "warning", `${metaLen} chars`, `${ZH_META_MIN}–${ZH_META_MAX}`, "Meta description is too short for Chinese content.", "SEO Fundamentals"));
  } else if (metaLen > 140) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 50, "warning", `${metaLen} chars`, `${ZH_META_MIN}–${ZH_META_MAX}`, "Meta description is too long for Chinese SEO.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("meta_length", "Meta Description Length", 0, "fail", "0 chars", `${ZH_META_MIN}–${ZH_META_MAX}`, "No meta description found.", "SEO Fundamentals"));
  }

  // 3. Focus Keyphrase in SEO Title
  if (!keywordHasCjk) {
    checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", null, "not_applicable", "No CJK keyword", "Exact phrase in title", "Keyword has no CJK characters — set a Chinese focus keyphrase for this project.", "SEO Fundamentals"));
  } else if (keywordLower) {
    const inTitle = title.toLowerCase().includes(keywordLower);
    if (inTitle) {
      checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", 100, "pass", `"${keyword}" found`, "Exact phrase in title", "The focus keyphrase appears in the SEO title.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", 0, "fail", `"${keyword}" not found`, "Exact phrase in title", "The focus keyphrase is missing from the SEO title.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", null, "not_applicable", "No keyphrase", "Exact phrase in title", "No focus keyphrase configured for this project.", "SEO Fundamentals"));
  }

  // 4. Body Character Count — Chinese char range
  if (englishWordCount > 0) {
    const rangeLabel = `${zhRange.min.toLocaleString()}–${zhRange.max.toLocaleString()} chars`;
    if (zhCharCount >= zhRange.min && zhCharCount <= zhRange.max) {
      checks.push(makeCheck("char_count", "Chinese Character Count", 100, "pass", `${zhCharCount.toLocaleString()} characters`, rangeLabel, "Character count is within the accepted tolerance range.", "SEO Fundamentals"));
    } else if (zhCharCount >= zhRange.hardMin && zhCharCount <= zhRange.max * 1.05) {
      checks.push(makeCheck("char_count", "Chinese Character Count", 60, "warning", `${zhCharCount.toLocaleString()} characters`, rangeLabel, "Character count is slightly outside the target range.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("char_count", "Chinese Character Count", 0, "fail", `${zhCharCount.toLocaleString()} characters`, rangeLabel, "Character count is significantly outside the target range.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("char_count", "Chinese Character Count", null, "not_applicable", "No target", "N/A", "No target word count configured.", "SEO Fundamentals"));
  }

  // 5. Keyphrase in First 200 Characters
  if (keywordHasCjk && keywordLower) {
    const readableText = extractReadableText(blog);
    const first200 = readableText.substring(0, 200).toLowerCase();
    const inFirst200 = first200.includes(keywordLower);
    if (inFirst200) {
      checks.push(makeCheck("keyphrase_first200", "Keyphrase in First 200 Characters", 100, "pass", "Found", "First 200 Chinese characters", "The keyphrase appears early in the content.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_first200", "Keyphrase in First 200 Characters", 60, "warning", "Not found", "First 200 Chinese characters", "The focus keyphrase should appear within the first 200 characters (quality target, not a hard requirement).", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_first200", "Keyphrase in First 200 Characters", null, "not_applicable", "No CJK keyword", "First 200 Chinese characters", "Keyword has no CJK characters — set a Chinese focus keyphrase for this project.", "Content & Keyphrase"));
  }

  // 6. Keyphrase in H2
  if (keywordHasCjk && keywordLower) {
    const exactInH2 = h2Texts.some((h) => h.toLowerCase().includes(keywordLower));
    const matchedHeading = h2Texts.find((h) => h.toLowerCase().includes(keywordLower)) ?? "";
    if (exactInH2) {
      checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", 100, "pass", `"${matchedHeading}"`, "Exact phrase in H2", "The exact keyphrase appears in an H2 heading.", "Content & Keyphrase"));
    } else if (h2Texts.length > 0) {
      checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", 60, "warning", "Not found", "Exact phrase in H2", "The keyphrase is missing from all H2 headings (quality target, not a hard requirement).", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", 60, "warning", "No H2 headings", "Exact phrase in H2", "No H2 headings found — add H2s to structure your content.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", null, "not_applicable", "No CJK keyword", "Exact phrase in H2", "Keyword has no CJK characters — set a Chinese focus keyphrase for this project.", "Content & Keyphrase"));
  }

  // 7. Keyphrase Occurrences (density-aware for Chinese)
  if (keywordHasCjk && keywordLower) {
    const readableText = extractReadableText(blog);
    const exactCount = countExactPhrase(readableText, keywordLower);
    const kpCharLen = [...keywordLower].filter((c) => c.charCodeAt(0) >= 0x4E00).length || keywordLower.length;
    const densityPct = zhCharCount > 0 ? (exactCount * kpCharLen / zhCharCount) * 100 : null;
    const densityHealthy = densityPct !== null && densityPct >= KEYPHRASE_DENSITY_MIN && densityPct <= DENSITY_DISPLAY_MAX;

    let kpScore: number;
    let kpStatus: AuditStatus;
    let kpMsg: string;

    if (densityHealthy) {
      kpScore = 100;
      kpStatus = "pass";
      kpMsg = `Keyphrase density is healthy (${densityPct!.toFixed(2)}%) for this article length.`;
    } else if (densityPct !== null && densityPct >= 0.3 && densityPct < KEYPHRASE_DENSITY_MIN) {
      kpScore = 60;
      kpStatus = "warning";
      kpMsg = `Keyphrase density is slightly low (${densityPct.toFixed(2)}%). Consider naturally increasing keyphrase frequency.`;
    } else if (densityPct !== null && densityPct > DENSITY_DISPLAY_MAX && densityPct <= KP_DENSITY_STUFFING) {
      kpScore = 60;
      kpStatus = "warning";
      kpMsg = `Keyphrase density is above the preferred range but below stuffing threshold (${densityPct.toFixed(2)}%). Consider using variations.`;
    } else if (densityPct !== null && densityPct > KP_DENSITY_STUFFING) {
      kpScore = 0;
      kpStatus = "fail";
      kpMsg = `Keyphrase density exceeds stuffing threshold (${densityPct.toFixed(2)}%) — hard failure. Reduce keyphrase occurrences.`;
    } else {
      kpScore = 0;
      kpStatus = "fail";
      kpMsg = "Keyphrase density is critically low — keyphrase is nearly absent.";
    }

    checks.push(makeCheck("keyphrase_count", "Keyphrase Occurrences", kpScore, kpStatus, `${exactCount} occurrences`, `Density ${KEYPHRASE_DENSITY_MIN}%–${DENSITY_DISPLAY_MAX}% (preferred ~${KEYPHRASE_DENSITY_PREFERRED}%, stuffing at ${KP_DENSITY_STUFFING}%)`, kpMsg, "Content & Keyphrase"));
  } else {
    checks.push(makeCheck("keyphrase_count", "Keyphrase Occurrences", null, "not_applicable", "No CJK keyword", "Density 0.5%–1.5%", "", "Content & Keyphrase"));
  }

  // 8. Keyphrase Density (weighted) — Chinese-adapted calculation
  if (keywordHasCjk && keywordLower && zhCharCount > 0) {
    const readableText = extractReadableText(blog);
    const exactCount = countExactPhrase(readableText, keywordLower);
    const cjkLen = [...keywordLower].filter((c) => c.charCodeAt(0) >= 0x4E00).length || keywordLower.length;
    const kpUnits = Math.max(2, Math.ceil(cjkLen / 2));
    const densityPct = (exactCount * kpUnits / zhCharCount) * 100;
    const densityStr = `${densityPct.toFixed(2)}%`;
    const targetStr = `${KEYPHRASE_DENSITY_MIN}%–${KEYPHRASE_DENSITY_PREFERRED}% (stuffing at ${KP_DENSITY_STUFFING}%)`;
    if (densityPct >= KEYPHRASE_DENSITY_MIN && densityPct <= DENSITY_DISPLAY_MAX) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 100, "pass", densityStr, targetStr, "Density is within the healthy range.", "Content & Keyphrase"));
    } else if (densityPct >= 0.3 && densityPct < KEYPHRASE_DENSITY_MIN) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is slightly below the minimum (soft warning).", "Content & Keyphrase"));
    } else if (densityPct > DENSITY_DISPLAY_MAX && densityPct <= KP_DENSITY_STUFFING) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is above the preferred range but below stuffing threshold.", "Content & Keyphrase"));
    } else if (densityPct > KP_DENSITY_STUFFING) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Density exceeds stuffing threshold (hard failure). Reduce keyphrase occurrences.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Density is critically low — keyphrase is nearly absent.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_density", "Keyphrase Density", null, "not_applicable", "N/A", `${KEYPHRASE_DENSITY_MIN}%–${DENSITY_DISPLAY_MAX}%`, "", "Content & Keyphrase"));
  }

  // 9. Paragraph Length
  const totalParas = (blog.match(/<!--\s*wp:paragraph\s*-->/gi) ?? []).length;
  const longParas = countLongParagraphs(blog, 3);
  let paraScore: number; let paraStatus: AuditStatus; let paraMsg: string;
  if (longParas === 0) { paraScore = 100; paraStatus = "pass"; paraMsg = "All paragraphs stay within the recommended sentence limit."; }
  else if (longParas <= 2) { paraScore = 80; paraStatus = "warning"; paraMsg = `${longParas} paragraph(s) contain more than 3 sentences. Consider splitting longer paragraphs.`; }
  else if (longParas <= 5) { paraScore = 60; paraStatus = "warning"; paraMsg = `${longParas} paragraphs exceed 3 sentences. Breaking these into shorter blocks improves readability.`; }
  else { paraScore = 60; paraStatus = "warning"; paraMsg = `${longParas} of ${totalParas} paragraphs exceed 3 sentences. Split longer paragraphs into shorter sections.`; }
  checks.push(makeCheck("paragraph_length", "Paragraph Length", paraScore, paraStatus, `${totalParas} paragraphs analysed`, "Max 3 sentences per paragraph", `${totalParas} paragraphs analysed. ${longParas === 0 ? "All within the sentence limit." : `${longParas} paragraph(s) contain more than 3 sentences.`} ${paraMsg}`, "Readability"));

  // 10. Reading Level — N/A for Chinese (excluded from scoring)
  checks.push(makeCheck("reading_level", "Reading Level", null, "not_applicable", "N/A (Chinese content)", "N/A", "Flesch reading score does not apply to Chinese content.", "Readability"));

  // 11. Internal Links
  const wpHtmlRanges: [number, number][] = [];
  let wm3: RegExpExecArray | null;
  const wpHtmlRegex3 = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  while ((wm3 = wpHtmlRegex3.exec(blog)) !== null) wpHtmlRanges.push([wm3.index, wm3.index + wm3[0].length]);
  const scriptRegex3 = /<script[\s\S]*?<\/script>/gi;
  while ((wm3 = scriptRegex3.exec(blog)) !== null) wpHtmlRanges.push([wm3.index, wm3.index + wm3[0].length]);
  const uniqueInternal3 = new Set<string>();
  const linkRegex3 = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let lm3: RegExpExecArray | null;
  while ((lm3 = linkRegex3.exec(blog)) !== null) { const href = lm3[1]; const pos = lm3.index; if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue; if (href.startsWith("/blog/")) uniqueInternal3.add(href); }
  const intLinkCount3 = uniqueInternal3.size;
  if (intLinkCount3 >= 0 && intLinkCount3 <= 4) {
    checks.push(makeCheck("internal_links", "Internal Links", 100, "pass", `${intLinkCount3} unique`, "0–4", "Internal link count is within the accepted range.", "Links"));
  } else {
    checks.push(makeCheck("internal_links", "Internal Links", 0, "fail", `${intLinkCount3} unique`, "0–4", "More than 4 unique internal links — exceeds the maximum (hard failure).", "Links"));
  }

  // 12. External Links
  const externalSet3 = new Set<string>();
  let lm4: RegExpExecArray | null;
  while ((lm4 = linkRegex3.exec(blog)) !== null) { const href = lm4[1]; const pos = lm4.index; if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue; if (href.startsWith("http")) externalSet3.add(href); }
  const extLinkCount3 = externalSet3.size;
  if (extLinkCount3 > 0) {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", `${extLinkCount3} unique`, "0+ accepted", "External links are present — supports editorial credibility.", "Links"));
  } else {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", "0 unique", "0+ accepted", "No external links found — 0 is acceptable per policy.", "Links"));
  }

  // 13. FAQ Schema — Chinese-only: audit only the LAST FAQPage JSON-LD block
  // (the Chinese schema, inserted after CTA). Reject empty answers and enforce
  // exact parity with the visible Chinese FAQ content.
  const scriptMatches3 = blog.match(/<script\s[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  let chineseFaqValid = false;
  let chineseFaqIssues: string[] = [];
  const allScripts = scriptMatches3.map((s) => {
    try { const jsonStr = s.replace(/<script[^>]*>/, "").replace(/<\/script>/, ""); return JSON.parse(jsonStr); } catch { return null; }
  }).filter(Boolean);
  // Find ALL FAQPage blocks, then pick the LAST one (Chinese, after CTA)
  const faqPages = allScripts.filter((p: any) => p?.["@type"] === "FAQPage" && Array.isArray(p?.mainEntity));
  if (faqPages.length > 0) {
    const lastFaqPage = faqPages[faqPages.length - 1] as any;
    const entities = lastFaqPage.mainEntity as Array<any>;
    // Check for empty answers
    const emptyAnswers = entities.filter((e: any) => !e.acceptedAnswer?.text?.trim());
    if (emptyAnswers.length > 0) {
      chineseFaqIssues.push(`${emptyAnswers.length} FAQ entr${emptyAnswers.length === 1 ? 'y has' : 'ies have'} empty acceptedAnswer.text`);
    }
    // Check parity: visible Chinese FAQ count should match schema question count
    const zhVisibleFaq = extractVisibleFaqFromArticle(blog);
    if (zhVisibleFaq.length > 0) {
      const schemaQuestionCount = entities.length;
      if (zhVisibleFaq.length !== schemaQuestionCount) {
        chineseFaqIssues.push(`Visible FAQ count (${zhVisibleFaq.length}) differs from schema question count (${schemaQuestionCount})`);
      } else {
        // Check exact Q&A match (normalizing whitespace and punctuation spacing)
        for (let i = 0; i < zhVisibleFaq.length; i++) {
          const norm = (s: string) => s.replace(/\s+/g, " ").replace(/\s*([,、。？！，])/g, "$1").trim();
          const vQ = norm(zhVisibleFaq[i].question);
          const sQ = norm(entities[i].name || "");
          const vA = norm(zhVisibleFaq[i].answerText);
          const sA = norm(entities[i].acceptedAnswer?.text || "");
          if (vQ !== sQ) { chineseFaqIssues.push(`FAQ #${i+1} question mismatch: visible="${vQ}" vs schema="${sQ}"`); }
          if (vA !== sA) { chineseFaqIssues.push(`FAQ #${i+1} answer mismatch: visible="${vA.substring(0, 40)}..." vs schema="${sA.substring(0, 40)}..."`); }
        }
      }
    }
    chineseFaqValid = chineseFaqIssues.length === 0;
  }

  if (chineseFaqValid) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 100, "pass", "Valid Chinese FAQPage JSON-LD", "FAQPage schema", `Valid Chinese FAQPage structured data with ${faqPages[faqPages.length - 1].mainEntity.length} entries.`, "Structure & Schema"));
  } else if (faqPages.length > 0) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", `Chinese FAQ issues: ${chineseFaqIssues.join("; ")}`, "FAQPage schema", chineseFaqIssues.join(". "), "Structure & Schema"));
  } else {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", "No Chinese FAQPage JSON-LD found", "FAQPage schema", "No FAQPage schema found in the Chinese article.", "Structure & Schema"));
  }

  // ── Weighted scoring ──
  let weightedSum = 0;
  let applicableWeight = 0;
  const categoryScores = new Map<string, { sum: number; weight: number; count: number }>();
  for (const check of checks) {
    if (!categoryScores.has(check.category)) { categoryScores.set(check.category, { sum: 0, weight: CATEGORY_WEIGHTS[check.category] ?? 10, count: 0 }); }
    const cs = categoryScores.get(check.category)!;
    if (check.status !== "not_applicable" && check.score !== null) { cs.sum += check.score; cs.count++; }
  }
  for (const [cat, cs] of categoryScores) {
    const catWeight = CATEGORY_WEIGHTS[cat] ?? 10;
    if (cs.count > 0) { const avg = cs.sum / cs.count; weightedSum += (avg / 100) * catWeight; applicableWeight += catWeight; }
  }
  const naCategories = [...categoryScores.entries()].filter(([_, cs]) => cs.count === 0);
  if (naCategories.length > 0 && applicableWeight > 0) {
    const naWeight = naCategories.reduce((s, [cat]) => s + (CATEGORY_WEIGHTS[cat] ?? 10), 0);
    weightedSum *= (1 + naWeight / applicableWeight);
  }
  const overallScore = applicableWeight > 0 ? Math.round(weightedSum) : 0;

  return {
    overallScore,
    checks,
    summary: {
      passed: checks.filter((c) => c.status === "pass").length,
      warnings: checks.filter((c) => c.status === "warning").length,
      failed: checks.filter((c) => c.status === "fail").length,
      notApplicable: checks.filter((c) => c.status === "not_applicable").length,
    },
  };
}
