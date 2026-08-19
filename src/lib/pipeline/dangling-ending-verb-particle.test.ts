// ── Stage 3O: dangling-ending verb-particle + trace attribution regressions ──
// Proves: valid intransitive verb-particle endings are not dangling, genuine
// dangling prepositions still fail, list-item/paragraph parity, malformed
// repair leaves valid phrasal endings untouched, the producer contract accepts
// the live sentence, and paragraph normalization never creates a false
// firstIntroduced (semantic findings that move blocks are preserved).

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import {
  scanMalformedProseInDocument,
  findMalformedProseTextIssues,
  hasDanglingSentenceEnding,
} from "@/lib/blog/publication-quality";
import { repairDeterministicMalformedProse } from "@/lib/pipeline/editorial-polish";
import { validateProducerCandidate, type ProducerComponentContext } from "@/lib/blog/producer-content-contract";
import { PipelineDebugTrace, type TraceContext } from "@/lib/pipeline/pipeline-debug-trace";
import type { ArticleDocument, ArticleComponent, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";

const KEYPHRASE = "hong kong gym marketing";
const SNAPSHOT = "src/lib/__live-fixtures__/2026-08-18T06-00-19-205Z_malformed-prose-repair_project-24.json";
const LIVE_SENTENCE = "Social proof – reviews and member stories build trust before someone even steps in.";

const VALID_PHRASAL_ENDINGS = [
  "someone steps in.",
  "people check in.",
  "members join in.",
  "customers log in.",
  "the team moves on.",
  "they carry on.",
  "visitors settle in.",
  "she dropped in.",
  "everything worked out.",
  "they followed through.",
  "Please come in.",
  "Let's dive in.",
];

const GENUINE_DANGLING = [
  "The budget is for.",
  "We discussed the plan in.",
  "The campaign depends on.",
  "Customers asked about.",
  "This package comes with.",
  "Marketing teams invest in.",
  "Smart owners plan for.",
];

function paragraphBlock(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function paragraphText(block: EditorialBlock): string {
  if (block.type !== "paragraph") throw new Error(`expected paragraph block, got ${block.type}`);
  return block.content.map((n) => n.text).join("");
}

function listItemText(block: EditorialBlock, index: number): string {
  if (block.type !== "list") throw new Error(`expected list block, got ${block.type}`);
  return block.items[index].map((n) => n.text).join("");
}

function makeDoc(opts: { sectionText?: string; listItems?: string[] } = {}): ArticleDocument {
  const intro: ArticleComponent = { id: "intro", status: "normalized", blocks: [paragraphBlock("intro-p0", "Intro one. Intro two.")] };
  const blocks: EditorialBlock[] = [];
  if (opts.sectionText) blocks.push(paragraphBlock("section-0-wp-0", opts.sectionText));
  if (opts.listItems) {
    blocks.push({
      id: "section-0-wp-1",
      type: "list",
      ordered: false,
      items: opts.listItems.map((item) => [{ type: "text", text: item }]),
    });
  }
  const section: ArticleSection = {
    id: "section-0",
    heading: "Leveraging Digital Marketing for Your Gym",
    headingLevel: 2,
    sectionType: "main",
    status: "normalized",
    blocks,
  };
  const conclusion: ArticleComponent = { id: "conclusion", status: "normalized", blocks: [paragraphBlock("conclusion-p0", "Conclusion one. Conclusion two.")] };
  return {
    metadata: { title: "Gym Marketing 2026 Guide", slug: "t", metaDescription: "Guide.", excerpt: "E.", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
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

function traceContext(): TraceContext {
  return { keyphrase: KEYPHRASE, research: [] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stage 3O: verb-particle endings are not dangling", () => {
  it("the exact live shape and common intransitive phrasal endings are clean", () => {
    for (const sentence of [LIVE_SENTENCE, ...VALID_PHRASAL_ENDINGS]) {
      expect(hasDanglingSentenceEnding(sentence), sentence).toBe(false);
      expect(findMalformedProseTextIssues([sentence]), sentence).toEqual([]);
    }
  });

  it("genuine dangling preposition endings remain rejected", () => {
    for (const sentence of GENUINE_DANGLING) {
      expect(hasDanglingSentenceEnding(sentence), sentence).toBe(true);
      expect(
        findMalformedProseTextIssues([sentence]).some((i) => i.code === "incomplete-sentence-ending"),
        sentence,
      ).toBe(true);
    }
  });
});

describe("Stage 3O: list-item / paragraph parity", () => {
  it("the live sentence is clean as both a list item and a paragraph", () => {
    const paragraphDoc = makeDoc({ sectionText: LIVE_SENTENCE });
    expect(scanMalformedProseInDocument(paragraphDoc)).toEqual([]);
    const listDoc = makeDoc({ listItems: ["Referrals – bring a friend.", LIVE_SENTENCE] });
    expect(scanMalformedProseInDocument(listDoc)).toEqual([]);
  });

  it("a genuinely dangling ending fails as both a list item and a paragraph", () => {
    const paragraphDoc = makeDoc({ sectionText: "We discussed the plan in." });
    expect(scanMalformedProseInDocument(paragraphDoc).length).toBeGreaterThan(0);
    const listDoc = makeDoc({ listItems: ["We discussed the plan in."] });
    expect(scanMalformedProseInDocument(listDoc).length).toBeGreaterThan(0);
  });
});

describe("Stage 3O: malformed repair safety", () => {
  it("a valid phrasal ending survives malformed-prose-repair unchanged", () => {
    const doc = makeDoc({ sectionText: LIVE_SENTENCE });
    const result = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    expect(result.repairedBlockIds).not.toContain("section-0-wp-0");
    expect(result.removedBlockIds).not.toContain("section-0-wp-0");
    const text = paragraphText(doc.sections[0].blocks[0]);
    expect(text).toBe(LIVE_SENTENCE);
  });

  it("a genuinely dangling ending is still repaired or removed when removable", () => {
    const doc = makeDoc({ sectionText: "We discussed the plan in." });
    doc.sections[0].blocks.push(paragraphBlock("section-0-wp-1", "A healthy paragraph that stays in place."));
    const before = scanMalformedProseInDocument(doc).length;
    expect(before).toBeGreaterThan(0);
    const result = repairDeterministicMalformedProse(doc, 1, {}, true, KEYPHRASE);
    // The dangling block is removable (the section has more than one block), so
    // it is removed rather than carried as an unresolved finding.
    expect(result.repairedBlockIds.length + result.removedBlockIds.length).toBeGreaterThan(0);
    const remaining = scanMalformedProseInDocument(doc).filter((f) => f.blockId === "section-0-wp-0");
    expect(remaining).toEqual([]);
  });
});

describe("Stage 3O: producer contract accepts the live sentence", () => {
  it("no incomplete-sentence-ending violation is produced for the live sentence", () => {
    const candidate = {
      blocks: [
        {
          id: "section-0-wp-1",
          type: "list" as const,
          ordered: false,
          items: [[{ type: "text" as const, text: "Referrals – bring a friend." }], [{ type: "text" as const, text: LIVE_SENTENCE }]],
        },
      ],
    };
    const ctx: ProducerComponentContext = { componentId: "section-0", componentType: "section", scope: "complete-component" };
    const result = validateProducerCandidate(candidate, ctx);
    expect(result.violations.some((v) => v.code === "incomplete-sentence-ending")).toBe(false);
  });
});

describe("Stage 3O: trace attribution across paragraph normalization", () => {
  it("a semantic finding that moves to a new block id is recorded as moved, not resolved+introduced", () => {
    const trace = new PipelineDebugTrace();
    const preDoc = makeDoc({ sectionText: "We discussed the plan in." });
    preDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-2", "We discussed the plan in.");
    const postDoc = structuredClone(preDoc);
    postDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-3", "We discussed the plan in."); // block churn

    trace.beginStage("paragraphs", JSON.stringify(preDoc), traceContext());
    trace.endStage("paragraphs", postDoc, traceContext(), true, false);

    const record = trace.recordsFor("paragraphs")[0];
    expect(record.introduced).toEqual([]);
    expect(record.resolved).toEqual([]);
    expect(record.moved.length).toBeGreaterThan(0);
    expect(record.moved[0].blockRef).toBe("section-0/section-0-wp-3");
    expect(record.firstIntroduced).toEqual([]);
  });

  it("a genuinely new malformed finding is still attributed to the real mutating stage", () => {
    const trace = new PipelineDebugTrace();
    const preDoc = makeDoc({ sectionText: "Clean paragraph one. Clean paragraph two." });
    const postDoc = structuredClone(preDoc);
    postDoc.sections[0].blocks[0] = paragraphBlock("section-0-wp-2", "We discussed the plan in.");

    trace.beginStage("factual-scan", JSON.stringify(preDoc), traceContext());
    trace.endStage("factual-scan", postDoc, traceContext(), true, false);

    const record = trace.recordsFor("factual-scan")[0];
    expect(record.introduced.length).toBeGreaterThan(0);
    expect(record.firstIntroduced.length).toBeGreaterThan(0);
    expect(record.firstIntroduced[0].blockRef).toBe("section-0/section-0-wp-2");
    expect(record.moved).toEqual([]);
  });
});

describe("Stage 3O: live snapshot replay", () => {
  it("the exact offending sentence has zero malformed findings and repair leaves it untouched", () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      documents: { rejectedCandidate: ArticleDocument };
    };
    const doc = structuredClone(snapshot.documents.rejectedCandidate);
    const findings = scanMalformedProseInDocument(doc);
    const item = doc.sections.find((s) => s.id === "section-2")!.blocks.find((b) => b.id === "section-2-wp-3");
    const text = listItemText(item!, 5);
    expect(text).toBe(LIVE_SENTENCE);
    expect(
      findings.some(
        (f) => f.blockId === "section-2-wp-3" && f.issues.some((i) => i.code === "incomplete-sentence-ending"),
      ),
    ).toBe(false);

    const kp = typeof (snapshot as unknown as { keyphrase: string }).keyphrase === "string"
      ? (snapshot as unknown as { keyphrase: string }).keyphrase
      : KEYPHRASE;
    const result = repairDeterministicMalformedProse(doc, 1, {}, true, kp);
    expect(result.repairedBlockIds).not.toContain("section-2-wp-3");
    expect(result.removedBlockIds).not.toContain("section-2-wp-3");
    const after = scanMalformedProseInDocument(doc);
    expect(after.filter((f) => f.blockId === "section-2-wp-3")).toEqual([]);
  });
});
