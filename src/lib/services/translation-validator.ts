// ── Number protection ──

import { createNumberExpressionRegex } from "./translation-number-grammar";

const NUMBER_PROTECT_RE = createNumberExpressionRegex();

export function protectNumbersInHtml(html: string): {
  protectedHtml: string;
  placeholders: string[];
  originalValues: string[];
} {
  const placeholders: string[] = [];
  const originalValues: string[] = [];
  let index = 0;
  const segments = html.split(/(<[^>]*>)/);
  const protectedSegments = segments.map((segment) => {
    if (segment.startsWith("<")) return segment;
    return segment.replace(NUMBER_PROTECT_RE, (match) => {
      placeholders.push(`__NUM_${index}__`);
      originalValues.push(match);
      return `__NUM_${index++}__`;
    });
  });
  return { protectedHtml: protectedSegments.join(""), placeholders, originalValues };
}

export function tryRestoreNumbersInHtml(
  html: string,
  placeholders: string[],
  originalValues: string[],
): { html: string; lost: string[]; extras: string[]; ok: boolean } {
  const lost: string[] = [];
  const extras: string[] = [];
  for (let i = 0; i < placeholders.length; i++) {
    const ph = placeholders[i];
    const escaped = ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = (html.match(new RegExp(escaped, "g")) || []).length;
    if (count === 0) lost.push(originalValues[i]);
    else if (count > 1) extras.push(originalValues[i]);
  }
  const unknownPhs = html.match(/__NUM_\d+__/g) || [];
  const knownSet = new Set(placeholders);
  for (const ph of unknownPhs) { if (!knownSet.has(ph)) extras.push(ph); }
  const ok = lost.length === 0 && extras.length === 0;
  let result = html;
  for (let i = 0; i < placeholders.length; i++) {
    if (lost.includes(originalValues[i])) continue;
    const escaped = placeholders[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), originalValues[i]);
  }
  return { html: result, lost, extras, ok };
}

// ── Number preservation (legacy) ──

export function extractVisibleNumbers(html: string): string[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const numbers: string[] = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/g;
  let m; while ((m = re.exec(cleaned)) !== null) numbers.push(m[0]);
  return numbers;
}

export function normalizeNumber(n: string): string {
  return n.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "").trim();
}

export function extractScaledNumbers(html: string): { raw: string; scaled: string }[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const results: { raw: string; scaled: string }[] = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const match = m[0];
    const isPercent = /[%％]/.test(match);
    const cleanMatch = match.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "");
    const numPart = parseFloat(cleanMatch);
    const after = body.substring(m.index + match.length, m.index + match.length + 12).toLowerCase();
    let scale = 1; let hasScale = false;
    const engWord = after.match(/^\s*(thousand|million|billion|trillion)\b/);
    if (engWord) { const w = engWord[1]; if (w === "thousand") { scale = 1_000; hasScale = true; } else if (w === "million") { scale = 1_000_000; hasScale = true; } else if (w === "billion") { scale = 1_000_000_000; hasScale = true; } }
    const zhChar = after.match(/^\s*(千|萬|億)\s*/);
    if (zhChar) { const ch = zhChar[1]; if (ch === "千") { scale = 1_000; hasScale = true; } else if (ch === "萬") { scale = 10_000; hasScale = true; } else if (ch === "億") { scale = 100_000_000; hasScale = true; } }
    const hasHkdSuffix = !!after.match(/^\s*(?:[千萬億]\s*)?港元的?/);
    const hasHkdPrefix = /^HK?\$/.test(match);
    const hasUsdPrefix = /^US?\$/.test(match) && !hasHkdPrefix;
    const scaledValue = isPercent ? `%:${numPart}`
      : hasScale ? `${hasHkdPrefix || hasHkdSuffix ? "HKD:" : hasUsdPrefix ? "USD:" : ""}${Math.round(numPart * scale)}`
      : hasHkdPrefix || hasHkdSuffix ? `HKD:${numPart}`
      : /^\d+$/.test(String(numPart)) ? String(numPart) : String(numPart).replace(/\.0$/, "");
    results.push({ raw: match, scaled: scaledValue });
  }
  return results;
}

export function checkNumbersPreserved(source: string, translated: string): { lost: string[]; extras: string[] } {
  const srcNums = extractScaledNumbers(source).map((n) => n.scaled);
  const tgtNums = extractScaledNumbers(translated).map((n) => n.scaled);
  const srcCounts: Record<string, number> = {}; const tgtCounts: Record<string, number> = {};
  for (const n of srcNums) srcCounts[n] = (srcCounts[n] || 0) + 1;
  for (const n of tgtNums) tgtCounts[n] = (tgtCounts[n] || 0) + 1;
  const lost: string[] = []; const extras: string[] = [];
  for (const [n, c] of Object.entries(srcCounts)) { const tgtC = tgtCounts[n] || 0; if (tgtC < c) lost.push(...Array(c - tgtC).fill(n)); }
  for (const [n, c] of Object.entries(tgtCounts)) { const srcC = srcCounts[n] || 0; if (srcC < c) extras.push(...Array(c - srcC).fill(n)); }
  return { lost, extras };
}

// ── Completeness & English leakage ──

const COMPLETENESS_RATIO = 0.25;

export function visibleChars(html: string): number {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

export function checkCompleteness(source: string, translated: string, component: string): { passed: boolean; sourceChars: number; translatedChars: number; ratio: number } {
  const sourceChars = visibleChars(source);
  const translatedChars = visibleChars(translated);
  const ratio = sourceChars > 0 ? translatedChars / sourceChars : 1;
  const passed = ratio >= COMPLETENESS_RATIO && !hasExcessiveEnglish(translated);
  return { passed, sourceChars, translatedChars, ratio };
}

export function hasExcessiveEnglish(text: string): boolean {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const engRuns = cleaned.match(/\b([A-Za-z]{2,}\s+){4,}[A-Za-z]{2,}\b/g) || [];
  if (engRuns.length === 0) return false;
  return engRuns.join(" ").length > cleaned.length * 0.10;
}

// ── Link checks ──

export function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m; while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
}

export function checkLinksPreserved(source: string, translated: string): string[] {
  const srcLinks = extractLinks(source);
  const tgtLinks = extractLinks(translated);
  return srcLinks.filter((l) => !tgtLinks.includes(l) && !l.startsWith("#"));
}

export function checkNoNewUrls(source: string, translated: string): string[] {
  const srcLinks = extractLinks(source);
  const tgtLinks = extractLinks(translated);
  return tgtLinks.filter((l) => !srcLinks.includes(l) && !l.startsWith("#") && !l.startsWith("/blog/") && !l.includes("b2ihub.com"));
}

// ── Chinese length metrics ──

export function countCjkChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
}

export function countLatinWords(text: string): number {
  const cleaned = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\s]+/g, " ").trim();
  return cleaned ? cleaned.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length : 0;
}

export function countParagraphs(html: string): number {
  return (html.match(/<\/p>/gi) || []).length + (html.match(/<\/li>/gi) || []).length;
}

export function estimatedReadingTime(cjkChars: number, latinWords: number): number {
  return Math.max(1, Math.ceil(cjkChars / 300 + latinWords / 200));
}

export function chineseLengthMetrics(html: string): {
  zhCharCount: number;
  latinWordCount: number;
  paragraphCount: number;
  estimatedReadingMinutes: number;
} {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const zhCharCount = countCjkChars(body);
  const latinWordCount = countLatinWords(body);
  const paragraphCount = countParagraphs(html);
  return { zhCharCount, latinWordCount, paragraphCount, estimatedReadingMinutes: estimatedReadingTime(zhCharCount, latinWordCount) };
}
