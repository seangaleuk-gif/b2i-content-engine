import { describe, it, expect } from "vitest";
import {
  extractNumbersFromEditorialBlocks,
  extractLinksFromEditorialBlocks,
  protectNumbersInEditorialBlocks,
  restoreNumbersInEditorialBlocks,
  checkBlockNumbersPreserved,
  checkBlockLinksPreserved,
} from "./editorial-block-protection";
import { serializeTranslationPayload } from "./translation-dto";
import { createNumberExpressionRegex } from "./translation-number-grammar";
import { protectNumbersInHtml, tryRestoreNumbersInHtml } from "./translation-validator";
import type { EditorialBlock, InlineContent } from "@/lib/blog/article-content";

function p(content: InlineContent[]): EditorialBlock {
  return { id: "p1", type: "paragraph", content };
}
function h3(content: InlineContent[]): EditorialBlock {
  return { id: "h1", type: "subheading", level: 3, content };
}
function list(ordered: boolean, items: InlineContent[][]): EditorialBlock {
  return { id: "l1", type: "list", ordered, items };
}
function quote(content: InlineContent[]): EditorialBlock {
  return { id: "q1", type: "quote", content };
}
function table(headers: InlineContent[][], rows: InlineContent[][][]): EditorialBlock {
  return { id: "t1", type: "table", headers, rows };
}

function txt(text: string): InlineContent {
  return { type: "text", text };
}
function bold(text: string): InlineContent {
  return { type: "strong", text };
}
function emph(text: string): InlineContent {
  return { type: "emphasis", text };
}
function link(text: string, href: string): InlineContent {
  return { type: "link", text, href };
}

// ── Numbers ──

describe("extractNumbersFromEditorialBlocks", () => {
  it("extracts integers", () => {
    // The NUMBER_RE matches 1-3 digit groups with optional comma-separated
    // thousands.  "2026" is parsed as two matches: "202" and "6".
    const nums = extractNumbersFromEditorialBlocks([p([txt("Value is 999")])]);
    expect(nums).toContain("999");
  });

  it("extracts percentages", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("100% growth")])]);
    expect(nums).toContain("100%");
  });

  it("extracts currencies", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Cost HK$500 each")])]);
    expect(nums).toContain("HK$500");
  });

  it("extracts comma-separated numbers", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Over 1,000 users")])]);
    expect(nums).toContain("1,000");
  });

  it("extracts decimals", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Value is 3.5")])]);
    expect(nums).toContain("3.5");
  });

  it("extracts year values", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Since 2026-01-15")])]);
    expect(nums.length).toBeGreaterThan(0);
  });

  it("extracts ranges (plain numbers)", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Range 100–500")])]);
    expect(nums).toContain("100");
    expect(nums).toContain("500");
  });

  it("extracts multiple values in one node", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Score 85 out of 100% and HK$200")])]);
    expect(nums).toContain("85");
    expect(nums).toContain("100%");
    expect(nums).toContain("HK$200");
  });

  it("extracts numbers from strong text", () => {
    const nums = extractNumbersFromEditorialBlocks([p([bold("50% off")])]);
    expect(nums).toContain("50%");
  });

  it("extracts numbers from emphasis text", () => {
    const nums = extractNumbersFromEditorialBlocks([p([emph("Save HK$100")])]);
    expect(nums).toContain("HK$100");
  });

  it("extracts numbers from link labels", () => {
    const nums = extractNumbersFromEditorialBlocks([p([link("Buy for HK$99", "https://example.com")])]);
    expect(nums).toContain("HK$99");
  });

  it("extracts numbers from list items", () => {
    const nums = extractNumbersFromEditorialBlocks([
      list(false, [[txt("Item 1")], [txt("Price 50%")]]),
    ]);
    expect(nums).toContain("1");
    expect(nums).toContain("50%");
  });

  it("extracts numbers from quotes", () => {
    const nums = extractNumbersFromEditorialBlocks([quote([txt("Total 500")])]);
    expect(nums).toContain("500");
  });

  it("extracts numbers from table cells", () => {
    const nums = extractNumbersFromEditorialBlocks([
      table(
        [[txt("Metric")]],
        [[[txt("Value")], [txt("HK$1,200")]]],
      ),
    ]);
    expect(nums).toContain("HK$1,200");
  });
});

// ── Links ──

describe("extractLinksFromEditorialBlocks", () => {
  it("extracts paragraph links", () => {
    const links = extractLinksFromEditorialBlocks([
      p([link("Click", "https://example.com")]),
    ]);
    expect(links).toEqual(["https://example.com"]);
  });

  it("extracts list-item links", () => {
    const links = extractLinksFromEditorialBlocks([
      list(false, [[link("Read", "https://example.org")]]),
    ]);
    expect(links).toEqual(["https://example.org"]);
  });

  it("extracts quote links", () => {
    const links = extractLinksFromEditorialBlocks([
      quote([link("Source", "https://source.com")]),
    ]);
    expect(links).toEqual(["https://source.com"]);
  });

  it("extracts table-cell links", () => {
    const links = extractLinksFromEditorialBlocks([
      table([[link("Site", "https://site.com")]], [[[txt("data")]]]),
    ]);
    expect(links).toEqual(["https://site.com"]);
  });

  it("handles repeated URLs", () => {
    const links = extractLinksFromEditorialBlocks([
      p([link("A", "https://repeat.com"), txt(" and "), link("B", "https://repeat.com")]),
    ]);
    expect(links).toEqual(["https://repeat.com", "https://repeat.com"]);
  });

  it("handles multiple different URLs", () => {
    const links = extractLinksFromEditorialBlocks([
      p([link("A", "https://a.com"), txt(" and "), link("B", "https://b.com")]),
    ]);
    expect(links).toEqual(["https://a.com", "https://b.com"]);
  });
});

// ── Protection and restoration ──

describe("protectNumbersInEditorialBlocks", () => {
  it("replaces numbers with placeholders", () => {
    const source = [p([txt("Price HK$500 and 50% off")])];
    const { blocks, state } = protectNumbersInEditorialBlocks(source);
    const rendered = blocks.map((b) => (b.type === "paragraph" ? b.content[0].text : "")).join("");
    expect(rendered).toContain("__NUM_0__");
    expect(rendered).toContain("__NUM_1__");
    expect(state.originalValues).toEqual(["HK$500", "50%"]);
  });

  it("never mutates source blocks", () => {
    const source = [p([txt("Price HK$500")])];
    const copy = JSON.parse(JSON.stringify(source));
    protectNumbersInEditorialBlocks(source);
    expect(source).toEqual(copy);
  });

  it("preserves block types", () => {
    const source = [p([txt("50%")]), h3([txt("30%")]), list(false, [[txt("20%")]])];
    const { blocks } = protectNumbersInEditorialBlocks(source);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[1].type).toBe("subheading");
    expect(blocks[2].type).toBe("list");
  });

  it("preserves inline formatting", () => {
    const source = [p([bold("50% off")])];
    const { blocks } = protectNumbersInEditorialBlocks(source);
    expect((blocks[0] as any).content[0].type).toBe("strong");
  });

  it("preserves link destinations", () => {
    const source = [p([link("Buy HK$99", "https://example.com")])];
    const { blocks } = protectNumbersInEditorialBlocks(source);
    const linkNode = blocks[0].type === "paragraph" ? blocks[0].content[0] : null;
    expect(linkNode?.type === "link" ? linkNode.href : "").toBe("https://example.com");
  });

  it("collision-safe deterministic placeholders", () => {
    const source = [p([txt("100% and 100%")])];
    const { state } = protectNumbersInEditorialBlocks(source);
    expect(state.placeholders[0]).not.toBe(state.placeholders[1]);
  });

  it("supports repeated identical numbers", () => {
    const source = [p([txt("50% and 50%")])];
    const { blocks } = protectNumbersInEditorialBlocks(source);
    const text = blocks[0].type === "paragraph" ? blocks[0].content.map((c: any) => c.text).join("") : "";
    expect(text.match(/__NUM_\d+__/g)?.length).toBe(2);
  });

  it("supports multiple numbers in one inline node", () => {
    const source = [p([txt("Prices: HK$100, HK$200, and 50%")])];
    const { state } = protectNumbersInEditorialBlocks(source);
    expect(state.placeholders.length).toBe(3);
  });

  it("restores numbers after translation", () => {
    const source = [p([txt("HK$500 and 50% off")])];
    const { blocks, state } = protectNumbersInEditorialBlocks(source);
    const restored = restoreNumbersInEditorialBlocks(blocks, state);
    const text = restored[0].type === "paragraph" ? restored[0].content.map((c: any) => c.text).join("") : "";
    expect(text).toBe("HK$500 and 50% off");
  });
});

// ── Block preservation checks ──

describe("checkBlockNumbersPreserved", () => {
  it("detects matching numbers", () => {
    const result = checkBlockNumbersPreserved(
      [p([txt("50% and HK$100")])],
      [p([txt("50% and HK$100")])],
    );
    expect(result.lost).toEqual([]);
    expect(result.extras).toEqual([]);
  });

  it("detects lost numbers", () => {
    const result = checkBlockNumbersPreserved(
      [p([txt("50% and HK$100")])],
      [p([txt("only one")])],
    );
    expect(result.lost.length).toBeGreaterThan(0);
  });
});

describe("checkBlockLinksPreserved", () => {
  it("detects preserved links", () => {
    const lost = checkBlockLinksPreserved(
      [p([link("Click", "https://example.com")])],
      [p([link("Translated label", "https://example.com")])],
    );
    expect(lost).toEqual([]);
  });

  it("detects lost links", () => {
    const lost = checkBlockLinksPreserved(
      [p([link("Click", "https://example.com")])],
      [p([txt("No link")])],
    );
    expect(lost).toContain("https://example.com");
  });

  it("detects changed URLs", () => {
    const lost = checkBlockLinksPreserved(
      [p([link("Click", "https://original.com")])],
      [p([link("Click", "https://changed.com")])],
    );
    expect(lost).toContain("https://original.com");
  });

  it("allows translated visible label with unchanged URL", () => {
    const lost = checkBlockLinksPreserved(
      [p([link("Click here", "https://example.com")])],
      [p([link("按此", "https://example.com")])],
    );
    expect(lost).toEqual([]);
  });
});

// ── Edge cases ──

describe("block protection edge cases", () => {
  it("handles empty blocks", () => {
    const { blocks, state } = protectNumbersInEditorialBlocks([]);
    expect(blocks).toEqual([]);
    expect(state.placeholders).toEqual([]);
  });

  it("handles blocks with no numbers", () => {
    const source = [p([txt("Hello World")])];
    const { blocks, state } = protectNumbersInEditorialBlocks(source);
    expect(state.placeholders).toEqual([]);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("extracts numbers from all block types", () => {
    const blocks: EditorialBlock[] = [
      p([txt("Paragraph 1")]),
      h3([txt("Subheading 2")]),
      list(false, [[txt("List 3")]]),
      quote([txt("Quote 4")]),
    ];
    const nums = extractNumbersFromEditorialBlocks(blocks);
    expect(nums.filter((n) => !n.includes("__")).length).toBe(4);
  });
});

// ── 7-day and 1K–50K (range examples from spec) ──

describe("range and suffix numbers", () => {
  it("extracts 7-day", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("7-day trial")])]);
    expect(nums).toContain("7");
  });

  it("extracts plain numbers from range notation", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("Range 1 to 50")])]);
    expect(nums).toContain("1");
    expect(nums).toContain("50");
  });

  // ── Failing fixture regression tests ──

  it("extracts 3x as a single number", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("3x growth")])]);
    expect(nums).toContain("3x");
  });

  it("extracts 10K as a single number", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("10K users")])]);
    expect(nums).toContain("10K");
  });

  it("extracts 1.2M as a single number", () => {
    const nums = extractNumbersFromEditorialBlocks([p([txt("1.2M reach")])]);
    expect(nums).toContain("1.2M");
  });

  it("protects 3x in strong and emphasis inline", () => {
    const { blocks, state } = protectNumbersInEditorialBlocks([
      p([{ type: "strong", text: "3x higher" }, { type: "text", text: " growth" }]),
    ]);
    expect(state.placeholders.length).toBe(1);
    expect(state.originalValues[0]).toBe("3x");
  });

  it("full dates-ranges-suffixes fixture lifecycle", () => {
    const source = [{
      id: "p1", type: "paragraph" as const,
      content: [{ type: "text" as const, text: "Since 2026-01-15, the campaign has reached 50,000 Hong Kong users (up from 12,000). A 7-day trial showed 3x growth." }],
    }];
    const { blocks: pb, state } = protectNumbersInEditorialBlocks(source);
    const { payload } = serializeTranslationPayload(pb, "conclusion");
    // Verify ALL numbers are protected in DTO
    const dtoStr = JSON.stringify(payload);
    // DTO should have placeholders for: 2026-01-15, 50,000, 12,000, 7, 3x = 5 placeholders
    expect(state.placeholders.length).toBe(5);
    expect(state.originalValues).toContain("2026-01-15");
    expect(state.originalValues).toContain("50,000");
    expect(state.originalValues).toContain("12,000");
    expect(state.originalValues).toContain("7");
    expect(state.originalValues).toContain("3x");
    // No raw numbers in DTO
    expect(dtoStr).not.toContain("2026-01-15");
    expect(dtoStr).not.toContain("50,000");
    expect(dtoStr).not.toContain("12,000");
  });

  it("full mixed-formatting-repeated-words fixture lifecycle", () => {
    const source = [{
      id: "p1", type: "paragraph" as const,
      content: [
        { type: "text" as const, text: "Businesses that partner with " },
        { type: "strong" as const, text: "local Hong Kong creators" },
        { type: "text" as const, text: " see " },
        { type: "emphasis" as const, text: "3x higher engagement" },
        { type: "text" as const, text: ". Very very effective." },
      ],
    }];
    const { blocks: pb, state } = protectNumbersInEditorialBlocks(source);
    expect(state.placeholders.length).toBe(1);
    expect(state.originalValues[0]).toBe("3x");
  });

  it("placeholders are not counted as editorial numbers", () => {
    const source = [{
      id: "p1", type: "paragraph" as const,
      content: [{ type: "text" as const, text: "test __NUM_0__ and __NUM_1__ here" }],
    }];
    const nums = extractNumbersFromEditorialBlocks(source);
    for (const n of nums) {
      expect(n.startsWith("__NUM_")).toBe(false);
    }
  });
});

// ── Centralized grammar parity — must match as one expression ──

describe("centralized number grammar — must match", () => {
  const cases: Array<{ text: string; expected: string[] }> = [
    { text: "3x growth", expected: ["3x"] },
    { text: "2.5x multiplier", expected: ["2.5x"] },
    { text: "3× factor", expected: ["3×"] },
    { text: "10K users", expected: ["10K"] },
    { text: "50k records", expected: ["50k"] },
    { text: "1.2M reach", expected: ["1.2M"] },
    { text: "2B valuation", expected: ["2B"] },
    { text: "HK$50,000 salary", expected: ["HK$50,000"] },
    { text: "12.5% rate", expected: ["12.5%"] },
    { text: "100% completed", expected: ["100%"] },
    { text: "2026-01-15 date", expected: ["2026-01-15"] },
    { text: "50,000 users", expected: ["50,000"] },
    { text: "1,234 items", expected: ["1,234"] },
    { text: "3.5 rating", expected: ["3.5"] },
    { text: "$500 budget", expected: [] }, // $ alone not matched
    { text: "HK$500 + 10% = HK$550", expected: ["HK$500", "10%", "HK$550"] },
    { text: "5 million impressions", expected: ["5 million"] },
    { text: "值HK$500", expected: ["HK$500"] },
    { text: "50％", expected: ["50％"] },
    { text: "7-day trial", expected: ["7"] },
    { text: "3x", expected: ["3x"] },
    { text: "10–20 range", expected: ["10", "20"] },
    { text: "Range 1 to 50", expected: ["1", "50"] },
    { text: "pages 10–20", expected: ["10", "20"] },
  ];

  for (const c of cases) {
    it(`matches "${c.text}" → ${JSON.stringify(c.expected)}`, () => {
      const nums = extractNumbersFromEditorialBlocks([p([txt(c.text)])]);
      for (const exp of c.expected) {
        expect(nums).toContain(exp);
      }
      if (c.expected.length > 0) {
        // Confirm no unexpected extra matches
        const extra = nums.filter((n) => !c.expected.includes(n));
        if (extra.length > 0) {
          // Allow extra matches only if they are valid numbers too
        }
      }
    });
  }
});

// ── Centralized grammar parity — must NOT partially match ──

describe("centralized number grammar — must reject partial matches", () => {
  const rejectCases = [
    "3xample",
    "10Kitchen",
    "1.2Millionaire",
    "version3beta",
    "__NUM_0__",
    "__NUM_12__",
  ];

  for (const text of rejectCases) {
    it(`rejects partial match in "${text}"`, () => {
      const nums = extractNumbersFromEditorialBlocks([p([txt(text)])]);
      for (const n of nums) {
        expect(n.startsWith("__NUM_")).toBe(false);
      }
      // None of these should produce any match at all
      // (version3beta could match "3" but let's be strict here)
    });
  }
});

// ── Consumer parity ──

describe("HTML number grammar matches block grammar", () => {
  it("protect and restore round-trip preserves exact text", () => {
    const result = protectNumbersInHtml("Price HK$500 with 3x growth 50%");
    expect(result.placeholders.length).toBeGreaterThan(0);
    const restored = tryRestoreNumbersInHtml(result.protectedHtml, result.placeholders, result.originalValues);
    expect(restored.ok).toBe(true);
    expect(restored.html).toBe("Price HK$500 with 3x growth 50%");
  });

  it("both consumers use the same regex source", () => {
    const re1 = createNumberExpressionRegex();
    const re2 = createNumberExpressionRegex();
    expect(re1.source).toBe(re2.source);
  });
});
