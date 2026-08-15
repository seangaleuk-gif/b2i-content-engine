import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineDebugTrace,
  isPipelineDebugTraceEnabled,
  traceContextFor,
} from "@/lib/pipeline/pipeline-debug-trace";
import {
  parseWordPressEditorialBlocks,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";

const KEYPHRASE = "hong kong marketing trends";

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function makeSectionDoc(sectionHtml: string): ArticleDocument {
  const sections: ArticleSection[] = [
    {
      id: "section-4",
      heading: "How Brands Should Plan",
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(sectionHtml, "section-4").blocks,
      status: "generated",
    },
  ];
  for (let index = 0; index < 3; index++) {
    sections.push({
      id: `section-filler-${index}`,
      heading: `Supporting area number ${index + 1} for brands`,
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(
        [
          paragraph("Supporting topic number one for the guide explains the core supporting ideas in plain words."),
          paragraph("A second supporting paragraph expands the topic number one area with more practical guidance."),
          paragraph("A third supporting paragraph keeps the topic number one section complete and grounded."),
        ].join("\n\n"),
        `section-filler-${index}`,
      ).blocks,
      status: "generated",
    });
  }
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections,
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function claim(text: string, sentenceText?: string): ScannedClaim {
  return {
    text,
    htmlPosition: 0,
    category: "platform_metric",
    supported: false,
    sectionIndex: 0,
    ...(sentenceText ? { sentenceText } : {}),
  };
}

afterEach(() => {
  delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
  vi.restoreAllMocks();
});

describe("pipeline debug trace: observational stage-by-stage diagnostics", () => {
  it("env flag defaults to disabled and enables with ENABLE_PIPELINE_DEBUG_TRACE=true", () => {
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    expect(isPipelineDebugTraceEnabled()).toBe(false);
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    expect(isPipelineDebugTraceEnabled()).toBe(true);
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "false";
    expect(isPipelineDebugTraceEnabled()).toBe(false);
  });

  it("identifies the FIRST stage that introduces a violation and distinguishes pre-existing vs new", () => {
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    const clean = makeSectionDoc(
      [
        paragraph("Many brands avoid automated scheduling tools for their campaigns."),
        paragraph("Instead, successful brands plan content around real customer questions."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
        paragraph("Regular replies also show customers that a real person is listening to their needs."),
      ].join("\n\n"),
    );

    // Stage 1: factual-scan removes the antecedent — the "Instead," opener is
    // stripped by the producer, so NO orphan is introduced. With positional
    // block ids, the antecedent paragraph's text is replaced by the stripped
    // remainder (text-changed) and the final paragraph falls off (removed).
    trace.beginStage("factual-scan", JSON.stringify(clean), ctx);
    const afterScan = makeSectionDoc(
      [
        paragraph("Successful brands plan content around real customer questions."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
        paragraph("Regular replies also show customers that a real person is listening to their needs."),
      ].join("\n\n"),
    );
    trace.endStage("factual-scan", afterScan, ctx, true, false);
    const scanRecord = trace.recordsFor("factual-scan")[0];
    expect(scanRecord.introduced.some((v) => v.category === "coherence" && v.key.includes("orphan-transition"))).toBe(false);
    expect(scanRecord.changedBlocks.some((c) => c.blockId === "section-4-wp-0" && c.reason === "text-changed")).toBe(true);
    expect(scanRecord.changedBlocks.some((c) => c.reason === "removed-block")).toBe(true);

    // Stage 2: a hypothetical later stage re-introduces an orphan transition
    // in a different block — must be attributed to THAT stage as first
    // introducer of the new key, while the original key set stays attributed.
    trace.beginStage("claim-ownership", JSON.stringify(afterScan), ctx);
    const corrupted = makeSectionDoc(
      [
        paragraph("Successful brands plan content around real customer questions."),
        paragraph("Instead, teams should review weekly to keep momentum."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
        paragraph("Regular replies also show customers that a real person is listening to their needs."),
      ].join("\n\n"),
    );
    trace.endStage("claim-ownership", corrupted, ctx, true, false);
    const ownershipRecord = trace.recordsFor("claim-ownership")[0];
    expect(ownershipRecord.firstIntroduced.some((v) =>
      v.category === "coherence" && v.type === "orphan-transition" && v.blockRef.includes("section-4-wp-1"),
    )).toBe(true);
    expect(ownershipRecord.introduced.some((v) => v.category === "coherence" && v.key.includes("orphan-transition"))).toBe(true);
  });

  it("reports exact changed block IDs with before/after content", () => {
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    const before = makeSectionDoc(
      [
        paragraph("About 35% of teams now rely on automated scheduling tools for their campaigns."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      ].join("\n\n"),
    );
    trace.beginStage("factual-scan", JSON.stringify(before), ctx);
    const after = makeSectionDoc(
      [
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      ].join("\n\n"),
    );
    trace.endStage("factual-scan", after, ctx, true, false);
    const record = trace.recordsFor("factual-scan")[0];
    // By-ID diff: wp-0 lost its claim sentence (text-changed), wp-1 removed.
    const changed = record.changedBlocks.find((c) => c.blockId === "section-4-wp-0");
    expect(changed?.reason).toBe("text-changed");
    expect(changed?.before).toContain("35% of teams");
    expect(changed?.after).toContain("Local teams share useful lessons");
    const removed = record.changedBlocks.find((c) => c.reason === "removed-block");
    expect(removed?.blockId).toBe("section-4-wp-1");
    expect(removed?.after).toBe("");
    expect(record.pre.wordCount).toBeGreaterThan(record.post.wordCount);
    expect(record.pre.fp).not.toBe(record.post.fp);
  });

  it("records a successful rollback with contract result", () => {
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    const before = makeSectionDoc(
      [
        paragraph("Many brands avoid automated scheduling tools for their campaigns."),
        paragraph("Instead, successful brands plan content around real customer questions."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      ].join("\n\n"),
    );
    trace.beginStage("malformed-prose-repair", JSON.stringify(before), ctx);
    // A candidate that the contract would reject (orphan transition left in).
    const rejected = makeSectionDoc(
      [
        paragraph("Instead, successful brands plan content around real customer questions."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      ].join("\n\n"),
    );
    trace.rejectContract(
      "malformed-prose-repair",
      ["coherence: orphan-transition in section-4/section-4-wp-0"],
      [],
      rejected,
      ctx,
    );
    const record = trace.recordsFor("malformed-prose-repair")[0];
    expect(record.rollback).toBe(true);
    expect(record.accepted).toBe(false);
    expect(record.contract?.valid).toBe(false);
    expect(record.contract?.violations[0]).toContain("orphan-transition");
    expect(record.firstIntroduced.some((v) => v.type === "orphan-transition")).toBe(true);
  });

  it("bounded snapshots are retained for backward tracing and never dumped", () => {
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    for (let index = 0; index < 10; index++) {
      const doc = makeSectionDoc([paragraph(`Local teams share useful lessons from daily work ${index} times.`)].join("\n\n"));
      trace.beginStage(`stage-${index}`, JSON.stringify(doc), ctx);
      trace.endStage(`stage-${index}`, doc, ctx, true, false);
    }
    const snapshots = trace.recentSnapshots();
    // Bounded ring: only the most recent N are retained.
    expect(snapshots.length).toBeLessThanOrEqual(6);
    expect(snapshots[snapshots.length - 1].stage).toBe("stage-9");
    // Records for all stages are retained in memory for attribution.
    expect(trace.recordsFor().length).toBe(10);
  });

  it("observational only: enabled trace does not mutate the document or its fingerprints", () => {
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    const before = makeSectionDoc(
      [
        paragraph("About 35% of teams now rely on automated scheduling tools for their campaigns."),
        paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      ].join("\n\n"),
    );
    const beforeJson = JSON.stringify(before);
    const beforeRender = parseWordPressEditorialBlocks(before.sections[0].blocks.map((b) => b.id).join(","), "x");

    trace.beginStage("factual-scan", beforeJson, ctx);
    // Trace only READS; the caller performs the mutation.
    const after = makeSectionDoc(
      [paragraph("Local teams share useful lessons from daily work with clear and honest words.")].join("\n\n"),
    );
    trace.endStage("factual-scan", after, ctx, true, false);

    // The pre-document snapshot is byte-identical (trace never wrote to it).
    expect(JSON.stringify(before)).toBe(beforeJson);
    expect(beforeRender).toBeDefined();
    // Records contain only derived metrics, never secrets or full documents.
    const emitted = JSON.stringify(trace.recordsFor());
    expect(emitted).not.toContain("Bearer");
    expect(emitted).not.toContain("api_key");
    expect(emitted).not.toContain("password");
  });

  it("works with the real removal producer: antecedent removal attributes no false orphan", () => {
    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    const sectionHtml = [
      paragraph("About 35% of teams now rely on automated scheduling tools for their campaigns."),
      paragraph("Instead, successful brands plan content around real customer questions."),
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("Regular replies also show customers that a real person is listening to their needs."),
    ].join("\n\n");
    const before = makeSectionDoc(sectionHtml);
    trace.beginStage("factual-scan", JSON.stringify(before), ctx);
    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of teams now rely on automated scheduling tools", "About 35% of teams now rely on automated scheduling tools for their campaigns."),
    ]);
    const after = makeSectionDoc(out.html);
    trace.endStage("factual-scan", after, ctx, true, false);
    const record = trace.recordsFor("factual-scan")[0];
    // The transition opener was stripped, so the trace sees a text change on
    // section-4-wp-1 and NO orphan-transition introduced.
    expect(record.changedBlocks.some((c) => c.blockId === "section-4-wp-1" && c.reason === "text-changed")).toBe(true);
    expect(record.introduced.filter((v) => v.category === "coherence" && v.key.includes("orphan-transition"))).toEqual([]);
  });
});
