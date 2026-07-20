import { cleanBodyText, countWords } from "@/lib/services/text-utils";
import { SEO_TITLE_MIN, SEO_TITLE_MAX, META_MIN, META_MAX, KEYPHRASE_MIN, KEYPHRASE_MAX, FLESCH_MIN, FLESCH_MAX, DEFAULT_WORD_COUNT } from "@/lib/services/generation-constants";

// ── Types ──

export interface ScoreDetail {
  label: string;
  score: number;
  max: number;
  status: "pass" | "warning" | "fail";
  message: string;
}

export interface CategoryScore {
  score: number;
  max: number;
  details: ScoreDetail[];
}

export interface QualityScore {
  overall: number;
  seo: CategoryScore;
  readability: CategoryScore;
  structure: CategoryScore;
  formatting: CategoryScore;
  content: CategoryScore;
}

export interface GenerationReport {
  qualityScore: QualityScore;
  generationTimeMs: number;
  retryCount: number;
  jsonRepairs: number;
  componentRegenerations: number;
  warnings: string[];
  estimatedTokens: number;
  targetWordCount: number;
  actualWordCount: number;
}

// ── Helpers ──

function scoreInRange(value: number, min: number, max: number, maxScore: number, label: string): ScoreDetail {
  if (value >= min && value <= max) {
    return { label, score: maxScore, max: maxScore, status: "pass", message: `✓ ${label}: ${value} (target: ${min}-${max})` };
  }
  const distance = value < min ? min - value : value - max;
  const penalty = Math.min(maxScore, Math.ceil(distance / 5));
  const score = Math.max(0, maxScore - penalty);
  const direction = value < min ? "too low" : "too high";
  return { label, score, max: maxScore, status: score === 0 ? "fail" : "warning", message: `⚠ ${label}: ${value} — ${direction} (target: ${min}-${max})` };
}

function scoreMin(value: number, target: number, maxScore: number, label: string): ScoreDetail {
  if (value >= target) {
    return { label, score: maxScore, max: maxScore, status: "pass", message: `✓ ${label}: ${value} (target: ≥ ${target})` };
  }
  const ratio = value / target;
  const score = Math.max(0, Math.round(maxScore * ratio));
  return { label, score, max: maxScore, status: score < maxScore / 2 ? "fail" : "warning", message: `⚠ ${label}: ${value} — below target of ${target}` };
}

function scoreBoolean(condition: boolean, maxScore: number, label: string, passMsg: string, failMsg: string): ScoreDetail {
  return condition
    ? { label, score: maxScore, max: maxScore, status: "pass", message: `✓ ${passMsg}` }
    : { label, score: 0, max: maxScore, status: "fail", message: `✗ ${failMsg}` };
}

function scoreCountInRange(actual: number, min: number, max: number, maxScore: number, label: string): ScoreDetail {
  return scoreInRange(actual, min, max, maxScore, label);
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

function avgSentenceLength(text: string): number {
  const cleaned = cleanBodyText(text);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const sentences = cleaned.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences.length > 0 ? Math.round(words.length / sentences.length) : 0;
}

function countParagraphsWithExcessiveSentences(html: string): number {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "");
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = paraRegex.exec(cleaned)) !== null) {
    const text = cleanBodyText(match[1]);
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length > 3) count++;
  }
  return count;
}

// ── Scoring engine ──

export function scoreArticle(
  blog: string,
  title: string,
  metaDescription: string,
  keyword: string,
  targetWordCount: number,
  faqCount: number,
): QualityScore {
  const blogCleaned = cleanBodyText(blog);
  const actualWordCount = countWords(blog);
  const keywordLower = keyword.toLowerCase().trim();
  const fleshScore = Math.round(fleschOnText(blog));
  const avgSentLen = avgSentenceLength(blog);
  const longParagraphs = countParagraphsWithExcessiveSentences(blog);

  // ── SEO (30 points) ──
  const seoDetails: ScoreDetail[] = [];

  // Title length: 10 pts
  seoDetails.push(scoreInRange(title.length, SEO_TITLE_MIN, SEO_TITLE_MAX, 10, "Title length"));

  // Meta length: 10 pts
  seoDetails.push(scoreInRange(metaDescription.length, META_MIN, META_MAX, 10, "Meta description length"));

  // Keyphrase in H1: 5 pts
  const h1Match = blog.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const kpInH1 = h1Match ? cleanBodyText(h1Match[1]).toLowerCase().includes(keywordLower) : false;
  seoDetails.push(scoreBoolean(kpInH1, 5, "Keyphrase in H1", `Keyphrase found in H1`, `Keyphrase not found in H1: "${keyword}"`));

  // Keyphrase in first 100 words: 5 pts
  const first100 = blogCleaned.split(/\s+/).slice(0, 100).join(" ").toLowerCase();
  const kpInFirst100 = first100.includes(keywordLower);
  seoDetails.push(scoreBoolean(kpInFirst100, 5, "Keyphrase in first 100 words", `Keyphrase in opening`, `Keyphrase not in first 100 words`));

  const seoScore = seoDetails.reduce((s, d) => s + d.score, 0);

  // ── Readability (20 points) ──
  const readabilityDetails: ScoreDetail[] = [];

  // Flesch 60-70: 10 pts
  readabilityDetails.push(scoreInRange(fleshScore, FLESCH_MIN, FLESCH_MAX, 10, "Flesch Reading Ease"));

  // Sentence length ≤ 20 avg: 5 pts
  const slScore = avgSentLen <= 20 ? 5 : avgSentLen <= 25 ? 3 : avgSentLen <= 30 ? 1 : 0;
  readabilityDetails.push({
    label: "Avg sentence length",
    score: slScore,
    max: 5,
    status: slScore >= 4 ? "pass" : slScore >= 2 ? "warning" : "fail",
    message: `${slScore >= 4 ? "✓" : "⚠"} Avg sentence length: ${avgSentLen} words (target: ≤ 20)`,
  });

  // Paragraphs ≤ 3 sentences: 5 pts
  const paraScore = longParagraphs === 0 ? 5 : longParagraphs <= 2 ? 3 : 1;
  readabilityDetails.push({
    label: "Paragraph length",
    score: paraScore,
    max: 5,
    status: paraScore >= 4 ? "pass" : paraScore >= 2 ? "warning" : "fail",
    message: `${paraScore >= 4 ? "✓" : "⚠"} ${longParagraphs} paragraph(s) exceed 3 sentences`,
  });

  const readabilityScore = readabilityDetails.reduce((s, d) => s + d.score, 0);

  // ── Structure (20 points) ──
  const structureDetails: ScoreDetail[] = [];

  // H2 count 4-6: 5 pts
  const h2Count = (blog.match(/<h2[^>]*>/gi) || []).length;
  structureDetails.push(scoreCountInRange(h2Count, 4, 6, 5, "H2 sections"));

  // FAQ count 4-6: 5 pts
  structureDetails.push(scoreCountInRange(faqCount, 4, 6, 5, "FAQ questions"));

  // CTA present: 5 pts
  const ctaPresent = /B2I Hub/i.test(blog) && /signup/i.test(blog);
  structureDetails.push(scoreBoolean(ctaPresent, 5, "CTA block", "CTA block found", "CTA block missing — no B2I Hub signup link"));

  // Language switcher present: 5 pts
  const langSwitcher = /Read in|閱讀.*版/i.test(blog);
  structureDetails.push(scoreBoolean(langSwitcher, 5, "Language switcher", "Language switcher found", "Language switcher missing"));

  const structureScore = structureDetails.reduce((s, d) => s + d.score, 0);

  // ── Formatting (15 points) ──
  const formattingDetails: ScoreDetail[] = [];

  // No Markdown: 5 pts
  const hasMarkdown = /(?:^|\n)(?:#{1,6}\s|```|^\*\s|^- )/m.test(blog) || /(?<!!)\[(.*?)\]\(.*?\)/.test(blog);
  formattingDetails.push(scoreBoolean(!hasMarkdown, 5, "No Markdown", "No Markdown detected", "Markdown found in output — WordPress blocks only"));

  // WordPress blocks: 5 pts
  const wpBlocks = (blog.match(/<!--\s*wp:/g) || []).length;
  const wpScore = wpBlocks >= 10 ? 5 : wpBlocks >= 5 ? 3 : 1;
  formattingDetails.push({
    label: "WordPress blocks",
    score: wpScore,
    max: 5,
    status: wpScore >= 4 ? "pass" : "warning",
    message: `${wpScore >= 4 ? "✓" : "⚠"} ${wpBlocks} WordPress blocks found (target: ≥ 10)`,
  });

  // FAQ schema present: 5 pts
  const hasSchema = /<script\s[^>]*type="application\/ld\+json"[^>]*>/i.test(blog);
  formattingDetails.push(scoreBoolean(hasSchema, 5, "FAQ schema", "FAQPage JSON-LD found", "FAQ schema JSON-LD missing"));

  const formattingScore = formattingDetails.reduce((s, d) => s + d.score, 0);

  // ── Content (15 points) ──
  const contentDetails: ScoreDetail[] = [];

  // Word count ≥ target: 5 pts
  contentDetails.push(scoreMin(actualWordCount, targetWordCount, 5, "Word count"));

  // Keyphrase density 3-5: 5 pts
  const kpCount = keywordLower ? blogCleaned.toLowerCase().split(keywordLower).length - 1 : 0;
  contentDetails.push(scoreCountInRange(kpCount, KEYPHRASE_MIN, KEYPHRASE_MAX, 5, "Keyphrase density"));

  // External links 2-3: 5 pts
  const extLinks = (blog.match(/href="https?:\/\/(?!b2ihub\.com)[^"]*"/gi) || []).length;
  contentDetails.push(scoreCountInRange(extLinks, 2, 3, 5, "External links"));

  const contentScore = contentDetails.reduce((s, d) => s + d.score, 0);

  // ── Overall ──
  const total = seoScore + readabilityScore + structureScore + formattingScore + contentScore;
  const maxTotal = 30 + 20 + 20 + 15 + 15; // 100

  return {
    overall: Math.round((total / maxTotal) * 100),
    seo: { score: seoScore, max: 30, details: seoDetails },
    readability: { score: readabilityScore, max: 20, details: readabilityDetails },
    structure: { score: structureScore, max: 20, details: structureDetails },
    formatting: { score: formattingScore, max: 15, details: formattingDetails },
    content: { score: contentScore, max: 15, details: contentDetails },
  };
}

// ── Full report ──

export function buildGenerationReport(
  blog: string,
  title: string,
  metaDescription: string,
  keyword: string,
  targetWordCount: number,
  faqCount: number,
  generationTimeMs: number,
  retryCount: number,
  jsonRepairs: number,
  componentRegenerations: number,
  warnings: string[],
  estimatedTokens: number,
): GenerationReport {
  return {
    qualityScore: scoreArticle(blog, title, metaDescription, keyword, targetWordCount, faqCount),
    generationTimeMs,
    retryCount,
    jsonRepairs,
    componentRegenerations,
    warnings,
    estimatedTokens,
    targetWordCount,
    actualWordCount: countWords(blog),
  };
}

// ── Report formatting ──

export function formatReport(report: GenerationReport): string {
  const q = report.qualityScore;
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════");
  lines.push(`  QUALITY SCORE: ${q.overall}/100`);
  lines.push("═══════════════════════════════════════");

  const categories: [string, CategoryScore][] = [
    ["SEO", q.seo],
    ["Readability", q.readability],
    ["Structure", q.structure],
    ["Formatting", q.formatting],
    ["Content", q.content],
  ];

  for (const [name, cat] of categories) {
    lines.push(`\n  ${name} — ${cat.score}/${cat.max}`);
    for (const d of cat.details) {
      lines.push(`    ${d.message}`);
    }
  }

  lines.push(`\n  ─── Generation Stats ───`);
  lines.push(`  Time: ${(report.generationTimeMs / 1000).toFixed(1)}s`);
  lines.push(`  Words: ${report.actualWordCount} / ${report.targetWordCount} target`);
  lines.push(`  Retries: ${report.retryCount}`);
  lines.push(`  JSON repairs: ${report.jsonRepairs}`);
  lines.push(`  Component regenerations: ${report.componentRegenerations}`);
  lines.push(`  Est. tokens: ~${report.estimatedTokens.toLocaleString()}`);
  lines.push(`  Warnings: ${report.warnings.length}`);

  if (report.warnings.length > 0) {
    lines.push(`\n  ─── Warnings ───`);
    for (const w of report.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  }

  lines.push("\n═══════════════════════════════════════");
  return lines.join("\n");
}
