import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  analyzeSentenceCompleteness,
  type SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";
import { resetSentenceCompletenessShadowDedup } from "@/lib/blog/sentence-completeness-shadow";
import * as classifierModule from "@/lib/blog/clause-aware-classifier";

interface WarnSpy {
  mock: { calls: unknown[][] };
}

function warnLines(warnSpy: WarnSpy): string[] {
  return warnSpy.mock.calls.map((args) => args.map(String).join(" "));
}

function shadowEvents(warnSpy: WarnSpy): string[] {
  return warnLines(warnSpy).filter((line) => line.includes("[sentence-completeness-shadow]"));
}

function shadowEvent(warnSpy: WarnSpy): string | undefined {
  return shadowEvents(warnSpy)[0];
}

afterEach(() => {
  delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
  resetSentenceCompletenessShadowDedup();
  vi.restoreAllMocks();
});

describe("sentence-completeness shadow (Stage 3E)", () => {
  it("3E-A: current FAIL / experimental PASS keeps FAIL and logs one disagreement", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness(
      "When feedback arrives, respond quickly and personally.",
      "paragraph",
    );
    expect(result.complete).toBe(false);
    expect(result.issues[0].code).toBe("no-finite-predicate");
    const event = shadowEvent(warnSpy);
    expect(event).toBeTruthy();
    expect(event).toContain("kind=paragraph");
    expect(event).toContain("current=fail");
    expect(event).toContain("experimental=pass");
    expect(event).toContain("currentIssue=no-finite-predicate");
    expect(event).toContain("reason=main-clause-predicate");
    expect(event).toContain('text="When feedback arrives, respond quickly and personally."');
  });

  it("B: current PASS / experimental FAIL keeps PASS and logs one disagreement", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness("When feedback arrives.", "paragraph");
    expect(result.complete).toBe(true);
    expect(result.issues).toHaveLength(0);
    const event = shadowEvent(warnSpy);
    expect(event).toBeTruthy();
    expect(event).toContain("kind=paragraph");
    expect(event).toContain("current=pass");
    expect(event).toContain("experimental=fail");
    expect(event).not.toContain("currentIssue=");
    expect(event).toContain("reason=subordinate-only");
    expect(event).toContain('text="When feedback arrives."');
  });

  it("C: both agree valid → no disagreement log", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness("Customers plan their visits.", "paragraph");
    expect(result.complete).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("D: both agree invalid → no disagreement log", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness("A stronger digital presence for repeat guests.", "paragraph");
    expect(result.complete).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("E: debug flag disabled → Compromise classifier is not executed and nothing is logged", () => {
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const classifySpy = vi.spyOn(classifierModule, "clauseAwareVerdict");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness(
      "When feedback arrives, respond quickly and personally.",
      "paragraph",
    );
    expect(result.complete).toBe(false);
    expect(classifySpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("E2: explicit false flag behaves like disabled", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "false";
    const classifySpy = vi.spyOn(classifierModule, "clauseAwareVerdict");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    analyzeSentenceCompleteness("When feedback arrives.", "paragraph");
    expect(classifySpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("F: byte-identical authoritative results with shadow enabled vs disabled", () => {
    const corpus: Array<{ text: string; kind: SentenceCompletenessKind; options?: boolean }> = [
      { text: "When feedback arrives, respond quickly and personally.", kind: "paragraph" },
      { text: "When feedback arrives.", kind: "paragraph" },
      { text: "Repeat business for local teams.", kind: "paragraph" },
      { text: "Prices rose sharply this year.", kind: "paragraph" },
      { text: "After the rush ends, staff rest.", kind: "paragraph" },
      { text: "Whenever the phone rings, someone answers.", kind: "paragraph" },
      { text: "Customers plan their visits.", kind: "paragraph" },
      { text: "A stronger digital presence for repeat guests.", kind: "paragraph" },
      { text: "The menu is ready for the", kind: "paragraph" },
      { text: "What they do stop for?", kind: "paragraph" },
      { text: "Local teams share useful lessons from daily work with clear and honest words.", kind: "paragraph" },
      { text: "So make feedback work for you, and turn every comment into a reason to return.", kind: "paragraph" },
      { text: "Yes, daily.", kind: "faq-answer" },
      { text: "No.", kind: "faq-answer" },
      { text: "Twice a week.", kind: "faq-answer" },
      { text: "He asked for the bill.", kind: "quote" },
      { text: "Choose the Right Space", kind: "subheading" },
      { text: "Turn complaints into loyalty", kind: "heading" },
      { text: "Repeat the offer only when it works.", kind: "heading" },
      { text: "Item A", kind: "list-item" },
      { text: "2026", kind: "table-cell" },
      { text: "A complete title for a guide", kind: "title" },
      { text: "A meta description is complete prose without punctuation.", kind: "meta-description" },
      { text: "A short excerpt", kind: "excerpt" },
      { text: "Sources: local restaurants (2026).", kind: "paragraph" },
      { text: "Sources:", kind: "paragraph" },
      { text: "", kind: "paragraph" },
      { text: "   ", kind: "paragraph" },
      { text: "Choose a dish:", kind: "paragraph" },
      { text: "This is fine. And this too. And a trailing fragment", kind: "paragraph" },
      { text: "A single orientation session won’t stick. Instead, weave service skills into your weekly routine. Role-play common scenarios, share feedback from online reviews and celebrate staff who go the extra mile. Keep it short and practical, so it feels like support, not a lecture.", kind: "paragraph" },
      { text: "So what drives loyalty? It’s a mix of practical and emotional factors. Diners want consistency.", kind: "paragraph" },
      { text: "Instead, weave service skills into your weekly routine.", kind: "paragraph" },
      { text: "Customers plan their visits. The host greets every table. We email the menu each week.", kind: "paragraph" },
    ];

    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const disabled = corpus.map((entry) => {
      const result = analyzeSentenceCompleteness(entry.text, entry.kind, {
        allowColonBeforeStructuredContinuation: entry.options ?? false,
      });
      return { text: entry.text, kind: entry.kind, result: JSON.stringify(result) };
    });

    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const enabled = corpus.map((entry) => {
      const result = analyzeSentenceCompleteness(entry.text, entry.kind, {
        allowColonBeforeStructuredContinuation: entry.options ?? false,
      });
      return { text: entry.text, kind: entry.kind, result: JSON.stringify(result) };
    });

    expect(enabled).toEqual(disabled);
  });

  it("H: no producer or mutator directly imports Compromise", () => {
    const root = path.resolve("src");
    const excluded = new Set([
      path.resolve("src", "lib", "blog", "clause-aware-classifier.ts"),
      path.resolve("src", "lib", "blog", "sentence-completeness-shadow.ts"),
    ]);
    const production = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...production(full));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          out.push(full);
        }
      }
      return out;
    };
    const files = production(root).filter((file) => !excluded.has(path.resolve(file)));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["']compromise["']|require\(\s*["']compromise["']\s*\)|requireCjs\(\s*["']compromise["']\s*\)/);
    }
  });
});

describe("sentence-completeness shadow unit alignment (Stage 3F)", () => {
  const BLOCK_7 =
    "A single orientation session won’t stick. Instead, weave service skills into your weekly routine. Role-play common scenarios, share feedback from online reviews and celebrate staff who go the extra mile. Keep it short and practical, so it feels like support, not a lecture.";

  it("A: multi-sentence valid paragraph never fails as a whole block", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paragraph =
      "So what drives loyalty? It’s a mix of practical and emotional factors. Diners want consistency.";
    const result = analyzeSentenceCompleteness(paragraph, "paragraph");
    expect(result.complete).toBe(true);
    const events = shadowEvents(warnSpy);
    // The whole paragraph is never emitted as a single compared unit and never
    // produces a no-predicate-evidence failure just because it is multi-sentence.
    expect(events.some((event) => event.includes("text=\"" + paragraph.slice(0, 40)))).toBe(false);
    expect(events.some((event) => event.includes("reason=no-predicate-evidence"))).toBe(false);
    // The only unit-level disagreement is the genuine "So what"-question
    // classifier limitation — attributed to that single unit, not the paragraph.
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("current=pass");
    expect(events[0]).toContain("experimental=fail");
    expect(events[0]).toContain("reason=question-unresolved");
    expect(events[0]).toContain('text="So what drives loyalty?"');
  });

  it("B: valid multi-sentence paragraph with one known false rejection logs only that unit", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness(BLOCK_7, "paragraph");
    expect(result.complete).toBe(false);
    expect(result.issues[0].code).toBe("no-finite-predicate");
    const events = shadowEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("kind=paragraph");
    expect(events[0]).toContain("current=fail");
    expect(events[0]).toContain("experimental=pass");
    expect(events[0]).toContain("currentIssue=no-finite-predicate");
    expect(events[0]).toContain("reason=main-clause-predicate");
    expect(events[0]).toContain('text="Instead, weave service skills into your weekly routine."');
  });

  it("C: subordinate+imperative still logs current=fail / experimental=pass at unit level", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness("When feedback arrives, respond quickly and personally.", "paragraph");
    expect(result.complete).toBe(false);
    const events = shadowEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("current=fail");
    expect(events[0]).toContain("experimental=pass");
    expect(events[0]).toContain("reason=main-clause-predicate");
    expect(events[0]).toContain('text="When feedback arrives, respond quickly and personally."');
  });

  it("D: subordinate-only still logs current=pass / experimental=fail at unit level", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness("When feedback arrives.", "paragraph");
    expect(result.complete).toBe(true);
    const events = shadowEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("current=pass");
    expect(events[0]).toContain("experimental=fail");
    expect(events[0]).not.toContain("currentIssue=");
    expect(events[0]).toContain("reason=subordinate-only");
    expect(events[0]).toContain('text="When feedback arrives."');
  });

  it("E: multiple complete sentences → no disagreement if each unit agrees", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness(
      "Customers plan their visits. Teams offer discounts on slow nights. Audiences trust peers more than ads.",
      "paragraph",
    );
    expect(result.complete).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("F: authoritative aggregate result is byte-identical before/after refactor (covered by enabled-vs-disabled)", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const withShadow = JSON.stringify(analyzeSentenceCompleteness(BLOCK_7, "paragraph"));
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const withoutShadow = JSON.stringify(analyzeSentenceCompleteness(BLOCK_7, "paragraph"));
    expect(withShadow).toBe(withoutShadow);
  });

  it("G: debug disabled → experimental classifier is not executed", () => {
    delete process.env.ENABLE_PIPELINE_DEBUG_TRACE;
    const classifySpy = vi.spyOn(classifierModule, "clauseAwareVerdict");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = analyzeSentenceCompleteness(BLOCK_7, "paragraph");
    expect(result.complete).toBe(false);
    expect(classifySpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("dedup: the same unit disagreement is emitted once across repeated checks", () => {
    process.env.ENABLE_PIPELINE_DEBUG_TRACE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      analyzeSentenceCompleteness("When feedback arrives.", "paragraph");
    }
    const events = shadowEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('text="When feedback arrives."');
  });
});
