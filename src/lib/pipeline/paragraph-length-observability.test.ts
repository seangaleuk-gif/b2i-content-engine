// ── Stage 3L: paragraph-length observability tests ──
// Proves the diagnostic instrumentation: 0→1 attribution at the exact
// introducing stage, no false introductions, 1→0 visibility, final-validation
// failure snapshot content, debug-off silence, and zero behavioral impact.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  renderArticleDocument,
  fingerprintHtml,
  type ArticleDocument,
  type ArticleComponent,
  type ArticleSection,
  type EditorialBlock,
} from "@/lib/blog/article-document";
import { analyzeFinalArticle } from "@/lib/blog/final-article-policy";
import {
  measureParagraphLengthDiagnostics,
  recordParagraphLengthStage,
  paragraphLengthStageTrace,
  resetParagraphLengthTrace,
} from "@/lib/pipeline/paragraph-length-trace";
import { captureFinalValidationFailure } from "@/lib/pipeline/pipeline-failure-snapshot";

const DEBUG_FLAG = "ENABLE_PIPELINE_DEBUG_TRACE";
const KEYPHRASE = "hong kong restaurant customer retention";

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(overrides: {
  sectionText?: string;
  introText?: string;
  conclusionText?: string;
} = {}): ArticleDocument {
  const intro: ArticleComponent = {
    id: "intro",
    status: "normalized",
    blocks: [paragraphBlock("intro-p0", overrides.introText ?? "Introduction one. Introduction two.")],
  };
  const section: ArticleSection = {
    id: "section-0",
    heading: "Why Customer Retention Matters",
    headingLevel: 2,
    sectionType: "main",
    status: "normalized",
    blocks: [
      paragraphBlock("section-0-wp-0", overrides.sectionText ?? "Section one. Section two. Section three."),
    ],
  };
  const conclusion: ArticleComponent = {
    id: "conclusion",
    status: "normalized",
    blocks: [paragraphBlock("conclusion-p0", overrides.conclusionText ?? "Conclusion one. Conclusion two.")],
  };
  return {
    metadata: {
      title: "A Title About Retention",
      slug: "test",
      metaDescription: "Meta description.",
      excerpt: "Excerpt.",
      targetWordCount: 2500,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: null,
    introduction: intro,
    sections: [section],
    visibleFaq: [],
    conclusion,
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function recordFor(stage: string, doc: ArticleDocument): void {
  recordParagraphLengthStage({
    stage,
    html: renderArticleDocument(doc),
    doc,
    keyphrase: KEYPHRASE,
    title: "A Title About Retention",
    metaDescription: "Meta description.",
    requestedWordCount: 2500,
  });
}

afterEach(() => {
  delete process.env[DEBUG_FLAG];
  resetParagraphLengthTrace();
  vi.restoreAllMocks();
});

describe("Stage 3L: shared diagnostic measurement", () => {
  it("uses the authoritative analyzeFinalArticle count and maps the violating block", () => {
    const doc = makeDoc({ sectionText: "One. Two. Three. Four." });
    const html = renderArticleDocument(doc);
    const metrics = analyzeFinalArticle(html, KEYPHRASE, "A Title About Retention", "Meta description.", 2500);
    const diagnostics = measureParagraphLengthDiagnostics(html, doc, KEYPHRASE, "A Title About Retention", "Meta description.", 2500);
    expect(diagnostics.longParagraphCount).toBe(1);
    expect(diagnostics.longParagraphCount).toBe(metrics.longParagraphCount);
    expect(diagnostics.paragraphs).toHaveLength(1);
    expect(diagnostics.paragraphs[0].text).toBe("One. Two. Three. Four.");
    expect(diagnostics.paragraphs[0].sentences).toBe(4);
    expect(diagnostics.paragraphs[0].blockId).toBe("section-0-wp-0");
    expect(diagnostics.paragraphs[0].componentId).toBe("section-0");
    expect(diagnostics.paragraphs[0].nearestHeading).toBe("Why Customer Retention Matters");
  });

  it("reports zero long paragraphs for a clean document", () => {
    const doc = makeDoc();
    const diagnostics = measureParagraphLengthDiagnostics(renderArticleDocument(doc), doc, KEYPHRASE);
    expect(diagnostics.longParagraphCount).toBe(0);
    expect(diagnostics.paragraphs).toHaveLength(0);
  });
});

describe("Stage 3L: stage trace 0→1 attribution", () => {
  it("A: 0→1 transition is reported at the exact introducing stage with before/after text", () => {
    process.env[DEBUG_FLAG] = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shortDoc = makeDoc({ sectionText: "One. Two. Three." });
    const longDoc = makeDoc({ sectionText: "One. Two. Three. Four." });
    longDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three. Four.");

    recordFor("seo-normalization", shortDoc);
    recordFor("factual-scan", longDoc);

    const trace = paragraphLengthStageTrace();
    expect(trace[0]).toMatchObject({ stage: "seo-normalization", count: 0, changed: false });
    expect(trace[1]).toMatchObject({ stage: "factual-scan", count: 1, changed: true });
    expect(trace[1].firstIntroduction).toBeDefined();
    expect(trace[1].firstIntroduction!.beforeText).toBe("One. Two. Three.");
    expect(trace[1].firstIntroduction!.afterText).toBe("One. Two. Three. Four.");

    const lines = warnSpy.mock.calls.map((args) => args.map(String).join(" "));
    const event = lines.find((line) => line.includes("[paragraph-length-trace]"));
    expect(event).toBeTruthy();
    expect(event).toContain("stage=factual-scan");
    expect(event).toContain("count=0→1");
    expect(event).toContain("block=section-0-wp-0");
    expect(event).toContain("component=section-0");
    expect(event).toContain("sentences=4");
  });

  it("B: a pre-existing long paragraph reports no false introduction", () => {
    process.env[DEBUG_FLAG] = "true";
    const longDoc = makeDoc({ sectionText: "One. Two. Three. Four." });
    longDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three. Four.");
    recordFor("seo-normalization", longDoc);
    recordFor("title-repair", longDoc);
    const trace = paragraphLengthStageTrace();
    expect(trace[0].count).toBe(1);
    expect(trace[1].count).toBe(1);
    expect(trace[1].changed).toBe(false);
    expect(trace[1].firstIntroduction).toBeUndefined();
  });

  it("C: 1→0 resolution is visible", () => {
    process.env[DEBUG_FLAG] = "true";
    const longDoc = makeDoc({ sectionText: "One. Two. Three. Four." });
    longDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three. Four.");
    const cleanDoc = makeDoc({ sectionText: "One. Two. Three." });
    cleanDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three.");
    recordFor("external-links", longDoc);
    recordFor("final-trim", cleanDoc);
    const trace = paragraphLengthStageTrace();
    expect(trace[0].count).toBe(1);
    expect(trace[1]).toMatchObject({ stage: "final-trim", count: 0, changed: true });
    expect(trace[1].firstIntroduction).toBeUndefined();
  });

  it("M: baseline=23 → no-op trim=23 → paragraphs=0 identifies NO introduction at trim", () => {
    process.env[DEBUG_FLAG] = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const with23 = makeDoc({
      sectionText: "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve. Thirteen. Fourteen. Fifteen. Sixteen. Seventeen. Eighteen. Nineteen. Twenty. Twenty one. Twenty two. Twenty three.",
    });
    const html23 = renderArticleDocument(with23);
    const diagnostics = measureParagraphLengthDiagnostics(html23, with23, KEYPHRASE);
    expect(diagnostics.longParagraphCount).toBe(1);

    // Baseline: the pre-existing long-paragraph state is recorded as a
    // baseline (count=1 here), never as "0→1".
    recordFor("baseline", with23);
    recordFor("trim", with23); // no-op trim: unchanged
    const paragraphs0 = makeDoc({ sectionText: "One. Two. Three." });
    paragraphs0.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three.");
    recordFor("paragraphs", paragraphs0);

    const trace = paragraphLengthStageTrace();
    expect(trace[0]).toMatchObject({ stage: "baseline", count: 1, changed: false });
    expect(trace[0].firstIntroduction).toBeUndefined();
    expect(trace[1]).toMatchObject({ stage: "trim", count: 1, changed: false });
    expect(trace[1].firstIntroduction).toBeUndefined();
    expect(trace[2]).toMatchObject({ stage: "paragraphs", count: 0, changed: true });
    expect(trace[2].firstIntroduction).toBeUndefined();

    const lines = warnSpy.mock.calls.map((args) => args.map(String).join(" "));
    const baselineLine = lines.find((line) => line.includes("[paragraph-length-trace]") && line.includes("baseline"));
    expect(baselineLine).toBeTruthy();
    expect(baselineLine).toContain("count=baseline:1");
    expect(lines.some((line) => line.includes("stage=trim") && line.includes("0→1"))).toBe(false);
    expect(lines.some((line) => line.includes("stage=trim") && line.includes("first-0→1"))).toBe(false);
  });
});

describe("Stage 3L: final-validation failure snapshot", () => {
  it("D: snapshot contains exact violating text, sentence count, block identity and stage trace", () => {
    process.env[DEBUG_FLAG] = "true";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2i-final-validation-"));
    try {
      const cleanDoc = makeDoc({ sectionText: "One. Two. Three." });
      recordFor("seo-normalization", cleanDoc);
      const longDoc = makeDoc({ sectionText: "One. Two. Three. Four." });
      longDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three. Four.");
      recordFor("factual-scan", longDoc);

      const filePath = captureFinalValidationFailure({
        projectId: "test-project",
        articleDoc: longDoc,
        html: renderArticleDocument(longDoc),
        reasons: ["long paragraphs=1"],
        keyphrase: KEYPHRASE,
        title: "A Title About Retention",
        metaDescription: "Meta description.",
        requestedWordCount: 2500,
        dir,
      });
      expect(filePath).toBeTruthy();
      expect(fs.existsSync(filePath!)).toBe(true);

      const artifact = JSON.parse(fs.readFileSync(filePath!, "utf8"));
      expect(artifact.schema).toBe("final-validation-failure/v1");
      expect(artifact.stage).toBe("final-validation");
      expect(artifact.projectId).toBe("test-project");
      expect(artifact.reasons).toEqual(["long paragraphs=1"]);
      expect(artifact.metrics.longParagraphCount).toBe(1);
      expect(artifact.longParagraphs).toHaveLength(1);
      expect(artifact.longParagraphs[0].text).toBe("One. Two. Three. Four.");
      expect(artifact.longParagraphs[0].sentences).toBe(4);
      expect(artifact.longParagraphs[0].blockId).toBe("section-0-wp-0");
      expect(artifact.documents.articleDoc.sections[0].blocks[0].id).toBe("section-0-wp-0");
      expect(artifact.paragraphLengthTrace.length).toBe(2);
      expect(artifact.paragraphLengthTrace[1].count).toBe(1);
      expect(artifact.paragraphLengthTrace[1].changed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E: debug flag OFF produces no snapshot file and no trace recording", () => {
    delete process.env[DEBUG_FLAG];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2i-final-validation-off-"));
    try {
      const longDoc = makeDoc({ sectionText: "One. Two. Three. Four." });
      longDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-0", "One. Two. Three. Four.");
      const filePath = captureFinalValidationFailure({
        projectId: "test-project",
        articleDoc: longDoc,
        html: renderArticleDocument(longDoc),
        reasons: ["long paragraphs=1"],
        keyphrase: KEYPHRASE,
        dir,
      });
      expect(filePath).toBeNull();
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
      recordFor("seo-normalization", longDoc);
      expect(paragraphLengthStageTrace()).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Stage 3L: zero behavioral impact", () => {
  it("F: instrumentation does not alter document fingerprint or acceptance metrics", () => {
    const doc = makeDoc({ sectionText: "One. Two. Three." });
    const html = renderArticleDocument(doc);
    const fpBefore = fingerprintHtml(html);
    const metricsBefore = analyzeFinalArticle(html, KEYPHRASE, "A Title About Retention", "Meta description.", 2500);

    process.env[DEBUG_FLAG] = "true";
    recordFor("seo-normalization", doc);
    recordFor("factual-scan", doc);
    measureParagraphLengthDiagnostics(html, doc, KEYPHRASE);
    process.env[DEBUG_FLAG] = "false";
    recordFor("final-trim", doc);

    expect(fingerprintHtml(renderArticleDocument(doc))).toBe(fpBefore);
    const metricsAfter = analyzeFinalArticle(html, KEYPHRASE, "A Title About Retention", "Meta description.", 2500);
    expect(JSON.stringify(metricsAfter)).toBe(JSON.stringify(metricsBefore));
    const block = doc.sections[0].blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph block");
    expect(block.content[0].text).toBe("One. Two. Three.");
  });
});
