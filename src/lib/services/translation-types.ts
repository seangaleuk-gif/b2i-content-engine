import type { ArticleDocument, FaqEntry, ProtectedArticleBlock } from "@/lib/blog/article-document";
import type { StructuredTranslationShadowResult } from "./editorial-block-translation";

export interface TranslationMetrics {
  component: string;
  sourceChars: number;
  translatedChars: number;
  ratio: number;
  passed: boolean;
  sourceNumbers: number;
  translatedNumbers: number;
  numbersMatch: boolean;
}

export interface SourceDecision {
  originalUrl: string;
  finalUrl: string;
  decision: "preserved" | "replaced" | "removed" | "localised";
  reason: string;
  matchScore: number;
}

export interface TranslationResult {
  doc: ArticleDocument;
  html: string;
  title: string;
  metaDescription: string;
  metrics: TranslationMetrics[];
  failedComponents: string[];
  warnings: string[];
  zhCharCount: number;
  latinWordCount: number;
  paragraphCount: number;
  estimatedReadingMinutes: number;
  sourceDecisions: SourceDecision[];
  internalLinkDecisions: SourceDecision[];
  structuredShadowResult?: StructuredTranslationShadowResult;
  /** Editorial-review diagnostics (selected units, reasons, decisions, field edits). */
  review?: {
    selectedUnitIds: string[];
    selectedReasons: Array<{ sourceUnitId: string; reasons: string[]; mandatory: boolean }>;
    decisions: Array<{
      sourceUnitId: string;
      decision: "replace" | "retain";
      reasonCodes: string[];
      edits?: Array<{ fieldId: string; replacementText: string }>;
    }>;
    appliedEditCount: number;
    retainedCount: number;
    status: "not-run" | "run" | "failed";
    failure: string | null;
  };
}

export interface ResearchItem {
  title: string;
  url: string;
  snippet: string;
  category: string;
}

export interface InternalLinkDecision {
  originalUrl: string;
  finalUrl: string;
  hasChineseVersion: boolean;
  reason: string;
}

/** Request-scoped retry budget for the entire translation operation.
 *  Every component gets its first API attempt regardless of budget exhaustion.
 *  Caps only retries (attempts 2 and 3) against the shared budget. */
export class RetryBudget {
  remaining: number;
  total: number;
  exhausted: boolean;
  apiCallCount: number;
  componentLog: string[];

  constructor(budget: number) {
    this.remaining = budget;
    this.total = budget;
    this.exhausted = false;
    this.apiCallCount = 0;
    this.componentLog = [];
  }

  capRetries(requestedRetries: number): number {
    this.apiCallCount++;
    if (this.exhausted || this.remaining <= 0) return 0;
    return Math.min(requestedRetries, this.remaining);
  }

  record(component: string, usedRetries: number, capped: boolean): void {
    this.remaining = Math.max(0, this.remaining - usedRetries);
    if (this.remaining <= 0) this.exhausted = true;
    const note = capped ? "(capped)" : "";
    if (usedRetries > 0 || capped) {
      this.componentLog.push(`${component}(retries=${usedRetries}/${this.total}${note})`);
    }
  }
}
