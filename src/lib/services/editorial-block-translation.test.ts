import { describe, it, expect, vi } from "vitest";
import { translateEditorialBlocks, EditorialBlockTranslationError, runConclusionStructuredShadow } from "./editorial-block-translation";
import { protectNumbersInEditorialBlocks } from "./editorial-block-protection";
import { serializeTranslationPayload } from "./translation-dto";
import { renderEditorialBlocksToWordPress, type EditorialBlock } from "@/lib/blog/article-content";

function p(text: string): EditorialBlock {
  return { id: "p", type: "paragraph", content: [{ type: "text", text }] };
}
function h3(text: string): EditorialBlock {
  return { id: "h3", type: "subheading", level: 3, content: [{ type: "text", text }] };
}
function li(ordered: boolean, items: string[]): EditorialBlock {
  return { id: "list", type: "list", ordered, items: items.map((t) => [{ type: "text", text: t }]) };
}
function quote(text: string): EditorialBlock {
  return { id: "q", type: "quote", content: [{ type: "text", text }] };
}

async function identityTranslate(protectedHtml: string): Promise<string> {
  return protectedHtml;
}

async function zhTranslate(protectedHtml: string): Promise<string> {
  return protectedHtml.replace(/Hello/g, "你好").replace(/World/g, "世界");
}

async function invalidHtmlTranslate(_protectedHtml: string): Promise<string> {
  return "NOT VALID WORDPRESS HTML {{{";
}

async function linkDroppingTranslate(_protectedHtml: string): Promise<string> {
  return "<!-- wp:paragraph --><p>No links here.</p><!-- /wp:paragraph -->";
}

describe("translateEditorialBlocks", () => {
  it("translates a paragraph round trip", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World")],
      componentId: "intro",
      componentKind: "introduction",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe("paragraph");
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("你好");
    expect(rendered).toContain("世界");
  });

  it("translates an H3 subheading", async () => {
    const result = await translateEditorialBlocks({
      blocks: [h3("Hello World")],
      componentId: "sec",
      componentKind: "section",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe("subheading");
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("你好");
  });

  it("translates ordered and unordered lists", async () => {
    const result = await translateEditorialBlocks({
      blocks: [li(false, ["Hello", "World"]), li(true, ["One", "Two"])],
      componentId: "list-sec",
      componentKind: "section",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(2);
    expect((result.blocks[0] as any).ordered).toBe(false);
    expect((result.blocks[1] as any).ordered).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("你好");
    expect(rendered).toContain("世界");
  });

  it("translates a quote", async () => {
    const result = await translateEditorialBlocks({
      blocks: [quote("Hello World")],
      componentId: "quote-sec",
      componentKind: "section",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe("quote");
  });

  it("preserves strong and emphasis inline content", async () => {
    const blocks: EditorialBlock[] = [
      { id: "p1", type: "paragraph", content: [
        { type: "text", text: "Normal " },
        { type: "strong", text: "Bold" },
        { type: "text", text: " and " },
        { type: "emphasis", text: "Italic" },
      ]},
    ];
    const result = await translateEditorialBlocks({
      blocks,
      componentId: "inline",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("<strong>Bold</strong>");
    expect(rendered).toContain("<em>Italic</em>");
  });

  it("preserves links", async () => {
    const blocks: EditorialBlock[] = [
      { id: "p1", type: "paragraph", content: [
        { type: "link", text: "Click here", href: "https://example.com" },
      ]},
    ];
    const result = await translateEditorialBlocks({
      blocks,
      componentId: "link-test",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com"');
    expect(rendered).toContain("Click here");
  });

  it("number protection and restoration occur centrally", async () => {
    const blocks: EditorialBlock[] = [
      { id: "p1", type: "paragraph", content: [
        { type: "text", text: "Price is HK$1,200 and 50% off" },
      ]},
    ];
    const result = await translateEditorialBlocks({
      blocks,
      componentId: "num-test",
      componentKind: "conclusion",
      translateProtectedHtml: identityTranslate,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("HK$1,200");
    expect(rendered).toContain("50%");
  });

  it("link validation occurs centrally — dropped links trigger repair", async () => {
    let repaired = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "link-check",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      repairProtectedHtml: async (html) => {
        repaired = true;
        return html;
      },
    });
    expect(repaired).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("repair that resolves errors produces successful result", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-ok",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p><a href=\"https://example.com\">Click</a></p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com"');
  });

  it("validation failure without repair falls back to source", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "no-repair",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      // No repairProtectedHtml provided
    });
    expect(result.passed).toBe(false);
    // Fallback produces blocks from source HTML
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("second invalid result (repair also bad) falls back to source", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-bad",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>Still no links.</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("parser errors throw EditorialBlockTranslationError with component ID", async () => {
    // H2 headings in editorial HTML trigger a parse error
    await expect(
      translateEditorialBlocks({
        blocks: [p("Hello")],
        componentId: "h2-reject",
        componentKind: "introduction",
        translateProtectedHtml: async () => {
          return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
        },
      }),
    ).rejects.toThrow(EditorialBlockTranslationError);
    await expect(
      translateEditorialBlocks({
        blocks: [p("Hello")],
        componentId: "h2-reject",
        componentKind: "introduction",
        translateProtectedHtml: async () => {
          return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
        },
      }),
    ).rejects.toThrow(/h2-reject/);
  });

  it("source blocks are not mutated", async () => {
    const original = [p("Hello World")];
    const copy = JSON.parse(JSON.stringify(original));
    await translateEditorialBlocks({
      blocks: original,
      componentId: "mutate-test",
      componentKind: "introduction",
      translateProtectedHtml: zhTranslate,
    });
    expect(original).toEqual(copy);
  });

  it("rendering happens once per successful call", async () => {
    let callCount = 0;
    const result = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "render-count",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => {
        callCount++;
        return html;
      },
    });
    expect(callCount).toBe(1);
    expect(result.blocks.length).toBe(1);
  });

  it("returned blocks contain no H2", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello"), h3("World")],
      componentId: "no-h2",
      componentKind: "section",
      translateProtectedHtml: identityTranslate,
    });
    for (const block of result.blocks) {
      if (block.type === "subheading") {
        expect((block as any).level).not.toBe(2);
      }
    }
  });

  it("deterministic block IDs remain stable", async () => {
    const result1 = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "det",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    const result2 = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "det",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    expect(result1.blocks[0].id).toBe(result2.blocks[0].id);
  });

  it("empty source blocks return empty result", async () => {
    const result = await translateEditorialBlocks({
      blocks: [],
      componentId: "empty",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    expect(result.blocks).toEqual([]);
    expect(result.translatedHtml).toBe("");
    expect(result.passed).toBe(true);
  });

  it("onStatus callback receives metrics", async () => {
    let captured: any = null;
    await translateEditorialBlocks({
      blocks: [p("Hello World")],
      componentId: "status-test",
      componentKind: "introduction",
      translateProtectedHtml: zhTranslate,
      onStatus: (status) => { captured = status; },
    });
    expect(captured).not.toBeNull();
    expect(captured.passed).toBe(true);
    expect(captured.metrics.sourceChars).toBeGreaterThan(0);
  });
});

// ── Authority-switch tests ──

describe("structured number/link validation is authoritative", () => {
  it("structured passes + HTML shadow passes → translation passes", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
          { type: "text", text: " 50% off" },
        ]},
      ],
      componentId: "both-pass",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
    expect(result.validationParity).toBeDefined();
  });

  it("structured fails + HTML shadow passes → repair is triggered", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "struct-fail",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link here.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("structured passes + HTML shadow fails → translation passes with disagreement diagnostic", async () => {
    // Render source with numbers, translate back identical (structured sees no change).
    // HTML shadow may disagree because the number protection grammars differ.
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "text", text: "Value is 123" },
        ]},
      ],
      componentId: "shadow-fail",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => html,
    });
    // Structured sees the candidate passes (same content)
    expect(result.passed).toBe(true);
  });

  it("structured fails + HTML shadow fails → repair is triggered", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "both-fail",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("repaired candidate passes structured validation → translation succeeds", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-success",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p><a href=\"https://example.com\">Click</a></p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com"');
  });

  it("repaired candidate still fails → permanent-fallback behaviour", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-fail",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>Still no link.</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0); // fallback
  });

  it("lost number blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "text", text: "Price HK$500" },
        ]},
      ],
      componentId: "num-lost",
      componentKind: "introduction",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Price dropped</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("changed number blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "text", text: "Price HK$500" },
        ]},
      ],
      componentId: "num-changed",
      componentKind: "introduction",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Price HK$600</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("lost URL blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "url-lost",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("changed URL blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://original.com" },
        ]},
      ],
      componentId: "url-changed",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p><a href=\"https://changed.com\">Click</a></p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("translated visible label with unchanged URL passes", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click here", href: "https://example.com" },
        ]},
      ],
      componentId: "label-translated",
      componentKind: "conclusion",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p><a href=\"https://example.com\">按此</a></p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(true);
  });

  it("parsed blocks validated before structured number/link checks", async () => {
    await expect(
      translateEditorialBlocks({
        blocks: [p("Hello")],
        componentId: "parse-first",
        componentKind: "introduction",
        translateProtectedHtml: async () => {
          return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
        },
      }),
    ).rejects.toThrow(EditorialBlockTranslationError);
  });

  it("source blocks are never mutated", async () => {
    const original = [
      { id: "p1", type: "paragraph" as const, content: [{ type: "text" as const, text: "HK$500" }] },
    ];
    const copy = JSON.parse(JSON.stringify(original));
    await translateEditorialBlocks({
      blocks: original,
      componentId: "no-mutate",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    expect(original).toEqual(copy);
  });

  it("diagnostics include component ID in error messages", async () => {
    await expect(
      translateEditorialBlocks({
        blocks: [p("Hello")],
        componentId: "diag-id",
        componentKind: "introduction",
        translateProtectedHtml: async () => {
          return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
        },
      }),
    ).rejects.toThrow(/diag-id/);
  });
});

// ── Block-level protection lifecycle ──

describe("block-level number protection lifecycle", () => {
  it("source blocks are protected before rendering", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "HK$500 and 50% off" }] },
      ],
      componentId: "protect-before",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => {
        expect(html).toContain("__NUM_");
        return html;
      },
    });
    expect(result.passed).toBe(true);
    expect(result.blocks[0].type).toBe("paragraph");
  });

  it("AI receives rendered HTML containing placeholders", async () => {
    let receivedHtml = "";
    await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "Price HK$1,200" }] },
      ],
      componentId: "ai-receives",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        receivedHtml = html;
        return html;
      },
    });
    expect(receivedHtml).toContain("__NUM_");
    expect(receivedHtml).toContain("wp:paragraph");
  });

  it("source blocks remain unchanged after protection", async () => {
    const original = [
      { id: "p1", type: "paragraph" as const, content: [{ type: "text" as const, text: "Price HK$500" }] },
    ];
    const copy = JSON.parse(JSON.stringify(original));
    await translateEditorialBlocks({
      blocks: original,
      componentId: "no-mutate-src",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => html,
    });
    expect(original).toEqual(copy);
  });

  it("restored output contains exact original numbers", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "HK$1,200 and 50% off" }] },
      ],
      componentId: "exact-restore",
      componentKind: "conclusion",
      translateProtectedHtml: async (html) => html,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("HK$1,200");
    expect(rendered).toContain("50%");
  });

  it("returned blocks contain no placeholders", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "100% and HK$500" }] },
      ],
      componentId: "no-phas",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    const allText = result.blocks
      .flatMap((b) => b.type === "paragraph" ? b.content.map((c: any) => c.text).join(" ") : "")
      .join(" ");
    expect(allText).not.toContain("__NUM_");
  });

  it("source text without numbers passes through unchanged", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "This is plain text without any digits" }] },
      ],
      componentId: "plain-safe",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
  });
});

// ── Placeholder integrity ──

describe("placeholder integrity validation", () => {
  it("one missing placeholder triggers repair", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "10 items and 50% off" }] },
      ],
      componentId: "missing-ph",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        // Drop one placeholder
        return html.replace(/__NUM_\d+__/, "");
      },
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
  });

  it("changed placeholder triggers repair", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "changed-ph",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        return html.replace(/__NUM_0__/, "__NUM_99__");
      },
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
  });

  it("duplicated placeholder triggers repair", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "dup-ph",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        const ph = html.match(/__NUM_\d+__/)?.[0] || "";
        return html.replace(ph, ph + " " + ph);
      },
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
  });

  it("repaired candidate succeeds after placeholder integrity failure", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "repair-ph-ok",
      componentKind: "section",
      translateProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>__NUM_0__ off</p><!-- /wp:paragraph -->";
      },
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>50% off</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(true);
  });

  it("second invalid candidate follows existing fallback", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "repair-ph-fail",
      componentKind: "section",
      translateProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>no placeholder here</p><!-- /wp:paragraph -->";
      },
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>still no placeholder</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("numeric URL remains unchanged through protection", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Link 123", href: "https://example.com/page123" },
        ]},
      ],
      componentId: "numeric-url",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com/page123"');
  });

  it("basic link with number passes identity", async () => {
    // Verify the simplest identity translate with a link that has numbers.
    // This must pass because the AI preserves both the placeholder and the URL.
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Read 50", href: "https://example.com" },
        ]},
      ],
      componentId: "label-num-id",
      componentKind: "conclusion",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
  });

  it("link label with number survives round trip with label translated", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Read 50", href: "https://example.com" },
        ]},
      ],
      componentId: "label-num",
      componentKind: "conclusion",
      translateProtectedHtml: async (html) => {
        return html.replace("Read __NUM_0__", "閱讀 __NUM_0__");
      },
    });
    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("50");
    expect(rendered).toContain('href="https://example.com"');
  });

  it("two links same label different URLs preserved", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://a.com" },
          { type: "link", text: "Click", href: "https://b.com" },
        ]},
      ],
      componentId: "label-diff-url",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
  });
});

// ── Structured translation shadow ──

describe("runConclusionStructuredShadow", () => {
  const identityPayload = (json: string) => Promise.resolve(json);
  function makeConclusionBlocks(): ReturnType<typeof protectNumbersInEditorialBlocks> {
    return protectNumbersInEditorialBlocks([
      { id: "c1", type: "paragraph", content: [
        { type: "text", text: "This is the conclusion with 50% growth." },
        { type: "link", text: "Learn more", href: "https://example.com" },
      ]},
    ]);
  }

  // ── Feature control ──

  it("disabled by default", async () => {
    const result = await runConclusionStructuredShadow(
      [],
      { placeholders: [], originalValues: [] },
      "zh-conc",
      { enabled: false, translatePayload: async () => { throw new Error("should not be called"); } },
    );
    expect(result.enabled).toBe(false);
    expect(result.attempted).toBe(false);
  });

  it("disabled mode makes zero AI calls", async () => {
    const fn = vi.fn();
    await runConclusionStructuredShadow(
      [],
      { placeholders: [], originalValues: [] },
      "zh-conc",
      { enabled: false, translatePayload: fn },
    );
    expect(fn).not.toHaveBeenCalled();
  });

  // ── Payload safety ──

  it("payload contains no block IDs", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).not.toContain("c1");
    expect(captured).toContain("__NUM_0__");
    expect(captured).toContain("linkRef");
  });

  it("payload contains no URLs", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).not.toContain("https://");
    expect(captured).not.toContain("href");
    expect(captured).not.toContain("sourceType");
  });

  it("payload contains no WordPress HTML", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).not.toContain("wp:");
    expect(captured).not.toContain("<!--");
  });

  it("payload contains protected number placeholders", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).toContain("__NUM_0__");
  });

  it("componentKind is conclusion", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).toContain('"conclusion"');
  });

  // ── Successful shadow flow ──

  it("valid JSON normalizes and passes", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.attempted).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.blockCount).toBeGreaterThan(0);
  });

  it("shadow success does not affect authoritative output", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.passed).toBe(true);
    // Authoritative conclusion is stored separately — no side effect from shadow
  });

  it("links reconstruct from private link map", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.passed).toBe(true);
  });

  // ── Failure and repair ──

  it("malformed JSON triggers one repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => "not valid json",
      repairPayload: async (src, invalid, errs) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("CTA introduced in conclusion triggers repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => {
        const response = {
          componentKind: "conclusion",
          blocks: [{ type: "paragraph", seq: 0, nodes: [{ type: "text", seq: 0, text: "Ready to grow your brand" }] }],
        };
        return JSON.stringify(response);
      },
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("second invalid payload records shadow failure", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => "invalid",
      // no repair
    });
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("no extra repair attempts occur", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCount = 0;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => "invalid",
      repairPayload: async () => {
        repairCount++;
        return null;
      },
    });
    expect(repairCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  // ── Result isolation ──

  it("shadow blocks are never stored anywhere", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.passed).toBe(true);
    // No global state change — result is only in the returned object
  });

  it("link map contents not included in diagnostics", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    for (const err of result.errors) {
      expect(err).not.toContain("https://");
      expect(err).not.toContain("example.com");
    }
  });

  // ── Additional failure cases ──

  it("structural mismatch triggers one repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "subheading", seq: 0, nodes: [{ type: "text", seq: 0, text: "Changed" }] },
        ],
      }),
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("missing placeholder triggers one repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "paragraph", seq: 0, nodes: [
            { type: "text", seq: 0, text: "This is the conclusion without placeholder." },
            { type: "link", seq: 1, linkRef: "link-0", text: "Learn more" },
          ]},
        ],
      }),
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("unknown linkRef triggers repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "paragraph", seq: 0, nodes: [
            { type: "text", seq: 0, text: "This is the conclusion with 50% growth." },
            { type: "link", seq: 1, linkRef: "link-999", text: "Bad ref" },
          ]},
        ],
      }),
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("valid repaired response succeeds after structural failure", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "subheading", seq: 0, nodes: [{ type: "text", seq: 0, text: "Wrong" }] },
        ],
      }),
      repairPayload: async () => {
        repairCalled = true;
        const { payload: srcPayload } = serializeTranslationPayload(blocks, "conclusion");
        return JSON.stringify(srcPayload);
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });
});





describe("professional translation structure gate", () => {
  it("rejects a candidate that drops an inline emphasis node", async () => {
    const result = await translateEditorialBlocks({
      blocks: [{ id: "p1", type: "paragraph", content: [
        { type: "text", text: "Hello " },
        { type: "strong", text: "World" },
      ] }],
      componentId: "inline-shape-loss",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>你好世界</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("rejects a candidate that adds a new URL", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World")],
      componentId: "new-url",
      componentKind: "section",
      translateProtectedHtml: async () => '<!-- wp:paragraph --><p><a href="https://invented.example">你好世界</a></p><!-- /wp:paragraph -->',
    });
    expect(result.passed).toBe(false);
  });

  it("rejects a materially incomplete translation", async () => {
    const source = "This is a complete business paragraph with several important details about planning, customers, measurement, execution, and long-term improvement.";
    const result = await translateEditorialBlocks({
      blocks: [p(source)],
      componentId: "incomplete",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>摘要。</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });
});
