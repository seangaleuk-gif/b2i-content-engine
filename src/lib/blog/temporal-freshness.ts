import type {
  ArticleDocument,
  ArticleComponent,
  FaqEntry,
  EditorialBlock,
} from "./article-document";
import { renderComponentHtml } from "./article-document";
import { splitSentences } from "@/lib/seo/seo-text-utils";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";

export type TemporalIssueType =
  | "expired_prediction"
  | "stale_current_status"
  | "ambiguous_relative_future";

export interface TemporalFreshnessIssue {
  type: TemporalIssueType;
  sentence: string;
  year?: number;
  reason: string;
}

export interface DocumentTemporalIssue {
  componentId: string;
  issue: TemporalFreshnessIssue;
}

export interface TemporalRepairResult {
  removedSentences: number;
  rewrittenSentences: number;
  changedComponentIds: string[];
  unresolved: DocumentTemporalIssue[];
}

const EN_PREDICTIVE_SOURCE = String.raw`(?:expected|projected|forecast|predicted|planned|scheduled|set|due|likely|poised)\s+to|(?:will|would)|(?:coming|forthcoming)|later`;
const ZH_PREDICTIVE_SOURCE = String.raw`(?:預計|預測|計劃|規劃|預定|將於|將在|將會|有望|料將|即將|稍後|未來將)`;
const EN_PREDICTIVE_RE = new RegExp(`\\b(?:${EN_PREDICTIVE_SOURCE})\\b`, "iu");
const ZH_PREDICTIVE_RE = new RegExp(ZH_PREDICTIVE_SOURCE, "u");
const EXPLICIT_HISTORICAL_RE = /\b(?:was|were|had been)\s+(?:expected|projected|forecast|predicted|planned|scheduled|set|due|likely|poised)\s+to\b|\b(?:at the time|historically|back in|previously)\b|(?:當時|原本|曾經|曾預計|曾預測|當年|其時|過去曾)/iu;
const RELATIVE_FUTURE_RE = /\b(?:later this year|later in the year|next year|in the months ahead|in the coming (?:weeks|months|year)|coming soon|by year[- ]end|this summer|this autumn|this fall|this winter|this spring)\b|(?:今年稍後|今年內|明年|未來幾個月|未來數月|未來幾星期|即將推出|即將上線|不久將來|稍後推出|稍後上線|年底前)/iu;
const EXPLICIT_STALE_ANCHOR_RE = /\b(?:as of|currently in|at present in|today in)\s+(20\d{2})\b|(?:截至|直至|現時為|目前為|現在是)\s*(20\d{2})\s*年/iu;
const CURRENT_STATUS_RE = /\b(?:currently|now|today|at present|still)\b|(?:目前|現時|現在|現階段|仍然|至今)/iu;
const YEAR_RE = /(?<!\d)(20\d{2})(?:\s*年)?(?!\d)/gu;
const TERMINAL_PUNCTUATION_RE = /[.!?。！？]$/u;
const DANGLING_END_RE = /(?:\b(?:and|but|or|with|while|because|although|as|which|that)\b|(?:以及|但|或|而|因為|雖然|即|並且))\s*[,，;；:]?$/iu;

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSentence(value: string): string {
  return value
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,，])\s*\1+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*[,，;；:]\s*/, "")
    .replace(/\s*[,，;；:]\s*([.!?。！？])$/u, "$1")
    .trim();
}

function capitalizeSentence(value: string): string {
  const match = value.match(/[A-Za-z]/);
  if (!match || match.index === undefined) return value;
  const index = match.index;
  return value.slice(0, index) + value[index].toUpperCase() + value.slice(index + 1);
}

export function scanTemporalFreshness(
  html: string,
  referenceDate: Date = new Date(),
): TemporalFreshnessIssue[] {
  const currentYear = referenceDate.getUTCFullYear();
  const issues: TemporalFreshnessIssue[] = [];

  for (const sentence of splitSentences(visibleText(html))) {
    const normalized = sentence.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const historical = EXPLICIT_HISTORICAL_RE.test(normalized);

    if (RELATIVE_FUTURE_RE.test(normalized) && !historical) {
      issues.push({
        type: "ambiguous_relative_future",
        sentence: normalized,
        reason: "relative future wording is not anchored to a verifiable date",
      });
      continue;
    }

    const years = [...normalized.matchAll(YEAR_RE)].map((match) => Number(match[1]));
    const pastYears = years.filter((year) => year < currentYear);
    if (pastYears.length === 0) continue;

    if ((EN_PREDICTIVE_RE.test(normalized) || ZH_PREDICTIVE_RE.test(normalized)) && !historical) {
      issues.push({
        type: "expired_prediction",
        sentence: normalized,
        year: Math.max(...pastYears),
        reason: `future or predictive wording refers to a year before ${currentYear}`,
      });
      continue;
    }

    if (CURRENT_STATUS_RE.test(normalized) && EXPLICIT_STALE_ANCHOR_RE.test(normalized)) {
      issues.push({
        type: "stale_current_status",
        sentence: normalized,
        year: Math.max(...pastYears),
        reason: `current-status wording is explicitly anchored to a year before ${currentYear}`,
      });
    }
  }

  return issues;
}

function staleClauseSource(issue: TemporalFreshnessIssue): string {
  const year = issue.year ? String(issue.year) : String.raw`20\d{2}`;
  const temporalAnchor = issue.type === "ambiguous_relative_future"
    ? String.raw`(?:later this year|later in the year|next year|in the months ahead|in the coming (?:weeks|months|year)|coming soon|by year[- ]end|this summer|this autumn|this fall|this winter|this spring|今年稍後|今年內|明年|未來幾個月|未來數月|未來幾星期|即將推出|即將上線|不久將來|稍後推出|稍後上線|年底前)`
    : String.raw`(?:later\s+in\s+|by\s+|during\s+|in\s+)?${year}(?:\s*年)?`;
  return String.raw`(?:(?:${EN_PREDICTIVE_SOURCE})|${ZH_PREDICTIVE_SOURCE})[^,，;；.!?。！？]{0,180}?${temporalAnchor}[^,，;；.!?。！？]{0,100}`;
}

/**
 * Rewrite only the expired clause inside a sentence. This deliberately avoids
 * replacing the sentence with a new current-status claim. If no trustworthy
 * clause-level repair exists, the caller may remove the whole sentence only
 * when other complete sentences remain in the same block.
 */
export function rewriteStaleTemporalSentence(
  sentence: string,
  issue: TemporalFreshnessIssue,
  referenceDate: Date = new Date(),
): string | null {
  const original = sentence.trim();
  if (!original) return null;

  const clause = staleClauseSource(issue);
  const candidates: string[] = [];

  // Coordinated stale clause: "X and advertising features are expected ... 2025, Y".
  candidates.push(original.replace(
    new RegExp(String.raw`\s+(?:and|but|while|as well as|以及|並且|而)\s+[^,，;；.!?。！？]{0,100}?${clause}`, "iu"),
    "",
  ));

  // Parenthetical stale aside.
  candidates.push(original.replace(
    new RegExp(String.raw`\s*[（(][^）)]{0,160}?${clause}[^）)]*[）)]`, "iu"),
    "",
  ));

  // Comma-delimited stale clause.
  candidates.push(original.replace(
    new RegExp(String.raw`\s*[,，]\s*[^,，;；.!?。！？]{0,100}?${clause}(?=\s*[,，;；.!?。！？]|$)`, "iu"),
    "",
  ));

  // Stale introductory clause followed by a complete main clause.
  const prefix = original.match(new RegExp(String.raw`^[^,，]{0,220}?${clause}\s*[,，]\s*(.+)$`, "iu"));
  if (prefix?.[1]) candidates.push(capitalizeSentence(prefix[1].trim()));

  for (const rawCandidate of candidates) {
    let candidate = normalizeSentence(rawCandidate);
    if (!candidate || candidate === normalizeSentence(original)) continue;
    if (DANGLING_END_RE.test(candidate)) continue;
    if (!TERMINAL_PUNCTUATION_RE.test(candidate) && TERMINAL_PUNCTUATION_RE.test(original)) {
      candidate += original.slice(-1);
    }
    if (candidate.length < 12) continue;
    if (scanTemporalFreshness(candidate, referenceDate).length > 0) continue;
    return candidate;
  }

  return null;
}

function repairPlainText(
  source: string,
  referenceDate: Date,
  allowWholeSentenceRemoval: boolean,
): { value: string; removed: number; rewritten: number; unresolved: TemporalFreshnessIssue[] } {
  const sourceQuotation = analyzeQuotationIntegrity(source);
  if (!sourceQuotation.balanced) {
    return {
      value: source,
      removed: 0,
      rewritten: 0,
      unresolved: scanTemporalFreshness(source, referenceDate),
    };
  }
  const sourceIssues = scanTemporalFreshness(source, referenceDate);
  if (sourceQuotation.spans.length > 0 && sourceIssues.length > 0) {
    // Do not rewrite or delete only part of attributed speech. A middle
    // sentence can be removed while both quotation marks remain, yielding
    // syntactically balanced but materially altered evidence.
    return {
      value: source,
      removed: 0,
      rewritten: 0,
      unresolved: sourceIssues,
    };
  }
  const sentences = splitSentences(source);
  if (sentences.length === 0) {
    return { value: source, removed: 0, rewritten: 0, unresolved: scanTemporalFreshness(source, referenceDate) };
  }

  let removed = 0;
  let rewritten = 0;
  const output: string[] = [];
  const unresolved: TemporalFreshnessIssue[] = [];

  for (const sentence of sentences) {
    const issues = scanTemporalFreshness(sentence, referenceDate);
    if (issues.length === 0) {
      output.push(sentence.trim());
      continue;
    }

    let candidate = sentence.trim();
    let repaired = true;
    for (const issue of issues) {
      const next = rewriteStaleTemporalSentence(candidate, issue, referenceDate);
      if (!next) {
        repaired = false;
        break;
      }
      candidate = next;
    }

    if (repaired && scanTemporalFreshness(candidate, referenceDate).length === 0) {
      output.push(candidate);
      rewritten += 1;
      continue;
    }

    if (allowWholeSentenceRemoval && sentences.length > 1) {
      removed += 1;
      continue;
    }

    output.push(sentence.trim());
    unresolved.push(...issues);
  }

  const value = output.join(" ").replace(/\s+/g, " ").trim();
  if (!analyzeQuotationIntegrity(value || source).balanced) {
    // A stale clause/sentence inside a multi-sentence quotation may not be
    // removed independently. Restore the exact source and let the guarded
    // temporal stage fail closed rather than carrying a broken quote into the
    // malformed-prose boundary.
    return {
      value: source,
      removed: 0,
      rewritten: 0,
      unresolved: scanTemporalFreshness(source, referenceDate),
    };
  }
  return {
    value: value || source,
    removed,
    rewritten,
    unresolved: [...unresolved, ...scanTemporalFreshness(value || source, referenceDate)]
      .filter((issue, index, all) => all.findIndex((item) => item.type === issue.type && item.sentence === issue.sentence) === index),
  };
}

function repairInlineContent(
  content: Array<{ type: string; text: string }>,
  referenceDate: Date,
  allowWholeSentenceRemoval: boolean,
): { changed: boolean; removed: number; rewritten: number; unresolved: TemporalFreshnessIssue[] } {
  // Preserve links and inline formatting byte-for-byte. A linked or styled stale
  // sentence is sent to a controlled component regeneration rather than being
  // flattened by deterministic code.
  if (content.length !== 1 || content[0]?.type !== "text") {
    return {
      changed: false,
      removed: 0,
      rewritten: 0,
      unresolved: scanTemporalFreshness(content.map((item) => item.text).join(""), referenceDate),
    };
  }

  const result = repairPlainText(content[0].text, referenceDate, allowWholeSentenceRemoval);
  const changed = result.value !== content[0].text;
  if (changed) content[0].text = result.value;
  return { changed, removed: result.removed, rewritten: result.rewritten, unresolved: result.unresolved };
}

function repairBlock(
  block: EditorialBlock,
  referenceDate: Date,
): { changed: boolean; removed: number; rewritten: number; unresolved: TemporalFreshnessIssue[] } {
  if (block.type === "paragraph" || block.type === "subheading" || block.type === "quote") {
    return repairInlineContent(block.content, referenceDate, block.type !== "subheading");
  }

  if (block.type === "list") {
    let changed = false;
    let removed = 0;
    let rewritten = 0;
    const unresolved: TemporalFreshnessIssue[] = [];
    for (const item of block.items) {
      const result = repairInlineContent(item, referenceDate, false);
      changed ||= result.changed;
      removed += result.removed;
      rewritten += result.rewritten;
      unresolved.push(...result.unresolved);
    }
    return { changed, removed, rewritten, unresolved };
  }

  let changed = false;
  let removed = 0;
  let rewritten = 0;
  const unresolved: TemporalFreshnessIssue[] = [];
  for (const cell of [...block.headers, ...block.rows.flat()]) {
    const result = repairInlineContent(cell, referenceDate, false);
    changed ||= result.changed;
    removed += result.removed;
    rewritten += result.rewritten;
    unresolved.push(...result.unresolved);
  }
  return { changed, removed, rewritten, unresolved };
}

function repairComponent(
  component: ArticleComponent,
  referenceDate: Date,
): { changed: boolean; removed: number; rewritten: number; unresolved: TemporalFreshnessIssue[] } {
  let changed = false;
  let removed = 0;
  let rewritten = 0;
  const unresolved: TemporalFreshnessIssue[] = [];

  for (const block of component.blocks) {
    const result = repairBlock(block, referenceDate);
    changed ||= result.changed;
    removed += result.removed;
    rewritten += result.rewritten;
    unresolved.push(...result.unresolved);
  }

  if (changed) component.status = "normalized";
  return {
    changed,
    removed,
    rewritten,
    unresolved: scanTemporalFreshness(renderComponentHtml(component), referenceDate).length > 0
      ? scanTemporalFreshness(renderComponentHtml(component), referenceDate)
      : unresolved.filter(() => false),
  };
}

function repairFaqEntry(
  entry: FaqEntry,
  referenceDate: Date,
): { entry: FaqEntry; changed: boolean; removed: number; rewritten: number; unresolved: TemporalFreshnessIssue[] } {
  const source = entry.answerText || visibleText(entry.answerHtml);
  const result = repairPlainText(source, referenceDate, true);
  if (result.value === source) {
    return { entry, changed: false, removed: result.removed, rewritten: result.rewritten, unresolved: result.unresolved };
  }
  const repairedEntry: FaqEntry = {
    ...entry,
    answerText: result.value,
    answerHtml: `<p>${result.value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")}</p>`,
  };
  return { entry: repairedEntry, changed: true, removed: result.removed, rewritten: result.rewritten, unresolved: result.unresolved };
}

export function findTemporalFreshnessIssues(
  doc: ArticleDocument,
  referenceDate: Date = new Date(),
): DocumentTemporalIssue[] {
  const results: DocumentTemporalIssue[] = [];
  const add = (componentId: string, value: string) => {
    for (const issue of scanTemporalFreshness(value, referenceDate)) {
      results.push({ componentId, issue });
    }
  };

  add("metadata-title", doc.metadata.title);
  add("metadata-description", doc.metadata.metaDescription);
  add("metadata-excerpt", doc.metadata.excerpt);
  add(doc.introduction.id, renderComponentHtml(doc.introduction));
  for (const section of doc.sections) {
    if (section.sectionType === "main" || section.sectionType === "mistakes") {
      add(section.id, `${section.heading}\n${renderComponentHtml(section)}`);
    }
  }
  add(doc.conclusion.id, renderComponentHtml(doc.conclusion));
  doc.visibleFaq.forEach((entry, index) => add(`faq-${index}`, `${entry.question}\n${entry.answerHtml}`));
  return results;
}

/**
 * Repair stale temporal wording without inventing a current outcome. Clause-level
 * rewrites are preferred; whole-sentence removal is only allowed when another
 * complete sentence remains in the same plain-text block. Anything unsafe stays
 * unresolved for the guarded pipeline stage to reject or regenerate.
 */
export function repairTemporalFreshnessDocument(
  doc: ArticleDocument,
  referenceDate: Date = new Date(),
): TemporalRepairResult {
  let removedSentences = 0;
  let rewrittenSentences = 0;
  const changedComponentIds = new Set<string>();
  const unresolved: DocumentTemporalIssue[] = [];

  for (const [field, value] of [
    ["metadata-title", doc.metadata.title],
    ["metadata-description", doc.metadata.metaDescription],
    ["metadata-excerpt", doc.metadata.excerpt],
  ] as const) {
    const result = repairPlainText(value, referenceDate, true);
    removedSentences += result.removed;
    rewrittenSentences += result.rewritten;
    if (result.value !== value) {
      changedComponentIds.add(field);
      if (field === "metadata-title") doc.metadata.title = result.value;
      if (field === "metadata-description") doc.metadata.metaDescription = result.value;
      if (field === "metadata-excerpt") doc.metadata.excerpt = result.value;
    }
    for (const issue of result.unresolved) unresolved.push({ componentId: field, issue });
  }

  const components: ArticleComponent[] = [
    doc.introduction,
    ...doc.sections.filter((section) => section.sectionType === "main" || section.sectionType === "mistakes"),
    doc.conclusion,
  ];
  for (const component of components) {
    const result = repairComponent(component, referenceDate);
    removedSentences += result.removed;
    rewrittenSentences += result.rewritten;
    if (result.changed) changedComponentIds.add(component.id);
    for (const issue of result.unresolved) unresolved.push({ componentId: component.id, issue });
  }

  doc.visibleFaq = doc.visibleFaq.map((entry, index) => {
    const result = repairFaqEntry(entry, referenceDate);
    removedSentences += result.removed;
    rewrittenSentences += result.rewritten;
    if (result.changed) changedComponentIds.add(`faq-${index}`);
    for (const issue of result.unresolved) unresolved.push({ componentId: `faq-${index}`, issue });
    return result.entry;
  });

  const remaining = findTemporalFreshnessIssues(doc, referenceDate);
  return {
    removedSentences,
    rewrittenSentences,
    changedComponentIds: [...changedComponentIds],
    unresolved: remaining,
  };
}
