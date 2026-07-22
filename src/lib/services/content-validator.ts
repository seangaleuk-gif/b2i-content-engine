import { cleanBodyText, countWords } from "@/lib/services/text-utils";
import { CONTENT_MIN_SECTION_WORDS, CONTENT_DUPLICATE_SIMILARITY, CONTENT_HEADING_DRIFT_MIN_OVERLAP, CONTENT_MIN_BODY_PARAGRAPHS } from "@/lib/services/generation-constants";
import { detectNestedParagraphs } from "@/lib/blog/article-document";

export type Severity = "info" | "warning" | "error";

export interface ContentIssue {
  check: string;
  severity: Severity;
  message: string;
  location: string;
}

export interface ContentValidationReport {
  passed: boolean;
  issues: ContentIssue[];
  warnings: number;
  errors: number;
}

// ── Normalization ──

function normalise(text: string): string {
  return cleanBodyText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceSimilarity(a: string, b: string): number {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return 0;
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / Math.max(1, union.size);
}

// ── Section extraction ──

interface ParsedSection {
  index: number;
  heading: string;
  headingText: string;
  bodyHtml: string;
  bodyText: string;
  bodyWords: number;
  paragraphs: string[];
}

function parseSections(blog: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const h2Re = /<!--\s*wp:heading\s*\{[^}]*"level":2[^}]*\}\s*-->\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi;
  const matches: { index: number; full: string; text: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = h2Re.exec(blog)) !== null) {
    matches.push({ index: m.index, full: m[0], text: cleanBodyText(m[1]) });
  }

  for (let i = 0; i < matches.length; i++) {
    const bodyStart = matches[i].index + matches[i].full.length;
    const bodyEnd = i < matches.length - 1 ? matches[i + 1].index : blog.length;
    const bodyHtml = blog.substring(bodyStart, bodyEnd).trim();
    const bodyText = cleanBodyText(bodyHtml);
    const paragraphs = extractParagraphs(bodyText);
    sections.push({
      index: i,
      heading: matches[i].full,
      headingText: matches[i].text,
      bodyHtml,
      bodyText,
      bodyWords: countWords(bodyHtml),
      paragraphs,
    });
  }

  return sections;
}

function extractParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=\.)\s+(?=[A-Z])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);
}

// ── Heading keywords ──

function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or", "is", "are", "was",
    "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "this", "that", "these", "those", "it",
    "its", "with", "from", "by", "as", "into", "through", "during", "before", "after", "above",
    "below", "between", "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "both", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "just", "about",
    "over", "also", "now", "up", "out", "make", "like", "get", "use", "one", "two",
  ]);
  return new Set(
    normalise(text)
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w)),
  );
}

// ── 1. Heading Coverage ──

function checkCoverage(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];

  for (const s of sections) {
    const loc = `Section ${s.index + 1}`;
    if (s.bodyWords === 0) {
      issues.push({ check: "coverage", severity: "error", message: `Empty section — no body content`, location: loc });
    } else if (s.bodyWords < CONTENT_MIN_SECTION_WORDS) {
      issues.push({ check: "coverage", severity: "warning", message: `Thin section — ${s.bodyWords} words (min: ${CONTENT_MIN_SECTION_WORDS})`, location: loc });
    }
    if (s.paragraphs.length < CONTENT_MIN_BODY_PARAGRAPHS && s.bodyWords > 0) {
      issues.push({ check: "coverage", severity: "warning", message: `Only ${s.paragraphs.length} paragraph(s) — may be list-only`, location: loc });
    }
  }

  // Duplicate paragraphs within same section
  for (const s of sections) {
    const seen = new Set<string>();
    for (let pi = 0; pi < s.paragraphs.length; pi++) {
      const norm = normalise(s.paragraphs[pi]);
      if (seen.has(norm)) {
        issues.push({ check: "coverage", severity: "warning", message: `Duplicate paragraph detected`, location: `Section ${s.index + 1}` });
        break;
      }
      seen.add(norm);
    }
  }

  return issues;
}

// ── 2. Duplicate Detection ──

function checkDuplicates(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];

  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      for (const pa of sections[i].paragraphs) {
        for (const pb of sections[j].paragraphs) {
          const sim = sentenceSimilarity(pa, pb);
          if (sim >= CONTENT_DUPLICATE_SIMILARITY) {
            issues.push({
              check: "duplicate",
              severity: "warning",
              message: `Duplicated content across sections (${Math.round(sim * 100)}% similar)`,
              location: `Section ${i + 1} ↔ Section ${j + 1}`,
            });
          }
        }
      }
    }
  }

  return issues;
}

// ── 3. Duplicate Statistics ──

function checkDuplicateStats(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const statRe = /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?%?\b/g;
  const statLocations = new Map<string, number[]>();

  for (const s of sections) {
    const stats = s.bodyText.match(statRe) || [];
    for (const stat of stats) {
      if (stat.length < 3) continue;
      const existing = statLocations.get(stat) || [];
      existing.push(s.index);
      statLocations.set(stat, existing);
    }
  }

  for (const [stat, locs] of statLocations) {
    if (locs.length > 1 && new Set(locs).size > 1) {
      issues.push({
        check: "duplicate-stats",
        severity: "warning",
        message: `Statistic "${stat}" repeated in multiple sections`,
        location: locs.map((l) => `Section ${l + 1}`).join(", "),
      });
    }
  }

  return issues;
}

// ── 4. Heading Drift ──

function checkHeadingDrift(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];

  for (const s of sections) {
    if (s.bodyWords < 30) continue;
    const headingKw = extractKeywords(s.headingText);
    const bodyKw = extractKeywords(s.bodyText);
    if (headingKw.size === 0) continue;

    const overlap = new Set([...headingKw].filter((w) => bodyKw.has(w)));
    const ratio = overlap.size / headingKw.size;

    if (ratio < CONTENT_HEADING_DRIFT_MIN_OVERLAP) {
      issues.push({
        check: "heading-drift",
        severity: "warning",
        message: `Body text may not match heading — only ${Math.round(ratio * 100)}% keyword overlap`,
        location: `Section ${s.index + 1}: "${s.headingText.substring(0, 60)}"`,
      });
    }
  }

  return issues;
}

// ── 5. Transition Check ──

function checkTransitions(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const transitionTerms = /\b(next|following|upcoming|we will|in the next|later in this|moving on|turn to|shift to|let.*explore|now let|finally)\b/i;

  for (let i = 0; i < sections.length - 1; i++) {
    const lastParagraph = sections[i].paragraphs[sections[i].paragraphs.length - 1] || "";
    if (lastParagraph.length > 30 && !transitionTerms.test(lastParagraph)) {
      issues.push({
        check: "transitions",
        severity: "info",
        message: `No transition toward next heading: "${sections[i + 1].headingText.substring(0, 50)}"`,
        location: `Section ${i + 1}`,
      });
    }
  }

  return issues;
}

// ── 6. Internal Contradictions ──

function checkContradictions(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const allText = sections.map((s) => s.bodyText).join("\n");

  // Conflicting quantifier pairs
  const contradictionPairs: [RegExp, RegExp, string][] = [
    [/\bmost\b/i, /\b(?:few|very few|hardly any)\b/i, "most vs few"],
    [/\b(?:always|every)\b/i, /\b(?:rarely|never|seldom)\b/i, "always vs rarely"],
    [/\b(?:increas|growing|rising)\w*\b/i, /\b(?:decreas|declining|falling|shrinking)\w*\b/i, "increasing vs decreasing"],
    [/\b(?:majority|most)\b/i, /\bminority\b/i, "majority vs minority"],
    [/\b(?:high|large|significant)\b/i, /\b(?:low|small|insignificant)\b/i, "high vs low"],
  ];

  for (const [patternA, patternB, label] of contradictionPairs) {
    const hasA = patternA.test(allText);
    const hasB = patternB.test(allText);
    if (hasA && hasB) {
      issues.push({
        check: "contradictions",
        severity: "warning",
        message: `Possible contradiction: ${label}`,
        location: "Body text",
      });
    }
  }

  // Year contradictions
  const years = allText.match(/\b(20\d{2})\b/g) || [];
  const uniqueYears = [...new Set(years)];
  if (uniqueYears.length > 1) {
    const sorted = uniqueYears.sort();
    if (parseInt(sorted[0]) < parseInt(sorted[sorted.length - 1]) - 1) {
      issues.push({
        check: "contradictions",
        severity: "info",
        message: `Multiple years referenced: ${sorted.join(", ")}`,
        location: "Body text",
      });
    }
  }

  return issues;
}

// ── 7. Broken Lists ──

function checkBrokenLists(sections: ParsedSection[]): ContentIssue[] {
  const issues: ContentIssue[] = [];

  for (const s of sections) {
    const loc = `Section ${s.index + 1}`;
    // Ordered list patterns
    const orderedItems = s.bodyText.match(/^\d+\.\s*$/gm);
    if (orderedItems && orderedItems.length > 0) {
      issues.push({ check: "broken-lists", severity: "warning", message: `Empty ordered list item(s) found`, location: loc });
    }
    // Bullet list patterns
    const bulletItems = s.bodyText.match(/^[•\-]\s*$/gm);
    if (bulletItems && bulletItems.length > 0) {
      issues.push({ check: "broken-lists", severity: "warning", message: `Empty bullet list item(s) found`, location: loc });
    }
  }

  return issues;
}

// ── 8. WordPress Block Integrity ──

function checkWordPressBlocks(blog: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const blocks = ["wp:paragraph", "wp:heading", "wp:list", "wp:quote", "wp:table", "wp:html"];

  for (const block of blocks) {
    const openCount = (blog.match(new RegExp(`<!--\\s*${block.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")) || []).length;
    const closeCount = (blog.match(new RegExp(`<!--\\s*/${block.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")) || []).length;
    if (openCount !== closeCount) {
      issues.push({
        check: "wp-blocks",
        severity: "error",
        message: `${block}: ${openCount} opening vs ${closeCount} closing blocks`,
        location: "Blog body",
      });
    }
  }

  return issues;
}

// ── 9. HTML Integrity ──

function checkHtmlIntegrity(blog: string): ContentIssue[] {
  const issues: ContentIssue[] = [];

  // Detect nested <p> tags using shared canonical implementation
  const nestedCount = detectNestedParagraphs(blog);
  if (nestedCount > 0) {
    issues.push({ check: "html", severity: "error", message: `${nestedCount} nested <p> tag(s) detected`, location: "Blog body" });
  }

  // Check common unclosed tags (simple pair matching)
  const tagPairs = [
    { open: /<p\b/gi, close: /<\/p>/gi, name: "p" },
    { open: /<h2\b/gi, close: /<\/h2>/gi, name: "h2" },
    { open: /<h3\b/gi, close: /<\/h3>/gi, name: "h3" },
    { open: /<ul\b/gi, close: /<\/ul>/gi, name: "ul" },
    { open: /<li\b/gi, close: /<\/li>/gi, name: "li" },
    { open: /<a\b/gi, close: /<\/a>/gi, name: "a" },
    { open: /<div\b/gi, close: /<\/div>/gi, name: "div" },
  ];

  for (const { open, close, name } of tagPairs) {
    const openCount = (blog.match(open) || []).length;
    const closeCount = (blog.match(close) || []).length;
    if (openCount !== closeCount) {
      issues.push({
        check: "html",
        severity: "error",
        message: `Unclosed <${name}> tags: ${openCount} open, ${closeCount} close`,
        location: "Blog body",
      });
    }
  }

  return issues;
}

// ── 10. Link Validation ──

function checkLinks(blog: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const linkRe = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const hrefs: string[] = [];
  let lm: RegExpExecArray | null;

  while ((lm = linkRe.exec(blog)) !== null) {
    const href = lm[1];
    const text = cleanBodyText(lm[2]);

    if (!text || text.trim().length === 0) {
      issues.push({ check: "links", severity: "warning", message: "Empty anchor text", location: "Blog body" });
    }
    if (!/^https?:\/\//i.test(href)) {
      issues.push({ check: "links", severity: "warning", message: `Malformed URL: ${href.substring(0, 60)}`, location: "Blog body" });
    }

    if (href) {
      const normalized = href.toLowerCase().replace(/\/+$/, "");
      if (hrefs.includes(normalized)) {
        issues.push({ check: "links", severity: "warning", message: `Duplicate link: ${href.substring(0, 60)}`, location: "Blog body" });
      }
      hrefs.push(normalized);
    }
  }

  return issues;
}

// ── Main validator ──

export function validateContent(blog: string, h2Headings: string[]): ContentValidationReport {
  const allIssues: ContentIssue[] = [];
  console.log(`[VALIDATE] starting, blogLength=${blog.length} h2Count=${h2Headings.length}`);
  const sections = parseSections(blog);
  console.log(`[VALIDATE] parseSections done, sectionCount=${sections.length}`);

  function safePushIssues(label: string, result: ContentIssue[]): void {
    if (!Array.isArray(result)) {
      console.error(`[VALIDATE] ${label} returned non-array: ${typeof result}`);
      return;
    }
    if (!Number.isSafeInteger(result.length) || result.length < 0) {
      console.error(`[VALIDATE] ${label} has invalid length: ${result.length} (type: ${typeof result.length})`);
      return;
    }
    console.log(`[VALIDATE] ${label} pushing ${result.length} issues, allIssues.length before=${allIssues.length}`);
    try {
      allIssues.push(...result);
    } catch (e) {
      console.error(`[VALIDATE] ${label} push FAILED: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[VALIDATE] ${label} allIssues.length=${allIssues.length} result.length=${result.length}`);
      console.error(`[VALIDATE] ${label} Number.isSafeInteger(allIssues.length)=${Number.isSafeInteger(allIssues.length)} Number.isSafeInteger(result.length)=${Number.isSafeInteger(result.length)}`);
      throw e;
    }
    console.log(`[VALIDATE] ${label} done, allIssues.length=${allIssues.length}`);
  }

  safePushIssues("coverage", checkCoverage(sections));
  safePushIssues("duplicates", checkDuplicates(sections));
  safePushIssues("duplicateStats", checkDuplicateStats(sections));
  safePushIssues("headingDrift", checkHeadingDrift(sections));
  safePushIssues("transitions", checkTransitions(sections));
  safePushIssues("contradictions", checkContradictions(sections));
  safePushIssues("brokenLists", checkBrokenLists(sections));
  safePushIssues("wpBlocks", checkWordPressBlocks(blog));
  safePushIssues("html", checkHtmlIntegrity(blog));
  safePushIssues("links", checkLinks(blog));

  const errors = allIssues.filter((i) => i.severity === "error").length;
  const warnings = allIssues.filter((i) => i.severity === "warning").length;

  return {
    passed: errors === 0,
    issues: allIssues,
    warnings,
    errors,
  };
}
