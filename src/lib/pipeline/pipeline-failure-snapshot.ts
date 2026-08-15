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
