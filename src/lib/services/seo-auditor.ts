import { countReadableWords } from "./text-utils";
import { SEO_TITLE_MIN, SEO_TITLE_MAX, META_MIN, META_MAX, keyphraseRangeForWordCount, type KeyphraseRange, FLESCH_MIN, FLESCH_MAX } from "./generation-constants";

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

function extractParagraphTexts(html: string): string[] {
  const cleaned = html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const texts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = paraRegex.exec(cleaned)) !== null) {
    texts.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return texts;
}

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

function countSentences(paragraphText: string): number {
  // Split on English (. ! ?) and Chinese (。！？) sentence endings.
  // Handles mixed-language paragraphs correctly.
  const sentences = paragraphText.split(/[.!?。！？]+/).filter((s) => s.trim().length > 0);
  return sentences.length;
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

const DENSITY_MIN = 0.5;
const DENSITY_MAX = 1.5;

function scoreKeyphraseCount(
  exactCount: number,
  range: KeyphraseRange,
  densityPct: number | null,
): KeyphraseScore {
  const densityHealthy = densityPct !== null && densityPct >= DENSITY_MIN && densityPct <= DENSITY_MAX;

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
  const paraTexts = extractParagraphTexts(blog);

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

  // 4. Body Word Count
  if (targetWordCount > 0) {
    const wcRatio = readableWords / targetWordCount;
    if (wcRatio >= 1) {
      checks.push(makeCheck("word_count", "Body Word Count", 100, "pass", `${readableWords} words`, `≥ ${targetWordCount}`, "Meets or exceeds the target word count.", "SEO Fundamentals"));
    } else if (wcRatio >= 0.95) {
      checks.push(makeCheck("word_count", "Body Word Count", 60, "warning", `${readableWords} words`, `≥ ${targetWordCount}`, "Close to target but slightly under.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("word_count", "Body Word Count", 0, "fail", `${readableWords} words`, `≥ ${targetWordCount}`, "Significantly below the target word count.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("word_count", "Body Word Count", null, "not_applicable", "No target", "N/A", "No target word count configured.", "SEO Fundamentals"));
  }

  // ── Content & Keyphrase (25%) ──

  // 5. Keyphrase in First 100 Words
  if (keywordLower) {
    const first100 = readableText.split(/\s+/).slice(0, 100).join(" ").toLowerCase();
    const inFirst100 = first100.includes(keywordLower);
    if (inFirst100) {
      checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", 100, "pass", "Found", "First 100 words", "The keyphrase appears early in the content.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", 0, "fail", "Not found", "First 100 words", "The keyphrase should appear within the first paragraph.", "Content & Keyphrase"));
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
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 0, "fail", "Not found", "Exact phrase in H2", "The keyphrase is missing from all H2 headings.", "Content & Keyphrase"));
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

  // 8. Keyphrase Density (percentage) — uses same exactCount, recalculated for independence
  if (keywordLower && readableWords > 0) {
    const exactCount = countExactPhrase(readableText, keywordLower);
    const densityPct = (exactCount / readableWords) * 100;
    const densityStr = `${densityPct.toFixed(2)}%`;
    if (densityPct >= DENSITY_MIN && densityPct <= DENSITY_MAX) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 100, "pass", densityStr, "0.5%-1.5%", "Density is within the optimal range.", "Content & Keyphrase"));
    } else if (densityPct >= 0.3 && densityPct <= 2.0) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, "0.5%-1.5%", "Density is slightly outside the optimal range.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, "0.5%-1.5%", densityPct > 2 ? "Density is too high — possible keyword stuffing." : "Density is too low — keyphrase is nearly absent.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_density", "Keyphrase Density", null, "not_applicable", "N/A", "0.5%-1.5%", "", "Content & Keyphrase"));
  }

  // ── Readability (15%) ──

  // 9. Paragraph Length
  const paraSentenceCounts = paraTexts.map((t) => countSentences(t)).filter((c) => c > 0);
  const longParas = paraSentenceCounts.filter((c) => c > 3);
  const totalParas = paraSentenceCounts.length;

  let paraScore: number;
  let paraStatus: AuditStatus;
  let paraMsg: string;

  if (longParas.length === 0) {
    paraScore = 100;
    paraStatus = "pass";
    paraMsg = "All analysed paragraphs stay within the recommended sentence limit.";
  } else if (longParas.length <= 2) {
    paraScore = 80;
    paraStatus = "warning";
    paraMsg = `${longParas.length} paragraph(s) contain more than 3 sentences. Consider splitting longer paragraphs into shorter sections to improve readability on desktop and mobile.`;
  } else if (longParas.length <= 5) {
    paraScore = 60;
    paraStatus = "warning";
    paraMsg = `${longParas.length} paragraphs exceed 3 sentences. Breaking these into shorter blocks will help readers scan the content more easily.`;
  } else {
    paraScore = totalParas <= 5 ? 60 : 0;
    paraStatus = totalParas <= 5 ? "warning" : "fail";
    paraMsg = totalParas <= 5
      ? `Most paragraphs exceed 3 sentences, but the article is short enough that this may be acceptable.`
      : `${longParas.length} of ${totalParas} paragraphs exceed 3 sentences. This makes the article difficult to scan. Split longer paragraphs into shorter sections.`;
  }

  checks.push(makeCheck(
    "paragraph_length", "Paragraph Length",
    paraScore, paraStatus,
    `${totalParas} paragraphs analysed`,
    "Max 3 sentences per paragraph",
    `${totalParas} paragraphs analysed. ${longParas.length === 0 ? "All within the sentence limit." : `${longParas.length} paragraph(s) contain more than 3 sentences.`} ${paraMsg}`,
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
  if (intLinkCount >= 3 && intLinkCount <= 5) {
    checks.push(makeCheck("internal_links", "Internal Links", 100, "pass", `${intLinkCount} unique`, "3-5", "Optimal number of unique internal links.", "Links"));
  } else if (intLinkCount < 3) {
    checks.push(makeCheck("internal_links", "Internal Links", intLinkCount > 0 ? 50 : 0, "warning", `${intLinkCount} unique`, "3-5", "Add more internal links to relevant B2I Hub content.", "Links"));
  } else {
    checks.push(makeCheck("internal_links", "Internal Links", 70, "warning", `${intLinkCount} unique`, "3-5", "Too many internal links. Keep to 3-5 unique.", "Links"));
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
  if (extLinkCount >= 2) {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", `${extLinkCount} unique`, "≥ 2", "Sufficient authoritative external links.", "Links"));
  } else {
    checks.push(makeCheck("external_links", "External Links", extLinkCount > 0 ? 50 : 0, "warning", `${extLinkCount} unique`, "≥ 2", "Add 2-3 links to high-authority external sources.", "Links"));
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
