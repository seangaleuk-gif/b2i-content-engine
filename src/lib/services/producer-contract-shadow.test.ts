import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { EditorialBlock } from "@/lib/blog/article-document";
import {
  shadowValidateProducerCandidate,
  type ProducerComponentContext,
} from "@/lib/blog/producer-content-contract";

function p(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function ctx(overrides: Partial<ProducerComponentContext> = {}): ProducerComponentContext {
  return { componentId: "intro", componentType: "introduction", scope: "complete-component", ...overrides };
}

afterEach(() => {
  delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
  vi.restoreAllMocks();
});

describe("producer-contract shadow harness", () => {
  it("A: when both validators pass, no disagreement is recorded and nothing is logged", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const candidate = { blocks: [p("p0", "Local teams share useful lessons from daily work with clear and honest words.")] };
    const comparison = shadowValidateProducerCandidate({
      label: "intro generation",
      candidate,
      context: ctx(),
      existingPassed: true,
    });
    expect(comparison.contractPassed).toBe(true);
    expect(comparison.disagreement).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    // Production unchanged: the candidate object is untouched by the shadow run.
    const block = candidate.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph block");
    expect(block.content[0].text).toBe("Local teams share useful lessons from daily work with clear and honest words.");
  });

  it("B: existing pass / contract fail records the disagreement with exact violation and text", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const comparison = shadowValidateProducerCandidate({
      label: "intro generation",
      candidate: { blocks: [p("p0", "The a menu changes daily.")] },
      context: ctx(),
      existingPassed: true,
    });
    expect(comparison.contractPassed).toBe(false);
    expect(comparison.disagreement).toBe(true);
    const lines = warnSpy.mock.calls.map((args) => args.map(String).join(" "));
    const event = lines.find((line) => line.includes("[producer-contract-shadow]"));
    expect(event).toBeTruthy();
    expect(event).toContain("label=intro generation");
    expect(event).toContain("existing=pass contract=fail");
    expect(event).toContain("violations=duplicated-determiner@p0");
    expect(event).toContain('text="The a menu changes daily."');
    expect(event).toContain("fingerprint=");
  });

  it("C: existing fail / contract pass records the disagreement", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const comparison = shadowValidateProducerCandidate({
      label: "section-1 generation",
      candidate: { blocks: [p("p0", "Local teams share useful lessons from daily work with clear and honest words.")] },
      context: ctx({ componentId: "section-1", componentType: "section" }),
      existingPassed: false,
    });
    expect(comparison.contractPassed).toBe(true);
    expect(comparison.disagreement).toBe(true);
    const lines = warnSpy.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.some((line) => line.includes("[producer-contract-shadow]") && line.includes("existing=fail contract=pass"))).toBe(true);
  });

  it("is fully skipped (no log, no compute) when the pipeline debug flag is off", () => {
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const comparison = shadowValidateProducerCandidate({
      label: "intro generation",
      candidate: { blocks: [p("p0", "The a menu changes daily.")] },
      context: ctx(),
      existingPassed: true,
    });
    expect(comparison.disagreement).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("producer-contract shadow: no component-replacement or post-assembly wiring", () => {
  // Stage 3W: regeneration/compaction/expansion are NOW wired to the shared
  // source-provenance helper by architecture (source-first provenance
  // completion). The remaining post-assembly quality paths must stay unwired:
  // SEO normalization, editorial polish and Stage 3Q never import the
  // producer contract.
  const mustStayUnwired = [
    "src/lib/blog/final-seo-normalizer.ts",
    "src/lib/pipeline/editorial-polish.ts",
    "src/lib/pipeline/full-document-editorial.ts",
  ];

  it("F: SEO/editorial-polish/3Q modules do not import the producer contract", () => {
    for (const file of mustStayUnwired) {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      expect(source, file).not.toContain("producer-content-contract");
    }
  });

  it("W: every factual-capable producer imports the shared source-provenance helper", () => {
    const mustBeWired = [
      "src/lib/services/blog-generation-service.ts",
      "src/lib/services/component-regenerator.ts",
      "src/lib/services/section-expander.ts",
      "src/lib/pipeline/blog-generation-pipeline.ts",
    ];
    for (const file of mustBeWired) {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      expect(source, file).toContain("validateProducerSentenceAccounting");
    }
  });
});
