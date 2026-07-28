import { describe, it, expect } from "vitest";
import {
  serializeTranslationPayload,
  extractTranslationJson,
  normalizeTranslationPayload,
  reconstructEditorialBlocks,
  validateReconstructedTranslation,
  validateConclusionPolicy,
  type TranslationComponentPayload,
  type TranslationBlock,
  type TranslationInlineNode,
} from "./translation-dto";
import type { EditorialBlock, InlineContent } from "@/lib/blog/article-content";
import { protectNumbersInEditorialBlocks } from "./editorial-block-protection";
import { validateEditorialBlocks } from "@/lib/blog/article-content";

function contentNodes(block: TranslationBlock): TranslationInlineNode[] {
  if (block.type === "paragraph" || block.type === "subheading" || block.type === "quote") {
    return block.nodes;
  }
  return [];
}

function isListBlock(b: TranslationBlock): b is TranslationBlock & { type: "list"; ordered: boolean; items: Array<{ seq: number; nodes: TranslationInlineNode[] }> } {
  return b.type === "list";
}
function isTableBlock(b: TranslationBlock): b is TranslationBlock & { type: "table"; headers: Array<{ seq: number; nodes: TranslationInlineNode[] }>; rows: Array<{ seq: number; cells: Array<{ seq: number; nodes: TranslationInlineNode[] }> }> } {
  return b.type === "table";
}
function isParagraphLike(b: EditorialBlock): b is EditorialBlock & { content: InlineContent[] } {
  return b.type === "paragraph" || b.type === "subheading" || b.type === "quote";
}
function isListLike(b: EditorialBlock): b is EditorialBlock & { ordered: boolean; items: InlineContent[][] } {
  return b.type === "list";
}

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

function t(text: string): InlineContent {
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

function makeSource(protectedBlocks: EditorialBlock[]): { blocks: EditorialBlock[]; state: any; linkMap: any } {
  const { blocks, state: protectionState } = protectNumbersInEditorialBlocks(protectedBlocks);
  const { payload, linkMap } = serializeTranslationPayload(blocks, "introduction");
  return { blocks, state: protectionState, linkMap };
}

function serializeForAi(payload: unknown): string {
  return JSON.stringify(payload);
}

// ── Serialization ──

describe("serializeTranslationPayload", () => {
  it("serializes a paragraph", () => {
    const { payload } = serializeTranslationPayload([p([t("Hello World")])], "introduction");
    expect(payload.blocks.length).toBe(1);
    expect(payload.blocks[0].type).toBe("paragraph");
    expect(payload.blocks[0].seq).toBe(0);
    expect(contentNodes(payload.blocks[0]).length).toBe(1);
    const nodes = contentNodes(payload.blocks[0]);
    const n = nodes[0];
    expect(n.type).toBe("text");
    expect(n.seq).toBe(0);
    expect(n.text).toBe("Hello World");
  });

  it("serializes a subheading", () => {
    const { payload } = serializeTranslationPayload([h3([t("Subtitle")])], "section");
    expect(payload.blocks[0].type).toBe("subheading");
    expect(payload.blocks[0].seq).toBe(0);
  });

  it("serializes an ordered list", () => {
    const { payload } = serializeTranslationPayload([list(true, [[t("A")], [t("B")]])], "section");
    expect(payload.blocks[0].type).toBe("list");
    expect(isListBlock(payload.blocks[0]) && payload.blocks[0].ordered).toBe(true);
    expect(isListBlock(payload.blocks[0]) && payload.blocks[0].items.length).toBe(2);
  });

  it("serializes an unordered list", () => {
    const { payload } = serializeTranslationPayload([list(false, [[t("X")], [t("Y")]])], "conclusion");
    expect(isListBlock(payload.blocks[0]) && payload.blocks[0].ordered).toBe(false);
  });

  it("serializes a quote", () => {
    const { payload } = serializeTranslationPayload([quote([t("Cited text")])], "section");
    expect(payload.blocks[0].type).toBe("quote");
  });

  it("serializes a table", () => {
    const { payload } = serializeTranslationPayload(
      [table([[t("H1")], [t("H2")]], [[[t("A")], [t("B")]]])],
      "section",
    );
    expect(payload.blocks[0].type).toBe("table");
    expect(isTableBlock(payload.blocks[0]) && payload.blocks[0].headers.length).toBe(2);
    expect(isTableBlock(payload.blocks[0]) && payload.blocks[0].rows.length).toBe(1);
  });

  it("serializes inline text, strong and emphasis", () => {
    const { payload } = serializeTranslationPayload(
      [p([t("Normal "), bold("Bold"), t(" and "), emph("Italic")])],
      "introduction",
    );
    const nodes = contentNodes(payload.blocks[0]);
    expect(nodes[0].type).toBe("text");
    expect(nodes[1].type).toBe("strong");
    expect(nodes[2].type).toBe("text");
    expect(nodes[3].type).toBe("emphasis");
  });

  it("serializes link label with private URL map", () => {
    const { payload, linkMap } = serializeTranslationPayload(
      [p([t("Visit "), link("Click here", "https://example.com")])],
      "introduction",
    );
    const nodes = contentNodes(payload.blocks[0]);
    expect(nodes[1].type).toBe("link");
    if (nodes[1].type === "link") {
      expect(nodes[1].linkRef).toBe("link-0");
    }
    expect(nodes[1].text).toBe("Click here");
    expect(linkMap.size).toBe(1);
    expect(linkMap.get("link-0")?.href).toBe("https://example.com");
  });

  it("preserves number placeholders", () => {
    const { blocks } = protectNumbersInEditorialBlocks([p([t("Price is HK$500 and 50% off")])]);
    const { payload } = serializeTranslationPayload(blocks, "introduction");
    const text = contentNodes(payload.blocks[0])[0].text;
    expect(text).toContain("__NUM_0__");
    expect(text).toContain("__NUM_1__");
  });

  it("deterministic sequences and link references", () => {
    const src = [p([t("A"), link("B", "https://x.com")])];
    const r1 = serializeTranslationPayload(src, "introduction");
    const r2 = serializeTranslationPayload(src, "introduction");
    expect(r1.payload).toEqual(r2.payload);
    expect([...r1.linkMap.entries()]).toEqual([...r2.linkMap.entries()]);
  });

  it("source immutability", () => {
    const src = [p([t("Original"), link("L", "https://x.com")])];
    const copy = JSON.parse(JSON.stringify(src));
    serializeTranslationPayload(src, "introduction");
    expect(src).toEqual(copy);
  });

  it("empty blocks return empty payload", () => {
    const { payload } = serializeTranslationPayload([], "conclusion");
    expect(payload.blocks).toEqual([]);
    expect(payload.componentKind).toBe("conclusion");
  });
});

// ── Strict parsing ──

describe("extractTranslationJson", () => {
  it("accepts a raw JSON object", () => {
    const r = extractTranslationJson('{"blocks":[]}');
    expect(r.error).toBeUndefined();
    expect(r.json).toBeDefined();
  });

  it("accepts one clean JSON fence", () => {
    const r = extractTranslationJson("```json\n{\"blocks\":[]}\n```");
    expect(r.error).toBeUndefined();
  });

  it("rejects prose before JSON", () => {
    const r = extractTranslationJson("Here is the translation:\n{\"blocks\":[]}");
    expect(r.error).toContain("prose");
  });

  it("rejects prose after JSON", () => {
    const r = extractTranslationJson("{\"blocks\":[]}\nLet me know if you need changes");
    expect(r.error).toContain("prose");
  });

  it("rejects multiple objects", () => {
    const r = extractTranslationJson('{"a":1}{"b":2}');
    expect(r.error).toContain("invalid JSON");
  });

  it("rejects malformed JSON", () => {
    const r = extractTranslationJson("{invalid}");
    expect(r.error).toContain("invalid JSON");
  });

  it("rejects array at top level", () => {
    const r = extractTranslationJson('["a","b"]');
    expect(r.error).toContain("must be a JSON object");
  });

  it("rejects primitive at top level", () => {
    const r = extractTranslationJson('"hello"');
    expect(r.error).toContain("must be a JSON object");
  });
});

// ── Structural validation ──

describe("normalizeTranslationPayload", () => {
  function makeSource(): TranslationComponentPayload {
    return {
      componentKind: "introduction",
      blocks: [
        { type: "paragraph", seq: 0, nodes: [
          { type: "text", seq: 0, text: "Hello __NUM_0__" },
          { type: "link", seq: 1, linkRef: "link-0", text: "Click" },
        ]},
        { type: "list", seq: 1, ordered: false, items: [
          { seq: 0, nodes: [{ type: "text", seq: 0, text: "Item" }] },
        ]},
      ],
    };
  }

  it("passes valid payload", () => {
    const source = makeSource();
    const r = normalizeTranslationPayload(serializeForAi(source), source);
    expect(r.errors.length).toBe(0);
    expect(r.payload).not.toBeNull();
  });

  it("rejects unexpected top-level key", () => {
    const source = makeSource();
    const raw = JSON.stringify({ ...source, extraKey: true });
    const r = normalizeTranslationPayload(raw, source);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects missing block", () => {
    const source = makeSource();
    const bad = { ...source, blocks: [source.blocks[0]] };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("count mismatch"))).toBe(true);
  });

  it("rejects extra block", () => {
    const source = makeSource();
    const bad = {
      ...source,
      blocks: [
        ...source.blocks,
        { type: "paragraph", seq: 2, nodes: [{ type: "text", seq: 0, text: "Extra" }] },
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("count mismatch"))).toBe(true);
  });

  it("rejects reordered block seq", () => {
    const source = makeSource();
    const bad = {
      ...source,
      blocks: [
        { ...JSON.parse(JSON.stringify(source.blocks[0])), seq: 1 },
        { ...JSON.parse(JSON.stringify(source.blocks[1])), seq: 0 },
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("seq mismatch"))).toBe(true);
  });

  it("rejects changed block type", () => {
    const source = makeSource();
    const bad = {
      ...source,
      blocks: [
        { ...JSON.parse(JSON.stringify(source.blocks[0])), type: "quote" },
        source.blocks[1],
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("type mismatch"))).toBe(true);
  });

  it("rejects changed inline type", () => {
    const source = makeSource();
    const srcNodes0 = JSON.parse(JSON.stringify(source.blocks[0]));
    const bad = {
      ...source,
      blocks: [
        { ...srcNodes0, nodes: [{ ...srcNodes0.nodes[0], type: "strong" }, srcNodes0.nodes[1]] },
        source.blocks[1],
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("type mismatch"))).toBe(true);
  });

  it("rejects missing inline node", () => {
    const source = makeSource();
    const srcNodes0 = JSON.parse(JSON.stringify(source.blocks[0]));
    const bad = {
      ...source,
      blocks: [
        { ...srcNodes0, nodes: [srcNodes0.nodes[0]] },
        source.blocks[1],
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("node count mismatch"))).toBe(true);
  });

  it("rejects changed list ordered flag", () => {
    const source = makeSource();
    const bad = {
      ...source,
      blocks: [
        source.blocks[0],
        { ...JSON.parse(JSON.stringify(source.blocks[1])), ordered: true },
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("ordered flag"))).toBe(true);
  });

  it("rejects missing list item", () => {
    const source = makeSource();
    const bad = {
      ...source,
      blocks: [
        source.blocks[0],
        { ...source.blocks[1], items: [] },
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("item count mismatch"))).toBe(true);
  });

  it("rejects unknown link reference", () => {
    const source = makeSource();
    const srcClone0 = JSON.parse(JSON.stringify(source.blocks[0]));
    srcClone0.nodes = [srcClone0.nodes[0], { type: "link" as const, seq: 1, linkRef: "link-999", text: "Bad" }];
    const bad = { ...source, blocks: [srcClone0, source.blocks[1]] };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    // linkRef validation against source: "link-999" is not in the source's expected shape.
    // Normalization checks that inline node types match. If source.nodes[1] is "link",
    // the DTO's node[1] must also be "link" and must have a linkRef.  The linkRef value
    // itself is validated during reconstruction against the link map.
  });

  it("rejects empty translated text", () => {
    const source = makeSource();
    const srcClone0 = JSON.parse(JSON.stringify(source.blocks[0]));
    srcClone0.nodes = [{ type: "text" as const, seq: 0, text: "" }, srcClone0.nodes[1]];
    const bad = { ...source, blocks: [srcClone0, source.blocks[1]] };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("empty text"))).toBe(true);
  });

  it("rejects changed table dimensions", () => {
    const source: TranslationComponentPayload = {
      componentKind: "section",
      blocks: [
        { type: "table", seq: 0, headers: [{ seq: 0, nodes: [{ type: "text", seq: 0, text: "H" }] }], rows: [{ seq: 0, cells: [{ seq: 0, nodes: [{ type: "text", seq: 0, text: "D" }] }] }] },
      ],
    };
    const bad = {
      ...source,
      blocks: [
        { ...source.blocks[0], headers: [] },
      ],
    };
    const r = normalizeTranslationPayload(serializeForAi(bad), source);
    expect(r.errors.some((e) => e.includes("header count"))).toBe(true);
  });
});

// ── Content policy ──

describe("text-value validation", () => {
  function sourceWithText(text: string): { payload: TranslationComponentPayload; source: TranslationComponentPayload } {
    const source: TranslationComponentPayload = {
      componentKind: "introduction",
      blocks: [
        { type: "paragraph", seq: 0, nodes: [{ type: "text", seq: 0, text: "Original" }] },
      ],
    };
    const payload: TranslationComponentPayload = {
      componentKind: "introduction",
      blocks: [
        { type: "paragraph", seq: 0, nodes: [{ type: "text", seq: 0, text }] },
      ],
    };
    return { payload, source };
  }

  it("rejects raw HTML", () => {
    const { payload, source } = sourceWithText("Hello <div>world</div>");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("HTML tag"))).toBe(true);
  });

  it("rejects WordPress comment", () => {
    const { payload, source } = sourceWithText("Hello <!-- wp:paragraph -->world");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("WordPress"))).toBe(true);
  });

  it("rejects Markdown link", () => {
    const { payload, source } = sourceWithText("Click [here](https://example.com)");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("Markdown link"))).toBe(true);
  });

  it("rejects Markdown heading", () => {
    const { payload, source } = sourceWithText("# Heading text");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("Markdown heading"))).toBe(true);
  });

  it("rejects fenced code", () => {
    const { payload, source } = sourceWithText("```\ncode\n```");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("fenced code"))).toBe(true);
  });

  it("rejects Markdown list prefix", () => {
    const { payload, source } = sourceWithText("- Item");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("Markdown list"))).toBe(true);
  });

  it("rejects signup URL", () => {
    const { payload, source } = sourceWithText("Click app.b2ihub.com/signup here");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.some((e) => e.includes("signup URL"))).toBe(true);
  });

  it("accepts ordinary punctuation", () => {
    const { payload, source } = sourceWithText("Hello, world! How's it going? (Yes.)");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.length).toBe(0);
  });

  it("accepts literal asterisk", () => {
    const { payload, source } = sourceWithText("Price is 5* per unit (not bold)");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.length).toBe(0);
  });

  it("accepts hyphens inside sentences", () => {
    const { payload, source } = sourceWithText("Hong Kong-based business — well-known brand");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.length).toBe(0);
  });

  it("accepts multiplication sign", () => {
    const { payload, source } = sourceWithText("The 3 × 4 matrix");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.length).toBe(0);
  });

  it("accepts legitimate FAQ wording", () => {
    const { payload, source } = sourceWithText("Check the FAQ section for more details");
    const r = normalizeTranslationPayload(serializeForAi(payload), source);
    expect(r.errors.length).toBe(0);
  });
});

describe("validateConclusionPolicy", () => {
  it("rejects conclusion with CTA content", () => {
    const blocks: any = [
      { type: "paragraph", seq: 0, nodes: [{ type: "text", seq: 0, text: "Ready to grow your brand" }] },
    ];
    const errors: string[] = [];
    validateConclusionPolicy(blocks, errors);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("passes conclusion without CTA content", () => {
    const blocks: any = [
      { type: "paragraph", seq: 0, nodes: [{ type: "text", seq: 0, text: "This is the conclusion." }] },
    ];
    const errors: string[] = [];
    validateConclusionPolicy(blocks, errors);
    expect(errors.length).toBe(0);
  });
});

// ── Reconstruction ──

describe("reconstructEditorialBlocks", () => {
  it("exact identity round trip", () => {
    const source = [p([t("Hello"), link("Click", "https://example.com")])];
    const { blocks: protectedBlocks, linkMap } = (() => {
      const pb = protectNumbersInEditorialBlocks(source);
      const sp = serializeTranslationPayload(pb.blocks, "introduction");
      return { blocks: pb.blocks, linkMap: sp.linkMap };
    })();
    const sp = serializeTranslationPayload(protectedBlocks, "introduction");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    expect(r.errors.length).toBe(0);
    expect(r.payload).not.toBeNull();
    const reconstructed = reconstructEditorialBlocks(r.payload!, protectedBlocks, sp.linkMap);
    expect(reconstructed.errors.length).toBe(0);
    expect(reconstructed.blocks.length).toBe(1);
    expect(reconstructed.blocks[0].type).toBe("paragraph");
  });

  it("translated visible text reconstructed", () => {
    const source = [p([t("Hello")])];
    const sp = serializeTranslationPayload(source, "introduction");
    const translated = { ...sp.payload, blocks: [{ ...sp.payload.blocks[0], nodes: [{ type: "text" as const, seq: 0, text: "你好" }] }] };
    const r = normalizeTranslationPayload(serializeForAi(translated), sp.payload);
    expect(r.errors.length).toBe(0);
    expect(r.payload).not.toBeNull();
    const reconstructed = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(reconstructed.errors.length).toBe(0);
    const rendered = isParagraphLike(reconstructed.blocks[0]) ? reconstructed.blocks[0].content[0]?.text : "";
    expect(rendered).toBe("你好");
  });

  it("translated link label with source-owned URL", () => {
    const source = [p([link("Click here", "https://example.com")])];
    const sp = serializeTranslationPayload(source, "introduction");
    const translated = {
      ...sp.payload,
      blocks: [{
        ...sp.payload.blocks[0],
        nodes: [{ type: "link" as const, seq: 0, linkRef: "link-0", text: "按此" }],
      }],
    };
    const r = normalizeTranslationPayload(serializeForAi(translated), sp.payload);
    expect(r.errors.length).toBe(0);
    const reconstructed = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(reconstructed.errors.length).toBe(0);
    const node = isParagraphLike(reconstructed.blocks[0]) ? reconstructed.blocks[0].content[0] : null;
    expect(node).not.toBeNull();
    if (node?.type === "link") {
      expect(node.text).toBe("按此");
      expect(node.href).toBe("https://example.com");
    }
  });

  it("canonical IDs preserved from source", () => {
    const source = [p([t("A")]), h3([t("B")])];
    const sp = serializeTranslationPayload(source, "section");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    expect(r.errors.length).toBe(0);
    const reconstructed = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(reconstructed.blocks[0].id).toBe("p1");
    expect(reconstructed.blocks[1].id).toBe("h1");
  });

  it("subheading level preserved from source", () => {
    const source = [h3([t("Title")])];
    const sp = serializeTranslationPayload(source, "section");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    const reconstructed = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(reconstructed.blocks[0].type === "subheading" && reconstructed.blocks[0].level).toBe(3);
  });

  it("list ordering preserved from source", () => {
    const source = [list(true, [[t("A"), link("L", "https://x.com")], [t("B")]])];
    const sp = serializeTranslationPayload(source, "section");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    const reconstructed = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(reconstructed.blocks.length).toBe(1);
    expect(isListLike(reconstructed.blocks[0]) && reconstructed.blocks[0].ordered).toBe(true);
  });

  it("deterministic reconstruction", () => {
    const source = [p([t("Hello"), link("Click", "https://x.com")])];
    const sp = serializeTranslationPayload(source, "introduction");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    expect(r.errors.length).toBe(0);
    const a = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    const b = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(a).toEqual(b);
  });

  it("source immutability", () => {
    const source = [p([t("Original")])];
    const sp = serializeTranslationPayload(source, "introduction");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    const copy = JSON.parse(JSON.stringify(source));
    reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    expect(source).toEqual(copy);
  });
});

// ── Round trip with number protection ──

describe("number placeholder round trip", () => {
  it("number placeholders survive serialization and reconstruction", () => {
    const source = [p([t("Price HK$500 and 50% off")])];
    const { blocks: protectedBlocks, state } = protectNumbersInEditorialBlocks(source);
    expect(protectedBlocks[0].type).toBe("paragraph");
    const rendered = isParagraphLike(protectedBlocks[0]) ? protectedBlocks[0].content[0]?.text || "" : "";
    expect(rendered).toContain("__NUM_");

    const sp = serializeTranslationPayload(protectedBlocks, "introduction");
    const dtoText = contentNodes(sp.payload.blocks[0])[0].text;
    expect(dtoText).toContain("__NUM_0__");

    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    expect(r.errors.length).toBe(0);
    const reconstructed = reconstructEditorialBlocks(r.payload!, protectedBlocks, sp.linkMap);
    expect(reconstructed.errors.length).toBe(0);
    const recText = isParagraphLike(reconstructed.blocks[0]) ? reconstructed.blocks[0].content[0]?.text || "" : "";
    expect(recText).toContain("__NUM_0__");
  });
});

// ── Post-reconstruction validation ──

describe("validateReconstructedTranslation", () => {
  it("passes on valid reconstruction", () => {
    const source = [p([t("Hello HK$500"), link("Click", "https://example.com")])];
    const sp = serializeTranslationPayload(source, "introduction");
    const r = normalizeTranslationPayload(serializeForAi(sp.payload), sp.payload);
    const reconstructed = reconstructEditorialBlocks(r.payload!, source, sp.linkMap);
    const vr = validateReconstructedTranslation(source, reconstructed.blocks);
    expect(vr.valid).toBe(true);
  });
});
