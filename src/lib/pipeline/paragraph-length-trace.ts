// ── Stage 3L: paragraph-length observability (diagnostic-only) ──
// Defines ONE shared diagnostic measurement built on the authoritative
// `analyzeFinalArticle` (no duplicated paragraph-count logic), a stage trace
// recorded at every post-seo commit boundary when ENABLE_PIPELINE_DEBUG_TRACE
// is set, and best-effort rendered-<p> → canonical block identity mapping.
//
// NO behavior change: this module never rejects, rolls back, or alters the
// document; it only measures, maps, logs and records. Recording and logging
// are fully gated on the pipeline debug flag, so default production behavior
// is byte-identical.

import {
  analyzeFinalArticle,
} from "@/lib/blog/final-article-policy";
import {
  extractParagraphTexts,
  countSentences,
  splitSentences,
} from "@/lib/seo/seo-text-utils";
import {
  renderComponentHtml,
  fingerprintHtml,
  countCanonicalVisibleWords,
  type ArticleDocument,
} from "@/lib/blog/article-document";
import { paragraphSentenceLimit } from "@/lib/content-standards";
import { isPipelineDebugTraceEnabled } from "@/lib/pipeline/pipeline-debug-trace";

const TRACE_TAG = "[paragraph-length-trace]";
const SNIPPET_LENGTH = 180;
const MAX_PARAGRAPHS_PER_COMPONENT = 200;

// ── Diagnostics shapes ──

export interface LongParagraphDiagnostic {
  /** Index of the paragraph among ALL rendered <p> paragraphs. */
  index: number;
  text: string;
  sentences: number;
  /** Short stable fingerprint of the paragraph text. */
  fp: string;
  /** Canonical component id when identity mapping succeeded. */
  componentId?: string;
  /** Canonical block id when identity mapping succeeded uniquely. */
  blockId?: string;
  /** Canonical block candidates when mapping is ambiguous. */
  candidates: string[];
  /** Heading of the nearest owning component (H2 context). */
  nearestHeading?: string;
}

export interface ParagraphLengthStageRecord {
  stage: string;
  count: number;
  /** Document fingerprint (fingerprintHtml of the rendered html). */
  fingerprint: string;
  /** True when the count differs from the previous recorded stage. */
  changed: boolean;
  /** Set exactly once, on the first observed 0→1 transition. */
  firstIntroduction?: {
    beforeText: string;
    afterText: string;
  };
}

export interface ParagraphLengthDiagnostics {
  longParagraphCount: number;
  paragraphs: LongParagraphDiagnostic[];
  fingerprint: string;
}

// ── Internal per-stage paragraph snapshot (for before/after diffing) ──

interface InternalParagraphSnapshot {
  index: number;
  text: string;
  fp: string;
  sentences: number;
  blockId?: string;
  componentId?: string;
}

interface InternalStageSnapshot {
  stage: string;
  count: number;
  fingerprint: string;
  changed: boolean;
  firstIntroduction?: { beforeText: string; afterText: string };
  paragraphs: InternalParagraphSnapshot[];
}

// ── Helpers ──

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function bounded(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/"/g, "'").slice(0, SNIPPET_LENGTH);
}

interface CanonicalParagraphRef {
  componentId: string;
  blockId: string;
  text: string;
  fp: string;
  nearestHeading?: string;
}

function buildCanonicalParagraphRegistry(doc: ArticleDocument): CanonicalParagraphRef[] {
  const refs: CanonicalParagraphRef[] = [];
  const pushComponent = (
    componentId: string,
    blocks: ArticleDocument["introduction"]["blocks"],
    heading?: string,
  ): void => {
    for (const block of blocks) {
      if (block.type !== "paragraph") continue;
      const html = renderComponentHtml({
        id: componentId,
        blocks: [block],
        status: "normalized",
      });
      const text = extractParagraphTexts(html).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      refs.push({ componentId, blockId: block.id, text, fp: shortHash(text), nearestHeading: heading });
      if (refs.length >= MAX_PARAGRAPHS_PER_COMPONENT) break;
    }
  };
  pushComponent(doc.introduction.id, doc.introduction.blocks);
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading") continue;
    pushComponent(section.id, section.blocks, section.heading);
  }
  pushComponent(doc.conclusion.id, doc.conclusion.blocks);
  return refs;
}

interface BlockIdentity {
  componentId?: string;
  blockId?: string;
  candidates: string[];
  nearestHeading?: string;
}

/** Diagnostic-only rendered-<p> → canonical block mapping. Exact normalized
 *  text match first, then first-sentence match, then candidates by overlap. */
function mapRenderedParagraphToBlock(
  renderedText: string,
  refs: CanonicalParagraphRef[],
): BlockIdentity {
  const normalized = renderedText.replace(/\s+/g, " ").trim();
  const exact = refs.filter((ref) => ref.text === normalized);
  if (exact.length === 1) {
    return {
      componentId: exact[0].componentId,
      blockId: exact[0].blockId,
      candidates: [],
      nearestHeading: exact[0].nearestHeading,
    };
  }
  if (exact.length > 1) {
    return {
      candidates: exact.map((ref) => `${ref.componentId}/${ref.blockId}`),
      nearestHeading: exact[0].nearestHeading,
    };
  }
  const firstSentence = splitSentences(normalized)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (firstSentence) {
    const byFirstSentence = refs.filter((ref) => ref.text.startsWith(firstSentence));
    if (byFirstSentence.length === 1) {
      return {
        componentId: byFirstSentence[0].componentId,
        blockId: byFirstSentence[0].blockId,
        candidates: [],
        nearestHeading: byFirstSentence[0].nearestHeading,
      };
    }
    if (byFirstSentence.length > 1) {
      return {
        candidates: byFirstSentence.map((ref) => `${ref.componentId}/${ref.blockId}`),
        nearestHeading: byFirstSentence[0].nearestHeading,
      };
    }
  }
  return { candidates: [], nearestHeading: undefined };
}

// ── Public measurement (authoritative analyzeFinalArticle count) ──

export function measureParagraphLengthDiagnostics(
  html: string,
  doc?: ArticleDocument,
  keyphrase = "",
  title?: string,
  metaDescription?: string,
  requestedWordCount?: number,
): ParagraphLengthDiagnostics {
  const metrics = analyzeFinalArticle(
    html,
    keyphrase,
    title,
    metaDescription,
    requestedWordCount,
    doc ? countCanonicalVisibleWords(doc) : undefined,
  );
  const refs = doc ? buildCanonicalParagraphRegistry(doc) : [];
  const paraTexts = extractParagraphTexts(html);
  const maxSentences = paragraphSentenceLimit();
  const paragraphs: LongParagraphDiagnostic[] = [];
  for (let index = 0; index < paraTexts.length; index++) {
    const text = paraTexts[index];
    const sentences = countSentences(text);
    if (sentences <= maxSentences) continue;
    const mapped = mapRenderedParagraphToBlock(text, refs);
    paragraphs.push({
      index,
      text,
      sentences,
      fp: shortHash(text),
      componentId: mapped.componentId,
      blockId: mapped.blockId,
      candidates: mapped.candidates,
      nearestHeading: mapped.nearestHeading,
    });
  }
  return {
    longParagraphCount: metrics.longParagraphCount,
    paragraphs,
    fingerprint: fingerprintHtml(html),
  };
}

// ── Stage trace (debug-gated) ──

const stageSnapshots: InternalStageSnapshot[] = [];

/** Copy of the recorded stage trace (for the final-validation snapshot). */
export function paragraphLengthStageTrace(): ParagraphLengthStageRecord[] {
  return stageSnapshots.map((snapshot) => ({
    stage: snapshot.stage,
    count: snapshot.count,
    fingerprint: snapshot.fingerprint,
    changed: snapshot.changed,
    ...(snapshot.firstIntroduction ? { firstIntroduction: snapshot.firstIntroduction } : {}),
  }));
}

/** Reset the stage trace (test isolation / debug-run boundaries). */
export function resetParagraphLengthTrace(): void {
  stageSnapshots.length = 0;
}

/** Record the long-paragraph state after one committed pipeline stage.
 *  Logs only when the count is non-zero OR changed, and records the first
 *  observed 0→1 transition with before/after paragraph text. Never throws. */
export function recordParagraphLengthStage(record: {
  stage: string;
  html: string;
  doc?: ArticleDocument;
  keyphrase?: string;
  title?: string;
  metaDescription?: string;
  requestedWordCount?: number;
}): void {
  if (!isPipelineDebugTraceEnabled()) return;
  try {
    const current = measureParagraphLengthDiagnostics(
      record.html,
      record.doc,
      record.keyphrase ?? "",
      record.title,
      record.metaDescription,
      record.requestedWordCount,
    );
    const previous = stageSnapshots[stageSnapshots.length - 1];
    // The FIRST observation is a BASELINE of the pre-existing state — never a
    // "0→N" introduction. A pre-existing long paragraph set (e.g. 23) is
    // recorded as baseline=23, so an unchanged stage can never be reported as
    // the first introduction (Stage 3M).
    const isBaseline = previous === undefined;
    const previousCount = previous?.count ?? 0;
    const changed = previous ? current.longParagraphCount !== previous.count : false;
    const firstIntroduction =
      previous && changed && current.longParagraphCount > previous.count
        ? (() => {
          const afterParagraph = current.paragraphs[0];
          const afterText = afterParagraph?.text ?? "";
          const beforeParagraph = previous.paragraphs.find(
            (para) =>
              (afterParagraph?.blockId && para.blockId === afterParagraph.blockId)
              || (afterParagraph && para.fp === afterParagraph.fp),
          );
          const beforeText = beforeParagraph?.text
            ?? (afterParagraph
              ? splitSentences(afterText)[0] ?? afterText
              : "");
          return { beforeText, afterText };
        })()
        : undefined;

    const refs = record.doc ? buildCanonicalParagraphRegistry(record.doc) : [];
    const snapshot: InternalStageSnapshot = {
      stage: record.stage,
      count: current.longParagraphCount,
      fingerprint: current.fingerprint,
      changed,
      ...(firstIntroduction ? { firstIntroduction } : {}),
      paragraphs: extractParagraphTexts(record.html).map((text, index) => {
        const mapped = mapRenderedParagraphToBlock(text, refs);
        return {
          index,
          text,
          fp: shortHash(text),
          sentences: countSentences(text),
          blockId: mapped.blockId,
          componentId: mapped.componentId,
        };
      }),
    };
    stageSnapshots.push(snapshot);

    if (current.longParagraphCount !== 0 || changed) {
      if (isBaseline) {
        console.warn(
          `${TRACE_TAG} baseline stage=${record.stage}` +
          ` count=baseline:${current.longParagraphCount} fp=${current.fingerprint}`,
        );
      } else {
        for (const paragraph of current.paragraphs) {
          console.warn(
            `${TRACE_TAG} stage=${record.stage} count=${previousCount}→${current.longParagraphCount}` +
            ` block=${paragraph.blockId ?? "unknown"} component=${paragraph.componentId ?? "-"}` +
            ` sentences=${paragraph.sentences} fp=${paragraph.fp}`,
          );
        }
        if (firstIntroduction) {
          console.warn(
            `${TRACE_TAG} first-0→1 stage=${record.stage}` +
            ` before="${bounded(firstIntroduction.beforeText)}"` +
            ` after="${bounded(firstIntroduction.afterText)}"`,
          );
        }
      }
    }
  } catch (error) {
    console.warn(
      `${TRACE_TAG} measurement failed at stage=${record.stage}` +
      ` — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Convenience: rendered-html fingerprint for a document (used by snapshots). */
export function paragraphTraceFingerprint(html: string): string {
  return fingerprintHtml(html);
}
