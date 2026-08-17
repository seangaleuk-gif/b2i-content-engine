import { describe, it, expect } from "vitest";
import {
  normalizeAiEditorialPayload,
  renderEditorialBlocksToWordPress,
  validateEditorialBlocks,
  extractPlainTextFromEditorialBlocks,
  countEditorialBlockWords,
  cloneEditorialBlocks,
  parseWordPressEditorialBlocks,
  type EditorialBlock,
} from "./article-content";

// ── normalizeAiEditorialPayload ──

describe("normalizeAiEditorialPayload", () => {
  it("normalizes paragraph block", () => {
    const input = { blocks: [{ type: "paragraph", text: "Hello world." }] };
    const result = normalizeAiEditorialPayload(input, "sec-0");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({
      id: "sec-0-paragraph-0",
      type: "paragraph",
    });
  });

  it("normalizes subheading block", () => {
    const input = { blocks: [{ type: "subheading", text: "Key Benefits" }] };
    const result = normalizeAiEditorialPayload(input, "sec-1");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({
      id: "sec-1-subheading-0",
      type: "subheading",
      level: 3,
    });
  });

  it("normalizes ordered list block", () => {
    const input = {
      blocks: [{ type: "list", ordered: true, items: ["First", "Second", "Third"] }],
    };
    const result = normalizeAiEditorialPayload(input, "sec-2");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({
      id: "sec-2-list-0",
      type: "list",
      ordered: true,
    });
  });

  it("normalizes unordered list block", () => {
    const input = {
      blocks: [{ type: "list", ordered: false, items: ["A", "B"] }],
    };
    const result = normalizeAiEditorialPayload(input, "sec-3");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({
      id: "sec-3-list-0",
      type: "list",
      ordered: false,
    });
  });

  it("accepts a colon-led paragraph only when a non-empty list immediately follows", () => {
    const result = normalizeAiEditorialPayload({
      blocks: [
        { type: "paragraph", text: "Use these safeguards:" },
        { type: "list", ordered: false, items: ["Collect only necessary data", "Document consent"] },
      ],
    }, "sec-list-setup");

    expect(result.errors).toEqual([]);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph", "list"]);
  });

  it("rejects a colon-led paragraph when no structured continuation follows", () => {
    const result = normalizeAiEditorialPayload({
      blocks: [{ type: "paragraph", text: "Use these safeguards:" }],
    }, "sec-dangling-setup");

    expect(result.errors.join(" ")).toContain("unfinished setup");
  });

  it("normalizes and merges unambiguous singleton list aliases", () => {
    const result = normalizeAiEditorialPayload({
      blocks: [
        { type: "paragraph", text: "Use these safeguards:" },
        { type: "list", ordered: false, text: "Collect only necessary data" },
        { type: "list", ordered: false, item: "Document consent" },
        { type: "list", ordered: false, items: "Review access regularly" },
      ],
    }, "sec-singletons");

    expect(result.errors).toEqual([]);
    expect(result.recoveries).toHaveLength(5);
    expect(result.blocks).toHaveLength(2);
    const list = result.blocks[1];
    expect(list.type).toBe("list");
    if (list.type !== "list") throw new Error("expected list");
    expect(list.items.map((item) => item.map((node) => node.text).join(""))).toEqual([
      "Collect only necessary data",
      "Document consent",
      "Review access regularly",
    ]);
    const html = renderEditorialBlocksToWordPress(result.blocks);
    expect(html.match(/<!-- wp:list /g)).toHaveLength(1);
    const roundTrip = parseWordPressEditorialBlocks(html, "sec-singletons-roundtrip");
    expect(roundTrip.errors).toEqual([]);
    expect(roundTrip.blocks.map((block) => block.type)).toEqual(["paragraph", "list"]);
  });

  it("rejects conflicting canonical and singleton list content", () => {
    const result = normalizeAiEditorialPayload({
      blocks: [{ type: "list", ordered: false, items: ["Canonical"], text: "Different" }],
    }, "sec-conflict");

    expect(result.blocks).toEqual([]);
    expect(result.errors.join(" ")).toContain("both 'items' and singleton");
  });

  it("does not treat a dash-ended paragraph as a valid list setup", () => {
    const result = normalizeAiEditorialPayload({
      blocks: [
        { type: "paragraph", text: "Use these safeguards —" },
        { type: "list", ordered: false, items: ["Collect only necessary data"] },
      ],
    }, "sec-dash");

    expect(result.errors.join(" ")).toContain("unfinished setup");
  });

  it("normalizes an attributable quote block", () => {
    const input = { blocks: [{ type: "quote", text: '"A wise statement," said the analyst.' }] };
    const result = normalizeAiEditorialPayload(input, "sec-4");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({ id: "sec-4-quote-0", type: "quote" });
  });

  it("demotes an unattributed quote to a paragraph (quote provenance contract)", () => {
    const input = { blocks: [{ type: "quote", text: "Brands that prove their worth will win over their audiences." }] };
    const result = normalizeAiEditorialPayload(input, "sec-4");
    expect(result.errors.length).toBe(0);
    expect(result.blocks[0]).toMatchObject({ id: "sec-4-quote-0", type: "paragraph" });
    expect(result.recoveries.join(" ")).toContain("demoted unattributed quote");
  });

  it("rejects an AI block with an unmatched quotation before rendering", () => {
    const result = normalizeAiEditorialPayload({
      blocks: [{ type: "quote", text: "The source says “this quotation never closes." }],
    }, "sec-unmatched-quote");
    expect(result.errors).toContain("Block 0 quote: contains an unmatched quotation mark");
  });

  it("normalizes table block", () => {
    const input = {
      blocks: [
        {
          type: "table",
          headers: ["Name", "Price"],
          rows: [
            ["Item A", "$10"],
            ["Item B", "$20"],
          ],
        },
      ],
    };
    const result = normalizeAiEditorialPayload(input, "sec-5");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({ id: "sec-5-table-0", type: "table" });
  });

  it("accepts direct array for defensive compatibility", () => {
    const input = [{ type: "paragraph", text: "Direct array item." }];
    const result = normalizeAiEditorialPayload(input, "sec-6");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
  });

  it("rejects unknown block types", () => {
    const input = { blocks: [{ type: "unknown", content: "stuff" }] };
    const result = normalizeAiEditorialPayload(input, "sec-7");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBe(0);
  });

  it("rejects empty paragraph", () => {
    const input = { blocks: [{ type: "paragraph", text: "" }] };
    const result = normalizeAiEditorialPayload(input, "sec-8");
    expect(result.errors.join(" ")).toContain("empty");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects empty subheading", () => {
    const input = { blocks: [{ type: "subheading", text: "" }] };
    const result = normalizeAiEditorialPayload(input, "sec-9");
    expect(result.errors.join(" ")).toContain("empty");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects H2 (level 2) subheading", () => {
    const input = { blocks: [{ type: "subheading", text: "Wrong", level: 2 }] };
    const result = normalizeAiEditorialPayload(input, "sec-10");
    expect(result.errors.join(" ")).toContain("disallowed");
    expect(result.blocks.length).toBe(0);
  });

  it("normalizes generic heading block to canonical H3 subheading", () => {
    const input = { blocks: [{ type: "heading", text: "Key Benefits" }] };
    const result = normalizeAiEditorialPayload(input, "sec-heading");
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]).toMatchObject({
      type: "subheading",
      level: 3,
    });
    const html = renderEditorialBlocksToWordPress(result.blocks);
    expect(html).toContain("<!-- wp:heading {\"level\":3} --><h3>Key Benefits</h3><!-- /wp:heading -->");
  });

  it("normalizes heading with explicit level 3 to canonical H3 subheading", () => {
    const input = { blocks: [{ type: "heading", text: "Explicit H3", level: 3 }] };
    const result = normalizeAiEditorialPayload(input, "sec-heading");
    expect(result.errors.length).toBe(0);
    expect(result.blocks[0]).toMatchObject({ type: "subheading", level: 3 });
  });

  it("rejects generic heading requesting level 2", () => {
    const input = { blocks: [{ type: "heading", text: "Wrong", level: 2 }] };
    const result = normalizeAiEditorialPayload(input, "sec-heading");
    expect(result.errors.join(" ")).toContain("disallowed level 2");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects generic heading requesting an unsupported level", () => {
    const input = { blocks: [{ type: "heading", text: "Wrong", level: 1 }] };
    const result = normalizeAiEditorialPayload(input, "sec-heading");
    expect(result.errors.join(" ")).toContain("unsupported level");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects empty generic heading", () => {
    const input = { blocks: [{ type: "heading", text: "" }] };
    const result = normalizeAiEditorialPayload(input, "sec-heading");
    expect(result.errors.join(" ")).toContain("empty");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects text containing WordPress block comments", () => {
    const input = { blocks: [{ type: "paragraph", text: "Some <!-- wp:paragraph --> text" }] };
    const result = normalizeAiEditorialPayload(input, "sec-11");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects raw HTML tags in AI text", () => {
    const input = { blocks: [{ type: "paragraph", text: "Has a <div> tag" }] };
    const result = normalizeAiEditorialPayload(input, "sec-12");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects empty list", () => {
    const input = { blocks: [{ type: "list", ordered: false, items: [] }] };
    const result = normalizeAiEditorialPayload(input, "sec-13");
    expect(result.errors.join(" ")).toContain("no items");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects empty quote", () => {
    const input = { blocks: [{ type: "quote", text: "" }] };
    const result = normalizeAiEditorialPayload(input, "sec-14");
    expect(result.errors.join(" ")).toContain("empty");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects table without headers", () => {
    const input = { blocks: [{ type: "table", headers: [], rows: [["a"]] }] };
    const result = normalizeAiEditorialPayload(input, "sec-15");
    expect(result.errors.join(" ")).toContain("no headers");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects table without rows", () => {
    const input = { blocks: [{ type: "table", headers: ["H"], rows: [] }] };
    const result = normalizeAiEditorialPayload(input, "sec-16");
    expect(result.errors.join(" ")).toContain("no rows");
    expect(result.blocks.length).toBe(0);
  });

  it("rejects table column mismatch", () => {
    const input = {
      blocks: [
        {
          type: "table",
          headers: ["A", "B"],
          rows: [["Only one"]],
        },
      ],
    };
    const result = normalizeAiEditorialPayload(input, "sec-17");
    expect(result.errors.join(" ")).toContain("expected 2");
    expect(result.blocks.length).toBe(0);
  });

  it("generates deterministic IDs", () => {
    const input = { blocks: [{ type: "paragraph", text: "P1" }, { type: "paragraph", text: "P2" }] };
    const r1 = normalizeAiEditorialPayload(input, "comp");
    const r2 = normalizeAiEditorialPayload(input, "comp");
    expect(r1.blocks[0].id).toBe("comp-paragraph-0");
    expect(r1.blocks[1].id).toBe("comp-paragraph-1");
    expect(r1.blocks[0].id).toBe(r2.blocks[0].id);
    expect(r1.blocks[1].id).toBe(r2.blocks[1].id);
  });

  it("normalizes whitespace without destroying meaning", () => {
    const input = { blocks: [{ type: "paragraph", text: "Hello    world.\n\nNew para." }] };
    const result = normalizeAiEditorialPayload(input, "sec");
    expect(result.errors.length).toBe(0);
    if (result.blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(result.blocks[0].content).toEqual([{ type: "text", text: "Hello world. New para." }]);
  });

  it("rejects non-object input", () => {
    const result = normalizeAiEditorialPayload("string", "sec");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBe(0);
  });

  it("rejects null input", () => {
    const result = normalizeAiEditorialPayload(null, "sec");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects empty table header cells", () => {
    const input = { blocks: [{ type: "table", headers: [""], rows: [["v"]] }] };
    const result = normalizeAiEditorialPayload(input, "sec");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBe(0);
  });
});

// ── renderEditorialBlocksToWordPress ──

describe("renderEditorialBlocksToWordPress", () => {
  function p(text: string): EditorialBlock {
    return { id: "p0", type: "paragraph", content: [{ type: "text", text }] };
  }

  it("renders paragraph block", () => {
    const html = renderEditorialBlocksToWordPress([p("Hello world")]);
    expect(html).toContain("<!-- wp:paragraph --><p>Hello world</p><!-- /wp:paragraph -->");
  });

  it("renders H3 subheading", () => {
    const block: EditorialBlock = {
      id: "sh0",
      type: "subheading",
      level: 3,
      content: [{ type: "text", text: "Section Title" }],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("<!-- wp:heading {\"level\":3} --><h3>Section Title</h3><!-- /wp:heading -->");
  });

  it("renders ordered list", () => {
    const block: EditorialBlock = {
      id: "l0",
      type: "list",
      ordered: true,
      items: [[{ type: "text", text: "One" }], [{ type: "text", text: "Two" }]],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("<!-- wp:list {\"ordered\":true} -->");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>One</li>");
    expect(html).toContain("<li>Two</li>");
    expect(html).toContain("</ol><!-- /wp:list -->");
  });

  it("renders unordered list", () => {
    const block: EditorialBlock = {
      id: "l1",
      type: "list",
      ordered: false,
      items: [[{ type: "text", text: "A" }]],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("<!-- wp:list {\"ordered\":false} -->");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>A</li>");
  });

  it("renders quote", () => {
    const block: EditorialBlock = {
      id: "q0",
      type: "quote",
      content: [{ type: "text", text: "Cited content." }],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("<!-- wp:quote --><blockquote><p>Cited content.</p></blockquote><!-- /wp:quote -->");
  });

  it("renders table", () => {
    const block: EditorialBlock = {
      id: "t0",
      type: "table",
      headers: [[{ type: "text", text: "Col1" }], [{ type: "text", text: "Col2" }]],
      rows: [
        [[{ type: "text", text: "A" }], [{ type: "text", text: "B" }]],
      ],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("<!-- wp:table -->");
    expect(html).toContain("<th>Col1</th>");
    expect(html).toContain("<th>Col2</th>");
    expect(html).toContain("<td>A</td>");
    expect(html).toContain("<td>B</td>");
    expect(html).toContain("</table></figure><!-- /wp:table -->");
  });

  it("renders strong and emphasis inline", () => {
    const block: EditorialBlock = {
      id: "p1",
      type: "paragraph",
      content: [
        { type: "text", text: "Normal " },
        { type: "strong", text: "bold" },
        { type: "text", text: " and " },
        { type: "emphasis", text: "italic" },
      ],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders safe external link", () => {
    const block: EditorialBlock = {
      id: "p2",
      type: "paragraph",
      content: [
        {
          type: "link",
          text: "Visit",
          href: "https://example.com/page",
          sourceType: "editorial-external",
        },
      ],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain('<a href="https://example.com/page">Visit</a>');
  });

  it("renders safe internal link", () => {
    const block: EditorialBlock = {
      id: "p3",
      type: "paragraph",
      content: [
        { type: "link", text: "Home", href: "/blog/my-post", sourceType: "internal" },
      ],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain('<a href="/blog/my-post">Home</a>');
  });

  it("omits unsafe javascript: link and returns plain text", () => {
    const block: EditorialBlock = {
      id: "p4",
      type: "paragraph",
      content: [
        { type: "link", text: "Danger", href: "javascript:alert(1)" },
      ],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Danger");
    expect(html).not.toContain("<a");
  });

  it("escapes HTML in text", () => {
    const block: EditorialBlock = {
      id: "p5",
      type: "paragraph",
      content: [{ type: "text", text: "<script>alert(1)</script>" }],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not produce wp:wp: artifacts", () => {
    const blocks: EditorialBlock[] = [
      p("First"),
      p("Second"),
    ];
    const html = renderEditorialBlocksToWordPress(blocks);
    expect(html).not.toContain("wp:wp:");
  });

  it("produces balanced WordPress comment pairs", () => {
    const blocks: EditorialBlock[] = [
      p("One"),
      p("Two"),
    ];
    const html = renderEditorialBlocksToWordPress(blocks);
    const opens = (html.match(/<!--\s*wp:\w+/g) || []).length;
    const closes = (html.match(/<!--\s*\/wp:\w+/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("does not produce nested <p> tags", () => {
    const block: EditorialBlock = {
      id: "p6",
      type: "paragraph",
      content: [{ type: "strong", text: "bold inner" }],
    };
    const html = renderEditorialBlocksToWordPress([block]);
    // Should be <p><strong>bold inner</strong></p> — no nested <p>
    expect(html).toContain("<p><strong>bold inner</strong></p>");
    expect(html).not.toContain("<p><p>");
    expect(html).not.toContain("</p></p>");
  });

  it("does not emit raw prose outside WordPress blocks", () => {
    const blocks: EditorialBlock[] = [p("Test")];
    const html = renderEditorialBlocksToWordPress(blocks);
    // Strip WordPress block comments and check nothing remains outside them
    // First extract content within wp:... blocks
    const wpBlocks: string[] = [];
    const wpRe = /<!--\s*wp:\w+(?:\s[^>]*)?\s*-->([\s\S]*?)<!--\s*\/wp:\w+\s*-->/gi;
    let m: RegExpExecArray | null;
    while ((m = wpRe.exec(html)) !== null) {
      // Strip all HTML tags inside the block to get the raw text
      const raw = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (raw.length > 0) wpBlocks.push(raw);
    }
    // Extract all text outside wp:... blocks
    const outside = html.replace(/<!--\s*wp:\w+(?:\s[^>]*)?\s*-->[\s\S]*?<!--\s*\/wp:\w+\s*-->/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    expect(wpBlocks).toContain("Test");
    expect(outside).toBe("");
  });

  it("never emits empty blocks", () => {
    const blocks: EditorialBlock[] = [
      {
        id: "l0",
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "Item" }]],
      },
    ];
    // All blocks have content, so no empty blocks should be emitted
    const html = renderEditorialBlocksToWordPress(blocks);
    expect(html).toContain("Item");
  });
});

// ── validateEditorialBlocks ──

describe("validateEditorialBlocks", () => {
  it("returns no errors for valid blocks", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      { id: "b", type: "subheading", level: 3, content: [{ type: "text", text: "Sub" }] },
    ];
    expect(validateEditorialBlocks(blocks)).toEqual([]);
  });

  it("detects duplicate IDs", () => {
    const blocks: EditorialBlock[] = [
      { id: "x", type: "paragraph", content: [{ type: "text", text: "A" }] },
      { id: "x", type: "paragraph", content: [{ type: "text", text: "B" }] },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("duplicate ID");
  });

  it("detects unsafe links", () => {
    const blocks: EditorialBlock[] = [
      {
        id: "a",
        type: "paragraph",
        content: [{ type: "link", text: "bad", href: "javascript:void(0)" }],
      },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("unsafe link");
  });

  it("detects WordPress comment inside text", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "<!-- comment -->" }] },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("WordPress");
  });

  it("detects HTML inside text", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "<div>test</div>" }] },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("HTML");
  });

  it("rejects subheading with level !== 3", () => {
    // Construct outside the EditorialBlock union to allow an invalid level.
    const raw = { id: "a", type: "subheading" as const, level: 2, content: [{ type: "text" as const, text: "Wrong" }] };
    const blocks: EditorialBlock[] = [raw as unknown as EditorialBlock];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("expected 3");
  });

  it("rejects table column count mismatch", () => {
    const blocks: EditorialBlock[] = [
      {
        id: "t",
        type: "table",
        headers: [[{ type: "text", text: "A" }], [{ type: "text", text: "B" }]],
        rows: [[[{ type: "text", text: "Only" }]]],
      },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("expected 2");
  });

  it("rejects empty paragraph content", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [] },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("no content");
  });

  it("rejects empty list items", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "list", ordered: false, items: [] },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("no items");
  });

  it("rejects unknown block type in validation", () => {
    const raw = { id: "x", type: "unknown" as const };
    const blocks: EditorialBlock[] = [raw as unknown as EditorialBlock];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("unknown block type");
  });
});

// ── extractPlainTextFromEditorialBlocks ──

describe("extractPlainTextFromEditorialBlocks", () => {
  it("extracts text from all block types", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Para" }] },
      { id: "b", type: "subheading", level: 3, content: [{ type: "text", text: "Sub" }] },
      {
        id: "c",
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "Item" }]],
      },
      { id: "d", type: "quote", content: [{ type: "text", text: "Quote" }] },
      {
        id: "e",
        type: "table",
        headers: [[{ type: "text", text: "H" }]],
        rows: [[[{ type: "text", text: "C" }]]],
      },
    ];
    const text = extractPlainTextFromEditorialBlocks(blocks);
    expect(text).toContain("Para");
    expect(text).toContain("Sub");
    expect(text).toContain("Item");
    expect(text).toContain("Quote");
    expect(text).toContain("H");
    expect(text).toContain("C");
  });
});

// ── countEditorialBlockWords ──

describe("countEditorialBlockWords", () => {
  it("counts words correctly", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "One two three" }] },
    ];
    expect(countEditorialBlockWords(blocks)).toBe(3);
  });

  it("counts zero for empty blocks", () => {
    expect(countEditorialBlockWords([])).toBe(0);
  });
});

// ── cloneEditorialBlocks ──

describe("cloneEditorialBlocks", () => {
  it("produces a deep copy", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Original" }] },
    ];
    const cloned = cloneEditorialBlocks(blocks);
    expect(cloned).toEqual(blocks);
    expect(cloned).not.toBe(blocks);
    expect(cloned[0]).not.toBe(blocks[0]);
    if (cloned[0].type !== "paragraph") throw new Error("expected paragraph");
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(cloned[0].content).not.toBe(blocks[0].content);
  });

  it("modifying clone does not affect original", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Original" }] },
    ];
    const cloned = cloneEditorialBlocks(blocks);
    if (cloned[0].type !== "paragraph") throw new Error("expected paragraph");
    cloned[0].content[0].text = "Modified";
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].content[0].text).toBe("Original");
  });
});

// ── Parser regression: inline content duplication ──

describe("parser inline-content duplication", () => {
  it("accepts only a structurally consistent H3 editorial heading", () => {
    const parsed = parseWordPressEditorialBlocks(
      '<!-- wp:heading {"level":3} --><h3>Practical steps</h3><!-- /wp:heading -->',
      "h3-test",
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks[0]).toMatchObject({ type: "subheading", level: 3 });
  });

  it.each([
    '<!-- wp:heading {"level":4} --><h4>Silently coerced before</h4><!-- /wp:heading -->',
    '<!-- wp:heading --><h2>Implicit WordPress H2</h2><!-- /wp:heading -->',
    '<!-- wp:heading {"level":3} --><h4>Mismatched levels</h4><!-- /wp:heading -->',
  ])("rejects unsupported or inconsistent editorial heading markup", (html) => {
    const parsed = parseWordPressEditorialBlocks(html, "unsafe-heading");
    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it.each([
    '<!-- wp:paragraph --><p>Text <img src="https://example.com/a.png"> after.</p><!-- /wp:paragraph -->',
    '<!-- wp:paragraph --><p>Text <span class="model-mark">inside</span> after.</p><!-- /wp:paragraph -->',
    '<!-- wp:paragraph --><p>Text<br>after.</p><!-- /wp:paragraph -->',
  ])("reports inline markup that the canonical renderer cannot preserve", (html) => {
    const parsed = parseWordPressEditorialBlocks(html, "unsupported-inline");
    expect(parsed.errors.join(" ")).toContain("unsupported inline element");
  });

  it("link creates one node without duplicate text node", () => {
    const parsed = parseWordPressEditorialBlocks(
      `<!-- wp:paragraph --><p><a href="https://example.com">Click here</a></p><!-- /wp:paragraph -->`,
      "link-test",
    );
    expect(parsed.blocks.length).toBe(1);
    const block = parsed.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    expect(block.content.length).toBe(1);
    const inline = block.content[0];
    if (inline.type !== "link") throw new Error("expected link");
    expect(inline.text).toBe("Click here");
    expect(inline.href).toBe("https://example.com");
  });

  it("strong content is not duplicated", () => {
    const parsed = parseWordPressEditorialBlocks(
      `<!-- wp:paragraph --><p>Normal <strong>Bold</strong></p><!-- /wp:paragraph -->`,
      "strong-test",
    );
    expect(parsed.blocks.length).toBe(1);
    const block = parsed.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    expect(block.content.length).toBe(2);
    expect(block.content[0].type).toBe("text");
    expect(block.content[1].type).toBe("strong");
  });

  it("emphasis content is not duplicated", () => {
    const parsed = parseWordPressEditorialBlocks(
      `<!-- wp:paragraph --><p>Text <em>Italic</em> end</p><!-- /wp:paragraph -->`,
      "em-test",
    );
    expect(parsed.blocks.length).toBe(1);
    const block = parsed.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    expect(block.content.length).toBe(3);
    expect(block.content[1].type).toBe("emphasis");
  });

  it("mixed text plus links preserves correct order", () => {
    const parsed = parseWordPressEditorialBlocks(
      `<!-- wp:paragraph --><p>Before <a href="https://x.com">Link</a> After</p><!-- /wp:paragraph -->`,
      "mixed",
    );
    expect(parsed.blocks.length).toBe(1);
    const block = parsed.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    const types = block.content.map((n) => n.type);
    expect(types).toEqual(["text", "link", "text"]);
    expect(block.content[0].text).toBe("Before ");
    expect(block.content[1].text).toBe("Link");
    expect(block.content[2].text).toBe(" After");
    expect(renderEditorialBlocksToWordPress(parsed.blocks)).toContain(
      'Before <a href="https://x.com">Link</a> After',
    );
  });

  it("legitimate repeated text remains unchanged", () => {
    const parsed = parseWordPressEditorialBlocks(
      `<!-- wp:paragraph --><p>very very useful</p><!-- /wp:paragraph -->`,
      "repeat-test",
    );
    expect(parsed.blocks.length).toBe(1);
    const block = parsed.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    expect(block.content.length).toBe(1);
    expect(block.content[0].type).toBe("text");
    expect(block.content[0].text).toBe("very very useful");
  });
});

// ── Regression: CTA content rejection (scoped to conclusion) ──

describe("CTA content rejection", () => {
  it("normalizeAiEditorialPayload with disallowCtaContent rejects paragraphs with CTA signup", () => {
    const input = { blocks: [{ type: "paragraph", text: "Sign up now! Create your free profile today." }] };
    const result = normalizeAiEditorialPayload(input, "conclusion", { disallowCtaContent: true });
    expect(result.errors.join(" ")).toContain("CTA");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("normalizeAiEditorialPayload with disallowCtaContent rejects paragraphs with app.b2ihub.com/signup", () => {
    const input = { blocks: [{ type: "paragraph", text: "Visit https://app.b2ihub.com/signup to start." }] };
    const result = normalizeAiEditorialPayload(input, "conclusion", { disallowCtaContent: true });
    expect(result.errors.join(" ")).toContain("CTA");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("normalizeAiEditorialPayload with disallowCtaContent rejects paragraphs with CTA heading", () => {
    const input = { blocks: [{ type: "paragraph", text: "Ready to grow your brand with Hong Kong creators?" }] };
    const result = normalizeAiEditorialPayload(input, "conclusion", { disallowCtaContent: true });
    expect(result.errors.join(" ")).toContain("CTA");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("normalizeAiEditorialPayload without option accepts generic marketing phrases in editorial content", () => {
    const input = { blocks: [{ type: "paragraph", text: "Ready to grow your brand with these strategies?" }] };
    const result = normalizeAiEditorialPayload(input, "intro");
    expect(result.errors.length).toBe(0);
  });

  it("validateEditorialBlocks flags signup URLs only", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Create your free profile and start collaborating today." }] },
    ];
    const errors = validateEditorialBlocks(blocks);
    // Generic CTA phrases like "create your free profile" are NOT flagged by validation
    // Only signup URLs are flagged
    expect(errors.join(" ")).not.toContain("CTA");
  });

  it("validateEditorialBlocks flags signup URL in content", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Visit https://app.b2ihub.com/signup to start." }] },
    ];
    const errors = validateEditorialBlocks(blocks);
    expect(errors.join(" ")).toContain("signup URL");
  });

  it("valid conclusion paragraph without CTA passes", () => {
    const input = { blocks: [{ type: "paragraph", text: "Threads marketing offers real opportunities for Hong Kong SMEs." }] };
    const result = normalizeAiEditorialPayload(input, "conclusion", { disallowCtaContent: true });
    expect(result.errors.length).toBe(0);
    expect(result.blocks.length).toBe(1);
  });

  it("editorial section with 'ready to grow' passes without option", () => {
    const input = { blocks: [{ type: "paragraph", text: "Small businesses are ready to grow their brand using these methods." }] };
    const result = normalizeAiEditorialPayload(input, "section-0");
    expect(result.errors.length).toBe(0);
  });
});

// ── Regression: renderer is sole source of WordPress markup ──

describe("renderEditorialBlocksToWordPress is sole WP markup source", () => {
  it("does not contain raw prose outside WordPress blocks", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      { id: "b", type: "paragraph", content: [{ type: "text", text: "World" }] },
    ];
    const html = renderEditorialBlocksToWordPress(blocks);
    // Extract all text content from inside wp:... blocks
    const insideBlocks: string[] = [];
    const re = /<!--\s*wp:\w+(?:\s[^>]*)?\s*-->([\s\S]*?)<!--\s*\/wp:\w+\s*-->/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (text) insideBlocks.push(text);
    }
    // All readable text should be inside blocks
    expect(insideBlocks.join(" ")).toContain("Hello");
    expect(insideBlocks.join(" ")).toContain("World");
    // No text outside blocks
    const outside = html.replace(re, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    expect(outside).toBe("");
  });

  it("does not emit wp:html blocks and keeps WordPress comments balanced", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "Test" }] },
    ];
    const html = renderEditorialBlocksToWordPress(blocks);
    // The renderer should never produce wp:html blocks
    expect(html).not.toContain("<!-- wp:html -->");
    // Every opener has a matching closer
    const opens = (html.match(/<!--\s*wp:\w+/g) || []).length;
    const closes = (html.match(/<!--\s*\/wp:\w+/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("produces no malformed wp:wp: artifacts", () => {
    const blocks: EditorialBlock[] = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "A" }] },
      { id: "b", type: "paragraph", content: [{ type: "text", text: "B" }] },
      { id: "c", type: "paragraph", content: [{ type: "text", text: "C" }] },
    ];
    const html = renderEditorialBlocksToWordPress(blocks);
    expect(html).not.toContain("wp:wp:");
  });
});
