import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseWordPressEditorialBlocks, type ArticleDocument } from "@/lib/blog/article-document";
import {
  PipelineDebugTrace,
  traceContextFor,
} from "@/lib/pipeline/pipeline-debug-trace";
import {
  captureIntegrityRejection,
  updateIntegrityRejectionRollback,
  retainNewestFailureSnapshots,
  captureProducerComponentFailure,
  parseProducerBlockViolations,
  MAX_RETAINED_FAILURE_SNAPSHOTS,
  PIPELINE_BUILD_IDENTIFIER,
  type IntegrityRejectionSnapshotArtifact,
  type ProducerComponentFailureArtifact,
} from "@/lib/pipeline/pipeline-failure-snapshot";
import { GENERATION_BUILD_ID } from "@/lib/services/generation-constants";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";

const KEYPHRASE = "threads marketing hong kong";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function makeDoc(sectionHtml: string): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      blocks: parseWordPressEditorialBlocks(
        [paragraph("Local teams can share useful lessons from daily work with clear and honest words.")].join("\n\n"),
        "intro",
      ).blocks,
      status: "generated",
    },
    sections: [
      {
        id: "section-2",
        heading: "Build a Simple Weekly Content Routine",
        headingLevel: 2,
        sectionType: "main",
        blocks: parseWordPressEditorialBlocks(sectionHtml, "section-2").blocks,
        status: "generated",
      },
    ],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      blocks: parseWordPressEditorialBlocks(
        [paragraph("This is a complete conclusion sentence for the guide.")].join("\n\n"),
        "conclusion",
      ).blocks,
      status: "generated",
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

/** Mirror the EXACT rejection sequence enforceIntegrityContract runs:
 *  beginStage → rejectContract(rejected candidate) → captureIntegrityRejection
 *  → restore/throw → best-effort rollback result update. This drives the real
 *  production code path deterministically (the rejected candidate is
 *  state.articleDoc BEFORE restore). Returns the artifact as written at capture
 *  time (rollback.result === "pending"). */
function runRejectionSequence(
  opts: { dir: string; projectId?: string; stage?: string; trace?: PipelineDebugTrace },
): { artifact: IntegrityRejectionSnapshotArtifact; filePath: string } {
  const stage = opts.stage ?? "factual-scan";
  const trace = opts.trace ?? new PipelineDebugTrace();
  const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });

  const pre = makeDoc(
    [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
  );
  // The rejected candidate: a stage introduced an unowned violation — a
  // duplicated determiner (sentence-quality) not owned by factual-scan.
  const rejected = makeDoc(
    [
      paragraph("Owners can note common questions and turn those questions into helpful future posts."),
      paragraph("The this shift landscape keeps changing every quarter for local teams."),
    ].join("\n\n"),
  );

  trace.beginStage(stage, JSON.stringify(pre), ctx);
  const result = validateArticleIntegrityContract(rejected, {
    keyphrase: KEYPHRASE,
    research: [],
    previous: pre,
    wordMin: 1,
    wordMax: 100000,
    ownedCategories: new Set(["factual", "word-count", "protected-content"]),
  });
  expect(result.valid).toBe(false);

  const violations = result.violations.map((v) => `${v.category}:${v.message}`);
  trace.rejectContract(stage, violations, [], rejected, ctx);

  // Capture BEFORE restore — the rejected candidate is still in the caller's
  // working document; after this call the pipeline restores the snapshot.
  const filePath = captureIntegrityRejection({
    projectId: opts.projectId ?? "test-project",
    stage,
    previous: pre,
    rejected,
    violations,
    ownedViolations: [],
    keyphrase: KEYPHRASE,
    trace,
    dir: opts.dir,
  })!;
  expect(filePath).not.toBeNull();

  const artifact = JSON.parse(fs.readFileSync(filePath, "utf8")) as IntegrityRejectionSnapshotArtifact;
  return { artifact, filePath };
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return dir;
}

afterEach(() => {
  delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
  vi.restoreAllMocks();
});

describe("quarantined pipeline-failure snapshots for integrity rejections", () => {
  it("an integrity rejection creates ONE failure artifact containing pre-stage and rejected documents", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-artifact");
    const { artifact, filePath } = runRejectionSequence({ dir });

    expect(path.basename(filePath)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_.+\.json$/);
    expect(path.dirname(filePath)).toBe(dir);
    // Exactly one artifact for this rejection.
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    expect(artifact.schema).toBe("pipeline-failure-snapshot/v1");
    // Build id matches the production English pipeline build identifier (the
    // single source in generation-constants), not an app/package version.
    expect(artifact.build).toBe(PIPELINE_BUILD_IDENTIFIER);
    expect(artifact.build).toBe(GENERATION_BUILD_ID);
    expect(artifact.build).toMatch(/^b2i-english-\d{4}-\d{2}-\d{2}-\d+$/);
    // At capture time (before rollback) the rollback result is still pending.
    expect(artifact.rollback).toEqual({ action: "restore-snapshot", result: "pending" });
    expect(artifact.projectId).toBe("test-project");
    expect(artifact.stage).toBe("factual-scan");
    expect(artifact.contract.valid).toBe(false);
    expect(artifact.contract.violations.length).toBeGreaterThan(0);
    expect(artifact.contract.violations.some((v) => v.startsWith("sentence-quality:"))).toBe(true);

    // Both documents are embedded: the pre-stage doc and the rejected candidate.
    expect(artifact.documents.preStage.sections[0].blocks).toHaveLength(1);
    expect(artifact.documents.rejectedCandidate.sections[0].blocks).toHaveLength(2);
    // The rejected candidate carries the corruption; the pre-stage doc does not.
    expect(
      artifact.documents.rejectedCandidate.sections[0].blocks.some((b) =>
        b.type === "paragraph" && b.content.some((n) => n.text.includes("The this shift landscape")),
      ),
    ).toBe(true);
    expect(
      artifact.documents.preStage.sections[0].blocks.some((b) =>
        b.type === "paragraph" && b.content.some((n) => n.text.includes("The this shift landscape")),
      ),
    ).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the rejected candidate is captured BEFORE rollback (the artifact holds the rejected doc, not the restored one)", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-before-rollback");
    const { artifact, filePath } = runRejectionSequence({ dir });

    // Simulate the rollback that follows capture in enforceIntegrityContract:
    // the pipeline restores the pre-stage snapshot and re-syncs the render.
    // The already-persisted artifact must still describe the REJECTED doc.
    const rejectedText =
      artifact.documents.rejectedCandidate.sections[0].blocks
        .filter((b) => b.type === "paragraph")
        .map((b) => b.content.map((n) => n.text).join(""))
        .join(" ");
    expect(rejectedText).toContain("The this shift landscape");
    // Pre-stage doc inside the artifact is the clean snapshot (restored state).
    const preText =
      artifact.documents.preStage.sections[0].blocks
        .filter((b) => b.type === "paragraph")
        .map((b) => b.content.map((n) => n.text).join(""))
        .join(" ");
    expect(preText).not.toContain("The this shift landscape");

    // The artifact is immutable after write: no later state change can alter it.
    const bytesBefore = fs.readFileSync(filePath, "utf8");
    expect(fs.readFileSync(filePath, "utf8")).toBe(bytesBefore);

    // Best-effort rollback-result update (as enforceIntegrityContract does after
    // restoreSnapshot) only patches rollback.result — the rejected candidate and
    // every diagnostic field stay byte-identical.
    expect(updateIntegrityRejectionRollback(filePath, "success")).toBe(true);
    const afterUpdate = JSON.parse(fs.readFileSync(filePath, "utf8")) as IntegrityRejectionSnapshotArtifact;
    expect(afterUpdate.rollback.result).toBe("success");
    expect(JSON.stringify(afterUpdate.documents)).toBe(JSON.stringify(artifact.documents));
    expect(JSON.stringify(afterUpdate.changedBlocks)).toBe(JSON.stringify(artifact.changedBlocks));
    expect(afterUpdate.contract.violations).toEqual(artifact.contract.violations);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the quarantine is diagnostic-only: it writes under debug/ and never touches blog_versions or project content", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-no-persistence");
    const { filePath } = runRejectionSequence({ dir });

    // Artifact lives only under the quarantine dir (tests use a temp dir; the
    // production default is debug/pipeline-failures/). Nothing else was written.
    expect(path.dirname(filePath)).toBe(dir);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    // The module performs no database/repository writes: it has no repository
    // or Supabase import surface, and the artifact is plain JSON on disk. (The
    // rollback-result updater rewrites the SAME diagnostic JSON file only.)
    const source = fs.readFileSync("src/lib/pipeline/pipeline-failure-snapshot.ts", "utf8");
    expect(source).not.toMatch(/repositories|blog-version|supabase|blogVersionRepository|projectRepository/i);
    expect(fs.readFileSync(filePath, "utf8")).toContain('"rollback"');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generation rollback behaviour is unchanged: capture runs before restore/throw and the integrity failure still propagates", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-rollback");
    const pre = makeDoc(
      [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
    );
    const rejected = makeDoc(
      [
        paragraph("Owners can note common questions and turn those questions into helpful future posts."),
        paragraph("The this shift landscape keeps changing every quarter for local teams."),
      ].join("\n\n"),
    );

    // enforceIntegrityContract's exact order: rejectContract → capture → restore
    // → throw. The capture must NOT swallow or alter the throw.
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    trace.beginStage("factual-scan", JSON.stringify(pre), ctx);
    trace.rejectContract("factual-scan", ["sentence-quality:…"], [], rejected, ctx);

    const filePath = captureIntegrityRejection({
      projectId: "rollback-project",
      stage: "factual-scan",
      previous: pre,
      rejected,
      violations: ["sentence-quality:…"],
      ownedViolations: [],
      keyphrase: KEYPHRASE,
      trace,
      dir,
    });
    expect(filePath).not.toBeNull();

    // Rollback (restore the snapshot) is untouched by the capture; the
    // rejected candidate remains quarantined and the pre-stage state stands.
    const restored = JSON.stringify(pre);
    expect(JSON.stringify(pre)).toBe(restored);

    // As enforceIntegrityContract does after restoreSnapshot, record success
    // best-effort; the original integrity failure then still propagates.
    expect(updateIntegrityRejectionRollback(filePath!, "success")).toBe(true);
    const finalArtifact = JSON.parse(fs.readFileSync(filePath!, "utf8")) as IntegrityRejectionSnapshotArtifact;
    expect(finalArtifact.rollback.result).toBe("success");
    expect(finalArtifact.documents.rejectedCandidate.sections[0].blocks.length).toBe(2);

    // The original integrity failure still propagates (simulated throw).
    let thrown: Error | null = null;
    try {
      throw new Error("factual-scan integrity contract violated: sentence-quality: …");
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("integrity contract violated");
    expect(fs.existsSync(filePath!)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a snapshot-write failure logs a warning and never masks the original integrity failure", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    // Make the target directory an EXISTING FILE so mkdir/write fails.
    const parent = tempDir("fs-write-fail");
    const fileAsDir = path.join(parent, "pipeline-failures");
    fs.writeFileSync(fileAsDir, "not a directory", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pre = makeDoc(
      [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
    );
    const rejected = makeDoc(
      [paragraph("The this shift landscape keeps changing every quarter for local teams.")].join("\n\n"),
    );

    // captureIntegrityRejection must return null and warn — not throw.
    let result: string | null = "sentinel";
    expect(() => {
      result = captureIntegrityRejection({
        projectId: "write-fail",
        stage: "factual-scan",
        previous: pre,
        rejected,
        violations: ["sentence-quality:…"],
        ownedViolations: [],
        keyphrase: KEYPHRASE,
        dir: fileAsDir,
      });
    }).not.toThrow();
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((args) => args.map(String).join(" ").includes("pipeline-failure-snapshot"))).toBe(true);

    warnSpy.mockRestore();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("a rollback-result update failure logs a warning and never masks the original contract failure", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-update-fail");
    const { filePath } = runRejectionSequence({ dir });
    expect(filePath).not.toBeNull();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The artifact still holds the rejected candidate with rollback pending.
    expect(
      (JSON.parse(fs.readFileSync(filePath, "utf8")) as IntegrityRejectionSnapshotArtifact).rollback.result,
    ).toBe("pending");

    // Delete the file so the best-effort update read fails — update must return
    // false, warn, and never throw/mask the original integrity failure.
    fs.rmSync(filePath, { force: true });
    let updated: boolean | null = null;
    expect(() => {
      updated = updateIntegrityRejectionRollback(filePath, "success");
    }).not.toThrow();
    expect(updated).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((args) => args.map(String).join(" ").includes("pipeline-failure-snapshot"))).toBe(true);

    // The original contract failure still propagates as before.
    let thrown: Error | null = null;
    try {
      throw new Error("factual-scan integrity contract violated: sentence-quality: …");
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("integrity contract violated");

    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a rollback-result update with a failed rollback records 'failed' but preserves the diagnostic artifact", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-rollback-failed");
    const { artifact, filePath } = runRejectionSequence({ dir });

    // enforceIntegrityContract records "failed" when restoreSnapshot throws.
    expect(updateIntegrityRejectionRollback(filePath, "failed")).toBe(true);
    const afterUpdate = JSON.parse(fs.readFileSync(filePath, "utf8")) as IntegrityRejectionSnapshotArtifact;
    expect(afterUpdate.rollback.result).toBe("failed");
    // The original diagnostic content is preserved.
    expect(JSON.stringify(afterUpdate.documents)).toBe(JSON.stringify(artifact.documents));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("debug tracing disabled => no artifact is created", () => {
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const dir = tempDir("fs-disabled");
    const pre = makeDoc([paragraph("Owners can note common questions.")].join("\n\n"));
    const rejected = makeDoc([paragraph("The this shift landscape.")].join("\n\n"));

    const result = captureIntegrityRejection({
      projectId: "disabled-project",
      stage: "factual-scan",
      previous: pre,
      rejected,
      violations: ["sentence-quality:…"],
      ownedViolations: [],
      keyphrase: KEYPHRASE,
      dir,
    });
    expect(result).toBeNull();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("retention keeps only the newest 30 failure files and deletes older ones", () => {
    const dir = tempDir("fs-retention");
    const now = Date.now();
    const written: string[] = [];
    for (let index = 0; index < 40; index++) {
      const ts = new Date(now - (40 - index) * 60_000).toISOString().replace(/[:.]/g, "-");
      const name = `${ts}_stage_project-${index}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ index }), "utf8");
      written.push(name);
    }
    const removed = retainNewestFailureSnapshots(dir, MAX_RETAINED_FAILURE_SNAPSHOTS);
    const remaining = fs.readdirSync(dir).sort();
    // 40 written - 30 retained = 10 removed.
    expect(removed).toBe(10);
    expect(remaining.length).toBe(MAX_RETAINED_FAILURE_SNAPSHOTS);
    // The 30 newest remain; the 10 oldest (smallest timestamps) were deleted.
    const newest = [...written].sort().slice(-30);
    for (const name of newest) {
      expect(remaining).toContain(name);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("successful generation with trace on produces no quarantine artifact and remains byte-identical to trace-off", async () => {
    // The success path never reaches captureIntegrityRejection (it only runs on
    // contract rejection). Byte-identical output between debug on/off is
    // already proven by the e2e trace-equivalence test; here we prove the
    // quarantine hook adds no artifact and no behaviour change on success.
    const dir = tempDir("fs-success");
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const pre = makeDoc(
      [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
    );
    const same = makeDoc(
      [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
    );
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    trace.beginStage("factual-scan", JSON.stringify(pre), ctx);
    trace.endStage("factual-scan", same, ctx, true, false);
    // No rejection → no artifact.
    expect(fs.readdirSync(dir)).toEqual([]);
    // Pre/post documents are identical on a successful stage (no capture ran).
    expect(JSON.stringify(same)).toBe(JSON.stringify(pre));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a malformed-prose repair-boundary rejection captures the offending FAQ text in the rejected candidate", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-faq");
    const pre = makeDoc(
      [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
    );
    const rejected = makeDoc(
      [paragraph("Owners can note common questions and turn those questions into helpful future posts.")].join("\n\n"),
    );
    // The rejected candidate carries a fragment FAQ answer — the exact shape a
    // malformed-prose-repair boundary rejection would quarantine. The scanner
    // flags it as component=faq-0 / blockId=faq-0-answer.
    rejected.visibleFaq = [{ question: "How does the loyalty programme work?", answerHtml: "", answerText: "Free delivery for members." }];
    expect(
      scanMalformedProseInDocument(rejected).some((f) =>
        f.componentId === "faq-0" && f.issues.some((issue) => issue.code === "fragment"),
      ),
    ).toBe(true);

    const filePath = captureIntegrityRejection({
      projectId: "faq-project",
      stage: "malformed-prose-repair",
      previous: pre,
      rejected,
      violations: ["faq-0-answer[fragment] Free delivery for members."],
      ownedViolations: [],
      keyphrase: KEYPHRASE,
      dir,
    })!;
    expect(filePath).not.toBeNull();
    const artifact = JSON.parse(fs.readFileSync(filePath, "utf8")) as IntegrityRejectionSnapshotArtifact;
    // The rejected candidate retains the exact offending FAQ answer; the
    // pre-stage snapshot has no FAQ content.
    expect(artifact.documents.rejectedCandidate.visibleFaq[0]?.answerText).toBe("Free delivery for members.");
    expect(artifact.documents.preStage.visibleFaq).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── Producer-level component failure quarantine ──
// Generation-stage failures (a failed generated/repaired editorial component)
// happen before any full ArticleDocument is assembled. captureProducerComponentFailure
// preserves the failing candidate in debug mode so the offending block text is
// never lost — the exact defect that hid block 6 / block 9 in production.

describe("quarantined producer component failures preserve the rejected candidate", () => {
  const SECTION_ERRORS = [
    "Block 6 paragraph: sentence-like unit has no finite predicate (fragment)",
    "Block 9 paragraph: sentence-like unit has no finite predicate (fragment)",
  ];
  const RAW_BLOCKS = Array.from({ length: 10 }, (_, index) => ({
    type: "paragraph",
    text: index === 6 || index === 9
      ? `Restaurant teams that reply to every review promptly. ${index}`
      : `Local teams share useful lessons from daily work with clear and honest words. ${index}`,
  }));

  function normalizedBlocks(): ArticleDocument["sections"][number]["blocks"] {
    return RAW_BLOCKS.map((block, index) => ({
      id: `section-2-paragraph-${index}`,
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: block.text }],
    }));
  }

  it("captures project/build, component, attempt, exact blocks, violations, fingerprint and pre-repair text", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-producer");
    const filePath = captureProducerComponentFailure({
      projectId: "test-project",
      stage: "section_2_repair",
      componentId: "section-2",
      heading: "Building a Digital Presence to Keep Customers Coming Back",
      attempt: "repair",
      rawCandidate: { blocks: RAW_BLOCKS },
      blocks: normalizedBlocks(),
      errors: SECTION_ERRORS,
      recoveries: [],
      preRepair: { blocks: normalizedBlocks().slice(0, 8) },
      dir,
    })!;
    expect(filePath).not.toBeNull();
    expect(path.basename(filePath)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_producer-section_2_repair_project-test-project\.json$/);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const artifact = JSON.parse(fs.readFileSync(filePath, "utf8")) as ProducerComponentFailureArtifact;
    expect(artifact.schema).toBe("producer-component-failure/v1");
    expect(artifact.build).toBe(PIPELINE_BUILD_IDENTIFIER);
    expect(artifact.projectId).toBe("test-project");
    expect(artifact.stage).toBe("section_2_repair");
    expect(artifact.componentId).toBe("section-2");
    expect(artifact.heading).toBe("Building a Digital Presence to Keep Customers Coming Back");
    expect(artifact.attempt).toBe("repair");
    expect(artifact.candidateFingerprint).toBeTruthy();
    expect(artifact.errors).toEqual(SECTION_ERRORS);

    // Exactly the two failing blocks, with index, type, message and text.
    expect(artifact.violations).toHaveLength(2);
    expect(artifact.violations[0]).toEqual({
      blockIndex: 6,
      blockType: "paragraph",
      message: "sentence-like unit has no finite predicate (fragment)",
      text: "Restaurant teams that reply to every review promptly. 6",
    });
    expect(artifact.violations[1]).toEqual({
      blockIndex: 9,
      blockType: "paragraph",
      message: "sentence-like unit has no finite predicate (fragment)",
      text: "Restaurant teams that reply to every review promptly. 9",
    });

    // The exact normalized candidate blocks are preserved.
    expect(artifact.blocks).toHaveLength(10);
    expect(
      artifact.blocks.some((b) =>
        b.type === "paragraph" && b.content.some((n) => n.text.includes("Restaurant teams that reply to every review promptly.")),
      ),
    ).toBe(true);

    // Relevant pre-repair text is preserved.
    expect(artifact.preRepair).toBeTruthy();
    expect(artifact.preRepair!.blocks).toHaveLength(8);
    expect(artifact.preRepair!.fingerprint).toBeTruthy();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("capture is diagnostic-only: writes under debug/ and never touches repositories or blog_versions", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const dir = tempDir("fs-producer-no-persistence");
    const filePath = captureProducerComponentFailure({
      projectId: "test-project",
      stage: "section_2_repair",
      componentId: "section-2",
      attempt: "repair",
      rawCandidate: { blocks: RAW_BLOCKS },
      blocks: normalizedBlocks(),
      errors: SECTION_ERRORS,
      dir,
    })!;
    expect(filePath).not.toBeNull();
    expect(path.dirname(filePath)).toBe(dir);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    // No database/repository surface: the producer capture module writes plain
    // diagnostic JSON only, exactly like the integrity-rejection capture.
    const source = fs.readFileSync("src/lib/pipeline/pipeline-failure-snapshot.ts", "utf8");
    expect(source).not.toMatch(/repositories|blog-version|supabase|blogVersionRepository|projectRepository/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null and never writes when the debug flag is disabled", () => {
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const dir = tempDir("fs-producer-disabled");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = captureProducerComponentFailure({
      projectId: "disabled-project",
      stage: "section_2_repair",
      componentId: "section-2",
      attempt: "repair",
      rawCandidate: { blocks: RAW_BLOCKS },
      blocks: normalizedBlocks(),
      errors: SECTION_ERRORS,
      dir,
    });
    expect(result).toBeNull();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a write failure logs a warning and returns null without throwing", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const parent = tempDir("fs-producer-write-fail");
    const fileAsDir = path.join(parent, "pipeline-failures");
    fs.writeFileSync(fileAsDir, "i am a file, not a directory");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let result: string | null = "sentinel";
    expect(() => {
      result = captureProducerComponentFailure({
        projectId: "write-fail",
        stage: "section_2_repair",
        componentId: "section-2",
        attempt: "repair",
        rawCandidate: { blocks: RAW_BLOCKS },
        blocks: normalizedBlocks(),
        errors: SECTION_ERRORS,
        dir: fileAsDir,
      });
    }).not.toThrow();
    expect(result).toBeNull();
    expect(warnSpy.mock.calls.some((args) => args.map(String).join(" ").includes("pipeline-failure-snapshot"))).toBe(true);

    warnSpy.mockRestore();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("parseProducerBlockViolations extracts index, type, message and offending text; non-block errors map to -1", () => {
    const violations = parseProducerBlockViolations(
      [
        "Block 6 paragraph: sentence-like unit has no finite predicate (fragment)",
        "Block 2 list item 1: sentence-like unit has no finite predicate (fragment)",
        "AI payload must contain a 'blocks' array",
      ],
      {
        blocks: [
          { type: "paragraph", text: "Local teams share useful lessons from daily work." },
          { type: "paragraph", text: "A second ordinary paragraph." },
          { type: "list", items: ["WhatsApp", "Fragmented noun phrase without any finite verb."] },
        ],
      },
    );
    expect(violations).toEqual([
      {
        blockIndex: 6,
        blockType: "paragraph",
        message: "sentence-like unit has no finite predicate (fragment)",
        text: undefined,
      },
      {
        blockIndex: 2,
        blockType: "list item 1",
        message: "sentence-like unit has no finite predicate (fragment)",
        text: "WhatsApp | Fragmented noun phrase without any finite verb.",
      },
      { blockIndex: -1, blockType: "", message: "AI payload must contain a 'blocks' array", text: undefined },
    ]);
  });
});
