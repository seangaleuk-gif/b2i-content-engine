// ── Stage 3G: live-shadow replay ──
// Replays the REAL generated prose from the latest restaurant run through the
// proposed hybrid policy. Source data is read-only:
//   debug/pipeline-failures/2026-08-17T13-05-16-270Z_producer-section_4_repair_project-22.json
// plus the exact sentence-level disagreement paragraphs observed in the live
// shadow log (Stage 3F report). No live data is altered. The hybrid is NOT
// wired into production; this only answers "what would the policy have done?".

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { analyzeSentenceCompletenessDeterministic } from "@/lib/blog/sentence-completeness";
import { clauseAwareVerdict } from "@/lib/blog/clause-aware-classifier";
import { decideSentenceCompletenessHybrid } from "@/lib/blog/hybrid-sentence-completeness";
import { splitSentences } from "@/lib/seo/seo-text-utils";

const SNAPSHOT = path.resolve(
  "src",
  "lib",
  "__live-fixtures__",
  "2026-08-17T13-05-16-270Z_producer-section_4_repair_project-22.json",
);

interface LiveUnit {
  text: string;
  current: boolean;
  experimental: boolean;
  experimentalReason: string;
  hybrid: boolean;
  hybridSource: string;
  hybridReason: string;
}

function collectProse(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: string }).type;
    if (type !== "paragraph" && type !== "quote" && type !== "faq-answer") continue;
    const content = (block as { content?: Array<{ text?: string }> }).content ?? [];
    const text = content.map((node) => node.text ?? "").join("");
    if (text.trim()) out.push(text);
  }
  return out;
}

describe("Stage 3G hybrid live-shadow replay (evaluation only)", () => {
  it("replays the real restaurant-run units through the hybrid policy", () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as {
      blocks?: unknown;
      preRepair?: { blocks?: unknown };
      rawCandidate?: { blocks?: unknown };
    };

    const sourceBlocks = [
      ...collectProse(snapshot.blocks),
      ...collectProse(snapshot.preRepair?.blocks),
      ...collectProse(snapshot.rawCandidate?.blocks),
    ];
    expect(sourceBlocks.length).toBeGreaterThan(10);

    // Live shadow-log disagreement paragraphs captured in Stage 3F.
    const liveLogParagraphs = [
      "So what drives loyalty? It’s a mix of practical and emotional factors. Diners want consistency.",
      "Personalised service is one of the strongest pull factors for repeat visits.",
      "Local engagement matters too for building a regular customer base.",
      "That’s the core of the SKIP model. It reminds us that retention starts with the team.",
    ];

    const units = new Map<string, string>();
    for (const block of [...sourceBlocks, ...liveLogParagraphs]) {
      for (const unit of splitSentences(block)) units.set(unit, unit);
    }
    expect(units.size).toBeGreaterThan(15);

    const report: LiveUnit[] = [];
    for (const unit of units.values()) {
      const authoritative = analyzeSentenceCompletenessDeterministic(unit, "paragraph");
      const experimental = clauseAwareVerdict(unit, "paragraph", authoritative);
      const hybrid = decideSentenceCompletenessHybrid({
        text: unit,
        kind: "paragraph",
        authoritative,
        experimental,
      });
      report.push({
        text: unit,
        current: authoritative.complete,
        experimental: experimental.complete,
        experimentalReason: experimental.reason,
        hybrid: hybrid.complete,
        hybridSource: hybrid.source,
        hybridReason: hybrid.reason,
      });
    }

    const outPath = path.resolve("debug", "hybrid-live-replay-report.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ units: report.length, rows: report }, null, 2), "utf8");

    const block7Unit = report.find((row) => row.text === "Instead, weave service skills into your weekly routine.");
    expect(block7Unit).toBeTruthy();
    expect(block7Unit!.current).toBe(false);
    expect(block7Unit!.hybrid).toBe(true);
    expect(block7Unit!.hybridSource).toBe("nlp-rescue");

    // The hybrid never rejects a unit the authoritative analyzer passes with
    // weak experimental evidence: every authoritative PASS unit stays PASS
    // unless rejected on a proven subordinate-only shape.
    for (const row of report) {
      if (row.current) {
        expect(row.hybrid, `must not reject authoritative pass: ${row.text}`).toBe(true);
      }
    }

    // Replays of the live-log paragraphs: no whole-paragraph aggregate
    // misjudgement; every unit-level decision keeps authoritative semantics.
    const soWhat = report.find((row) => row.text === "So what drives loyalty?");
    expect(soWhat).toBeTruthy();
    expect(soWhat!.current).toBe(true);
    expect(soWhat!.hybrid).toBe(true);
    expect(soWhat!.hybridSource).toBe("authoritative");
  });
});
