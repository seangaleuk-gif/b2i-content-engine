// ── Opt-in stage-by-stage pipeline debug tracing ──
//
// Observational only. When ENABLE_PIPELINE_DEBUG_TRACE=true, every mutating
// stage records deterministic, compact diagnostics that identify the FIRST
// stage where each violation appears and exactly which blocks changed. When
// disabled (the default), every hook is a no-op and production logging,
// validation and pipeline behaviour are byte-for-byte unchanged.
//
// Never logs secrets: only document-derived metrics, fingerprints and
// truncated text snippets are emitted.

import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import {
  renderArticleDocument,
  fingerprintHtml,
  renderFaqSchema,
  countCanonicalVisibleWords,
  extractVisibleFaqFromArticle,
  validateFaqParity,
} from "@/lib/blog/article-document";
import { extractFaqBlock } from "@/lib/blog/protected-block-extractor";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import { scanSentenceQualityInDocument } from "@/lib/blog/sentence-quality";
import { validateCoherence } from "@/lib/blog/coherence";
import { findUngroundedSectionIds } from "@/lib/blog/content-relevance";
import { scanFactualRisks } from "@/lib/blog/factual-risk-scanner";
import { validateClaimOwnership, type ClaimOwnershipLedger } from "@/lib/blog/claim-ownership";
import { canonicalKeyphraseMetrics } from "@/lib/blog/final-seo-reconcile";

const ENABLE_FLAG = "ENABLE_PIPELINE_DEBUG_TRACE";
const MAX_SNAPSHOTS = 6;
const SNIPPET_LENGTH = 96;

export function isPipelineDebugTraceEnabled(): boolean {
  return process.env[ENABLE_FLAG] === "true";
}

export interface TraceContext {
  keyphrase: string;
  research: Array<{ title?: string; snippet?: string; url?: string }>;
  ledger?: ClaimOwnershipLedger;
}

export interface TraceMetrics {
  fp: string;
  wordCount: number;
  occurrences: number;
  density: number;
}

export interface TraceViolationKey {
  category: string;
  /** Human-readable key like "section-4/section-4-wp-5:orphan-transition". */
  key: string;
  /** Block-level identity for first-introduced lines. */
  blockRef: string;
  /** Violation type/code, e.g. "orphan-transition". */
  type: string;
}

export interface TraceBlockChange {
  componentId: string;
  blockId: string;
  reason: "removed-block" | "added-block" | "text-changed";
  before: string;
  after: string;
}

export interface TraceContractRecord {
  label: string;
  valid: boolean;
  violations: string[];
  owned: string[];
}

export interface TraceStageRecord {
  stage: string;
  pre: TraceMetrics;
  post: TraceMetrics;
  preViolations: TraceViolationKey[];
  postViolations: TraceViolationKey[];
  introduced: TraceViolationKey[];
  resolved: TraceViolationKey[];
  firstIntroduced: TraceViolationKey[];
  changedBlocks: TraceBlockChange[];
  accepted: boolean;
  rollback: boolean;
  contract?: TraceContractRecord;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function snippet(text: string): string {
  const normalized = normalizeText(text).replace(/"/g, "'").replace(/\\/g, "/");
  return normalized.length > SNIPPET_LENGTH
    ? `${normalized.slice(0, SNIPPET_LENGTH)}…`
    : normalized;
}

function plainBlockText(block: EditorialBlock): string {
  if (block.type === "list") return block.items.flat().map((node) => node.text).join(" ");
  if (block.type === "table") {
    return [...block.headers, ...block.rows.flat()].flat().map((node) => node.text).join(" ");
  }
  return block.content.map((node) => node.text).join(" ");
}

/** Link destinations of the rendered article, excluding wp:html/script ranges
 *  (language switcher, CTA and FAQ schema never count). Mirrors the contract's
 *  link fingerprint so the trace agrees with the integrity gate. */
function collectLinkDestinations(html: string): string[] {
  const excludedRanges: Array<[number, number]> = [];
  const rangeRe =
    /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->|<script[\s\S]*?<\/script>/gi;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = rangeRe.exec(html)) !== null) {
    excludedRanges.push([rangeMatch.index, rangeMatch.index + rangeMatch[0].length]);
  }
  const hrefs: string[] = [];
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    const insideExcluded = excludedRanges.some(([from, to]) => start >= from && start < to);
    if (!insideExcluded) hrefs.push(m[1]);
  }
  return hrefs;
}

function metricsFor(doc: ArticleDocument, keyphrase: string): TraceMetrics {
  const html = renderArticleDocument(doc);
  const keyphraseMetrics = canonicalKeyphraseMetrics(doc, keyphrase);
  return {
    fp: fingerprintHtml(html),
    wordCount: countCanonicalVisibleWords(doc),
    occurrences: keyphraseMetrics.occurrences,
    density: keyphraseMetrics.density,
  };
}

function violationsFor(doc: ArticleDocument, ctx: TraceContext): TraceViolationKey[] {
  const keys: TraceViolationKey[] = [];
  const push = (category: string, key: string, blockRef: string, type: string) => {
    keys.push({ category, key, blockRef, type });
  };

  for (const finding of scanMalformedProseInDocument(doc)) {
    for (const issue of finding.issues) {
      push("malformed", `${finding.componentId}/${finding.blockId}:${issue.code}`, `${finding.componentId}/${finding.blockId}`, issue.code);
    }
  }
  for (const finding of scanSentenceQualityInDocument(doc)) {
    for (const issue of finding.issues) {
      push("sentence-quality", `${finding.componentId}/${finding.blockId}:${issue.code}`, `${finding.componentId}/${finding.blockId}`, issue.code);
    }
  }
  for (const violation of validateCoherence(doc)) {
    const blockRef = `${violation.componentId}/${violation.blockId ?? "-"}`;
    push("coherence", `${blockRef}:${violation.type}`, blockRef, violation.type);
  }
  for (const sectionId of findUngroundedSectionIds(doc)) {
    push("grounding", `grounding:${sectionId}`, sectionId, "ungrounded-section");
  }

  const html = renderArticleDocument(doc);
  const claims = scanFactualRisks(html, ctx.keyphrase, ctx.research).claims;
  for (const claim of claims) {
    push(
      "factual",
      `factual:${claim.supported ? "supported" : "unsupported"}:${normalizeText(claim.text).toLowerCase()}`,
      "-",
      claim.supported ? "supported-claim" : "unsupported-claim",
    );
  }
  if (ctx.ledger) {
    for (const violation of validateClaimOwnership(doc, ctx.ledger, ctx.keyphrase, ctx.research)) {
      push("ownership", `ownership:${violation.componentId}:${violation.reason}`, violation.componentId, violation.reason);
    }
  }

  // FAQ parity: canonical entries vs rendered block vs schema fingerprint.
  const renderedFaq = extractVisibleFaqFromArticle(html, doc);
  const schemaHtml = extractFaqBlock(html);
  const schemaParity = validateFaqParity(doc.visibleFaq, schemaHtml);
  if (!schemaParity.valid) {
    push("faq-parity", `faq-parity:schema`, "-", "faq-schema-mismatch");
  }
  if (renderedFaq.length !== doc.visibleFaq.length) {
    push("faq-parity", `faq-parity:rendered-count`, "-", "faq-rendered-count-mismatch");
  } else if (
    !renderedFaq.every((entry, index) => {
      const canonical = doc.visibleFaq[index];
      return canonical
        && normalizeText(entry.question) === normalizeText(canonical.question)
        && normalizeText(entry.answerText) === normalizeText(canonical.answerText);
    })
  ) {
    push("faq-parity", `faq-parity:rendered-text`, "-", "faq-rendered-text-mismatch");
  }
  const expectedSchema = fingerprintHtml(renderFaqSchema(doc.visibleFaq));
  if (doc.visibleFaq.length > 0 && (!doc.faqSchema || fingerprintHtml(doc.faqSchema.html) !== expectedSchema)) {
    push("faq-parity", `faq-parity:canonical-schema`, "-", "faq-canonical-schema-mismatch");
  }

  const links = collectLinkDestinations(html).join("|");
  push("links", `links:${links}`, "-", "link-destinations");

  push(
    "protected-content",
    `protected:switcher=${fingerprintHtml(doc.languageSwitcher?.html ?? "")}`,
    "-",
    "language-switcher",
  );
  push("protected-content", `protected:cta=${fingerprintHtml(doc.cta?.html ?? "")}`, "-", "cta");
  push(
    "protected-content",
    `protected:faq-schema=${doc.faqSchema ? fingerprintHtml(doc.faqSchema.html) : "none"}`,
    "-",
    "faq-schema",
  );

  const seoMetrics = canonicalKeyphraseMetrics(doc, ctx.keyphrase);
  push("seo", `seo:occ=${seoMetrics.occurrences}`, "-", `keyphrase-occurrences=${seoMetrics.occurrences}`);

  return keys;
}

function diffBlocks(pre: ArticleDocument, post: ArticleDocument): TraceBlockChange[] {
  const changes: TraceBlockChange[] = [];

  const components: Array<{ id: string; pre: EditorialBlock[]; post: EditorialBlock[] }> = [
    { id: pre.introduction.id, pre: pre.introduction.blocks, post: post.introduction.blocks },
  ];
  const preSections = new Map(pre.sections.map((section) => [section.id, section]));
  const postSections = new Map(post.sections.map((section) => [section.id, section]));
  for (const [sectionId, preSection] of preSections) {
    const postSection = postSections.get(sectionId);
    components.push({
      id: sectionId,
      pre: preSection.blocks,
      post: postSection ? postSection.blocks : [],
    });
  }
  for (const [sectionId, postSection] of postSections) {
    if (!preSections.has(sectionId)) {
      components.push({ id: sectionId, pre: [], post: postSection.blocks });
    }
  }
  components.push({ id: pre.conclusion.id, pre: pre.conclusion.blocks, post: post.conclusion.blocks });

  for (const component of components) {
    const preById = new Map(component.pre.map((block) => [block.id, block]));
    const postById = new Map(component.post.map((block) => [block.id, block]));
    for (const [blockId, preBlock] of preById) {
      const postBlock = postById.get(blockId);
      if (!postBlock) {
        changes.push({
          componentId: component.id,
          blockId,
          reason: "removed-block",
          before: snippet(plainBlockText(preBlock)),
          after: "",
        });
        continue;
      }
      const before = plainBlockText(preBlock);
      const after = plainBlockText(postBlock);
      if (normalizeText(before) !== normalizeText(after)) {
        changes.push({
          componentId: component.id,
          blockId,
          reason: "text-changed",
          before: snippet(before),
          after: snippet(after),
        });
      }
    }
    for (const [blockId, postBlock] of postById) {
      if (!preById.has(blockId)) {
        changes.push({
          componentId: component.id,
          blockId,
          reason: "added-block",
          before: "",
          after: snippet(plainBlockText(postBlock)),
        });
      }
    }
  }
  return changes;
}

function keyOf(violation: TraceViolationKey): string {
  return `${violation.category}:${violation.key}`;
}

/** Deterministic compact console emitter. Observational only. */
function emit(line: string): void {
  console.log(`[debug-trace] ${line}`);
}

function sortKeys(keys: TraceViolationKey[]): TraceViolationKey[] {
  return [...keys].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/**
 * Per-pipeline-run trace collector. Attached to PipelineState when the env
 * flag is enabled; every method is a safe no-op guard (the collector itself is
 * only created when tracing is on). Never mutates the pipeline state.
 */
export class PipelineDebugTrace {
  private records: TraceStageRecord[] = [];
  private current: {
    record: TraceStageRecord;
    preDoc: ArticleDocument;
  } | null = null;
  private firstSeen = new Map<string, string>();
  private snapshotRing: Array<{ stage: string; articleDoc: string }> = [];

  /** Bounded in-memory pre-stage snapshots for backward tracing. */
  recentSnapshots(): Array<{ stage: string; articleDoc: string }> {
    return [...this.snapshotRing];
  }

  recordsFor(stage?: string): TraceStageRecord[] {
    return stage ? this.records.filter((record) => record.stage === stage) : [...this.records];
  }

  beginStage(stage: string, preDocJson: string, ctx: TraceContext): void {
    const preDoc = JSON.parse(preDocJson) as ArticleDocument;
    this.current = {
      preDoc,
      record: {
        stage,
        pre: metricsFor(preDoc, ctx.keyphrase),
        post: { fp: "", wordCount: 0, occurrences: 0, density: 0 },
        preViolations: violationsFor(preDoc, ctx),
        postViolations: [],
        introduced: [],
        resolved: [],
        firstIntroduced: [],
        changedBlocks: [],
        accepted: true,
        rollback: false,
      },
    };
    this.snapshotRing.push({ stage, articleDoc: preDocJson });
    if (this.snapshotRing.length > MAX_SNAPSHOTS) this.snapshotRing.shift();
  }

  /** Attach a successful/owned contract result to the current stage; emitted
   *  when the stage ends normally. */
  recordContract(label: string, valid: boolean, violations: string[], owned: string[]): void {
    if (!this.current) return;
    this.current.record.contract = { label, valid, violations, owned };
  }

  /** Finalize the current stage immediately after a contract REJECTION: the
   *  pipeline throws right after, so no endStage will follow. Computes the
   *  introduced violations from the rejected candidate BEFORE rollback and
   *  marks rollback=true so the trace names the first corrupting stage. */
  rejectContract(
    label: string,
    violations: string[],
    owned: string[],
    postDoc: ArticleDocument,
    ctx: TraceContext,
  ): void {
    if (!this.current) return;
    const record = this.current.record;
    record.contract = { label, valid: false, violations, owned };
    record.post = metricsFor(postDoc, ctx.keyphrase);
    record.postViolations = violationsFor(postDoc, ctx);
    record.changedBlocks = diffBlocks(this.current.preDoc, postDoc)
      .sort((a, b) => `${a.componentId}/${a.blockId}`.localeCompare(`${b.componentId}/${b.blockId}`));
    record.accepted = false;
    record.rollback = true;

    const preKeys = new Set(record.preViolations.map(keyOf));
    const postKeys = new Set(record.postViolations.map(keyOf));
    record.introduced = sortKeys(record.postViolations.filter((v) => !preKeys.has(keyOf(v))));
    record.resolved = sortKeys(record.preViolations.filter((v) => !postKeys.has(keyOf(v))));
    for (const violation of record.introduced) {
      if (!this.firstSeen.has(keyOf(violation))) {
        this.firstSeen.set(keyOf(violation), label);
        record.firstIntroduced.push(violation);
      }
    }
    this.emitRecord(record);
    this.records.push(record);
    this.current = null;
  }

  endStage(stage: string, postDoc: ArticleDocument, ctx: TraceContext, accepted: boolean, rollback: boolean): void {
    if (!this.current || this.current.record.stage !== stage) return;
    const record = this.current.record;
    record.post = metricsFor(postDoc, ctx.keyphrase);
    record.postViolations = violationsFor(postDoc, ctx);
    record.changedBlocks = diffBlocks(this.current.preDoc, postDoc)
      .sort((a, b) => `${a.componentId}/${a.blockId}`.localeCompare(`${b.componentId}/${b.blockId}`));
    record.accepted = accepted;
    record.rollback = rollback;

    const preKeys = new Set(record.preViolations.map(keyOf));
    const postKeys = new Set(record.postViolations.map(keyOf));
    record.introduced = sortKeys(record.postViolations.filter((v) => !preKeys.has(keyOf(v))));
    record.resolved = sortKeys(record.preViolations.filter((v) => !postKeys.has(keyOf(v))));
    for (const violation of record.introduced) {
      if (!this.firstSeen.has(keyOf(violation))) {
        this.firstSeen.set(keyOf(violation), stage);
        record.firstIntroduced.push(violation);
      }
    }

    this.emitRecord(record);
    this.records.push(record);
    this.current = null;
  }

  private emitRecord(record: TraceStageRecord): void {
    const pre = record.pre;
    const post = record.post;
    emit(
      `stage=${record.stage}` +
      ` fp=${pre.fp}→${post.fp}` +
      ` wc=${pre.wordCount}→${post.wordCount}` +
      ` kp=${pre.occurrences}→${post.occurrences}` +
      ` density=${pre.density.toFixed(2)}%→${post.density.toFixed(2)}%` +
      ` accepted=${record.accepted} rollback=${record.rollback}`,
    );
    for (const change of record.changedBlocks) {
      emit(
        `  changed ${change.componentId}/${change.blockId}` +
        ` reason=${change.reason}` +
        ` before="${change.before}" after="${change.after}"`,
      );
    }
    for (const violation of record.introduced) {
      emit(`  introduced ${violation.category}:${violation.key}`);
    }
    for (const violation of record.resolved) {
      emit(`  resolved ${violation.category}:${violation.key}`);
    }
    for (const violation of record.firstIntroduced) {
      emit(`firstIntroduced=${record.stage} ${violation.blockRef} ${violation.type}`);
    }
    if (record.contract) {
      emit(
        `contract=${record.contract.label}` +
        ` valid=${record.contract.valid}` +
        ` violations=[${record.contract.violations.join("; ")}]` +
        ` owned=[${record.contract.owned.join("; ")}]` +
        ` rollback=${record.rollback}`,
      );
    }
  }
}

/** Observational context builder used by pipeline hooks. */
export function traceContextFor(state: { keyphrase: string; ctx?: { research?: unknown[]; claimOwnership?: ClaimOwnershipLedger } }): TraceContext {
  return {
    keyphrase: state.keyphrase,
    research: (state.ctx?.research as Array<{ title?: string; snippet?: string; url?: string }>) ?? [],
    ledger: state.ctx?.claimOwnership,
  };
}
