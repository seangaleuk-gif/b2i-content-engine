// ── Quarantined integrity-rejection failure snapshots ──
//
// When ENABLE_PIPELINE_DEBUG_TRACE=true, every integrity-contract REJECTION
// writes a diagnostic JSON artifact to:
//
//   debug/pipeline-failures/<timestamp>_<stage>_project-<id>.json
//
// The artifact captures the rejected candidate BEFORE rollback destroys it,
// along with the pre-stage document, contract violations, metrics, changed
// blocks and the debug tracer's first-introduced attribution. It is purely
// diagnostic: the rejected document is never written to blog_versions or any
// normal project content, and a failed snapshot write only logs a warning —
// it can never mask the original integrity failure or change generation
// behaviour. Retention keeps only the newest 30 artifacts.
//
// No scanner logic lives here: all violation/malformed/coherence/factual/
// ownership/SEO/link/protected-content deltas come from the PipelineDebugTrace
// record that rejectContract() already produced for the same rejected
// candidate, so there is exactly one scanner, never a duplicate.

import * as fs from "fs";
import * as path from "path";
import { renderArticleDocument, fingerprintHtml, countCanonicalVisibleWords } from "@/lib/blog/article-document";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderEditorialBlocksToWordPress } from "@/lib/blog/article-content";
import type { EditorialBlock } from "@/lib/blog/article-document";
import { canonicalKeyphraseMetrics } from "@/lib/blog/final-seo-reconcile";
import { GENERATION_BUILD_ID } from "@/lib/services/generation-constants";
import {
  PipelineDebugTrace,
  isPipelineDebugTraceEnabled,
  type TraceViolationKey,
  type TraceBlockChange,
} from "@/lib/pipeline/pipeline-debug-trace";

/** Build identifier embedded in every artifact — the SAME production English
 *  pipeline build id referenced by the generation/pipeline logs. Reused from
 *  generation-constants, never maintained a second time here. */
export const PIPELINE_BUILD_IDENTIFIER = GENERATION_BUILD_ID;

/** Default quarantine directory relative to the project root. */
export const DEFAULT_FAILURE_DIR = path.join("debug", "pipeline-failures");

/** Newest artifacts retained per directory; older files are deleted. */
export const MAX_RETAINED_FAILURE_SNAPSHOTS = 30;

export interface IntegrityRejectionSnapshotInput {
  projectId: string;
  stage: string;
  /** Pre-stage ArticleDocument (already parsed from the snapshot). */
  previous: ArticleDocument;
  /** The REJECTED candidate, captured BEFORE restore/rollback. */
  rejected: ArticleDocument;
  violations: string[];
  ownedViolations: string[];
  /** Keyphrase used for density metrics (only used when the tracer record is
   *  unavailable; the tracer's own metrics are preferred). */
  keyphrase?: string;
  /** Optional debug tracer whose finalized record is the single source of
   *  violation/malformed/coherence/factual/SEO/link/protected-content deltas. */
  trace?: PipelineDebugTrace;
  /** Override for the output directory (tests use a temp dir). */
  dir?: string;
}

export interface IntegrityRejectionSnapshotArtifact {
  schema: "pipeline-failure-snapshot/v1";
  timestamp: string;
  build: string;
  projectId: string;
  stage: string;
  contract: {
    label: string;
    valid: false;
    violations: string[];
    ownedViolations: string[];
  };
  rollback: {
    action: "restore-snapshot";
    /** "pending" until restoreSnapshot completes; updated best-effort to
     *  "success" afterwards (or "failed" when rollback itself threw). */
    result: "pending" | "success" | "failed";
  };
  fingerprints: { pre: string; post: string };
  wordCount: { pre: number; post: number };
  keyphrase: {
    pre: { occurrences: number; density: number };
    post: { occurrences: number; density: number };
  };
  changedBlocks: TraceBlockChange[];
  firstIntroduced: TraceViolationKey[];
  deltas: Record<string, { introduced: string[]; resolved: string[] }>;
  documents: {
    preStage: ArticleDocument;
    rejectedCandidate: ArticleDocument;
  };
}

function groupDeltas(introduced: TraceViolationKey[], resolved: TraceViolationKey[]): Record<string, { introduced: string[]; resolved: string[] }> {
  const deltas: Record<string, { introduced: string[]; resolved: string[] }> = {};
  for (const violation of introduced) {
    const bucket = (deltas[violation.category] ??= { introduced: [], resolved: [] });
    bucket.introduced.push(violation.key);
  }
  for (const violation of resolved) {
    const bucket = (deltas[violation.category] ??= { introduced: [], resolved: [] });
    bucket.resolved.push(violation.key);
  }
  return deltas;
}

function sanitizeFilenamePart(value: string): string {
  return String(value ?? "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Build the full artifact object. Reuses the trace record (pre/post metrics,
 *  changed blocks, introduced/resolved/present/first-introduced, contract)
 *  when the tracer is present; metrics are otherwise computed with the same
 *  canonical helpers the tracer uses — never a second scanner. */
export function buildIntegrityRejectionSnapshot(input: IntegrityRejectionSnapshotInput): IntegrityRejectionSnapshotArtifact {
  const timestamp = new Date().toISOString();
  const record = input.trace?.recordsFor(input.stage)[0];
  const keyphrase = input.keyphrase ?? "";
  const preMetrics = record
    ? { fp: record.pre.fp, wordCount: record.pre.wordCount, occurrences: record.pre.occurrences, density: record.pre.density }
    : (() => {
      const html = renderArticleDocument(input.previous);
      const kp = canonicalKeyphraseMetrics(input.previous, keyphrase);
      return {
        fp: fingerprintHtml(html),
        wordCount: countCanonicalVisibleWords(input.previous),
        occurrences: kp.occurrences,
        density: kp.density,
      };
    })();
  const postMetrics = record
    ? { fp: record.post.fp, wordCount: record.post.wordCount, occurrences: record.post.occurrences, density: record.post.density }
    : (() => {
      const html = renderArticleDocument(input.rejected);
      const kp = canonicalKeyphraseMetrics(input.rejected, keyphrase);
      return {
        fp: fingerprintHtml(html),
        wordCount: countCanonicalVisibleWords(input.rejected),
        occurrences: kp.occurrences,
        density: kp.density,
      };
    })();

  return {
    schema: "pipeline-failure-snapshot/v1",
    timestamp,
    build: PIPELINE_BUILD_IDENTIFIER,
    projectId: input.projectId,
    stage: input.stage,
    contract: {
      label: input.stage,
      valid: false,
      violations: [...input.violations],
      ownedViolations: [...input.ownedViolations],
    },
    rollback: {
      action: "restore-snapshot",
      result: "pending",
    },
    fingerprints: { pre: preMetrics.fp, post: postMetrics.fp },
    wordCount: { pre: preMetrics.wordCount, post: postMetrics.wordCount },
    keyphrase: {
      pre: { occurrences: preMetrics.occurrences, density: preMetrics.density },
      post: { occurrences: postMetrics.occurrences, density: postMetrics.density },
    },
    changedBlocks: record ? [...record.changedBlocks] : [],
    firstIntroduced: record ? [...record.firstIntroduced] : [],
    deltas: groupDeltas(
      record ? record.introduced : [],
      record ? record.resolved : [],
    ),
    documents: {
      preStage: JSON.parse(JSON.stringify(input.previous)) as ArticleDocument,
      rejectedCandidate: JSON.parse(JSON.stringify(input.rejected)) as ArticleDocument,
    },
  };
}

/** Delete all but the newest maxFiles *.json snapshots in dir. Best-effort:
 *  failures to read the directory or remove a file are ignored. Returns the
 *  number of files removed. */
export function retainNewestFailureSnapshots(dir: string, maxFiles: number = MAX_RETAINED_FAILURE_SNAPSHOTS): number {
  if (maxFiles <= 0) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return 0;
  }
  // ISO timestamps sort lexicographically; newest first.
  entries.sort().reverse();
  let removed = 0;
  for (const name of entries.slice(maxFiles)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed++;
    } catch {
      // best-effort retention never throws into generation
    }
  }
  return removed;
}

/** Persist the artifact to debug/pipeline-failures/. Returns the written file
 *  path, or null when the trace flag is disabled or persistence failed (the
 *  failure is logged as a warning and never masks the original error). */
export function captureIntegrityRejection(input: IntegrityRejectionSnapshotInput): string | null {
  if (!isPipelineDebugTraceEnabled()) return null;
  const dir = input.dir ?? DEFAULT_FAILURE_DIR;
  try {
    const artifact = buildIntegrityRejectionSnapshot(input);
    const filename =
      `${timestampForFilename(new Date())}_${sanitizeFilenamePart(input.stage)}_project-${sanitizeFilenamePart(input.projectId)}.json`;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf8");
    retainNewestFailureSnapshots(dir, MAX_RETAINED_FAILURE_SNAPSHOTS);
    console.warn(`[pipeline-failure-snapshot] quarantine written: ${filePath}`);
    return filePath;
  } catch (error) {
    console.warn(
      `[pipeline-failure-snapshot] failed to persist quarantine artifact for stage=${input.stage}` +
      ` project=${input.projectId} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Best-effort patch of an already-persisted artifact's rollback result after
 *  restoreSnapshot completes. Reads the file, sets rollback.result and writes
 *  it back. ANY failure only logs a warning — it can never mask the original
 *  integrity-contract error, and a failure to update leaves the diagnostic
 *  artifact intact. */
export function updateIntegrityRejectionRollback(
  filePath: string,
  result: "success" | "failed",
): boolean {
  try {
    const artifact = JSON.parse(fs.readFileSync(filePath, "utf8")) as IntegrityRejectionSnapshotArtifact;
    artifact.rollback.result = result;
    fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf8");
    return true;
  } catch (error) {
    console.warn(
      `[pipeline-failure-snapshot] failed to record rollback result="${result}" on ${filePath}` +
      ` — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ── Producer-level component failure quarantine ──
//
// The integrity-rejection snapshots above capture failures of the post-assembly
// pipeline, where a full canonical ArticleDocument already exists. Generation-
// stage producer failures (a generated/repaired editorial component that fails
// deterministic acceptance, e.g. section_2_repair throwing
// "Block 6 paragraph: sentence-like unit has no finite predicate") happen
// BEFORE any full document is assembled, so they were previously invisible to
// this system and the failing candidate's text was lost.
//
// When ENABLE_PIPELINE_DEBUG_TRACE=true, captureProducerComponentFailure writes
// the SAME quarantine format into the SAME debug/pipeline-failures/ directory,
// preserving (debug mode only): project/build, component id + heading,
// generation-vs-repair attempt, the exact normalized candidate blocks, the
// exact failing block indexes + offending text + violation type/message, a
// candidate fingerprint, and the relevant pre-repair text when available. It is
// purely diagnostic — never written to blog_versions/project content — and a
// write failure only logs a warning. Retention reuses the same cap.

export interface ProducerBlockViolation {
  /** Raw block index from the error label ("Block 6 ..." → 6). -1 when the
   *  error is not a per-block label. */
  blockIndex: number;
  /** Block type from the label ("paragraph", "list item 3", ...). */
  blockType: string;
  /** The full deterministic acceptance message after the label. */
  message: string;
  /** Best-effort offending text extracted from the raw candidate payload. */
  text?: string;
}

export interface ProducerComponentFailureInput {
  projectId: string;
  /** Debug stage label, e.g. "section_2_repair", "intro_repair". */
  stage: string;
  /** Canonical component id, e.g. "section-2", "intro", "conclusion". */
  componentId: string;
  /** H2 heading for a section; omitted for components with no heading. */
  heading?: string;
  attempt: "generation" | "repair";
  /** The raw JSON payload of the failing candidate (repaired attempt). */
  rawCandidate?: unknown;
  /** The exact normalized candidate blocks produced by normalizeAiEditorialPayload. */
  blocks: EditorialBlock[];
  errors: string[];
  recoveries?: string[];
  /** The prior generation attempt (the "pre-repair text") when available. */
  preRepair?: { rawCandidate?: unknown; blocks: EditorialBlock[] };
  /** Override for the output directory (tests use a temp dir). */
  dir?: string;
}

export interface ProducerComponentFailureArtifact {
  schema: "producer-component-failure/v1";
  timestamp: string;
  build: string;
  projectId: string;
  stage: string;
  componentId: string;
  heading?: string;
  attempt: "generation" | "repair";
  candidateFingerprint: string;
  violations: ProducerBlockViolation[];
  errors: string[];
  recoveries: string[];
  blocks: EditorialBlock[];
  preRepair?: { fingerprint: string; blocks: EditorialBlock[] };
  rawCandidate?: unknown;
}

const BLOCK_ERROR_LABEL_RE = /^Block (\d+)\s+([^:]+):\s*([\s\S]*)$/;

/** Best-effort text of a raw editorial block by the index used in error labels. */
function blockTextFromRaw(rawCandidate: unknown, blockIndex: number): string | undefined {
  let block: unknown;
  if (rawCandidate && typeof rawCandidate === "object" && !Array.isArray(rawCandidate)) {
    const obj = rawCandidate as Record<string, unknown>;
    if (!Array.isArray(obj.blocks)) return undefined;
    block = obj.blocks[blockIndex];
  } else if (Array.isArray(rawCandidate)) {
    block = rawCandidate[blockIndex];
  } else {
    return undefined;
  }
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const rb = block as Record<string, unknown>;
  if (typeof rb.text === "string") return rb.text;
  if (typeof rb.item === "string") return rb.item;
  if (Array.isArray(rb.items)) {
    const joined = rb.items
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean)
      .join(" | ");
    return joined || undefined;
  }
  return undefined;
}

/** Parse the "Block 6 paragraph: <message>" acceptance labels into structured
 *  per-block diagnostics, attaching the offending text from the raw payload. */
export function parseProducerBlockViolations(
  errors: string[],
  rawCandidate?: unknown,
): ProducerBlockViolation[] {
  return (errors ?? []).map((error) => {
    const match = error.match(BLOCK_ERROR_LABEL_RE);
    if (!match) {
      return { blockIndex: -1, blockType: "", message: error, text: blockTextFromRaw(rawCandidate, -1) };
    }
    const blockIndex = Number(match[1]);
    const blockType = match[2].trim();
    const message = match[3].trim();
    return { blockIndex, blockType, message, text: blockTextFromRaw(rawCandidate, blockIndex) };
  });
}

function componentFingerprint(blocks: EditorialBlock[], rawCandidate?: unknown): string {
  if (blocks.length > 0) return fingerprintHtml(renderEditorialBlocksToWordPress(blocks));
  return fingerprintHtml(JSON.stringify(rawCandidate ?? ""));
}

/** Persist a producer-level component failure artifact to debug/pipeline-failures/
 *  when the debug trace flag is enabled. Returns the written path or null (a
 *  write failure only logs a warning — it never masks the original producer
 *  error or changes generation behaviour). */
export function captureProducerComponentFailure(input: ProducerComponentFailureInput): string | null {
  if (!isPipelineDebugTraceEnabled()) return null;
  const dir = input.dir ?? DEFAULT_FAILURE_DIR;
  try {
    const blocks = input.blocks ?? [];
    const artifact: ProducerComponentFailureArtifact = {
      schema: "producer-component-failure/v1",
      timestamp: new Date().toISOString(),
      build: PIPELINE_BUILD_IDENTIFIER,
      projectId: input.projectId,
      stage: input.stage,
      componentId: input.componentId,
      heading: input.heading,
      attempt: input.attempt,
      candidateFingerprint: componentFingerprint(blocks, input.rawCandidate),
      violations: parseProducerBlockViolations(input.errors, input.rawCandidate),
      errors: [...(input.errors ?? [])],
      recoveries: [...(input.recoveries ?? [])],
      blocks,
      preRepair: input.preRepair
        ? {
            fingerprint: componentFingerprint(input.preRepair.blocks, input.preRepair.rawCandidate),
            blocks: input.preRepair.blocks ?? [],
          }
        : undefined,
      rawCandidate: input.rawCandidate !== undefined
        ? JSON.parse(JSON.stringify(input.rawCandidate))
        : undefined,
    };
    const filename =
      `${timestampForFilename(new Date())}_producer-${sanitizeFilenamePart(input.stage)}` +
      `_project-${sanitizeFilenamePart(input.projectId)}.json`;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf8");
    retainNewestFailureSnapshots(dir, MAX_RETAINED_FAILURE_SNAPSHOTS);
    console.warn(`[pipeline-failure-snapshot] producer component failure quarantined: ${filePath}`);
    return filePath;
  } catch (error) {
    console.warn(
      `[pipeline-failure-snapshot] failed to persist producer component failure for stage=${input.stage}` +
      ` project=${input.projectId} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
